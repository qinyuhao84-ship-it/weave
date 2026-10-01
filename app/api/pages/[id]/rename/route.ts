import { NextRequest } from "next/server";
import { handle, fail, readJsonObject } from "@/lib/api";
import { renamePage } from "@/lib/vault/service";

export const runtime = "nodejs";

/** 改名。服务层会重写全库引用 + 写别名 + 写重定向，三件事在同一个事务里完成。 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(async () => {
    const body = (await readJsonObject(request)) as { title?: string };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return fail("新标题不能为空。", 400);
    if (title.length > 120) return fail("标题太长了（上限 120 字）。", 400);
    return renamePage(id, title);
  });
}
