import { getJob, subscribe } from "@/lib/jobs/runner";
import { isTerminal } from "@/lib/jobs/types";
import { sseResponse } from "@/lib/sse";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 补发数据库状态与实时事件；客户端断开只关闭订阅，不停止后台任务。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getJob(id)) return Response.json({ ok: false, error: "找不到这个任务。" }, { status: 404 });
  return sseResponse(request, ({ send, close, onCleanup }) => {
    onCleanup(subscribe(id, event => {
      send(event);
      if (event.type === "status" && (isTerminal(event.status) || event.status === "awaiting_review")) {
        if (isTerminal(event.status)) send({ type: "done" });
        close();
      }
    }));
    const current = getJob(id);
    if (current) {
      send({ type: "stage", stage: current.stage, label: current.stageLabel, message: current.message });
      send({ type: "progress", progress: current.progress, total: 100 });
      if (current.error) send({ type: "error", message: current.error });
      send({ type: "status", status: current.status, stage: current.stage });
      if (isTerminal(current.status) || current.status === "awaiting_review") {
        if (isTerminal(current.status)) send({ type: "done" });
        close();
      }
    }
  });
}
