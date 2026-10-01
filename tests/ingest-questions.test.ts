import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  startIngest, commitIngest, loadIngestDraft, type IngestDraft,
} from "@/lib/ingest/pipeline";
import { getJob } from "@/lib/jobs/runner";
import { dropAllIndexTables, getDb } from "@/lib/db/client";
import { reviewItems } from "@/lib/db/schema";
import { DraftSchema } from "@/lib/llm/prompts";
import { FakeProvider } from "@/lib/llm/fake";
import { stopWatcher } from "@/lib/index/watcher";
import { clearSuppression } from "@/lib/index/watch-suppression";
import { resetVault } from "./helpers";

/**
 * 导入侧的「问题 + 候选答案」。
 *
 * 这组用例守两件事：
 *   1. 分析阶段发现的矛盾**一定**会进审阅队列 —— 不能靠起草阶段的模型自觉；
 *   2. 用户此前的裁决真的进了 prompt（这两个 prompt 的形参早就在，却一直没被传过）。
 */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");

function fakeAnalysis(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    gist: "介绍推荐算法的基本原理与协同过滤的两类方法。",
    language: "中文",
    entities: [
      { name: "字节跳动", type: "机构", description: "一家科技公司", mentions: 1, evidence: "字节跳动大规模应用了这类方法。" },
    ],
    concepts: [
      { name: "协同过滤", description: "一类推荐方法", evidence: "协同过滤分为基于用户与基于物品两类。" },
    ],
    relations: [],
    overlaps: [],
    contradictions: [],
    gaps: [],
    ...overrides,
  });
}

function fakeDraft(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    sourceSummary: { title: "推荐算法概述", content: "这份资料介绍了 [[协同过滤]]。" },
    newPages: [
      {
        type: "concept",
        title: "协同过滤",
        summary: "一类推荐方法",
        content: "协同过滤分为基于用户与基于物品两类。",
        aliases: [],
        tags: ["算法"],
        confidence: "high",
        citations: [{ page: null, quote: "协同过滤分为基于用户与基于物品两类。" }],
      },
    ],
    updatedPages: [],
    reviewItems: [],
    ...overrides,
  });
}

async function waitForJob(jobId: string, wanted: string[] | "settled", timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getJob(jobId);
    if (job) {
      if (wanted === "settled" && ["done", "failed", "cancelled", "awaiting_review"].includes(job.status)) {
        return job;
      }
      if (Array.isArray(wanted) && wanted.includes(job.status)) return job;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("等待任务状态超时：" + JSON.stringify(getJob(jobId)));
}

function ingestInput(name: string, provider: FakeProvider) {
  return { fileName: name, buffer: fs.readFileSync(path.join(FIXTURES, name)), provider };
}

/** 跑到审阅态，返回可提交的草稿 */
async function prepareDraft(provider: FakeProvider) {
  const { jobId } = startIngest(ingestInput("sample.docx", provider));
  await waitForJob(jobId, "settled");
  return { jobId, staged: loadIngestDraft<IngestDraft>(jobId)! };
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

describe("导入 —— 矛盾必须进队列", () => {
  it("起草阶段漏写矛盾时，后端从分析结果里补进队列", async () => {
    // 这是本功能里唯一一处「后端替模型兜底」的地方：分析步看见了矛盾，起草步
    // 忙着写正文忘了报 —— 而界面上那段 contradictures 是只读的，用户永远看不到
    const provider = new FakeProvider({
      responses: [
        fakeAnalysis({
          contradictions: [
            {
              existing: "字节跳动",
              claim: "成立于 2012 年",
              conflict: "词条里写的是 2013 年",
              question: "以哪个说法为准？",
              options: [
                { id: "a", label: "以词条现有说法为准", impact: "不改词条，只记下口径" },
                { id: "b", label: "改成 2012 年", impact: "改写《字节跳动》正文里的成立年份" },
              ],
            },
          ],
        }),
        fakeDraft({ reviewItems: [] }),
      ],
    });

    const { jobId, staged } = await prepareDraft(provider);
    const result = await commitIngest({ jobId, draft: staged.draft });

    expect(result.supplementedContradictions).toBe(1);
    const rows = getDb().select().from(reviewItems).all();
    const item = rows.find((r) => r.kind === "contradiction")!;
    expect(item.title).toContain("字节跳动");
    expect(item.question).toBe("以哪个说法为准？");
    expect(JSON.parse(item.optionsJson!)).toHaveLength(2);
  });

  it("模型自己写了的矛盾不会被重复补一条（措辞不同也算同一条）", async () => {
    const provider = new FakeProvider({
      responses: [
        fakeAnalysis({
          contradictions: [{ existing: "字节跳动", claim: "成立于 2012 年", conflict: "词条说是 2013 年" }],
        }),
        fakeDraft({
          reviewItems: [
            {
              kind: "contradiction",
              title: "《字节跳动》的成立年份对不上",
              detail: "资料说 2012，词条说 2013。",
              severity: "warning",
              relatedTitles: ["字节跳动"],
            },
          ],
        }),
      ],
    });

    const { jobId, staged } = await prepareDraft(provider);
    const result = await commitIngest({ jobId, draft: staged.draft });

    expect(result.supplementedContradictions).toBe(0);
    const rows = getDb().select().from(reviewItems).all().filter((r) => r.kind === "contradiction");
    expect(rows).toHaveLength(1);
    // 留下来的是模型自己写的那条 —— 它有完整语境
    expect(rows[0].title).toBe("《字节跳动》的成立年份对不上");
  });

  it("补进来的事项同样过净化：只有一个选项时退回旧交互", async () => {
    const provider = new FakeProvider({
      responses: [
        fakeAnalysis({
          contradictions: [
            {
              existing: "字节跳动",
              claim: "成立于 2012 年",
              conflict: "词条里写的是 2013 年",
              question: "以哪个说法为准？",
              options: [{ id: "a", label: "以词条为准", impact: "不改" }],
            },
          ],
        }),
        fakeDraft({ reviewItems: [] }),
      ],
    });

    const { jobId, staged } = await prepareDraft(provider);
    await commitIngest({ jobId, draft: staged.draft });

    const item = getDb().select().from(reviewItems).all().find((r) => r.kind === "contradiction")!;
    expect(item.question).toBeNull();
    expect(item.optionsJson).toBeNull();
  });
});

describe("导入 —— 裁决回灌与旧草稿兼容", () => {
  it("用户此前的裁决进了分析与起草的 prompt", async () => {
    // 这两个 prompt 的 decisions 形参一直存在，却从没被传过 —— 于是
    // 「我在导入界面当场裁决过的口径，下一次导入时模型还是不知道」
    const provider = new FakeProvider({
      responses: [
        fakeAnalysis(),
        fakeDraft({
          reviewItems: [
            {
              kind: "stale_claim",
              title: "一条待裁决事项",
              detail: "详情",
              severity: "warning",
              relatedTitles: [],
            },
          ],
        }),
      ],
    });
    const { jobId, staged } = await prepareDraft(provider);

    // 先造一条已裁决的事项，再提交一次让 prompt 里带上它
    const { decideReviewItem } = await import("@/lib/lint");
    await commitIngest({ jobId, draft: staged.draft });

    const seeded = getDb().select().from(reviewItems).all();
    expect(seeded.length).toBeGreaterThan(0);
    decideReviewItem(seeded[0].id, "accepted", "以研发同事的说法为准");

    // 第二次导入 —— 换一份文件：同一份会被 sha256 去重拦下，模型根本不会被调用
    const second = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const secondInput = {
      fileName: "sample.md",
      buffer: fs.readFileSync(path.join(FIXTURES, "sample.md")),
      provider: second,
    };
    const { jobId: secondJob } = startIngest(secondInput);
    await waitForJob(secondJob, "settled");

    const prompts = second.calls.map((call) => call.messages.map((m) => m.content).join("\n"));
    expect(prompts.some((p) => p.includes("以研发同事的说法为准"))).toBe(true);
  });

  it("升级前生成的旧草稿仍然提交得了", () => {
    // jobs 表里存着没有 question / options 字段的草稿。加必填字段会让用户手上
    // 那份待审草稿在 safeParse 直接失败 —— 白审一遍。relatedTitles 吃过这个亏。
    const legacy = {
      sourceSummary: { title: "旧摘要", content: "正文" },
      newPages: [],
      updatedPages: [],
      reviewItems: [
        {
          kind: "contradiction",
          title: "一条老事项",
          detail: "详情",
          severity: "warning",
          relatedTitles: ["某词条"],
        },
      ],
    };

    const parsed = DraftSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.reviewItems[0].question).toBe("");
      expect(parsed.data.reviewItems[0].options).toEqual([]);
    }
  });
});
