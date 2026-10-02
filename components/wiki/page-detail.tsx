"use client";
import { useI18n } from "@/components/i18n-provider";

import { useAppData } from "@/components/app-provider";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Hairline,
  Input,
  Spinner,
  Textarea,
  TypeBadge,
} from "@/components/ui";
import { ApiError, apiFetch, useApi } from "@/hooks/use-api";
import { cn, formatDate, truncate } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ExternalLink,
  GitMerge,
  Link2,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { DeleteDialog, MergeDialog } from "./page-actions";

/**
 * 词条详情。
 *
 * 三栏：正文（左，主区域）+ 元信息面板（右）。
 * 编辑走乐观并发控制 —— 提交时带上打开页面时读到的内容哈希，
 * 服务端发现文件被外部改过就报冲突，而不是静默覆盖。
 * 这样用户在 Obsidian 里同时编辑时不会丢改动。
 */

type Backlink = { pageId: string; title: string; occurrences: number };
type OutgoingLink = { raw: string; resolved: boolean; pageId: string | null; title: string | null };

type PageDetailData = {
  id: string;
  title: string;
  type: string;
  aliases: string[];
  tags: string[];
  sources: Array<{ doc: string; page?: number; quote?: string }>;
  confidence: string;
  created: string;
  updated: string;
  content: string;
  /** 编辑时回传给服务端做乐观并发控制，不是给用户看的 */
  contentHash: string;
  backlinks: Backlink[];
  outgoing: OutgoingLink[];
};

export function PageDetail({ pageId }: { pageId: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  // 写操作成功后要 bumpData()：侧栏是路由组级别常驻的、按 dataVersion 自己取数，
  // 不通知它的话，「知识库正常」弹层里的词条数会一直停在旧值直到手动刷新。
  const { dataVersion, bumpData } = useAppData();
  const { data, loading, error, refresh } = useApi<PageDetailData>(`/api/pages/${pageId}`, [dataVersion]);

  const [editing, setEditing] = React.useState(false);
  const [draftContent, setDraftContent] = React.useState("");
  const [draftTitle, setDraftTitle] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);

  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [mergeOpen, setMergeOpen] = React.useState(false);

  React.useEffect(() => {
    if (data && !editing) {
      setDraftContent(data.content);
      setDraftTitle(data.title);
    }
  }, [data, editing]);

  const handleSave = React.useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiFetch(`/api/pages/${pageId}`, {
        method: "PATCH",
        body: JSON.stringify({
          content: draftContent,
          title: draftTitle,
          expectedHash: data.contentHash,
        }),
      });
      setEditing(false);
      setConflict(false);
      await refresh();
      bumpData();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSaveError(message);
      if (err instanceof ApiError && err.code === "CONFLICT") setConflict(true);
    } finally {
      setSaving(false);
    }
  }, [data, pageId, draftContent, draftTitle, refresh, bumpData]);

  // 双链解析。原来这里恒返回 null，于是正文里**每一个** [[X]] 都被渲染成虚线断链，
  // 点击还会跳回列表并且搜索框是空的 —— 用户点一个明明存在的双链，看到的是「没有这个词条」。
  // data.outgoing 里本来就有 raw → pageId 的映射，直接用。
  const resolveWikilink = React.useCallback(
    (target: string) => {
      // 正文里写的是 [[原始文本]]，所以先比 raw；改名后 raw 与规范标题可能不同，
      // 再比一次 title 兜住这种情况。
      const hit = data?.outgoing.find(
        (link) => link.raw === target || link.title === target,
      );
      return hit?.pageId ? { pageId: hit.pageId, title: hit.title ?? target } : null;
    },
    [data?.outgoing],
  );

  const goToPage = React.useCallback(
    (targetPageId: string, target: string) => {
      if (targetPageId) router.push(`/wiki/${targetPageId}`);
      else router.push(`/wiki?missing=${encodeURIComponent(target)}`);
    },
    [router],
  );

  if (loading) {
    return (
      <>
        <div className="flex items-center justify-center py-32 text-muted-foreground">
          <Spinner size={18} />
        </div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <div className="mx-auto max-w-3xl px-6 py-20">
          <Card>
            <EmptyState
              title={t("wiki_page_detail.m001")}
              description={error ?? t("wiki_page_detail.m002")}
              action={
                <Link href="/wiki">
                  <Button variant="secondary" size="md" icon={<ArrowLeft size={13} />}>
                    {t("wiki_page_detail.m003")}</Button>
                </Link>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      {/* 顶部工具栏 */}
      {/* 移动端要让开顶部的导航条（h-12），桌面端没有全局头部，直接贴顶 */}
      <div className="sticky top-12 z-[var(--z-index-sticky)] border-b border-border bg-[color-mix(in_srgb,var(--background)_92%,transparent)] backdrop-blur-sm md:top-0">
        <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-3 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href="/wiki"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
              aria-label={t("wiki_page_detail.m003")}
            >
              <ArrowLeft size={14} />
            </Link>
            <span className="truncate text-[13px] font-medium text-foreground">{data.title}</span>
            <TypeBadge type={data.type} />
            {data.confidence === "low" && <Badge tone="warning">{t("wiki_page_detail.m004")}</Badge>}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {editing ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X size={13} />}
                  onClick={() => {
                    setEditing(false);
                    setDraftContent(data.content);
                    setDraftTitle(data.title);
                    setSaveError(null);
                  }}
                >
                  {t("wiki_page_detail.m005")}</Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={saving}
                  icon={<Check size={13} strokeWidth={2} />}
                  onClick={handleSave}
                >
                  {t("wiki_page_detail.m006")}</Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Pencil size={12} />}
                  onClick={() => setEditing(true)}
                >
                  {t("wiki_page_detail.m007")}</Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<GitMerge size={12} />}
                  onClick={() => setMergeOpen(true)}
                >
                  {t("wiki_page_detail.m008")}</Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={12} />}
                  onClick={() => setDeleteOpen(true)}
                  aria-label={t("wiki_page_detail.m009")}
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 md:px-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        {/* 正文 */}
        <div className="min-w-0">
          {saveError && (
            <div className="mb-4 rounded-[12px] border border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_7%,transparent)] p-3.5">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--destructive)]" />
                <div className="min-w-0">
                  <p className="text-[12.5px] leading-relaxed text-foreground">{saveError}</p>
                  {conflict && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2.5"
                      icon={<RotateCcw size={12} />}
                      onClick={() => {
                        void refresh();
                        setEditing(false);
                        setConflict(false);
                      }}
                    >
                      {t("wiki_page_detail.m010")}</Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {editing ? (
            <div className="space-y-3">
              <Input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder={t("wiki_page_detail.m011")}
                className="text-[15px] font-medium"
              />
              <Textarea
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                rows={26}
                className="font-mono text-[13px] leading-relaxed"
              />
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                {t("wiki_page_detail.m012")}<code className="rounded bg-[var(--muted)] px-1">{t("wiki_page_detail.m013")}</code> {t("wiki_page_detail.m014")}</p>
            </div>
          ) : (
            <Card className="px-6 py-7 md:px-10 md:py-9">
              <MarkdownRenderer
                content={data.content}
                resolveWikilink={resolveWikilink}
                onWikilinkClick={goToPage}
              />
            </Card>
          )}
        </div>

        {/* 元信息面板 */}
        <aside className="space-y-4 lg:sticky lg:top-16 lg:self-start">
          <MetaSection title={t("wiki_page_detail.m015")}>
            {/*
              slug 与磁盘路径曾经也在这里显示。去掉它们不是嫌挤，是它们回答不了
              用户会问的任何问题：「这个文件在哪」是 Obsidian / Finder 的活，
              而 slug 是一个从标题派生的、用户从不需要读写的中间值。
              同一条纪律见 components/history/workspace.tsx 顶部 —— 那里连 commit
              sha 都不显示。它们是实现细节，露出来只会让这一栏看起来像调试面板。
            */}
            <MetaRow label={t("wiki_page_detail.m016")} value={<TypeBadge type={data.type} />} />
            <MetaRow label={t("wiki_page_detail.m017")} value={data.confidence} />
            <MetaRow label={t("wiki_page_detail.m018")} value={formatDate(data.created, locale)} />
            <MetaRow label={t("wiki_page_detail.m019")} value={formatDate(data.updated, locale)} />
          </MetaSection>

          {data.aliases.length > 0 && (
            <MetaSection title={t("wiki_page_detail.m020")}>
              <div className="flex flex-wrap gap-1.5">
                {data.aliases.map((alias) => (
                  <Badge key={alias} tone="neutral">{alias}</Badge>
                ))}
              </div>
            </MetaSection>
          )}

          {data.tags.length > 0 && (
            <MetaSection title={t("wiki_page_detail.m021")}>
              <div className="flex flex-wrap gap-1.5">
                {data.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">{tag}</Badge>
                ))}
              </div>
            </MetaSection>
          )}

          {data.sources.length > 0 && (
            <MetaSection title={t("wiki_page_detail.m022", {v0: data.sources.length})}>
              {data.sources.map((source, index) => (
                <div key={index} className="text-[11.5px] leading-relaxed">
                  <p className="text-foreground">{source.doc}</p>
                  {source.page && (
                    <p className="text-muted-foreground">{t("wiki_page_detail.m023")}{source.page} {t("wiki_page_detail.m024")}</p>
                  )}
                  {source.quote && (
                    <p className="mt-0.5 text-muted-foreground">
                      「{truncate(source.quote, 60)}」
                    </p>
                  )}
                </div>
              ))}
            </MetaSection>
          )}

          <MetaSection title={t("wiki_page_detail.m025", {v0: data.backlinks.length})}>
            {data.backlinks.length === 0 ? (
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                {t("wiki_page_detail.m026")}</p>
            ) : (
              data.backlinks.map((link) => (
                <Link
                  key={link.pageId}
                  href={`/wiki/${link.pageId}`}
                  className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[12px] transition-colors hover:bg-[var(--muted)]"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Link2 size={10} className="shrink-0 text-muted-foreground" />
                    <span className="truncate text-foreground">{link.title}</span>
                  </span>
                  {link.occurrences > 1 && (
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      ×{link.occurrences}
                    </span>
                  )}
                </Link>
              ))
            )}
          </MetaSection>

          {data.outgoing.length > 0 && (
            <MetaSection title={t("wiki_page_detail.m027", {v0: data.outgoing.length})}>
              {data.outgoing.map((link, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => goToPage(link.pageId ?? "", link.raw)}
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-[var(--muted)]"
                >
                  <ExternalLink size={10} className="shrink-0 text-muted-foreground" />
                  <span className={cn("truncate", link.resolved ? "text-foreground" : "text-muted-foreground")}>
                    {link.raw}
                  </span>
                  {!link.resolved && <span className="shrink-0 text-[10.5px] text-muted-foreground">{t("wiki_page_detail.m028")}</span>}
                </button>
              ))}
            </MetaSection>
          )}
        </aside>
      </div>

      {deleteOpen && (
        <DeleteDialog
          pageId={pageId}
          title={data.title}
          expectedHash={data.contentHash}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => router.push("/wiki")}
        />
      )}

      {mergeOpen && (
        <MergeDialog
          pageId={pageId}
          title={data.title}
          sourceHash={data.contentHash}
          onClose={() => setMergeOpen(false)}
          onMerged={() => {
            setMergeOpen(false);
            router.push("/wiki");
          }}
        />
      )}
    </>
  );
}

function MetaSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {title}
      </h3>
      <Hairline className="mb-2.5" />
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{value}</span>
    </div>
  );
}
