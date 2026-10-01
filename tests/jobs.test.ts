import { describe, it, expect, beforeEach } from "vitest";
import {
  INGEST_STAGES,
  LINT_STAGES,
  REMEDIATE_STAGES,
  computeProgress,
  estimateStageFraction,
  stageLabel,
  stageStartPercent,
  stagesForKind,
  type JobEvent,
} from "@/lib/jobs/types";
import { enqueue, finishJob, cancel, getJob, subscribe, type JobContext } from "@/lib/jobs/runner";
import { dropAllIndexTables } from "@/lib/db/client";
import { resetVault } from "./helpers";

/**
 * 任务进度的用例。
 *
 * 这一层单测的价值在「颗粒度」这件事上：用户报的现象是「进度条只有 50% 和 100%，
 * 其他时候都不显示」。那不是一个渲染 bug，而是**上报频率**的问题 ——
 * 真实进度只在两个 LLM 调用结束时各报一次，中间几分钟一条事件都没有。
 * 所以下面断言的不是「进度对不对」，而是「事件够不够密、会不会倒退」。
 */

async function waitForSettled(jobId: string, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getJob(jobId);
    if (job && ["done", "failed", "cancelled", "awaiting_review"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待任务结束超时：${JSON.stringify(getJob(jobId))}`);
}

/** 跑一个只切阶段、不做实事的任务，把事件全程录下来 */
async function recordJob(handler: (context: JobContext) => Promise<unknown>) {
  const events: JobEvent[] = [];
  const jobId = enqueue({ kind: "reindex", handler });
  const unsubscribe = subscribe(jobId, (event) => events.push(event));
  const job = await waitForSettled(jobId);
  unsubscribe();
  return {
    jobId,
    job,
    events,
    progressOf: () =>
      events.filter((e): e is Extract<JobEvent, { type: "progress" }> => e.type === "progress").map((e) => e.progress),
  };
}

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

describe("阶段权重与进度换算", () => {
  it("权重合计是 100，且阶段起点单调不减", () => {
    const total = INGEST_STAGES.reduce((sum, stage) => sum + stage.weight, 0);
    expect(total).toBe(100);

    for (let i = 1; i < INGEST_STAGES.length; i++) {
      const previous = INGEST_STAGES[i - 1];
      const current = INGEST_STAGES[i];
      expect(computeProgress(previous.stage, 1)).toBeLessThanOrEqual(computeProgress(current.stage, 0));
    }
  });

  it("最后一个带权重的阶段跑满就是 100%", () => {
    expect(computeProgress("committing", 1)).toBe(100);
  });

  it("等待审阅不占进度 —— 那是等人的时间，不是机器的时间", () => {
    expect(stageStartPercent("reviewing")).toBe(stageStartPercent("drafting") + 35);
    expect(computeProgress("reviewing", 1)).toBe(83);
  });
});

describe("阶段内进度的估算曲线", () => {
  it("从 0 起步、单调递增", () => {
    expect(estimateStageFraction("analyzing", 0)).toBe(0);
    let previous = 0;
    for (const ms of [1_000, 10_000, 30_000, 60_000, 110_000, 200_000, 600_000]) {
      const value = estimateStageFraction("analyzing", ms);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBeGreaterThan(0.5);
  });

  it("永远不自己走到阶段终点 —— 100% 只能由真实完成换来", () => {
    expect(estimateStageFraction("drafting", 10 * 60_000)).toBeLessThanOrEqual(0.97);
    expect(computeProgress("drafting", estimateStageFraction("drafting", 10 * 60_000))).toBeLessThan(83);
  });

  it("长尾不会撞顶僵住：超出预期十倍后仍在缓慢推进", () => {
    const atExpected = estimateStageFraction("analyzing", 110_000);
    const atTenTimes = estimateStageFraction("analyzing", 1_100_000);
    expect(atTenTimes).toBeGreaterThan(atExpected);
  });
});

describe("任务运行时的事件流", () => {
  it("每个阶段一开始就推一条进度，不等阶段跑完", async () => {
    const { job, progressOf } = await recordJob(async (context) => {
      context.setStage("parsing");
      context.setStage("analyzing");
      context.setFraction(1);
      context.setStage("reviewing");
      return { ok: true };
    });

    expect(job.status).toBe("done");
    const progress = progressOf();
    // 三个阶段的起点都必须出现（3 / 18 / 48 / 83）
    expect(progress).toContain(stageStartPercent("parsing"));
    expect(progress).toContain(stageStartPercent("analyzing"));
    expect(progress).toContain(stageStartPercent("reviewing"));
    expect(progress).toContain(100);
  });

  it("进度全程不倒退", async () => {
    const { progressOf } = await recordJob(async (context) => {
      context.setStage("uploaded");
      context.setFraction(1);
      context.setStage("parsing");
      context.setFraction(0.5);
      context.setStage("analyzing");
      context.setFraction(1);
      return { ok: true };
    });

    const progress = progressOf();
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
  });
});

describe("任务收尾", () => {
  it("finishJob 把状态写进库，并通知订阅者", async () => {
    const events: JobEvent[] = [];
    const jobId = enqueue({ kind: "ingest", handler: async (context) => {
      context.setStage("reviewing");
      return { awaitingReview: true };
    } });
    const unsubscribe = subscribe(jobId, (event) => events.push(event));
    await waitForSettled(jobId);

    expect(getJob(jobId)!.status).toBe("awaiting_review");

    finishJob(jobId, { status: "done", progress: 100, message: "已写入 3 个词条" });
    unsubscribe();

    const job = getJob(jobId)!;
    expect(job.status).toBe("done");
    expect(job.progress).toBe(100);
    expect(job.finishedAt).not.toBeNull();
    expect(events.some((e) => e.type === "status" && e.status === "done")).toBe(true);
  });
});

describe("每种任务有自己的阶段表", () => {
  const TABLES = [
    ["导入", INGEST_STAGES],
    ["体检", LINT_STAGES],
    ["修订", REMEDIATE_STAGES],
  ] as const;

  it.each(TABLES)("%s：权重合计 100，阶段起点单调不减", (_name, stages) => {
    expect(stages.reduce((sum, stage) => sum + stage.weight, 0)).toBe(100);
    for (let i = 1; i < stages.length; i++) {
      const previous = stages[i - 1];
      const current = stages[i];
      expect(computeProgress(previous.stage, 1, stages)).toBeLessThanOrEqual(
        computeProgress(current.stage, 0, stages),
      );
    }
  });

  it("按任务类型取表：体检拿到的不是导入那一张", () => {
    expect(stagesForKind("lint")).toBe(LINT_STAGES);
    expect(stagesForKind("remediate")).toBe(REMEDIATE_STAGES);
    // 没有自己阶段表的短任务落回导入表 —— 它们要么秒级完成，要么根本不报进度
    expect(stagesForKind("reindex")).toBe(INGEST_STAGES);
  });

  it("体检的阶段名各自说人话 —— 侧栏显示英文 stage 名就是把内部标识漏到了界面上", () => {
    expect(stageLabel("judging", LINT_STAGES)).toBe("模型判断矛盾与过时论断");
    expect(stageLabel("sampling", LINT_STAGES)).toBe("抽样读取词条");
  });

  it("体检的长阶段（judging）占大头，开头不会几毫秒冲过一半", () => {
    // 权重与实际耗时对不上，进度条就会在开头冲过去然后僵住 —— 比没有进度更糟
    expect(stageStartPercent("judging", LINT_STAGES)).toBeLessThan(20);
  });

  it("judging 的估算曲线起步就是 1% 量级 —— 这是「颗粒度到 1%」的实际来源", () => {
    // 权重 70、预期 90s ⇒ τ=36s，起手约 1.9%/秒；400ms 上报一次、取整到 1%，
    // 界面上就是每秒稳稳跳一格
    const oneSecond = computeProgress("judging", estimateStageFraction("judging", 1_000, LINT_STAGES), LINT_STAGES);
    const start = stageStartPercent("judging", LINT_STAGES);
    expect(oneSecond - start).toBeGreaterThanOrEqual(1);
  });
});

describe("取消信号", () => {
  it("任务能看到取消，且 signal 会被 abort —— 在途的模型请求靠它才停得下来", async () => {
    let seen: AbortSignal | null = null;
    let aborted = false;

    const jobId = enqueue({
      kind: "reindex",
      handler: (context: JobContext) =>
        new Promise((resolve) => {
          seen = context.signal;
          context.signal.addEventListener("abort", () => {
            aborted = true;
            resolve(null);
          });
        }),
    });

    // 等它真的开始跑，再取消
    const started = Date.now();
    while (!seen && Date.now() - started < 3000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen).not.toBeNull();
    expect(seen!.aborted).toBe(false);

    expect(cancel(jobId)).toBe("cancelled");
    await waitForSettled(jobId);

    expect(aborted).toBe(true);
    expect(getJob(jobId)!.status).toBe("cancelled");
  });
});
