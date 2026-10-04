"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import { Code2, CircleStop } from "lucide-react";
import { DocumentReader } from "@/components/documents/document-reader";
import { Button } from "@/components/ui";
import { apiFetch } from "@/hooks/use-api";
import type { ChatArtifact } from "@/lib/chat/config";

export function ArtifactCard({ artifact }: { artifact: ChatArtifact }) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState(artifact.status);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [acting, setActing] = React.useState(false);
  const url = `/api/chat/artifacts/${artifact.id}`;
  React.useEffect(() => {
    if (status !== "pending") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await apiFetch<{ status: ChatArtifact["status"]; error: string | null }>(url, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setStatus(result.status); setError(result.error);
        if (result.status === "pending") timer = setTimeout(() => void read(), 1500);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t("chat_artifact_card.checkFailed"));
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, status, attempt, t]);
  const act = async (method: "POST" | "DELETE") => {
    setActing(true);
    try {
      await apiFetch(url, { method });
      setError(null); setStatus(method === "POST" ? "pending" : "cancelled"); setAttempt(value => value + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("chat_artifact_card.checkFailed"));
    } finally { setActing(false); }
  };
  if (status === "pending" || status === "failed" || status === "cancelled") {
    return <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-3" data-testid="chat-artifact-pending">
      <div className="flex min-w-0 items-center gap-2.5 text-[12px] text-muted-foreground" role="status" aria-live="polite">
        <Code2 size={16} className="shrink-0 text-[var(--waiting-accent)]" aria-hidden />
        <span>{error || t(`chat_artifact_card.${status}`)}</span>
      </div>
      <div className="flex items-center gap-1">
        {status === "pending" ? <>
          {error && <Button size="sm" variant="ghost" onClick={() => { setError(null); setAttempt(value => value + 1); }}>{t("chat_artifact_card.check")}</Button>}
          <Button size="sm" variant="ghost" icon={<CircleStop size={13} />} disabled={acting} onClick={() => void act("DELETE")}>{t("chat_artifact_card.stop")}</Button>
        </> : <Button size="sm" variant="ghost" disabled={acting} onClick={() => void act("POST")}>{t("chat_artifact_card.retry")}</Button>}
      </div>
    </div>;
  }
  return <div className="mt-4"><DocumentReader name={artifact.name} mediaType={artifact.mediaType} status={status}
    contentUrl={`/api/chat/artifacts/${artifact.id}`} downloadUrl={`/api/chat/artifacts/${artifact.id}?download=1`} followAppTheme testId="chat-artifact" /></div>;
}

export function ArtifactPlaceholder() {
  const { t } = useI18n();
  return <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-dashed border-[color-mix(in_srgb,var(--waiting-accent)_35%,var(--border))] px-4 py-4 text-[12px] text-muted-foreground"><Code2 size={16} className="text-[var(--waiting-accent)]" aria-hidden /><span>{t("chat_artifact_card.m001")}</span></div>;
}
