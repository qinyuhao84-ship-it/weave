import { NextRequest } from "next/server";
import { handle, fail, readJsonObject } from "@/lib/api";
import { startLintJob, listReviewItems, runMechanicalChecks, syncMechanicalFindingsToQueue, sampleForReview } from "@/lib/lint";
import { isLlmConfigured } from "@/lib/settings";
import { listJobs } from "@/lib/jobs/runner";
import { desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { buildCatalog } from "@/lib/index/catalog";
import { sources } from "@/lib/db/schema";

export const runtime = "nodejs";
/** 启动任务本身是毫秒级的，真正的体检跑在后台任务里（见 lib/lint/index.ts#startLintJob） */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** 快速预览：只跑程序检查，不调模型。用于进页面时立刻出结果。 */
export async function GET(request: Request) {
  return handle(() => {
    const mechanical = runMechanicalChecks();
    // 体检页请求时，把程序检查结果放进统一队列；设置页只读取状态，不产生写入。
    if (new URL(request.url).searchParams.get("queueMechanical") === "1") {
      syncMechanicalFindingsToQueue(mechanical);
    }
    const lastCompletedLint = listJobs(100)
      .find((job) => job.kind === "lint" && job.status === "done" && job.finishedAt);
    const latestSource = getDb().select({ importedAt: sources.importedAt }).from(sources)
      .orderBy(desc(sources.importedAt)).limit(1).get();
    return {
      coverage: sampleForReview(buildCatalog({ includeSummaries: false }), 0).coverage,
      mechanical,
      pending: listReviewItems("pending"),
      llmConfigured: isLlmConfigured(),
      lastCompletedAt: lastCompletedLint?.finishedAt ?? null,
      latestSourceImportedAt: latestSource?.importedAt ?? null,
      newSourcesSinceLastLint: Boolean(
        latestSource?.importedAt &&
        (!lastCompletedLint?.finishedAt || latestSource.importedAt > lastCompletedLint.finishedAt),
      ),
    };
  });
}

/**
 * 启动一次体检。
 *
 * 立即返回 jobId，进度与日志走 /api/jobs/[id]/stream。
 *
 * 这里曾经直接 await runLint() 返回整份报告 —— 那意味着用户必须守在页面上
 * 等两三分钟，关掉页面就什么都没有，刷新一次进度归零，而且没有任何办法中止。
 * 体检是三个核心操作里唯一一个**跑得久又不需要人在场**的：它不需要用户做任何
 * 决定（发现的问题进审阅队列，那是另一件事）。所以它天然就该是个后台任务。
 *
 * `mechanicalOnly` 仍然可以传（模型没配时前端会自动传）：只跑程序检查的那一次
 * 也是任务，只是几毫秒就结束了 —— 统一走一条路，比为了快几毫秒维护两条路径划算。
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const body = (await readJsonObject(request)) as { mechanicalOnly?: boolean };
    if (body.mechanicalOnly !== undefined && typeof body.mechanicalOnly !== "boolean") return fail("mechanicalOnly 必须是布尔值。", 400);
    const { jobId } = startLintJob({
      mechanicalOnly: body.mechanicalOnly ?? !isLlmConfigured(),
    });
    return { jobId };
  });
}
