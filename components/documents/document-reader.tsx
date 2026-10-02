"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import { createPortal } from "react-dom";
import { Code2, Download, Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { apiFetch } from "@/hooks/use-api";
import { useModalFocus } from "@/hooks/use-modal-focus";

export function DocumentReader({ name, mediaType, status = "ready", contentUrl, downloadUrl, responseFormat = "json", previewClassName, testId }: {
  name: string; mediaType: string; status?: "ready" | "basic" | "incomplete";
  contentUrl: string; downloadUrl: string; responseFormat?: "json" | "text"; previewClassName?: string; testId?: string;
}) {
  const { t } = useI18n();
  const [content, setContent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const panel = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<HTMLIFrameElement>(null);
  const fullFrame = React.useRef<HTMLIFrameElement>(null);
  // 必须导航到带 CSP sandbox 响应头的独立文档；srcDoc 无法继承该响应头。
  const htmlPreviewUrl = responseFormat === "text" ? contentUrl : `${contentUrl}${contentUrl.includes("?") ? "&" : "?"}preview=1`;
  const canPreview = status !== "incomplete" && ["text/html", "text/markdown"].includes(mediaType);
  const close = React.useCallback(() => setFullscreen(false), []);
  useModalFocus(fullscreen, panel, close);
  React.useEffect(() => {
    if (!canPreview) return;
    let active = true;
    const controller = new AbortController();
    setContent(null);
    setError(null);
    const read = responseFormat === "json" ? apiFetch<{ content: string }>(contentUrl, { signal: controller.signal }).then(result => result.content)
      : fetch(contentUrl, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) }).then(async response => { if (!response.ok) throw new Error(t("documents_document_reader.m001")); return response.text(); });
    void read.then(text => { if (active) setContent(text); }).catch(error => { if (active) setError(error instanceof Error ? error.message : t("documents_document_reader.m001")); });
    return () => { active = false; controller.abort(); };
  }, [contentUrl, responseFormat, canPreview, attempt, t]);
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === fullFrame.current?.contentWindow && event.data?.type === "weave-artifact-escape") close();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [close]);
  const preview = (full: boolean) => mediaType === "text/html"
    ? <iframe ref={full ? fullFrame : frame} title={full ? t("documents_document_reader.m002", {v0: name}) : t("documents_document_reader.m003", {v0: name})} sandbox="allow-scripts" referrerPolicy="no-referrer" src={htmlPreviewUrl} className={full ? "h-full w-full flex-1 border-0 bg-[#fcfbf9]" : previewClassName ?? "h-[360px] w-full border-0 bg-[#fcfbf9] sm:h-[420px]"} />
    : <div className={full ? "flex-1 overflow-y-auto p-6 sm:px-12" : "max-h-[420px] overflow-y-auto p-5"}><MarkdownRenderer content={content ?? ""} /></div>;
  const download = <a href={downloadUrl} download className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"><Download size={13} aria-hidden />{t("documents_document_reader.m004")}{mediaType === "text/html" ? " HTML" : t("documents_document_reader.m005")}</a>;
  return <div className="overflow-hidden rounded-xl border border-border" data-testid={testId}>
    <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2"><Code2 size={15} className="shrink-0 text-[var(--waiting-accent)]" aria-hidden /><span className="min-w-0 truncate text-[12.5px] font-medium">{name}</span>{status !== "ready" && <span className="shrink-0 text-[10.5px] text-muted-foreground">{status === "basic" ? t("documents_document_reader.m006") : t("documents_document_reader.m007")}</span>}</div>
      <div className="flex items-center gap-1">{canPreview && content !== null && <Button size="sm" variant="ghost" icon={<Maximize2 size={13} />} onClick={() => setFullscreen(true)}>{t("documents_document_reader.m008")}</Button>}{download}</div>
    </div>
    {canPreview ? content !== null ? preview(false) : <div className="p-5 text-[12px] text-muted-foreground">{error ? <><p>{error}</p><Button size="sm" variant="ghost" className="mt-2" onClick={() => setAttempt(value => value + 1)}>{t("documents_document_reader.m009")}</Button></> : t("documents_document_reader.m010")}</div> : <p className="p-4 text-[12px] leading-relaxed text-muted-foreground">{status === "incomplete" ? t("documents_document_reader.m011") : t("documents_document_reader.m012")}</p>}
    {fullscreen && createPortal(<div ref={panel} role="dialog" aria-modal="true" aria-label={t("documents_document_reader.m013", {v0: name})} tabIndex={-1} className="fixed inset-0 z-[100] flex flex-col bg-background outline-none">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-2.5 sm:px-6"><h2 className="truncate text-[14px] font-medium">{name}</h2><div className="flex shrink-0 items-center gap-2">{download}<Button variant="ghost" size="sm" icon={<X size={16} />} onClick={close} aria-label={t("documents_document_reader.m014")}>{t("documents_document_reader.m015")}</Button></div></div>
      {preview(true)}
    </div>, document.body)}
  </div>;
}
