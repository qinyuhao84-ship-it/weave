/**
 * 双链（wikilink）的解析与重写。
 *
 * 为什么这是最容易出错的地方：正文里的 [[...]] 必须与「代码块里的 [[...]]」区分开。
 * 一篇讲 Markdown 语法的笔记，正文里会出现 ```[[示例]]``` 这样的字面量，
 * 如果把它也当成真链接去重写，就会静默破坏用户的笔记内容。
 *
 * 因此所有解析都先算出「受保护区间」（代码围栏 + 行内代码），
 * 落在区间内的匹配一律忽略；重写时从后往前替换，保证前面的偏移量不失效。
 */

export type Wikilink = {
  /** 完整原文，含双方括号 */
  raw: string;
  /** 目标词条名（已 trim，未做大小写归一） */
  target: string;
  /** # 后面的小节名；本项目只做词条级引用，解析时保留以便未来扩展 */
  heading?: string;
  /** | 后面的显示别名 */
  alias?: string;
  start: number;
  end: number;
};

const WIKILINK_PATTERN = /\[\[([^\[\]]+?)\]\]/g;

/** 计算正文里不应被当作链接解析的区间（代码围栏与行内代码） */
export function protectedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // 围栏代码块：``` 或 ~~~，允许缩进，闭合标记需与开启标记字符一致且长度不短于开启
  const fence = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[^\n]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  // 行内代码：`code` 或 ``code``；跳过已落在围栏内的
  const inline = /`+[^`\n]*`+/g;
  while ((match = inline.exec(content)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (!ranges.some(([s, e]) => start >= s && end <= e)) {
      ranges.push([start, end]);
    }
  }

  return ranges;
}

function isProtected(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

/** 把 [[目标|别名]] 拆成目标、小节、别名三段 */
function parseInner(inner: string): { target: string; heading?: string; alias?: string } {
  let rest = inner;
  let alias: string | undefined;

  const pipeIndex = rest.indexOf("|");
  if (pipeIndex !== -1) {
    alias = rest.slice(pipeIndex + 1).trim();
    rest = rest.slice(0, pipeIndex);
  }

  let heading: string | undefined;
  const hashIndex = rest.indexOf("#");
  if (hashIndex !== -1) {
    heading = rest.slice(hashIndex + 1).trim();
    rest = rest.slice(0, hashIndex);
  }

  return {
    target: rest.trim(),
    ...(heading ? { heading } : {}),
    ...(alias ? { alias } : {}),
  };
}

/** 归一化用于比对的词条名：折叠空白、去首尾、统一小写 */
export function normalizeLinkTarget(target: string): string {
  return target.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 提取正文里所有有效的双链（自动跳过代码区间） */
export function extractWikilinks(content: string): Wikilink[] {
  const ranges = protectedRanges(content);
  const links: Wikilink[] = [];
  const pattern = new RegExp(WIKILINK_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (isProtected(ranges, start, end)) continue;

    const parsed = parseInner(match[1]);
    if (!parsed.target) continue;

    links.push({ ...parsed, raw: match[0], start, end });
  }

  return links;
}

/** 把一条双链重新序列化；alias 与原文相同时省略 | */
export function serializeWikilink(target: string, alias?: string, heading?: string): string {
  const inner = heading ? `${target}#${heading}` : target;
  return alias ? `[[${inner}|${alias}]]` : `[[${inner}]]`;
}

export type RewriteResult = {
  content: string;
  /** 实际改写的链接条数 */
  changed: number;
  /** 改写明细，用于生成操作日志 */
  rewrites: Array<{ from: string; to: string }>;
};

/**
 * 按映射重写正文里的双链。
 *
 * resolve 收到归一化后的目标名，返回新的目标名；返回 null 表示保持原样。
 * 重写时保留原有的别名与小节，只替换目标部分。
 *
 * 从后往前替换是关键：这样前面链接的 start/end 偏移量不会因为文本长度变化而失效。
 */
export function rewriteWikilinks(
  content: string,
  resolve: (normalizedTarget: string) => string | null,
): RewriteResult {
  const links = extractWikilinks(content);
  if (links.length === 0) return { content, changed: 0, rewrites: [] };

  const rewrites: Array<{ from: string; to: string }> = [];
  let result = content;

  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    const nextTarget = resolve(normalizeLinkTarget(link.target));
    if (nextTarget === null || nextTarget === link.target) continue;

    const replacement = serializeWikilink(nextTarget, link.alias, link.heading);
    result = result.slice(0, link.start) + replacement + result.slice(link.end);
    rewrites.push({ from: link.target, to: nextTarget });
  }

  // 反向遍历导致 rewrites 是倒序的，翻转回来便于阅读
  rewrites.reverse();
  return { content: result, changed: rewrites.length, rewrites };
}

/** 统计正文里指向某个词条名的链接数量（用于删除前的「被 N 个词条引用」提示） */
export function countLinksTo(content: string, normalizedTarget: string): number {
  return extractWikilinks(content).filter(
    (link) => normalizeLinkTarget(link.target) === normalizedTarget,
  ).length;
}

/**
 * 把指向某个词条的链接降级为纯文本。
 *
 * 用于「删除词条时一并清理引用」——把 [[张三]] 变成「张三」（保留显示名），
 * 而不是留着一条点不开的死链。同样跳过代码区间。
 */
export function stripWikilinksTo(content: string, normalizedTarget: string): {
  content: string;
  stripped: number;
} {
  const links = extractWikilinks(content);
  const targets = links.filter((l) => normalizeLinkTarget(l.target) === normalizedTarget);
  if (targets.length === 0) return { content, stripped: 0 };

  let result = content;
  for (let i = targets.length - 1; i >= 0; i--) {
    const link = targets[i];
    // 优先显示别名；没有别名就用原名。小节信息在降级后无意义，丢弃。
    const display = link.alias ?? link.target;
    result = result.slice(0, link.start) + display + result.slice(link.end);
  }
  return { content: result, stripped: targets.length };
}

/**
 * 去掉正文里**所有**双链的方括号，只留下可读的那个名字。
 *
 * 与 stripWikilinksTo 的分工：那个只处理指向某一个词条的链接（删除词条时用），
 * 这个处理全部 —— 场景是「把内部写法还原成人读的文字」，比如引用抽屉里的
 * 原文片段、审阅卡片上的原文依据。
 *
 * 同样先算受保护区间：引文里若出现一段讲 Markdown 语法的例子，
 * 那些放在代码里的 [[字面量]] 是内容本身，不该被动。
 */
export function stripWikilinks(content: string): string {
  const links = extractWikilinks(content);
  if (links.length === 0) return content;

  let result = content;
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    result = result.slice(0, link.start) + (link.alias ?? link.target) + result.slice(link.end);
  }
  return result;
}

/**
 * 把指向某个词条的链接重写为「指向新目标但保留旧显示名」。
 *
 * 这是合并的标准形态：[[张三]] → [[张三丰|张三]]。
 * 保留旧显示名让原句读起来仍然通顺，同时链接已经指向合并后的词条。
 */
export function repointWikilinks(
  content: string,
  normalizedTarget: string,
  newTarget: string,
): { content: string; repointed: number } {
  const links = extractWikilinks(content);
  const targets = links.filter((l) => normalizeLinkTarget(l.target) === normalizedTarget);
  if (targets.length === 0) return { content, repointed: 0 };

  let result = content;
  for (let i = targets.length - 1; i >= 0; i--) {
    const link = targets[i];
    const display = link.alias ?? link.target;
    const replacement = serializeWikilink(newTarget, display, link.heading);
    result = result.slice(0, link.start) + replacement + result.slice(link.end);
  }
  return { content: result, repointed: targets.length };
}
