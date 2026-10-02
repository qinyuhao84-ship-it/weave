import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 计算字符串的 SHA256，用于内容指纹 */
export function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * 原子写文件：先写临时文件再 rename。
 *
 * 为什么必须这样：直接 writeFile 在进程被杀时会留下半截文件，而 vault 是
 * 唯一真源 —— 半截的 md 会让整个索引重建失败。rename 在同一文件系统内是
 * 原子操作，要么全有要么全无。
 */
export class AtomicWriteConflictError extends Error {
  constructor(readonly filePath: string) { super("文件在原子写入期间被修改。"); this.name = "AtomicWriteConflictError"; }
}

export function writeFileAtomic(absolutePath: string, content: string | Buffer, options: { expected?: string | null } = {}): void {
  const dir = path.dirname(absolutePath);
  const missing: string[] = [];
  for (let current = dir; !fs.existsSync(current); current = path.dirname(current)) missing.push(current);
  fs.mkdirSync(dir, { recursive: true });
  for (const created of missing.reverse()) syncDirectory(path.dirname(created));
  const tempPath = path.join(
    dir,
    `.${path.basename(absolutePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    const fd = fs.openSync(tempPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // 临时文件写入和 fsync 可能较慢，必须在发布前再次核对首次读取版本。
    if ("expected" in options && readFileIfExists(absolutePath) !== options.expected) throw new AtomicWriteConflictError(absolutePath);
    fs.renameSync(tempPath, absolutePath);
    syncDirectory(dir);
  } catch (error) {
    // 失败时清掉临时文件，不要把垃圾留在 vault 里
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // 清理失败不影响主错误的上报
    }
    throw error;
  }
}

/** 删除文件；文件不存在时静默返回 */
export function removeFileIfExists(absolutePath: string): boolean {
  if (!fs.existsSync(absolutePath)) return false;
  fs.unlinkSync(absolutePath);
  syncDirectory(path.dirname(absolutePath));
  return true;
}

/** 将 rename/unlink 的目录项一并落盘；不支持目录同步的平台明确降级。 */
export function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** 读取文件内容；不存在返回 null */
export function readFileIfExists(absolutePath: string): string | null {
  if (!fs.existsSync(absolutePath)) return null;
  return fs.readFileSync(absolutePath, "utf8");
}

/** 文件的 mtime 毫秒数；不存在返回 null */
export function mtimeMs(absolutePath: string): number | null {
  try {
    return fs.statSync(absolutePath).mtimeMs;
  } catch {
    return null;
  }
}

/** Publish a fully synced copy without replacing an existing destination. */
export function copyFileAtomic(from: string, to: string): void {
  const dir = path.dirname(to);
  const missing: string[] = [];
  for (let current = dir; !fs.existsSync(current); current = path.dirname(current)) missing.push(current);
  fs.mkdirSync(dir, { recursive: true });
  for (const created of missing.reverse()) syncDirectory(path.dirname(created));
  const temp = path.join(dir, `.${path.basename(to)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.copyFileSync(from, temp, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(temp, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(temp, to); // fails on collisions; a partial copy is never visible
    fs.unlinkSync(temp);
    syncDirectory(dir);
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* retain the original error */ }
    throw error;
  }
}
