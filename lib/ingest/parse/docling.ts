import fs from "node:fs";
import path from "node:path";
import type { ParseInput, ParseResult } from "./types";

/**
 * docling-serve 侧车客户端。
 *
 * 为什么需要它（而不是全用 Node）：所有 Node PDF 库底层都是 Mozilla pdf.js，
 * 本质只是「带坐标的字符串流」，没有阅读顺序、没有段落语义、没有表格结构 ——
 * 这是格式本身的限制，不是库不好。实测数据：markitdown 的表格保真度评分 0.273，
 * docling 0.887。
 *
 * 为什么是 docling 而不是同类：Marker 需要 GPU 且是 GPL-3.0；MinerU 是 AGPL
 * 且官方不支持 macOS；docling 是 MIT、CPU 可用、Apple Silicon 上 30 页约 9 秒。
 *
 * 中文加分项：docling 默认 OCR 引擎 RapidOCR 有个已知 bug（忽略语言参数、
 * 永远加载中文 PP-OCRv4 模型）—— 对中文扫描件反而是意外利好。
 */

const DEFAULT_ENDPOINT = process.env.DOCLING_ENDPOINT ?? "http://127.0.0.1:5001";

/** 转换超时：大文档 + 首次加载模型可能很慢 */
const configuredTimeout = Number(process.env.DOCLING_TIMEOUT_MS ?? 300_000);
const CONVERT_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.trunc(configuredTimeout) : 300_000;

export type DoclingStatus =
  | { available: true; version: string | null }
  | { available: false; reason: string };

let cachedStatus: { at: number; value: DoclingStatus } | null = null;
const STATUS_TTL_MS = 30_000;

/** 探测侧车是否在跑。结果缓存 30 秒，避免每次导入都打一次网络请求。 */
export async function checkDocling(force = false): Promise<DoclingStatus> {
  if (!force && cachedStatus && Date.now() - cachedStatus.at < STATUS_TTL_MS) {
    return cachedStatus.value;
  }

  let value: DoclingStatus;
  try {
    const response = await fetch(`${DEFAULT_ENDPOINT}/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (response.ok) {
      let version: string | null = null;
      try {
        const body = (await response.json()) as { version?: string };
        version = body.version ?? null;
      } catch {
        // 健康检查返回非 JSON 也算可用
      }
      value = { available: true, version };
    } else {
      value = { available: false, reason: `健康检查返回 ${response.status}` };
    }
  } catch (error) {
    value = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  cachedStatus = { at: Date.now(), value };
  return value;
}

/** 测试用：重置探测缓存 */
export function resetDoclingCache(): void {
  cachedStatus = null;
}

export class DoclingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoclingError";
  }
}

/**
 * 调侧车转换一个文件。
 *
 * 走 multipart 上传，让侧车直接读文件字节 —— 比传路径更健壮（侧车可能跑在
 * 容器里，看不到宿主机路径）。
 */
export async function parseWithDocling(input: ParseInput): Promise<ParseResult> {
  const status = await checkDocling();
  if (!status.available) {
    throw new DoclingError(`docling 侧车不可用：${status.reason}`);
  }

  const buffer = fs.readFileSync(input.absolutePath);
  const form = new FormData();
  form.append(
    "files",
    new Blob([new Uint8Array(buffer)], { type: "application/octet-stream" }),
    path.basename(input.originalName),
  );
  // 保留页边界供引用定位，开启 OCR、准确表格识别与 PDF 标题层级恢复。
  form.append("to_formats", "md");
  form.append("do_table_structure", "true");
  form.append("table_mode", "accurate");
  form.append("do_ocr", "true");
  form.append("do_pdf_heading_hierarchy", "true");
  form.append("md_page_break_placeholder", "<!-- WEAVE_PAGE_BREAK -->");
  form.append("image_export_mode", "placeholder");

  let response: Response;
  try {
    response = await fetch(`${DEFAULT_ENDPOINT}/v1/convert/file`, {
      method: "POST",
      body: form,
      // 两个取消来源合并：侧车自己卡死有超时兜底，用户点停止则由外部 signal 掐断。
      // AbortSignal.any 而不是二选一 —— 少任何一个都会留下「停不下来」的路径。
      signal: input.signal
        ? AbortSignal.any([AbortSignal.timeout(CONVERT_TIMEOUT_MS), input.signal])
        : AbortSignal.timeout(CONVERT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DoclingError(
      `调用 docling 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new DoclingError(
      `docling 返回 ${response.status}${detail ? `：${detail.slice(0, 300)}` : ""}`,
    );
  }

  const payload = (await response.json()) as DoclingResponse;
  if (payload.status === "failure" || payload.status === "skipped") {
    const errors = (payload.errors ?? []).map(String).slice(0, 3).join("；");
    throw new DoclingError(`Docling ${payload.status === "failure" ? "解析失败" : "跳过了这份资料"}${errors ? `：${errors.slice(0, 240)}` : "。"}`);
  }
  const rawMarkdown = extractMarkdown(payload);
  const markdown = rawMarkdown ? restorePageMarkers(rawMarkdown) : null;

  if (!markdown) {
    throw new DoclingError("docling 没有返回可用的 Markdown 内容");
  }

  const pageCount = extractPageCount(payload);
  const warnings: string[] = [];
  if (input.byteSize > 20 * 1024 * 1024) {
    warnings.push("文件较大，解析耗时较长属正常。");
  }
  if (payload.status === "partial_success") {
    warnings.push("Docling 只完成了部分解析；请在解析稿中核对缺页或表格。");
  }
  if ((payload.errors?.length ?? 0) > 0) {
    const errors = payload.errors!.slice(0, 2).map(String).join("；").slice(0, 200);
    warnings.push(`Docling 报告 ${payload.errors!.length} 条解析提示${errors ? `：${errors}` : "。"}`);
  }

  return {
    markdown: markdown.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    parser: "docling",
    pageCount,
    note: pageCount ? `识别到 ${pageCount} 页` : undefined,
    warnings,
  };
}

/** docling-serve 不同版本的响应结构略有差异，逐种尝试 */
type DoclingResponse = {
  document?: { md_content?: string; markdown?: string; pages?: unknown };
  md_content?: string;
  markdown?: string;
  status?: string;
  errors?: unknown[];
};

function extractMarkdown(payload: DoclingResponse): string | null {
  return (
    payload.document?.md_content ??
    payload.document?.markdown ??
    payload.md_content ??
    payload.markdown ??
    null
  );
}

function restorePageMarkers(markdown: string): string {
  const parts = markdown.split("<!-- WEAVE_PAGE_BREAK -->");
  if (parts.length < 2) return markdown;
  return parts.map((part, index) => `<!-- page:${index + 1} -->\n\n${part.trim()}`).join("\n\n");
}

function extractPageCount(payload: DoclingResponse): number | null {
  const pages = payload.document?.pages;
  if (Array.isArray(pages)) return pages.length;
  if (typeof pages === "object" && pages !== null) return Object.keys(pages).length;
  return null;
}

/** 给用户看的安装指引 —— 侧车不可用时展示 */
export const DOCLING_SETUP_HINT = [
  "要为 PDF / PPT 启用高质量解析与 OCR，请先安装 Docling：",
  "",
  "  pnpm docling:install",
  "  pnpm dev",
  "",
  "应用启动时会自动运行本地 Docling 服务；首次解析可能下载 OCR 模型。",
  "扫描版 PDF 在 OCR 服务不可用时会暂停导入，避免生成空内容。",
].join("\n");
