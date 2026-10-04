"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, FileText, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { DocumentReader } from "@/components/documents/document-reader";
import { Badge, Button, Card, Input, LoadingCards, RequestError } from "@/components/ui";
import { useAppData } from "@/components/app-provider";
import { useIngest } from "@/components/ingest/ingest-provider";
import { apiFetch, useApi } from "@/hooks/use-api";
import { formatBytes, formatDate } from "@/lib/utils";

type SourceRecord = {
  id: string;
  originalName: string;
  title: string | null;
  byteSize: number;
  pageCount: number | null;
  status: string;
  importedAt: string;
  parser?: string | null;
  mimeType?: string | null;
  linkedPages?: Array<{ id: string; title: string }>;
};

type SourceList = { sources: SourceRecord[]; total: number; limit: number; offset: number };

export function SourcesWorkspace() {
  const { t, locale } = useI18n();
  const { dataVersion } = useAppData();
  const { adoptExistingJob, phase: ingestPhase } = useIngest();
  const [query, setQuery] = React.useState("");
  const [pageIndex, setPageIndex] = React.useState(0);
  const deferredQuery = React.useDeferredValue(query);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const { data, loading, error, refresh } = useApi<SourceList>(`/api/sources?limit=20&offset=${pageIndex * 20}&q=${encodeURIComponent(deferredQuery)}`, [dataVersion, ingestPhase]);
  const sources = data?.sources ?? [];

  const reprocess = async (source: SourceRecord) => {
    setBusyId(source.id);
    setActionError(null);
    try {
      const result = await apiFetch<{ jobId: string }>(`/api/sources/${source.id}/reprocess`, { method: "POST" });
      adoptExistingJob(result.jobId, source.originalName);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("sources_workspace.m001"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title={t("sources_workspace.m002")}
        maxWidth="5xl"
        description={t("sources_workspace.m003")}
        meta={data && <Badge tone="neutral">{data.total} {t("sources_workspace.m004")}</Badge>}
        actions={<Link href="/wiki" className="inline-flex h-11 items-center sm:h-7 gap-1.5 rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><ArrowLeft size={13} />{t("sources_workspace.m005")}</Link>}
      />
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Input value={query} onChange={(event) => { setQuery(event.target.value); setPageIndex(0); }} placeholder={t("sources_workspace.m006")} aria-label={t("sources_workspace.m007")} />
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={() => void refresh()}>{t("sources_workspace.m008")}</Button>
        </div>
        {actionError && <p role="alert" className="mb-3 text-[12px] text-[var(--destructive)]">{actionError}</p>}
        {loading && !data && !error ? (
          <LoadingCards />
        ) : error ? (
          <RequestError error={error} onRetry={() => void refresh()} retrying={loading} />
        ) : sources.length === 0 ? (
          <Card className="p-8 text-center">
            <FileText className="mx-auto mb-2 text-muted-foreground" size={24} strokeWidth={1.5} />
            <p className="text-[13px] font-medium text-foreground">{query ? t("sources_workspace.m009") : t("sources_workspace.m010")}</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground">{t("sources_workspace.m011")}</p>
          </Card>
        ) : (
          <Card className="divide-y divide-[var(--border)]">
            {sources.map((source) => (
              <article key={source.id} className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between md:px-5">
                <div className="min-w-0 flex-1">
                  <Link href={`/sources/${source.id}`} className="break-words text-[13px] font-medium text-foreground underline decoration-transparent underline-offset-4 hover:decoration-current">
                    {source.originalName}
                  </Link>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    {formatDate(source.importedAt, locale)} · {formatBytes(source.byteSize)}{source.pageCount ? t("sources_workspace.m012", {v0: source.pageCount}) : ""}
                    {source.parser ? ` · ${source.parser}` : ""}
                  </p>
                  {source.linkedPages && source.linkedPages.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {source.linkedPages.slice(0, 5).map((page) => (
                        <Link key={page.id} href={`/wiki/${page.id}`} className="rounded-full border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground">{page.title}</Link>
                      ))}
                      {source.linkedPages.length > 5 && <span className="px-1 py-0.5 text-[10.5px] text-muted-foreground">{t("sources_workspace.m013")}{source.linkedPages.length - 5} {t("sources_workspace.m014")}</span>}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <StatusBadge status={source.status} />
                  <Link href={`/sources/${source.id}`} className="inline-flex h-11 items-center sm:h-7 gap-1.5 rounded-full border border-border bg-card px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"><ExternalLink size={12} />{t("sources_workspace.m015")}</Link>
                  <a href={`/api/sources/${source.id}/raw`} className="px-1 text-[11.5px] text-muted-foreground underline underline-offset-4 hover:text-foreground">{t("sources_workspace.m016")}</a>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<RefreshCw size={11} />}
                    disabled={source.status === "parsing" || busyId !== null || ingestPhase === "running" || ingestPhase === "review"}
                    loading={busyId === source.id}
                    onClick={() => void reprocess(source)}
                  >
                    {t("sources_workspace.m017")}</Button>
                </div>
              </article>
            ))}
          </Card>
        )}
        {data && data.total > 20 && <nav aria-label={t("sources_workspace.m018")} className="mt-4 flex items-center justify-between gap-3">
          <Button variant="secondary" size="sm" disabled={loading || pageIndex === 0} onClick={() => setPageIndex(index => index - 1)}>{t("sources_workspace.m019")}</Button>
          <span className="text-[12px] text-muted-foreground">{t("sources_workspace.m020")}{pageIndex + 1} / {Math.ceil(data.total / 20)} {t("sources_workspace.m021")}</span>
          <Button variant="secondary" size="sm" disabled={loading || (pageIndex + 1) * 20 >= data.total} onClick={() => setPageIndex(index => index + 1)}>{t("sources_workspace.m022")}</Button>
        </nav>}
      </div>
    </>
  );
}

export function SourceDetailWorkspace({ sourceId }: { sourceId: string }) {
  const { t, locale } = useI18n();
  const { dataVersion } = useAppData();
  const { phase: ingestPhase } = useIngest();
  const { data: sourceData, loading, error, refresh } = useApi<SourceRecord>(`/api/sources/${sourceId}`, [dataVersion, ingestPhase]);
  // useApi 保留旧响应以便同页刷新；详情必须核对归属，不能展示上一份资料。
  const source = sourceData?.id === sourceId ? sourceData : null;
  const [parsed, setParsed] = React.useState<{ sourceId: string; markdown: string | null; error: string | null; loading: boolean } | null>(null);
  const [parsedAttempt, setParsedAttempt] = React.useState(0);
  const currentParsed = parsed?.sourceId === sourceId ? parsed : null;
  const markdown = currentParsed?.markdown ?? null;
  const parsedError = currentParsed?.error ?? null;
  const parsedLoading = !currentParsed || currentParsed.loading;
  const isPdf = Boolean(source?.originalName.toLowerCase().endsWith(".pdf"));
  const isHtml = Boolean(source && (/\.html?$/i.test(source.originalName) || source.mimeType === "text/html"));
  const [showParsed, setShowParsed] = React.useState(false);
  React.useEffect(() => { setShowParsed(false); }, [sourceId]);

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setParsed({ sourceId, markdown: null, error: null, loading: true });
    void fetch(`/api/sources/${sourceId}/parsed`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? t("sources_workspace.m023"));
        }
        return response.text();
      })
      .then((text) => { if (!cancelled) setParsed({ sourceId, markdown: text, error: null, loading: false }); })
      .catch((err) => { if (!cancelled) setParsed({ sourceId, markdown: null, error: err instanceof Error && err.name !== "TimeoutError" ? err.message : t("sources_workspace.m024"), loading: false }); });
    return () => { cancelled = true; controller.abort(); };
  }, [sourceId, parsedAttempt, t]);

  return (
    <>
      <PageHeader
        title={source?.title || source?.originalName || t("sources_workspace.m002")}
        maxWidth="5xl"
        description={source?.originalName}
        meta={source && <><StatusBadge status={source.status} /><Badge tone="neutral">{formatBytes(source.byteSize)}</Badge>{source.pageCount ? <Badge tone="neutral">{source.pageCount} {t("sources_workspace.m021")}</Badge> : null}</>}
        actions={<Link href="/sources" className="inline-flex h-11 items-center sm:h-7 gap-1.5 rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><ArrowLeft size={13} />{t("sources_workspace.m025")}</Link>}
      />
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        {loading && !source && !error ? <LoadingCards /> : error ? (
          <RequestError error={error} onRetry={() => void refresh()} retrying={loading} />
        ) : source ? (
          <>
            {isHtml && <div role="group" aria-label={t("sources_workspace.m026")} className="mb-4 flex gap-1"><Button size="sm" variant={showParsed ? "ghost" : "secondary"} aria-pressed={!showParsed} onClick={() => setShowParsed(false)}>{t("sources_workspace.m027")}</Button><Button size="sm" variant={showParsed ? "secondary" : "ghost"} aria-pressed={showParsed} onClick={() => setShowParsed(true)}>{t("sources_workspace.m028")}</Button></div>}
            {!isHtml && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-border bg-card px-4 py-3">
              <div className="min-w-0">
                <p className="break-all text-[12px] font-medium text-foreground">{source.originalName}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{t("sources_workspace.m029")}{formatDate(source.importedAt, locale)}{source.parser ? t("sources_workspace.m030", {v0: source.parser}) : ""}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {isPdf && <a className="inline-flex h-11 items-center sm:h-7 gap-1.5 rounded-full border border-border bg-card px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted" href={`/api/sources/${source.id}/raw?view=1`} target="_blank" rel="noreferrer"><ExternalLink size={12} />{t("sources_workspace.m031")}</a>}
                <a className="inline-flex h-11 items-center sm:h-7 rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" href={`/api/sources/${source.id}/raw`}>{t("sources_workspace.m016")}</a>
              </div>
            </div>}
            {isHtml && !showParsed ? <DocumentReader name={source.originalName} mediaType="text/html" responseFormat="text" contentUrl={`/api/sources/${source.id}/raw?view=1`} downloadUrl={`/api/sources/${source.id}/raw`} previewClassName="h-[72vh] min-h-[420px] w-full border-0 bg-[#fcfbf9]" /> : isPdf ? (
              <section aria-label={t("sources_workspace.m032")} className="overflow-hidden rounded-[12px] border border-border bg-[var(--muted)]">
                <iframe title={t("sources_workspace.m033", {v0: source.originalName})} src={`/api/sources/${source.id}/raw?view=1`} className="h-[min(76vh,980px)] min-h-[420px] w-full bg-white" />
              </section>
            ) : parsedLoading ? (
              <LoadingCards />
            ) : parsedError ? (
              <RequestError error={parsedError} onRetry={() => setParsedAttempt(attempt => attempt + 1)} />
            ) : markdown ? (
              <Card className="min-w-0 overflow-hidden px-5 py-6 md:px-8 md:py-8">
                <MarkdownRenderer content={markdown} density="comfortable" className="mx-auto max-w-[72ch]" />
              </Card>
            ) : (
              <Card className="p-4"><p className="text-[12px] text-muted-foreground">{t("sources_workspace.m034")}</p></Card>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const tone = status === "parsed" ? "success" : status === "failed" ? "warning" : status === "parsing" || status === "awaiting_review" ? "accent" : "neutral";
  const label = status === "parsed" ? t("sources_workspace.m035") : status === "awaiting_review" ? t("sources_workspace.m036") : status === "failed" ? t("sources_workspace.m037") : status === "parsing" ? t("sources_workspace.m038") : t("sources_workspace.m039");
  return <Badge tone={tone}>{label}</Badge>;
}
