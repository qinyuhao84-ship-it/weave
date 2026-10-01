import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { loadLocalEnv } from "./env.mjs";

// 显式运行才会调用真实模型；仅读取配置，不连接应用写库，不发送个人知识内容。
loadLocalEnv("start");
const configDir = process.env.WEAVE_CONFIG_DIR || path.join(os.homedir(), process.platform === "darwin" ? "Library/Application Support/Weave" : ".config/weave");
const location = readJson(path.join(configDir, "vault-location.json"));
const root = process.env.WEAVE_VAULT || location.activeRoot || path.join(os.homedir(), "Documents/织识");
const databasePath = path.join(root, ".weave/weave.db");
let settings = {};
if (fs.existsSync(databasePath)) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try { settings = JSON.parse(database.prepare("SELECT value_json FROM settings LIMIT 1").get()?.value_json || "{}"); }
  finally { database.close(); }
}
let provider = settings.providers?.find(value => value.id === settings.activeProviderId) ?? settings.providers?.[0] ?? {};
if (!settings.preferSavedModels) provider = {
  ...provider,
  baseUrl: process.env.WEAVE_LLM_BASE_URL || provider.baseUrl,
  apiKey: process.env.WEAVE_LLM_API_KEY?.trim() || provider.apiKey,
  model: process.env.WEAVE_LLM_MODEL || provider.model,
  reasoningEffort: process.env.WEAVE_LLM_REASONING_EFFORT || provider.reasoningEffort,
  headers: { ...provider.headers, ...readEnvHeaders() },
};
if (!provider.baseUrl || !provider.model) throw new Error("请先配置模型服务，再显式运行测速。");
const efforts = process.argv.slice(2).length ? process.argv.slice(2) : ["low", "medium", provider.reasoningEffort || "default"];
if (efforts.some(effort => !["default", "none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"].includes(effort))) throw new Error("推理强度无效。");
const messages = [
  { role: "system", content: "根据所给资料回答，用中文简洁解释，标注 [ID:1]，不要编造。" },
  { role: "user", content: "# 资料 [ID:1]\n推荐算法是信息过滤技术的一类，用于预测用户对内容的偏好。协同过滤分为基于用户与基于物品两类：前者使用兴趣相近用户的行为，后者使用物品间的相似性。冷启动指新用户或新物品缺少行为数据，可以通过用户主动选择兴趣或内容特征缓解。\n\n# 问题\n基于用户与基于物品的协同过滤有什么区别？为什么会有冷启动？请在150字内回答。" },
];
const results = [];
for (const effort of [...new Set(efforts)]) {
  process.stdout.write(`测速 ${provider.model} · ${effort}…\n`);
  const started = performance.now();
  const metrics = { model: provider.model, effort, firstReasoningMs: null, firstTextMs: null, totalMs: null, contentCharacters: 0, truncated: false, usage: null };
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(180_000),
      headers: { "Content-Type": "application/json", ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}), ...provider.headers },
      body: JSON.stringify({ model: provider.model, messages, stream: true, max_tokens: 4096, ...(effort !== "default" ? { reasoning_effort: effort } : {}) }),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const decoder = new TextDecoder(); let buffer = "";
    const consume = data => {
      if (!data || data === "[DONE]") return;
      let chunk; try { chunk = JSON.parse(data); } catch { return; }
      const choice = chunk.choices?.[0];
      if (choice?.delta?.reasoning_content && metrics.firstReasoningMs === null) metrics.firstReasoningMs = Math.round(performance.now() - started);
      if (choice?.delta?.content) { metrics.firstTextMs ??= Math.round(performance.now() - started); metrics.contentCharacters += choice.delta.content.length; }
      if (choice?.finish_reason === "length") metrics.truncated = true;
      if (chunk.usage) metrics.usage = chunk.usage;
    };
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || "";
      for (const event of events) consume(event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"));
    }
    if (buffer.startsWith("data:")) consume(buffer.slice(5).trim());
  } catch (error) {
    metrics.error = error?.name === "TimeoutError" ? "请求超过180秒" : error?.message?.startsWith("HTTP ") ? error.message : "模型连接失败";
  }
  metrics.totalMs = Math.round(performance.now() - started);
  results.push(metrics); process.stdout.write(`${JSON.stringify(metrics)}\n`);
}
const output = process.env.WEAVE_BENCHMARK_OUTPUT;
if (output) fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
if (results.some(result => result.error)) process.exitCode = 1;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } }
function readEnvHeaders() {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith("WEAVE_LLM_HEADER_") && value).map(([key, value]) => [key.slice("WEAVE_LLM_HEADER_".length).toLowerCase().replaceAll("_", "-"), value]));
}
