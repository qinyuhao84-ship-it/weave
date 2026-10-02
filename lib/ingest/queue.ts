import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb } from "@/lib/db/client";
import { ingestQueue, jobs } from "@/lib/db/schema";
import { startIngest, resumeIngest } from "@/lib/ingest/pipeline";
import { canImport } from "@/lib/ingest/parse/router";
import { UnsupportedFormatError, ParseQualityError } from "@/lib/ingest/parse/types";
import { isLlmConfigured } from "@/lib/settings";
import { INGEST_QUEUE_DIR, ensureVaultLayout } from "@/lib/vault/paths";
import { localISOString } from "@/lib/utils";
import { syncDirectory } from "@/lib/vault/atomic";

const ACTIVE_JOB_STATUSES = ["queued", "running", "awaiting_review", "committing", "discarding"];

export type IngestQueueStatus = "queued" | "processing" | "awaiting_review" | "failed" | "paused";

export type IngestQueueItem = {
  id: string;
  originalName: string;
  byteSize: number;
  status: IngestQueueStatus;
  jobId: string | null;
  error: string | null;
  createdAt: string;
};

export class IngestQueueError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "IngestQueueError";
  }
}

function stagedFilePath(id: string): string {
  // id 由本服务生成，不使用原始文件名构造路径。
  return path.join(INGEST_QUEUE_DIR, `${id}.bin`);
}

function safeOriginalName(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  return path.posix.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255) || "未命名资料";
}

/** 文件只在完整落盘后加入 SQLite 队列；未完成的上传不会显示为已排队。 */
export async function stageIngestFile(name: string, bytes: Buffer): Promise<IngestQueueItem> {
  if (!bytes.byteLength || bytes.byteLength > 200 * 1024 * 1024) throw new ParseQualityError("请选择非空且不超过 200 MB 的资料文件。");
  ensureVaultLayout();
  const id = ulid();
  const originalName = safeOriginalName(name);
  const filePath = stagedFilePath(id);
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(INGEST_QUEUE_DIR, { recursive: true });

  try {
    const file = await fs.promises.open(temporaryPath, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await fs.promises.rename(temporaryPath, filePath);
    syncDirectory(path.dirname(filePath));
    const item = {
      id,
      originalName,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
      status: "queued",
      jobId: null,
      createdAt: localISOString(),
    };
    getDb().insert(ingestQueue).values(item).run();
    return { ...item, status: "queued", jobId: null, error: null };
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 刷新任务状态；服务重启后中断的任务会作为失败项保留，供用户重试。 */
export function listIngestQueue(): IngestQueueItem[] {
  const db = getDb();
  const rows = db
    .select({ item: ingestQueue, jobStatus: jobs.status, jobError: jobs.error })
    .from(ingestQueue)
    .leftJoin(jobs, eq(ingestQueue.jobId, jobs.id))
    .orderBy(asc(ingestQueue.createdAt), asc(ingestQueue.id))
    .all();

  const items: IngestQueueItem[] = [];
  for (const row of rows) {
    if (row.jobStatus === "done") {
      removeQueueRow(row.item.id);
      continue;
    }

    let status: IngestQueueStatus;
    if (row.jobStatus === "awaiting_review" || row.jobStatus === "committing" || row.jobStatus === "discarding") {
      status = "awaiting_review";
    } else if (row.jobStatus === "queued" || row.jobStatus === "running") {
      status = "processing";
    } else if (row.jobStatus === "cancelled") {
      status = "paused";
    } else if (row.jobStatus === "failed" || row.item.status === "processing" || row.item.status === "awaiting_review") {
      status = "failed";
    } else {
      status = row.item.status === "failed" ? "failed" : "queued";
    }

    if (status !== row.item.status) {
      db.update(ingestQueue).set({ status }).where(eq(ingestQueue.id, row.item.id)).run();
    }
    items.push({
      id: row.item.id,
      originalName: row.item.originalName,
      byteSize: row.item.byteSize,
      status,
      jobId: row.item.jobId,
      error: status === "failed" ? row.jobError : null,
      createdAt: row.item.createdAt,
    });
  }
  return items;
}

/** 一次只启动一个导入；有保存进度时恢复原任务，旧任务则复用上传文件。 */
export async function startQueuedIngest(id: string): Promise<{ jobId: string; fileName: string }> {
  const db = getDb();
  const item = db.select().from(ingestQueue).where(eq(ingestQueue.id, id)).get();
  if (!item) throw new IngestQueueError("找不到这份排队资料。", 404);

  if (item.jobId) {
    const linkedJob = db.select().from(jobs).where(eq(jobs.id, item.jobId)).get();
    if (linkedJob && ACTIVE_JOB_STATUSES.includes(linkedJob.status)) {
      return { jobId: linkedJob.id, fileName: item.originalName };
    }
  }

  if (!isLlmConfigured()) {
    throw new IngestQueueError("模型服务暂不可用，资料已保留在队列中；请稍后重试。", 412);
  }

  const capability = await canImport(item.originalName);
  if (!capability.ok) throw new UnsupportedFormatError(capability.reason ?? "不支持的文件格式。");

  const filePath = stagedFilePath(item.id);
  if (!fs.existsSync(filePath)) {
    db.update(ingestQueue).set({ status: "failed", jobId: null }).where(eq(ingestQueue.id, item.id)).run();
    throw new IngestQueueError("队列里的文件暂存不完整，请重新选择这份资料。", 410);
  }
  const buffer = fs.readFileSync(filePath);

  let started: { jobId: string; fileName: string } | null = null;
  db.transaction(() => {
    const current = db.select().from(ingestQueue).where(eq(ingestQueue.id, item.id)).get();
    if (!current) throw new IngestQueueError("这份资料已从队列移除。", 404);

    if (current.jobId) {
      const linkedJob = db.select().from(jobs).where(eq(jobs.id, current.jobId)).get();
      if (linkedJob && ACTIVE_JOB_STATUSES.includes(linkedJob.status)) {
        started = { jobId: linkedJob.id, fileName: current.originalName };
        return;
      }
    }

    const activeJob = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, "ingest"), inArray(jobs.status, ACTIVE_JOB_STATUSES)))
      .all()
      .find((job) => job.id !== current.jobId);
    if (activeJob) {
      throw new IngestQueueError("另一份资料正在处理或等待审阅，请完成后再继续。", 409);
    }

    const previous = current.jobId ? db.select().from(jobs).where(eq(jobs.id, current.jobId)).get() : null;
    const resumable = previous && ["failed", "cancelled"].includes(previous.status) &&
      !previous.draftJson && JSON.parse(previous.payloadJson ?? "null")?.resumable;
    const jobId = resumable ? previous.id : ulid();
    if (resumable) resumeIngest(jobId);
    else startIngest({ fileName: current.originalName, buffer, jobId });
    db.update(ingestQueue)
      .set({ status: "processing", jobId })
      .where(eq(ingestQueue.id, current.id))
      .run();
    started = { jobId, fileName: current.originalName };
  });

  if (!started) throw new IngestQueueError("这份资料没有开始处理，请重试。", 500);
  return started;
}

/** 删除暂存记录；调用方应先确认关联任务已结束。 */
function removeQueueRow(id: string): void {
  getDb().delete(ingestQueue).where(eq(ingestQueue.id, id)).run();
  try {
    fs.rmSync(stagedFilePath(id), { force: true });
  } catch {
    // 队列记录已删除；暂存文件残留不会阻塞后续任务。
  }
}

export function removeQueuedIngestForJob(jobId: string): void {
  const item = getDb().select({ id: ingestQueue.id }).from(ingestQueue).where(eq(ingestQueue.jobId, jobId)).get();
  if (item) removeQueueRow(item.id);
}

export function deleteQueuedIngest(id: string): "removed" | "active" | "missing" {
  const item = getDb().select().from(ingestQueue).where(eq(ingestQueue.id, id)).get();
  if (!item) return "missing";

  if (item.jobId) {
    const job = getDb().select().from(jobs).where(eq(jobs.id, item.jobId)).get();
    if (job && ACTIVE_JOB_STATUSES.includes(job.status)) return "active";
  }

  removeQueueRow(id);
  return "removed";
}
