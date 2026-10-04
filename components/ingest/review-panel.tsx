"use client";
import { useI18n } from "@/components/i18n-provider";

import { Badge, Button, ProgressBar, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { diffLines } from "diff";
import {
  ChevronRight,
  Pencil, Sparkles
} from "lucide-react";
import * as React from "react";
import {
  type Draft,
  type IngestDraft,
  type ReviewDecisionDraft
} from "./ingest-provider";

import { CollapsibleCard, ReviewDecisionCard, Section, SkipButton } from "./draft-review-cards";

/* ------------------------------------------------------------ 审阅面板 */

export function ReviewPanel({
  draft,
  recovered,
  skipped,
  decisions,
  onAnswer,
  onToggleSkip,
  onRemovePage,
  onChange,
  committing,
  commitProgress,
  aiReviewBusy,
  aiReviewProgress,
  onAiReview,
  onStopAiReview,
}: {
  draft: IngestDraft;
  recovered: boolean;
  skipped: Set<string>;
  decisions: Map<number, ReviewDecisionDraft>;
  onAnswer: (index: number, answer: string, choiceId: string | null) => void;
  onToggleSkip: (title: string) => void;
  onRemovePage: (index: number) => void;
  onChange: (next: Draft) => void;
  committing: boolean;
  commitProgress: number;
  aiReviewBusy: boolean;
  aiReviewProgress: number;
  onAiReview: () => void;
  onStopAiReview: () => void;
}) {
  const { t } = useI18n();
  const data = draft;
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const analysis = data.analysis;
  const newPages = data.draft.newPages;
  const updates = data.draft.updatedPages;
  const items = data.draft.reviewItems;
  const createdCount = newPages.filter((p) => !skipped.has(p.title)).length;

  return (
    <div className="p-4 sm:p-5">
      {recovered && (
        <p className="mb-3 rounded-[10px] bg-[var(--muted)] px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          {t("ingest_ingest_drawer.m072")}</p>
      )}

      {/* 概览：一眼看清「这份资料是什么、会动到多少东西」 */}
      <div className="rounded-[16px] border border-border bg-card p-4">
        <h3 className="mb-2 text-[13px] font-semibold">{t("draftReview.overview")}</h3>
        <p className="text-[13px] leading-relaxed text-foreground">{analysis.gist.length > 600 ? analysis.gist.slice(0, 600) + "…" : analysis.gist}</p>
        {analysis.gist.length > 600 && <details className="mt-2 text-[12px] leading-relaxed text-muted-foreground"><summary className="cursor-pointer">{t("aiIngestReview.fullOverview")}</summary><p className="mt-2 whitespace-pre-wrap">{analysis.gist}</p></details>}
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{t("draftReview.guidance")}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="neutral">{createdCount} {t("ingest_ingest_drawer.m073")}</Badge>
          {updates.length > 0 && <Badge tone="neutral">{updates.length} {t("ingest_ingest_drawer.m074")}</Badge>}
          {items.length > 0 && <Badge tone="warning">{items.length} {t("ingest_ingest_drawer.m075")}</Badge>}
          <Badge tone="neutral">{analysis.entities.length} {t("ingest_ingest_drawer.m076")}</Badge>
          <Badge tone="neutral">{analysis.concepts.length} {t("ingest_ingest_drawer.m077")}</Badge>
        </div>

        {analysis.contradictions.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-border pt-3">
            {analysis.contradictions.map((item, index) => (
              <p key={index} className="text-[12px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-[var(--warning)]">{t("ingest_ingest_drawer.m078")}</span>
                「{item.existing}{t("ingest_ingest_drawer.m079")}{item.conflict}{t("ingest_ingest_drawer.m080")}{item.claim}
              </p>
            ))}
          </div>
        )}

        {data.warnings.length > 0 && (
          <div className="mt-3 space-y-1 border-t border-border pt-3">
            {data.warnings.map((warning, index) => (
              <p key={index} className="text-[12px] leading-relaxed text-[var(--warning)]">{warning}</p>
            ))}
          </div>
        )}
      </div>

      {/* 待你判断的事项：需要用户做决定，默认展开 */}
      {items.length > 0 && (
        <Section title={t("ingest_ingest_drawer.m081")} count={items.length} hint={t("ingest_ingest_drawer.m082")} action={
          <Button size="sm" variant="secondary" loading={aiReviewBusy} disabled={committing || items.every((_item, index) => Boolean(decisions.get(index)?.answer.trim() || decisions.get(index)?.decision))} onClick={onAiReview} icon={<Sparkles size={13} />}>
            {t("aiIngestReview.button")}
          </Button>
        }>
          <p className="text-[12px] text-muted-foreground">{t("aiIngestReview.hint")}</p>
          {aiReviewBusy && <div role="status" className="space-y-2">
            <ProgressBar value={aiReviewProgress} max={100} label={t("aiIngestReview.working")} />
            <Button size="sm" variant="ghost" onClick={onStopAiReview}>{t("aiIngestReview.stop")}</Button>
          </div>}
          <fieldset disabled={aiReviewBusy || committing} className="min-w-0 space-y-3 disabled:opacity-70">
          {items.map((item, index) => (
            <ReviewDecisionCard
              key={index}
              item={item}
              decision={decisions.get(index)}
              onAnswer={(text, choiceId) => onAnswer(index, text, choiceId)}
            />
          ))}
          </fieldset>
        </Section>
      )}

      {/* 新建词条：折叠行，需要时展开看正文 */}
      <fieldset disabled={aiReviewBusy || committing} className="min-w-0">
      <Section
        title={t("ingest_ingest_drawer.m083")}
        count={newPages.length}
        action={
          newPages.length > 1 ? (
            <button
              type="button"
              onClick={() =>
                setExpanded((prev) =>
                  prev.size >= newPages.length
                    ? new Set()
                    : new Set(newPages.map((_p, i) => `page:${i}`)),
                )
              }
              className="text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {expanded.size >= newPages.length ? t("ingest_ingest_drawer.m084") : t("ingest_ingest_drawer.m085")}
            </button>
          ) : null
        }
      >
        {newPages.map((page, index) => {
          const key = `page:${index}`;
          return (
            <CollapsibleCard
              key={key}
              title={page.title}
              type={page.type}
              summary={page.summary}
              expanded={expanded.has(key)}
              onToggle={() => toggle(key)}
              skipped={skipped.has(page.title)}
              onSkip={() => onToggleSkip(page.title)}
              onRemove={() => onRemovePage(index)}
              onTitleChange={(title) =>
                onChange({
                  ...data.draft,
                  newPages: newPages.map((p, i) => (i === index ? { ...p, title } : p)),
                })
              }
              onEdit={(content) =>
                onChange({
                  ...data.draft,
                  newPages: newPages.map((p, i) => (i === index ? { ...p, content } : p)),
                })
              }
              page={page}
            />
          );
        })}
        {newPages.length === 0 && (
          <p className="text-[12.5px] text-muted-foreground">{t("ingest_ingest_drawer.m086")}</p>
        )}
      </Section>

      {/* 更新已有词条 */}
      {updates.length > 0 && (
        <Section title={t("ingest_ingest_drawer.m087")} count={updates.length} hint={t("ingest_ingest_drawer.m088")}>
          {updates.map((update, index) => {
            const key = `update:${index}`;
            const isOpen = expanded.has(key);
            const disabled = skipped.has(update.title);
            const hasFullBody = update.originalContent !== undefined && update.expectedHash !== undefined && update.proposedContent !== undefined;
            const originalContent = update.originalContent ?? "";
            const proposedContent = update.proposedContent ?? "";
            return (
              <div key={key} className={cn("rounded-[14px] border border-border bg-card", disabled && "opacity-50")}>
                <div className="flex items-center gap-2 px-3.5 py-3">
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <ChevronRight
                      size={13}
                      className={cn("shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
                    />
                    <Pencil size={12} className="shrink-0 text-muted-foreground" />
                    <span className="truncate text-[13.5px] font-medium text-foreground">{update.title}</span>
                    <span className="truncate text-[12px] text-muted-foreground">{update.reason}</span>
                  </button>
                  <SkipButton disabled={disabled} onClick={() => onToggleSkip(update.title)} />
                </div>

                {isOpen && (
                  <div className="border-t border-border px-3.5 py-3">
                    {hasFullBody ? (
                      <details open className="mb-3 rounded-[10px] border border-border bg-background">
                        <summary className="cursor-pointer px-3 py-2 text-[11.5px] font-medium text-foreground">
                          {t("ingest_ingest_drawer.m089")}</summary>
                        <div className="max-h-72 overflow-y-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed">
                          {diffLines(originalContent, proposedContent).map((part, partIndex) => (
                            <pre
                              key={partIndex}
                              className={cn(
                                "whitespace-pre-wrap break-words",
                                part.added && "bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-foreground",
                                part.removed && "bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)] text-muted-foreground line-through",
                              )}
                            >
                              {part.value}
                            </pre>
                          ))}
                        </div>
                      </details>
                    ) : (
                      <p className="mb-2 text-[11.5px] leading-relaxed text-muted-foreground">
                        {t("ingest_ingest_drawer.m090")}</p>
                    )}
                    <Textarea
                      value={hasFullBody ? update.proposedContent! : update.appendContent}
                      rows={hasFullBody ? 12 : 5}
                      aria-label={hasFullBody ? t("ingest_ingest_drawer.m091", {v0: update.title}) : t("ingest_ingest_drawer.m092", {v0: update.title})}
                      onChange={(e) =>
                        onChange({
                          ...data.draft,
                          updatedPages: updates.map((u, i) =>
                            i === index
                              ? hasFullBody
                                ? { ...u, proposedContent: e.target.value }
                                : { ...u, appendContent: e.target.value }
                              : u,
                          ),
                        })
                      }
                    />
                    {update.citations.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        <p className="text-[11.5px] font-medium text-foreground">{t("ingest_ingest_drawer.m093")}</p>
                        {update.citations.map((citation, citationIndex) => (
                          <p key={citationIndex} className="text-[11.5px] leading-relaxed text-muted-foreground">
                            {citation.page ? t("ingest_ingest_drawer.m094", {v0: citation.page}) : ""}“{citation.quote}”
                          </p>
                        ))}
                      </div>
                    )}
                    {(update.addAliases.length > 0 || update.addTags.length > 0) && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {update.addAliases.map((alias) => (
                          <Badge key={alias} tone="neutral">{t("ingest_ingest_drawer.m095")}{alias}</Badge>
                        ))}
                        {update.addTags.map((tag) => (
                          <Badge key={tag} tone="neutral">{t("ingest_ingest_drawer.m096")}{tag}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {/* 来源摘要页 */}
      <Section title={t("ingest_ingest_drawer.m097")} count={1} hint={t("ingest_ingest_drawer.m098")}>
        <CollapsibleCard
          title={data.draft.sourceSummary.title}
          type="source"
          summary={firstLine(data.draft.sourceSummary.content)}
          expanded={expanded.has("summary")}
          onToggle={() => toggle("summary")}
          skipped={skipped.has(data.draft.sourceSummary.title)}
          onSkip={() => onToggleSkip(data.draft.sourceSummary.title)}
          onTitleChange={(title) =>
            onChange({
              ...data.draft,
              sourceSummary: { ...data.draft.sourceSummary, title },
            })
          }
          onEdit={(content) =>
            onChange({
              ...data.draft,
              sourceSummary: { ...data.draft.sourceSummary, content },
            })
          }
          page={{
            type: "source",
            title: data.draft.sourceSummary.title,
            summary: "",
            content: data.draft.sourceSummary.content,
            aliases: [],
            tags: [],
            confidence: "high",
            citations: [],
          }}
        />
      </Section>

      </fieldset>
      {committing && (
        <div className="mt-5">
          <ProgressBar value={commitProgress} max={100} label={t("ingest_ingest_drawer.m099")} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ 卡片与零件 */

/** 折叠卡片：一行标题 + 一句话，展开后才渲染正文 */
function firstLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 60) : "";
}
