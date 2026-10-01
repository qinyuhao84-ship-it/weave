import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pages } from "@/lib/db/schema";
import { absolutePath } from "@/lib/vault/paths";
import { readFileIfExists, writeFileAtomic } from "@/lib/vault/atomic";
import { truncate, localISOString } from "@/lib/utils";
import type { PageType } from "@/lib/vault/paths";

/**
 * 确定性地重建 index.md。
 *
 * 与 Karpathy 原始理念的关系：原文把 index.md 定义为「LLM 在每次 ingest 后更新
 * 的全站目录」，是 LLM 回答提问前先读的导航层。
 *
 * 我们做了个偏离：**由程序生成而不是由 LLM 维护**。理由是它在原理上就是一个
 * 投影 —— 内容完全由已有词条决定，没有任何需要判断的地方。让 LLM 来写它，
 * 只会在每次 ingest 后引入一批无意义的 diff（换个说法、调整顺序），
 * 而确定性生成永远是准确的、免费的、且 diff 干净。
 *
 * LLM 的判断力应该花在真正的判断上（抽取什么实体、发现什么矛盾），
 * 而不是抄目录。
 */

const SECTION_ORDER: Array<{ type: PageType; heading: string }> = [
  { type: "entity", heading: "实体" },
  { type: "concept", heading: "概念" },
  { type: "source", heading: "来源" },
  { type: "query", heading: "问答归档" },
  { type: "overview", heading: "综述" },
];

/** 从正文里取一句话摘要：第一段非标题、非空行的文字 */
function summarize(content: string): string {
  const lines = content.split("\n");
  for (const line of lines) {
    const clean = line.trim();
    if (!clean) continue;
    if (clean.startsWith("#")) continue;
    if (clean.startsWith("---")) continue;
    if (clean.startsWith("[[")) continue;      // 纯链接行没有摘要价值
    if (clean.startsWith(">")) continue;       // 引用块多为元信息
    // 去掉行内的双链标记，让目录读起来干净
    const plain = clean.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias ?? target);
    return truncate(plain, 70);
  }
  return "";
}

export type IndexFileReport = {
  totalPages: number;
  changed: boolean;
};

export function rebuildIndexFile(): IndexFileReport {
  const db = getDb();
  const all = db
    .select()
    .from(pages)
    .where(eq(pages.status, "active"))
    .all();

  const byType = new Map<PageType, typeof all>();
  for (const row of all) {
    const type = row.type as PageType;
    const bucket = byType.get(type) ?? [];
    bucket.push(row);
    byType.set(type, bucket);
  }

  const lines: string[] = [
    "# 织识 · 知识库目录",
    "",
    "> 本文件由程序确定性生成，请勿手工编辑（下次重建会覆盖）。",
    `> 最后更新：${localISOString()}　·　共 ${all.length} 个词条`,
    ">",
    "> 回答提问前，先读本文件来定位相关词条。",
    "",
  ];

  for (const { type, heading } of SECTION_ORDER) {
    const rows = (byType.get(type) ?? []).sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    lines.push(`## ${heading}（${rows.length}）`, "");
    if (rows.length === 0) {
      lines.push("_（暂无）_", "");
      continue;
    }
    for (const row of rows) {
      const frontmatter = safeParse(row.frontmatterJson);
      const raw = readFileIfExists(absolutePath(row.filePath));
      const content = raw ? extractBody(raw) : "";
      const summary = summarize(content);
      const aliasNote =
        Array.isArray(frontmatter?.aliases) && frontmatter.aliases.length > 0
          ? `　*(别名：${frontmatter.aliases.join("、")})*`
          : "";
      const sourceCount = Array.isArray(frontmatter?.sources) ? frontmatter.sources.length : 0;
      const sourceNote = sourceCount > 0 ? `　·　${sourceCount} 个来源` : "";
      lines.push(
        `- [[${row.title}]]${summary ? ` — ${summary}` : ""}${aliasNote}${sourceNote}`,
      );
    }
    lines.push("");
  }

  const next = `${lines.join("\n").replace(/\s*$/, "")}\n`;
  const current = readFileIfExists(absolutePath("index.md"));
  if (current === next) return { totalPages: all.length, changed: false };

  writeFileAtomic(absolutePath("index.md"), next);
  return { totalPages: all.length, changed: true };
}

function safeParse(json: string): { aliases?: unknown; sources?: unknown } | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}
