import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { parseDocument, canImport, estimateTokens, stripPageMarkers, extractPageMarkers, looksLikeScan } from "@/lib/ingest/parse/router";
import { UnsupportedFormatError } from "@/lib/ingest/parse/types";
import { htmlToMarkdown, stripHtml } from "@/lib/ingest/parse/turndown";
import { titleFromFilename, normalizeBlankLines } from "@/lib/ingest/parse/node-parsers";
import { checkDocling, resetDoclingCache } from "@/lib/ingest/parse/docling";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");

function input(name: string) {
  const absolutePath = path.join(FIXTURES, name);
  return {
    absolutePath,
    originalName: name,
    byteSize: fs.statSync(absolutePath).size,
  };
}

describe("Markdown 与纯文本解析", () => {
  it("Markdown 直读并保留双链", async () => {
    const result = await parseDocument(input("sample.md"));
    expect(result.parser).toBe("direct:markdown");
    expect(result.markdown).toContain("# 已有笔记");
    expect(result.markdown).toContain("[[双链]]");
  });

  it("纯文本直读", async () => {
    const result = await parseDocument(input("sample.txt"));
    expect(result.parser).toBe("direct:text");
    expect(result.markdown).toContain("知识图谱用节点与边表达实体之间的关系");
  });
});

describe("Word 解析", () => {
  it("抽取出标题与正文", async () => {
    const result = await parseDocument(input("sample.docx"));
    expect(result.parser).toBe("mammoth");
    expect(result.markdown).toContain("推荐算法概述");
    expect(result.markdown).toContain("协同过滤");
    expect(result.markdown).toContain("字节跳动大规模应用了这类方法");
  });

  it("标题转成 Markdown 的 # 层级 —— 语义结构被保留", async () => {
    const result = await parseDocument(input("sample.docx"));
    expect(result.markdown).toMatch(/^#\s+推荐算法概述/m);
    expect(result.markdown).toMatch(/^##\s+协同过滤/m);
  });

  it("表格被保留为 Markdown 表格", async () => {
    const result = await parseDocument(input("sample.docx"));
    expect(result.markdown).toContain("|");
    expect(result.markdown).toContain("UserCF");
    expect(result.markdown).toContain("ItemCF");
  });
});

describe("HTML 解析", () => {
  it("标题、段落、表格都转成 Markdown", async () => {
    const result = await parseDocument(input("sample.html"));
    expect(result.markdown).toContain("# 向量数据库选型");
    expect(result.markdown).toContain("向量数据库用于存储嵌入向量");
    expect(result.markdown).toContain("Qdrant");
    expect(result.markdown).toContain("Milvus");
  });

  it("script 与 style 被剥掉", () => {
    const html = '<p>正文</p><script>var x=1;</script><style>.a{color:red}</style>';
    const markdown = htmlToMarkdown(html);
    expect(markdown).toContain("正文");
    expect(markdown).not.toContain("var x=1");
    expect(markdown).not.toContain("color:red");
  });

  it("转义不过度 —— 中文标点保持可读", () => {
    const html = "<p>他说：「这是重点。」然后停顿。</p>";
    const markdown = htmlToMarkdown(html);
    expect(markdown).toContain("「这是重点。」");
    expect(markdown).not.toContain("\\");
  });

  it("htmlToMarkdown 不给双链字面量加反斜杠转义", () => {
    const html = "<p>语法是 [[目标]] 这样写。</p>";
    expect(htmlToMarkdown(html)).toContain("[[目标]]");
  });

  it("stripHtml 兜底能取到纯文本", () => {
    expect(stripHtml("<div><p>你好&nbsp;世界</p></div>")).toContain("你好 世界");
  });
});

describe("PDF 解析（Node 兜底路径）", () => {
  it("在没有 docling 时回落到 unpdf 并如实警告", async () => {
    resetDoclingCache();
    const result = await parseDocument(input("sample.pdf"));
    expect(result.parser).toBe("unpdf");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("轻量解析器");
  });

  it("给出升级提示（怎么装侧车）", async () => {
    resetDoclingCache();
    const result = await parseDocument(input("sample.pdf"));
    expect(result.upgradeHint).toContain("pnpm docling:install");
  });

  it("识别出页数", async () => {
    resetDoclingCache();
    const result = await parseDocument(input("sample.pdf"));
    expect(result.pageCount).toBe(2);
  });

  it("离线提取中文正文，不能把缺少字符映射误报为扫描件", async () => {
    resetDoclingCache();
    const result = await parseDocument(input("sample.pdf"));
    expect(result.markdown).toContain("知识管理方法论");
    expect(result.markdown).toContain("卢曼的卡片盒笔记法");
    expect(result.markdown).toContain("知识会累积，而不是每次重新检索");
    expect(result.warnings.join(" ")).not.toContain("几乎没有可提取的文字");
  });

  it("保留页码标记，供引用精确定位使用", async () => {
    resetDoclingCache();
    const result = await parseDocument(input("sample.pdf"));
    const markers = extractPageMarkers(result.markdown);
    expect(markers.map((m) => m.page)).toEqual([1, 2]);
    expect(markers[0].offset).toBe(0);
  });

  it("stripPageMarkers 得到干净正文", async () => {
    resetDoclingCache();
    const result = await parseDocument(input("sample.pdf"));
    expect(stripPageMarkers(result.markdown)).not.toContain("<!-- page:");
  });
});

describe("PPT 与旧格式的处理", () => {
  it("没有侧车时 PPTX 明确失败，而不是产出一份没结构的词条", async () => {
    resetDoclingCache();
    const fake = { absolutePath: "/nonexistent.pptx", originalName: "x.pptx", byteSize: 100 };
    await expect(parseDocument(fake)).rejects.toThrow(UnsupportedFormatError);
    await expect(parseDocument(fake)).rejects.toThrow(/需要 docling 侧车/);
  });

  it("旧版 .doc 给出可操作的指引", async () => {
    const fake = { absolutePath: "/nonexistent.doc", originalName: "x.doc", byteSize: 100 };
    await expect(parseDocument(fake)).rejects.toThrow(/另存为 .docx/);
  });

  it("不支持的扩展名被拒", async () => {
    const fake = { absolutePath: "/nonexistent.xyz", originalName: "x.xyz", byteSize: 10 };
    await expect(parseDocument(fake)).rejects.toThrow(UnsupportedFormatError);
  });

  it("canImport 对可导入格式返回 ok", async () => {
    expect((await canImport("a.md")).ok).toBe(true);
    expect((await canImport("a.docx")).ok).toBe(true);
    expect((await canImport("a.pdf")).ok).toBe(true);
    expect((await canImport("a.exe")).ok).toBe(false);
  });

  it("canImport 对 PPT 依据侧车可用性判断", async () => {
    resetDoclingCache();
    const result = await canImport("a.pptx");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("docling");
  });
});

describe("侧车探测", () => {
  it("没有侧车时返回不可用并给出原因", async () => {
    resetDoclingCache();
    const status = await checkDocling(true);
    expect(status.available).toBe(false);
    if (!status.available) expect(status.reason).toBeTruthy();
  });

  it("探测结果被缓存，不会每次导入都打网络", async () => {
    resetDoclingCache();
    const first = await checkDocling();
    const second = await checkDocling();
    expect(first).toEqual(second);
  });
});

describe("工具函数", () => {
  it("titleFromFilename 去掉扩展名与日期前缀", () => {
    expect(titleFromFilename("2026-09-26-某访谈.pdf")).toBe("某访谈");
    expect(titleFromFilename("推荐算法笔记.docx")).toBe("推荐算法笔记");
    expect(titleFromFilename("my_notes.md")).toBe("my notes");
  });

  it("normalizeBlankLines 压掉多余空行", () => {
    expect(normalizeBlankLines("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(normalizeBlankLines("a   \nb")).toBe("a\nb");
  });

  it("estimateTokens 对中文给出保守估算", () => {
    // 150 个汉字 ≈ 100 token
    expect(estimateTokens("汉".repeat(150))).toBe(150);
  });

  it("looksLikeScan 识别「文件大但文字少」的扫描件", () => {
    expect(looksLikeScan("短", 5 * 1024 * 1024)).toBe(true);
    expect(looksLikeScan("很长的正文".repeat(100), 100 * 1024)).toBe(false);
  });
});
