"use client";
import { useI18n } from "@/components/i18n-provider";

import { useAppData } from "@/components/app-provider";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { QuestionPicker, type AnswerDraft } from "@/components/review/question-picker";
import { Badge, Input, Textarea, TypeBadge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { stripWikilinks } from "@/lib/vault/wikilinks";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Pencil, Save,
  Trash2
} from "lucide-react";
import * as React from "react";
import {
  type DraftPage,
  type DraftReviewItem,
  type ReviewDecisionDraft
} from "./ingest-provider";

export function CollapsibleCard({
  title,
  type,
  summary,
  expanded,
  onToggle,
  skipped,
  onSkip,
  onRemove,
  onTitleChange,
  onEdit,
  page,
}: {
  title: string;
  type: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  skipped: boolean;
  onSkip: () => void;
  onRemove?: () => void;
  onTitleChange?: (title: string) => void;
  onEdit: (content: string) => void;
  page: DraftPage;
}) {
  const { t } = useI18n();
  const { resolveWikilink } = useAppData();
  const [editing, setEditing] = React.useState(false);
  const [draftContent, setDraftContent] = React.useState(page.content);
  const [draftTitle, setDraftTitle] = React.useState(title);

  React.useEffect(() => setDraftContent(page.content), [page.content]);
  React.useEffect(() => setDraftTitle(title), [title]);

  return (
    <div className={cn("rounded-[14px] border border-border bg-card", skipped && "opacity-50")}>
      <div className="flex items-center gap-2 px-3.5 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            size={13}
            className={cn("shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
          <span className="truncate text-[13.5px] font-medium text-foreground">{draftTitle}</span>
          <TypeBadge type={type} />
          {page.confidence === "low" && <Badge tone="warning">{t("ingest_ingest_drawer.m100")}</Badge>}
          {summary && (
            <span className="hidden truncate text-[12px] text-muted-foreground sm:block">{summary}</span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <SkipButton disabled={skipped} onClick={onSkip} />
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
              aria-label={t("ingest_ingest_drawer.m101", {v0: draftTitle})}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-3.5 py-3">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            {onTitleChange ? (
              <Input
                value={draftTitle}
                onChange={(e) => { setDraftTitle(e.target.value); onTitleChange(e.target.value); }}
                className="h-7 max-w-xs text-[13px] font-medium"
                aria-label={type === "source" ? t("ingest_ingest_drawer.m102") : t("ingest_ingest_drawer.m103")}
              />
            ) : (
              <span className="text-[12px] text-muted-foreground">{t("ingest_ingest_drawer.m104")}</span>
            )}
            <button
              type="button"
              onClick={() => {
                if (editing) onEdit(draftContent);
                setEditing((v) => !v);
              }}
              className="flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
            >
              {editing ? <><Save size={11} /> {t("ingest_ingest_drawer.m105")}</> : <><Pencil size={11} /> {t("ingest_ingest_drawer.m106")}</>}
            </button>
          </div>

          {editing ? (
            <Textarea
              value={draftContent}
              rows={12}
              onChange={(e) => { setDraftContent(e.target.value); onEdit(e.target.value); }}
              aria-label={t("ingest_ingest_drawer.m107", {v0: title})}
              className="font-mono text-[12.5px]"
            />
          ) : (
            <div className="rounded-[12px] border border-border bg-background p-3">
              {/* 草稿正文本来就由模型按 [[词条名]] 写成，这里必须把双链渲染出来 ——
                  否则审阅时看到的是满屏双方括号，读不出这段正文到底长什么样。
                  还没建出来的词条按普通文字渲染：它们正是这次要建的，
                  点进一个尚不存在的词条没有任何意义。 */}
              <MarkdownRenderer
                content={page.content}
                density="compact"
                resolveWikilink={resolveWikilink}
                brokenWikilinks="plain"
              />
            </div>
          )}

          {page.aliases.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">{t("ingest_ingest_drawer.m108")}</span>
              {page.aliases.map((alias) => (
                <Badge key={alias} tone="neutral">{alias}</Badge>
              ))}
            </div>
          )}

          {page.citations.length > 0 && (
            <div className="mt-2.5 border-t border-border pt-2.5">
              <p className="mb-1 text-[11.5px] text-muted-foreground">
                {t("ingest_ingest_drawer.m109")}{page.citations.some((c) => c.page) ? t("ingest_ingest_drawer.m110") : ""}）
              </p>
              {page.citations.slice(0, 2).map((citation, index) => (
                <p key={index} className="text-[11.5px] leading-relaxed text-muted-foreground">
                  {citation.page ? t("ingest_ingest_drawer.m111", {v0: citation.page}) : ""}
                  {stripWikilinks(citation.quote).slice(0, 120)}
                  {citation.quote.length > 120 ? "…" : ""}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SkipButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        disabled
          ? "border-[var(--muted-foreground)] text-muted-foreground"
          : "border-[var(--focus-ring)] text-[var(--ring)]",
      )}
    >
      {disabled ? t("ingest_ingest_drawer.m112") : t("ingest_ingest_drawer.m113")}
    </button>
  );
}

export function Section({
  title,
  count,
  hint,
  action,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="text-[12px] font-semibold tracking-[0.08em] text-foreground">{title}</h3>
        <span className="text-[11.5px] tabular-nums text-muted-foreground">{count}</span>
        {hint && <span className="truncate text-[11.5px] text-muted-foreground">· {hint}</span>}
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/**
 * 一条待判事项 + 当场裁决。
 *
 * 与体检页的裁决卡片是同一套语义（采纳 / 忽略 + 一句可选说明），差别只在时机：
 * 这里点完随草稿一起落库；体检页那条是可以随时改判的长期记录。
 */
export function ReviewDecisionCard({
  item,
  decision,
  onAnswer,
}: {
  item: DraftReviewItem;
  decision?: ReviewDecisionDraft;
  onAnswer: (answer: string, choiceId: string | null) => void;
}) {
  const { t } = useI18n();
  const answerDraft: AnswerDraft = {
    answer: decision?.answer ?? "",
    choiceId: decision?.choiceId ?? null,
  };

  // 「碰过了」而不是「裁决过了」：只回答了没裁决的条目也是处理过的，
  // 它会在提交之后由模型接着处理
  const handled = Boolean(decision?.answer?.trim());

  return (
    <div
      className={cn(
        "rounded-[14px] border p-3.5 transition-colors",
        handled
          ? "border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-[color-mix(in_srgb,var(--success)_5%,transparent)]"
          : "border-border bg-[color-mix(in_srgb,var(--warning)_5%,transparent)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {handled ? (
              <Check size={12} className="shrink-0 text-[var(--success)]" />
            ) : (
              <AlertTriangle size={12} className="shrink-0 text-[var(--warning)]" />
            )}
            <span className="text-[12.5px] font-medium text-foreground">{item.title}</span>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{item.detail}</p>

          {item.relatedTitles.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.relatedTitles.slice(0, 6).map((title) => (
                <Badge key={title} tone="neutral">{title}</Badge>
              ))}
            </div>
          )}
        </div>

      </div>

      {item.question && item.options && item.options.length >= 2 ? (
        <QuestionPicker
          question={item.question}
          options={item.options}
          value={answerDraft}
          onChange={(next) => {
            onAnswer(next.answer, next.choiceId);
          }}
        />
      ) : (
        <>
          {item.question && (
            <p className="mt-3 text-[12.5px] font-medium leading-relaxed text-foreground">{item.question}</p>
          )}
        <Textarea
          className={item.question ? "mt-2" : "mt-3"}
          rows={2}
          value={answerDraft.choiceId ? "" : answerDraft.answer}
          aria-label={t("ingest_ingest_drawer.m114", {v0: item.title})}
          maxLength={500}
          placeholder={t("ingest_ingest_drawer.m115")}
          onChange={(event) => {
            const next = { answer: event.target.value, choiceId: null };
            onAnswer(next.answer, next.choiceId);
          }}
        />
        </>
      )}
      {handled && (
        <div className="mt-2 space-y-1">
          <p className="text-[11.5px] text-[var(--success)]">{t(decision?.note === "由 AI 批量判断" ? "aiIngestReview.generated" : "ingest_ingest_drawer.m116")}</p>
          {decision?.note === "由 AI 批量判断" && answerDraft.choiceId && <p className="text-[12px] leading-relaxed text-foreground">{answerDraft.answer}</p>}
        </div>
      )}
    </div>
  );
}
