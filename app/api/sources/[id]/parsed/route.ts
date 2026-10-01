import fs from "node:fs";
import { fail } from "@/lib/api";
import { getSource, resolveSourceFile } from "@/lib/ingest/source-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const source = getSource(id);
  if (!source) return fail("找不到这份原始资料。", 404);
  const filePath = resolveSourceFile(source, "parsed");
  if (!filePath) return fail("这份资料还没有可查看的解析稿。", 404);

  return new Response(new Uint8Array(fs.readFileSync(filePath)), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": "inline; filename*=UTF-8''parsed.md",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
