"use client";
import * as React from "react";
import { apiFetch } from "@/hooks/use-api";

export function useAiReview({ ingestId, savedJobId, flush, revision, reload, onError }: {
  ingestId: string | null;
  savedJobId?: string;
  flush: () => Promise<void>;
  revision: () => number;
  reload: (id: string, ignoreLocal: boolean) => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const [taskId, setTaskId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [finished, setFinished] = React.useState<string[]>([]);
  const starting = React.useRef(false);
  const stopRequested = React.useRef(false);
  const currentTask = taskId ?? savedJobId;
  React.useEffect(() => {
    if (!currentTask || !ingestId || finished.includes(currentTask)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let pollingFailed = false;
    setBusy(true);
    const poll = async () => {
      try {
        const task = await apiFetch<{ status: string; progress: number; error: string | null }>(`/api/jobs/${currentTask}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (pollingFailed) { onError(null); pollingFailed = false; }
        setProgress(task.progress);
        if (["done", "failed", "cancelled"].includes(task.status)) {
          if (task.status === "done") await reload(ingestId, true);
          else onError(task.error ?? "AI 判断已停止，原有回答已保留。");
          if (!controller.signal.aborted) { setFinished(previous => [...previous, currentTask]); setBusy(false); setTaskId(null); }
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        pollingFailed = true;
        onError(error instanceof Error ? error.message : String(error));
      }
      timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [currentTask, ingestId, reload, onError, finished]);
  const start = React.useCallback(async () => {
    if (!ingestId || starting.current || busy) return;
    starting.current = true;
    stopRequested.current = false;
    setBusy(true); setProgress(0); onError(null);
    try {
      await flush();
      if (stopRequested.current) {
        onError("AI 判断已停止，原有回答已保留。");
        setBusy(false);
        return;
      }
      const result = await apiFetch<{ jobId: string }>(`/api/ingest/${ingestId}/ai-review`, { method: "POST", body: JSON.stringify({ revision: revision() }) });
      setTaskId(result.jobId);
      if (stopRequested.current) await apiFetch(`/api/jobs/${result.jobId}`, { method: "DELETE" });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    } finally { starting.current = false; }
  }, [ingestId, busy, flush, revision, onError]);
  const stop = React.useCallback(async () => {
    if (starting.current) { stopRequested.current = true; return; }
    if (!currentTask) return;
    try { await apiFetch(`/api/jobs/${currentTask}`, { method: "DELETE" }); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }, [currentTask, onError]);
  return { busy: busy || Boolean(ingestId && currentTask && !finished.includes(currentTask)), progress, start, stop };
}
