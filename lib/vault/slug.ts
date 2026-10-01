import { pinyin } from "pinyin-pro";

/**
 * 生成 slug。规则：
 * - 中文转拼音（不带声调），如「张一鸣」→ "zhang-yi-ming"
 * - 英文转小写
 * - 非字母数字一律折叠成单个连字符
 * - 去掉首尾连字符
 *
 * 保留中英混排的能力：「字节跳动 ByteDance」→ "zi-jie-tiao-dong-bytedance"
 */
export function slugify(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // 把中文字符替换成拼音，其余字符原样保留
  const romanized = trimmed.replace(/[一-龥]+/g, (chunk) =>
    pinyin(chunk, { toneType: "none", type: "array" }).join("-"),
  );

  return romanized
    .toLowerCase()
    .normalize("NFKD")
    // 去掉变音符号（é → e）
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

/**
 * 生成带序号后缀的唯一 slug。
 * 传入 used 判定函数：返回 true 表示该 slug 已被占用。
 */
export function uniqueSlug(base: string, isTaken: (candidate: string) => boolean): string {
  const root = base || "untitled";
  if (!isTaken(root)) return root;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${root}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`无法为 ${base} 生成唯一 slug`);
}
