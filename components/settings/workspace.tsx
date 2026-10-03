"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import Link from "next/link";
import { Sparkles, Palette, Check, Database, FolderOpen } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, Input, Label, Hairline, Button, RequestError, LoadingCards } from "@/components/ui";
import { useApi, apiFetch } from "@/hooks/use-api";
import { useTheme } from "@/hooks/use-theme";
import { useAppData } from "@/components/app-provider";
import { ModelSection } from "./model-section";
import { RetrievalSection } from "./retrieval-section";
import { cn, formatDate } from "@/lib/utils";

/** 个人偏好即时保存；模型连接配置在独立表单中显式保存。 */

type PersonalityPreset = Record<
  string,
  { label: string; options: Array<{ value: string; label: string; hint?: string }> }
>;

type SettingsData = {
  settings: {
    agentName: string;
    personality: Record<string, string>;
    theme: string;
  };
  personalityPresets: PersonalityPreset;
  model: { configured: boolean };
  docling: { available: boolean };
};

function settingsPatchFromDraft(draft: Record<string, string>) {
  const { agentName, ...personality } = draft;
  return {
    personality,
    agentName: (agentName ?? "织识").trim() || "织识",
  };
}

type LintStatus = {
  lastCompletedAt: string | null;
  newSourcesSinceLastLint: boolean;
};

export function SettingsWorkspace() {
  const { t, locale } = useI18n();
  const { theme, setTheme } = useTheme();
  const { vault, bumpData, dataVersion } = useAppData();
  const { data, loading, error, refresh } = useApi<SettingsData>("/api/settings");
  const { data: lintStatus } = useApi<LintStatus>("/api/lint", [dataVersion]);
  const [personality, setPersonality] = React.useState<Record<string, string>>({});
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const seeded = React.useRef(false);
  const debounce = React.useRef<number | null>(null);
  const flash = React.useRef<number | null>(null);
  const saveInFlight = React.useRef<Promise<unknown> | null>(null);
  const savedAgentName = React.useRef("织识");
  /** 防抖窗口内待发送的改动。卸载时要补发，见下面的清理 effect。 */
  const pending = React.useRef<Record<string, string> | null>(null);

  // 只在首次拿到服务端值时灌一次草稿 —— 之后本地 state 是权威，
  // 否则每次 revalidate 回来都会把用户刚点的选择顶掉。
  React.useEffect(() => {
    if (data && !seeded.current) {
      seeded.current = true;
      savedAgentName.current = data.settings.agentName;
      setPersonality({ ...data.settings.personality, agentName: data.settings.agentName });
    }
  }, [data]);

  React.useEffect(
    () => () => {
      if (debounce.current) window.clearTimeout(debounce.current);
      if (flash.current) window.clearTimeout(flash.current);
      // 350ms 的防抖窗口内切走（点侧栏链接、按浏览器后退）会静默丢掉最后一次改动 ——
      // 而「改完即存」的全部意义就是不丢。这里用 keepalive 补发一次。
      const draft = pending.current;
      if (draft) {
        void fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settingsPatchFromDraft(draft)),
          keepalive: true,
        }).catch(() => undefined);
      }
    },
    [],
  );

  const persist = React.useCallback(async (next: Record<string, string>) => {
    setSaveError(null);
    const patch = settingsPatchFromDraft(next);
    const agentNameChanged = patch.agentName !== savedAgentName.current;
    const request = apiFetch("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    saveInFlight.current = request;
    try {
      await request;
      if (agentNameChanged) {
        savedAgentName.current = patch.agentName;
        bumpData("settings");
      }
      setSaved(true);
      if (flash.current) window.clearTimeout(flash.current);
      flash.current = window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      if (saveInFlight.current === request) saveInFlight.current = null;
    }
  }, [bumpData]);

  // 重建索引要二次确认：它是不可撤销的重操作（重写 index.md 并产生一次 git 提交），
  // 但一年也用不上一次 —— 顺手就能点到才是问题，所以要人先读一遍再决定。
  const [confirming, setConfirming] = React.useState(false);
  const [rebuilding, setRebuilding] = React.useState(false);
  const [rebuildNote, setRebuildNote] = React.useState<string | null>(null);
  const [locationBusy, setLocationBusy] = React.useState(false);
  const [locationMessage, setLocationMessage] = React.useState<string | null>(null);
  const handleVaultLocation = React.useCallback(async (action: "open" | "choose") => {
    setLocationBusy(true);
    setLocationMessage(null);
    try {
      const result = await apiFetch<{
        opened?: boolean;
        cancelled?: boolean;
        unchanged?: boolean;
        pendingRoot?: string | null;
        restartRequired?: boolean;
      }>("/api/vault/location", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (result.cancelled) return;
      if (result.pendingRoot) {
        setLocationMessage(t("settings_workspace.m001", {v0: result.pendingRoot}));
        bumpData();
      } else if (result.unchanged) {
        setLocationMessage(t("settings_workspace.m002"));
      } else if (result.opened) {
        setLocationMessage(t("settings_workspace.m003"));
      }
    } catch (err) {
      setLocationMessage(err instanceof Error ? err.message : t("settings_workspace.m004"));
    } finally {
      setLocationBusy(false);
    }
  }, [bumpData, t]);
  const runRebuild = React.useCallback(async () => {
    setRebuilding(true);
    setRebuildNote(null);
    try {
      await apiFetch("/api/vault", { method: "POST" });
      setConfirming(false);
      // 侧栏的词条数与各页面的数据都挂在 dataVersion 上，不通知的话
      // 用户点完重建，同一屏里刚看过的数字纹丝不动，没法判断生效了没有。
      bumpData();
      setRebuildNote(t("settings_workspace.m005"));
    } catch (err) {
      setRebuildNote(err instanceof Error ? err.message : t("settings_workspace.m006"));
    } finally {
      setRebuilding(false);
    }
  }, [bumpData, t]);

  const update = React.useCallback(
    (key: string, value: string) => {
      const next = { ...personality, [key]: value };
      setPersonality(next);
      // 点选是即时的；输入称谓时不必每敲一个字打一次请求，所以统一防抖 350ms
      pending.current = next;
      if (debounce.current) window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => {
        pending.current = null;
        void persist(next);
      }, 350);
    },
    [personality, persist],
  );

  if (loading && !data && !error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 md:px-6"><LoadingCards /></div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-20">
        <RequestError error={error ?? t("settings_workspace.m007")} onRetry={() => void refresh()} retrying={loading} />
      </div>
    );
  }

  const presets = Object.fromEntries(Object.entries(data.personalityPresets).map(([key, preset]) => [key, {
    ...preset, label: t("personality." + key),
    options: preset.options.map(option => ({ ...option, label: t("personality." + option.value), hint: t("personalityHints." + option.value) })),
  }]));

  return (
    <>
      <PageHeader
        title={t("settings_workspace.m008")}
        description={t("settings_workspace.m009")}
        maxWidth="3xl"
        actions={
          saved ? (
            <span className="msg-in flex items-center gap-1.5 text-[12px] text-[var(--success)]">
              <Check size={12} strokeWidth={2.5} />
              {t("settings_workspace.m010")}</span>
          ) : undefined
        }
      />

      <div className="mx-auto max-w-3xl space-y-8 px-4 py-8 md:px-6">
        {saveError && (
          <Card className="border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] p-3.5">
            <p className="text-[12.5px] text-[var(--destructive)]">{saveError}</p>
          </Card>
        )}

        <ModelSection />
        <Hairline />
        <RetrievalSection />
        {/* ---------------------------------------------- 个性化 */}
        <Section
          icon={<Sparkles size={14} />}
          title={t("settings_workspace.m011")}
          description={t("settings_workspace.m012")}
        >
          <Card className="divide-y divide-[var(--border)]">
            <div className="p-5">
              <Label>{t("settings_workspace.m014")}</Label>
              <Input
                value={personality.agentName ?? ""}
                onChange={(e) => update("agentName", e.target.value)}
                placeholder="织识"
                aria-label={t("settings_workspace.m014")}
                maxLength={20}
                className="max-w-xs"
              />
            </div>
            {Object.entries(presets).map(([key, preset]) => (
              <div key={key} className="p-5 first:pt-5 last:pb-5">
                <Label>
                  {preset.label}
                </Label>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={preset.label}>
                  {preset.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={personality[key] === option.value}
                      onClick={() => update(key, option.value)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[12.5px] transition-colors duration-150",
                        personality[key] === option.value
                          ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
                          : "border-[var(--border)] text-muted-foreground hover:border-[var(--input)] hover:text-foreground",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <div className="p-5">
              <Label hint={t("settings_workspace.m015")}>{t("settings_workspace.m016")}</Label>
              <Input
                value={personality.address ?? ""}
                onChange={(e) => update("address", e.target.value)}
                placeholder={t("settings_workspace.m017")}
                aria-label={t("settings_workspace.m016")}
                maxLength={20}
                className="max-w-xs"
              />
            </div>
          </Card>
        </Section>

        {/* ---------------------------------------------- 外观 */}
        <Section icon={<Palette size={14} />} title={t("settings_workspace.m018")}>
          <Card className="space-y-4 p-5">
            <div>
              <Label>{t("settings_workspace.m019")}</Label>
              <div className="flex gap-1.5">
                {([
                  { value: "light" as const, label: t("settings_workspace.m020") },
                  { value: "dark" as const, label: t("settings_workspace.m021") },
                  { value: "system" as const, label: t("settings_workspace.m022") },
                ]).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={theme === option.value}
                    onClick={() => setTheme(option.value)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-[12.5px] transition-colors duration-150",
                      theme === option.value
                        ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
                        : "border-[var(--border)] text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

          </Card>
        </Section>

        {/* ---------------------------------------------- 知识库维护 */}
        <Section
          icon={<Database size={14} />}
          title={t("settings_workspace.m025")}
        >
          <Card className="space-y-4 p-5">
            <div>
              <p className="text-[12.5px] font-medium text-foreground">{t("settings_workspace.m027")}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                {lintStatus?.lastCompletedAt ? formatDate(lintStatus.lastCompletedAt, locale) : t("settings_workspace.m028")}
              </p>
              {lintStatus?.newSourcesSinceLastLint && (
                <p className="mt-1 text-[11.5px] text-[var(--warning)]">{t("settings_workspace.m029")}</p>
              )}
              <Link href="/review" className="mt-2 inline-flex text-[11.5px] text-foreground underline underline-offset-4 hover:text-muted-foreground">
                {t("settings_workspace.m030")}</Link>
            </div>

            <Hairline />

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-foreground">{t("settings_workspace.m031")}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                  {t("settings_workspace.m032")}</p>
              </div>
              {!confirming && (
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirming(true);
                    setRebuildNote(null);
                  }}
                >
                  {t("settings_workspace.m033")}</Button>
              )}
            </div>

            <Hairline />

            <dl className="flex flex-wrap gap-x-6 gap-y-1.5 text-[11.5px]">
              <div className="flex items-center gap-1.5">
                <dt className="text-muted-foreground">{t("settings_workspace.m034")}</dt>
                <dd className="tabular-nums text-foreground">{vault?.stats.pages ?? "—"}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-muted-foreground">{t("settings_workspace.m035")}</dt>
                <dd className="tabular-nums text-foreground">{vault?.stats.links ?? "—"}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-muted-foreground">{t("settings_workspace.m036")}</dt>
                <dd
                  className={
                    vault && !vault.indexHealthy
                      ? "text-[var(--warning)]"
                      : "text-foreground"
                  }
                >
                  {vault ? (vault.indexHealthy ? t("settings_workspace.m037") : t("settings_workspace.m038")) : "—"}
                </dd>
              </div>
            </dl>

            <div>
              <p className="text-[12.5px] font-medium text-foreground">{t("settings_workspace.m039")}</p>
              <code className="mt-1 block break-all rounded-[8px] bg-[var(--muted)] px-2.5 py-2 font-mono text-[11px] text-foreground">
                {vault?.vaultRoot ?? t("settings_workspace.m040")}
              </code>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderOpen size={13} />}
                  loading={locationBusy}
                  disabled={!vault?.canOpenLocation}
                  onClick={() => void handleVaultLocation("open")}
                >
                  {t("settings_workspace.m041")}</Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderOpen size={13} />}
                  loading={locationBusy}
                  disabled={!vault?.canChangeLocation || Boolean(vault?.pendingVaultRoot)}
                  onClick={() => void handleVaultLocation("choose")}
                >
                  {t("settings_workspace.m042")}</Button>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                {t("settings_workspace.m043")}</p>
              {!vault?.canChangeLocation && (
                <p className="mt-2 text-[11.5px] text-muted-foreground">{t("settings_workspace.m044")}</p>
              )}
              {(locationMessage || vault?.pendingVaultRoot) && (
                <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--ring)]">
                  {locationMessage ?? t("settings_workspace.m045", {v0: vault?.pendingVaultRoot ?? ""})}
                </p>
              )}
            </div>

            {confirming && (
              <div className="rounded-[10px] border border-border bg-[var(--muted)] p-3.5">
                <p className="text-[12px] font-medium text-foreground">{t("settings_workspace.m046")}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                  {t("settings_workspace.m047")}</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="primary" loading={rebuilding} onClick={runRebuild}>
                    {t("settings_workspace.m048")}</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={rebuilding}
                    onClick={() => setConfirming(false)}
                  >
                    {t("settings_workspace.m049")}</Button>
                </div>
              </div>
            )}

            {rebuildNote && (
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">{rebuildNote}</p>
            )}
          </Card>
        </Section>
        <DatabaseClearSection bumpData={bumpData} />
      </div>
    </>
  );
}

function DatabaseClearSection({ bumpData }: { bumpData: () => void }) {
  const { t, locale } = useI18n();
  const [confirming, setConfirming] = React.useState(false);
  const [phrase, setPhrase] = React.useState("");
  const [clearing, setClearing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const clearKnowledgeBase = async () => {
    setClearing(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch("/api/vault/clear", {
        method: "POST",
        body: JSON.stringify({ confirmation: "清空" }),
      });
      setConfirming(false);
      setPhrase("");
      setNotice(t("settings_workspace.m050"));
      bumpData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings_workspace.m051"));
    } finally {
      setClearing(false);
    }
  };

  return (
    <Section
      icon={<Database size={14} />}
      title={t("settings_workspace.m052")}
    >
      <Card className="space-y-3 p-5">
        <div>
          <p className="text-[12.5px] font-medium text-foreground">{t("settings_workspace.m054")}</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
            {t("settings_workspace.m055")}</p>
        </div>
        {!confirming ? (
          <Button size="sm" variant="danger" onClick={() => { setConfirming(true); setError(null); setNotice(null); }}>
            {t("settings_workspace.m052")}</Button>
        ) : (
          <div className="space-y-3 rounded-[10px] border border-border bg-[var(--muted)] p-3.5">
            <p className="text-[12px] font-medium text-foreground">{t("settings_workspace.m056")}</p>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">{t("settings_workspace.m057")}</p>
            <Input
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder={t("settings_workspace.m058")}
              aria-label={t("settings_workspace.m059")}
              maxLength={8}
              autoComplete="off"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="danger" loading={clearing} disabled={phrase.trim() !== (locale === "en" ? "CLEAR" : "清空")} onClick={clearKnowledgeBase}>
                {t("settings_workspace.m060")}</Button>
              <Button size="sm" variant="ghost" disabled={clearing} onClick={() => { setConfirming(false); setPhrase(""); }}>
                {t("settings_workspace.m049")}</Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-[11.5px] text-[var(--destructive)]">{error}</p>}
        {notice && <p role="status" className="text-[11.5px] text-muted-foreground">{notice}</p>}
      </Card>
    </Section>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div>
          <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
          {description && (
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}
