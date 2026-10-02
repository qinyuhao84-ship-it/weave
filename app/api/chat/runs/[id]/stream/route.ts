import { fail } from "@/lib/api";
import { getChatRun } from "@/lib/chat/sessions";
import { subscribeChatRun } from "@/lib/chat/streams";

import { sseResponse } from "@/lib/sse";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const stored = getChatRun(id);
  if (!stored) return fail("找不到这轮回答。", 404);

  return sseResponse(request, ({ send, close, onCleanup }) => {
    const subscription = subscribeChatRun(id, event => {
      send(event);
      if (event.type === "done" || event.type === "error") close();
    });
    if (subscription) {
      onCleanup(subscription.unsubscribe);
      send({ type: "snapshot", run: subscription.snapshot });
      if (subscription.snapshot.status !== "running") close();
    } else {
      send({ type: "snapshot", run: stored });
      close();
    }
  });
}
