"use client";
import * as React from "react";
import { X } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { Button, Input, Textarea, TypeBadge } from "@/components/ui";
import { apiFetch } from "@/hooks/use-api";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { cn, truncate } from "@/lib/utils";
import type { Message } from "./types";
import { MarkdownRenderer } from "@/components/markdown/renderer";

type FilingTarget = { id: string; title: string; contentHash: string };
type FilingPageOption = { pageId: string; title: string; type: string };
// 预览用文字呈现关联名称，避免离开尚未保存的表单；正文仍保留原始链接。
const previewWikilink = () => null;

/** 把只在当前问答轮次有效的引用编号，落成词条之间可长期使用的双链。 */
function answerForFiling(message: Message): string {
  const byIndex = new Map((message.citations?.list ?? []).map((citation) => [citation.index, citation]));
  return message.content.replace(/\[\s*ID\s*[:：]\s*(\d+)\s*\]/gi, (marker, indexText: string) => {
    const citation = byIndex.get(Number(indexText));
    return citation ? `[[${citation.pageTitle}]]` : marker;
  });
}

export function AnswerFilingDialog({ message: filingMessage, sessionId, onSaved, onClose }: {
  message: Message; sessionId: string | null; onSaved: () => Promise<void>; onClose: () => void;
}) {
  const { t } = useI18n();
  const panel = React.useRef<HTMLElement>(null);
  useModalFocus(true, panel, onClose);
  const [filingMode, setFilingMode] = React.useState<"new" | "existing">("new");
  const [filingTitle, setFilingTitle] = React.useState(() => truncate(filingMessage.content.replace(/\[\s*ID\s*[:：]\s*\d+\s*\]/gi, "").split("\n")[0].trim(), 40));
  const [filingContent, setFilingContent] = React.useState(() => answerForFiling(filingMessage));
  const [filingSearch, setFilingSearch] = React.useState("");
  const [filingOptions, setFilingOptions] = React.useState<FilingPageOption[]>([]);
  const [filingTarget, setFilingTarget] = React.useState<FilingTarget | null>(null);
  const [filingLoading, setFilingLoading] = React.useState(false);
  const [editingContent, setEditingContent] = React.useState(false);
  const [filingSaving, setFilingSaving] = React.useState(false);
  const [filingError, setFilingError] = React.useState<string | null>(null);
  const selectionRequest = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => selectionRequest.current?.abort(), []);
  React.useEffect(() => {
    const query = filingSearch.trim();
    if (!filingMessage || filingMode !== "existing" || filingTarget || query.length < 2) {
      setFilingOptions([]);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setFilingLoading(true);
      void apiFetch<{ results: FilingPageOption[] }>(`/api/search?q=${encodeURIComponent(query)}&limit=12`, { signal: controller.signal })
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
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [filingMessage, filingMode, filingSearch, filingTarget]);

  const selectFilingTarget = React.useCallback(async (option: FilingPageOption) => {
    if (!filingMessage) return;
    selectionRequest.current?.abort();
    const controller = new AbortController(); selectionRequest.current = controller;
    setFilingError(null);
    setFilingLoading(true);
    try {
      const page = await apiFetch<{ id: string; title: string; content: string; contentHash: string }>(`/api/pages/${option.pageId}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setFilingTarget({ id: page.id, title: page.title, contentHash: page.contentHash });
      setFilingContent(t("chat_workspace.m006", {v0: page.content.trimEnd(), v1: answerForFiling(filingMessage).trim()}));
    } catch (err) {
      if (!controller.signal.aborted) setFilingError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setFilingLoading(false);
    }
  }, [filingMessage, t]);

  const saveFiledAnswer = React.useCallback(async () => {
    if (!filingMessage || !sessionId) return;
    setFilingSaving(true);
    setFilingError(null);
    try {
      await apiFetch(`/api/chat/sessions/${sessionId}/file`, {
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
      await onSaved();
      onClose();
    } catch (err) {
      setFilingError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilingSaving(false);
    }
  }, [filingMessage, sessionId, filingMode, filingTitle, filingTarget, filingContent, onSaved, onClose]);

  return (
        <>
          <div
            data-modal-dismiss
            className="fixed inset-0 z-[var(--z-index-overlay)] bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]"
            onClick={() => onClose()}
            aria-hidden
          />
          <aside ref={panel} role="dialog" aria-modal="true" aria-labelledby="filing-dialog-title" className="panel-in fixed right-0 top-0 z-[var(--z-index-modal)] flex h-full w-full max-w-xl flex-col border-l border-border bg-background shadow-dialog">
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
              <div>
                <h2 id="filing-dialog-title" className="text-[14px] font-semibold text-foreground">{t("chat_workspace.m065")}</h2>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t("chat_workspace.m066")}</p>
              </div>
              <button type="button" onClick={() => onClose()} aria-label={t("chat_workspace.m051")} className="rounded-full p-2 text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground">
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
                  {t("chat_workspace.m067")}</button>
                <button
                  type="button"
                  aria-pressed={filingMode === "existing"}
                  onClick={() => { setFilingMode("existing"); setFilingTarget(null); setFilingContent(""); }}
                  className={cn("rounded-full border px-3 py-1.5 text-[12px]", filingMode === "existing" ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}
                >
                  {t("chat_workspace.m068")}</button>
              </div>

              {filingMode === "new" ? (
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground" htmlFor="filing-title">{t("chat_workspace.m069")}</label>
                  <Input id="filing-title" value={filingTitle} onChange={(event) => setFilingTitle(event.target.value)} maxLength={120} />
                </div>
              ) : (
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground" htmlFor="filing-search">{t("chat_workspace.m070")}</label>
                  {filingTarget ? (
                    <div className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-card px-3 py-2.5">
                      <span className="truncate text-[12.5px] text-foreground">{filingTarget.title}</span>
                      <Button size="sm" variant="ghost" onClick={() => { setFilingTarget(null); setFilingSearch(""); setFilingContent(""); }}>{t("chat_workspace.m071")}</Button>
                    </div>
                  ) : (
                    <>
                      <Input id="filing-search" value={filingSearch} onChange={(event) => setFilingSearch(event.target.value)} placeholder={t("chat_workspace.m072")} />
                      {filingLoading && <p className="mt-2 text-[11.5px] text-muted-foreground">{t("chat_workspace.m073")}</p>}
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
                        <p className="mt-2 text-[11.5px] text-muted-foreground">{t("chat_workspace.m074")}</p>
                      )}
                    </>
                  )}
                </div>
              )}

              {(filingMode === "new" || filingTarget) && (
                <div>
                  {editingContent
                    ? <label className="mb-1.5 block text-[12px] font-medium text-foreground" htmlFor="filing-content">{filingMode === "new" ? t("chat_workspace.m075") : t("chat_workspace.m076")}</label>
                    : <p className="mb-1.5 text-[12px] font-medium text-foreground">{filingMode === "new" ? t("chat_workspace.m075") : t("chat_workspace.m076")}</p>}
                  {filingMode === "existing" && (
                    <p className="mb-2 text-[11.5px] leading-relaxed text-muted-foreground">
                      {t("chat_workspace.m077")}</p>
                  )}
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditingContent(value => !value)}>{t(editingContent ? "answerPreview.read" : "answerPreview.edit")}</Button>
                  {editingContent
                    ? <Textarea id="filing-content" value={filingContent} onChange={(event) => setFilingContent(event.target.value)} rows={18} />
                    : <div id="filing-content" className="mt-2 rounded-xl border border-border bg-background p-4"><MarkdownRenderer content={filingContent} resolveWikilink={previewWikilink} brokenWikilinks="plain" /></div>}
                </div>
              )}

              {filingError && <p role="alert" className="rounded-[10px] border border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_7%,transparent)] p-3 text-[12px] text-foreground">{filingError}</p>}
            </div>

            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3.5">
              <Button variant="ghost" size="sm" disabled={filingSaving} onClick={() => onClose()}>{t("chat_workspace.m078")}</Button>
              <Button
                variant="primary"
                size="sm"
                loading={filingSaving}
                disabled={filingMode === "existing" && !filingTarget}
                onClick={() => void saveFiledAnswer()}
              >
                {filingMode === "new" ? t("chat_workspace.m079") : t("chat_workspace.m080")}
              </Button>
            </footer>
          </aside>
        </>
  );
}
