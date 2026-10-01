import { getDb } from "@/lib/db/client";
import { redirects } from "@/lib/db/schema";
import { normalizeLinkTarget } from "@/lib/vault/wikilinks";
import { buildCatalog } from "./catalog";

/**
 * 双链解析表：归一化名字 → 词条。
 *
 * 为什么要有它：正文里的 [[X]] 只写了名字，而点它需要 id。词条页的链接是从
 * 该页自己的 outgoing 里查的（只覆盖它写过的那些），但对话回答里的 [[X]]
 * 是模型随手写的，可能指向知识库里任何一个词条 —— 必须有一张全库的表。
 *
 * **优先级与索引器完全一致**（lib/index/reindex.ts#buildNameIndex）：
 * title > slug > alias，别名不覆盖已有的键。两边规则一旦分叉，就会出现
 * 「索引认为这条链接是死的，界面却把它渲染成能点的胶囊」这种自相矛盾的状态。
 *
 * 重定向也进表：改名之后 [[旧名]] 仍然能点到新词条 —— 那正是重定向存在的意义。
 */
export function buildWikilinkTable(): Record<string, { pageId: string; title: string }> {
  const table: Record<string, { pageId: string; title: string }> = {};

  const register = (name: string, pageId: string, title: string, overwrite: boolean) => {
    const key = normalizeLinkTarget(name);
    if (!key) return;
    if (table[key] === undefined || overwrite) table[key] = { pageId, title };
  };

  const catalog = buildCatalog({ includeSummaries: false });
  // 三个循环而不是一个：顺序就是优先级，合并成一个循环会让「先注册者胜」
  // 退化成「按目录顺序碰运气」
  for (const entry of catalog) register(entry.title, entry.id, entry.title, true);
  for (const entry of catalog) register(entry.slug, entry.id, entry.title, false);
  for (const entry of catalog) {
    for (const alias of entry.aliases) register(alias, entry.id, entry.title, false);
  }

  // 重定向：旧名指向新词条。表里已有同名活词条时不覆盖 —— 一个名字被重新
  // 启用为别的词条时，活词条优先
  const byId = new Map(catalog.map((entry) => [entry.id, entry.title]));
  for (const row of getDb().select().from(redirects).all()) {
    const title = byId.get(row.newPageId);
    if (!title) continue;
    register(row.oldNormalized, row.newPageId, title, false);
  }

  return table;
}
