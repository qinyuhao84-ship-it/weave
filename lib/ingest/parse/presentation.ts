/** 面向用户的导入格式说明，和 parse/router.ts 的实际支持能力保持一致。 */
export function ingestFileAccept(doclingAvailable: boolean): string {
  const base = ".md,.markdown,.txt,.text,.docx,.pdf,.html,.htm";
  return doclingAvailable ? `${base},.ppt,.pptx` : base;
}

export function ingestFormatLabel(doclingAvailable: boolean): string {
  return `Word（.docx） · PDF · Markdown · 纯文本 · HTML${doclingAvailable ? " · PowerPoint" : ""}`;
}
