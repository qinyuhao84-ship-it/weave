import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropAllIndexTables } from "@/lib/db/client";
import { getSqlite } from "@/lib/db/client";
import { OpenAiCompatibleProvider } from "@/lib/llm/provider";
import { FakeProvider } from "@/lib/llm/fake";
import { LlmError } from "@/lib/llm/types";
import { runChatRun } from "@/lib/chat/run";
import { compressHistory, resetCompressionCooldown } from "@/lib/chat/compress";
import * as sessions from "@/lib/chat/sessions";
import * as configServer from "@/lib/chat/config-server";
import * as answerModule from "@/lib/chat/answer";
import * as retrieval from "@/lib/chat/retrieve";
import { isStreaming, registerStream, subscribeChatRun } from "@/lib/chat/streams";
import { reindexAll } from "@/lib/index/reindex";
import { resetVault, writePage, frontmatterFor } from "./helpers";
import type { ChatConfig } from "@/lib/chat/config";

const config: ChatConfig = { providerId: "fixture", model: "fixture", reasoningEffort: "default", contextWindow: 32768, showMe: false };
const event = (content: string, finishReason: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\n`;

beforeEach(() => {
  resetVault(); dropAllIndexTables(); resetCompressionCooldown();
  writePage("recommend", frontmatterFor("RECOMMEND", "推荐算法"), "推荐算法用于预测用户偏好。");
  reindexAll();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function runResponse(body: string) {
  vi.stubGlobal("fetch", async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  const provider = new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:1", apiKey: "", model: "fixture" });
  vi.spyOn(configServer, "chatProvider").mockReturnValue(provider);
  const sessionId = sessions.createSession("终态验证");
  const run = sessions.beginChatRun(sessionId, "推荐算法", config);
  const controller = registerStream(sessionId, run.id, run.assistantMessageId);
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  subscribeChatRun(run.id, entry => events.push(entry));
  await runChatRun({ run, question: "推荐算法", controller });
  return { sessionId, run, events, saved: sessions.getMessages(sessionId).find(message => message.id === run.assistantMessageId)! };
}

describe("模型流的完成边界", () => {
  it.each([
    ["静默 EOF", event("部分正文。[ID:1] 虚构[ID:999]")],
    ["输出上限", event("部分正文。[ID:1]", "length") + "data: [DONE]\n\n"],
    ["服务中止", event("部分正文。[ID:1]", "content_filter") + "data: [DONE]\n\n"],
    ["空正文", event("  ", "stop") + "data: [DONE]\n\n"],
    ["仅 DONE 没有完成原因", event("部分正文。[ID:1]") + "data: [DONE]\n\n"],
    ["中途坏 JSON", event("部分正文。[ID:1]") + "data: {broken-json}\n\n" + event("后半段", "stop")],
  ])("%s 保存已有内容、失败终态且不进入后续上下文", async (_name, body) => {
    const { sessionId, run, events, saved } = await runResponse(body);
    expect(sessions.getChatRun(run.id)?.status).toBe("failed");
    expect(saved.content).not.toContain("[ID:999]");
    if (body.includes("部分正文")) expect(saved.content).toContain("部分正文");
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(entry => entry.type === "done")).toBe(false);
    expect(sessions.buildHistory(sessionId).messages.some(message => message.role === "assistant")).toBe(false);
    expect(isStreaming(sessionId)).toBe(false);
  });

  it.each(["", "data: [DONE]\n\n"])("明确 stop 后成功，DONE 尾帧可选：%j", async tail => {
    const { sessionId, run, events, saved } = await runResponse(event("完整回答。[ID:1]", "stop") + tail);
    expect(sessions.getChatRun(run.id)?.status).toBe("done");
    expect(saved.content).toContain("完整回答");
    expect(events.at(-1)?.type).toBe("done");
    expect(sessions.buildHistory(sessionId).messages.at(-1)?.role).toBe("assistant");
  });
});

it("检索期间停止也标记为取消，不留下运行中的任务或失败提示", async () => {
  vi.spyOn(retrieval, "retrieveHybrid").mockImplementation(async (_question, options) => {
    await new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
    return [];
  });
  const provider = new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:1", apiKey: "", model: "fixture" });
  vi.spyOn(configServer, "chatProvider").mockReturnValue(provider);
  const sessionId = sessions.createSession("检索中停止"), run = sessions.beginChatRun(sessionId, "推荐算法", config);
  const controller = registerStream(sessionId, run.id, run.assistantMessageId);
  const pending = runChatRun({ run, question: "推荐算法", controller });
  controller.abort(); await pending;
  expect(sessions.getChatRun(run.id)?.status).toBe("cancelled");
  expect(isStreaming(sessionId)).toBe(false);
});

it("保存与终态写入同时失败时，仍结束订阅并逐项记录恢复错误", async () => {
  const sessionId = sessions.createSession("收尾故障"), run = sessions.beginChatRun(sessionId, "推荐算法", config);
  const controller = registerStream(sessionId, run.id, run.assistantMessageId);
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  subscribeChatRun(run.id, entry => events.push(entry));
  const original = new LlmError("模型连接中断。", 502);
  const saveFailure = new Error("database write failed");
  vi.spyOn(answerModule, "answer").mockImplementation(async options => {
    options.onDelta?.("部分正文"); throw original;
  });
  const progress = vi.spyOn(sessions, "saveChatRunProgress").mockImplementationOnce(() => {}).mockImplementation(() => { throw saveFailure; });
  const finish = vi.spyOn(sessions, "finishChatRun").mockImplementation(() => { throw new Error("terminal write failed"); });
  vi.spyOn(sessions, "resetPendingSessionTitleSummary").mockImplementation(() => { throw new Error("title write failed"); });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(runChatRun({ run, question: "推荐算法", controller })).resolves.toBeUndefined();
  expect(progress).toHaveBeenCalledTimes(2); expect(finish).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("部分状态未能保存") });
  const aggregate = logged.mock.calls.find(([, detail]) => detail instanceof AggregateError)?.[1] as AggregateError;
  expect(aggregate.errors).toEqual(expect.arrayContaining([original, saveFailure]));
  expect(isStreaming(sessionId)).toBe(false);
});

it("旧版停止消息和失败摘要保持可查看，后续模型只使用完整内容", async () => {
  const sessionId = sessions.createSession("摘要边界");
  const run = sessions.beginChatRun(sessionId, "请介绍推荐算法", config);
  sessions.saveChatRunProgress(run.id, "半截断言不能作为事实");
  sessions.finishChatRun(run.id, "failed", "断线");
  sessions.writeSummary({ sessionId, content: "污染摘要不能再发送给模型", coveredToMessageId: run.assistantMessageId, coveredMessageCount: 40, compressionCount: 1, tokenCount: 20, model: "fixture" });
  // 模拟升级前已落库的摘要：迁移会为它填入 legacy，而不是假定内容来源安全。
  getSqlite().prepare("UPDATE chat_summaries SET history_policy = 'legacy' WHERE session_id = ?").run(sessionId);
  const legacyStopped = sessions.appendMessage({ sessionId, role: "assistant", content: "旧版半截答案", interrupted: true });
  for (let index = 0; index < 10; index++) sessions.appendMessage({ sessionId, role: index % 2 === 0 ? "user" : "assistant", content: "完整历史内容涉及推荐算法与用户偏好。".repeat(20) });
  const history = sessions.buildHistory(sessionId);
  expect(history.summary).toBeNull();
  expect(history.messages.some(message => message.id === run.assistantMessageId || message.id === legacyStopped)).toBe(false);
  expect(sessions.getMessages(sessionId).find(message => message.id === legacyStopped)?.content).toBe("旧版半截答案");
  expect(sessions.readSummary(sessionId)?.content).toBe("污染摘要不能再发送给模型");
  const provider = new FakeProvider({ responses: ["用户讨论推荐算法与偏好预测，已有完整回答解释相关概念，并希望继续学习。"] });
  const result = await compressHistory({ sessionId, history, provider, keepRecent: 2 });
  expect(result.status).toBe("compressed");
  expect(provider.lastMessages[0].content).not.toContain("污染摘要");
  expect(provider.lastMessages[0].content).not.toContain("半截");
  expect(result.history.summary?.content).toContain("推荐算法");
  expect(sessions.readSummary(sessionId)?.historyPolicy).toBe("complete");
  expect(sessions.buildHistory(sessionId).summary?.content).toContain("推荐算法");
});

it("运行中的助手正文退出上下文，旧版完整消息仍保留", () => {
  const sessionId = sessions.createSession("历史兼容");
  const oldId = sessions.appendMessage({ sessionId, role: "assistant", content: "旧版完整回答" });
  const run = sessions.beginChatRun(sessionId, "推荐算法", config);
  sessions.saveChatRunProgress(run.id, "仍在生成的答案");
  const history = sessions.buildHistory(sessionId);
  expect(history.messages.some(message => message.id === oldId)).toBe(true);
  expect(history.messages.some(message => message.id === run.assistantMessageId)).toBe(false);
});
