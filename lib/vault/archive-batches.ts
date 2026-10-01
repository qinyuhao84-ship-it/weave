import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { getDb } from "@/lib/db/client";
import { edges, indexMeta, ingestQueue, jobs, links, pages, redirects, reviewItems, sources } from "@/lib/db/schema";
import { rebuildIndexFile } from "@/lib/index/index-file";
import { reindexAll } from "@/lib/index/reindex";
import { commitVault, ensureGitRepo } from "@/lib/git/auto-commit";
import { suppressWatcher } from "@/lib/index/watch-suppression";
import { localISOString } from "@/lib/utils";
import { parsePage } from "./frontmatter";
import { ensureVaultLayout, INGEST_QUEUE_DIR, PARSED_DIR, RAW_DIR, WIKI_DIR, WORK_DIR, VAULT_ROOT } from "./paths";
import { appendLog } from "./service";

const BATCHES_DIR = path.join(WORK_DIR, "trash", "batches");
const ARCHIVED_DIRS = [
  { active: WIKI_DIR, archive: "wiki" },
  { active: RAW_DIR, archive: "raw" },
  { active: PARSED_DIR, archive: "parsed" },
  { active: INGEST_QUEUE_DIR, archive: "ingest-queue" },
  { active: path.join(WORK_DIR, "ingest-inputs"), archive: "ingest-inputs" },
  { active: path.join(WORK_DIR, "ingest-checkpoints"), archive: "ingest-checkpoints" },
  { active: path.join(WORK_DIR, "lint-checkpoints"), archive: "lint-checkpoints" },
] as const;

type ArchiveManifest = {
  version: 1 | 2;
  id: string;
  createdAt: string;
  pageCount: number;
  sourceCount: number;
  archivedFiles: number;
  sources: Array<typeof sources.$inferSelect>;
  reviewItems: Array<typeof reviewItems.$inferSelect>;
  jobs?: Array<typeof jobs.$inferSelect>;
  ingestQueue?: Array<typeof ingestQueue.$inferSelect>;
  redirects?: Array<typeof redirects.$inferSelect>;
  restoredAt?: string;
};

export type ArchiveBatchSummary = {
  id: string;
  createdAt: string;
  pageCount: number;
  sourceCount: number;
  archivedFiles: number;
  restoredAt: string | null;
};

export type DeletedPageSummary = {
  id: string;
  title: string;
  deletedAt: string | null;
  redirectTo: string | null;
};

export class ArchiveRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveRestoreError";
  }
}

/** Archive the current knowledge snapshot and rebuild an empty active vault index. */
export function clearKnowledgeBase(): ArchiveBatchSummary {
  ensureVaultLayout();
  fs.mkdirSync(BATCHES_DIR, { recursive: true });

  const db = getDb();
  const sourceRows = db.select().from(sources).all();
  const reviewRows = db.select().from(reviewItems).all();
  const jobRows = db.select().from(jobs).all();
  if (jobRows.some((job) => ["queued", "running", "committing", "discarding"].includes(job.status))) {
    throw new ArchiveRestoreError("后台任务正在运行，请等它结束再清空知识库。");
  }
  const queueRows = db.select().from(ingestQueue).all();
  const redirectRows = db.select().from(redirects).all();
  const pageCount = countMarkdown(WIKI_DIR);
  const id = ulid();
  const createdAt = localISOString();
  const batchDir = path.join(BATCHES_DIR, id);
  const moved: Array<{ from: string; to: string }> = [];
  const restoreMetadata = snapshotMetadata();
  suppressWatcher();

  try {
    fs.mkdirSync(batchDir, { recursive: false });
    for (const directory of ARCHIVED_DIRS) {
      if (!fs.existsSync(/* turbopackIgnore: true */ directory.active)) continue;
      const archived = path.join(batchDir, directory.archive);
      fs.renameSync(directory.active, archived);
      moved.push({ from: directory.active, to: archived });
    }
    const archivedFiles = moved.reduce((count, entry) => count + countFiles(entry.to), 0);
    const manifest: ArchiveManifest = {
      version: 2,
      id,
      createdAt,
      pageCount,
      sourceCount: sourceRows.length,
      archivedFiles,
      sources: sourceRows,
      reviewItems: reviewRows,
      jobs: jobRows,
      ingestQueue: queueRows,
      redirects: redirectRows,
    };
    fs.writeFileSync(path.join(batchDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    db.transaction((tx) => {
      tx.delete(links).run();
      tx.delete(edges).run();
      tx.delete(redirects).run();
      tx.delete(pages).run();
      tx.delete(reviewItems).run();
      tx.delete(sources).run();
      tx.delete(ingestQueue).run();
      tx.delete(jobs).run();
      tx.delete(indexMeta).run();
      ensureVaultLayout();
      reindexAll();
      rebuildIndexFile();
      appendLog("DELETE", `清空知识库，${pageCount} 个词条与 ${sourceRows.length} 份原始资料已归档到回收站批次 ${id}`);
      commitVault("清空知识库并归档旧资料");
    });
    return { id, createdAt, pageCount, sourceCount: sourceRows.length, archivedFiles, restoredAt: null };
  } catch (error) {
    // SQLite 已回滚；恢复文件目录与 Git 暂存状态，不把失败说成成功清空。
    let recoveryIncomplete = false;
    for (const { from, to } of moved.reverse()) {
      try {
        if (fs.existsSync(to)) {
          fs.rmSync(from, { recursive: true, force: true });
          fs.renameSync(to, from);
        }
      } catch {
        recoveryIncomplete = true; // 保留归档副本，绝不能在恢复失败时删除唯一资料。
      }
    }
    restoreMetadata();
    try {
      if (!recoveryIncomplete && fs.existsSync(batchDir)) fs.rmSync(batchDir, { recursive: true, force: true });
      ensureVaultLayout();
    } catch {
      // The original error carries the actionable failure.
    }
    if (recoveryIncomplete) throw new ArchiveRestoreError(`清空未完成，部分目录无法自动回迁。归档副本保留在 ${batchDir}，请关闭服务后检查权限并恢复副本。`);
    throw error;
  }
}

export function listArchiveBatches(): ArchiveBatchSummary[] {
  if (!fs.existsSync(BATCHES_DIR)) return [];
  const batches: ArchiveBatchSummary[] = [];
  for (const entry of fs.readdirSync(BATCHES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.name)) continue;
    const manifest = readManifest(path.join(BATCHES_DIR, entry.name));
    if (!manifest) continue;
    batches.push(toSummary(manifest));
  }
  return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listDeletedPages(): DeletedPageSummary[] {
  const dir = path.join(WORK_DIR, "trash");
  if (!fs.existsSync(dir)) return [];
  const deleted: DeletedPageSummary[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(dir, entry.name), "utf8");
    const parsed = parsePage(raw, path.posix.join(".weave", "trash", entry.name));
    if (!parsed.ok) continue;
    deleted.push({
      id: parsed.data.id,
      title: parsed.data.title,
      deletedAt: parsed.data.deleted_at ?? null,
      redirectTo: parsed.data.redirect_to ?? null,
    });
  }
  return deleted.sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
}

/** 只清理回收站副本。先移走、提交，再物理删除；失败时恢复原位置。 */
export function purgeTrash(input: { kind: "page" | "batch"; id: string } | { kind: "all" }): { deleted: number } {
  const trashDir = path.join(WORK_DIR, "trash");
  const targets: string[] = [];
  if (input.kind === "all") {
    if (fs.existsSync(trashDir)) {
      for (const entry of fs.readdirSync(trashDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) targets.push(path.join(trashDir, entry.name));
      }
    }
    for (const batch of listArchiveBatches()) targets.push(path.join(BATCHES_DIR, batch.id));
  } else {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(input.id)) throw new ArchiveRestoreError("回收站编号无效。");
    const target = input.kind === "batch" ? path.join(BATCHES_DIR, input.id) : path.join(trashDir, `${input.id}.md`);
    if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) throw new ArchiveRestoreError("这个回收站项目已不存在。");
    targets.push(target);
  }
  if (!targets.length) return { deleted: 0 };
  const staging = path.join(WORK_DIR, `trash-purge-${ulid()}`);
  const moved: Array<{ from: string; to: string }> = [];
  const restoreMetadata = snapshotMetadata();
  suppressWatcher();
  try {
    fs.mkdirSync(staging);
    for (const [index, from] of targets.entries()) {
      const to = path.join(staging, String(index));
      fs.renameSync(from, to);
      moved.push({ from, to });
    }
    appendLog("DELETE", `从回收站移除 ${targets.length} 个项目`);
    commitVault("清理回收站");
  } catch (error) {
    for (const { from, to } of moved.reverse()) fs.renameSync(to, from);
    restoreMetadata();
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  fs.rmSync(staging, { recursive: true, force: true });
  return { deleted: targets.length };
}

/** Restore archived files and their source/review records; refuse path or hash collisions. */
export function restoreArchiveBatch(id: string): ArchiveBatchSummary {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new ArchiveRestoreError("回收站批次编号无效。");
  const batchDir = path.join(BATCHES_DIR, id);
  const manifest = readManifest(batchDir);
  if (!manifest) throw new ArchiveRestoreError("找不到这个回收站批次，或批次清单已损坏。");
  if (manifest.restoredAt) throw new ArchiveRestoreError("这个批次已经恢复过了。");

  ensureVaultLayout();
  const fileGroups = ARCHIVED_DIRS.map((directory) => ({
    source: path.join(batchDir, directory.archive),
    target: directory.active,
  })).filter((group) => fs.existsSync(/* turbopackIgnore: true */ group.source));
  const conflicts: string[] = [];
  const db = getDb();
  const archivedJobs = manifest.jobs ?? [];
  const archivedQueue = manifest.ingestQueue ?? [];
  const existingJobIds = new Set(db.select({ id: jobs.id }).from(jobs).all().map((job) => job.id));
  const existingQueueIds = new Set(db.select({ id: ingestQueue.id }).from(ingestQueue).all().map((item) => item.id));
  if (archivedJobs.some((job) => existingJobIds.has(job.id))) conflicts.push("导入任务编号已存在");
  if (archivedQueue.some((item) => existingQueueIds.has(item.id))) conflicts.push("待处理资料编号已存在");
  const existingSources = db.select({ sha256: sources.sha256 }).from(sources).all();
  const existingHashes = new Set(existingSources.map((row) => row.sha256));
  const duplicateNames = manifest.sources.filter((source) => existingHashes.has(source.sha256));
  for (const source of duplicateNames) conflicts.push(`原始资料「${source.originalName}」已存在`);

  for (const group of fileGroups) {
    for (const relative of listFiles(group.source)) {
      if (fs.existsSync(path.join(group.target, relative))) conflicts.push(relative);
    }
  }
  if (conflicts.length > 0) {
    throw new ArchiveRestoreError(`恢复前发现 ${conflicts.length} 处重名，当前资料没有改动：${conflicts.slice(0, 5).join("、")}`);
  }

  const copied: string[] = [];
  const restoreMetadata = snapshotMetadata([path.join(batchDir, "manifest.json")]);
  suppressWatcher();
  try {
    for (const group of fileGroups) {
      for (const relative of listFiles(group.source)) {
        const from = path.join(group.source, relative);
        const to = path.join(group.target, relative);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        copied.push(to);
      }
    }

    db.transaction((tx) => {
      // 旧批次没有草稿快照，允许来源重新处理，不恢复无法解锁的待审阅状态。
      const sourceRows = manifest.sources.map((source) => ({ ...source, status: manifest.version === 1 && source.status === "awaiting_review" ? "pending" : source.status }));
      if (sourceRows.length) tx.insert(sources).values(sourceRows).run();
      const jobIds = new Set(archivedJobs.map((job) => job.id));
      const reviewRows = manifest.reviewItems.map((item) => ({ ...item, batchId: item.batchId && jobIds.has(item.batchId) ? item.batchId : null }));
      if (reviewRows.length) tx.insert(reviewItems).values(reviewRows).run();
      if (archivedJobs.length) tx.insert(jobs).values(archivedJobs).run();
      if (archivedQueue.length) tx.insert(ingestQueue).values(archivedQueue).run();
      for (const redirect of manifest.redirects ?? []) tx.insert(redirects).values(redirect).onConflictDoNothing().run();
      reindexAll();
      rebuildIndexFile();
      appendLog("RESTORE", `从回收站批次 ${id} 恢复 ${manifest.pageCount} 个词条与 ${manifest.sourceCount} 份原始资料`);
      fs.writeFileSync(path.join(batchDir, "manifest.json"), JSON.stringify({ ...manifest, restoredAt: localISOString() }, null, 2), "utf8");
      commitVault("从回收站恢复知识库资料");
    });
    const restoredAt = localISOString();
    return { ...toSummary(manifest), restoredAt };
  } catch (error) {
    for (const file of copied.reverse()) {
      try { fs.rmSync(file, { force: true }); } catch { /* continue cleanup */ }
    }
    for (const group of fileGroups) pruneEmptyDirectories(group.target);
    restoreMetadata();
    throw error;
  }
}

function readManifest(batchDir: string): ArchiveManifest | null {
  const file = path.join(batchDir, "manifest.json");
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as ArchiveManifest;
    if (![1, 2].includes(value.version) || !Array.isArray(value.sources) || !Array.isArray(value.reviewItems)) return null;
    if (value.version === 2 && (!Array.isArray(value.jobs) || !Array.isArray(value.ingestQueue) || !Array.isArray(value.redirects))) return null;
    return value;
  } catch {
    return null;
  }
}

function snapshotMetadata(extraFiles: string[] = []): () => void {
  ensureGitRepo();
  const files = [path.join(VAULT_ROOT, "index.md"), path.join(VAULT_ROOT, "log.md"), path.join(VAULT_ROOT, ".git", "index"), ...extraFiles];
  const originals = files.map((file) => ({ file, content: fs.existsSync(file) ? fs.readFileSync(file) : null }));
  return () => {
    for (const { file, content } of originals) {
      if (content === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, content);
    }
  };
}

function toSummary(manifest: ArchiveManifest): ArchiveBatchSummary {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    pageCount: manifest.pageCount,
    sourceCount: manifest.sourceCount,
    archivedFiles: manifest.archivedFiles,
    restoredAt: manifest.restoredAt ?? null,
  };
}

function countMarkdown(dir: string): number {
  return listFiles(dir).filter((file) => file.toLowerCase().endsWith(".md")).length;
}

function countFiles(dir: string): number {
  return fs.existsSync(dir) ? listFiles(dir).length : 0;
}

function listFiles(dir: string, prefix = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function pruneEmptyDirectories(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirectories(path.join(root, entry.name));
  }
  if (fs.readdirSync(root).length === 0 && root !== WIKI_DIR && root !== RAW_DIR && root !== PARSED_DIR && root !== INGEST_QUEUE_DIR) {
    fs.rmdirSync(root);
  }
}
