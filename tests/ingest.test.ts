import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { startIngest, commitIngest, discardIngest, loadIngestDraft, listSources, type IngestDraft } from "@/lib/ingest/pipeline";
import { getJob, markInterruptedAsFailed } from "@/lib/jobs/runner";
import { dropAllIndexTables, getDb } from "@/lib/db/client";
import { pages, sources as sourcesTable, reviewItems, jobs } from "@/lib/db/schema";
import { FakeProvider } from "@/lib/llm/fake";
import { stopWatcher } from "@/lib/index/watcher";
import { clearSuppression } from "@/lib/index/watch-suppression";
import { resetVault, vaultRoot, readPageRaw } from "./helpers";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");

/** 一份内容丰富的分析结果，供假 provider 使用 */
function fakeAnalysis(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    gist: "介绍推荐算法的基本原理与协同过滤的两类方法。",
    language: "中文",
    entities: [
      { name: "字节跳动", type: "机构", description: "一家科技公司", mentions: 1, evidence: "字节跳动大规模应用了这类方法。" },
    ],
    concepts: [
      { name: "推荐算法", description: "信息过滤技术的子类", evidence: "推荐算法是信息过滤技术的子类，用于预测用户对条目的评分或偏好。" },
      { name: "协同过滤", description: "一类推荐方法", evidence: "协同过滤分为基于用户与基于物品两类。" },
    ],
    relations: [
      { source: "字节跳动", target: "推荐算法", type: "应用于", description: "大规模应用了这类方法" },
    ],
    overlaps: [],
    contradictions: [],
    gaps: [],
    ...overrides,
  });
}

function fakeDraft(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    sourceSummary: {
      title: "推荐算法概述",
      content: "这份资料介绍了 [[推荐算法]] 的基本原理，以及 [[协同过滤]] 的两类方法。",
    },
    newPages: [
      {
        type: "concept",
        title: "推荐算法",
        summary: "信息过滤技术的子类",
        content: "推荐算法是信息过滤技术的子类，用于预测用户对条目的评分或偏好。\n\n由 [[字节跳动]] 大规模应用。",
        aliases: ["推荐系统"],
        tags: ["算法"],
        confidence: "high",
        citations: [{ page: null, quote: "推荐算法是信息过滤技术的子类，用于预测用户对条目的评分或偏好。" }],
      },
      {
        type: "concept",
        title: "协同过滤",
        summary: "一类推荐方法",
        content: "协同过滤分为基于用户与基于物品两类。",
        aliases: ["Collaborative Filtering"],
        tags: ["算法"],
        confidence: "high",
        citations: [{ page: null, quote: "协同过滤分为基于用户与基于物品两类。" }],
      },
      {
        type: "entity",
        title: "字节跳动",
        summary: "一家科技公司",
        content: "一家科技公司，大规模应用了 [[推荐算法]]。",
        aliases: [],
        tags: ["机构"],
        confidence: "medium",
        citations: [{ page: null, quote: "字节跳动大规模应用了这类方法。" }],
      },
    ],
    updatedPages: [],
    reviewItems: [
      {
        kind: "missing_page",
        title: "「信息过滤」还没有自己的词条",
        detail: "资料里多次提到信息过滤，但知识库中没有对应词条。",
        severity: "info",
        relatedTitles: ["信息过滤"],
      },
    ],
    ...overrides,
  });
}

/** 等待任务到达某个状态或终态 */
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
  throw new Error(`等待任务状态超时：${JSON.stringify(wanted)}，当前 ${JSON.stringify(getJob(jobId))}`);
}

function ingestInput(name: string, provider: FakeProvider) {
  return {
    fileName: name,
    buffer: fs.readFileSync(path.join(FIXTURES, name)),
    provider,
  };
}

afterEach(async () => {
  await stopWatcher();
  clearSuppression();
});

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
  clearSuppression();
});

describe("导入流水线 —— 完整流程", () => {
  it("从文件走到审阅态，产出草稿", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.docx", provider));

    const job = await waitForJob(jobId, "settled");
    expect(job.status).toBe("awaiting_review");
    expect(job.stage).toBe("reviewing");

    const draft = loadIngestDraft<IngestDraft>(jobId);
    expect(draft).toBeTruthy();
    expect(draft!.draft.newPages).toHaveLength(3);
    expect(draft!.analysis.entities[0].name).toBe("字节跳动");
  });

  it("原件被永久留存到 raw/", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.docx", provider));
    await waitForJob(jobId, "settled");

    const draft = loadIngestDraft<IngestDraft>(jobId)!;
    expect(draft.source.docPath).toMatch(/^raw\/\d{4}-\d{2}-\d{2}-/);
    expect(fs.existsSync(path.join(vaultRoot(), draft.source.docPath))).toBe(true);
    // 字节数与原件一致 —— 不是转换结果，是原封不动的原件
    const original = fs.readFileSync(path.join(FIXTURES, "sample.docx"));
    expect(fs.readFileSync(path.join(vaultRoot(), draft.source.docPath)).equals(original)).toBe(true);
  });

  it("解析产物存到 .weave/parsed（派生数据不进 git）", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.docx", provider));
    await waitForJob(jobId, "settled");

    const draft = loadIngestDraft<IngestDraft>(jobId)!;
    expect(fs.existsSync(path.join(vaultRoot(), ".weave", "parsed", `${draft.source.id}.md`))).toBe(true);
  });

  it("来源记录写入数据库", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.docx", provider));
    await waitForJob(jobId, "settled");

    const rows = getDb().select().from(sourcesTable).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].parser).toBe("mammoth");
    expect(rows[0].sha256).toHaveLength(64);
  });

  it("进度事件被推送，前端能看到阶段变化", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { subscribe } = await import("@/lib/jobs/runner");
    const { jobId } = startIngest(ingestInput("sample.docx", provider));

    const stages: string[] = [];
    const unsubscribe = subscribe(jobId, (event) => {
      if (event.type === "stage") stages.push(event.stage);
    });

    await waitForJob(jobId, "settled");
    unsubscribe();

    expect(stages).toContain("parsing");
    expect(stages).toContain("analyzing");
    expect(stages).toContain("drafting");
    expect(stages).toContain("reviewing");
  });
});

describe("导入流水线 —— 查重", () => {
  it("同一份文件导入两次，第二次被拦截", async () => {
    const provider = new FakeProvider({
      responses: [fakeAnalysis(), fakeDraft(), fakeAnalysis(), fakeDraft()],
    });
    const first = startIngest(ingestInput("sample.docx", provider));
    await waitForJob(first.jobId, "settled");
    // 先提交第一次，让来源记录落库
    const draft = loadIngestDraft<IngestDraft>(first.jobId)!;
    await commitIngest({ jobId: first.jobId, draft: draft.draft });

    const second = startIngest(ingestInput("sample.docx", provider));
    const job = await waitForJob(second.jobId, "settled");

    expect(job.status).toBe("done");
    const result = job.result as { duplicate?: { kind: string; existingName: string } };
    expect(result.duplicate?.kind).toBe("exact");
    expect(result.duplicate?.existingName).toBe("sample.docx");
  });

  it("只导入了一次就只有一个来源记录", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.docx", provider));
    await waitForJob(jobId, "settled");
    expect(getDb().select().from(sourcesTable).all()).toHaveLength(1);
  });
});

describe("导入流水线 —— 引用校验", () => {
  it("编造的引用被剔除", async () => {
    const provider = new FakeProvider({
      responses: [
        fakeAnalysis(),
        fakeDraft({
          newPages: [
            {
              type: "concept",
              title: "推荐算法",
              summary: "x",
              content: "正文",
              aliases: [],
              tags: [],
              confidence: "high",
              citations: [
                { page: null, quote: "推荐算法是信息过滤技术的子类，用于预测用户对条目的评分或偏好。" },
                { page: null, quote: "这段引用在原文里根本不存在，是模型编出来的。" },
              ],
            },
          ],
        }),
      ],
    });

    const { jobId } = startIngest(ingestInput("sample.docx", provider));
    await waitForJob(jobId, "settled");

    const draft = loadIngestDraft<IngestDraft>(jobId)!;
    expect(draft.draft.newPages[0].citations).toHaveLength(1);
    expect(draft.draft.newPages[0].citations[0].quote).toContain("信息过滤技术");
  });

  it("引用校验的日志如实报告剔除数量", async () => {
    const provider = new FakeProvider({
      responses: [
        fakeAnalysis(),
        fakeDraft({
          newPages: [{
            type: "concept", title: "甲", summary: "x", content: "正文",
            aliases: [], tags: [], confidence: "high",
            citations: [{ page: null, quote: "完全编造的内容不存在的引用文本" }],
          }],
        }),
      ],
    });
    const { subscribe } = await import("@/lib/jobs/runner");
    const { jobId } = startIngest(ingestInput("sample.docx", provider));
    const logs: string[] = [];
    subscribe(jobId, (e) => { if (e.type === "log") logs.push(e.message); });
    await waitForJob(jobId, "settled");

    expect(logs.join("\n")).toContain("找不到对应片段");
  });
});

describe("导入流水线 —— 提交入库", () => {
  // name 可换：同一个用例里连续导入两次时，第二份必须是**内容不同**的文件，
  // 否则会被查重闸门拦住（那是另一个用例专门验证的行为）
  async function prepareDraft(name = "sample.docx") {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput(name, provider));
    await waitForJob(jobId, "settled");
    return { jobId, draft: loadIngestDraft<IngestDraft>(jobId)! };
  }

  it("新建的词条落盘并被索引", async () => {
    const { jobId, draft } = await prepareDraft();
    const result = await commitIngest({ jobId, draft: draft.draft });

    expect(result.createdPages).toHaveLength(4); // 来源摘要页 + 3 个词条
    const indexed = getDb().select().from(pages).all();
    expect(indexed.map((p) => p.title)).toContain("推荐算法");
    expect(indexed.map((p) => p.title)).toContain("协同过滤");
    expect(indexed.map((p) => p.title)).toContain("字节跳动");
  });

  it("词条之间用双链连起来，图谱里出现边", async () => {
    const { jobId, draft } = await prepareDraft();
    await commitIngest({ jobId, draft: draft.draft });

    const { edges } = await import("@/lib/db/schema");
    const allEdges = getDb().select().from(edges).all();
    expect(allEdges.length).toBeGreaterThan(0);
  });

  // 审阅队列的三件事（入队、涉及词条、当场裁决）合在一个用例里断言。
  // 每多一次 commitIngest 就多一次完整的 reindex + git 提交，而这个文件已经
  // 跑到 20 秒超时线的边缘了 —— 拆成四个用例会让后面每个都更慢。
  it("审阅队列：入队、涉及词条、当场裁决", async () => {
    // ---- ① 没裁决的按待裁决入队 ----
    const first = await prepareDraft();
    const result = await commitIngest({ jobId: first.jobId, draft: first.draft.draft });
    expect(result.reviewItemCount).toBe(1);

    let items = getDb().select().from(reviewItems).all();
    expect(items[0].kind).toBe("missing_page");
    expect(items[0].status).toBe("pending");
    expect(items[0].decisionNote).toBeNull();

    // 涉及词条记的是模型指认的那个名字，不是本次导入碰过的全部词条 id。
    // 「信息过滤」还没有词条，所以只有标题没有 id。
    // 回归点：早先这里写的是本次导入新建/更新的全部词条 id（界面上就是一排 ULID）
    expect(JSON.parse(items[0].relatedPagesJson ?? "[]")).toEqual([
      { id: null, title: "信息过滤" },
    ]);

    // ---- ② 当场裁决的直接落成终态，并能回灌给下一轮 ----
    const second = await prepareDraft("sample.md");
    await commitIngest({
      jobId: second.jobId,
      draft: second.draft.draft,
      overrides: { skippedTitles: ["推荐算法概述", "推荐算法", "协同过滤", "字节跳动"] },
      decisions: [{ index: 0, decision: "accepted", note: "确认它确实缺一个词条" }],
    });

    items = getDb().select().from(reviewItems).all();
    const decided = items.find((row) => row.status === "accepted")!;
    expect(decided.decisionNote).toBe("确认它确实缺一个词条");
    expect(decided.resolvedAt).toBeTruthy();

    const { recentDecisions } = await import("@/lib/lint");
    const decisions = recentDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("accepted");
    expect(decisions[0].note).toBe("确认它确实缺一个词条");
  });

  it("提交产生一个 git commit", async () => {
    const { jobId, draft } = await prepareDraft();
    const result = await commitIngest({ jobId, draft: draft.draft });
    expect(result.commitSha).toBeTruthy();
  });

  it("用户在审阅时删掉的词条不会被创建", async () => {
    const { jobId, draft } = await prepareDraft();
    const edited = {
      ...draft.draft,
      newPages: draft.draft.newPages.filter((p) => p.title !== "协同过滤"),
    };

    await commitIngest({ jobId, draft: edited });
    const titles = getDb().select().from(pages).all().map((p) => p.title);
    expect(titles).not.toContain("协同过滤");
    expect(titles).toContain("推荐算法");
  });

  it("发现重名时整份草稿不写入，并保留供用户处理", async () => {
    const { jobId, draft } = await prepareDraft();
    const { createPage } = await import("@/lib/vault/service");
    createPage({ type: "concept", title: "推荐算法", content: "用户已有页面。" });
    const pageCount = getDb().select().from(pages).all().length;

    await expect(commitIngest({ jobId, draft: draft.draft })).rejects.toThrow("未写入任何内容");
    expect(getDb().select().from(pages).all()).toHaveLength(pageCount);
    expect(getDb().select().from(reviewItems).all()).toHaveLength(0);
    expect(loadIngestDraft<IngestDraft>(jobId)).toBeTruthy();
    expect(getJob(jobId)?.status).toBe("awaiting_review");
  });

  it("更新目标在审阅期间发生变化时不写入其他草稿内容", async () => {
    const { createPage, updatePage } = await import("@/lib/vault/service");
    const existing = createPage({ type: "concept", title: "推荐算法", content: "草稿生成前的正文。" });
    const provider = new FakeProvider({
      responses: [
        fakeAnalysis(),
        fakeDraft({
          newPages: [],
          updatedPages: [{
            title: "推荐算法",
            reason: "补充资料",
            proposedContent: "完整改写正文。",
            appendContent: "",
            addAliases: [],
            addTags: [],
            citations: [],
          }],
        }),
      ],
    });
    const { jobId } = startIngest(ingestInput("sample.html", provider));
    await waitForJob(jobId, "settled");
    const draft = loadIngestDraft<IngestDraft>(jobId)!;
    updatePage(existing.pageId, { content: "用户的新正文。" });
    const pageCount = getDb().select().from(pages).all().length;

    await expect(commitIngest({ jobId, draft: draft.draft })).rejects.toThrow("未写入任何内容");
    expect(readPageRaw(existing.relativePath)).toContain("用户的新正文。");
    expect(getDb().select().from(pages).all()).toHaveLength(pageCount);
    expect(loadIngestDraft<IngestDraft>(jobId)).toBeTruthy();
  });

  it("用户在审阅时改过的内容被如实写入", async () => {
    const { jobId, draft } = await prepareDraft();
    const edited = {
      ...draft.draft,
      newPages: draft.draft.newPages.map((p) =>
        p.title === "推荐算法" ? { ...p, content: "这是用户手改过的正文。" } : p,
      ),
    };

    await commitIngest({ jobId, draft: edited });
    const row = getDb().select().from(pages).all().find((p) => p.title === "推荐算法")!;
    expect(readPageRaw(row.filePath)).toContain("这是用户手改过的正文。");
  });

  it("index.md 被更新，新词条出现在目录里", async () => {
    const { jobId, draft } = await prepareDraft();
    await commitIngest({ jobId, draft: draft.draft });
    const index = readPageRaw("index.md");
    expect(index).toContain("[[推荐算法]]");
  });

  it("log.md 记下这次导入", async () => {
    const { jobId, draft } = await prepareDraft();
    await commitIngest({ jobId, draft: draft.draft });
    const log = readPageRaw("log.md");
    expect(log).toContain("INGEST");
    expect(log).toContain("sample.docx");
  });

  it("更新已有词条时只追加，不覆盖用户编辑过的内容", async () => {
    const { jobId, draft } = await prepareDraft();
    await commitIngest({ jobId, draft: draft.draft });

    // 用户手工改了「推荐算法」
    const row = getDb().select().from(pages).all().find((p) => p.title === "推荐算法")!;
    const { updatePage } = await import("@/lib/vault/service");
    updatePage(row.id, { content: "用户手工重写的正文。" });

    // 再来一次导入，要求追加到这个词条
    const provider2 = new FakeProvider({
      responses: [
        fakeAnalysis(),
        fakeDraft({
          newPages: [],
          updatedPages: [{
            title: "推荐算法",
            reason: "补充新来源",
            appendContent: "这里是新追加的内容。",
            addAliases: ["推荐引擎"],
            addTags: ["新标签"],
            citations: [],
          }],
        }),
      ],
    });
    const second = startIngest({
      fileName: "sample.html",
      buffer: fs.readFileSync(path.join(FIXTURES, "sample.html")),
      provider: provider2,
    });
    await waitForJob(second.jobId, "settled");
    const secondDraft = loadIngestDraft<IngestDraft>(second.jobId)!;
    await commitIngest({
      jobId: second.jobId,
      draft: secondDraft.draft,
      overrides: { skippedTitles: ["推荐算法概述"] },
    });

    const content = readPageRaw(row.filePath);
    expect(content).toContain("用户手工重写的正文。");
    expect(content).toContain("这里是新追加的内容。");
    expect(content).toContain("推荐引擎");
  });
});

describe("导入流水线 —— 放弃与中断", () => {
  it("放弃草稿时原件保留 —— 不删用户的资料", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.txt", provider));
    await waitForJob(jobId, "settled");

    const draft = loadIngestDraft<IngestDraft>(jobId)!;
    discardIngest(jobId);

    expect(fs.existsSync(path.join(vaultRoot(), draft.source.docPath))).toBe(true);
    expect(getDb().select().from(pages).all()).toHaveLength(0);
  });

  it("中断的任务可以被识别并标记", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.md", provider));
    await waitForJob(jobId, "settled");

    const marked = markInterruptedAsFailed();
    expect(marked).toBeGreaterThanOrEqual(0);
  });

  it("写入中断后保留草稿并恢复到可审阅状态", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.txt", provider));
    await waitForJob(jobId, "settled");
    getDb().update(jobs).set({ status: "committing" }).where(eq(jobs.id, jobId)).run();

    expect(markInterruptedAsFailed()).toBe(1);
    expect(getJob(jobId)?.status).toBe("awaiting_review");
    expect(loadIngestDraft<IngestDraft>(jobId)).toBeTruthy();
  });
});

/**
 * 失败之后能不能重来。
 *
 * 这是从真实事故里补的一条：用户导入一份 16KB 的资料，模型端点在第 7 分钟
 * 超时，任务失败。他再导一次同一份文件 —— 得到的是「这份资料已经导入过了」，
 * 而知识库里其实一个字都没有。原因不在失败本身，在查重只认 sha256、
 * 不认那一行到底走没走完。
 */
describe("导入流水线 —— 失败之后可以重来", () => {
  it("起草阶段失败后，同一份文件还能重新导入", async () => {
    // 第一次：模型端点报错，任务在分析阶段就断了
    const broken = new FakeProvider({ responses: [{ error: "端点 500", retryable: true }] });
    const first = startIngest(ingestInput("sample.md", broken));
    const failed = await waitForJob(first.jobId, "settled");
    expect(failed.status).toBe("failed");

    // 第二次：同样的文件名、同样的字节，必须能正常走完
    const good = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const second = startIngest(ingestInput("sample.md", good));
    const job = await waitForJob(second.jobId, "settled");
    expect(job.status).toBe("awaiting_review");
    expect(loadIngestDraft<IngestDraft>(second.jobId)).toBeTruthy();
  });

  it("编译成功之后仍然是重复 —— 查重没有被放宽成「永不拦」", async () => {
    const provider = new FakeProvider({
      responses: [fakeAnalysis(), fakeDraft(), fakeAnalysis(), fakeDraft()],
    });
    const first = startIngest(ingestInput("sample.txt", provider));
    await waitForJob(first.jobId, "settled");
    await commitIngest({ jobId: first.jobId, draft: loadIngestDraft<IngestDraft>(first.jobId)!.draft });

    const again = startIngest(ingestInput("sample.txt", provider));
    const job = await waitForJob(again.jobId, "settled");
    expect(job.status).toBe("done");
    expect((job.result as { duplicate?: unknown }).duplicate).toBeTruthy();
  });

  it("放弃草稿之后也能重新导入 —— 「待处理」不是「已编译」", async () => {
    const provider = new FakeProvider({
      responses: [fakeAnalysis(), fakeDraft(), fakeAnalysis(), fakeDraft()],
    });
    const first = startIngest(ingestInput("sample.html", provider));
    await waitForJob(first.jobId, "settled");
    discardIngest(first.jobId);

    const second = startIngest(ingestInput("sample.html", provider));
    const job = await waitForJob(second.jobId, "settled");
    expect(job.status).toBe("awaiting_review");
  });
});

/**
 * 任务生命周期。
 *
 * 为什么要专门盯这两条：界面上「还有一份草稿等你审阅」的提示，是靠
 * /api/jobs?active=1 找未结束的任务得来的。提交与放弃都发生在 HTTP 请求里、
 * 不由任务自己收尾 —— 少写一步，那行记录就永远停在 awaiting_review，
 * 于是用户明明已经确认写入了，每次刷新页面指示器还在催他。
 */
describe("导入流水线 —— 任务收尾", () => {
  it("提交之后任务收尾为 done，进度补满", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.txt", provider));
    await waitForJob(jobId, "settled");
    const draft = loadIngestDraft<IngestDraft>(jobId)!;

    expect(getJob(jobId)!.status).toBe("awaiting_review");
    await commitIngest({ jobId, draft: draft.draft });

    const job = getJob(jobId)!;
    expect(job.status).toBe("done");
    expect(job.progress).toBe(100);
    expect(job.finishedAt).not.toBeNull();
    expect(loadIngestDraft<IngestDraft>(jobId)).toBeNull();
  });

  it("同一份草稿只能提交一次", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.html", provider));
    await waitForJob(jobId, "settled");
    const draft = loadIngestDraft<IngestDraft>(jobId)!;
    await commitIngest({ jobId, draft: draft.draft });
    const pageCount = getDb().select().from(pages).all().length;
    const reviewCount = getDb().select().from(reviewItems).all().length;

    await expect(commitIngest({ jobId, draft: draft.draft })).rejects.toThrow("草稿");
    expect(getDb().select().from(pages).all()).toHaveLength(pageCount);
    expect(getDb().select().from(reviewItems).all()).toHaveLength(reviewCount);
  });

  it("放弃之后任务收尾为 cancelled", async () => {
    const provider = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    const { jobId } = startIngest(ingestInput("sample.md", provider));
    await waitForJob(jobId, "settled");

    discardIngest(jobId);
    expect(getJob(jobId)!.status).toBe("cancelled");
  });
});

describe("导入流水线 —— 模型配置缺失", () => {
  it("没有配置模型时给出可操作的错误", async () => {
    // 不注入 provider，走 createProvider()
    const { jobId } = startIngest({
      fileName: "sample.md",
      buffer: fs.readFileSync(path.join(FIXTURES, "sample.md")),
    });
    const job = await waitForJob(jobId, "settled");
    expect(job.status).toBe("failed");
    expect(job.error).toContain("模型服务");
  });
});

describe("导入中断后的持久化续传", () => {
  it("起草失败后恢复原任务，复用解析和分析，不重复请求分析", async () => {
    const { resumeIngest } = await import("@/lib/ingest/pipeline");
    const first = new FakeProvider({ responses: [fakeAnalysis(), { error: "connection lost" }] });
    const { jobId } = startIngest(ingestInput("sample.docx", first));
    expect(await waitForJob(jobId, "settled")).toMatchObject({ status: "failed", stage: "drafting" });
    const source = listSources()[0];
    expect(fs.existsSync(path.join(vaultRoot(), '.weave', 'ingest-checkpoints', `${source.id}.json`))).toBe(true);
    const resumed = new FakeProvider({ responses: [fakeDraft()] });
    expect(resumeIngest(jobId, resumed).jobId).toBe(jobId);
    expect(await waitForJob(jobId, "settled")).toMatchObject({ status: "awaiting_review" });
    expect(resumed.calls).toHaveLength(1);
    expect(loadIngestDraft<IngestDraft>(jobId)?.analysis.gist).toContain("推荐算法");
    expect(listSources()).toHaveLength(1);
    await commitIngest({ jobId, draft: loadIngestDraft<IngestDraft>(jobId)!.draft });
    expect(fs.existsSync(path.join(vaultRoot(), '.weave', 'ingest-checkpoints', `${source.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(vaultRoot(), '.weave', 'ingest-inputs', `${jobId}.bin`))).toBe(false);
  });

  it("上传返回前保存完整输入，重启状态恢复后可以继续", async () => {
    const { resumeIngest } = await import("@/lib/ingest/pipeline");
    const bytes = fs.readFileSync(path.join(FIXTURES, "sample.docx"));
    const { jobId } = startIngest({ fileName: "sample.docx", buffer: bytes, provider: new FakeProvider({ responses: [fakeAnalysis(), { error: "interrupted" }] }) });
    expect(fs.readFileSync(path.join(vaultRoot(), '.weave', 'ingest-inputs', `${jobId}.bin`))).toEqual(bytes);
    await waitForJob(jobId, "settled");
    // 模拟进程离开时遗留的 running：重建内存订阅不参与缓存恢复。
    getDb().update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId)).run();
    markInterruptedAsFailed();
    (globalThis as unknown as { __weaveJobs?: unknown }).__weaveJobs = undefined;
    resumeIngest(jobId, new FakeProvider({ responses: [fakeDraft()] }));
    expect((await waitForJob(jobId, "settled")).status).toBe("awaiting_review");
  });

  it("多段资料保留已完成分段，失败后只处理剩余分段", async () => {
    const { resumeIngest } = await import("@/lib/ingest/pipeline");
    const bytes = Buffer.from("资料第一段。".repeat(1600) + "\n\n" + "资料第二段。".repeat(1600));
    const partial = new FakeProvider({ responses: [fakeAnalysis(), { error: "offline" }] });
    const { jobId } = startIngest({ fileName: "长资料.md", buffer: bytes, provider: partial });
    expect((await waitForJob(jobId, "settled")).status).toBe("failed");
    const source = listSources()[0];
    const checkpoint = JSON.parse(fs.readFileSync(path.join(vaultRoot(), '.weave', 'ingest-checkpoints', `${source.id}.json`), 'utf8'));
    expect(checkpoint.analyses).toHaveLength(1);
    expect(checkpoint.chunks.length).toBeGreaterThan(1);
    const rest = checkpoint.chunks.length - 1;
    const resumed = new FakeProvider({ responses: [...Array(rest).fill(fakeAnalysis()), ...Array(checkpoint.chunks.length).fill(fakeDraft())] });
    resumeIngest(jobId, resumed);
    expect((await waitForJob(jobId, "settled")).status).toBe("awaiting_review");
    expect(resumed.calls).toHaveLength(rest + checkpoint.chunks.length);
  });

  it("知识库变化使旧模型建议失效，但仍复用解析稿", async () => {
    const { resumeIngest } = await import("@/lib/ingest/pipeline");
    const { createPage } = await import("@/lib/vault/service");
    const { jobId } = startIngest(ingestInput("sample.docx", new FakeProvider({ responses: [fakeAnalysis(), { error: "offline" }] })));
    await waitForJob(jobId, "settled");
    createPage({ type: "concept", title: "新知识", content: "恢复前发生了改变。" });
    const resumed = new FakeProvider({ responses: [fakeAnalysis(), fakeDraft()] });
    resumeIngest(jobId, resumed);
    expect((await waitForJob(jobId, "settled")).status).toBe("awaiting_review");
    expect(resumed.calls).toHaveLength(2);
  });
});

it("主动取消保留已完成分析，继续时只重新请求未完成草稿", async () => {
  const { cancel } = await import('@/lib/jobs/runner');
  const { resumeIngest } = await import('@/lib/ingest/pipeline');
  const provider = new FakeProvider({ responses: [fakeAnalysis()] });
  let waiting = false;
  const original = provider.complete.bind(provider);
  provider.complete = async request => {
    if (!waiting) { waiting = true; return original(request); }
    return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }));
  };
  const { jobId } = startIngest(ingestInput('sample.docx', provider));
  for (let i = 0; i < 100 && getJob(jobId)?.stage !== 'drafting'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(getJob(jobId)?.stage).toBe('drafting'); expect(cancel(jobId)).toBe('cancelled');
  expect((await waitForJob(jobId, 'settled')).status).toBe('cancelled');
  const resumed = new FakeProvider({ responses: [fakeDraft()] });
  resumeIngest(jobId, resumed);
  expect((await waitForJob(jobId, 'settled')).status).toBe('awaiting_review');
  expect(resumed.calls).toHaveLength(1);
});
