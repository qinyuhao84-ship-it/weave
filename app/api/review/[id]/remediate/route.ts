import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { fail, handle, readJsonObject } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { reviewItems } from "@/lib/db/schema";
import { MAX_ANNOTATION_LENGTH, startRemediation } from "@/lib/review/remediate";
import { isLlmConfigured } from "@/lib/settings";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 按批注修订：把用户的批注交给模型，让它改词条。
 *
 * 立即返回 jobId，实际工作跑在后台任务里 —— 一次修订要读词条、调模型、
 * 重建索引、提交，是分钟级的，不能挂在请求生命周期上（HMR 会杀掉它）。
 * 前端沿用任务那套 SSE 看进度，与导入完全同一条路。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { annotation?: unknown };
  try {
    body = (await readJsonObject(request)) as { annotation?: unknown };
  } catch {
    return fail("请求体不是合法的 JSON。", 400);
  }

  const annotation = typeof body.annotation === "string" ? body.annotation.trim() : "";
  if (!annotation) {
    return fail("先写一句批注 —— 模型需要知道你希望它怎么改。", 400);
  }
  if (annotation.length > MAX_ANNOTATION_LENGTH) {
    return fail(`批注太长了（上限 ${MAX_ANNOTATION_LENGTH} 字）。把最要紧的那句说清楚更管用。`, 400);
  }

  if (!isLlmConfigured()) {
    return fail("模型服务暂不可用，修订没有开始。请在设置中检查模型地址、名称及凭据，保存后重试。", 412);
  }

  return handle(() => {
    const item = getDb().select().from(reviewItems).where(eq(reviewItems.id, id)).get();
    if (!item) return fail("找不到这条审阅事项。", 404);
    if (item.status === "accepted" && item.appliedSha) {
      return fail(
        "这条事项已经按批注修订过了。要看修改结果可以打开对应词条，" +
          "要重新处理就先收回裁决（在「已采纳」页签下点收回）。",
        409,
      );
    }

    const { jobId } = startRemediation({ itemId: id, annotation });
    return { jobId };
  });
}
