import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

// 只使用合成资料和临时库，不读取个人配置，也不调用模型。
const root = fs.mkdtempSync(path.join(os.tmpdir(), "weave-performance-"));
process.env.WEAVE_VAULT = root;
process.env.WEAVE_CONFIG_DIR = path.join(root, "config");
for (const key of Object.keys(process.env)) if (key.startsWith("WEAVE_LLM_")) delete process.env[key];
const { closeDb } = await import("../lib/db/client");
try {
  const { reindexAll } = await import("../lib/index/reindex");
  const { buildCatalog, readCatalogSummary } = await import("../lib/index/catalog");
  const { buildWikilinkTable } = await import("../lib/index/wikilink-table");
  const { retrieve, excerptForQuery, extractTerms } = await import("../lib/chat/retrieve");
  const { knowledgeContextForDocument } = await import("../lib/ingest/knowledge-context");
  const pageCount = Number(process.env.WEAVE_PERF_PAGES || 300);
  if (!Number.isInteger(pageCount) || pageCount < 10 || pageCount > 5000) throw new Error("WEAVE_PERF_PAGES 必须为 10–5000。");
  const directory = path.join(root, "wiki/concepts");
  fs.mkdirSync(directory, { recursive: true });
  const body = "信息过滤与用户偏好需要结合数据质量和评估方法。".repeat(500);
  for (let index = 0; index < pageCount; index++) {
    const title = index < 8 ? `推荐算法${index}` : `资料条目${index}`;
    const link = index < 8 ? `[[推荐算法${(index + 1) % 8}]]` : "";
    const content = `---\nid: PERF${index}\ntype: concept\ntitle: ${title}\nslug: page-${index}\ncreated: 2026-10-01T00:00:00+08:00\nupdated: 2026-10-01T00:00:00+08:00\n---\n\n${title}。${link}\n\n${body}\n\n${index < 8 ? "协同过滤根据用户与物品相似性给出推荐，冷启动需要内容特征。" : "其他资料。"}`;
    fs.writeFileSync(path.join(directory, `${index}.md`), content);
  }
  const seedStart = performance.now();
  reindexAll();
  const seedMs = performance.now() - seedStart;
  const catalog = buildCatalog();
  const document = Array.from({ length: 8 }, (_, index) => `推荐算法${index}`).join("，") + "。" + body.repeat(15);
  function measure(name: string, run: () => unknown, repetitions = 12) {
    run(); // 预热；不计入统计。
    const samples = Array.from({ length: repetitions }, () => {
      const start = performance.now(); run(); return performance.now() - start;
    }).sort((a, b) => a - b);
    const middle = Math.floor(samples.length / 2);
    const median = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
    return { name, samples: repetitions, medianMs: +median.toFixed(2), p95Ms: +samples[Math.ceil(samples.length * .95) - 1].toFixed(2) };
  }
  const results = [
    measure("catalog", () => buildCatalog()),
    measure("catalog-page-50", () => buildCatalog({ includeSummaries: false }).slice(0, 50).map(readCatalogSummary)),
    measure("wikilink-table", () => buildWikilinkTable()),
    measure("retrieve", () => retrieve("推荐算法0的协同过滤和冷启动有什么区别？")),
    measure("long-query", () => retrieve("请解释信息过滤与用户偏好的推荐方法".repeat(100))),
    measure("excerpt", () => excerptForQuery(body.repeat(8), "信息过滤与用户偏好需要结合数据质量和评估方法")),
    measure("document-context", () => knowledgeContextForDocument(catalog, document), 5),
  ];
  // 可重复的本地向量扫描成本测量；模拟向量不代表真实语义质量。
  if (process.env.WEAVE_PERF_HYBRID === "1") {
    const { saveSettings, RetrievalModelSchema } = await import("../lib/settings");
    const { indexEmbeddings } = await import("../lib/index/embeddings");
    const { retrieveHybrid } = await import("../lib/chat/retrieve");
    const originalFetch = globalThis.fetch;
    const config = RetrievalModelSchema.parse({ enabled: true, baseUrl: "http://127.0.0.1:1", apiKey: "", rerankModel: "" });
    const embedding = Array.from({ length: 1024 }, (_, index) => index % 2 ? .01 : .02);
    // 每一请求按 input 的实际数量回应，索引构建与查询使用同一个维度。
    globalThis.fetch = async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input as string[];
      return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding })) }));
    };
    saveSettings({ retrievalModel: config });
    try {
      await indexEmbeddings(config);
      const query = "推荐算法0的协同过滤和冷启动有什么区别？";
      await retrieveHybrid(query, { config });
      const samples: number[] = [];
      for (let iteration = 0; iteration < 12; iteration++) {
        const start = performance.now(); await retrieveHybrid(query, { config }); samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      results.push({ name: "hybrid-local-1024d-no-network-no-rerank", samples: samples.length, medianMs: +((samples[5] + samples[6]) / 2).toFixed(2), p95Ms: +samples[11].toFixed(2) });
    } finally { saveSettings({ retrievalModel: { ...config, enabled: false } }); globalThis.fetch = originalFetch; }
  }
  const report = { at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, pageCount, bodyCharacters: body.length, documentCharacters: document.length, seedMs: +seedMs.toFixed(2), extractedTerms: extractTerms(document).length, results };
  const output = process.argv[2];
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
