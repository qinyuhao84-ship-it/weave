"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Select, Textarea, Switch } from "@/components/ui";
import { apiFetch, useApi } from "@/hooks/use-api";
import { useAppData } from "@/components/app-provider";
import { PROVIDER_PRESETS, isPresetKey } from "@/lib/llm/presets";
import { canonicalReasoningEffort, reasoningCapability, type ModelCapability } from "@/lib/llm/capabilities";
import type { PublicProvider, PublicSettings, ProviderOverrideField } from "@/lib/settings";

// 凭据只保留在当前表单状态中，保存或取消后清除。
type Draft = {
  id: string; label: string; baseUrl: string; model: string; apiKey: string;
  contextWindow: string; lightModel: string; reasoningEffort: string;
  temperature: string; supportsStrictSchema: boolean; headersText: string; clearApiKey: boolean;
};
type Result = { settings: PublicSettings; model: { configured: boolean } };
const commonPresets = ["deepseek", "openai", "gemini", "claude", "ollama", "lmstudio", "openaiCompatible"];

function draftFor(provider?: PublicProvider): Draft {
  return {
    id: provider?.id ?? crypto.randomUUID(), label: provider?.label ?? "",
    baseUrl: provider?.baseUrl ?? "", model: provider?.model ?? "", apiKey: "",
    contextWindow: String(provider?.contextWindow ?? 32768),
    lightModel: provider?.lightModel ?? "", reasoningEffort: provider?.reasoningEffort ?? "default",
    temperature: String(provider?.temperature ?? 0.3),
    supportsStrictSchema: provider?.supportsStrictSchema ?? false, headersText: "", clearApiKey: false,
  };
}
function publicInput(provider: PublicProvider) {
  const { hasApiKey: _key, hasHeaders: _headers, apiKeySource: _source,
    overriddenFields: _fields, environmentOnly: _environment, ...values } = provider;
  return values;
}

export function ModelSection() {
  const { t } = useI18n();
  const presetLabel = (key: string, original: string) => t.has("providerPresets." + key) ? t("providerPresets." + key) : original;
  const { bumpData } = useAppData();
  const { data, error: loadError, refresh } = useApi<Result>("/api/settings");
  const [saved, setSaved] = React.useState<Result | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [presetKey, setPresetKey] = React.useState("openaiCompatible");
  const [models, setModels] = React.useState<string[]>([]);
  const [modelDetails, setModelDetails] = React.useState<ModelCapability[]>([]);
  const [probing, setProbing] = React.useState<string | null>(null);
  const probeGeneration = React.useRef(0);
  React.useEffect(() => () => { probeGeneration.current++; }, []);
  const formRef = React.useRef<HTMLFormElement>(null);
  const result = saved ?? data;
  const settings = result?.settings;
  const providers = settings?.providers ?? [];
  const editing = providers.find(p => p.id === draft?.id);
  const locked = (field: ProviderOverrideField) => Boolean(editing?.overriddenFields.includes(field));
  const capability = reasoningCapability(draft?.baseUrl ?? "", draft?.model ?? "", modelDetails.find(model => model.id === draft?.model));
  const effortOptions = capability.efforts;
  const change = (patch: Partial<Draft>) => { setDraft(previous => previous ? { ...previous, ...patch } : null); setError(null); if (patch.baseUrl !== undefined || patch.apiKey !== undefined || patch.headersText !== undefined || patch.clearApiKey !== undefined) { setModels([]); setModelDetails([]); probeGeneration.current++; setProbing(null); } };
  const selectPreset = (key: string) => {
    if (!isPresetKey(key)) return;
    setPresetKey(key);
    const preset = PROVIDER_PRESETS[key];
    change({ label: preset.label, baseUrl: preset.baseUrl, model: "", apiKey: "", clearApiKey: Boolean(editing?.hasApiKey), contextWindow: "32768", lightModel: "", reasoningEffort: "default", supportsStrictSchema: false, headersText: key === "gemini" ? '{"x-goog-api-client":"weave/0.1.0"}' : "{}" });
  };
  const edit = (provider?: PublicProvider) => {
    if (draft && !window.confirm(t("settings_model_section.m001"))) return;
    probeGeneration.current++; setProbing(null); setModels([]); setModelDetails([]);
    setPresetKey(Object.entries(PROVIDER_PRESETS).find(([, preset]) => preset.baseUrl === provider?.baseUrl)?.[0] ?? "openaiCompatible");
    setDraft(draftFor(provider)); setError(null); setNotice(null); setConfirmDelete(false);
  };
  const draftId = draft?.id;
  React.useEffect(() => {
    if (draftId) formRef.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
  }, [draftId]);

  const persist = async (body: unknown, message: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await apiFetch<Result>("/api/settings", { method: "PATCH", body: JSON.stringify(body) });
      setSaved(next); setDraft(null); setConfirmDelete(false); setNotice(message); bumpData();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("settings_model_section.m002")); }
    finally { setBusy(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || busy) return;
    let headers: Record<string, string> | undefined;
    if (draft.headersText.trim()) {
      try {
        const value: unknown = JSON.parse(draft.headersText);
        if (!value || Array.isArray(value) || typeof value !== "object" || Object.values(value).some(v => typeof v !== "string")) throw new Error();
        headers = value as Record<string, string>;
      } catch { setError(t("settings_model_section.m003")); return; }
    }
    const input = {
      id: draft.id, label: draft.label || (isPresetKey(presetKey) ? PROVIDER_PRESETS[presetKey].label : t("settings_model_section.m004")), baseUrl: draft.baseUrl, model: draft.model,
      ...(locked("apiKey") ? {} : { apiKey: draft.apiKey, clearApiKey: draft.clearApiKey && !draft.apiKey }),
      contextWindow: Number(draft.contextWindow), lightModel: draft.lightModel,
      reasoningEffort: canonicalReasoningEffort(draft.baseUrl, draft.model, draft.reasoningEffort as PublicProvider["reasoningEffort"]), temperature: Number(draft.temperature),
      supportsStrictSchema: draft.supportsStrictSchema,
      ...(headers && !locked("headers") ? { headers } : {}),
    };
    const remaining = providers.filter(p => !p.environmentOnly && p.id !== draft.id).map(publicInput);
    await persist({ providers: [...remaining, input], activeProviderId: draft.id, preferSavedModels: true }, t("settings_model_section.m005"));
  };

  const probe = async (provider?: PublicProvider, test = false) => {
    if (probing || busy) return;
    const id = provider?.id ?? draft?.id;
    if (!id) return;
    const generation = ++probeGeneration.current;
    setProbing(id); setError(null); setNotice(null);
    try {
      let body: unknown = { providerId: id, test };
      if (!provider && draft) {
        let headers: Record<string, string> | undefined;
        if (draft.headersText.trim()) {
          const parsed: unknown = JSON.parse(draft.headersText);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw new Error(t("settings_model_section.m006"));
          headers = parsed as Record<string, string>;
        }
        body = { test, provider: { id, ...(draft.model.trim() ? { model: draft.model.trim() } : {}), baseUrl: draft.baseUrl, apiKey: draft.apiKey, clearApiKey: draft.clearApiKey && !draft.apiKey,
          reasoningEffort: draft.reasoningEffort, temperature: Number(draft.temperature), supportsStrictSchema: draft.supportsStrictSchema,
          ...(headers ? { headers } : {}) } };
        // 环境覆盖的凭据由服务端读取，不回传浏览器。
        if (editing?.overriddenFields.length) body = { providerId: editing.id, test };
      }
      const result = await apiFetch<{ models?: string[]; details?: ModelCapability[]; supported?: boolean; connected?: boolean; elapsedMs?: number }>("/api/settings/models", { method: "POST", body: JSON.stringify(body) });
      if (generation !== probeGeneration.current) return;
      if (test) {
        const detail = t("settings_model_section.m007", {v0: ((result.elapsedMs ?? 0) / 1000).toFixed(1)});
        setNotice(detail); return;
      }
      const available = result.models ?? [];
      if (!provider) {
        setModels(available);
        setModelDetails(result.details ?? []);
        if (!draft?.model && available.length) change({ model: available[0] });
      }
      const model = provider?.model ?? draft?.model;
      const found = available.includes(model ?? "");
      const detail = !result.supported ? t("settings_model_section.m008")
        : found ? t("settings_model_section.m009") : available.length ? t("settings_model_section.m010", {v0: available.length}) : t("settings_model_section.m011");
      setNotice(detail);
    } catch (cause) {
      if (generation !== probeGeneration.current) return;
      const detail = cause instanceof Error ? cause.message : t("settings_model_section.m012");
      setError(detail);
    } finally { if (generation === probeGeneration.current) setProbing(null); }
  };

  return <section id="model-service" aria-labelledby="model-service-title">
    <div className="mb-4"><h2 id="model-service-title" className="text-[15px] font-semibold">{t("settings_model_section.m013")}</h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{t("settings_model_section.m014")}</p>
    </div>
    <div className="space-y-3">
      {!result && !loadError && <p className="text-[12.5px] text-muted-foreground">{t("settings_model_section.m015")}</p>}
      {providers.length === 0 && result && <p className="py-4 text-[13px] text-muted-foreground">{t("settings_model_section.m016")}</p>}
      <ul className="space-y-2">
        {providers.map(provider => <li key={provider.id} className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-4 sm:px-5">
          <div className="min-w-0 flex-1"><p className="flex flex-wrap items-center gap-2 text-[14px] font-medium"><span className="break-words">{provider.label}</span>{provider.id === settings?.activeProviderId && <span className="inline-flex items-center gap-1.5 text-[11px] font-normal text-[var(--success)]"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{t("settings_model_section.m017")}</span>}</p>
            <p className="mt-1 break-all text-[12px] text-muted-foreground">{provider.model || t("settings_model_section.m018")}</p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground" title={provider.baseUrl}>{serviceHost(provider.baseUrl, t("common.unconfiguredAddress"))} · {provider.hasApiKey ? t("settings_model_section.m019") : provider.hasHeaders ? t("settings_model_section.m020") : t("settings_model_section.m021")}{provider.environmentOnly ? t("settings_model_section.m022") : ""}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            {provider.id !== settings?.activeProviderId && !provider.environmentOnly && <Button size="sm" variant="ghost" disabled={busy || Boolean(draft)} onClick={() => void persist({ activeProviderId: provider.id, preferSavedModels: true }, t("settings_model_section.m023"))}>{t("settings_model_section.m024")}</Button>}
            <Button size="sm" variant="secondary" aria-label={t("settings_model_section.m025", {v0: provider.label})} disabled={busy} onClick={() => edit(provider)}>{t("settings_model_section.m026")}</Button>
          </div>
        </li>)}
      </ul>
      {!draft && result && <button type="button" className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border text-[12.5px] text-muted-foreground transition-colors hover:border-input hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-50" disabled={busy} onClick={() => edit()}><Plus size={14} aria-hidden />{t("settings_model_section.m027")}</button>}
      {draft && <form ref={formRef} onSubmit={event => void save(event)} className="rounded-xl border border-border bg-card p-5" aria-label={t("settings_model_section.m028")}>
        <fieldset disabled={busy} className="space-y-4">
          <legend className="mb-4 text-[13px] font-medium">{editing ? t("settings_model_section.m029") : t("settings_model_section.m027")}</legend>
          {editing?.environmentOnly && <p className="text-[12px] leading-relaxed text-muted-foreground">{t("settings_model_section.m030")}</p>}
          <Field label={t("settings_model_section.m031")}>
            <Select aria-label={t("settings_model_section.m031")} disabled={locked("baseUrl") || locked("apiKey") || locked("model")} value={presetKey} onChange={event => selectPreset(event.target.value)}>{Object.entries(PROVIDER_PRESETS).filter(([key]) => commonPresets.includes(key) || key === presetKey).map(([key, preset]) => <option key={key} value={key}>{presetLabel(key, preset.label)}</option>)}</Select>

          </Field>
          <Field label="API Key" overridden={locked("apiKey")} hint={editing?.hasApiKey ? t("settings_model_section.m032") : t("settings_model_section.m033")}>
            <Input aria-label="API Key" type="password" autoComplete="new-password" disabled={locked("apiKey")} value={draft.apiKey} onChange={e => change({ apiKey: e.target.value })} placeholder={draft.clearApiKey ? t("settings_model_section.m034") : editing?.hasApiKey ? t("settings_model_section.m035") : t("settings_model_section.m036")} />
          </Field>
          {presetKey === "openaiCompatible" && <Field label={t("settings_model_section.m037")}><Input aria-label={t("settings_model_section.m037")} type="url" required disabled={locked("baseUrl")} value={draft.baseUrl} onChange={e => change({ baseUrl: e.target.value })} placeholder="https://your-provider.example/v1" autoCapitalize="none" spellCheck={false} /></Field>}
          <Field label={t("settings_model_section.m013")} overridden={locked("model")}>
            {models.length ? <Select aria-label={t("settings_model_section.m038")} disabled={locked("model")} value={draft.model} onChange={event => change({ model: event.target.value })}>{!models.includes(draft.model) && <option value={draft.model}>{draft.model || t("settings_model_section.m039")}</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}</Select> : <Input aria-label={t("settings_model_section.m038")} required disabled={locked("model")} value={draft.model} onChange={e => change({ model: e.target.value })} placeholder={t("settings_model_section.m040")} autoCapitalize="none" spellCheck={false} />}
          </Field>
          <div className="flex flex-wrap items-center gap-3"><Button type="button" size="sm" loading={probing === draft.id} disabled={busy || Boolean(probing) || !draft.baseUrl} onClick={() => void probe()}>{t("settings_model_section.m041")}</Button><Button type="button" size="sm" variant="secondary" loading={probing === draft.id} disabled={busy || Boolean(probing) || !draft.baseUrl || !draft.model} onClick={() => void probe(undefined, true)}>{t("settings_model_section.m042")}</Button></div>
          {editing?.hasApiKey && !locked("apiKey") && <Button type="button" size="sm" variant="ghost" onClick={() => change({ clearApiKey: !draft.clearApiKey, apiKey: "" })}>{draft.clearApiKey ? t("settings_model_section.m043") : t("settings_model_section.m044")}</Button>}
          {draft.clearApiKey && !draft.apiKey && <p role="status" className="text-xs text-muted-foreground">{t("settings_model_section.m045")}</p>}
          <details className="space-y-4"><summary className="cursor-pointer text-[13px] font-medium">{t("settings_model_section.m046")}</summary>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("settings_model_section.m047")}><Select aria-label={t("settings_model_section.m047")} value={presetKey} disabled={locked("baseUrl")} onChange={event => selectPreset(event.target.value)}>{Object.entries(PROVIDER_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}</Select></Field>
            <Field label={t("settings_model_section.m048")}><Input aria-label={t("settings_model_section.m048")} maxLength={80} value={draft.label} onChange={e => change({ label: e.target.value })} placeholder={t("settings_model_section.m049")} /></Field>
            <Field label={t("settings_model_section.m037")} overridden={locked("baseUrl")} hint={t("settings_model_section.m050")}><Input aria-label={t("settings_model_section.m051")} type="url" disabled={locked("baseUrl")} value={draft.baseUrl} onChange={e => change({ baseUrl: e.target.value })} placeholder="https://your-provider.example/v1" autoCapitalize="none" spellCheck={false} /></Field>
            <Field label={t("settings_model_section.m052")} overridden={locked("contextWindow")} hint={t("settings_model_section.m053")}><Input aria-label={t("settings_model_section.m052")} type="number" min={1000} max={10000000} step={1} disabled={locked("contextWindow")} value={draft.contextWindow} onChange={e => change({ contextWindow: e.target.value })} placeholder={t("settings_model_section.m054")} /></Field>
          </div>

            <p className="text-xs text-muted-foreground">{t("settings_model_section.m055")}</p>
            <div className="grid gap-4 pt-3 sm:grid-cols-2">
              <Field label={t("settings_model_section.m056")} overridden={locked("lightModel")}><Input aria-label={t("settings_model_section.m057")} disabled={locked("lightModel")} value={draft.lightModel} onChange={e => change({ lightModel: e.target.value })} placeholder={t("settings_model_section.m058")} /></Field>
              <Field label={t("settings_model_section.m059")} overridden={locked("reasoningEffort")}><Select aria-label={t("settings_model_section.m059")} disabled={locked("reasoningEffort")} value={canonicalReasoningEffort(draft.baseUrl, draft.model, draft.reasoningEffort as PublicProvider["reasoningEffort"])} onChange={e => change({ reasoningEffort: e.target.value })}>{!effortOptions.includes(canonicalReasoningEffort(draft.baseUrl, draft.model, draft.reasoningEffort as PublicProvider["reasoningEffort"])) && <option value={draft.reasoningEffort} disabled>{t("settings_model_section.m060")}{draft.reasoningEffort}</option>}{effortOptions.map(value => <option key={value} value={value}>{t("reasoning." + value)}</option>)}</Select></Field>
              <Field label={t("settings_model_section.m061")}><Input aria-label={t("settings_model_section.m061")} type="number" min={0} max={2} step={0.1} required value={draft.temperature} onChange={e => change({ temperature: e.target.value })} /></Field>
              <div className="flex items-center justify-between gap-3"><span className="text-[12px]">{t("settings_model_section.m062")}</span><Switch label={t("settings_model_section.m062")} checked={draft.supportsStrictSchema} onChange={value => change({ supportsStrictSchema: value })} /></div>
            </div>
            <Field label={t("settings_model_section.m063")} overridden={locked("headers")} hint={editing?.hasHeaders ? t("settings_model_section.m064") : t("settings_model_section.m065")}>
              <Textarea aria-label={t("settings_model_section.m063")} disabled={locked("headers")} value={draft.headersText} onChange={e => change({ headersText: e.target.value })} rows={3} spellCheck={false} autoComplete="off" placeholder={'{"x-custom-header":"your-value"}'} />
            </Field>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" aria-label={t("settings_model_section.m066")} loading={busy}>{editing?.environmentOnly ? t("settings_model_section.m067") : t("settings_model_section.m068")}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(null); setConfirmDelete(false); setError(null); }}>{t("settings_model_section.m069")}</Button>
            {editing && !editing.environmentOnly && <Button type="button" size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)}>{t("settings_model_section.m070")}</Button>}
          </div>
          {confirmDelete && editing && <div className="space-y-3 rounded-md bg-muted p-3">
            <p className="text-[13px]">{t("settings_model_section.m071")}{editing.label}{t("settings_model_section.m072")}</p>
            <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => {
              const remaining = providers.filter(p => !p.environmentOnly && p.id !== editing.id);
              void persist({ providers: remaining.map(publicInput), activeProviderId: settings?.activeProviderId === editing.id ? remaining[0]?.id ?? "" : settings?.activeProviderId }, t("settings_model_section.m073"));
            }}>{t("settings_model_section.m074")}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>{t("settings_model_section.m075")}</Button></div>
          </div>}
        </fieldset>
      </form>}
      {(error || loadError) && <div role="alert" className="space-y-2"><p className="text-[13px] text-[var(--destructive)]">{error || loadError}</p>{loadError && <Button size="sm" variant="ghost" onClick={() => void refresh()}>{t("settings_model_section.m076")}</Button>}</div>}
      {notice && <p role="status" className="text-[13px] text-muted-foreground">{notice}</p>}
      <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">{t("settings_model_section.m077")}</p>
    </div>
  </section>;
}

function Field({ label, hint, overridden, children }: { label: string; hint?: string; overridden?: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  const id = React.useId();
  const element = React.isValidElement<React.HTMLAttributes<HTMLElement>>(children) ? React.cloneElement(children, { id, "aria-describedby": hint ? `${id}-hint` : undefined }) : children;
  return <div className="min-w-0 space-y-1.5">
    <label htmlFor={id} className="block text-[12px] font-medium">{label}{overridden && <span className="ml-2 text-xs font-normal text-muted-foreground">{t("settings_model_section.m078")}</span>}</label>
    {element}
    {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
  </div>;
}

function serviceHost(value: string, fallback: string) {
  try { return new URL(value).host; } catch { return fallback; }
}
