import type { CatalogEntry } from "@/lib/index/catalog";
import { absolutePath } from "@/lib/vault/paths";
import { readFileIfExists } from "@/lib/vault/atomic";
import { excerptForQuery, extractTerms } from "@/lib/chat/retrieve";

/** 全目录用于识别实体；相关正文用于比较新旧事实，二者不能互相替代。 */
export function knowledgeContextForDocument(catalog: CatalogEntry[], document: string): string {
  const lower = document.toLocaleLowerCase();
  const queryTerms = extractTerms(document);
  const directory = catalog.map(entry => `- [[${entry.title}]] (${entry.type})${entry.aliases.length ? ` 别名：${entry.aliases.join("、")}` : ""}`).join("\n");
  const related = catalog.map(entry => ({ entry, score: [entry.title, ...entry.aliases].reduce((sum, name) => sum + (name.trim().length > 1 && lower.includes(name.toLocaleLowerCase()) ? name.length : 0), 0) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.entry.inboundLinks - a.entry.inboundLinks).slice(0, 8);
  const bodies = related.flatMap(({ entry }) => {
    const raw = readFileIfExists(absolutePath(entry.filePath));
    if (!raw) return [];
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    // 文档关键词只抽取一次；仍按事实定位片段，不能只截取名称附近的正文。
    return [`## [[${entry.title}]]\n${excerptForQuery(body, document, 3000, queryTerms)}`];
  });
  return `${directory || "（知识库为空）"}\n\n相关词条正文（片段之外的内容未在本轮比较）：\n${bodies.join("\n\n") || "（未发现名称匹配的现有词条）"}`;
}
