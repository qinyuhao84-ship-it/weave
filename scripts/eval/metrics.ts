import type { EvalHit, QueryMetrics, EvalRow } from "./types";

export function scoreQuery(qrels: Record<string, number>, input: EvalHit[], evidence?: Record<string, string[]>): QueryMetrics {
  if (Object.values(qrels).some(value => !Number.isFinite(value) || value < 0)) throw new Error("非法相关性标注");
  const relevant = Object.values(qrels).filter(value => value > 0).length;
  if (!relevant) throw new Error("可回答检索问题必须有正例");
  const seen = new Set<string>();
  const hits = input.filter(hit => { if (seen.has(hit.id)) return false; seen.add(hit.id); return true; }).slice(0, 10);
  const count = (k: number) => hits.slice(0, k).filter(hit => (qrels[hit.id] ?? 0) > 0).length;
  const ideal = Object.values(qrels).filter(value => value > 0).sort((a, b) => b - a).slice(0, 10);
  const dcg = (values: number[]) => values.reduce((total, value, index) => total + (2 ** value - 1) / Math.log2(index + 2), 0);
  const first = hits.findIndex(hit => (qrels[hit.id] ?? 0) > 0);
  const judged = hits.filter(hit => Object.hasOwn(qrels, hit.id));
  return {
    recall5: count(5) / relevant, recall10: count(10) / relevant,
    hit5: Number(count(5) > 0), hit10: Number(count(10) > 0), mrr10: first < 0 ? 0 : 1 / (first + 1),
    ndcg10: dcg(hits.map(hit => qrels[hit.id] ?? 0)) / dcg(ideal),
    precision5: count(5) / 5, precision10: count(10) / 10,
    judgedPrecision10: judged.length ? judged.filter(hit => qrels[hit.id] > 0).length / judged.length : null,
    judgmentCoverage10: judged.length / Math.max(1, hits.length),
    // 只有有独立答案片段标注时才计算。MIRACL 的相关性标签不是答案跨度。
    evidenceRecall10: evidence ? Object.keys(qrels).filter(id => qrels[id] > 0 && hits.some(hit => hit.id === id && evidence[id]?.some(span => hit.content.includes(span)))).length / relevant : null,
  };
}

export function latency(values: number[]) {
  if (!values.length) return { samples: 0, medianMs: null, p95Ms: null };
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("非法延迟样本");
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return { samples: sorted.length, medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] };
}

export function summarize(rows: EvalRow[]) {
  if (!rows.length) throw new Error("没有评测样本");
  const metrics = {} as Record<keyof QueryMetrics, number | null>;
  for (const key of Object.keys(rows[0].metrics) as Array<keyof QueryMetrics>) {
    const values = rows.map(row => row.metrics[key]).filter((value): value is number => value !== null);
    metrics[key] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }
  return { samples: rows.length, metrics, local: latency(rows.map(row => row.localMs)), wall: latency(rows.map(row => row.wallMs)), embedding: latency(rows.map(row => row.embeddingMs).filter(value => value > 0)), rerank: latency(rows.map(row => row.rerankMs).filter(value => value > 0)), failureRate: rows.filter(row => row.failed).length / rows.length, degradationRate: rows.filter(row => row.degraded).length / rows.length, networkRequests: rows.reduce((sum, row) => sum + row.networkRequests, 0), cacheHits: rows.reduce((sum, row) => sum + row.cacheHits, 0) };
}

export function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

export function pairedBootstrap(left: EvalRow[], right: EvalRow[], repetitions = 5000, seed = 20261002) {
  if (!left.length || new Set(left.map(row => row.id)).size !== left.length || new Set(right.map(row => row.id)).size !== right.length) throw new Error("配对样本为空或重复");
  const byId = new Map(right.map(row => [row.id, row]));
  if (left.length !== right.length || left.some(row => !byId.has(row.id))) throw new Error("配对问题集合不同");
  const differences = left.map(row => row.metrics.ndcg10 - byId.get(row.id)!.metrics.ndcg10);
  const rng = random(seed); const means: number[] = [];
  for (let iteration = 0; iteration < repetitions; iteration++) {
    let sum = 0; for (let index = 0; index < differences.length; index++) sum += differences[Math.floor(rng() * differences.length)];
    means.push(sum / differences.length);
  }
  means.sort((a, b) => a - b);
  return { samples: differences.length, repetitions, seed, mean: differences.reduce((sum, value) => sum + value, 0) / differences.length, lower95: means[Math.floor(repetitions * .025)], upper95: means[Math.min(repetitions - 1, Math.floor(repetitions * .975))] };
}
