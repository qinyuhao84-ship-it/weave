import { describe, expect, it } from "vitest";
import { createDocument } from "@mixmark-io/domino";
import { basicHtml, formatHtmlCitations, HtmlAnswerStream, prepareHtml } from "@/lib/chat/artifacts";
import { HTML_START, HTML_END } from "@/lib/chat/html-guidance";
import { previewHtml } from "@/lib/documents/html";
import { installReadingStyle, READING_STYLE_ID } from "@/lib/documents/reading-style";
import type { ContextChunk } from "@/lib/llm/prompts";
import type { CitationView } from "@/lib/chat/citations";

const chunk: ContextChunk = { index: 1, pageTitle: "矩形面积", pagePath: "area.md", pageType: "concept", sourcePage: null, sourceDoc: null, content: "矩形面积等于长度乘以宽度。" };
const citation: CitationView = { index: 1, pageId: "area", pageTitle: "矩形面积", pagePath: "area.md", pageType: "concept", sourcePage: null, sourceDoc: null, excerpt: chunk.content, sourceRefs: [] };
const html = '<!DOCTYPE html><html lang="zh-CN"><head><title>矩形面积</title></head><body><main><h1>矩形面积</h1><p>面积等于长度乘以宽度。[ID:1]</p><p hidden id="explanation">长度不变时，面积随宽度增加。[ID:1][ID:999]</p><button aria-controls="explanation">展开解释</button></main><script>const spacing = "a  b";</script></body></html>';

describe("新阅读页的共用样式与引用", () => {
  it("为新页面加入可重复安装的样式，保留脚本和待展开内容的合法引用", () => {
    const result = prepareHtml(html, [chunk], [citation]);
    const document = createDocument(result);
    expect(document.documentElement.getAttribute("data-weave-reading")).toBe("1");
    expect(document.documentElement.hasAttribute("data-weave-theme")).toBe(false);
    expect(document.getElementById("explanation")?.querySelector("sup")?.textContent).toBe("1");
    expect(document.getElementById("explanation")?.textContent).not.toContain("999");
    expect(document.querySelector("script")?.textContent).toBe('const spacing = "a  b";');
    const style = document.getElementById(READING_STYLE_ID)?.textContent;
    installReadingStyle(document);
    expect(document.querySelectorAll(`#${READING_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(READING_STYLE_ID)?.textContent).toBe(style);
    expect(document.head.firstChild).toBe(document.getElementById(READING_STYLE_ID));
    expect(formatHtmlCitations(result, [citation])).toBe(result);
  });

  it("基础阅读版使用相同样式、默认可读并转义正文", () => {
    const document = createDocument(basicHtml('## 面积\n长度乘以宽度。\n\n<script>危险内容</script>', "矩形面积"));
    expect(document.getElementById(READING_STYLE_ID)).not.toBeNull();
    expect(document.querySelectorAll("details[open]")).toHaveLength(2);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.body.textContent).toContain("<script>危险内容</script>");
  });

  it("历史附件格式化时保留原配色和主题，下载内容不带预览消息脚本", () => {
    const legacy = createDocument(formatHtmlCitations(html, [citation]));
    expect(legacy.getElementById(READING_STYLE_ID)).toBeNull();
    expect(legacy.documentElement.hasAttribute("data-weave-reading")).toBe(false);
    const download = prepareHtml(html, [chunk], [citation]);
    expect(download).not.toContain("weave-artifact-theme");
    const preview = previewHtml(download);
    expect(preview).toContain("weave-artifact-theme");
    expect(preview).toContain("e.source!==parent");
    expect(preview).toContain("weave-artifact-ready");
    expect(createDocument(preview).documentElement.hasAttribute("data-weave-theme")).toBe(false);
  });
});

it("增强后的真实文档处理仍能逐字符分离正文和 HTML", () => {
  const stream = new HtmlAnswerStream();
  const output = `面积等于长度乘以宽度。${HTML_START}${html}${HTML_END}`;
  let text = "";
  for (const character of output) text += stream.push(character);
  text += stream.finish();
  expect(text).toBe("面积等于长度乘以宽度。");
  expect(stream.complete).toBe(true);
  const document = createDocument(prepareHtml(stream.html, [chunk], [citation]));
  expect(document.querySelector("main p sup a")?.getAttribute("href")).toBe("#weave-source-1");
});
