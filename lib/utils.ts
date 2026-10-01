import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 Tailwind 类名，后写的同类属性覆盖先写的 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 把字节数格式化成人类可读形式 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/** 把毫秒格式化成「1分23秒」这样的中文时长 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}

/** 本地时区的 ISO 8601 时间戳，带 +08:00 这样的偏移 */
export function localISOString(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`
  );
}

/** 用于文件名的时间戳前缀：2026-09-26 */
export function datePrefix(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 只到天的日期显示。
 *
 * 知识库里的时间精度不需要到分秒 —— 用户读的是「哪天导的、哪天改的」，
 * 秒级时间戳只会让这一行更长、更难扫。
 */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** 截断长文本，用于列表摘要 */
export function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * 基于字符二元组的 Jaccard 相似度 —— 对中文比编辑距离更合适。
 *
 * 原先住在 lib/index/catalog.ts 里（只服务于「导入前找相似词条」）。现在
 * lib/review/questions.ts 也要用它来判断「模型给的两个选项是不是同一个意思」，
 * 而那个模块是纯函数、不该依赖索引层，所以搬到这里由两边共用。
 * 实现与搬迁前逐字一致。
 */
export function textSimilarity(a: string, b: string): number {
  const grams = (text: string) => {
    const clean = text.replace(/\s+/g, "").toLowerCase();
    const set = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    if (set.size === 0) set.add(clean);
    return set;
  };
  const setA = grams(a);
  const setB = grams(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}
