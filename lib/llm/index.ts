import { isLlmConfigured, getActiveProvider, BUILTIN_PROVIDERS, type ProviderEntry } from "@/lib/settings";
import { OpenAiCompatibleProvider, PROVIDER_PRESETS, isPresetKey } from "./provider";
import { LlmError, type LlmProvider, type ReasoningEffort } from "./types";
import { canonicalReasoningEffort, lightReasoningEffort } from "./capabilities";
import { cachedModelCapability } from "./models";
import { isOpenCodeGoBaseUrl, OPENCODE_GO_CHAT_COMPLETION_MODELS } from "./presets";

export * from "./types";
export { OpenAiCompatibleProvider, PROVIDER_PRESETS, isPresetKey } from "./provider";
export { FakeProvider } from "./fake";
export { completeStructured, extractJson } from "./structured";

/**
 * 按当前设置构建 provider。
 *
 * 「配置驱动」不是洁癖：国内模型型号半年一换，严格 JSON Schema 的支持情况
 * 各家差别很大。把差异收敛在这一层，换模型就只改设置里的一行，
 * 业务代码一行不用动。
 */
function toSdkProvider(
  entry: ProviderEntry,
  modelOverride?: string,
  effortOverride?: ReasoningEffort | "default",
): LlmProvider {
  if (!entry.baseUrl || !(modelOverride || entry.model)) {
    throw new LlmError(
      "请先在设置中配置你的模型服务，再开始导入或问答。",
    );
  }

  const model = modelOverride || entry.model;
  if (isOpenCodeGoBaseUrl(entry.baseUrl) && !OPENCODE_GO_CHAT_COMPLETION_MODELS.includes(model as typeof OPENCODE_GO_CHAT_COMPLETION_MODELS[number])) {
    throw new LlmError("织识只支持 OpenCode Go 中使用 Chat Completions 接口的模型，请从可用模型列表中选择。", 400);
  }
  const effort = canonicalReasoningEffort(entry.baseUrl, model, effortOverride ?? entry.reasoningEffort, cachedModelCapability(entry.baseUrl, model));
  return new OpenAiCompatibleProvider({
    baseUrl: entry.baseUrl.replace(/\/$/, ""),
    apiKey: entry.apiKey,
    model,
    contextWindow: model !== entry.model ? cachedModelCapability(entry.baseUrl, model)?.contextWindow ?? Math.min(entry.contextWindow, 32_768) : entry.contextWindow,
    supportsStrictSchema: entry.supportsStrictSchema,
    defaultTemperature: entry.temperature,
    defaultReasoningEffort: effort === "default" ? undefined : effort,
    headers: entry.headers,
  });
}

export function createProvider(): LlmProvider {
  const active = getActiveProvider();
  if (!active) {
    throw new LlmError(
      "请先在设置中配置你的模型服务，再开始导入或问答。",
    );
  }
  return toSdkProvider(active);
}

/**
 * 轻量任务（对话摘要、标签、分类）用的 provider。
 *
 * 模型与档位分别选择：默认不发参数，已知支持 low 时降档，
 * 保留关闭/极低设置；未知轻量模型不继承主模型的显式档位。
 */
export function createLightProvider(): LlmProvider {
  const active = getActiveProvider();
  if (!active) {
    throw new LlmError("还没有配置任何模型服务。");
  }
  const model = active.lightModel || active.model;
  return toSdkProvider(active, model, lightReasoningEffort(active.baseUrl, model, active.reasoningEffort, cachedModelCapability(active.baseUrl, model)));
}

/** 当前配置下的一次性可用性报告，供设置界面展示 */
export function describeProvider(): {
  configured: boolean;
  label: string;
  model: string;
  supportsStrictSchema: boolean;
  reasoningEffort: string;
  note: string | null;
} {
  const active = getActiveProvider();
  if (!active) {
    return {
      configured: false, label: "（未配置）", model: "（未设置）",
      supportsStrictSchema: false, reasoningEffort: "high", note: null,
    };
  }

  // 优先用配置里的自定义名字；否则按 baseUrl 匹配内置预设的说明
  const matched = BUILTIN_PROVIDERS.find((preset) => preset.id === active.id);

  return {
    configured: isLlmConfigured(),
    label: active.label || matched?.label || "自定义端点",
    model: active.model || "（未设置）",
    supportsStrictSchema: active.supportsStrictSchema,
    reasoningEffort: active.reasoningEffort,
    note: matched?.note ?? null,
  };
}

/** 内置接入点预设，供设置界面一键填充 */
export function listBuiltinProviders() {
  return BUILTIN_PROVIDERS.map((preset) => ({ ...preset }));
}

/** 按预设填充一组默认配置，供设置界面「一键切换服务商」 */
export function applyPreset(presetKey: string): {
  baseUrl: string;
  model: string;
  supportsStrictSchema: boolean;
  headers?: Record<string, string>;
} {
  if (!isPresetKey(presetKey)) {
    return { baseUrl: "", model: "", supportsStrictSchema: false };
  }
  const preset = PROVIDER_PRESETS[presetKey];
  return {
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
    supportsStrictSchema: preset.supportsStrictSchema,
    ...(Object.keys(preset.defaultHeaders).length > 0 ? { headers: preset.defaultHeaders } : {}),
  };
}

/** 列出所有可用预设，供设置界面渲染下拉框 */
export function listPresets() {
  return Object.entries(PROVIDER_PRESETS).map(([key, value]) => ({
    key,
    label: value.label,
    baseUrl: value.baseUrl,
    defaultModel: value.defaultModel,
    supportsStrictSchema: value.supportsStrictSchema,
    note: value.note,
  }));
}
