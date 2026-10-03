import { toUserMessage } from "@/lib/api";
import { answer, emptyKnowledgeBaseAnswer } from "@/lib/chat/answer";
import { usageWithoutRetrieval } from "@/lib/chat/context";
import {
  finishChatRun,
  resetPendingSessionTitleSummary,
  saveChatRunProgress,
  updateAssistantMessage,
  type ChatRunView,
  saveChatTimings,
} from "@/lib/chat/sessions";
import { summarizePendingSessionTitle } from "@/lib/chat/session-title";
import { clearStream, publishChatRun } from "@/lib/chat/streams";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pages } from "@/lib/db/schema";
import { basicHtml, saveArtifact } from "./artifacts";
import { validateCitations } from "./citations";

/** 服务端持有整轮问答；客户端断开 SSE 只会取消订阅，不会取消模型请求。 */
export async function runChatRun(input: {
  run: ChatRunView;
  question: string;
  controller: AbortController;
}): Promise<void> {
  const { run, question, controller } = input;
  let accumulated = "";
  let lastSavedAt = 0;
  let shouldGenerateTitle = false;

  try {
    controller.signal.throwIfAborted();
    if (!getDb().select({ id: pages.id }).from(pages).where(eq(pages.status, "active")).limit(1).get()) {
      const text = emptyKnowledgeBaseAnswer();
      const quality = {
        citationCount: 0,
        hallucinationCount: 0,
        hallucinationRate: 0,
        hasNoCitations: true,
        isNoAnswer: true,
      };
      const context = usageWithoutRetrieval({
        sessionId: run.sessionId,
        question,
        excludeMessageId: run.questionMessageId,
        maxTokens: run.config?.contextWindow,
      });
      accumulated = text;
      const artifacts = run.config?.showMe ? [saveArtifact({ messageId: run.assistantMessageId, content: basicHtml(text), status: "basic" })] : [];
      updateAssistantMessage({
        messageId: run.assistantMessageId,
        content: text,
        citations: { list: [], quality, hallucinated: [] },
        context,
      });
      finishChatRun(run.id, "done");
      publishChatRun(run.id, {
        type: "done",
        runId: run.id,
        sessionId: run.sessionId,
        messageId: run.assistantMessageId,
        text,
        citations: [],
        quality,
        context,
        interrupted: false,
        artifacts,
      });
      shouldGenerateTitle = true;
      return;
    }

    const result = await answer({
      sessionId: run.sessionId,
      question,
      questionMessageId: run.questionMessageId,
      assistantMessageId: run.assistantMessageId,
      signal: controller.signal,
      ...(run.config ? { config: run.config } : {}),
      onTimings: timings => {
        saveChatTimings(run.id, timings);
        publishChatRun(run.id, { type: "timings", timings });
      },
      onDelta: (text) => {
        accumulated += text;
        publishChatRun(run.id, { type: "delta", text });
        if (Date.now() - lastSavedAt >= 500) {
          lastSavedAt = Date.now();
          saveChatRunProgress(run.id, accumulated);
        }
      },
      onRetrieved: (pages) => publishChatRun(run.id, {
        type: "retrieved",
        pages: pages.map((page) => ({
          pageId: page.pageId,
          title: page.title,
          type: page.type,
          matchedBy: page.matchedBy,
        })),
      }),
      onCompressing: (notice) => publishChatRun(run.id, { type: "compressing", notice }),
      onProgress: (progress) => publishChatRun(run.id, { type: "progress", progress }),
    });

    const status = result.interrupted ? "cancelled" : "done";
    finishChatRun(run.id, status);
    publishChatRun(run.id, {
      type: "citations",
      citations: result.citations,
      quality: result.quality,
      process: result.process,
    });
    publishChatRun(run.id, {
      type: "done",
      runId: run.id,
      sessionId: run.sessionId,
      messageId: result.messageId,
      text: result.text,
      citations: result.citations,
      quality: result.quality,
      context: result.context,
      compression: result.compression,
      process: result.process,
      interrupted: result.interrupted,
      artifacts: result.artifacts,
      timings: result.timings,
    });
    shouldGenerateTitle = !result.interrupted;
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = cancelled ? "这次回答已停止，生成的部分内容已保留。" : toUserMessage(error).message;
    const failures: unknown[] = [];
    // SQLite 故障可能同时打断主流程与收尾；逐项尝试，仍然通知订阅者结束等待。
    if (accumulated) {
      try { saveChatRunProgress(run.id, accumulated); } catch (failure) { failures.push(failure); }
    }
    try { finishChatRun(run.id, cancelled ? "cancelled" : "failed", cancelled ? null : message); }
    catch (failure) { failures.push(failure); }
    if (failures.length) console.error("[chat] 回答失败且部分状态未能保存，重启时将恢复终态：", new AggregateError([error, ...failures]));
    if (cancelled && failures.length === 0) publishChatRun(run.id, {
      type: "done", runId: run.id, sessionId: run.sessionId,
      messageId: run.assistantMessageId, text: validateCitations(accumulated, []).text, citations: [], interrupted: true,
    });
    else publishChatRun(run.id, { type: "error", runId: run.id, message: failures.length ? `${message} 部分状态未能保存，请重启应用后检查。` : message });
  } finally {
    clearStream(run.sessionId, controller);
    if (shouldGenerateTitle) {
      try {
        await summarizePendingSessionTitle(run.sessionId);
      } catch (error) {
        console.error("[chat] AI 会话名称生成失败，保留现有标题：", error);
      }
    } else {
      try { resetPendingSessionTitleSummary(run.sessionId); }
      catch (error) { console.error("[chat] 未能重置会话标题状态，重启时将恢复：", error); }
    }
  }
}
