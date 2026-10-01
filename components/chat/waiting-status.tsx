"use client";
import * as React from "react";

const COPY = [
  "让零散的知识，慢慢连成线。", "给这个问题，一个更清楚的答案。",
  "文字正在落笔，思路正在成形。", "从一页资料，到一个新发现。",
  "把复杂留给思考，把清楚带给你。", "一些线索，正在这里相遇。",
];

/** 计时只更新这个小组件，不触发整篇 Markdown 重解析。 */
export const WaitingStatus = React.memo(function WaitingStatus({ createdAt, hasText }: { createdAt: string; hasText: boolean }) {
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
      <span className="chat-waiting-text text-[13px] font-medium" role="status">正在生成回复……</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-live="off">已等待 {seconds} 秒</span>
    </div>
    <p className="mt-1 h-5 truncate text-[11.5px] text-muted-foreground">{seconds >= 30 && Math.floor(seconds / 6) % 3 === 2 ? "可以先去看看别处，回复会继续生成。" : hasText ? "回复正在展开，新的内容会陆续出现。" : COPY[Math.floor(seconds / 6) % COPY.length]}</p>
  </div>;
});
