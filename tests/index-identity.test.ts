import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, getSqlite, dropAllIndexTables } from "@/lib/db/client";
import { chatMessages, pages, redirects, reviewItems } from "@/lib/db/schema";
import { reindexAll } from "@/lib/index/reindex";
import { retrieve } from "@/lib/chat/retrieve";
import { buildWikilinkTable } from "@/lib/index/wikilink-table";
import { appendMessage, createSession, getMessages, markFiled } from "@/lib/chat/sessions";
import { loadPageFile, updatePage } from "@/lib/vault/service";
import { checkReadiness } from "@/lib/readiness";
import { frontmatterFor, readPageRaw, resetVault, vaultRoot, writePage } from "./helpers";

beforeEach(() => { resetVault(); dropAllIndexTables(); });

it("所有重复 ID 文件都退出证据索引，原文件与应用数据保持不变，修正后自动恢复", async () => {
  const originalPath = writePage("original", frontmatterFor("DUPLICATE", "原词条"), "只有原文包含的甲事实。");
  writePage("referrer", frontmatterFor("REFERRER", "引用者"), "参考 [[原词条]] 与 [[曾用名]]。");
  reindexAll();
  const sessionId = createSession("归档关联");
  const messageId = appendMessage({ sessionId, role: "assistant", content: "已归档的回答" });
  markFiled(messageId, "DUPLICATE");
  getDb().insert(reviewItems).values({ id: "DECISION", kind: "contradiction", title: "已确认裁决", status: "answered", answer: "用户判断", createdAt: "2026-01-01" }).run();
  getDb().insert(redirects).values({ oldNormalized: "曾用名", oldRaw: "曾用名", newPageId: "DUPLICATE", reason: "rename", createdAt: "2026-01-01" }).run();
  const duplicatePath = writePage("copy", frontmatterFor("DUPLICATE", "复制词条"), "只有复制文包含的乙事实。");
  const original = readPageRaw(originalPath), duplicate = readPageRaw(duplicatePath);
  const report = reindexAll();
  expect(report.idConflicts).toEqual([{ pageId: "DUPLICATE", relativePaths: [duplicatePath, originalPath] }]);
  expect(report.broken).toHaveLength(2);
  expect(getDb().select().from(pages).where(eq(pages.id, "DUPLICATE")).get()).toMatchObject({ status: "conflicted", filePath: originalPath, deletedAt: null });
  expect(retrieve("甲事实").some(page => page.pageId === "DUPLICATE")).toBe(false);
  expect(getSqlite().prepare("SELECT count(*) AS n FROM pages_fts WHERE page_id = ?").get("DUPLICATE")).toEqual({ n: 0 });
  expect(getSqlite().prepare("SELECT count(*) AS n FROM links WHERE dst_page_id = ?").get("DUPLICATE")).toEqual({ n: 0 });
  expect(getSqlite().prepare("SELECT count(*) AS n FROM edges WHERE target_page_id = ? OR source_page_id = ?").get("DUPLICATE", "DUPLICATE")).toEqual({ n: 0 });
  expect(buildWikilinkTable()["曾用名"]).toBeUndefined();
  expect(() => loadPageFile("DUPLICATE")).toThrow("同一 id");
  expect(() => updatePage("DUPLICATE", { content: "不能覆盖" })).toThrow("同一 id");
  expect(getMessages(sessionId)[0].filedAsPageId).toBe("DUPLICATE");
  expect(getDb().select().from(chatMessages).where(eq(chatMessages.id, messageId)).get()?.filedAsPageId).toBe("DUPLICATE");
  expect(getDb().select().from(reviewItems).where(eq(reviewItems.id, "DECISION")).get()?.answer).toBe("用户判断");
  expect(getDb().select().from(redirects).get()?.newPageId).toBe("DUPLICATE");
  expect(readPageRaw(originalPath)).toBe(original); expect(readPageRaw(duplicatePath)).toBe(duplicate);
  expect((await checkReadiness()).find(check => check.name === "词条身份")?.detail).toContain(duplicatePath);
  fs.unlinkSync(path.join(vaultRoot(), duplicatePath));
  expect(reindexAll().idConflicts).toEqual([]);
  expect(loadPageFile("DUPLICATE").content).toContain("甲事实");
  expect(getMessages(sessionId)[0].filedAsPageId).toBe("DUPLICATE");
  expect(buildWikilinkTable()["曾用名"]?.pageId).toBe("DUPLICATE");
});

it("首次导入的重复 ID 不挑选任意文件作为词条", () => {
  writePage("a", frontmatterFor("DUPLICATE", "甲"), "甲事实");
  writePage("b", frontmatterFor("DUPLICATE", "乙"), "乙事实");
  const report = reindexAll();
  expect(report.pages).toBe(0); expect(report.broken).toHaveLength(2);
  expect(getDb().select().from(pages).all()).toEqual([]);
  expect(retrieve("甲事实")).toEqual([]);
});

it.each([false, true])("修正原文件 ID 后恢复真实路径 ownership，保留旧记录（两份均换 ID：%s）", replaceBoth => {
  const originalPath = writePage("a", frontmatterFor("ORIGINAL", "原词条"), "甲事实");
  reindexAll();
  writePage("b", frontmatterFor("ORIGINAL", "复制词条"), "乙事实");
  reindexAll();
  writePage("a", frontmatterFor("NEW", "新词条"), "甲事实");
  if (replaceBoth) writePage("b", frontmatterFor("COPY", "复制词条"), "乙事实");
  expect(reindexAll().pages).toBe(2);
  expect(loadPageFile("NEW").relativePath).toBe(originalPath);
  expect(loadPageFile(replaceBoth ? "COPY" : "ORIGINAL").content).toContain("乙事实");
  expect(getDb().select().from(pages).where(eq(pages.id, "ORIGINAL")).get()).toBeDefined();
  expect(retrieve("甲事实")[0].pageId).toBe("NEW");
});
