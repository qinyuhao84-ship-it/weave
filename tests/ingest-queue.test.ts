import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { dropAllIndexTables, getDb } from "@/lib/db/client";
import { deleteQueuedIngest, listIngestQueue, stageIngestFile } from "@/lib/ingest/queue";
import { ingestQueue, jobs } from "@/lib/db/schema";
import { INGEST_QUEUE_DIR } from "@/lib/vault/paths";
import { resetVault } from "./helpers";

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

describe("持久化导入队列", () => {
  it("文件完整写入暂存区后才出现在队列中", async () => {
    const bytes = Buffer.from("A small file kept for retry.");
    const item = await stageIngestFile("资料.md", bytes);

    expect(listIngestQueue()).toMatchObject([
      { id: item.id, originalName: "资料.md", byteSize: bytes.byteLength, status: "queued" },
    ]);
    expect(fs.readFileSync(path.join(INGEST_QUEUE_DIR, `${item.id}.bin`))).toEqual(bytes);
  });

  it("移除排队或失败项目时同时删除数据库记录和暂存文件", async () => {
    const item = await stageIngestFile("资料.txt", Buffer.from("retry me"));
    const stagedPath = path.join(INGEST_QUEUE_DIR, `${item.id}.bin`);

    expect(deleteQueuedIngest(item.id)).toBe("removed");
    expect(listIngestQueue()).toEqual([]);
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it("刷新时把中断或失败的任务恢复成可重试队列项", async () => {
    const item = await stageIngestFile("失败资料.txt", Buffer.from("retry me"));
    getDb().insert(jobs).values({
      id: "01FAILEDJOB",
      kind: "ingest",
      status: "failed",
      stage: "parsing",
      progress: 30,
      total: 100,
      error: "解析失败",
      createdAt: "2026-09-28T10:00:00+08:00",
      updatedAt: "2026-09-28T10:00:01+08:00",
    }).run();
    getDb().update(ingestQueue)
      .set({ status: "processing", jobId: "01FAILEDJOB" })
      .where(eq(ingestQueue.id, item.id))
      .run();

    expect(listIngestQueue()).toMatchObject([
      { id: item.id, status: "failed", error: "解析失败" },
    ]);
  });
});
