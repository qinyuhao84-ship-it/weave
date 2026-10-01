"use client";

import * as React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkWikilinks, remarkCitations, type WikilinkResolver } from "@/lib/markdown/wikilink-plugin";
import { cn } from "@/lib/utils";

/**
 * Markdown 渲染。
 *
 * 「统一渲染管线」是这里的关键约定：审阅 / 阅读 / 对话三处用的是同一个组件，
 * 所以「编辑时看到的」和「入库后看到的」永远一致 —— 不会出现审阅时排版正常、
 * 入库后表格塌掉这种最让人失去信任的问题。
 *
 * 双链与引用角标都在 AST 阶段处理（见 wikilink-plugin），不在 HTML 字符串上
 * 做正则替换 —— 后者会破坏代码块里的字面量。
 */

export type CitationMeta = {
  pageId: string;
  title: string;
  sourcePage: number | null;
};

export type MarkdownRendererProps = {
  content: string;
  /** 双链解析器：把 [[名字]] 解析成词条 id 与标题 */
  resolveWikilink?: WikilinkResolver;
  /**
   * 双链目标不存在时的渲染方式。默认虚线断链（词条页）；
   * 对话回答传 "plain" —— 那里出现一串虚线词像排版坏了，见 remarkWikilinks
   */
  brokenWikilinks?: "link" | "plain";
  /** 引用编号 → 词条信息，用于渲染角标 */
  citations?: Map<number, CitationMeta>;
  /** 点双链的回调；不传则用普通 <a> 行为 */
  onWikilinkClick?: (pageId: string, target: string) => void;
  /** 点引用角标的回调 */
  onCitationClick?: (index: number, meta: CitationMeta) => void;
  /** 流式输出时传入上下文片段总数，提前隐掉越界引用 */
  validCitationRange?: number;
  pendingCitations?: boolean;
  /**
   * 排版密度。
   *
   * 长文阅读（词条页）用 comfortable；卡片、预览这类「快速扫读」的容器用 compact；
   * 对话回答用 conversation —— 与长文同样 15.5px 正文，但标题收窄一档，
   * 因为对话里的 h2 是「这一段在说什么」，不是「这一章」。
   * 抽成 prop 而不是让调用方写 text-[13px]：字号只是密度的一个维度，
   * 行高与段距必须一起收，否则卡片会被撑得又高又散。
   * 具体数值由 app/globals.css 的 .prose-weave[data-density] 定义，这里只传意图。
   */
  density?: "comfortable" | "compact" | "conversation";
  className?: string;
};

/**
 * 重依赖按需加载。
 *
 * rehype-katex 与 rehype-highlight 加起来约 580KB —— katex 带着整套字体度量表，
 * hljs 带着全量语言包。它们原本是静态 import，于是 /wiki、/wiki/[id]、/chat
 * 每次首屏都要同步下载，哪怕页面上一个公式、一段代码都没有。
 *
 * 现在先探测内容里有没有公式或代码块，只有确实需要时才把对应插件拉进来重渲染一次。
 * 加载失败就保持轻量渲染 —— 排版差一点，但内容一个字都不会丢。
 * 公式的解析（remarkMath）也与 katex 插件一起等，避免同一段内容先以原文出现、
 * 再跳成公式的二次变化 —— 一次跳变比晚一点渲染更刺眼。
 */
export function MarkdownRenderer({
  content,
  resolveWikilink,
  brokenWikilinks = "link",
  citations,
  onWikilinkClick,
  onCitationClick,
  validCitationRange,
  pendingCitations = false,
  density = "comfortable",
  className,
}: MarkdownRendererProps) {
  const needsMath = React.useMemo(
    () => /(^|[^\\])\$[^$\n]+\$|\$\$/.test(content),
    [content],
  );
  const needsCode = React.useMemo(() => content.includes("```"), [content]);

  const [heavy, setHeavy] = React.useState<{ katex: unknown; highlight: unknown }>({
    katex: null,
    highlight: null,
  });

  React.useEffect(() => {
    let alive = true;
    if (needsMath && !heavy.katex) {
      void import("rehype-katex")
        .then((mod) => {
          if (alive) setHeavy((prev) => ({ ...prev, katex: mod.default }));
        })
        .catch(() => undefined);
    }
    if (needsCode && !heavy.highlight) {
      void import("rehype-highlight")
        .then((mod) => {
          if (alive) setHeavy((prev) => ({ ...prev, highlight: mod.default }));
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [needsMath, needsCode, heavy.katex, heavy.highlight]);

  const rehypePlugins = React.useMemo(() => {
    const plugins: unknown[] = [];
    if (heavy.katex) plugins.push(heavy.katex);
    // detect 关掉：让 hljs 逐块猜语言既慢又常猜错，只在围栏上显式标了语言时才高亮
    if (heavy.highlight) plugins.push([heavy.highlight, { detect: false, ignoreMissing: true }]);
    return plugins as never[];
  }, [heavy.katex, heavy.highlight]);

  const remarkPlugins = React.useMemo(() => {
    const plugins: unknown[] = [remarkGfm];
    if (heavy.katex) plugins.push(remarkMath);
    if (resolveWikilink) plugins.push([remarkWikilinks, { resolve: resolveWikilink, broken: brokenWikilinks }]);
    if (citations !== undefined) {
      plugins.push([
        remarkCitations,
        {
          citationIndices: citations,
          pending: pendingCitations,
          ...(validCitationRange !== undefined ? { stripOutOfRange: validCitationRange } : {}),
        },
      ]);
    }
    return plugins as never[];
  }, [resolveWikilink, brokenWikilinks, citations, validCitationRange, pendingCitations, heavy.katex]);

  /**
   * 让 weave:// 活下来。
   *
   * react-markdown 默认只放行 http/https/mailto 这类标准协议，其余一律清成空串。
   * 双链走的是自定义协议，于是 <a> 拿到的是 href="" —— 而 href="" 在浏览器里
   * 的含义是「当前地址」，点一个双链的结果是**当前页面重新加载一次**；
   * 上面 handleClick 里的 weave:// 分支则永远等不到匹配。
   * 也就是说：解析表修好了、插件也注册了，链接仍然点不动，只差这一步。
   */
  const urlTransform = React.useCallback((url: string) => {
    if (url.startsWith("weave://")) return url;
    return defaultUrlTransform(url);
  }, []);

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // 引用角标是 <sup> 不是 <a>，单独处理
      const citation = (event.target as HTMLElement).closest("sup.citation-ref");
      if (citation) {
        if (citation.hasAttribute("data-pending")) return;
        event.preventDefault();
        const index = Number(citation.getAttribute("data-citation"));
        const pageId = citation.getAttribute("data-page-id") ?? "";
        const sourcePage = citation.getAttribute("data-source-page");
        onCitationClick?.(index, {
          pageId,
          title: citation.getAttribute("title") ?? "",
          sourcePage: sourcePage ? Number(sourcePage) : null,
        });
        return;
      }
      const anchor = (event.target as HTMLElement).closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("weave://page/")) {
        event.preventDefault();
        onWikilinkClick?.(href.replace("weave://page/", ""), anchor.getAttribute("data-target") ?? "");
      } else if (href.startsWith("weave://missing/")) {
        event.preventDefault();
        onWikilinkClick?.("", anchor.getAttribute("data-target") ?? "");
      }
    },
    [onWikilinkClick, onCitationClick],
  );

  // 外部链接一律新窗口打开，且带上 noreferrer。
  //
  // node 必须显式摘掉：react-markdown 会往自定义组件里塞一个 node（AST 节点），
  // 它顺着 {...props} 落到 <a> 上就成了 node="[object Object]" —— 一个既非法
  // 又没人读的 DOM 属性，React 在开发模式还会为此报警告。
  const components = React.useMemo(
    () => ({
      a: ({
        href,
        children,
        node: _node,
        ...props
      }: React.ComponentPropsWithoutRef<"a"> & { node?: unknown }) => {
        const external = href && /^https?:\/\//.test(href);
        return (
          <a
            href={href}
            {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
            {...props}
          >
            {children}
          </a>
        );
      },
    }),
    [],
  );

  return (
    <div className={cn("prose-weave", className)} data-density={density} onClick={handleClick} onKeyDown={event => {
      if ((event.key === "Enter" || event.key === " ") && (event.target as HTMLElement).closest('sup.citation-ref[role="button"]')) {
        event.preventDefault();
        (event.target as HTMLElement).click();
      }
    }}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={urlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 轻量渲染器：只做基础 Markdown 渲染，不含双链与引用。
 * 用于列表摘要、卡片预览这类短文本 —— 不需要为此付出完整插件的代价。
 */
export function MarkdownPreview({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("prose-weave", className)} data-density="compact">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
