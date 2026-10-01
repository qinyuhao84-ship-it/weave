import { handle, intParam } from "@/lib/api";
import { buildCatalog, graphStats, readCatalogSummary } from "@/lib/index/catalog";
import { countPendingReviewItems } from "@/lib/lint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 知识库总览：目录树 + 图谱统计 + 待办数 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type")?.trim() || null;
  const keyword = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
  const limit = intParam(url.searchParams.get("limit"), 50, 1, 2000);
  const offset = intParam(url.searchParams.get("offset"), 0, 0, 1_000_000);

  return handle(() => {
    const catalog = buildCatalog({ includeSummaries: Boolean(keyword) });
    const counts: Record<string, number> = {};
    for (const entry of catalog) counts[entry.type] = (counts[entry.type] ?? 0) + 1;

    const filtered = catalog.filter((entry) => {
      if (type && entry.type !== type) return false;
      if (!keyword) return true;
      return [entry.title, entry.summary, ...entry.aliases, ...entry.tags]
        .some((value) => value.toLocaleLowerCase().includes(keyword));
    });

    return {
      pages: filtered.slice(offset, offset + limit).map((entry) => ({
        id: entry.id,
        title: entry.title,
        type: entry.type,
      // slug 与磁盘相对路径刻意不返回：界面没有任何地方该显示它们 ——
      // 用户要的是「这个词条讲了什么」，不是「它落在磁盘的哪个文件里」。
      // 按不变式 6 的口径，不返回才是消除病因，前端不显示只是消除症状。
        aliases: entry.aliases,
        tags: entry.tags,
        summary: keyword ? entry.summary : readCatalogSummary(entry),
        sourceCount: entry.sourceCount,
        inboundLinks: entry.inboundLinks,
      })),
      total: filtered.length,
      offset,
      limit,
      counts,
      stats: graphStats(),
      pendingReview: countPendingReviewItems(),
    };
  });
}
