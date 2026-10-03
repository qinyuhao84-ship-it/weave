import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { PROVIDER_PRESETS, OpenAiCompatibleProvider } from "@/lib/llm/provider";
import { listProviderModels } from "@/lib/llm/models";
import { completeStructured } from "@/lib/llm/structured";
import { BUILTIN_PROVIDERS } from "@/lib/settings";

afterEach(() => vi.unstubAllGlobals());
const services = [...Object.entries(PROVIDER_PRESETS).filter(([, preset]) => preset.baseUrl).map(([id, preset]) => ({ id, baseUrl: preset.baseUrl })), BUILTIN_PROVIDERS.find(provider => provider.id === "opencode-go")!];

it.each(services)("$id：列表、同步、结构化、流式走完整兼容调用链", async ({ id, baseUrl }) => {
  const local = id === "ollama" || id === "lmstudio";
  const apiKey = local ? "" : "fixture-secret";
  const headers: Record<string, string> = id === "opencode-go" ? { "x-opencode-session": "fixture" } : {};
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe(`${baseUrl}${init.method === "POST" ? "/chat/completions" : "/models"}`);
    expect(init.headers).toMatchObject(id === "claude" && init.method !== "POST" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : apiKey ? { Authorization: `Bearer ${apiKey}`, ...headers } : headers);
    if (local) expect(init.headers).not.toHaveProperty("Authorization");
    if (init.method !== "POST") return Response.json({ data: [{ id: "fixture-model" }] });
    const body = JSON.parse(String(init.body)); requests.push(body);
    expect(body.model).toBe("fixture-model"); expect(body).not.toHaveProperty("reasoning_effort");
    if (body.stream) return new Response('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n', { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ choices: [{ message: { content: body.response_format ? '{"ok":true}' : "OK" }, finish_reason: "stop" }] });
  });
  const provider = new OpenAiCompatibleProvider({ baseUrl, apiKey, headers, model: "fixture-model" });
  expect((await listProviderModels({ baseUrl, apiKey, headers })).models).toEqual(["fixture-model"]);
  expect((await provider.complete({ messages: [{ role: "user", content: "Reply OK." }] })).text).toBe("OK");
  expect((await completeStructured({ provider, schema: z.object({ ok: z.boolean() }), schemaName: "probe", messages: [{ role: "user", content: 'Return JSON {"ok":true}.' }] })).data).toEqual({ ok: true });
  const reasoning = vi.fn(); const stream = provider.stream({ messages: [{ role: "user", content: "Reply OK." }], onReasoningDelta: reasoning });
  expect(await stream.next()).toMatchObject({ value: "OK", done: false });
  expect(await stream.next()).toMatchObject({ value: { text: "OK", usage: { totalTokens: 3 } }, done: true });
  expect(reasoning).toHaveBeenCalledWith("thinking"); expect(requests).toHaveLength(3);
});

it("模型元数据不支持的已保存档位不会进入请求", async () => {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    if (init.method !== "POST") return Response.json({ data: [{ id: "deepseek-flash", reasoning_efforts: ["low", "high"] }] });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("reasoning_effort");
    return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
  });
  const baseUrl = "http://localhost/metadata-test";
  await listProviderModels({ baseUrl, apiKey: "", headers: {} });
  await new OpenAiCompatibleProvider({ baseUrl, apiKey: "", model: "deepseek-flash", defaultReasoningEffort: "max" }).complete({ messages: [] });
});
