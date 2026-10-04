import { z } from "zod";
import { handle, fail } from "@/lib/api";
import { startAiIngestReview } from "@/lib/ingest/ai-review";
import { ReviewSaveConflict } from "@/lib/ingest/review-draft";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const input = z.object({ revision: z.number().int().nonnegative() }).safeParse(await request.json());
    if (!input.success) return fail("草稿版本格式不正确。", 400);
    try { return startAiIngestReview((await params).id, input.data.revision); }
    catch (error) { if (error instanceof ReviewSaveConflict) return fail(error.message, 409); throw error; }
  });
}
