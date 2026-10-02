import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { digest } from "./storage";

export type TransportStats = { embeddingMs: number; rerankMs: number; cacheHits: number; networkRequests: number; failures: number };
export class RetrievalCache {
  readonly db: Database.Database;
  readonly stats: TransportStats = { embeddingMs: 0, rerankMs: 0, cacheHits: 0, networkRequests: 0, failures: 0 };
  private original: typeof fetch;
  constructor(file: string, private readonly origin: string, private readonly offline = false) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.original = globalThis.fetch;
  }
  snapshot() { return { ...this.stats }; }
  delta(before: TransportStats): TransportStats { return Object.fromEntries(Object.keys(before).map(key => [key, this.stats[key as keyof TransportStats] - before[key as keyof TransportStats]])) as TransportStats; }
  key(endpoint: string, body: unknown) { return digest(JSON.stringify(["retrieval-cache-v1", this.origin, endpoint, body])); }
  get(key: string): unknown | undefined { const row = this.db.prepare("SELECT value FROM cache WHERE key = ?").get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) : undefined; }
  put(key: string, value: unknown) { this.db.prepare("INSERT OR REPLACE INTO cache VALUES (?, ?)").run(key, JSON.stringify(value)); }
  install() { globalThis.fetch = this.fetch; }
  close() { if (globalThis.fetch === this.fetch) globalThis.fetch = this.original; this.db.close(); }
  readonly fetch: typeof fetch = async (url, init) => {
    const address = new URL(String(url));
    if (address.origin !== new URL(this.origin).origin || !/\/(embeddings|rerank)$/.test(address.pathname)) throw new Error("评测隔离：拒绝非检索网络请求");
    init?.signal?.throwIfAborted();
    const body = JSON.parse(String(init?.body)) as { model: string; input?: string[]; documents?: string[]; [key: string]: unknown };
    const endpoint = address.pathname.endsWith("embeddings") ? "embeddings" : "rerank";
    if (body.model !== (endpoint === "embeddings" ? "BAAI/bge-m3" : "BAAI/bge-reranker-v2-m3")) throw new Error("评测隔离：拒绝未经授权的付费模型");
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    if (endpoint === "embeddings") {
      const input = body.input; if (!Array.isArray(input) || input.some(text => typeof text !== "string")) throw new Error("嵌入请求格式错误");
      const { input: _input, ...parameters } = body;
      const keys = input.map(text => this.key(endpoint, { ...parameters, input: text }));
      const cached = keys.map(key => this.get(key) as number[] | undefined);
      const missing = [...new Set(input.filter((_, index) => !cached[index]))];
      this.stats.cacheHits += cached.filter(Boolean).length;
      if (missing.length) {
        if (this.offline) throw new Error("离线缓存未覆盖嵌入请求");
        const response = await this.network(url, { ...init, body: JSON.stringify({ ...body, input: missing }) }, endpoint);
        const value = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
        const rows = value.data?.slice().sort((a, b) => a.index - b.index);
        if (!rows || rows.length !== missing.length || rows.some((row, index) => row.index !== index || !validVector(row.embedding) || row.embedding.length !== rows[0].embedding.length)) throw new Error("无效真实嵌入响应，未写入缓存");
        this.db.transaction(() => rows.forEach((row, index) => this.put(this.key(endpoint, { ...parameters, input: missing[index] }), row.embedding)))();
      }
      init?.signal?.throwIfAborted();
      return json({ data: keys.map((key, index) => ({ index, embedding: cached[index] || this.get(key) })) });
    }
    const key = this.key(endpoint, body); const cached = this.get(key);
    if (cached !== undefined) { this.stats.cacheHits++; return json(cached); }
    if (this.offline) throw new Error("离线缓存未覆盖重排请求");
    const response = await this.network(url, init, endpoint);
    const value = await response.json() as { results?: Array<{ index: number; relevance_score: number }> };
    const rows = value.results; const count = body.documents?.length;
    if (!rows || rows.length !== count || new Set(rows.map(row => row.index)).size !== count || rows.some(row => !Number.isInteger(row.index) || row.index < 0 || row.index >= count! || !Number.isFinite(row.relevance_score))) throw new Error("无效真实重排响应，未写入缓存");
    init?.signal?.throwIfAborted(); this.put(key, value); return json(value);
  };
  private async network(url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], endpoint: "embeddings" | "rerank") {
    for (let attempt = 0; ; attempt++) {
      const start = performance.now(); this.stats.networkRequests++;
      let recorded = false;
      try {
        const response = await this.original(url, init);
        // 计时包括完整响应下载，不把 JSON 读取的网络等待误算为本地计算。
        const data = await response.text();
        this.stats[endpoint === "embeddings" ? "embeddingMs" : "rerankMs"] += performance.now() - start;
        recorded = true;
        if (!response.ok) {
          this.stats.failures++;
          if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
            const waiting = performance.now();
            try { await new Promise<void>((resolve, reject) => {
              const aborted = () => { clearTimeout(timer); reject(new Error("评测已取消")); };
              const timer = setTimeout(() => { init?.signal?.removeEventListener("abort", aborted); resolve(); }, 1000);
              init?.signal?.addEventListener("abort", aborted, { once: true });
              if (init?.signal?.aborted) aborted();
            }); } finally { this.stats[endpoint === "embeddings" ? "embeddingMs" : "rerankMs"] += performance.now() - waiting; }
            continue;
          }
          throw new Error(`真实检索请求失败 HTTP ${response.status}`);
        }
        return new Response(data, { headers: { "Content-Type": "application/json" } });
      } catch { if (!recorded) { this.stats[endpoint === "embeddings" ? "embeddingMs" : "rerankMs"] += performance.now() - start; this.stats.failures++; } init?.signal?.throwIfAborted(); throw new Error("真实检索网络请求失败，未回显上游内容"); }
    }
  }
}

export function validVector(value: unknown): value is number[] { return Array.isArray(value) && value.length > 0 && value.length <= 8192 && value.every(number => typeof number === "number" && Number.isFinite(number)) && Math.hypot(...value) > 0; }
