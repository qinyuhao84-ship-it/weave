import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getSqlite, dropAllIndexTables } from "@/lib/db/client";
import { RetrievalModelSchema, getSettings, getPublicSettings, saveSettings } from "@/lib/settings";
import { embedTexts, rerankTexts } from "@/lib/llm/retrieval";
import { indexEmbeddings, searchVectors, embeddingIndexStatus, embeddingChunks, startEmbeddingIndex } from "@/lib/index/embeddings";
import { getJob } from "@/lib/jobs/runner";
import { reindexAll } from "@/lib/index/reindex";
import { retrieve, retrieveHybrid } from "@/lib/chat/retrieve";
import { PATCH } from "@/app/api/settings/route";
import { frontmatterFor, resetVault, writePage, vaultRoot } from "./helpers";

const config = RetrievalModelSchema.parse({ enabled: true, apiKey: "fixture-retrieval-key" });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const vector = (text: string) => /耐受|容忍|resilience/.test(text) ? [1, 0, 0] : [0, 1, 0];
const provider = () => vi.fn<typeof fetch>(async (url, init) => {
  const body = JSON.parse(String(init?.body));
  if (String(url).endsWith("embeddings")) return json({ data: body.input.map((text: string, index: number) => ({ index, embedding: vector(text) })).reverse() });
  return json({ results: body.documents.map((text: string, index: number) => ({ index, relevance_score: /耐受/.test(text) ? .99 : .1 })) });
});
beforeEach(() => { resetVault(); dropAllIndexTables(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function seed() {
  writePage("one", frontmatterFor("ONE", "系统韧性"), "容忍故障需要耐受临时异常。" + "说明。".repeat(1000));
  writePage("two", frontmatterFor("TWO", "水果"), "新鲜苹果可以直接食用。");
  reindexAll(); saveSettings({ retrievalModel: config });
}

it("独立凭据不回显，空值保留、显式清除，地址和未知字段受校验", async () => {
  const patch = (retrievalModel: unknown) => PATCH(new NextRequest("http://localhost/api/settings", { method: "PATCH", body: JSON.stringify({ retrievalModel }) }));
  const first = await patch({ ...config, enabled: false });
  expect(await first.text()).not.toContain(config.apiKey);
  expect(getPublicSettings().retrievalModel.hasApiKey).toBe(true);
  const { hasApiKey: _key, ...publicInput } = getPublicSettings().retrievalModel;
  await patch({ ...publicInput, apiKey: "" });
  expect(getSettings().retrievalModel.apiKey).toBe(config.apiKey);
  await patch({ ...publicInput, clearApiKey: true });
  expect(getSettings().retrievalModel.apiKey).toBe("");
  expect((await patch({ ...publicInput, baseUrl: "file:///tmp/example" })).status).toBe(400);
  expect((await patch({ ...publicInput, unexpected: true })).status).toBe(400);
  expect(getSettings().providers).toEqual([]);
});

it("禁用时完全使用原有检索，不发送网络请求", async () => {
  writePage("one", frontmatterFor("ONE", "苹果"), "苹果很好吃。"); reindexAll();
  const fetch = provider(); vi.stubGlobal("fetch", fetch);
  expect(await retrieveHybrid("苹果")).toEqual(retrieve("苹果"));
  expect(fetch).not.toHaveBeenCalled();
});

it("分段向量持久化、文字无结果仍可召回同义表达，并用重排排序和预算截断", async () => {
  seed(); const fetch = provider(); vi.stubGlobal("fetch", fetch);
  const result = await indexEmbeddings(config);
  expect(result.indexed).toBe(2); expect(embeddingIndexStatus().indexed).toBe(2);
  expect(retrieve("resilience")).toEqual([]);
  const hybrid = await retrieveHybrid("resilience", { config, charBudget: 40, limit: 1 });
  expect(hybrid[0].pageId).toBe("ONE"); expect(hybrid[0].matchedBy).toBe("vector");
  expect(hybrid[0].content.length).toBeLessThanOrEqual(40);
  expect(await indexEmbeddings(config)).toEqual({ indexed: 0, skipped: 0 });
  const requests = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(requests.every(body => !("reasoning_effort" in body) && !("temperature" in body))).toBe(true);
  expect(requests.some(body => body.model === config.rerankModel)).toBe(true);
});

it("正文修改立即使缓存向量失效，监听窗口内磁盘变更同样不能使用旧向量", async () => {
  seed(); vi.stubGlobal("fetch", provider()); await indexEmbeddings(config);
  const file = path.join(vaultRoot(), "wiki/entities/one.md");
  fs.appendFileSync(file, "外部修改");
  expect((await searchVectors("resilience", config, 10)).map(hit => hit.pageId)).not.toContain("ONE");
  reindexAll();
  expect((getSqlite().prepare("SELECT count(*) AS n FROM page_embeddings WHERE page_id = 'ONE'").get() as { n: number }).n).toBe(0);
  await indexEmbeddings(config); expect(embeddingIndexStatus().indexed).toBe(2);
  getSqlite().prepare("UPDATE pages SET status = 'deleted' WHERE id = 'ONE'").run();
  expect((await searchVectors("resilience", config, 10)).map(hit => hit.pageId)).not.toContain("ONE");
});

it("嵌入返回前外部编辑不能把旧内容写入新缓存", async () => {
  seed(); const fetch = provider();
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (...args) => {
    const result = await fetch(...args); fs.appendFileSync(path.join(vaultRoot(), "wiki/entities/one.md"), "并发编辑"); return result;
  }));
  const result = await indexEmbeddings(config);
  expect(result.skipped).toBe(1);
  expect((getSqlite().prepare("SELECT count(*) AS n FROM page_embeddings WHERE page_id = 'ONE'").get() as { n: number }).n).toBe(0);
});

it("服务异常和非法重排索引自动回退，取消仍终止整个检索", async () => {
  seed(); vi.stubGlobal("fetch", provider()); await indexEmbeddings(config);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private gateway body fixture-retrieval-key", { status: 429 })));
  expect((await retrieveHybrid("系统韧性", { config })).map(page => page.pageId)).toEqual(retrieve("系统韧性").map(page => page.pageId));
  const abort = new AbortController(); abort.abort();
  await expect(retrieveHybrid("系统韧性", { config, signal: abort.signal })).rejects.toThrow();
  vi.stubGlobal("fetch", vi.fn(async () => json({ results: [{ index: 500, relevance_score: 1 }] })));
  await expect(rerankTexts(config, "x", ["x"])).rejects.toThrow("索引或数量");
});

it.each([
  { data: [{ index: 0, embedding: [0, 0] }] },
  { data: [{ index: 1, embedding: [1, 0] }] },
  { data: [{ index: 0, embedding: [1, null] }] },
  { data: [] },
])("拒绝无效向量 %j", async response => {
  vi.stubGlobal("fetch", vi.fn(async () => json(response)));
  await expect(embedTexts(config, ["query"])).rejects.toThrow();
});

it("重叠分段覆盖正文尾部，保留原文坐标", () => {
  const body = "a".repeat(1000) + "tail";
  const chunks = embeddingChunks(body, 256);
  expect(chunks[chunks.length - 1].text).toContain("tail");
  expect(chunks.every(chunk => chunk.text === body.slice(chunk.start, chunk.start + 256))).toBe(true);
});

it("关闭检索配置会取消正在索引的网络请求，不继续发送后续分段", async () => {
  seed();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const jobId = startEmbeddingIndex()!;
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const response = await PATCH(new NextRequest("http://localhost/api/settings", { method: "PATCH", body: JSON.stringify({ retrievalModel: { ...config, enabled: false } }) }));
  expect(response.status).toBe(200);
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await vi.waitFor(() => expect(getJob(jobId)?.status).toBe("cancelled"));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(embeddingIndexStatus().indexed).toBe(0);
});
