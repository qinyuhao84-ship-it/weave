import { handle, fail, readJsonObject } from "@/lib/api";
import { startReviewBatch } from "@/lib/review/batch-run";
import { isLlmConfigured } from "@/lib/settings";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 一次最多处理多少条回答。
 *
 * 上限的意义不是省钱，是控制**爆炸半径**：这一批的回答会被一次性拿去改知识库，
 * 模型一次看的东西越多、越容易顾此失彼；而且真要回滚，版本页里是逐条记录。
 */
const MAX_ITEMS = 20;

/** 起一个批量任务，把一批已回答的事项交给模型处理 */
export async function POST(request: Request) {
  return handle(async () => {
    const body = (await readJsonObject(request)) as {
      mode?: unknown;
      itemIds?: unknown;
    };

    // 机械发现的修复计划：没有用户回答，材料只有引用上下文。
    // 与 answers 共用同一个 job kind —— 两者生命周期完全同构
    //（跑 → 可能挂起 → 确认 → 落盘），拆成两套会产生两套 confirm/cancel。
    if (body.mode === "mechanical") {
      if (!isLlmConfigured()) {
        return fail("模型服务暂不可用，修复计划没有开始。请在设置中检查模型地址、名称及凭据，保存后重试。", 412);
      }
      return startReviewBatch({ mode: "mechanical" });
    }

    if (body.mode !== "answers") {
      return fail("mode 只能是 answers 或 mechanical。", 400);
    }

    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (itemIds.length === 0) return fail("没有选中任何回答。", 400);
    if (itemIds.length > MAX_ITEMS) {
      return fail(`一次最多处理 ${MAX_ITEMS} 条回答，现在选了 ${itemIds.length} 条。`, 400);
    }
    // 与 /api/lint 同一道门禁：没有模型时这条路走不通，如实告知而不是让它跑空
    if (!isLlmConfigured()) {
      return fail("模型服务暂不可用，这些回答没有开始处理。请在设置中检查模型地址、名称及凭据，保存后重试。", 412);
    }

    return startReviewBatch({ mode: "answers", itemIds });
  });
}
