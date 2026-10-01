import { handle, intParam } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { pages, edges } from "@/lib/db/schema";
import { graphStats } from "@/lib/index/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 关系图谱数据。
 *
 * 节点与边都来自 SQLite（可随时从 markdown 重建），不直接扫描文件 ——
 * 「图谱与计数从索引读，绝不从 md 现算」是保证编辑后 UI 立即正确的关键。
 *
 * 返回的是全量图（数百到数千节点对 Canvas 2D 是零压力），
 * 前端自己做视口裁剪与邻域高亮。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const maxNodes = intParam(url.searchParams.get("maxNodes"), 3000, 10, 20000);

  return handle(() => {
    const db = getDb();
    const activePages = db
      .select()
      .from(pages)
      .all()
      .filter((p) => p.status === "active");

    const truncated = activePages.length > maxNodes;
    const shown = activePages.slice(0, maxNodes);
    const shownIds = new Set(shown.map((p) => p.id));

    const allEdges = db.select().from(edges).all();
    const visibleEdges = allEdges.filter(
      (e) => shownIds.has(e.sourcePageId) && shownIds.has(e.targetPageId),
    );

    // 度数：前端据此决定节点大小与「枢纽」的视觉权重
    const degree = new Map<string, number>();
    for (const edge of visibleEdges) {
      degree.set(edge.sourcePageId, (degree.get(edge.sourcePageId) ?? 0) + 1);
      degree.set(edge.targetPageId, (degree.get(edge.targetPageId) ?? 0) + 1);
    }

    return {
      nodes: shown.map((page) => ({
        id: page.id,
        title: page.title,
        type: page.type,

        degree: degree.get(page.id) ?? 0,
        // 入链为 0 的孤立节点，前端可以淡化显示
        isolated: (degree.get(page.id) ?? 0) === 0,
      })),
      links: visibleEdges.map((edge) => ({
        id: String(edge.id),
        source: edge.sourcePageId,
        target: edge.targetPageId,
        relType: edge.relType,
        weight: edge.weight,
        /** 「为什么连」—— 点边时弹出的解释卡片用 */
        signals: safeParse(edge.signalsJson),
        evidence: edge.evidencePagePath,
      })),
      stats: graphStats(),
      truncated,
      ...(truncated
        ? { note: `词条数超过 ${maxNodes}，图谱只展示了前 ${maxNodes} 个节点。` }
        : {}),
    };
  });
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
