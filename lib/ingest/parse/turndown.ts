import TurndownService from "turndown";

/**
 * HTML → Markdown。
 *
 * 这个文件比看起来重要：它是所有富格式（Word / 网页 / 未来可能的其它来源）
 * 进入知识库的必经通道。做错两件事的代价都很大：
 *
 *   1. 过度转义 —— turndown 默认会把 [ 和 ] 转义成 \[ \]，这会让正文里本来
 *      正确的 [[双链]] 变成 \[\[双链\]\]，双链解析直接失效，图谱里凭空少一批边。
 *   2. 丢失表格 —— turndown 默认丢弃 table，而中文技术文档里表格密度很高。
 */

/** turndown 默认会转义的字符，我们去掉方括号（保护双链） */
const ESCAPE_CHARS = /([\\*_`~])/g;
const LEADING_BLOCK = /^(\s*)([-+>#=])/gm;

function conservativeEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(ESCAPE_CHARS, "\\$1")
    // 行首的块级标记（- + > # =）需要转义，否则会被当成列表/引用/标题
    .replace(LEADING_BLOCK, "$1\\$2");
}

/** 把 DOM 单元格里的内容压成单行：表格里不能有换行，否则表格就断了 */
function cellText(cell: Element): string {
  const raw = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
  // 竖线会破坏表格结构，转义掉
  return raw.replace(/\|/g, "\\|");
}

/** 由 <table> 构建 GFM 表格 */
function tableToMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return "";

  const matrix = rows.map((row) =>
    Array.from(row.querySelectorAll("th, td")).map(cellText),
  );

  const columnCount = Math.max(...matrix.map((r) => r.length));
  if (columnCount === 0) return "";

  // 补齐全行的列数，否则 Markdown 表格渲染会错位
  const padded = matrix.map((row) => [
    ...row,
    ...Array.from({ length: columnCount - row.length }, () => ""),
  ]);

  // 第一行如果有 th 就当表头，否则自己造一个空表头（GFM 表格必须有表头行）
  const hasHeader = rows[0].querySelector("th") !== null;
  const header = hasHeader ? padded[0] : Array.from({ length: columnCount }, () => "");
  const body = hasHeader ? padded.slice(1) : padded;

  const formatRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const separator = `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`;

  return ["", formatRow(header), separator, ...body.map(formatRow), ""].join("\n");
}

export function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });

  service.escape = conservativeEscape;

  // 纯装饰性标签直接丢掉，不产出噪音
  service.remove(["script", "style", "noscript", "iframe", "nav", "footer", "form"]);

  // 表格 → GFM 表格（必须放在通用规则之前注册，否则会被 div/p 规则抢先处理）
  service.addRule("gfmTable", {
    filter: "table",
    replacement: (_content, node) => tableToMarkdown(node as unknown as Element),
  });

  // <p> 与 <div> 负责段落切分，并压掉多余空行
  service.addRule("blockParagraph", {
    filter: (node) => node.nodeName === "P" || node.nodeName === "DIV",
    replacement: (content) => {
      const trimmed = content.trim();
      return trimmed ? `\n\n${trimmed}\n\n` : "";
    },
  });

  return service;
}

/** 把 HTML 转成 Markdown；顺带还原 NBSP、压掉多余空行 */
export function htmlToMarkdown(html: string): string {
  const markdown = createTurndown().turndown(html);
  return markdown
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 剥掉 HTML 标签，用于从网页里取纯文本兜底 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
