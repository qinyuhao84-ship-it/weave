import fs from "node:fs";
import path from "node:path";
import { createDocument } from "@mixmark-io/domino";
import { createTurndown, htmlToMarkdown } from "./turndown";
import type { ParseInput, ParseResult } from "./types";

let pdfEngine: Promise<void> | null = null;

/**
 * Node 原生解析路径：快、零外部依赖、覆盖大部分常见格式。
 *
 * 能力边界（这是选择「双路径」而非「纯 Node」的原因）：
 * PDF 走的是 unpdf（底层 Mozilla pdf.js），它本质只是「带坐标的字符串流」，
 * 没有阅读顺序、没有段落语义、没有表格结构。单栏干净的 PDF 够用，
 * 多栏、带表格、扫描件必须交给 docling 侧车。
 */

/** Markdown 与纯文本：直读，不做任何加工 */
export function parsePlainText(input: ParseInput): ParseResult {
  const text = fs.readFileSync(input.absolutePath, "utf8");
  const isMarkdown = /\.(md|markdown)$/i.test(input.originalName);
  return {
    markdown: normalizeBlankLines(text),
    parser: isMarkdown ? "direct:markdown" : "direct:text",
    pageCount: null,
    warnings: [],
  };
}

/**
 * Word 文档。
 *
 * 用 mammoth 走语义路线：它忽略字体字号颜色，只保留标题层级/列表/表格/脚注
 * 等结构 —— 正好契合 wiki 编译场景。反过来，凡是依赖「看起来像标题」的
 * 启发式解析都会在中文文档上翻车。
 *
 * mammoth 运行时提供 convertToMarkdown，但类型定义里没有；我们走
 * convertToHtml + 自己的 turndown，好处是表格保留与转义策略可控
 * （markdown.org 的默认转义会把中文标点和 [[双链]] 字面量改得很难读）。
 */
export async function parseDocx(input: ParseInput): Promise<ParseResult> {
  const mammoth = await import("mammoth");
  const buffer = fs.readFileSync(input.absolutePath);

  const result = await mammoth.convertToHtml({ buffer });

  const warnings = result.messages
    .filter((message: { type: string }) => message.type === "warning" || message.type === "error")
    .slice(0, 5)
    .map((message: { message: string }) => message.message);

  return {
    markdown: normalizeBlankLines(htmlToMarkdown(result.value)),
    parser: "mammoth",
    pageCount: null,
    warnings,
  };
}

/**
 * 网页。
 *
 * 先把 HTML 降级为 Markdown；如果 turndown 输出的内容少得可疑（例如原页面
 * 是纯 JS 渲染的空壳），就退回纯文本剥离，至少不让导入彻底失败。
 */
export function parseHtml(input: ParseInput): ParseResult {
  const html = fs.readFileSync(input.absolutePath, "utf8");
  const document = createDocument(html);
  for (const element of Array.from(document.querySelectorAll(
    "script, style, noscript, iframe, nav, footer, form, svg, canvas, [hidden], [aria-hidden='true'], " +
    "[role='navigation'], [role='complementary'], .cookie-banner, .cookie-consent, .advertisement, .ad-slot",
  ))) {
    element.parentNode?.removeChild(element);
  }

  const body = document.body;
  const bodyText = body?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const candidates = Array.from(document.querySelectorAll("article, main, [role='main'], .article-content, .post-content, .entry-content"));
  const mainContent = candidates
    .map((element) => ({ element, text: element.textContent?.replace(/\s+/g, " ").trim() ?? "" }))
    .filter((candidate) => candidate.text.length >= 200)
    .sort((a, b) => b.text.length - a.text.length)[0];
  const contentRoot = mainContent && mainContent.text.length >= bodyText.length * 0.2
    ? mainContent.element
    : body;
  const markdown = contentRoot
    ? createTurndown().turndown(contentRoot as unknown as HTMLElement)
    : htmlToMarkdown(html);
  const warnings: string[] = [];

  // 正文太短通常意味着页面是 JS 渲染的，抓下来的只有骨架
  const plainLength = bodyText.length;
  if (markdown.length < 200 && plainLength > markdown.length * 2) {
    warnings.push("这个页面可能主要靠 JavaScript 渲染，抓到的正文不完整。");
    return {
      markdown: normalizeBlankLines(bodyText),
      parser: "html:domino-text",
      pageCount: null,
      warnings,
    };
  }

  if (plainLength > markdown.length * 6 && plainLength > 2_000) {
    warnings.push("网页中包含较多导航或模板内容，已优先提取正文区域；请在预览中核对转换结果。");
  }
  return { markdown: normalizeBlankLines(markdown), parser: "domino+turndown", pageCount: null, warnings };
}

/**
 * PDF 的 Node 兜底路径。
 *
 * 只在 docling 侧车不可用时使用。产出的结构信息很有限，必须如实告诉用户，
 * 而不是假装解析得很好 —— 用户有权知道这份资料的后续 LLM 整合质量会打折。
 */
export async function parsePdfFallback(input: ParseInput): Promise<ParseResult> {
  const { definePDFJSModule, extractText, getDocumentProxy } = await import("unpdf");
  // 使用锁文件中的已修复引擎；同一进程只初始化一次，加载失败直接报告。
  pdfEngine ??= definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs"));
  await pdfEngine;
  const buffer = fs.readFileSync(input.absolutePath);
  // PDF.js 的 Node 文件读取器需要本机路径，不能用 file:// URL；中文字体
  // 的字符映射随应用一起分发，解析不依赖系统字体或网络。
  // Next 和桌面启动器都以服务根目录为 cwd；这些资源由 outputFileTracingIncludes
  // 明确复制到 node_modules。不要使用 require.resolve：Webpack 会将它改成模块 ID。
  const pdfAssets = path.join(process.cwd(), "node_modules", "pdfjs-dist");
  const pdf = await getDocumentProxy(new Uint8Array(buffer), {
    cMapUrl: path.join(pdfAssets, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfAssets, "standard_fonts") + path.sep,
  });
  let extracted: Awaited<ReturnType<typeof extractText>>;
  try {
    extracted = await extractText(pdf, { mergePages: false });
  } finally {
    await pdf.loadingTask.destroy();
  }
  const { totalPages, text } = extracted;
  const pages = Array.isArray(text) ? text : [text];

  // 保留页边界，让后续的「引用定位到原文页码」仍然可用
  const markdown = pages
    .map((pageText, index) => {
      const clean = normalizeBlankLines(pageText ?? "");
      return `<!-- page:${index + 1} -->\n\n${clean}`;
    })
    .join("\n\n");

  const warnings: string[] = [
    "这次用的是内置的轻量解析器，PDF 的表格与多栏排版可能错乱。安装 docling 侧车后可获得显著更好的质量。",
  ];

  // 几乎没抽出文字，多半是扫描件
  if (markdown.replace(/<!--.*?-->/g, "").trim().length < 50 && totalPages > 0) {
    warnings.push("这份 PDF 几乎没有可提取的文字，可能是扫描件或图片型 PDF，需要 OCR。");
  }

  return {
    markdown: normalizeBlankLines(markdown),
    parser: "unpdf",
    pageCount: totalPages,
    warnings,
  };
}

/** 统一整理空行：压掉多余空行，保证结尾单个换行 */
export function normalizeBlankLines(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 从文件名推断一个人类可读的标题（去掉扩展名与日期前缀） */
export function titleFromFilename(filename: string): string {
  return path
    .basename(filename, path.extname(filename))
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}
