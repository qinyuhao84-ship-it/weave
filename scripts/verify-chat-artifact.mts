import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import type { ChatArtifact, ChatConfig, ChatTimings } from "../lib/chat/config";
import type { PublicSettings } from "../lib/settings";

// 显式运行真实模型验收；服务必须使用系统临时目录中的真实知识库副本。
const base = new URL(process.argv[2] || "http://127.0.0.1:3001");
assert.equal(base.hostname, "127.0.0.1");
const output = path.resolve(process.argv[3] || ".eval-cache/chat-artifact-real");
fs.mkdirSync(output, { recursive: true });
async function api<T>(route: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(new URL(route, base), { method, signal: AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${method} ${route}: HTTP ${response.status}`);
  const result = await response.json() as { ok: boolean; data: T };
  assert.ok(result.ok);
  return result.data;
}
const vault = await api<{ vaultRoot: string }>("/api/vault");
assert.ok([os.tmpdir(), "/tmp"].some(directory => fs.realpathSync(vault.vaultRoot).startsWith(`${fs.realpathSync(directory)}${path.sep}`)), "只允许使用系统临时目录中的知识库副本");
const { settings } = await api<{ settings: PublicSettings }>("/api/settings");
const provider = settings.providers.find(entry => entry.id === settings.activeProviderId)!;
assert.ok(provider?.baseUrl && provider.model);
const config: ChatConfig = { providerId: provider.id, model: provider.model, reasoningEffort: "high", contextWindow: provider.contextWindow, showMe: true };
type Run = { id: string; status: string; text: string; artifacts: ChatArtifact[]; timings: ChatTimings };
async function waitFor<T>(read: () => Promise<T>, complete: (value: T) => boolean, timeout = 240_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (complete(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("真实模型验收等待超时");
}
const started = Date.now();
const first = await api<{ runId: string; sessionId: string }>("/api/chat", "POST", { question: "讲讲天命", config });
const answer = await waitFor(() => api<Run>(`/api/chat/runs/${first.runId}`), value => value.status !== "running");
assert.equal(answer.status, "done");
assert.ok(answer.text.trim());
assert.ok(!answer.text.includes("<html"));
assert.equal(answer.artifacts[0].status, "pending");
const textReadyMs = Date.now() - started;
const artifactId = answer.artifacts[0].id;
console.log(JSON.stringify({ textReadyMs, artifactStatus: "pending", timings: answer.timings }));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(new URL(`/chat?s=${first.sessionId}`, base).href);
  await page.getByTestId("chat-artifact-pending").waitFor();
  assert.equal(await page.locator("textarea").isEnabled(), true);
  await page.screenshot({ path: path.join(output, "text-ready-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "text-ready-mobile.png"), fullPage: true });
  await page.reload();
  await page.getByTestId("chat-artifact-pending").waitFor();
  assert.equal(await page.locator("textarea").isEnabled(), true);
  const next = await api<{ runId: string }>("/api/chat", "POST", { sessionId: first.sessionId, question: "用一句话总结", config: { ...config, showMe: false } });
  const duringSecond = await api<{ status: string }>(`/api/chat/artifacts/${artifactId}`);
  assert.equal(duringSecond.status, "pending");
  const second = await waitFor(() => api<Run>(`/api/chat/runs/${next.runId}`), value => value.status !== "running");
  assert.equal(second.status, "done");
  const ready = await waitFor(() => api<{ status: string }>(`/api/chat/artifacts/${artifactId}`), value => value.status !== "pending");
  assert.equal(ready.status, "ready");
  const pageReadyMs = Date.now() - started;
  await page.getByTestId("chat-artifact").waitFor({ timeout: 10_000 });
  const frame = page.frameLocator('iframe[title*="预览"]');
  await frame.locator("main").waitFor();
  assert.ok((await frame.locator("main").innerText()).trim());
  const preview = await fetch(new URL(`/api/chat/artifacts/${artifactId}?preview=1`, base));
  assert.ok(preview.headers.get("Content-Security-Policy")?.includes("sandbox allow-scripts;"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(output, "page-ready-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "全屏阅读" }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const stop = await api<{ runId: string }>("/api/chat", "POST", { sessionId: first.sessionId, question: "什么是天命三七论？请简短解释。", config });
  const stopAnswer = await waitFor(() => api<Run>(`/api/chat/runs/${stop.runId}`), value => value.status !== "running");
  assert.equal(stopAnswer.status, "done");
  const stoppedId = stopAnswer.artifacts[0].id;
  await api(`/api/chat/artifacts/${stoppedId}`, "DELETE");
  const cancelled = await waitFor(() => api<{ status: string }>(`/api/chat/artifacts/${stoppedId}`), value => value.status !== "pending");
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await api<Run>(`/api/chat/runs/${stop.runId}`)).text, stopAnswer.text);
  // 使用真实的连接拒绝检查失败处理，随后恢复副本的原配置。
  const saved = { id: provider.id, label: provider.label, baseUrl: provider.baseUrl, model: provider.model, contextWindow: provider.contextWindow, reasoningEffort: provider.reasoningEffort };
  try {
    await api("/api/settings", "PATCH", { providers: [{ ...saved, baseUrl: "http://127.0.0.1:1/v1" }], activeProviderId: provider.id });
    await api(`/api/chat/artifacts/${stoppedId}`, "POST");
    const failed = await waitFor(() => api<{ status: string }>(`/api/chat/artifacts/${stoppedId}`), value => value.status !== "pending");
    assert.equal(failed.status, "failed");
    assert.equal((await api<Run>(`/api/chat/runs/${stop.runId}`)).status, "done");
    assert.equal((await api<Run>(`/api/chat/runs/${stop.runId}`)).text, stopAnswer.text);
  } finally { await api("/api/settings", "PATCH", { providers: [saved], activeProviderId: provider.id }); }
  await page.reload();
  await page.getByTestId("chat-artifact-pending").getByRole("button", { name: "重新生成页面" }).waitFor();
  await page.getByTestId("chat-artifact-pending").getByRole("button", { name: "重新生成页面" }).click();
  await page.getByRole("button", { name: "停止生成页面" }).waitFor();
  await page.getByRole("button", { name: "停止生成页面" }).click();
  await page.getByText("交互页面生成已停止，文字回答已保留。").waitFor();
  assert.deepEqual(errors, []);
  const report = { at: new Date().toISOString(), model: config.model, reasoningEffort: config.reasoningEffort, textReadyMs, pageReadyMs, textTimings: answer.timings, checks: ["真实模型先完成文字", "页面独立生成", "页面生成期间可以继续提问", "刷新恢复生成状态", "桌面与手机宽度", "HTML 独立来源与 CSP", "全屏与键盘关闭", "停止页面保留文字", "真实连接失败保留文字", "从失败状态重新生成并停止"], pageErrors: errors };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
