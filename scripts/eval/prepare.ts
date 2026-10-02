import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { digest, writeJson, writeLines } from "./storage";
import type { AnswerCase, EvalDocument, EvalManifest, EvalQuery } from "./types";
import { loadDataset } from "./run";

const SOURCES = [
  { name: "MIRACL queries/qrels", revision: "5be20db9509754dadad47689368639fcec739c00", url: "https://huggingface.co/datasets/miracl/miracl", license: "Apache-2.0 (dataset metadata); Wikipedia text retains its upstream license" },
  { name: "MIRACL corpus", revision: "d921ec7e349ce0d28daf30b2da9da5ee698bef0d", url: "https://huggingface.co/datasets/miracl/miracl-corpus", license: "Apache-2.0 (dataset metadata); Wikipedia text CC-BY-SA/GFDL" },
  { name: "CMRC2018", revision: "c0eb1b6ba219847457e6af3180da722bbeb656af", url: "https://github.com/ymcui/cmrc2018", license: "CC-BY-SA-4.0" },
];
const PARQUET_REVISION = "ad2acf33f265b8fba92e5096c9d2cf569a82b067";
const PARQUET_HASHES = { train: "56798d5cbc601a6f1fa8df72f37ef37c4f26911e0cbc42d5b26d04cc43731f1e", dev: "58a8233b5191ac64804e03fd1a5c7e259c918d0a134f0da4a4a97a6dc389e812" };

async function download(url: string, file: string) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw new Error(`资料下载失败 HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), fs.createWriteStream(`${file}.partial`));
      fs.renameSync(`${file}.partial`, file); return;
    } catch {
      fs.rmSync(`${file}.partial`, { force: true });
      if (attempt >= 2) throw new Error(`公开资料下载失败：${path.basename(file)}，可重新运行断点续传`);
    }
  }
}

export function selectQueries(topics: string, judgments: string, split: EvalQuery["split"], count: number, seed: number, excludedArticles = new Set<string>(), excludedQueries = new Set<string>(), excludedQueryHashes = new Set<string>()): EvalQuery[] {
  const qrels = new Map<string, Record<string, number>>();
  for (const line of judgments.trim().split("\n")) {
    const [qid, , docid, label] = line.trim().split(/\s+/); const relevance = Number(label);
    if (!qid || !docid || !Number.isInteger(relevance) || relevance < 0) throw new Error("qrels 格式错误");
    const row = qrels.get(qid) ?? {}; row[docid] = relevance; qrels.set(qid, row);
  }
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
  const candidates = topics.trim().split("\n").map(line => {
    const position = line.indexOf("\t"); if (position < 1) throw new Error("topics 格式错误");
    const id = line.slice(0, position); return { id: `${split}:${id}`, query: line.slice(position + 1).trim(), split, qrels: qrels.get(id) ?? {} };
  }).sort((a, b) => digest(`${seed}:${a.id}`).localeCompare(digest(`${seed}:${b.id}`)));
  const selected: EvalQuery[] = []; const seen = new Set(excludedQueries);
  for (const candidate of candidates) {
    const positive = Object.entries(candidate.qrels).filter(([, label]) => label > 0).map(([id]) => id);
    const key = normalize(candidate.query);
    if (!positive.length || seen.has(key) || excludedQueryHashes.has(digest(key)) || positive.some(id => excludedArticles.has(id.split("#")[0]))) continue;
    selected.push(candidate); seen.add(key); if (selected.length === count) break;
  }
  if (selected.length !== count) throw new Error("去重和文章隔离后问题数量不足，不能静默缩小评测集");
  return selected;
}

export async function prepare(directory: string, cacheDirectory: string, seed = 20261002, previousDirectory?: string) {
  if (fs.existsSync(path.join(directory, "manifest.json"))) throw new Error("数据已冻结，请复用；新划分使用新的目录，禁止覆盖原测试集");
  const datasetBase = `${SOURCES[0].url}/resolve/${SOURCES[0].revision}/miracl-v1.0-zh`;
  const text = async (relative: string) => { const file = path.join(cacheDirectory, digest(relative)); await download(`${datasetBase}/${relative}`, file); return fs.readFileSync(file, "utf8"); };
  const normalizeQuery = (query: string) => query.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
  const previous = previousDirectory ? loadDataset(previousDirectory) : null;
  const excludedQueryHashes = new Set(previous?.manifest.previousEvaluation?.excludedQueryHashes ?? []);
  const excludedArticles = new Set(previous?.manifest.previousEvaluation?.excludedArticles ?? []);
  const excludedQaTitles = new Set(previous?.manifest.previousEvaluation?.excludedQaTitles ?? []);
  for (const doc of previous?.documents ?? []) if (doc.id.startsWith("cmrc:")) excludedQaTitles.add(doc.title);
  for (const entry of previous?.answers ?? []) if (entry.excludedArticle) excludedQaTitles.add(entry.excludedArticle);
  for (const query of previous?.queries ?? []) {
    excludedQueryHashes.add(digest(normalizeQuery(query.query)));
    for (const [id, relevance] of Object.entries(query.qrels)) if (relevance > 0) excludedArticles.add(id.split("#")[0]);
  }
  const prefixIds = (content: string, prefix: string) => content.trim().split("\n").map(line => `${prefix}:${line}`).join("\n");
  const testTopics = await text("topics/topics.miracl-v1.0-zh-dev.tsv"); const testQrels = await text("qrels/qrels.miracl-v1.0-zh-dev.tsv");
  const trainTopics = await text("topics/topics.miracl-v1.0-zh-train.tsv"); const trainQrels = await text("qrels/qrels.miracl-v1.0-zh-train.tsv");
  // 首轮 official dev；续轮从未使用的 official train/dev 池抽样，明确记录来源。
  const test = previous
    ? selectQueries(`${prefixIds(trainTopics, "train")}\n${prefixIds(testTopics, "dev")}`, `${prefixIds(trainQrels, "train")}\n${prefixIds(testQrels, "dev")}`, "test", 200, seed, excludedArticles, new Set(), excludedQueryHashes)
    : selectQueries(testTopics, testQrels, "test", 200, seed);
  const protectedArticles = new Set(test.flatMap(query => Object.entries(query.qrels).filter(([, label]) => label > 0).map(([id]) => id.split("#")[0])));
  const protectedQueries = new Set(test.map(query => query.query.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "")));
  const dev = previous ? previous.queries.filter(query => query.split === "dev") : selectQueries(trainTopics, trainQrels, "dev", 200, seed, protectedArticles, protectedQueries);
  if (dev.length !== 200 || dev.some(query => Object.entries(query.qrels).some(([id, relevance]) => relevance > 0 && protectedArticles.has(id.split("#")[0])))) throw new Error("续轮开发集数量或文章隔离无效");
  const required = new Set([...dev, ...test].flatMap(query => Object.keys(query.qrels)));
  const selected = new Map<string, EvalDocument>(); const pool = new Map<string, EvalDocument>();
  let scanned = 0;
  // 官方 Parquet 转换含人工判定段落。复用该小数据源，避免为首版下载整个中文维基。
  for (const split of ["train", "dev"] as const) {
    const file = path.join(cacheDirectory, `miracl-${PARQUET_REVISION}-${split}.parquet`);
    process.stdout.write(`下载官方 MIRACL ${split} 段落池\n`);
    await download(`${SOURCES[0].url}/resolve/${PARQUET_REVISION}/zh/${split}/0000.parquet`, file);
    if (digest(fs.readFileSync(file)) !== PARQUET_HASHES[split]) throw new Error("官方 Parquet 文件哈希不符");
    const rows = await parquetReadObjects({ file: await asyncBufferFromFile(file) }) as Array<{ positive_passages: Array<{ docid: string; title: string; text: string }>; negative_passages: Array<{ docid: string; title: string; text: string }> }>;
    for (const row of rows) for (const raw of [...row.positive_passages, ...row.negative_passages]) {
      if (!raw.docid || !raw.title || typeof raw.text !== "string") throw new Error("语料记录无效");
      const doc = { id: raw.docid, article: raw.docid.split("#")[0], title: raw.title, text: raw.text }; scanned++;
      const prior = pool.get(doc.id); if (prior && (prior.text !== doc.text || prior.title !== doc.title)) throw new Error("同一段落存在冲突内容");
      pool.set(doc.id, doc); if (required.has(doc.id)) selected.set(doc.id, doc);
    }
  }
  if (selected.size !== required.size) throw new Error(`缺少 ${required.size - selected.size} 个官方标注段落`);
  for (const doc of [...pool.values()].sort((a, b) => digest(`${seed}:${a.id}`).localeCompare(digest(`${seed}:${b.id}`)))) { if (selected.size >= 10_000) break; selected.set(doc.id, doc); }
  if (selected.size !== 10_000) throw new Error("语料数量不满足固定规模");

  const cmrcFile = path.join(cacheDirectory, `cmrc-${SOURCES[2].revision}.json`);
  await download(`https://raw.githubusercontent.com/ymcui/cmrc2018/${SOURCES[2].revision}/data/cmrc2018_dev.json`, cmrcFile);
  const cmrc = JSON.parse(fs.readFileSync(cmrcFile, "utf8")) as Array<{ context_id: string; title: string; context_text: string; qas: Array<{ query_id: string; query_text: string; answers: string[] }> }>;
  const docs = [...selected.values()]; const answers: AnswerCase[] = []; const usedTitles = new Set([...docs.map(doc => doc.title), ...excludedQaTitles]);
  const normalizeEvidence = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
  let controlledCorpus = "";
  for (const entry of cmrc.sort((a, b) => digest(`${seed}:${a.context_id}`).localeCompare(digest(`${seed}:${b.context_id}`)))) {
    if (usedTitles.has(entry.title)) continue;
    const question = entry.qas.find(qa => qa.answers.every(answer => answer.length > 0 && entry.context_text.includes(answer)));
    if (!question) continue;
    const id = `cmrc:${entry.context_id}`; usedTitles.add(entry.title);
    if (answers.length < 80) {
      docs.push({ id, article: id, title: entry.title, text: entry.context_text });
      answers.push({ id: question.query_id, question: question.query_text, documentId: id, answers: [...new Set(question.answers)], spans: [...new Set(question.answers)].map(answer => { const start = entry.context_text.indexOf(answer); return { start, end: start + answer.length }; }), kind: "answerable" });
    } else {
      // 缺证据场景保留真实问题，但整篇答案文章不进入语料；额外保守检查全体正文。
      if (question.answers.some(answer => docs.some(doc => doc.text.includes(answer)))) continue;
      controlledCorpus ||= docs.map(doc => normalizeEvidence(`${doc.title}\n${doc.text}`)).join("\n");
      // 避免仅移除标准答案长串，而其他段落仍支持同一事实或别名。
      // 取标题前三个字符作为保守主题筛选；有任何主题提及就放弃该场景。
      const subject = [...normalizeEvidence(entry.title)].slice(0, 3).join("");
      if (!subject || controlledCorpus.includes(subject) || question.answers.some(answer => controlledCorpus.includes(normalizeEvidence(answer)))) continue;
      answers.push({ id: question.query_id, question: question.query_text, documentId: null, answers: [...new Set(question.answers)], spans: [], kind: "controlled-unanswerable", excludedArticle: entry.title });
    }
    if (answers.length === 100) break;
  }
  if (answers.length !== 100) throw new Error("问答证据检查后样本不足");
  // 后加入的 CMRC 正文也不能使前面选定的缺证据场景变成可回答。
  if (answers.filter(entry => entry.kind === "controlled-unanswerable").some(entry => entry.answers.some(answer => docs.some(doc => doc.text.includes(answer))))) throw new Error("无答案场景证据泄漏");
  docs.sort((a, b) => a.id.localeCompare(b.id));
  writeLines(path.join(directory, "documents.jsonl"), docs); writeLines(path.join(directory, "queries.jsonl"), [...dev, ...test]); writeLines(path.join(directory, "answers.jsonl"), answers);
  const files = Object.fromEntries(["documents.jsonl", "queries.jsonl", "answers.jsonl"].map(file => [file, digest(fs.readFileSync(path.join(directory, file)))]));
  const manifest: EvalManifest = { version: 1, seed, sources: [...SOURCES, { name: "MIRACL official Parquet conversion", revision: PARQUET_REVISION, url: SOURCES[0].url, license: SOURCES[0].license }], files, documents: docs.length, dev: dev.length, test: test.length, answerable: 80, unanswerable: 20, corpusScanned: scanned, notes: ["MIRACL 官方 train 抽作开发集，官方 dev 抽作本轮留出集，正例文章不跨划分。", `10000 段 MIRACL 资料加 80 篇 CMRC 资料；包含全部选中问题的已标注负例，额外干扰资料按固定种子从 ${pool.size} 个官方 train/dev 已判定段落中抽取，并非均匀采样全维基。`, "这是受限语料检索评测，不可与 MIRACL 全语料排行榜直接比较。", "未标注段落并非已知不相关；Precision/nDCG 按未标注为0计算，另报标注覆盖率。", "无答案为受控移除资料场景，额外排除规范化的标题前三字符或答案仍在语料中的题目；不是原始 CMRC 无答案标注。", "不含扫描件、导入编译、多轮、多跳及图谱质量验收。"] };
  if (previous) {
    manifest.previousEvaluation = { datasetHash: previous.hash, excludedQueryHashes: [...excludedQueryHashes].sort(), excludedArticles: [...excludedArticles].sort(), excludedQaTitles: [...excludedQaTitles].sort() };
    manifest.notes[0] = "续轮保留原200个开发问题；新留出题从未使用的 MIRACL official train/dev 抽取，排除所有历史问题哈希及正例文章。来源在 test:train:/test:dev: ID 中注明。";
    manifest.notes.push("本轮语料与问答样本随新抽样重新生成，不能直接跨语料对比延迟；所有方法在本轮同一语料评测。历次留出结果均保留，不只报告成功轮次。");
  }
  writeJson(path.join(directory, "manifest.json"), manifest); return manifest;
}
