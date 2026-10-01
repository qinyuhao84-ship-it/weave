import { z } from "zod";
import { handle, fail, readJsonObject } from "@/lib/api";
import { listArchiveBatches, listDeletedPages, purgeTrash } from "@/lib/vault/archive-batches";
import { hasActiveStreams } from "@/lib/chat/streams";
import { listJobs } from "@/lib/jobs/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(() => ({
    batches: listArchiveBatches(),
    pages: listDeletedPages(),
  }));
}

const DeleteInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.enum(["page", "batch"]), id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }).strict(),
]);
export async function DELETE(request: Request) {
  return handle(async () => {
    const input = DeleteInput.parse(await readJsonObject(request));
    if (hasActiveStreams() || listJobs(1000, { activeOnly: true }).some(job => ["queued", "running", "committing", "discarding"].includes(job.status))) return fail("后台任务正在处理资料，请等任务结束后再清理回收站。", 409);
    return purgeTrash(input);
  });
}
