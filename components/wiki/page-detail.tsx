"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Pencil, Trash2, Check, X, Link2, GitMerge, RotateCcw,
  ExternalLink, AlertTriangle,
} from "lucide-react";
import { useAppData } from "@/components/app-provider";
import {
  Button, Badge, TypeBadge, Input, Textarea, Card, Hairline,
  Spinner, EmptyState,
} from "@/components/ui";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { useApi, apiFetch } from "@/hooks/use-api";
import { cn, formatDate, truncate } from "@/lib/utils";

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
      if (message.includes("被外部修改")) setConflict(true);
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
              title="找不到这个词条"
              description={error ?? "它可能已经被删除或合并到别的词条了。"}
              action={
                <Link href="/wiki">
                  <Button variant="secondary" size="md" icon={<ArrowLeft size={13} />}>
                    返回知识库
                  </Button>
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
              aria-label="返回知识库"
            >
              <ArrowLeft size={14} />
            </Link>
            <span className="truncate text-[13px] font-medium text-foreground">{data.title}</span>
            <TypeBadge type={data.type} />
            {data.confidence === "low" && <Badge tone="warning">弱结论</Badge>}
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
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={saving}
                  icon={<Check size={13} strokeWidth={2} />}
                  onClick={handleSave}
                >
                  保存
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Pencil size={12} />}
                  onClick={() => setEditing(true)}
                >
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<GitMerge size={12} />}
                  onClick={() => setMergeOpen(true)}
                >
                  合并
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={12} />}
                  onClick={() => setDeleteOpen(true)}
                  aria-label="删除"
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
                      放弃我的改动并重新载入
                    </Button>
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
                placeholder="词条标题"
                className="text-[15px] font-medium"
              />
              <Textarea
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                rows={26}
                className="font-mono text-[13px] leading-relaxed"
              />
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                用 <code className="rounded bg-[var(--muted)] px-1">[[词条名]]</code> 建立双链。
                改名会自动重写全库指向它的引用，并保留旧名作为别名 —— 不会产生死链。
              </p>
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
          <MetaSection title="元信息">
            {/*
              slug 与磁盘路径曾经也在这里显示。去掉它们不是嫌挤，是它们回答不了
              用户会问的任何问题：「这个文件在哪」是 Obsidian / Finder 的活，
              而 slug 是一个从标题派生的、用户从不需要读写的中间值。
              同一条纪律见 components/history/workspace.tsx 顶部 —— 那里连 commit
              sha 都不显示。它们是实现细节，露出来只会让这一栏看起来像调试面板。
            */}
            <MetaRow label="类型" value={<TypeBadge type={data.type} />} />
            <MetaRow label="置信度" value={data.confidence} />
            <MetaRow label="创建" value={formatDate(data.created)} />
            <MetaRow label="更新" value={formatDate(data.updated)} />
          </MetaSection>

          {data.aliases.length > 0 && (
            <MetaSection title="别名">
              <div className="flex flex-wrap gap-1.5">
                {data.aliases.map((alias) => (
                  <Badge key={alias} tone="neutral">{alias}</Badge>
                ))}
              </div>
            </MetaSection>
          )}

          {data.tags.length > 0 && (
            <MetaSection title="标签">
              <div className="flex flex-wrap gap-1.5">
                {data.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">{tag}</Badge>
                ))}
              </div>
            </MetaSection>
          )}

          {data.sources.length > 0 && (
            <MetaSection title={`来源（${data.sources.length}）`}>
              {data.sources.map((source, index) => (
                <div key={index} className="text-[11.5px] leading-relaxed">
                  <p className="text-foreground">{source.doc}</p>
                  {source.page && (
                    <p className="text-muted-foreground">第 {source.page} 页</p>
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

          <MetaSection title={`反向链接（${data.backlinks.length}）`}>
            {data.backlinks.length === 0 ? (
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                还没有别的词条引用它。孤立词条不会被检索路径带到 —— 可以在相关词条里补一条双链。
              </p>
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
            <MetaSection title={`指向（${data.outgoing.length}）`}>
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
                  {!link.resolved && <span className="shrink-0 text-[10.5px] text-muted-foreground">待补</span>}
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

/* ---------------------------------------------------------- 删除对话框 */

/**
 * 删除对话框。
 *
 * 必须先展示「被 N 个词条引用」，并让用户显式选择引用怎么处理 ——
 * 这是业界教训的直接落地：删除的语义如果不明确，就会静默产生死链。
 */
function DeleteDialog({
  pageId,
  title,
  expectedHash,
  onClose,
  onDeleted,
}: {
  pageId: string;
  title: string;
  expectedHash: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { data: preview, loading } = useApi<{
    totalReferences: number;
    referencingPages: Array<{ pageId: string; title: string; count: number }>;
  }>(`/api/pages/${pageId}/references`);

  const [strategy, setStrategy] = React.useState<"keep_dangling" | "clean_refs" | "redirect">("keep_dangling");
  const [targetId, setTargetId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const { bumpData } = useAppData();

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/pages/${pageId}`, {
        method: "DELETE",
        body: JSON.stringify({
          strategy,
          ...(strategy === "redirect" ? { targetPageId: targetId } : {}),
          expectedHash,
        }),
      });
      bumpData();
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell title={`删除「${title}」`} onClose={onClose}>
      {loading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {preview && preview.totalReferences > 0 ? (
              <>
                这个词条被 <strong className="text-foreground">{preview.referencingPages.length} 个词条</strong>
                引用了 <strong className="text-foreground">{preview.totalReferences} 次</strong>：
                {preview.referencingPages.slice(0, 5).map((p) => `「${p.title}」`).join("、")}
                {preview.referencingPages.length > 5 ? " 等" : ""}。
              </>
            ) : (
              "没有别的词条引用它，可以放心删除。"
            )}
          </p>

          <p className="mt-4 mb-2 text-[12px] font-semibold text-foreground">
            这些引用怎么处理？
          </p>
          <div className="space-y-1.5">
            {[
              { value: "keep_dangling" as const, label: "先保留，等我以后处理", hint: "引用会变成虚线标记，体检时会提醒你" },
              { value: "clean_refs" as const, label: "降级为纯文本", hint: "[[张三]] 变成「张三」，文字保留但没有链接" },
              { value: "redirect" as const, label: "改指向另一个词条", hint: "适合删重复项，引用会自动转过去" },
            ].map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-[12px] border p-3 transition-colors",
                  strategy === option.value ? "border-[var(--focus-ring)] bg-[var(--muted)]" : "border-border hover:bg-[var(--muted)]",
                )}
              >
                <input
                  type="radio"
                  name="strategy"
                  checked={strategy === option.value}
                  onChange={() => setStrategy(option.value)}
                  className="mt-0.5 accent-[var(--ring)]"
                />
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium text-foreground">{option.label}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {strategy === "redirect" && (
            <Input
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="目标词条的 id（可从地址栏复制）"
              className="mt-2.5"
            />
          )}

          {error && <p className="mt-3 text-[12px] text-[var(--destructive)]">{error}</p>}

          <p className="mt-4 rounded-[12px] border border-border bg-background p-3 text-[11.5px] leading-relaxed text-muted-foreground">
            删除是软删除：词条会被移入回收站并留下墓碑，随时可以恢复。
            每次操作都有 git 提交，改错了能回滚。
          </p>

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={onClose}>取消</Button>
            <Button
              variant="danger"
              size="md"
              loading={busy}
              disabled={strategy === "redirect" && !targetId.trim()}
              onClick={handleDelete}
            >
              确认删除
            </Button>
          </div>
        </>
      )}
    </DialogShell>
  );
}

/* ---------------------------------------------------------- 合并对话框 */

function MergeDialog({
  pageId,
  title,
  sourceHash,
  onClose,
  onMerged,
}: {
  pageId: string;
  title: string;
  sourceHash: string;
  onClose: () => void;
  onMerged: () => void;
}) {
  const { bumpData } = useAppData();
  const [query, setQuery] = React.useState("");
  const [pageIndex, setPageIndex] = React.useState(0);
  const search = React.useDeferredValue(query);
  const { data, loading, error: loadError } = useApi<{ pages: Array<{ id: string; title: string; type: string }>; total: number }>(`/api/pages?limit=20&offset=${pageIndex * 20}&q=${encodeURIComponent(search)}`);
  const [targetId, setTargetId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const candidates = (data?.pages ?? []).filter((p) => p.id !== pageId);

  const handleMerge = async () => {
    if (!targetId) return;
    setBusy(true);
    setError(null);
    try {
      // 合并前读取目标版本，并把当前页与目标页的哈希一起提交。
      // 若用户打开对话框后在 Obsidian 里改过其中任一页，服务端会拒绝覆盖。
      const target = await apiFetch<{ contentHash: string }>(`/api/pages/${targetId}`);
      await apiFetch("/api/pages/merge", {
        method: "POST",
        body: JSON.stringify({
          sourcePageId: pageId,
          targetPageId: targetId,
          expectedHashes: { source: sourceHash, target: target.contentHash },
        }),
      });
      bumpData();
      onMerged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell title={`把「${title}」合并到别的词条`} onClose={onClose}>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        合并后：这个词条的内容会并入目标词条，指向它的引用会自动转过去并保留原显示名，
        旧名字会被记成别名 —— 以后写 <code className="rounded bg-[var(--muted)] px-1">[[{title}]]</code> 仍然能跳转。
      </p>

      <Input className="mt-4" value={query} onChange={event => { setQuery(event.target.value); setPageIndex(0); setTargetId(""); }} placeholder="搜索全部词条作为合并目标……" aria-label="搜索合并目标" />
      {loadError && <p role="alert" className="mt-2 text-[12px] text-[var(--destructive)]">{loadError}</p>}
      <div className="mt-3 max-h-64 overflow-y-auto rounded-[12px] border border-border" aria-busy={loading}>
        {candidates.map((page) => (
          <button
            key={page.id}
            type="button"
            onClick={() => setTargetId(page.id)}
            aria-pressed={targetId === page.id}
            className={cn(
              "flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left text-[12.5px] transition-colors last:border-b-0",
              targetId === page.id ? "bg-[var(--muted)]" : "hover:bg-[var(--muted)]",
            )}
          >
            <span className="truncate text-foreground">{page.title}</span>
            <TypeBadge type={page.type} />
          </button>
        ))}
        {candidates.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            {query ? "没有匹配的目标词条。" : "此页没有其他词条，请搜索或翻页。"}
          </p>
        )}
      </div>
      {data && data.total > 20 && <nav aria-label="合并目标分页" className="mt-3 flex items-center justify-between gap-2"><Button variant="secondary" size="sm" disabled={loading || pageIndex === 0} onClick={() => { setPageIndex(index => index - 1); setTargetId(""); }}>上一页</Button><span className="text-[12px] text-muted-foreground">{pageIndex + 1} / {Math.ceil(data.total / 20)}</span><Button variant="secondary" size="sm" disabled={loading || (pageIndex + 1) * 20 >= data.total} onClick={() => { setPageIndex(index => index + 1); setTargetId(""); }}>下一页</Button></nav>}

      {error && <p className="mt-3 text-[12px] text-[var(--destructive)]">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="md" onClick={onClose}>取消</Button>
        <Button variant="primary" size="md" loading={busy} disabled={!targetId} onClick={handleMerge}>
          确认合并
        </Button>
      </div>
    </DialogShell>
  );
}

/**
 * 对话框外壳。
 *
 * 键盘可达性不是在样式之外补的事 —— 一个用键盘的人打不开也关不掉的对话框，
 * 等于这个功能对他不存在。所以这里做齐三件事：Escape 关闭、打开时把焦点
 * 移进来、Tab 循环困在对话框内部。
 */
function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    // 记住打开前的焦点，关闭时还回去 —— 否则键盘用户会掉到页面开头
    const previous = document.activeElement as HTMLElement | null;

    // 初始焦点给面板本身（而不是第一个按钮）—— 屏幕阅读器会先读标题
    panel.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      // 焦点循环：Tab 到末尾回到开头，Shift+Tab 到开头跳到末尾
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-[var(--z-index-overlay)] bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="fixed left-1/2 top-1/2 z-[var(--z-index-modal)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[22px] border border-border bg-popover p-5 shadow-dialog focus:outline-none"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
            aria-label="关闭对话框"
          >
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}
