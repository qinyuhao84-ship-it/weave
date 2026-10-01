/** 解析器统一契约：任何格式最终都产出 Markdown */
export type ParseResult = {
  markdown: string;
  /** 实际使用的解析器标识，用于判断将来是否需要重新解析 */
  parser: string;
  /** 页数（PDF/PPT 有，其余为 null） */
  pageCount: number | null;
  /** 面向用户的一句话说明，会在导入进度里展示 */
  note?: string;
  /** 非致命警告，例如「已回落到低质量解析」 */
  warnings: string[];
};

export type ParseInput = {
  absolutePath: string;
  originalName: string;
  /** 文件字节数，用于决定是否走重路径 */
  byteSize: number;
  /**
   * 取消信号。
   *
   * 只有走网络的解析器用得上（docling 侧车），而它恰恰是最慢的一个 ——
   * PDF 与 PPTX 动辄几十秒。Node 侧的那几个解析器是同步的，拿到 signal 也
   * 中断不了，它们会忽略这个字段；对它们来说「取消」只能等这一步跑完。
   */
  signal?: AbortSignal;
};

/** 支持的文件扩展名 → 展示名 */
export const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".md": "Markdown",
  ".markdown": "Markdown",
  ".txt": "纯文本",
  ".text": "纯文本",
  ".docx": "Word 文档",
  ".doc": "Word 文档（旧版）",
  ".html": "网页",
  ".htm": "网页",
  ".pdf": "PDF",
  ".pptx": "PowerPoint",
  ".ppt": "PowerPoint（旧版）",
};

export class UnsupportedFormatError extends Error {
  constructor(extension: string) {
    super(
      `不支持的格式「${extension}」。目前支持：${Object.keys(SUPPORTED_EXTENSIONS).join("、")}`,
    );
    this.name = "UnsupportedFormatError";
  }
}

export class ParseQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseQualityError";
  }
}
