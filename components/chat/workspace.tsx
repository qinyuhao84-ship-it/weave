"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Send, Trash2, BookMarked, X, Quote, AlertTriangle, CircleStop,
} from "lucide-react";
import { useAppData } from "@/components/app-provider";
import { useIngest } from "@/components/ingest/ingest-provider";
import {
  Button, Badge, TypeBadge, Card, Textarea, Hairline, AiWorkingFrame, ProgressRing,
} from "@/components/ui";
import { COMPRESS_THRESHOLD, CONTEXT_WARN_THRESHOLD } from "@/lib/chat/tokens";
import { apiFetch } from "@/hooks/use-api";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { stripWikilinks } from "@/lib/vault/wikilinks";
import { cn } from "@/lib/utils";
import type { ChatProgress } from "@/lib/chat/progress";
import { restoreChatConfig, type ChatConfig, type ChatArtifact } from "@/lib/chat/config";
import type { PublicSettings } from "@/lib/settings";
import { ChatControls } from "./chat-controls";
import { WeaveMark } from "@/components/ui/weave-mark";

/**
 * 对话界面。
 *
 * 三件事让这里的体验区别于普通聊天框：
 *   1. 等待时是边框扫光（不是 spinner）—— 与本产品的设计语言一致
 *   2. 流式逐字入场，每个消息块 6px 上浮
 *   3. 引用角标可查看检索到的词条片段及关联原始资料
 */

import type { Citation, Quality, Message } from "./types";
import { MessageBubble } from "./message-bubble";
import { AnswerFilingDialog } from "./answer-filing-dialog";

type ActiveRun = {
  id: string;
  sessionId: string;
  questionMessageId: string;
  assistantMessageId: string;
  status: "running" | "done" | "failed" | "cancelled";
  error?: string | null;
  text?: string;
  citations?: unknown;
  createdAt?: string;
  config?: ChatConfig | null;
};

/** 与 lib/chat/context.ts 的 ContextUsage 对应。前端只渲染，不做算术。 */
type ContextUsage = {
  usedTokens: number;
  maxTokens: number;
  ratio: number;
  breakdown: { system: number; summary: number; history: number; context: number; question: number };
  historyMessages: number;
  summarizedMessages: number;
  compressionCount: number;
  droppedMessages: number;
  /** false 表示这个数是估算的，界面要换措辞 */
  measured: boolean;
};

/** 与 lib/chat/answer.ts 的 CompressionNotice 对应 */
type CompressionNotice =
  | { phase: "started"; usedTokens: number; maxTokens: number }
  | { phase: "compressed"; compressedMessages: number; summaryTokens: number; model: string }
  | { phase: "skipped"; reason: string }
  | { phase: "failed"; reason: string }
  | { phase: "truncated"; droppedMessages: number; reason: string | null };

/**
 * 占用百分比（整数，**不封顶**）。
 *
 * 真实占用可以超过窗口（检索块太大、窗口配小了），那时如实显示 133% 而不是
 * 悄悄截成 100% —— 用户正是要靠这个数字知道「该调设置了」。
 * 分母为 0 时返回 0，不让 NaN 漏到界面上。
 */
function contextPercent(usage: ContextUsage): number {
  if (usage.maxTokens <= 0) return 0;
  return Math.max(0, Math.round(usage.ratio * 100));
}

/** 画环用的百分比：几何上封顶 100，环画到 133% 没有意义 */
function ringPercent(usage: ContextUsage): number {
  return Math.min(100, contextPercent(usage));
}

/** 紧凑的 token 数：「1.2M」「55.4k」「820」 */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * 占用率对应的配色。
 *
 * 刻意不用蓝色 —— 蓝色在这个设计系统里是留给焦点环与「AI 正在工作」的，
 * 占用率是状态不是活动。中性 → 琥珀 → 红，三档全部来自既有语义令牌。
 */
function contextTone(ratio: number): "neutral" | "warning" | "danger" {
  if (ratio >= COMPRESS_THRESHOLD) return "danger";
  if (ratio >= CONTEXT_WARN_THRESHOLD) return "warning";
  return "neutral";
}

/**
 * 流式文本的刷新间隔。
 *
 * 60（跟屏幕刷新）太费 —— markdown 重解析的成本随文本长度增长；
 * 200 以上能看出「一段一段蹦」。80ms 是实测下来既不卡又看不出颗粒感的一档。
 */
const STREAM_FLUSH_MS = 80;

/**
 * 合并新旧消息列表：内容完全一致的那几条沿用旧对象。
 *
 * 判据用 id + 正文 + 引用 + 归档状态 —— 少判一样都可能吃到过期的渲染。
 * 跨会话切换时两边的 id 不会重合，所以自然会全量替换，不需要额外分支。
 */
function mergePreservingIdentity(previous: Message[], incoming: Message[]): Message[] {
  return incoming.map((message, index) => {
    const before = previous[index];
    if (
      before &&
      before.id === message.id &&
      before.content === message.content &&
      before.filedAsPageId === message.filedAsPageId &&
      Boolean(before.interrupted) === Boolean(message.interrupted) &&
      before.runStatus === message.runStatus &&
      before.runError === message.runError &&
      JSON.stringify(before.artifacts) === JSON.stringify(message.artifacts) &&
      JSON.stringify(before.citations) === JSON.stringify(message.citations)
    ) {
      return before;
    }
    return message;
  });
}

export function ChatWorkspace() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { bumpData, resolveWikilink, vault, agentName, sessions } = useAppData();
  const { openDrawer: openIngest } = useIngest();
  // 当前会话由 URL 决定（/chat?s=<id>）：侧栏的「最近对话」据此高亮，
  // 刷新页面也能回到同一段对话。新对话就是不带 s 的 /chat。
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(
    () => searchParams.get("s"),
  );
  const [sessionTitle, setSessionTitle] = React.useState(t("chat_workspace.m001"));
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [activeRun, setActiveRun] = React.useState<ActiveRun | null>(null);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [openCitation, setOpenCitation] = React.useState<Citation | null>(null);
  const citationPanel = React.useRef<HTMLDivElement>(null);
  const closeCitation = React.useCallback(() => setOpenCitation(null), []);
  useModalFocus(Boolean(openCitation), citationPanel, closeCitation);
  const [citationPageState, setCitationPageState] = React.useState<"checking" | "available" | "stale" | "error" | null>(null);
  const [filingMessage, setFilingMessage] = React.useState<Message | null>(null);
  const [configMissing, setConfigMissing] = React.useState(false);
  const [settings, setSettings] = React.useState<PublicSettings | null>(null);
  const [chatConfig, setChatConfig] = React.useState<ChatConfig | null>(null);
  const pendingConfigWrite = React.useRef<Promise<void>>(Promise.resolve());
  const [context, setContext] = React.useState<ContextUsage | null>(null);
  const [showContext, setShowContext] = React.useState(false);
  // 本轮压缩的最终结论（失败 / 跳过 / 硬截断），用于明细行里的如实说明
  const [compression, setCompression] = React.useState<CompressionNotice | null>(null);
  // 后台任务事件对应当前订阅的会话。
  const streaming = Boolean(activeRun && activeRun.sessionId === activeSessionId);
  const busy = streaming || sending;

  const citationPageId = openCitation?.pageId;
  React.useEffect(() => {
    if (!citationPageId) {
      setCitationPageState(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setCitationPageState("checking");
    void fetch(`/api/pages/${citationPageId}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) })
      .then((response) => {
        if (!active) return;
        setCitationPageState(response.status === 404 ? "stale" : response.ok ? "available" : "error");
      })
      .catch(() => { if (active) setCitationPageState("error"); });
    return () => { active = false; controller.abort(); };
  }, [citationPageId]);

  // 流收尾时确认用户仍停在所属会话，避免后台事件改写当前打开的另一段对话。
  const currentSessionRef = React.useRef(activeSessionId);
  React.useEffect(() => {
    currentSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  // 传给消息气泡的回调必须是稳定引用，否则 React.memo 完全失效 ——
  // 每次渲染都换新函数等于没 memo，流式输出时整列历史消息会跟着每个 token 重解析。
  const goToPage = React.useCallback(
    (pageId: string) => {
      router.push(`/wiki/${pageId}`);
    },
    [router],
  );

  /** 入场动效只在消息首次出现时播放；后台任务从占位消息开始，收尾时沿用同一个 id。 */
  const previousMessages = React.useRef<Message[]>([]);
  /** 刚刚流式渲染完的那条消息的 id —— 它已经在屏幕上待过了，不该再演一次入场 */
  const streamedMessageIds = React.useRef<Set<string>>(new Set());
  // ref 仅保存已展示消息的动画历史，不作为正文或交互状态的真源。
  /* eslint-disable react-hooks/refs */
  const animateFlags = React.useMemo(() => {
    const previous = previousMessages.current;
    return messages.map((message, index) => {
      if (streamedMessageIds.current.has(message.id)) return false;
      const before = previous[index];
      return !(before && before.role === message.role && before.content === message.content);
    });
  }, [messages]);
  /* eslint-enable react-hooks/refs */
  React.useEffect(() => {
    previousMessages.current = messages;
  }, [messages]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const hasConversation = messages.length > 0 || streaming;
  const sendingRef = React.useRef(false);

  // 与 hooks/use-api.ts 里同一套办法：每次请求领一个序号，只有最新那次允许写 state。
  // 否则 A 的流结束后那次 loadMessages(A) 还在途中、用户已经切到 B 时，
  // 晚到的响应会把 B 的消息与标题覆盖回 A。
  const messagesGeneration = React.useRef(0);

  const loadMessages = React.useCallback(async (sessionId: string, restoreConfig = true) => {
    const current = ++messagesGeneration.current;
    try {
      const data = await apiFetch<{
        session: { title: string; config: ChatConfig | null };
        messages: Message[];
        context: ContextUsage;
        activeRun: ActiveRun | null;
      }>(`/api/chat/sessions/${sessionId}`);
      if (current !== messagesGeneration.current) return;
      setSessionTitle(data.session?.title ?? t("chat_workspace.m002"));
      if (restoreConfig) setChatConfig(data.session.config);
      setActiveRun(data.activeRun ?? null);
      // 保留没变的那几条消息的**对象引用**。
      //
      // 每次回答结束都会重新拉一遍消息列表，而服务端返回的是全新对象 ——
      // 直接 setMessages 的话，整段对话里每一条的 props 都变了，
      // React.memo 直接失效，于是几十条历史消息的 markdown 会在
      // 「答案刚落定」的这一刻一起重解析。用户感觉到的就是那一下卡顿。
      // 没变的消息沿用旧引用，重解析就只剩新出现的那一两条。
      setMessages((previous) => mergePreservingIdentity(previous, data.messages));
      // 服务端算好的占用。刷新页面后靠它把百分比复原 —— 检索到的正文没有落库，
      // 前端自己算不出当时那一轮真实的 prompt 长度
      setContext(data.context ?? null);
      // 压缩结论属于**上一段会话**，切过来必须清掉。不清的话，在 A 里压缩失败过
      // 一次，切到 B 打开占用明细，B 会被告知「上一次自动压缩没成功（摘要端点挂了）」
      // 或者「已丢弃最早的 3 条对话」—— 对 B 全是假的，而这正是本文件反复防的
      // 那类跨会话串台（同一批状态里，标题、消息、占用都随会话切了，只漏了它）。
      setCompression(null);
    } catch {
      if (current === messagesGeneration.current) {
        setActiveRun(null);
        setMessages([]);
        setContext(null);
        setCompression(null);
      }
    }
  }, [t]);

  // 读取本机模型配置状态；凭据不返回浏览器。
  React.useEffect(() => {
    void apiFetch<{ model: { configured: boolean }; settings: PublicSettings }>("/api/settings")
      .then((data) => {
        setConfigMissing(!data.model?.configured); setSettings(data.settings);
        setChatConfig(previous => restoreChatConfig(previous, data.settings));
      })
      .catch(() => undefined);
  }, []);

  // 从侧栏点另一段对话时，路由不变但 ?s= 变了，要跟着切
  React.useEffect(() => {
    setActiveSessionId(searchParams.get("s"));
  }, [searchParams]);

  React.useEffect(() => {
    if (!activeSessionId) return;
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    if (activeSession) setSessionTitle(activeSession.title);
  }, [activeSessionId, sessions]);

  React.useEffect(() => {
    if (activeSessionId) void loadMessages(activeSessionId);
    else {
      setActiveRun(null);
      setMessages([]);
      const provider = settings?.providers.find(entry => entry.id === settings.activeProviderId);
      setChatConfig(provider?.model ? { providerId: provider.id, model: provider.model, reasoningEffort: provider.reasoningEffort, contextWindow: provider.contextWindow, showMe: false } : null);
    }
  }, [activeSessionId, loadMessages, settings]);

  // 只有「本来就贴着底」时才自动跟随。用户往上翻看历史时，
  // 原来的实现每个 token 都把他拽回底部一次，根本读不了。
  const stickToBottom = React.useRef(true);
  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    // 流式期间用 auto：smooth 由主线程驱动，每个 token 发一次会互相打断、抖
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? "auto" : "smooth" });
  }, [messages, streaming]);

  const handleSend = React.useCallback(async () => {
    const question = input.trim();
    if (!question || busy || sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setInput("");
    setError(null);

    try {
      await pendingConfigWrite.current;
      const run = await apiFetch<{
        runId: string;
        sessionId: string;
        questionMessageId: string;
        assistantMessageId: string;
        createdAt: string;
        config: ChatConfig;
      }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ question, sessionId: activeSessionId, ...(chatConfig ? { config: chatConfig } : {}) }),
      });
      const now = Date.now();
      const userMessage: Message = {
        id: run.questionMessageId,
        role: "user",
        content: question,
        citations: null,
        filedAsPageId: null,
        createdAt: new Date(now).toISOString(),
      };
      const assistantMessage: Message = {
        id: run.assistantMessageId,
        role: "assistant",
        content: "",
        citations: null,
        filedAsPageId: null,
        runStatus: "running",
        runError: null,
        createdAt: run.createdAt,
        config: run.config,
        artifacts: [],
      };
      setMessages((previous) => [...previous, userMessage, assistantMessage]);
      setActiveRun({
        id: run.runId,
        sessionId: run.sessionId,
        questionMessageId: run.questionMessageId,
        assistantMessageId: run.assistantMessageId,
        status: "running",
        text: "",
        createdAt: run.createdAt,
        config: run.config,
      });
      setCompression(null);
      setSessionTitle(question.slice(0, 30));
      if (run.sessionId !== activeSessionId) {
        setActiveSessionId(run.sessionId);
        router.replace(`/chat?s=${run.sessionId}`);
      }
      bumpData("sessions");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInput((current) => current || question);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [input, busy, activeSessionId, chatConfig, router, bumpData]);

  const handleConfigChange = React.useCallback((config: ChatConfig) => {
    setChatConfig(config);
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    // 顺序保存，避免快速切换时较早的请求覆盖最终选择。
    pendingConfigWrite.current = pendingConfigWrite.current.then(async () => {
      await apiFetch(`/api/chat/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ config }) });
    }).catch(error => { if (currentSessionRef.current === sessionId) setError(error instanceof Error ? error.message : t("chat_workspace.m003")); });
  }, [activeSessionId, t]);

  /**
   * 客户端只订阅服务端任务。离开聊天页时清理这个订阅不会中止模型生成；
   * 返回会话或刷新页面后，会从服务端快照继续接收正文。
   */
  React.useEffect(() => {
    if (!activeRun || activeRun.sessionId !== activeSessionId) return;

    let accumulated = activeRun.text ?? "";
    let flushTimer: number | null = null;
    let lastFlushAt = 0;
    let terminalHandled = false;
    const assistantMessageId = activeRun.assistantMessageId;
    const sessionId = activeRun.sessionId;
    const source = new EventSource(`/api/chat/runs/${activeRun.id}/stream`);

    const patchAssistant = (patch: Partial<Message>) => {
      setMessages((previous) => previous.map((message) =>
        message.id === assistantMessageId ? { ...message, ...patch } : message,
      ));
    };
    const normalizeCitations = (value: unknown, quality?: unknown): Message["citations"] => {
      if (Array.isArray(value)) {
        return { list: value as Citation[], quality: (quality as Quality | null) ?? undefined };
      }
      if (value && typeof value === "object") {
        const stored = value as NonNullable<Message["citations"]>;
        return {
          list: Array.isArray(stored.list) ? stored.list : [],
          quality: stored.quality,
          hallucinated: stored.hallucinated,
          process: stored.process,
        };
      }
      return null;
    };
    const flush = (immediate = false) => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      const elapsed = performance.now() - lastFlushAt;
      if (immediate || elapsed >= STREAM_FLUSH_MS) {
        lastFlushAt = performance.now();
        patchAssistant({ content: accumulated });
      } else {
        flushTimer = window.setTimeout(() => {
          flushTimer = null;
          lastFlushAt = performance.now();
          patchAssistant({ content: accumulated });
        }, STREAM_FLUSH_MS - elapsed);
      }
    };
    const finish = (status: "done" | "failed" | "cancelled", details: {
      text?: string;
      citations?: unknown;
      quality?: unknown;
      context?: ContextUsage | null;
      compression?: CompressionNotice | null;
      error?: string | null;
      interrupted?: boolean;
      process?: ChatProgress[];
      artifacts?: ChatArtifact[];
    } = {}) => {
      if (terminalHandled) return;
      terminalHandled = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      flushTimer = null;
      if (typeof details.text === "string") accumulated = details.text;
      const citations = normalizeCitations(details.citations, details.quality);
      patchAssistant({
        content: accumulated,
        citations,
        runStatus: status,
        runError: details.error ?? null,
        interrupted: details.interrupted ?? status === "cancelled",
        ...(details.process ? { process: details.process } : {}),
        ...(details.artifacts ? { artifacts: details.artifacts } : {}),
      });
      streamedMessageIds.current.add(assistantMessageId);
      setActiveRun(null);
      if (currentSessionRef.current === sessionId) {
        if (details.context) setContext(details.context);
        if (details.compression) setCompression(details.compression);
        bumpData("sessions");
        void loadMessages(sessionId, false).then(() => {
          if (details.compression && currentSessionRef.current === sessionId) {
            setCompression(details.compression);
          }
        });
      } else {
        bumpData("sessions");
      }
      source.close();
    };

    source.onmessage = (messageEvent) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(messageEvent.data) as Record<string, unknown>;
      } catch {
        return;
      }

      if (event.type === "snapshot") {
        const run = event.run as Record<string, unknown> | undefined;
        if (!run) return;
        if (typeof run.text === "string") accumulated = run.text;
        const citations = normalizeCitations(run.citations, run.quality);
        patchAssistant({
          content: accumulated,
          citations,
          runStatus: (run.status as Message["runStatus"]) ?? "running",
          runError: typeof run.error === "string" ? run.error : null,
          interrupted: run.status === "cancelled",
          ...(Array.isArray(run.artifacts) ? { artifacts: run.artifacts as ChatArtifact[] } : {}),
          ...(typeof run.createdAt === "string" ? { createdAt: run.createdAt } : {}),
          ...(run.config ? { config: run.config as ChatConfig } : {}),
          ...(Array.isArray(run.process) ? { process: run.process as ChatProgress[] } : {}),
        });
        if (run.status === "done" || run.status === "cancelled") {
          finish(run.status, {
            text: accumulated,
            citations: run.citations,
            quality: run.quality,
            interrupted: run.status === "cancelled",
          });
        } else if (run.status === "failed") {
          finish("failed", {
            text: accumulated,
            citations: run.citations,
            quality: run.quality,
            error: typeof run.error === "string" ? run.error : t("chat_workspace.m004"),
          });
        }
        return;
      }

      if (event.type === "delta" && typeof event.text === "string") {
        accumulated += event.text;
        flush();
      } else if (event.type === "citations") {
        patchAssistant({ citations: normalizeCitations(event.citations, event.quality) });
      } else if (event.type === "done") {
        finish(event.interrupted ? "cancelled" : "done", {
          text: typeof event.text === "string" ? event.text : accumulated,
          citations: event.citations,
          quality: event.quality,
          context: (event.context as ContextUsage | null) ?? null,
          compression: (event.compression as CompressionNotice | null) ?? null,
          interrupted: Boolean(event.interrupted),
          process: Array.isArray(event.process) ? event.process as ChatProgress[] : undefined,
          artifacts: Array.isArray(event.artifacts) ? event.artifacts as ChatArtifact[] : undefined,
        });
      } else if (event.type === "error") {
        finish("failed", {
          text: accumulated,
          error: typeof event.message === "string" ? event.message : t("chat_workspace.m004"),
        });
      }
    };
    // EventSource 会在短暂断线后自动重连；断开连接只影响展示订阅，不影响服务端任务。
    source.onerror = () => undefined;

    return () => {
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      source.close();
    };
  }, [activeRun, activeSessionId, bumpData, loadMessages, t]);

  const handleStop = React.useCallback(async () => {
    if (!activeRun || activeRun.sessionId !== activeSessionId) return;
    try {
      await apiFetch("/api/chat/stop", {
        method: "POST",
        body: JSON.stringify({ sessionId: activeRun.sessionId }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chat_workspace.m005"));
    }
  }, [activeRun, activeSessionId, t]);

  // 会话是**惰性创建**的：服务端在第一句提问时才落库。所以「新对话」只是
  // 回到不带 ?s 的 /chat，不需要先建一个空会话出来。
  const handleNewSession = React.useCallback(() => {
    setActiveSessionId(null);
    setSessionTitle(t("chat_workspace.m001"));
    setMessages([]);
    setError(null);
    setContext(null);
    setCompression(null);
    setShowContext(false);
    const provider = settings?.providers.find(entry => entry.id === settings.activeProviderId);
    setChatConfig(provider?.model ? { providerId: provider.id, model: provider.model, reasoningEffort: provider.reasoningEffort, contextWindow: provider.contextWindow, showMe: false } : null);
    router.push("/chat");
  }, [router, settings, t]);

  const handleDeleteSession = React.useCallback(
    async (sessionId: string) => {
      try {
        await apiFetch(`/api/chat/sessions/${sessionId}`, { method: "DELETE" });
        handleNewSession();
        bumpData("sessions"); // 让侧栏的最近对话把这条去掉
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [handleNewSession, bumpData],
  );

  const closeFiledAnswer = React.useCallback(() => setFilingMessage(null), []);
  const handleFile = React.useCallback((messageId: string) => {
    const message = messages.find(item => item.id === messageId);
    if (message) setFilingMessage(message);
  }, [messages]);

  return (
    <>
      {/* 移动端要让开顶部导航条（h-12），桌面端侧栏占满高度，主区就是满屏 */}
      <div className="chat-workspace flex h-[calc(100dvh-3rem)] p-2 md:h-dvh md:p-3">
        {/* 主对话区 */}
        <div className="chat-surface flex min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-border bg-card/50">
          <div className="chat-header flex h-12 shrink-0 items-center justify-between gap-3 px-4">
            <span className="truncate text-[12.5px] text-muted-foreground">{sessionTitle}</span>
            <div className="flex shrink-0 items-center gap-1">
              {activeSessionId && context && context.maxTokens > 0 && (
                <button
                  type="button"
                  onClick={() => setShowContext((open) => !open)}
                  aria-expanded={showContext}
                  aria-label={t("chat_workspace.m009", {v0: contextPercent(context), v1: showContext ? t("chat_workspace.m007") : t("chat_workspace.m008")})}
                  title={t("chat_workspace.m012", {v0: contextPercent(context), v1: context.measured ? t("chat_workspace.m010") : t("chat_workspace.m011")})}
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
                >
                  <ProgressRing
                    value={ringPercent(context)}
                    size={14}
                    strokeWidth={2}
                    tone={contextTone(context.ratio)}
                  />
                  <span data-numeric>{contextPercent(context)}%</span>
                </button>
              )}
              {activeSessionId && (
                <button
                  type="button"
                  onClick={() => void handleDeleteSession(activeSessionId)}
                  aria-label={t("chat_workspace.m013")}
                  title={t("chat_workspace.m013")}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
                >
                  <Trash2 size={13} strokeWidth={1.8} />
                </button>
              )}

            </div>
          </div>

          {/* 上下文占用明细。点开才出现，因为它是「想深究时才有用」的信息 ——
              常驻会把头部那一行挤满，而平时没人需要看五个分项。 */}
          {activeSessionId && context && showContext && (
            <div className="chat-context-panel mx-4 mb-2 shrink-0 rounded-[14px] border border-border bg-muted/50 px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
              <div className="mx-auto max-w-3xl md:px-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-foreground" data-numeric>
                    {context.usedTokens.toLocaleString("zh-CN")} / {context.maxTokens.toLocaleString("zh-CN")} tokens
                  </span>
                  <span>
                    （{contextPercent(context)}%）
                    {context.measured ? t("chat_workspace.m014") : t("chat_workspace.m015")}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                  <span>{t("chat_workspace.m016")}{formatTokenCount(context.breakdown.system)}</span>
                  {context.breakdown.summary > 0 && (
                    <span>{t("chat_workspace.m017")}{formatTokenCount(context.breakdown.summary)}</span>
                  )}
                  <span>{t("chat_workspace.m018")}{formatTokenCount(context.breakdown.history)}</span>
                  <span>{t("chat_workspace.m019")}{formatTokenCount(context.breakdown.context)}</span>
                  <span>{t("chat_workspace.m020")}{formatTokenCount(context.breakdown.question)}</span>
                </div>
                {(context.summarizedMessages > 0 || context.compressionCount > 0 || context.droppedMessages > 0) && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {context.summarizedMessages > 0 && <span>{t("chat_workspace.m023")}{context.summarizedMessages} {t("chat_workspace.m022")}</span>}
                  {context.compressionCount > 0 && <span>{t("chat_workspace.m024")}{context.compressionCount} {t("chat_workspace.m025")}</span>}
                  {/* 硬丢弃的条数取自落库的实测记录，所以刷新页面后仍然在。
                      下面那段文字只在刚发生截断的那一轮出现 —— 少了这一行，
                      刷新一次「丢了 3 条对话」就消失了，而顶部百分比照样好看。 */}
                  {context.droppedMessages > 0 && <span>{t("chat_workspace.m026")}{context.droppedMessages} {t("chat_workspace.m022")}</span>}
                </div>}
                {!context.measured && context.breakdown.context === 0 && (
                  <p className="mt-1">
                    {t("chat_workspace.m027")}</p>
                )}
                {/* 这几条用前景色而不是语义色：语义色在本设计系统里只用于图标、边框与
                    底色，正文一律走前景/次级前景 —— 11.5px 的 --warning 压在暖米白上
                    对比度只有 2:1 量级，读不清就失去了提示的意义。 */}
                {compression?.phase === "failed" && (
                  <p className="mt-1 text-foreground">
                    {t("chat_workspace.m028")}{compression.reason}{t("chat_workspace.m029")}</p>
                )}
                {compression?.phase === "skipped" && compression.reason === "cooldown" && (
                  <p className="mt-1 text-foreground">{t("chat_workspace.m030")}</p>
                )}
                {compression?.phase === "truncated" && (
                  <p className="mt-1 text-foreground">
                    {t("chat_workspace.m031")}{compression.droppedMessages} {t("chat_workspace.m032")}{compression.reason ? `（${compression.reason}）` : ""}{t("chat_workspace.m033")}</p>
                )}
              </div>
            </div>
          )}

          <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
            {/* 屏幕阅读器的播报策略：流式过程中用 aria-busy 保持安静，
                回答结束后才把完整文本读一次。逐字播报会把用户淹没。 */}
            <div
              className="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {!streaming && messages.length > 0 && messages[messages.length - 1].role === "assistant"
                ? messages[messages.length - 1].content.replace(/\[ID:\d+\]/g, "")
                : ""}
            </div>

            <div
              className={cn(
                "mx-auto flex min-h-full max-w-3xl flex-col px-4 md:px-6",
                // 空状态时让问候块贴住下半部，和输入框凑成一组；
                // 在里面居中会让它俩被拉开半个屏幕，读起来是两件不相干的事。
                hasConversation ? "py-6" : "justify-end pb-6",
              )}
            >
              {configMissing && (
                <Card className="mb-5 border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_6%,transparent)] p-4">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--warning)]" />
                    <div>
                      <p className="text-[13px] font-medium text-foreground">{t("chat_workspace.m034")}</p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                        {t("chat_workspace.m035")}<Link href="/settings#model-service" className="ml-1 underline underline-offset-4">{t("chat_workspace.m036")}</Link>
                      </p>
                    </div>
                  </div>
                </Card>
              )}

              {!hasConversation && (
                <div className="flex flex-col items-center pt-8 text-center">
                  <WeaveMark animate className="mb-5 h-10 w-10 text-foreground" />
                  <h2 className="max-w-full text-balance text-[1.55rem] font-semibold leading-[1.35] tracking-[-0.025em] text-foreground sm:text-[1.85rem]">
                    {agentName}{t("chat_workspace.m037")}</h2>
                  {vault?.stats.pages === 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-4"
                      icon={<BookMarked size={13} />}
                      onClick={openIngest}
                    >
                      {t("chat_workspace.m038")}</Button>
                  )}
                </div>
              )}

              <div className="space-y-6">
                {messages.map((message, index) => {
                  const working = Boolean(
                    activeRun && activeRun.sessionId === activeSessionId && activeRun.assistantMessageId === message.id,
                  );
                  return (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      animate={animateFlags[index] ?? false}
                      resolveWikilink={resolveWikilink}
                      onCitationClick={setOpenCitation}
                      onFile={handleFile}
                      onNavigate={goToPage}
                      working={working}
                    />
                  );
                })}
              </div>

              {error && (
                <div role="alert" className="mt-4 rounded-[12px] border border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_7%,transparent)] p-3.5 text-[12.5px] text-foreground">
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* 输入区 */}
          <div className="shrink-0 pt-2">
            <div className="mx-auto max-w-3xl px-4 pb-3.5 md:px-6">
              {/* 焦点反馈给整条输入框（描边加深），不在里面的 textarea 上再套一圈。
                  浏览器对文本输入框的 :focus-visible 是「只要聚焦就命中」，所以鼠标点进来
                  也会画那条 2px 蓝环 —— 而它套在内层元素上，看上去像画歪了。
                  外框只在等待回答时使用蓝色；平时用中性描边加深表示焦点。 */}
              <AiWorkingFrame
                working={busy}
                tone="answer"
                className="chat-composer border border-border bg-card transition-colors focus-within:border-[color-mix(in_srgb,var(--foreground)_32%,transparent)]"
              >
                <div className="p-2.5">
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      // IME 结束时 compositionend 可能先于 keydown，229 仍表示候选确认。
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    placeholder={t("chat_workspace.m039")}
                    aria-label={t("chat_workspace.m040")}
                    rows={1}
                    className="min-h-[88px] border-0 bg-transparent px-1.5 py-2 text-[16px] focus:border-0 focus-visible:outline-none sm:min-h-[44px] sm:text-[14px]"
                    disabled={busy}
                  />
                  <div className="mt-1.5 flex items-center justify-between gap-3">
                    <ChatControls value={chatConfig} providers={settings?.providers ?? []} disabled={busy} onChange={handleConfigChange} />
                    {streaming ? (
                      // 生成中把「发送」换成「停止」：同一个位置、同一个尺寸，
                      // 手不用移动。停止比发送更需要被立刻找到 —— 它是救急的那个
                      <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        onClick={() => void handleStop()}
                        icon={<CircleStop size={12} strokeWidth={2} />}
                      >
                        {t("chat_workspace.m041")}</Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        className="shrink-0"
                        disabled={!input.trim() || busy}
                        onClick={() => void handleSend()}
                        icon={<Send size={12} strokeWidth={2} />}
                      >
                        {hasConversation ? t("chat_workspace.m042") : t("chat_workspace.m043")}
                      </Button>
                    )}
                  </div>
                </div>
              </AiWorkingFrame>
            </div>

          </div>

          {/* 空状态时把输入框顶到视觉中间。用一个占位块而不是给输入框换位置 ——
              换位置会让它重新挂载、丢焦点，也会让布局跳一下。 */}
          {!hasConversation && <div className="chat-empty-space shrink-0" aria-hidden />}
        </div>
      </div>

      {/* 引用详情抽屉 */}
      {openCitation && (
        <div ref={citationPanel} role="dialog" aria-modal="true" aria-label={t("chat_workspace.m045", {v0: openCitation.index, v1: openCitation.pageTitle})} tabIndex={-1} className="fixed inset-0 z-[var(--z-index-modal)] outline-none">
          <div data-modal-dismiss className="absolute inset-0 bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]" onClick={closeCitation} aria-hidden />
          <aside className="panel-in absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-border bg-background p-5 shadow-dialog">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-[11.5px] font-semibold tracking-[0.1em] text-muted-foreground">
                  {t("chat_workspace.m046")}{openCitation.index}]
                </p>
                <p className="mt-1 text-[15px] font-medium text-foreground">{openCitation.pageTitle}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <TypeBadge type={openCitation.pageType} />
                  {openCitation.sourcePage && (
                    <Badge tone="accent">{t("chat_workspace.m047")}{openCitation.sourcePage} {t("chat_workspace.m048")}</Badge>
                  )}
                </div>
                {citationPageState === "stale" && (
                  <p role="status" className="mt-2 max-w-[300px] text-[11.5px] leading-relaxed text-[var(--warning)]">
                    {t("chat_workspace.m049")}</p>
                )}
                {citationPageState === "error" && (
                  <p role="status" className="mt-2 text-[11.5px] text-muted-foreground">{t("chat_workspace.m050")}</p>
                )}
              </div>
              <button
                type="button"
                onClick={closeCitation}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
                aria-label={t("chat_workspace.m051")}
              >
                <X size={14} />
              </button>
            </div>

            <Hairline className="mb-4" />

            <div className="mb-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <Quote size={11} />
              {t("chat_workspace.m052")}</div>
            <div className="rounded-[12px] border border-border bg-card p-3.5">
              <p className="text-[12.5px] leading-relaxed text-foreground">
                {stripWikilinks(openCitation.excerpt)}
              </p>
            </div>

            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {t("chat_workspace.m053")}</p>

            {openCitation.sourceRefs && openCitation.sourceRefs.length > 0 && (
              <div className="mt-4 space-y-3">
                <p className="text-[11.5px] font-medium text-foreground">{t("chat_workspace.m054")}</p>
                {openCitation.sourceRefs.map((source, index) => (
                  <div key={`${source.sourceId ?? source.originalName}-${index}`} className="rounded-[12px] border border-border bg-card p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[12px] text-foreground">{source.originalName}</span>
                      {source.page && <Badge tone="neutral">{t("chat_workspace.m055")}{source.page} {t("chat_workspace.m048")}</Badge>}
                    </div>
                    {source.quote && (
                      <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
                        {stripWikilinks(source.quote)}
                      </p>
                    )}
                    {source.sourceId && citationPageState === "stale" ? (
                      <p className="mt-2.5 text-[11px] text-muted-foreground">{t("chat_workspace.m056")}</p>
                    ) : source.sourceId && (
                      <div className="mt-2.5 flex gap-3 text-[11.5px]">
                        <a href={`/api/sources/${source.sourceId}/raw`} className="text-foreground underline underline-offset-4">
                          {t("chat_workspace.m057")}</a>
                        <a href={`/api/sources/${source.sourceId}/parsed`} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">
                          {t("chat_workspace.m058")}</a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {openCitation.sourceDoc && (!openCitation.sourceRefs || openCitation.sourceRefs.length === 0) && (
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                {/[\\/]|^[A-Za-z]:/.test(openCitation.sourceDoc)
                  ? t("chat_workspace.m059")
                  : t("chat_workspace.m060", {v0: openCitation.sourceDoc})}
              </p>
            )}

            <Button
              variant="secondary"
              size="sm"
              className="mt-4 w-full"
              disabled={citationPageState !== "available"}
              onClick={() => {
                if (citationPageState === "available") router.push(`/wiki/${openCitation.pageId}`);
              }}
            >
              {citationPageState === "checking" ? t("chat_workspace.m061") : citationPageState === "stale" ? t("chat_workspace.m062") : citationPageState === "error" ? t("chat_workspace.m063") : t("chat_workspace.m064")}
            </Button>
          </aside>
        </div>
      )}

      {filingMessage && <AnswerFilingDialog key={filingMessage.id} message={filingMessage} sessionId={activeSessionId}
        onClose={closeFiledAnswer} onSaved={async () => { if (activeSessionId) await loadMessages(activeSessionId); bumpData(); }} />}

    </>
  );
}
