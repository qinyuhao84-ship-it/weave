import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createDocument } from "@mixmark-io/domino";
import { HtmlAnswerStream, HTML_START, HTML_END, getArtifact, previewHtml, prepareHtml, formatHtmlCitations, saveArtifact, updateArtifact } from "@/lib/chat/artifacts";
import { dropAllIndexTables } from "@/lib/db/client";
import { appendMessage, createSession, beginChatRun, getMessages, getChatRun, getSession, saveSessionConfig, trashSession, restoreSession, permanentlyDeleteSession, buildHistory, saveChatRunProgress, markInterruptedChatRunsFailed } from "@/lib/chat/sessions";
import { resolveChatConfig, chatProvider } from "@/lib/chat/config-server";
import { reasoningCapability } from "@/lib/llm/capabilities";
import { runChatRun } from "@/lib/chat/run";
import * as configServer from "@/lib/chat/config-server";
import { registerStream } from "@/lib/chat/streams";
import { getSettings, saveSettings } from "@/lib/settings";
import { GET as download } from "@/app/api/chat/artifacts/[id]/route";
import { PATCH as patchSession } from "@/app/api/chat/sessions/[id]/route";
import { reindexAll } from "@/lib/index/reindex";
import { resetVault, writePage, frontmatterFor } from "./helpers";
import type { ChatConfig } from "@/lib/chat/config";
import type { CitationView } from "@/lib/chat/citations";

const config: ChatConfig = { providerId: "a", model: "model-a", reasoningEffort: "low", contextWindow: 32768, showMe: true };
const document = '<!DOCTYPE html><html lang="zh-CN"><head><title>图解</title><style>p { white-space: pre; }</style></head><body><h1>推荐算法</h1><p>预测偏好。[ID:1]</p><button onclick="this.textContent=\'完成\'">展开</button><script>const code = "a  b [ID:999]";</script></body></html>';
const citation = (index: number): CitationView => ({ index, pageId: `page-${index}`, pageTitle: `来源 ${index}`, pagePath: `source-${index}.md`, pageType: "concept", sourcePage: null, sourceDoc: null, excerpt: "来源片段", sourceRefs: [] });

it("页面沿用原引用编号，删去未使用资料后保留较大编号和范围引用", () => {
  const chunks = [9, 10].map(index => ({ index, pageTitle: `来源 ${index}`, pagePath: `source-${index}.md`, pageType: "concept", sourcePage: null, sourceDoc: null, content: "来源片段" }));
  const html = prepareHtml('<!DOCTYPE html><html><body><p>[ID:9-10]</p><span data-citation="10"></span></body></html>', chunks, [citation(9), citation(10)]);
  const dom = createDocument(html);
  expect(dom.querySelector("p")?.textContent).toContain("9");
  expect(dom.querySelector("p")?.textContent).toContain("10");
  expect(dom.querySelector('[data-citation="10"]')?.textContent).toBe("10");
});

it("流式模型失败后保留后端校验的正文和引用，不重新落库幻觉标记", async () => {
  const provider = configServer.chatProvider(config);
  vi.spyOn(provider, "stream").mockImplementation(async function* () {
    yield "预测偏好。[ID:1] 虚构引用[ID:999]";
    throw new Error("模拟流式连接中断");
  });
  vi.spyOn(configServer, "chatProvider").mockReturnValue(provider);
  const sessionId = createSession("失败引用"), run = beginChatRun(sessionId, "推荐算法", { ...config, showMe: false });
  await runChatRun({ run, question: "推荐算法", controller: registerStream(sessionId, run.id, run.assistantMessageId) });
  expect(getChatRun(run.id)?.status).toBe("failed");
  const saved = getMessages(sessionId).find(message => message.id === run.assistantMessageId)!;
  expect(saved.content).toContain("预测偏好");
  expect(saved.content).not.toContain("[ID:999]");
  expect(saved.citations).toMatchObject({ quality: { hallucinationCount: 1 } });
});

it("HTML JSON 与独立预览均有 CSP，独立页面以响应头强制独立来源", async () => {
  const sessionId = createSession("沙箱"), run = beginChatRun(sessionId, "问题", config);
  const artifact = saveArtifact({ messageId: run.assistantMessageId, content: document, status: "ready" });
  for (const query of ["", "?preview=1"]) {
    const response = await download(new Request(`http://localhost/api/chat/artifacts/${artifact.id}${query}`), { params: Promise.resolve({ id: artifact.id }) });
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts;");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    if (query) { expect(response.headers.get("Content-Type")).toContain("text/html"); expect(await response.text()).toContain("推荐算法"); }
    else expect((await response.json()).data.content).toContain("推荐算法");
  }
});

it("服务在引用校验前退出，重启恢复不把流式编号当成有效证据", () => {
  const sessionId = createSession("中断引用"), run = beginChatRun(sessionId, "问题", config);
  saveChatRunProgress(run.id, "部分正文[ID:1]及虚构编号[ID:999]");
  expect(markInterruptedChatRunsFailed()).toBe(1);
  const saved = getMessages(sessionId).find(message => message.id === run.assistantMessageId)!;
  expect(saved.content).toContain("部分正文"); expect(saved.content).not.toContain("[ID:");
  expect(getChatRun(run.id)?.status).toBe("failed");
});

it("HTML 引用具有数字上标、来源锚点，转换可重复且不修改代码或属性", () => {
  const source = '<html><head><style>p:before{content:"[ID:1]"}</style></head><body><p data-value="[ID:1]">事实。[ID:1][ID:9][ID:999]<sup data-citation="9"></sup></p><code>[ID:1]</code><pre>[ID:9]</pre><script>const marker="[ID:1]";</script></body></html>';
  const content = formatHtmlCitations(source, [citation(1), citation(9)]);
  const dom = createDocument(content);
  expect(Array.from(dom.querySelectorAll("p sup")).map(node => node.textContent)).toEqual(["1", "9", "9"]);
  expect(dom.querySelector("p")?.textContent).not.toContain("[ID:");
  expect(dom.querySelector('a[href="#weave-source-9"]')?.getAttribute("title")).toBe("来源 9");
  expect(dom.getElementById("weave-source-9")?.textContent).toBe("来源 9");
  expect(dom.querySelector("p")?.getAttribute("data-value")).toBe("[ID:1]");
  expect(dom.querySelector("script")?.textContent).toContain('[ID:1]');
  expect(dom.querySelector("code")?.textContent).toBe("[ID:1]");
  expect(dom.querySelector("pre")?.textContent).toBe("[ID:9]");
  expect(formatHtmlCitations(content, [citation(1), citation(9)])).toBe(content);
});

it("历史 HTML 预览和下载使用所属消息的来源，不改写存储的原附件", async () => {
  const sessionId = createSession("历史引用");
  const messageId = appendMessage({ sessionId, role: "assistant", content: "事实。[ID:1]", citations: { list: [citation(1)] } });
  const artifact = saveArtifact({ messageId, content: document, status: "ready" });
  const params = { params: Promise.resolve({ id: artifact.id }) };
  const response = await download(new Request(`http://localhost/api/chat/artifacts/${artifact.id}?download=1`), params);
  const dom = createDocument(await response.text());
  expect(dom.querySelector("p sup")?.textContent).toBe("1");
  expect(dom.querySelector("p")?.textContent).not.toContain("[ID:");
  const preview = await download(new Request(`http://localhost/api/chat/artifacts/${artifact.id}`), params);
  expect(createDocument((await preview.json()).data.content).querySelector("p sup")?.textContent).toBe("1");
  expect(getArtifact(artifact.id)?.content).toBe(document);
});

beforeEach(() => {
  resetVault(); dropAllIndexTables();
  const provider = { id: "a", label: "A", baseUrl: "http://localhost/v1", apiKey: "fixture-secret", model: "model-a", lightModel: "", supportsStrictSchema: false, reasoningEffort: "max" as const, contextWindow: 100000, temperature: 0.3, headers: {} };
  saveSettings({ providers: [provider, { ...provider, id: "b", label: "B", model: "model-b" }], activeProviderId: "a" });
  writePage("recommend", frontmatterFor("RECOMMEND", "推荐算法", { type: "concept" }), "推荐算法用于预测用户偏好。");
  reindexAll();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("HTML 流分离", () => {
  it("任意分片边界都不会把文件源码漏进正文", () => {
    const output = `简短回答。[ID:1]\n${HTML_START}${document}${HTML_END}`;
    for (let width = 1; width < 30; width++) {
      const stream = new HtmlAnswerStream(); let visible = "";
      for (let at = 0; at < output.length; at += width) visible += stream.push(output.slice(at, at + width));
      visible += stream.finish();
      expect(visible).toBe("简短回答。[ID:1]\n"); expect(stream.html).toBe(document); expect(stream.complete).toBe(true);
    }
  });
  it("兼容模型输出代码围栏和直接 HTML", () => {
    for (const output of [`回答\n\`\`\`html\n${document}\n\`\`\``, `回答\n${document}`]) {
      const stream = new HtmlAnswerStream(); let text = "";
      for (const character of output) text += stream.push(character);
      text += stream.finish(); expect(text).toBe("回答\n"); expect(stream.complete).toBe(true); expect(stream.html).toContain("<html");
    }
  });
  it("未完成边界、超长文件保留已生成内容但不可运行", () => {
    const stream = new HtmlAnswerStream(); stream.push(`回答${HTML_START}<html>未完成`); stream.finish(); expect(stream.complete).toBe(false); expect(stream.text).toBe("回答");
    const large = new HtmlAnswerStream(); large.push(`${HTML_START}${"a".repeat(1_000_001)}${HTML_END}`); expect(large.html.length).toBe(1_000_000); expect(large.complete).toBe(false);
  });
});

it("页面生成期间只返回状态，完成后能预览，文字和历史保持完整", async () => {
  const sessionId = createSession("独立页面");
  const messageId = appendMessage({ sessionId, role: "assistant", content: "预测偏好。[ID:1]", citations: { list: [citation(1)] } });
  const artifact = saveArtifact({ messageId, content: "", status: "pending" });
  const params = { params: Promise.resolve({ id: artifact.id }) };
  const pending = await download(new Request(`http://localhost/api/chat/artifacts/${artifact.id}`), params);
  expect((await pending.json()).data.status).toBe("pending");
  for (const query of ["?preview=1", "?download=1"]) {
    expect((await download(new Request(`http://localhost/api/chat/artifacts/${artifact.id}${query}`), params)).status).toBe(409);
  }
  updateArtifact(artifact.id, document, "ready");
  const ready = await download(new Request(`http://localhost/api/chat/artifacts/${artifact.id}?preview=1`), params);
  expect(ready.status).toBe(200);
  expect(ready.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts;");
  expect(getMessages(sessionId)[0].content).toBe("预测偏好。[ID:1]");
  expect(buildHistory(sessionId).messages.map(message => message.content).join("")).not.toContain("<script>");
});

it("预览限制外部资源、表单和导航，仍保留内联交互", () => {
  const html = previewHtml('<html><head><meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com"><script src="https://example.com/remote.js"></script></head><body><iframe src="https://example.com"></iframe><a href="https://example.com">外链</a><a href="#part">内部</a><script>const x=1;</script></body></html>');
  const dom = createDocument(html);
  expect(dom.head.firstChild?.nodeName).toBe("META"); expect(html).toContain("connect-src 'none'");
  expect(dom.querySelector("iframe,base,script[src],meta[http-equiv=refresh]")).toBeFalsy();
  expect(dom.querySelector("a")?.hasAttribute("href")).toBe(false); expect(dom.querySelector('a[href="#part"]')).not.toBeNull(); expect(html).toContain("const x=1;");
});

it("附件下载与内容一致，随会话回收、恢复和永久删除", async () => {
  const sessionId = createSession("文件生命周期"); const run = beginChatRun(sessionId, "问题", config);
  const artifact = saveArtifact({ messageId: run.assistantMessageId, content: document, status: "ready" });
  const response = await download(new Request(`http://localhost/api/chat/artifacts/${artifact.id}?download=1`), { params: Promise.resolve({ id: artifact.id }) });
  expect(await response.text()).toBe(document); expect(response.headers.get("content-disposition")).toContain("attachment");
  trashSession(sessionId); expect(getArtifact(artifact.id)).toBeNull(); restoreSession(sessionId); expect(getArtifact(artifact.id)).not.toBeNull();
  permanentlyDeleteSession(sessionId); expect(getArtifact(artifact.id)).toBeNull();
});

it("会话选择分别保存，任务冻结选择且全局配置不变", async () => {
  const a = createSession("A"), b = createSession("B");
  saveSessionConfig(a, config); saveSessionConfig(b, { ...config, providerId: "b", model: "model-b", showMe: false });
  const run = beginChatRun(a, "问题", config); saveSessionConfig(a, { ...config, reasoningEffort: "high" });
  expect(getChatRun(run.id)?.config).toEqual(config); expect(getSession(b)?.config?.model).toBe("model-b"); expect(getSettings().providers[0].reasoningEffort).toBe("max");
  expect(() => resolveChatConfig({ ...config, providerId: "missing" })).toThrow("已移除");
});

it("服务默认不发送推理参数，所选服务的密钥不会出现在会话响应里", async () => {
  vi.stubGlobal("fetch", async (_url: string, input: RequestInit) => {
    const body = JSON.parse(String(input.body)); expect(body.model).toBe("other-model"); expect(body).not.toHaveProperty("reasoning_effort");
    return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
  });
  await chatProvider({ ...config, model: "other-model", reasoningEffort: "default" }).complete({ messages: [{ role: "user", content: "test" }] });
  const sessionId = createSession("配置接口");
  const response = await patchSession(new NextRequest("http://localhost/api/chat/sessions/x", { method: "PATCH", body: JSON.stringify({ config }) }), { params: Promise.resolve({ id: sessionId }) });
  expect(response.status).toBe(200); expect(await response.text()).not.toContain("fixture-secret");
  expect(reasoningCapability("https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3-pro").efforts).not.toContain("none");
});

it("空库 HTML 回答不调用模型，文件与任务计时可恢复", async () => {
  resetVault(); dropAllIndexTables();
  const sessionId = createSession("空库"), run = beginChatRun(sessionId, "问题", config);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await runChatRun({ run, question: "问题", controller: registerStream(sessionId, run.id, run.assistantMessageId) });
  expect(fetch).not.toHaveBeenCalled(); expect(getChatRun(run.id)?.artifacts[0].status).toBe("basic"); expect(getChatRun(run.id)?.status).toBe("done");
});
