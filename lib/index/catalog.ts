import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pages, links, edges } from "@/lib/db/schema";
import { absolutePath } from "@/lib/vault/paths";
import { readFileIfExists } from "@/lib/vault/atomic";
import { textSimilarity, truncate } from "@/lib/utils";

/**
 * 知识库的「目录视图」。
 *
 * 这是 LLM Wiki 理念的核心机制之一：原文明确要求「LLM 回答前提问前先读 index.md，
 * 找到相关词条再深入」。对本项目，这个目录有两个用途：
 *   1. 导入分析时告诉模型「知识库里已经有什么」—— 它才能判断新资料里的
 *      「张一鸣」是已有实体还是别名，从而决定更新还是新建。
 *      这一步做不好，知识库会迅速碎成一堆重复词条。
 *   2. 问答时作为检索的第一跳。
 */

export type CatalogEntry = {
  id: string;
  title: string;
  type: string;
  slug: string;
  aliases: string[];
  tags: string[];
  summary: string;
  filePath: string;
  sourceCount: number;
  /** 入链数，用于判断哪些是枢纽词条 */
  inboundLinks: number;
};

/** 列表分页后只读取当前页的摘要，避免无搜索时扫描全库 Markdown。 */
export function readCatalogSummary(entry: Pick<CatalogEntry, "filePath">): string {
  const raw = readFileIfExists(absolutePath(entry.filePath));
  return summarize(raw ? extractBody(raw) : "");
}

/** 读取全部活跃词条，组装成目录 */
export function buildCatalog(options: { includeSummaries?: boolean } = {}): CatalogEntry[] {
  const db = getDb();
  const rows = db.select().from(pages).where(eq(pages.status, "active")).all();
  const inbound = new Map<string, number>();
  for (const link of db.select({ dstPageId: links.dstPageId, occurrences: links.occurrences }).from(links).all()) {
    if (!link.dstPageId) continue;
    inbound.set(link.dstPageId, (inbound.get(link.dstPageId) ?? 0) + link.occurrences);
  }

  return rows
    .map((row) => {
      const frontmatter = safeParse(row.frontmatterJson) ?? {};
      return {
        id: row.id,
        title: row.title,
        type: row.type,
        slug: row.slug,
        aliases: Array.isArray(frontmatter.aliases) ? (frontmatter.aliases as string[]) : [],
        tags: Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : [],
        summary: options.includeSummaries === false ? "" : readCatalogSummary(row),
        filePath: row.filePath,
        sourceCount: Array.isArray(frontmatter.sources) ? frontmatter.sources.length : 0,
        inboundLinks: inbound.get(row.id) ?? 0,
      };
    })
    .sort((a, b) => b.inboundLinks - a.inboundLinks || a.title.localeCompare(b.title, "zh-CN"));
}

/**
 * 把目录渲染成给模型看的紧凑文本。
 *
 * 刻意保持紧凑：目录会被塞进每一次导入分析与每一次问答的上下文里，
 * 它本身的开销必须小。所以只给标题、类型、别名和一句话摘要 ——
 * 模型据此足以判断「这个名字我见过没有」，需要细节时再去读词条全文。
 */
export function renderCatalogForPrompt(
  entries: CatalogEntry[],
  options: { maxEntries?: number } = {},
): string {
  const max = options.maxEntries ?? 400;
  const shown = entries.slice(0, max);

  const lines = shown.map((entry) => {
    const parts = [`- [[${entry.title}]]`, `(${entry.type})`];
    if (entry.aliases.length > 0) parts.push(`别名：${entry.aliases.join("、")}`);
    if (entry.summary) parts.push(`— ${entry.summary}`);
    return parts.join(" ");
  });

  if (entries.length > shown.length) {
    lines.push(`\n（还有 ${entries.length - shown.length} 个词条未列出）`);
  }

  return lines.join("\n");
}

/** 按标题/别名归一化查重，用于判断某个名字是否已存在 */
export function findExisting(
  entries: CatalogEntry[],
  name: string,
): CatalogEntry | null {
  const normalize = (text: string) => text.replace(/\s+/g, "").trim().toLowerCase();
  const target = normalize(name);
  if (!target) return null;

  for (const entry of entries) {
    if (normalize(entry.title) === target) return entry;
    if (normalize(entry.slug) === target) return entry;
    if (entry.aliases.some((alias) => normalize(alias) === target)) return entry;
  }
  return null;
}

/** 检测近似重复（用于导入前的相似度提示） */
export function findSimilarTitles(
  entries: CatalogEntry[],
  candidate: string,
  threshold = 0.5,
): Array<{ entry: CatalogEntry; score: number }> {
  return entries
    .map((entry) => ({ entry, score: textSimilarity(entry.title, candidate) }))
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/** 图谱统计，供仪表盘与 Lint 使用 */
export function graphStats(): {
  pages: number;
  links: number;
  edges: number;
  orphans: number;
  dangling: number;
} {
  const db = getDb();
  const allPages = db.select().from(pages).where(eq(pages.status, "active")).all();
  const allLinks = db.select().from(links).all();
  const ids = new Set(allPages.map(page => page.id));
  const allEdges = db.select().from(edges).all().filter(edge => ids.has(edge.sourcePageId) && ids.has(edge.targetPageId));
  const connected = new Set(allEdges.flatMap(edge => [edge.sourcePageId, edge.targetPageId]));

  return {
    pages: allPages.length,
    links: allLinks.length,
    edges: allEdges.length,
    // 孤立指没有任何有效入链或出链，与图谱节点的连通定义一致。
    orphans: allPages.filter((p) => !connected.has(p.id)).length,
    dangling: allLinks.filter((l) => !l.dstPageId).length,
  };
}

function extractBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

function summarize(content: string): string {
  for (const line of content.split("\n")) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#") || clean.startsWith(">") || clean.startsWith("[[")) continue;
    return truncate(
      clean.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias ?? target),
      60,
    );
  }
  return "";
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
