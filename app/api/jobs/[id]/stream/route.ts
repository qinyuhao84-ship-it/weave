import { getJob, subscribe } from "@/lib/jobs/runner";
import { isTerminal } from "@/lib/jobs/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 补发数据库状态与实时事件；客户端断开只关闭订阅，不停止后台任务。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getJob(id)) return Response.json({ ok: false, error: "找不到这个任务。" }, { status: 404 });
  const encoder = new TextEncoder();
  let closeStream = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const cleanup = () => {
        if (closed) return;
        closed = true; clearInterval(heartbeat); unsubscribe();
        request.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* 客户端已关闭。 */ }
      };
      closeStream = cleanup;
      const send = (payload: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); }
        catch { cleanup(); }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { cleanup(); }
      }, 15_000);
      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) { cleanup(); return; }
      // 历史事件会同步补发，因此清理函数与计时器必须先初始化。
      unsubscribe = subscribe(id, event => {
        send(event);
        if (event.type === "status" && (isTerminal(event.status) || event.status === "awaiting_review")) {
          if (isTerminal(event.status)) send({ type: "done" });
          cleanup();
        }
      });
      if (closed) { unsubscribe(); return; }
      const current = getJob(id);
      if (current) {
        send({ type: "stage", stage: current.stage, label: current.stageLabel, message: current.message });
        send({ type: "progress", progress: current.progress, total: 100 });
        if (current.error) send({ type: "error", message: current.error });
        send({ type: "status", status: current.status, stage: current.stage });
        if (isTerminal(current.status) || current.status === "awaiting_review") {
          if (isTerminal(current.status)) send({ type: "done" });
          cleanup();
        }
      }
    },
    cancel() { closeStream(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  } });
}
