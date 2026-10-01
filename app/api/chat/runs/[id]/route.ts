import { handle, fail } from "@/lib/api";
import { getChatRun } from "@/lib/chat/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    const run = getChatRun(id);
    return run ?? fail("找不到这轮回答。", 404);
  });
}
