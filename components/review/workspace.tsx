"use client";
import { useI18n } from "@/components/i18n-provider";

import { useAppData } from "@/components/app-provider";
import { useJobs } from "@/components/jobs/jobs-provider";
import { PageHeader } from "@/components/layout/page-header";
import {
  AiWorkingFrame,
  Badge,
  Button,
  Card,
  EmptyState,
  ProgressBar,
  Spinner
} from "@/components/ui";
import { apiFetch } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import {
  CircleStop,
  Play,
  ShieldCheck
} from "lucide-react";
import * as React from "react";
import { FixPlanPanel } from "./plan-confirm-panel";
import { type AnswerDraft } from "./question-picker";

import { ReviewCard } from "./review-card";
import type { ReviewBatchJob, ReviewItem, ReviewStatus } from "./types";

/**
 * 体检与审阅队列。
 *
 * 这是原始 LLM Wiki 理念里的第三个核心操作（Ingest / Query / **Lint**）。
 * 它存在的理由很实在：这套 wiki 由 LLM 写、由 LLM 维护、由 LLM 查询，
 * 所以典型失效不是某一次错误，而是**错误静默复利** —— 一个错误论断留在词条里，
 * 被后续词条引用，再被引用它的人当成前提。
 *
 * 一条事项只有一个处理入口：选择方向或写批注，提交后自动修订。程序检查与模型
 * 发现共享同一条队列；无法落盘的事项保留回答，方便用户重试。
 */


const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "reviewStatus.pending",
  answered: "reviewStatus.answered",
};

/**
 * 一条审阅事项牵涉的词条。
 *
 * id 为 null 不是数据缺失，而是「这个词条现在还不存在」—— 「缺页」类发现的
 * 常态就是如此（某个名字被引用了 3 次，但还没有它的词条）。
 * 这类标签只显示、不链接：链接过去也只会看到「没有匹配的词条」。
 */
/** 正在跑的修订任务在界面上的样子 */
export function ReviewWorkspace() {
  const { t } = useI18n();
  const [items, setItems] = React.useState<ReviewItem[]>([]);
  const [stats, setStats] = React.useState<{ pages: number; edges: number; orphans: number; dangling: number } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [scanning, setScanning] = React.useState(false);
  const [scanLog, setScanLog] = React.useState<string[]>([]);
  /** 体检任务的进度：0-100，由后台任务按 1% 颗粒推上来 */
  const [scanProgress, setScanProgress] = React.useState(0);
  const [scanStage, setScanStage] = React.useState("");
  const [scanJobId, setScanJobId] = React.useState<string | null>(null);
  const [stopping, setStopping] = React.useState(false);
  const [coverage, setCoverage] = React.useState<{ checkedSegments: number; totalSegments: number; remainingSegments: number } | null>(null);
  const [llmConfigured, setLlmConfigured] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<ReviewStatus>("pending");
  const [batchJobs, setBatchJobs] = React.useState<ReviewBatchJob[]>([]);
  const [busyPlanIds, setBusyPlanIds] = React.useState<Set<string>>(() => new Set());

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{
        pending: ReviewItem[];
        llmConfigured: boolean;
        coverage: { checkedSegments: number; totalSegments: number; remainingSegments: number };
      }>("/api/lint?queueMechanical=1");
      setItems(data.pending);
      setLlmConfigured(data.llmConfigured);
      setCoverage(data.coverage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueue = React.useCallback(async (status: ReviewStatus) => {
    try {
      const data = await apiFetch<{ items: ReviewItem[] }>(`/api/review?status=${status}`);
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const filterRef = React.useRef(filter);
  React.useLayoutEffect(() => { filterRef.current = filter; }, [filter]);

  const { dataVersion, bumpData } = useAppData();
  // 左下角那排任务读的是 JobsProvider 的轮询结果。刚起了任务就催它一次，
  // 免得用户要等下一次轮询（最长 6 秒）才看见「体检 0%」出现
  const { refresh: refreshJobs } = useJobs();

  const batchJobsRef = React.useRef<ReviewBatchJob[]>([]);
  const refreshBatchJobs = React.useCallback(async () => {
    const { jobs } = await apiFetch<{ jobs: ReviewBatchJob[] }>(
      "/api/jobs?active=1&kind=review_batch",
    );
    const detailed = await Promise.all(jobs.map(async (job) => {
      if (job.status !== "awaiting_review") return job;
      try {
        return await apiFetch<ReviewBatchJob>(`/api/jobs/${job.id}`);
      } catch {
        return job;
      }
    }));
    detailed.sort((left, right) => {
      const leftCreated = left.createdAt ? Date.parse(left.createdAt) : Number.MAX_SAFE_INTEGER;
      const rightCreated = right.createdAt ? Date.parse(right.createdAt) : Number.MAX_SAFE_INTEGER;
      return leftCreated - rightCreated;
    });
    const previousIds = new Set(batchJobsRef.current.map((job) => job.id));
    const nextIds = new Set(detailed.map((job) => job.id));
    const finishedAny = [...previousIds].some((id) => !nextIds.has(id));
    batchJobsRef.current = detailed;
    setBatchJobs(detailed);
    if (finishedAny) {
      await loadQueue(filterRef.current);
      void refreshJobs();
      bumpData();
    }
    return detailed;
  }, [loadQueue, refreshJobs, bumpData]);

  React.useEffect(() => {
    void refreshBatchJobs().catch(() => undefined);
  }, [refreshBatchJobs]);

  React.useEffect(() => {
    if (batchJobs.length === 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await refreshBatchJobs();
      } catch {
        // 下一轮继续尝试，任务仍会在服务端队列中运行。
      }
      if (!stopped) timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [batchJobs.length, refreshBatchJobs]);

  React.useEffect(() => {
    void load();
    void apiFetch<{ stats: typeof stats }>("/api/graph")
      .then((data) => setStats(data.stats))
      .catch(() => undefined);
  }, [load, dataVersion]);

  React.useEffect(() => {
    void loadQueue(filter);
  }, [filter, loadQueue, dataVersion]);

  /** 体检任务的进度流。断开后由轮询接管，任务本身在服务端跑着 */
  const scanSourceRef = React.useRef<EventSource | null>(null);
  /** settle 时要读最新的页签，不能吃调用时的闭包 —— 体检跑着的时候用户完全可能切页签 */

  /**
   * 跟着一个体检任务走：进度、日志、收尾。
   *
   * 与导入抽屉用的是同一套办法（SSE + 轮询兜底），因为任务本来就落在同一张
   * jobs 表里、走同一个事件协议 —— 用户看到的「进度」在两种任务里是同一个东西。
   */
  const watchScan = React.useCallback(
    (jobId: string) => {
      scanSourceRef.current?.close();
      setScanJobId(jobId);
      setScanning(true);
      setStopping(false);

      const source = new EventSource(`/api/jobs/${jobId}/stream`);
      scanSourceRef.current = source;
      let finished = false;

      const settle = async (status: string, jobError: string | null) => {
        if (finished) return;
        finished = true;
        source.close();
        scanSourceRef.current = null;
        setScanning(false);
        setScanJobId(null);
        setStopping(false);

        if (status === "cancelled") {
          setScanLog((prev) => [...prev, t("review_workspace.m001")]);
        } else if (status === "failed") {
          setError(jobError ?? t("review_workspace.m002"));
          setScanLog((prev) => [...prev, t("review_workspace.m003")]);
        } else {
          setScanProgress(100);
          setScanLog((prev) => [...prev, t("review_workspace.m004")]);
        }

        // 不论怎么结束，都要重新拉一遍队列与机械发现：成功时它写入了新条目，
        // 失败与被停止时可能什么都没写 —— 界面显示的必须是服务端的真实状态，
        // 而不是我们以为发生了什么的推测。
        await load();
        await loadQueue(filterRef.current);
        // 侧栏「体检」角标读的是外壳层的数据，不通知它就不会变
        bumpData();
      };

      source.onmessage = (event) => {
        let payload: {
          type: string;
          status?: string;
          stage?: string;
          label?: string;
          progress?: number;
          message?: string;
          level?: "info" | "warning" | "error";
        };
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (payload.type) {
          case "stage":
            setScanStage(payload.label ?? payload.stage ?? "");
            if (payload.message) {
              setScanLog((prev) => [...prev, `· ${payload.message}`]);
            }
            break;
          case "progress":
            setScanProgress(payload.progress ?? 0);
            break;
          case "log":
            setScanLog((prev) => [...prev, `· ${payload.message ?? ""}`]);
            break;
          case "status":
            if (payload.status && ["done", "failed", "cancelled"].includes(payload.status)) {
              void settle(payload.status, null);
            }
            break;
          case "error":
            setError(payload.message ?? t("review_workspace.m005"));
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
          while (!finished && scanSourceRef.current === source) {
            await new Promise((r) => setTimeout(r, 1000));
            if (finished || scanSourceRef.current !== source) return;
            try {
              const job = await apiFetch<{
                status: string;
                progress: number;
                stageLabel: string;
                error: string | null;
              }>(`/api/jobs/${jobId}`);
              if (finished || scanSourceRef.current !== source) return;
              setScanProgress(job.progress);
              setScanStage(job.stageLabel);
              if (["done", "failed", "cancelled"].includes(job.status)) {
                await settle(job.status, job.error);
                return;
              }
            } catch {
              // 网络还没恢复，继续轮询
            }
          }
        })();
      };
    },
    [load, loadQueue, bumpData, t],
  );

  /** 起一次体检。任务在服务端跑，这个页面只是它的一个视图 */
  const handleScan = React.useCallback(async () => {
    setError(null);
    setScanLog([t("review_workspace.m006")]);
    setScanProgress(0);
    setScanStage(t("review_workspace.m007"));
    setScanning(true);
    try {
      const { jobId } = await apiFetch<{ jobId: string }>("/api/lint", {
        method: "POST",
        body: JSON.stringify({ mechanicalOnly: !llmConfigured }),
      });
      watchScan(jobId);
      void refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScanning(false);
    }
  }, [t, llmConfigured, watchScan, refreshJobs]);

  /**
   * 停止体检。
   *
   * 和导入那边同一条纪律：这里只发出请求，界面一律由服务端推来的真实状态收尾。
   * 自己抢先显示「已停止」的话，服务端可能还在收尾，两边就此不一致。
   */
  const stopScan = React.useCallback(async () => {
    if (!scanJobId) return;
    setStopping(true);
    setScanLog((prev) => [...prev, t("review_workspace.m008")]);
    try {
      await apiFetch(`/api/jobs/${scanJobId}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStopping(false);
    }
  }, [scanJobId, t]);

  /**
   * 进页面时认领一个还在跑的体检。
   *
   * 与导入同一条理由：体检是分钟级的，用户可以关掉页面、刷新、去别的页逛一圈。
   * 任务状态本来就落在 SQLite 里，不主动认回来的话，「支持后台运行」就等于
   * 「关掉页面之后就再也找不到它了」。
   */
  const watchScanRef = React.useRef(watchScan);
  const scanJobIdRef = React.useRef<string | null>(null);
  React.useLayoutEffect(() => { watchScanRef.current = watchScan; scanJobIdRef.current = scanJobId; }, [watchScan, scanJobId]);

  React.useEffect(() => {
    if (scanJobIdRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<{ jobs: Array<{ id: string }> }>(
          "/api/jobs?active=1&kind=lint",
        );
        const job = data.jobs[0];
        if (cancelled || !job) return;
        setScanLog([t("review_workspace.m009")]);
        watchScanRef.current(job.id);
      } catch {
        // 认领失败不影响任何事：用户重新点一次体检即可
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  // 离开页面时断开订阅。任务在服务端继续跑 —— 断的只是这条视图连接
  React.useEffect(() => () => { scanSourceRef.current?.close(); scanSourceRef.current = null; }, []);

  /** 保存一条选择或批注后，将它加入服务端的串行处理队列。 */
  const handleSubmitAnswer = React.useCallback(
    async (id: string, next: AnswerDraft) => {
      if (!next.answer.trim()) return;
      setError(null);
      try {
        await apiFetch(`/api/review/${id}/answer`, {
          method: "POST",
          body: JSON.stringify(next),
        });
        const { jobId } = await apiFetch<{ jobId: string }>("/api/review/batch", {
          method: "POST",
          body: JSON.stringify({ mode: "answers", itemIds: [id] }),
        });
        const queuedJob: ReviewBatchJob = {
          id: jobId,
          createdAt: new Date().toISOString(),
          status: "queued",
          progress: 0,
          stageLabel: t("review_workspace.m010"),
          error: null,
          payload: { mode: "answers", itemIds: [id] },
          draft: null,
        };
        const nextJobs = [...batchJobsRef.current.filter((job) => job.id !== jobId), queuedJob];
        batchJobsRef.current = nextJobs;
        setBatchJobs(nextJobs);
        await Promise.all([loadQueue(filter), refreshJobs(), refreshBatchJobs()]);
        bumpData();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // 回答可能已保存但任务启动失败；让它留在「已提交」里以便重试。
        await loadQueue("answered");
        setFilter("answered");
      }
    },
    [t, loadQueue, filter, refreshJobs, refreshBatchJobs, bumpData],
  );

  /** 确认某一个任务提出的执行计划 */
  const handleApplyPlan = React.useCallback(
    async (jobId: string, approved: string[], edits?: Record<string, string>) => {
      setBusyPlanIds((previous) => new Set(previous).add(jobId));
      try {
        await apiFetch(`/api/review/batch/${jobId}/apply`, {
          method: "POST",
          body: JSON.stringify({ approve: approved, ...(edits ? { edits } : {}) }),
        });
        await Promise.all([loadQueue(filter), refreshBatchJobs()]);
        void refreshJobs();
        bumpData();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyPlanIds((previous) => {
          const next = new Set(previous);
          next.delete(jobId);
          return next;
        });
      }
    },
    [filter, loadQueue, refreshBatchJobs, refreshJobs, bumpData],
  );

  // 兼容升级前已生成的合并/删除计划；用户提交的回答就是执行授权。
  const resumedPlans = React.useRef(new Set<string>());
  React.useEffect(() => {
    for (const job of batchJobs) {
      if (job.status !== "awaiting_review" || job.draft?.mode !== "answers" || resumedPlans.current.has(job.id)) continue;
      resumedPlans.current.add(job.id);
      void handleApplyPlan(job.id, job.draft.pending.map(action => action.id));
    }
  }, [batchJobs, handleApplyPlan]);

  /** 放弃某一个计划：不做任何破坏性操作，事项回到「已回答」 */
  const handleCancelPlan = React.useCallback(async (jobId: string) => {
    setBusyPlanIds((previous) => new Set(previous).add(jobId));
    try {
      await apiFetch(`/api/review/batch/${jobId}/cancel`, { method: "POST" });
      await Promise.all([loadQueue(filter), refreshBatchJobs()]);
      void refreshJobs();
      bumpData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPlanIds((previous) => {
        const next = new Set(previous);
        next.delete(jobId);
        return next;
      });
    }
  }, [filter, loadQueue, refreshBatchJobs, refreshJobs, bumpData]);

  const queueStatusByItem = React.useMemo(() => {
    const result = new Map<string, "queued" | "running" | "awaiting_review">();
    for (const job of batchJobs) {
      const status = job.status === "queued"
        ? "queued"
        : job.status === "awaiting_review"
          ? "awaiting_review"
          : "running";
      for (const id of job.payload?.itemIds ?? []) result.set(id, status);
    }
    for (const item of items) {
      if (item.batchId && !result.has(item.id)) result.set(item.id, "running");
    }
    return result;
  }, [batchJobs, items]);


  return (
    <>
      <PageHeader
        title={t("review_workspace.m011")}
        description={t("review_workspace.m012")}
        meta={
          stats && (
            <>
              <Badge tone="neutral">{stats.pages} {t("review_workspace.m013")}</Badge>
              <Badge tone={stats.orphans > 0 ? "warning" : "neutral"}>
                {stats.orphans} {t("review_workspace.m014")}</Badge>
              <Badge tone={stats.dangling > 0 ? "warning" : "neutral"}>
                {stats.dangling} {t("review_workspace.m015")}</Badge>
              {!llmConfigured && <Badge tone="neutral">{t("review_workspace.m016")}</Badge>}
            </>
          )
        }
        actions={
          scanning ? (
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] tabular-nums text-muted-foreground" data-numeric>
                {Math.round(scanProgress)}%
              </span>
              <Button
                variant="ghost"
                size="sm"
                loading={stopping}
                onClick={() => void stopScan()}
                icon={<CircleStop size={12} strokeWidth={1.8} />}
                className="text-[var(--destructive)] hover:bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)] hover:text-[var(--destructive)]"
                title={t("review_workspace.m017")}
              >
                {t("review_workspace.m018")}</Button>
            </div>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={<Play size={12} strokeWidth={2} />}
              onClick={handleScan}
            >
              {t("review_workspace.m019")}</Button>
          )
        }
      />

      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
        <p className="mb-5 text-[12px] leading-relaxed text-muted-foreground">{t("review_workspace.m020")}{coverage ? t("review_workspace.m021", {v0: coverage.checkedSegments, v1: coverage.totalSegments, v2: coverage.remainingSegments}) : ""}</p>
        {/* 扫描进行中 */}
        {scanning && (
          <AiWorkingFrame working className="mb-5 border border-transparent bg-card p-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[13.5px] font-medium text-foreground">
                {scanStage || t("review_workspace.m007")}
              </p>
              <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground" data-numeric>
                {Math.round(scanProgress)}%
              </span>
            </div>
            <div className="mt-3">
              <ProgressBar value={scanProgress} max={100} />
            </div>
            <div className="mt-3 space-y-1.5">
              {scanLog.map((line, index) => (
                <p key={index} className="msg-in text-[12.5px] leading-relaxed text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          </AiWorkingFrame>
        )}

        {error && (
          <Card className="mb-5 border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] p-3.5">
            <p className="text-[12.5px] text-[var(--destructive)]">{error}</p>
          </Card>
        )}

        {/* 审阅队列 */}
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShieldCheck size={13} className="text-muted-foreground" />
              <h2 className="text-[12px] font-semibold tracking-[0.08em] text-foreground">
                {t("review_workspace.m022")}</h2>
            </div>
            <div className="flex items-center gap-1">
              {(["pending", "answered"] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setFilter(status)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11.5px] transition-colors",
                    filter === status
                      ? "border-[var(--foreground)] text-foreground"
                      : "border-[var(--border)] text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(STATUS_LABEL[status])}
                </button>
              ))}
            </div>
          </div>

          {filter === "pending" && items.length > 0 && (
            <p className="mb-3 text-[11.5px] leading-relaxed text-muted-foreground">
              {t("review_workspace.m023")}</p>
          )}

          {filter === "answered" && items.length > 0 && (
            <p className="mb-3 text-[11.5px] leading-relaxed text-muted-foreground">
              {t("review_workspace.m024")}</p>
          )}

          {/* 每个已完成的模型任务各自等待确认；队列中其他任务可以继续运行。 */}
          {batchJobs.map((job) => {
            if (job.status !== "awaiting_review" || !job.draft) return null;
            return (
              <div key={job.id} className="mb-3">
                {job.draft.mode === "mechanical" ? (
                  <FixPlanPanel
                    plan={job.draft}
                    busy={busyPlanIds.has(job.id)}
                    onApply={(approved, edits) => void handleApplyPlan(job.id, approved, edits)}
                    onCancel={() => void handleCancelPlan(job.id)}
                  />
                ) : (
                  <p role="status" className="rounded-xl border border-border px-4 py-3 text-[12px] text-muted-foreground">{t("review_workspace.m025")}{job.draft.pending.length} {t("review_workspace.m026")}</p>
                )}
              </div>
            );
          })}

          {batchJobs.filter((job) => job.status !== "awaiting_review").map((job, index, activeJobs) => (
            <div key={job.id} className="mb-2 rounded-[16px] bg-background px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11.5px] text-muted-foreground">
                  {job.status === "queued"
                    ? t("review_workspace.m029", {v0: index > 0 ? t("review_workspace.m027", {v0: index}) : t("review_workspace.m028")})
                    : job.stageLabel ? t("review_workspace.m030", {v0: job.stageLabel}) : t("review_workspace.m031")}
                </span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
                  {job.status === "queued" ? `${index + 1}/${activeJobs.length}` : `${job.progress}%`}
                </span>
              </div>
              {job.status !== "queued" && (
                <ProgressBar value={job.progress} max={100} className="mt-2" />
              )}
            </div>
          ))}

          {loading && (
            <div className="flex justify-center py-12 text-muted-foreground">
              <Spinner size={16} />
            </div>
          )}

          {!loading && items.length === 0 && (
            <Card>
              <EmptyState
                icon={<ShieldCheck size={28} strokeWidth={1.3} />}
                title={
                  filter === "pending"
                    ? t("review_workspace.m032")
                    : t("review_workspace.m033")
                }
                description={
                  filter === "pending"
                    ? t("review_workspace.m034")
                    : undefined
                }
                action={
                  filter === "pending" && (
                    <Button variant="secondary" size="md" onClick={handleScan} loading={scanning}>
                      {scanning ? t("review_workspace.m035") : t("review_workspace.m019")}
                    </Button>
                  )
                }
              />
            </Card>
          )}

          <div className="space-y-2">
            {items.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                filter={filter}
                llmConfigured={llmConfigured}
                queueStatus={queueStatusByItem.get(item.id) ?? null}
                onSubmit={(next) => handleSubmitAnswer(item.id, next)}
              />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
