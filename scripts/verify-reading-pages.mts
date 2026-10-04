import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import nextEnv from "@next/env";
import Database from "better-sqlite3";
import matter from "gray-matter";

const generate = process.argv.includes("--generate");
assert(generate, "使用 --generate 进行真实模型验收；结果写入 WEAVE_READING_EVIDENCE_DIR 或 docs/evidence/reading-pages。");
nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error(message: string) { throw new Error(message); } });
const locationFile = path.join(os.homedir(), "Library", "Application Support", "Weave", "vault-location.json");
const originalRoot = process.env.WEAVE_VAULT || (fs.existsSync(locationFile) ? JSON.parse(fs.readFileSync(locationFile, "utf8")).activeRoot : undefined) || path.join(os.homedir(), "Documents", "织识");
const originalDb = new Database(path.join(originalRoot, ".weave", "weave.db"), { readonly: true, fileMustExist: true });
const settingsRow = originalDb.prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as { value_json: string } | undefined;
originalDb.close();

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weave-reading-"));
process.env.WEAVE_VAULT = path.join(temporary, "vault");
process.env.WEAVE_CONFIG_DIR = path.join(temporary, "config");
const output = path.resolve(process.env.WEAVE_READING_EVIDENCE_DIR || "docs/evidence/reading-pages");
fs.mkdirSync(output, { recursive: true });

const { closeDb } = await import("../lib/db/client");
try {
  const { AppSettingsSchema, getSettings, saveSettings } = await import("../lib/settings");
  if (settingsRow) {
    const stored = AppSettingsSchema.parse(JSON.parse(settingsRow.value_json));
    saveSettings({ providers: stored.providers, activeProviderId: stored.activeProviderId, preferSavedModels: stored.preferSavedModels, personality: stored.personality });
  }
  const { createSession } = await import("../lib/chat/sessions");
  const { answer } = await import("../lib/chat/answer");
  const { getArtifact } = await import("../lib/chat/artifacts");
  const { SHOW_ME_PROMPT } = await import("../lib/chat/html-guidance");
  const { defaultChatConfig } = await import("../lib/chat/config-server");
  const { reindexAll } = await import("../lib/index/reindex");
  const config = defaultChatConfig();
  assert(config, "当前没有配置可用的真实模型。");
  config.showMe = true;
  const knowledge = path.join(process.env.WEAVE_VAULT, "wiki", "concepts");
  fs.mkdirSync(knowledge, { recursive: true });
  const timestamp = new Date().toISOString();
  const materials = [
    { slug: "reading-flow", title: "交互阅读页生成流程", text: "交互阅读页的流程依次为：检索知识库资料，组装带编号的上下文，模型生成正文和独立 HTML，后端校验引用并保存，用户在隔离窗口中阅读。HTML 预览允许内联脚本，禁止网络请求和访问父页面。完整附件支持预览、全屏与下载；未完成附件保留已生成内容并标记未完成。\n\n" + fs.readFileSync(path.join(process.cwd(), "docs", "chat-experience.md"), "utf8") },
    { slug: "shape-comparison", title: "矩形与三角形面积比较", text: "矩形有四条边、四个直角。矩形面积等于长度乘以宽度。三角形有三条边。三角形面积等于底边乘以对应高度，再除以二。相同的底边和高度时，三角形面积是矩形面积的一半。以底边六厘米、高度四厘米为例，矩形面积是二十四平方厘米，三角形面积是十二平方厘米。比较时需要保持底边与高度相同。" },
    { slug: "rectangle-area", title: "矩形面积参数变化", text: "矩形面积公式为面积＝长度×宽度。长度和宽度以厘米计时，面积单位是平方厘米。长度或宽度保持不变，另一边增加一倍，面积也增加一倍。两边都增加一倍，面积增加到原来的四倍。可以在一至十厘米的正整数范围内选择长度和宽度进行数学演示。六厘米乘以四厘米得到二十四平方厘米。该范围只是演示的输入范围。" },
  ];
  for (const material of materials) {
    fs.writeFileSync(path.join(knowledge, `${material.slug}.md`), matter.stringify(material.text, { id: material.slug, type: "concept", title: material.title, slug: material.slug, created: timestamp, updated: timestamp }));
  }
  reindexAll();
  const cases = [
    { name: "flow", question: "请解释交互阅读页生成流程，用完整流程图和可以前进、返回、重置的分步演示帮助我理解每一步。" },
    { name: "comparison", question: "请比较矩形与三角形面积，用相同底边和高度的真实图形并列展示，提供操作帮助理解为何面积相差一半。" },
    { name: "parameters", question: "请解释矩形面积参数变化，用能调整长度和宽度的图形与结果，帮助理解面积如何变化。" },
  ];
  const results = [];
  console.log(JSON.stringify({ model: config.model, reasoningEffort: config.reasoningEffort, cases: cases.length, source: "真实模型，临时知识库；流程依据项目文档，几何依据明确的数学定义" }));
  for (const entry of cases) {
    console.log(`正在生成：${entry.name}`);
    const sessionId = createSession(entry.question);
    const result = await answer({ sessionId, question: entry.question, config, signal: AbortSignal.timeout(300_000) });
    const artifact = result.artifacts[0];
    assert.equal(artifact?.status, "ready", `${entry.name} 未生成完整页面`);
    assert.equal(result.interrupted, false);
    assert.equal(result.quality.hallucinationCount, 0, `${entry.name} 出现无效引用`);
    const stored = getArtifact(artifact.id);
    assert(stored);
    fs.writeFileSync(path.join(output, `${entry.name}.html`), stored.content);
    fs.writeFileSync(path.join(output, `${entry.name}.md`), result.text);
    results.push({ ...entry, artifactStatus: artifact.status, model: config.model, reasoningEffort: config.reasoningEffort, citations: result.citations.length, timings: result.timings });
    console.log(JSON.stringify(results.at(-1)));
  }
  assert(getSettings().providers.length > 0);
  fs.writeFileSync(path.join(output, "generation.json"), JSON.stringify({ generatedAt: timestamp, source: "real-model", promptSha256: createHash("sha256").update(SHOW_ME_PROMPT).digest("hex"), cases: results }, null, 2) + "\n");
} finally {
  closeDb();
  fs.rmSync(temporary, { recursive: true, force: true });
}
