"use client";
import { useI18n } from "@/components/i18n-provider";

import { useAppData } from "@/components/app-provider";
import { PlanConfirmPanel } from "@/components/review/plan-confirm-panel";
import { AiWorkingFrame, Badge, Button, ProgressBar } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { ingestFileAccept } from "@/lib/ingest/parse/presentation";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleStop,
  Copy,
  Sparkles,
  X
} from "lucide-react";
import * as React from "react";
import {
  useIngest
} from "./ingest-provider";

import { PickPanel } from "./pick-panel";
import { ReviewPanel } from "./review-panel";

/** 导入视图：任务在 IngestProvider 中运行，关闭抽屉不停止导入。 */
export function IngestDrawer({ onCommitted }: { onCommitted?: () => void }) {
  const { t, locale } = useI18n();
  const {
    open, closeDrawer, phase, fileName, progress, stage, stageLabel, message, startedAt,
    logs, error, duplicate, draft, recovered, skipped, decisions, committing, commitProgress,
    result, stopping, notice, dismissNotice, stop,
    queueFiles, queuedCount, queueItems, queueUploading, removeQueueItem, continueQueue,
    toggleSkip, removePage, answer, updateDraft, commit, discard,
    batchJobId, batchStage, batchProgress, batchPlan, batchBusy, applyBatchPlan, cancelBatchPlan,
    draftSaveStatus, draftSaveError, retryDraftSave, reloadSavedDraft,
  } = useIngest();

  const { dataVersion } = useAppData();
  const [showLogs, setShowLogs] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const panelRef = React.useRef<HTMLElement>(null);
  useModalFocus(open, panelRef, closeDrawer);
  const { data: readiness, refresh: refreshReadiness } = useApi<{ model: { configured: boolean }; docling: { available: boolean } }>("/api/settings", [dataVersion]);

  const elapsed = useElapsed(startedAt, phase === "running");

  React.useEffect(() => {
    if (!open || readiness?.docling.available) return;
    const timer = window.setInterval(() => void refreshReadiness(), 15_000);
    return () => window.clearInterval(timer);
  }, [open, readiness?.docling.available, refreshReadiness]);

  if (!open) return null;

  const isRunning = phase === "running";

  return (
    <>
      <div
        className="fixed inset-0 z-[var(--z-index-overlay)] bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]"
        onClick={closeDrawer}
        aria-hidden
      />
      <aside ref={panelRef} role="dialog" aria-modal="true" aria-label={t("ingest_ingest_drawer.m001")} tabIndex={-1} className="fixed right-0 top-0 z-[var(--z-index-modal)] flex h-dvh min-h-0 w-full max-w-2xl flex-col overflow-hidden border-l border-border bg-background shadow-dialog focus:outline-none">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Sparkles size={15} className="shrink-0 text-[var(--ring)]" strokeWidth={1.8} />
            <span className="shrink-0 text-[14px] font-semibold text-foreground">{t("ingest_ingest_drawer.m001")}</span>
            {fileName && <span className="truncate text-[12px] text-muted-foreground">{fileName}</span>}
          </div>
          <button
            type="button"
            onClick={closeDrawer}
            className="flex h-11 w-11 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
            aria-label={isRunning ? t("ingest_ingest_drawer.m002") : t("ingest_ingest_drawer.m003")}
            title={isRunning ? t("ingest_ingest_drawer.m004") : t("ingest_ingest_drawer.m003")}
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {phase === "review" && <div className="px-5 pt-3 text-[12px] text-muted-foreground" role="status">
            <span>{draftSaveStatus}</span>
            {draftSaveError && <div className="mt-2 space-y-2"><p>{draftSaveError}</p><div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void retryDraftSave().catch(() => undefined)}>{t("ingest_ingest_drawer.m005")}</Button>
              <Button size="sm" variant="ghost" onClick={() => void reloadSavedDraft()}>{t("ingest_ingest_drawer.m006")}</Button>
            </div></div>}
          </div>}
          {/* 错误统一显示在这里，所有相都能看见。
              以前只有「选文件」与「审阅」两相里有错误位，于是**在运行中点停止失败时
              界面上一个字都不出现** —— 例如任务其实已经生成完草稿（服务端返回 409
              「请用放弃这次导入」），用户看到的就是「点了没反应」，然后以为整个
              停止功能是坏的。服务端已经把话说清楚了，界面不能替它闭嘴。 */}
          {error && (
            <div className="mx-5 mt-5 rounded-[12px] border border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_7%,transparent)] p-3.5">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--destructive)]" />
                <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground">{error}</p>
              </div>
            </div>
          )}

          {phase === "idle" && (
            <PickPanel
              notice={notice}
              onDismissNotice={dismissNotice}
              onPick={() => fileInputRef.current?.click()}
              onQueue={queueFiles}
              readiness={readiness}
              onConfigure={closeDrawer}
              queuedCount={queuedCount}
              queueItems={queueItems}
              queueUploading={queueUploading}
              onRemoveQueueItem={removeQueueItem}
              onContinue={continueQueue}
            />
          )}

          {phase === "running" && (
            <div className="p-5">
              <AiWorkingFrame working className="border border-transparent bg-card p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[13.5px] font-medium text-foreground">{locale === "en" && t.has("stages." + stage) ? t("stages." + stage) : stageLabel || t("ingest_ingest_drawer.m007")}</p>
                  <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground" data-numeric>
                    {Math.round(progress)}%
                  </span>
                </div>
                <div className="mt-3">
                  <ProgressBar value={progress} max={100} />
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
                  {message ?? t("ingest_ingest_drawer.m008")}
                  {elapsed !== null && t("ingest_ingest_drawer.m009", {v0: formatElapsed(elapsed, locale)})}
                </p>
              </AiWorkingFrame>

              <button
                type="button"
                onClick={() => setShowLogs((v) => !v)}
                aria-expanded={showLogs}
                className="mt-4 flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight size={12} className={cn("transition-transform", showLogs && "rotate-90")} />
                {showLogs ? t("ingest_ingest_drawer.m010") : t("ingest_ingest_drawer.m011", {v0: logs.length})}
              </button>

              {showLogs && (
                <div className="mt-3 space-y-2 border-l border-border pl-3">
                  {logs.length === 0 && (
                    <p className="text-[12px] text-muted-foreground">{t("ingest_ingest_drawer.m012")}</p>
                  )}
                  {logs.map((log, index) => (
                    <p
                      key={index}
                      className={cn(
                        "text-[12px] leading-relaxed",
                        log.level === "warning" ? "text-[var(--warning)]" : "text-muted-foreground",
                      )}
                    >
                      {log.message}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {phase === "review" && draft && (
            <ReviewPanel
              draft={draft}
              recovered={recovered}
              skipped={skipped}
              decisions={decisions}
              onAnswer={answer}
              onToggleSkip={toggleSkip}
              onRemovePage={removePage}
              onChange={updateDraft}
              committing={committing}
              commitProgress={commitProgress}
            />
          )}

          {phase === "duplicate" && duplicate && (
            <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--muted)]">
                <Copy size={20} className="text-muted-foreground" strokeWidth={1.8} />
              </div>
              <p className="text-[16px] font-semibold text-foreground">{t("ingest_ingest_drawer.m013")}</p>
              <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
                {t("ingest_ingest_drawer.m014")}{duplicate.existingName}{t("ingest_ingest_drawer.m015")}<code className="rounded bg-[var(--muted)] px-1 py-0.5">raw/</code> {t("ingest_ingest_drawer.m016")}</p>
            </div>
          )}

          {phase === "done" && result && (
            <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--success)_12%,transparent)]">
                <Check size={22} className="text-[var(--success)]" strokeWidth={2} />
              </div>
              <p className="text-[16px] font-semibold text-foreground">{t("ingest_ingest_drawer.m017")}</p>
              <p className="mt-2 text-[13px] text-muted-foreground">
                {t("ingest_ingest_drawer.m018")}{result.createdPages.length} {t("ingest_ingest_drawer.m019")}{result.updatedPages.length} {t("ingest_ingest_drawer.m020")}{result.reviewItemCount > 0 ? t("ingest_ingest_drawer.m021", {v0: result.reviewItemCount}) : ""}
              </p>

              {result.conflicts.length > 0 && (
                <div className="mt-5 w-full rounded-[12px] border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] p-3.5 text-left">
                  <p className="mb-1.5 text-[12.5px] font-medium text-foreground">
                    {t("ingest_ingest_drawer.m022")}{result.conflicts.length} {t("ingest_ingest_drawer.m023")}</p>
                  {result.conflicts.map((conflict, index) => (
                    <p key={index} className="text-[12px] leading-relaxed text-muted-foreground">
                      · {conflict}
                    </p>
                  ))}
                </div>
              )}

              {/* 提交之后接着跑的那批回答。跟在这个抽屉里、不跳页 ——
                  用户在草稿上答完题，期待的是「确认写入」之后一路跑完，
                  而不是被丢到另一个页面去看进度。 */}
              {batchPlan && (
                <div className="mt-5 w-full text-left">
                  <PlanConfirmPanel
                    plan={batchPlan}
                    busy={batchBusy}
                    onApply={(approved) => void applyBatchPlan(approved)}
                    onCancel={() => void cancelBatchPlan()}
                  />
                </div>
              )}

              {!batchPlan && batchJobId && (
                <div className="mt-5 w-full rounded-[12px] border border-border bg-card p-3.5 text-left">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[12.5px] text-muted-foreground">
                      {batchStage ? t("ingest_ingest_drawer.m024", {v0: batchStage}) : t("ingest_ingest_drawer.m025")}
                    </span>
                    <span className="text-[12.5px] tabular-nums text-muted-foreground">
                      {batchProgress}%
                    </span>
                  </div>
                  <ProgressBar value={batchProgress} max={100} className="mt-2" />
                </div>
              )}

              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {result.createdPages.slice(0, 6).map((page) => (
                  <Badge key={page.id} tone="neutral">{page.title}</Badge>
                ))}
                {result.updatedPages.slice(0, 6).map((page) => (
                  <Badge key={page.id} tone="accent">{t("ingest_ingest_drawer.m026")}{page.title}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-border px-5 py-3.5">
          {phase === "idle" && (
            <p className="text-center text-[12px] text-muted-foreground">
              {queuedCount > 0 ? t("ingest_ingest_drawer.m027", {v0: queuedCount}) : t("ingest_ingest_drawer.m028")}
            </p>
          )}

          {phase === "running" && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <Button
                variant="ghost"
                size="sm"
                loading={stopping}
                onClick={() => void stop()}
                icon={<CircleStop size={12} strokeWidth={1.8} />}
                // 停止是丢掉这次导入，不是删资料 —— 用 ghost + 警示色而不是
                // 实心红按钮：原件留在 raw/、随时能重来，它不该看起来像危险操作。
                className="text-[var(--destructive)] hover:bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)] hover:text-[var(--destructive)]"
                title={t("ingest_ingest_drawer.m029")}
              >
                {t("ingest_ingest_drawer.m030")}</Button>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
                <p className="text-[12px] text-muted-foreground">{t("ingest_ingest_drawer.m031")}</p>
                <Button variant="secondary" size="sm" onClick={closeDrawer}>
                  {t("ingest_ingest_drawer.m002")}</Button>
              </div>
            </div>
          )}

          {phase === "review" && draft && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void discard()}
                disabled={committing}
              >
                {t("ingest_ingest_drawer.m032")}</Button>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
                <span className="text-[12px] leading-relaxed text-muted-foreground sm:max-w-[24rem]" data-numeric>
                  {committing
                    ? t("ingest_ingest_drawer.m033", {v0: Math.round(commitProgress)})
                    : t("ingest_ingest_drawer.m034", {v0: draft.draft.newPages.filter((p) => !skipped.has(p.title)).length + (skipped.has(draft.draft.sourceSummary.title) || draft.sourceSummarySnapshot ? 0 : 1), v1: draft.draft.updatedPages.filter((p) => !skipped.has(p.title)).length + (!skipped.has(draft.draft.sourceSummary.title) && draft.sourceSummarySnapshot ? 1 : 0)})}
                </span>
                <Button
                  variant="primary"
                  size="md"
                  loading={committing}
                  onClick={() => {
                    void commit().then(() => onCommitted?.()).catch(() => undefined);
                  }}
                  icon={<Check size={13} strokeWidth={2} />}
                >
                  {t("ingest_ingest_drawer.m035")}</Button>
              </div>
            </div>
          )}

          {(phase === "done" || phase === "duplicate") && (
            <Button variant="primary" size="md" className="w-full" onClick={() => queuedCount > 0 ? continueQueue() : closeDrawer()}>
              {queuedCount > 0 ? t("ingest_ingest_drawer.m036", {v0: queuedCount}) : t("ingest_ingest_drawer.m037")}
            </Button>
          )}
        </footer>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={ingestFileAccept(readiness?.docling.available ?? false)}
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) void queueFiles(files);
            event.target.value = "";
          }}
        />
      </aside>
    </>
  );
}

/* ------------------------------------------------------------ 小工具 */

/** 每秒走一次的已用时。只在这段时间里需要，跑完就停 */
function useElapsed(startedAt: number | null, active: boolean): number | null {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!active || startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  if (startedAt === null) return null;
  return Math.max(0, now - startedAt);
}

function formatElapsed(ms: number, locale: string): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return locale === "en" ? `${seconds} s` : `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return locale === "en" ? `${minutes} min ${seconds % 60} s` : `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}
