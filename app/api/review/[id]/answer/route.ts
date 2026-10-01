import { NextRequest } from "next/server";
import { handle, fail, readJsonObject } from "@/lib/api";
import { answerReviewItem } from "@/lib/lint";

export const runtime = "nodejs";

/**
 * 回答一条事项。
 *
 * 回答与裁决是两件事：裁决（accepted / dismissed）是「这条判断我认了 / 这不是
 * 问题」，一个终态；回答是「我的口径是这个」—— 它还要由模型去处理，处理完才结案。
 * 所以这个接口只写库、不碰 vault，也不改 resolvedAt：回答本身不进下一轮的回灌，
 * 它要等到批量处理完成、以 decision_note 的身份被写回去。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(async () => {
    const body = (await readJsonObject(request)) as {
      answer?: unknown;
      choiceId?: unknown;
    };

    const result = answerReviewItem(id, {
      answer: typeof body.answer === "string" ? body.answer : null,
      choiceId: typeof body.choiceId === "string" ? body.choiceId : null,
    });
    // 三种拒绝各有各的下一步：404 这条没了、409 等它跑完、400 答复是空的。
    // 服务端已经分好了状态码，这里不要压成同一个。
    if (!result.ok) return fail(result.error, result.status);

    return { id, answered: true };
  });
}
