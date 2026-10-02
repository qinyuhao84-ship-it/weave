import path from "node:path";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { scoreQuery, latency, pairedBootstrap } from "../scripts/eval/metrics";
import { selectQueries } from "../scripts/eval/prepare";
import { RetrievalCache } from "../scripts/eval/cache";
import { BudgetedProvider, BudgetStop, goConditions, GO_MODEL, costUsd } from "../scripts/eval/budget";
import type { EvalRow } from "../scripts/eval/types";
import type { LlmProvider, CompletionResult, CompletionRequest } from "@/lib/llm/types";
import { vaultRoot, resetVault, writePage, frontmatterFor } from "./helpers";
import { dropAllIndexTables } from "@/lib/db/client";
import { RetrievalModelSchema, saveSettings } from "@/lib/settings";
import { reindexAll } from "@/lib/index/reindex";
import { indexEmbeddings } from "@/lib/index/embeddings";
import { retrieveHybrid, type RetrievalTrace } from "@/lib/chat/retrieve";
import { loadDataset, measure } from "../scripts/eval/run";
import { digest, writeJson, writeLines } from "../scripts/eval/storage";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const hit = (id: string, content = "") => ({ id, content, score: 1 });

it("按相关性等级算 nDCG，去重，未知标注不伪装成已知负例", () => {
  const result = scoreQuery({ A: 2, B: 1, N: 0 }, [hit("U"), hit("N"), hit("A"), hit("A"), hit("B")]);
  expect(result.recall5).toBe(1); expect(result.precision5).toBe(.4); expect(result.precision10).toBe(.2);
  expect(result.mrr10).toBeCloseTo(1 / 3); expect(result.judgedPrecision10).toBeCloseTo(2 / 3); expect(result.judgmentCoverage10).toBe(.75);
  expect(result.ndcg10).toBeCloseTo((3 / Math.log2(4) + 1 / Math.log2(5)) / (3 + 1 / Math.log2(3)));
  expect(result.evidenceRecall10).toBeNull();
  expect(scoreQuery({ A: 1 }, []).recall10).toBe(0);
  expect(() => scoreQuery({ N: 0 }, [])).toThrow("正例");
});

it("命中词条不等于答案证据进入上下文", () => {
  expect(scoreQuery({ A: 1 }, [hit("A", "正文开头")], { A: ["尾部事实"] }).evidenceRecall10).toBe(0);
  expect(scoreQuery({ A: 1 }, [hit("A", "尾部事实")], { A: ["尾部事实"] }).evidenceRecall10).toBe(1);
});

it("中位数、经验P95和配对置信区间使用固定定义，问题集不同时拒绝比较", () => {
  expect(latency([1, 2, 3, 4])).toEqual({ samples: 4, medianMs: 2.5, p95Ms: 4 });
  const row = (id: string, ndcg10: number) => ({ id, metrics: { ndcg10 } }) as EvalRow;
  const result = pairedBootstrap([row("a", .9), row("b", .8)], [row("b", .7), row("a", .8)]);
  expect(result.lower95).toBeCloseTo(.1); expect(result.mean).toBeCloseTo(.1);
  expect(() => pairedBootstrap([row("a", .9)], [row("b", .8)])).toThrow("不同");
});

it("固定种子抽样隔离正例文章和重复问题，不静默减少数量", () => {
  const topics = "1\t同一个问题？\n2\t另一个问题\n3\t其他问题";
  const qrels = "1 Q0 article#1 1\n2 Q0 excluded#1 1\n3 Q0 other#1 1\n3 Q0 negative#1 0";
  const queries = selectQueries(topics, qrels, "dev", 1, 1, new Set(["excluded"]), new Set(["同一个问题"]));
  expect(queries[0].id).toBe("dev:3"); expect(queries[0].qrels["negative#1"]).toBe(0);
  expect(() => selectQueries(topics, qrels, "dev", 2, 1, new Set(["excluded"]), new Set(["同一个问题"]))).toThrow("不足");
});

it("真实向量缓存按内容和请求参数失效，取消和错误响应不写入缓存", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: body.input.map((text: string, index: number) => ({ index, embedding: [text.length, 1] })) }));
  }); vi.stubGlobal("fetch", fetch);
  const cache = new RetrievalCache(path.join(vaultRoot(), "vectors.sqlite"), "https://api.siliconflow.cn/v1");
  const request = (input: string[], extra = {}) => cache.fetch("https://api.siliconflow.cn/v1/embeddings", { body: JSON.stringify({ model: "BAAI/bge-m3", input, ...extra }) });
  try {
    await request(["a", "b"]); await request(["b", "a"]); expect(fetch).toHaveBeenCalledTimes(1);
    await request(["changed"]); await request(["a"], { encoding_format: "float" }); expect(fetch).toHaveBeenCalledTimes(3);
    const signal = new AbortController(); signal.abort();
    await expect(cache.fetch("https://api.siliconflow.cn/v1/embeddings", { signal: signal.signal, body: JSON.stringify({ model: "BAAI/bge-m3", input: ["a"] }) })).rejects.toThrow();
    await expect(cache.fetch("https://example.com/chat", {})).rejects.toThrow("隔离");
    await expect(request(["a"], { model: "Pro/BAAI/bge-m3" })).rejects.toThrow("付费");
    fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 0] }] })));
    await expect(request(["invalid"])).rejects.toThrow("无效"); expect(cache.get(cache.key("embeddings", { model: "BAAI/bge-m3", input: "invalid" }))).toBeUndefined();
  } finally { cache.close(); }
});

function provider(usage: CompletionResult["usage"] = null) {
  const result = { text: "ok", model: GO_MODEL, usage, truncated: false };
  return { id: "fixture", model: GO_MODEL, supportsStrictSchema: false, complete: vi.fn(async (_request: CompletionRequest) => result), stream: async function* () { yield "ok"; return result; } } satisfies LlmProvider;
}
it("Go 条件必须有近期额度确认、窗口截止和明确关闭余额兜底", () => {
  const now = Date.now(); const env = { WEAVE_EVAL_GO_API_KEY: "fixture", WEAVE_EVAL_GO_REMAINING_USD: "6", WEAVE_EVAL_GO_QUOTA_CHECKED_AT: new Date(now).toISOString(), WEAVE_EVAL_GO_WINDOW_END: new Date(now + 3600_000).toISOString(), WEAVE_EVAL_GO_BALANCE_FALLBACK: "off" };
  expect(goConditions(env, now).limitUsd).toBe(4.8);
  expect(() => goConditions({ ...env, WEAVE_EVAL_GO_BALANCE_FALLBACK: "on" }, now)).toThrow(BudgetStop);
  expect(() => goConditions(env, now + 700_000)).toThrow(BudgetStop);
});
it("发送前预留最坏费用，实际用量结算，缺用量保留预留，账本禁止跨窗口", async () => {
  let now = Date.now(); const file = path.join(vaultRoot(), "budget.json"); const delegate = provider({ promptTokens: 100, completionTokens: 10, totalTokens: 110 });
  const wrapped = new BudgetedProvider(delegate, file, { limitUsd: .01, windowEnd: now + 1000 }, () => now);
  await wrapped.complete({ messages: [{ role: "user", content: "中文问题" }], maxTokens: 9000, reasoningEffort: "max" });
  expect(wrapped.ledger.chargedUsd).toBeCloseTo(costUsd(100, 10));
  expect(delegate.complete.mock.calls[0][0]).toMatchObject({ maxTokens: 2048, reasoningEffort: undefined });
  now += 1001; await expect(wrapped.complete({ messages: [] })).rejects.toThrow(BudgetStop); expect(delegate.complete).toHaveBeenCalledTimes(1);
  const restarted = new BudgetedProvider(delegate, file, { limitUsd: 4.8, windowEnd: now + 5 * 3600_000 }, () => now);
  await expect(restarted.complete({ messages: [] })).rejects.toThrow();
  const tiny = new BudgetedProvider(provider(), path.join(vaultRoot(), "tiny-budget.json"), { limitUsd: .0001, windowEnd: now + 1000 }, () => now);
  await expect(tiny.complete({ messages: [] })).rejects.toThrow(); expect(tiny.ledger.attempts).toBe(0);
});

it("流中途取消和无用量结算都保留预留，关闭上游，禁止继续烧额度", async () => {
  const delegate = provider(); const now = Date.now();
  const budget = new BudgetedProvider(delegate, path.join(vaultRoot(), "stream-budget.json"), { limitUsd: .1, windowEnd: now + 10000 });
  const iterator = budget.stream({ messages: [] }); await iterator.next(); await iterator.return({ text: "", model: GO_MODEL, usage: null, truncated: true });
  expect(budget.ledger.stopped).toBe(true); expect(budget.ledger.chargedUsd).toBeGreaterThan(0);
  await expect(budget.complete({ messages: [] })).rejects.toThrow(BudgetStop);
  const unknownUsage = new BudgetedProvider(delegate, path.join(vaultRoot(), "unknown-usage.json"), { limitUsd: .1, windowEnd: now + 10000 });
  await unknownUsage.complete({ messages: [] }); expect(unknownUsage.ledger.chargedUsd).toBeCloseTo(costUsd(512, 2048));
});

it("无效重排和离线缓存缺失不能伪装成真实评测结果", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: .8 }, { index: 0, relevance_score: .7 }] })));
  vi.stubGlobal("fetch", fetch);
  const file = path.join(vaultRoot(), "rerank-cache.sqlite");
  const cache = new RetrievalCache(file, "https://api.siliconflow.cn/v1");
  const body = { model: "BAAI/bge-reranker-v2-m3", query: "query", documents: ["a", "b"], top_n: 2 };
  try { await expect(cache.fetch("https://api.siliconflow.cn/v1/rerank", { body: JSON.stringify(body) })).rejects.toThrow("无效"); expect(cache.get(cache.key("rerank", body))).toBeUndefined(); } finally { cache.close(); }
  const offline = new RetrievalCache(file, "https://api.siliconflow.cn/v1", true);
  try { await expect(offline.fetch("https://api.siliconflow.cn/v1/rerank", { body: JSON.stringify(body) })).rejects.toThrow("离线"); expect(fetch).toHaveBeenCalledTimes(1); } finally { offline.close(); }
});

it("冻结数据在读取前核验内容哈希，不能悄悄修改留出标注", () => {
  const directory = path.join(vaultRoot(), "frozen-eval");
  writeLines(path.join(directory, "documents.jsonl"), []); writeLines(path.join(directory, "queries.jsonl"), []); writeLines(path.join(directory, "answers.jsonl"), []);
  writeJson(path.join(directory, "manifest.json"), { files: Object.fromEntries(["documents.jsonl", "queries.jsonl", "answers.jsonl"].map(file => [file, digest(fs.readFileSync(path.join(directory, file)))])) });
  expect(loadDataset(directory).queries).toEqual([]);
  fs.appendFileSync(path.join(directory, "queries.jsonl"), "{}\n"); expect(() => loadDataset(directory)).toThrow("内容发生变化");
});

it("留出检索和证据场景都不能绕过冻结，校验在访问模型及个人配置之前", async () => {
  const directory = path.join(vaultRoot(), "protected-test");
  for (const file of ["documents.jsonl", "queries.jsonl", "answers.jsonl"]) writeLines(path.join(directory, file), []);
  writeJson(path.join(directory, "manifest.json"), { files: Object.fromEntries(["documents.jsonl", "queries.jsonl", "answers.jsonl"].map(file => [file, digest(fs.readFileSync(path.join(directory, file)))])) });
  const cacheFile = path.join(directory, "retrieval.sqlite"); fs.copyFileSync("docs/evaluation/2026-10-02/original-retrieve.ts.txt", path.join(directory, "original-retrieve.mts"));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(measure({ directory, cacheFile, output: path.join(directory, "result"), methods: ["original", "current", "vector"], split: "test" })).rejects.toThrow("冻结回执");
  await expect(measure({ directory, cacheFile, output: path.join(directory, "result"), methods: ["current"], split: "dev", suite: "evidence" })).rejects.toThrow("必须先冻结");
  expect(fetch).not.toHaveBeenCalled();
});

it("仅对已校准的 BGE 组合融合排序，追踪保留原始分数和实际片段，其他模型维持重排顺序", async () => {
  resetVault(); dropAllIndexTables();
  writePage("eval-one", frontmatterFor("EVAL_ONE", "系统容错"), "容忍异常需要耐受临时故障。");
  writePage("eval-two", frontmatterFor("EVAL_TWO", "水果"), "苹果适合食用。");
  const config = RetrievalModelSchema.parse({ enabled: true, apiKey: "fixture" }); reindexAll(); saveSettings({ retrievalModel: config });
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(String(url).endsWith("embeddings") ? { data: body.input.map((text: string, index: number) => ({ index, embedding: /耐受|resilience/.test(text) ? [1, 0] : [0, 1] })) } : { results: body.documents.map((text: string, index: number) => ({ index, relevance_score: text.includes("苹果") ? .55 : .5 })) }));
  }));
  await indexEmbeddings(config); const traces: RetrievalTrace[] = [];
  const current = await retrieveHybrid("resilience", { config, limit: 2, charBudget: 12, onTrace: trace => traces.push(trace) });
  expect(current[0].pageId).toBe("EVAL_ONE"); expect(current.reduce((sum, page) => sum + page.content.length, 0)).toBeLessThanOrEqual(12);
  expect(traces.find(trace => trace.stage === "reranking")?.hits[0]).toMatchObject({ pageId: "EVAL_TWO", score: .55 });
  expect(traces.find(trace => trace.stage === "result")?.hits[0].content).toBe(current[0].content);
  expect((await retrieveHybrid("resilience", { config: { ...config, rerankModel: "other-reranker" }, limit: 2 }))[0].pageId).toBe("EVAL_TWO");
  const modelFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (!String(url).endsWith("rerank")) return modelFetch(url, init);
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ results: body.documents.map((text: string, index: number) => ({ index, relevance_score: text.includes("苹果") ? .9 : .1 })) }));
  }));
  expect((await retrieveHybrid("resilience", { config, limit: 2 }))[0].pageId).toBe("EVAL_TWO");
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (!String(url).endsWith("rerank")) return modelFetch(url, init);
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ results: body.documents.map((text: string, index: number) => ({ index, relevance_score: text.includes("苹果") ? 1.2 : 1.15 })) }));
  }));
  expect((await retrieveHybrid("resilience", { config, limit: 2 }))[0].pageId).toBe("EVAL_TWO");
});
