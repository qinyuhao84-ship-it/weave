import path from "node:path";
import fs from "node:fs";
import { estimateContextTokens } from "@/lib/chat/tokens";
import {
  parsePlainText, parseDocx, parseHtml, parsePdfFallback,
} from "./node-parsers";
import { parseWithDocling, checkDocling, DOCLING_SETUP_HINT } from "./docling";
import {
  SUPPORTED_EXTENSIONS, UnsupportedFormatError, ParseQualityError, type ParseInput, type ParseResult,
} from "./types";

/**
 * 格式路由。
 *
 * 设计原则是「快路径优先、重路径兜底、失败要说清楚」：
 *
 *   .md / .txt     → 直读
 *   .docx          → mammoth（Node）
 *   .html / .htm   → turndown（Node）
 *   .pdf           → docling 优先，不可用时回落 unpdf（并如实告知质量下降）
 *   .pptx          → 必须 docling（Node 方案拿不到版面与表格结构）
 *
 * 注意：格式转换**不是 LLM Wiki 理念的一部分**。Karpathy 的原始设计里，
 * 来源层只有 markdown 和图片，网页靠 Obsidian Web Clipper 剪藏。所以这一层
 * 完全是我们补的工程环节 —— 它做不好会直接拖垮后面 LLM 的整合质量，
 * 这也是整个项目里唯一值得引入 Python 侧车的地方。
 */

export type ParseOutcome = ParseResult & {
  /** 是否有更优路径可用但没走（用于提示用户装侧车） */
  upgradeHint: string | null;
};

export async function parseDocument(input: ParseInput): Promise<ParseOutcome> {
  const extension = path.extname(input.originalName).toLowerCase();

  if (!(extension in SUPPORTED_EXTENSIONS)) {
    throw new UnsupportedFormatError(extension || "（无扩展名）");
  }

  switch (extension) {
    case ".md":
    case ".markdown":
    case ".txt":
    case ".text":
      return { ...parsePlainText(input), upgradeHint: null };

    case ".docx":
      return { ...(await parseDocx(input)), upgradeHint: null };

    case ".html":
    case ".htm":
      return { ...parseHtml(input), upgradeHint: null };

    case ".pdf": {
      const docling = await checkDocling();
      if (docling.available) {
        try {
          const parsed = await parseWithDocling(input);
          if (looksLikeScan(parsed.markdown, input.byteSize)) {
            throw new Error("Docling 没有提取到足够的文字，扫描件 OCR 可能未生效。");
          }
          return { ...parsed, upgradeHint: null };
        } catch (error) {
          input.signal?.throwIfAborted();
          // 侧车在跑但这次转换失败：退回 Node 路径，并把原因如实带上
          const fallback = await parsePdfFallback(input);
          if (looksLikeScan(fallback.markdown, input.byteSize)) {
            throw new ParseQualityError(
              "没有从这份 PDF 中提取到正文。请确认 Docling 服务及 OCR 依赖已启动，再重新处理；这份文件暂不导入，以免生成空知识。",
            );
          }
          return {
            ...fallback,
            warnings: [
              `高质量解析失败（${error instanceof Error ? error.message : String(error)}），已回落到轻量解析。`,
              ...fallback.warnings,
            ],
            upgradeHint: null,
          };
        }
      }
      const fallback = await parsePdfFallback(input);
      if (looksLikeScan(fallback.markdown, input.byteSize)) {
        throw new ParseQualityError(
          `没有从这份 PDF 中提取到正文。请安装并启动 Docling OCR 后重试。\n\n${DOCLING_SETUP_HINT}`,
        );
      }
      return { ...fallback, upgradeHint: DOCLING_SETUP_HINT };
    }

    case ".pptx":
    case ".ppt": {
      const docling = await checkDocling();
      if (!docling.available) {
        // PPT 不做降级：Node 方案只能抽出幻灯片上的散字，丢掉分页、层级与表格，
        // 产出的内容会污染知识库。宁可明确失败，也不要生成一份看起来成功
        // 但其实没有结构的词条。
        throw new UnsupportedFormatError(
          `${extension}（需要 docling 侧车）\n\n${DOCLING_SETUP_HINT}`,
        );
      }
      return { ...(await parseWithDocling(input)), upgradeHint: null };
    }

    case ".doc":
      throw new UnsupportedFormatError(
        ".doc（旧版二进制格式）。请先在 Word 里另存为 .docx 再导入。",
      );

    default:
      throw new UnsupportedFormatError(extension);
  }
}

/** 判断一个文件能否被导入（不实际解析） */
export async function canImport(originalName: string): Promise<{ ok: boolean; reason?: string }> {
  const extension = path.extname(originalName).toLowerCase();
  if (!(extension in SUPPORTED_EXTENSIONS)) {
    return { ok: false, reason: `不支持的格式：${extension || "无扩展名"}` };
  }
  if (extension === ".ppt" || extension === ".pptx") {
    const docling = await checkDocling();
    if (!docling.available) {
      return { ok: false, reason: "PPT 需要 docling 侧车支持，当前不可用" };
    }
  }
  if (extension === ".doc") {
    return { ok: false, reason: "旧版 .doc 格式请先另存为 .docx" };
  }
  return { ok: true };
}

/** 累积所有解析器产生的警告去重 */
export function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.filter(Boolean))];
}

/** 从解析结果里提取页码标记（parsePdfFallback 会写 <!-- page:N -->） */
export function extractPageMarkers(markdown: string): Array<{ page: number; offset: number }> {
  const markers: Array<{ page: number; offset: number }> = [];
  const pattern = /<!--\s*page:(\d+)\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    markers.push({ page: Number(match[1]), offset: match.index });
  }
  return markers;
}

/** 去掉页码标记，得到干净的正文（标记只在内部用于引用定位） */
export function stripPageMarkers(markdown: string): string {
  return markdown.replace(/<!--\s*page:\d+\s*-->\n?/g, "");
}

/** 导入、分段和问答使用同一保守预算口径。 */
export function estimateTokens(text: string): number {
  return estimateContextTokens(text);
}

/** 判断文件是否可能是扫描件（文本极少但文件很大） */
export function looksLikeScan(markdown: string, byteSize: number): boolean {
  const textLength = markdown.replace(/<!--.*?-->/g, "").trim().length;
  return textLength < 100 && byteSize > 100 * 1024;
}

/** 确认文件真实存在且可读 */
export function assertReadable(absolutePath: string): void {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`文件不存在：${absolutePath}`);
  }
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`不是一个文件：${absolutePath}`);
  }
  if (stat.size === 0) {
    throw new Error("文件是空的");
  }
}
