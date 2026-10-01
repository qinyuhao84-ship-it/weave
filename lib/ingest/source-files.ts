import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { PARSED_DIR, RAW_DIR, VAULT_ROOT } from "@/lib/vault/paths";

export type SourceRow = typeof sources.$inferSelect;

export function getSource(id: string): SourceRow | null {
  return getDb().select().from(sources).where(eq(sources.id, id)).get() ?? null;
}

/**
 * 将数据库中的 vault 相对路径收敛到对应目录，并同时检查词法路径和真实路径。
 * 这样即使索引数据损坏，或 raw/ 内被放入指向外部的符号链接，也不会越界读取。
 */
export function resolveSourceFile(source: SourceRow, kind: "raw" | "parsed"): string | null {
  const storedPath = kind === "raw" ? source.docPath : source.parsedPath;
  if (!storedPath || path.isAbsolute(storedPath)) return null;

  const allowedRoot = kind === "raw" ? RAW_DIR : PARSED_DIR;
  const candidate = path.resolve(VAULT_ROOT, storedPath);
  if (!isWithin(allowedRoot, candidate)) return null;

  try {
    const realRoot = fs.realpathSync(allowedRoot);
    const realCandidate = fs.realpathSync(candidate);
    if (!isWithin(realRoot, realCandidate) || !fs.statSync(realCandidate).isFile()) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
