"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ShieldCheck, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useJobs, type ActiveJob } from "./jobs-provider";
import { useIngest } from "@/components/ingest/ingest-provider";

/**
 * 后台任务的常驻指示器（侧栏底部）。
 *
 * 体检从「请求里跑完再返回」改成后台任务之后，「进度在哪看」必须有个答案 ——
 * 否则「可以关掉页面」就变成了「关掉之后就再也找不到进度了」。
 * 它和旁边的导入指示器是同一套语言：一个状态点、一句话、一条迷你进度条。
 *
 * 这里刻意只显示**一件事**：哪个任务、走到百分之多少。
 *
 *   · 不显示当前阶段（「模型判断矛盾与过时论断」那一类）。左下角是余光扫一眼的
 *     地方，一句话越长越读不完；阶段细节属于任务自己的页面 —— 点进去就有完整的过程。
 *   · 也不在这里放停止按钮。栏底是**只读的进度**，停止是那个页面里的动作：
 *     在只有 60px 宽的折叠栏里挤进第二个按钮，误点的代价是丢掉几分钟的工作。
 */

const KIND_META: Record<string, { label: string; icon: React.ElementType; href: string }> = {
  lint: { label: "jobKinds.lint", icon: ShieldCheck, href: "/review" },
  remediate: { label: "jobKinds.remediate", icon: Sparkles, href: "/review" },
  review_batch: { label: "jobKinds.review_batch", icon: Sparkles, href: "/review" },
  reindex: { label: "jobKinds.reindex", icon: Sparkles, href: "/settings" },
  embeddings: { label: "jobKinds.embeddings", icon: Sparkles, href: "/settings" },
  chat_artifact: { label: "jobKinds.chat_artifact", icon: Sparkles, href: "/chat" },
  rebuild_graph: { label: "jobKinds.rebuild_graph", icon: Sparkles, href: "/settings" },
  refile: { label: "jobKinds.refile", icon: Sparkles, href: "/wiki" },
};

export function JobIndicators() {
  const { t } = useI18n();
  const { jobs } = useJobs();
  const [expanded, setExpanded] = React.useState(false);
  if (jobs.length === 0) return null;
  const running = jobs.filter(job => job.status === "running").length;
  const queued = jobs.filter(job => job.status === "queued").length;

  return (
    <div className="min-w-0">
      <button type="button" aria-label={t("jobs_job_indicator.m001", {v0: jobs.length})} aria-expanded={expanded} aria-controls="sidebar-jobs" onClick={() => setExpanded(value => !value)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
        <Sparkles size={13} className="shrink-0" />
        <span className="sidebar-label min-w-0 flex-1">{t("jobs_job_indicator.m002")}{jobs.length}<span className="mt-0.5 block text-[11px]">{running ? t("jobs_job_indicator.m003", {v0: running}) : ""}{running && queued ? " · " : ""}{queued ? t("jobs_job_indicator.m004", {v0: queued}) : ""}{!running && !queued ? t("jobs_job_indicator.m005") : ""}</span></span>
        <ChevronDown size={13} className={cn("sidebar-label shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && <div id="sidebar-jobs" className="max-h-52 overflow-y-auto overscroll-contain">
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} />
      ))}
      </div>}
    </div>
  );
}

function JobRow({ job }: { job: ActiveJob }) {
  const { t, locale } = useI18n();
  const { adoptExistingJob } = useIngest();
  const meta = KIND_META[job.kind] ?? { label: job.kind, icon: Sparkles, href: "/wiki" };
  const Icon = meta.icon;
  const running = job.status === "running";
  const queued = job.status === "queued";
  const percent = Math.max(0, Math.min(100, job.progress));

  const name = job.payload?.title ?? `${t.has(meta.label) ? t(meta.label) : meta.label} · ${new Date(job.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} · ${job.id.slice(-4)}`;
  const label = `${name} · ${queued ? t("jobs_job_indicator.m006") : job.status === "awaiting_review" ? t("jobs_job_indicator.m007") : `${Math.round(percent)}%`}`;

  return (
    <Link
      href={job.kind === "chat_artifact" && job.payload?.sessionId ? `/chat?s=${encodeURIComponent(job.payload.sessionId)}` : meta.href}
      onClick={event => {
        if (job.kind === "ingest_review" && job.payload?.ingestId) {
          event.preventDefault();
          adoptExistingJob(job.payload.ingestId, job.payload.title?.replace(/^AI 批量判断 · /, "") ?? "");
        }
      }}
      // 阶段信息收进悬浮提示：想知道它卡在哪一步，把鼠标停上去，或者点进去看过程记录
      title={job.stageLabel ? `${label} · ${locale === "en" && t.has("stages." + job.stage) ? t("stages." + job.stage) : job.stageLabel}` : label}
      className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--muted)] hover:text-foreground"
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", running && "animate-pulse")}
        style={{ background: running ? "var(--ring)" : "var(--warning)" }}
        aria-hidden
      />
      {/* 图标与文字一起在折叠态隐藏 —— 60px 的窄栏里只留得下那个点与进度条 */}
      <Icon size={12} strokeWidth={1.8} className="sidebar-label shrink-0 opacity-70" />
      <span className="sidebar-label min-w-0 flex-1 truncate">{label}</span>
      {running && (
        <span className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-[var(--muted)]">
          <span
            className="block h-full origin-left rounded-full bg-[var(--ring)] transition-transform duration-500 ease-out"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </span>
      )}
    </Link>
  );
}
