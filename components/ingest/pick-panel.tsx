"use client";
import { useI18n } from "@/components/i18n-provider";

import { Button, Input, Textarea } from "@/components/ui";
import { ingestFormatLabel } from "@/lib/ingest/parse/presentation";
import {
  CircleStop, ClipboardPaste,
  Trash2,
  Upload,
  X
} from "lucide-react";
import Link from "next/link";
import * as React from "react";

/* ------------------------------------------------------------ 选文件 */

export function PickPanel({
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
  const { t } = useI18n();
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteTitle, setPasteTitle] = React.useState("");
  const [pasteText, setPasteText] = React.useState("");

  const submitPaste = async () => {
    const title = pasteTitle.trim() || t("ingest_ingest_drawer.m038");
    const safeTitle = title.replace(/[\\/:*?"<>|\r\n]/g, "-").slice(0, 100) || t("ingest_ingest_drawer.m038");
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
        <p className="text-[14px] font-semibold text-foreground">{t("ingest_ingest_drawer.m039")}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          {t("ingest_ingest_drawer.m040")}</p>
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
            aria-label={t("ingest_ingest_drawer.m041")}
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
          <span className="text-[14px] font-medium text-foreground">{t("ingest_ingest_drawer.m042")}</span>
          <span className="mt-1.5 text-[12.5px] text-muted-foreground">
            {ingestFormatLabel(readiness?.docling.available ?? false)}
          </span>
        </button>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-[12px] border border-border bg-card px-3.5 py-2.5">
          <span className="text-[13px] font-medium text-foreground">{t("ingest_ingest_drawer.m043")}</span>
          <Button variant="secondary" size="sm" icon={<Upload size={12} />} onClick={onPick} disabled={queueUploading}>
            {t("ingest_ingest_drawer.m044")}</Button>
        </div>
      )}

      {!pasteOpen && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button variant="secondary" size="sm" icon={<ClipboardPaste size={13} />} onClick={() => setPasteOpen(true)}>
            {t("ingest_ingest_drawer.m043")}</Button>
          <p className="text-[11.5px] text-muted-foreground">{t("ingest_ingest_drawer.m045")}</p>
        </div>
      )}

      {pasteOpen && (
        <div className="mt-3 space-y-2.5 rounded-[12px] border border-border bg-card p-3.5">
          <Input value={pasteTitle} onChange={(event) => setPasteTitle(event.target.value)} placeholder={t("ingest_ingest_drawer.m046")} maxLength={100} aria-label={t("ingest_ingest_drawer.m047")} />
          <Textarea autoFocus value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder={t("ingest_ingest_drawer.m048")} rows={6} aria-label={t("ingest_ingest_drawer.m049")} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPasteOpen(false)}>{t("ingest_ingest_drawer.m050")}</Button>
            <Button variant="primary" size="sm" disabled={!pasteText.trim() || queueUploading} loading={queueUploading} onClick={() => void submitPaste()}>{t("ingest_ingest_drawer.m051")}</Button>
          </div>
        </div>
      )}

      {queueUploading && <p role="status" className="mt-3 text-[12px] text-muted-foreground">{t("ingest_ingest_drawer.m052")}</p>}

      {queueItems.length > 0 && (
        <div className="mt-4 rounded-[14px] border border-border bg-card p-3 sm:p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] font-medium text-foreground">
              {queuedCount > 0 ? t("ingest_ingest_drawer.m027", {v0: queuedCount}) : t("ingest_ingest_drawer.m053")}
            </p>
            {queuedCount > 0 && <Button variant="secondary" size="sm" onClick={onContinue} disabled={queueUploading}>{t("ingest_ingest_drawer.m054")}</Button>}
          </div>
          <ul className="mt-2.5 space-y-1.5 border-t border-border pt-2.5">
            {queueItems.slice(0, 4).map((item) => (
              <li key={item.id} className="flex min-w-0 items-center gap-2 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.error ?? item.originalName}>{item.originalName}</span>
                <span className={item.status === "failed" ? "shrink-0 text-[var(--warning)]" : "shrink-0 text-muted-foreground"}>
                  {item.status === "paused" ? t("ingest_ingest_drawer.m055") : item.status === "failed" ? t("ingest_ingest_drawer.m056") : item.status === "processing" ? t("ingest_ingest_drawer.m057") : item.status === "awaiting_review" ? t("ingest_ingest_drawer.m058") : t("ingest_ingest_drawer.m059")}
                </span>
                {(item.status === "queued" || item.status === "failed" || item.status === "paused") && (
                  <button type="button" aria-label={t("ingest_ingest_drawer.m060", {v0: item.originalName})} className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => void onRemoveQueueItem(item.id)}>
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
            {queueItems.length > 4 && <li className="text-[11px] text-muted-foreground">{t("ingest_ingest_drawer.m061")}{queueItems.length - 4} {t("ingest_ingest_drawer.m062")}</li>}
          </ul>
        </div>
      )}

      {readiness && (
        <div className="mt-4 space-y-1.5 text-[11.5px] leading-relaxed">
          {!readiness.model.configured && (
            <p className="text-[var(--warning)]">{t("ingest_ingest_drawer.m063")}<Link href="/settings#model-service" onClick={onConfigure} className="ml-1 underline underline-offset-4">{t("ingest_ingest_drawer.m064")}</Link></p>
          )}
          {!readiness.docling.available && (
            <p className="text-muted-foreground">{t("ingest_ingest_drawer.m065")}</p>
          )}
        </div>
      )}

      <div className="mt-5 space-y-2 border-t border-border pt-4 text-[12px] leading-relaxed text-muted-foreground">
        <p>{t("ingest_ingest_drawer.m066")}</p>
        <p>{t("ingest_ingest_drawer.m067")}<strong className="text-foreground">{t("ingest_ingest_drawer.m068")}</strong>。</p>
        <p>{t("ingest_ingest_drawer.m069")}</p>
        <p>{t("ingest_ingest_drawer.m070")}</p>
        <p>{t("ingest_ingest_drawer.m071")}</p>
      </div>
    </div>
  );
}

