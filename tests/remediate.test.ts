import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { startRemediation } from "@/lib/review/remediate";
import { listReviewItems } from "@/lib/lint";
import { getJob } from "@/lib/jobs/runner";
import { getDb, dropAllIndexTables } from "@/lib/db/client";
import { reviewItems } from "@/lib/db/schema";
import { reindexAll } from "@/lib/index/reindex";
import { FakeProvider } from "@/lib/llm/fake";
import { stopWatcher } from "@/lib/index/watcher";
import { clearSuppression } from "@/lib/index/watch-suppression";
import { resetVault, writePage, frontmatterFor, readPageRaw } from "./helpers";

/**
 * 按批注修订（体检闭环的第二段）。
 *
 * 这一层要守住的东西和导入那边一样，但更容易被忽略：**模型会给出不存在的 id、
 * 会把没让改的词条也改一遍**。所以每个用例都在问同一个问题 ——
 * 模型的产出有多少被真的信了。
 */

// 必须是合法 ULID：frontmatter 的 id 校验不过的话，词条根本进不了索引，
// 于是「一切正常但什么都没改」—— 这个坑第一次就是这么踩到的
const PAGE_ID = ulid();

function seedPage() {
  writePage("suan-lu", frontmatterFor(PAGE_ID, "算路科技", { slug: "suan-lu" }), "算路科技成立于 2024 年。", "entity");
  reindexAll();
}

function seedItem(overrides: Partial<typeof reviewItems.$inferInsert> = {}) {
  const id = ulid();
  getDb()
    .insert(reviewItems)
    .values({
      id,
      kind: "stale_claim",
      title: "「算路科技」的成立年份可能过时",
      detail: "词条写的是 2024 年，但新资料里出现了更早的年份。",
      severity: "warning",
      relatedPagesJson: JSON.stringify([{ id: PAGE_ID, title: "算路科技" }]),
      status: "pending",
      createdAt: "2026-01-01T00:00:00+08:00",
      ...overrides,
    })
    .run();
  return id;
}

function plan(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: "按批注把成立年份改成 2021 年。",
    edits: [
      {
        pageId: PAGE_ID,
        title: "算路科技",
        newContent: "算路科技成立于 2021 年。",
        reason: "批注要求以工商登记为准",
      },
    ],
    newPages: [],
    noChangeReason: null,
    ...overrides,
  });
}

async function waitForJob(jobId: string, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getJob(jobId);
    if (job && ["done", "failed", "cancelled", "awaiting_review"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待任务超时：${JSON.stringify(getJob(jobId))}`);
}

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
  clearSuppression();
});

afterEach(async () => {
  await stopWatcher();
  clearSuppression();
});

describe("按批注修订", () => {
  it("模型提出的修订落进文件、提交、并在事项上留下记录", async () => {
    seedPage();
    const itemId = seedItem();
    const provider = new FakeProvider({ responses: [plan()] });

    const { jobId } = startRemediation({ itemId, annotation: "以工商登记为准，成立于 2021 年", provider });
    const job = await waitForJob(jobId);
    expect(job.status).toBe("done");

    // 文件真的被改了
    expect(readPageRaw("wiki/entities/suan-lu.md")).toContain("2021 年");

    const view = listReviewItems("all").find((item) => item.id === itemId)!;
    expect(view.status).toBe("accepted");
    // 批注原样留下 —— 它是这条修订的指令，也是日后回看的依据
    expect(view.decisionNote).toBe("以工商登记为准，成立于 2021 年");
    expect(view.appliedSha).toBeTruthy();
    expect(view.remediation?.edits[0]?.title).toBe("算路科技");
    expect(view.remediation?.edits[0]?.reason).toContain("工商登记");
  });

  it("批注进 prompt，词条正文被当作不可信数据包裹", async () => {
    seedPage();
    const itemId = seedItem();
    const provider = new FakeProvider({ responses: [plan()] });

    const { jobId } = startRemediation({ itemId, annotation: "以工商登记为准", provider });
    await waitForJob(jobId);

    const prompt = provider.calls[0].messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("以工商登记为准");
    // 词条正文来自任意资料，必须包在边界标记里；批注是用户亲手写的指令，不包
    expect(prompt).toContain("UNTRUSTED_CONTENT");
    expect(prompt).toMatch(/UNTRUSTED_CONTENT[^]*算路科技成立于 2024 年/);
  });

  it("模型给出不在清单里的 id 时不认 —— 顺手改别的词条是它的常见行为", async () => {
    seedPage();
    const itemId = seedItem();
    const provider = new FakeProvider({
      responses: [
        plan({
          edits: [
            { pageId: "01NOTINTHECONTEXT00000000", title: "别的词条", newContent: "被顺手改掉的内容", reason: "顺手" },
            ...JSON.parse(plan()).edits,
          ],
        }),
      ],
    });

    const { jobId } = startRemediation({ itemId, annotation: "只改年份", provider });
    await waitForJob(jobId);

    const view = listReviewItems("all").find((item) => item.id === itemId)!;
    expect(view.remediation?.rejected.join("")).toContain("不在这次读入的清单里");
    // 该改的那条仍然改了
    expect(readPageRaw("wiki/entities/suan-lu.md")).toContain("2021 年");
  });

  it("模型认为不用改时不动文件、也不提交，但如实记下它说了什么", async () => {
    seedPage();
    const itemId = seedItem();
    const before = readPageRaw("wiki/entities/suan-lu.md");
    const provider = new FakeProvider({
      responses: [plan({ edits: [], noChangeReason: "批注与词条现有内容并不冲突。" })],
    });

    const { jobId } = startRemediation({ itemId, annotation: "再核一遍", provider });
    const job = await waitForJob(jobId);
    expect(job.status).toBe("done");

    expect(readPageRaw("wiki/entities/suan-lu.md")).toBe(before);
    const view = listReviewItems("all").find((item) => item.id === itemId)!;
    expect(view.appliedSha).toBeNull();
    expect(view.remediation?.noChangeReason).toContain("并不冲突");
  });

  it("没有批注时不启动 —— 模型需要指令，不能替用户猜", async () => {
    seedPage();
    const itemId = seedItem();
    const provider = new FakeProvider({ responses: [plan()] });

    const { jobId } = startRemediation({ itemId, annotation: "   ", provider });
    const job = await waitForJob(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("批注");
    expect(provider.calls).toHaveLength(0);
  });

  it("事项没有指向任何词条时明确拒绝，而不是让模型自由发挥", async () => {
    seedPage();
    const itemId = seedItem({ relatedPagesJson: JSON.stringify([]) });
    const provider = new FakeProvider({ responses: [plan()] });

    const { jobId } = startRemediation({ itemId, annotation: "随便改改", provider });
    const job = await waitForJob(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("没有指向任何具体词条");
    expect(provider.calls).toHaveLength(0);
  });

  it("词条在体检之后被删掉时不崩 —— 当作缺页交给模型判断", async () => {
    // 不 seedPage：事项指向一个已经不存在的 id
    const itemId = seedItem();
    getDb().delete(reviewItems).where(eq(reviewItems.id, "nonexistent")).run();
    const provider = new FakeProvider({ responses: [plan({ edits: [], noChangeReason: "词条已不存在。" })] });

    const { jobId } = startRemediation({ itemId, annotation: "重建它", provider });
    const job = await waitForJob(jobId);
    expect(job.status).toBe("done");
    const prompt = provider.calls[0].messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("算路科技");
  });
});
