import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { loadLocalEnv } from "./env.mjs";
import { OpenAiCompatibleProvider } from "../lib/llm/provider";
import { listProviderModels } from "../lib/llm/models";
import { completeStructured } from "../lib/llm/structured";
import type { ProviderEntry } from "../lib/settings";

// 显式执行才产生真实调用费用。配置库只读；请求仅含固定测试文字，不读取知识库资料。
loadLocalEnv("start");
function readJson(file: string) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } }
const configDir = process.env.WEAVE_CONFIG_DIR || path.join(os.homedir(), process.platform === "darwin" ? "Library/Application Support/Weave" : ".config/weave");
const root = process.env.WEAVE_VAULT || readJson(path.join(configDir, "vault-location.json")).activeRoot || path.join(os.homedir(), "Documents/织识");
const file = path.join(root, ".weave/weave.db");
let providers: ProviderEntry[] = [];
if (fs.existsSync(file)) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { providers = JSON.parse((db.prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as { value_json?: string })?.value_json || "{}").providers ?? []; }
  finally { db.close(); }
}
// 启动配置也独立检查，可覆盖已保存服务之外的网关；不修改激活项。
if (process.env.WEAVE_LLM_BASE_URL && process.env.WEAVE_LLM_MODEL) {
  providers.push({ id: "startup-env", baseUrl: process.env.WEAVE_LLM_BASE_URL, apiKey: process.env.WEAVE_LLM_API_KEY?.trim() ?? "", model: process.env.WEAVE_LLM_MODEL,
    reasoningEffort: process.env.WEAVE_LLM_REASONING_EFFORT as ProviderEntry["reasoningEffort"] || "default", temperature: 0.3, supportsStrictSchema: false,
    headers: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith("WEAVE_LLM_HEADER_") && value).map(([key, value]) => [key.slice("WEAVE_LLM_HEADER_".length).toLowerCase().replaceAll("_", "-"), value!])),
    label: "启动配置", lightModel: "", contextWindow: 32768 });
}
const results = [];
for (const entry of providers) {
  if (!entry.baseUrl || !entry.model) continue;
  const client = new OpenAiCompatibleProvider({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, headers: entry.headers, model: entry.model,
    defaultTemperature: entry.temperature, defaultReasoningEffort: entry.reasoningEffort === "default" ? undefined : entry.reasoningEffort,
    supportsStrictSchema: entry.supportsStrictSchema, timeoutMs: 60_000 });
  const checks: Record<string, unknown> = {};
  const check = async (name: string, run: () => Promise<unknown>) => {
    process.stdout.write(`检查 ${entry.model} · ${name}…\n`);
    const start = Date.now();
    try { const result = await run(); checks[name] = { passed: true, elapsedMs: Date.now() - start, result }; }
    catch (error) { checks[name] = { passed: false, elapsedMs: Date.now() - start, error: error instanceof Error ? error.name : "Error", status: (error as { status?: number })?.status }; }
    // 不打印密钥、请求头值或上游错误正文。
  };
  await check("models", async () => { const list = await listProviderModels(entry); return { supported: list.supported, selectedAvailable: list.supported ? list.models.some(model => model === entry.model) : null }; });
  await check("complete", async () => { const result = await client.complete({ messages: [{ role: "user", content: "Reply with only OK." }], maxTokens: 4096 }); if (!result.text.trim() || result.truncated) throw new Error("NoCompleteText"); return { textPresent: true }; });
  await check("stream", async () => {
    const stream = client.stream({ messages: [{ role: "user", content: "Reply with only OK." }], maxTokens: 4096 });
    let text = "";
    for (;;) { const next = await stream.next(); if (next.done) { if (!text.trim() || next.value.truncated) throw new Error("NoStreamText"); break; } text += next.value; }
    return { textPresent: true };
  });
  await check("structured", async () => { const result = await completeStructured({ provider: client, schema: z.object({ ok: z.literal(true) }), schemaName: "connection_probe", messages: [{ role: "user", content: 'Return a JSON object with ok set to true.' }], maxTokens: 4096, timeoutMs: 60_000, maxAttempts: 1 }); return { valid: result.data.ok }; });
  results.push({ providerId: entry.id, model: entry.model, host: new URL(entry.baseUrl).hostname, checks });
}
const report = { at: new Date().toISOString(), scope: "仅测试本机已有配置；不等于所有供应商账号或模型已实测", results };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!results.length || results.some(result => Object.values(result.checks).some(check => !(check as { passed: boolean }).passed))) process.exitCode = 1;
