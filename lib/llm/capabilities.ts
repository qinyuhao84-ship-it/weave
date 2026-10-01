import type { Effort } from "@/lib/settings";

export type ModelCapability = { id: string; contextWindow?: number; reasoningEfforts?: Effort[] };
export type ReasoningCapability = { efforts: Effort[]; known: boolean; defaultEffort?: Effort };

/** 按模型家族识别官方档位；未知模型只展示默认，不猜测支持全集。 */
export function reasoningCapability(baseUrl: string, model: string, metadata?: ModelCapability): ReasoningCapability {
  if (metadata?.reasoningEfforts !== undefined) return { efforts: [...new Set<Effort>(["default", ...metadata.reasoningEfforts])], known: true };
  if (/(?:^|\/)deepseek-(?:v4|flash)/i.test(model)) {
    const supported: Effort[] = ["none", "low", "high", "max"];
    return { efforts: ["default", ...supported], known: true, defaultEffort: "high" };
  }
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { /* 未配置 */ }
  if (/(?:^|\/)gemini-(2\.5|3)/i.test(model)) {
    const originalPro = /gemini-3-pro/i.test(model);
    const allowsMinimal = /gemini-3(?:\.(?:1|5|6))?-(?:flash|flash-lite)/i.test(model);
    const allowsNone = /gemini-2\.5-flash/i.test(model);
    return { efforts: ["default", ...(allowsNone ? ["none" as const] : []), ...(allowsMinimal ? ["minimal" as const] : []), "low", ...(originalPro ? [] : ["medium" as const]), "high"], known: true };
  }
  if (host === "api.deepseek.com") {
    if (/^deepseek-v4/i.test(model)) return { efforts: ["default", "none", "low", "high", "max"], known: true };
    if (/^deepseek-chat$/i.test(model)) return { efforts: ["default"], known: true };
  }
  if (host === "api.openai.com" && /^(gpt-4o|gpt-4\.1|gpt-3\.5)/i.test(model)) return { efforts: ["default"], known: true };
  return { efforts: ["default"], known: false };
}

/** 轻任务统一降档；尊重默认/关闭/极低设置，不给未知轻量模型猜参数。 */
export function lightReasoningEffort(baseUrl: string, model: string, configured: Effort, metadata?: ModelCapability): Effort {
  if (configured === "default") return "default";
  const capability = reasoningCapability(baseUrl, model, metadata);
  if ((configured === "none" || configured === "minimal") && capability.efforts.includes(configured)) return configured;
  return capability.efforts.includes("low") ? "low" : "default";
}

/** 官方推理模型不接受通用温度参数；未知兼容端点保持现有协议。 */
export function supportsTemperature(baseUrl: string, model: string, effort?: Effort): boolean {
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { return true; }
  if (host !== "api.openai.com") return true;
  if (/^o[134](?:-|$)/i.test(model)) return false;
  if (/^gpt-[56](?:\.|-|$)/i.test(model)) {
    // GPT-5 最初一代即使低档也不支持；后续支持 none 的模型才允许采样。
    return effort === "none" && !/^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/i.test(model);
  }
  return true;
}

/** DeepSeek 兼容别名归一为同一个实际档位，避免界面显示虚假的额外选项。 */
export function canonicalReasoningEffort(_baseUrl: string, model: string, effort: Effort, metadata?: ModelCapability): Effort {
  if (metadata?.reasoningEfforts?.includes(effort)) return effort;
  if (/(?:^|\/)deepseek-(?:v4|flash)/i.test(model)) {
    if (effort === "minimal") return "low";
    if (effort === "medium" || effort === "xhigh") return "high";
    if (effort === "ultra") return "max";
  }
  return effort;
}

export const EFFORT_LABELS: Record<Effort, string> = {
  default: "默认", none: "不思考", minimal: "极低", low: "低", medium: "中",
  high: "高", xhigh: "更高", ultra: "极高", max: "最高",
};
