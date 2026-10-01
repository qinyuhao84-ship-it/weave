import { fail, handle } from "@/lib/api";
import { hasActiveStreams } from "@/lib/chat/streams";
import { hasActiveJobs } from "@/lib/jobs/runner";
import { clearKnowledgeBase } from "@/lib/vault/archive-batches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Archive and clear current knowledge records while leaving chats and preferences intact. */
export async function POST(request: Request) {
  return handle(async () => {
    let confirmation: unknown;
    try {
      const body: unknown = await request.json();
      confirmation = body && typeof body === "object" && "confirmation" in body
        ? body.confirmation
        : undefined;
    } catch {
      return fail("请在确认后再清空知识库。", 400);
    }
    if (confirmation !== "清空") return fail("请输入“清空”并确认后再执行。", 400);
    if (hasActiveStreams() || hasActiveJobs()) {
      return fail("当前有对话或后台任务正在运行，请先停止或等待它们结束。", 409);
    }
    return clearKnowledgeBase();
  });
}
