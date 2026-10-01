import { handle } from "@/lib/api";
import { emptySessionTrash } from "@/lib/chat/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 永久清空会话回收站。 */
export async function DELETE() {
  return handle(() => ({ deleted: emptySessionTrash() }));
}
