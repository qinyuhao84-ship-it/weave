import { handle } from "@/lib/api";
import { listJobs } from "@/lib/jobs/runner";
import type { JobKind } from "@/lib/jobs/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 任务列表。
 *
 * `?active=1` 是**后台处理的恢复入口**：用户把导入抽屉关掉、甚至刷新了页面之后，
 * 界面靠它把「还在跑的任务」重新认回来 —— 没有这个接口，关掉抽屉就等于丢了进度，
 * 用户只能干等着那个界面。刷新后能恢复，靠的就是任务状态本来就落在 SQLite 里。
 *
 * 返回时剥掉 draft 与 result：草稿可能有几十 KB（整份词条正文），
 * 而列表只需要「哪个任务、什么状态、到哪一步了」。要看草稿请走 /api/jobs/[id]。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const activeOnly = url.searchParams.get("active") === "1";
  const kind = url.searchParams.get("kind");

  return handle(() => {
    const jobs = listJobs(50, {
      activeOnly,
      ...(kind ? { kind: kind as JobKind } : {}),
    })
      .map(({ draft: _draft, result: _result, ...rest }) => rest);
    return { jobs };
  });
}
