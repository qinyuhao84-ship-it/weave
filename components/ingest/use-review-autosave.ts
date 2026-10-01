"use client";
import * as React from "react";
import { apiFetch } from "@/hooks/use-api";
import type { Draft, IngestDraft, ReviewDecisionDraft } from "./ingest-provider";

export type Snapshot = { draft: Draft; reviewState: { skippedTitles: string[]; decisions: Array<[number, ReviewDecisionDraft]> } };
type CachedReview = { revision: number; snapshot: Snapshot; sentSnapshot?: Snapshot | null };
/** 只有服务端内容等于本浏览器刚发送的版本，才接续刷新前尚未发送的输入。 */
export function canResumePendingReview(local: CachedReview, serverRevision: number, server: Snapshot): boolean {
  return local.revision + 1 === serverRevision && Boolean(local.sentSnapshot) && JSON.stringify(local.sentSnapshot) === JSON.stringify(server);
}
const cacheKey = (id: string) => `weave-ingest-review:${id}`;

/** 本机缓存立即保存输入；服务器保存串行执行，刷新不会丢防抖窗口里的编辑。 */
export function useReviewAutosave(active: boolean, jobId: string | null, draft: IngestDraft | null, skipped: Set<string>, decisions: Map<number, ReviewDecisionDraft>) {
  const identity = React.useRef<string | null>(null);
  const revision = React.useRef(0);
  const saved = React.useRef("");
  const latest = React.useRef<Snapshot | null>(null);
  const inFlight = React.useRef<Promise<void> | null>(null);
  const cached = React.useRef(false);
  const sending = React.useRef<Snapshot | null>(null);
  const [status, setStatus] = React.useState("已保存");
  const [error, setError] = React.useState<string | null>(null);

  const restore = React.useCallback((server: IngestDraft, ignoreLocal = false): Snapshot => {
    identity.current = server.jobId;
    cached.current = false;
    revision.current = server.reviewRevision ?? 0;
    sending.current = null;
    const snapshot: Snapshot = { draft: server.draft, reviewState: server.reviewState ?? { skippedTitles: [], decisions: [] } };
    saved.current = JSON.stringify(snapshot);
    latest.current = snapshot;
    setStatus("已保存"); setError(null);
    try {
      if (ignoreLocal) localStorage.removeItem(cacheKey(server.jobId));
      const local = JSON.parse(localStorage.getItem(cacheKey(server.jobId)) ?? "null") as CachedReview | null;
      if (local?.snapshot && (local.revision === revision.current || canResumePendingReview(local, revision.current, snapshot))) { cached.current = true; return local.snapshot; }
      // 服务端已经收到上一次保存：只丢掉相同的本地副本，保留冲突副本供用户复制。
      if (local?.snapshot && JSON.stringify(local.snapshot) !== saved.current) {
        revision.current = local.revision;
        setStatus("仅保存在此浏览器");
        setError("草稿已在另一页面更新。当前修改保留在此浏览器，请复制需要的内容后载入已保存版本。");
        return local.snapshot;
      }
    } catch { /* 浏览器存储不可用时依靠服务端保存与离开提醒。 */ }
    return snapshot;
  }, []);

  const flush = React.useCallback(async function flushPending(): Promise<void> {
    if (inFlight.current) { await inFlight.current; return flushPending(); }
    const id = identity.current;
    const task = async () => {
      while (id && identity.current === id && latest.current && JSON.stringify(latest.current) !== saved.current) {
        const snapshot = latest.current;
        setStatus("正在保存");
        sending.current = snapshot;
        try { localStorage.setItem(cacheKey(id), JSON.stringify({ revision: revision.current, snapshot: latest.current, sentSnapshot: snapshot })); cached.current = true; } catch { cached.current = false; }
        try {
          const result = await apiFetch<{ revision: number }>(`/api/ingest/${id}/draft`, { method: "PATCH", body: JSON.stringify({ ...snapshot, revision: revision.current }) });
          if (identity.current !== id) return;
          revision.current = result.revision;
          sending.current = null;
          saved.current = JSON.stringify(snapshot);
          setError(null);
          try { localStorage.setItem(cacheKey(id), JSON.stringify({ revision: revision.current, snapshot: latest.current, sentSnapshot: sending.current })); cached.current = true; } catch { cached.current = false; }
        } catch (cause) {
          if (identity.current === id) { setStatus("仅保存在此浏览器"); setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
          throw cause;
        }
      }
      if (identity.current === id) setStatus("已保存");
    };
    inFlight.current = task().finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, []);

  React.useEffect(() => {
    if (!active || !jobId || !draft || identity.current !== jobId) return;
    latest.current = { draft: draft.draft, reviewState: { skippedTitles: [...skipped], decisions: [...decisions] } };
    if (JSON.stringify(latest.current) === saved.current) return;
    try { localStorage.setItem(cacheKey(jobId), JSON.stringify({ revision: revision.current, snapshot: latest.current, sentSnapshot: sending.current })); cached.current = true; } catch { cached.current = false; }
    setStatus("正在保存");
    const timer = window.setTimeout(() => { void flush().catch(() => undefined); }, 300);
    return () => window.clearTimeout(timer);
  }, [active, jobId, draft, skipped, decisions, flush]);

  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (active && !cached.current && latest.current && JSON.stringify(latest.current) !== saved.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const forget = React.useCallback((id: string) => {
    if (identity.current === id) { identity.current = null; latest.current = null; }
    try { localStorage.removeItem(cacheKey(id)); } catch { /* no cached copy */ }
  }, []);
  const getRevision = React.useCallback(() => revision.current, []);
  return { restore, flush, forget, getRevision, status, error };
}
