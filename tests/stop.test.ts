import { describe, it, expect, beforeEach } from "vitest";
import { answer } from "@/lib/chat/answer";
import { createSession, getMessages, appendMessage } from "@/lib/chat/sessions";
import {
  registerStream, stopStream, clearStream, isStreaming,
} from "@/lib/chat/streams";
import { getJob, cancel, enqueue, type JobContext } from "@/lib/jobs/runner";
import { startLintJob, listReviewItems } from "@/lib/lint";
import { dropAllIndexTables } from "@/lib/db/client";
import { reindexAll } from "@/lib/index/reindex";
import { resetVault, writePage, frontmatterFor } from "./helpers";
import { ulid } from "ulid";
import type { CompletionRequest, CompletionResult, LlmProvider } from "@/lib/llm/types";

/**
 * 停止：问答与体检。
 *
 * 这一层要守住的核心是一条纪律 —— **停下来说的话必须是真的**。
 * 「已取消」只能意味着真的没有东西被写进去；已经产出的东西不能凭空消失
 * （问答那半截回答），没产出的东西也不能假装产出了（体检的审阅条目）。
 */

/**
 * 挂在那儿不返回的 provider：吐完预设的分片就一直等，直到被中止。
 *
 * 真实的模型调用就是这个形状 —— 一次请求挂几分钟，中途唯一的出口是被掐断。
 * 用 FakeProvider 测不了这件事：它是立刻返回的，永远测不到「生成到一半停下来」。
 */
class HangingProvider implements LlmProvider {
  readonly id = "hanging";
  readonly model = "hanging-model";
  readonly supportsStrictSchema = false;

  constructor(private readonly chunks: string[] = []) {}

  /**
   * 结构化调用（体检、导入用的是这一条）同样挂到被中止为止 ——
   * 它一次请求就是几分钟，中途唯一的出口也是被掐断。
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    await hangUntilAborted(request);
    return { text: "{}", usage: null, model: this.model, truncated: false };
  }

  async *stream(request: CompletionRequest): AsyncGenerator<string, CompletionResult, void> {
    for (const chunk of this.chunks) {
      yield chunk;
      await new Promise((r) => setTimeout(r, 10));
    }
    await hangUntilAborted(request);
    return { text: "", usage: null, model: this.model, truncated: false };
  }
}

function hangUntilAborted(request: CompletionRequest): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "abort"));
    if (request.signal?.aborted) return abort();
    request.signal?.addEventListener("abort", abort, { once: true });
  });
}

async function settle(jobId: string, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getJob(jobId);
    if (job && ["done", "failed", "cancelled", "awaiting_review"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待任务结束超时：${JSON.stringify(getJob(jobId))}`);
}

/** 等到任务走到某个阶段，方便在「正跑着」的那一刻动手 */
async function waitForStage(jobId: string, stage: string, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (getJob(jobId)?.stage === stage) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待阶段 ${stage} 超时，当前 ${getJob(jobId)?.stage}`);
}

async function waitForStatus(jobId: string, status: string, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (getJob(jobId)?.status === status) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待状态 ${status} 超时，当前 ${getJob(jobId)?.status}`);
}

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

describe("停止生成中的回答", () => {
  it("已经生成的部分照样落库，并标记为已停止", async () => {
    const sessionId = createSession();
    const controller = registerStream(sessionId);
    const questionMessageId = appendMessage({ sessionId, role: "user", content: "推荐算法是什么？" });

    const pending = answer({
      sessionId,
      question: "推荐算法是什么？",
      questionMessageId,
      provider: new HangingProvider(["推荐算法是", "信息过滤技术"]),
      signal: controller.signal,
    });

    // 等它吐出那两个分片，此刻模型还挂在生成中
    await new Promise((r) => setTimeout(r, 60));
    expect(stopStream(sessionId)).toBe(true);

    const result = await pending;
    expect(result.interrupted).toBe(true);
    expect(result.text).toContain("推荐算法是");

    // 半截回答必须留在库里：不落的话，刷新之后屏幕上那半截文字会凭空消失，
    // 只剩一个孤零零的提问 —— 用户会以为自己从来没被回答过
    const messages = getMessages(sessionId);
    const last = messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.interrupted).toBe(true);
    expect(last.content).toContain("信息过滤技术");

    clearStream(sessionId, controller);
    expect(isStreaming(sessionId)).toBe(false);
  });

  it("没有在生成时停止，如实返回 false（不谎报成功）", () => {
    expect(stopStream("不存在这个会话")).toBe(false);
  });

  it("收尾只摘掉自己那一轮 —— 同一会话里紧接着的下一轮不该被牵连", () => {
    const sessionId = createSession();
    const first = registerStream(sessionId);
    const second = registerStream(sessionId);

    // 前一轮收尾时，表里已经是后一轮了，它无权把自己之外的东西清掉
    clearStream(sessionId, first);
    expect(isStreaming(sessionId)).toBe(true);

    clearStream(sessionId, second);
    expect(isStreaming(sessionId)).toBe(false);
  });
});

describe("停止体检", () => {
  /** 造一个死链，让机械检查有东西可报 —— 这样才能验证「被停止时它也不入队」 */
  function seedBrokenLink() {
    writePage(
      "suan-lu",
      frontmatterFor(ulid(), "算路科技", { slug: "suan-lu" }),
      "参见 [[协同过滤]] 与 [[并不存在的词条]]。",
      "entity",
    );
    reindexAll();
  }

  it("被停止的体检什么都不写入 —— 包括那几条已经算出来的客观发现", async () => {
    seedBrokenLink();
    const { jobId } = startLintJob({ provider: new HangingProvider([]) });

    await waitForStage(jobId, "judging");
    expect(cancel(jobId)).toBe("cancelled");

    const job = await settle(jobId);
    expect(job.status).toBe("cancelled");
    expect(job.progress).toBeLessThan(100);
    // 死链确实存在，但这次体检被停了，队列里不该多出任何一条
    expect(listReviewItems("all")).toHaveLength(0);
  });

  it("正常跑完的体检会把发现写进队列（对照组）", async () => {
    seedBrokenLink();
    const { jobId } = startLintJob({ mechanicalOnly: true });
    const job = await settle(jobId);

    expect(job.status).toBe("done");
    expect(listReviewItems("all").length).toBeGreaterThan(0);
  });
});

describe("任务取消的三种结局", () => {
  /** 一个不做到实事的短任务，用来制造「已经结束」与「排队中」两种状态 */
  const noop = () => enqueue({ kind: "reindex", handler: async () => ({ ok: true }) });

  it("排队中的任务：直接移除，立刻变成已取消", async () => {
    // 先占住运行位：runner 是单并发的，后面那个就只能排队。
    // 必须等 blocker 真的进了 running —— 它还在队列里的话，下一个任务也在队列里，
    // 这条用例就测不到「排队中被取消」这个分支了。
    const blocker = enqueue({
      kind: "reindex",
      handler: (context: JobContext) =>
        new Promise((resolve) => {
          context.signal.addEventListener("abort", () => resolve(null));
        }),
    });
    await waitForStatus(blocker, "running");

    const queued = noop();
    expect(cancel(queued)).toBe("cancelled");
    expect(getJob(queued)!.status).toBe("cancelled");

    // 收尾：把 blocker 也停掉。单并发的队列必须空出来，否则下一个用例的任务要排队
    cancel(blocker);
    await waitForStatus(blocker, "cancelled");
  });

  it("已经结束的任务：如实说「不在运行」，而不是假装停掉了", async () => {
    const jobId = noop();
    await settle(jobId);
    expect(cancel(jobId)).toBe("not-running");
  });

  it("压根不存在的 id", () => {
    expect(cancel("01ABCDEFGHJKMNPQRSTVWXYZAB")).toBe("not-found");
  });
});
