import { createHash } from "node:crypto";
import { getSqlite } from "@/lib/db/client";
import { getSettings, type RetrievalModelSettings } from "@/lib/settings";
import { readFileIfExists } from "@/lib/vault/atomic";
import { absolutePath } from "@/lib/vault/paths";
import { embedTexts } from "@/lib/llm/retrieval";
import { enqueue, listJobs, cancel, type JobContext } from "@/lib/jobs/runner";

export const hashContent = (raw: string) => createHash("sha256").update(raw).digest("hex");
export const embeddingProfile = (config: RetrievalModelSettings) => hashContent(JSON.stringify([config.baseUrl.replace(/\/+$/, ""), config.embeddingModel, config.chunkChars, "chunks-v1"]));
export const pageBody = (raw: string) => raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
type PageRow = { id: string; title: string; file_path: string; content_hash: string };
export type VectorHit = { pageId: string; score: number; chunkStart: number; contentHash: string };

/** 重叠分块，原文坐标保留给语义片段提取；不将整篇长文截成一个向量。 */
export function embeddingChunks(body: string, size: number): Array<{ start: number; text: string }> {
  const chunks: Array<{ start: number; text: string }> = [];
  const overlap = Math.min(200, Math.floor(size / 10));
  for (let start = 0; start < body.length; start += size - overlap) {
    const text = body.slice(start, start + size);
    if (text.trim()) chunks.push({ start, text });
    if (start + size >= body.length) break;
  }
  return chunks;
}

export function embeddingIndexStatus(config = getSettings().retrievalModel) {
  const profile = embeddingProfile(config);
  const sqlite = getSqlite();
  const total = (sqlite.prepare("SELECT count(*) AS n FROM pages WHERE status = 'active'").get() as { n: number }).n;
  const indexed = (sqlite.prepare(`SELECT count(DISTINCT e.page_id) AS n FROM page_embeddings e JOIN pages p ON p.id = e.page_id WHERE e.profile = ? AND e.content_hash = p.content_hash AND p.status = 'active'`).get(profile) as { n: number }).n;
  const active = listJobs(1, { kind: "embeddings", activeOnly: true })[0];
  const latest = listJobs(1, { kind: "embeddings" })[0];
  const failed = !active && latest?.status === "failed" && (latest.payload as { profile?: string } | null)?.profile === profile;
  return { total, indexed, pending: total - indexed, jobId: active?.id ?? null, failed: Boolean(failed) };
}

export async function indexEmbeddings(config: RetrievalModelSettings, signal?: AbortSignal, onProgress?: (done: number, total: number) => void) {
  if (!config.enabled) return { indexed: 0, skipped: 0 };
  const sqlite = getSqlite(); const profile = embeddingProfile(config);
  const pending = sqlite.prepare(`SELECT p.id, p.title, p.file_path, p.content_hash FROM pages p WHERE p.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM page_embeddings e WHERE e.page_id = p.id AND e.profile = ? AND e.content_hash = p.content_hash) ORDER BY p.id`).all(profile) as PageRow[];
  let indexed = 0; let skipped = 0;
  for (const page of pending) {
    signal?.throwIfAborted();
    if (embeddingProfile(getSettings().retrievalModel) !== profile || !getSettings().retrievalModel.enabled) break;
    const raw = readFileIfExists(absolutePath(page.file_path));
    if (raw === null || hashContent(raw) !== page.content_hash) { skipped++; continue; }
    const chunks = embeddingChunks(pageBody(raw), config.chunkChars);
    if (!chunks.length) chunks.push({ start: 0, text: "" }); // 空正文仍可按标题建立索引。
    const vectors: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += 8) {
      signal?.throwIfAborted();
      const currentConfig = getSettings().retrievalModel;
      if (!currentConfig.enabled || embeddingProfile(currentConfig) !== profile) return { indexed, skipped: skipped + 1 };
      vectors.push(...await embedTexts(config, chunks.slice(offset, offset + 8).map(chunk => `${page.title.slice(0, 256)}\n${chunk.text}`), signal, 30_000));
    }
    // 网络等待期间可能发生外部编辑；文件和索引都必须仍是同一版本。
    signal?.throwIfAborted();
    if (readFileIfExists(absolutePath(page.file_path)) !== raw || embeddingProfile(getSettings().retrievalModel) !== profile || !getSettings().retrievalModel.enabled) { skipped++; continue; }
    const current = sqlite.prepare("SELECT content_hash, status FROM pages WHERE id = ?").get(page.id) as { content_hash: string; status: string } | undefined;
    if (current?.content_hash !== page.content_hash || current.status !== "active") { skipped++; continue; }
    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM page_embeddings WHERE page_id = ?").run(page.id);
      const insert = sqlite.prepare("INSERT INTO page_embeddings VALUES (?, ?, ?, ?, ?, ?, ?)");
      vectors.forEach((vector, index) => {
        if (vector.length !== vectors[0].length) throw new Error("嵌入模型在同一词条内返回了不同维度。");
        const binary = Buffer.alloc(vector.length * 4);
        vector.forEach((value, dimension) => binary.writeFloatLE(value, dimension * 4));
        insert.run(profile, page.id, page.content_hash, index, chunks[index].start, vector.length, binary);
      });
    })();
    indexed++; onProgress?.(indexed + skipped, pending.length);
  }
  return { indexed, skipped };
}

/** 本地小型知识库采用精确余弦扫描，只读取派生向量；查询不扫描全库正文。 */
export async function searchVectors(query: string, config: RetrievalModelSettings, limit: number, signal?: AbortSignal): Promise<VectorHit[]> {
  const sqlite = getSqlite(); const profile = embeddingProfile(config);
  if (!(sqlite.prepare("SELECT 1 FROM page_embeddings WHERE profile = ? LIMIT 1").get(profile))) return [];
  const [vector] = await embedTexts(config, [query.slice(0, config.chunkChars)], signal);
  const rows = sqlite.prepare(`SELECT e.page_id, e.content_hash, e.chunk_start, e.vector, p.file_path FROM page_embeddings e JOIN pages p ON p.id = e.page_id
    WHERE e.profile = ? AND e.dimensions = ? AND e.content_hash = p.content_hash AND p.status = 'active'`).iterate(profile, vector.length) as Iterable<{ page_id: string; content_hash: string; chunk_start: number; vector: Buffer; file_path: string }>;
  const hits = new Map<string, VectorHit & { filePath: string }>();
  for (const row of rows) {
    if (row.vector.length !== vector.length * 4) continue;
    let score = 0;
    for (let index = 0; index < vector.length; index++) score += vector[index] * row.vector.readFloatLE(index * 4);
    if (Number.isFinite(score) && score > (hits.get(row.page_id)?.score ?? -Infinity)) hits.set(row.page_id, { pageId: row.page_id, score, chunkStart: row.chunk_start, contentHash: row.content_hash, filePath: row.file_path });
  }
  const results: VectorHit[] = [];
  for (const hit of [...hits.values()].sort((a, b) => b.score - a.score || a.pageId.localeCompare(b.pageId))) {
    if (results.length >= limit) break;
    const raw = readFileIfExists(absolutePath(hit.filePath));
    if (raw !== null && hashContent(raw) === hit.contentHash) results.push(hit);
  }
  return results;
}

const background = globalThis as typeof globalThis & { __weaveEmbeddingTimer?: ReturnType<typeof setTimeout>; __weaveEmbeddingRetryAt?: number; __weaveEmbeddingDirty?: boolean };
export function startEmbeddingIndex(): string | null {
  const config = getSettings().retrievalModel;
  if (!config.enabled || !config.baseUrl || !config.embeddingModel) return null;
  const status = embeddingIndexStatus(config);
  if (status.jobId) { background.__weaveEmbeddingDirty = true; return status.jobId; }
  if (!status.pending) return null;
  return enqueue({ kind: "embeddings", payload: { profile: embeddingProfile(config) }, handler: async (context: JobContext) => {
    context.setStage("embedding", "更新向量索引");
    try { return await indexEmbeddings(getSettings().retrievalModel, context.signal, (done, total) => context.setFraction(done / Math.max(1, total), `已处理 ${done}/${total} 个词条`)); }
    catch (error) { background.__weaveEmbeddingRetryAt = Date.now() + 60_000; throw error; }
    finally { if (background.__weaveEmbeddingDirty) { background.__weaveEmbeddingDirty = false; scheduleEmbeddingIndex(); } }
  } });
}
/** 保存新配置或禁用时，立即中止旧配置的在途请求。 */
export function stopEmbeddingIndex(): void {
  if (background.__weaveEmbeddingTimer) clearTimeout(background.__weaveEmbeddingTimer);
  background.__weaveEmbeddingTimer = undefined;
  background.__weaveEmbeddingRetryAt = 0;
  background.__weaveEmbeddingDirty = false;
  const active = listJobs(1, { kind: "embeddings", activeOnly: true })[0];
  if (active) cancel(active.id);
}
export function scheduleEmbeddingIndex(): void {
  // 协议测试通过显式 indexEmbeddings 调用验证，不能留下访问真实网关的计时器。
  if (process.env.VITEST) return;
  if (background.__weaveEmbeddingTimer) clearTimeout(background.__weaveEmbeddingTimer);
  background.__weaveEmbeddingTimer = setTimeout(() => {
    background.__weaveEmbeddingTimer = undefined;
    if (Date.now() < (background.__weaveEmbeddingRetryAt ?? 0)) return;
    try { startEmbeddingIndex(); } catch { /* 查询和保存不依赖后台索引成功。 */ }
  }, 1000);
  background.__weaveEmbeddingTimer.unref?.();
}
