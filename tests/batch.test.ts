import { describe, it, expect, beforeEach } from "vitest";
import { groupItems, sanitizePlan, type BatchPlan } from "@/lib/review/batch";
import { startReviewBatch, applyReviewPlan } from "@/lib/review/batch-run";
import { runLint, listReviewItems, answerReviewItem } from "@/lib/lint";
import { reindexAll } from "@/lib/index/reindex";
import { dropAllIndexTables, getDb } from "@/lib/db/client";
import { getJob } from "@/lib/jobs/runner";
import { reviewItems } from "@/lib/db/schema";
import { ensureGitRepo } from "@/lib/git/auto-commit";
import { FakeProvider } from "@/lib/llm/fake";
import { writePage, frontmatterFor, resetVault, readPageRaw, pageExists } from "./helpers";

/**
 * 批量处理的一批用例。
 *
 * 重点不在「正常路径能跑通」，而在三件会静默出错的事：
 *   ① 同一词条出现在两条 edits 里（后写的完整正文会抹掉前一条）
 *   ② 同一词条被拆进两组（同上，且更难发现）
 *   ③ 自动执行绕过内容冲突检查或重复执行
 */

function fakeBatchPlan(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: "按回答做了处理",
    edits: [],
    newPages: [],
    deletions: [],
    merges: [],
    noChangeItems: [],
    ...overrides,
  });
}

async function waitForJob(jobId: string, wanted: string | string[] | "settled", timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getJob(jobId);
    if (job) {
      if (wanted === "settled" && ["done", "failed", "cancelled", "awaiting_review"].includes(job.status)) {
        return job;
      }
      if (typeof wanted === "string" && wanted !== "settled" && job.status === wanted) return job;
      if (Array.isArray(wanted) && wanted.includes(job.status)) return job;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("等待任务状态超时：" + JSON.stringify(getJob(jobId)));
}

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
  ensureGitRepo();
});

/** 造一条已回答的事项：一个指向不存在词条的引用就是一条 missing_page */
async function seedAnswered() {
  writePage("a", frontmatterFor("01A", "甲"), "参见 [[不存在的词条]]。");
  reindexAll();
  await runLint({ mechanicalOnly: true });
  const item = listReviewItems("pending")[0];
  answerReviewItem(item.id, { answer: "给它建一个词条，并说明它的用途" });
  return item;
}

describe("groupItems —— 同一词条绝不能进两组", () => {
  it("共享词条的事项被合成一组", () => {
    const groups = groupItems([
      { itemId: "i1", pageIds: ["p1"] },
      { itemId: "i2", pageIds: ["p1"] },
      { itemId: "i3", pageIds: ["p2"] },
    ]);
    expect(groups).toHaveLength(2);
    const merged = groups.find((g) => g.length === 2)!;
    expect(merged.map((g) => g.itemId).sort()).toEqual(["i1", "i2"]);
  });

  it("链式共享会传递合并", () => {
    const groups = groupItems([
      { itemId: "i1", pageIds: ["p1"] },
      { itemId: "i2", pageIds: ["p1", "p2"] },
      { itemId: "i3", pageIds: ["p2"] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("不牵涉任何词条的事项各自成组", () => {
    const groups = groupItems([
      { itemId: "i1", pageIds: [] },
      { itemId: "i2", pageIds: [] },
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("sanitizePlan —— 净化规则", () => {
  const targets = [
    { id: "01A", title: "甲", content: "原来的正文" },
    { id: "01B", title: "乙", content: "乙的正文" },
  ];

  function plan(overrides: Partial<BatchPlan>): BatchPlan {
    return {
      summary: "s", edits: [], newPages: [], deletions: [], merges: [],
      noChangeItems: [], ...overrides,
    };
  }

  it("同一词条的第二条改动被丢掉并如实报告", () => {
    // 完整正文不是补丁：第二条是照原稿写的，应用上去等于把第一条回滚掉
    const result = sanitizePlan(
      plan({
        edits: [
          { pageId: "01A", title: "甲", newContent: "第一次改", reason: "r", itemIds: [] },
          { pageId: "01A", title: "甲", newContent: "第二次改", reason: "r", itemIds: [] },
        ],
      }),
      targets,
    );
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].newContent).toBe("第一次改");
    expect(result.rejected.some((r) => r.includes("只应用了第一条"))).toBe(true);
  });

  it("不在清单里的 pageId 被丢掉", () => {
    const result = sanitizePlan(
      plan({ edits: [{ pageId: "99Z", title: "不存在", newContent: "x", reason: "r", itemIds: [] }] }),
      targets,
    );
    expect(result.edits).toHaveLength(0);
    expect(result.rejected.some((r) => r.includes("不在这次读入的清单里"))).toBe(true);
  });

  it("正文没变化的不算改动", () => {
    const result = sanitizePlan(
      plan({ edits: [{ pageId: "01A", title: "甲", newContent: "原来的正文", reason: "r", itemIds: [] }] }),
      targets,
    );
    expect(result.edits).toHaveLength(0);
    expect(result.rejected.some((r) => r.includes("没有实际变化"))).toBe(true);
  });

  it("既想改又想删同一个词条时，删除让位、改动照常", () => {
    const result = sanitizePlan(
      plan({
        edits: [{ pageId: "01A", title: "甲", newContent: "新正文", reason: "r", itemIds: [] }],
        deletions: [{ pageId: "01A", title: "甲", reason: "r", itemIds: [] }],
      }),
      targets,
    );
    expect(result.edits).toHaveLength(1);
    expect(result.deletions).toHaveLength(0);
    expect(result.rejected.some((r) => r.includes("既要改它又要删它"))).toBe(true);
  });

  it("合并到自己身上被丢掉", () => {
    const result = sanitizePlan(
      plan({
        merges: [{
          sourcePageId: "01A", sourceTitle: "甲",
          targetPageId: "01A", targetTitle: "甲",
          mergedContent: "x", reason: "r", itemIds: [],
        }],
      }),
      targets,
    );
    expect(result.merges).toHaveLength(0);
    expect(result.rejected.some((r) => r.includes("不能和自己合并"))).toBe(true);
  });

  it("破坏性操作超过上限时截断并说明", () => {
    const many = ["01A", "01B", "01C", "01D", "01E", "01F"].map((id) => ({
      pageId: id, title: id, reason: "r", itemIds: [],
    }));
    const wide = [...targets, ...many.map((m) => ({ id: m.pageId, title: m.title, content: "x" }))];
    const result = sanitizePlan(plan({ deletions: many }), wide);
    // 上限 5，多出来的被丢掉
    expect(result.deletions.length + result.rejected.filter((r) => r.includes("进入这次确认")).length).toBe(6);
    expect(result.rejected.some((r) => r.includes("最多确认 5 项"))).toBe(true);
  });
});

describe("批量处理 —— 端到端", () => {
  it("改正文直接落盘，事项结案", async () => {
    const item = await seedAnswered();
    const provider = new FakeProvider({
      responses: [
        fakeBatchPlan({
          edits: [{
            pageId: "01A", title: "甲",
            newContent: "参见 [[不存在的词条]]。\n\n补充：这一段是按你的回答加上的。",
            reason: "按回答补充", itemIds: [item.id],
          }],
        }),
      ],
    });

    const { jobId } = startReviewBatch({ mode: "answers", itemIds: [item.id], provider });
    const job = await waitForJob(jobId, "settled");
    expect(job.status).toBe("done");

    expect(readPageRaw("wiki/entities/a.md")).toContain("按你的回答加上的");
    const settled = getDb().select().from(reviewItems).all().find((r) => r.id === item.id)!;
    expect(settled.status).toBe("accepted");
    expect(settled.batchId).toBeNull();
  });

  it("提交回答后自动删除并结案，不再等待第二次确认", async () => {
    const item = await seedAnswered();
    const provider = new FakeProvider({ responses: [fakeBatchPlan({ deletions: [{ pageId: "01A", title: "甲", reason: "重复", itemIds: [item.id] }] })] });
    const { jobId } = startReviewBatch({ mode: "answers", itemIds: [item.id], provider });
    const job = await waitForJob(jobId, "done");
    expect(job.status).toBe("done");
    expect(pageExists("wiki/entities/a.md")).toBe(false);
    const settled = getDb().select().from(reviewItems).all().find(row => row.id === item.id)!;
    expect(settled.status).toBe("accepted"); expect(settled.batchId).toBeNull();
    expect(job.result).toMatchObject({ deleted: 1 });
    const { readDraft } = await import("@/lib/jobs/runner");
    const draft = readDraft<{ pending: Array<{ id: string }> }>(jobId)!;
    expect(() => applyReviewPlan(jobId, { approve: draft.pending.map(action => action.id) })).toThrow();
  });

  it("自动执行保留内容冲突保护，不覆盖任务期间的外部编辑", async () => {
    const item = await seedAnswered();
    const provider = new FakeProvider({ responses: [() => {
      writePage("a", frontmatterFor("01A", "甲"), "外部编辑的新正文");
      return fakeBatchPlan({ deletions: [{ pageId: "01A", title: "甲", reason: "重复", itemIds: [item.id] }] });
    }] });
    const { jobId } = startReviewBatch({ mode: "answers", itemIds: [item.id], provider });
    const job = await waitForJob(jobId, "done");
    expect(pageExists("wiki/entities/a.md")).toBe(true);
    expect(readPageRaw("wiki/entities/a.md")).toContain("外部编辑的新正文");
    expect((job.result as { conflicts: string[] }).conflicts).toHaveLength(1);
    const settled = getDb().select().from(reviewItems).all().find(row => row.id === item.id)!;
    expect(settled.status).toBe("answered"); expect(settled.batchId).toBeNull();
  });

  it("模型认为不需要改动时，不落盘但会结案", async () => {
    const item = await seedAnswered();
    const provider = new FakeProvider({
      responses: [
        fakeBatchPlan({ noChangeItems: [{ itemId: item.id, reason: "已经说清楚了" }] }),
      ],
    });

    const { jobId } = startReviewBatch({ mode: "answers", itemIds: [item.id], provider });
    await waitForJob(jobId, "settled");

    const after = getDb().select().from(reviewItems).all().find((r) => r.id === item.id)!;
    // 不需要改动也是一次完整处理；保留回答供历史回看，不再让同一问题重复出现。
    expect(after.status).toBe("accepted");
    expect(after.answer).toBe("给它建一个词条，并说明它的用途");
    expect(after.resolvedAt).toBeTruthy();
  });
});
