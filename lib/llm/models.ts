import type { ProviderEntry } from "@/lib/settings";
import { LlmError } from "./types";
import { REASONING_EFFORTS } from "./types";
import type { ModelCapability } from "./capabilities";

const globalModels = globalThis as unknown as { __weaveModelCapabilities?: Map<string, { model: ModelCapability; at: number }> };
const capabilities = () => globalModels.__weaveModelCapabilities ??= new Map();
export function cachedModelCapability(baseUrl: string, model: string): ModelCapability | undefined {
  const entry = capabilities().get(`${baseUrl.replace(/\/+$/, "")}:${model}`);
  return entry && Date.now() - entry.at < 5 * 60_000 ? entry.model : undefined;
}

/** 列表探测不发生成请求，也不暴露密钥或上游错误正文。 */
export async function listProviderModels(provider: Pick<ProviderEntry, "baseUrl" | "apiKey" | "headers">): Promise<{ models: string[]; details?: ModelCapability[]; supported: boolean }> {
  // Claude 的生成接口兼容 OpenAI，模型列表仍是原生 API，需要版本头与原生鉴权。
  const anthropic = new URL(provider.baseUrl).hostname === "api.anthropic.com";
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { ...(anthropic ? { "anthropic-version": "2023-06-01", ...(provider.apiKey ? { "x-api-key": provider.apiKey } : {}) }
        : provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}), ...provider.headers },
      signal: AbortSignal.timeout(10_000), cache: "no-store",
    });
  } catch { throw new LlmError("模型列表连接失败或超时。请检查 API 基础地址、网络与代理；当前输入已保留。"); }
  if (response.status === 404 || response.status === 405) return { models: [], supported: false };
  if (!response.ok) throw new LlmError(response.status === 401 || response.status === 403
    ? "凭据被拒绝，请检查 API Key 与请求头。"
    : `服务返回 HTTP ${response.status}。请检查地址、模型权限与额度。`, response.status);
  const body = await response.json().catch(() => null) as { data?: Array<{ id?: unknown; context_length?: unknown; context_window?: unknown; reasoning_efforts?: unknown; effort?: unknown }> } | null;
  if (!Array.isArray(body?.data)) return { models: [], supported: false };
  const models = [...new Set(body.data.flatMap(model => typeof model?.id === "string" && model.id.length <= 200 ? [model.id] : []))].sort();
  const modelIds = new Set(models);
  const details: ModelCapability[] = body.data.flatMap(model => {
    if (typeof model.id !== "string" || !modelIds.has(model.id)) return [];
    const window = model.context_length ?? model.context_window;
    const officialEffort = model.effort && typeof model.effort === "object" && "supported_levels" in model.effort ? model.effort.supported_levels : model.effort;
    const efforts = model.reasoning_efforts ?? officialEffort;
    const levels = Array.isArray(efforts) ? efforts.filter((value): value is typeof REASONING_EFFORTS[number] => REASONING_EFFORTS.includes(value)) : undefined;
    // DeepSeek 的 supported_levels 只列「开启思考后的强度」，none 是独立关闭开关。
    // 显式 reasoning_efforts（包括空列表）仍完全尊重服务声明。
    if (levels?.length && model.reasoning_efforts === undefined && model.effort && typeof model.effort === "object" && "supported_levels" in model.effort &&
      new URL(provider.baseUrl).hostname === "api.deepseek.com" && !levels.includes("none")) levels.unshift("none");
    return [{ id: model.id,
      ...(typeof window === "number" && Number.isInteger(window) && window >= 1000 && window <= 10_000_000 ? { contextWindow: window } : {}),
      ...(levels ? { reasoningEfforts: levels } : {}),
    }];
  });
  const cache = capabilities();
  for (const model of details.slice(0, 2000)) cache.set(`${provider.baseUrl.replace(/\/+$/, "")}:${model.id}`, { model, at: Date.now() });
  while (cache.size > 4000) cache.delete(cache.keys().next().value!);
  return { models: models.slice(0, 2000), details: details.slice(0, 2000), supported: true };
}
