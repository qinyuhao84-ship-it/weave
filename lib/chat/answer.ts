import { createProvider, createLightProvider } from "@/lib/llm";
import { getSettings, getContextWindow } from "@/lib/settings";
import { buildContextBlock, NO_ANSWER_PHRASE } from "@/lib/llm/prompts";
import { LlmError, type ChatMessage, type LlmProvider } from "@/lib/llm/types";
import { retrieveHybrid, toContextChunks, type RetrievedPage } from "./retrieve";
import {
  validateCitations, buildCitationViews, assessQuality,
  type CitationView, type AnswerQuality,
} from "./citations";
import { appendMessage, updateAssistantMessage, buildHistory, type ChatHistory } from "./sessions";
import {
  assembleContext, needsCompression, retrievalCharBudget, largestBucket,
  applyMeasuredTokens, chatSystemPrompt, ContextOverflowError,
  type ContextUsage, type AssembledContext,
} from "./context";
import { compressHistory } from "./compress";
import type { ChatProgress } from "./progress";
import type { ChatConfig, ChatTimings, ChatArtifact } from "./config";
import { chatProvider } from "./config-server";
import { queueAnswerArtifact } from "./artifact-generation";

/**
 * 问答流程。
 *
 * 分层很清楚：
 *   检索 → 组装上下文（编号化）→ 必要时压缩历史 → 流式生成 → 后端校验引用 → 落库
 *
 * 关键设计是「生成与校验解耦」：模型只负责写编号，原文与可点击的角标
 * 全部由后端补齐和校验。这样引用错了是后端的锅，能修；而让模型自己
 * 生成"原文片段"则无法修复 —— 它会编出看起来极其合理的引文。
 *
 * 「压缩」这一步放在检索之后、生成之前：判定要算上本轮的检索块
 * （它常常是 prompt 里最大的一块），而检索块只有检索跑完才知道有多大。
 */

/** 压缩过程的进度通知，route 层负责推成 SSE 事件 */
export type CompressionNotice =
  | { phase: "started"; usedTokens: number; maxTokens: number }
  | { phase: "compressed"; compressedMessages: number; summaryTokens: number; model: string }
  /** 压不动或没必要压：历史太短、刚失败过还在冷却 */
  | { phase: "skipped"; reason: string }
  /** 摘要失败，已降级；reason 是给用户看的中文说明 */
  | { phase: "failed"; reason: string }
  /**
   * 摘要之外还硬丢了消息，属于真正的信息损失，必须让用户看见。
   * reason 是紧挨着它的那次压缩结论的说明（若有）—— 「压不动」和「压完还是超」
   * 是两件事，只显示后一件会让用户以为压缩压根没跑过。
   */
  | { phase: "truncated"; droppedMessages: number; reason: string | null };

export type AnswerOptions = {
  sessionId: string;
  question: string;
  /**
   * 本轮用户消息在库里的 id。
   *
   * route 在调用 answer 之前已经把这条消息落库了，所以组装历史时要把它排除掉，
   * 否则同一个问题会出现两次（一次在历史里、一次在最后）。
   * 按 id 排除而不是按内容比较：同一句话被问两遍、或两条消息落在同一秒时，
   * 内容比较会认错对象。
   */
  questionMessageId?: string;
  /** 当前轮的助手占位消息；存在时用最终答案更新原消息以保持 UI 节点稳定。 */
  assistantMessageId?: string;
  provider?: LlmProvider;
  signal?: AbortSignal;
  /** 每个文本增量都会回调，用于 SSE 推送 */
  onDelta?: (text: string) => void;
  /** 检索完成时回调，让前端先展示"找到了哪些词条" */
  onRetrieved?: (pages: RetrievedPage[]) => void;
  /** 上下文压缩的进度回调 */
  onCompressing?: (notice: CompressionNotice) => void;
  onProgress?: (progress: ChatProgress) => void;
  config?: ChatConfig;
  onTimings?: (timings: ChatTimings) => void;
};

export type AnswerResult = {
  messageId: string;
  /**
   * 这轮回答被用户中途停掉了（点「停止」，或者关掉页面断了连接）。
   *
   * 中止**不是失败**：已经生成的那部分照常落库，引用照常校验，只是标记出来。
   * 不这么做的话，刷新页面后这条回答会凭空消失，而屏幕上明明还留着半截文字 ——
   * 用户会以为自己的问题从来没被回答过。
   */
  interrupted: boolean;
  /** 校验并净化后的答案正文（引用已归一为 [ID:n]） */
  text: string;
  citations: CitationView[];
  quality: AnswerQuality;
  retrieved: Array<{ pageId: string; title: string; type: string; matchedBy: string }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  /** 本轮请求在上下文窗口里的占用，前端据此显示百分比 */
  context: ContextUsage;
  /** 本轮压缩做了什么；没触发压缩时为 null */
  compression: CompressionNotice | null;
  process: ChatProgress[];
  artifacts: ChatArtifact[];
  timings: ChatTimings;
};

export async function answer(options: AnswerOptions): Promise<AnswerResult> {
  const startedAt = Date.now();
  const timings: ChatTimings = {};
  const process: ChatProgress[] = [];
  const progress = (entry: Omit<ChatProgress, "elapsedMs">) => {
    const event = { ...entry, elapsedMs: Date.now() - startedAt };
    process.push(event); options.onProgress?.(event);
  };
  const settings = getSettings();
  const provider = options.provider ?? (options.config ? chatProvider(options.config) : createProvider());
  const maxTokens = options.config?.contextWindow ?? getContextWindow();
  const summaryProvider = options.provider ?? (options.config ? chatProvider(options.config, true) : resolveSummaryProvider());

  // ---- ① 检索 ----
  // 检索块的上限由窗口派生，不能让一个与模型无关的常量把小窗口的模型第一轮就撑爆
  const retrieved = await retrieveHybrid(options.question, {
    limit: settings.retrievalLimit,
    charBudget: retrievalCharBudget(maxTokens),
    onProgress: progress,
    signal: options.signal,
    config: settings.retrievalModel,
  });
  options.onRetrieved?.(retrieved);
  // 编号 = 位置（1-based），检索、组装、引用校验三处共用同一份，不能各算各的
  const chunks = toContextChunks(retrieved);
  const contextBlock = buildContextBlock(chunks);

  // ---- ② 组装 ----
  // 系统提示词从 context.ts 拿，别在这儿再拼一遍 —— 会话占用与空库占用走的是
  // 同一个函数，三处只留一份实现
  const systemPrompt = chatSystemPrompt(settings);

  let history = buildHistory(options.sessionId, {
    ...(options.questionMessageId ? { excludeMessageId: options.questionMessageId } : {}),
    ...(options.assistantMessageId ? { excludeMessageIds: [options.assistantMessageId] } : {}),
    question: options.question,
  });

  const build = (candidate: ChatHistory): AssembledContext =>
    assembleContext({ systemPrompt, history: candidate, contextBlock, question: options.question, maxTokens });

  let assembled = build(history);
  timings.preparedMs = Date.now() - startedAt;
  progress({ stage: "context", label: `上下文准备完成 · ${retrieved.length} 个词条 · 约 ${assembled.usage.usedTokens.toLocaleString("zh-CN")} tokens` });
  let compression: CompressionNotice | null = null;

  // ---- ③ 上下文压缩 ----
  if (needsCompression(assembled.usage.usedTokens, maxTokens)) {
    const compressionStartedAt = Date.now();
    progress({ stage: "compressing", label: "正在压缩较早的对话，保留本轮检索资料" });
    options.onCompressing?.({
      phase: "started",
      usedTokens: assembled.usage.usedTokens,
      maxTokens,
    });

    const outcome = await compressHistory({
      sessionId: options.sessionId,
      history,
      provider: summaryProvider,
      ...(options.signal ? { signal: options.signal } : {}),
      // 成功路径会重新从库里读历史，排除项必须和上面那次组装完全一致
      ...(options.questionMessageId ? { excludeMessageId: options.questionMessageId } : {}),
      ...(options.assistantMessageId ? { excludeMessageIds: [options.assistantMessageId] } : {}),
      question: options.question,
    });

    // 记下压缩这一步的结论。截断兜底若发生，会把它的原因一并带出去。
    let previous: CompressionNotice | null = null;

    if (outcome.status === "compressed") {
      history = outcome.history;
      assembled = build(history);
      compression = {
        phase: "compressed",
        compressedMessages: outcome.compressedMessages,
        summaryTokens: outcome.summaryTokens,
        model: outcome.model,
      };
    } else {
      compression = outcome.status === "skipped"
        ? { phase: "skipped", reason: outcome.reason }
        : { phase: "failed", reason: outcome.reason };
      previous = compression;
    }

    // 结论必须推出去。只推 started 的话，前端会永远停在「正在压缩历史…」——
    // 用户看不到压缩到底成没成、压掉了多少。
    options.onCompressing?.(compression);

    // 压完（或压不成）仍然**超出窗口硬上限** → 硬截断兜底。
    // 这是真正的信息损失，所以结果会被带进 context.droppedMessages 显示给用户。
    //
    // 判据是「超出窗口」而不是「超过压缩线」：85% 只是「该压缩了」的信号，
    // 不是「必须丢消息」的理由。按 85% 截断会把本来能完整发出去的历史丢掉 ——
    // 窗口 8000、实际占 6900 的一轮，历史会被清空，用户还被告知
    // 「为了塞进窗口，已丢弃最早的 3 条对话」。下面那句 ContextOverflowError
    // 用的也是同一个判据，两处必须一致。
    if (assembled.usage.usedTokens > maxTokens) {
      const fitted = fitHistoryToBudget(history, build, maxTokens);
      if (fitted.dropped > 0) {
        history = fitted.history;
        // 丢掉几条是组装算不出来的（它是这次截断的结果），在这里补进 usage，
        // 否则 context.droppedMessages 会一直是 0 —— 那条「必须显示给用户」的
        // 信息渠道等于不存在
        assembled = {
          ...fitted.assembled,
          usage: { ...fitted.assembled.usage, droppedMessages: fitted.dropped },
        };
        compression = { phase: "truncated", droppedMessages: fitted.dropped, reason: previous?.reason ?? null };
        options.onCompressing?.(compression);
      }
    }
    timings.compressionMs = Date.now() - compressionStartedAt;
  }

  // 仍然超出窗口的硬上限 —— 发出去必然被端点拒绝。
  // 与其让用户看到一句英文的 context_length_exceeded，不如在这儿给出可操作的中文说明。
  if (assembled.usage.usedTokens > maxTokens) {
    throw new ContextOverflowError(
      assembled.usage.usedTokens,
      maxTokens,
      largestBucket(assembled.usage.breakdown),
    );
  }

  // ---- ④ 流式生成 ----
  let raw = "";
  let usage: AnswerResult["usage"] = null;
  let interrupted = false;
  let streamFailure: unknown;
  let truncated = false;
  timings.requestedMs = Date.now() - startedAt;

  const iterator = provider.stream({
    messages: assembled.messages as ChatMessage[],
    sessionId: options.sessionId,
    onReasoningDelta: () => {
      if (timings.firstReasoningMs === undefined) { timings.firstReasoningMs = Date.now() - startedAt; options.onTimings?.({ ...timings }); }
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  progress({ stage: "generating", label: "资料已发送 · 等待模型开始回答" });

  try {
    let step = await iterator.next();
    while (!step.done) {
      if (timings.firstTextMs === undefined) { timings.firstTextMs = Date.now() - startedAt; options.onTimings?.({ ...timings }); }
      const delta = step.value;
      raw += delta;
      if (delta) options.onDelta?.(delta);
      step = await iterator.next();
    }
    truncated = Boolean(step.value?.truncated);
    if (step.value?.usage) {
      usage = {
        promptTokens: step.value.usage.promptTokens,
        completionTokens: step.value.usage.completionTokens,
        totalTokens: step.value.usage.totalTokens,
      };
    }
  } catch (error) {
    // 中止不是失败，但它会以失败的样子到来：fetch 被掐断时抛的是一个
    // AbortError，而 provider 会把它包成 LlmError（见 lib/llm/provider.ts）。
    // 所以判据不看错误类型，看**信号本身**——是它被 abort 了，才说明这是
    // 我们（或框架）主动叫停的，而不是端点真的出了问题。
    if (!options.signal?.aborted) streamFailure = error;
    else interrupted = true;
  }
  if (!interrupted && !streamFailure) {
    if (truncated) streamFailure = new LlmError("回答达到模型的输出上限，内容尚未完成。已保留生成的部分内容，可以缩小问题范围后重试。", 502);
    else if (!raw.trim()) streamFailure = new LlmError("模型没有返回回答正文。请重试或检查所选模型。", 502, true);
  }
  timings.generatedMs = Date.now() - startedAt;

  // ---- ⑤ 后端校验引用 ----
  progress({ stage: "validating", label: interrupted ? "已停止生成 · 校验已有内容的引用" : "生成完成 · 正在校验引用和保存回答" });
  const report = validateCitations(raw, chunks);
  const citations = buildCitationViews(
    report.usedIndices,
    chunks,
    retrieved.map((page) => page.pageId),
  );
  const quality = assessQuality(report);

  if (quality.hallucinationCount > 0) {
    console.warn(
      `[chat] 检测到 ${quality.hallucinationCount} 处越界引用（占 ${(quality.hallucinationRate * 100).toFixed(1)}%），已剔除：`,
      report.hallucinatedIndices,
    );
  }

  // 展示给前端的占用：有实测值就用实测值，没有就用刚才那轮组装时的估算。
  // droppedMessages 由上面的截断分支写进 assembled.usage，applyMeasuredTokens
  // 会连同其余字段一起带出来（早先这里是个恒等的展开，看起来在转发、其实什么都没做）。
  const context = applyMeasuredTokens(assembled.usage, usage?.promptTokens ?? null);

  // ---- ⑥ 落库 ----
  const messageData = {
    content: report.text,
    // 停掉的那一轮也要落库 —— 哪怕一个字都没生成出来。空回答配上这个标记，
    // 界面上就是一行「已停止生成」，那正是实际发生过的事。
    citations: {
      list: citations,
      quality,
      hallucinated: report.hallucinatedIndices,
      process,
    },
    context: retrieved.map((page) => ({
      pageId: page.pageId,
      title: page.title,
      matchedBy: page.matchedBy,
      score: Number(page.score.toFixed(3)),
    })),
    // 记下这一轮真实的输入用量。刷新页面后前端要靠它把百分比复原 ——
    // 检索到的正文没有落库，事后重建不出这个数。
    ...(usage ? { promptTokens: usage.promptTokens } : {}),
    // 硬丢弃的条数同理：那一轮丢了没有、丢了几条，是历史事实，事后重算不出来
    droppedMessages: assembled.usage.droppedMessages,
    ...(interrupted ? { interrupted: true } : {}),
  };
  const messageId = options.assistantMessageId
    ? (updateAssistantMessage({ messageId: options.assistantMessageId, ...messageData }), options.assistantMessageId)
    : appendMessage({ sessionId: options.sessionId, role: "assistant", ...messageData });

  const artifacts: ChatArtifact[] = [];
  timings.savedMs = Date.now() - startedAt;
  if (usage) { timings.promptTokens = usage.promptTokens; timings.completionTokens = usage.completionTokens; }
  options.onTimings?.({ ...timings });
  if (streamFailure) throw streamFailure;
  if (options.config?.showMe && !interrupted) {
    artifacts.push(queueAnswerArtifact({ sessionId: options.sessionId, messageId, question: options.question, text: report.text, chunks, citations, config: options.config }, options.provider));
  }

  return {
    messageId,
    interrupted,
    text: report.text,
    citations,
    quality,
    retrieved: retrieved.map((page) => ({
      pageId: page.pageId,
      title: page.title,
      type: page.type,
      matchedBy: page.matchedBy,
    })),
    usage,
    context,
    compression,
    process,
    artifacts, timings,
  };
}

/**
 * 摘要用哪个 provider。
 *
 * 调用方显式注入了 provider（测试、冒烟脚本）就用它 —— 那时"轻量模型"这个概念
 * 不存在，注入什么就用什么。否则走 createLightProvider（低思考档的便宜模型）。
 * 这里兜一层 try：模型没配好时不该让压缩把整个问答带崩，退回主力 provider 就是。
 */
function resolveSummaryProvider(injected?: LlmProvider): LlmProvider | undefined {
  if (injected) return injected;
  try {
    return createLightProvider();
  } catch {
    return undefined;
  }
}

/**
 * 丢掉最旧的历史消息，直到请求真的能塞进窗口。
 *
 * 目标是**窗口的硬上限**，不是压缩线 —— 只丢到「不超窗口」为止，
 * 能完整发出去的历史一条都不该动（早先按 85% 截，把本可保留的消息也丢了）。
 *
 * 一次丢一对（一问一答）而不是一条：剩下的历史若以助手的回答开头，
 * 读起来像是模型在自己接自己的话。
 *
 * 注意这会**真的丢内容** —— 被丢掉的消息不在摘要里。所以调用方必须把
 * dropped 的数量上报出去，不能让用户以为对话还完整。
 */
function fitHistoryToBudget(
  history: ChatHistory,
  build: (candidate: ChatHistory) => AssembledContext,
  maxTokens: number,
): { history: ChatHistory; assembled: AssembledContext; dropped: number } {
  let messages = history.messages;
  let dropped = 0;
  let assembled = build(history);

  while (assembled.usage.usedTokens > maxTokens && messages.length > 0) {
    const step = messages[0].role === "user" && messages[1]?.role === "assistant" ? 2 : 1;
    messages = messages.slice(step);
    dropped += step;
    assembled = build({ ...history, messages });
  }

  return { history: { ...history, messages }, assembled, dropped };
}

/**
 * 知识库为空时的快捷回答。
 * 不调模型 —— 没有语料时任何生成都是纯粹的编造。
 */
export function emptyKnowledgeBaseAnswer(): string {
  return `${NO_ANSWER_PHRASE}知识库里还没有任何词条。先导入一份资料，让模型把它编译成互相链接的知识，再来提问。`;
}

export { NO_ANSWER_PHRASE };
