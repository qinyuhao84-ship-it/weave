import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { resolveVaultRoot } from "@/lib/vault/location";

/**
 * vault 是知识库的唯一真源目录，可直接用 Obsidian / VS Code 打开。
 * 默认放在 ~/Documents/织识，可用环境变量 WEAVE_VAULT 覆盖（测试时用）。
 */
export const VAULT_ROOT = resolveVaultRoot(path.join(os.homedir(), "Documents", "织识"));

export const RAW_DIR = path.join(VAULT_ROOT, "raw");
export const WIKI_DIR = path.join(VAULT_ROOT, "wiki");
export const INDEX_FILE = path.join(VAULT_ROOT, "index.md");
export const LOG_FILE = path.join(VAULT_ROOT, "log.md");
export const SCHEMA_FILE = path.join(VAULT_ROOT, "schema.md");

/** 五类词条各自的目录名 */
export const PAGE_TYPES = ["entity", "concept", "source", "query", "overview"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

const TYPE_DIRS: Record<PageType, string> = {
  entity: "entities",
  concept: "concepts",
  source: "sources",
  query: "queries",
  overview: "overview",
};

/** 词条类型 → 磁盘目录 */
export function typeDir(type: PageType): string {
  return path.join(WIKI_DIR, TYPE_DIRS[type]);
}

/** 词条类型 → vault 相对路径前缀，如 "wiki/entities" */
export function typeRelativeDir(type: PageType): string {
  return path.posix.join("wiki", TYPE_DIRS[type]);
}

/** 从 vault 相对路径反推词条类型，无法识别返回 null */
export function typeFromRelativePath(relativePath: string): PageType | null {
  const normalized = relativePath.split(path.sep).join("/");
  for (const type of PAGE_TYPES) {
    if (normalized.startsWith(`wiki/${TYPE_DIRS[type]}/`)) return type;
  }
  return null;
}

/** 词条在 vault 中的相对路径（始终用 / 分隔，便于跨平台与展示） */
export function pageRelativePath(type: PageType, slug: string): string {
  return path.posix.join(typeRelativeDir(type), `${slug}.md`);
}

/** 相对路径 → 绝对路径 */
export function absolutePath(relativePath: string): string {
  return path.join(VAULT_ROOT, relativePath);
}

/** 绝对路径 → vault 相对路径 */
export function relativePath(absolute: string): string {
  return path.relative(VAULT_ROOT, absolute).split(path.sep).join("/");
}

/** 确保 vault 目录骨架存在；返回是否新建了目录 */

/* ---------------------------------------------------------------- 工作目录 */
/**
 * .weave/ 存放 SQLite 与解析后的 markdown。SQLite 同时保存索引、导入草稿、
 * 审阅决定和聊天记录；备份时必须保留，不能只靠 raw/ 与 wiki/ 重建。
 * 放在 vault 内而不是项目内，是为了让知识库整体可搬迁 —— 拷走 织识/ 一个目录，
 * 重开索引即可继续用。
 *
 * **trash/ 是例外**：它不放派生数据，放的是被删除词条的墓碑与正文 ——
 * 墓碑是「旧名指向哪里」唯一的文件证据，正文更是删掉就没了。
 * 因此它在 .gitignore 里被单独放行（见 lib/git/auto-commit.ts#IGNORE_BLOCK）。
 */
export const WORK_DIR = path.join(VAULT_ROOT, ".weave");
export const DB_FILE = path.join(WORK_DIR, "weave.db");
export const PARSED_DIR = path.join(WORK_DIR, "parsed");
export const INGEST_QUEUE_DIR = path.join(WORK_DIR, "ingest-queue");

export function ensureVaultLayout(): boolean {
  const required = [
    RAW_DIR,
    WIKI_DIR,
    WORK_DIR,
    PARSED_DIR,
    INGEST_QUEUE_DIR,
    ...PAGE_TYPES.map(typeDir),
  ];
  let created = false;
  for (const dir of required) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created = true;
    }
  }
  return created;
}

/** 由 vault 相对路径推导词条的类型与 slug；不属于任何词条目录时返回 null */
export function parsePagePath(relative: string): { type: PageType; slug: string } | null {
  const type = typeFromRelativePath(relative);
  if (!type) return null;
  const slug = path.posix.basename(relative, ".md");
  return { type, slug };
}
