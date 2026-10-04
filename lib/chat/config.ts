import { z } from "zod";
import { REASONING_EFFORTS } from "@/lib/llm/types";
import type { ProviderEntry } from "@/lib/settings";

export const ChatConfigSchema = z.object({
  providerId: z.string().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.enum(["default", ...REASONING_EFFORTS]),
  contextWindow: z.number().int().min(1000).max(10_000_000),
  showMe: z.boolean().default(false),
}).strict();
export type ChatConfig = z.infer<typeof ChatConfigSchema>;

/** 恢复历史选择时，已删除/未配置的服务回到当前默认；有效的独立选择仍保留。 */
export function restoreChatConfig(config: ChatConfig | null, settings: {
  providers: Pick<ProviderEntry, "id" | "baseUrl" | "model" | "reasoningEffort" | "contextWindow">[];
  activeProviderId: string;
}): ChatConfig | null {
  const selected = settings.providers.find(provider => provider.id === config?.providerId && provider.baseUrl && provider.model);
  if (selected && config) return { ...config };
  const provider = settings.providers.find(provider => provider.id === settings.activeProviderId && provider.baseUrl && provider.model);
  if (!provider) return null;
  return {
    providerId: provider.id, model: provider.model, reasoningEffort: provider.reasoningEffort,
    contextWindow: provider.contextWindow, showMe: config?.showMe ?? false,
  };
}

export type ChatTimings = {
  preparedMs?: number;
  compressionMs?: number;
  requestedMs?: number;
  firstReasoningMs?: number;
  firstTextMs?: number;
  generatedMs?: number;
  savedMs?: number;
  promptTokens?: number;
  completionTokens?: number;
};

export type ChatArtifact = {
  id: string;
  messageId: string;
  name: string;
  mediaType: string;
  status: "ready" | "basic" | "incomplete" | "pending" | "failed" | "cancelled";
};
