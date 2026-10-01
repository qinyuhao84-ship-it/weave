import { fail, ok } from "@/lib/api";
import { ArchiveRestoreError, restoreArchiveBatch } from "@/lib/vault/archive-batches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return ok(restoreArchiveBatch(id));
  } catch (error) {
    if (error instanceof ArchiveRestoreError) return fail(error.message, 409);
    console.error("[vault/trash] 恢复知识库批次失败：", error);
    return fail("恢复批次没有完成，请检查当前知识库是否有同名资料。", 500);
  }
}
