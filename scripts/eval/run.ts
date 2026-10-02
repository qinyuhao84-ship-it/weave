import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import type { RetrievalModelSettings } from "../../lib/settings";
import type { RetrieveOptions, RetrievedPage, RetrievalTrace } from "../../lib/chat/retrieve";
import { RetrievalCache } from "./cache";
import { isolateVault, readRetrievalConfig } from "./config";
import { digest, readLines, writeJson } from "./storage";
import { scoreQuery, summarize } from "./metrics";
import type { AnswerCase, EvalDocument, EvalManifest, EvalQuery, EvalHit, EvalRow } from "./types";

export const METHODS = ["original", "current", "bm25", "vector", "rrf-rerank"] as const;
type Method = typeof METHODS[number];
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const words = (text: string) => [...segmenter.segment(text.normalize("NFKC").toLowerCase())].filter(word => word.isWordLike).map(word => word.segment);
export const sourceHash = () => digest(fs.readFileSync(path.resolve("lib/chat/retrieve.ts")));
export const answerQuestion = (question: string) => `${question}\n请只依据知识库，用一句话给出最短答案并附引用；资料不足时明确说明。`;
export const implementationHashes = () => Object.fromEntries([
  "lib/chat/retrieve.ts", "lib/chat/answer.ts", "lib/chat/context.ts", "lib/index/embeddings.ts", "lib/llm/retrieval.ts",
  "scripts/eval/run.ts", "scripts/eval/cache.ts", "scripts/eval/metrics.ts", "scripts/eval/prepare.ts", "pnpm-lock.yaml",
].map(file => [file, digest(fs.readFileSync(file))]));

export function loadDataset(directory: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")) as EvalManifest;
  for (const [file, hash] of Object.entries(manifest.files)) if (digest(fs.readFileSync(path.join(directory, file))) !== hash) throw new Error("冻结数据内容发生变化，拒绝评测");
  return { manifest, hash: digest(JSON.stringify(manifest)), documents: readLines<EvalDocument>(path.join(directory, "documents.jsonl")), queries: readLines<EvalQuery>(path.join(directory, "queries.jsonl")), answers: readLines<AnswerCase>(path.join(directory, "answers.jsonl")) };
}

export async function setupVault(documents: EvalDocument[], cacheFile: string, offline = false, signal?: AbortSignal) {
  const config = readRetrievalConfig(); const root = isolateVault();
  const { closeDb, getSqlite } = await import("../../lib/db/client");
  const { saveSettings } = await import("../../lib/settings");
  const { serializePage, createFrontmatter } = await import("../../lib/vault/frontmatter");
  const { reindexAll } = await import("../../lib/index/reindex");
  const { embeddingChunks, indexEmbeddings, stopEmbeddingIndex } = await import("../../lib/index/embeddings");
  const { embedTexts } = await import("../../lib/llm/retrieval");
  const cache = new RetrievalCache(cacheFile, config.baseUrl, offline); cache.install();
  try {
    const directory = path.join(root, "wiki/concepts"); fs.mkdirSync(directory, { recursive: true });
    const inputs: string[] = [];
    for (const doc of documents) {
      const slug = digest(doc.id).slice(0, 24);
      const frontmatter = { ...createFrontmatter({ type: "concept", title: doc.title, slug, now: "2026-10-02T00:00:00+08:00" }), id: doc.id };
      const raw = serializePage(frontmatter, doc.text); fs.writeFileSync(path.join(directory, `${slug}.md`), raw);
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      for (const chunk of embeddingChunks(body, config.chunkChars)) inputs.push(`${doc.title.slice(0, 256)}\n${chunk.text}`);
    }
    const index = reindexAll(); if (index.broken.length || index.pages !== documents.length) throw new Error("临时知识库索引不完整");
    saveSettings({ retrievalModel: config, retrievalLimit: 10, personality: { tone: "plain", length: "concise", emoji: "none", noAnswer: "admit" } });
    process.stdout.write(`临时库 ${documents.length} 篇，真实向量 ${inputs.length} 段；缓存可复用\n`);
    // 跨文档批量预取仅用于评测准备，随后仍由应用索引器验证哈希并写入派生索引。
    for (let offset = 0; offset < inputs.length; offset += 32) {
      signal?.throwIfAborted();
      await embedTexts(config, inputs.slice(offset, offset + 32), signal, 30_000);
      if (offset % 640 === 0) process.stdout.write(`真实嵌入准备 ${Math.min(offset + 32, inputs.length)}/${inputs.length}\n`);
    }
    await indexEmbeddings(config, signal);
    const sqlite = getSqlite();
    sqlite.exec("CREATE VIRTUAL TABLE eval_bm25 USING fts5(docid UNINDEXED, title, body, tokenize='unicode61')");
    const insert = sqlite.prepare("INSERT INTO eval_bm25 VALUES (?, ?, ?)");
    sqlite.transaction(() => documents.forEach(doc => insert.run(doc.id, words(doc.title).join(" "), words(doc.text).join(" "))))();
    return { config, root, cache, sqlite, close: () => { stopEmbeddingIndex(); cache.close(); closeDb(); fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { stopEmbeddingIndex(); cache.close(); closeDb(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
}

export async function measure(options: { directory: string; output: string; methods: string[]; split: "dev" | "test"; cacheFile: string; offline?: boolean; suite?: "retrieval" | "evidence"; freeze?: string; original?: string; signal?: AbortSignal }) {
  const dataset = loadDataset(options.directory);
  if (options.suite === "evidence" && options.split !== "test") throw new Error("证据套件是留出问答场景，必须先冻结并使用 split=test");
  if (options.methods.some(method => !METHODS.includes(method as Method))) throw new Error("未知评测方法");
  if (!options.methods.length || new Set(options.methods).size !== options.methods.length) throw new Error("方法集合为空或重复");
  if (fs.existsSync(path.join(options.output, "summary.json"))) throw new Error("结果目录已完成，不能覆盖历史测量");
  const originalFile = path.resolve(path.dirname(options.cacheFile), "original-retrieve.mts");
  if (options.original) {
    const snapshot = Buffer.from(fs.readFileSync(options.original, "utf8").replace('from "./progress"', 'from "@/lib/chat/progress"'));
    if (fs.existsSync(originalFile) && digest(fs.readFileSync(originalFile)) !== digest(snapshot)) throw new Error("原实现快照与缓存中的版本不一致，请使用独立缓存目录");
    fs.mkdirSync(path.dirname(originalFile), { recursive: true });
    if (!fs.existsSync(originalFile)) fs.writeFileSync(originalFile, snapshot);
  }
  if (!fs.existsSync(originalFile)) {
    throw new Error("需要 --original 提供优化前的检索快照，不能把优化后代码当作原实现");
  }
  if (options.split === "test") {
    if (!options.freeze) throw new Error("留出评测必须提供开发集冻结回执");
    const receipt = JSON.parse(fs.readFileSync(options.freeze, "utf8")) as { datasetHash: string; sourceHash: string; baseline: string; originalHash: string; implementationHashes: Record<string, string> };
    if (receipt.datasetHash !== dataset.hash || receipt.sourceHash !== sourceHash() || receipt.originalHash !== digest(fs.readFileSync(originalFile))) throw new Error("代码或数据与冻结回执不一致");
    if (JSON.stringify(receipt.implementationHashes) !== JSON.stringify(implementationHashes())) throw new Error("检索依赖或评测代码与冻结回执不一致");
    if (!options.methods.includes(receipt.baseline) || !options.methods.includes("current") || !options.methods.includes("original")) throw new Error("留出评测缺少预先选定基线、当前实现或原实现");
    const lock = path.join(options.directory, `heldout-${options.suite ?? "retrieval"}.lock.json`);
    fs.writeFileSync(lock, JSON.stringify({ receipt, output: path.resolve(options.output), at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  }
  const environment = await setupVault(dataset.documents, options.cacheFile, options.offline, options.signal);
  const { retrieveHybrid, excerptForQuery } = await import("../../lib/chat/retrieve");
  const { searchVectors } = await import("../../lib/index/embeddings");
  const { rerankTexts } = await import("../../lib/llm/retrieval");
  const original = await import(pathToFileURL(originalFile).href) as { retrieveHybrid: (query: string, options: RetrieveOptions & { config: RetrievalModelSettings }) => Promise<RetrievedPage[]> };
  const docById = new Map(dataset.documents.map(doc => [doc.id, doc]));
  const queryCases: Array<EvalQuery & { evidence?: Record<string, string[]> }> = options.suite === "evidence"
    ? dataset.answers.filter(entry => entry.kind === "answerable").map(entry => ({ id: entry.id, query: answerQuestion(entry.question), split: "test", qrels: { [entry.documentId!]: 1 }, evidence: { [entry.documentId!]: entry.answers } }))
    : dataset.queries.filter(query => query.split === options.split);
  const rows: EvalRow[] = [];
  fs.mkdirSync(options.output, { recursive: true });
  const rowFile = path.join(options.output, "rows.jsonl"); fs.writeFileSync(rowFile, "");
  const traceFile = path.join(options.output, "trace.jsonl"); fs.writeFileSync(traceFile, "");
  const charBudget = options.suite === "evidence" ? 8192 : 24_000;
  const clip = (hits: EvalHit[]) => { let remaining = charBudget; return hits.slice(0, 10).filter(hit => { if (!remaining) return false; hit.content = hit.content.slice(0, Math.min(3000, remaining)); remaining -= hit.content.length; return true; }); };
  const bm25 = (query: string, limit: number): EvalHit[] => {
    const terms = [...new Set(words(query))].slice(0, 64); if (!terms.length) return [];
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const found = environment.sqlite.prepare("SELECT docid, bm25(eval_bm25, 0.0, 10.0, 1.0) AS score FROM eval_bm25 WHERE eval_bm25 MATCH ? ORDER BY score, docid LIMIT ?").all(match, limit) as Array<{ docid: string; score: number }>;
    return found.map(hit => ({ id: hit.docid, score: -hit.score, content: excerptForQuery(docById.get(hit.docid)!.text, query, 3000) }));
  };
  try {
    // 仅预热开发问题的本地路径；留出问题在这里不计算指标或发送给模型。
    for (const query of dataset.queries.filter(query => query.split === "dev").slice(0, 5)) bm25(query.query, 50);
    for (let index = 0; index < queryCases.length; index++) {
      const query = queryCases[index];
      options.signal?.throwIfAborted();
      for (const method of options.methods as Method[]) {
        const before = environment.cache.snapshot(); const started = performance.now(); const traces: RetrievalTrace[] = [];
        let hits: EvalHit[] = []; let failed = false;
        try {
          if (method === "current" || method === "original") {
            const entry = method === "original" ? original.retrieveHybrid : retrieveHybrid;
            hits = (await entry(query.query, { config: environment.config, signal: options.signal, limit: 10, charBudget, onTrace: trace => traces.push(trace) })).map(page => ({ id: page.pageId, content: page.content, score: page.score }));
          } else if (method === "bm25") hits = clip(bm25(query.query, 10));
          else {
            const vectors = await searchVectors(query.query, environment.config, 50, options.signal);
            const vectorHits = vectors.map(hit => ({ id: hit.pageId, score: hit.score, content: docById.get(hit.pageId)!.text.slice(Math.max(0, hit.chunkStart - 1), Math.max(0, hit.chunkStart - 1) + 3000) }));
            if (method === "vector") hits = clip(vectorHits);
            else {
              const fusion = new Map<string, EvalHit>();
              for (const list of [bm25(query.query, 50), vectorHits]) list.forEach((hit, rank) => { const prior = fusion.get(hit.id); fusion.set(hit.id, { ...hit, score: (prior?.score ?? 0) + 1 / (60 + rank + 1) }); });
              const candidates = [...fusion.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 50);
              const rank = await rerankTexts(environment.config, query.query, candidates.map(hit => `${docById.get(hit.id)!.title}\n${hit.content}`.slice(0, environment.config.chunkChars)), options.signal);
              hits = clip(rank.map(hit => ({ ...candidates[hit.index], score: hit.score })));
            }
          }
        } catch { options.signal?.throwIfAborted(); failed = true; }
        const wallMs = performance.now() - started; const stats = environment.cache.delta(before);
        const row: EvalRow = { id: query.id, method, hits, metrics: scoreQuery(query.qrels, hits, query.evidence), localMs: Math.max(0, wallMs - stats.embeddingMs - stats.rerankMs), wallMs, ...stats, degraded: traces.some(trace => trace.fallback) || stats.failures > 0, failed };
        rows.push(row); fs.appendFileSync(rowFile, JSON.stringify(row) + "\n"); fs.appendFileSync(traceFile, JSON.stringify({ id: query.id, method, traces }) + "\n");
      }
      if (index % 10 === 0) process.stdout.write(`评测 ${options.split}/${options.suite ?? "retrieval"} ${index + 1}/${queryCases.length}\n`);
    }
    const summary = { at: new Date().toISOString(), datasetHash: dataset.hash, sourceHash: sourceHash(), implementationHashes: implementationHashes(), originalHash: digest(fs.readFileSync(originalFile)), split: options.split, suite: options.suite ?? "retrieval", config: { topK: 10, charBudget, embedding: environment.config.embeddingModel, rerank: environment.config.rerankModel, chunkChars: environment.config.chunkChars, baselineCandidates: 50, rrfConstant: 60 }, environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, memoryGB: os.totalmem() / 1024 ** 3 }, methods: Object.fromEntries(options.methods.map(method => [method, summarize(rows.filter(row => row.method === method))])), notes: [...dataset.manifest.notes, "wall 包含本轮实际发生的网络和缓存调用；不能把缓存重放结果当作真实线上延迟。", "embedding/rerank 延迟仅统计实际网络请求的问题，零请求时样本量为0；同题重试等待也归入网络阶段。", "失败问题保留并按零分计入，不丢弃失败样本。", "MIRACL 不提供答案跨度，证据召回仅在 CMRC 问题上计算。", "证据套件使用32768模型窗口对应的8192字符上下文预算；它验证检索片段，不代替模型问答。"] };
    writeJson(path.join(options.output, "summary.json"), summary); return summary;
  } finally { environment.close(); }
}
