"use client";

import * as React from "react";
import { apiFetch } from "@/hooks/use-api";
import { type ChangePlanView } from "@/components/review/plan-confirm-panel";
import { computeProgress, estimateStageFraction } from "@/lib/jobs/types";
import { useReviewAutosave } from "./use-review-autosave";

/**
 * 导入任务的状态宿主。
 *
 * 为什么任务状态必须住在抽屉**外面**：一次导入是分钟级的，而用户不该被扣在
 * 那个界面里。抽屉只是个视图，开关它不该中断导入 —— 所以 SSE 订阅、任务 id、
 * 进度、草稿全在这里，抽屉只负责画。
 *
 * 三件事因此成立：
 *   ① 关掉抽屉 = 关掉视图，任务照跑；
 *   ② 重新打开时进度、日志、草稿原样还在（状态从没被销毁过）；
 *   ③ **刷新页面也不丢** —— 任务状态本来就落在 SQLite 的 jobs 表里，
 *      重新挂载时用 /api/jobs?active=1 认回来，接着订阅。
 */

type Phase = "idle" | "running" | "review" | "done" | "duplicate";

export type IngestQueueItem = {
  id: string;
  originalName: string;
  byteSize: number;
  status: "queued" | "processing" | "awaiting_review" | "failed" | "paused";
  jobId: string | null;
  error: string | null;
  createdAt: string;
};

export type LogEntry = { message: string; level: "info" | "warning" | "error" };

type JobEvent =
  | { type: "status"; status: string; stage: string }
  | { type: "stage"; stage: string; label: string; message?: string }
  | { type: "progress"; progress: number; total: number }
  | { type: "delta"; text: string }
  | { type: "log"; message: string; level?: "info" | "warning" | "error" }
  | { type: "error"; message: string }
  | { type: "done" };

type JobView = {
  id: string;
  kind: string;
  status: string;
  stage: string;
  stageLabel: string;
  progress: number;
  message: string | null;
  error: string | null;
  payload: { fileName?: string } | null;
  createdAt: string;
};

export type DuplicateInfo = {
  kind: "exact" | "similar";
  existingName: string;
  existingId: string;
  importedAt: string;
};

export type DraftPage = {
  type: string;
  title: string;
  summary: string;
  content: string;
  aliases: string[];
  tags: string[];
  confidence: "high" | "medium" | "low";
  citations: Array<{ page: number | null; quote: string }>;
};

export type DraftUpdate = {
  title: string;
  reason: string;
  proposedContent?: string;
  originalContent?: string;
  expectedHash?: string;
  appendContent: string;
  addAliases: string[];
  addTags: string[];
  citations: Array<{ page: number | null; quote: string }>;
};

export type DraftReviewItem = {
  kind: string;
  title: string;
  detail: string;
  severity: string;
  relatedTitles: string[];
  /** 系统提的问题与候选答案。两者同时为空 = 没有值得拍板的问题，退回旧交互 */
  question?: string;
  options?: Array<{ id: string; label: string; impact: string }>;
};

export type Draft = {
  sourceSummary: { title: string; content: string };
  newPages: DraftPage[];
  updatedPages: DraftUpdate[];
  reviewItems: DraftReviewItem[];
};

export type IngestDraft = {
  jobId: string;
  source: { docPath: string; originalName: string; pageCount: number | null; parser: string };
  analysis: {
    gist: string;
    entities: Array<{ name: string; type: string }>;
    concepts: Array<{ name: string }>;
    contradictions: Array<{ existing: string; claim: string; conflict: string }>;
  };
  draft: Draft;
  warnings: string[];
  upgradeHint: string | null;
  sourceSummarySnapshot?: { pageId: string; expectedHash: string };
  reviewRevision?: number;
  reviewState?: { skippedTitles: string[]; decisions: Array<[number, ReviewDecisionDraft]> };
};

/**
 * 用户在草稿上对一条事项做过的事。
 *
 * 裁决与回答是两件独立的事，都可能只发生一半：只回答不裁决的条目会落成
 * answered 等模型处理；只裁决不回答的按老路子直接结案。
 */
export type ReviewDecisionDraft = {
  decision?: "accepted" | "dismissed";
  note: string;
  answer: string;
  choiceId: string | null;
};

export type CommitResult = {
  createdPages: Array<{ id: string; title: string; path: string }>;
  updatedPages: Array<{ id: string; title: string; addedChars: number }>;
  reviewItemCount: number;
  /** 接着起的那批回答处理任务。null = 这次没有回答，或者没配模型 */
  batchJobId: string | null;
  commitSha: string | null;
  conflicts: string[];
};

type IngestValue = {
  /** 抽屉是否展开。与任务状态无关 —— 关掉它任务照跑 */
  open: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;

  phase: Phase;
  fileName: string | null;
  progress: number;
  stage: string;
  stageLabel: string;
  message: string | null;
  /** 任务开始的时间戳，用来显示「已用 1 分 12 秒」 */
  startedAt: number | null;
  logs: LogEntry[];
  error: string | null;
  duplicate: DuplicateInfo | null;

  draft: IngestDraft | null;
  draftSaveStatus: string;
  draftSaveError: string | null;
  retryDraftSave: () => Promise<void>;
  reloadSavedDraft: () => Promise<void>;
  /** 这份草稿是「之前那次导入」留下的，不是刚刚上传的 */
  recovered: boolean;
  skipped: Set<string>;
  decisions: Map<number, ReviewDecisionDraft>;
  committing: boolean;
  commitProgress: number;
  result: CommitResult | null;

  /** 停止这次导入。服务端会掐断在途的模型调用，见 lib/jobs/runner.ts#cancel */
  stopping: boolean;
  /**
   * 一条中性提示（不是错误）。
   *
   * 停止导入之后总要说一句「原件还在，可以重来」—— 那句话放进 error 里会被
   * 红框渲染成一次失败，而停止是用户主动做的决定，不该被当成出错了。
   */
  notice: string | null;
  dismissNotice: () => void;
  stop: () => Promise<void>;

  start: (file: File) => Promise<void>;
  queueFiles: (files: File[]) => Promise<boolean>;
  queuedCount: number;
  queueItems: IngestQueueItem[];
  queueUploading: boolean;
  removeQueueItem: (id: string) => Promise<void>;
  continueQueue: () => void;
  /** 认领服务端已创建的重新处理任务 */
  adoptExistingJob: (jobId: string, fileName: string) => void;
  toggleSkip: (title: string) => void;
  removePage: (index: number) => void;
  decide: (index: number, decision: "accepted" | "dismissed", note: string) => void;
  /** 记下一条回答。它随「确认写入」一起提交，提交之后由模型接着处理 */
  answer: (index: number, answer: string, choiceId: string | null) => void;
  /** 提交之后接着跑的那批回答。它跟在这个抽屉里，不跳页 */
  batchJobId: string | null;
  batchStage: string;
  batchProgress: number;
  /** 挂起中的破坏性操作方案。非 null 时抽屉里显示确认面板 */
  batchPlan: ChangePlanView | null;
  batchBusy: boolean;
  applyBatchPlan: (approved: string[]) => Promise<void>;
  cancelBatchPlan: () => Promise<void>;
  updateDraft: (next: Draft) => void;
  commit: () => Promise<CommitResult>;
  discard: () => Promise<void>;
  dismissError: () => void;
};

const IngestContext = React.createContext<IngestValue | null>(null);

export function useIngest(): IngestValue {
  const value = React.useContext(IngestContext);
  if (!value) throw new Error("useIngest 必须在 IngestProvider 内使用");
  return value;
}

export function IngestProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [recovered, setRecovered] = React.useState(false);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState(0);
  const [stage, setStage] = React.useState("uploaded");
  const [stageLabel, setStageLabel] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const [startedAt, setStartedAt] = React.useState<number | null>(null);
  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [duplicate, setDuplicate] = React.useState<DuplicateInfo | null>(null);
  const [draft, setDraft] = React.useState<IngestDraft | null>(null);
  const [skipped, setSkipped] = React.useState<Set<string>>(new Set());
  const [decisions, setDecisions] = React.useState<Map<number, ReviewDecisionDraft>>(new Map());
  const { restore: restoreReview, flush: flushReview, forget: forgetReview, getRevision: getReviewRevision, status: draftSaveStatus, error: draftSaveError } = useReviewAutosave(phase === "review", jobId, draft, skipped, decisions);
  /**
   * 提交之后接着跑的那批回答。
   *
   * 它跟在这个抽屉里、不跳页 —— 用户在草稿上答完题，期待的是「确认写入」之后
   * 一路跑完，而不是被丢到另一个页面去看进度。
   */
  const [batchJobId, setBatchJobId] = React.useState<string | null>(null);
  const [batchStage, setBatchStage] = React.useState("");
  const [batchProgress, setBatchProgress] = React.useState(0);
  const [batchPlan, setBatchPlan] = React.useState<ChangePlanView | null>(null);
  const [batchBusy, setBatchBusy] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  /** 正在上传的那次 fetch。任务 id 到手之前，停止按钮掐的就是它 */
  const uploadAbortRef = React.useRef<AbortController | null>(null);
  const [commitProgress, setCommitProgress] = React.useState(0);
  const [result, setResult] = React.useState<CommitResult | null>(null);
  const [queueItems, setQueueItems] = React.useState<IngestQueueItem[]>([]);
  const [queueUploading, setQueueUploading] = React.useState(false);
  const queueUploadRef = React.useRef(false);
  const queueStartRef = React.useRef(false);
  const queuedCount = queueItems.filter((item) => item.status === "queued" || item.status === "failed" || item.status === "paused").length;

  const appendLog = React.useCallback((entry: LogEntry) => {
    setLogs((prev) => (prev.length > 400 ? [...prev.slice(-400), entry] : [...prev, entry]));
  }, []);

  const refreshQueue = React.useCallback(async () => {
    const data = await apiFetch<{ items: IngestQueueItem[] }>("/api/ingest/queue");
    setQueueItems(data.items);
    return data.items;
  }, []);

  React.useEffect(() => {
    void refreshQueue().catch(() => undefined);
  }, [refreshQueue]);

  /**
   * 认领一个任务（新上传的、或刷新后捞回来的）。
   * 重置一切属于「上一次导入」的状态，只保留这次任务自己的信息。
   */
  const adoptJob = React.useCallback((id: string, name: string | null) => {
    setJobId(id);
    setFileName(name);
    setDraft(null);
    setSkipped(new Set());
    setDecisions(new Map());
    setResult(null);
    setDuplicate(null);
    setError(null);
    setNotice(null);
    setRecovered(false);
    setLogs([]);
    setMessage(null);
    setProgress(0);
    setStage("uploaded");
    setStageLabel("正在准备");
    setStartedAt(Date.now());
    setPhase("running");
  }, []);

  const adoptExistingJob = React.useCallback((id: string, name: string) => {
    setOpen(true);
    adoptJob(id, name);
  }, [adoptJob]);

  const loadDraft = React.useCallback(
    async (id: string, ignoreLocal = false) => {
      try {
        const job = await apiFetch<{ draft: IngestDraft | null }>(`/api/jobs/${id}`);
        if (job.draft) {
          // Persisted drafts can predate relatedTitles; normalize them at the API boundary
          // so every consumer can treat the field as an array.
          const loadedDraft = {
            ...job.draft,
            draft: {
              ...job.draft.draft,
              reviewItems: job.draft.draft.reviewItems.map((item) => ({
                ...item,
                relatedTitles: item.relatedTitles ?? [],
              })),
            },
          };
          const restored = restoreReview(loadedDraft, ignoreLocal);
          setDraft({ ...loadedDraft, draft: restored.draft });
          setSkipped(new Set(restored.reviewState.skippedTitles));
          setDecisions(new Map(restored.reviewState.decisions));
          setFileName(loadedDraft.source.originalName);
          setPhase("review");
        } else {
          setError("草稿没找到 —— 它可能已经被提交或放弃了。");
          setPhase("idle");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("idle");
      }
    },
    [restoreReview],
  );

  /* -------------------------------------------------- 后台任务：SSE + 轮询兜底 */

  React.useEffect(() => {
    if (!jobId || phase !== "running") return;

    const source = new EventSource(`/api/jobs/${jobId}/stream`);
    let finished = false;
    let disposed = false;
    const pollAbort = new AbortController();

    const settle = async (status: string, jobError: string | null) => {
      if (finished) return;
      finished = true;
      source.close();
      void refreshQueue().catch(() => undefined);
      if (status === "awaiting_review") {
        setProgress(computeProgress("reviewing", 1));
        setStage("reviewing");
        setStageLabel("等待你审阅");
        await loadDraft(jobId);
      } else if (status === "failed") {
        setJobId(null);
        setError(previous => jobError ?? previous ?? "这次导入没有完成。进度已保存，点击继续处理队列即可接着导入。");
        setPhase("idle");
      } else if (status === "cancelled") {
        // 停成了。任务 id 必须清掉 —— 留着的话「认领还没跑完的任务」会以为
        // 手上还有一个任务，之后新上传的导入不会被它接管，界面就卡死了。
        setJobId(null);
        setPhase("idle");
        setNotice("这次导入已暂停，资料与已完成进度已保留，点击继续处理队列即可接着导入；已经保存到 raw/ 的原件也会保留。");
        appendLog({ message: "已停止这次导入。", level: "warning" });
      } else if (status === "done") {
        // 任务正常结束却没有草稿 = 查重命中，原件已在库里
        try {
          const job = await apiFetch<{ result: { duplicate?: DuplicateInfo } | null }>(`/api/jobs/${jobId}`);
          if (job.result?.duplicate) {
            setDuplicate(job.result.duplicate);
            setPhase("duplicate");
            return;
          }
        } catch {
          // 读不到就当普通结束处理
        }
        setPhase("idle");
      }
    };

    source.onmessage = (event) => {
      let payload: JobEvent;
      try {
        payload = JSON.parse(event.data) as JobEvent;
      } catch {
        return;
      }

      switch (payload.type) {
        case "stage":
          setStage(payload.stage);
          setStageLabel(payload.label);
          setMessage(payload.message ?? null);
          appendLog({ message: payload.label, level: "info" });
          break;
        case "progress":
          setProgress(payload.progress);
          break;
        case "log":
          appendLog({ message: payload.message, level: payload.level ?? "info" });
          break;
        case "error":
          setError(payload.message);
          break;
        case "status":
          if (payload.stage) setStage(payload.stage);
          if (["awaiting_review", "failed", "cancelled", "done"].includes(payload.status)) {
            void settle(payload.status, null);
          }
          break;
        case "done":
          if (!finished) void settle("done", null);
          break;
      }
    };

    // SSE 断线（服务重启、网络抖动）时降级为轮询 —— 任务其实还在跑
    source.onerror = () => {
      source.close();
      if (finished) return;
      void (async () => {
        while (!disposed && !finished) {
          await new Promise((r) => setTimeout(r, 1000));
          if (finished || disposed) return;
          try {
            const job = await apiFetch<JobView>(`/api/jobs/${jobId}`, { signal: pollAbort.signal });
            if (disposed) return;
            setProgress(job.progress);
            setStage(job.stage);
            setStageLabel(job.stageLabel);
            setMessage(job.message);
            if (["awaiting_review", "failed", "cancelled", "done"].includes(job.status)) {
              await settle(job.status, job.error);
              return;
            }
          } catch {
            // 网络还没恢复，继续轮询
          }
        }
      })();
    };

    return () => { disposed = true; pollAbort.abort(); source.close(); };
  }, [jobId, phase, appendLog, loadDraft, refreshQueue]);

  /* ------------------------------------------- 把没跑完的任务认回来（含刷新后） */

  const phaseRef = React.useRef(phase);
  const jobIdRef = React.useRef(jobId);
  React.useLayoutEffect(() => { phaseRef.current = phase; jobIdRef.current = jobId; }, [phase, jobId]);

  /**
   * 认领一个还没结束的导入任务。
   *
   * 两个时机都要查：**挂载时**（刷新页面/重开标签页，任务状态在库里，不查就丢了）
   * 和**打开抽屉时**（上一份草稿处理完之后，后面可能还排着一份 —— 只查一次的话
   * 第二份要等到下次刷新才会冒出来）。
   *
   * 只在「手上没有任务」时才认领，绝不打断正在跑的那一个。
   */
  const recoverActiveJob = React.useCallback(async () => {
    if (jobIdRef.current !== null || phaseRef.current === "running" || phaseRef.current === "review") {
      return;
    }
    try {
      const data = await apiFetch<{ jobs: JobView[] }>("/api/jobs?active=1&kind=ingest");
      const job = data.jobs[0];
      if (!job) return;
      setJobId(job.id);
      setFileName(job.payload?.fileName ?? null);
      setProgress(job.progress);
      setStage(job.stage);
      setStageLabel(job.stageLabel);
      setMessage(job.message);
      setStartedAt(new Date(job.createdAt).getTime());
      setRecovered(true);
      // 交给上面那个 effect 重新订阅 / 拉草稿：awaiting_review 的任务也先在
      // running 相里停一拍，settle 会立刻把它推进到审阅相
      setPhase("running");
    } catch {
      // 认领失败不影响任何事：用户重新导入即可
    }
  }, []);

  React.useEffect(() => {
    void recoverActiveJob();
  }, [recoverActiveJob]);

  React.useEffect(() => {
    if (open) void recoverActiveJob();
  }, [open, recoverActiveJob]);

  /* ------------------------------------------------------------- 上传与动作 */

  const start = React.useCallback(
    async (file: File) => {
      adoptJob("", file.name);
      setStageLabel("正在上传");
      appendLog({ message: `正在上传 ${file.name}`, level: "info" });
      // 这次上传的 fetch。停止按钮在上传期间掐的就是它
      const uploadController = new AbortController();
      uploadAbortRef.current = uploadController;

      try {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/ingest", {
          method: "POST",
          body: form,
          signal: uploadController.signal,
        });
        const payload = await response.json();
        if (!payload.ok) {
          setError(payload.error);
          setPhase("idle");
          return;
        }
        setJobId(payload.data.jobId);
      } catch (err) {
        if (uploadController.signal.aborted) {
          // 用户按的停止，不是出错 —— 别用红框说它
          setPhase("idle");
          setNotice("这次上传已取消，服务端没有产生任何记录。");
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setPhase("idle");
      } finally {
        if (uploadAbortRef.current === uploadController) uploadAbortRef.current = null;
      }
    },
    [adoptJob, appendLog],
  );

  const startQueuedItem = React.useCallback(async () => {
    if (queueStartRef.current) return;
    queueStartRef.current = true;
    try {
      const items = await refreshQueue();
      const active = items.find(item => item.jobId && ["processing", "awaiting_review"].includes(item.status));
      if (active?.jobId) { setOpen(true); adoptJob(active.jobId, active.originalName); return; }
      const next = items.find((item) => item.status === "queued" || item.status === "failed" || item.status === "paused");
      if (!next) {
        setPhase("idle");
        setJobId(null);
        setFileName(null);
        setResult(null);
        setDuplicate(null);
        return;
      }

      const started = await apiFetch<{ jobId: string; fileName: string }>(
        `/api/ingest/queue/${next.id}/start`,
        { method: "POST" },
      );
      setOpen(true);
      adoptJob(started.jobId, started.fileName);
      await refreshQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshQueue().catch(() => undefined);
    } finally {
      queueStartRef.current = false;
    }
  }, [adoptJob, refreshQueue]);

  const queueFiles = React.useCallback(async (files: File[]): Promise<boolean> => {
    if (files.length === 0 || queueUploadRef.current) return false;
    queueUploadRef.current = true;
    setQueueUploading(true);
    setOpen(true);
    setError(null);
    const failures: string[] = [];

    try {
      for (const file of files) {
        try {
          const form = new FormData();
          form.append("file", file);
          const response = await fetch("/api/ingest/queue", { method: "POST", body: form });
          const payload = await response.json();
          if (!payload.ok) throw new Error(payload.error ?? "上传没有完成。");
        } catch (err) {
          failures.push(`${file.name}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      let items: IngestQueueItem[];
      try {
        items = await refreshQueue();
      } catch {
        setError("文件已上传，但队列状态暂时无法更新。刷新页面后可以继续处理。");
        return failures.length === 0;
      }
      if (failures.length > 0) {
        setError(failures.slice(0, 3).join("\n") + (failures.length > 3 ? `\n另有 ${failures.length - 3} 份上传失败。` : ""));
      }

      if (phaseRef.current === "idle" || phaseRef.current === "done" || phaseRef.current === "duplicate") {
        if (items.some((item) => item.status === "queued" || item.status === "failed" || item.status === "paused")) {
          await startQueuedItem();
        }
      }
      if (failures.length > 0) setError(failures.slice(0, 3).join("\n"));
      return failures.length === 0;
    } finally {
      queueUploadRef.current = false;
      setQueueUploading(false);
    }
  }, [refreshQueue, startQueuedItem]);

  const continueQueue = React.useCallback(() => {
    void startQueuedItem();
  }, [startQueuedItem]);

  const removeQueueItem = React.useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/ingest/queue/${id}`, { method: "DELETE" });
      await refreshQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshQueue]);

  const toggleSkip = React.useCallback((title: string) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }, []);

  const removePage = React.useCallback((index: number) => {
    setDraft((prev) =>
      prev
        ? { ...prev, draft: { ...prev.draft, newPages: prev.draft.newPages.filter((_, i) => i !== index) } }
        : prev,
    );
  }, []);

  /** 改一条事项上的任意字段。裁决与回答走同一个入口，免得两边互相覆盖 */
  const patchDecision = React.useCallback(
    (index: number, patch: Partial<ReviewDecisionDraft>) => {
      setDecisions((prev) => {
        const next = new Map(prev);
        const current = next.get(index) ?? { note: "", answer: "", choiceId: null };
        next.set(index, { ...current, ...patch });
        return next;
      });
    },
    [],
  );

  /** 跟着批量任务走。与体检页那份是同一套轮询，只是结果留在这个抽屉里 */
  React.useEffect(() => {
    if (!batchJobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (stopped) return;
      try {
        const job = await apiFetch<{
          status: string;
          stageLabel: string | null;
          progress: number;
          error: string | null;
          draft: ChangePlanView | null;
        }>(`/api/jobs/${batchJobId}`);
        if (stopped) return;

        setBatchProgress(job.progress ?? 0);
        setBatchStage(job.stageLabel ?? "");

        if (job.status === "awaiting_review") {
          setBatchPlan(job.draft);
          return; // 停下等用户确认
        }
        if (["done", "failed", "cancelled"].includes(job.status)) {
          setBatchJobId(null);
          setBatchPlan(null);
          if (job.error) setError(job.error);
          return;
        }
        timer = setTimeout(tick, 1000);
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error ? err.message : String(err));
        setBatchStage("连接暂时中断，正在重连；后台处理仍在继续");
        timer = setTimeout(tick, 3000);
      }
    };

    timer = setTimeout(tick, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [batchJobId]);

  const applyBatchPlan = React.useCallback(
    async (approved: string[]) => {
      if (!batchJobId) return;
      setBatchBusy(true);
      try {
        await apiFetch(`/api/review/batch/${batchJobId}/apply`, {
          method: "POST",
          body: JSON.stringify({ approve: approved }),
        });
        setBatchPlan(null);
        setBatchJobId(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBatchBusy(false);
      }
    },
    [batchJobId],
  );

  const cancelBatchPlan = React.useCallback(async () => {
    if (!batchJobId) return;
    setBatchBusy(true);
    try {
      await apiFetch(`/api/review/batch/${batchJobId}/cancel`, { method: "POST" });
      setBatchPlan(null);
      setBatchJobId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBatchBusy(false);
    }
  }, [batchJobId]);

  const decide = React.useCallback(
    (index: number, decision: "accepted" | "dismissed", note: string) =>
      patchDecision(index, { decision, note }),
    [patchDecision],
  );

  const answer = React.useCallback(
    (index: number, value: string, choiceId: string | null) =>
      patchDecision(index, { answer: value, choiceId }),
    [patchDecision],
  );

  const updateDraft = React.useCallback((next: Draft) => {
    setDraft((prev) => (prev ? { ...prev, draft: next } : prev));
  }, []);

  const commit = React.useCallback(async () => {
    if (!draft || !jobId) throw new Error("还没有可以写入的草稿。");

    setCommitting(true);
    setError(null);
    // 最后 17% 是「建页 + 重建索引 + git 提交」，同样拿不到中间进度，
    // 用与后台任务**同一条**估算曲线推进 —— 两处一致，用户看到的进度语言才统一
    const commitStartedAt = Date.now();
    setCommitProgress(computeProgress("committing", 0));
    const timer = setInterval(() => {
      setCommitProgress(
        computeProgress("committing", estimateStageFraction("committing", Date.now() - commitStartedAt)),
      );
    }, 400);

    try {
      await flushReview();
      const edited: Draft = {
        ...draft.draft,
        newPages: draft.draft.newPages.filter((p) => !skipped.has(p.title)),
        updatedPages: draft.draft.updatedPages.filter((p) => !skipped.has(p.title)),
      };
      const response = await apiFetch<CommitResult>(`/api/ingest/${jobId}/commit`, {
        method: "POST",
        body: JSON.stringify({
          draft: edited,
          reviewRevision: getReviewRevision(),
          // 当场裁决过的随草稿一起落库；只回答了没裁决的落成 answered，
          // 提交之后**接着**由同一个任务链交给模型处理；什么都没做的留 pending
          // 进体检队列 —— 三条路都要通，用户可能在这里就看得明白，也可能想攒着。
          decisions: [...decisions.entries()].flatMap(([index, value]) => {
            const note = value.note.trim();
            const text = value.answer.trim();
            if (!value.decision && !text) return [];
            return [{
              index,
              ...(value.decision ? { decision: value.decision } : {}),
              ...(note ? { note } : {}),
              ...(text ? { answer: text } : {}),
              ...(value.choiceId ? { choiceId: value.choiceId } : {}),
            }];
          }),
        }),
      });
      await refreshQueue().catch(() => undefined);
      forgetReview(jobId);
      setResult(response);
      setCommitProgress(100);
      setPhase("done");
      setJobId(null);
      // 有回答的话，同一个抽屉里接着跟它跑
      if (response.batchJobId) {
        setBatchJobId(response.batchJobId);
        setBatchProgress(0);
        setBatchStage("");
      }
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      clearInterval(timer);
      setCommitting(false);
    }
  }, [draft, jobId, skipped, decisions, refreshQueue, flushReview, forgetReview, getReviewRevision]);

  /**
   * 停止这次导入。
   *
   * 这里**不直接改 phase**：停止是异步生效的 —— 服务端 abort 之后，任务要在
   * 下一个 await 点才会退出，SSE 随后推来 cancelled。所以这一端只负责发出请求，
   * 界面的收尾一律由那一条真实状态驱动。自己抢先改成 idle 的话，服务端还在跑、
   * 界面已经说停了，两边就此不一致。
   */
  const stop = React.useCallback(async () => {
    // 上传还没结束：任务 id 还没到手，此刻能停的是这次上传本身。
    //
    // 早先这里是 `if (!jobId) return;` —— 静默返回。用户在「正在上传」时点停止，
    // 界面上一个像素都不会变，看起来就是**点了没反应**。上传一个 200MB 的 PDF
    // 要几十秒，那段时间正好是最想反悔的时候。
    if (!jobId) {
      if (uploadAbortRef.current) {
        uploadAbortRef.current.abort();
        appendLog({ message: "已取消这次上传。", level: "warning" });
      }
      return;
    }
    setStopping(true);
    setError(null);
    try {
      await apiFetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      appendLog({ message: "正在停止…", level: "warning" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }, [jobId, appendLog]);

  const discard = React.useCallback(async () => {
    if (jobId) {
      try {
        await flushReview().catch(() => undefined);
        await apiFetch(`/api/ingest/${jobId}/discard`, { method: "POST" });
        forgetReview(jobId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "放弃未完成，草稿仍然保留。");
        return;
      }
    }
    await refreshQueue().catch(() => undefined);
    setJobId(null);
    setPhase("idle");
    setDraft(null);
  }, [jobId, refreshQueue, flushReview, forgetReview]);

  const value = React.useMemo<IngestValue>(
    () => ({
      open,
      openDrawer: () => setOpen(true),
      closeDrawer: () => setOpen(false),
      phase,
      fileName,
      progress,
      stage,
      stageLabel,
      message,
      startedAt,
      logs,
      error,
      duplicate,
      draft,
      draftSaveStatus,
      draftSaveError,
      retryDraftSave: flushReview,
      reloadSavedDraft: async () => { if (jobId) await loadDraft(jobId, true); },
      recovered,
      skipped,
      decisions,
      committing,
      commitProgress,
      result,
      stopping,
      notice,
      dismissNotice: () => setNotice(null),
      stop,
      start,
      queueFiles,
      queuedCount,
      queueItems,
      queueUploading,
      removeQueueItem,
      continueQueue,
      adoptExistingJob,
      toggleSkip,
      removePage,
      decide,
      answer,
      updateDraft,
      commit,
      discard,
      batchJobId,
      batchStage,
      batchProgress,
      batchPlan,
      batchBusy,
      applyBatchPlan,
      cancelBatchPlan,
      dismissError: () => setError(null),
    }),
    [
      open, phase, fileName, progress, stage, stageLabel, message, startedAt, logs, error,
      duplicate, draft, draftSaveStatus, draftSaveError, flushReview, loadDraft, jobId, recovered, skipped, decisions, committing, commitProgress, result,
      stopping, notice, stop, start, queueFiles, queuedCount, queueItems, queueUploading, removeQueueItem, continueQueue, adoptExistingJob, toggleSkip, removePage, decide, answer, updateDraft, commit, discard,
      batchJobId, batchStage, batchProgress, batchPlan, batchBusy, applyBatchPlan, cancelBatchPlan,
    ],
  );

  return <IngestContext.Provider value={value}>{children}</IngestContext.Provider>;
}
