import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { pages, redirects } from "@/lib/db/schema";
import { reindexAll, flattenRedirects } from "@/lib/index/reindex";
import { suppressWatcher } from "@/lib/index/watch-suppression";
import { rebuildIndexFile } from "@/lib/index/index-file";
import { commitVault, ensureGitRepo } from "@/lib/git/auto-commit";
import { localISOString, datePrefix } from "@/lib/utils";

import {
  VAULT_ROOT, pageRelativePath, absolutePath, type PageType,
} from "./paths";
import {
  parsePage, serializePage, touch, createFrontmatter,
  type PageFrontmatter, type SourceRef,
} from "./frontmatter";
import { readFileIfExists, writeFileAtomic, removeFileIfExists } from "./atomic";
import { slugify, uniqueSlug } from "./slug";
import {
  rewriteWikilinks, stripWikilinksTo, repointWikilinks, normalizeLinkTarget,
  countLinksTo,
} from "./wikilinks";

/** 跨文件写入统一处理引用、索引与本地备份；可捕获失败按快照尝试恢复。 */
type Snapshot = string | null;

/**
 * 文件级事务：把所有改动先在内存里算完，再一次性落盘，失败则按快照回滚。
 *
 * 为什么需要它：一次改名要改 1 个词条文件 + N 个引用它的文件，还要移动文件。
 * 如果写到第 5 个文件时磁盘满了，前 4 个已经落盘 —— vault 就处于半改状态，
 * 比不改还糟。有了快照就能退回去。
 */
class VaultTransaction {
  private writes = new Map<string, string>();
  private removals = new Set<string>();
  private snapshots = new Map<string, Snapshot>();

  private snapshot(relative: string): void {
    if (!this.snapshots.has(relative)) {
      this.snapshots.set(relative, readFileIfExists(absolutePath(relative)));
    }
  }

  capture(relative: string): void {
    this.snapshot(relative);
  }

  write(relative: string, content: string): void {
    this.removals.delete(relative);
    this.writes.set(relative, content);
    this.snapshot(relative);
  }

  remove(relative: string): void {
    this.writes.delete(relative);
    this.removals.add(relative);
    this.snapshot(relative);
  }

  /**
   * 读取一个文件的「事务内当前状态」：有待写入的内容就返回它，否则读磁盘。
   *
   * 这个方法的存在是必需的：同一个事务里可能多次追加同一个文件（例如一次合并
   * 既写 log.md 又写多个词条）。直接读磁盘会读到尚未提交的旧内容，
   * 后一次写入就会把前一次覆盖掉。
   */
  read(relative: string): string | null {
    if (this.removals.has(relative)) return null;
    const pending = this.writes.get(relative);
    if (pending !== undefined) return pending;
    return readFileIfExists(absolutePath(relative));
  }

  /** 移动 = 写新路径 + 删旧路径。退化成两个基本操作，回滚逻辑就不必特判。 */
  move(from: string, to: string, content: string): void {
    this.write(to, content);
    if (from !== to) this.remove(from);
  }

  get touchedFiles(): string[] {
    return [...new Set([...this.writes.keys(), ...this.removals])];
  }

  /** 写入失败由 completeTransaction 统一恢复，避免重复回滚掩盖原始错误。 */
  commit(): void {
    suppressWatcher();
    for (const [relative, content] of this.writes) {
      writeFileAtomic(absolutePath(relative), content);
    }
    for (const relative of this.removals) {
      removeFileIfExists(absolutePath(relative));
    }
  }

  /** 某一文件恢复失败也继续尝试其余快照。 */
  rollback(): void {
    suppressWatcher();
    const failures: Error[] = [];
    for (const [relative, original] of [...this.snapshots.entries()].reverse()) {
      try {
        if (original === null || original === undefined) removeFileIfExists(absolutePath(relative));
        else writeFileAtomic(absolutePath(relative), original);
      } catch (cause) {
        failures.push(new Error(`无法恢复文件：${relative}`, { cause }));
      }
    }
    if (failures.length) throw new AggregateError(failures, "文件快照未完整恢复。");
  }
}

/** 恢复失败保留原始原因与全部恢复错误，详细路径只进入本机日志。 */
export class VaultRecoveryError extends AggregateError {
  constructor(original: unknown, failures: unknown[]) {
    super([original, ...failures], "操作失败，部分文件或备份暂存状态未能恢复。请停止服务，检查目录权限和磁盘空间，并使用完整备份核对知识库；不要继续写入。", { cause: original });
    this.name = "VaultRecoveryError";
  }
}

/* -------------------------------------------------------------- 读取辅助 */

/**
 * 词条不存在。
 *
 * 消息里**刻意不带 pageId**：ULID 对用户没有任何意义，而这一页最常见的中招
 * 路径恰恰是「点了一个已删词条的旧链接」。告诉他「可能已被删除或改名」能让他
 * 知道下一步做什么，给他一串 26 位编码只会让他以为是自己弄错了。
 * id 仍留在属性上供日志与调试使用 —— 只是不进消息。
 */
export class PageNotFoundError extends Error {
  constructor(readonly pageId: string) {
    super("这个链接指向的词条不存在了 —— 可能已被删除或改名。");
    this.name = "PageNotFoundError";
  }
}

/** 冲突：文件在别处被改过（例如用户用 Obsidian 同时编辑），拒绝静默覆盖 */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly relativePath: string,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

export type LoadedPageFile = {
  pageId: string;
  relativePath: string;
  data: PageFrontmatter;
  content: string;
  raw: string;
};

/**
 * 按 id 载入词条。
 *
 * 数据库只用来查路径，真正的数据一律以磁盘文件为准 —— 因为文件是真源，
 * 数据库可能落后（用户刚在 Obsidian 里改过还没被监听到）。
 */
export function loadPageFile(pageId: string): LoadedPageFile {
  const row = getDb().select().from(pages).where(eq(pages.id, pageId)).get();
  if (!row) throw new PageNotFoundError(pageId);

  const raw = readFileIfExists(absolutePath(row.filePath));
  if (raw === null) {
    throw new PageNotFoundError(`${pageId}（数据库记录了 ${row.filePath}，但文件已不在磁盘上）`);
  }

  const parsed = parsePage(raw, row.filePath);
  if (!parsed.ok) {
    throw new Error(`词条文件损坏：${row.filePath} —— ${parsed.error}`);
  }
  if (parsed.data.id !== pageId) {
    throw new Error(
      `词条 id 不一致：${row.filePath} 的 frontmatter id 是 ${parsed.data.id}，期望 ${pageId}`,
    );
  }

  return {
    pageId,
    relativePath: row.filePath,
    data: parsed.data,
    content: parsed.content,
    raw,
  };
}

/** 判断 slug 是否已被占用（以磁盘为准，不信数据库） */
function slugTaken(type: PageType, slug: string, exceptRelative?: string): boolean {
  const relative = pageRelativePath(type, slug);
  if (relative === exceptRelative) return false;
  return fs.existsSync(absolutePath(relative));
}

/** 遍历 vault 内全部词条文件，逐个交给回调处理 */
function forEachPageFile(
  callback: (file: LoadedPageFile, tx: VaultTransaction) => void,
  tx: VaultTransaction,
  skipPageId?: string,
): void {
  const rows = getDb().select().from(pages).all();
  for (const row of rows) {
    if (row.status !== "active") continue;
    if (row.id === skipPageId) continue;

    // 事务里同一文件可能被多次改写（例如一次合并要处理标题、slug 与别名）。
    // 读待提交内容，避免后一次写入从磁盘旧版开始而覆盖前一次改动。
    const raw = tx.read(row.filePath);
    if (raw === null) continue;

    const parsed = parsePage(raw, row.filePath);
    if (!parsed.ok) continue;

    callback(
      {
        pageId: row.id,
        relativePath: row.filePath,
        data: parsed.data,
        content: parsed.content,
        raw,
      },
      tx,
    );
  }
}

/* ------------------------------------------------------------ 操作日志 */

type LogKind = "INGEST" | "QUERY" | "LINT" | "REVIEW" | "RENAME" | "MERGE" | "DELETE" | "EDIT" | "CREATE" | "RESTORE";

/**
 * 追加一条操作日志到 log.md。
 *
 * 格式是固定前缀 + ISO 时间戳，这样既能被人读，也能被 grep/awk 解析。
 * 只追加不修改 —— 这份日志本身是审计轨迹。
 */
const LOG_HEADER = `# 织识 · 操作日志

> 本文件面向时间，只追加不修改。固定前缀便于 grep / awk 解析。
> 格式：\`- [YYYY-MM-DDTHH:MM:SS+08:00] <KIND> <描述>\`
> KIND ∈ {INGEST, QUERY, LINT, REVIEW, RENAME, MERGE, DELETE, EDIT, CREATE, RESTORE}
`;

export function appendLog(kind: LogKind, message: string, tx?: VaultTransaction): void {
  const relative = "log.md";
  // 优先读事务内的待写入内容，避免同一事务内多次追加时互相覆盖
  const current = tx ? tx.read(relative) : readFileIfExists(absolutePath(relative));
  const base = current ?? LOG_HEADER;
  const line = `- [${localISOString()}] ${kind} ${message}\n`;

  // 文件末尾保证只有一个换行，追加后自然成行
  const next = `${base.replace(/\s*$/, "")}\n${line}`;
  if (tx) tx.write(relative, next);
  else writeFileAtomic(absolutePath(relative), next);
}

/* -------------------------------------------------------------- 结果类型 */

export type WriteResult = {
  pageId: string;
  relativePath: string;
  commitSha: string | null;
  /** 被这次操作牵连改动的其他词条数 */
  affectedPages: number;
  /** 被重写/降级/重指向的链接条数 */
  linksTouched: number;
  /** 索引重建报告 */
  indexed: { pages: number; links: number; edges: number };
};

/** 文件快照与 SQLite 事务覆盖索引、重定向和 Git 收尾。 */
function completeTransaction(tx: VaultTransaction, message: string, beforeFinalize?: () => void, beforeGitCommit?: () => void) {
  ensureGitRepo();
  tx.capture("index.md");
  tx.capture("log.md");
  const gitIndexPath = path.join(VAULT_ROOT, ".git", "index");
  const gitIndex = fs.existsSync(gitIndexPath) ? fs.readFileSync(gitIndexPath) : null;
  try {
    return getDb().transaction(() => {
      tx.commit();
      beforeFinalize?.();
      const report = reindexAll();
      rebuildIndexFile();
      beforeGitCommit?.();
      const { sha } = commitVault(message);
      return { pages: report.pages, links: report.links, edges: report.edges, commitSha: sha };
    });
  } catch (error) {
    const failures: unknown[] = [];
    try { tx.rollback(); } catch (recoveryError) { failures.push(recoveryError); }
    // 文件恢复失败也要尝试恢复原有暂存状态，不能留下失败操作的 git add。
    try {
      if (gitIndex) fs.writeFileSync(gitIndexPath, gitIndex);
      else removeFileIfExists(gitIndexPath);
    } catch (recoveryError) { failures.push(recoveryError); }
    if (failures.length) throw new VaultRecoveryError(error, failures);
    throw error;
  }
}

/* ---------------------------------------------------------------- 新建 */

export type CreatePageInput = {
  type: PageType;
  title: string;
  slug?: string;
  aliases?: string[];
  tags?: string[];
  sources?: SourceRef[];
  related?: string[];
  confidence?: PageFrontmatter["confidence"];
  content: string;
  /** 显式指定 id（导入流水线要用它把草稿与最终词条对应起来） */
  id?: string;
};

export function createPage(input: CreatePageInput): WriteResult {
  const tx = new VaultTransaction();
  const base = input.slug ?? slugify(input.title);
  const slug = uniqueSlug(base, (candidate) => slugTaken(input.type, candidate));
  const relative = pageRelativePath(input.type, slug);

  const frontmatter = {
    ...createFrontmatter({
      type: input.type,
      title: input.title,
      slug,
      aliases: input.aliases ?? [],
      tags: input.tags ?? [],
      sources: input.sources ?? [],
      related: input.related ?? [],
      ...(input.confidence ? { confidence: input.confidence } : {}),
    }),
    ...(input.id ? { id: input.id } : {}),
  };

  tx.write(relative, serializePage(frontmatter, input.content));
  appendLog("CREATE", `新建${typeLabel(input.type)}「${input.title}」(${relative})`, tx);
  const indexed = completeTransaction(tx, `新增${typeLabel(input.type)}「${input.title}」`);
  return {
    pageId: frontmatter.id,
    relativePath: relative,
    commitSha: indexed.commitSha,
    affectedPages: 0,
    linksTouched: 0,
    indexed: { pages: indexed.pages, links: indexed.links, edges: indexed.edges },
  };
}

/* ---------------------------------------------------------------- 编辑 */

export type UpdatePageInput = {
  content?: string;
  title?: string;
  aliases?: string[];
  tags?: string[];
  sources?: SourceRef[];
  related?: string[];
  confidence?: PageFrontmatter["confidence"];
  /**
   * 调用方读到的文件哈希。传入时做乐观并发控制：若磁盘上的文件已被改过
   * （例如用户同时在 Obsidian 里编辑），拒绝覆盖并抛 ConflictError。
   */
  expectedHash?: string;
};

export function updatePage(pageId: string, input: UpdatePageInput): WriteResult {
  const file = loadPageFile(pageId);
  const title = input.title?.trim();
  if (input.title !== undefined && !title) throw new Error("词条标题不能为空。");
  if (title && title.length > 120) throw new Error("词条标题不能超过 120 个字。");

  if (input.expectedHash && hashOf(file.raw) !== input.expectedHash) {
    throw new ConflictError(
      `「${file.data.title}」在你编辑期间被外部修改过（可能来自 Obsidian 或其他编辑器）。` +
        `请刷新后重新编辑，以免覆盖掉那部分改动。`,
      file.relativePath,
    );
  }

  const tx = new VaultTransaction();
  const now = localISOString();
  const titleChanged = title !== undefined && title !== file.data.title;

  let nextData: PageFrontmatter = touch(
    {
      ...file.data,
      ...(title !== undefined ? { title } : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.sources !== undefined ? { sources: input.sources } : {}),
      ...(input.related !== undefined ? { related: input.related } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    },
    now,
  );

  let nextContent = input.content ?? file.content;
  let relative = file.relativePath;
  let linksTouched = 0;
  let affectedPages = 0;
  let redirectNames: string[] = [];

  // 改了标题就等同于一次改名：引用要重写，旧名要能被解析到
  if (titleChanged) {
    const oldNames = dedupe([file.data.title, file.data.slug, ...file.data.aliases]);
    const newSlug = uniqueSlug(slugify(nextData.title), (candidate) =>
      slugTaken(nextData.type, candidate, file.relativePath),
    );
    nextData = {
      ...nextData,
      slug: newSlug,
      aliases: dedupe([...nextData.aliases, file.data.title, file.data.slug])
        .filter((name) => normalizeLinkTarget(name) !== normalizeLinkTarget(nextData.title)),
    };

    const linkRewrite = rewriteReferences(tx, pageId, oldNames, nextData.title, nextContent);
    nextContent = linkRewrite.selfContent;
    linksTouched += linkRewrite.linksTouched;
    affectedPages += linkRewrite.affectedPages;

    const nextRelative = pageRelativePath(nextData.type, newSlug);
    tx.move(file.relativePath, nextRelative, serializePage(nextData, nextContent));
    relative = nextRelative;

    // 别名兜底之后仍写重定向：用户以后手写旧名也能落到这里。
    redirectNames = oldNames;
  } else {
    tx.write(file.relativePath, serializePage(nextData, nextContent));
  }

  appendLog(
    titleChanged ? "RENAME" : "EDIT",
    titleChanged
      ? `「${file.data.title}」→「${nextData.title}」，重写了 ${linksTouched} 处引用`
      : `编辑「${nextData.title}」`,
    tx,
  );

  // 改名与改写要分开：两者都走 updatePage，但用户找的往往是「我改过名的那个」。
  const renamed = nextData.title !== file.data.title;
  const indexed = completeTransaction(tx,
    renamed
      ? `把「${file.data.title}」改名为「${nextData.title}」`
      : `改写「${nextData.title}」`,
    () => { for (const oldName of redirectNames) writeRedirect(oldName, pageId, "rename"); },
  );
  return {
    pageId,
    relativePath: relative,
    commitSha: indexed.commitSha,
    affectedPages,
    linksTouched,
    indexed: { pages: indexed.pages, links: indexed.links, edges: indexed.edges },
  };
}

export type IngestBatchResult = {
  created: Array<{ pageId: string; title: string; relativePath: string }>;
  updated: Array<{ pageId: string; title: string }>;
  commitSha: string | null;
  indexed: { pages: number; links: number; edges: number };
};

/** 一次导入的词条写入、索引、应用记录与版本提交共用一份文件快照。 */
export function applyIngestBatch(input: {
  creates: Array<CreatePageInput & { id: string }>;
  updates: Array<{ pageId: string; input: UpdatePageInput & { expectedHash: string } }>;
  message: string;
  beforeGitCommit?: () => void;
}): IngestBatchResult {
  const tx = new VaultTransaction();
  const created: IngestBatchResult["created"] = [];
  const updated: IngestBatchResult["updated"] = [];
  const reservedSlugs = new Map<PageType, Set<string>>();
  const now = localISOString();

  for (const page of input.creates) {
    const reserved = reservedSlugs.get(page.type) ?? new Set<string>();
    reservedSlugs.set(page.type, reserved);
    const base = page.slug ?? slugify(page.title);
    const slug = uniqueSlug(base, (candidate) =>
      reserved.has(candidate) || slugTaken(page.type, candidate),
    );
    reserved.add(slug);
    const relative = pageRelativePath(page.type, slug);
    const frontmatter = {
      ...createFrontmatter({
        type: page.type,
        title: page.title,
        slug,
        aliases: page.aliases ?? [],
        tags: page.tags ?? [],
        sources: page.sources ?? [],
        related: page.related ?? [],
        ...(page.confidence ? { confidence: page.confidence } : {}),
      }),
      id: page.id,
    };
    tx.write(relative, serializePage(frontmatter, page.content));
    created.push({ pageId: page.id, title: page.title, relativePath: relative });
  }

  for (const entry of input.updates) {
    const file = loadPageFile(entry.pageId);
    if (hashOf(file.raw) !== entry.input.expectedHash) {
      throw new ConflictError(
        `「${file.data.title}」在你审阅期间已被修改，请刷新或重新处理后再导入。`,
        file.relativePath,
      );
    }
    const nextData = touch({
      ...file.data,
      ...(entry.input.aliases !== undefined ? { aliases: entry.input.aliases } : {}),
      ...(entry.input.tags !== undefined ? { tags: entry.input.tags } : {}),
      ...(entry.input.sources !== undefined ? { sources: entry.input.sources } : {}),
    }, now);
    tx.write(file.relativePath, serializePage(nextData, entry.input.content ?? file.content));
    updated.push({ pageId: entry.pageId, title: nextData.title });
  }

  appendLog("INGEST", input.message, tx);
  const indexed = completeTransaction(tx, input.message, undefined, input.beforeGitCommit);
  return { created, updated, commitSha: indexed.commitSha, indexed: { pages: indexed.pages, links: indexed.links, edges: indexed.edges } };
}

/* ---------------------------------------------------------------- 改名 */

export function renamePage(pageId: string, newTitle: string): WriteResult {
  return updatePage(pageId, { title: newTitle });
}

/**
 * 把全库里指向 oldName 的双链重写为 newName。
 * 返回被牵连的词条数与链接数。
 */
function rewriteReferences(
  tx: VaultTransaction,
  targetPageId: string,
  oldNames: string[],
  newName: string,
  selfContent: string,
): { affectedPages: number; linksTouched: number; selfContent: string } {
  const normalizedNames = new Set(oldNames.map(normalizeLinkTarget));
  const affectedPageIds = new Set<string>();
  let linksTouched = 0;

  forEachPageFile(
    (file) => {
      const result = rewriteWikilinks(file.content, (target) =>
        normalizedNames.has(target) ? newName : null,
      );
      if (result.changed === 0) return;
      affectedPageIds.add(file.pageId);
      linksTouched += result.changed;
      tx.write(file.relativePath, serializePage(touch(file.data), result.content));
    },
    tx,
    targetPageId,
  );

  // 被改名词条自己的正文也可能引用旧标题。使用调用方的当前草稿，
  // 这样同时编辑正文和标题时不会丢掉其中任何一项。
  const selfResult = rewriteWikilinks(selfContent, (target) =>
    normalizedNames.has(target) ? newName : null,
  );
  linksTouched += selfResult.changed;

  return {
    affectedPages: affectedPageIds.size,
    linksTouched,
    selfContent: selfResult.content,
  };
}

/** 写一条重定向记录（同名时覆盖为最新目标） */
function writeRedirect(
  oldName: string,
  newPageId: string,
  reason: "rename" | "merge",
): void {
  const normalized = normalizeLinkTarget(oldName);
  if (!normalized) return;
  const db = getDb();
  const now = localISOString();

  // 文件事务成功后再写派生表，避免文件写入失败却留下指向未改词条的重定向。
  db.insert(redirects)
    .values({ oldNormalized: normalized, oldRaw: oldName, newPageId, reason, createdAt: now })
    .onConflictDoUpdate({
      target: redirects.oldNormalized,
      set: { newPageId, oldRaw: oldName, reason, createdAt: now },
    })
    .run();
}

/* ---------------------------------------------------------------- 删除 */

export type DeleteStrategy =
  /** 把其他词条里指向它的链接降级为纯文本 */
  | { kind: "clean_refs" }
  /** 让那些引用改指向另一个词条（旧显示名保留） */
  | { kind: "redirect"; targetPageId: string }
  /** 保留死链，留待 Lint 巡检时处理 */
  | { kind: "keep_dangling" };

export type DeletePreview = {
  pageId: string;
  title: string;
  /** 引用了这个词条的其他词条 */
  referencingPages: Array<{ pageId: string; title: string; count: number }>;
  totalReferences: number;
};

/** 删除前的预览：让用户看到「本词条被 N 个词条引用」，而不是闷头删掉。 */
export function previewDelete(pageId: string): DeletePreview {
  const file = loadPageFile(pageId);
  // 必须去重：title 与 slug 常常相同（中文标题的 slug 就是标题本身，
  // 英文标题的 slug 只是小写化），不去重会把同一条引用算两遍。
  const names = dedupe([
    file.data.title,
    file.data.slug,
    ...file.data.aliases,
  ]).map(normalizeLinkTarget);
  const db = getDb();
  const referencing: DeletePreview["referencingPages"] = [];
  let total = 0;

  for (const row of db.select().from(pages).all()) {
    if (row.id === pageId || row.status !== "active") continue;
    const raw = readFileIfExists(absolutePath(row.filePath));
    if (raw === null) continue;
    const parsed = parsePage(raw, row.filePath);
    if (!parsed.ok) continue;

    let count = 0;
    for (const name of names) count += countLinksTo(parsed.content, name);
    if (count > 0) {
      referencing.push({ pageId: row.id, title: parsed.data.title, count });
      total += count;
    }
  }

  return { pageId, title: file.data.title, referencingPages: referencing, totalReferences: total };
}

export function deletePage(
  pageId: string,
  strategy: DeleteStrategy,
  /**
   * 调用方读到的那份文件的哈希。传入时做乐观并发控制 —— 删除本身不覆盖正文
   * （文件原样搬进回收站），但「先给用户看影响范围、他读完再确认」这个窗口里
   * 的外部改动会让那份影响范围失真，所以执行前仍要确认它没被动过。
   */
  expectedHash?: string,
): WriteResult {
  const file = loadPageFile(pageId);

  if (expectedHash && hashOf(file.raw) !== expectedHash) {
    throw new ConflictError(
      `《${file.data.title}》在你确认期间被外部修改过（可能来自 Obsidian 或其他编辑器）。` +
        `这次删除已取消，请重新发起。`,
      file.relativePath,
    );
  }

  const tx = new VaultTransaction();
  const now = localISOString();
  let linksTouched = 0;
  const affectedPageIds = new Set<string>();

  if (strategy.kind === "redirect" && strategy.targetPageId === pageId) {
    throw new Error("不能把词条重定向到它自己。");
  }

  const names = dedupe([file.data.title, file.data.slug, ...file.data.aliases].map((n) => n.trim()));

  if (strategy.kind === "clean_refs") {
    for (const name of names) {
      const normalized = normalizeLinkTarget(name);
      forEachPageFile((other, t) => {
        const result = stripWikilinksTo(other.content, normalized);
        if (result.stripped === 0) return;
        affectedPageIds.add(other.pageId);
        linksTouched += result.stripped;
        t.write(other.relativePath, serializePage(touch(other.data), result.content));
      }, tx, pageId);
    }
  } else if (strategy.kind === "redirect") {
    const target = loadPageFile(strategy.targetPageId);
    for (const name of names) {
      const normalized = normalizeLinkTarget(name);
      forEachPageFile((other, t) => {
        const result = repointWikilinks(other.content, normalized, target.data.title);
        if (result.repointed === 0) return;
        affectedPageIds.add(other.pageId);
        linksTouched += result.repointed;
        t.write(other.relativePath, serializePage(touch(other.data), result.content));
      }, tx, pageId);
    }
  }
  // keep_dangling 什么都不改，让链接自然地变成 dangling

  // 软删除：文件移进回收站，frontmatter 打墓碑。绝不物理删除。
  const trashRelative = path.posix.join(".weave", "trash", `${pageId}.md`);
  // redirect 策略必须把「并去了哪里」写进墓碑：墓碑是这类重定向唯一的文件证据，
  // 缺了它，全量重建索引后 [[旧名]] 就再也找不到落点（见 lib/vault/read.ts#scanTombstones）。
  const tombstoned: PageFrontmatter = {
    ...file.data,
    deleted_at: now,
    ...(strategy.kind === "redirect" ? { redirect_to: strategy.targetPageId } : {}),
    updated: now,
  };
  tx.move(file.relativePath, trashRelative, serializePage(tombstoned, file.content));

  appendLog(
    "DELETE",
    `删除「${file.data.title}」（策略 ${strategy.kind}${
      strategy.kind === "redirect"
        ? ` → 「${loadPageFile(strategy.targetPageId).data.title}」`
        : ""
    }），处理了 ${linksTouched} 处引用`,
    tx,
  );
  const indexed = completeTransaction(tx, `删除「${file.data.title}」`, () => {
    if (strategy.kind === "redirect") {
      for (const name of names) writeRedirect(name, strategy.targetPageId, "merge");
      flattenRedirects();
    }
  });
  return {
    pageId,
    relativePath: trashRelative,
    commitSha: indexed.commitSha,
    affectedPages: affectedPageIds.size,
    linksTouched,
    indexed: { pages: indexed.pages, links: indexed.links, edges: indexed.edges },
  };
}

/** 从回收站恢复一个被软删除的词条 */
export function restorePage(pageId: string): WriteResult {
  const trashRelative = path.posix.join(".weave", "trash", `${pageId}.md`);
  const raw = readFileIfExists(absolutePath(trashRelative));
  if (raw === null) throw new PageNotFoundError(`${pageId}（回收站里没有这个文件）`);

  const parsed = parsePage(raw, trashRelative);
  if (!parsed.ok) throw new Error(`回收站文件损坏：${parsed.error}`);

  const tx = new VaultTransaction();
  const restored: PageFrontmatter = { ...parsed.data, updated: localISOString() };
  delete restored.deleted_at;
  // redirect_to 也必须清掉。留着它，reindexAll 里那句
  // `status: page.data.redirect_to ? "deleted" : "active"` 会继续把复活后的词条
  // 标成已删除 —— 恢复等于没恢复，词条永远进不了目录。
  delete restored.redirect_to;

  const slug = uniqueSlug(slugify(restored.slug || restored.title), (candidate) =>
    slugTaken(restored.type, candidate),
  );
  const relative = pageRelativePath(restored.type, slug);
  tx.move(trashRelative, relative, serializePage({ ...restored, slug }, parsed.content));
  appendLog("RESTORE", `恢复「${restored.title}」`, tx);

  // 词条复活了，之前那些指向它的重定向就该消失 —— 否则 [[它自己的旧名]] 会绕一圈
  // 又跳回它自己。重定向表是派生数据，直接写库，不进文件事务。
  const indexed = completeTransaction(tx, `恢复「${restored.title}」`, () => {
    getDb().delete(redirects).where(eq(redirects.newPageId, pageId)).run();
  });
  return {
    pageId,
    relativePath: relative,
    commitSha: indexed.commitSha,
    affectedPages: 0,
    linksTouched: 0,
    indexed: { pages: indexed.pages, links: indexed.links, edges: indexed.edges },
  };
}

/* ---------------------------------------------------------------- 合并 */

export type MergePagesInput = {
  sourcePageId: string;
  targetPageId: string;
  /**
   * 合并后的正文。不传则简单拼接 —— 界面上会提示用户合并后自行整理，
   * 或者由 LLM 先给出合并稿再交人确认。
   */
  mergedContent?: string;
  /** 合并后保留哪个标题，默认用目标的 */
  title?: string;
  /**
   * 调用方读到的那两份文件的哈希。传入时做乐观并发控制 —— 合并是**唯一**
   * 会覆盖已有正文的破坏性操作（删除是把文件原样搬进回收站，正文一个字不动），
   * 少了它，「先给用户看影响范围、他读完再确认」这个分钟级窗口里的外部改动
   * 就会被静默覆盖，而那恰好是本项目最不能接受的一种失败。
   */
  expectedHashes?: { source?: string; target?: string };
};

/**
 * 合并两个重复词条。
 *
 * 用「MediaWiki 范式 + Obsidian 范式」并用（调研结论）：
 *   - Obsidian 范式：旧名写进新词条的 aliases，以后 [[旧名]] 仍能解析
 *   - MediaWiki 范式：旧词条转成墓碑 + 重定向记录
 * 两个都做，因为任何一条路径都可能漏（用户在 Obsidian 里手写的链接、
 * 索引尚未覆盖的文件）。
 *
 * 合并会做传递闭包：如果 A 之前被合并进了 B，现在 B 又要并进 C，
 * 那么所有指向 A 的链接会一路落到 C，不留双重跳转。
 */
export function mergePages(input: MergePagesInput): WriteResult & { mergedAliases: string[] } {
  if (input.sourcePageId === input.targetPageId) {
    throw new Error("不能把词条合并到它自己。");
  }
  if (input.title !== undefined && !input.title.trim()) {
    throw new Error("合并后的标题不能为空。");
  }
  const source = loadPageFile(input.sourcePageId);
  const target = loadPageFile(input.targetPageId);

  for (const [file, expected] of [
    [source, input.expectedHashes?.source, "源词条"],
    [target, input.expectedHashes?.target, "目标词条"],
  ] as const) {
    if (!expected || hashOf(file.raw) === expected) continue;
    throw new ConflictError(
      `《${file.data.title}》在你确认期间被外部修改过（可能来自 Obsidian 或其他编辑器）。` +
        `这次合并已取消，请重新发起 —— 否则那部分改动会被合并稿覆盖掉。`,
      file.relativePath,
    );
  }

  const tx = new VaultTransaction();
  const now = localISOString();

  const mergedTitle = input.title?.trim() || target.data.title;
  if (mergedTitle.length > 120) throw new Error("合并后的标题不能超过 120 个字。");
  const mergedSlug = mergedTitle === target.data.title
    ? target.data.slug
    : uniqueSlug(slugify(mergedTitle), (candidate) =>
        slugTaken(target.data.type, candidate, target.relativePath),
      );
  const mergedRelative = pageRelativePath(target.data.type, mergedSlug);
  const targetTitleChanged = mergedTitle !== target.data.title;
  const mergedAliases = dedupe([
    ...target.data.aliases,
    ...(targetTitleChanged ? [target.data.title, target.data.slug] : []),
    source.data.title,
    source.data.slug,
    ...source.data.aliases,
  ]).filter((name) => normalizeLinkTarget(name) !== normalizeLinkTarget(mergedTitle));

  const mergedSources = dedupeBy(
    [...target.data.sources, ...source.data.sources],
    (ref) => `${ref.doc}#${ref.page ?? ""}`,
  );

  const mergedContent =
    input.mergedContent ??
    [target.content.trim(), source.content.trim()].filter(Boolean).join("\n\n");

  const nextTarget: PageFrontmatter = touch(
    {
      ...target.data,
      title: mergedTitle,
      slug: mergedSlug,
      aliases: mergedAliases,
      sources: mergedSources,
    },
    now,
  );

  tx.write(target.relativePath, serializePage(nextTarget, mergedContent));

  // 把所有指向源词条的链接改指向目标，并保留原显示名：[[张三]] → [[张三丰|张三]]
  const sourceNames = dedupe([
    source.data.title,
    source.data.slug,
    ...source.data.aliases,
  ]);
  let linksTouched = 0;
  const affectedPageIds = new Set<string>();

  for (const name of sourceNames) {
    const normalized = normalizeLinkTarget(name);
    forEachPageFile(
      (other, t) => {
        const result = repointWikilinks(other.content, normalized, mergedTitle);
        if (result.repointed === 0) return;
        affectedPageIds.add(other.pageId);
        linksTouched += result.repointed;
        t.write(other.relativePath, serializePage(touch(other.data), result.content));
      },
      tx,
      source.pageId,
    );
  }

  if (mergedRelative !== target.relativePath) {
    const stagedTarget = tx.read(target.relativePath);
    if (stagedTarget !== null) tx.move(target.relativePath, mergedRelative, stagedTarget);
  }

  // 源词条转为墓碑并移入回收站
  const trashRelative = path.posix.join(".weave", "trash", `${source.pageId}.md`);
  const tombstone: PageFrontmatter = {
    ...source.data,
    deleted_at: now,
    redirect_to: target.pageId,
    updated: now,
  };
  tx.move(source.relativePath, trashRelative, serializePage(tombstone, source.content));

  appendLog(
    "MERGE",
    `「${source.data.title}」并入「${mergedTitle}」，重指向 ${linksTouched} 处引用，别名折叠 ${mergedAliases.length} 个`,
    tx,
  );
  const indexed = completeTransaction(tx, `把「${source.data.title}」并入「${mergedTitle}」`, () => {
    for (const name of sourceNames) writeRedirect(name, target.pageId, "merge");
    const flattened = flattenRedirects();
    appendLog("LINT", `压平 ${flattened} 条重定向链`);
  });
  return {
    pageId: target.pageId,
    relativePath: mergedRelative,
    commitSha: indexed.commitSha,
    affectedPages: affectedPageIds.size,
    linksTouched,
    mergedAliases,
    indexed: { pages: indexed.pages, links: indexed.links, edges: indexed.edges },
  };
}

/* ---------------------------------------------------------------- 工具 */

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key) continue;
    const normalized = normalizeLinkTarget(key);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(key);
  }
  return result;
}

function dedupeBy<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function typeLabel(type: PageType): string {
  return { entity: "实体", concept: "概念", source: "来源", query: "问答", overview: "综述" }[type];
}

/** 时间戳前缀，供导入流程给 raw/ 文件命名 */
export { datePrefix, VAULT_ROOT };
