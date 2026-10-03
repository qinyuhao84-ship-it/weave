import { z } from "zod";
import { handle, fail, readJsonObject } from "@/lib/api";
import { getSettings, ProviderInputSchema, readStoredSettings } from "@/lib/settings";
import { listProviderModels } from "@/lib/llm/models";
import { OpenAiCompatibleProvider } from "@/lib/llm/provider";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Input = ProviderInputSchema.partial().required({ id: true, baseUrl: true });
const RequestSchema = z.union([
  z.object({ providerId: z.string(), test: z.boolean().optional() }).strict(),
  z.object({ provider: Input, test: z.boolean().optional() }).strict(),
]);
export async function POST(request: Request) {
  return handle(async () => {
    const body = RequestSchema.parse(await readJsonObject(request));
    let provider;
    if ("providerId" in body) provider = getSettings().providers.find(p => p.id === body.providerId);
    else {
      const stored = readStoredSettings().providers.find(p => p.id === body.provider.id);
      provider = { ...stored, ...body.provider, apiKey: body.provider.clearApiKey ? "" : body.provider.apiKey || stored?.apiKey || "", headers: body.provider.headers ?? stored?.headers ?? {} };
    }
    if (!provider?.baseUrl) return fail("请先填写 API 地址，或选择已保存的服务。", 400);
    if (body.test) {
      const model = provider.model;
      if (!model) return fail("请先选择或填写模型名。", 400);
      const startedAt = Date.now();
      const client = new OpenAiCompatibleProvider({ baseUrl: provider.baseUrl, apiKey: provider.apiKey ?? "", headers: provider.headers, model,
        defaultTemperature: provider.temperature,
        defaultReasoningEffort: provider.reasoningEffort === "default" ? undefined : provider.reasoningEffort,
        supportsStrictSchema: provider.supportsStrictSchema, timeoutMs: 30_000 });
      // 连接测试使用极短请求，验证所选模型的生成权限；不发送知识库内容。
      const result = await client.complete({ messages: [{ role: "user", content: "Reply OK." }], maxTokens: 128 });
      if (!result.text.trim()) return fail("服务有响应，但没有返回文本。请检查模型是否支持文本生成。", 502);
      return { connected: true, model, elapsedMs: Date.now() - startedAt };
    }
    return listProviderModels(provider);
  });
}
