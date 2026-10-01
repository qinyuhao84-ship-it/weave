import { eq } from "drizzle-orm";
import { fail, handle } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    const source = getDb().select().from(sources).where(eq(sources.id, id)).get();
    if (!source) return fail("找不到这份原始资料。", 404);
    return {
      id: source.id,
      originalName: source.originalName,
      title: source.title,
      byteSize: source.byteSize,
      pageCount: source.pageCount,
      status: source.status,
      importedAt: source.importedAt,
      parser: source.parser,
      mimeType: source.mimeType,
    };
  });
}
