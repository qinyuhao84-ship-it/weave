import { describe, expect, it } from "vitest";
import {
  normalizeQuestion, parseQuestion, normalizeAnswer, MAX_OPTIONS, MAX_ANSWER_LENGTH,
} from "@/lib/review/questions";

/**
 * 「事项配的问题 + 候选答案」的确定性净化。
 *
 * 这组用例守的是一件事：模型给不出有区分度的选项时，代码必须把它清干净、让界面
 * 退回旧交互，而不是把一个雷同或复述性的问题摆到用户面前。硬凑的问题比没有
 * 问题更糟 —— 它会让用户以为必须选一个才能往下走。
 */

const TITLE = "「算路科技」的成立年份与资料冲突";
const QUESTION = "以哪个说法为准？";

function option(id: string, label: string, impact = "会改写《算路科技》正文") {
  return { id, label, impact };
}

describe("normalizeQuestion", () => {
  it("正常的问题与选项原样保留", () => {
    const result = normalizeQuestion(
      {
        question: QUESTION,
        options: [
          option("a", "以工商登记为准，改成 2021 年"),
          option("b", "以词条现有说法为准", "不改词条，这条按「口径不变」记下"),
        ],
      },
      TITLE,
    );

    expect(result.question).toBe(QUESTION);
    expect(result.options).toHaveLength(2);
    expect(result.options[0].label).toBe("以工商登记为准，改成 2021 年");
    expect(result.options[1].impact).toBe("不改词条，这条按「口径不变」记下");
    expect(result.dropped).toEqual([]);
  });

  it("短选项只认完全相同，绝不因为一个字包含就删掉语义相反的选项", () => {
    // 「不是」包含「是」。早期实现用包含关系判重，于是「不是」被判成与「是」重复、
    // 直接从用户眼前消失了 —— 一条把有效选项删掉的规则比漏判危险得多。
    const result = normalizeQuestion(
      { question: QUESTION, options: [option("a", "是"), option("b", "不是"), option("c", "不确定")] },
      TITLE,
    );
    expect(result.options.map((o) => o.label)).toEqual(["是", "不是", "不确定"]);
    expect(result.dropped).toEqual([]);
  });

  it("短选项的完全相同判定忽略标点与空白", () => {
    const result = normalizeQuestion(
      { question: QUESTION, options: [option("a", "是"), option("b", " 是。 "), option("c", "不是")] },
      TITLE,
    );
    expect(result.options.map((o) => o.label)).toEqual(["是", "不是"]);
    expect(result.dropped.some((d) => d.includes("同一个意思"))).toBe(true);
  });

  it("长选项靠相似度判重", () => {
    const result = normalizeQuestion(
      {
        question: QUESTION,
        options: [
          option("a", "以工商登记为准，把成立年份改成 2021 年"),
          option("b", "以工商登记为准，把成立年份改成 2021 年。"),
          option("c", "两个都不对，我再想想"),
        ],
      },
      TITLE,
    );
    expect(result.options.map((o) => o.id)).toEqual(["a", "c"]);
  });

  it("去重后不足两个选项时，整组清空并退回旧交互", () => {
    const result = normalizeQuestion(
      { question: QUESTION, options: [option("a", "是"), option("b", " 是。 ")] },
      TITLE,
    );
    expect(result.question).toBeNull();
    expect(result.options).toEqual([]);
  });

  it("问题只是在复述标题时置空，选项一并清空", () => {
    const result = normalizeQuestion(
      {
        question: TITLE,
        options: [option("a", "以工商登记为准"), option("b", "以词条现有说法为准")],
      },
      TITLE,
    );
    expect(result.question).toBeNull();
    expect(result.options).toEqual([]);
    expect(result.dropped.some((d) => d.includes("复述"))).toBe(true);
  });

  it("没有问题配套的选项是悬空的，一并清空", () => {
    const result = normalizeQuestion(
      { question: "  ", options: [option("a", "甲"), option("b", "乙")] },
      TITLE,
    );
    expect(result).toEqual({ question: null, options: [], dropped: ["选项（没有配套的问题）"] });
  });

  it("id 缺失时按位置补一个确定性的短标识（作答回填要用）", () => {
    const result = normalizeQuestion(
      { question: QUESTION, options: [{ label: "甲" }, { label: "乙" }] },
      TITLE,
    );
    expect(result.options.map((o) => o.id)).toEqual(["opt1", "opt2"]);
  });

  it("id 重复只留第一条", () => {
    const result = normalizeQuestion(
      { question: QUESTION, options: [option("a", "甲"), option("a", "乙"), option("b", "丙")] },
      TITLE,
    );
    expect(result.options.map((o) => o.label)).toEqual(["甲", "丙"]);
    expect(result.dropped.some((d) => d.includes("id 与前面的选项重复"))).toBe(true);
  });

  it("没有文字的选项直接丢掉", () => {
    const result = normalizeQuestion(
      { question: QUESTION, options: [option("a", "  "), option("b", "甲"), option("c", "乙")] },
      TITLE,
    );
    expect(result.options.map((o) => o.id)).toEqual(["b", "c"]);
    expect(result.dropped).toContain("没有文字的选项");
  });

  it("超过上限的选项被截断", () => {
    const result = normalizeQuestion(
      {
        question: QUESTION,
        options: ["甲", "乙", "丙", "丁", "戊", "己"].map((label, i) => option(`o${i}`, label)),
      },
      TITLE,
    );
    expect(result.options).toHaveLength(MAX_OPTIONS);
    expect(result.dropped.some((d) => d.includes("最多"))).toBe(true);
  });

  it("空输入返回「没有问题」，不报错", () => {
    expect(normalizeQuestion(null, TITLE)).toEqual({ question: null, options: [], dropped: [] });
    expect(normalizeQuestion({}, TITLE)).toEqual({ question: null, options: [], dropped: [] });
  });
});

describe("parseQuestion", () => {
  it("坏 JSON 当作没有 —— 界面不该因为一行脏数据整页崩掉", () => {
    expect(parseQuestion("以哪个为准？", "{不是 JSON")).toEqual({
      question: "以哪个为准？",
      options: [],
    });
  });

  it("落库的选项不足两个等于没有", () => {
    const json = JSON.stringify([{ id: "a", label: "甲", impact: "" }]);
    expect(parseQuestion("以哪个为准？", json).options).toEqual([]);
  });

  it("形状不对的条目被过滤，其余照常读出", () => {
    const json = JSON.stringify([
      { id: "a", label: "甲", impact: "" },
      { id: "", label: "乙", impact: "" },
      null,
      { id: "c", label: "丙", impact: "" },
    ]);
    expect(parseQuestion("以哪个为准？", json).options.map((o) => o.id)).toEqual(["a", "c"]);
  });

  it("没有问题文本时选项一律不返回", () => {
    const json = JSON.stringify([
      { id: "a", label: "甲", impact: "" },
      { id: "b", label: "乙", impact: "" },
    ]);
    expect(parseQuestion(null, json)).toEqual({ question: null, options: [] });
  });
});

describe("normalizeAnswer", () => {
  const options = [
    { id: "a", label: "以工商登记为准", impact: "" },
    { id: "b", label: "以词条现有说法为准", impact: "" },
  ];

  it("选中选项时用选项的 label，而不是前端传来的文本", () => {
    expect(normalizeAnswer({ answer: "随便写点什么", choiceId: "a", options })).toEqual({
      answer: "以工商登记为准",
      choiceId: "a",
      source: "option",
    });
  });

  it("选中项在当前选项里不存在时，降级为自由输入而不是拒绝", () => {
    // 选项可能在这期间被重新生成过，但用户那句话里的意图还在
    expect(normalizeAnswer({ answer: "我自己判断", choiceId: "gone", options })).toEqual({
      answer: "我自己判断",
      choiceId: null,
      source: "freeform",
    });
  });

  it("空答复返回 null", () => {
    expect(normalizeAnswer({ answer: "   ", options })).toBeNull();
    expect(normalizeAnswer({ answer: null, choiceId: "gone", options })).toBeNull();
  });

  it("超长答复被截断", () => {
    const result = normalizeAnswer({ answer: "字".repeat(MAX_ANSWER_LENGTH + 200), options });
    expect(result?.answer).toHaveLength(MAX_ANSWER_LENGTH);
  });
});
