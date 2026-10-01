import { visit } from "unist-util-visit";
import type { Root, Text, PhrasingContent } from "mdast";

/**
 * 把正文里的 [[双链]] 转成可点击的链接节点。
 *
 * 为什么用 remark 插件而不是正则替换 HTML：
 * 正则替换会把代码块、行内代码里的 [[字面量]] 也改掉 —— 一篇讲 Markdown 语法的
 * 笔记会被改得面目全非。走 AST 就天然只在文本节点上操作，代码块根本不在
 * 遍历范围内。
 */

export type WikilinkResolver = (target: string) => { pageId: string; title: string } | null;

const WIKILINK = /\[\[([^\[\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

export function remarkWikilinks(options: {
  resolve: WikilinkResolver;
  /**
   * 目标不存在时怎么渲染。
   *
   * "link"（默认）：渲染成虚线断链，点它去补建这个词条 —— 词条页用这个，
   *   因为读者正站在知识库里，缺页是一个可以立刻处理的信号。
   * "plain"：直接当普通文字，连双方括号一起消失 —— 对话回答用这个。
   *   回答里连着一串虚线词，读起来像排版坏了；而读者在那儿也无从补建，
   *   那个「缺页」的信号对他没有下一步动作可言。
   */
  broken?: "link" | "plain";
}) {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      const value = node.value;
      WIKILINK.lastIndex = 0;
      if (!WIKILINK.test(value)) return;
      WIKILINK.lastIndex = 0;

      const children: PhrasingContent[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = WIKILINK.exec(value)) !== null) {
        const [raw, target, , alias] = match;
        if (match.index > lastIndex) {
          children.push({ type: "text", value: value.slice(lastIndex, match.index) });
        }

        const resolved = options.resolve(target.trim());
        const display = alias?.trim() || target.trim();

        if (!resolved && (options.broken ?? "link") === "plain") {
          // 词条不存在：当作普通文字。不留下双方括号，也不留下链接语义
          children.push({ type: "text", value: display });
        } else {
          children.push({
            type: "link",
            url: resolved
              ? `weave://page/${resolved.pageId}`
              : `weave://missing/${encodeURIComponent(target.trim())}`,
            title: resolved ? resolved.title : `${target.trim()}（还没有这个词条）`,
            data: {
              hProperties: {
                className: resolved ? ["wikilink"] : ["wikilink", "wikilink-broken"],
                "data-page-id": resolved?.pageId ?? "",
                "data-target": target.trim(),
              },
            },
            children: [{ type: "text", value: display }],
          });
        }

        lastIndex = match.index + raw.length;
      }

      if (children.length === 0) return;
      if (lastIndex < value.length) {
        children.push({ type: "text", value: value.slice(lastIndex) });
      }

      parent.children.splice(index, 1, ...children);
      // 跳过刚插入的节点，避免重复处理
      return index + children.length;
    });
  };
}

/**
 * 把 [ID:n] 引用标记转成上标角标。
 *
 * 在 markdown 渲染阶段就转成 HTML，而不是渲染完再正则替换字符串 ——
 * 后者会把 <code> 与 <pre> 里的内容也改掉。
 */
export function remarkCitations(options: {
  citationIndices: Map<number, { pageId: string; title: string; sourcePage: number | null }>;
  /**
   * 上下文片段总数。超过这个编号的引用直接删掉。
   *
   * 为什么需要：流式输出时模型的越界引用（如 [ID:99]）会先被渲染出来，
   * 直到回答结束、后端校验完成后才消失 —— 用户会看到一次内容闪变。
   * 而「本次检索到几个片段」在流式开始前就知道了，所以可以提前隐掉。
   */
  stripOutOfRange?: number;
  pending?: boolean;
}) {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      const value = node.value;
      const pattern = /\[ID:(\d+)\]/g;
      if (!pattern.test(value)) return;
      pattern.lastIndex = 0;

      const children: PhrasingContent[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(value)) !== null) {
        const citationIndex = Number(match[1]);
        const meta = options.citationIndices.get(citationIndex);

        if (!meta && (!options.pending || citationIndex < 1 || (options.stripOutOfRange !== undefined && citationIndex > options.stripOutOfRange))) {
          // 完成校验后，不展示没有来源信息的内部标记。
          if (match.index > lastIndex) children.push({ type: "text", value: value.slice(lastIndex, match.index) });
          lastIndex = match.index + match[0].length;
          continue;
        }

        if (match.index > lastIndex) {
          children.push({ type: "text", value: value.slice(lastIndex, match.index) });
        }

        children.push({
          type: "emphasis",
          data: {
            hName: "sup",
            hProperties: {
              className: ["citation-ref"],
              "data-citation": String(citationIndex),
              ...(meta ? {
                "data-page-id": meta.pageId,
                ...(meta.sourcePage ? { "data-source-page": String(meta.sourcePage) } : {}),
                title: meta.title,
                role: "button",
                tabIndex: 0,
                "aria-label": `引用 ${citationIndex}：${meta.title}`,
              } : { title: "正在校验来源", "data-pending": "true" }),
            },
          },
          children: [{ type: "text", value: String(citationIndex) }],
        });

        lastIndex = match.index + match[0].length;
      }

      if (lastIndex === 0) return;
      if (lastIndex < value.length) {
        children.push({ type: "text", value: value.slice(lastIndex) });
      }

      parent.children.splice(index, 1, ...children);
      return index + children.length;
    });
  };
}
