import { handle, fail } from "@/lib/api";
import { getJob, cancel } from "@/lib/jobs/runner";
import { isTerminal } from "@/lib/jobs/types";
import { discardIngest } from "@/lib/ingest/pipeline";
import { removeQueuedIngestForJob } from "@/lib/ingest/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 轮询接口。SSE 断线时前端降级用它，页面刷新后恢复进度也用它。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    const job = getJob(id);
    if (!job) return fail("找不到这个任务。", 404);
    return job;
  });
}

/**
 * 停止一个任务。
 *
 * 为什么不返回 204 就走：返回「停止成功了没有」比返回「请求收到了」重要得多。
 * 三种停不下来的情况各有各的下一步 —— 已经跑完的不用管、停在草稿的该去点「放弃」、
 * 压根不存在的多半是页面状态过期了 —— 一句笼统的「操作成功」会让用户以为
 * 任务真的停了，然后盯着一个还在跑的进度条发愣。
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    const job = getJob(id);
    if (!job) return fail("找不到这个任务 —— 它可能已经被清理了。刷新页面看看当前状态。", 404);

    if (isTerminal(job.status)) {
      return fail("这个任务已经结束了，不需要停止。", 409);
    }

    if (job.status === "awaiting_review") {
      // 草稿已经生成完了，没有「正在跑的工作」可以掐断 —— 但用户点的是停止，
      // 他要的是「这次导入我不要了」。那就把它丢掉（与「放弃这次导入」是同一件事），
      // 而不是回一句「请去点另一个按钮」：那个按钮未必在他眼前的这一屏上。
      // 停止这个动作，在任何一个相下都必须有真实效果。
      discardIngest(job.id);
      removeQueuedIngestForJob(job.id);
      return {
        cancelled: true,
        discarded: true,
        id: job.id,
        note: "这次导入已放弃，原件保留在 raw/，随时可以重新处理。",
      };
    }

    const outcome = cancel(id);
    if (outcome === "not-found") {
      return fail("找不到这个任务 —— 它可能已经被清理了。刷新页面看看当前状态。", 404);
    }
    if (outcome === "not-running") {
      return fail("这个任务刚才已经结束了，不需要停止。", 409);
    }

    return { cancelled: true, id };
  });
}
