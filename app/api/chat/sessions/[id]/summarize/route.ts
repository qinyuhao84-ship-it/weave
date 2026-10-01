import { fail, handle } from "@/lib/api";
import {
  beginSessionTitleSummary,
  getSession,
  getMessages,
} from "@/lib/chat/sessions";
import { summarizePendingSessionTitle } from "@/lib/chat/session-title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(async () => {
    const session = getSession(id);
    if (!session) return fail("找不到这个对话。", 404);
    if (session.generating) return fail("请等当前回答完成后再总结名称。", 409);
    if (getMessages(id).length === 0) return fail("这段对话还没有内容，暂时无法总结名称。", 400);
    if (!beginSessionTitleSummary(id)) return fail("这段对话正在总结名称，请稍后再试。", 409);

    const title = await summarizePendingSessionTitle(id);
    return { title: title ?? getSession(id)?.title ?? "未命名对话" };
  });
}
