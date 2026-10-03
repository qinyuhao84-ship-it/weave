"use client";
import { useI18n } from "@/components/i18n-provider";

import { useAppData } from "@/components/app-provider";
import {
  Button,
  Input,
  Spinner,
  TypeBadge
} from "@/components/ui";
import { apiFetch, useApi } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import {
  X
} from "lucide-react";
import * as React from "react";

/* ---------------------------------------------------------- 删除对话框 */

/**
 * 删除对话框。
 *
 * 必须先展示「被 N 个词条引用」，并让用户显式选择引用怎么处理 ——
 * 这是业界教训的直接落地：删除的语义如果不明确，就会静默产生死链。
 */
export function DeleteDialog({
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
  const { t } = useI18n();
  const { data: preview, loading } = useApi<{
    totalReferences: number;
    referencingPages: Array<{ pageId: string; title: string; count: number }>;
  }>(`/api/pages/${pageId}/references`);

  const [strategy, setStrategy] = React.useState<"keep_dangling" | "clean_refs" | "redirect">("keep_dangling");
  const [targetId, setTargetId] = React.useState("");
  const [targetQuery, setTargetQuery] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(targetQuery.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [targetQuery]);
  const { data: targets, loading: searching, error: searchError, refresh: retrySearch } = useApi<{
    results: Array<{ pageId: string; title: string; type: string }>;
  }>(strategy === "redirect" && searchQuery ? `/api/search?q=${encodeURIComponent(searchQuery)}&limit=12` : null);
  const matchingTargets = targets?.results.filter(page => page.pageId !== pageId) ?? [];
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
    <DialogShell title={t("wiki_page_detail.m029", {v0: title})} onClose={onClose}>
      {loading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {preview && preview.totalReferences > 0 ? (
              <>
                {t("wiki_page_detail.m030")}<strong className="text-foreground">{preview.referencingPages.length} {t("wiki_page_detail.m031")}</strong>
                {t("wiki_page_detail.m032")}<strong className="text-foreground">{preview.totalReferences} {t("wiki_page_detail.m033")}</strong>：
                {preview.referencingPages.slice(0, 5).map((p) => `「${p.title}」`).join("、")}
                {preview.referencingPages.length > 5 ? t("wiki_page_detail.m034") : ""}。
              </>
            ) : (
              t("wiki_page_detail.m035")
            )}
          </p>

          <p className="mt-4 mb-2 text-[12px] font-semibold text-foreground">
            {t("wiki_page_detail.m036")}</p>
          <div className="space-y-1.5">
            {[
              { value: "keep_dangling" as const, label: t("wiki_page_detail.m037"), hint: t("wiki_page_detail.m038") },
              { value: "clean_refs" as const, label: t("wiki_page_detail.m039"), hint: t("wiki_page_detail.m040") },
              { value: "redirect" as const, label: t("wiki_page_detail.m041"), hint: t("wiki_page_detail.m042") },
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
            <div className="mt-2.5 space-y-2">
              <Input
                aria-label={t("knowledgeSelection.label")}
                value={targetQuery}
                onChange={(e) => { setTargetQuery(e.target.value); setTargetId(""); }}
                placeholder={t("wiki_page_detail.m043")}
              />
              {targetQuery.trim() && (searching || searchQuery !== targetQuery.trim()) && <p role="status" className="text-[12px] text-muted-foreground">{t("knowledgeSelection.loading")}</p>}
              {searchError && <div role="alert"><p className="text-[12px] text-[var(--destructive)]">{searchError}</p><Button size="sm" variant="ghost" onClick={() => void retrySearch()}>{t("knowledgeSelection.retry")}</Button></div>}
              {!searching && !searchError && searchQuery && searchQuery === targetQuery.trim() && <div className="max-h-48 overflow-y-auto">
                {matchingTargets.map(page => <button type="button" key={page.pageId} aria-pressed={targetId === page.pageId} onClick={() => setTargetId(page.pageId)} className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-muted aria-pressed:bg-muted focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
                  <span className="min-w-0 break-words">{page.title}</span><TypeBadge type={page.type} />
                </button>)}
                {matchingTargets.length === 0 && <p className="text-[12px] text-muted-foreground">{t("knowledgeSelection.empty")}</p>}
              </div>}
              {targetId && <p role="status" className="text-[12px] text-muted-foreground">{t("knowledgeSelection.selected", { v0: matchingTargets.find(page => page.pageId === targetId)?.title ?? targetQuery })}</p>}
            </div>
          )}

          {error && <p className="mt-3 text-[12px] text-[var(--destructive)]">{error}</p>}

          <p className="mt-4 rounded-[12px] border border-border bg-background p-3 text-[11.5px] leading-relaxed text-muted-foreground">
            {t("wiki_page_detail.m044")}</p>

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={onClose}>{t("wiki_page_detail.m005")}</Button>
            <Button
              variant="danger"
              size="md"
              loading={busy}
              disabled={strategy === "redirect" && !targetId.trim()}
              onClick={handleDelete}
            >
              {t("wiki_page_detail.m045")}</Button>
          </div>
        </>
      )}
    </DialogShell>
  );
}

/* ---------------------------------------------------------- 合并对话框 */

export function MergeDialog({
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
  const { t } = useI18n();
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
    <DialogShell title={t("wiki_page_detail.m046", {v0: title})} onClose={onClose}>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {t("wiki_page_detail.m047")}<code className="rounded bg-[var(--muted)] px-1">[[{title}]]</code> {t("wiki_page_detail.m048")}</p>

      <Input className="mt-4" value={query} onChange={event => { setQuery(event.target.value); setPageIndex(0); setTargetId(""); }} placeholder={t("wiki_page_detail.m049")} aria-label={t("wiki_page_detail.m050")} />
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
            {query ? t("wiki_page_detail.m051") : t("wiki_page_detail.m052")}
          </p>
        )}
      </div>
      {data && data.total > 20 && <nav aria-label={t("wiki_page_detail.m053")} className="mt-3 flex items-center justify-between gap-2"><Button variant="secondary" size="sm" disabled={loading || pageIndex === 0} onClick={() => { setPageIndex(index => index - 1); setTargetId(""); }}>{t("wiki_page_detail.m054")}</Button><span className="text-[12px] text-muted-foreground">{pageIndex + 1} / {Math.ceil(data.total / 20)}</span><Button variant="secondary" size="sm" disabled={loading || (pageIndex + 1) * 20 >= data.total} onClick={() => { setPageIndex(index => index + 1); setTargetId(""); }}>{t("wiki_page_detail.m055")}</Button></nav>}

      {error && <p className="mt-3 text-[12px] text-[var(--destructive)]">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="md" onClick={onClose}>{t("wiki_page_detail.m005")}</Button>
        <Button variant="primary" size="md" loading={busy} disabled={!targetId} onClick={handleMerge}>
          {t("wiki_page_detail.m056")}</Button>
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
  const { t } = useI18n();
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
            aria-label={t("wiki_page_detail.m057")}
          >
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}
