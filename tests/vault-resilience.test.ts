import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { dropAllIndexTables, getDb } from "@/lib/db/client";
import { redirects } from "@/lib/db/schema";
import { createPage, renamePage, mergePages, updatePage, loadPageFile, ConflictError } from "@/lib/vault/service";
import { recoverVaultTransactions, prepareJournal, cleanAtomicTemps } from "@/lib/vault/transaction-journal";
import * as atomic from "@/lib/vault/atomic";
import { reindexAll } from "@/lib/index/reindex";
import { resetVault, vaultRoot } from "./helpers";

beforeEach(() => { vi.restoreAllMocks(); resetVault(); dropAllIndexTables(); });
afterEach(() => vi.restoreAllMocks());

it.each(["rename", "merge"])("%s 读取引用文件后发生外部编辑，不覆盖外部版本", operation => {
  const source = createPage({ type: "concept", title: "原名", content: "原正文" });
  const target = createPage({ type: "concept", title: "目标", content: "目标正文" });
  const ref = createPage({ type: "concept", title: "引用", content: "[[原名]]" });
  const before = loadPageFile(ref.pageId);
  const read = atomic.readFileIfExists;
  let changed = false;
  vi.spyOn(atomic, "readFileIfExists").mockImplementation(file => {
    const value = read(file);
    if (file === path.join(vaultRoot(), before.relativePath) && !changed) {
      changed = true;
      fs.writeFileSync(file, before.raw + "\nObsidian 新增事实");
    }
    return value;
  });
  expect(() => operation === "rename" ? renamePage(source.pageId, "新名") : mergePages({ sourcePageId: source.pageId, targetPageId: target.pageId })).toThrow(ConflictError);
  expect(loadPageFile(ref.pageId).raw).toContain("Obsidian 新增事实");
  expect(loadPageFile(source.pageId).data.title).toBe("原名");
});

it("残留 index.lock 不使保存回滚，并保留锁文件", () => {
  const page = createPage({ type: "concept", title: "保存", content: "原正文" });
  const lock = path.join(vaultRoot(), ".git/index.lock");
  fs.writeFileSync(lock, "外部 Git 锁");
  try {
    const result = updatePage(page.pageId, { content: "已保存正文" });
    expect(result.backupWarning).toContain("内容已保存"); expect(result.commitSha).toBeNull();
    expect(loadPageFile(page.pageId).content).toContain("已保存正文");
    expect(fs.readFileSync(lock, "utf8")).toBe("外部 Git 锁");
  } finally { fs.rmSync(lock, { force: true }); }
});

it("临时文件同步期间发生外部编辑，发布前拒绝覆盖并保留外部正文", () => {
  const page = createPage({ type: "concept", title: "并发保存", content: "原正文" });
  const file = loadPageFile(page.pageId);
  const target = path.join(vaultRoot(), file.relativePath);
  const fsync = fs.fsyncSync;
  const open = fs.openSync;
  let pendingDescriptor: number | null = null;
  let changed = false;
  vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const descriptor = open(...args);
    if (String(args[0]).includes(`.${path.basename(target)}.`) && args[1] === "wx") pendingDescriptor = descriptor;
    return descriptor;
  });
  vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
    if (descriptor === pendingDescriptor && !changed) { changed = true; fs.writeFileSync(target, file.raw + "\nObsidian 并发编辑"); }
    fsync(descriptor);
  });
  expect(() => updatePage(page.pageId, { content: "应用修改", expectedHash: atomic.sha256(file.raw) })).toThrow(ConflictError);
  expect(fs.readFileSync(target, "utf8")).toContain("Obsidian 并发编辑");
  expect(fs.readFileSync(target, "utf8")).not.toContain("应用修改");
});

it.each(["writing", "committed"])("SIGKILL 发生在 %s 时，依据 SQLite 标记恢复文件", phase => {
  const page = createPage({ type: "concept", title: "原名", content: "原正文" });
  const ref = createPage({ type: "concept", title: "引用", content: "[[原名]]" });
  const child = spawnSync(process.execPath, ["--import", "tsx", "tests/fixtures/crash-vault.mts", phase, page.pageId], {
    cwd: process.cwd(), env: { ...process.env, WEAVE_CRASH_TEST: "1" }, encoding: "utf8", timeout: 20_000,
  });
  expect(child.signal, child.stderr).toBe("SIGKILL");
  expect(recoverVaultTransactions()).toBe(phase === "writing" ? 1 : 0);
  reindexAll();
  expect(loadPageFile(page.pageId).data.title).toBe(phase === "writing" ? "原名" : "中断后新名");
  expect(loadPageFile(ref.pageId).content).toContain(phase === "writing" ? "[[原名]]" : "[[中断后新名");
  const redirectCount = getDb().select().from(redirects).all().length;
  if (phase === "writing") expect(redirectCount).toBe(0);
  else expect(redirectCount).toBeGreaterThan(0);
  expect(recoverVaultTransactions()).toBe(0);
  expect(fs.readdirSync(path.join(vaultRoot(), ".weave/transactions"))).toEqual([]);
}, 30_000);

it("中断后又有外部编辑，恢复不覆盖用户内容且保留日志", () => {
  const page = createPage({ type: "concept", title: "原名", content: "原正文" });
  const file = loadPageFile(page.pageId);
  prepareJournal([{ relative: file.relativePath, original: file.raw, next: file.raw + "\n事务内容" }]);
  fs.writeFileSync(path.join(vaultRoot(), file.relativePath), file.raw + "\n外部新增");
  expect(() => recoverVaultTransactions()).toThrow("外部修改");
  expect(loadPageFile(page.pageId).raw).toContain("外部新增");
  expect(fs.readdirSync(path.join(vaultRoot(), ".weave/transactions"))).toHaveLength(1);
});

it("启动只清理本应用命名的临时文件", () => {
  const dir = path.join(vaultRoot(), "wiki");
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, ".page.md.123.1234567890123.tmp");
  const external = path.join(dir, "Obsidian.tmp");
  fs.writeFileSync(stale, "未提交片段"); fs.writeFileSync(external, "外部临时文件");
  cleanAtomicTemps();
  expect(fs.existsSync(stale)).toBe(false); expect(fs.readFileSync(external, "utf8")).toBe("外部临时文件");
});

it.each(["clear", "restore", "purge"].flatMap(operation => ["writing", "committed"].map(phase => [operation, phase])))("整库 %s 在 %s 中断后可恢复且幂等", async (operation, phase) => {
  const { clearKnowledgeBase, listArchiveBatches } = await import("@/lib/vault/archive-batches");
  const page = createPage({ type: "concept", title: "归档原文", content: "原正文" });
  const raw = path.join(vaultRoot(), "raw", "original.bin");
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  fs.writeFileSync(raw, Buffer.from([0, 255, 13, 10]));
  const batch = operation !== "clear" ? clearKnowledgeBase() : null;
  const child = spawnSync(process.execPath, ["--import", "tsx", "tests/fixtures/crash-vault.mts", phase, batch?.id ?? page.pageId, operation], {
    cwd: process.cwd(), env: { ...process.env, WEAVE_CRASH_TEST: "1" }, encoding: "utf8", timeout: 20_000,
  });
  expect(child.signal, child.stderr).toBe("SIGKILL");
  expect(recoverVaultTransactions()).toBe(phase === "writing" ? 1 : 0);
  reindexAll();
  const pagePresent = operation === "clear" ? phase === "writing" : operation === "restore" && phase === "committed";
  if (pagePresent) {
    expect(loadPageFile(page.pageId).content).toContain("原正文");
    expect(fs.readFileSync(raw)).toEqual(Buffer.from([0, 255, 13, 10]));
  } else expect(() => loadPageFile(page.pageId)).toThrow();
  if (operation === "purge") expect(listArchiveBatches()).toHaveLength(phase === "committed" ? 0 : 1);
  if (operation === "restore") expect(listArchiveBatches()[0].restoredAt !== null).toBe(phase === "committed");
  expect(recoverVaultTransactions()).toBe(0);
}, 30_000);
