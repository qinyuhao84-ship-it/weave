"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronDown, Code2 } from "lucide-react";
import { apiFetch } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import { preferredThinkingEffort, thinkingEfforts, reasoningCapability, type ModelCapability } from "@/lib/llm/capabilities";
import type { PublicProvider } from "@/lib/settings";
import type { ChatConfig } from "@/lib/chat/config";

type ModelList = { models: string[]; details?: ModelCapability[]; supported: boolean; error?: string };

const PICKER_ITEM = "flex min-h-10 w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-[12.5px] transition-colors hover:bg-muted aria-pressed:bg-muted focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:opacity-55";

export function ChatControls({ value, providers, disabled, onChange }: {
  value: ChatConfig | null; providers: PublicProvider[]; disabled: boolean; onChange: (value: ChatConfig) => void;
}) {
  const { t } = useI18n();
  const effortLabel = (effort: ChatConfig["reasoningEffort"]) => effort === "none" ? t("reasoning.off") : t("reasoning.label", { effort: t("reasoning." + effort) });
  const [open, setOpen] = React.useState<"model" | "effort" | null>(null);
  const [lists, setLists] = React.useState<Record<string, ModelList>>({});
  const [loading, setLoading] = React.useState(false);
  const loaded = React.useRef<Record<string, PublicProvider>>({});
  const requests = React.useRef(new Map<string, AbortController>());
  const browsingModels = open === "model";
  const panel = React.useRef<HTMLDivElement>(null);
  const controls = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const effortTrigger = React.useRef<HTMLButtonElement>(null);
  const hintId = React.useId();
  const [position, setPosition] = React.useState({ left: 16, bottom: 80, maxHeight: 400 });
  const selected = providers.find(provider => provider.id === value?.providerId);
  const selectedMetadata = lists[value?.providerId ?? ""]?.details?.find(model => model.id === value?.model);
  const capability = reasoningCapability(selected?.baseUrl ?? "", value?.model ?? "", selectedMetadata);
  const shownEffort = preferredThinkingEffort(selected?.baseUrl ?? "", value?.model ?? "", value?.reasoningEffort ?? "default", selectedMetadata);
  const efforts = thinkingEfforts(capability);
  React.useEffect(() => {
    if (value && (capability.known || Boolean(selected && loaded.current[selected.id])) && value.reasoningEffort !== shownEffort) onChange({ ...value, reasoningEffort: shownEffort });
  }, [value, capability.known, shownEffort, onChange, selected]);
  const close = React.useCallback(() => { setOpen(null); (open === "effort" ? effortTrigger : trigger).current?.focus(); }, [open]);

  React.useEffect(() => {
    loaded.current = {};
    setLists({});
    const pending = requests.current;
    return () => { for (const controller of pending.values()) controller.abort(); pending.clear(); };
  }, [providers]);

  React.useEffect(() => {
    const pending = providers.filter(provider => provider.baseUrl && (browsingModels || provider.id === value?.providerId) && loaded.current[provider.id] !== provider && !requests.current.has(provider.id));
    for (const provider of pending) {
      const controller = new AbortController();
      requests.current.set(provider.id, controller);
      void apiFetch<ModelList>("/api/settings/models", { method: "POST", body: JSON.stringify({ providerId: provider.id }), signal: controller.signal })
        .catch((): ModelList => ({ models: [], supported: false, error: t("chat_chat_controls.m001") }))
        .then(list => {
          if (controller.signal.aborted) return;
          loaded.current[provider.id] = provider;
          setLists(previous => ({ ...previous, [provider.id]: list }));
        }).finally(() => {
          if (requests.current.get(provider.id) !== controller) return;
          requests.current.delete(provider.id);
          setLoading(requests.current.size > 0);
        });
    }
    setLoading(requests.current.size > 0);
  }, [providers, value?.providerId, browsingModels, t]);

  React.useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = (open === "effort" ? effortTrigger : trigger).current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(open === "effort" ? 180 : 320, window.innerWidth - 32);
      const top = controls.current?.getBoundingClientRect().top ?? rect.top;
      setPosition({ left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), bottom: Math.max(16, window.innerHeight - top + 8), maxHeight: Math.max(80, top - 24) });
    };
    place(); window.addEventListener("resize", place);
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node) && !effortTrigger.current?.contains(event.target as Node)) setOpen(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    (panel.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)') ?? panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    return () => { window.removeEventListener("resize", place); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open, close]);
  React.useEffect(() => { if (disabled) setOpen(null); }, [disabled]);

  const navigatePicker = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") { close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const openWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, picker: "model" | "effort") => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(picker); }
  };

  const choose = (provider: PublicProvider, model: string) => {
    if (!value) return;
    const metadata = lists[provider.id]?.details?.find(entry => entry.id === model);
    onChange({ ...value, providerId: provider.id, model, reasoningEffort: preferredThinkingEffort(provider.baseUrl, model, "default", metadata), contextWindow: metadata?.contextWindow ?? provider.contextWindow });
    close();
  };

  return <div ref={controls} className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
    <div className="group/html relative">
      <button type="button" disabled={disabled || !value} aria-pressed={value?.showMe ?? false} aria-describedby={hintId} onClick={() => value && onChange({ ...value, showMe: !value.showMe })}
        className={cn("chat-composer-control gap-1.5", value?.showMe && "chat-html-selected")}>
        <Code2 size={13} strokeWidth={1.8} aria-hidden />{t("chat_chat_controls.m002")}</button>
      <div id={hintId} role="tooltip" className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 w-[min(240px,75vw)] rounded-lg border border-border bg-popover px-3 py-2 text-[12px] leading-relaxed text-popover-foreground opacity-0 shadow-sm transition-opacity group-hover/html:opacity-100 group-focus-within/html:opacity-100">{t("html.hint")}</div>
    </div>
    <div className="relative min-w-0">
      <button ref={trigger} type="button" className="chat-composer-control max-w-[190px] gap-1" disabled={disabled || !value} aria-expanded={open === "model"} aria-controls="chat-model-picker" aria-label={t("chat_chat_controls.m004", {v0: value?.model ?? t("chat_chat_controls.m003")})} onKeyDown={event => openWithKeyboard(event, "model")} onClick={() => setOpen(previous => previous === "model" ? null : "model")}>
        <span className="truncate">{value?.model || t("chat_chat_controls.m005")}</span><ChevronDown size={12} className="shrink-0" aria-hidden />
      </button>
      {open === "model" && <div ref={panel} id="chat-model-picker" role="group" aria-label={t("chat_chat_controls.m006")} onKeyDown={navigatePicker} style={position} className="selection-popover chat-picker w-[min(320px,calc(100vw-32px))]">
        {providers.filter(provider => provider.baseUrl).map(provider => {
          const list = lists[provider.id];
          const models = [...new Set([provider.model, ...(value?.providerId === provider.id ? [value.model] : []), ...(list?.models ?? [])])].filter(Boolean);
          return <div key={provider.id} className="mb-2 last:mb-0"><p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">{provider.label}</p>
            {models.map(model => <button key={model} type="button" aria-pressed={value?.providerId === provider.id && value.model === model} className={PICKER_ITEM} onClick={() => choose(provider, model)}><span className="min-w-0 break-all">{model}</span>{value?.providerId === provider.id && value.model === model && <Check size={13} className="shrink-0" aria-label={t("chat_chat_controls.m007")} />}</button>)}
            {list?.error && <p className="px-2 py-1 text-[11px] leading-relaxed text-muted-foreground">{list.error}</p>}
          </div>;
        })}
        {loading && <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("chat_chat_controls.m008")}</p>}
        <Link href="/settings#model-service" onClick={() => setOpen(null)} className="mt-1 flex min-h-10 items-center border-t border-border px-2 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">{t("chat_chat_controls.m009")}</Link>
      </div>}
    </div>
    {efforts.length > 0 && <div className="relative min-w-0">
      <button ref={effortTrigger} type="button" className="chat-composer-control gap-1" title={capability.known ? t("chat_chat_controls.m010") : t("chat_chat_controls.m011")} aria-label={t("chat_chat_controls.m012", {v0: t("reasoning." + shownEffort)})} aria-expanded={open === "effort"} aria-controls="chat-effort-picker" disabled={disabled || !value || (efforts.length === 1 && shownEffort === "default")} onKeyDown={event => openWithKeyboard(event, "effort")} onClick={() => setOpen(previous => previous === "effort" ? null : "effort")}>
        <span>{effortLabel(shownEffort)}</span><ChevronDown size={12} className="shrink-0" aria-hidden />
      </button>
      {open === "effort" && <div ref={panel} id="chat-effort-picker" role="group" aria-label={t("chat_chat_controls.m013")} onKeyDown={navigatePicker} style={position} className="selection-popover chat-picker w-[min(180px,calc(100vw-32px))]">
        {efforts.map(effort => <button key={effort} type="button" className={PICKER_ITEM} aria-pressed={shownEffort === effort} onClick={() => { if (value) onChange({ ...value, reasoningEffort: effort }); close(); }}><span>{effortLabel(effort)}</span>{shownEffort === effort && <Check size={13} className="shrink-0" aria-hidden />}</button>)}
      </div>}
    </div>}
  </div>;
}
