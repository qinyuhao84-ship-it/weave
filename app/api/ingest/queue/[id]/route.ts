import { fail, handle } from "@/lib/api";
import { deleteQueuedIngest } from "@/lib/ingest/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    const result = deleteQueuedIngest(id);
    if (result === "missing") return fail("这份资料已不在队列中。", 404);
    if (result === "active") return fail("资料正在处理或等待审阅，暂时不能移除。", 409);
    return { removed: true };
  });
}
