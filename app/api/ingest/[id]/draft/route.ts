import { handle, fail } from "@/lib/api";
import { SaveReviewSchema, saveIngestReview, ReviewSaveConflict } from "@/lib/ingest/review-draft";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const parsed = SaveReviewSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail("草稿或审阅选择格式不正确，请检查输入后重试。", 400);
    try { return { revision: saveIngestReview((await params).id, parsed.data) }; }
    catch (error) { if (error instanceof ReviewSaveConflict) return fail(error.message, 409); throw error; }
  });
}
