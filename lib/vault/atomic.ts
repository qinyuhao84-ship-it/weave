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
export function writeFileAtomic(absolutePath: string, content: string): void {
  const dir = path.dirname(absolutePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(absolutePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, absolutePath);
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
  return true;
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
