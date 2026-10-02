"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import { Trash2, GitMerge } from "lucide-react";
import { Button, Card, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";

/** 一条破坏性操作的影响范围。**由后端现算**，模型自述的一律不采信 */
export type ImpactView = {
  totalReferences: number;
  referencingPages: Array<{ pageId: string; title: string; count: number }>;
  computedAt: string;
};

export type PendingActionView =
  | {
      id: string;
      action: "delete";
      pageId: string;
      title: string;
      impact: ImpactView;
      reason: string;
    }
  | {
      id: string;
      action: "merge";
      sourcePageId: string;
      sourceTitle: string;
      targetPageId: string;
      targetTitle: string;
      impact: ImpactView;
      mergedContent: string;
      diffStat: { added: number; removed: number };
      reason: string;
    };

export type ChangePlanView = {
  /** 字面量类型，界面靠它把两种计划分开渲染 */
  mode: "answers";
  summary: string;
  applied: {
    edits: Array<{ pageId: string; title: string; reason: string; added: number; removed: number }>;
    created: Array<{ id: string; title: string }>;
    conflicts: string[];
    rejected: string[];
    commits: number;
  };
  pending: PendingActionView[];
  itemOutcomes: Array<{ itemId: string; outcome: string; note: string }>;
};

/**
 * 破坏性操作的确认面板。
 *
 * 不是模态框 —— 影响范围可能列出十几个词条，模态里读不完也滚不动。它是一块
 * 就地展开的面板。
 *
 * 三件事必须显式呈现，缺一不可：
 *   · **影响范围**：哪些词条引用了它、各引用几次、引用会被改写成什么
 *   · **这份影响是几分钟前算的**：用户可能读很久，期间外部编辑会让它失真
 *   · **没勾选的不会被静默丢掉**：提交时会如实报告，事项回到「已回答」
 */
export function PlanConfirmPanel({
  plan,
  onApply,
  onCancel,
  busy,
}: {
  plan: ChangePlanView;
  onApply: (approved: string[]) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { t, locale } = useI18n();
  // 默认全勾：模型提议的每一件事都是某条回答要的结果，用户不勾才是例外
  const [approved, setApproved] = React.useState<Set<string>>(
    () => new Set(plan.pending.map((action) => action.id)),
  );

  const toggle = (id: string) => {
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const done = plan.applied.edits.length + plan.applied.created.length;

  return (
    <Card className="min-w-0 border-[var(--warning)]/40 p-4 sm:p-5 [overflow-wrap:anywhere]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-semibold tracking-[0.08em] text-foreground">{t("review_plan_confirm_panel.m001")}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            {plan.summary}
          </p>
        </div>
        <Badge tone="warning">{plan.pending.length} {t("review_plan_confirm_panel.m002")}</Badge>
      </div>

      {done > 0 && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
          {plan.applied.edits.length > 0 && t("review_plan_confirm_panel.m003", {v0: plan.applied.edits.length})}
          {plan.applied.edits.length > 0 && plan.applied.created.length > 0 && "、"}
          {plan.applied.created.length > 0 && t("review_plan_confirm_panel.m004", {v0: plan.applied.created.length})}
          {t("review_plan_confirm_panel.m005")}
        </p>
      )}

      <div className="mt-3 space-y-2">
        {plan.pending.map((action) => {
          const checked = approved.has(action.id);
          const label =
            action.action === "delete"
              ? t("review_plan_confirm_panel.m006", {v0: action.title})
              : t("review_plan_confirm_panel.m007", {v0: action.sourceTitle, v1: action.targetTitle});

          return (
            <label
              key={action.id}
              className={cn(
                "block cursor-pointer rounded-[16px] border p-3 transition-colors",
                checked ? "border-[var(--warning)]/50 bg-background" : "border-[var(--border)]",
              )}
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy}
                  onChange={() => toggle(action.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
                    {action.action === "delete" ? <Trash2 size={12} /> : <GitMerge size={12} />}
                    {label}
                  </p>

                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                    {t("review_plan_confirm_panel.m008")}{action.impact.totalReferences > 0
                      ? t("review_plan_confirm_panel.m009", {v0: action.impact.totalReferences, v1: action.impact.referencingPages.length})
                      : t("review_plan_confirm_panel.m010")}
                    {action.impact.referencingPages.length > 0 && (
                      <>
                        {" —— "}
                        {action.impact.referencingPages.slice(0, 5).map((page) => `《${page.title}》`).join("、")}
                        {action.impact.referencingPages.length > 5 && t("review_plan_confirm_panel.m011")}
                      </>
                    )}
                    {action.action === "merge" && t("review_plan_confirm_panel.m012")}
                  </p>

                  <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                    {t("review_plan_confirm_panel.m013")}{relativeTime(action.impact.computedAt, locale)}{t("review_plan_confirm_panel.m014")}{action.action === "merge" &&
                      t("review_plan_confirm_panel.m015", {v0: action.diffStat.added > 0 ? `+${action.diffStat.added}` : "", v1: action.diffStat.removed > 0 ? ` −${action.diffStat.removed}` : ""})}
                  </p>

                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                    {t("review_plan_confirm_panel.m016")}{action.reason}
                  </p>
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {plan.applied.rejected.length > 0 && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--warning)]">
          {t("review_plan_confirm_panel.m017")}{plan.applied.rejected.join("；")}
        </p>
      )}
      {plan.applied.conflicts.length > 0 && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--warning)]">
          {t("review_plan_confirm_panel.m018")}{plan.applied.conflicts.join("；")}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          loading={busy}
          onClick={() => onApply([...approved])}
          disabled={busy || approved.size === 0}
        >
          {t("review_plan_confirm_panel.m019")}{approved.size} {t("review_plan_confirm_panel.m002")}</Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t("review_plan_confirm_panel.m020")}</Button>
        <span className="text-[11px] text-muted-foreground">
          {t("review_plan_confirm_panel.m021")}</span>
      </div>
    </Card>
  );
}

/** 「3 分钟前」。影响范围可能过期，用户有权知道它是什么时候算的 */
function relativeTime(iso: string, locale: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes <= 0) return locale === "en" ? "just now" : "刚刚";
  if (minutes < 60) return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).format(-minutes, "minute");
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).format(-Math.round(minutes / 60), "hour");
}

/* ------------------------------------------------------ 机械修复计划 */

export type FixPlanItemView = {
  id: string;
  title: string;
  type: string;
  content: string;
  reason: string;
};

export type FixPlanView = {
  mode: "mechanical";
  summary: string;
  items: FixPlanItemView[];
  skipped: Array<{ name: string; reason: string }>;
};

/**
 * 缺页补建的计划面板。
 *
 * 与破坏性操作那块的区别：这里没有「不可逆」的顾虑（新建不覆盖任何东西），
 * 所以不需要影响范围那一套；但初稿是模型凭几处引用上下文写的，**用户可以改** ——
 * 那是它唯一可能出错的地方。
 */
export function FixPlanPanel({
  plan,
  onApply,
  onCancel,
  busy,
}: {
  plan: FixPlanView;
  onApply: (approved: string[], edits: Record<string, string>) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const [approved, setApproved] = React.useState<Set<string>>(
    () => new Set(plan.items.map((item) => item.id)),
  );
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const [openId, setOpenId] = React.useState<string | null>(null);

  const toggle = (id: string) => {
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Card className="min-w-0 p-4 sm:p-5 [overflow-wrap:anywhere]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-semibold tracking-[0.08em] text-foreground">
            {t("review_plan_confirm_panel.m022")}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            {plan.summary}
          </p>
        </div>
        <Badge tone="accent">{plan.items.length} {t("review_plan_confirm_panel.m002")}</Badge>
      </div>

      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        {t("review_plan_confirm_panel.m023")}</p>

      <div className="mt-3 space-y-2">
        {plan.items.map((item) => {
          const checked = approved.has(item.id);
          const open = openId === item.id;
          return (
            <div
              key={item.id}
              className={cn(
                "rounded-[16px] border p-3 transition-colors",
                checked ? "border-[var(--border)] bg-background" : "border-[var(--border)] opacity-60",
              )}
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy}
                  onChange={() => toggle(item.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : item.id)}
                    className="text-left text-[12.5px] font-medium text-foreground"
                  >
                    《{item.title}》
                    <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                      {open ? t("review_plan_confirm_panel.m024") : t("review_plan_confirm_panel.m025")}
                    </span>
                  </button>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                    {t("review_plan_confirm_panel.m016")}{item.reason}
                  </p>
                  {open && (
                    <textarea
                      className="mt-2 w-full resize-none rounded-[12px] border border-[var(--border)] bg-card p-2 font-mono text-[11.5px] leading-relaxed text-foreground"
                      rows={8}
                      disabled={busy}
                      value={edits[item.id] ?? item.content}
                      onChange={(event) =>
                        setEdits((prev) => ({ ...prev, [item.id]: event.target.value }))
                      }
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {plan.skipped.length > 0 && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
          {t("review_plan_confirm_panel.m026")}{plan.skipped.map((entry) => `「${entry.name}」${entry.reason ? `（${entry.reason}）` : ""}`).join("、")}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button
          size="sm"
          loading={busy}
          disabled={busy || approved.size === 0}
          onClick={() => onApply([...approved], edits)}
        >
          {t("review_plan_confirm_panel.m027")}{approved.size} {t("review_plan_confirm_panel.m028")}</Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t("review_plan_confirm_panel.m029")}</Button>
      </div>
    </Card>
  );
}
