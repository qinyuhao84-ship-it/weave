import { NextRequest } from "next/server";
import { handle, fail } from "@/lib/api";
import { getJob, readDraft } from "@/lib/jobs/runner";
import { cancelFixPlan, cancelReviewPlan } from "@/lib/review/batch-run";

export const runtime = "nodejs";

/**
 * 放弃这个计划：不执行任何破坏性操作，把事项放回「已回答」。
 *
 * 刻意不复用 `DELETE /api/jobs/[id]`：那条对 awaiting_review 明确返回 409，
 * 提示改用「放弃」—— 那个设计是对的，「停」与「放弃」是两件事。
 * 这个端点是「放弃」的那一半。
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return handle(async () => {
    const job = getJob(jobId);
    if (!job || job.status !== "awaiting_review") {
      return fail("这个计划已经处理过了，或者已经取消。", 409);
    }
    const plan = readDraft<{ mode?: string }>(jobId);
    if (plan?.mode === "mechanical") cancelFixPlan(jobId);
    else cancelReviewPlan(jobId);
    return { cancelled: true };
  });
}
