import { NextRequest } from "next/server";
import { handle, fail, readJsonObject } from "@/lib/api";
import { getJob, readDraft } from "@/lib/jobs/runner";
import { applyFixPlan, applyReviewPlan } from "@/lib/review/batch-run";

export const runtime = "nodejs";
/** 破坏性操作是同步落盘的（没有模型调用），但一次可能合并好几个词条 */
export const maxDuration = 120;

/**
 * 确认并执行计划里勾中的破坏性操作。
 *
 * 幂等保护放在这里而不是 applyReviewPlan 里：任务状态是这条路的唯一真相，
 * 散在两处判断早晚会出现两边不一致。重复提交一律 409，绝不二次落盘。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return handle(async () => {
    const job = getJob(jobId);
    if (!job || job.status !== "awaiting_review") {
      return fail("这个计划已经处理过了，或者已经取消。", 409);
    }

    const body = (await readJsonObject(request)) as {
      approve?: unknown;
      edits?: unknown;
    };

    const approve = Array.isArray(body.approve)
      ? body.approve.filter((id): id is string => typeof id === "string")
      : [];
    const edits: Record<string, string> = {};
    if (body.edits && typeof body.edits === "object") {
      for (const [key, value] of Object.entries(body.edits as Record<string, unknown>)) {
        if (typeof value === "string") edits[key] = value;
      }
    }

    // 两种计划的确认走同一个入口，按 mode 分派 —— 用户看到的都是
    //「勾选要执行的那些项」，不需要知道它们背后是两条不同的应用路径
    const plan = readDraft<{ mode?: string }>(jobId);
    return plan?.mode === "mechanical"
      ? applyFixPlan(jobId, approve, edits)
      : applyReviewPlan(jobId, { approve, edits });
  });
}
