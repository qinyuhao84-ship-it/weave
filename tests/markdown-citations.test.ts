import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDocument } from "@mixmark-io/domino";
import { expect, it } from "vitest";
import { MarkdownRenderer, type MarkdownRendererProps } from "@/components/markdown/renderer";

const citations = new Map([
  [1, { pageId: "one", title: "第一份来源", sourcePage: null }],
  [9, { pageId: "nine", title: "第九份来源", sourcePage: 3 }],
]);
const render = (props: MarkdownRendererProps) => createDocument(renderToStaticMarkup(createElement(MarkdownRenderer, props)));

it("连续引用渲染为有来源说明的可操作上标", () => {
  const dom = render({ content: "事实。[ID:1][ID:9]", citations });
  expect(Array.from(dom.querySelectorAll("sup")).map(node => node.textContent)).toEqual(["1", "9"]);
  expect(dom.body.textContent).not.toContain("[ID:");
  expect(dom.querySelector('sup[data-citation="9"]')?.getAttribute("aria-label")).toBe("引用 9：第九份来源");
  expect(dom.querySelector("sup")?.getAttribute("tabindex")).toBe("0");
});

it("流式输出的完整标记先显示上标，暂不伪造可点击来源", () => {
  const dom = render({ content: "事实。[ID:1]", citations: new Map(), pendingCitations: true });
  expect(dom.querySelector("sup")?.textContent).toBe("1");
  expect(dom.querySelector("sup")?.getAttribute("data-pending")).toBe("true");
  expect(dom.querySelector("sup")?.hasAttribute("role")).toBe(false);
});

it("无效引用被去除，包括正文只有一个无效标记的情况", () => {
  expect(render({ content: "[ID:99]", citations }).body.textContent).not.toContain("ID:");
  const dom = render({ content: "事实。[ID:9]", citations: new Map(), pendingCitations: true, validCitationRange: 2 });
  expect(dom.querySelector("sup")).toBeFalsy();
});

it("代码和没有引用上下文的普通文档保留原标记", () => {
  const dom = render({ content: "`[ID:1]`\n\n```text\n[ID:9]\n```\n\n事实。[ID:1]", citations });
  expect(Array.from(dom.querySelectorAll("code")).map(node => node.textContent?.trim())).toEqual(["[ID:1]", "[ID:9]"]);
  expect(dom.querySelectorAll("sup")).toHaveLength(1);
  expect(render({ content: "[ID:1]" }).body.textContent).toContain("[ID:1]");
});
