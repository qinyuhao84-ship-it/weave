import { describe, it, expect, beforeEach, vi } from "vitest";
import { createLightProvider, createProvider } from "@/lib/llm";
import { saveSettings, type ProviderEntry } from "@/lib/settings";
import { dropAllIndexTables } from "@/lib/db/client";

/**
 * provider 的请求体。
 *
 * 这块此前完全没有测试覆盖，而它恰好是「配置写得对不对」唯一能被观察到的层面 ——
 * 思考档、模型名、请求头都只体现在这里，落在界面上的只是间接后果。
 */

function entry(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    id: "p", label: "测试", baseUrl: "http://localhost", apiKey: "k",
    model: "main-model", lightModel: "", supportsStrictSchema: false,
    temperature: 0.3, reasoningEffort: "max", headers: {}, contextWindow: 1_000_000,
    ...overrides,
  };
}

/** 把一次 complete() 实际发出去的请求体截下来 */
async function captureBody(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        model: "m",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  try {
    await run();
  } finally {
    vi.unstubAllGlobals();
  }
  return bodies[0];
}

beforeEach(() => {
  dropAllIndexTables();
});

describe("createLightProvider —— 两个降级互相独立", () => {
  it("没配 lightModel 时，支持低档的模型仍然降到 low", async () => {
    // 原先的实现在没配 lightModel 时直接 return createProvider()，思考档跟着主力模型走。
    // 而内置预设的主力档位常常是 max：同一道题 low 档思考约 660 字、max 档约 3200 字，
    // 一次摘要要多等几十秒 —— 而它正好压在用户提问的关键路径上。
    saveSettings({ providers: [entry({ model: "deepseek-v4.1-flash", lightModel: "", reasoningEffort: "max" })], activeProviderId: "p" });

    const body = await captureBody(() =>
      createLightProvider().complete({ messages: [{ role: "user", content: "摘要这段对话" }] }),
    );

    expect(body.reasoning_effort).toBe("low");
    expect(body.model).toBe("deepseek-v4.1-flash");
  });

  it("配了 lightModel 就用它，同样压到 low", async () => {
    saveSettings({
      providers: [entry({ lightModel: "deepseek-v4-flash", reasoningEffort: "max" })],
      activeProviderId: "p",
    });

    const body = await captureBody(() =>
      createLightProvider().complete({ messages: [{ role: "user", content: "x" }] }),
    );

    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.reasoning_effort).toBe("low");
  });

  it("主力 provider 保留配置里的思考档，不被轻量档污染", async () => {
    saveSettings({ providers: [entry({ reasoningEffort: "max" })], activeProviderId: "p" });

    const body = await captureBody(() =>
      createProvider().complete({ messages: [{ role: "user", content: "x" }] }),
    );

    expect(body.reasoning_effort).toBe("max");
  });
});

describe("通用兼容模型 —— 不强制思考参数", () => {
  it("服务默认行为不发送 reasoning_effort，包括摘要模型", async () => {
    saveSettings({ providers: [entry({ reasoningEffort: "default", apiKey: "" })], activeProviderId: "p" });
    const body = await captureBody(() => createProvider().complete({ messages: [{ role: "user", content: "测试" }] }));
    expect(body).not.toHaveProperty("reasoning_effort");
    const summary = await captureBody(() => createLightProvider().complete({ messages: [{ role: "user", content: "摘要" }] }));
    expect(summary).not.toHaveProperty("reasoning_effort");
  });
});

describe("请求超时与格式降级的边界", () => {
  it("外部取消信号存在时仍遵守超时", async () => {
    const { OpenAiCompatibleProvider } = await import("@/lib/llm/provider");
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    try {
      const provider = new OpenAiCompatibleProvider({ baseUrl: 'http://localhost', apiKey: '', model: 'm' });
      await expect(provider.complete({ messages: [], signal: new AbortController().signal, timeoutMs: 20 })).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally { vi.unstubAllGlobals(); }
  });
  it("HTTP 429 不会被误判为格式不支持", async () => {
    const { OpenAiCompatibleProvider } = await import("@/lib/llm/provider");
    const fetchMock = vi.fn(async () => new Response('{"error":"rate limit"}', { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = new OpenAiCompatibleProvider({ baseUrl: 'http://localhost', apiKey: '', model: 'm' });
      await expect(provider.complete({ messages: [], responseFormat: { type: 'json_object' } })).rejects.toMatchObject({ status: 429, retryable: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it("严格格式和 JSON 对象均被拒绝时完整降级，后续不重复撞错", async () => {
    const { OpenAiCompatibleProvider } = await import("@/lib/llm/provider");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); bodies.push(body);
      return body.response_format ? new Response('{"error":"response_format unsupported"}', { status: 400 }) : new Response('{"choices":[{"message":{"content":"{}"},"finish_reason":"stop"}]}');
    });
    try {
      const provider = new OpenAiCompatibleProvider({ baseUrl: 'http://localhost/', apiKey: '', model: 'm', supportsStrictSchema: true });
      const request = { messages: [], responseFormat: { type: 'json_schema', json_schema: { name: 'fixture', schema: { type: 'object' }, strict: true } } } as const;
      await provider.complete({ ...request, messages: [] });
      await provider.complete({ ...request, messages: [] });
      expect(bodies).toHaveLength(4);
      expect(bodies[2]).not.toHaveProperty('response_format'); expect(bodies[3]).not.toHaveProperty('response_format');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("非流式生成必须有完整、非空的回答", () => {
  async function complete(choice: Record<string, unknown>) {
    vi.stubGlobal("fetch", async () => Response.json({ choices: [choice] }));
    const { OpenAiCompatibleProvider } = await import("@/lib/llm/provider");
    try {
      return await new OpenAiCompatibleProvider({ baseUrl: "http://localhost", apiKey: "", model: "m" })
        .complete({ messages: [{ role: "user", content: "测试" }] });
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it.each([
    ["content_filter", { message: { content: "被拒答的片段" }, finish_reason: "content_filter" }, /服务中止/],
    ["缺少结束原因", { message: { content: "看起来完整的正文" } }, /完成前结束/],
    ["未知结束原因", { message: { content: "看起来完整的正文" }, finish_reason: "tool_calls" }, /完成前结束/],
  ])("拒绝 %s", async (_name, choice, message) => {
    await expect(complete(choice)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(message) });
  });

  it.each(["stop", "length"])("%s 终态的空正文失败", async finishReason => {
    await expect(complete({ message: { content: "  " }, finish_reason: finishReason }))
      .rejects.toMatchObject({ status: 502, message: /没有返回回答正文/ });
  });

  it("length 终态保留非空文本并交给结构化调用方重试", async () => {
    await expect(complete({ message: { content: '{"partial":' }, finish_reason: "length" }))
      .resolves.toMatchObject({ text: '{"partial":', truncated: true });
  });
});
