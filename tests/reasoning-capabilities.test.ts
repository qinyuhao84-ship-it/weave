import { expect, it } from "vitest";
import { canonicalReasoningEffort, reasoningCapability } from "@/lib/llm/capabilities";

it.each(["deepseek-v4-pro", "deepseek-v4.1-flash", "deepseek-flash", "deepseek/deepseek-v4-flash"])("%s 经网关也只显示官方思考档位", model => {
  const result = reasoningCapability("https://gateway.example/v1", model);
  expect(result.efforts).toEqual(["default", "none", "low", "high", "max"]);
  expect(result.defaultEffort).toBe("high");
});
it("DeepSeek 兼容别名显示实际对应档位", () => {
  for (const [input, actual] of [["minimal", "low"], ["medium", "high"], ["xhigh", "high"], ["ultra", "max"]] as const) {
    expect(canonicalReasoningEffort("https://gateway.example/v1", "deepseek-v4.1-flash", input)).toBe(actual);
  }
});
it("未知模型不猜测档位，明确元数据优先", () => {
  expect(reasoningCapability("https://gateway.example/v1", "unknown")).toEqual({ efforts: ["default"], known: false });
  expect(reasoningCapability("https://gateway.example/v1", "custom", { id: "custom", reasoningEfforts: ["low", "high"] }).efforts).toEqual(["default", "low", "high"]);
});
it("空能力列表明确关闭档位推断，服务声明的兼容档位不被改名", () => {
  const baseUrl = "https://gateway.example/v1";
  const model = "deepseek-v4.1-flash";
  expect(reasoningCapability(baseUrl, model, { id: model, reasoningEfforts: [] })).toEqual({ efforts: ["default"], known: true });
  expect(canonicalReasoningEffort(baseUrl, model, "medium", { id: model, reasoningEfforts: ["medium"] })).toBe("medium");
});
it("Gemini 不同型号不会共用不受支持的档位", () => {
  expect(reasoningCapability("https://gateway.example/v1", "gemini-3-pro-preview").efforts).toEqual(["default", "low", "high"]);
  expect(reasoningCapability("https://gateway.example/v1", "gemini-3.1-pro-preview").efforts).toEqual(["default", "low", "medium", "high"]);
  expect(reasoningCapability("https://gateway.example/v1", "gemini-3.8-flash").efforts).not.toContain("minimal");
});

it("思考菜单只列实际档位，新选择采用中间档，已选有效档位保留", async () => {
  const { thinkingEfforts, preferredThinkingEffort } = await import("@/lib/llm/capabilities");
  expect(thinkingEfforts(reasoningCapability("https://api.deepseek.com", "deepseek-flash"))).toEqual(["low", "high", "max"]);
  expect(preferredThinkingEffort("https://api.deepseek.com", "deepseek-flash")).toBe("high");
  expect(preferredThinkingEffort("https://api.deepseek.com", "deepseek-flash", "none")).toBe("high");
  expect(preferredThinkingEffort("https://api.deepseek.com", "deepseek-flash", "max")).toBe("max");
  expect(preferredThinkingEffort("https://gateway.example", "custom", "default", { id: "custom", reasoningEfforts: ["none", "low", "medium", "high"] })).toBe("medium");
  expect(preferredThinkingEffort("https://gateway.example", "custom", "default", { id: "custom", reasoningEfforts: [] })).toBe("default");
  expect(thinkingEfforts(reasoningCapability("https://gateway.example", "unknown"))).toEqual([]);
});

it("官方 OpenAI 型号使用各自的真实档位，元数据仍优先", async () => {
  const { thinkingEfforts } = await import("@/lib/llm/capabilities");
  const baseUrl = "https://api.openai.com/v1";
  expect(thinkingEfforts(reasoningCapability(baseUrl, "gpt-5.1"))).toEqual(["low", "medium", "high"]);
  expect(thinkingEfforts(reasoningCapability(baseUrl, "gpt-5.4"))).toEqual(["low", "medium", "high", "xhigh"]);
  expect(thinkingEfforts(reasoningCapability(baseUrl, "gpt-6.1-sol"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(thinkingEfforts(reasoningCapability(baseUrl, "gpt-6.1-sol", { id: "gpt-6.1-sol", reasoningEfforts: ["low", "high"] }))).toEqual(["low", "high"]);
  expect(thinkingEfforts(reasoningCapability(baseUrl, "gpt-future"))).toEqual([]);
});
