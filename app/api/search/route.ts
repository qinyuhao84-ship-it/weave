import { handle, intParam } from "@/lib/api";
import { searchFullText, extractTerms, matchByTitle } from "@/lib/chat/retrieve";
import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pages } from "@/lib/db/schema";
import { absolutePath } from "@/lib/vault/paths";
import { readFileIfExists } from "@/lib/vault/atomic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 跨全库的全文搜索。
 *
 * 返回带高亮的摘要片段 —— 只给标题列表的话，用户还得逐条点开才知道是不是要的。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const limit = intParam(url.searchParams.get("limit"), 20, 1, 100);

  return handle(() => {
    if (!query) return { query, results: [], terms: [] };

    const scoreById = new Map<string, number>();
    for (const hit of matchByTitle(query, limit)) scoreById.set(hit.pageId, 100 + hit.score);
    for (const hit of searchFullText(query, limit)) {
      scoreById.set(hit.pageId, (scoreById.get(hit.pageId) ?? 0) + hit.score);
    }
    const hits = [...scoreById.entries()]
      .map(([pageId, score]) => ({ pageId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const db = getDb();
    const terms = extractTerms(query).slice(0, 8);
    const rows = hits.length > 0
      ? db.select().from(pages).where(inArray(pages.id, hits.map((hit) => hit.pageId))).all()
      : [];
    const rowById = new Map(rows.map((row) => [row.id, row]));

    const results = hits
      .map((hit) => {
        const row = rowById.get(hit.pageId);
        if (!row || row.status !== "active") return null;

        const raw = readFileIfExists(absolutePath(row.filePath)) ?? "";
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
        const snippet = buildSnippet(body, terms);

        return {
          pageId: row.id,
          title: row.title,
          type: row.type,
          score: Number(hit.score.toFixed(4)),
          /** 带 <mark> 的摘要，前端直接渲染 */
          snippet: snippet.html,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    return { query, results, terms };
  });
}

/** 取第一个命中位置周围的文字，并把命中词包成 <mark> */
function buildSnippet(body: string, terms: string[]): { html: string } {
  const plain = body.replace(/\s+/g, " ").trim();
  if (!plain) return { html: "" };

  let position = -1;
  let matchedTerm = "";
  for (const term of terms) {
    const index = plain.toLowerCase().indexOf(term.toLowerCase());
    if (index >= 0 && (position < 0 || index < position)) {
      position = index;
      matchedTerm = term;
    }
  }

  const start = Math.max(0, position < 0 ? 0 : position - 60);
  const raw = plain.slice(start, start + 220);
  const prefix = start > 0 ? "…" : "";
  const suffix = start + 220 < plain.length ? "…" : "";

  const escaped = escapeHtml(raw);
  const highlighted = matchedTerm
    ? escaped.replace(
        new RegExp(escapeRegExp(escapeHtml(matchedTerm)), "gi"),
        (m) => `<mark>${m}</mark>`,
      )
    : escaped;

  return { html: `${prefix}${highlighted}${suffix}` };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
