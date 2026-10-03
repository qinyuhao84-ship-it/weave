"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search, Plus, Network, ListTree, BookOpen, RefreshCw, FileText, ArrowUpRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { useAppData } from "@/components/app-provider";
import { useIngest } from "@/components/ingest/ingest-provider";
import {
  Button, Badge, TypeBadge, Input, Card, EmptyState, Hairline, RequestError, LoadingCards,
} from "@/components/ui";
import { apiFetch, useApi } from "@/hooks/use-api";
import { cn, truncate } from "@/lib/utils";
import { ingestFormatLabel } from "@/lib/ingest/parse/presentation";

/**
 * 知识库工作区。
 *
 * 双视图：文档视图（目录树 + 词条列表）与大纲视图（按类型折叠纵览）。
 * 导入做成这里的一个按钮 + 抽屉向导，不单独占一个界面 —— 这是用户明确要求的。
 */

type PageSummary = {
  id: string;
  title: string;
  type: string;
  aliases: string[];
  tags: string[];
  summary: string;
  sourceCount: number;
  inboundLinks: number;
};

type Overview = {
  pages: PageSummary[];
  total: number;
  offset: number;
  limit: number;
  counts: Record<string, number>;
  stats: { pages: number; links: number; edges: number; orphans: number; dangling: number };
  pendingReview: number;
};

type FullTextResult = { pageId: string; title: string; type: string; score: number; snippet: string };

const TYPE_ORDER = ["entity", "concept", "source", "query", "overview"] as const;
const TYPE_LABEL: Record<string, string> = {
  entity: "pageTypes.entity", concept: "pageTypes.concept", source: "pageTypes.source", query: "pageTypes.query", overview: "pageTypes.overview",
};
const PAGE_SIZE = 50;

export function WikiWorkspace({ initialQuery = "" }: { initialQuery?: string }) {
  const { t } = useI18n();
  const router = useRouter();
  // dataVersion 在导入提交后递增，「添加资料」完成时本页数据会自动重取，
  // 不再需要把 refresh 回调从外壳一路透传下来。
  const { dataVersion } = useAppData();
  const { openDrawer: openIngest } = useIngest();
  const { data: sourceData, refresh: refreshSources } = useApi<{ total: number }>("/api/sources?limit=1&offset=0", [dataVersion]);
  // 从 URL 起手：断链跳转带 ?missing=，体检页的条目带 ?q=，
  // 以前这两个深链都是死的（这一页从来不读 searchParams），跳过来看到的是一片空白。
  const [query, setQuery] = React.useState(initialQuery);
  const [activeType, setActiveType] = React.useState<string | null>(null);
  const [pageIndex, setPageIndex] = React.useState(0);
  const [pageQuery, setPageQuery] = React.useState(initialQuery.trim());
  const [view, setView] = React.useState<"list" | "outline">("list");
  const [fullTextResults, setFullTextResults] = React.useState<FullTextResult[]>([]);
  const [fullTextLoading, setFullTextLoading] = React.useState(false);
  const [fullTextError, setFullTextError] = React.useState<string | null>(null);
  const [searchAttempt, setSearchAttempt] = React.useState(0);
  const { data: readiness } = useApi<{ docling: { available: boolean } }>("/api/settings");
  const pagesPath = `/api/pages?limit=${PAGE_SIZE}&offset=${pageIndex * PAGE_SIZE}&q=${encodeURIComponent(pageQuery)}${activeType ? `&type=${encodeURIComponent(activeType)}` : ""}`;
  const { data, loading, error, refresh } = useApi<Overview>(pagesPath, [dataVersion]);

  const pages = React.useMemo(() => data?.pages ?? [], [data?.pages]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setPageQuery(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  React.useEffect(() => {
    const search = query.trim();
    setFullTextResults([]);
    setFullTextError(null);
    if (!search) {
      setFullTextResults([]);
      setFullTextLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setFullTextLoading(true);
    const timer = window.setTimeout(() => {
      void apiFetch<{ results: FullTextResult[] }>(`/api/search?q=${encodeURIComponent(search)}&limit=30`, { signal: controller.signal })
        .then((result) => { if (!cancelled) setFullTextResults(result.results); })
        .catch((error) => { if (!cancelled) setFullTextError(error instanceof Error ? error.message : t("wiki_workspace.m001")); })
        .finally(() => { if (!cancelled) setFullTextLoading(false); });
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, dataVersion, searchAttempt, t]);

  const visibleFullTextResults = fullTextResults.filter(hit => !activeType || hit.type === activeType);

  const grouped = React.useMemo(() => {
    const map = new Map<string, PageSummary[]>();
    for (const page of pages) {
      const bucket = map.get(page.type) ?? [];
      bucket.push(page);
      map.set(page.type, bucket);
    }
    return map;
  }, [pages]);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  React.useEffect(() => {
    if (data && pageIndex >= totalPages) setPageIndex(Math.max(0, totalPages - 1));
  }, [data, pageIndex, totalPages]);

  return (
    <>
      <PageHeader
        title={t("wiki_workspace.m002")}
        description={t("wiki_workspace.m003")}
        meta={
          data && (
            <>
              <Badge tone="neutral">{data.stats.pages} {t("wiki_workspace.m004")}</Badge>
              <Badge tone="neutral">{data.stats.edges} {t("wiki_workspace.m005")}</Badge>
              {data.stats.dangling > 0 && (
                <Badge tone="warning">{data.stats.dangling} {t("wiki_workspace.m006")}</Badge>
              )}
              {data.pendingReview > 0 && (
                <Link href="/review">
                  <Badge tone="warning">{data.pendingReview} {t("wiki_workspace.m007")}</Badge>
                </Link>
              )}
            </>
          )
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={13} strokeWidth={1.8} />}
              onClick={() => { void refresh(); void refreshSources(); }}
              aria-label={t("wiki_workspace.m008")}
            />
            <Button
              variant="secondary"
              size="sm"
              icon={view === "list" ? <ListTree size={13} /> : <BookOpen size={13} />}
              onClick={() => setView((v) => (v === "list" ? "outline" : "list"))}
            >
              {view === "list" ? t("wiki_workspace.m009") : t("wiki_workspace.m010")}
            </Button>
            <Link
              href="/sources"
              className="inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[14px] font-medium text-foreground transition-colors hover:bg-muted sm:h-7 sm:text-[12px]"
            >
              <FileText size={13} />
              {t("wiki_workspace.m011")}{typeof sourceData?.total === "number" ? ` ${sourceData.total}` : ""}
            </Link>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={13} strokeWidth={2} />}
              onClick={openIngest}
            >
              {t("wiki_workspace.m012")}</Button>
          </>
        }
      />

      <div className="@container mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
        {/* 搜索与筛选 */}
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPageIndex(0);
              }}
              placeholder={t("wiki_workspace.m013")}
              aria-label={t("wiki_workspace.m014")}
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={activeType === null}
              onClick={() => {
                setActiveType(null);
                setPageIndex(0);
              }}
              className={cn(
                "min-h-11 rounded-full border px-3 py-1 text-[13px] transition-colors sm:min-h-7 sm:px-2.5 sm:text-[12px]",
                activeType === null
                  ? "border-[var(--foreground)] text-foreground"
                  : "border-[var(--border)] text-muted-foreground hover:text-foreground",
              )}
            >
              {t("wiki_workspace.m015")}{data?.stats.pages ?? 0}
            </button>
            {TYPE_ORDER.filter((t) => (data?.counts[t] ?? 0) > 0).map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={activeType === type}
                onClick={() => {
                  setActiveType(activeType === type ? null : type);
                  setPageIndex(0);
                }}
                className={cn(
                  "min-h-11 rounded-full border px-3 py-1 text-[13px] transition-colors sm:min-h-7 sm:px-2.5 sm:text-[12px]",
                  activeType === type
                    ? "border-[var(--foreground)] text-foreground"
                    : "border-[var(--border)] text-muted-foreground hover:text-foreground",
                )}
              >
                {t(TYPE_LABEL[type])} {data?.counts[type] ?? 0}
              </button>
            ))}
          </div>
        </div>

        {query.trim() && (
          <section className="mb-6">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 className="text-[12.5px] font-semibold text-foreground">{t("wiki_workspace.m016")}</h2>
              <span role="status" className="text-[11.5px] text-muted-foreground">{fullTextLoading ? t("wiki_workspace.m017") : fullTextError ? t("wiki_workspace.m018") : t("wiki_workspace.m019", {v0: visibleFullTextResults.length})}</span>
            </div>
            {fullTextError ? <div role="alert" className="rounded-[10px] border border-border px-4 py-3 text-[12px]">
              <p>{t("wiki_workspace.m020")}{fullTextError}</p>
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setSearchAttempt(value => value + 1)}>{t("wiki_workspace.m021")}</Button>
            </div> : visibleFullTextResults.length > 0 ? (
              <Card className="divide-y divide-[var(--border)]">
                {visibleFullTextResults.map((hit) => (
                  <button key={hit.pageId} type="button" onClick={() => router.push(`/wiki/${hit.pageId}`)} className="block w-full px-4 py-3 text-left transition-colors hover:bg-[var(--muted)]">
                    <div className="flex min-w-0 items-start gap-2">
                      <TypeBadge type={hit.type} />
                      <span title={hit.title} className="min-w-0 line-clamp-3 text-[13px] font-medium text-foreground [overflow-wrap:anywhere]">{hit.title}</span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: hit.snippet }} />
                  </button>
                ))}
              </Card>
            ) : !fullTextLoading ? (
              <p className="rounded-[10px] border border-border px-4 py-3 text-[12px] text-muted-foreground">{t("wiki_workspace.m022")}</p>
            ) : null}
          </section>
        )}

        {loading && !error && <LoadingCards />}
        {error && <RequestError error={error} onRetry={() => void refresh()} retrying={loading} />}

        {!loading && !error && data?.stats.pages === 0 && (
          <Card>
            <EmptyState
              icon={<FileText size={30} strokeWidth={1.3} />}
              title={t("wiki_workspace.m023")}
              description={t("wiki_workspace.m025", {v0: ingestFormatLabel(readiness?.docling.available ?? false), v1: readiness?.docling.available ? "" : t("wiki_workspace.m024")})}
              action={
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Plus size={14} strokeWidth={2} />}
                  onClick={openIngest}
                >
                  {t("wiki_workspace.m026")}</Button>
              }
            />
          </Card>
        )}

        {!loading && !error && data && data.stats.pages > 0 && data.total === 0 && !fullTextLoading && !fullTextError && visibleFullTextResults.length === 0 && (
          <Card className="px-4 py-8 text-center">
            <p className="text-[13px] text-muted-foreground">
              {query.trim() ? t("wiki_workspace.m027", {v0: query}) : t("wiki_workspace.m028")}
            </p>
            {(query.trim() || activeType) && (
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => {
                setQuery("");
                setPageQuery("");
                setActiveType(null);
                setPageIndex(0);
              }}>
                {t("wiki_workspace.m029")}</Button>
            )}
          </Card>
        )}

        {!loading && !error && data && data.total > 0 && view === "list" && (
          <div className="grid grid-cols-1 gap-2.5 @min-[42rem]:grid-cols-2">
            {pages.map((page) => (
              <PageCard key={page.id} page={page} onNavigate={() => router.push(`/wiki/${page.id}`)} />
            ))}
          </div>
        )}

        {!loading && !error && data && data.total > 0 && view === "outline" && (
          <OutlineView grouped={grouped} onNavigate={(id) => router.push(`/wiki/${id}`)} />
        )}

        {!loading && !error && data && data.total > PAGE_SIZE && (
          <div className="mt-5 flex items-center justify-between gap-3">
            <Button variant="ghost" size="sm" disabled={pageIndex === 0} onClick={() => setPageIndex((page) => Math.max(0, page - 1))}>{t("wiki_workspace.m030")}</Button>
            <span className="text-[11.5px] tabular-nums text-muted-foreground">
              {t("wiki_workspace.m031")}{pageIndex + 1} / {totalPages} {t("wiki_workspace.m032")}{data.total} {t("wiki_workspace.m004")}</span>
            <Button variant="ghost" size="sm" disabled={pageIndex + 1 >= totalPages} onClick={() => setPageIndex((page) => Math.min(totalPages - 1, page + 1))}>{t("wiki_workspace.m033")}</Button>
          </div>
        )}

      </div>
    </>
  );
}

function PageCard({
  page,
  onNavigate,
}: {
  page: PageSummary;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onNavigate}
      className="group flex min-h-[144px] min-w-0 flex-col rounded-[16px] border border-border bg-card p-5 text-left transition-colors duration-150 hover:border-[var(--input)] hover:bg-[color-mix(in_srgb,var(--card)_96%,var(--foreground))] focus-visible:border-[var(--input)]"
    >
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <span title={page.title} className="min-w-0 line-clamp-3 text-[16px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{page.title}</span>
        <TypeBadge type={page.type} />
      </div>

      {page.summary && (
        <p className="line-clamp-3 text-[13.5px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {truncate(page.summary, 100)}
        </p>
      )}

      <div className="mt-auto flex items-end justify-between gap-2 pt-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
          {page.inboundLinks > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Network size={10} strokeWidth={1.8} />
              {page.inboundLinks} {t("wiki_workspace.m034")}</span>
          )}
          {page.aliases.slice(0, 2).map((alias) => (
            <span key={alias} title={alias} className="max-w-full truncate text-[11px] text-muted-foreground">
              {alias}
            </span>
          ))}
        </div>
        <ArrowUpRight size={15} strokeWidth={1.7} aria-hidden className="shrink-0 text-muted-foreground opacity-50 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </div>
    </button>
  );
}

/** 大纲视图：按类型折叠，快速纵览一个主题下的全部子概念 */
function OutlineView({
  grouped,
  onNavigate,
}: {
  grouped: Map<string, PageSummary[]>;
  onNavigate: (id: string) => void;
}) {
  return (
    <div className="space-y-6">
      {TYPE_ORDER.filter((type) => grouped.has(type)).map((type) => {
        const items = grouped.get(type)!;
        return (
          <section key={type}>
            <div className="mb-2 flex items-center gap-2">
              <TypeBadge type={type} />
              <span className="text-[12px] tabular-nums text-muted-foreground">{items.length}</span>
            </div>
            <Hairline className="mb-2" />
            <div className="space-y-0.5">
              {items.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => onNavigate(page.id)}
                  className="group flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--muted)]"
                >
                  <span className="text-[13px] font-medium text-foreground">{page.title}</span>
                  {page.summary && (
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                      {page.summary}
                    </span>
                  )}
                  {page.inboundLinks > 0 && (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {page.inboundLinks}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
