import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb } from "@/lib/db/client";
import { chatSessions, chatMessages, chatSummaries, chatRuns, pages } from "@/lib/db/schema";
import type { ChatSessionTitleOrigin, ChatSessionTitleSummaryStatus } from "@/lib/db/schema";
import { localISOString, truncate } from "@/lib/utils";
import { getSettings } from "@/lib/settings";
import { isSmallTalkQuestion } from "./title-utils";
import { ChatConfigSchema, restoreChatConfig, type ChatConfig, type ChatTimings, type ChatArtifact } from "./config";
import { defaultChatConfig } from "./config-server";
import { messageArtifacts } from "./artifacts";

/** 对话历史管理。用户明确要求：不做成一次性问答，问过的结论要能找回来。 */

export type ChatSessionView = {
  id: string;
  title: string;
  titleOrigin: ChatSessionTitleOrigin;
  titleSummaryStatus: ChatSessionTitleSummaryStatus;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  generating: boolean;
  activeRunId: string | null;
  config?: ChatConfig | null;
};

export type ChatRunStatus = "running" | "done" | "failed" | "cancelled";

export type ChatRunView = {
  id: string;
  sessionId: string;
  questionMessageId: string;
  assistantMessageId: string;
  status: ChatRunStatus;
  error: string | null;
  text: string;
  citations: unknown;
  updatedAt: string;
  createdAt: string;
  config: ChatConfig | null;
  timings: ChatTimings | null;
  artifacts: ChatArtifact[];
};

export type TrashedChatSessionView = ChatSessionView & {
  deletedAt: string;
};

export type ChatMessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: unknown;
  filedAsPageId: string | null;
  /** 生成这条回答时请求实际消耗的输入 token；老数据与不调模型的轮次为 null */
  promptTokens: number | null;
  /**
   * 生成这条回答时，为了塞进窗口而**硬丢掉**的历史消息条数。
   *
   * 和 promptTokens 一样存下来而不是每次重算：丢掉的消息还在库里、也算得出来，
   * 但「那一轮到底丢了几条」是个历史事实，事后重建不出。不存它，刷新页面之后
   * 「丢了 3 条对话」这句提示就消失了，而顶部百分比仍然显示得健健康康 ——
   * 信息损失恰好变得不可见（不变式：真信息损失必须显示给用户）。
   */
  droppedMessages: number;
  /** 这条回答是被用户中途停掉的。界面上要如实标出来，不能让它看起来像答完了 */
  interrupted: boolean;
  runStatus: ChatRunStatus | null;
  runError: string | null;
  createdAt: string;
  artifacts: ChatArtifact[];
  config: ChatConfig | null;
  timings: ChatTimings | null;
};

/** 一段会话历史被压缩后的摘要 */
export type ChatSummaryView = {
  content: string;
  /** 水位线：摘要已覆盖到这条消息为止（含） */
  coveredToMessageId: string;
  coveredMessageCount: number;
  compressionCount: number;
  tokenCount: number;
  model: string | null;
  updatedAt: string;
};

/**
 * 要送进 prompt 的历史。
 *
 * 分成「摘要」与「逐字消息」两段：摘要覆盖掉的部分不再逐字发送 —— 这正是压缩的
 * 全部意义。两段合起来才是完整的历史，缺一段都会让模型丢掉信息。
 */
export type ChatHistory = {
  summary: ChatSummaryView | null;
  /** 水位线之后、需要逐字带进 prompt 的消息（引用标记已剥掉） */
  messages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  /** 被摘要覆盖、不再逐字发送的消息条数 */
  summarizedCount: number;
};

export function createSession(title = "新对话"): string {
  const id = ulid();
  const now = localISOString();
  getDb().insert(chatSessions).values({
    id,
    title,
    titleOrigin: title === "新对话" ? "fallback" : "manual",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

function sessionFilter(query = "") {
  const pattern = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
  return and(isNull(chatSessions.deletedAt), query.trim() ? sql`${chatSessions.title} LIKE ${pattern} ESCAPE '\\'` : undefined);
}

export function countSessions(query = ""): number {
  return getDb().select({ count: sql<number>`count(*)` }).from(chatSessions).where(sessionFilter(query)).get()?.count ?? 0;
}

export function listSessions(limit = 100, offset = 0, query = ""): ChatSessionView[] {
  const db = getDb();
  const rows = db
    .select()
    .from(chatSessions)
    .where(sessionFilter(query))
    .orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id))
    .limit(limit).offset(offset)
    .all();
  const counts = new Map<string, number>();
  for (const message of db.select().from(chatMessages).all()) {
    counts.set(message.sessionId, (counts.get(message.sessionId) ?? 0) + 1);
  }

  const activeRuns = new Map(
    db.select().from(chatRuns).where(eq(chatRuns.status, "running")).all()
      .map((run) => [run.sessionId, run.id]),
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    titleOrigin: row.titleOrigin,
    titleSummaryStatus: row.titleSummaryStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: counts.get(row.id) ?? 0,
    generating: activeRuns.has(row.id),
    activeRunId: activeRuns.get(row.id) ?? null,
  }));
}

export function listTrashedSessions(limit = 1000): TrashedChatSessionView[] {
  const db = getDb();
  const rows = db
    .select()
    .from(chatSessions)
    .where(isNotNull(chatSessions.deletedAt))
    .orderBy(desc(chatSessions.deletedAt))
    .limit(limit)
    .all();
  const counts = new Map<string, number>();
  for (const message of db.select().from(chatMessages).all()) {
    counts.set(message.sessionId, (counts.get(message.sessionId) ?? 0) + 1);
  }

  return rows.map((row) => ({
    ...row,
    deletedAt: row.deletedAt!,
    messageCount: counts.get(row.id) ?? 0,
    generating: false,
    activeRunId: null,
  }));
}

export function getSession(sessionId: string): ChatSessionView | null {
  const row = getDb()
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.deletedAt)))
    .get();
  if (!row) return null;
  const activeRun = getActiveChatRun(sessionId);
  return {
    ...row,
    config: readSessionConfig(row.configJson),
    messageCount: getMessages(sessionId).length,
    generating: Boolean(activeRun),
    activeRunId: activeRun?.id ?? null,
  };
}

/** 原子地记录用户问题、助手占位消息和后台生成记录。 */
export function beginChatRun(sessionId: string, question: string, config?: ChatConfig): ChatRunView {
  const db = getDb();
  const id = ulid();
  const questionMessageId = ulid();
  const assistantMessageId = ulid();
  const now = localISOString();
  const assistantAt = localISOString(new Date(Date.now() + 1));

  db.transaction((tx) => {
    const session = tx.select().from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.deletedAt))).get();
    if (!session) throw new Error("找不到这段对话。");
    const active = tx.select({ id: chatRuns.id }).from(chatRuns)
      .where(and(eq(chatRuns.sessionId, sessionId), eq(chatRuns.status, "running"))).get();
    if (active) throw new Error("这段对话正在生成，请等它完成或先停止。");

    tx.insert(chatMessages).values({
      id: questionMessageId,
      sessionId,
      role: "user",
      content: question,
      createdAt: now,
    }).run();
    tx.insert(chatMessages).values({
      id: assistantMessageId,
      sessionId,
      role: "assistant",
      content: "",
      createdAt: assistantAt,
    }).run();
    tx.update(chatSessions).set({
      ...(config ? { configJson: JSON.stringify(config) } : {}),
      title: session.title === "新对话" ? truncate(question, 30) : session.title,
      titleSummaryStatus:
        session.titleOrigin === "fallback" &&
        (session.titleSummaryStatus === "idle" || session.titleSummaryStatus === "failed") &&
        !isSmallTalkQuestion(question)
          ? "pending"
          : session.titleSummaryStatus,
      updatedAt: now,
    }).where(eq(chatSessions.id, sessionId)).run();
    tx.insert(chatRuns).values({
      ...(config ? { configJson: JSON.stringify(config) } : {}),
      id,
      sessionId,
      questionMessageId,
      assistantMessageId,
      status: "running",
      createdAt: now,
      updatedAt: now,
    }).run();
  });

  return {
    id, sessionId, questionMessageId, assistantMessageId,
    status: "running", error: null, text: "", citations: null, updatedAt: now,
    createdAt: now, config: config ?? null, timings: null, artifacts: [],
  };
}

export function getActiveChatRun(sessionId: string): ChatRunView | null {
  const row = getDb().select().from(chatRuns)
    .where(and(eq(chatRuns.sessionId, sessionId), eq(chatRuns.status, "running"))).get();
  return row ? toChatRunView(row) : null;
}

export function getChatRun(runId: string): ChatRunView | null {
  const row = getDb().select().from(chatRuns).where(eq(chatRuns.id, runId)).get();
  return row ? toChatRunView(row) : null;
}

function toChatRunView(row: typeof chatRuns.$inferSelect): ChatRunView {
  const message = getDb().select().from(chatMessages)
    .where(eq(chatMessages.id, row.assistantMessageId)).get();
  return {
    id: row.id,
    sessionId: row.sessionId,
    questionMessageId: row.questionMessageId,
    assistantMessageId: row.assistantMessageId,
    status: row.status as ChatRunStatus,
    error: row.error,
    text: message?.content ?? "",
    citations: safeParse(message?.citationsJson ?? null),
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    config: row.configJson ? ChatConfigSchema.parse(safeParse(row.configJson)) : null,
    timings: safeParse(row.timingsJson) as ChatTimings | null,
    artifacts: messageArtifacts(row.assistantMessageId),
  };
}

/** 节流写入流式正文；浏览器刷新或服务进程重启后至少保留最近一次快照。 */
export function saveChatRunProgress(runId: string, text: string): void {
  const db = getDb();
  const run = db.select().from(chatRuns).where(eq(chatRuns.id, runId)).get();
  if (!run || run.status !== "running") return;
  const now = localISOString();
  db.update(chatMessages).set({ content: text }).where(eq(chatMessages.id, run.assistantMessageId)).run();
  db.update(chatRuns).set({ updatedAt: now }).where(eq(chatRuns.id, runId)).run();
}

export function updateAssistantMessage(input: {
  messageId: string;
  content: string;
  citations?: unknown;
  context?: unknown;
  promptTokens?: number;
  droppedMessages?: number;
  interrupted?: boolean;
}): void {
  getDb().update(chatMessages).set({
    content: input.content,
    citationsJson: input.citations ? JSON.stringify(input.citations) : null,
    contextJson: input.context ? JSON.stringify(input.context) : null,
    promptTokens: input.promptTokens ?? null,
    droppedMessages: input.droppedMessages ?? 0,
    interrupted: input.interrupted ? 1 : 0,
  }).where(eq(chatMessages.id, input.messageId)).run();
}

export function finishChatRun(runId: string, status: Exclude<ChatRunStatus, "running">, error: string | null = null): void {
  const now = localISOString();
  getDb().update(chatRuns).set({ status, error, updatedAt: now, finishedAt: now })
    .where(and(eq(chatRuns.id, runId), eq(chatRuns.status, "running"))).run();
}

export function saveChatTimings(runId: string, timings: ChatTimings): void {
  getDb().update(chatRuns).set({ timingsJson: JSON.stringify(timings) }).where(eq(chatRuns.id, runId)).run();
}

function readSessionConfig(value: string | null): ChatConfig | null {
  const parsed = ChatConfigSchema.safeParse(safeParse(value));
  // 只修复会话的生效视图，历史 run 的模型快照与原始配置不改写。
  return parsed.success ? restoreChatConfig(parsed.data, getSettings()) : defaultChatConfig();
}

export function saveSessionConfig(sessionId: string, config: ChatConfig): void {
  getDb().update(chatSessions).set({ configJson: JSON.stringify(config) }).where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.deletedAt))).run();
}

/** 进程重启后将无法继续的模型请求标成失败，已保存的部分正文仍保留。 */
export function markInterruptedChatRunsFailed(): number {
  const db = getDb();
  const rows = db.select().from(chatRuns).where(eq(chatRuns.status, "running")).all();
  if (rows.length === 0) return 0;
  const now = localISOString();
  for (const row of rows) {
    db.update(chatRuns).set({
      status: "failed",
      error: "服务重启时回答尚未完成，已保留当前内容。",
      updatedAt: now,
      finishedAt: now,
    }).where(eq(chatRuns.id, row.id)).run();
  }
  return rows.length;
}

/** 进程重启后，异步会话标题任务不会再继续；保留现有标题并允许用户重试。 */
export function markInterruptedSessionTitleSummariesFailed(): number {
  const result = getDb()
    .update(chatSessions)
    .set({ titleSummaryStatus: "failed" })
    .where(and(
      ne(chatSessions.titleSummaryStatus, "idle"),
      ne(chatSessions.titleSummaryStatus, "failed"),
    ))
    .run();
  return result.changes;
}

/** 用户主动请求 AI 重新总结时占用标题任务槽；同一会话同时只跑一个。 */
export function beginSessionTitleSummary(sessionId: string): boolean {
  const result = getDb()
    .update(chatSessions)
    .set({ titleSummaryStatus: "pending" })
    .where(and(
      eq(chatSessions.id, sessionId),
      isNull(chatSessions.deletedAt),
      ne(chatSessions.titleSummaryStatus, "pending"),
      ne(chatSessions.titleSummaryStatus, "generating"),
    ))
    .run();
  return result.changes > 0;
}

/** 把排队任务原子地标记为正在运行，防止连续两轮问答重复启动标题模型请求。 */
export function claimSessionTitleSummary(sessionId: string): boolean {
  const result = getDb()
    .update(chatSessions)
    .set({ titleSummaryStatus: "generating" })
    .where(and(
      eq(chatSessions.id, sessionId),
      isNull(chatSessions.deletedAt),
      eq(chatSessions.titleSummaryStatus, "pending"),
    ))
    .run();
  return result.changes > 0;
}

/** 只在任务仍处于 generating 时保存；用户期间手动改名会清空状态并赢得竞态。 */
export function completeSessionTitleSummary(sessionId: string, title: string): boolean {
  const result = getDb()
    .update(chatSessions)
    .set({ title, titleOrigin: "ai", titleSummaryStatus: "idle" })
    .where(and(
      eq(chatSessions.id, sessionId),
      isNull(chatSessions.deletedAt),
      eq(chatSessions.titleSummaryStatus, "generating"),
    ))
    .run();
  return result.changes > 0;
}

export function failSessionTitleSummary(sessionId: string): void {
  getDb()
    .update(chatSessions)
    .set({ titleSummaryStatus: "failed" })
    .where(and(
      eq(chatSessions.id, sessionId),
      ne(chatSessions.titleSummaryStatus, "idle"),
      ne(chatSessions.titleSummaryStatus, "failed"),
    ))
    .run();
}

/** 问答失败或被停止时释放自动标题任务，后续有实质内容时还可重试。 */
export function resetPendingSessionTitleSummary(sessionId: string): void {
  getDb()
    .update(chatSessions)
    .set({ titleSummaryStatus: "idle" })
    .where(and(
      eq(chatSessions.id, sessionId),
      eq(chatSessions.titleOrigin, "fallback"),
      eq(chatSessions.titleSummaryStatus, "pending"),
    ))
    .run();
}

export function getTrashedSession(sessionId: string): TrashedChatSessionView | null {
  const row = getDb()
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), isNotNull(chatSessions.deletedAt)))
    .get();
  if (!row?.deletedAt) return null;
  return {
    ...row,
    deletedAt: row.deletedAt,
    messageCount: getMessages(sessionId).length,
    generating: false,
    activeRunId: null,
  };
}

export function renameSession(sessionId: string, title: string): void {
  getDb()
    .update(chatSessions)
    .set({
      title: title.trim().slice(0, 60) || "未命名对话",
      titleOrigin: "manual",
      titleSummaryStatus: "idle",
      updatedAt: localISOString(),
    })
    .where(eq(chatSessions.id, sessionId))
    .run();
}

export function deleteSession(sessionId: string): void {
  // 保留内部永久删除语义；HTTP DELETE 使用 trashSession()，让用户可从回收站恢复。
  permanentlyDeleteSession(sessionId);
}

/** 将会话移入回收站，消息与摘要原样保留。 */
export function trashSession(sessionId: string): boolean {
  const now = localISOString();
  const result = getDb()
    .update(chatSessions)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.deletedAt)))
    .run();
  return result.changes > 0;
}

export function restoreSession(sessionId: string): boolean {
  const result = getDb()
    .update(chatSessions)
    .set({ deletedAt: null, updatedAt: localISOString() })
    .where(and(eq(chatSessions.id, sessionId), isNotNull(chatSessions.deletedAt)))
    .run();
  return result.changes > 0;
}

export function permanentlyDeleteSession(sessionId: string): boolean {
  const db = getDb();
  return db.transaction((tx) => {
    tx.delete(chatRuns).where(eq(chatRuns.sessionId, sessionId)).run();
    tx.delete(chatMessages).where(eq(chatMessages.sessionId, sessionId)).run();
    // 摘要必须跟着走。留着它的话，同 id 的会话被重建时（ULID 不会重复，但手工改库会）
    // 会拿一段属于别的对话的摘要去压缩新对话。
    tx.delete(chatSummaries).where(eq(chatSummaries.sessionId, sessionId)).run();
    const result = tx.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
    return result.changes > 0;
  });
}

export function emptySessionTrash(): number {
  const db = getDb();
  return db.transaction((tx) => {
    const ids = tx
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(isNotNull(chatSessions.deletedAt))
      .all();
    for (const { id } of ids) {
      tx.delete(chatRuns).where(eq(chatRuns.sessionId, id)).run();
      tx.delete(chatMessages).where(eq(chatMessages.sessionId, id)).run();
      tx.delete(chatSummaries).where(eq(chatSummaries.sessionId, id)).run();
      tx.delete(chatSessions).where(eq(chatSessions.id, id)).run();
    }
    return ids.length;
  });
}

export function getMessages(sessionId: string): ChatMessageView[] {
  const db = getDb();
  const activePages = new Set(db.select({ id: pages.id }).from(pages).where(eq(pages.status, "active")).all().map((page) => page.id));
  const runByMessage = new Map(
    db.select().from(chatRuns).where(eq(chatRuns.sessionId, sessionId)).all()
      .map((run) => [run.assistantMessageId, run]),
  );
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .all()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((row) => ({
      id: row.id,
      role: row.role as "user" | "assistant",
      content: row.content,
      citations: safeParse(row.citationsJson),
      // 文件版本撤销/删除之后保留原始归档关联，复原版本时还能恢复；失效页不阻止再归档。
      filedAsPageId: row.filedAsPageId && activePages.has(row.filedAsPageId) ? row.filedAsPageId : null,
      promptTokens: row.promptTokens ?? null,
      droppedMessages: row.droppedMessages ?? 0,
      interrupted: row.interrupted === 1,
      runStatus: (runByMessage.get(row.id)?.status as ChatRunStatus | undefined) ?? null,
      runError: runByMessage.get(row.id)?.error ?? null,
      createdAt: row.createdAt,
      artifacts: messageArtifacts(row.id),
      config: runByMessage.get(row.id)?.configJson ? ChatConfigSchema.parse(safeParse(runByMessage.get(row.id)!.configJson)) : null,
      timings: safeParse(runByMessage.get(row.id)?.timingsJson ?? null) as ChatTimings | null,
    }));
}

export function appendMessage(input: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  citations?: unknown;
  context?: unknown;
  /** 该轮请求实际消耗的输入 token（只有 assistant 消息有） */
  promptTokens?: number;
  /** 该轮为塞进窗口而硬丢掉的历史消息条数（只有 assistant 消息有，通常为 0） */
  droppedMessages?: number;
  /** 这轮回答被用户中途停掉了。只影响界面怎么标它，不影响它进不进历史 */
  interrupted?: boolean;
}): string {
  const id = ulid();
  const now = localISOString();
  const db = getDb();

  db.insert(chatMessages)
    .values({
      id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      citationsJson: input.citations ? JSON.stringify(input.citations) : null,
      contextJson: input.context ? JSON.stringify(input.context) : null,
      promptTokens: input.promptTokens ?? null,
      droppedMessages: input.droppedMessages ?? 0,
      interrupted: input.interrupted ? 1 : 0,
      createdAt: now,
    })
    .run();

  // 首条用户消息自动成为会话标题 —— 比"新对话"有用得多
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, input.sessionId)).get();
  const latestUpdated = db.select({ value: sql<string | null>`max(${chatSessions.updatedAt})` }).from(chatSessions).get()?.value;
  const touchedDate = new Date(Math.max(Date.now(), latestUpdated ? new Date(latestUpdated).getTime() + 1 : 0));
  const touchedAt = localISOString(touchedDate).replace(/(T\d{2}:\d{2}:\d{2})/, `$1.${String(touchedDate.getMilliseconds()).padStart(3, "0")}`);
  const patch: { updatedAt: string; title?: string } = { updatedAt: touchedAt };
  if (session && session.title === "新对话" && session.titleOrigin === "fallback" && input.role === "user") {
    patch.title = truncate(input.content, 30);
  }
  db.update(chatSessions).set(patch).where(eq(chatSessions.id, input.sessionId)).run();

  return id;
}

/** 标记某条回答已回填为 wiki 词条 */
export function markFiled(messageId: string, pageId: string): void {
  getDb()
    .update(chatMessages)
    .set({ filedAsPageId: pageId })
    .where(eq(chatMessages.id, messageId))
    .run();
}

/* ------------------------------------------------------------------ 摘要读写 */

export function readSummary(sessionId: string): ChatSummaryView | null {
  const row = getDb().select().from(chatSummaries).where(eq(chatSummaries.sessionId, sessionId)).get();
  if (!row) return null;
  return {
    content: row.content,
    coveredToMessageId: row.coveredToMessageId,
    coveredMessageCount: row.coveredMessageCount,
    compressionCount: row.compressionCount,
    tokenCount: row.tokenCount,
    model: row.model,
    updatedAt: row.updatedAt,
  };
}

/** 覆盖写。一个会话只保留一份当前生效的摘要，压缩没有「历史版本」的概念。 */
export function writeSummary(input: {
  sessionId: string;
  content: string;
  coveredToMessageId: string;
  coveredMessageCount: number;
  compressionCount: number;
  tokenCount: number;
  model: string | null;
}): boolean {
  const now = localISOString();
  const existing = getDb()
    .select()
    .from(chatSummaries)
    .where(eq(chatSummaries.sessionId, input.sessionId))
    .get();

  // 水位线只许前进，不许回退。
  //
  // 场景是并发：同一个会话开两个标签页各发一问，两次压缩都读到了同一个旧摘要，
  // 各自跑完模型后都来写这一行。后写的那次若基于更少的已落库消息算出更靠前的水位线，
  // 把它写进去会让已经进过摘要的一段历史重新变回「未覆盖」—— 下一轮被再摘要一次，
  // 摘要里出现重复事实；而 chat_summaries 只有一行，事后完全看不出发生过什么。
  //
  // 拒绝回退是确定性的（不变式 5：能用程序算的绝不交给模型或时序），
  // 代价只是这一次压缩的结果被丢弃 —— 库里那份覆盖得更全，丢掉不损失信息。
  if (existing && input.coveredMessageCount < existing.coveredMessageCount) return false;

  getDb()
    .insert(chatSummaries)
    .values({
      sessionId: input.sessionId,
      content: input.content,
      coveredToMessageId: input.coveredToMessageId,
      coveredMessageCount: input.coveredMessageCount,
      compressionCount: input.compressionCount,
      tokenCount: input.tokenCount,
      model: input.model,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: chatSummaries.sessionId,
      set: {
        content: input.content,
        coveredToMessageId: input.coveredToMessageId,
        coveredMessageCount: input.coveredMessageCount,
        compressionCount: input.compressionCount,
        tokenCount: input.tokenCount,
        model: input.model,
        updatedAt: now,
      },
    })
    .run();

  return true;
}

export function clearSummary(sessionId: string): void {
  getDb().delete(chatSummaries).where(eq(chatSummaries.sessionId, sessionId)).run();
}

/* -------------------------------------------------------------- 历史组装 */

/**
 * 剥掉回答正文里的引用标记。
 *
 * 历史消息里的 [ID:n] 对模型是**噪音而不是信息**：编号指向的是上一轮那次检索的
 * 结果列表，这一轮的编号完全不同（同一编号在这一轮是另一篇词条）。留着它，
 * 模型会以为自己在引用一段它看不到的内容，进而编出对应关系。
 */
export function stripCitationMarkers(text: string): string {
  return text.replace(/\[\s*ID\s*[:：]\s*\d+\s*\]/gi, "");
}

/**
 * 组装要带进 prompt 的对话历史。
 *
 * 与原先的 recentTurns 有两点本质区别：
 *   1. **不按轮数截断**。旧实现固定只带最近 6 轮，于是历史长度有天花板，
 *      永远不可能触发压缩 —— 上限被硬编码死了。现在逐字历史一直保留到
 *      水位线为止，什么时候该收窄由 token 预算说了算（见 lib/chat/compress.ts）。
 *   2. 带出摘要。压缩过的部分以摘要形式继续参与，而不是被丢掉。
 */
export function buildHistory(
  sessionId: string,
  options: { excludeMessageId?: string; excludeMessageIds?: string[]; question?: string } = {},
): ChatHistory {
  const all = getMessages(sessionId);
  const summary = readSummary(sessionId);

  // 顺序很重要：**先做「哪些消息真的会进 prompt」这一次过滤，再按水位线切分**。
  // 反过来（先切、再过滤）会让 summarizedCount 把空内容的消息也算进去 ——
  // 那些消息从来没进过摘要的输入，报出去的数字却把用户的水位线往后推了一截，
  // 和同一块面板里的 coveredMessageCount 对不上。
  let eligible = all.filter((message) => message.content.trim().length > 0);

  // 本轮的用户消息在调用方（answer 之前）就已经落库了，它不该再作为「历史」
  // 重复出现一次 —— 问题本身在最后那条 user 消息里已经写全了。
  //
  // 优先按 message id 精确排除。退回到「最后一条内容等于本次提问」是给老调用点
  // 留的兼容路径：那个启发式在 createdAt 落在同一秒、或用户把同一句话问了两遍时
  // 会认错对象（多带一次问题，或误删一条历史）。
  const excluded = new Set([
    ...(options.excludeMessageIds ?? []),
    ...(options.excludeMessageId ? [options.excludeMessageId] : []),
  ]);
  if (excluded.size > 0) {
    eligible = eligible.filter((message) => !excluded.has(message.id));
  } else if (options.question !== undefined) {
    const last = eligible.at(-1);
    if (last && last.content === options.question) eligible = eligible.slice(0, -1);
  }

  let kept = eligible;
  let summarizedCount = 0;

  if (summary) {
    const mark = eligible.findIndex((message) => message.id === summary.coveredToMessageId);
    if (mark >= 0) {
      kept = eligible.slice(mark + 1);
      // 水位线之前、真正进过 prompt 的消息条数 —— 也就是这份摘要实际覆盖掉的量
      summarizedCount = mark + 1;
    }
    // 水位线找不到对应的消息时（正常流程下不会发生：消息只随会话一起删）
    // 保守地**保留全部消息**、摘要照用。最坏结果是内容重复一点，
    // 而反过来假定「全都被摘要覆盖了」会静默丢掉用户刚说过的话 ——
    // 那是不可接受的。下一轮压缩会重写水位线，状态自行恢复。
  }

  return {
    summary,
    messages: kept.map((message) => ({
      id: message.id,
      role: message.role,
      content: stripCitationMarkers(message.content),
    })),
    summarizedCount,
  };
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
