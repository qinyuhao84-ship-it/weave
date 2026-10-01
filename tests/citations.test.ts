import { describe, it, expect } from "vitest";
import {
  validateCitations, collectCitations, expandRanges, detectNoAnswer,
  buildCitationViews, renderCitationAnchors, assessQuality,
} from "@/lib/chat/citations";
import type { ContextChunk } from "@/lib/llm/prompts";

function chunks(count: number): ContextChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    pageTitle: `词条${i + 1}`,
    pagePath: `wiki/entities/page-${i + 1}.md`,
    pageType: "entity",
    sourcePage: i + 1,
    sourceDoc: `raw/doc-${i + 1}.pdf`,
    content: `这是第 ${i + 1} 个片段的正文内容。`,
  }));
}

describe("validateCitations —— 标准形态", () => {
  it("合法的引用被保留并归一化", () => {
    const report = validateCitations("答案是甲 [ID:1]，依据是乙 [ID:2]。", chunks(3));
    expect(report.text).toBe("答案是甲 [ID:1]，依据是乙 [ID:2]。");
    expect(report.usedIndices).toEqual([1, 2]);
    expect(report.hallucinatedIndices).toEqual([]);
  });

  it("多个连续引用", () => {
    const report = validateCitations("综合来看 [ID:1][ID:3]。", chunks(3));
    expect(report.usedIndices).toEqual([1, 3]);
  });

  it("同一编号重复引用只记一次", () => {
    const report = validateCitations("前面 [ID:1]，后面又说 [ID:1]。", chunks(3));
    expect(report.usedIndices).toEqual([1]);
  });

  it("没有引用时不报错", () => {
    const report = validateCitations("这是一句常识性的话。", chunks(3));
    expect(report.usedIndices).toEqual([]);
    expect(assessQuality(report).hasNoCitations).toBe(true);
  });
});

describe("validateCitations —— 坏格式修复", () => {
  it("圆括号形态 (ID:1)", () => {
    const report = validateCitations("答案 (ID:1)。", chunks(3));
    expect(report.text).toContain("[ID:1]");
    expect(report.usedIndices).toEqual([1]);
  });

  it("全角方括号 【ID: 2】", () => {
    const report = validateCitations("答案【ID: 2】。", chunks(3));
    expect(report.text).toContain("[ID:2]");
    expect(report.usedIndices).toEqual([2]);
  });

  it("带 markdown 强调 (**ID:3**)", () => {
    const report = validateCitations("答案 (**ID:3**)。", chunks(3));
    expect(report.usedIndices).toEqual([3]);
  });

  it("ref 前缀形态", () => {
    const report = validateCitations("答案 ref2。", chunks(3));
    expect(report.usedIndices).toEqual([2]);
  });

  it("带空格的形态 [ID: 1]", () => {
    const report = validateCitations("答案 [ID: 1]。", chunks(3));
    expect(report.usedIndices).toEqual([1]);
  });

  it("修复过的标记被计数", () => {
    const report = validateCitations("答案 (ID:1) 与 [ID:2]。", chunks(3));
    expect(report.repairedCount).toBeGreaterThan(0);
  });
});

describe("validateCitations —— 范围展开", () => {
  it("[ID:1-3] 展开为三个独立标记", () => {
    const report = validateCitations("综合 [ID:1-3]。", chunks(5));
    expect(report.text).toContain("[ID:1]");
    expect(report.text).toContain("[ID:2]");
    expect(report.text).toContain("[ID:3]");
    expect(report.usedIndices).toEqual([1, 2, 3]);
  });

  it("范围超出上下文时截断到边界，不产生幻觉引用", () => {
    const report = validateCitations("综合 [ID:1-99]。", chunks(3));
    expect(report.usedIndices).toEqual([1, 2, 3]);
    expect(report.hallucinatedIndices).toEqual([]);
  });

  it("波浪号与「至」也识别", () => {
    expect(validateCitations("x [ID:1~2]", chunks(3)).usedIndices).toEqual([1, 2]);
    expect(validateCitations("x [ID:1至2]", chunks(3)).usedIndices).toEqual([1, 2]);
  });

  it("过大的范围不展开（防御异常输入）", () => {
    const report = validateCitations("x [ID:1-500]", chunks(600));
    expect(report.usedIndices.length).toBeLessThan(30);
  });
});

describe("validateCitations —— 幻觉引用剔除", () => {
  it("越界编号被剔除", () => {
    const report = validateCitations("答案 [ID:99]。", chunks(3));
    expect(report.text).not.toContain("[ID:99]");
    expect(report.hallucinatedIndices).toEqual([99]);
    expect(report.usedIndices).toEqual([]);
  });

  it("合法与越界混杂时只剔除越界的", () => {
    const report = validateCitations("甲 [ID:1]，乙 [ID:88]，丙 [ID:2]。", chunks(3));
    expect(report.text).toContain("[ID:1]");
    expect(report.text).toContain("[ID:2]");
    expect(report.text).not.toContain("[ID:88]");
    expect(report.hallucinatedIndices).toEqual([88]);
  });

  it("剔除后不留空括号", () => {
    const report = validateCitations("答案（[ID:99]）。", chunks(3));
    expect(report.text).not.toContain("()");
    expect(report.text).not.toContain("（）");
  });

  it("剔除后不留多余空格", () => {
    const report = validateCitations("答案 [ID:99] 后续", chunks(3));
    expect(report.text).not.toMatch(/\s{2,}/);
  });

  it("裸角标 [5] 被保留 —— 它可能是脚注或年份，不是引用", () => {
    const report = validateCitations("参见文献 [5] 的说法。", chunks(3));
    expect(report.text).toContain("[5]");
    expect(report.hallucinatedIndices).toEqual([]);
  });

  it("上下文为空时任何引用都是幻觉", () => {
    const report = validateCitations("答案 [ID:1]。", []);
    expect(report.text).not.toContain("[ID:1]");
    expect(report.hallucinatedIndices).toEqual([1]);
  });
});

describe("detectNoAnswer", () => {
  it("识别标准的无答案话术", () => {
    expect(detectNoAnswer("知识库里没有找到相关内容。")).toBe(true);
  });

  it("句中插了引用标记也能识别", () => {
    expect(detectNoAnswer("知识库里没有[ID:3]找到相关内容。")).toBe(true);
  });

  it("有答案时不误判", () => {
    expect(detectNoAnswer("张一鸣是字节跳动的创始人 [ID:1]。")).toBe(false);
  });

  it("前面有无答案话术后面有推测时仍算无答案", () => {
    expect(
      detectNoAnswer("知识库里没有找到相关内容。以下是我的推测：可能与此有关。"),
    ).toBe(true);
  });
});

describe("buildCitationViews 与 renderCitationAnchors", () => {
  const contextChunks = chunks(3);

  it("把编号映射回词条信息", () => {
    const views = buildCitationViews([1, 3], contextChunks, ["p1", "p2", "p3"]);
    expect(views).toHaveLength(2);
    expect(views[0].pageId).toBe("p1");
    expect(views[0].pageTitle).toBe("词条1");
    expect(views[1].pageId).toBe("p3");
  });

  it("带出原文页码，供跳转使用", () => {
    const views = buildCitationViews([2], contextChunks, ["p1", "p2", "p3"]);
    expect(views[0].sourcePage).toBe(2);
    expect(views[0].sourceDoc).toBe("raw/doc-2.pdf");
  });

  it("渲染成可点击的角标", () => {
    const views = buildCitationViews([1], contextChunks, ["p1", "p2", "p3"]);
    const html = renderCitationAnchors("答案 [ID:1]。", views);
    expect(html).toContain('data-citation="1"');
    expect(html).toContain('data-page-id="p1"');
    expect(html).toContain("citation-ref");
  });

  it("未知编号保持原样（等待后续校验处理）", () => {
    const html = renderCitationAnchors("答案 [ID:9]。", []);
    expect(html).toBe("答案 [ID:9]。");
  });

  it("词条标题里的引号被转义，不会破坏 HTML 属性", () => {
    const views = buildCitationViews([1], contextChunks, ["p1"]);
    views[0].pageTitle = '带"引号"的标题';
    const html = renderCitationAnchors("[ID:1]", views);
    expect(html).toContain("&quot;");
    expect(html).not.toContain('title="带"引号"的标题"');
  });
});

describe("assessQuality —— 幻觉率是可跟踪的指标", () => {
  it("全部合法时幻觉率为 0", () => {
    const quality = assessQuality(validateCitations("甲 [ID:1]，乙 [ID:2]。", chunks(3)));
    expect(quality.citationCount).toBe(2);
    expect(quality.hallucinationRate).toBe(0);
  });

  it("一半越界时幻觉率为 0.5", () => {
    const quality = assessQuality(validateCitations("甲 [ID:1]，乙 [ID:99]。", chunks(3)));
    expect(quality.hallucinationRate).toBe(0.5);
  });

  it("完全没有引用时标记出来", () => {
    const quality = assessQuality(validateCitations("纯常识回答。", chunks(3)));
    expect(quality.hasNoCitations).toBe(true);
  });
});

describe("expandRanges 与 collectCitations 的边界", () => {
  it("expandRanges 正确处理倒序范围", () => {
    const { text } = expandRanges("[ID:3-1]", 5);
    expect(text).toBe("[ID:3-1]");
  });

  it("collectCitations 不会重复计数同一个位置", () => {
    expect(collectCitations("[ID:1]")).toHaveLength(1);
  });

  it("collectCitations 按位置排序", () => {
    const found = collectCitations("第二 [ID:2] 第一 [ID:1]");
    expect(found.map((c) => c.index)).toEqual([2, 1]);
    expect(found[0].start).toBeLessThan(found[1].start);
  });
});
