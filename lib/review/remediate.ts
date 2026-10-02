import { eq } from "drizzle-orm";
import { diffLines } from "diff";
import { ulid } from "ulid";

import { getDb } from "@/lib/db/client";
import { reviewItems } from "@/lib/db/schema";
import { appendLog, createPage, loadPageFile, updatePage } from "@/lib/vault/service";
import { sha256 } from "@/lib/vault/atomic";
import { backupVault, withCommitOperation } from "@/lib/git/auto-commit";
import { enqueue, type JobContext } from "@/lib/jobs/runner";
import { createProvider } from "@/lib/llm";
import type { LlmProvider } from "@/lib/llm/types";
import { completeStructured } from "@/lib/llm/structured";
import { RemediationSchema, buildRemediationPrompt, type Remediation } from "@/lib/llm/prompts";
import { recentDecisions } from "@/lib/lint";
import { localISOString, truncate } from "@/lib/utils";
import { hasOversizedRelatedPages, parseRelatedPages } from "./related-pages";

/**
 * 体检闭环的第二段：**按用户的批注去修词条**。
 *
 * 第一段（已有的）只到「裁决 + 回灌」：用户的采纳/忽略会作为约束进入下一轮
 * 体检与导入的 prompt，让模型不再重复报同一个问题。但那一段**一个字都不改
 * 知识库** —— 用户批注完，问题还在原处，他得自己再去词条页手改。这一层补的就是
 * 那道断层：批注是一条**指令**，模型据此提出修订，直接写进知识库。
 *
 * 三件事值得写清楚：
 *
 * 1. **落盘走服务层**（不变式 2）。和导入提交一样：算改动 → 服务层事务写 →
 *    重建索引 → git 提交。所以这次修订在版本页是一条记录，可以一键撤销 ——
 *    这正是「让模型直接改」敢开的口子：改错了有退路，而不是靠它一次做对。
 *
 * 2. **批注是可信指令，材料不是**。见 lib/llm/prompts.ts#buildRemediationPrompt
 *    顶上的那段说明：用户的批注不包裹（它是命令），而词条正文与事项本身都包裹
 *    （它们是数据）。
 *
 * 3. **模型的产出仍然逐项校验**。它会给出不存在的 pageId、把没改的词条也列进来、
 *    甚至返回空正文 —— 这些一律在应用前剔除并如实报告，而不是照单全收。
 *    这条纪律与引用校验同源：模型只写编号，能不能落地由后端说了算。
 */

/** 批注上限，与 API 层的校验保持一致 */
export const MAX_ANNOTATION_LENGTH = 2000;

/** 这一类修订比导入轻，但仍然给足时间：后台任务等得起 */
const REMEDIATE_TIMEOUT_MS = 10 * 60_000;

export type RemediationRecord = {
  summary: string;
  edits: Array<{ pageId: string; title: string; reason: string; added: number; removed: number }>;
  created: Array<{ id: string; title: string }>;
  rejected: string[];
  noChangeReason: string | null;
  /**
   * 这次修订一共留下几条版本记录。
   *
   * 服务层的每次写各自提交（那是全仓的既有形状：一个词条一条记录），所以一次
   * 修订通常不止一条。界面必须把这个数说出来 —— 只给一个 sha 会让人以为
   * 「撤销那一条就全回去了」，而实际上要逐条撤。
   */
  commits: number;
};

export type StartRemediationInput = {
  itemId: string;
  annotation: string;
  /** 允许注入 provider 以便测试（与 startIngest 同一套做法） */
  provider?: LlmProvider;
};

export function startRemediation(input: StartRemediationInput): { jobId: string } {
  input = { ...input, provider: input.provider ?? createProvider() };
  const jobId = ulid();
  enqueue({
    kind: "remediate",
    jobId,
    payload: { itemId: input.itemId },
    handler: (context) => withCommitOperation("按批注修订体检问题", () => runRemediation(context, input)),
  });
  return { jobId };
}

async function runRemediation(
  context: JobContext,
  input: StartRemediationInput,
): Promise<unknown> {
  const annotation = input.annotation.trim().slice(0, MAX_ANNOTATION_LENGTH);
  if (!annotation) throw new Error("批注是空的 —— 模型需要知道你希望它怎么做。");

  /* ---- ① 读相关词条 ---- */
  context.setStage("reading", "读取相关词条");
  const item = getDb().select().from(reviewItems).where(eq(reviewItems.id, input.itemId)).get();
  if (!item) throw new Error("找不到这条审阅事项，可能已经被清理了。");
  if (hasOversizedRelatedPages(item.relatedPagesJson)) {
    throw new Error("这条事项关联了过多词条，已阻止自动修订。请先在审阅页手动核对关联。 ");
  }

  const related = parseRelatedPages(item.relatedPagesJson);
  const targets: Array<{ id: string; title: string; type: string; content: string; hash: string }> = [];
  const missingTitles: string[] = [];

  for (const ref of related) {
    // id 为 null 表达的是「这个词条还不存在」，不是数据缺失（见 schema 里的注释）
    if (!ref.id) {
      missingTitles.push(ref.title);
      continue;
    }
    try {
      const file = loadPageFile(ref.id);
      targets.push({
        id: ref.id,
        title: file.data.title,
        type: file.data.type,
        content: file.content,
        // 规划时读到的那一份的指纹：落盘时带回去做乐观并发控制，
        // 用户在这期间用 Obsidian 改过同一个文件就报冲突而不是被覆盖
        hash: sha256(file.raw),
      });
    } catch {
      // 词条在体检之后被删了：当作缺页处理，交给模型看批注要不要补建
      missingTitles.push(ref.title);
    }
  }

  if (targets.length === 0 && missingTitles.length === 0) {
    throw new Error(
      "这条事项没有指向任何具体词条，模型无从下手。可以在批注里写清是哪个词条，或者直接从词条页修改。",
    );
  }
  context.log(`读入 ${targets.length} 个词条${missingTitles.length > 0 ? `，另有 ${missingTitles.length} 个缺失的名字` : ""}`);

  /* ---- ② 模型规划修订 ---- */
  context.setStage("drafting", "正在按批注修订");
  const result = await completeStructured({
    provider: input.provider ?? createProvider(),
    schema: RemediationSchema,
    schemaName: "remediation",
    temperature: 0.2,
    timeoutMs: REMEDIATE_TIMEOUT_MS,
    // 取消信号一路传到模型请求上。这一阶段是整次修订里唯一的长耗时，
    // 也是唯一能被真正中断的地方（后面的写库是同步的，跑起来就是一气呵成）
    signal: context.signal,
    messages: [
      {
        role: "user",
        content: buildRemediationPrompt({
          kind: item.kind,
          annotation,
          pages: targets.map((t) => ({ id: t.id, title: t.title, type: t.type, content: t.content })),
          missingTitles,
          decisions: recentDecisions(),
        }),
      },
    ],
    onAttempt: (attempt, error) => {
      context.log(`模型第 ${attempt} 次输出不符合格式要求，已自动重试：${truncate(error, 80)}`, "warning");
    },
  });
  context.setFraction(1);

  const plan: Remediation = result.data;
  const byId = new Map(targets.map((t) => [t.id, t]));
  const applied: RemediationRecord["edits"] = [];
  /** 最后一次写操作的提交。收尾提交落空时拿它兜底 */
  let lastSha: string | null = null;
  const created: RemediationRecord["created"] = [];
  const rejected: string[] = [];
  const conflicts: string[] = [];

  /* ---- ③ 应用修订 ---- */
  context.setStage("applying", "写入知识库");
  context.throwIfCancelled();

  for (const edit of plan.edits) {
    const target = byId.get(edit.pageId);
    if (!target) {
      // 模型常会顺手把旁边的词条也「改」一遍 —— 不在清单里的一律不认
      rejected.push(`${edit.title || edit.pageId}（不在这次读入的清单里）`);
      continue;
    }
    const next = edit.newContent.trim();
    if (!next || next === target.content.trim()) {
      rejected.push(`${target.title}（正文没有实际变化）`);
      continue;
    }

    try {
      // 服务层的每次写都会自己收尾（reindex + backupVault，见 service.finalize），
      // 所以这里不需要、也不该再叠一层提交
      const written = updatePage(target.id, { content: next, expectedHash: target.hash });
      lastSha = written.commitSha ?? lastSha;
    } catch (error) {
      // ConflictError 就是「你在这期间手工改过它」，如实报告而不是覆盖
      conflicts.push(`${target.title}：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const stat = countChanges(target.content, next);
    applied.push({ pageId: target.id, title: target.title, reason: edit.reason, ...stat });
    context.log(`已更新《${target.title}》（+${stat.added} / −${stat.removed} 行）`);
  }

  for (const page of plan.newPages) {
    const title = page.title.trim();
    if (!title) continue;
    // 同名词条已经存在时不新建：批注说「补建」，但它可能刚被别的路径建出来了
    if (targets.some((t) => t.title === title)) {
      rejected.push(`${title}（同名词条已存在）`);
      continue;
    }
    const written = createPage({
      type: page.type,
      title,
      content: page.content,
      tags: ["体检补建"],
      // 低置信度 + 标签：这类词条没有导入那样的原文出处，标出来方便日后复核
      confidence: "low",
    });
    created.push({ id: written.pageId, title });
    lastSha = written.commitSha ?? lastSha;
    context.log(`已补建《${title}》`);
  }

  context.setFraction(1);

  /* ---- ④ 收尾：索引、提交、记账 ---- */
  const record: RemediationRecord = {
    summary: plan.summary,
    edits: applied,
    created,
    rejected,
    noChangeReason: plan.noChangeReason,
    commits: 0,
  };

  let sha: string | null = null;
  let commits = 0;
  if (applied.length > 0 || created.length > 0) {
    context.setStage("committing", "收尾并提交");
    // 先写日志再提交：日志是这次修订「为什么改」的那句话，跟着一起进版本记录。
    // 顺序反过来的话它会留在工作区不提交，用户下次打开版本页看到的是「有未提交的改动」。
    appendLog(
      "EDIT",
      `按批注修订 ${applied.length} 个词条、补建 ${created.length} 个 —— ${truncate(annotation, 80)}`,
    );
    // 这一次提交是这次修订的收尾记录（内容是上面那条日志），也是回滚时最该找的锚点
    const closing = backupVault(`按批注修订：${truncate(plan.summary, 60)}`);
    sha = closing.sha ?? lastSha;
    commits = applied.length + created.length + (closing.committed ? 1 : 0);
  }

  record.commits = commits;
  const now = localISOString();
  getDb()
    .update(reviewItems)
    .set({
      status: "accepted",
      decisionNote: annotation,
      resolvedAt: now,
      remediationJson: JSON.stringify(record),
      appliedSha: sha,
    })
    .where(eq(reviewItems.id, input.itemId))
    .run();

  for (const conflict of conflicts) context.log(conflict, "warning");
  if (rejected.length > 0) {
    context.log(`有 ${rejected.length} 项模型的改动没有采纳：${rejected.join("；")}`, "warning");
  }

  return {
    itemId: input.itemId,
    commitSha: sha,
    edits: applied.length,
    created: created.length,
    rejected,
    conflicts,
    summary: plan.summary,
    noChangeReason: plan.noChangeReason,
  };
}

/** 改了多大：按行算增删。用它代替模型自述的「改了哪里」—— 那个不可信 */
export function countChanges(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const lines = part.count ?? 0;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
}
