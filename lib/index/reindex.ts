import { eq, inArray, sql } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { pages, links, edges, redirects, indexMeta, reviewItems } from "@/lib/db/schema";
import { scanAllPages, scanTombstones, type LoadedPage, type BrokenFile, type Tombstone } from "@/lib/vault/read";
import { extractWikilinks, normalizeLinkTarget } from "@/lib/vault/wikilinks";
import { parsePagePath } from "@/lib/vault/paths";
import { relatedPagesFromIds } from "@/lib/review/related-pages";
import { localISOString } from "@/lib/utils";
import { ulid } from "ulid";

/**
 * 索引器：把 vault 里的 markdown 编译成 SQLite 里的可查询结构。
 *
 * 一条铁律：索引器只读 vault、只写数据库。它绝不修改任何 md 文件。
 * 所有对 vault 的写入都必须经过 lib/vault/service.ts 的服务层 —— 这是 F2
 * 「写操作收口」原则的落地。
 */

/** 链接的解析结果 */
type ResolutionKind = "resolved" | "redirected" | "dangling" | "unresolved";

export type ReindexReport = {
  pages: number;
  links: number;
  edges: number;
  /** 本次从墓碑补齐的重定向条数 */
  redirects: number;
  broken: BrokenFile[];
  /** 归一化名字的冲突（两个词条抢同一个名字） */
  nameConflicts: Array<{ name: string; pageIds: string[] }>;
  durationMs: number;
};

/** 建立「归一化名字 → 词条 id」的索引，并检测重名冲突 */
function buildNameIndex(
  active: LoadedPage[],
): { map: Map<string, string>; conflicts: Array<{ name: string; pageIds: string[] }> } {
  const map = new Map<string, string>();
  const seen = new Map<string, string[]>();

  // 优先级：title > slug > alias。先注册 title 与 slug，再补 alias（不覆盖已有）
  const register = (name: string, pageId: string, overwrite: boolean) => {
    const key = normalizeLinkTarget(name);
    if (!key) return;
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, pageId);
      seen.set(key, [pageId]);
      return;
    }
    if (existing === pageId) return;
    // 记录冲突，供审阅队列提示
    const owners = seen.get(key) ?? [existing];
    if (!owners.includes(pageId)) owners.push(pageId);
    seen.set(key, owners);
    if (overwrite) map.set(key, pageId);
  };

  for (const page of active) register(page.data.title, page.data.id, true);
  for (const page of active) register(page.data.slug, page.data.id, false);
  for (const page of active) {
    for (const alias of page.data.aliases) register(alias, page.data.id, false);
  }

  const conflicts = [...seen.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([name, pageIds]) => ({ name, pageIds }));

  return { map, conflicts };
}

/**
 * 从墓碑补齐重定向表。
 *
 * 与 rebuildLinks / rebuildEdges 的「先清空再重建」不同，这里刻意**不清空**：
 * 改名产生的重定向无法从文件恢复 —— 它和新词条的 aliases 是同一份信息，
 * 没有任何办法区分「用户手工写的别名」和「改名留下的旧名」。清空会连它一起丢掉，
 * 而留着它没有代价（常规路径下它本来就由服务层写库，语义正确）。
 *
 * 所以语义是：表里已有的行不动，只把文件能证明的补进去，同名行以文件为准覆盖。
 *
 * 为什么必须自己走一遍 pageId 链：墓碑里存的是 redirect_to（一个 pageId），
 * 所以 A→B→C 这种链在墓碑之间是完整的 pageId 链。而 redirects 表的键是**名字**，
 * flattenRedirects() 的 while 循环拿名字去查 map，跨不过这条链 —— 重建时不自己
 * 走到底，[[甲]] 就会停在一个已经不存在的词条上。
 */
function rebuildRedirects(tombstones: Tombstone[], active: LoadedPage[]): number {
  if (tombstones.length === 0) return 0;

  const db = getDb();
  const now = localISOString();
  const chain = new Map<string, string>();
  for (const tomb of tombstones) {
    if (tomb.redirectTo) chain.set(tomb.pageId, tomb.redirectTo);
  }
  const liveIds = new Set(active.map((p) => p.data.id));

  // 表里已有的行先读出来。理由是 reindexAll 跑得太频繁了 —— 每次写操作之后、
  // 每次 watcher 事件之后都会全量重跑一遍，如果无条件 onConflictDoUpdate，
  // 服务层写下的 reason（rename / merge）与 createdAt 会在下一次重建时被盖成
  // 「merge + 今天」。今天没人读 reason，正因如此它才会烂得无声无息：
  // 下一个消费者（改动记录界面、或 lib/lint 的双重定向检查）会对着一次删除
  // 报「merge」，而且时间全是最近一次重建的时间。
  const existing = new Map(
    db.select().from(redirects).all().map((row) => [row.oldNormalized, row]),
  );
  let written = 0;

  for (const tomb of tombstones) {
    if (!tomb.redirectTo) continue; // keep_dangling / clean_refs 不建立重定向

    let target = tomb.redirectTo;
    const visited = new Set([tomb.pageId]);
    while (!liveIds.has(target) && chain.has(target) && !visited.has(target)) {
      visited.add(target);
      target = chain.get(target)!;
    }
    // 链的尽头不是活词条：那次合并的目标后来自己也被删了，没有可跳转的地方
    if (!liveIds.has(target)) continue;

    for (const name of tomb.names) {
      const normalized = normalizeLinkTarget(name);
      if (!normalized) continue;

      // 文件与表说的是同一件事 → 一个字都不写，来历与时间原样留着。
      // 这是常态路径（绝大多数重建都发生在词条没动过的时候）。
      const prior = existing.get(normalized);
      if (prior && prior.newPageId === target) continue;

      // 目标确实变了（链式合并里，原目标自己后来被并走了）—— 这是一条新的映射，
      // 时间按现在记。reason 只能是 merge：墓碑证明的是一次「删掉并重指向」，
      // 文件里没有区分「改名」与「合并」的依据，而墓碑只覆盖后者。
      const row = {
        oldNormalized: normalized,
        oldRaw: name,
        newPageId: target,
        reason: "merge",
        createdAt: now,
      };
      db.insert(redirects).values(row).onConflictDoUpdate({
        target: redirects.oldNormalized,
        set: row,
      }).run();
      written++;
    }
  }
  return written;
}

/** 重建全部链接：先清空再按当前所有词条的正文重新解析 */
function rebuildLinks(
  active: LoadedPage[],
  nameIndex: Map<string, string>,
  redirectMap: Map<string, string>,
  deletedNames: Map<string, string>,
): { total: number; resolutions: Map<string, Map<string, { kind: ResolutionKind; pageId: string | null }>> } {
  const db = getDb();
  db.delete(links).run();

  const resolutions = new Map<string, Map<string, { kind: ResolutionKind; pageId: string | null }>>();
  const rows: Array<typeof links.$inferInsert> = [];

  for (const page of active) {
    const found = extractWikilinks(page.content);
    if (found.length === 0) continue;

    // 同一目标可能出现多次，先聚合
    const grouped = new Map<string, { raw: string; count: number; heading?: string; alias?: string }>();
    for (const link of found) {
      const key = normalizeLinkTarget(link.target);
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(key, {
          raw: link.target,
          count: 1,
          ...(link.heading ? { heading: link.heading } : {}),
          ...(link.alias ? { alias: link.alias } : {}),
        });
      }
    }

    const pageResolutions = new Map<string, { kind: ResolutionKind; pageId: string | null }>();

    for (const [key, info] of grouped) {
      let kind: ResolutionKind = "unresolved";
      let dstPageId: string | null = null;

      const direct = nameIndex.get(key);
      if (direct) {
        kind = "resolved";
        dstPageId = direct;
      } else {
        const redirected = redirectMap.get(key);
        if (redirected) {
          kind = "redirected";
          dstPageId = redirected;
        } else if (deletedNames.has(key)) {
          kind = "dangling";
        }
      }

      pageResolutions.set(key, { kind, pageId: dstPageId });
      rows.push({
        srcPageId: page.data.id,
        dstRaw: info.raw,
        dstNormalized: key,
        dstPageId,
        heading: info.heading ?? null,
        alias: info.alias ?? null,
        occurrences: info.count,
      });
    }

    resolutions.set(page.data.id, pageResolutions);
  }

  // 分批插入，避免超出 SQLite 的变量上限
  for (let i = 0; i < rows.length; i += 200) {
    db.insert(links).values(rows.slice(i, i + 200)).run();
  }

  return { total: rows.length, resolutions };
}

/**
 * 重建关系图的边。
 *
 * 边的数据源是 markdown 里的双链，不是数据库 —— 所以在 Obsidian 里手动加一条
 * 双链，下次重建图谱就自动多一条边。
 *
 * 边的生命周期绑到 provenance：每条边都是「某个词条提出的一条主张」。这样
 * 「改一个词条」的影响天然被限制在「该词条贡献的那些边」内，不会牵动全图。
 */
function rebuildEdges(active: LoadedPage[]): number {
  const db = getDb();
  db.delete(edges).run();

  const byId = new Map(active.map((p) => [p.data.id, p]));
  const now = localISOString();
  const rows: Array<typeof edges.$inferInsert> = [];
  const seen = new Set<string>();

  const allLinks = db
    .select({
      srcPageId: links.srcPageId,
      dstPageId: links.dstPageId,
      dstNormalized: links.dstNormalized,
      occurrences: links.occurrences,
    })
    .from(links)
    .all();

  for (const link of allLinks) {
    if (!link.dstPageId) continue;
    if (link.srcPageId === link.dstPageId) continue; // 自环不入图

    const key = `${link.srcPageId}->${link.dstPageId}`;
    // 同一对词条可能被多条链接连到，取出现次数最多的一条作为强度依据
    const existing = rows.find((r) => `${r.sourcePageId}->${r.targetPageId}` === key);
    if (existing) {
      existing.weight = Math.min(1, (existing.weight as number) + 0.1);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    const src = byId.get(link.srcPageId);
    rows.push({
      sourcePageId: link.srcPageId,
      targetPageId: link.dstPageId,
      relType: "mentions",
      // 强度：基础 0.5，出现次数越多越强，同类型词条之间略高
      weight: Math.min(1, 0.5 + Math.log2(1 + link.occurrences) * 0.15),
      signalsJson: JSON.stringify({
        occurrences: link.occurrences,
        sourceType: src?.data.type ?? null,
      }),
      evidencePagePath: src?.relativePath ?? null,
      sourceDocId: src?.data.sources[0]?.doc ?? null,
      createdAt: now,
    });
  }

  for (let i = 0; i < rows.length; i += 200) {
    db.insert(edges).values(rows.slice(i, i + 200)).run();
  }

  return rows.length;
}

/** 重建全文检索索引 */
function rebuildFts(active: LoadedPage[]): void {
  const sqlite = getSqlite();
  sqlite.exec("DELETE FROM pages_fts");
  const insert = sqlite.prepare(
    "INSERT INTO pages_fts (page_id, title, body, tags) VALUES (?, ?, ?, ?)",
  );
  const run = sqlite.transaction((items: LoadedPage[]) => {
    for (const page of items) {
      insert.run(
        page.data.id,
        page.data.title,
        `${page.content}\n${page.data.aliases.join(" ")}`,
        page.data.tags.join(" "),
      );
    }
  });
  run(active);
}

/** 读取当前的 redirects 表为 Map */
function loadRedirects(): Map<string, string> {
  const rows = getDb().select().from(redirects).all();
  return new Map(rows.map((r) => [r.oldNormalized, r.newPageId]));
}

/**
 * 「词条名冲突」审阅事项的标题格式。
 *
 * 抽成函数是因为它是**去重键的一半**：queueFindings 按 kind::title 全表判重，
 * 而这里的 upsert 每次索引重建都要拿同一个键去比对已有行 —— 两处拼法只要差一个
 * 字符，同一条冲突就会同时存在两份，界面上看起来像是两个不同的问题。
 */
function duplicateTitle(name: string): string {
  return `词条名冲突：「${name}」`;
}

/** 把重定向链压平成一步，避免 A→B、B→C 的双重重定向 */
export function flattenRedirects(): number {
  const db = getDb();
  const rows = db.select().from(redirects).all();
  const map = new Map(rows.map((r) => [r.oldNormalized, r.newPageId]));
  const pageExists = new Set(db.select({ id: pages.id }).from(pages).all().map((p) => p.id));
  let fixed = 0;

  for (const row of rows) {
    let target = row.newPageId;
    const visited = new Set<string>();
    while (!pageExists.has(target) && map.has(target) && !visited.has(target)) {
      visited.add(target);
      target = map.get(target)!;
    }
    // 目标失效（指向了已不存在的词条）时，指向该词条的原 id 也无意义
    if (target !== row.newPageId && pageExists.has(target)) {
      db.update(redirects)
        .set({ newPageId: target })
        .where(eq(redirects.oldNormalized, row.oldNormalized))
        .run();
      map.set(row.oldNormalized, target);
      fixed++;
    }
  }
  return fixed;
}

/**
 * 全量重建索引。
 *
 * 仅恢复 SQLite 中的派生索引；会话、草稿和裁决等应用数据不可重建。
 */
export function reindexAll(): ReindexReport {
  const report = getDb().transaction(() => reindexWithinTransaction());
  // 动态加载避免领域写入模块的循环依赖，任务在事务退出后运行。
  void import("./embeddings").then(module => module.scheduleEmbeddingIndex());
  return report;
}

function reindexWithinTransaction(): ReindexReport {
  const startedAt = Date.now();
  const db = getDb();
  const now = localISOString();

  const { pages: loaded, broken } = scanAllPages();
  const active = loaded.filter((p) => !p.data.deleted_at);

  // 1. 词条表：用 id 做 upsert，保证已删除的词条不会因为这次扫描而复活
  const existingIds = new Set(db.select({ id: pages.id }).from(pages).all().map((p) => p.id));
  const seenIds = new Set<string>();

  for (const page of active) {
    seenIds.add(page.data.id);
    const parsedPath = parsePagePath(page.relativePath);
    const row: typeof pages.$inferInsert = {
      id: page.data.id,
      slug: page.data.slug || parsedPath?.slug || page.data.id,
      type: page.data.type,
      title: page.data.title,
      filePath: page.relativePath,
      contentHash: page.rawHash,
      frontmatterJson: JSON.stringify(page.data),
      normalizedNames: JSON.stringify(
        [page.data.title, page.data.slug, ...page.data.aliases].map(normalizeLinkTarget),
      ),
      status: page.data.redirect_to ? "deleted" : "active",
      deletedAt: page.data.deleted_at ?? null,
      redirectTo: page.data.redirect_to ?? null,
      createdAt: page.data.created,
      updatedAt: page.data.updated,
      indexedAt: now,
    };
    db.insert(pages).values(row).onConflictDoUpdate({ target: pages.id, set: row }).run();
  }

  // 2. 文件已从磁盘消失的词条：标记为删除（不是物理删除，保留墓碑）
  const vanished = [...existingIds].filter((id) => !seenIds.has(id));
  if (vanished.length > 0) {
    db.update(pages)
      .set({ status: "deleted", deletedAt: now, indexedAt: now })
      .where(inArray(pages.id, vanished))
      .run();
  }

  // 3. 先从墓碑补齐重定向，再压平重定向链，最后才解析链接
  const tombstones = scanTombstones();
  const redirectCount = rebuildRedirects(tombstones, active);
  flattenRedirects();
  const redirectMap = loadRedirects();

  const deletedNames = new Map<string, string>();
  for (const row of db.select().from(pages).where(eq(pages.status, "deleted")).all()) {
    try {
      const names: string[] = JSON.parse(row.normalizedNames);
      for (const name of names) deletedNames.set(name, row.id);
    } catch {
      // 旧的坏数据，跳过
    }
  }
  // 墓碑里的名字也要纳入：墓碑页不在 wiki/ 下，全量重建后它在 pages 表里没有行，
  // 少了这一步，「指向一个被删除过的词条」会被误判成「指向一个从未存在的名字」。
  for (const tomb of tombstones) {
    for (const name of tomb.names) {
      const key = normalizeLinkTarget(name);
      if (key && !deletedNames.has(key)) deletedNames.set(key, tomb.pageId);
    }
  }

  const linkResult = rebuildLinks(active, buildNameIndex(active).map, redirectMap, deletedNames);
  const edgeCount = rebuildEdges(active);
  rebuildFts(active);

  // 4. 名字冲突进审阅队列（LLM 只提议，人来裁决）
  //
  // 这一段必须写成「按稳定键 upsert」，不能删光重建。删光重建曾是这里的实现，
  // 它有一个很隐蔽的后果：重建会给每一条冲突换一个新 ULID，于是用户对「这两个
  // 词条该合并」的裁决会在**下一次任意写操作之后消失**（每次写操作都会触发一次
  // reindexAll），而且正在被审阅事项引用的 id 会整个失效 —— 批量处理跑到一半
  // 撞上一次重建，手里那批 itemId 就全指空了。
  const { conflicts } = buildNameIndex(active);
  // 冲突里存的是词条 id，这里反查成标题 —— 审阅队列一律按 { id, title } 存，
  // 界面只渲染 title，id 仅用于点击跳转（见 lib/review/related-pages.ts）
  const titleById = new Map(active.map((page) => [page.data.id, page.data.title]));
  const existingDuplicates = db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.kind, "duplicate"))
    .all();
  const duplicateByTitle = new Map(existingDuplicates.map((row) => [row.title, row]));
  const currentTitles = new Set(conflicts.map((conflict) => duplicateTitle(conflict.name)));

  for (const conflict of conflicts) {
    const title = duplicateTitle(conflict.name);
    const relatedPagesJson = JSON.stringify(relatedPagesFromIds(conflict.pageIds, titleById));
    const row = duplicateByTitle.get(title);

    if (row) {
      // 冲突还在：只更新「涉及词条」。status / answer / batch_id 一个字都不动 ——
      // 那些是人的判断与任务的认领，不该被一次索引重建抹掉。
      db.update(reviewItems)
        .set({ relatedPagesJson })
        .where(eq(reviewItems.id, row.id))
        .run();
      continue;
    }

    db.insert(reviewItems)
      .values({
        id: ulid(),
        kind: "duplicate",
        title,
        detail: `${conflict.pageIds.length} 个词条共用了同一个名字，链接解析只会命中其中一个。建议合并或改名。`,
        severity: "warning",
        relatedPagesJson,
        suggestedAction: "merge",
        status: "pending",
        createdAt: now,
      })
      .run();
  }

  // 冲突已经不存在的行：只清掉还没人碰过的噪音。已裁决 / 已回答 / 已处理的是
  // 历史事实，留着 —— queueFindings 的去重按 kind::title 全表比，留着它不会让
  // 同一个问题重新入队。
  for (const row of existingDuplicates) {
    if (currentTitles.has(row.title) || row.status !== "pending") continue;
    db.delete(reviewItems).where(eq(reviewItems.id, row.id)).run();
  }

  // 5. 记录索引参数，用于判断将来是否需要重建
  db.insert(indexMeta)
    .values({ key: "last_full_reindex", value: now, updatedAt: now })
    .onConflictDoUpdate({
      target: indexMeta.key,
      set: { value: now, updatedAt: now },
    })
    .run();

  return {
    pages: active.length,
    links: linkResult.total,
    edges: edgeCount,
    redirects: redirectCount,
    broken,
    nameConflicts: conflicts,
    durationMs: Date.now() - startedAt,
  };
}

/** 让 SQLite 认为连接空闲，便于 WAL 检查点落盘 */
export function checkpoint(): void {
  try {
    getSqlite().pragma("wal_checkpoint(PASSIVE)");
  } catch {
    // 检查点失败不影响主流程
  }
}

/** 取出 FTS 相关表名，供测试断言 */
export const FTS_TABLE = "pages_fts";
export { sql };
