"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

/** 失败保留在原位置，恢复动作不要求刷新整个应用。 */
export function RequestError({ error, onRetry, retrying = false, className }: {
  error: string;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("flex flex-col gap-3 rounded-[16px] border border-border bg-card p-4 sm:flex-row sm:items-start sm:justify-between", className)}>
      <p role="alert" className="flex min-w-0 items-start gap-2 text-[13px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
        <TriangleAlert size={15} className="mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden />
        <span>{error}</span>
      </p>
      <button type="button" disabled={retrying} onClick={onRetry} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 self-start rounded-full border border-border px-3 text-[13px] font-medium transition-colors hover:bg-muted disabled:opacity-50 sm:min-h-8 sm:text-[12px]">
        <RefreshCw size={13} aria-hidden />
        {t(retrying ? "requestFeedback.retrying" : "requestFeedback.retry")}
      </button>
    </div>
  );
}

/** 固定阅读结构的静态占位，减少首次加载及筛选时的布局跳变。 */
export function LoadingCards({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" className={className}>
      <span className="sr-only">{t("requestFeedback.loading")}</span>
      <div aria-hidden className="grid grid-cols-1 gap-2.5 @min-[42rem]:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex min-h-[144px] flex-col gap-4 rounded-[16px] border border-border bg-card p-5">
            <div className="h-4 w-2/5 rounded bg-muted" />
            <div className="h-3 w-5/6 rounded bg-muted" />
            <div className="mt-auto h-2.5 w-1/5 rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
