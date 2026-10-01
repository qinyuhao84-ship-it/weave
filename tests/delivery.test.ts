import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { getDb, dropAllIndexTables } from "@/lib/db/client";
import { jobs, sources, ingestQueue, chatSessions, chatMessages, redirects } from "@/lib/db/schema";
import { clearKnowledgeBase, restoreArchiveBatch, listArchiveBatches, listDeletedPages, purgeTrash } from "@/lib/vault/archive-batches";
import { createPage, updatePage, renamePage, loadPageFile, deletePage, ConflictError, VaultRecoveryError } from "@/lib/vault/service";
import { ensureVaultLayout, VAULT_ROOT, INGEST_QUEUE_DIR } from "@/lib/vault/paths";
import { hasUncommittedChanges, commitVault, revertCommit, logVault } from "@/lib/git/auto-commit";
import { sha256 } from "@/lib/vault/atomic";
import * as atomic from "@/lib/vault/atomic";
import { excerptForQuery, retrieve } from "@/lib/chat/retrieve";
import { createSession, listSessions, countSessions, appendMessage, markFiled, getMessages } from "@/lib/chat/sessions";
import { saveIngestReview, ReviewSaveConflict, SaveReviewSchema } from "@/lib/ingest/review-draft";
import { verifyCitations, commitIngest, type IngestDraft } from "@/lib/ingest/pipeline";
import { repairEscapedParagraphs, applyFormatRepair } from "@/lib/vault/format-repair";
import { knowledgeContextForDocument } from "@/lib/ingest/knowledge-context";
import { buildCatalog, graphStats } from "@/lib/index/catalog";
import { sampleForReview } from "@/lib/lint";
import { stageIngestFile, listIngestQueue } from "@/lib/ingest/queue";
import * as indexModule from "@/lib/index/reindex";
import { resetVault, writePage, frontmatterFor } from "./helpers";
import { isLocalRequest } from "@/lib/local-access";
import { localNextArgs } from "../scripts/local-host.mjs";
import { readJsonObject, handle, toUserMessage } from "@/lib/api";
import { canResumePendingReview } from "@/components/ingest/use-review-autosave";
import { POST as chatRequest } from "@/app/api/chat/route";
import * as settingsModule from "@/lib/settings";
import { NextRequest } from "next/server";
import { GET as sourceList } from "@/app/api/sources/route";
import { GET as pageList } from "@/app/api/pages/route";

const timestamp = "2026-09-30T12:00:00+08:00";
const draft = { sourceSummary: { title: "来源摘要", content: "测试资料" }, newPages: [], updatedPages: [], reviewItems: [] };
function failGit() { const hook = path.join(VAULT_ROOT, ".git/hooks/pre-commit"); fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 }); }
function stopFailingGit() { fs.rmSync(path.join(VAULT_ROOT, ".git/hooks/pre-commit"), { force: true }); }
function seedDraft() {
  ensureVaultLayout();
  const staged: IngestDraft = { jobId: "DRAFT", source: { id: "SOURCE", docPath: "raw/test.md", originalName: "test.md", sha256: "hash", byteSize: 12, pageCount: null, parser: "markdown", importedAt: timestamp }, markdown: "真实证据", tokenEstimate: 10, warnings: [], upgradeHint: null, analysis: {} as IngestDraft["analysis"], draft };
  getDb().insert(sources).values({ id: "SOURCE", docPath: "raw/test.md", originalName: "test.md", sha256: "hash", byteSize: 12, importedAt: timestamp, status: "awaiting_review" }).run();
  fs.writeFileSync(path.join(VAULT_ROOT, "raw/test.md"), "真实证据");
  getDb().insert(jobs).values({ id: "DRAFT", kind: "ingest", status: "awaiting_review", draftJson: JSON.stringify(staged), createdAt: timestamp, updatedAt: timestamp }).run();
  return staged;
}
beforeEach(() => {
  vi.restoreAllMocks(); stopFailingGit(); resetVault(); dropAllIndexTables();
  const db = getDb(); for (const table of [jobs, sources, ingestQueue, chatMessages, chatSessions]) db.delete(table).run();
});
afterEach(() => { vi.restoreAllMocks(); stopFailingGit(); });

describe("本机访问边界", () => {
  it.each(["127.0.0.1:3000", "localhost:3000", "[::1]:3000"])("允许正常本机同源 %s", host => {
    expect(isLocalRequest(`http://${host}/api/chat`, new Headers({ host, origin: `http://${host}` }))).toBe(true);
  });
  it.each([{ host: "evil.example:3000" }, { host: "127.0.0.1:3000", origin: "https://evil.example" }, { host: "127.0.0.1:3000", origin: "null" }, { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" }])("拒绝跨站或非本机主机 %o", headers => {
    expect(isLocalRequest("http://127.0.0.1:3000/api/chat", new Headers(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")))).toBe(false);
  });
  it("默认绑定本机，不能通过长短选项开放网卡", () => {
    expect(localNextArgs(["-p", "3200"])).toEqual(["-p", "3200", "--hostname", "127.0.0.1"]);
    for (const args of [["-H", "0.0.0.0"], ["--hostname=0.0.0.0"], ["-H0.0.0.0"]]) expect(() => localNextArgs(args)).toThrow();
  });
  it("新对话 null / 缺省编号通过输入校验，错误问题类型仍返回400", async () => {
    vi.spyOn(settingsModule, "isLlmConfigured").mockReturnValue(false);
    for (const body of [{ question: "正常问题", sessionId: null }, { question: "正常问题" }]) expect((await chatRequest(new NextRequest("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }))).status).toBe(412);
    for (const body of [{ question: 123 }, { question: ["x"] }, null, { question: "x", sessionId: 123 }]) expect((await chatRequest(new NextRequest("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }))).status).toBe(400);
  });
  it.each([null, 123, ["x"], "text"])("JSON 非对象 %j 返回统一 400", async body => {
    const response = await handle(() => readJsonObject(new Request("http://localhost", { method: "POST", body: JSON.stringify(body) })));
    expect(response.status).toBe(400); expect((await response.json()).ok).toBe(false);
  });
});

describe("清空和批次恢复", () => {
  it("回收站单条删除和全部清空不影响活跃资料，拒绝路径穿越", () => {
    const discarded = createPage({ type: "concept", title: "待删除", content: "旧正文" });
    deletePage(discarded.pageId, { kind: "keep_dangling" });
    const batch = clearKnowledgeBase();
    const active = createPage({ type: "concept", title: "保留", content: "新正文" });
    expect(() => purgeTrash({ kind: "batch", id: "../../wiki" })).toThrow();
    expect(purgeTrash({ kind: "batch", id: batch.id }).deleted).toBe(1);
    const another = createPage({ type: "concept", title: "单条", content: "旧资料" });
    deletePage(another.pageId, { kind: "keep_dangling" });
    expect(purgeTrash({ kind: "page", id: another.pageId }).deleted).toBe(1);
    expect(listDeletedPages().map(item => item.id)).toEqual([discarded.pageId]);
    const last = createPage({ type: "concept", title: "最后", content: "旧资料" });
    deletePage(last.pageId, { kind: "keep_dangling" });
    expect(purgeTrash({ kind: "all" }).deleted).toBe(2);
    expect(listDeletedPages()).toHaveLength(0); expect(listArchiveBatches()).toHaveLength(0);
    expect(loadPageFile(active.pageId).content.trim()).toBe("新正文");
  });
  it("回收站删除提交失败时恢复文件，仍然可以恢复词条", () => {
    const page = createPage({ type: "concept", title: "删除失败", content: "保留副本" });
    deletePage(page.pageId, { kind: "keep_dangling" });
    failGit(); expect(() => purgeTrash({ kind: "page", id: page.pageId })).toThrow();
    expect(listDeletedPages().map(item => item.id)).toContain(page.pageId);
    expect(hasUncommittedChanges()).toBe(false);
  });
  it("恢复完整人工草稿、队列原件和来源状态，并保持工作区干净", async () => {
    createPage({ type: "concept", title: "概念", content: "正文" }); seedDraft();
    saveIngestReview("DRAFT", { draft: { ...draft, sourceSummary: { title: "人工标题", content: "人工正文" } }, reviewState: { skippedTitles: ["概念"], decisions: [[0, { note: "人工批注", answer: "答复", choiceId: null }]] }, revision: 0 });
    const queued = await stageIngestFile("queued.md", Buffer.from("排队正文"));
    const before = getDb().select().from(jobs).where(eq(jobs.id, "DRAFT")).get()!.draftJson;
    const batch = clearKnowledgeBase(); expect(listIngestQueue()).toHaveLength(0);
    restoreArchiveBatch(batch.id);
    expect(getDb().select().from(jobs).where(eq(jobs.id, "DRAFT")).get()!.draftJson).toBe(before);
    expect(getDb().select().from(sources).get()!.status).toBe("awaiting_review");
    expect(listIngestQueue()[0].id).toBe(queued.id);
    expect(fs.readFileSync(path.join(INGEST_QUEUE_DIR, `${queued.id}.bin`), "utf8")).toBe("排队正文");
    expect(hasUncommittedChanges()).toBe(false);
  });
  it("Git 清空失败不改变文件、来源、草稿和暂存状态", () => {
    const page = createPage({ type: "concept", title: "概念", content: "正文" }); seedDraft(); commitVault("保存样本");
    failGit(); expect(() => clearKnowledgeBase()).toThrow();
    expect(loadPageFile(page.pageId).content).toContain("正文"); expect(getDb().select().from(jobs).get()!.status).toBe("awaiting_review");
    expect(listArchiveBatches()).toHaveLength(0); expect(hasUncommittedChanges()).toBe(false);
  });
  it("恢复失败仍可安全重试，不留下已恢复标记和半份资料", () => {
    seedDraft(); const batch = clearKnowledgeBase(); failGit();
    expect(() => restoreArchiveBatch(batch.id)).toThrow(); expect(getDb().select().from(sources).all()).toHaveLength(0);
    expect(listArchiveBatches()[0].restoredAt).toBeNull(); expect(hasUncommittedChanges()).toBe(false);
    stopFailingGit(); restoreArchiveBatch(batch.id); expect(getDb().select().from(jobs).get()!.id).toBe("DRAFT");
  });
  it("旧版缺少任务的批次恢复来源为可重新处理状态", () => {
    seedDraft(); const batch = clearKnowledgeBase();
    const file = path.join(VAULT_ROOT, ".weave/trash/batches", batch.id, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")); manifest.version = 1; delete manifest.jobs; delete manifest.ingestQueue; delete manifest.redirects;
    fs.writeFileSync(file, JSON.stringify(manifest)); restoreArchiveBatch(batch.id);
    expect(getDb().select().from(sources).get()!.status).toBe("pending");
  });
});

describe("文件、索引、Git 失败的原子性", () => {
  it("文件恢复失败仍恢复其余快照与原有 Git 暂存，报告原始和恢复错误", () => {
    const page = createPage({ type: "concept", title: "恢复故障", content: "原内容" });
    const before = loadPageFile(page.pageId);
    const indexPath = path.join(VAULT_ROOT, ".git/index");
    const gitIndex = fs.readFileSync(indexPath);
    const log = fs.readFileSync(path.join(VAULT_ROOT, "log.md"), "utf8");
    const write = atomic.writeFileAtomic;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, content) => {
      if (file === path.join(VAULT_ROOT, before.relativePath) && content === before.raw) throw new Error("recovery fault");
      write(file, content);
    });
    failGit();
    let caught: unknown;
    try { updatePage(page.pageId, { content: "新内容" }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(VaultRecoveryError);
    const error = caught as VaultRecoveryError;
    expect(String(error.cause)).toContain("git");
    expect(error.errors).toHaveLength(2);
    expect(String(error.errors[1])).toContain("文件快照未完整恢复");
    expect(fs.readFileSync(indexPath)).toEqual(gitIndex);
    expect(fs.readFileSync(path.join(VAULT_ROOT, "log.md"), "utf8")).toBe(log);
    expect(toUserMessage(error)).toEqual({ message: error.message, status: 500 });
    expect(error.message).toContain("不要继续写入");
    expect(error.message).not.toContain(VAULT_ROOT);
  });

  it("多个恢复失败全部报告，Git 暂存恢复失败不替换原始故障", () => {
    const page = createPage({ type: "concept", title: "暂存恢复故障", content: "原内容" });
    const before = loadPageFile(page.pageId);
    const indexPath = path.join(VAULT_ROOT, ".git/index");
    const write = atomic.writeFileAtomic;
    const writeFile = fs.writeFileSync;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, content) => {
      if (file === path.join(VAULT_ROOT, before.relativePath) && content === before.raw) throw new Error("recovery fault");
      write(file, content);
    });
    vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]) === indexPath) throw new Error("index recovery fault");
      writeFile(...args);
    });
    failGit();
    let caught: unknown;
    try { updatePage(page.pageId, { content: "新内容" }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(VaultRecoveryError);
    const error = caught as VaultRecoveryError;
    expect(error.errors).toHaveLength(3);
    expect(String(error.cause)).toContain("git");
    expect(String(error.errors[2])).toContain("index recovery fault");
  });
  it("改名 Git 失败后正文、引用、重定向、Git 暂存与索引均回滚", () => {
    const first = createPage({ type: "concept", title: "旧名", content: "原内容" });
    const linked = createPage({ type: "concept", title: "引用者", content: "[[旧名]]" });
    const before = loadPageFile(first.pageId).raw; const log = fs.readFileSync(path.join(VAULT_ROOT, "log.md"), "utf8");
    failGit(); expect(() => renamePage(first.pageId, "新名")).toThrow();
    expect(loadPageFile(first.pageId).raw).toBe(before); expect(loadPageFile(linked.pageId).content).toContain("[[旧名]]");
    expect(getDb().select().from(redirects).all()).toHaveLength(0); expect(hasUncommittedChanges()).toBe(false);
    expect(fs.readFileSync(path.join(VAULT_ROOT, "log.md"), "utf8")).toBe(log);
  });
  it("索引失败不留下已保存正文，可重试", () => {
    const page = createPage({ type: "concept", title: "索引失败", content: "原内容" }); const raw = loadPageFile(page.pageId).raw;
    vi.spyOn(indexModule, "reindexAll").mockImplementationOnce(() => { throw new Error("index fault"); });
    expect(() => updatePage(page.pageId, { content: "错误写入" })).toThrow("index fault");
    expect(loadPageFile(page.pageId).raw).toBe(raw); expect(hasUncommittedChanges()).toBe(false);
    updatePage(page.pageId, { content: "重试成功" }); expect(loadPageFile(page.pageId).content).toContain("重试成功");
  });
  it("文件替换失败不留下局部修改", () => {
    const page = createPage({ type: "concept", title: "文件失败", content: "原内容" }); const raw = loadPageFile(page.pageId).raw;
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("write fault"); });
    expect(() => updatePage(page.pageId, { content: "新内容" })).toThrow(); expect(loadPageFile(page.pageId).raw).toBe(raw);
  });
});

describe("检索、引用和语义检查覆盖", () => {
  it.each([0, 4000, 8000])("长正文位置 %i 的命中能进入有限预算", position => {
    const content = "无关内容".repeat(2500); const body = content.slice(0, position) + " unique_tail_evidence 27% " + content.slice(position);
    const result = excerptForQuery(body, "unique_tail_evidence", 500); expect(result.length).toBeLessThanOrEqual(500); expect(result).toContain("unique_tail_evidence 27%");
  });
  it("全文命中尾部事实，返回正文预算而非完整文件长度", () => {
    writePage("long", frontmatterFor("LONG", "长正文"), "无关".repeat(4000) + "unique_tail_evidence 27%"); indexModule.reindexAll();
    const result = retrieve("unique_tail_evidence", { charBudget: 200 }); expect(result[0].content).toContain("27%"); expect(result[0].content.length).toBeLessThanOrEqual(200);
  });
  it("引用必须在指定页存在，否则移除虚假页码，保留真实证据", () => {
    const withCitation = { ...draft, newPages: [{ type: "concept" as const, title: "证据", summary: "", content: "正文", aliases: [], tags: [], confidence: "high" as const, citations: [{ page: 2, quote: "第一页真实证据" }, { page: 999, quote: "第二页真实证据" }, { page: 2, quote: "第二页真实证据" }] }] };
    const checked = verifyCitations(withCitation, "<!-- page:1 -->\n第一页真实证据\n<!-- page:2 -->\n第二页真实证据", { log: () => {} }, 2);
    expect(checked.newPages[0].citations.map(item => item.page)).toEqual([null, null, 2]);
    expect(verifyCitations(withCitation, "第一页真实证据\n第二页真实证据", { log: () => {} }).newPages[0].citations.every(item => item.page === null)).toBe(true);
  });
  it("重复体检轮换全部类型与长文段落，只计成功检查", () => {
    writePage("long", frontmatterFor("LONG", "长正文"), "头部".repeat(2000) + "末尾事实");
    writePage("query", frontmatterFor("QUERY", "问答", { type: "query" }), "问答正文"); indexModule.reindexAll();
    const catalog = buildCatalog(); const first = sampleForReview(catalog, 1); expect(first.coverage.totalPages).toBe(2);
    expect(sampleForReview(catalog, 1).samples).toEqual(first.samples); first.recordSuccess();
    const second = sampleForReview(catalog, 1); expect(second.samples[0].title).not.toBe(first.samples[0].title); second.recordSuccess();
    const third = sampleForReview(catalog, 1); expect(third.samples[0].title).toContain("第 2/"); expect(third.coverage.checkedSegments).toBe(2);
  });
  it("导入目录超过160项仍保留尾项，并读取名称匹配的相关正文事实", () => {
    writePage("target", frontmatterFor("TARGET", "推荐算法"), "背景".repeat(2000) + "探索比例是27%"); indexModule.reindexAll();
    const entry = buildCatalog()[0]; const catalog = Array.from({ length: 170 }, (_, i) => ({ ...entry, id: String(i), title: `词条${i}`, aliases: [] as string[] })); catalog.push(entry);
    const context = knowledgeContextForDocument(catalog, "推荐算法探索比例是31%"); expect(context).toContain("词条169"); expect(context).toContain("探索比例是27%");
  });
  it("图谱统计与总度为零一致，出链节点并不孤立", () => {
    writePage("a", frontmatterFor("A", "甲词条"), "[[乙词条]]"); writePage("b", frontmatterFor("B", "乙词条"), "正文"); indexModule.reindexAll(); expect(graphStats().orphans).toBe(0);
  });
});

describe("人工成果、旧格式和撤销归档", () => {
  it("持久保存草稿与裁决，拒绝旧版本覆盖", () => {
    seedDraft(); const input = { draft: { ...draft, sourceSummary: { title: "人工标题", content: "人工正文" } }, reviewState: { skippedTitles: ["跳过"], decisions: [] }, revision: 0 };
    expect(saveIngestReview("DRAFT", input)).toBe(1); expect(() => saveIngestReview("DRAFT", input)).toThrow(ReviewSaveConflict);
    const saved = JSON.parse(getDb().select().from(jobs).get()!.draftJson!); expect(saved.draft.sourceSummary.title).toBe("人工标题"); expect(saved.reviewState.skippedTitles).toEqual(["跳过"]);
    expect(SaveReviewSchema.safeParse(null).success).toBe(false);
  });
  it("刷新期间请求已保存但响应未收到时，只接续本浏览器确认过的版本", () => {
    const server = { draft, reviewState: { skippedTitles: [], decisions: [] } };
    const local = { revision: 0, sentSnapshot: server, snapshot: { ...server, draft: { ...draft, sourceSummary: { title: "稍后输入", content: "正文" } } } };
    expect(canResumePendingReview(local, 1, server)).toBe(true);
    expect(canResumePendingReview(local, 2, server)).toBe(false);
    expect(canResumePendingReview(local, 1, local.snapshot)).toBe(false);
  });
  it("服务端保存更新后拒绝旧页面直接提交，不覆盖人工成果", async () => {
    seedDraft(); saveIngestReview("DRAFT", { draft, reviewState: { skippedTitles: [], decisions: [] }, revision: 0 });
    await expect(commitIngest({ jobId: "DRAFT", draft, reviewRevision: 0 })).rejects.toThrow("另一页面");
    expect(getDb().select().from(jobs).get()!.status).toBe("awaiting_review");
  });
  it("增量追加使用真实段落分隔且重新进入全文索引", async () => {
    const page = createPage({ type: "concept", title: "已有概念", content: "原正文" }); const staged = seedDraft();
    const updates = [{ title: "已有概念", reason: "新事实", proposedContent: "", appendContent: "追加新事实 [[关联]]。", addAliases: [], addTags: [], citations: [] }];
    const edited = { ...draft, updatedPages: updates }; staged.draft = { ...edited, updatedPages: updates.map(update => ({ ...update, expectedHash: sha256(loadPageFile(page.pageId).raw) })) }; staged.analysis = { gist: "事实", language: "中文", entities: [], concepts: [], relations: [], overlaps: [], contradictions: [], gaps: [] };
    getDb().update(jobs).set({ draftJson: JSON.stringify(staged) }).where(eq(jobs.id, "DRAFT")).run();
    await commitIngest({ jobId: "DRAFT", draft: edited });
    expect(loadPageFile(page.pageId).content).toContain("原正文\n\n追加新事实 [[关联]]。"); expect(loadPageFile(page.pageId).content).not.toContain("\\n\\n");
    expect(retrieve("追加新事实").some(result => result.pageId === page.pageId)).toBe(true);
  });
  it("旧段落修复保留代码，并防止预览后外部编辑被覆盖", () => {
    const broken = "原正文\\n\\n新增 [[关联]]\n`字符串\\n\\n`\n```js\nlet x = '\\n\\n';\n```\n    代码\\n\\n";
    const fixed = repairEscapedParagraphs(broken); expect(fixed).toContain("原正文\n\n新增 [[关联]]"); expect(fixed).toContain("`字符串\\n\\n`"); expect(fixed).toContain("let x = '\\n\\n'"); expect(fixed).toContain("    代码\\n\\n");
    const page = createPage({ type: "concept", title: "旧格式", content: broken }); const hash = sha256(loadPageFile(page.pageId).raw);
    updatePage(page.pageId, { content: "外部改动" }); expect(() => applyFormatRepair(page.pageId, hash)).toThrow(ConflictError);
  });
  it("撤销归档或删除词条后答案恢复可归档状态", () => {
    const session = createSession(); const message = appendMessage({ sessionId: session, role: "assistant", content: "可归档答案" });
    const page = createPage({ type: "query", title: "归档", content: "答案" }); markFiled(message, page.pageId);
    expect(getMessages(session)[0].filedAsPageId).toBe(page.pageId); revertCommit(page.commitSha!); indexModule.reindexAll();
    expect(getMessages(session)[0].filedAsPageId).toBeNull();
    const again = createPage({ type: "query", title: "再次归档", content: "答案" }); markFiled(message, again.pageId); deletePage(again.pageId, { kind: "clean_refs" }); expect(getMessages(session)[0].filedAsPageId).toBeNull();
  });
});

describe("超出首屏的数据仍可到达", () => {
  it("101条对话可翻页和搜索，末项不消失", () => {
    for (let i = 0; i < 101; i++) createSession(`对话${i}`);
    const first = listSessions(100); const last = listSessions(100, 100); expect(first).toHaveLength(100); expect(last).toHaveLength(1); expect(new Set([...first, ...last].map(item => item.id)).size).toBe(101); expect(countSessions("对话100")).toBe(1);
  });
  it("101份来源分页和服务端搜索均可达", async () => {
    for (let i = 0; i < 101; i++) getDb().insert(sources).values({ id: `S${i}`, docPath: `raw/${i}.md`, originalName: `${i}.md`, title: `资料${i}`, sha256: `hash${i}`, byteSize: 1, importedAt: timestamp }).run();
    const result = await (await sourceList(new Request("http://localhost/api/sources?limit=100&offset=100"))).json(); expect(result.data.sources).toHaveLength(1); expect(result.data.total).toBe(101);
    const searched = await (await sourceList(new Request("http://localhost/api/sources?q=资料100"))).json(); expect(searched.data.sources[0].id).toBe("S100");
  });
  it("51个合并候选不被默认50条截断", async () => {
    for (let i = 0; i < 51; i++) writePage(`page-${i}`, frontmatterFor(`P${i}`, `候选${i}`), "正文"); indexModule.reindexAll();
    const response = await (await pageList(new Request("http://localhost/api/pages?limit=50&offset=50"))).json(); expect(response.data.pages).toHaveLength(1); expect(response.data.total).toBe(51);
  });
  it("51条历史可翻页，提交标识不含空白", () => {
    createPage({ type: "concept", title: "历史", content: "正文" });
    for (let i = 0; i < 51; i++) execFileSync("git", ["commit", "--allow-empty", "-m", `记录${i}`], { cwd: VAULT_ROOT, stdio: "ignore" });
    const earlier = logVault(50, 50); expect(earlier.length).toBeGreaterThan(0); expect(earlier.every(commit => /^[0-9a-f]{40}$/.test(commit.sha))).toBe(true);
  });
});
