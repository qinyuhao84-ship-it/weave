import { NextRequest } from "next/server";
import { handle, fail, readJsonObject } from "@/lib/api";
import { decideReviewItem } from "@/lib/lint";

export const runtime = "nodejs";

/** 说明会原样进下一轮 prompt，必须设上限 —— 见 lib/llm/prompts.ts#formatDecisions */
const MAX_NOTE_LENGTH = 500;

/**
 * 裁决一条待审事项。LLM 只提议，执行权始终在人手里。
 *
 * 三个取值：accepted（采纳）/ dismissed（忽略）/ pending（收回裁决，回到待裁决）。
 *
 * 注意裁决**本身不改动知识库**：它记录的是人的判断，作用是让下一轮模型知道
 * 「这件事已经定了」——既不再重复报，也按这个口径理解。要改词条仍然得去改词条。
 * 模型提议永不直接执行这条不变式，不因为多了这个接口而松动。
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(async () => {
    const body = (await readJsonObject(request)) as {
      decision?: unknown;
      note?: unknown;
    };

    // pending = 收回裁决，让这条事项回到待裁决列表（按钮上叫「改判」）
    const allowed = ["accepted", "dismissed", "pending"] as const;
    if (!allowed.includes(body.decision as (typeof allowed)[number])) {
      return fail("裁决只能是 accepted（采纳）、dismissed（忽略）或 pending（收回）。", 400);
    }
    const decision = body.decision as (typeof allowed)[number];

    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > MAX_NOTE_LENGTH) {
      return fail(`说明最多 ${MAX_NOTE_LENGTH} 字，现在有 ${note.length} 字。`, 400);
    }

    if (!decideReviewItem(id, decision, note || undefined)) {
      return fail("找不到这条待办事项 —— 可能已经被清理过了。", 404);
    }
    return { id, decision, note: note || null };
  });
}
