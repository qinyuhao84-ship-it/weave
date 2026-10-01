import type { ChatArtifact, ChatConfig, ChatTimings } from "./config";
/** 正在生成中的回答由服务端持有，不再依赖浏览器请求的生命周期。 */
export type ChatRunSnapshot = {
  runId: string;
  sessionId: string;
  assistantMessageId: string;
  status: "running" | "done" | "failed" | "cancelled";
  text: string;
  retrieved: unknown[];
  compression: unknown;
  citations: unknown[];
  quality: unknown;
  context: unknown;
  error: string | null;
  process: unknown[];
  createdAt: string;
  config: ChatConfig | null;
  artifacts: ChatArtifact[];
  timings: ChatTimings | null;
};

export type ChatRunEvent = { type: string; [key: string]: unknown };
type Listener = (event: ChatRunEvent) => void;

type RuntimeStream = {
  snapshot: ChatRunSnapshot;
  listeners: Set<Listener>;
};

type StreamState = {
  controllers: Map<string, AbortController>;
  runs: Map<string, RuntimeStream>;
  runBySession: Map<string, string>;
};

const globalForStreams = globalThis as unknown as { __weaveChatStreams?: StreamState };

function registry(): StreamState {
  if (!globalForStreams.__weaveChatStreams) {
    globalForStreams.__weaveChatStreams = {
      controllers: new Map(),
      runs: new Map(),
      runBySession: new Map(),
    };
  }
  return globalForStreams.__weaveChatStreams;
}

/** 注册一轮服务端生成。runId 参数可省略，兼容既有停止流测试与调用点。 */
export function registerStream(
  sessionId: string,
  runId?: string,
  assistantMessageId?: string,
  createdAt = new Date().toISOString(),
  config: ChatConfig | null = null,
): AbortController {
  const state = registry();
  const controller = new AbortController();
  state.controllers.set(sessionId, controller);
  if (runId && assistantMessageId) {
    const snapshot: ChatRunSnapshot = {
      runId,
      sessionId,
      assistantMessageId,
      status: "running",
      text: "",
      retrieved: [],
      compression: null,
      citations: [],
      quality: null,
      context: null,
      error: null,
      process: [],
      createdAt, config, artifacts: [], timings: null,
    };
    state.runs.set(runId, { snapshot, listeners: new Set() });
    state.runBySession.set(sessionId, runId);
  }
  return controller;
}

/** 给所有当前订阅者推送事件，并同步更新可供刷新恢复的进程内快照。 */
export function publishChatRun(runId: string, event: ChatRunEvent): void {
  const runtime = registry().runs.get(runId);
  if (!runtime) return;

  if (event.type === "timings") {
    runtime.snapshot.timings = event.timings as ChatTimings ?? null;
  } else if (event.type === "progress" && event.progress) {
    runtime.snapshot.process = [...runtime.snapshot.process, event.progress];
  } else if (event.type === "delta" && typeof event.text === "string") {
    runtime.snapshot.text += event.text;
  } else if (event.type === "retrieved" && Array.isArray(event.pages)) {
    runtime.snapshot.retrieved = event.pages;
  } else if (event.type === "compressing") {
    runtime.snapshot.compression = event.notice ?? null;
  } else if (event.type === "citations") {
    runtime.snapshot.citations = Array.isArray(event.citations) ? event.citations : [];
    runtime.snapshot.quality = event.quality ?? null;
  } else if (event.type === "done") {
    runtime.snapshot.artifacts = Array.isArray(event.artifacts) ? event.artifacts as ChatArtifact[] : [];
    runtime.snapshot.timings = event.timings as ChatTimings ?? null;
    runtime.snapshot.status = event.interrupted ? "cancelled" : "done";
    if (typeof event.text === "string") runtime.snapshot.text = event.text;
    runtime.snapshot.citations = Array.isArray(event.citations) ? event.citations : [];
    runtime.snapshot.quality = event.quality ?? null;
    runtime.snapshot.context = event.context ?? null;
  } else if (event.type === "error") {
    runtime.snapshot.status = "failed";
    runtime.snapshot.error = typeof event.message === "string" ? event.message : "回答生成失败。";
  }

  for (const listener of runtime.listeners) {
    try { listener(event); } catch { /* 单个订阅者断开不影响模型生成 */ }
  }
}

/** 同步订阅并读取首帧快照，避免刷新恢复时在「快照与订阅」之间漏掉增量。 */
export function subscribeChatRun(
  runId: string,
  listener: Listener,
): { snapshot: ChatRunSnapshot; unsubscribe: () => void } | null {
  const runtime = registry().runs.get(runId);
  if (!runtime) return null;
  runtime.listeners.add(listener);
  return {
    snapshot: { ...runtime.snapshot },
    unsubscribe: () => runtime.listeners.delete(listener),
  };
}

export function finishLiveChatRun(runId: string): void {
  const state = registry();
  const runtime = state.runs.get(runId);
  if (!runtime) return;
  state.runs.delete(runId);
  if (state.runBySession.get(runtime.snapshot.sessionId) === runId) {
    state.runBySession.delete(runtime.snapshot.sessionId);
  }
}

/**
 * 清理本轮停止开关。只有注册自己的那一轮才允许摘除，避免收尾与新任务竞态。
 */
export function clearStream(sessionId: string, controller: AbortController): void {
  const state = registry();
  if (state.controllers.get(sessionId) !== controller) return;
  state.controllers.delete(sessionId);
  const runId = state.runBySession.get(sessionId);
  if (runId) finishLiveChatRun(runId);
}

export function stopStream(sessionId: string): boolean {
  const controller = registry().controllers.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isStreaming(sessionId: string): boolean {
  return registry().controllers.has(sessionId);
}

/** 数据清理前用于避免正在生成的回答在清理后重新写入数据库。 */
export function hasActiveStreams(): boolean {
  return registry().controllers.size > 0;
}
