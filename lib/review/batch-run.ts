import { eq } from "drizzle-orm";
import { ulid } from "ulid";

import { getDb } from "@/lib/db/client";
import { reviewItems } from "@/lib/db/schema";
import {
  appendLog, createPage, deletePage, loadPageFile, mergePages, previewDelete, updatePage,
} from "@/lib/vault/service";
import { sha256 } from "@/lib/vault/atomic";
import { commitVault, withCommitOperation } from "@/lib/git/auto-commit";
import { enqueue, getJob, readDraft, saveDraft, finishJob, type JobContext } from "@/lib/jobs/runner";
import { createProvider } from "@/lib/llm";
import type { LlmProvider } from "@/lib/llm/types";
import { completeStructured } from "@/lib/llm/structured";
import {
  BatchRemediationSchema, buildBatchRemediationPrompt,
  FixPlanSchema, buildFixPlanPrompt,
} from "@/lib/llm/prompts";
import { claimReviewItems, releaseReviewItems, recentDecisions, runMechanicalChecks } from "@/lib/lint";
import { buildCatalog, renderCatalogForPrompt } from "@/lib/index/catalog";
import { parseQuestion } from "@/lib/review/questions";
import { hasOversizedRelatedPages, parseRelatedPages } from "@/lib/review/related-pages";
import {
  groupItems, sanitizePlan,
  type ApplyInput, type BatchPlan, type ChangePlan,
  type DestructiveAction, type FixPlan, type ItemOutcome, type ItemRef,
} from "@/lib/review/batch";
import { countChanges } from "@/lib/review/remediate";
import { localISOString, truncate } from "@/lib/utils";

/**
 * 批量处理一批已回答的事项：一次模型调用处理一组，改正文与新建直接落盘，
 * 删除与合并按已提交的回答自动执行，并保留影响检查与内容冲突保护。
 *
 * 与 lib/review/remediate.ts 的分工：那条路是「用户对**一条**事项写了一段批注」，
 * 这条路是「用户在队列里答完了一批问题」。两者共用同一套应用与报告纪律
 * （逐项校验、乐观并发、如实报告 rejected/conflicts），但入口与材料完全不同，
 * 所以是两个文件而不是一个带 flag 的函数。
 *
 * 三件事值得写清楚：
 *
 * 1. **绝不截断词条正文**。模型返回的是完整正文，输入里被截掉的那部分会在输出里
 *    永久消失 —— 那是一次静默的数据丢失。所以宁可一组处理得慢，也不裁材料。
 *
 * 2. **破坏性操作只提议、不执行**。模型给出 id 与合并稿，影响范围由后端用
 *    previewDelete 现算，用户确认后才动手。模型自述的影响范围一律不采信 ——
 *    与「引用由后端回填」是同一条纪律。
 *
 * 3. **认领与释放**。事项在任务跑的过程中带着 batchId，这样界面能显示「处理中」、
 *    第二个任务拿不走它、刷新页面也能认回来。任务**非挂起**结束时一定要释放，
 *    否则那条事项会永远停在「处理中」。
 */

/** 一次批量比单条修订重，给足时间 */
const BATCH_TIMEOUT_MS = 15 * 60_000;

/**
 * 一组的材料预算（字符）。超了只记日志、不拆组 ——
 * 拆点落在共享词条上就会产生两条针对同一 pageId 的完整正文，那是静默丢改动。
 */
const GROUP_BUDGET_CHARS = 60_000;

export type StartReviewBatchInput = {
  mode: "answers" | "mechanical";
  /** mode 为 answers 时必填 */
  itemIds?: string[];
  /** 允许注入 provider 以便测试（与 startIngest / startRemediation 同一套做法） */
  provider?: LlmProvider;
};

export function startReviewBatch(input: StartReviewBatchInput): { jobId: string } {
  input = { ...input, provider: input.provider ?? createProvider() };
  const jobId = ulid();
  enqueue({
    kind: "review_batch",
    jobId,
    payload: {
      mode: input.mode, itemIds: input.itemIds ?? [],
      title: input.mode === "mechanical" ? "补建缺失词条" : reviewBatchTitle(input.itemIds ?? []),
    },
    handler: (context) => withCommitOperation("处理体检问题", () => runReviewBatch(context, input)),
  });
  return { jobId };
}

function reviewBatchTitle(itemIds: string[]): string {
  const row = itemIds.length ? getDb().select().from(reviewItems).where(eq(reviewItems.id, itemIds[0])).get() : null;
  const related = row ? parseRelatedPages(row.relatedPagesJson) : [];
  const title = related.map(page => page.title).slice(0, 2).join("、");
  return `修订${title ? ` · ${truncate(title, 32)}` : "体检反馈"}${itemIds.length > 1 ? ` · ${itemIds.length} 项` : ""}`;
}

type Target = { id: string; title: string; type: string; content: string; hash: string };

async function runReviewBatch(
  context: JobContext,
  input: StartReviewBatchInput,
): Promise<unknown> {
  if (input.mode === "mechanical") return runMechanicalPlan(context, input);

  let suspended = false;
  try {
    const result = await processAnswers(context, input);
    suspended = Boolean((result as { awaitingReview?: boolean } | null)?.awaitingReview);
    return result;
  } finally {
    // 挂起时**不**释放：任务还没结束，界面要继续显示「处理中」，
    // 也要挡住第二个任务把它抢走。挂起的任务由 apply / cancel 负责收尾并释放。
    if (!suspended) releaseReviewItems(context.jobId);
  }
}

async function processAnswers(
  context: JobContext,
  input: StartReviewBatchInput,
): Promise<unknown> {
  const jobId = context.jobId;

  /* ---- ① 认领并读材料 ---- */
  context.setStage("reading", "读取相关词条");
  const claimed = claimReviewItems(jobId, input.itemIds ?? []);
  if (claimed.length === 0) {
    throw new Error("这批事项没有一条处于「已回答」状态 —— 可能已经被别的任务处理了。");
  }

  const rows = getDb()
    .select()
    .from(reviewItems)
    .all()
    .filter((row) => claimed.includes(row.id));

  const targets = new Map<string, Target>();
  const missingTitles: string[] = [];
  const refs: ItemRef[] = [];

  if (rows.some((row) => hasOversizedRelatedPages(row.relatedPagesJson))) {
    releaseReviewItems(jobId);
    throw new Error("所选事项包含过多关联词条，已停止批量修订。请先手动核对关联。");
  }

  for (const row of rows) {
    const pageIds: string[] = [];
    for (const ref of parseRelatedPages(row.relatedPagesJson)) {
      // id 为 null 表达的是「这个词条还不存在」，不是数据缺失
      if (!ref.id) {
        missingTitles.push(ref.title);
        continue;
      }
      if (!targets.has(ref.id)) {
        try {
          const file = loadPageFile(ref.id);
          targets.set(ref.id, {
            id: ref.id,
            title: file.data.title,
            type: file.data.type,
            content: file.content,
            // 读到的那一份的指纹：落盘时带回去做乐观并发控制
            hash: sha256(file.raw),
          });
        } catch {
          // 词条在用户作答之后被删了：当作缺页处理
          missingTitles.push(ref.title);
          continue;
        }
      }
      pageIds.push(ref.id);
    }
    refs.push({ itemId: row.id, pageIds });
  }

  context.log(`读入 ${targets.size} 个词条，处理 ${rows.length} 条回答`);
  context.setFraction(1);

  /* ---- ② 按连通分量分组，逐组调模型 ---- */
  context.setStage("drafting", "模型正在处理这批回答");
  const groups = groupItems(refs);
  const provider = input.provider ?? createProvider();

  const plan = emptyPlan();
  const appliedHashes = new Map<string, string>();

  for (const [index, group] of groups.entries()) {
    const groupRows = group
      .map((ref) => rows.find((row) => row.id === ref.itemId))
      .filter((row): row is (typeof rows)[number] => Boolean(row));
    const groupTargetIds = [...new Set(group.flatMap((ref) => ref.pageIds))];
    const groupTargets = groupTargetIds
      .map((id) => targets.get(id))
      .filter((target): target is Target => Boolean(target));

    const chars = groupTargets.reduce((sum, t) => sum + t.content.length, 0);
    if (chars > GROUP_BUDGET_CHARS) {
      // 只说事实、不做取舍：拆组会让同一条词条出现在两组里，后写的完整正文
      // 会抹掉前一条的改动 —— 宁可慢，不可丢。
      context.log(
        `第 ${index + 1} 组涉及 ${groupTargets.length} 个词条、约 ${Math.round(chars / 1000)}k 字符，超过单组预算，仍然整组处理（拆分会导致改动互相覆盖）`,
        "warning",
      );
    }

    const result = await completeStructured({
      provider,
      schema: BatchRemediationSchema,
      schemaName: "batch_remediation",
      temperature: 0.2,
      timeoutMs: BATCH_TIMEOUT_MS,
      signal: context.signal,
      messages: [
        {
          role: "user",
          content: buildBatchRemediationPrompt({
            items: groupRows.map((row) => {
              const { question, options } = parseQuestion(row.question, row.optionsJson);
              return {
                itemId: row.id,
                kind: row.kind,
                title: row.title,
                detail: row.detail,
                question,
                options,
                answer: row.answer ?? "",
              };
            }),
            pages: groupTargets.map((t) => ({
              id: t.id, title: t.title, type: t.type, content: t.content,
            })),
            missingTitles,
            decisions: recentDecisions(),
          }),
        },
      ],
      onAttempt: (attempt, error) => {
        context.log(
          `模型第 ${attempt} 次输出不符合格式要求，已自动重试：${truncate(error, 80)}`,
          "warning",
        );
      },
    });

    const clean = sanitizePlan(result.data, groupTargets);
    plan.summary = plan.summary || result.data.summary;
    plan.rejected.push(...clean.rejected);
    plan.noChangeItems.push(...clean.noChangeItems);

    for (const target of groupTargets) appliedHashes.set(target.id, target.hash);

    if (clean.deletions.length > 0 || clean.merges.length > 0) {
      collectDestructive(plan, clean, groupTargets, targets);
    }
    plan.edits.push(...clean.edits);
    plan.newPages.push(...clean.newPages);

    context.setFraction((index + 1) / groups.length);
  }

  /* ---- ③ 应用：改正文与新建直接落盘 ---- */
  context.setStage("applying", "写入知识库");
  context.throwIfCancelled();

  const applied: ChangePlan["applied"] = {
    edits: [], created: [], conflicts: [], rejected: plan.rejected, commits: 0,
  };

  for (const edit of plan.edits) {
    const target = targets.get(edit.pageId);
    if (!target) continue;
    try {
      updatePage(target.id, { content: edit.newContent, expectedHash: target.hash });
    } catch (error) {
      // ConflictError 就是「你在这期间手工改过它」，如实报告而不是覆盖
      applied.conflicts.push(
        `${target.title}：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const stat = countChanges(target.content, edit.newContent);
    applied.edits.push({
      pageId: target.id, title: target.title, reason: edit.reason, ...stat,
    });
    context.log(`已更新《${target.title}》（+${stat.added} / −${stat.removed} 行）`);
  }

  for (const page of plan.newPages) {
    try {
      const written = createPage({
        type: page.type as Parameters<typeof createPage>[0]["type"],
        title: page.title,
        content: page.content,
        tags: ["按回答补建"],
        confidence: "low",
      });
      applied.created.push({ id: written.pageId, title: page.title });
      context.log(`已补建《${page.title}》`);
    } catch (error) {
      applied.conflicts.push(
        `${page.title}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /* ---- ④ 收尾 ---- */
  const outcomes = buildOutcomes(rows, plan, applied);

  if (plan.pending.length > 0) {
    context.throwIfCancelled();
    context.setStage("reviewing", "执行已提交的处理方向");
    const changePlan: ChangePlan = {
      mode: "answers",
      summary: plan.summary || "按你的回答处理了一批事项",
      applied,
      pending: plan.pending,
      itemOutcomes: outcomes,
    };
    saveDraft(jobId, changePlan);
    const result = applyReviewPlan(jobId, { approve: plan.pending.map(action => action.id) });
    context.log(`已自动处理 ${result.deleted} 项删除、${result.merged} 项合并${result.conflicts.length ? `，${result.conflicts.length} 项内容冲突已跳过` : ""}`);
    return { ...summarize(applied, []), ...result };
  }

  await finalize(context, jobId, outcomes, applied, plan.summary, plan.pending);
  return summarize(applied, []);
}

/* ------------------------------------------------------------ 辅助 */

/**
 * 模型侧的计划累积器。
 *
 * 注意它装的是**还没应用**的改动（edits 带 newContent），与 applied（应用后的
 * 记账）是两回事 —— 混在一起写会让「计划了什么」和「实际做了什么」分不开，
 * 而这两件事恰恰必须分开报告。
 */
type PendingPlan = {
  summary: string;
  edits: BatchPlan["edits"];
  newPages: BatchPlan["newPages"];
  rejected: string[];
  noChangeItems: Array<{ itemId: string; reason: string }>;
  /** 已转成等确认形状的破坏性操作 */
  pending: DestructiveAction[];
};

function emptyPlan(): PendingPlan {
  return { summary: "", edits: [], newPages: [], rejected: [], noChangeItems: [], pending: [] };
}

/**
 * 把净化的删除/合并转成等确认的破坏性操作，影响范围**由后端现算**。
 *
 * 模型回来的任何「影响」字段一律不看：那是它与自己的对话，不是事实。
 */
function collectDestructive(
  plan: PendingPlan,
  clean: ReturnType<typeof sanitizePlan>,
  _groupTargets: Target[],
  allTargets: Map<string, Target>,
): void {
  const computedAt = localISOString();

  for (const item of clean.deletions) {
    const target = allTargets.get(item.pageId);
    if (!target) continue;
    plan.pending.push({
      id: ulid(),
      action: "delete",
      pageId: target.id,
      title: target.title,
      impact: impactOf(target.id, computedAt),
      strategy: { kind: "clean_refs" },
      expectedHash: target.hash,
      reason: item.reason,
      itemIds: item.itemIds,
    });
  }

  for (const merge of clean.merges) {
    const source = allTargets.get(merge.sourcePageId);
    const target = allTargets.get(merge.targetPageId);
    if (!source || !target) continue;
    plan.pending.push({
      id: ulid(),
      action: "merge",
      sourcePageId: source.id,
      sourceTitle: source.title,
      targetPageId: target.id,
      targetTitle: target.title,
      // 引用改写的影响范围：合并会把指向 source 的引用改指向 target
      impact: impactOf(source.id, computedAt),
      mergedContent: merge.mergedContent,
      diffStat: countChanges(target.content, merge.mergedContent),
      expectedHashes: { source: source.hash, target: target.hash },
      reason: merge.reason,
      itemIds: merge.itemIds,
    });
  }
}

function impactOf(pageId: string, computedAt: string): DestructiveAction["impact"] {
  const preview = previewDelete(pageId);
  return {
    totalReferences: preview.totalReferences,
    referencingPages: preview.referencingPages,
    computedAt,
  };
}

/**
 * 每条事项的结局。
 *
 * 判据是「这条回答有没有被某条改动认领」：模型用 itemIds 指认，指认不出来时
 * 退回到「这一组里的全部事项」—— 降级而不是失败，因为「哪条改动的功劳算谁的」
 * 记不准只影响记账，不影响知识库。
 */
function buildOutcomes(
  rows: Array<typeof reviewItems.$inferSelect>,
  plan: PendingPlan,
  applied: ChangePlan["applied"],
): ItemOutcome[] {
  const credited = new Set<string>();
  for (const edit of plan.edits) for (const id of edit.itemIds) credited.add(id);
  for (const page of plan.newPages) for (const id of page.itemIds) credited.add(id);
  for (const action of plan.pending) for (const id of action.itemIds) credited.add(id);

  const noChange = new Map(plan.noChangeItems.map((item) => [item.itemId, item.reason]));
  const failedPages = new Set(
    applied.conflicts.map((conflict) => conflict.split("：")[0].replace(/^《|》$/g, "")),
  );

  return rows.map((row) => {
    if (noChange.has(row.id)) {
      return { itemId: row.id, outcome: "unchanged" as const, note: noChange.get(row.id)! };
    }
    if (credited.has(row.id)) {
      return { itemId: row.id, outcome: "accepted" as const, note: row.answer ?? "" };
    }
    // 没有被任何改动认领、也不在「不需要改」清单里：模型漏了这条
    const touchedTitles = row.relatedPagesJson ?? "";
    const failed = [...failedPages].some((title) => touchedTitles.includes(title));
    return failed
      ? { itemId: row.id, outcome: "failed" as const, note: "改动没能落盘，见任务日志" }
      : { itemId: row.id, outcome: "unchanged" as const, note: "模型认为不需要改动" };
  });
}

/** 收尾：写日志、提交、把每条事项的结局写回 */
async function finalize(
  context: JobContext,
  _jobId: string,
  outcomes: ItemOutcome[],
  applied: ChangePlan["applied"],
  summary: string,
  pending: DestructiveAction[],
): Promise<void> {
  context.setStage("committing", "收尾并提交");
  const now = localISOString();

  let sha: string | null = null;
  if (applied.edits.length > 0 || applied.created.length > 0) {
    appendLog(
      "EDIT",
      `按回答处理 ${applied.edits.length} 个词条、补建 ${applied.created.length} 个 —— ${truncate(summary, 80)}`,
    );
    const closing = commitVault(`按回答处理：${truncate(summary, 60)}`);
    sha = closing.sha;
    applied.commits = applied.edits.length + applied.created.length + (closing.committed ? 1 : 0);
  }

  writeOutcomes(outcomes, applied, sha, now, pending);
  context.setFraction(1);
}

/** 把结局写回 review_items */
function writeOutcomes(
  outcomes: ItemOutcome[],
  applied: ChangePlan["applied"],
  sha: string | null,
  now: string,
  pending: DestructiveAction[],
): void {
  const db = getDb();
  // 还有待确认的破坏性操作时，涉及它的那些条目不结案 —— 它们停在 answered，
  // 等用户确认后再结。否则用户取消计划时会发现事项已经「已采纳」了。
  const waiting = new Set(pending.flatMap((action) => action.itemIds));

  for (const outcome of outcomes) {
    if (waiting.has(outcome.itemId)) continue;

    // 还在等确认的（deferred）与落盘失败的（failed）都**原样保留回答** ——
    // 它们停在「已回答」里，用户可以重新发起；把回答清掉等于让他白答一次。
    // 只把 task 的认领标记放开。
    if (outcome.outcome === "deferred" || outcome.outcome === "failed") {
      db.update(reviewItems)
        .set({ batchId: null, decisionNote: outcome.note || null })
        .where(eq(reviewItems.id, outcome.itemId))
        .run();
      continue;
    }

    db.update(reviewItems)
      .set({
        // 无需改动也是一次完整处理：留在待处理里会让同一问题反复出现。
        status: outcome.outcome === "accepted" || outcome.outcome === "unchanged" ? "accepted" : "pending",
        decisionNote: outcome.note || null,
        resolvedAt: outcome.outcome === "accepted" || outcome.outcome === "unchanged" ? now : null,
        remediationJson: JSON.stringify({
          summary: outcome.note,
          edits: applied.edits,
          created: applied.created,
          rejected: applied.rejected,
          noChangeReason: outcome.outcome === "unchanged" ? outcome.note : null,
          commits: applied.commits,
        }),
        appliedSha: outcome.outcome === "accepted" ? sha : null,
      })
      .where(eq(reviewItems.id, outcome.itemId))
      .run();
  }
}

function summarize(applied: ChangePlan["applied"], pending: DestructiveAction[]) {
  return {
    edits: applied.edits.length,
    created: applied.created.length,
    conflicts: applied.conflicts,
    rejected: applied.rejected,
    pending: pending.length,
  };
}

/* ------------------------------------------------- 确认 / 放弃破坏性操作 */

export type ApplyResult = {
  deleted: number;
  merged: number;
  conflicts: string[];
  rejected: string[];
  commits: number;
  commitSha: string | null;
};

/**
 * 用户确认之后，执行计划里勾中的破坏性操作。
 *
 * 三件事与「改正文直接写」不同，都是刻意的：
 *
 * 1. **用方案里存的哈希执行**。影响范围是几分钟前算给用户看的，这期间他可能
 *    在 Obsidian 里改过那两个词条 —— 哈希对不上就跳过这一项并如实报告，
 *    其余照常执行。整体拒绝会让一次外部编辑毁掉整批工作。
 * 2. **用户可以改合并稿**。`input.edits` 里带了就是他的版本，优先用它。
 * 3. **未勾选的项如实报告**，不静默丢弃 —— 用户会想知道「我按了执行，那三项呢」。
 *
 * 调用方（API 路由）必须先确认任务还在 awaiting_review：重复提交要挡在门口，
 * 而不是靠这里的状态判断 —— 那会把幂等保护散在两处。
 */
export function applyReviewPlan(jobId: string, input: ApplyInput): ApplyResult {
  // 幂等防线。API 路由也会查一次并返回 409，这里再查一次是因为 finishJob
  // **不清 draftJson** —— 只靠路由的话，任何直接调用这条路的地方（脚本、测试、
  // 将来的另一个入口）重复执行一次就会把删除/合并做两遍。
  const job = getJob(jobId);
  if (!job || job.status !== "awaiting_review") {
    throw new Error("这个计划已经处理过了，或者已经取消。");
  }

  const plan = readDraft<ChangePlan>(jobId);
  if (!plan) throw new Error("找不到这次处理的方案，可能已经被清理了。");

  const approve = new Set(input.approve);
  const conflicts: string[] = [];
  const rejected: string[] = [];
  /** 真正执行成功的那几项牵涉到的事项。没勾选与失败的都不算 */
  const done = new Set<string>();
  let deleted = 0;
  let merged = 0;

  for (const action of plan.pending) {
    const label = action.action === "delete" ? action.title : `${action.sourceTitle} → ${action.targetTitle}`;
    if (!approve.has(action.id)) {
      rejected.push(`${label}（你没有勾选）`);
      continue;
    }

    try {
      if (action.action === "delete") {
        deletePage(action.pageId, action.strategy, action.expectedHash ?? undefined);
        deleted++;
      } else {
        mergePages({
          sourcePageId: action.sourcePageId,
          targetPageId: action.targetPageId,
          // 用户在确认界面上改过合并稿就用他的版本
          mergedContent: input.edits?.[action.id]?.trim() || action.mergedContent,
          expectedHashes: action.expectedHashes,
        });
        merged++;
      }
      for (const itemId of action.itemIds) done.add(itemId);
    } catch (error) {
      // ConflictError 就是「你确认期间它被外部改过」，如实报告而不是覆盖
      conflicts.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const now = localISOString();
  const applied: ChangePlan["applied"] = {
    ...plan.applied,
    conflicts: [...plan.applied.conflicts, ...conflicts],
    rejected: [...plan.applied.rejected, ...rejected],
    commits: plan.applied.commits,
  };

  let sha: string | null = null;
  if (deleted > 0 || merged > 0) {
    appendLog("EDIT", `按你的确认执行了 ${deleted} 项删除、${merged} 项合并`);
    const closing = commitVault(`按确认处理 ${deleted + merged} 项`);
    sha = closing.sha;
    // 服务层每写一次各留一条记录，收尾这次再加一条
    applied.commits += deleted + merged + (closing.committed ? 1 : 0);
  }

  // 只把真正执行成功的那几项算「已处理」；没勾选与失败的留在等待里，
  // 事项回到「已回答」，用户可以重新发起
  const outcomes = plan.itemOutcomes.map((outcome) =>
    outcome.outcome === "accepted" && !done.has(outcome.itemId) && waitingOn(plan, outcome.itemId)
      ? { ...outcome, outcome: "deferred" as const, note: "相应的删除/合并没有执行，可以重新发起" }
      : outcome,
  );

  writeOutcomes(outcomes, applied, sha, now, []);
  releaseReviewItems(jobId);
  finishJob(jobId, {
    status: "done",
    stage: "committing",
    progress: 100,
    message: `已完成 ${deleted + merged} 项`,
  });

  return {
    deleted,
    merged,
    conflicts,
    rejected,
    commits: applied.commits,
    commitSha: sha,
  };
}

/** 放弃这次计划：不执行任何破坏性操作。已经落盘的改动不动（它们是设计的一部分） */
export function cancelReviewPlan(jobId: string): void {
  const job = getJob(jobId);
  if (!job || job.status !== "awaiting_review") {
    throw new Error("这个计划已经处理过了，或者已经取消。");
  }

  const plan = readDraft<ChangePlan>(jobId);
  if (plan) {
    const outcomes = plan.itemOutcomes.map((outcome) =>
      outcome.outcome === "accepted" && waitingOn(plan, outcome.itemId)
        ? { ...outcome, outcome: "deferred" as const, note: "你放弃了这次的删除/合并，可以重新发起" }
        : outcome,
    );
    // 已落盘的改动照常记账，只是把等待确认的那些放回「已回答」
    writeOutcomes(outcomes, plan.applied, null, localISOString(), []);
  }
  releaseReviewItems(jobId);
  finishJob(jobId, { status: "cancelled", message: "这次处理已放弃，你的回答还在。" });
}

/** 某条事项是否正等着某个破坏性操作的确认 */
function waitingOn(plan: ChangePlan, itemId: string): boolean {
  return plan.pending.some((action) => action.itemIds.includes(itemId));
}

/* -------------------------------------------------- 机械发现的修复计划 */

/** 一次最多为几个缺页写初稿。超出的留到下一批 —— 计划的价值与条数成反比 */
const MAX_FIX_ITEMS = 10;
/** 每个缺页最多看几处引用上下文 */
const CONTEXTS_PER_TARGET = 3;
/** 每处上下文截多长。太长的引用会把 prompt 淹掉，而判断「这是什么」用不了那么多 */
const CONTEXT_EXCERPT = 1200;

/**
 * 为「被反复引用但还没有词条」的名字写初稿。
 *
 * 与 answers 模式的区别：这一条**没有用户回答**，材料只有引用上下文。
 * 所以初稿一律低置信度、带「体检补建」标签，方便日后复核。
 */
async function runMechanicalPlan(
  context: JobContext,
  input: StartReviewBatchInput,
): Promise<unknown> {
  context.setStage("reading", "读取引用上下文");

  const missing = runMechanicalChecks()
    .filter((finding) => finding.kind === "missing_page")
    .slice(0, MAX_FIX_ITEMS);

  if (missing.length === 0) {
    context.log("没有需要补建的缺页");
    return { planned: 0 };
  }

  const catalog = buildCatalog();
  const byTitle = new Map(catalog.map((entry) => [entry.title, entry]));
  const targets: Array<{ name: string; contexts: Array<{ from: string; excerpt: string }> }> = [];

  for (const finding of missing) {
    // 新旧 finding 都提供 target；标题解析仅留作兼容历史构造的数据。
    const name = finding.target ?? /^「(.+?)」/.exec(finding.title)?.[1];
    if (!name) continue;

    const contexts: Array<{ from: string; excerpt: string }> = [];
    for (const sourceTitle of finding.pages.slice(0, CONTEXTS_PER_TARGET)) {
      const entry = byTitle.get(sourceTitle);
      if (!entry) continue;
      try {
        const file = loadPageFile(entry.id);
        contexts.push({ from: file.data.title, excerpt: file.content.slice(0, CONTEXT_EXCERPT) });
      } catch {
        // 引用方在体检之后被删了：跳过，不值得为它中断整批
      }
    }
    if (contexts.length > 0) targets.push({ name, contexts });
  }

  if (targets.length === 0) {
    context.log("缺页的引用方都读不到了，这次没有可补建的内容", "warning");
    return { planned: 0 };
  }

  context.log(`为 ${targets.length} 个缺页读取了引用上下文`);
  context.setStage("drafting", "模型正在写初稿");

  const provider = input.provider ?? createProvider();
  const result = await completeStructured({
    provider,
    schema: FixPlanSchema,
    schemaName: "fix_plan",
    temperature: 0.3,
    timeoutMs: BATCH_TIMEOUT_MS,
    signal: context.signal,
    messages: [
      {
        role: "user",
        content: buildFixPlanPrompt({
          targets,
          catalog: renderCatalogForPrompt(catalog, { maxEntries: 200 }),
          decisions: recentDecisions(),
        }),
      },
    ],
    onAttempt: (attempt, error) => {
      context.log(`模型第 ${attempt} 次输出不符合格式要求，已自动重试：${truncate(error, 80)}`, "warning");
    },
  });

  const existingTitles = new Set(catalog.map((entry) => entry.title.toLowerCase()));
  const items: FixPlan["items"] = [];
  const rejected: string[] = [];

  for (const page of result.data.newPages) {
    const title = page.title.trim();
    if (!title) continue;
    if (existingTitles.has(title.toLowerCase())) {
      rejected.push(`${title}（同名词条已存在）`);
      continue;
    }
    existingTitles.add(title.toLowerCase());
    items.push({
      id: ulid(),
      title,
      type: page.type,
      content: page.content,
      reason: page.reason,
    });
  }

  if (items.length === 0) {
    context.log("模型认为这些缺页暂时不该建，没有生成计划项");
    return { planned: 0, skipped: result.data.skipped.length };
  }

  context.setStage("reviewing", "等待你确认");
  const plan: FixPlan = {
    mode: "mechanical",
    summary: result.data.summary,
    items,
    skipped: [...result.data.skipped, ...rejected.map((r) => ({ name: r, reason: "" }))],
  };
  saveDraft(context.jobId, plan);
  context.log(`生成了 ${items.length} 条补建初稿，等你确认`);
  return { awaitingReview: true, planned: items.length };
}

export type FixApplyResult = {
  created: number;
  conflicts: string[];
  commitSha: string | null;
};

/**
 * 执行用户勾选的补建项。
 *
 * 与破坏性操作那条不同，这里没有乐观并发的需要：新建不覆盖任何东西，
 * 同名词条已被建出的情况按冲突如实报告即可（与 commitIngest 同一套做法）。
 */
export function applyFixPlan(
  jobId: string,
  approved: string[],
  edits: Record<string, string> = {},
): FixApplyResult {
  const job = getJob(jobId);
  if (!job || job.status !== "awaiting_review") {
    throw new Error("这个计划已经处理过了，或者已经取消。");
  }
  const plan = readDraft<FixPlan>(jobId);
  if (!plan) throw new Error("找不到这次的计划，可能已经被清理了。");

  const approve = new Set(approved);
  const conflicts: string[] = [];
  let created = 0;

  for (const item of plan.items) {
    if (!approve.has(item.id)) continue;
    const title = item.title.trim();
    try {
      createPage({
        type: item.type as Parameters<typeof createPage>[0]["type"],
        title,
        // 用户在计划界面上改过正文就用他的版本
        content: edits[item.id]?.trim() || item.content,
        tags: ["体检补建"],
        confidence: "low",
      });
      created++;
    } catch (error) {
      conflicts.push(`${title}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let sha: string | null = null;
  if (created > 0) {
    appendLog("EDIT", `按修复计划补建了 ${created} 个词条`);
    sha = commitVault(`体检补建 ${created} 个词条`).sha;
  }

  finishJob(jobId, {
    status: "done",
    stage: "committing",
    progress: 100,
    message: `补建了 ${created} 个词条`,
  });

  return { created, conflicts, commitSha: sha };
}

/** 放弃修复计划 */
export function cancelFixPlan(jobId: string): void {
  const job = getJob(jobId);
  if (!job || job.status !== "awaiting_review") {
    throw new Error("这个计划已经处理过了，或者已经取消。");
  }
  finishJob(jobId, { status: "cancelled", message: "这次修复计划已放弃。" });
}
