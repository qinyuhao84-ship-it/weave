import { handle, fail } from "@/lib/api";
import { discardIngest, loadIngestDraft, type IngestDraft } from "@/lib/ingest/pipeline";
import { removeQueuedIngestForJob } from "@/lib/ingest/queue";

export const runtime = "nodejs";

/** 放弃草稿。原件保留在 raw/ —— 用户可能只是想稍后再处理。 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    if (!loadIngestDraft<IngestDraft>(id)) return fail("找不到这次导入的草稿。", 404);
    discardIngest(id);
    removeQueuedIngestForJob(id);
    return { discarded: true, note: "原件已保留在 raw/ 目录，随时可以重新处理。" };
  });
}
