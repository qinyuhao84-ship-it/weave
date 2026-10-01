import { onExternalChange, startWatcher } from "@/lib/index/watcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Push external Markdown edits to the app after the watcher has reindexed them. */
export async function GET() {
  await startWatcher();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // Client closed the stream.
        }
      };

      send({ type: "ready" });
      unsubscribe = onExternalChange(({ changes, report }) => {
        send({ type: "change", changes, report });
      });
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 20_000);
    },
    cancel() {
      cleanup();
    },
  });

  function cleanup() {
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
