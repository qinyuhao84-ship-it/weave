import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { and, eq, isNotNull } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb } from "@/lib/db/client";
import { pages, links, redirects, reviewItems, indexMeta, type ReviewRelatedPage } from "@/lib/db/schema";
import {
  buildTitleIndex, parseRelatedPages, relatedPagesFromTitles,
} from "@/lib/review/related-pages";
import type { RemediationRecord } from "@/lib/review/remediate";
import {
  parseQuestion, normalizeAnswer, normalizeQuestion,
  type ReviewOption,
} from "@/lib/review/questions";
import { WORK_DIR, absolutePath } from "@/lib/vault/paths";
import { readFileIfExists, sha256, writeFileAtomic } from "@/lib/vault/atomic";
import { localISOString, truncate } from "@/lib/utils";
import { buildCatalog, renderCatalogForPrompt, graphStats } from "@/lib/index/catalog";
import { flattenRedirects } from "@/lib/index/reindex";
import { createProvider } from "@/lib/llm";
import { completeStructured } from "@/lib/llm/structured";
import {
  LintSchema, buildLintPrompt,
  type LintResult, type DecisionContext,
} from "@/lib/llm/prompts";
import { appendLog } from "@/lib/vault/service";
import { backupVault, withCommitOperation } from "@/lib/git/auto-commit";
import { enqueue, type JobContext } from "@/lib/jobs/runner";
import type { LlmProvider } from "@/lib/llm/types";

/**
 * ============================================================================
 * Lint —— 知识库体检
 * ============================================================================
 *
 * 这是原始 LLM Wiki 理念里明确要求的**第三个核心操作**（Ingest / Query / Lint），
 * 也是最容易被实现者漏掉的一环。原文要求检查：词条间的矛盾、被新来源推翻的
 * 过时论断、没有入链的孤儿页、被反复提及却没有自己词条的概念、缺失的交叉引用。
 *
 * 为什么必须做：原文自己承认这套 wiki 是「由 LLM 写、由 LLM 维护、由 LLM 查询」
 * 的活草稿。这类系统的典型失效模式不是某一次错误，而是**错误静默复利** ——
 * 一个错误论断留在词条里，被后续词条引用，再被引用它的人当成前提。
 * Lint 就是定期阻断这个复利过程的机制。
 *
 * 分工原则：**能用程序算出来的绝不交给模型**。死链、孤儿页、断链统计都是
 * 确定性的，让模型去"发现"它们既浪费 token 又不可靠。模型只负责真正需要
 * 判断力的事：矛盾、过时、重复。
 */

/* ------------------------------------------------------------ 客观检查 */

export type MechanicalFinding = {
  kind: "broken_link" | "orphan" | "missing_page" | "double_redirect";
  /** 缺页或已删除词条的目标名称；用于把缺失目标一并交给修订模型 */
  target?: string;
  title: string;
  detail: string;
  severity: "info" | "warning" | "critical";
  pages: string[];
  suggestion: string;
};

/** 程序能算出来的问题。不调模型，零成本，随时可跑。 */
export function runMechanicalChecks(): MechanicalFinding[] {
  const db = getDb();
  const findings: MechanicalFinding[] = [];

  const activePages = db.select().from(pages).where(eq(pages.status, "active")).all();
  const allLinks = db.select().from(links).all();
  const deletedPages = db.select().from(pages).where(eq(pages.status, "deleted")).all();
  const pageById = new Map(activePages.map((p) => [p.id, p]));

  const deletedNames = new Set<string>();
  for (const deleted of deletedPages) {
    try {
      for (const name of JSON.parse(deleted.normalizedNames) as string[]) deletedNames.add(name);
    } catch {
      // 坏的索引数据，跳过
    }
  }

  // --- 死链：区分「从未存在」与「被删过」 ---
  const dangling = new Map<string, { count: number; sources: Set<string> }>();
  for (const link of allLinks) {
    if (link.dstPageId) continue;
    const entry = dangling.get(link.dstNormalized) ?? { count: 0, sources: new Set<string>() };
    entry.count += link.occurrences;
    const source = pageById.get(link.srcPageId);
    if (source) entry.sources.add(source.title);
    dangling.set(link.dstNormalized, entry);
  }

  for (const [target, entry] of dangling) {
    const sourceList = [...entry.sources];
    const shown = sourceList.slice(0, 3).join("、");
    const suffix = sourceList.length > 3 ? " 等" : "";

    if (deletedNames.has(target)) {
      findings.push({
        kind: "broken_link",
        target,
        title: `词条「${target}」仍有引用但已被删除`,
        detail: `引用来自：${shown}${suffix}。可以恢复到回收站里的版本，或把这些引用改指向别的词条。`,
        severity: "warning",
        pages: sourceList,
        suggestion: `恢复「${target}」，或把引用改指向相关词条`,
      });
    } else {
      findings.push({
        kind: "missing_page",
        target,
        title: `词条「${target}」被引用但尚未创建`,
        detail: `引用来自：${shown}${suffix}。被反复提及说明它值得有一个词条。`,
        severity: "info",
        pages: sourceList,
        suggestion: `为「${target}」创建词条`,
      });
    }
  }

  // --- 孤儿页：没有任何入链 ---
  const inbound = new Set(allLinks.map((l) => l.dstPageId).filter(Boolean));
  const orphans = activePages.filter((p) => p.type !== "source" && !inbound.has(p.id));
  if (orphans.length > 0) {
    findings.push({
      kind: "orphan",
      title: "有词条缺少入链",
      detail:
        `${orphans.slice(0, 8).map((p) => `「${p.title}」`).join("、")}${orphans.length > 8 ? " 等" : ""}。` +
        `这些词条没有其他页面指向它们，仍可通过标题或正文搜索找到；补充入链有助于从其他知识导航过来。`,
      severity: "info",
      pages: orphans.map((p) => p.title),
      suggestion: "在相关词条里补上指向它们的双链，或确认它们是否应该被合并",
    });
  }

  // --- 双重重定向：A→B、B→C 应当被压平成 A→C ---
  const redirectRows = db.select().from(redirects).all();
  const redirectedTargets = new Set(redirectRows.map((r) => r.newPageId));
  const liveIds = new Set([...activePages.map((p) => p.id), ...deletedPages.map((p) => p.id)]);
  const doubles = redirectRows.filter(
    (row) => !liveIds.has(row.newPageId) || redirectedTargets.has(row.newPageId),
  );
  if (doubles.length > 0) {
    findings.push({
      kind: "double_redirect",
      title: `${doubles.length} 条重定向需要压平`,
      detail: `例如「${doubles[0].oldRaw}」指向的目标本身又指向了别处，导致 [[旧名]] 要跳两次甚至跳丢。`,
      severity: "info",
      pages: [],
      suggestion: "执行重定向压平（合并时已自动处理，这里是被外部编辑器改乱的情况）",
    });
  }

  return findings;
}

/* ------------------------------------------------------------ 主观检查 */

export type LintReport = {
  mechanical: MechanicalFinding[];
  /** 模型发现的问题 */
  llm: LintResult["findings"];
  /** 是否因为未配置模型而跳过了 LLM 部分 */
  llmSkipped: boolean;
  stats: ReturnType<typeof graphStats>;
  /** 本次新写入审阅队列的条数 */
  queued: number;
  /**
   * 程序自动修掉的问题。界面必须如实说出来 —— 悄悄改掉比不改更糟。
   * 见 runLint 里那段自动压平的注释。
   */
  autoFixed: { flattenedRedirects: number };
  durationMs: number;
  coverage: LintCoverage;
};

export type LintCoverage = { sampledPages: number; totalPages: number; checkedSegments: number; totalSegments: number; remainingSegments: number };
type CoverageState = Record<string, { hash: string; checked: number; lastChecked: number }>;
const COVERAGE_KEY = "lint:semantic-coverage";
const LintCheckpointSchema = z.object({
  catalogHash: z.string(), result: LintSchema,
  coverage: z.object({ sampledPages: z.number(), totalPages: z.number(), checkedSegments: z.number(), totalSegments: z.number(), remainingSegments: z.number() }),
  coverageState: z.record(z.string(), z.object({ hash: z.string(), checked: z.number(), lastChecked: z.number() })),
});
function persistCoverage(state: CoverageState) {
  getDb().insert(indexMeta).values({ key: COVERAGE_KEY, value: JSON.stringify(state), updatedAt: localISOString() }).onConflictDoUpdate({ target: indexMeta.key, set: { value: JSON.stringify(state), updatedAt: localISOString() } }).run();
}

export type RunLintOptions = {
  provider?: LlmProvider;
  /** 抽样多少个词条给模型看。词条多时必须抽样，否则上下文装不下 */
  sampleSize?: number;
  /** 只跑程序检查，不调模型 */
  mechanicalOnly?: boolean;
  /**
   * 后台任务上下文。
   *
   * 传了才会报进度、才会响应停止。同步调用（测试、脚本、任何只想立刻拿到
   * 一份报告的场合）不传它，行为与从前完全一致 —— 这是刻意的：把体检搬进后台
   * 任务队列，不该让「把它当普通函数调用」的那条路付出任何代价。
   */
  context?: JobContext;
};

/**
 * 启动一次后台体检。
 *
 * 为什么体检必须走后台任务，而不是像早先那样在 POST /api/lint 里 await 完：
 * 一次体检是一整块分钟级的模型调用，挂在请求生命周期里就同时丢掉了三件事 ——
 * 用户关掉页面就再也看不到结果、刷新一次进度归零、想停也停不下来。
 * 放进任务队列之后，进度落在 SQLite 里、事件走 SSE，页面只是个视图。
 * 这与导入（lib/ingest/pipeline.ts）和按批注修订（lib/review/remediate.ts）
 * 走的是同一条路。
 */
export function startLintJob(options: Omit<RunLintOptions, "context"> & { resumeJobId?: string } = {}): { jobId: string } {
  if (!options.mechanicalOnly) options = { ...options, provider: options.provider ?? createProvider() };
  const jobId = options.resumeJobId ?? ulid();
  enqueue({
    kind: "lint",
    jobId,
    resume: Boolean(options.resumeJobId),
    // 载荷记下这次是不是只跑了程序检查 —— 刷新页面后，界面靠它把任务说成人话
    payload: { mechanicalOnly: Boolean(options.mechanicalOnly) },
    handler: (context) => withCommitOperation("知识库体检", () => runLint({ ...options, context })),
  });
  return { jobId };
}

export async function runLint(options: RunLintOptions = {}): Promise<LintReport> {
  const startedAt = Date.now();
  const context = options.context;
  const checkpointPath = context && /^[0-9A-Z]{26}$/.test(context.jobId) ? path.join(WORK_DIR, "lint-checkpoints", `${context.jobId}.json`) : null;

  // ---- ① 程序检查：确定性的，毫秒级 ----
  context?.setStage("mechanical", "正在检查死链与孤儿页");
  const mechanical = runMechanicalChecks();
  const stats = graphStats();
  context?.setFraction(1);
  context?.log(`程序检查：${mechanical.length} 项`);
  // 取消只可能发生在阶段之间的等待点上，这里是最后一个不花时间的边界，
  // 过了它就要开始读文件、发模型请求了
  context?.throwIfCancelled();

  // ---- ② 程序能确定性修的，直接修掉 ----
  //
  // 双重重定向（A→B→C 压平成 A→C）是**信息无损**的等价改写，而且它只改
  // redirects 这张派生表 —— 不碰任何文件、不进 git，reindexAll 本来每次都会跑它。
  // 所以它不需要用户点头，也不该占着审阅队列。
  //
  // 放在取消检查**之后**：用户点了停止就什么都别留下。这条纪律与 runLint 的
  // 其余部分一致（见上面那行 throwIfCancelled 的注释）。
  //
  // 注意 flattenRedirects 的能力边界：它的 while 条件是「目标已不在 pages 表里」，
  // 所以修不了「A→B、B→C 且 B 仍在表里」那类双跳。能修几条如实报几条，
  // 不要在这里假定它能修更多。
  const flattenedRedirects = flattenRedirects();
  if (flattenedRedirects > 0) {
    context?.log(`已自动压平 ${flattenedRedirects} 条重定向链（不改任何词条文件）`);
  }

  let llmFindings: LintResult["findings"] = [];
  let llmSkipped = false;
  let coverage: LintCoverage = { sampledPages: 0, totalPages: stats.pages, checkedSegments: 0, totalSegments: 0, remainingSegments: 0 };

  if (options.mechanicalOnly) {
    llmSkipped = true;
  } else {
    try {
      const provider = options.provider ?? createProvider();

      // ---- ② 抽样：读词条正文 ----
      context?.setStage("sampling", "正在挑选要细看的词条");
      const catalog = buildCatalog();
      const catalogHash = sha256(JSON.stringify(catalog.map(entry => [entry.id, sha256(readFileIfExists(absolutePath(entry.filePath)) ?? "")])));
      let restored: z.infer<typeof LintCheckpointSchema> | null = null;
      if (checkpointPath) {
        try {
          const parsed = LintCheckpointSchema.parse(JSON.parse(fs.readFileSync(checkpointPath, "utf8")));
          if (parsed.catalogHash === catalogHash) restored = parsed;
        } catch { /* 无完整检查结果时重新判断。 */ }
      }
      if (restored) {
        llmFindings = restored.result.findings; coverage = restored.coverage;
        persistCoverage(restored.coverageState);
        context?.log("已恢复完成的模型检查结果，继续写入审阅队列。");
      } else {
        const sampling = sampleForReview(catalog, options.sampleSize ?? 12, context);
        const samples = sampling.samples;
        coverage = sampling.coverage;
        context?.setFraction(1);
        context?.log(`抽样 ${samples.length} 个词条交给模型细看`);

        // ---- ③ 模型判断：整块调用，中途拿不到任何真实进度 ----
        context?.setStage("judging", "模型正在通读抽样词条");
        const result = await completeStructured({
          provider,
          schema: LintSchema,
          schemaName: "lint_findings",
          temperature: 0.2,
          timeoutMs: 15 * 60_000,
          messages: [
            {
              role: "user",
              content: buildLintPrompt({
                catalog: renderCatalogForPrompt(catalog, { maxEntries: 200 }),
                samples: samples.map((s) => `## ${s.title}\n\n${s.content}`).join("\n\n---\n\n"),
                mechanical: mechanical.map((f) => `- [${f.kind}] ${f.title}：${f.detail}`).join("\n"),
                decisions: recentDecisions(),
              }),
            },
          ],
          // 这一行是「停止」能真正生效的前提：没有它，用户点了停止之后请求
          // 照样发到端点跑满两分钟，而界面已经显示「已取消」—— 那是撒谎。
          ...(context ? { signal: context.signal } : {}),
        });
        llmFindings = result.data.findings;
        // 先保留结果和覆盖账本，再写审阅事项；退出进程也不会丢掉已完成判断。
        if (checkpointPath) writeFileAtomic(checkpointPath, JSON.stringify({ catalogHash, result: result.data, coverage: sampling.completedCoverage, coverageState: sampling.coverageState }));
        sampling.recordSuccess();
        coverage = sampling.completedCoverage;
        context?.log(`语义检查累计覆盖 ${coverage.checkedSegments}/${coverage.totalSegments} 段；还有 ${coverage.remainingSegments} 段待检查。重复体检会轮换词条和正文段落。`);
        context?.setFraction(1);
      }
    } catch (error) {
      // 取消要走另一条路：它不是「模型不可用」。
      //
      // 下面那个降级分支的本意是「模型挂了也要把客观发现交出去」，
      // 但对取消来说，顺着它继续跑就等于**在用户点了停止之后照样写入审阅队列、
      // 照样提交一次 git**。用户点的是停止，那就什么都别留下。
      if (context?.isCancelled()) throw error;

      // 模型不可用不该让整个体检失败 —— 客观检查本身就有价值
      llmSkipped = true;
      console.warn("[lint] LLM 检查跳过：", error instanceof Error ? error.message : error);
    }
  }

  // ---- ④ 入队 ----
  context?.setStage("queuing", "正在写入审阅队列");
  context?.throwIfCancelled();
  const { queued, dropped } = queueFindings(mechanical, llmFindings);
  context?.setFraction(1);
  context?.log(`新入队 ${queued} 条`);
  if (dropped.length > 0) {
    // 说出来而不是闷掉：某条事项退回了「采纳 / 忽略」，用户有理由知道为什么
    context?.log(
      `有 ${dropped.length} 个模型给的选项不合用，已丢弃：${dropped.slice(0, 3).join("；")}`,
      "warning",
    );
  }

  // ---- ⑤ 收尾：写日志 + 提交 ----
  context?.setStage("committing", "正在收尾并提交");
  appendLog(
    "LINT",
    `体检完成：${mechanical.length} 项客观问题、${llmFindings.length} 项待判断事项，新入队 ${queued} 条` +
      (flattenedRedirects > 0 ? `，自动压平 ${flattenedRedirects} 条重定向链` : ""),
  );
  backupVault("体检了知识库");
  context?.setFraction(1);

  if (checkpointPath) { try { fs.rmSync(checkpointPath, { force: true }); } catch { /* 收尾已完成。 */ } }
  return {
    mechanical,
    llm: llmFindings,
    llmSkipped,
    stats,
    queued,
    autoFixed: { flattenedRedirects },
    durationMs: Date.now() - startedAt,
    coverage,
  };
}

/**
 * 抽样要挑「最该看的」词条，而不是随机抽。
 *
 * 优先级：入链多的（枢纽词条影响面大）> 内容长的（信息多、更可能有矛盾）
 * > 单来源支撑的（最可能已经过时）。
 */
export function sampleForReview(
  catalog: ReturnType<typeof buildCatalog>,
  size: number,
  context?: JobContext,
){
  const candidates = catalog;
  let state: CoverageState = {};
  try { const parsed = JSON.parse(getDb().select().from(indexMeta).where(eq(indexMeta.key, COVERAGE_KEY)).get()?.value ?? "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed; } catch { /* reset corrupt coverage only */ }

  // 打分要读正文（长度是权重之一），所以排序之前必须把候选全部读进来。
  // 这一步在词条多的时候是实打实的秒级开销，正好是体检里少数能报**真实**进度
  // 的地方 —— 每读完一个候选报一次，进度条在这一段不是估算出来的。
  const loaded: Array<{
    entry: (typeof candidates)[number];
    content: string;
    score: number;
    hash: string;
    checked: number;
    lastChecked: number;
    segments: number;
  }> = [];

  candidates.forEach((entry, index) => {
    const raw = readFileIfExists(absolutePath(entry.filePath));
    const content = raw ? extractBody(raw) : "";
    const hash = sha256(content);
    const previous = state[entry.id]?.hash === hash ? state[entry.id] : undefined;
    loaded.push({
      entry,
      content,
      hash,
      checked: previous?.checked ?? 0,
      lastChecked: previous?.lastChecked ?? 0,
      segments: Math.max(1, Math.ceil(Math.max(0, content.length - 160) / 1840)),
      score:
        entry.inboundLinks * 3 +
        Math.min(content.length / 200, 10) +
        (entry.sourceCount <= 1 ? 4 : 0),
    });
    context?.setFraction((index + 1) / Math.max(1, candidates.length));
  });

  const selected = [...loaded].sort((a, b) => a.lastChecked - b.lastChecked || b.score - a.score).slice(0, size);
  const samples = selected.map(item => {
    const segment = item.checked % item.segments;
    return { title: `${item.entry.title}（第 ${segment + 1}/${item.segments} 段）`, content: item.content.slice(segment * 1840, segment * 1840 + 2000) };
  });
  const totalSegments = loaded.reduce((sum, item) => sum + item.segments, 0);
  const checkedSegments = loaded.reduce((sum, item) => sum + Math.min(item.checked, item.segments), 0);
  const added = selected.filter(item => item.checked < item.segments).length;
  const coverage = { sampledPages: samples.length, totalPages: candidates.length, checkedSegments, totalSegments, remainingSegments: totalSegments - checkedSegments };
  const next: CoverageState = Object.fromEntries(loaded.map(item => [item.entry.id, { hash: item.hash, checked: item.checked, lastChecked: item.lastChecked }]));
  for (const item of selected) next[item.entry.id] = { hash: item.hash, checked: item.checked + 1, lastChecked: Math.max(Date.now(), ...loaded.map(page => page.lastChecked + 1)) };
  return {
    samples, coverage, coverageState: next,
    completedCoverage: { ...coverage, checkedSegments: checkedSegments + added, remainingSegments: totalSegments - checkedSegments - added },
    recordSuccess: () => { persistCoverage(next);
    },
  };
}

/**
 * 把体检发现写入审阅队列。
 *
 * 两条纪律：
 *   1. **去重**：同一个问题每次体检都会重现，每次都新建一条会让队列迅速
 *      变成噪音，用户就不看了 —— 那等于这个功能不存在。
 *   2. **只提议不执行**：LLM 的判断可能是错的，执行权必须留在人手里。
 */
function queueFindings(
  mechanical: MechanicalFinding[],
  llmFindings: LintResult["findings"],
): { queued: number; dropped: string[] } {
  const db = getDb();
  /**
   * 标题索引**懒构建**：只有真要插入新条目时才去读一遍全部词条。
   *
   * 这一懒是有实际价值的：体检的常态是新问题少、老问题多，而每一次体检都会
   * 走到这里。提前构建的话，一次「什么都没发现」的体检也要把整库文件读一遍
   * 才能得出「没东西可插」这个结论。
   */
  let byTitle: Map<string, { id: string; title: string }> | null = null;

  /**
   * 去重范围是**全部**事项，不只是待裁决的那些。
   *
   * 这一条是「裁决回灌」里最要紧的一环：早先只比对 pending，于是用户点过
   * 「已处理」的问题下次体检会原样重现 —— 他的判断不但没被用上，还没被记住，
   * 每体检一次就要重新裁决一遍同样的事。那比不给他按钮更糟。
   */
  const existing = new Set(
    db
      .select()
      .from(reviewItems)
      .all()
      .map((row) => `${row.kind}::${row.title}`),
  );

  const now = localISOString();
  let queued = 0;
  /** 被净化规则丢掉的东西。丢掉的事实必须能说出来 —— 见下面的日志 */
  const dropped: string[] = [];

  const insert = (item: {
    kind: string;
    title: string;
    detail: string;
    severity: string;
    relatedTitles?: string[];
    suggestion?: string;
    question?: string;
    options?: Array<Partial<ReviewOption>>;
  }) => {
    const key = `${item.kind}::${item.title}`;
    if (existing.has(key)) return;
    existing.add(key);
    byTitle ??= buildTitleIndex(buildCatalog({ includeSummaries: false }));

    // 模型给的问题与选项要过一遍确定性净化：雷同的选项、复述标题的问题都在这里
    // 被丢掉（见 lib/review/questions.ts）。净化后不成形的会退回旧的
    // 「采纳 / 忽略 / 写批注」交互 —— 那是允许的，硬凑的问题比没有问题更糟。
    const clean = normalizeQuestion({ question: item.question, options: item.options }, item.title);
    for (const reason of clean.dropped) dropped.push(`「${truncate(item.title, 24)}」${reason}`);

    db.insert(reviewItems)
      .values({
        id: ulid(),
        kind: item.kind,
        title: item.title,
        detail: item.detail,
        severity: item.severity,
        relatedPagesJson: JSON.stringify(relatedPagesFromTitles(item.relatedTitles ?? [], byTitle)),
        suggestedAction: item.suggestion ?? null,
        question: clean.question,
        optionsJson: clean.options.length > 0 ? JSON.stringify(clean.options) : null,
        status: "pending",
        createdAt: now,
      })
      .run();
    queued++;
  };

  // 程序检测的缺页、断链与孤儿页进入同一条可回答、可提交的队列。
  // 双重重定向由 runLint 的 flattenRedirects 确定性修复，不需要用户重复处理。
  for (const finding of mechanical) {
    if (finding.kind === "double_redirect") continue;
    const target = finding.target;
    const relatedTitles = finding.kind === "missing_page" || finding.kind === "broken_link"
      ? [...(target ? [target] : []), ...finding.pages].slice(0, 12)
      : finding.pages.slice(0, 12);
    const question = finding.kind === "missing_page"
      ? `如何处理缺少的词条「${target ?? "该词条"}」？`
      : finding.kind === "broken_link"
        ? `如何处理仍指向已删除词条「${target ?? "该词条"}」的引用？`
        : "这些词条没有被其他内容引用，你希望如何处理？";
    const options = finding.kind === "missing_page"
      ? [
          { id: "create", label: "按现有引用补建词条", impact: "模型会根据相关词条中的上下文整理一份初稿。" },
          { id: "redirect", label: "在批注中说明应改指向哪里", impact: "适合已有同义词条或需要手动指定正确目标的情况。" },
        ]
      : finding.kind === "broken_link"
        ? [
            { id: "repair", label: "按现有内容修复引用", impact: "模型会结合相关词条与批注整理修订。" },
            { id: "keep", label: "暂时保留并说明原因", impact: "若无需修改，处理后这条问题会关闭。" },
          ]
        : [
            { id: "connect", label: "补充相关链接", impact: "模型会根据词条内容寻找适合的关联。" },
            { id: "keep", label: "确认保留现状", impact: "处理后这条问题会关闭，不再重复出现。" },
          ];
    insert({ ...finding, question, options, relatedTitles });
  }

  for (const finding of llmFindings) insert(finding);

  return { queued, dropped };
}

/** 让刚打开体检页时的程序检查结果也进入逐条处理队列。 */
export function syncMechanicalFindingsToQueue(findings = runMechanicalChecks()): number {
  return queueFindings(findings, []).queued;
}

/* ------------------------------------------------------------ 审阅队列 */

export type ReviewItemView = {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  severity: string;
  /** 这条发现牵涉的词条。见 parseRelatedPages —— id 为 null 是合法状态，不是缺失 */
  relatedPages: ReviewRelatedPage[];
  suggestedAction: string | null;
  status: string;
  createdAt: string;
  /** 用户裁决时写下的一句话说明。只有人写过才有 */
  decisionNote: string | null;
  resolvedAt: string | null;
  /**
   * 「让模型按批注去修」这条路的执行记录。见 lib/review/remediate.ts。
   * null = 这条事项不是那么处理的（可能是人自己裁的，也可能还没处理）。
   */
  remediation: RemediationRecord | null;
  /** 那次修订的 git 提交，版本页据此回滚 */
  appliedSha: string | null;
  /**
   * 系统提给用户的问题与候选答案。两者同时为空 = 这条事项没有值得拍板的问题，
   * 界面退回旧的「采纳 / 忽略 / 写批注」。见 lib/review/questions.ts。
   */
  question: string | null;
  options: ReviewOption[];
  /**
   * 用户的答复。它是**回答**不是**裁决**：回答之后还要由模型去处理，
   * 处理完 status 才成为 accepted。
   */
  answer: string | null;
  /** 选中的选项 id；null = 自由输入 */
  answerChoiceId: string | null;
  answerSource: "option" | "freeform" | null;
  answeredAt: string | null;
  /** 正在处理这批回答的任务 id。non-null 且任务未结束 = 界面上显示「处理中」 */
  batchId: string | null;
};

/** 执行记录的解析。写坏了一律当作没有 —— 界面不该因为一条脏 JSON 整页崩掉 */
function parseRemediation(json: string | null): RemediationRecord | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RemediationRecord;
  } catch {
    return null;
  }
}

export function listReviewItems(
  status: "pending" | "answered" | "accepted" | "dismissed" | "all" = "pending",
): ReviewItemView[] {
  archiveLegacyCompletedReviewItems();
  return getDb()
    .select()
    .from(reviewItems)
    .all()
    .filter((row) => status === "all" || row.status === status)
    .sort((a, b) => {
      const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      const diff = (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
      return diff !== 0 ? diff : b.createdAt.localeCompare(a.createdAt);
    })
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      detail: row.detail,
      severity: row.severity,
      relatedPages: parseRelatedPages(row.relatedPagesJson),
      suggestedAction: row.suggestedAction,
      status: row.status,
      createdAt: row.createdAt,
      decisionNote: row.decisionNote,
      resolvedAt: row.resolvedAt,
      remediation: parseRemediation(row.remediationJson),
      appliedSha: row.appliedSha,
      ...parseQuestion(row.question, row.optionsJson),
      answer: row.answer,
      answerChoiceId: row.answerChoiceId,
      answerSource: (row.answerSource as ReviewItemView["answerSource"]) ?? null,
      answeredAt: row.answeredAt,
      batchId: row.batchId,
    }));
}

/**
 * 早期版本把「无需修改」写入了 remediation，却没有把事项从 pending 结案。
 * 修订记录是这条事项已被处理的确定证据；首次读取时补齐状态，避免它继续
 * 出现在待办里，也让后续体检能复用这条已处理结论。
 */
function archiveLegacyCompletedReviewItems(): void {
  const db = getDb();
  const completed = and(
    eq(reviewItems.status, "pending"),
    isNotNull(reviewItems.remediationJson),
  );
  if (db.select({ id: reviewItems.id }).from(reviewItems).where(completed).all().length === 0) return;

  db.update(reviewItems)
    .set({ status: "accepted", resolvedAt: localISOString() })
    .where(completed)
    .run();
}

/**
 * 记录用户对一条审阅事项的裁决。
 *
 * 两个正选动作（采纳 / 忽略）加一句可选说明。**没有第三个「我自己改好了」** ——
 * 它对回灌不增加任何信息量，只是多一个按钮让人犹豫；用户真要自己改，改完点
 * 「采纳」即可。传入 "pending" 表示**收回裁决**：那条事项回到待裁决列表，
 * 说明一并清掉 —— 一条已经作废的判断留在库里，下一轮模型会照着它行事。
 *
 * 这个函数只写库，不碰 vault。裁决是给下一轮模型看的上下文，不是自动改稿的
 * 指令 —— 模型的提议仍然永远不直接执行（不变式：执行权在人手里）。
 */
export function decideReviewItem(
  id: string,
  decision: "accepted" | "dismissed" | "pending",
  note?: string,
): boolean {
  const db = getDb();
  const row = db.select().from(reviewItems).where(eq(reviewItems.id, id)).get();
  if (!row) return false;

  const reverted = decision === "pending";
  db.update(reviewItems)
    .set({
      status: decision,
      decisionNote: reverted ? null : note?.trim() || null,
      resolvedAt: reverted ? null : localISOString(),
      // 收回裁决时把回答一并清掉，理由与 decisionNote 完全相同：一条已经作废的
      // 判断留在库里，下一轮模型会照着它行事。回答还多一层 —— 它指向的是这条
      // 事项此刻的选项，而选项可能已经随着新一次体检重新生成过了。
      ...(reverted
        ? {
            answer: null,
            answerChoiceId: null,
            answerSource: null,
            answeredAt: null,
            batchId: null,
          }
        : {}),
    })
    .where(eq(reviewItems.id, id))
    .run();

  // 裁决进操作日志。
  //
  // 它不改动任何词条，所以「知识库为什么是现在这样」这个问题里没有它的位置；
  // 但「我当初为什么判定这两句话不矛盾」有 —— 而 log.md 是回答后者的唯一地方。
  // 用户的说明尤其值得留：那句话不在任何词条里，也不在复盘之外的地方。
  const cleanNote = note?.replace(/\s+/g, " ").trim();
  appendLog(
    "REVIEW",
    `裁决「${row.title}」：${VERDICT_LABEL[decision]}${cleanNote ? ` —— ${cleanNote}` : ""}`,
  );
  backupVault(`裁决审阅事项：${row.title}`);

  return true;
}

const VERDICT_LABEL = {
  accepted: "采纳",
  dismissed: "忽略",
  pending: "收回裁决，退回待裁决",
} as const;

/**
 * 最近被裁决过的事项，用于回灌给下一轮模型。
 *
 * 只回灌 title 与 note，**不带 detail** —— detail 是纯模型产出、篇幅也最长，
 * 是提示词注入最合适的载体；而用户点过「采纳/忽略」这件事本身，才让这一条
 * 有了约束力。详细理由见 lib/llm/prompts.ts#formatDecisions。
 */
export function recentDecisions(limit = 20): DecisionContext[] {
  archiveLegacyCompletedReviewItems();
  return getDb()
    .select()
    .from(reviewItems)
    .all()
    .filter((row) => row.status === "accepted" || row.status === "dismissed")
    .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""))
    .slice(0, limit)
    .map((row) => ({
      kind: row.kind,
      title: row.title,
      status: row.status as "accepted" | "dismissed",
      note: row.decisionNote,
    }));
}

/**
 * 记录用户对一条事项的回答。
 *
 * 回答 ≠ 裁决。裁决（accepted / dismissed）是「这条判断我认了 / 这不是问题」，
 * 是个终态；回答是「我的口径是这个」—— 它还要由模型去处理，处理完才结案。
 * 所以这条路径只写库、不碰 vault，也**不动 resolvedAt**（回答不等于结案，
 * recentDecisions 的回灌因此不会读到它 —— 那正是我们想要的：回答在处理完成时
 * 才以 decision_note 的身份进入回灌）。
 *
 * 事项正在被某个批量任务处理时拒绝写入：那个任务已经拿着旧答案在读词条了，
 * 此刻改答案只会让用户以为生效了、实际没有。
 */
export function answerReviewItem(
  id: string,
  input: { answer?: string | null; choiceId?: string | null },
): { ok: true } | { ok: false; error: string; status: number } {
  const db = getDb();
  const row = db.select().from(reviewItems).where(eq(reviewItems.id, id)).get();
  if (!row) return { ok: false, error: "找不到这条审阅事项。", status: 404 };
  // batchId 非空即表示有任务正在处理它（任务结束时一定会清空这一列）
  if (row.batchId) {
    return { ok: false, error: "这条正在处理中，等它跑完再改。", status: 409 };
  }

  const { options } = parseQuestion(row.question, row.optionsJson);
  const normalized = normalizeAnswer({ ...input, options });
  if (!normalized) {
    return {
      ok: false,
      error: "答复是空的 —— 选一个选项，或者写一句你的判断。",
      status: 400,
    };
  }

  db.update(reviewItems)
    .set({
      status: "answered",
      answer: normalized.answer,
      answerChoiceId: normalized.choiceId,
      answerSource: normalized.source,
      answeredAt: localISOString(),
    })
    .where(eq(reviewItems.id, id))
    .run();

  return { ok: true };
}

/** 清掉一条事项上的批处理认领标记。任务无论成败都要调它，否则事项永远「处理中」 */
export function releaseReviewItems(jobId: string): number {
  const db = getDb();
  const rows = db.select().from(reviewItems).where(eq(reviewItems.batchId, jobId)).all();
  if (rows.length === 0) return 0;
  db.update(reviewItems).set({ batchId: null }).where(eq(reviewItems.batchId, jobId)).run();
  return rows.length;
}

/** 认领一批已回答的事项。返回真正被认领的 id —— 已被别的任务拿走的会被跳过 */
export function claimReviewItems(jobId: string, ids: string[]): string[] {
  const db = getDb();
  const claimed: string[] = [];
  for (const id of ids) {
    const row = db.select().from(reviewItems).where(eq(reviewItems.id, id)).get();
    // 只认领「已回答且无人处理」的：状态在任务排队期间被用户改掉是可能的
    if (!row || row.status !== "answered" || row.batchId) continue;
    db.update(reviewItems).set({ batchId: jobId }).where(eq(reviewItems.id, id)).run();
    claimed.push(id);
  }
  return claimed;
}

export function countPendingReviewItems(): number {
  archiveLegacyCompletedReviewItems();
  return getDb()
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.status, "pending"))
    .all().length;
}

/**
 * 还没结案的事项数：待答 + 已回答待处理。
 *
 * 侧栏角标用它而不是 countPendingReviewItems —— 已回答却处理失败的事项不会再被
 * 重新入队（queueFindings 的去重是全表 kind::title），如果角标不算它们，
 * 用户会以为它消失了。
 */
export function countOpenReviewItems(): number {
  archiveLegacyCompletedReviewItems();
  return getDb()
    .select()
    .from(reviewItems)
    .all()
    .filter((row) => row.status === "pending" || row.status === "answered").length;
}

function extractBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}
