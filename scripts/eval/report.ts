import fs from "node:fs";
import path from "node:path";
import { digest, readLines, writeJson } from "./storage";
import { pairedBootstrap, summarize } from "./metrics";
import type { EvalRow } from "./types";
import type { measure } from "./run";
import { implementationHashes } from "./run";

type Summary = Awaited<ReturnType<typeof measure>>;
export function readSummary(directory: string): Summary { return JSON.parse(fs.readFileSync(path.join(directory, "summary.json"), "utf8")); }

export function freeze(devDirectory: string, output: string) {
  const summary = readSummary(devDirectory);
  if (summary.split !== "dev" || summary.suite !== "retrieval") throw new Error("冻结必须依据检索开发集");
  const baselines = ["bm25", "vector", "rrf-rerank"];
  if (baselines.some(method => !summary.methods[method]) || !summary.methods.current) throw new Error("冻结需要当前方案与三种基线的开发结果");
  if (Object.values(summary.methods).some(method => method.failureRate > 0 || method.degradationRate > 0)) throw new Error("开发评测存在失败或降级，不能冻结为有效模型比较");
  const baseline = baselines.sort((a, b) => summary.methods[b].metrics.ndcg10! - summary.methods[a].metrics.ndcg10! || a.localeCompare(b))[0];
  const source = digest(fs.readFileSync("lib/chat/retrieve.ts"));
  if (source !== summary.sourceHash) throw new Error("代码与开发结果不一致，请重新评估开发集");
  if (JSON.stringify(summary.implementationHashes) !== JSON.stringify(implementationHashes())) throw new Error("依赖或评测实现与开发结果不一致，请重新评估开发集");
  if (fs.existsSync(output)) throw new Error("冻结回执已存在，禁止覆盖");
  const receipt = { at: new Date().toISOString(), datasetHash: summary.datasetHash, sourceHash: source, implementationHashes: summary.implementationHashes, originalHash: summary.originalHash, baseline, devSummaryHash: digest(fs.readFileSync(path.join(devDirectory, "summary.json"))), thresholds: { recall10: .85, ndcg10: .70, ndcgGain: .03, recallDrop: .02, localP95Ratio: 1.2 } };
  writeJson(output, receipt); return receipt;
}

export function compare(directory: string, baseline: string, output: string) {
  const summary = readSummary(directory); const rows = readLines<EvalRow>(path.join(directory, "rows.jsonl"));
  const current = rows.filter(row => row.method === "current"); const reference = rows.filter(row => row.method === baseline); const original = rows.filter(row => row.method === "original");
  const currentSummary = summarize(current); const baselineSummary = summarize(reference); const originalSummary = summarize(original);
  const bootstrap = pairedBootstrap(current, reference);
  const gates = {
    recall: currentSummary.metrics.recall10! >= .85,
    ranking: currentSummary.metrics.ndcg10! >= .70,
    baselineGain: bootstrap.mean >= .03,
    confidence: bootstrap.lower95 > 0,
    recallNonRegression: currentSummary.metrics.recall10! >= baselineSummary.metrics.recall10! - .02,
    latency: currentSummary.local.p95Ms! <= originalSummary.local.p95Ms! * 1.2,
    services: [...current, ...reference, ...original].every(row => !row.failed && !row.degraded),
  };
  const result = { split: summary.split, datasetHash: summary.datasetHash, baseline, current: currentSummary, reference: baselineSummary, original: originalSummary, bootstrap, gates, passed: Object.values(gates).every(Boolean), answerVerification: "pending" };
  writeJson(path.join(output, "comparison.json"), result);
  const percentage = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;
  const lines = ["# 真实检索评测报告", "", `评测划分：${summary.split}；问题数：${current.length}；预先选定基线：${baseline}。`, "", "| 方法 | Recall@10 | nDCG@10 | MRR@10 | Precision@10¹ | 标注覆盖率 | 本地中位数 / P95 |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const [name, value] of [["原实现", originalSummary], [baseline, baselineSummary], ["当前实现", currentSummary]] as const) lines.push(`| ${name} | ${percentage(value.metrics.recall10)} | ${percentage(value.metrics.ndcg10)} | ${percentage(value.metrics.mrr10)} | ${percentage(value.metrics.precision10)} | ${percentage(value.metrics.judgmentCoverage10)} | ${value.local.medianMs?.toFixed(2)} / ${value.local.p95Ms?.toFixed(2)} ms |`);
  lines.push("", `nDCG 差值：${(bootstrap.mean * 100).toFixed(2)} 个百分点；配对 bootstrap 95% 区间：[${(bootstrap.lower95 * 100).toFixed(2)}, ${(bootstrap.upper95 * 100).toFixed(2)}]。`, "", "| 验收项 | 结果 |", "| --- | --- |");
  for (const [name, passed] of Object.entries(gates)) lines.push(`| ${name} | ${passed ? "通过" : "未通过"} |`);
  lines.push("", `检索门槛：${result.passed ? "全部通过" : "尚未全部通过"}。问答复核另行验收；不能据此宣称市场平均以上。`, "", "¹ 未标注结果按0计分，该值受不完整标注影响，不代表全部结果的真实准确率。", "", `环境：${summary.environment.cpu} / ${summary.environment.platform}-${summary.environment.arch} / Node ${summary.environment.node}。`, "", "## 测量限制", "", ...summary.notes.map(note => `- ${note}`), "", "## 排序或召回失败样例", "");
  const byId = new Map(reference.map(row => [row.id, row]));
  const failures = current.filter(row => row.metrics.recall10 < 1 || row.metrics.ndcg10 < byId.get(row.id)!.metrics.ndcg10).sort((a, b) => a.metrics.ndcg10 - b.metrics.ndcg10).slice(0, 20);
  writeJson(path.join(output, "failures.json"), failures.map(row => ({ id: row.id, current: row.metrics, baseline: byId.get(row.id)!.metrics, returned: row.hits.map(hit => hit.id) })));
  for (const row of failures) lines.push(`- ${row.id}：Recall@10 ${percentage(row.metrics.recall10)}，nDCG@10 ${percentage(row.metrics.ndcg10)}。`);
  fs.writeFileSync(path.join(output, "report.md"), lines.join("\n") + "\n"); return result;
}
