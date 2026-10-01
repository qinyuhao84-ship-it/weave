"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Send, Plus, Trash2, BookMarked, X, Quote, AlertTriangle, CircleStop,
} from "lucide-react";
import { useAppData } from "@/components/app-provider";
import { useIngest } from "@/components/ingest/ingest-provider";
import {
  Button, Badge, TypeBadge, Card, Input, Textarea, Hairline, AiWorkingFrame, ProgressRing,
} from "@/components/ui";
import { COMPRESS_THRESHOLD, CONTEXT_WARN_THRESHOLD } from "@/lib/chat/tokens";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { apiFetch } from "@/hooks/use-api";
import { useModalFocus } from "@/hooks/use-modal-focus";
import type { WikilinkResolver } from "@/lib/markdown/wikilink-plugin";
import { stripWikilinks } from "@/lib/vault/wikilinks";
import { cn, truncate } from "@/lib/utils";
import type { ChatProgress } from "@/lib/chat/progress";
import { restoreChatConfig, type ChatConfig, type ChatArtifact } from "@/lib/chat/config";
import type { PublicSettings } from "@/lib/settings";
import { ChatControls } from "./chat-controls";
import { WaitingStatus } from "./waiting-status";
import { ArtifactCard, ArtifactPlaceholder } from "./artifact-card";
import { WeaveMark } from "@/components/ui/weave-mark";

/**
 * 对话界面。
 *
 * 三件事让这里的体验区别于普通聊天框：
 *   1. 等待时是边框扫光（不是 spinner）—— 与本产品的设计语言一致
 *   2. 流式逐字入场，每个消息块 6px 上浮
 *   3. 引用角标可查看检索到的词条片段及关联原始资料
 */

type Citation = {
  index: number;
  pageId: string;
  pageTitle: string;
  pageType: string;
  sourcePage: number | null;
  sourceDoc: string | null;
  excerpt: string;
  sourceRefs?: Array<{
    sourceId: string | null;
    originalName: string;
    page: number | null;
    quote: string | null;
  }>;
};

type Quality = {
  citationCount: number;
  hallucinationCount: number;
  hallucinationRate: number;
  hasNoCitations: boolean;
  isNoAnswer: boolean;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: { list?: Citation[]; quality?: Quality; hallucinated?: number[]; process?: ChatProgress[] } | null;
  filedAsPageId: string | null;
  /** 这条回答是被用户中途停掉的。界面要如实标出来，不能让它看起来像答完了 */
  interrupted?: boolean;
  runStatus?: "running" | "done" | "failed" | "cancelled" | null;
  runError?: string | null;
  process?: ChatProgress[];
  createdAt: string;
  config?: ChatConfig | null;
  artifacts?: ChatArtifact[];
};

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

type FilingTarget = { id: string; title: string; contentHash: string };
type FilingPageOption = { pageId: string; title: string; type: string };

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

/** 把只在当前问答轮次有效的引用编号，落成词条之间可长期使用的双链。 */
function answerForFiling(message: Message): string {
  const byIndex = new Map((message.citations?.list ?? []).map((citation) => [citation.index, citation]));
  return message.content.replace(/\[\s*ID\s*[:：]\s*(\d+)\s*\]/gi, (marker, indexText: string) => {
    const citation = byIndex.get(Number(indexText));
    return citation ? `[[${citation.pageTitle}]]` : marker;
  });
}

export function ChatWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { bumpData, resolveWikilink, vault, agentName, sessions } = useAppData();
  const { openDrawer: openIngest } = useIngest();
  // 当前会话由 URL 决定（/chat?s=<id>）：侧栏的「最近对话」据此高亮，
  // 刷新页面也能回到同一段对话。新对话就是不带 s 的 /chat。
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(
    () => searchParams.get("s"),
  );
  const [sessionTitle, setSessionTitle] = React.useState("新对话");
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
  const [filingMode, setFilingMode] = React.useState<"new" | "existing">("new");
  const [filingTitle, setFilingTitle] = React.useState("");
  const [filingContent, setFilingContent] = React.useState("");
  const [filingSearch, setFilingSearch] = React.useState("");
  const [filingOptions, setFilingOptions] = React.useState<FilingPageOption[]>([]);
  const [filingTarget, setFilingTarget] = React.useState<FilingTarget | null>(null);
  const [filingLoading, setFilingLoading] = React.useState(false);
  const [filingSaving, setFilingSaving] = React.useState(false);
  const [filingError, setFilingError] = React.useState<string | null>(null);
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
      setSessionTitle(data.session?.title ?? "对话");
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
  }, []);

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
      bumpData();
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
    }).catch(error => { if (currentSessionRef.current === sessionId) setError(error instanceof Error ? error.message : "问答配置保存失败，发送时将重试当前选择。"); });
  }, [activeSessionId]);

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
        bumpData();
        void loadMessages(sessionId, false).then(() => {
          if (details.compression && currentSessionRef.current === sessionId) {
            setCompression(details.compression);
          }
        });
      } else {
        bumpData();
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
            error: typeof run.error === "string" ? run.error : "回答生成失败。",
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
          error: typeof event.message === "string" ? event.message : "回答生成失败。",
        });
      }
    };
    // EventSource 会在短暂断线后自动重连；断开连接只影响展示订阅，不影响服务端任务。
    source.onerror = () => undefined;

    return () => {
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      source.close();
    };
  }, [activeRun, activeSessionId, bumpData, loadMessages]);

  const handleStop = React.useCallback(async () => {
    if (!activeRun || activeRun.sessionId !== activeSessionId) return;
    try {
      await apiFetch("/api/chat/stop", {
        method: "POST",
        body: JSON.stringify({ sessionId: activeRun.sessionId }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "停止请求没有完成。");
    }
  }, [activeRun, activeSessionId]);

  // 会话是**惰性创建**的：服务端在第一句提问时才落库。所以「新对话」只是
  // 回到不带 ?s 的 /chat，不需要先建一个空会话出来。
  const handleNewSession = React.useCallback(() => {
    setActiveSessionId(null);
    setSessionTitle("新对话");
    setMessages([]);
    setError(null);
    setContext(null);
    setCompression(null);
    setShowContext(false);
    const provider = settings?.providers.find(entry => entry.id === settings.activeProviderId);
    setChatConfig(provider?.model ? { providerId: provider.id, model: provider.model, reasoningEffort: provider.reasoningEffort, contextWindow: provider.contextWindow, showMe: false } : null);
    router.push("/chat");
  }, [router, settings]);

  const handleDeleteSession = React.useCallback(
    async (sessionId: string) => {
      try {
        await apiFetch(`/api/chat/sessions/${sessionId}`, { method: "DELETE" });
        handleNewSession();
        bumpData(); // 让侧栏的最近对话把这条去掉
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [handleNewSession, bumpData],
  );

  const handleFile = React.useCallback((messageId: string) => {
    const message = messages.find((item) => item.id === messageId);
    if (!message) return;
    setFilingMessage(message);
    setFilingMode("new");
    setFilingTitle(truncate(message.content.replace(/\[\s*ID\s*[:：]\s*\d+\s*\]/gi, "").split("\n")[0].trim(), 40));
    setFilingContent(answerForFiling(message));
    setFilingSearch("");
    setFilingOptions([]);
    setFilingTarget(null);
    setFilingError(null);
  }, [messages]);

  React.useEffect(() => {
    const query = filingSearch.trim();
    if (!filingMessage || filingMode !== "existing" || filingTarget || query.length < 2) {
      setFilingOptions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setFilingLoading(true);
      void apiFetch<{ results: FilingPageOption[] }>(`/api/search?q=${encodeURIComponent(query)}&limit=12`)
        .then((result) => {
          if (!cancelled) setFilingOptions(result.results);
        })
        .catch((err) => {
          if (!cancelled) setFilingError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setFilingLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filingMessage, filingMode, filingSearch, filingTarget]);

  const selectFilingTarget = React.useCallback(async (option: FilingPageOption) => {
    if (!filingMessage) return;
    setFilingError(null);
    setFilingLoading(true);
    try {
      const page = await apiFetch<{ id: string; title: string; content: string; contentHash: string }>(`/api/pages/${option.pageId}`);
      setFilingTarget({ id: page.id, title: page.title, contentHash: page.contentHash });
      setFilingContent(`${page.content.trimEnd()}\n\n## 来自问答的补充\n\n${answerForFiling(filingMessage).trim()}`);
    } catch (err) {
      setFilingError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilingLoading(false);
    }
  }, [filingMessage]);

  const saveFiledAnswer = React.useCallback(async () => {
    if (!filingMessage || !activeSessionId) return;
    setFilingSaving(true);
    setFilingError(null);
    try {
      await apiFetch(`/api/chat/sessions/${activeSessionId}/file`, {
        method: "POST",
        body: JSON.stringify({
          messageId: filingMessage.id,
          ...(filingMode === "new" ? { title: filingTitle } : {}),
          ...(filingTarget ? {
            targetPageId: filingTarget.id,
            expectedHash: filingTarget.contentHash,
            content: filingContent,
          } : filingMode === "new" ? { content: filingContent } : {}),
        }),
      });
      await loadMessages(activeSessionId);
      bumpData();
      setFilingMessage(null);
    } catch (err) {
      setFilingError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilingSaving(false);
    }
  }, [filingMessage, activeSessionId, filingMode, filingTitle, filingTarget, filingContent, loadMessages, bumpData]);

  return (
    <>
      {/* 移动端要让开顶部导航条（h-12），桌面端侧栏占满高度，主区就是满屏 */}
      <div className="flex h-[calc(100dvh-3rem)] md:h-dvh">
        {/* 主对话区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
            <span className="truncate text-[12.5px] text-muted-foreground">{sessionTitle}</span>
            <div className="flex shrink-0 items-center gap-1">
              {activeSessionId && context && context.maxTokens > 0 && (
                <button
                  type="button"
                  onClick={() => setShowContext((open) => !open)}
                  aria-expanded={showContext}
                  aria-label={`上下文占用 ${contextPercent(context)}%，点击${showContext ? "收起" : "展开"}明细`}
                  title={`上下文占用 ${contextPercent(context)}% · ${context.measured ? "实测" : "估算"}`}
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
                  aria-label="删除这段对话"
                  title="删除这段对话"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
                >
                  <Trash2 size={13} strokeWidth={1.8} />
                </button>
              )}
              {activeSessionId && (
                <button
                  type="button"
                  onClick={handleNewSession}
                  className="flex h-7 items-center gap-1 rounded-full px-2 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
                >
                  <Plus size={13} strokeWidth={1.8} />
                  新对话
                </button>
              )}
            </div>
          </div>

          {/* 上下文占用明细。点开才出现，因为它是「想深究时才有用」的信息 ——
              常驻会把头部那一行挤满，而平时没人需要看五个分项。 */}
          {activeSessionId && context && showContext && (
            <div className="shrink-0 border-b border-border bg-[var(--muted)] px-4 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
              <div className="mx-auto max-w-3xl md:px-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-foreground" data-numeric>
                    {context.usedTokens.toLocaleString("zh-CN")} / {context.maxTokens.toLocaleString("zh-CN")} tokens
                  </span>
                  <span>
                    （{contextPercent(context)}%）
                    {context.measured ? " · 实测" : " · 估算"}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>系统 {formatTokenCount(context.breakdown.system)}</span>
                  {context.breakdown.summary > 0 && (
                    <span>摘要 {formatTokenCount(context.breakdown.summary)}</span>
                  )}
                  <span>对话历史 {formatTokenCount(context.breakdown.history)}</span>
                  <span>检索资料 {formatTokenCount(context.breakdown.context)}</span>
                  <span>本次提问 {formatTokenCount(context.breakdown.question)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>逐字保留 {context.historyMessages} 条</span>
                  {context.summarizedMessages > 0 && <span>已摘要 {context.summarizedMessages} 条</span>}
                  {context.compressionCount > 0 && <span>压缩过 {context.compressionCount} 次</span>}
                  {/* 硬丢弃的条数取自落库的实测记录，所以刷新页面后仍然在。
                      下面那段文字只在刚发生截断的那一轮出现 —— 少了这一行，
                      刷新一次「丢了 3 条对话」就消失了，而顶部百分比照样好看。 */}
                  {context.droppedMessages > 0 && <span>已丢弃 {context.droppedMessages} 条</span>}
                </div>
                {!context.measured && context.breakdown.context === 0 && (
                  <p className="mt-1">
                    这一页没有正在进行的提问，所以「检索资料」与「本次提问」为空 ——
                    真实占用还要再多出这两项。
                  </p>
                )}
                {/* 这几条用前景色而不是语义色：语义色在本设计系统里只用于图标、边框与
                    底色，正文一律走前景/次级前景 —— 11.5px 的 --warning 压在暖米白上
                    对比度只有 2:1 量级，读不清就失去了提示的意义。 */}
                {compression?.phase === "failed" && (
                  <p className="mt-1 text-foreground">
                    注意：上一次自动压缩没成功（{compression.reason}），对话本身不受影响。
                  </p>
                )}
                {compression?.phase === "skipped" && compression.reason === "cooldown" && (
                  <p className="mt-1 text-foreground">上次压缩失败，已暂停 5 分钟再试，免得每轮都白等一次。</p>
                )}
                {compression?.phase === "truncated" && (
                  <p className="mt-1 text-foreground">
                    注意：为了塞进窗口，已丢弃最早的 {compression.droppedMessages} 条对话
                    {compression.reason ? `（${compression.reason}）` : ""}。这段内容不在摘要里。
                  </p>
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
                      <p className="text-[13px] font-medium text-foreground">先配置你的模型</p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                        请先连接你自己的云端或本地模型，保存后即可开始问答。
                        <Link href="/settings#model-service" className="ml-1 underline underline-offset-4">去配置模型</Link>
                      </p>
                    </div>
                  </div>
                </Card>
              )}

              {!hasConversation && (
                <div className="flex flex-col items-center pt-8 text-center">
                  <WeaveMark animate className="mb-5 h-10 w-10 text-foreground" />
                  <h2 className="max-w-full text-balance text-[1.55rem] font-semibold leading-[1.35] tracking-[-0.025em] text-foreground sm:text-[1.85rem]">
                    {agentName}，今天想了解什么？
                  </h2>
                  {vault?.stats.pages === 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-4"
                      icon={<BookMarked size={13} />}
                      onClick={openIngest}
                    >
                      先导入资料
                    </Button>
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
                <div className="mt-4 rounded-[12px] border border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_7%,transparent)] p-3.5 text-[12.5px] text-foreground">
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* 输入区 */}
          <div className={cn("shrink-0", hasConversation && "border-t border-border")}>
            <div className="mx-auto max-w-3xl px-4 pb-3.5 md:px-6">
              {/* 焦点反馈给整条输入框（描边加深），不在里面的 textarea 上再套一圈。
                  浏览器对文本输入框的 :focus-visible 是「只要聚焦就命中」，所以鼠标点进来
                  也会画那条 2px 蓝环 —— 而它套在内层元素上，看上去像画歪了。
                  外框只在等待回答时使用蓝色；平时用中性描边加深表示焦点。 */}
              <AiWorkingFrame
                working={busy}
                tone="answer"
                className="border border-border bg-card transition-colors focus-within:border-[color-mix(in_srgb,var(--foreground)_32%,transparent)]"
              >
                <div className="p-2.5">
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    placeholder="问问你的知识库，比如：这几篇资料对项目风险有什么不同看法？"
                    aria-label="向知识库提问"
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
                        停止
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        className="shrink-0"
                        disabled={!input.trim() || busy}
                        onClick={() => void handleSend()}
                        icon={<Send size={12} strokeWidth={2} />}
                      >
                        {hasConversation ? "发送" : "开始提问"}
                      </Button>
                    )}
                  </div>
                </div>
              </AiWorkingFrame>
            </div>
            {!hasConversation && (
              <p className="mx-auto mt-3 flex max-w-3xl items-baseline justify-center gap-1.5 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-[11.5px] text-muted-foreground md:px-6">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" aria-hidden />
                资料保存在本机，入库前可以检查 AI 生成的变更。
              </p>
            )}
          </div>

          {/* 空状态时把输入框顶到视觉中间。用一个占位块而不是给输入框换位置 ——
              换位置会让它重新挂载、丢焦点，也会让布局跳一下。 */}
          {!hasConversation && <div className="chat-empty-space shrink-0" aria-hidden />}
        </div>
      </div>

      {/* 引用详情抽屉 */}
      {openCitation && (
        <div ref={citationPanel} role="dialog" aria-modal="true" aria-label={`引用 ${openCitation.index}：${openCitation.pageTitle}`} tabIndex={-1} className="fixed inset-0 z-[var(--z-index-modal)] outline-none">
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]" onClick={closeCitation} aria-hidden />
          <aside className="panel-in absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-border bg-background p-5 shadow-dialog">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-[11.5px] font-semibold tracking-[0.1em] text-muted-foreground">
                  引用 [{openCitation.index}]
                </p>
                <p className="mt-1 text-[15px] font-medium text-foreground">{openCitation.pageTitle}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <TypeBadge type={openCitation.pageType} />
                  {openCitation.sourcePage && (
                    <Badge tone="accent">原文第 {openCitation.sourcePage} 页</Badge>
                  )}
                </div>
                {citationPageState === "stale" && (
                  <p role="status" className="mt-2 max-w-[300px] text-[11.5px] leading-relaxed text-[var(--warning)]">
                    这条引用来自已删除或已清空的知识库快照。原对话中的引用片段仍保留，当前词条已不可用。
                  </p>
                )}
                {citationPageState === "error" && (
                  <p role="status" className="mt-2 text-[11.5px] text-muted-foreground">暂时无法核对这条引用对应的词条。</p>
                )}
              </div>
              <button
                type="button"
                onClick={closeCitation}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>

            <Hairline className="mb-4" />

            <div className="mb-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <Quote size={11} />
              本次检索到的知识库词条片段
            </div>
            <div className="rounded-[12px] border border-border bg-card p-3.5">
              <p className="text-[12.5px] leading-relaxed text-foreground">
                {stripWikilinks(openCitation.excerpt)}
              </p>
            </div>

            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              编号只确认答案引用了本次检索结果，不代表该片段在语义上足以推出回答中的结论。
            </p>

            {openCitation.sourceRefs && openCitation.sourceRefs.length > 0 && (
              <div className="mt-4 space-y-3">
                <p className="text-[11.5px] font-medium text-foreground">关联原文</p>
                {openCitation.sourceRefs.map((source, index) => (
                  <div key={`${source.sourceId ?? source.originalName}-${index}`} className="rounded-[12px] border border-border bg-card p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[12px] text-foreground">{source.originalName}</span>
                      {source.page && <Badge tone="neutral">第 {source.page} 页</Badge>}
                    </div>
                    {source.quote && (
                      <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
                        {stripWikilinks(source.quote)}
                      </p>
                    )}
                    {source.sourceId && citationPageState === "stale" ? (
                      <p className="mt-2.5 text-[11px] text-muted-foreground">原件已随旧知识库归档；恢复对应回收站批次后可再次查看。</p>
                    ) : source.sourceId && (
                      <div className="mt-2.5 flex gap-3 text-[11.5px]">
                        <a href={`/api/sources/${source.sourceId}/raw`} className="text-foreground underline underline-offset-4">
                          下载原件
                        </a>
                        <a href={`/api/sources/${source.sourceId}/parsed`} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">
                          查看解析稿
                        </a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {openCitation.sourceDoc && (!openCitation.sourceRefs || openCitation.sourceRefs.length === 0) && (
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                {/[\\/]|^[A-Za-z]:/.test(openCitation.sourceDoc)
                  ? "此引用来自旧版来源记录；请通过关联词条核对原始资料。"
                  : `来源：${openCitation.sourceDoc}`}
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
              {citationPageState === "checking" ? "正在核对词条…" : citationPageState === "stale" ? "词条已失效" : citationPageState === "error" ? "暂时无法打开词条" : "打开完整词条"}
            </Button>
          </aside>
        </div>
      )}

      {filingMessage && (
        <>
          <div
            className="fixed inset-0 z-[var(--z-index-overlay)] bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]"
            onClick={() => setFilingMessage(null)}
            aria-hidden
          />
          <aside className="panel-in fixed right-0 top-0 z-[var(--z-index-modal)] flex h-full w-full max-w-xl flex-col border-l border-border bg-background shadow-dialog">
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
              <div>
                <h2 className="text-[14px] font-semibold text-foreground">保存回答到知识库</h2>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">保留回答里的引用与原始资料来源</p>
              </div>
              <button type="button" onClick={() => setFilingMessage(null)} aria-label="关闭" className="rounded-full p-2 text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground">
                <X size={14} />
              </button>
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-pressed={filingMode === "new"}
                  onClick={() => { setFilingMode("new"); setFilingTarget(null); }}
                  className={cn("rounded-full border px-3 py-1.5 text-[12px]", filingMode === "new" ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}
                >
                  新建词条
                </button>
                <button
                  type="button"
                  aria-pressed={filingMode === "existing"}
                  onClick={() => { setFilingMode("existing"); setFilingTarget(null); setFilingContent(""); }}
                  className={cn("rounded-full border px-3 py-1.5 text-[12px]", filingMode === "existing" ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}
                >
                  合并到已有词条
                </button>
              </div>

              {filingMode === "new" ? (
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground" htmlFor="filing-title">词条标题</label>
                  <Input id="filing-title" value={filingTitle} onChange={(event) => setFilingTitle(event.target.value)} maxLength={120} />
                </div>
              ) : (
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground" htmlFor="filing-search">查找要合并的词条</label>
                  {filingTarget ? (
                    <div className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-card px-3 py-2.5">
                      <span className="truncate text-[12.5px] text-foreground">{filingTarget.title}</span>
                      <Button size="sm" variant="ghost" onClick={() => { setFilingTarget(null); setFilingSearch(""); setFilingContent(""); }}>更换</Button>
                    </div>
                  ) : (
                    <>
                      <Input id="filing-search" value={filingSearch} onChange={(event) => setFilingSearch(event.target.value)} placeholder="输入词条标题或相关内容…" />
                      {filingLoading && <p className="mt-2 text-[11.5px] text-muted-foreground">正在查找…</p>}
                      {filingOptions.length > 0 && (
                        <div className="mt-2 max-h-48 overflow-y-auto rounded-[10px] border border-border bg-card">
                          {filingOptions.map((option) => (
                            <button key={option.pageId} type="button" onClick={() => void selectFilingTarget(option)} className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-[var(--muted)]">
                              <span className="truncate text-[12.5px] text-foreground">{option.title}</span>
                              <TypeBadge type={option.type} />
                            </button>
                          ))}
                        </div>
                      )}
                      {filingSearch.trim().length >= 2 && !filingLoading && filingOptions.length === 0 && (
                        <p className="mt-2 text-[11.5px] text-muted-foreground">没有找到匹配词条，请换个关键词。</p>
                      )}
                    </>
                  )}
                </div>
              )}

              {(filingMode === "new" || filingTarget) && (
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground" htmlFor="filing-content">
                    {filingMode === "new" ? "词条正文预览" : "合并后的正文预览，可继续编辑"}
                  </label>
                  {filingMode === "existing" && (
                    <p className="mb-2 text-[11.5px] leading-relaxed text-muted-foreground">
                      预览保留原词条正文，并在末尾加入这条回答；保存时会检查原词条是否被同时修改。
                    </p>
                  )}
                  <Textarea id="filing-content" value={filingContent} onChange={(event) => setFilingContent(event.target.value)} rows={18} />
                </div>
              )}

              {filingError && <p role="alert" className="rounded-[10px] border border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_7%,transparent)] p-3 text-[12px] text-foreground">{filingError}</p>}
            </div>

            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3.5">
              <Button variant="ghost" size="sm" disabled={filingSaving} onClick={() => setFilingMessage(null)}>取消</Button>
              <Button
                variant="primary"
                size="sm"
                loading={filingSaving}
                disabled={filingMode === "existing" && !filingTarget}
                onClick={() => void saveFiledAnswer()}
              >
                {filingMode === "new" ? "创建词条" : "确认合并"}
              </Button>
            </footer>
          </aside>
        </>
      )}
    </>
  );
}

/**
 * 回答上方那一行小字。
 *
 * 存在的理由只有一个：**它必须始终在、且高度固定**。
 * 流式时它写「正在检索 / 正在生成」，完成后它写引用统计 —— 同一行、同一高度，
 * 所以正文的起始位置从等待到落定始终不动。这正是「生成回答时跳一下」的解法：
 * 不是把动画调快，而是让状态切换根本不改变布局。
 *
 * 用 h-5 钉死高度、truncate 保证不换行：换行会让高度重新变成变量，
 * 那就等于把刚修好的坑又挖回来。
 */
function AnswerMeta({
  working = false,
  label,
  parts,
}: {
  working?: boolean;
  /** 流式状态下的那句话 */
  label?: string;
  /** 完成后的统计片段，用 · 连接 */
  parts?: React.ReactNode[];
}) {
  return (
    <div className="mb-2 flex h-5 items-center gap-1.5 text-[11.5px] text-muted-foreground">
      {working ? (
        <>
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ring)]" aria-hidden />
          <span className="truncate">{label}</span>
        </>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {(parts ?? []).map((part, index) => (
            <React.Fragment key={index}>
              {index > 0 && <span aria-hidden>·</span>}
              {part}
            </React.Fragment>
          ))}
        </span>
      )}
    </div>
  );
}

const MessageBubble = React.memo(function MessageBubble({
  message,
  animate,
  resolveWikilink,
  onCitationClick,
  onFile,
  onNavigate,
  working,
}: {
  message: Message;
  /** 这条消息是不是刚出现。false = 它已经在屏幕上待过了，别重播入场动效 */
  animate: boolean;
  /** 必须引用稳定：换个函数身份，这条消息的 markdown 就整篇重解析 */
  resolveWikilink: WikilinkResolver;
  onCitationClick: (citation: Citation) => void;
  onFile: (messageId: string) => void;
  onNavigate: (pageId: string) => void;
  working: boolean;
}) {
  const citations = React.useMemo(() => message.citations?.list ?? [], [message.citations?.list]);
  const quality = message.citations?.quality;

  const citationMap = React.useMemo(() => {
    const map = new Map<number, { pageId: string; title: string; sourcePage: number | null }>();
    for (const citation of citations) {
      map.set(citation.index, {
        pageId: citation.pageId,
        title: citation.pageTitle,
        sourcePage: citation.sourcePage,
      });
    }
    return map;
  }, [citations]);

  if (message.role === "user") {
    return (
      <div className={cn("flex justify-end", animate && "msg-in")}>
        <div className="max-w-[85%] rounded-[16px] rounded-br-[6px] bg-primary px-4 py-2.5 text-[13.5px] leading-relaxed text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  // 引用统计放在正文上方的状态行里（与流式时那一行同一个位置），
  // 不再在正文下面另起一个标题行 —— 一屏里两处说同一件事，读起来是噪音。
  const metaParts: React.ReactNode[] = [];
  if (!working && message.interrupted) {
    metaParts.push(
      <span key="interrupted" className="text-[var(--warning)]">
        已停止生成
      </span>,
    );
  }
  if (!working && citations.length > 0) {
    metaParts.push(`已校验的引用 ${citations.length} 处`);
  } else if (!working && quality?.isNoAnswer) {
    metaParts.push("知识库里没有能回答这个问题的内容");
  } else if (!working && message.runStatus !== "failed") {
    metaParts.push("这次回答没有引用知识库内容");
  }
  if (message.runStatus === "failed") {
    metaParts.push(
      <span key="failed" className="text-[var(--warning)]">
        {message.runError ? `生成失败：${message.runError}` : "回答生成失败"}
      </span>,
    );
  }
  if (quality && quality.hallucinationCount > 0) {
    metaParts.push(
      <span key="hallucination" className="text-[var(--warning)]">
        剔除 {quality.hallucinationCount} 条对不上原文的引用
      </span>,
    );
  }

  return (
    <div className={cn("group", animate && "msg-in")}>
      {working && <WaitingStatus createdAt={message.createdAt} hasText={Boolean(message.content.trim())} />}
      {!working && <AnswerMeta parts={metaParts} />}

      {message.content.trim() ? (
      <MarkdownRenderer
        content={message.content}
        resolveWikilink={resolveWikilink}
        // 回答里指向不存在词条的 [[X]] 直接当普通文字：对读者来说
        // 「这个词条还没有」不是他能处理的事，虚线只会让回答看着像坏了
        brokenWikilinks="plain"
        citations={citationMap}
        pendingCitations={working}
        onCitationClick={(index) => {
          const citation = citations.find((c) => c.index === index);
          if (citation) onCitationClick(citation);
        }}
        onWikilinkClick={(pageId) => pageId && onNavigate(pageId)}
        density="conversation"
        className={working ? "streaming-caret" : undefined}
      />
      ) : working ? null : message.interrupted || message.runStatus === "cancelled" ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          已停止生成，这一轮还没有产出内容。
        </p>
      ) : message.runStatus === "failed" ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">没有生成回答内容。</p>
      ) : (
        <p className="text-[13px] leading-relaxed text-muted-foreground">回答内容为空。</p>
      )}

      {message.artifacts?.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} />)}
      {working && message.config?.showMe && !message.artifacts?.length && <ArtifactPlaceholder />}

      {/* 引用列表 */}
      {citations.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex flex-wrap gap-1.5">
            {citations.map((citation) => (
              <button
                key={citation.index}
                type="button"
                onClick={() => onCitationClick(citation)}
                className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11.5px] transition-colors hover:border-[var(--focus-ring)] hover:bg-[var(--muted)]"
              >
                <span className="font-semibold tabular-nums text-[var(--ring)]">
                  {citation.index}
                </span>
                <span className="text-foreground">{truncate(citation.pageTitle, 16)}</span>
                {citation.sourcePage && (
                  <span className="text-muted-foreground">p.{citation.sourcePage}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 回填 wiki */}
      {/* 隐藏用的是父容器的 opacity —— 祖先的 opacity 会乘到整棵子树，
          子元素加 focus-visible:opacity-100 是反超不了的（这是同一个 opacity 的两个层级）。
          键盘用户 Tab 到这个会真的写数据的按钮上时必须能看见它，所以把 focus-within
          加在父容器上。 */}
      <div className="mt-2.5 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {message.filedAsPageId ? (
          <Badge tone="success">
            <BookMarked size={9} />
            已归档为词条
          </Badge>
        ) : (
          <button
            type="button"
            onClick={() => onFile(message.id)}
            className="flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <BookMarked size={11} />
            归档为新词条
          </button>
        )}
      </div>
    </div>
  );
});
