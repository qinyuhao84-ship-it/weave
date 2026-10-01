import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "@/components/markdown/renderer";

/**
 * 双链的**渲染层**回归。
 *
 * 起因是一个真实缺陷：对话回答里的 [[算路科技]] 会原样带着双方括号漏给用户。
 * 根因不在插件，而在调用方 —— MarkdownRenderer 只有拿到 resolveWikilink 才注册
 * 双链插件，而对话那条调用路径没传，于是模型写的每个双链都成了字面量。
 *
 * 所以这里断言的是「渲染出来的 HTML 里不该再有 [[」，而不是插件内部的 AST ——
 * 那个漏传的 bug 恰恰在 AST 层完全看不出来。
 */

const resolve = (target: string) =>
  target === "算路科技" ? { pageId: "01ABC", title: "算路科技" } : null;

describe("对话回答里的双链", () => {
  it("能解析的渲染成可点击的胶囊，不能解析的退成普通文字 —— 双方括号一个不留", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownRenderer, {
        content: "[[算路科技]] 的核心交付物，另外 [[尚不存在的词条]] 还缺一份说明。",
        resolveWikilink: resolve,
        brokenWikilinks: "plain",
      }),
    );

    expect(html).not.toContain("[[");
    expect(html).not.toContain("]]");
    expect(html).toContain('class="wikilink"');
    expect(html).toContain("weave://page/01ABC");
    // 缺页的那个只剩文字，没有虚线、也没有链接
    expect(html).toContain("尚不存在的词条");
    expect(html).not.toContain("wikilink-broken");
  });

  it("代码块里的双链字面量不受影响 —— 讲 Markdown 语法的资料得能如实显示", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownRenderer, {
        content: "写法是 `[[词条名]]`：\n\n```\n[[示例]]\n```\n",
        resolveWikilink: resolve,
        brokenWikilinks: "plain",
      }),
    );

    expect(html).toContain("[[词条名]]");
    expect(html).toContain("[[示例]]");
  });

  it("词条页的默认行为不变：缺页仍然渲染成可点的虚线断链", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownRenderer, {
        content: "见 [[不存在的词条]]",
        resolveWikilink: resolve,
      }),
    );

    expect(html).toContain("wikilink-broken");
    expect(html).not.toContain("[[");
  });

  it("没有解析器时原样保留 —— 这正是对话页面当时的症状", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownRenderer, { content: "这是 [[算路科技]]。" }),
    );

    expect(html).toContain("[[算路科技]]");
  });
});
