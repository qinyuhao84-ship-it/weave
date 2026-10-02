import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 当前测试文件专属的临时 vault 根目录（由 tests/setup.ts 创建） */
export function vaultRoot(): string {
  const dir = process.env.WEAVE_VAULT;
  if (!dir) throw new Error("tests/setup.ts 未运行");
  return dir;
}

const TYPE_DIRS: Record<string, string> = {
  entity: "entities",
  concept: "concepts",
  source: "sources",
  query: "queries",
  overview: "overview",
};

/** 写入一个测试用词条，返回 vault 相对路径 */
export function writePage(
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
  type = "entity",
): string {
  const dir = path.join(vaultRoot(), "wiki", TYPE_DIRS[type] ?? type);
  fs.mkdirSync(dir, { recursive: true });
  const relative = `wiki/${TYPE_DIRS[type] ?? type}/${slug}.md`;

  const lines = Object.entries(frontmatter).map(([key, value]) => {
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      return `${key}: ${JSON.stringify(value)}`;
    }
    if (typeof value === "string" && /[:#\[\]{}",]/.test(value)) {
      return `${key}: ${JSON.stringify(value)}`;
    }
    return `${key}: ${value}`;
  });

  fs.writeFileSync(
    path.join(vaultRoot(), relative),
    `---\n${lines.join("\n")}\n---\n\n${body}\n`,
    "utf8",
  );
  return relative;
}

/** 构造一份完整的 frontmatter 字段，只覆盖需要变化的部分 */
export function frontmatterFor(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "entity",
    title,
    slug: title,
    created: "2026-01-01T00:00:00+08:00",
    updated: "2026-01-01T00:00:00+08:00",
    ...overrides,
  };
}

/** 读回一个词条文件的原始内容 */
export function readPageRaw(relative: string): string {
  return fs.readFileSync(path.join(vaultRoot(), relative), "utf8");
}

/** 判断词条文件是否存在 */
export function pageExists(relative: string): boolean {
  return fs.existsSync(path.join(vaultRoot(), relative));
}

/**
 * 清空 vault 里的 wiki/、raw/、测试队列与回收站内容。
 *
 * 同一个测试文件内的多个 it() 共享一个临时 vault，所以每个用例开头都要调它，
 * 否则上一个用例写的词条会漏进下一个用例。
 */
export function resetVault(): void {
  // .weave/trash 也要清：墓碑是「合并/删除建立了什么重定向」的唯一文件证据，
  // 重建索引会读它。不清的话，上一个用例删掉的词条会以重定向的形式漏进下一个用例。
  for (const sub of ["wiki", "raw", path.join(".weave", "trash"), path.join(".weave", "ingest-queue"), path.join(".weave", "transactions")]) {
    const dir = path.join(vaultRoot(), sub);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 测试直接核对 Git 备份，不保留已移除的历史产品 API。 */
export function gitHistory(limit = 50): Array<{ sha: string; shortSha: string }> {
  const raw = execFileSync("git", ["log", `-${limit}`, "--format=%H %h"], { cwd: vaultRoot(), encoding: "utf8" });
  return raw.trim().split("\n").map(line => { const [sha, shortSha] = line.split(" "); return { sha, shortSha }; });
}
