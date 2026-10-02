import fs from "node:fs";
import path from "node:path";
import { loadEvaluationEnv } from "./config";
import { loadDataset, setupVault, answerQuestion } from "./run";
import { BudgetedProvider, BudgetStop, GO_MODEL, goConditions } from "./budget";
import { writeJson, readLines } from "./storage";
import type { AnswerCase } from "./types";
import type { AnswerResult } from "../../lib/chat/answer";
import { latency } from "./metrics";
import type { RetrievedPage } from "../../lib/chat/retrieve";

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\[ID:\d+\]/g, "").replace(/[\p{P}\p{Z}\s]/gu, "");
export function factualCheck(entry: AnswerCase, result: Pick<AnswerResult, "text" | "citations" | "interrupted">) {
  const matched = entry.answers.some(answer => normalize(result.text).includes(normalize(answer)));
  const supported = result.citations.some(citation => citation.pageId === entry.documentId && entry.answers.some(answer => citation.excerpt.includes(answer)));
  const refused = /知识库.{0,20}(没有|未提供|不足|未找到|无法|不包含)|资料.{0,12}(不足|没有|未提供|未找到)|无法.{0,8}(确定|回答)/u.test(result.text);
  return { goldAnswerMatched: matched, goldCitationSupported: supported, controlledRefusal: entry.kind === "controlled-unanswerable" && refused && !matched && !result.interrupted, automaticPass: !result.interrupted && (entry.kind === "answerable" ? matched && supported && !refused : refused && !matched) };
}

export async function answerEvaluation(directory: string, output: string, cacheFile: string, signal?: AbortSignal) {
  loadEvaluationEnv(); fs.mkdirSync(output, { recursive: true });
  let conditions: ReturnType<typeof goConditions>;
  try { conditions = goConditions(); } catch (error) { const status = { status: "not-run", reason: error instanceof BudgetStop ? error.message : "Go 条件未确认", requests: 0, chargedUsd: 0 }; writeJson(path.join(output, "answer-status.json"), status); return status; }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const lock = path.join(path.dirname(cacheFile), "go-budget.lock");
  const handle = fs.openSync(lock, "wx", 0o600); fs.closeSync(handle);
  let environment: Awaited<ReturnType<typeof setupVault>> | undefined;
  try {
    const dataset = loadDataset(directory);
    environment = await setupVault(dataset.documents, cacheFile, false, signal);
    const { OpenAiCompatibleProvider } = await import("../../lib/llm/provider");
    const { answer } = await import("../../lib/chat/answer");
    const { createSession, appendMessage } = await import("../../lib/chat/sessions");
    const { saveSettings } = await import("../../lib/settings");
    saveSettings({ providers: [{ id: "go-eval", label: "评测专用", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "", model: GO_MODEL, lightModel: "", reasoningEffort: "default", contextWindow: 32768, temperature: .3, supportsStrictSchema: false, headers: {} }], activeProviderId: "go-eval", preferSavedModels: true });
    const provider = new BudgetedProvider(new OpenAiCompatibleProvider({ baseUrl: "https://opencode.ai/zen/go/v1", apiKey: process.env.WEAVE_EVAL_GO_API_KEY!, model: GO_MODEL, contextWindow: 32768, headers: { "user-agent": "weave-evaluation/1.0", "x-opencode-session": `weave-eval-${dataset.hash.slice(0, 16)}` } }), path.join(path.dirname(cacheFile), "go-budget.json"), conditions);
    const retrievalFetch = globalThis.fetch;
    // 仅放行评测约定的 Go 端点，其余仍由检索缓存隔离。
    globalThis.fetch = async (url, init) => {
      if (String(url) === "https://opencode.ai/zen/go/v1/chat/completions") {
        const body = JSON.parse(String(init?.body)); if (body.model !== GO_MODEL) throw new BudgetStop("拒绝非约定问答模型");
        body.stream_options = { include_usage: true };
        return nativeFetch(url, { ...init, body: JSON.stringify(body) });
      }
      return retrievalFetch(url, init);
    };
    const file = path.join(output, "answers.jsonl");
    const completed = fs.existsSync(file) ? new Set(readLines<{ id: string }>(file).map(row => row.id)) : new Set<string>();
    try {
      for (const entry of dataset.answers) {
        if (signal?.aborted) { provider.stop("用户取消，保存进度，不继续发送请求"); break; }
        if (completed.has(entry.id) || provider.ledger.stopped) continue;
        const sessionId = createSession("公开资料评测");
        const question = answerQuestion(entry.question);
        const questionMessageId = appendMessage({ sessionId, role: "user", content: question });
        const before = environment.cache.snapshot(); let retrieved: RetrievedPage[] = [];
        try {
          const result = await answer({ sessionId, questionMessageId, question, provider, onRetrieved: pages => { retrieved = pages; }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
          fs.appendFileSync(file, JSON.stringify({ id: entry.id, kind: entry.kind, question: entry.question, answers: entry.answers, text: result.text, citations: result.citations, retrieved: retrieved.map(page => ({ id: page.pageId, title: page.title, content: page.content })), timings: result.timings, transport: environment.cache.delta(before), usage: result.usage, automatic: factualCheck(entry, result), review: { correct: null, citationsSupported: null, notes: "待独立复核；自动答案匹配不能核验所有额外结论" } }) + "\n");
        } catch { fs.appendFileSync(file, JSON.stringify({ id: entry.id, kind: entry.kind, failed: true, review: { correct: false, citationsSupported: false, notes: "调用失败，按失败计入" } }) + "\n"); }
        process.stdout.write(`问答 ${completed.size + 1}/${dataset.answers.length}，累计预算计价 ${provider.ledger.chargedUsd.toFixed(4)} USD\n`); completed.add(entry.id);
      }
      const rows = fs.existsSync(file) ? readLines<{ failed?: boolean; timings?: AnswerResult["timings"]; transport?: { embeddingMs: number; rerankMs: number; failures: number } }>(file) : [];
      const times = (field: keyof AnswerResult["timings"], fromRequested = false) => latency(rows.flatMap(row => typeof row.timings?.[field] === "number" ? [Math.max(0, row.timings[field]! - (fromRequested ? row.timings.requestedMs ?? 0 : 0))] : []));
      const status = { status: provider.ledger.stopped ? "stopped" : "awaiting-review", ...provider.ledger, model: GO_MODEL, expected: dataset.answers.length, completed: completed.size, datasetHash: dataset.hash, latency: { firstText: times("firstTextMs"), completion: times("generatedMs"), modelFirstText: times("firstTextMs", true), modelCompletion: times("generatedMs", true), localPreparation: latency(rows.flatMap(row => typeof row.timings?.preparedMs === "number" ? [Math.max(0, row.timings.preparedMs - (row.transport?.embeddingMs ?? 0) - (row.transport?.rerankMs ?? 0))] : [])), embedding: latency(rows.flatMap(row => row.transport?.embeddingMs ? [row.transport.embeddingMs] : [])), rerank: latency(rows.flatMap(row => row.transport?.rerankMs ? [row.transport.rerankMs] : [])) }, failureRate: rows.length ? rows.filter(row => row.failed).length / rows.length : null, degradationRate: rows.length ? rows.filter(row => row.transport?.failures).length / rows.length : null, notes: "账本为按高峰价格计算的用量，缺 usage 时使用保守预留；没有自动跨窗口或直连回退。首字/完成分别报告端到端及模型请求之后的时间；缓存不代表网络延迟。" };
      writeJson(path.join(output, "answer-status.json"), status); return status;
    } finally { globalThis.fetch = retrievalFetch; }
  } finally { environment?.close(); fs.rmSync(lock, { force: true }); }
}

// 在任何检索缓存安装前捕获原生网络函数。
const nativeFetch = globalThis.fetch;

export function reviewAnswers(directory: string, output: string, reviewsFile: string) {
  const dataset = loadDataset(directory);
  type Review = { id: string; correct: boolean; citationsSupported: boolean; notes: string; reviewer: string; method: "human" | "agent-assisted" };
  const reviews = readLines<Review>(reviewsFile); const byId = new Map(reviews.map(row => [row.id, row]));
  const answers = readLines<{ id: string; failed?: boolean }>(path.join(output, "answers.jsonl"));
  const answered = new Set(answers.map(row => row.id));
  if (reviews.length !== dataset.answers.length || byId.size !== reviews.length || answers.length !== answered.size || dataset.answers.some(entry => !answered.has(entry.id) || !byId.has(entry.id))) throw new Error("复核必须覆盖全部100个场景，失败样本不能省略");
  if (reviews.some(row => typeof row.correct !== "boolean" || typeof row.citationsSupported !== "boolean" || !row.notes?.trim() || !row.reviewer?.trim() || !["human", "agent-assisted"].includes(row.method))) throw new Error("复核记录缺少判定、证据说明或复核身份");
  const failed = new Set(answers.filter(row => row.failed).map(row => row.id));
  const positive = dataset.answers.filter(entry => entry.kind === "answerable"); const negative = dataset.answers.filter(entry => entry.kind === "controlled-unanswerable");
  const accuracy = positive.filter(entry => !failed.has(entry.id) && byId.get(entry.id)!.correct).length / positive.length;
  const citationSupport = positive.filter(entry => !failed.has(entry.id) && byId.get(entry.id)!.citationsSupported).length / positive.length;
  const refusal = negative.filter(entry => !failed.has(entry.id) && byId.get(entry.id)!.correct).length / negative.length;
  const summary = { datasetHash: dataset.hash, answerable: positive.length, controlledUnanswerable: negative.length, accuracy, citationSupport, refusal, reviewMethods: [...new Set(reviews.map(row => row.method))], gates: { accuracy: accuracy >= .85, citationSupport: citationSupport >= .95, refusal: refusal >= .9 }, notes: "复核判定涵盖正确性、额外结论是否有证据以及拒答；自动字符串匹配未代替独立复核。样本较少，仅代表本评测集。" };
  writeJson(path.join(output, "answer-summary.json"), summary); return summary;
}
