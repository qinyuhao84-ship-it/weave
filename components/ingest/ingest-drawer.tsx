"use client";

import * as React from "react";
import Link from "next/link";
import { diffLines } from "diff";
import {
  X, Upload, Sparkles, Check, AlertTriangle, Trash2, Pencil, Save, ChevronRight, Copy,
  CircleStop, ClipboardPaste,
} from "lucide-react";
import { useAppData } from "@/components/app-provider";
import { Button, Badge, TypeBadge, Input, Textarea, AiWorkingFrame, ProgressBar } from "@/components/ui";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import {
  useIngest,
  type Draft,
  type DraftPage,
  type DraftReviewItem,
  type IngestDraft,
  type ReviewDecisionDraft,
} from "./ingest-provider";
import { QuestionPicker, type AnswerDraft } from "@/components/review/question-picker";
import { PlanConfirmPanel } from "@/components/review/plan-confirm-panel";
import { cn } from "@/lib/utils";
import { stripWikilinks } from "@/lib/vault/wikilinks";
import { ingestFileAccept, ingestFormatLabel } from "@/lib/ingest/parse/presentation";
import { useApi } from "@/hooks/use-api";
import { useModalFocus } from "@/hooks/use-modal-focus";

/** 导入视图：任务在 IngestProvider 中运行，关闭抽屉不停止导入。 */
export function IngestDrawer({ onCommitted }: { onCommitted?: () => void }) {
  const {
    open, closeDrawer, phase, fileName, progress, stageLabel, message, startedAt,
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
      <aside ref={panelRef} role="dialog" aria-modal="true" aria-label="导入资料" tabIndex={-1} className="fixed right-0 top-0 z-[var(--z-index-modal)] flex h-dvh min-h-0 w-full max-w-2xl flex-col overflow-hidden border-l border-border bg-background shadow-dialog focus:outline-none">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Sparkles size={15} className="shrink-0 text-[var(--ring)]" strokeWidth={1.8} />
            <span className="shrink-0 text-[14px] font-semibold text-foreground">导入资料</span>
            {fileName && <span className="truncate text-[12px] text-muted-foreground">{fileName}</span>}
          </div>
          <button
            type="button"
            onClick={closeDrawer}
            className="flex h-11 w-11 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
            aria-label={isRunning ? "收起到后台" : "关闭"}
            title={isRunning ? "收起到后台，导入会继续跑" : "关闭"}
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {phase === "review" && <div className="px-5 pt-3 text-[12px] text-muted-foreground" role="status">
            <span>{draftSaveStatus}</span>
            {draftSaveError && <div className="mt-2 space-y-2"><p>{draftSaveError}</p><div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void retryDraftSave().catch(() => undefined)}>重试保存</Button>
              <Button size="sm" variant="ghost" onClick={() => void reloadSavedDraft()}>载入已保存版本</Button>
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
                  <p className="text-[13.5px] font-medium text-foreground">{stageLabel || "正在准备"}</p>
                  <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground" data-numeric>
                    {Math.round(progress)}%
                  </span>
                </div>
                <div className="mt-3">
                  <ProgressBar value={progress} max={100} />
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
                  {message ?? "模型正在读这份资料。长文档可能要几分钟。"}
                  {elapsed !== null && ` · 已用 ${formatElapsed(elapsed)}`}
                </p>
              </AiWorkingFrame>

              <button
                type="button"
                onClick={() => setShowLogs((v) => !v)}
                aria-expanded={showLogs}
                className="mt-4 flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight size={12} className={cn("transition-transform", showLogs && "rotate-90")} />
                {showLogs ? "收起过程记录" : `过程记录（${logs.length}）`}
              </button>

              {showLogs && (
                <div className="mt-3 space-y-2 border-l border-border pl-3">
                  {logs.length === 0 && (
                    <p className="text-[12px] text-muted-foreground">还没有记录。</p>
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
              <p className="text-[16px] font-semibold text-foreground">这份资料已经导入过了</p>
              <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
                内容与《{duplicate.existingName}》完全相同，没有重复编译。
                原件留在 <code className="rounded bg-[var(--muted)] px-1 py-0.5">raw/</code> 里。
              </p>
            </div>
          )}

          {phase === "done" && result && (
            <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--success)_12%,transparent)]">
                <Check size={22} className="text-[var(--success)]" strokeWidth={2} />
              </div>
              <p className="text-[16px] font-semibold text-foreground">已写入知识库</p>
              <p className="mt-2 text-[13px] text-muted-foreground">
                新建了 {result.createdPages.length} 个词条，更新了 {result.updatedPages.length} 个已有词条
                {result.reviewItemCount > 0 ? `，另有 ${result.reviewItemCount} 条待你判断的事项` : ""}
              </p>

              {result.conflicts.length > 0 && (
                <div className="mt-5 w-full rounded-[12px] border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] p-3.5 text-left">
                  <p className="mb-1.5 text-[12.5px] font-medium text-foreground">
                    有 {result.conflicts.length} 项被跳过
                  </p>
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
                      {batchStage ? `正在处理你的回答：${batchStage}` : "正在处理你的回答…"}
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
                  <Badge key={page.id} tone="accent">更新：{page.title}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-border px-5 py-3.5">
          {phase === "idle" && (
            <p className="text-center text-[12px] text-muted-foreground">
              {queuedCount > 0 ? `还有 ${queuedCount} 份资料待处理` : "模型只提议，写入前由你确认"}
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
                title="停止这次导入。原件会留在 raw/，随时可以重新导入。"
              >
                停止导入
              </Button>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
                <p className="text-[12px] text-muted-foreground">关掉窗口后，导入会在后台继续</p>
                <Button variant="secondary" size="sm" onClick={closeDrawer}>
                  收起到后台
                </Button>
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
                放弃这次导入
              </Button>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
                <span className="text-[12px] leading-relaxed text-muted-foreground sm:max-w-[24rem]" data-numeric>
                  {committing
                    ? `正在写入… ${Math.round(commitProgress)}%`
                    : `将新建 ${draft.draft.newPages.filter((p) => !skipped.has(p.title)).length + (skipped.has(draft.draft.sourceSummary.title) || draft.sourceSummarySnapshot ? 0 : 1)} 个（含来源摘要）、更新 ${draft.draft.updatedPages.filter((p) => !skipped.has(p.title)).length + (!skipped.has(draft.draft.sourceSummary.title) && draft.sourceSummarySnapshot ? 1 : 0)} 个词条`}
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
                  确认写入
                </Button>
              </div>
            </div>
          )}

          {(phase === "done" || phase === "duplicate") && (
            <Button variant="primary" size="md" className="w-full" onClick={() => queuedCount > 0 ? continueQueue() : closeDrawer()}>
              {queuedCount > 0 ? `审阅下一份（剩余 ${queuedCount} 份）` : "完成"}
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

/* ------------------------------------------------------------ 选文件 */

function PickPanel({
  notice,
  onDismissNotice,
  onPick,
  onQueue,
  readiness,
  queuedCount,
  queueItems,
  queueUploading,
  onRemoveQueueItem,
  onContinue,
  onConfigure,
}: {
  /** 中性提示（例如「已停止，原件还在」）。错误统一在抽屉顶部渲染，不在这里 */
  notice: string | null;
  onDismissNotice: () => void;
  onPick: () => void;
  onQueue: (files: File[]) => Promise<boolean>;
  readiness: { model: { configured: boolean }; docling: { available: boolean } } | null;
  queuedCount: number;
  queueItems: Array<{ id: string; originalName: string; status: string; error: string | null }>;
  queueUploading: boolean;
  onRemoveQueueItem: (id: string) => Promise<void>;
  onContinue: () => void;
  onConfigure: () => void;
}) {
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteTitle, setPasteTitle] = React.useState("");
  const [pasteText, setPasteText] = React.useState("");

  const submitPaste = async () => {
    const title = pasteTitle.trim() || "快速捕捉";
    const safeTitle = title.replace(/[\\/:*?"<>|\r\n]/g, "-").slice(0, 100) || "快速捕捉";
    const queued = await onQueue([new File([pasteText], `${safeTitle}.md`, { type: "text/markdown" })]);
    if (queued) {
      setPasteTitle("");
      setPasteText("");
      setPasteOpen(false);
    }
  };

  return (
    <div className="p-4 sm:p-5">
      <div className="mb-4">
        <p className="text-[14px] font-semibold text-foreground">添加资料</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          长文档会分段分析并合并结果；每份资料都会先进入审阅，确认后才写入知识库。
        </p>
      </div>
      {notice && (
        <div className="mb-4 flex items-start gap-2 rounded-[12px] border border-border bg-[var(--muted)] p-3.5">
          <CircleStop size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
          <p className="flex-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground">
            {notice}
          </p>
          <button
            type="button"
            onClick={onDismissNotice}
            aria-label="知道了"
            className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {!pasteOpen ? (
        <button
          type="button"
          onClick={onPick}
          disabled={queueUploading}
          className="group flex min-h-52 w-full flex-col items-center justify-center rounded-[20px] border border-dashed border-[var(--input)] bg-card px-4 py-10 text-center transition-colors duration-200 hover:border-[var(--focus-ring)] hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 disabled:opacity-50 sm:rounded-[22px] sm:px-6 sm:py-12"
        >
          <Upload size={26} strokeWidth={1.4} className="mb-3 text-muted-foreground transition-colors group-hover:text-[var(--ring)]" />
          <span className="text-[14px] font-medium text-foreground">选择要导入的资料</span>
          <span className="mt-1.5 text-[12.5px] text-muted-foreground">
            {ingestFormatLabel(readiness?.docling.available ?? false)}
          </span>
        </button>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-[12px] border border-border bg-card px-3.5 py-2.5">
          <span className="text-[13px] font-medium text-foreground">粘贴文字</span>
          <Button variant="secondary" size="sm" icon={<Upload size={12} />} onClick={onPick} disabled={queueUploading}>
            选择文件
          </Button>
        </div>
      )}

      {!pasteOpen && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button variant="secondary" size="sm" icon={<ClipboardPaste size={13} />} onClick={() => setPasteOpen(true)}>
            粘贴文字
          </Button>
          <p className="text-[11.5px] text-muted-foreground">可多选，系统会逐份处理并等待你审阅</p>
        </div>
      )}

      {pasteOpen && (
        <div className="mt-3 space-y-2.5 rounded-[12px] border border-border bg-card p-3.5">
          <Input value={pasteTitle} onChange={(event) => setPasteTitle(event.target.value)} placeholder="标题（可选）" maxLength={100} aria-label="粘贴内容标题" />
          <Textarea autoFocus value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder="粘贴你想收入知识库的内容…" rows={6} aria-label="要导入的文字" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPasteOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" disabled={!pasteText.trim() || queueUploading} loading={queueUploading} onClick={() => void submitPaste()}>加入队列</Button>
          </div>
        </div>
      )}

      {queueUploading && <p role="status" className="mt-3 text-[12px] text-muted-foreground">正在上传并保存到队列…</p>}

      {queueItems.length > 0 && (
        <div className="mt-4 rounded-[14px] border border-border bg-card p-3 sm:p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] font-medium text-foreground">
              {queuedCount > 0 ? `还有 ${queuedCount} 份资料待处理` : "队列中的资料"}
            </p>
            {queuedCount > 0 && <Button variant="secondary" size="sm" onClick={onContinue} disabled={queueUploading}>继续处理</Button>}
          </div>
          <ul className="mt-2.5 space-y-1.5 border-t border-border pt-2.5">
            {queueItems.slice(0, 4).map((item) => (
              <li key={item.id} className="flex min-w-0 items-center gap-2 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.error ?? item.originalName}>{item.originalName}</span>
                <span className={item.status === "failed" ? "shrink-0 text-[var(--warning)]" : "shrink-0 text-muted-foreground"}>
                  {item.status === "paused" ? "已暂停 · 进度保留" : item.status === "failed" ? "可继续 · 进度保留" : item.status === "processing" ? "处理中" : item.status === "awaiting_review" ? "待审阅" : "等待处理"}
                </span>
                {(item.status === "queued" || item.status === "failed" || item.status === "paused") && (
                  <button type="button" aria-label={`移除 ${item.originalName}`} className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => void onRemoveQueueItem(item.id)}>
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
            {queueItems.length > 4 && <li className="text-[11px] text-muted-foreground">另有 {queueItems.length - 4} 份资料</li>}
          </ul>
        </div>
      )}

      {readiness && (
        <div className="mt-4 space-y-1.5 text-[11.5px] leading-relaxed">
          {!readiness.model.configured && (
            <p className="text-[var(--warning)]">请先配置你的模型，保存后即可处理资料。<Link href="/settings#model-service" onClick={onConfigure} className="ml-1 underline underline-offset-4">去配置模型</Link></p>
          )}
          {!readiness.docling.available && (
            <p className="text-muted-foreground">PDF 将尝试轻量解析；扫描件若无法提取文字会明确提示 OCR 不可用，不会写入空内容。PowerPoint 暂不可导入。</p>
          )}
        </div>
      )}

      <div className="mt-5 space-y-2 border-t border-border pt-4 text-[12px] leading-relaxed text-muted-foreground">
        <p>· 原件会随知识库保存，随时可以重新处理。</p>
        <p>· 模型先分析、再写草稿，<strong className="text-foreground">你确认后才写入知识库</strong>。</p>
        <p>· 导入中可以关掉这个窗口去做别的事。</p>
        <p>· 已加入队列的资料会保存，刷新后可以继续；尚未完成上传的文件需要重新选择。</p>
        <p>· 旧版 .doc 文件请先另存为 .docx。</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 审阅面板 */

function ReviewPanel({
  draft,
  recovered,
  skipped,
  decisions,
  onAnswer,
  onToggleSkip,
  onRemovePage,
  onChange,
  committing,
  commitProgress,
}: {
  draft: IngestDraft;
  recovered: boolean;
  skipped: Set<string>;
  decisions: Map<number, ReviewDecisionDraft>;
  onAnswer: (index: number, answer: string, choiceId: string | null) => void;
  onToggleSkip: (title: string) => void;
  onRemovePage: (index: number) => void;
  onChange: (next: Draft) => void;
  committing: boolean;
  commitProgress: number;
}) {
  const data = draft;
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const analysis = data.analysis;
  const newPages = data.draft.newPages;
  const updates = data.draft.updatedPages;
  const items = data.draft.reviewItems;
  const createdCount = newPages.filter((p) => !skipped.has(p.title)).length;

  return (
    <div className="p-4 sm:p-5">
      {recovered && (
        <p className="mb-3 rounded-[10px] bg-[var(--muted)] px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          这是之前那次导入留下的草稿，还没写入知识库。确认或放弃都可以。
        </p>
      )}

      {/* 概览：一眼看清「这份资料是什么、会动到多少东西」 */}
      <div className="rounded-[16px] border border-border bg-card p-4">
        <p className="text-[13px] leading-relaxed text-foreground">{analysis.gist}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="neutral">{createdCount} 个新词条</Badge>
          {updates.length > 0 && <Badge tone="neutral">{updates.length} 个更新</Badge>}
          {items.length > 0 && <Badge tone="warning">{items.length} 条待你判断</Badge>}
          <Badge tone="neutral">{analysis.entities.length} 个实体</Badge>
          <Badge tone="neutral">{analysis.concepts.length} 个概念</Badge>
        </div>

        {analysis.contradictions.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-border pt-3">
            {analysis.contradictions.map((item, index) => (
              <p key={index} className="text-[12px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-[var(--warning)]">与已有知识矛盾：</span>
                「{item.existing}」说 {item.conflict}，这份资料说 {item.claim}
              </p>
            ))}
          </div>
        )}

        {data.warnings.length > 0 && (
          <div className="mt-3 space-y-1 border-t border-border pt-3">
            {data.warnings.map((warning, index) => (
              <p key={index} className="text-[12px] leading-relaxed text-[var(--warning)]">{warning}</p>
            ))}
          </div>
        )}
      </div>

      {/* 待你判断的事项：需要用户做决定，默认展开 */}
      {items.length > 0 && (
        <Section title="需要你处理的事项" count={items.length} hint="选择处理方向或写批注，确认写入时会一并处理">
          {items.map((item, index) => (
            <ReviewDecisionCard
              key={index}
              item={item}
              decision={decisions.get(index)}
              onAnswer={(text, choiceId) => onAnswer(index, text, choiceId)}
            />
          ))}
        </Section>
      )}

      {/* 新建词条：折叠行，需要时展开看正文 */}
      <Section
        title="新建词条"
        count={newPages.length}
        action={
          newPages.length > 1 ? (
            <button
              type="button"
              onClick={() =>
                setExpanded((prev) =>
                  prev.size >= newPages.length
                    ? new Set()
                    : new Set(newPages.map((_p, i) => `page:${i}`)),
                )
              }
              className="text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {expanded.size >= newPages.length ? "全部收起" : "全部展开"}
            </button>
          ) : null
        }
      >
        {newPages.map((page, index) => {
          const key = `page:${index}`;
          return (
            <CollapsibleCard
              key={key}
              title={page.title}
              type={page.type}
              summary={page.summary}
              expanded={expanded.has(key)}
              onToggle={() => toggle(key)}
              skipped={skipped.has(page.title)}
              onSkip={() => onToggleSkip(page.title)}
              onRemove={() => onRemovePage(index)}
              onTitleChange={(title) =>
                onChange({
                  ...data.draft,
                  newPages: newPages.map((p, i) => (i === index ? { ...p, title } : p)),
                })
              }
              onEdit={(content) =>
                onChange({
                  ...data.draft,
                  newPages: newPages.map((p, i) => (i === index ? { ...p, content } : p)),
                })
              }
              page={page}
            />
          );
        })}
        {newPages.length === 0 && (
          <p className="text-[12.5px] text-muted-foreground">这次没有需要新建的词条。</p>
        )}
      </Section>

      {/* 更新已有词条 */}
      {updates.length > 0 && (
        <Section title="更新已有词条" count={updates.length} hint="检查建议、差异和来源，再决定是否写入">
          {updates.map((update, index) => {
            const key = `update:${index}`;
            const isOpen = expanded.has(key);
            const disabled = skipped.has(update.title);
            const hasFullBody = update.originalContent !== undefined && update.expectedHash !== undefined && update.proposedContent !== undefined;
            const originalContent = update.originalContent ?? "";
            const proposedContent = update.proposedContent ?? "";
            return (
              <div key={key} className={cn("rounded-[14px] border border-border bg-card", disabled && "opacity-50")}>
                <div className="flex items-center gap-2 px-3.5 py-3">
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <ChevronRight
                      size={13}
                      className={cn("shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
                    />
                    <Pencil size={12} className="shrink-0 text-muted-foreground" />
                    <span className="truncate text-[13.5px] font-medium text-foreground">{update.title}</span>
                    <span className="truncate text-[12px] text-muted-foreground">{update.reason}</span>
                  </button>
                  <SkipButton disabled={disabled} onClick={() => onToggleSkip(update.title)} />
                </div>

                {isOpen && (
                  <div className="border-t border-border px-3.5 py-3">
                    {hasFullBody ? (
                      <details open className="mb-3 rounded-[10px] border border-border bg-background">
                        <summary className="cursor-pointer px-3 py-2 text-[11.5px] font-medium text-foreground">
                          查看正文差异
                        </summary>
                        <div className="max-h-72 overflow-y-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed">
                          {diffLines(originalContent, proposedContent).map((part, partIndex) => (
                            <pre
                              key={partIndex}
                              className={cn(
                                "whitespace-pre-wrap break-words",
                                part.added && "bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-foreground",
                                part.removed && "bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)] text-muted-foreground line-through",
                              )}
                            >
                              {part.value}
                            </pre>
                          ))}
                        </div>
                      </details>
                    ) : (
                      <p className="mb-2 text-[11.5px] leading-relaxed text-muted-foreground">
                        这是旧版追加式草稿；确认后只会把下面内容追加到原正文。
                      </p>
                    )}
                    <Textarea
                      value={hasFullBody ? update.proposedContent! : update.appendContent}
                      rows={hasFullBody ? 12 : 5}
                      aria-label={hasFullBody ? `${update.title} 更新后的完整正文` : `${update.title} 要追加的内容`}
                      onChange={(e) =>
                        onChange({
                          ...data.draft,
                          updatedPages: updates.map((u, i) =>
                            i === index
                              ? hasFullBody
                                ? { ...u, proposedContent: e.target.value }
                                : { ...u, appendContent: e.target.value }
                              : u,
                          ),
                        })
                      }
                    />
                    {update.citations.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        <p className="text-[11.5px] font-medium text-foreground">本次资料中的依据</p>
                        {update.citations.map((citation, citationIndex) => (
                          <p key={citationIndex} className="text-[11.5px] leading-relaxed text-muted-foreground">
                            {citation.page ? `第 ${citation.page} 页 · ` : ""}“{citation.quote}”
                          </p>
                        ))}
                      </div>
                    )}
                    {(update.addAliases.length > 0 || update.addTags.length > 0) && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {update.addAliases.map((alias) => (
                          <Badge key={alias} tone="neutral">+ 别名 {alias}</Badge>
                        ))}
                        {update.addTags.map((tag) => (
                          <Badge key={tag} tone="neutral">+ 标签 {tag}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {/* 来源摘要页 */}
      <Section title="来源摘要页" count={1} hint="这份资料本身的词条">
        <CollapsibleCard
          title={data.draft.sourceSummary.title}
          type="source"
          summary={firstLine(data.draft.sourceSummary.content)}
          expanded={expanded.has("summary")}
          onToggle={() => toggle("summary")}
          skipped={skipped.has(data.draft.sourceSummary.title)}
          onSkip={() => onToggleSkip(data.draft.sourceSummary.title)}
          onTitleChange={(title) =>
            onChange({
              ...data.draft,
              sourceSummary: { ...data.draft.sourceSummary, title },
            })
          }
          onEdit={(content) =>
            onChange({
              ...data.draft,
              sourceSummary: { ...data.draft.sourceSummary, content },
            })
          }
          page={{
            type: "source",
            title: data.draft.sourceSummary.title,
            summary: "",
            content: data.draft.sourceSummary.content,
            aliases: [],
            tags: [],
            confidence: "high",
            citations: [],
          }}
        />
      </Section>

      {committing && (
        <div className="mt-5">
          <ProgressBar value={commitProgress} max={100} label="正在写入知识库" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ 卡片与零件 */

/** 折叠卡片：一行标题 + 一句话，展开后才渲染正文 */
function CollapsibleCard({
  title,
  type,
  summary,
  expanded,
  onToggle,
  skipped,
  onSkip,
  onRemove,
  onTitleChange,
  onEdit,
  page,
}: {
  title: string;
  type: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  skipped: boolean;
  onSkip: () => void;
  onRemove?: () => void;
  onTitleChange?: (title: string) => void;
  onEdit: (content: string) => void;
  page: DraftPage;
}) {
  const { resolveWikilink } = useAppData();
  const [editing, setEditing] = React.useState(false);
  const [draftContent, setDraftContent] = React.useState(page.content);
  const [draftTitle, setDraftTitle] = React.useState(title);

  React.useEffect(() => setDraftContent(page.content), [page.content]);
  React.useEffect(() => setDraftTitle(title), [title]);

  return (
    <div className={cn("rounded-[14px] border border-border bg-card", skipped && "opacity-50")}>
      <div className="flex items-center gap-2 px-3.5 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            size={13}
            className={cn("shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
          <span className="truncate text-[13.5px] font-medium text-foreground">{draftTitle}</span>
          <TypeBadge type={type} />
          {page.confidence === "low" && <Badge tone="warning">弱结论</Badge>}
          {summary && (
            <span className="hidden truncate text-[12px] text-muted-foreground sm:block">{summary}</span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <SkipButton disabled={skipped} onClick={onSkip} />
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
              aria-label={`删除 ${draftTitle}`}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-3.5 py-3">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            {onTitleChange ? (
              <Input
                value={draftTitle}
                onChange={(e) => { setDraftTitle(e.target.value); onTitleChange(e.target.value); }}
                className="h-7 max-w-xs text-[13px] font-medium"
                aria-label={type === "source" ? "来源摘要标题" : "词条标题"}
              />
            ) : (
              <span className="text-[12px] text-muted-foreground">正文</span>
            )}
            <button
              type="button"
              onClick={() => {
                if (editing) onEdit(draftContent);
                setEditing((v) => !v);
              }}
              className="flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
            >
              {editing ? <><Save size={11} /> 完成编辑</> : <><Pencil size={11} /> 编辑</>}
            </button>
          </div>

          {editing ? (
            <Textarea
              value={draftContent}
              rows={12}
              onChange={(e) => { setDraftContent(e.target.value); onEdit(e.target.value); }}
              aria-label={`${title}的草稿正文`}
              className="font-mono text-[12.5px]"
            />
          ) : (
            <div className="rounded-[12px] border border-border bg-background p-3">
              {/* 草稿正文本来就由模型按 [[词条名]] 写成，这里必须把双链渲染出来 ——
                  否则审阅时看到的是满屏双方括号，读不出这段正文到底长什么样。
                  还没建出来的词条按普通文字渲染：它们正是这次要建的，
                  点进一个尚不存在的词条没有任何意义。 */}
              <MarkdownRenderer
                content={page.content}
                density="compact"
                resolveWikilink={resolveWikilink}
                brokenWikilinks="plain"
              />
            </div>
          )}

          {page.aliases.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">别名</span>
              {page.aliases.map((alias) => (
                <Badge key={alias} tone="neutral">{alias}</Badge>
              ))}
            </div>
          )}

          {page.citations.length > 0 && (
            <div className="mt-2.5 border-t border-border pt-2.5">
              <p className="mb-1 text-[11.5px] text-muted-foreground">
                原文依据（已通过校验{page.citations.some((c) => c.page) ? "，可定位到页码" : ""}）
              </p>
              {page.citations.slice(0, 2).map((citation, index) => (
                <p key={index} className="text-[11.5px] leading-relaxed text-muted-foreground">
                  {citation.page ? `第 ${citation.page} 页：` : ""}
                  {stripWikilinks(citation.quote).slice(0, 120)}
                  {citation.quote.length > 120 ? "…" : ""}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SkipButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        disabled
          ? "border-[var(--muted-foreground)] text-muted-foreground"
          : "border-[var(--focus-ring)] text-[var(--ring)]",
      )}
    >
      {disabled ? "已跳过" : "将写入"}
    </button>
  );
}

function Section({
  title,
  count,
  hint,
  action,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="text-[12px] font-semibold tracking-[0.08em] text-foreground">{title}</h3>
        <span className="text-[11.5px] tabular-nums text-muted-foreground">{count}</span>
        {hint && <span className="truncate text-[11.5px] text-muted-foreground">· {hint}</span>}
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/**
 * 一条待判事项 + 当场裁决。
 *
 * 与体检页的裁决卡片是同一套语义（采纳 / 忽略 + 一句可选说明），差别只在时机：
 * 这里点完随草稿一起落库；体检页那条是可以随时改判的长期记录。
 */
function ReviewDecisionCard({
  item,
  decision,
  onAnswer,
}: {
  item: DraftReviewItem;
  decision?: ReviewDecisionDraft;
  onAnswer: (answer: string, choiceId: string | null) => void;
}) {
  const [answerDraft, setAnswerDraft] = React.useState<AnswerDraft>({
    answer: decision?.answer ?? "",
    choiceId: decision?.choiceId ?? null,
  });

  // 「碰过了」而不是「裁决过了」：只回答了没裁决的条目也是处理过的，
  // 它会在提交之后由模型接着处理
  const handled = Boolean(decision?.answer?.trim());

  return (
    <div
      className={cn(
        "rounded-[14px] border p-3.5 transition-colors",
        handled
          ? "border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-[color-mix(in_srgb,var(--success)_5%,transparent)]"
          : "border-border bg-[color-mix(in_srgb,var(--warning)_5%,transparent)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {handled ? (
              <Check size={12} className="shrink-0 text-[var(--success)]" />
            ) : (
              <AlertTriangle size={12} className="shrink-0 text-[var(--warning)]" />
            )}
            <span className="text-[12.5px] font-medium text-foreground">{item.title}</span>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{item.detail}</p>

          {item.relatedTitles.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.relatedTitles.slice(0, 6).map((title) => (
                <Badge key={title} tone="neutral">{title}</Badge>
              ))}
            </div>
          )}
        </div>

      </div>

      {item.question && item.options && item.options.length >= 2 ? (
        <QuestionPicker
          question={item.question}
          options={item.options}
          value={answerDraft}
          onChange={(next) => {
            setAnswerDraft(next);
            onAnswer(next.answer, next.choiceId);
          }}
        />
      ) : (
        <>
          {item.question && (
            <p className="mt-3 text-[12.5px] font-medium leading-relaxed text-foreground">{item.question}</p>
          )}
        <Textarea
          className={item.question ? "mt-2" : "mt-3"}
          rows={2}
          value={answerDraft.choiceId ? "" : answerDraft.answer}
          aria-label={`对「${item.title}」的处理意见`}
          maxLength={500}
          placeholder="写下你希望如何处理这条问题…"
          onChange={(event) => {
            const next = { answer: event.target.value, choiceId: null };
            setAnswerDraft(next);
            onAnswer(next.answer, next.choiceId);
          }}
        />
        </>
      )}
      {handled && (
        <p className="mt-2 text-[11.5px] text-[var(--success)]">已填写，确认写入时会自动处理</p>
      )}
    </div>
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

function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

function firstLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 60) : "";
}
