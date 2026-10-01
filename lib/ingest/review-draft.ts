import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { DraftSchema } from "@/lib/llm/prompts";
import { localISOString } from "@/lib/utils";
import type { IngestDraft } from "./pipeline";

export const ReviewStateSchema = z.object({
  skippedTitles: z.array(z.string().max(120)).max(1000),
  decisions: z.array(z.tuple([z.number().int().nonnegative(), z.object({
    decision: z.enum(["accepted", "dismissed"]).optional(),
    note: z.string().max(500), answer: z.string().max(500), choiceId: z.string().nullable(),
  })])).max(1000),
});

export const SaveReviewSchema = z.object({ draft: DraftSchema, reviewState: ReviewStateSchema, revision: z.number().int().nonnegative() });

export class ReviewSaveConflict extends Error {}

export function saveIngestReview(jobId: string, input: z.infer<typeof SaveReviewSchema>): number {
  const db = getDb();
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (job?.kind !== "ingest" || job.status !== "awaiting_review" || !job.draftJson) throw new ReviewSaveConflict("这份草稿已经提交或放弃，请刷新查看当前状态。");
  const staged = JSON.parse(job.draftJson) as IngestDraft;
  if ((staged.reviewRevision ?? 0) !== input.revision) throw new ReviewSaveConflict("草稿已在另一页面保存。当前修改保留在此浏览器，请先复制需要保留的内容，再载入已保存版本。");
  const updates = new Map(staged.draft.updatedPages.map((page) => [page.title, page]));
  const next: IngestDraft = {
    ...staged,
    draft: { ...input.draft, updatedPages: input.draft.updatedPages.map((page) => ({ ...page, expectedHash: updates.get(page.title)?.expectedHash, originalContent: updates.get(page.title)?.originalContent })) },
    reviewState: input.reviewState,
    reviewRevision: input.revision + 1,
  };
  const result = db.update(jobs).set({ draftJson: JSON.stringify(next), updatedAt: localISOString() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "awaiting_review"), eq(jobs.draftJson, job.draftJson))).run();
  if (result.changes !== 1) throw new ReviewSaveConflict("草稿状态已变化，请刷新后再保存。");
  return next.reviewRevision!;
}
