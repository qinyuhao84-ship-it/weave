import fs from "node:fs";
import path from "node:path";
import { loadDataset } from "./run";
import { readSummary } from "./report";
import { scoreQuery, summarize } from "./metrics";
import { readLines, writeJson } from "./storage";
import type { RetrievalTrace } from "../../lib/chat/retrieve";
import type { EvalRow } from "./types";

/** 只读取开发集实测轨迹，重放排序实验；不调用模型，不修改生产参数。 */
export function experiment(directory: string, runDirectory: string, output: string) {
  const dataset = loadDataset(directory); const summary = readSummary(runDirectory);
  if (summary.split !== "dev" || summary.suite !== "retrieval" || summary.datasetHash !== dataset.hash) throw new Error("排序探索仅允许同一开发集");
  const queries = new Map(dataset.queries.filter(query => query.split === "dev").map(query => [query.id, query]));
  const rows = readLines<EvalRow>(path.join(runDirectory, "rows.jsonl")).filter(row => row.method === "current");
  const traces = new Map(readLines<{ id: string; method: string; traces: RetrievalTrace[] }>(path.join(runDirectory, "trace.jsonl")).filter(row => row.method === "current").map(row => [row.id, row.traces]));
  const configurations: Array<{ vectorWeight: number; gapThreshold: number | null; constant: number; scoring: "rrf" | "raw" | "logit" }> = [];
  for (const constant of [5, 20, 60]) for (const vectorWeight of [0, .2, .4, .6, .8, 1]) configurations.push({ vectorWeight, gapThreshold: null, constant, scoring: "rrf" });
  for (const gapThreshold of [.05, .1, .2, .3, .4]) for (const vectorWeight of [.2, .4, .6, .8]) for (const constant of [5, 20, 60]) configurations.push({ vectorWeight, gapThreshold, constant, scoring: "rrf" });
  for (const vectorWeight of [1, 3, 8, 12, 16, 24]) configurations.push({ vectorWeight, gapThreshold: null, constant: 60, scoring: "raw" });
  for (const vectorWeight of [10, 20, 30, 35, 40, 50]) for (const gapThreshold of [.1, .2, .3, null]) configurations.push({ vectorWeight, gapThreshold, constant: 60, scoring: "logit" });
  const results = configurations.map(configuration => {
    const adjusted = rows.map(row => {
      const trace = traces.get(row.id)!; const ranked = trace.find(entry => entry.stage === "reranking")?.hits; const vectors = trace.find(entry => entry.stage === "vectors")?.hits; const read = trace.find(entry => entry.stage === "reading")?.hits;
      if (!ranked?.length || !vectors?.length || !read?.length || row.failed || row.degraded) throw new Error("轨迹不完整，不能用降级结果探索排序");
      const query = queries.get(row.id); if (!query) throw new Error("轨迹包含非开发问题");
      const vectorRanks = new Map(vectors.map((hit, rank) => [hit.pageId, rank])); const vectorScores = new Map(vectors.map(hit => [hit.pageId, hit.score])); const contents = new Map(read.map(hit => [hit.pageId, hit.content ?? ""]));
      const gap = ranked[0].score - (ranked[1]?.score ?? 0);
      const weight = configuration.gapThreshold === null || gap < configuration.gapThreshold ? configuration.vectorWeight : 0;
      let remaining = 24_000;
      if (configuration.scoring === "logit" && ranked.some(hit => hit.score < 0 || hit.score > 1)) throw new Error("logit 校准要求重排分数处于 [0,1]");
      const hits = ranked.map((hit, rank) => ({ id: hit.pageId, content: contents.get(hit.pageId)!, score: configuration.scoring === "logit" ? Math.log(Math.max(1e-5, hit.score) / Math.max(1e-5, 1 - hit.score)) + weight * (vectorScores.get(hit.pageId) ?? 0) : configuration.scoring === "raw" ? hit.score + weight * (vectorScores.get(hit.pageId) ?? 0) : (1 - weight) / (configuration.constant + rank + 1) + (vectorRanks.has(hit.pageId) ? weight / (configuration.constant + vectorRanks.get(hit.pageId)! + 1) : 0) })).sort((a, b) => b.score - a.score).slice(0, 10).filter(hit => { if (!remaining) return false; hit.content = hit.content.slice(0, remaining); remaining -= hit.content.length; return true; });
      return { ...row, hits, metrics: scoreQuery(query.qrels, hits) };
    });
    return { ...configuration, summary: summarize(adjusted) };
  });
  const report = { datasetHash: dataset.hash, sourceHash: summary.sourceHash, cases: rows.length, scope: "开发轨迹排序重放，只能证明固定候选集合下的质量；不代表新调用延迟。", configurations: results };
  writeJson(output, report);
  fs.writeFileSync(`${output}.md`, ["# 开发集排序探索", "", report.scope, "", "| 计分 | RRF 常数 | 向量权重 | 置信差阈值 | Recall@10 | nDCG@10 |", "| --- | --- | --- | --- | --- | --- |", ...results.map(result => `| ${result.scoring} | ${result.constant} | ${result.vectorWeight} | ${result.gapThreshold ?? "全部"} | ${(result.summary.metrics.recall10! * 100).toFixed(2)}% | ${(result.summary.metrics.ndcg10! * 100).toFixed(2)}% |`)].join("\n") + "\n");
  return report;
}
