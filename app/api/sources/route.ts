import { desc, eq, sql } from "drizzle-orm";
import { handle, intParam } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { pages, sources } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 分页列出原始资料及其编译状态、关联词条。 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = intParam(url.searchParams.get("limit"), 20, 1, 100);
  const offset = intParam(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const filter = query ? sql`(${sources.originalName} LIKE ${pattern} ESCAPE '\\' OR ${sources.title} LIKE ${pattern} ESCAPE '\\')` : undefined;

  return handle(() => {
    const db = getDb();
    const rows = db.select().from(sources)
      .where(filter).orderBy(desc(sources.importedAt), desc(sources.id))
      .limit(limit).offset(offset).all();
    const total = db.select({ count: sql<number>`count(*)` }).from(sources).where(filter).get()?.count ?? 0;
    const pageRows = db.select({ id: pages.id, title: pages.title, frontmatterJson: pages.frontmatterJson })
      .from(pages).where(eq(pages.status, "active")).all();

    const pageLinks = new Map<string, Array<{ id: string; title: string }>>();
    for (const page of pageRows) {
      try {
        const frontmatter = JSON.parse(page.frontmatterJson) as { sources?: Array<{ doc?: string }> };
        for (const ref of frontmatter.sources ?? []) {
          if (!ref.doc) continue;
          const linked = pageLinks.get(ref.doc) ?? [];
          if (!linked.some((item) => item.id === page.id)) linked.push({ id: page.id, title: page.title });
          pageLinks.set(ref.doc, linked);
        }
      } catch {
        // 坏 frontmatter 不应阻断来源列表；对应词条会在其他位置提示修复。
      }
    }

    return {
      sources: rows.map((source) => ({
        id: source.id,
        originalName: source.originalName,
        title: source.title,
        byteSize: source.byteSize,
        pageCount: source.pageCount,
        status: source.status,
        importedAt: source.importedAt,
        linkedPages: pageLinks.get(source.docPath) ?? [],
      })),
      total,
      limit,
      offset,
    };
  });
}
