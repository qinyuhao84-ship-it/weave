import { z } from "zod";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { ulid } from "ulid";
import { localISOString } from "@/lib/utils";
import { PAGE_TYPES, type PageType } from "./paths";

/**
 * frontmatter 的规范定义。
 *
 * 注意：Karpathy 的原始 LLM Wiki 理念**刻意没有规定** frontmatter 字段
 * （原文明确说目录结构与页面格式都留给实现者决定）。所以这是我们的自主设计，
 * 不是「标准答案」。设计目标只有两个：
 *   1. 一致性内核需要一个永不变更的锚点 → `id`（ULID）
 *   2. 人要能读懂、Obsidian 要能识别 → `title` / `slug` / `aliases` 都是普通字符串
 */

export const PageTypeSchema = z.enum(PAGE_TYPES);
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);

/** 溯源：这一页的内容来自哪份原文的哪一页 */
export const SourceRefSchema = z.object({
  doc: z.string().describe("raw/ 下的相对路径"),
  page: z.number().int().positive().optional().describe("原文页码，用于引用精确定位"),
  quote: z.string().optional().describe("支撑该页结论的原文片段"),
});

export const PageFrontmatterSchema = z.object({
  id: z.string().min(1).describe("ULID，永不变更 —— 一致性内核的锚点"),
  type: PageTypeSchema,
  title: z.string().min(1).describe("可变的人类标签"),
  slug: z.string().min(1),
  aliases: z.array(z.string()).default([]).describe("承接旧名，使 [[旧名]] 仍可解析"),
  tags: z.array(z.string()).default([]),
  sources: z.array(SourceRefSchema).default([]),
  related: z.array(z.string()).default([]),
  created: z.string(),
  updated: z.string(),
  confidence: ConfidenceSchema.default("high"),
  /** 软删除墓碑：有值表示已删除，检索层按此过滤 */
  deleted_at: z.string().optional(),
  /** 重定向墓碑：合并后旧词条保留此字段指向新词条 */
  redirect_to: z.string().optional(),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type PageFrontmatter = z.infer<typeof PageFrontmatterSchema>;

export class FrontmatterError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "FrontmatterError";
  }
}

/** 字段的书写顺序 —— js-yaml 按对象键的插入顺序输出，这里显式固定以保证 diff 稳定 */
const FIELD_ORDER: Array<keyof PageFrontmatter> = [
  "id", "type", "title", "slug", "aliases", "tags",
  "sources", "related", "created", "updated", "confidence",
  "deleted_at", "redirect_to",
];

/** 按固定顺序重排字段，并丢掉空值，让 diff 干净 */
function orderFields(data: PageFrontmatter): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    ordered[key] = value;
  }
  return ordered;
}

/**
 * 解析一个 md 文件为 frontmatter + 正文。
 *
 * 容错策略：解析失败不抛异常到调用方，而是返回 degraded 结果 —— 索引器需要
 * 「尽力而为」地把整个 vault 建起来，不能因为一个坏文件就全盘失败。
 */
export type ParsedPage =
  | { ok: true; data: PageFrontmatter; content: string }
  | { ok: false; error: string; content: string };

export function parsePage(raw: string, _filePath: string): ParsedPage {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) {
    return { ok: false, error: "缺少 frontmatter（文件未以 --- 开头）", content: raw };
  }

  const content = raw.slice(match[0].length);

  let parsedYaml: unknown;
  try {
    parsedYaml = loadYaml(match[1]);
  } catch (error) {
    return {
      ok: false,
      error: `YAML 解析失败：${error instanceof Error ? error.message : String(error)}`,
      content,
    };
  }

  const result = PageFrontmatterSchema.safeParse(parsedYaml);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".");
    const message = first?.message ?? "未知校验错误";
    return {
      ok: false,
      error: `frontmatter 校验失败：${path ? `${path} — ` : ""}${message}`,
      content,
    };
  }

  return { ok: true, data: result.data, content };
}

/** 把 frontmatter + 正文序列化成 md 文件内容 */
export function serializePage(data: PageFrontmatter, content: string): string {
  const frontmatter = dumpYaml(orderFields(data), {
    lineWidth: -1,       // 不要自动折行，否则中文长句会被切碎
    noRefs: true,        // 重复对象内联展开，不生成 &ref/*ref 锚点
    quoteStyle: "double",
    forceQuotes: false,
    sortKeys: false,     // 保留 FIELD_ORDER 的顺序
    flowLevel: -1,       // 永不自动切换成流式（花括号）风格
  });
  const body = content.replace(/^\n+/, "").replace(/\s+$/, "");
  return `---\n${frontmatter}---\n\n${body}\n`;
}

/** 新建一页时的默认 frontmatter */
export function createFrontmatter(input: {
  type: PageType;
  title: string;
  slug: string;
  aliases?: string[];
  tags?: string[];
  sources?: SourceRef[];
  related?: string[];
  confidence?: PageFrontmatter["confidence"];
  now?: string;
}): PageFrontmatter {
  const timestamp = input.now ?? localISOString();
  return {
    id: ulid(),
    type: input.type,
    title: input.title,
    slug: input.slug,
    aliases: input.aliases ?? [],
    tags: input.tags ?? [],
    sources: input.sources ?? [],
    related: input.related ?? [],
    created: timestamp,
    updated: timestamp,
    confidence: input.confidence ?? "high",
  };
}

/** 重新序列化时刷新 updated 时间戳 */
export function touch(data: PageFrontmatter, now: string = localISOString()): PageFrontmatter {
  return { ...data, updated: now };
}
