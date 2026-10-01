import { eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb, getSqlite } from "@/lib/db/client";
import { jobs, sources, reviewItems } from "@/lib/db/schema";
import { localISOString } from "@/lib/utils";
import {
  computeProgress,
  estimateStageFraction,
  isTerminal,
  stageLabel,
  stagesForKind,
  type JobEvent,
  type JobKind,
  type JobStageTable,
  type JobStatus,
} from "./types";

/**
 * 单并发任务运行器。
 *
 * 为什么必须自己管任务，而不能把导入跑在请求生命周期里：
 * next dev 的 HMR 会杀掉长任务，而一次导入是分钟级的（解析 + 两次 LLM 调用）。
 * 本机单用户场景下串行执行完全够用，还避免了并发写 vault 的一致性问题。
 *
 * 为什么用 SSE 而不是 WebSocket：只需要单向推送；EventSource 原生自带断线重连、
 * 零依赖；而且 AI SDK 的数据流本身就是 SSE —— 两套流共用一套心智模型。
 * 另外保留一个轮询接口作兜底（见 getJob），SSE 断线时前端可降级。
 */

export type JobHandler = (context: JobContext) => Promise<unknown>;

export type JobContext = {
  jobId: string;
  /** 推送一个事件给所有订阅者，并写入数据库 */
  emit: (event: JobEvent) => void;
  /** 切换阶段并重置该阶段的进度 */
  setStage: (stage: string, message?: string) => void;
  /** 上报阶段内进度，fraction ∈ [0,1] */
  setFraction: (fraction: number, message?: string) => void;
  /** 记录一条人类可读的日志 */
  log: (message: string, level?: "info" | "warning" | "error") => void;
  /** 检查是否已被取消；长循环里应当定期调用 */
  isCancelled: () => boolean;
  /** 抛出即中止任务 */
  throwIfCancelled: () => void;
  /**
   * 取消信号。**必须把它传给在途的 fetch / 模型调用**。
   *
   * 只给 isCancelled() 是不够的：那个判据只在任务自己回到循环顶部时才生效，
   * 而一次 LLM 调用会一口气挂在那儿几分钟 —— 用户点了停止，请求照样发到端点、
   * 照样占着配额跑完，界面上却已经显示「已取消」。那不是停止，是撤回了显示。
   * 把 signal 交给 fetch，取消才是真的把请求掐断。
   */
  signal: AbortSignal;
};

type Subscriber = (event: JobEvent) => void;

type RunningJob = {
  jobId: string;
  abort: AbortController;
  cancelled: boolean;
  /** 这个任务的阶段表。进度换算与阶段名都按它来，见 types.ts */
  stages: JobStageTable;
};

const globalForJobs = globalThis as unknown as {
  __weaveJobs?: {
    queue: Array<{
      jobId: string;
      kind: JobKind;
      payload: unknown;
      handler: JobHandler;
      stages: JobStageTable;
    }>;
    running: RunningJob | null;
    subscribers: Map<string, Set<Subscriber>>;
    /** 每个 job 的最近事件，供新订阅者补历史（刷新页面后不丢进度） */
    replay: Map<string, JobEvent[]>;
  };
};

function state() {
  if (!globalForJobs.__weaveJobs) {
    globalForJobs.__weaveJobs = {
      queue: [],
      running: null,
      subscribers: new Map(),
      replay: new Map(),
    };
  }
  return globalForJobs.__weaveJobs;
}

const REPLAY_LIMIT = 200;

/** 订阅某个任务的实时事件。返回取消订阅的函数。 */
export function subscribe(jobId: string, listener: Subscriber): () => void {
  const s = state();
  const set = s.subscribers.get(jobId) ?? new Set<Subscriber>();
  set.add(listener);
  s.subscribers.set(jobId, set);

  // 补发历史事件：页面刷新后重新连接时，进度不会从零开始
  const history = s.replay.get(jobId) ?? [];
  for (const event of history) {
    try {
      listener(event);
    } catch {
      // 订阅者出错不影响其它订阅者
    }
  }

  return () => {
    set.delete(listener);
    if (set.size === 0) s.subscribers.delete(jobId);
  };
}

function publish(jobId: string, event: JobEvent): void {
  const s = state();
  const history = s.replay.get(jobId) ?? [];
  history.push(event);
  if (history.length > REPLAY_LIMIT) history.shift();
  s.replay.set(jobId, history);

  for (const listener of s.subscribers.get(jobId) ?? []) {
    try {
      listener(event);
    } catch {
      // 单个订阅者出错不影响其它
    }
  }
}

/* ------------------------------------------------------------ 数据库同步 */

function createJobRow(jobId: string, kind: JobKind, payload: unknown): void {
  const now = localISOString();
  getDb()
    .insert(jobs)
    .values({
      id: jobId,
      kind,
      status: "queued",
      // 每张阶段表的第一项都是排队阶段。硬写 "uploaded" 的话，
      // 将来任何一张不以它开头的表都会让新任务一开始就显示 100%
      //（computeProgress 对查不到的阶段名给满，见 types.ts）。
      stage: stagesForKind(kind)[0].stage,
      progress: 0,
      total: 100,
      payloadJson: JSON.stringify(payload ?? null),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function updateJobRow(jobId: string, patch: Partial<typeof jobs.$inferInsert>): void {
  getDb()
    .update(jobs)
    .set({ ...patch, updatedAt: localISOString() })
    .where(eq(jobs.id, jobId))
    .run();
}

/* ------------------------------------------------------------ 入队与执行 */

export type EnqueueOptions = {
  kind: JobKind;
  payload?: unknown;
  handler: JobHandler;
  /** 指定 jobId（导入流水线需要预先告诉前端 id） */
  jobId?: string;
  /** 覆盖阶段表。不传则按 kind 推导 —— 只有测试才需要覆盖它 */
  stages?: JobStageTable;
  /** 恢复已落盘任务，沿用任务标识与上传信息。 */
  resume?: boolean;
};

export function enqueue(options: EnqueueOptions): string {
  const jobId = options.jobId ?? ulid();
  const stages = options.stages ?? stagesForKind(options.kind);
  if (state().running?.jobId === jobId || state().queue.some(job => job.jobId === jobId)) return jobId;
  if (options.resume) {
    const existing = getJob(jobId);
    if (!existing || !["failed", "cancelled"].includes(existing.status)) throw new Error("这个任务无法继续，可能已经完成或正在处理。");
    updateJobRow(jobId, { status: "queued", error: null, finishedAt: null, message: "正在从已保存进度继续" });
    state().replay.delete(jobId);
  } else createJobRow(jobId, options.kind, options.payload);

  state().queue.push({
    jobId,
    kind: options.kind,
    payload: options.payload,
    handler: options.handler,
    stages,
  });
  publish(jobId, { type: "status", status: "queued", stage: stages[0].stage });

  // 下一个 tick 再跑，让调用方先拿到 jobId 去订阅
  queueMicrotask(() => void drain());
  return jobId;
}

async function drain(): Promise<void> {
  const s = state();
  if (s.running || s.queue.length === 0) return;

  const next = s.queue.shift()!;
  const abort = new AbortController();
  s.running = { jobId: next.jobId, abort, cancelled: false, stages: next.stages };

  try {
    updateJobRow(next.jobId, { status: "running", startedAt: localISOString() });
    publish(next.jobId, { type: "status", status: "running", stage: next.stages[0].stage });

    let status: JobStatus = "done";
    let result: unknown = null;
    let errorMessage: string | null = null;

    const context = buildContext(next.jobId, s.running);

    try {
      result = await next.handler(context);
      if (context.isCancelled()) {
        status = "cancelled";
      } else if (isAwaitingReview(result)) {
        status = "awaiting_review";
      }
    } catch (error) {
      if (context.isCancelled()) {
        status = "cancelled";
      } else {
        status = "failed";
        errorMessage = error instanceof Error && error.name === "TimeoutError" ? "模型请求超时，已完成进度已保留。请检查服务状态后继续任务。" : error instanceof Error ? error.message : String(error);
        console.error(`[jobs] 任务 ${next.jobId} 失败：`, error);
      }
    } finally {
      // 估算定时器必须在这里停 —— 它只知道「阶段开始了」，不知道任务已经结束，
      // 不停的话已结束的任务会继续按曲线往上爬，进度条会走过头。
      context.stopTicker();
    }

    const now = localISOString();
    if (status === "awaiting_review") {
      const current = getDb().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, next.jobId)).get();
      // 用户可能在 saveDraft 发布审阅事件后立刻点击了提交/放弃。
      // handler 收尾不能把 HTTP 请求领取的状态覆盖回 awaiting_review。
      if (current?.status === "committing" || current?.status === "discarding" || current?.status === "done" || current?.status === "cancelled") {
        status = current.status as JobStatus;
      }
    }
    updateJobRow(next.jobId, {
      status,
      ...(result !== null ? { resultJson: JSON.stringify(result) } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(isTerminal(status) ? { finishedAt: now, progress: status === "done" ? 100 : undefined } : {}),
    });

    if (errorMessage) publish(next.jobId, { type: "error", message: errorMessage });
    // 真跑完了才把进度补到 100：awaiting_review 不是完成态（还剩「写入知识库」那 17%），
    // 给它发 100 就是撒谎 —— 用户会以为已经入库了。
    if (status === "done") publish(next.jobId, { type: "progress", progress: 100, total: 100 });
    publish(next.jobId, { type: "status", status, stage: context.currentStage() });

  } catch (error) {
    console.error(`[jobs] 任务 ${next.jobId} 收尾失败，保留落盘进度：`, error);
    try { updateJobRow(next.jobId, { status: "failed", error: "任务状态写入失败。进度与草稿已保留，请重启服务后继续。" }); } catch { /* 数据库暂不可用，重启时恢复。 */ }
  } finally {
    s.running = null;
    pruneReplayCache();
    void drain();
  }
}

function isAwaitingReview(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { awaitingReview?: boolean }).awaitingReview);
}

/** 估算进度的推进节拍。够 1% 粒度，又不至于把 SQLite 写穿。 */
const PROGRESS_TICK_MS = 400;

function buildContext(
  jobId: string,
  running: RunningJob,
): JobContext & { currentStage: () => string; stopTicker: () => void } {
  let stage = running.stages[0].stage;
  let fraction = 0;
  /** 本阶段是什么时候开始的 —— 估算曲线的自变量 */
  let stageStartedAt = Date.now();
  /** 上一次推出去的整数百分比。只在它变化时才写库、才发事件 */
  let lastPercent = -1;
  let ticker: ReturnType<typeof setInterval> | null = null;

  /**
   * 当前进度：真实进度与估算进度取较大者。
   *
   * 取 max 而不是「有真实值就用真实值」：真实值只在阶段完成时报一次（1.0），
   * 中间那几分钟是估算在领跑；而阶段刚切换时估算从 0 起步，可能落后于
   * 上一阶段末尾的真实值 —— 取 max 保证进度条永不倒退。
   */
  const currentPercent = (): number => {
    const estimated = estimateStageFraction(stage, Date.now() - stageStartedAt, running.stages);
    // 取整到 1%：估算是连续的小数（每 400ms 动 0.25%），照原样上报会把
    // 一次导入变成三百多条事件、三百多次 SQLite 写入，而界面上根本分不出来。
    // 1% 是用户明确要的颗粒度，也正好是「看得出在走、又不至于刷屏」的平衡点。
    return Math.round(computeProgress(stage, Math.max(fraction, estimated), running.stages));
  };

  const publishProgress = (message?: string) => {
    const percent = currentPercent();
    if (percent === lastPercent && message === undefined) return;
    lastPercent = percent;
    updateJobRow(jobId, { progress: percent, ...(message !== undefined ? { message } : {}) });
    publish(jobId, { type: "progress", progress: percent, total: 100 });
  };

  const stopTicker = () => {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  const startTicker = () => {
    stopTicker();
    // unref：这个定时器不该拖住进程退出（测试与 next build 都会因此挂住）
    ticker = setInterval(() => {
      try {
        publishProgress();
      } catch {
        // 路径出错不影响任务本身
      }
    }, PROGRESS_TICK_MS);
    (ticker as unknown as { unref?: () => void }).unref?.();
  };

  const setStage = (next: string, message?: string) => {
    stage = next;
    fraction = 0;
    stageStartedAt = Date.now();
    lastPercent = -1;
    updateJobRow(jobId, { stage: next, message: message ?? null });
    publish(jobId, {
      type: "stage",
      stage: next,
      label: stageLabel(next, running.stages),
      ...(message ? { message } : {}),
    });
    // 阶段一开跑就把进度条推到这个阶段的起点，别让用户等到第一次 tick
    publishProgress(message);
    startTicker();
  };

  const setFraction = (nextFraction: number, message?: string) => {
    fraction = Math.max(0, Math.min(1, nextFraction));
    // 用阶段权重换算成整体百分比，避免进度条在阶段切换时跳变
    publishProgress(message);
  };

  return {
    jobId,
    currentStage: () => stage,
    stopTicker,
    signal: running.abort.signal,
    emit: (event) => publish(jobId, event),
    setStage,
    setFraction,
    log: (message, level = "info") => publish(jobId, { type: "log", message, level }),
    isCancelled: () => running.cancelled || running.abort.signal.aborted,
    throwIfCancelled: () => {
      if (running.cancelled || running.abort.signal.aborted) {
        throw new JobCancelledError();
      }
    },
  };
}

export class JobCancelledError extends Error {
  constructor() {
    super("任务已取消");
    this.name = "JobCancelledError";
  }
}

/**
 * 取消的结果。
 *
 * 返回布尔值是不够的：调用方拿到 false 之后没法区分「这个任务早就结束了」
 * 和「根本没有这个 id」，而这两件事对用户要说的话完全不同。**状态必须如实反映现实**，
 * 包括「你点的这个停止没能生效」这件事。
 */
export type CancelOutcome = "cancelled" | "not-running" | "not-found";

/**
 * 取消一个任务。排队中的直接移除，运行中的打标记 + abort 由任务自己退出。
 *
 * abort 只对**在途的 IO** 有效（模型请求、文档解析）；纯粹的计算代码跑完手上的
 * 那一小段才会看到取消标记。所以真正的事务性写入（导入的提交、修订的落盘）
 * 一旦开始就不会被腰斩 —— 半途停下比跑完更糟。
 */
export function cancel(jobId: string): CancelOutcome {
  const s = state();

  const queuedIndex = s.queue.findIndex((j) => j.jobId === jobId);
  if (queuedIndex >= 0) {
    s.queue.splice(queuedIndex, 1);
    updateJobRow(jobId, { status: "cancelled", finishedAt: localISOString() });
    publish(jobId, { type: "status", status: "cancelled", stage: "uploaded" });
    return "cancelled";
  }

  if (s.running?.jobId === jobId) {
    s.running.cancelled = true;
    s.running.abort.abort();
    return "cancelled";
  }

  // 内存里找不到：要么这个 id 压根不存在，要么它已经结束了
  return getDb().select().from(jobs).where(eq(jobs.id, jobId)).get() ? "not-running" : "not-found";
}

/* ------------------------------------------------------------ 查询接口 */

export type JobView = {
  id: string;
  kind: string;
  status: JobStatus;
  stage: string;
  stageLabel: string;
  progress: number;
  message: string | null;
  error: string | null;
  /** 入队时带的载荷（导入任务里是文件名）。刷新后靠它把任务显示成人话 */
  payload: unknown;
  result: unknown;
  draft: unknown;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export function getJob(jobId: string): JobView | null {
  const row = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!row) return null;
  return toView(row);
}

export function listJobs(
  limit = 30,
  filters: { kind?: JobKind; activeOnly?: boolean } = {},
): JobView[] {
  return getDb()
    .select()
    .from(jobs)
    .all()
    .filter((row) => (filters.kind ? row.kind === filters.kind : true))
    .filter((row) => (filters.activeOnly ? !isTerminal(row.status as JobStatus) : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map(toView);
}

export function hasActiveJobs(): boolean {
  return Boolean(
    getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running", "committing", "discarding"]))
      .limit(1)
      .get(),
  );
}

/** 找出上次被中断的任务（进程被杀时留下的 running 状态），供启动时提示 */
export function findInterruptedJobs(): JobView[] {
  return getDb()
    .select()
    .from(jobs)
    .all()
    .filter((row) => row.status === "running" || row.status === "queued" || row.status === "committing" || row.status === "discarding" || (row.status === "failed" && row.kind === "ingest" && Boolean(row.draftJson)))
    .map(toView);
}

/** 把中断的任务标记出来，让用户知道可以重试 */
export function markInterruptedAsFailed(): number {
  const interrupted = getDb()
    .select()
    .from(jobs)
    .all()
    .filter((row) => row.status === "running" || row.status === "queued" || row.status === "committing" || row.status === "discarding" || (row.status === "failed" && row.kind === "ingest" && Boolean(row.draftJson)))
    .map(toView);
  for (const job of interrupted) {
    if (job.kind === "review_batch") getDb().update(reviewItems).set({ batchId: null }).where(eq(reviewItems.batchId, job.id)).run();
    if (job.kind === "ingest" && job.draft && (job.status === "committing" || job.status === "discarding" || job.status === "failed")) {
      updateJobRow(job.id, {
        status: "awaiting_review",
        stage: "reviewing",
        message: "上次进程在写入期间退出。草稿已保留，请检查冲突后继续处理。",
        error: "上次写入未确认完成；提交前会重新检查所有目标。",
        finishedAt: null,
      });
    } else {
      updateJobRow(job.id, {
        status: "failed",
        error: "进程在任务执行期间退出，任务被中断。可以重新导入。",
        finishedAt: localISOString(),
      });
    }
  }
  getDb().update(sources).set({ status: "pending" }).where(eq(sources.status, "parsing")).run();
  return interrupted.length;
}

/** 原子领取待审草稿，防止重复提交或并发提交/放弃。 */
export function claimAwaitingReview(jobId: string, operation: "committing" | "discarding"): boolean {
  const now = localISOString();
  const result = getSqlite().prepare(
    "UPDATE jobs SET status = ?, stage = ?, updated_at = ?, message = ? WHERE id = ? AND status = 'awaiting_review' AND draft_json IS NOT NULL",
  ).run(operation, operation, now, operation === "committing" ? "正在写入知识库" : "正在放弃草稿", jobId);
  if (result.changes === 0) return false;
  publish(jobId, { type: "status", status: operation, stage: operation });
  return true;
}

/** 失败且尚未完成时释放领取状态，保留草稿供用户解决冲突后重试。 */
export function releaseAwaitingReview(jobId: string, message?: string): void {
  const now = localISOString();
  const result = getSqlite().prepare(
    "UPDATE jobs SET status = 'awaiting_review', stage = 'reviewing', updated_at = ?, message = ? WHERE id = ? AND status IN ('committing', 'discarding') AND draft_json IS NOT NULL",
  ).run(now, message ?? null, jobId);
  if (result.changes > 0) {
    publish(jobId, { type: "status", status: "awaiting_review", stage: "reviewing" });
  }
}

/**
 * 由任务之外的一方收尾一个任务。
 *
 * 导入的「提交」与「放弃」都发生在 HTTP 请求里（用户点了按钮），而不是任务体内 ——
 * 任务早在 awaiting_review 就停住了。不收尾的话那一行永远停在 awaiting_review，
 * 于是每次页面刷新，「还有一份草稿等你审阅」都会被重新发现一遍：
 * 用户明明已经确认写入了，指示器还在催他。**状态必须如实反映现实**。
 */
export function finishJob(
  jobId: string,
  patch: { status: JobStatus; stage?: string; message?: string | null; progress?: number; clearDraft?: boolean },
): void {
  const now = localISOString();
  updateJobRow(jobId, {
    status: patch.status,
    ...(patch.stage ? { stage: patch.stage } : {}),
    ...(patch.message !== undefined ? { message: patch.message } : {}),
    ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
    ...(patch.clearDraft ? { draftJson: null } : {}),
    finishedAt: isTerminal(patch.status) ? now : null,
  });
  const row = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get();
  publish(jobId, { type: "status", status: patch.status, stage: patch.stage ?? row?.stage ?? "reviewing" });
}

/** 保存审阅草稿 —— 用户确认前，LLM 的产出停在这里，不落盘 */
export function saveDraft(jobId: string, draft: unknown): void {
  updateJobRow(jobId, { draftJson: JSON.stringify(draft), status: "awaiting_review", stage: "reviewing" });
  publish(jobId, { type: "status", status: "awaiting_review", stage: "reviewing" });
}

export function readDraft<T>(jobId: string): T | null {
  const row = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!row?.draftJson) return null;
  try {
    return JSON.parse(row.draftJson) as T;
  } catch {
    return null;
  }
}

/** 清理已结束任务的内存事件缓存，避免长期运行后内存增长 */
export function pruneReplayCache(keep = 50): void {
  const s = state();
  if (s.replay.size <= keep) return;
  const entries = [...s.replay.keys()];
  for (const key of entries.slice(0, entries.length - keep)) {
    if (!s.subscribers.has(key)) s.replay.delete(key);
  }
}

function toView(row: typeof jobs.$inferSelect): JobView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as JobStatus,
    stage: row.stage,
    stageLabel: stageLabel(row.stage, stagesForKind(row.kind)),
    progress: row.progress,
    message: row.message,
    error: row.error,
    payload: safeParse(row.payloadJson),
    result: safeParse(row.resultJson),
    draft: safeParse(row.draftJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
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
