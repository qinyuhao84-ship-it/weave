import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { WIKI_DIR, WORK_DIR, PAGE_TYPES, typeDir, relativePath, typeFromRelativePath } from "./paths";
import { parsePage, type PageFrontmatter, type ParsedPage } from "./frontmatter";
import { readFileIfExists } from "./atomic";

export type LoadedPage = {
  /** vault 相对路径 */
  relativePath: string;
  absolutePath: string;
  data: PageFrontmatter;
  content: string;
  /** 文件全文的 SHA256，用于判脏 */
  rawHash: string;
};

export type BrokenFile = {
  relativePath: string;
  absolutePath: string;
  error: string;
};

export type ScanResult = {
  pages: LoadedPage[];
  /** 解析失败的文件 —— 不能让一个坏文件阻断整个索引 */
  broken: BrokenFile[];
};

/** 递归列出 wiki/ 下所有 .md 文件（vault 相对路径，字典序） */
export function listPageFiles(): string[] {
  const results: string[] = [];
  for (const type of PAGE_TYPES) {
    const dir = typeDir(type);
    if (!fs.existsSync(dir)) continue;
    walk(dir, results);
  }
  return results.sort();
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // 跳过隐藏文件与目录（.obsidian、.trash 之类）
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(relativePath(full));
    }
  }
}

/** 读取单个词条文件；文件不存在返回 null */
export function readPage(relative: string): LoadedPage | BrokenFile | null {
  if (!isPageFile(relative)) return null;
  const absolute = path.join(WIKI_DIR, "..", relative);
  const raw = readFileIfExists(absolute);
  if (raw === null) return null;
  return toLoadedPage(relative, absolute, raw);
}

function toLoadedPage(relative: string, absolute: string, raw: string): LoadedPage | BrokenFile {
  const parsed: ParsedPage = parsePage(raw, relative);
  if (!parsed.ok) {
    return { relativePath: relative, absolutePath: absolute, error: parsed.error };
  }
  return {
    relativePath: relative,
    absolutePath: absolute,
    data: parsed.data,
    content: parsed.content,
    rawHash: hashOf(raw),
  };
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 扫描整个 wiki/，返回所有可解析的词条与解析失败的清单 */
export function scanAllPages(): ScanResult {
  const pages: LoadedPage[] = [];
  const broken: BrokenFile[] = [];

  for (const relative of listPageFiles()) {
    const absolute = path.join(WIKI_DIR, "..", relative);
    const raw = readFileIfExists(absolute);
    if (raw === null) continue;
    const result = toLoadedPage(relative, absolute, raw);
    if ("error" in result) {
      broken.push(result);
    } else {
      pages.push(result);
    }
  }

  return { pages, broken };
}

/* ---------------------------------------------------------------- 墓碑 */

/**
 * 一条墓碑能提供的信息。
 *
 * 它是「这个词条曾经叫什么名字」和「它被并去了哪里」的唯一文件证据 ——
 * 词条被软删除时文件移进 .weave/trash/，那之后就再没有任何扫描路径会读到它。
 *
 * 也正因为它是唯一证据，.weave/trash/ 是**唯一被放行进入版本管理的派生目录**
 * （见 lib/git/auto-commit.ts#IGNORE_BLOCK）。早些时候整个 .weave/ 都被 gitignore，
 * 于是这些重定向在换机器或 clone 之后彻底消失。
 */
export type Tombstone = {
  /** 墓碑记录的词条 id（frontmatter 里的 ULID，不是文件名） */
  pageId: string;
  /** 这个词条用过的全部名字：title、slug、aliases */
  names: string[];
  /** 删除/合并时指向的新词条 id；为 null 表示这次删除没有建立重定向 */
  redirectTo: string | null;
};

/**
 * 扫描回收站里的墓碑。
 *
 * 存在的理由只有一个：**redirects 表是纯派生数据，而墓碑是它唯一能重建的依据。**
 *
 * 三类写重定向的操作，可恢复性并不相同：
 *   改名     —— 不产生墓碑（词条还活着），旧名被折叠进新词条的 aliases。
 *               buildNameIndex 直接消费 aliases，这份信息本来就在文件里，不需要墓碑。
 *   合并     —— 旧名同样进了目标词条的 aliases，所以 [[旧名]] 靠 aliases 也能解析；
 *               重定向表在这条路上只是第二重保险，丢了不会断链。
 *   删除并重指向 —— 引用被就地改写成新目标，但旧名**不**进任何词条的 aliases。
 *               重定向表是它唯一的落点，而墓碑里的 redirect_to 是这张表唯一的证据。
 *               少了它，全量重建之后 [[旧名]] 就是一条死链。
 *
 * 这里扫的是最后一类的救命线索；前两类顺带被覆盖。
 *
 * 单个墓碑解析失败只跳过它自己：一条坏掉的历史线索不该阻断整次重建。
 * 这与 scanAllPages 对坏文件的处理是同一个立场。
 */
export function scanTombstones(): Tombstone[] {
  const dir = path.join(WORK_DIR, "trash");
  if (!fs.existsSync(dir)) return [];

  const out: Tombstone[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || !entry.isFile() || !entry.name.endsWith(".md")) continue;
    const relative = path.posix.join(".weave", "trash", entry.name);
    const raw = readFileIfExists(path.join(dir, entry.name));
    if (raw === null) continue;
    const parsed = parsePage(raw, relative);
    if (!parsed.ok) continue;

    const names = [parsed.data.title, parsed.data.slug, ...parsed.data.aliases]
      .map((name) => name.trim())
      .filter(Boolean);

    out.push({
      pageId: parsed.data.id,
      names: [...new Set(names)],
      redirectTo: parsed.data.redirect_to ?? null,
    });
  }
  return out;
}

/** 判断一个 vault 相对路径是不是有效的词条文件位置 */
export function isPageFile(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  return (
    !path.posix.isAbsolute(normalized) &&
    path.posix.normalize(normalized) === normalized &&
    normalized.endsWith(".md") &&
    typeFromRelativePath(normalized) !== null
  );
}
