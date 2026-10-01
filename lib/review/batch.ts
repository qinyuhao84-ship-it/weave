import type { DeleteStrategy } from "@/lib/vault/service";

/**
 * 批量处理：把一批已回答的事项分组、把模型产出的方案净化。
 *
 * 这个文件是**纯函数** —— 不碰数据库、不碰文件、不调模型，理由与
 * lib/review/questions.ts 相同：这里的规则一旦错了，后果是**静默丢改动**
 * （后写的完整正文把前一条整段抹掉），而静默的错误只能靠测试发现，
 * 不能靠观察线上行为。
 */

/** 分组与净化只需要「一条事项牵涉哪些已有词条」 */
export type ItemRef = {
  itemId: string;
  /** 这条事项牵涉的、**确实存在**的词条 id（id 为 null 的缺页不算） */
  pageIds: string[];
};

/**
 * 按「事项 → 涉及词条」的连通分量分组，每组一次模型调用。
 *
 * 为什么必须是连通分量而不是按大小切：两条回答涉及同一条词条时，它们必须进同一组。
 * 跨组就会产生两条针对同一 pageId 的 edits，而它们各自是照**原始正文**写的完整
 * 正文 —— 顺序应用会互相覆盖，后一条把前一条的改动整段抹掉，且不留任何痕迹。
 * 完整正文不是补丁，所以这件事没有「顺序应用」的补救办法。
 *
 * 不按预算再拆是同一个理由：拆点恰好落在共享词条上时，正确性就没了。
 * 单组过大时由调用方读完整材料并记一条日志 —— 宁可慢，不可丢。
 */
export function groupItems<T extends ItemRef>(items: T[]): T[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const item of items) {
    if (!parent.has(item.itemId)) parent.set(item.itemId, item.itemId);
    for (const pageId of item.pageIds) {
      // 词条 id 与事项 id 处在同一个命名空间里也不会撞：ULID 全局唯一。
      // 仍然加前缀，是为了让「谁是词条、谁是事项」在读代码时一眼可辨。
      const node = `page:${pageId}`;
      if (!parent.has(node)) parent.set(node, node);
      union(item.itemId, node);
    }
  }

  const groups = new Map<string, T[]>();
  for (const item of items) {
    const root = find(item.itemId);
    const bucket = groups.get(root) ?? [];
    bucket.push(item);
    groups.set(root, bucket);
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------------ 方案 */

/** 模型产出的原始方案。形状与 lib/llm/prompts.ts#BatchRemediationSchema 对应 */
export type BatchPlan = {
  summary: string;
  edits: Array<{
    pageId: string;
    title: string;
    newContent: string;
    reason: string;
    itemIds: string[];
  }>;
  newPages: Array<{
    type: string;
    title: string;
    content: string;
    reason: string;
    itemIds: string[];
  }>;
  deletions: Array<{ pageId: string; title: string; reason: string; itemIds: string[] }>;
  merges: Array<{
    sourcePageId: string;
    sourceTitle: string;
    targetPageId: string;
    targetTitle: string;
    mergedContent: string;
    reason: string;
    itemIds: string[];
  }>;
  noChangeItems: Array<{ itemId: string; reason: string }>;
};

/** 一条破坏性操作的影响范围。**由后端现算**，模型自述的一律不采信 */
export type DestroyImpact = {
  totalReferences: number;
  referencingPages: Array<{ pageId: string; title: string; count: number }>;
  /**
   * 影响范围是几点算的。
   *
   * 用户可能读很久才确认，这期间外部编辑会让这份影响失真，所以界面必须显示
   * 「这是 X 分钟前算的」，执行时还要用存下来的哈希校验一次。
   */
  computedAt: string;
};

/** 等待用户确认的破坏性操作 */
export type DestructiveAction =
  | {
      id: string;
      action: "delete";
      pageId: string;
      title: string;
      impact: DestroyImpact;
      /** 默认策略，用户可以在确认界面上改 */
      strategy: DeleteStrategy;
      expectedHash: string | null;
      reason: string;
      itemIds: string[];
    }
  | {
      id: string;
      action: "merge";
      sourcePageId: string;
      sourceTitle: string;
      targetPageId: string;
      targetTitle: string;
      /** 引用改写的影响范围，来自 previewDelete(sourcePageId) */
      impact: DestroyImpact;
      /** 合并后的完整正文 */
      mergedContent: string;
      /** 相对目标现有正文的增删行数，后端用 diff 算 */
      diffStat: { added: number; removed: number };
      expectedHashes: { source?: string; target?: string };
      reason: string;
      itemIds: string[];
    };

/** 已经落盘、只如实报告的部分 */
export type AppliedPart = {
  edits: Array<{ pageId: string; title: string; reason: string; added: number; removed: number }>;
  created: Array<{ id: string; title: string }>;
  conflicts: string[];
  rejected: string[];
  commits: number;
};

/**
 * 每条事项的结局，收尾时据此写回 review_items。
 *
 * 四种结局对事项做的事完全不同，别合并：
 *   · accepted  —— 有改动为它落盘了，结案
 *   · unchanged —— 模型看过之后认为不需要改，回到待裁决（回答一并清掉：
 *                  这条问题已经处理过了，留着回答只会让下一轮重复处理它）
 *   · deferred  —— 还有一项删除/合并等用户确认，或者用户放弃了。**原样保留回答**，
 *                  它停在「已回答」里可以重新发起
 *   · failed    —— 改动没能落盘（冲突）。与 deferred 一样保留回答，
 *                  用户改完外部编辑就能重试
 */
export type ItemOutcome = {
  itemId: string;
  outcome: "accepted" | "unchanged" | "deferred" | "failed";
  note: string;
};

/**
 * 一次批量任务挂起时存进 jobs.draftJson 的东西。
 *
 * 存进 jobs 而不是新开一张表：方案是任务级、有明确生命周期（proposed →
 * applied / cancelled）的产物，与导入草稿同构 —— 存进 jobs 就白拿了
 * saveDraft / readDraft / finishJob / 刷新恢复全套。
 */
export type ChangePlan = {
  mode: "answers" | "mechanical";
  summary: string;
  applied: AppliedPart;
  pending: DestructiveAction[];
  itemOutcomes: ItemOutcome[];
};

/** 用户确认时回传的东西 */
export type ApplyInput = {
  /** 勾选要执行的破坏性操作 id */
  approve: string[];
  /** 用户改过的正文（键是操作 id） */
  edits?: Record<string, string>;
};

/* -------------------------------------------------------------- 净化规则 */

const DEFAULT_MAX_DESTRUCTIVE = 5;

export type SanitizeResult = {
  edits: BatchPlan["edits"];
  newPages: BatchPlan["newPages"];
  deletions: BatchPlan["deletions"];
  merges: BatchPlan["merges"];
  noChangeItems: BatchPlan["noChangeItems"];
  /** 被丢掉的东西与原因。如实报告，不静默 */
  rejected: string[];
};

/**
 * 应用模型方案之前的确定性净化。
 *
 * 每一条规则都对应一种真实的模型行为，而不是假想的：
 *
 *  R1 未知 pageId —— 模型常会顺手把旁边的词条也「改」一遍
 *  R2 同一 pageId 多条 edits —— 完整正文不是补丁，第二条是照原稿写的，
 *     应用上去等于把第一条回滚掉。保留最长是猜的，不如一条确定的规则加如实报告
 *  R3 破坏性操作与改动撞同一词条 —— 破坏性让位：它本来就要等确认，退回零代价；
 *     退回 edits 则会让用户的回答落空
 *  R4 merges 指向不存在的目标 / 自己合并自己
 *  R5 破坏性操作数量上限 —— 确认界面的价值与条数成反比
 */
export function sanitizePlan(
  plan: BatchPlan,
  targets: Array<{ id: string; title: string; content: string }>,
  options: { maxDestructive?: number } = {},
): SanitizeResult {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const rejected: string[] = [];

  // --- R1 + R2：改动 ---
  const edits: BatchPlan["edits"] = [];
  const editedIds = new Set<string>();
  for (const edit of plan.edits) {
    const target = byId.get(edit.pageId);
    if (!target) {
      rejected.push(`${edit.title || edit.pageId}（不在这次读入的清单里）`);
      continue;
    }
    if (editedIds.has(edit.pageId)) {
      rejected.push(`${target.title}（同一词条出现多条改动，只应用了第一条）`);
      continue;
    }
    const next = edit.newContent.trim();
    if (!next || next === target.content.trim()) {
      rejected.push(`${target.title}（正文没有实际变化）`);
      continue;
    }
    editedIds.add(edit.pageId);
    edits.push({ ...edit, newContent: next });
  }

  // --- 新建：同名词条已存在时挡下（与 commitIngest 同一套做法） ---
  const existingTitles = new Set(targets.map((t) => t.title.toLowerCase()));
  const newPages: BatchPlan["newPages"] = [];
  for (const page of plan.newPages) {
    const title = page.title.trim();
    if (!title) continue;
    if (existingTitles.has(title.toLowerCase())) {
      rejected.push(`${title}（同名词条已存在，没有重复建）`);
      continue;
    }
    existingTitles.add(title.toLowerCase());
    newPages.push({ ...page, title });
  }

  // --- R3：破坏性操作与改动撞同一词条时让位 ---
  const touched = new Set([...editedIds, ...newPages.map((p) => p.title.toLowerCase())]);

  // --- R4：删除 ---
  const deletions: BatchPlan["deletions"] = [];
  for (const item of plan.deletions) {
    const target = byId.get(item.pageId);
    if (!target) {
      rejected.push(`${item.title || item.pageId}（要删的词条不在这次读入的清单里）`);
      continue;
    }
    if (touched.has(item.pageId) || touched.has(target.title.toLowerCase())) {
      rejected.push(`${target.title}（同一轮里既要改它又要删它，请分开处理）`);
      continue;
    }
    deletions.push({ ...item, title: target.title });
  }

  // --- R4：合并 ---
  const merges: BatchPlan["merges"] = [];
  for (const merge of plan.merges) {
    const source = byId.get(merge.sourcePageId);
    const target = byId.get(merge.targetPageId);
    if (!source || !target) {
      rejected.push(`${merge.sourceTitle || merge.sourcePageId}（要合并的词条不在这次读入的清单里）`);
      continue;
    }
    if (merge.sourcePageId === merge.targetPageId) {
      rejected.push(`${source.title}（不能和自己合并）`);
      continue;
    }
    if (!merge.mergedContent.trim()) {
      rejected.push(`${source.title} → ${target.title}（没有给出合并后的正文）`);
      continue;
    }
    if (touched.has(merge.sourcePageId) || touched.has(merge.targetPageId)) {
      rejected.push(`${source.title} → ${target.title}（同一轮里既要改它又要合并它，请分开处理）`);
      continue;
    }
    merges.push({ ...merge, sourceTitle: source.title, targetTitle: target.title });
  }

  // --- R5：上限 ---
  const max = options.maxDestructive ?? DEFAULT_MAX_DESTRUCTIVE;
  const destructiveCount = deletions.length + merges.length;
  if (destructiveCount > max) {
    rejected.push(
      `有 ${destructiveCount - max} 项删除/合并没有进入这次确认（一批最多确认 ${max} 项，请分批处理）`,
    );
    // 从后往前砍，先保留模型最靠前的判断
    let overflow = destructiveCount - max;
    while (overflow > 0 && merges.length > 0) {
      merges.pop();
      overflow--;
    }
    while (overflow > 0 && deletions.length > 0) {
      deletions.pop();
      overflow--;
    }
  }

  return { edits, newPages, deletions, merges, noChangeItems: plan.noChangeItems, rejected };
}

/* ------------------------------------------------------ 机械修复计划 */

/** 计划里的一条补建 */
export type FixPlanItem = {
  /** 计划内唯一，确认时按它回传 */
  id: string;
  title: string;
  type: string;
  content: string;
  reason: string;
};

/**
 * 缺页补建的计划。与 ChangePlan 平级，同样存在 jobs.draftJson 里。
 *
 * 为什么只做缺页：机械发现里只有它既明确又有确定产物。孤儿页与压不平的重定向
 * 需要判断「该怎么改」，而放着它们不影响任何东西 —— 缺页却每天都在被引用。
 */
export type FixPlan = {
  mode: "mechanical";
  summary: string;
  items: FixPlanItem[];
  /** 模型建议先不建的名字，逐条说明原因。如实呈现，不悄悄丢掉 */
  skipped: Array<{ name: string; reason: string }>;
};
