import { handle } from "@/lib/api";
import { restorePage } from "@/lib/vault/service";

export const runtime = "nodejs";

/** 从回收站恢复。软删除的全部意义就在于这一步。 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => restorePage(id));
}
