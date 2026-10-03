"use client";
import { useI18n } from "@/components/i18n-provider";

import { cn } from "@/lib/utils";
import Link from "next/link";
import * as React from "react";
import { RefreshCw } from "lucide-react";

export type NavLeaf = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  badge?: number;
};

/** 判断某个 href 是否命中当前地址。带 query 的目标要连查询串一起比 —— 
    否则 /wiki 与 /wiki?view=graph 会同时高亮。 */
function isActive(href: string, pathname: string, params: URLSearchParams): boolean {
  const [path, query] = href.split("?");
  const inPath = pathname === path || pathname.startsWith(`${path}/`);
  if (!inPath) return false;
  if (!query) {
    // 不带查询串的目标：当前也不能带着「用来区分同一路由不同视图」的参数。
    // /chat 用 s 区分会话、/wiki 用 view 区分视图 —— 少了这一步，
    // 打开某段对话时「新对话」与那条会话会同时高亮，出现两个 aria-current。
    if (path === "/chat") return !params.get("s");
    if (path === "/wiki") return !params.get("view");
    return true;
  }
  for (const [key, value] of new URLSearchParams(query)) {
    if (params.get(key) !== value) return false;
  }
  return true;
}

export function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="sidebar-label sidebar-group-label px-2.5 pb-1 pt-4 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * 导航项。
 *
 * 选中态用灰底圆角（对齐参考站的视觉）。同时保留 design DNA 的签名「生长」动效 ——
 * 顶部横向导航里它是下划线宽度 0→100%，在这里转译成左边缘一根从 0 长到 14px 的竖条：
 * 横排变竖排时，把「生长」的方向一起转 90° 才是同一个语言。
 */
export function NavItem({
  item,
  pathname,
  params,
}: {
  item: NavLeaf;
  pathname: string;
  params: URLSearchParams;
}) {
  const active = isActive(item.href, pathname, params);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={item.label}
      className={cn(
        "sidebar-item group relative flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13px] font-medium transition-colors duration-150",
        active
          ? "bg-[var(--muted)] text-foreground"
          : "text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 w-[2px] -translate-y-1/2 rounded-full bg-foreground transition-[height] duration-200 ease-out",
          active ? "h-3.5" : "h-0 group-hover:h-2",
        )}
        aria-hidden
      />
      <Icon size={15} strokeWidth={1.8} className="shrink-0" />
      <span className="sidebar-label truncate">{item.label}</span>
      {item.badge !== undefined && item.badge > 0 && (
        <span className="sidebar-label ml-auto rounded-full bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] px-1.5 text-[10.5px] font-semibold tabular-nums text-[var(--warning)]">
          {item.badge}
        </span>
      )}
    </Link>
  );
}

/**
 * 知识库状态。纯展示，不可点击。
 *
 * 「从 Markdown 重建索引」搬去了设置页最后一节：它是索引损坏时的自救入口，
 * 一年也用不上一次，摆在常驻的侧栏里只会让人以为需要经常点。
 * 这里只回答一个问题 —— 知识库现在正常吗。
 */
export function VaultStatus({ pages, healthy, loading = false, error, onRetry }: { pages: number | null; healthy: boolean | null; loading?: boolean; error?: string | null; onRetry?: () => void }) {
  const { t } = useI18n();
  const confirmed = !loading && !error && healthy !== null;
  const label = loading ? t("vaultStatus.checking") : !confirmed ? t("vaultStatus.failed") : healthy ? t("layout_sidebar.m034") : t("layout_sidebar.m035");
  return (
    <div
      title={error || (confirmed ? healthy ? t("layout_sidebar.m032", {v0: pages ?? 0}) : t("layout_sidebar.m033") : label)}
      className="vault-status flex min-h-10 items-center gap-2.5 rounded-[14px] border border-border bg-card/60 px-3 py-2 text-[12px] text-muted-foreground"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: confirmed && healthy ? "var(--success)" : loading ? "var(--muted-foreground)" : "var(--warning)" }}
        aria-hidden
      />
      <span role="status" className="sidebar-label truncate">{label}</span>
      {error && onRetry ? <button type="button" onClick={onRetry} disabled={loading} aria-label={t("vaultStatus.retry")} className="sidebar-label ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-muted disabled:opacity-50"><RefreshCw size={13} aria-hidden /></button> : pages !== null && <span className="sidebar-label ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums">{pages}</span>}
    </div>
  );
}
