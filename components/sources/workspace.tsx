"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, FileText, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { DocumentReader } from "@/components/documents/document-reader";
import { Badge, Button, Card, Input, Spinner } from "@/components/ui";
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
  const { dataVersion } = useAppData();
  const { adoptExistingJob, phase: ingestPhase } = useIngest();
  const [query, setQuery] = React.useState("");
  const [pageIndex, setPageIndex] = React.useState(0);
  const deferredQuery = React.useDeferredValue(query);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const { data, loading, error, refresh } = useApi<SourceList>(`/api/sources?limit=20&offset=${pageIndex * 20}&q=${encodeURIComponent(deferredQuery)}`, [dataVersion]);
  const sources = data?.sources ?? [];

  const reprocess = async (source: SourceRecord) => {
    setBusyId(source.id);
    setActionError(null);
    try {
      const result = await apiFetch<{ jobId: string }>(`/api/sources/${source.id}/reprocess`, { method: "POST" });
      adoptExistingJob(result.jobId, source.originalName);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "重新处理没有完成。");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="原始资料"
        maxWidth="5xl"
        description="集中查看已导入的原件、解析稿和关联词条。"
        meta={<Badge tone="neutral">{data?.total ?? 0} 份资料</Badge>}
        actions={<Link href="/wiki" className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><ArrowLeft size={13} />回到知识库</Link>}
      />
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Input value={query} onChange={(event) => { setQuery(event.target.value); setPageIndex(0); }} placeholder="搜索全部资料的文件名或标题……" aria-label="搜索原始资料" />
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={() => void refresh()}>刷新</Button>
        </div>
        {actionError && <p role="alert" className="mb-3 text-[12px] text-[var(--destructive)]">{actionError}</p>}
        {loading && !data ? (
          <div className="flex justify-center py-20 text-muted-foreground"><Spinner size={18} /></div>
        ) : error ? (
          <Card className="p-4"><p role="alert" className="text-[12.5px] text-[var(--destructive)]">{error}</p></Card>
        ) : sources.length === 0 ? (
          <Card className="p-8 text-center">
            <FileText className="mx-auto mb-2 text-muted-foreground" size={24} strokeWidth={1.5} />
            <p className="text-[13px] font-medium text-foreground">{query ? "没有匹配的资料" : "还没有导入资料"}</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground">导入完成后，原件与解析稿会显示在这里。</p>
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
                    {formatDate(source.importedAt)} · {formatBytes(source.byteSize)}{source.pageCount ? ` · ${source.pageCount} 页` : ""}
                    {source.parser ? ` · ${source.parser}` : ""}
                  </p>
                  {source.linkedPages && source.linkedPages.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {source.linkedPages.slice(0, 5).map((page) => (
                        <Link key={page.id} href={`/wiki/${page.id}`} className="rounded-full border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground">{page.title}</Link>
                      ))}
                      {source.linkedPages.length > 5 && <span className="px-1 py-0.5 text-[10.5px] text-muted-foreground">另有 {source.linkedPages.length - 5} 条</span>}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <StatusBadge status={source.status} />
                  <Link href={`/sources/${source.id}`} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"><ExternalLink size={12} />查看资料</Link>
                  <a href={`/api/sources/${source.id}/raw`} className="px-1 text-[11.5px] text-muted-foreground underline underline-offset-4 hover:text-foreground">下载原件</a>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<RefreshCw size={11} />}
                    disabled={source.status === "parsing" || busyId !== null || ingestPhase === "running" || ingestPhase === "review"}
                    loading={busyId === source.id}
                    onClick={() => void reprocess(source)}
                  >
                    重新处理
                  </Button>
                </div>
              </article>
            ))}
          </Card>
        )}
        {data && data.total > 20 && <nav aria-label="资料分页" className="mt-4 flex items-center justify-between gap-3">
          <Button variant="secondary" size="sm" disabled={loading || pageIndex === 0} onClick={() => setPageIndex(index => index - 1)}>上一页</Button>
          <span className="text-[12px] text-muted-foreground">第 {pageIndex + 1} / {Math.ceil(data.total / 20)} 页</span>
          <Button variant="secondary" size="sm" disabled={loading || (pageIndex + 1) * 20 >= data.total} onClick={() => setPageIndex(index => index + 1)}>下一页</Button>
        </nav>}
      </div>
    </>
  );
}

export function SourceDetailWorkspace({ sourceId }: { sourceId: string }) {
  const { data: source, loading, error } = useApi<SourceRecord>(`/api/sources/${sourceId}`);
  const [markdown, setMarkdown] = React.useState<string | null>(null);
  const [parsedError, setParsedError] = React.useState<string | null>(null);
  const [parsedLoading, setParsedLoading] = React.useState(true);
  const isPdf = Boolean(source?.originalName.toLowerCase().endsWith(".pdf"));
  const isHtml = Boolean(source && (/\.html?$/i.test(source.originalName) || source.mimeType === "text/html"));
  const [showParsed, setShowParsed] = React.useState(false);
  React.useEffect(() => { setShowParsed(false); }, [sourceId]);

  React.useEffect(() => {
    let cancelled = false;
    setParsedLoading(true);
    setParsedError(null);
    void fetch(`/api/sources/${sourceId}/parsed`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? "解析稿当前不可用。");
        }
        return response.text();
      })
      .then((text) => { if (!cancelled) setMarkdown(text); })
      .catch((err) => { if (!cancelled) setParsedError(err instanceof Error ? err.message : "读取解析稿失败。"); })
      .finally(() => { if (!cancelled) setParsedLoading(false); });
    return () => { cancelled = true; };
  }, [sourceId]);

  return (
    <>
      <PageHeader
        title={source?.title || source?.originalName || "原始资料"}
        maxWidth="5xl"
        description={source?.originalName}
        meta={source && <><StatusBadge status={source.status} /><Badge tone="neutral">{formatBytes(source.byteSize)}</Badge>{source.pageCount ? <Badge tone="neutral">{source.pageCount} 页</Badge> : null}</>}
        actions={<Link href="/sources" className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><ArrowLeft size={13} />资料列表</Link>}
      />
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        {loading && !source ? <div className="flex justify-center py-20"><Spinner size={18} /></div> : error ? (
          <Card className="p-4"><p role="alert" className="text-[12.5px] text-[var(--destructive)]">{error}</p></Card>
        ) : source ? (
          <>
            {isHtml && <div role="group" aria-label="资料视图" className="mb-4 flex gap-1"><Button size="sm" variant={showParsed ? "ghost" : "secondary"} aria-pressed={!showParsed} onClick={() => setShowParsed(false)}>原件</Button><Button size="sm" variant={showParsed ? "secondary" : "ghost"} aria-pressed={showParsed} onClick={() => setShowParsed(true)}>解析稿</Button></div>}
            {!isHtml && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-border bg-card px-4 py-3">
              <div className="min-w-0">
                <p className="break-all text-[12px] font-medium text-foreground">{source.originalName}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">导入于 {formatDate(source.importedAt)}{source.parser ? ` · 使用 ${source.parser} 解析` : ""}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {isPdf && <a className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted" href={`/api/sources/${source.id}/raw?view=1`} target="_blank" rel="noreferrer"><ExternalLink size={12} />新窗口查看 PDF</a>}
                <a className="inline-flex h-7 items-center rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" href={`/api/sources/${source.id}/raw`}>下载原件</a>
              </div>
            </div>}
            {isHtml && !showParsed ? <DocumentReader name={source.originalName} mediaType="text/html" responseFormat="text" contentUrl={`/api/sources/${source.id}/raw?view=1`} downloadUrl={`/api/sources/${source.id}/raw`} previewClassName="h-[72vh] min-h-[420px] w-full border-0 bg-[#fcfbf9]" /> : isPdf ? (
              <section aria-label="PDF 原件预览" className="overflow-hidden rounded-[12px] border border-border bg-[var(--muted)]">
                <iframe title={`${source.originalName} PDF 预览`} src={`/api/sources/${source.id}/raw?view=1`} className="h-[min(76vh,980px)] min-h-[420px] w-full bg-white" />
              </section>
            ) : parsedLoading ? (
              <Card className="flex justify-center py-16"><Spinner size={18} /></Card>
            ) : markdown ? (
              <Card className="min-w-0 overflow-hidden px-5 py-6 md:px-8 md:py-8">
                <MarkdownRenderer content={markdown} density="comfortable" className="mx-auto max-w-[72ch]" />
              </Card>
            ) : (
              <Card className="p-4"><p className="text-[12px] text-muted-foreground">{parsedError ?? "这份资料还没有生成解析稿。"}</p></Card>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "parsed" ? "success" : status === "failed" ? "warning" : status === "parsing" || status === "awaiting_review" ? "accent" : "neutral";
  const label = status === "parsed" ? "已处理" : status === "awaiting_review" ? "待审阅" : status === "failed" ? "处理失败" : status === "parsing" ? "处理中" : "待处理";
  return <Badge tone={tone}>{label}</Badge>;
}
