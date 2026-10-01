import { handle, fail } from "@/lib/api";
import { previewDelete } from "@/lib/vault/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 删除前的预览：先让用户看到「本词条被 N 个词条引用」，而不是闷头删掉。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    try {
      return previewDelete(id);
    } catch {
      return fail("找不到这个词条。", 404);
    }
  });
}
