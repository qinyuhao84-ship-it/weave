import { describe, it, expect, beforeEach } from "vitest";
import {
  runMechanicalChecks, runLint, listReviewItems, decideReviewItem, countPendingReviewItems,
  countOpenReviewItems, answerReviewItem, claimReviewItems, releaseReviewItems,
} from "@/lib/lint";
import { reindexAll } from "@/lib/index/reindex";
import { eq } from "drizzle-orm";
import { dropAllIndexTables, getDb } from "@/lib/db/client";
import { reviewItems } from "@/lib/db/schema";
import { deletePage } from "@/lib/vault/service";
import { FakeProvider } from "@/lib/llm/fake";
import { writePage, frontmatterFor, resetVault } from "./helpers";

function fakeLintFindings(findings: unknown[] = []) {
  return JSON.stringify({ findings });
}

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

/** 造一条审阅事项：一个指向不存在词条的引用就是一条 missing_page */
async function seedItem() {
  writePage("a", frontmatterFor("01A", "甲"), "参见 [[根本没有的词条]]。");
  reindexAll();
  await runLint({ mechanicalOnly: true });
  return listReviewItems("pending")[0];
}

describe("runMechanicalChecks —— 程序能算的绝不交给模型", () => {
  it("发现被引用但没有词条的名字（缺页）", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[根本没有的词条]]。");
    reindexAll();

    const findings = runMechanicalChecks();
    const missing = findings.find((f) => f.kind === "missing_page");
    expect(missing).toBeTruthy();
    expect(missing!.title).toContain("根本没有的词条");
    expect(missing!.detail).toContain("甲");
  });

  it("区分「从未存在」与「被删过」", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[乙]]。");
    writePage("b", frontmatterFor("01B", "乙"), "正文");
    reindexAll();
    deletePage("01B", { kind: "keep_dangling" });

    const findings = runMechanicalChecks();
    const broken = findings.find((f) => f.kind === "broken_link");
    expect(broken).toBeTruthy();
    expect(broken!.title).toContain("已被删除");
    expect(broken!.severity).toBe("warning");
  });

  it("发现孤儿页", () => {
    writePage("a", frontmatterFor("01A", "甲"), "正文，没有任何链接。");
    writePage("b", frontmatterFor("01B", "乙"), "参见 [[甲]]。");
    writePage("c", frontmatterFor("01C", "孤立者"), "没人引用我。");
    reindexAll();

    const findings = runMechanicalChecks();
    const orphan = findings.find((f) => f.kind === "orphan");
    expect(orphan).toBeTruthy();
    expect(orphan!.detail).toContain("孤立者");
    expect(orphan!.detail).not.toContain("「甲」");
  });

  it("来源页不算孤儿（它们本就常常孤立）", () => {
    writePage("s", frontmatterFor("01S", "某来源", { type: "source" }), "正文");
    reindexAll();
    const findings = runMechanicalChecks();
    expect(findings.find((f) => f.kind === "orphan")).toBeUndefined();
  });

  it("健康的知识库不产生噪音", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[乙]]。");
    writePage("b", frontmatterFor("01B", "乙"), "参见 [[甲]]。");
    reindexAll();

    const findings = runMechanicalChecks();
    expect(findings.filter((f) => f.kind === "missing_page")).toHaveLength(0);
    expect(findings.filter((f) => f.kind === "orphan")).toHaveLength(0);
    expect(findings.filter((f) => f.kind === "broken_link")).toHaveLength(0);
  });

  it("空知识库不报错", () => {
    expect(runMechanicalChecks()).toEqual([]);
  });
});

describe("runLint —— 完整体检", () => {
  beforeEach(() => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[乙]] 与 [[不存在者]]。");
    writePage("b", frontmatterFor("01B", "乙"), "正文内容。");
    reindexAll();
  });

  it("客观检查在模型不可用时依然完成", async () => {
    const report = await runLint({ mechanicalOnly: true });
    expect(report.mechanical.length).toBeGreaterThan(0);
    expect(report.llmSkipped).toBe(true);
  });

  it("模型不可用时不抛异常，只是跳过主观检查", async () => {
    const report = await runLint();
    expect(report.llmSkipped).toBe(true);
    expect(report.llm).toEqual([]);
  });

  it("模型可用时归并主观发现", async () => {
    const provider = new FakeProvider({
      responses: [fakeLintFindings([
        {
          kind: "contradiction",
          title: "「甲」与「乙」对同一件事说法矛盾",
          detail: "甲说 X，乙说非 X。",
          severity: "warning",
          relatedTitles: ["甲", "乙"],
          suggestion: "核对来源后统一表述",
        },
      ])],
    });

    const report = await runLint({ provider });
    expect(report.llm).toHaveLength(1);
    expect(report.llm[0].kind).toBe("contradiction");
    expect(report.llmSkipped).toBe(false);
  });

  it("统计图谱规模", async () => {
    const report = await runLint({ mechanicalOnly: true });
    expect(report.stats.pages).toBe(2);
    expect(report.stats.edges).toBeGreaterThan(0);
  });

  it("体检写进操作日志", async () => {
    await runLint({ mechanicalOnly: true });
    const { readPageRaw } = await import("./helpers");
    expect(readPageRaw("log.md")).toContain("LINT");
  });
});

describe("审阅队列", () => {
  beforeEach(() => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[不存在者]]。");
    reindexAll();
  });

  it("缺页问题进入队列", async () => {
    await runLint({ mechanicalOnly: true });
    const items = listReviewItems("pending");
    expect(items.some((i) => i.kind === "missing_page")).toBe(true);
  });

  it("反复体检不会重复入队 —— 否则队列会变成噪音", async () => {
    await runLint({ mechanicalOnly: true });
    const first = listReviewItems("pending").length;
    await runLint({ mechanicalOnly: true });
    await runLint({ mechanicalOnly: true });
    expect(listReviewItems("pending").length).toBe(first);
  });

  it("把旧版已有修订记录却仍标记待处理的问题归档", () => {
    const id = "legacy-completed-review";
    getDb().insert(reviewItems).values({
      id,
      kind: "research",
      title: "已处理的旧事项",
      severity: "info",
      status: "pending",
      decisionNote: "保留现状",
      remediationJson: JSON.stringify({
        summary: "现状符合要求",
        edits: [],
        created: [],
        rejected: [],
        noChangeReason: "无需修改",
        commits: 0,
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
    }).run();

    expect(listReviewItems("pending").some((item) => item.id === id)).toBe(false);
    const archived = listReviewItems("accepted").find((item) => item.id === id);
    expect(archived?.status).toBe("accepted");
    expect(archived?.resolvedAt).toBeTruthy();
    expect(getDb().select().from(reviewItems).where(eq(reviewItems.id, id)).get()?.status).toBe("accepted");
  });

  it("程序检测到的孤儿页也能进入统一处理队列", async () => {
    writePage("orphan", frontmatterFor("01ORPH", "无人引用"), "正文");
    reindexAll();
    await runLint({ mechanicalOnly: true });

    const items = listReviewItems("pending");
    expect(items.some((i) => i.kind === "orphan")).toBe(true);
    expect(items.every((i) => i.kind === "missing_page" || i.kind === "broken_link" || i.kind === "orphan")).toBe(true);
  });

  it("待办数量可统计", async () => {
    await runLint({ mechanicalOnly: true });
    expect(countPendingReviewItems()).toBeGreaterThan(0);
  });

  it("采纳：离开待裁决，进已采纳", async () => {
    await runLint({ mechanicalOnly: true });
    const item = listReviewItems("pending")[0];
    decideReviewItem(item.id, "accepted");
    expect(listReviewItems("pending").some((i) => i.id === item.id)).toBe(false);
    expect(listReviewItems("accepted").some((i) => i.id === item.id)).toBe(true);
  });

  it("忽略：离开待裁决，进已忽略", async () => {
    await runLint({ mechanicalOnly: true });
    const item = listReviewItems("pending")[0];
    decideReviewItem(item.id, "dismissed");
    expect(listReviewItems("dismissed").some((i) => i.id === item.id)).toBe(true);
  });

  it("裁决过的事情不再重复入队 —— 否则用户每体检一次就要重裁一遍", async () => {
    await runLint({ mechanicalOnly: true });
    const item = listReviewItems("pending")[0];
    decideReviewItem(item.id, "dismissed");

    const before = listReviewItems("all").length;
    await runLint({ mechanicalOnly: true });

    // 队列没有变长 —— 被忽略的那条没有被重新插一遍
    expect(listReviewItems("all").length).toBe(before);
    expect(listReviewItems("pending").some((i) => i.title === item.title)).toBe(false);
  });

  it("收回裁决：回到待裁决，说明一并清掉", async () => {
    await runLint({ mechanicalOnly: true });
    const item = listReviewItems("pending")[0];
    decideReviewItem(item.id, "accepted", "以甲的说法为准");
    expect(listReviewItems("accepted")[0].decisionNote).toBe("以甲的说法为准");

    decideReviewItem(item.id, "pending");
    const back = listReviewItems("pending").find((i) => i.id === item.id);
    expect(back).toBeTruthy();
    // 作废的判断不能留在库里 —— 下一轮模型会照着它行事
    expect(back!.decisionNote).toBeNull();
    expect(back!.resolvedAt).toBeNull();
  });

  it("模型给的问题与选项经净化后入库", async () => {
    const provider = new FakeProvider({
      responses: [
        fakeLintFindings([
          {
            kind: "contradiction",
            title: "成立年份对不上",
            detail: "资料说 2012，词条说 2013。",
            severity: "warning",
            relatedTitles: [],
            suggestion: "",
            question: "以哪个说法为准？",
            options: [
              { id: "a", label: "以工商登记为准，改成 2012 年", impact: "改写《字节跳动》正文" },
              { id: "b", label: "以词条现有说法为准", impact: "不改词条，只记下口径" },
            ],
          },
        ]),
      ],
    });
    await runLint({ provider });

    const item = listReviewItems("pending")[0];
    expect(item.question).toBe("以哪个说法为准？");
    expect(item.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(item.options[0].impact).toBe("改写《字节跳动》正文");
  });

  it("雷同选项与复述性问题在入库前就被丢掉", async () => {
    const provider = new FakeProvider({
      responses: [
        fakeLintFindings([
          {
            kind: "contradiction",
            title: "成立年份对不上",
            detail: "细节",
            severity: "warning",
            relatedTitles: [],
            suggestion: "",
            // 问题就是在复述标题，选项里两个只有一个字之差
            question: "成立年份对不上",
            options: [
              { id: "a", label: "是", impact: "" },
              { id: "b", label: " 是。 ", impact: "" },
            ],
          },
        ]),
      ],
    });
    await runLint({ provider });

    const item = listReviewItems("pending")[0];
    expect(item.question).toBeNull();
    expect(item.options).toEqual([]);
  });

  it("回答写进 answer、状态变 answered，但不算结案", async () => {
    const item = await seedItem();

    expect(answerReviewItem(item.id, { answer: "以工商登记为准" })).toEqual({ ok: true });

    const answered = listReviewItems("answered").find((i) => i.id === item.id)!;
    expect(answered.answer).toBe("以工商登记为准");
    expect(answered.answerSource).toBe("freeform");
    expect(answered.answerChoiceId).toBeNull();
    // 回答不等于结案：resolvedAt 仍为空，recentDecisions 因此读不到它 ——
    // 它要等到批量处理完成，才以 decision_note 的身份进入回灌
    expect(answered.resolvedAt).toBeNull();
    expect(listReviewItems("pending").some((i) => i.id === item.id)).toBe(false);
  });

  it("选中选项时存的是选项的 label 与 id，不是前端传来的文本", async () => {
    const item = await seedItem();
    const options = [
      { id: "a", label: "以工商登记为准", impact: "改写正文" },
      { id: "b", label: "以现有说法为准", impact: "不改" },
    ];
    // 直接构造带选项的事项（正常路径下由模型产出，见 lib/review/questions.ts）
    getDb()
      .update(reviewItems)
      .set({ question: "以哪个说法为准？", optionsJson: JSON.stringify(options) })
      .where(eq(reviewItems.id, item.id))
      .run();

    answerReviewItem(item.id, { answer: "随便", choiceId: "a" });
    const answered = listReviewItems("answered").find((i) => i.id === item.id)!;
    expect(answered.answer).toBe("以工商登记为准");
    expect(answered.answerChoiceId).toBe("a");
    expect(answered.answerSource).toBe("option");
  });

  it("空答复被拒绝", async () => {
    const item = await seedItem();
    const result = answerReviewItem(item.id, { answer: "   " });
    expect(result.ok).toBe(false);
    expect(listReviewItems("answered")).toHaveLength(0);
  });

  it("正在处理中的事项拒绝改答案", async () => {
    const item = await seedItem();
    answerReviewItem(item.id, { answer: "第一版" });
    claimReviewItems("job1", [item.id]);

    const result = answerReviewItem(item.id, { answer: "改主意了" });
    expect(result.ok).toBe(false);
    expect(listReviewItems("answered")[0].answer).toBe("第一版");
  });

  it("认领只拿得走「已回答且无人处理」的事项", async () => {
    const item = await seedItem();
    expect(claimReviewItems("job1", [item.id])).toEqual([]); // 还没回答

    answerReviewItem(item.id, { answer: "我的判断" });
    expect(claimReviewItems("job1", [item.id])).toEqual([item.id]);
    expect(listReviewItems("answered")[0].batchId).toBe("job1");
    // 已被认领的不再被第二个任务拿走
    expect(claimReviewItems("job2", [item.id])).toEqual([]);

    releaseReviewItems("job1");
    expect(listReviewItems("answered")[0].batchId).toBeNull();
  });

  it("收回裁决时回答一并清掉", async () => {
    const item = await seedItem();
    answerReviewItem(item.id, { answer: "我的判断" });
    expect(listReviewItems("answered")).toHaveLength(1);

    decideReviewItem(item.id, "pending");
    const back = listReviewItems("pending").find((i) => i.id === item.id)!;
    expect(back.answer).toBeNull();
    expect(back.answerChoiceId).toBeNull();
    expect(back.answeredAt).toBeNull();
    expect(back.batchId).toBeNull();
  });

  it("角标算的是「还没结案」：待答 + 已回答", async () => {
    const item = await seedItem();
    const openBefore = countOpenReviewItems();
    expect(countPendingReviewItems()).toBe(openBefore);

    answerReviewItem(item.id, { answer: "我的判断" });
    // 已回答却处理失败的事项不会再被重新入队，所以角标必须算上它们，
    // 否则用户会以为它消失了
    expect(countOpenReviewItems()).toBe(openBefore);
    expect(countPendingReviewItems()).toBe(openBefore - 1);

    decideReviewItem(item.id, "dismissed");
    expect(countOpenReviewItems()).toBe(openBefore - 1);
  });

  it("critical 排在最前面", async () => {
    const provider = new FakeProvider({
      responses: [fakeLintFindings([
        { kind: "contradiction", title: "一般问题", detail: "x", severity: "info", relatedTitles: [], suggestion: "" },
        { kind: "contradiction", title: "严重问题", detail: "y", severity: "critical", relatedTitles: [], suggestion: "" },
      ])],
    });
    await runLint({ provider });

    const items = listReviewItems("pending");
    expect(items[0].severity).toBe("critical");
  });
});
