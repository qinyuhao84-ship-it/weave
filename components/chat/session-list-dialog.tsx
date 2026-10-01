"use client";
import * as React from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { X, MessagesSquare } from "lucide-react";
import { Button, Input, Spinner } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { useAppData, type SessionSummary } from "@/components/app-provider";

export function SessionListDialog({ onClose }: { onClose: () => void }) {
  const panel = React.useRef<HTMLDivElement>(null);
  useModalFocus(true, panel, onClose);
  const { dataVersion } = useAppData();
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const search = React.useDeferredValue(query);
  const { data, loading, error, refresh } = useApi<{ sessions: SessionSummary[]; total: number }>(`/api/chat/sessions?limit=20&offset=${page * 20}&q=${encodeURIComponent(search)}`, [dataVersion]);
  return createPortal(<>
    <div className="fixed inset-0 z-[var(--z-index-overlay)] bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]" aria-hidden />
    <div ref={panel} role="dialog" aria-modal="true" aria-label="全部对话" tabIndex={-1} className="fixed left-1/2 top-1/2 z-[var(--z-index-modal)] flex max-h-[85dvh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[22px] border border-border bg-popover p-5 shadow-dialog focus:outline-none">
      <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-[15px] font-semibold">全部对话</h2><Button variant="ghost" size="sm" aria-label="关闭对话列表" onClick={onClose}><X size={15} /></Button></div>
      <Input value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="搜索全部对话的标题……" aria-label="搜索对话" />
      <div className="mt-3 min-h-0 overflow-y-auto">
        {loading ? <div className="flex justify-center py-10"><Spinner size={16} /></div> : error ? <div role="alert" className="py-4 text-[13px]"><p>{error}</p><Button variant="secondary" size="sm" onClick={() => void refresh()}>重试</Button></div> : !data?.sessions.length ? <p className="py-8 text-center text-[13px] text-muted-foreground">{query ? "没有匹配的对话" : "还没有对话"}</p> : <ul className="divide-y divide-[var(--border)]">{data.sessions.map(session => <li key={session.id}><Link href={`/chat?s=${session.id}`} onClick={onClose} className="flex min-w-0 items-center gap-3 rounded-[8px] px-2 py-3 hover:bg-muted"><MessagesSquare size={14} className="shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-words text-[13px]">{session.title}</span></Link></li>)}</ul>}
      </div>
      {data && data.total > 20 && <nav aria-label="对话分页" className="mt-4 flex items-center justify-between gap-2"><Button variant="secondary" size="sm" disabled={loading || page === 0} onClick={() => setPage(value => value - 1)}>上一页</Button><span className="text-[12px] text-muted-foreground">{page + 1} / {Math.ceil(data.total / 20)}</span><Button variant="secondary" size="sm" disabled={loading || (page + 1) * 20 >= data.total} onClick={() => setPage(value => value + 1)}>下一页</Button></nav>}
    </div>
  </>, document.body);
}
