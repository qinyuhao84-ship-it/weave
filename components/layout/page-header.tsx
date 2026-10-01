import * as React from "react";

/**
 * 页面级标题区。窄主区让操作另起一行，避免侧栏挤压标题与说明。
 *
 * 从 app-shell.tsx 拆出来单独放：外壳现在只负责「导航 + 主区」，
 * 页面自己的标题不该混在外壳的导出里。
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  compact = false,
  maxWidth = "6xl",
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  compact?: boolean;
  maxWidth?: "3xl" | "5xl" | "6xl";
}) {
  return (
    <div className="border-b border-border">
      <div className={`${{ "3xl": "max-w-3xl", "5xl": "max-w-5xl", "6xl": "max-w-6xl" }[maxWidth]} ${compact
        ? "mx-auto flex w-full flex-wrap items-center justify-between gap-3 px-4 py-2.5 md:px-6"
        : "mx-auto flex flex-col gap-5 px-4 pb-6 pt-8 md:px-6 md:pb-8 md:pt-10 xl:flex-row xl:items-end xl:justify-between"}`}
      >
        <div className="min-w-0">
          <h1 className={compact
            ? "text-[1.25rem] font-semibold leading-tight tracking-[-0.025em] text-foreground"
            : "text-[1.75rem] font-semibold leading-[1.2] tracking-[-0.025em] text-foreground md:text-[2rem]"}
          >
            {title}
          </h1>
          {description && (
            <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {description}
            </p>
          )}
          {meta && <div className={compact ? "mt-1.5 flex flex-wrap items-center gap-1.5" : "mt-3 flex flex-wrap items-center gap-2"}>{meta}</div>}
        </div>
        {actions && <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 xl:justify-end">{actions}</div>}
      </div>
    </div>
  );
}
