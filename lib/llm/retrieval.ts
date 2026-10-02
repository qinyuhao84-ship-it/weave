import { z } from "zod";
import type { RetrievalModelSettings } from "@/lib/settings";
import { LlmError } from "./types";

const vectorSchema = z.array(z.number().finite()).min(1).max(8192);
const embeddingResponse = z.object({ data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: vectorSchema })) });
const rerankResponse = z.object({ results: z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number().finite() })) });

/** 检索协议独立于聊天参数。上游正文、URL、凭据永不进入错误消息。 */
async function request(config: RetrievalModelSettings, endpoint: string, body: unknown, signal?: AbortSignal, timeoutMs = 8000): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify(body), signal: combined,
    });
    if (!response.ok) { await response.body?.cancel(); throw new LlmError(`检索模型请求失败（HTTP ${response.status}），请检查配置或稍后重试。`, response.status); }
    // 响应同样有体积上限；不能因异常网关 JSON 耗尽内存。
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new Error();
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LlmError) throw error;
    throw new LlmError("检索模型连接超时或响应无效，请检查地址、模型和网络后重试。", 502);
  }
}

export function normalizeVector(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new LlmError("嵌入模型返回了无效向量。", 502);
  return vector.map(value => value / norm);
}

export async function embedTexts(config: RetrievalModelSettings, texts: string[], signal?: AbortSignal, timeoutMs?: number): Promise<number[][]> {
  if (!texts.length) return [];
  const result = embeddingResponse.safeParse(await request(config, "embeddings", { model: config.embeddingModel, input: texts, encoding_format: "float" }, signal, timeoutMs));
  if (!result.success || result.data.data.length !== texts.length) throw new LlmError("嵌入模型返回的向量数量或格式不正确。", 502);
  const ordered = [...result.data.data].sort((a, b) => a.index - b.index);
  if (ordered.some((entry, index) => entry.index !== index || entry.embedding.length !== ordered[0].embedding.length)) throw new LlmError("嵌入模型返回的索引或维度不一致。", 502);
  return ordered.map(entry => normalizeVector(entry.embedding));
}

export async function rerankTexts(config: RetrievalModelSettings, query: string, documents: string[], signal?: AbortSignal): Promise<Array<{ index: number; score: number }>> {
  if (!documents.length || !config.rerankModel) return [];
  const result = rerankResponse.safeParse(await request(config, "rerank", { model: config.rerankModel, query: query.slice(0, config.chunkChars), documents, top_n: documents.length, return_documents: false }, signal));
  if (!result.success || result.data.results.length !== documents.length || new Set(result.data.results.map(item => item.index)).size !== documents.length || result.data.results.some(item => item.index >= documents.length)) throw new LlmError("重排模型返回的索引或数量不正确。", 502);
  return result.data.results.map(item => ({ index: item.index, score: item.relevance_score })).sort((a, b) => b.score - a.score || a.index - b.index);
}
