"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";

const COPY = ["waitingCopy.m0","waitingCopy.m1","waitingCopy.m2","waitingCopy.m3","waitingCopy.m4","waitingCopy.m5"];

/** 计时只更新这个小组件，不触发整篇 Markdown 重解析。 */
export const WaitingStatus = React.memo(function WaitingStatus({ createdAt, hasText }: { createdAt: string; hasText: boolean }) {
  const { t } = useI18n();
  const [seconds, setSeconds] = React.useState(0);
  React.useEffect(() => {
    const timestamp = Date.parse(createdAt);
    const start = Number.isFinite(timestamp) ? timestamp : Date.now();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick(); const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [createdAt]);
  return <div className="chat-waiting mb-3" data-testid="chat-waiting">
    <div className="flex items-center justify-between gap-4">
      <span className="chat-waiting-text text-[13px] font-medium" role="status">{t("chat_waiting_status.m001")}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-live="off">{t("chat_waiting_status.elapsed", { seconds })}</span>
    </div>
    <p className="mt-1 h-5 truncate text-[11.5px] text-muted-foreground">{seconds >= 30 && Math.floor(seconds / 6) % 3 === 2 ? t("chat_waiting_status.m004") : hasText ? t("chat_waiting_status.m005") : t(COPY[Math.floor(seconds / 6) % COPY.length])}</p>
  </div>;
});
