import { fail } from "@/lib/api";
import { getChatRun } from "@/lib/chat/sessions";
import { subscribeChatRun } from "@/lib/chat/streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const stored = getChatRun(id);
  if (!stored) return fail("找不到这轮回答。", 404);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let closeStream: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        try { controller.close(); } catch { /* 客户端已断开 */ }
      };
      closeStream = close;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          close();
        }
      };

      const subscription = subscribeChatRun(id, (event) => {
        send(event);
        if (event.type === "done" || event.type === "error") close();
      });

      if (subscription) {
        unsubscribe = subscription.unsubscribe;
        send({ type: "snapshot", run: subscription.snapshot });
        if (subscription.snapshot.status !== "running") close();
      } else {
        send({ type: "snapshot", run: stored });
        close();
      }
    },
    cancel() {
      unsubscribe?.();
      closeStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
