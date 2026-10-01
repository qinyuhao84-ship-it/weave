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
    const { message } = toUserMessage(error);
    if (accumulated) saveChatRunProgress(run.id, accumulated);
    finishChatRun(run.id, "failed", message);
    publishChatRun(run.id, { type: "error", runId: run.id, message });
  } finally {
    clearStream(run.sessionId, controller);
    if (shouldGenerateTitle) {
      try {
        await summarizePendingSessionTitle(run.sessionId);
      } catch (error) {
        console.error("[chat] AI 会话名称生成失败，保留现有标题：", error);
      }
    } else {
      resetPendingSessionTitleSummary(run.sessionId);
    }
  }
}
