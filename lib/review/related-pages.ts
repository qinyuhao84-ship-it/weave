import { getDb } from "@/lib/db/client";
import { pages, type ReviewRelatedPage } from "@/lib/db/schema";

/**
 * ============================================================================
 * 审阅事项的「涉及词条」字段（review_items.related_pages）
 * ============================================================================
 *
 * 为什么值得单独一个文件：这个字段有三个写入方（体检、导入提交、索引器的重名
 * 检测）和两个读取方（审阅队列、导入草稿），而它的内容格式换过三代。解析逻辑
 * 只要存在第二份实现，就一定会有一份先腐烂 —— 这个字段已经用一次真实的用户
 * 可见故障证明了这一点：
 *
 *   导入侧曾经写入「本次导入碰过的全部词条 id」，而不是这条事项真正在说哪两个
 *   词条。于是界面上一条「A 与 B 的口径冲突」下面，挂着七个与它毫无关系的 ULID。
 *   根因不是算错了，是**没有人真的知道该写什么** —— 模型当时根本没被要求指认。
 *
 * 所以现在的分工是：模型指认标题（它只知道标题），这里反查 id（界面要 id 才能
 * 跳转），查不到就保留 id: null（那正是「缺页」类发现的常态，不是错误）。
 */

/**
 * ULID 的形状：26 位 Crockford Base32（去掉了容易看错的 I / L / O / U）。
 *
 * 唯一用途是认出历史数据里那些其实是词条 id 的字符串，见 parseRelatedPages。
 */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const MAX_RELATED_PAGES = 12;

/** 不让体检批次或单项修订将异常大的关联列表送入模型。 */
export function hasOversizedRelatedPages(json: string | null): boolean {
  if (!json) return false;
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.length > MAX_RELATED_PAGES;
  } catch {
    return false;
  }
}

/**
 * 标题 → 词条引用的查找表。
 *
 * 参数只要 { id, title } 而不是完整的 CatalogEntry：导入提交那一刻要查的
 * 不只是「库里已有的词条」，还包括**本次刚建出来的**那些（比如「A 与 B 矛盾」
 * 里的 A 正是这次新建的）—— 它们只有 id 和 title，没有 CatalogEntry 的其余字段。
 */
export function buildTitleIndex(
  entries: Array<{ id: string; title: string }>,
): Map<string, { id: string; title: string }> {
  return new Map(entries.map((entry) => [entry.title.toLowerCase(), entry]));
}

/**
 * 把模型（或机械检查）写出的词条标题，转成 { id, title } 引用。
 *
 * 查不到的标题保留 id: null —— 那不是错误，是「缺页」类发现的常态：
 * 词条本来就还没建出来。
 */
export function relatedPagesFromTitles(
  titles: string[],
  byTitle: Map<string, { id: string; title: string }>,
): ReviewRelatedPage[] {
  const seen = new Set<string>();
  const out: ReviewRelatedPage[] = [];

  for (const raw of titles) {
    const title = raw.trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = byTitle.get(key);
    out.push({ id: entry?.id ?? null, title: entry?.title ?? title });
  }

  return out;
}

/**
 * 与 relatedPagesFromTitles 相反：手里已经有 id（索引器的重名检测就是这么来的），
 * 反查标题。
 *
 * 查不到的一律丢弃 —— 宁可少一个标签，也不要甩一个裸 id 到界面上。这正是
 * 用户最初看到那排 ULID 的教训：**能显示 id 的地方，迟早会显示 id**。
 */
export function relatedPagesFromIds(
  ids: string[],
  byId: Map<string, string>,
): ReviewRelatedPage[] {
  const seen = new Set<string>();
  const out: ReviewRelatedPage[] = [];

  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = byId.get(id);
    if (!title) continue;
    out.push({ id, title });
  }

  return out;
}

/**
 * 解析 related_pages 列。
 *
 * 要兼容三种历史形态，因为这个字段的写入方换过三代：
 *   ① 现行格式：[{ id, title }]；
 *   ② 旧版体检写入的 string[]，元素是**标题**；
 *   ③ 旧版导入写入的 string[]，元素是**词条 id**（用户看到的那串编号）。
 *
 * ② 与 ③ 光看内容分不出来 —— 都是一串字符串。所以只对形状像 ULID 的那批去查库：
 * 查得到就换成标题，**查不到就丢掉**。丢掉的代价只是界面上少几个小标签；
 * 留着的代价是让用户继续对着一串无意义的编号发愣。下一次体检重新入队时，
 * 这条记录就以格式 ① 重生了。
 */
export function parseRelatedPages(json: string | null): ReviewRelatedPage[] {
  if (!json) return [];

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_RELATED_PAGES) return [];

  const out: ReviewRelatedPage[] = [];
  const unresolvedIds: string[] = [];

  for (const entry of value) {
    if (entry && typeof entry === "object") {
      const { id, title } = entry as { id?: unknown; title?: unknown };
      if (typeof title === "string" && title.trim()) {
        out.push({ id: typeof id === "string" && id ? id : null, title });
      }
      continue;
    }
    if (typeof entry !== "string" || !entry.trim()) continue;

    if (ULID_PATTERN.test(entry)) unresolvedIds.push(entry);
    else out.push({ id: null, title: entry });
  }

  if (unresolvedIds.length > 0) {
    const resolved = resolveIdsToTitles(unresolvedIds);
    for (const id of unresolvedIds) {
      const title = resolved.get(id);
      if (title) out.push({ id, title });
      // 查不到：那个词条已经不存在了，这条引用没有任何可显示的信息
    }
  }

  return out;
}

/** 把一批词条 id 换成标题。查不到的 id 不出现在结果里 */
function resolveIdsToTitles(ids: string[]): Map<string, string> {
  const wanted = new Set(ids);
  const rows = getDb()
    .select({ id: pages.id, title: pages.title })
    .from(pages)
    .all()
    .filter((row) => wanted.has(row.id));
  return new Map(rows.map((row) => [row.id, row.title]));
}
