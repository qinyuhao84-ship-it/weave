"use client";

import * as React from "react";
import Link from "next/link";
import { Sparkles, Palette, Check, Database, FolderOpen } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, Input, Label, Hairline, Switch, Spinner, Button } from "@/components/ui";
import { useApi, apiFetch } from "@/hooks/use-api";
import { useTheme } from "@/hooks/use-theme";
import { useAppData } from "@/components/app-provider";
import { ModelSection } from "./model-section";
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
  const { theme, setTheme, focusMode, toggleFocusMode } = useTheme();
  const { vault, bumpData, dataVersion } = useAppData();
  const { data, loading, error } = useApi<SettingsData>("/api/settings");
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
        bumpData();
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
        setLocationMessage(`已安排迁移到 ${result.pendingRoot}。重启服务后会复制并校验整个知识库，再切换到新位置。`);
        bumpData();
      } else if (result.unchanged) {
        setLocationMessage("知识库已经在所选位置。");
      } else if (result.opened) {
        setLocationMessage("已在访达中打开知识库。");
      }
    } catch (err) {
      setLocationMessage(err instanceof Error ? err.message : "操作没有完成。");
    } finally {
      setLocationBusy(false);
    }
  }, [bumpData]);
  const runRebuild = React.useCallback(async () => {
    setRebuilding(true);
    setRebuildNote(null);
    try {
      await apiFetch("/api/vault", { method: "POST" });
      setConfirming(false);
      // 侧栏的词条数与各页面的数据都挂在 dataVersion 上，不通知的话
      // 用户点完重建，同一屏里刚看过的数字纹丝不动，没法判断生效了没有。
      bumpData();
      setRebuildNote("已重建，页面上的数据会立即刷新。");
    } catch (err) {
      setRebuildNote(err instanceof Error ? err.message : "重建失败。");
    } finally {
      setRebuilding(false);
    }
  }, [bumpData]);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32 text-muted-foreground">
        <Spinner size={18} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-20">
        <Card className="p-4">
          <p className="text-[13px] text-[var(--destructive)]">{error ?? "加载设置失败。"}</p>
        </Card>
      </div>
    );
  }

  const presets = data.personalityPresets;

  return (
    <>
      <PageHeader
        title="设置"
        description="模型、回答偏好与知识库。"
        maxWidth="3xl"
        actions={
          saved ? (
            <span className="msg-in flex items-center gap-1.5 text-[12px] text-[var(--success)]">
              <Check size={12} strokeWidth={2.5} />
              已保存
            </span>
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
        {/* ---------------------------------------------- 个性化 */}
        <Section
          icon={<Sparkles size={14} />}
          title="回答的个性化"
          description="调整称呼、语气与回答长度，自动保存。"
        >
          <Card className="divide-y divide-[var(--border)]">
            <div className="p-5">
              <Label hint="回答中使用的助手名称；留空会恢复为织识">Agent 名称</Label>
              <Input
                value={personality.agentName ?? ""}
                onChange={(e) => update("agentName", e.target.value)}
                placeholder="织识"
                aria-label="Agent 名称"
                maxLength={20}
                className="max-w-xs"
              />
            </div>
            {Object.entries(presets).map(([key, preset]) => (
              <div key={key} className="p-5 first:pt-5 last:pb-5">
                <Label hint={preset.options.find((o) => o.value === personality[key])?.hint}>
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
              <Label hint="留空则不使用称呼语">对你的称谓</Label>
              <Input
                value={personality.address ?? ""}
                onChange={(e) => update("address", e.target.value)}
                placeholder="例如：秦小"
                aria-label="对你的称谓"
                maxLength={20}
                className="max-w-xs"
              />
            </div>
          </Card>
        </Section>

        {/* ---------------------------------------------- 外观 */}
        <Section icon={<Palette size={14} />} title="外观">
          <Card className="space-y-4 p-5">
            <div>
              <Label>主题</Label>
              <div className="flex gap-1.5">
                {([
                  { value: "light" as const, label: "浅色" },
                  { value: "dark" as const, label: "深色" },
                  { value: "system" as const, label: "跟随系统" },
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

            <Hairline />

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-foreground">专注配色</p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                  深色下换成深靛蓝底，亮色下把纸压深一档，长时间阅读更安静。
                </p>
              </div>
              <Switch checked={focusMode} onChange={toggleFocusMode} label="专注配色" />
            </div>
          </Card>
        </Section>

        {/* ---------------------------------------------- 知识库维护 */}
        <Section
          icon={<Database size={14} />}
          title="知识库维护"
          description="索引只是 Markdown 的一份查询副本，出问题时重算一遍即可。"
        >
          <Card className="space-y-4 p-5">
            <div>
              <p className="text-[12.5px] font-medium text-foreground">上次知识库体检</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                {lintStatus?.lastCompletedAt ? formatDate(lintStatus.lastCompletedAt) : "还没有完成过体检。"}
              </p>
              {lintStatus?.newSourcesSinceLastLint && (
                <p className="mt-1 text-[11.5px] text-[var(--warning)]">上次体检后又导入了资料，建议再检查一次。</p>
              )}
              <Link href="/review" className="mt-2 inline-flex text-[11.5px] text-foreground underline underline-offset-4 hover:text-muted-foreground">
                打开体检与审阅
              </Link>
            </div>

            <Hairline />

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-foreground">从 Markdown 重建索引</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                  你的知识都在 vault 的 Markdown 文件里，数据库只是照着它们建的一份索引。
                  重建就是丢掉索引、照着文件重算一遍 —— 不会改动、也不会丢失任何知识。
                </p>
              </div>
              {!confirming && (
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirming(true);
                    setRebuildNote(null);
                  }}
                >
                  重建索引
                </Button>
              )}
            </div>

            <Hairline />

            <dl className="flex flex-wrap gap-x-6 gap-y-1.5 text-[11.5px]">
              <div className="flex items-center gap-1.5">
                <dt className="text-muted-foreground">词条</dt>
                <dd className="tabular-nums text-foreground">{vault?.stats.pages ?? "—"}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-muted-foreground">关联</dt>
                <dd className="tabular-nums text-foreground">{vault?.stats.links ?? "—"}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-muted-foreground">索引</dt>
                <dd
                  className={
                    vault && !vault.indexHealthy
                      ? "text-[var(--warning)]"
                      : "text-foreground"
                  }
                >
                  {vault ? (vault.indexHealthy ? "正常" : "异常，建议重建") : "—"}
                </dd>
              </div>
            </dl>

            <div>
              <p className="text-[12.5px] font-medium text-foreground">知识库位置</p>
              <code className="mt-1 block break-all rounded-[8px] bg-[var(--muted)] px-2.5 py-2 font-mono text-[11px] text-foreground">
                {vault?.vaultRoot ?? "正在读取…"}
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
                  在访达中打开
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderOpen size={13} />}
                  loading={locationBusy}
                  disabled={!vault?.canChangeLocation || Boolean(vault?.pendingVaultRoot)}
                  onClick={() => void handleVaultLocation("choose")}
                >
                  选择新位置
                </Button>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                更换位置会迁移 Markdown、原始资料、索引数据库与本地备份记录。迁移在下次启动时完成，原文件通过校验后再切换。
              </p>
              {!vault?.canChangeLocation && (
                <p className="mt-2 text-[11.5px] text-muted-foreground">文件夹选择需 macOS 且未设置 WEAVE_VAULT；其他环境请通过启动环境变量指定位置。</p>
              )}
              {(locationMessage || vault?.pendingVaultRoot) && (
                <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--ring)]">
                  {locationMessage ?? `已安排迁移到 ${vault?.pendingVaultRoot}。重启服务后生效。`}
                </p>
              )}
            </div>

            {confirming && (
              <div className="rounded-[10px] border border-border bg-[var(--muted)] p-3.5">
                <p className="text-[12px] font-medium text-foreground">什么时候该点它</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                  上面显示「异常，建议重建」时；或者你在 Obsidian 里直接改过文件、感觉某处数据对不上时。
                  重建会按当前文件重算全部词条、双链、关系图谱与全文索引，并重写 vault 根目录的
                  index.md（因此会产生一次 git 提交）。词条多时需要数秒到数十秒，期间请不要关闭页面。
                </p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="primary" loading={rebuilding} onClick={runRebuild}>
                    确认重建
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={rebuilding}
                    onClick={() => setConfirming(false)}
                  >
                    取消
                  </Button>
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
        body: JSON.stringify({ confirmation: phrase.trim() }),
      });
      setConfirming(false);
      setPhrase("");
      setNotice("知识库已清空，之前的词条与原始资料已归档到回收站；对话与个性化设置已保留。");
      bumpData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "清空知识库失败。");
    } finally {
      setClearing(false);
    }
  };

  return (
    <Section
      icon={<Database size={14} />}
      title="清空知识库"
      description="清空当前知识内容时，会先归档为可恢复批次。"
    >
      <Card className="space-y-3 p-5">
        <div>
          <p className="text-[12.5px] font-medium text-foreground">归档并清空当前知识库</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
            当前词条、原始资料、解析稿与待处理导入会一起存入回收站批次，再清空活动知识库。历史对话与引用快照、个性化配置和主题设置都会保留；清空批次可在“回收站”恢复。
          </p>
        </div>
        {!confirming ? (
          <Button size="sm" variant="danger" onClick={() => { setConfirming(true); setError(null); setNotice(null); }}>
            清空知识库
          </Button>
        ) : (
          <div className="space-y-3 rounded-[10px] border border-border bg-[var(--muted)] p-3.5">
            <p className="text-[12px] font-medium text-foreground">当前内容会移入回收站</p>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">请输入“清空”以确认。现有回收站批次不会被删除。</p>
            <Input
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder="输入：清空"
              aria-label="输入清空以确认"
              maxLength={8}
              autoComplete="off"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="danger" loading={clearing} disabled={phrase.trim() !== "清空"} onClick={clearKnowledgeBase}>
                确认清空并归档
              </Button>
              <Button size="sm" variant="ghost" disabled={clearing} onClick={() => { setConfirming(false); setPhrase(""); }}>
                取消
              </Button>
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
