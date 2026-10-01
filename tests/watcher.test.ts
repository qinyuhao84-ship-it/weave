import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startWatcher, stopWatcher, onExternalChange, isWatching, waitUntilReady } from "@/lib/index/watcher";
import { clearSuppression, suppressWatcher } from "@/lib/index/watch-suppression";
import { reindexAll } from "@/lib/index/reindex";
import { getDb, dropAllIndexTables } from "@/lib/db/client";
import { pages } from "@/lib/db/schema";
import { writePage, frontmatterFor, resetVault, vaultRoot } from "./helpers";

/** 等待某个条件成立，或超时 */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

afterEach(async () => {
  await stopWatcher();
  clearSuppression();
});

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
  clearSuppression();
});

describe("文件监听器", () => {
  it("外部新增文件后索引自动更新 —— Obsidian 里改文件也能生效", async () => {
    await waitUntilReady();
    expect(isWatching()).toBe(true);

    // 模拟用户在 Obsidian 里新建了一个词条
    writePage("wai-bu", frontmatterFor("01EXT", "外部新建"), "这是在应用外创建的。");

    const indexed = await waitFor(
      () => getDb().select().from(pages).all().some((p) => p.id === "01EXT"),
    );
    expect(indexed).toBe(true);
  }, 15000);

  it("外部修改文件后索引内容更新", async () => {
    const relative = writePage("a", frontmatterFor("01A", "原标题"), "原正文");
    reindexAll();
    await waitUntilReady();

    // 模拟用户在 Obsidian 里改了标题
    const absolute = path.join(vaultRoot(), relative);
    fs.writeFileSync(
      absolute,
      fs.readFileSync(absolute, "utf8").replace("原标题", "改后标题"),
      "utf8",
    );

    const updated = await waitFor(
      () => getDb().select().from(pages).all().some((p) => p.title === "改后标题"),
    );
    expect(updated).toBe(true);
  }, 15000);

  it("外部删除文件后词条被标记为已删除", async () => {
    const relative = writePage("a", frontmatterFor("01A", "甲"), "正文");
    reindexAll();

    const events: string[] = [];
    onExternalChange(({ changes }) => changes.forEach((c) => events.push(c.kind)));

    await waitUntilReady();

    fs.unlinkSync(path.join(vaultRoot(), relative));

    const deleted = await waitFor(
      () => getDb().select().from(pages).all().some((p) => p.status === "deleted"),
    );
    expect({ deleted, events }).toEqual({
      deleted: true,
      events: expect.arrayContaining(["unlink"]),
    });
  }, 15000);

  it("订阅者收到外部变更事件 —— 前端据此提示用户", async () => {
    reindexAll();
    await waitUntilReady();

    const received: string[] = [];
    const unsubscribe = onExternalChange(({ changes }) => {
      for (const c of changes) received.push(`${c.kind}:${c.relativePath}`);
    });

    writePage("b", frontmatterFor("01B", "乙"), "正文");

    await waitFor(() => received.length > 0);
    unsubscribe();
    expect(received.some((r) => r.includes("wiki/entities/b.md"))).toBe(true);
  }, 15000);

  it("服务层写入期间的事件被抑制，不重复重建索引", async () => {
    await waitUntilReady();
    suppressWatcher(5000);

    const received: string[] = [];
    const unsubscribe = onExternalChange(() => received.push("fired"));

    writePage("c", frontmatterFor("01C", "丙"), "正文");
    await new Promise((r) => setTimeout(r, 1200));

    unsubscribe();
    expect(received).toHaveLength(0);
  }, 15000);

  it("忽略 .weave 与隐藏目录", async () => {
    await waitUntilReady();
    const received: string[] = [];
    const unsubscribe = onExternalChange(({ changes }) => {
      for (const c of changes) received.push(c.relativePath);
    });

    // 在我们的工作目录里造点动静，不该被当成知识库变更
    const workDir = path.join(vaultRoot(), ".weave");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "noise.md"), "噪音", "utf8");

    await new Promise((r) => setTimeout(r, 1200));
    unsubscribe();
    expect(received).toHaveLength(0);
  }, 15000);

  it("重复 start 是幂等的", async () => {
    await startWatcher();
    await startWatcher();
    expect(isWatching()).toBe(true);
  }, 15000);
});
