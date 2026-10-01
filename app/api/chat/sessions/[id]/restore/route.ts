import { handle, fail } from "@/lib/api";
import { restoreSession } from "@/lib/chat/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    if (!restoreSession(id)) return fail("回收站里找不到这段对话。", 404);
    return { restored: true };
  });
}
