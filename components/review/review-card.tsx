"use client";
import { useI18n } from "@/components/i18n-provider";

import {
  Badge,
  Button,
  Card,
  Textarea
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Clock,
  Copy, FileQuestion,
  Link2,
  Search
} from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { QuestionPicker, type AnswerDraft } from "./question-picker";

import type { ReviewItem, ReviewStatus } from "./types";

const KIND_META: Record<string, { label: string; icon: React.ElementType; tone: "danger" | "warning" | "accent" | "neutral" }> = {
  contradiction: { label: "reviewKinds.contradiction", icon: AlertTriangle, tone: "danger" },
  stale_claim: { label: "reviewKinds.stale_claim", icon: Clock, tone: "warning" },
  duplicate: { label: "reviewKinds.duplicate", icon: Copy, tone: "warning" },
  missing_page: { label: "reviewKinds.missing_page", icon: FileQuestion, tone: "accent" },
  broken_link: { label: "reviewKinds.broken_link", icon: Link2, tone: "warning" },
  orphan: { label: "reviewKinds.orphan", icon: FileQuestion, tone: "neutral" },
  research: { label: "reviewKinds.research", icon: Search, tone: "neutral" },
};

export function ReviewCard({
  item,
  filter,
  llmConfigured,
  queueStatus,
  onSubmit,
}: {
  item: ReviewItem;
  filter: ReviewStatus;
  llmConfigured: boolean;
  queueStatus: "queued" | "running" | "awaiting_review" | null;
  onSubmit: (next: AnswerDraft) => Promise<void>;
}) {
  const { t } = useI18n();
  const [answer, setAnswer] = React.useState<AnswerDraft>({
    answer: item.answer ?? "",
    choiceId: item.answerChoiceId,
  });
  const [busy, setBusy] = React.useState(false);
  const meta = KIND_META[item.kind] ?? KIND_META.research;
  const editable = filter === "pending" || filter === "answered";
  const submit = async () => {
    if (!answer.answer.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(answer);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <meta.icon
          size={15}
          className={cn(
            "mt-0.5 shrink-0",
            item.severity === "critical"
              ? "text-[var(--destructive)]"
              : item.severity === "warning"
                ? "text-[var(--warning)]"
                : item.kind === "missing_page"
                  ? "text-[var(--ring)]"
                  : "text-muted-foreground",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={meta.tone}>{t.has(meta.label) ? t(meta.label) : meta.label}</Badge>
            <span className="text-[13.5px] font-medium text-foreground">{item.title}</span>
          </div>
          {item.detail && (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{item.detail}</p>
          )}
          {item.suggestedAction && (
            <p className="mt-1.5 text-[11.5px] text-[var(--ring)]">{t("review_workspace.m036")}{item.suggestedAction}</p>
          )}
          {item.relatedPages.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {item.relatedPages.map((page) =>
                page.id ? (
                  <Link key={`${page.id}:${page.title}`} href={`/wiki/${page.id}`}>
                    <Badge tone="neutral">{page.title}</Badge>
                  </Link>
                ) : (
                  <Badge key={page.title} tone="neutral">{page.title}</Badge>
                ),
              )}
            </div>
          )}
        </div>
      </div>

      {item.remediation && (
        <div className="mt-3 rounded-[10px] border border-[color-mix(in_srgb,var(--success)_28%,transparent)] bg-[color-mix(in_srgb,var(--success)_5%,transparent)] px-3 py-2.5">
          <p className="text-[12px] font-medium text-foreground">
            {item.remediation.noChangeReason && item.remediation.edits.length === 0 && item.remediation.created.length === 0
              ? t("review_workspace.m037")
              : t("review_workspace.m038")}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {item.remediation.noChangeReason ?? item.remediation.summary}
          </p>
          {item.remediation.edits.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {item.remediation.edits.map((edit) => (
                <li key={edit.pageId} className="text-[11.5px] leading-relaxed text-muted-foreground">
                  《{edit.title}{t("review_workspace.m039")}{edit.added} {t("review_workspace.m040")}{edit.removed} {t("review_workspace.m041")}{edit.reason}
                </li>
              ))}
            </ul>
          )}
          {item.remediation.created.length > 0 && (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
              {t("review_workspace.m042")}{item.remediation.created.map((page) => `《${page.title}》`).join("、")}
              {t("review_workspace.m043")}</p>
          )}
          {item.remediation.rejected.length > 0 && (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--warning)]">
              {t("review_workspace.m044")}{item.remediation.rejected.join("；")}
            </p>
          )}
          {item.appliedSha && (
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
              {t("review_workspace.m045")}<Link href="/wiki" className="text-foreground underline">{t("review_workspace.m046")}</Link>
            </p>
          )}
        </div>
      )}

      {editable && (
        <div className="mt-3 rounded-[14px] bg-background p-3">
          {item.question && item.options.length >= 2 ? (
            <QuestionPicker
              question={item.question}
              options={item.options}
              value={answer}
              disabled={Boolean(item.batchId) || Boolean(queueStatus) || busy}
              onChange={setAnswer}
            />
          ) : (
            <>
              {item.question && (
                <p className="text-[12.5px] font-medium leading-relaxed text-foreground">{item.question}</p>
              )}
              <Textarea
                className={item.question ? "mt-2" : ""}
                rows={3}
                value={answer.answer}
                disabled={Boolean(item.batchId) || Boolean(queueStatus) || busy}
                placeholder={t("review_workspace.m047")}
                onChange={(event) => setAnswer({ answer: event.target.value, choiceId: null })}
              />
            </>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11.5px] text-muted-foreground">
              {queueStatus === "queued"
                ? t("review_workspace.m048")
                : queueStatus === "running"
                  ? t("review_workspace.m049")
                  : queueStatus === "awaiting_review"
                    ? t("review_workspace.m050")
                    : filter === "answered"
                      ? t("review_workspace.m051")
                      : t("review_workspace.m052")}
            </span>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={!answer.answer.trim() || Boolean(item.batchId) || Boolean(queueStatus) || busy || !llmConfigured}
              title={llmConfigured ? undefined : t("review_workspace.m053")}
              onClick={() => void submit()}
            >
              {queueStatus === "queued"
                ? t("review_workspace.m054")
                : queueStatus
                  ? t("review_workspace.m055")
                  : filter === "answered"
                    ? t("review_workspace.m056")
                    : t("review_workspace.m057")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
