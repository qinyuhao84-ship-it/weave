import { getActiveProvider, getSettings } from "@/lib/settings";
import { LlmError } from "@/lib/llm/types";
import { OpenAiCompatibleProvider } from "@/lib/llm/provider";
import { reasoningCapability, canonicalReasoningEffort, preferredThinkingEffort, lightReasoningEffort } from "@/lib/llm/capabilities";
import { cachedModelCapability } from "@/lib/llm/models";
import { ChatConfigSchema, type ChatConfig } from "./config";

export function defaultChatConfig(): ChatConfig | null {
  const active = getActiveProvider();
  if (!active?.baseUrl || !active.model) return null;
  return { providerId: active.id, model: active.model, reasoningEffort: preferredThinkingEffort(active.baseUrl, active.model, active.reasoningEffort, cachedModelCapability(active.baseUrl, active.model)), contextWindow: active.contextWindow, showMe: false };
}

export function resolveChatConfig(value?: unknown): ChatConfig {
  const config = ChatConfigSchema.parse(value ?? defaultChatConfig());
  const provider = getSettings().providers.find(entry => entry.id === config.providerId);
  if (!provider?.baseUrl) throw new LlmError("所选模型服务已移除或尚未配置。请重新选择模型服务。", 400);
  const metadata = cachedModelCapability(provider.baseUrl, config.model);
  config.reasoningEffort = canonicalReasoningEffort(provider.baseUrl, config.model, config.reasoningEffort, metadata);
  const capability = reasoningCapability(provider.baseUrl, config.model, metadata);
  if (!capability.known) config.reasoningEffort = "default";
  if (config.reasoningEffort === "default") config.reasoningEffort = preferredThinkingEffort(provider.baseUrl, config.model, config.reasoningEffort, metadata);
  if (capability.known && !capability.efforts.includes(config.reasoningEffort)) {
    throw new LlmError("所选模型不支持这个推理强度，请重新选择可用档位。", 400);
  }
  return config;
}

export function chatProvider(config: ChatConfig, light = false) {
  const entry = getSettings().providers.find(provider => provider.id === config.providerId);
  if (!entry?.baseUrl) throw new LlmError("所选模型服务已移除，请重新选择。", 400);
  const model = light ? entry.lightModel || config.model : config.model;
  const metadata = cachedModelCapability(entry.baseUrl, model);
  const effort = light ? lightReasoningEffort(entry.baseUrl, model, config.reasoningEffort, metadata) : config.reasoningEffort;
  return new OpenAiCompatibleProvider({
    baseUrl: entry.baseUrl, apiKey: entry.apiKey, model, headers: entry.headers,
    contextWindow: light && model !== config.model ? metadata?.contextWindow ?? Math.min(config.contextWindow, 32_768) : config.contextWindow,
    supportsStrictSchema: entry.supportsStrictSchema,
    defaultTemperature: entry.temperature,
    defaultReasoningEffort: effort === "default" ? undefined : effort,
  });
}
