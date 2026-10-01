import { describe, it, expect } from "vitest";
import {
  extractWikilinks,
  rewriteWikilinks,
  countLinksTo,
  normalizeLinkTarget,
  protectedRanges,
  stripWikilinks,
} from "@/lib/vault/wikilinks";

describe("extractWikilinks", () => {
  it("提取基本双链", () => {
    const links = extractWikilinks("这是 [[张一鸣]] 的词条");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("张一鸣");
    expect(links[0].raw).toBe("[[张一鸣]]");
  });

  it("提取带别名的双链", () => {
    const links = extractWikilinks("参见 [[张一鸣|老张]] 的说明");
    expect(links[0].target).toBe("张一鸣");
    expect(links[0].alias).toBe("老张");
  });

  it("提取带小节的链接", () => {
    const links = extractWikilinks("见 [[推荐算法#协同过滤]]");
    expect(links[0].target).toBe("推荐算法");
    expect(links[0].heading).toBe("协同过滤");
  });

  it("同时带小节与别名", () => {
    const links = extractWikilinks("见 [[推荐算法#协同过滤|推荐]]");
    expect(links[0].target).toBe("推荐算法");
    expect(links[0].heading).toBe("协同过滤");
    expect(links[0].alias).toBe("推荐");
  });

  it("提取多条", () => {
    const links = extractWikilinks("[[A]] 与 [[B]] 和 [[C|丙]]");
    expect(links.map((l) => l.target)).toEqual(["A", "B", "C"]);
  });

  it("忽略围栏代码块里的双链 —— 这是最容易出错的地方", () => {
    const content = "说明文字\n\n```\n[[这是代码里的字面量]]\n```\n\n真实的 [[链接]]";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("链接");
  });

  it("忽略行内代码里的双链", () => {
    const content = "语法是 `[[目标]]`，实例如 [[张一鸣]]";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("张一鸣");
  });

  it("忽略波浪号围栏代码块", () => {
    const content = "~~~\n[[代码里的]]\n~~~\n\n[[真的]]";
    expect(extractWikilinks(content).map((l) => l.target)).toEqual(["真的"]);
  });

  it("支持缩进的围栏代码块", () => {
    const content = "- 列表项\n\n  ```\n  [[代码里的]]\n  ```\n\n[[真的]]";
    expect(extractWikilinks(content).map((l) => l.target)).toEqual(["真的"]);
  });

  it("空链接与仅有空白的链接被跳过", () => {
    expect(extractWikilinks("[[]] 与 [[   ]]")).toHaveLength(0);
  });

  it("嵌套方括号不会误匹配", () => {
    expect(extractWikilinks("[[a]b]]")).toHaveLength(0);
  });

  it("记录正确的字符偏移", () => {
    const content = "前缀 [[目标]] 后缀";
    const link = extractWikilinks(content)[0];
    expect(content.slice(link.start, link.end)).toBe("[[目标]]");
  });
});

describe("rewriteWikilinks", () => {
  it("按映射重写目标名", () => {
    const result = rewriteWikilinks("见 [[张三]] 与 [[李四]]", (t) =>
      t === "张三" ? "张三丰" : null,
    );
    expect(result.content).toBe("见 [[张三丰]] 与 [[李四]]");
    expect(result.changed).toBe(1);
  });

  it("重写时保留别名", () => {
    const result = rewriteWikilinks("见 [[张三|老张]]", () => "张三丰");
    expect(result.content).toBe("见 [[张三丰|老张]]");
  });

  it("重写时保留小节", () => {
    const result = rewriteWikilinks("见 [[张三#生平]]", () => "张三丰");
    expect(result.content).toBe("见 [[张三丰#生平]]");
  });

  it("重写时同时保留小节与别名", () => {
    const result = rewriteWikilinks("见 [[张三#生平|老张]]", () => "张三丰");
    expect(result.content).toBe("见 [[张三丰#生平|老张]]");
  });

  it("大小写不敏感匹配", () => {
    const result = rewriteWikilinks("见 [[transformer]]", (t) =>
      t === "transformer" ? "Transformer架构" : null,
    );
    expect(result.content).toBe("见 [[Transformer架构]]");
  });

  it("不改动代码块里的字面量", () => {
    const content = "```\n[[张三]]\n```\n\n真的 [[张三]]";
    const result = rewriteWikilinks(content, () => "张三丰");
    expect(result.content).toBe("```\n[[张三]]\n```\n\n真的 [[张三丰]]");
  });

  it("同一目标出现多次全部重写，且偏移不失效", () => {
    const content = "[[张三]] 开头，中间 [[李四]]，结尾又是 [[张三]]";
    const result = rewriteWikilinks(content, (t) => (t === "张三" ? "张三丰" : null));
    expect(result.content).toBe("[[张三丰]] 开头，中间 [[李四]]，结尾又是 [[张三丰]]");
    expect(result.changed).toBe(2);
  });

  it("目标变长时后续链接的偏移依然正确", () => {
    const content = "[[A]] 然后 [[B]]";
    const result = rewriteWikilinks(content, (t) => (t === "a" ? "非常长的目标名称" : "另一个很长的名字"));
    expect(result.content).toBe("[[非常长的目标名称]] 然后 [[另一个很长的名字]]");
  });

  it("返回改写明细", () => {
    const result = rewriteWikilinks("[[张三]]", () => "张三丰");
    expect(result.rewrites).toEqual([{ from: "张三", to: "张三丰" }]);
  });

  it("无匹配时原样返回", () => {
    const content = "没有链接的文本";
    expect(rewriteWikilinks(content, () => "X").content).toBe(content);
  });
});

describe("stripWikilinks —— 把内部写法还原成人读的文字", () => {
  it("去掉方括号，保留别名优先的显示名", () => {
    expect(stripWikilinks("见 [[张一鸣]] 与 [[张一鸣|老张]]。")).toBe("见 张一鸣 与 老张。");
  });

  it("代码区间里的字面量不动 —— 引文可能在讲 Markdown 语法", () => {
    const text = "写法是 `[[词条名]]`：\n\n```\n[[示例]]\n```\n";
    expect(stripWikilinks(text)).toBe(text);
  });

  it("没有双链时原样返回", () => {
    expect(stripWikilinks("一段普通文字。")).toBe("一段普通文字。");
  });
});

describe("countLinksTo 与 normalizeLinkTarget", () => {
  it("统计指向某词条的链接数", () => {
    expect(countLinksTo("[[张三]] 和 [[张三|老张]] 以及 [[李四]]", "张三")).toBe(2);
  });

  it("归一化折叠空白并小写", () => {
    expect(normalizeLinkTarget("  Zhang  Yi Ming  ")).toBe("zhang yi ming");
  });
});

describe("protectedRanges", () => {
  it("识别围栏与行内代码", () => {
    const ranges = protectedRanges("`行内` 和\n```\n围栏\n```");
    expect(ranges.length).toBe(2);
  });
});

/**
 * 导入 prompt 从「紧凑散文」改成「分节 + 列表」之后，词条正文里会出现
 * ## 标题、- / 1. 列表、| 表格 |、> 引用块、**粗体**。
 *
 * 这一组用例钉死一件事：这些语法都不能影响双链提取。
 * 反向链接、改名时重写全库引用、死链检测全都建立在 extractWikilinks 之上 ——
 * 提取一旦漏掉列表项或标题行里的链接，改名后就会静默产生死链，
 * 而这正是 CLAUDE.md 里点名要防的那类问题。
 */
describe("结构化正文里的双链（导入产出的新格式）", () => {
  const structured = `[[算路科技]] 的 B 端项目，面向 [[专精特新「小巨人」]] 申报。

## 定位与角色

- 场景：面向 [[专精特新「小巨人」]] 申报中的市占率报告交付
- 角色：项目主导（参见 [[PI Agent]]）

## 工程优化

1. 搜索层用 [[混合检索（语义 + 关键词）]]，由 [[Exa]] 与 [[Brave]] 并行召回
2. 抓取走 [[多级抓取回退链路]]，含 [[Jina]] 与 [[Crawl4AI]]

| 指标 | 口径 |
| --- | --- |
| [[抓取成功率]] | 有效来源数 ÷ 尝试总数 |

> 引用块里也要能提取：[[Workflow 与 Skill 的分工架构]]

**粗体里也要能提取：[[证据缓存]]**
`;

  it("标题、列表、表格、引用块、粗体里的双链都能提取到", () => {
    const targets = extractWikilinks(structured).map((l) => l.target);
    for (const expected of [
      "算路科技",
      "专精特新「小巨人」",
      "PI Agent",
      "混合检索（语义 + 关键词）",
      "Exa",
      "Brave",
      "多级抓取回退链路",
      "Jina",
      "Crawl4AI",
      "抓取成功率",
      "Workflow 与 Skill 的分工架构",
      "证据缓存",
    ]) {
      expect(targets, `漏掉了 ${expected}`).toContain(expected);
    }
  });

  it("同一目标多次出现时每次都提取到（改名的重写依赖每个位置）", () => {
    const links = extractWikilinks(structured);
    expect(links.filter((l) => l.target === "专精特新「小巨人」")).toHaveLength(2);
  });

  it("小节标题的 # 不会被当成链接里的小节分隔符", () => {
    // `## 定位与角色` 与 `[[目标#小节]]` 用的是同一个字符，
    // 提取器必须只认方括号里的那一个。
    const links = extractWikilinks(structured);
    expect(links.every((l) => l.heading === undefined)).toBe(true);
  });

  it("改名重写能覆盖到列表与标题之间的全部链接", () => {
    const { content, changed } = rewriteWikilinks(structured, (t) =>
      t === "专精特新「小巨人」" ? "专精特新小巨人" : null,
    );
    expect(changed).toBe(2);
    expect(content).toContain("[[专精特新小巨人]] 申报");
    expect(content).toContain("- 场景：面向 [[专精特新小巨人]] 申报");
    expect(content).not.toContain("专精特新「小巨人」");
  });

  it("代码块与行内 code 里的 [[字面量]] 仍然不算链接", () => {
    const withCode = `${structured}
\`\`\`
[[这不是链接]]
\`\`\`

用 \`[[双链]]\` 建立连接。
`;
    const targets = extractWikilinks(withCode).map((l) => l.target);
    expect(targets).not.toContain("这不是链接");
    expect(targets).not.toContain("双链");
  });
});
