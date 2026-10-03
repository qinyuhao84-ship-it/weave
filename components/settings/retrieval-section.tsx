"use client";

import * as React from "react";
import { ModelAccessHelp } from "./model-access-help";
import { useI18n } from "@/components/i18n-provider";
import { Button, Input, Label, Switch } from "@/components/ui";
import { apiFetch, useApi } from "@/hooks/use-api";
import { useAppData } from "@/components/app-provider";
import type { PublicSettings } from "@/lib/settings";

type Result = { settings: PublicSettings };
type Status = { total: number; indexed: number; pending: number; jobId: string | null; failed: boolean };
type Draft = PublicSettings["retrievalModel"] & { apiKey: string; clearApiKey: boolean };

export function RetrievalSection() {
  const { t } = useI18n(); const { bumpData } = useAppData();
  const { data, refresh, error: loadError } = useApi<Result>("/api/settings");
  const { data: status, refresh: refreshStatus } = useApi<Status>("/api/settings/retrieval");
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ key?: string; error?: string } | null>(null);
  const saved = data?.settings.retrievalModel;
  React.useEffect(() => {
    if (!status?.jobId) return;
    const timer = setInterval(refreshStatus, 2000);
    return () => clearInterval(timer);
  }, [status?.jobId, refreshStatus]);
  const run = async (action: "save" | "test" | "index") => {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      if (action === "save" && draft) {
        const { hasApiKey: _key, ...input } = draft;
        await apiFetch<Result>("/api/settings", { method: "PATCH", body: JSON.stringify({ retrievalModel: input }) });
        setDraft(null); refresh(); refreshStatus(); bumpData("settings");
        setMessage({ key: "retrieval.saved" });
      } else {
        await apiFetch("/api/settings/retrieval", { method: action === "test" ? "PUT" : "POST" });
        refreshStatus(); setMessage({ key: action === "test" ? "retrieval.connected" : "retrieval.queued" });
      }
    } catch (error) { setMessage({ error: error instanceof Error ? error.message : t("retrieval.failed") }); }
    finally { setBusy(false); }
  };
  const change = (patch: Partial<Draft>) => setDraft(previous => previous ? { ...previous, ...patch } : previous);
  return <section aria-labelledby="retrieval-title" className="space-y-4">
    <div><h2 id="retrieval-title" className="text-[15px] font-semibold">{t("retrieval.title")}</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{t("retrieval.description")}</p></div>
    {loadError && <div role="alert" className="text-[12px]"><p>{loadError}</p><Button size="sm" variant="ghost" onClick={() => void refresh()}>{t("retrieval.retry")}</Button></div>}
    {!draft && <ModelAccessHelp service="siliconflow" />}
    {saved && !draft && <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <p className="text-[13px] font-medium">{t(saved.enabled ? "retrieval.enabled" : "retrieval.disabled")}</p>
      <p className="mt-1 break-all text-[12px] text-muted-foreground">{saved.embeddingModel} {saved.rerankModel ? `· ${saved.rerankModel}` : ""}</p>
      <p className="mt-2 text-[12px] text-muted-foreground">{t(saved.hasApiKey ? "retrieval.keySaved" : "retrieval.noKey")}</p>
      {status?.jobId && <p className="mt-2 text-[12px] text-muted-foreground" role="status">{t("retrieval.indexing")}</p>}
      {status?.failed && <p role="alert" className="mt-2 text-[12px] text-[var(--warning)]">{t("retrieval.indexFailed")}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setDraft({ ...saved, apiKey: "", clearApiKey: false }); setMessage(null); }}>{t("retrieval.edit")}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("test")}>{t("retrieval.test")}</Button>
        <Button size="sm" variant="ghost" disabled={busy || !saved.enabled || Boolean(status?.jobId)} onClick={() => void run("index")}>{t("retrieval.index")}</Button>
      </div>
    </div>}
    {draft && <form aria-label={t("retrieval.form")} onSubmit={event => { event.preventDefault(); void run("save"); }} className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <fieldset disabled={busy} className="space-y-4">
        <legend className="sr-only">{t("retrieval.form")}</legend>
        <div className="flex items-center justify-between gap-3"><span className="text-[13px] font-medium">{t("retrieval.enable")}</span><Switch checked={draft.enabled} onChange={enabled => change({ enabled })} label={t("retrieval.enable")} /></div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">{t("retrieval.sharing")}</p>
        <div><Label htmlFor="retrieval-url">{t("retrieval.url")}</Label><Input id="retrieval-url" type="url" required value={draft.baseUrl} onChange={event => change({ baseUrl: event.target.value })} /></div>
        <div><Label htmlFor="embedding-model">{t("retrieval.embedding")}</Label><Input id="embedding-model" required value={draft.embeddingModel} onChange={event => change({ embeddingModel: event.target.value })} /></div>
        <div><Label htmlFor="rerank-model">{t("retrieval.rerank")}</Label><Input id="rerank-model" value={draft.rerankModel} onChange={event => change({ rerankModel: event.target.value })} /><p className="mt-1 text-[11.5px] text-muted-foreground">{t("retrieval.rerankHint")}</p></div>
        <div><Label htmlFor="retrieval-key">{t("retrieval.key")}</Label><Input id="retrieval-key" type="password" autoComplete="off" value={draft.apiKey} placeholder={t(draft.hasApiKey ? "retrieval.keepKey" : "retrieval.keyOptional")} onChange={event => change({ apiKey: event.target.value, clearApiKey: false })} /><div className="mt-2"><ModelAccessHelp service="siliconflow" /></div></div>
        {draft.hasApiKey && <div className="flex items-center justify-between gap-3"><span className="text-[12px]">{t("retrieval.clearKey")}</span><Switch checked={draft.clearApiKey} onChange={clearApiKey => change({ clearApiKey, apiKey: "" })} label={t("retrieval.clearKey")} /></div>}
        <div><Label htmlFor="embedding-chunk">{t("retrieval.chunk")}</Label><Input id="embedding-chunk" type="number" min={256} max={6000} required value={draft.chunkChars} onChange={event => change({ chunkChars: Number(event.target.value) })} /><p className="mt-1 text-[11.5px] text-muted-foreground">{t("retrieval.chunkHint")}</p></div>
        <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" loading={busy}>{t("retrieval.save")}</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(null); setMessage(null); }}>{t("retrieval.cancel")}</Button></div>
      </fieldset>
    </form>}
    {message && <p role={message.error ? "alert" : "status"} className="text-[12px] leading-relaxed text-muted-foreground">{message.error ?? (message.key ? t(message.key) : "")}</p>}
  </section>;
}
