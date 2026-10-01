import { describe, it, expect, beforeEach } from "vitest";
import { runLint } from "@/lib/lint";
import { reindexAll } from "@/lib/index/reindex";
import { dropAllIndexTables, getDb } from "@/lib/db/client";
import { redirects, pages } from "@/lib/db/schema";
import { getJob, readDraft } from "@/lib/jobs/runner";
import { startReviewBatch, applyFixPlan, cancelFixPlan } from "@/lib/review/batch-run";
import { ensureGitRepo } from "@/lib/git/auto-commit";
import { FakeProvider } from "@/lib/llm/fake";
import { localISOString } from "@/lib/utils";
import { writePage, frontmatterFor, resetVault, pageExists, readPageRaw } from "./helpers";

/**
 * 机械发现的自动处理。
 *
 * 两条纪律各有对应用例：程序能确定性修的**直接修**（但必须如实报告修了几条），
 * 要写内容的**只给计划**、等用户点头。
 */

async function waitForJob(jobId: string, wanted: string | "settled", timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getJob(jobId);
    if (job) {
      if (wanted === "settled" && ["done", "failed", "cancelled", "awaiting_review"].includes(job.status)) {
        return job;
      }
      if (wanted !== "settled" && job.status === wanted) return job;
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

describe("扫码时程序能确定性修的，直接修", () => {
  it("压平断掉的重定向链，并把条数如实报出来", async () => {
    writePage("b", frontmatterFor("01B", "乙"), "正文");
    reindexAll();

    // 手工造一条被外部编辑器改乱的链：旧名 → 一个不存在的 id → 乙
    const now = localISOString();
    getDb().insert(redirects).values([
      { oldNormalized: "gone", oldRaw: "旧名字", newPageId: "01MISSING", reason: "rename", createdAt: now },
      { oldNormalized: "01MISSING", oldRaw: "01MISSING", newPageId: "01B", reason: "rename", createdAt: now },
    ]).run();

    const report = await runLint({ mechanicalOnly: true });

    expect(report.autoFixed.flattenedRedirects).toBe(1);
    const row = getDb().select().from(redirects).all().find((r) => r.oldNormalized === "gone")!;
    expect(row.newPageId).toBe("01B");
  });

  it("没有可压平的链时如实报 0", async () => {
    const report = await runLint({ mechanicalOnly: true });
    expect(report.autoFixed.flattenedRedirects).toBe(0);
  });
});

describe("缺页补建 —— 只给计划，等用户点头", () => {
  function fakeFixPlan(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      summary: "为缺页写初稿",
      newPages: [],
      skipped: [],
      ...overrides,
    });
  }

  it("先生成计划挂起，用户确认后才建词条", async () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[根本不存在的词条]]。");
    reindexAll();

    const provider = new FakeProvider({
      responses: [
        fakeFixPlan({
          newPages: [{
            targetName: "根本不存在的词条",
            type: "concept",
            title: "根本不存在的词条",
            content: "这是初稿。参考了 [[甲]]。",
            reason: "被甲引用了",
          }],
        }),
      ],
    });

    const { jobId } = startReviewBatch({ mode: "mechanical", provider });
    await waitForJob(jobId, "awaiting_review");

    // 关键断言：还没确认，词条不该存在
    expect(pageExists("wiki/concepts/根本不存在的词条.md")).toBe(false);

    const plan = readDraft<{ items: Array<{ id: string }> }>(jobId)!;
    const result = applyFixPlan(jobId, [plan.items[0].id]);

    expect(result.created).toBe(1);
    const created = getDb().select().from(pages).all()
      .find((row) => row.title === "根本不存在的词条");
    expect(created).toBeTruthy();
    // 初稿没有原文出处，必须标成低置信度方便日后复核
    const raw = readPageRaw(created!.filePath);
    expect(raw).toContain("confidence: low");
    expect(raw).toContain("体检补建");
  });

  it("放弃计划：一个字都不写", async () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[另一个不存在的词条]]。");
    reindexAll();

    const provider = new FakeProvider({
      responses: [
        fakeFixPlan({
          newPages: [{
            targetName: "另一个不存在的词条", type: "entity",
            title: "另一个不存在的词条", content: "初稿", reason: "被引用",
          }],
        }),
      ],
    });

    const { jobId } = startReviewBatch({ mode: "mechanical", provider });
    await waitForJob(jobId, "awaiting_review");
    cancelFixPlan(jobId);

    expect(pageExists("wiki/entities/另一个不存在的词条.md")).toBe(false);
  });

  it("没有缺页时不开任务，也不报错", async () => {
    const provider = new FakeProvider({ responses: [fakeFixPlan()] });
    const { jobId } = startReviewBatch({ mode: "mechanical", provider });
    const job = await waitForJob(jobId, "settled");

    expect(job.status).toBe("done");
    // 模型一次都没被调用 —— 没有材料就不该花钱
    expect(provider.calls).toHaveLength(0);
  });
});
