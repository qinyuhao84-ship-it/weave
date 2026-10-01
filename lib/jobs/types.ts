/**
 * 任务阶段表与进度换算。
 *
 * 这是「进度条」这件事的全部真相所在：每种任务有一张**阶段表**，每个阶段带两个数：
 *   · `weight`      —— 该阶段占整体进度的多少个百分点（每张表各自合计 100）
 *   · `expectedMs`  —— 该阶段通常要跑多久，用来在**没有真实进度可报**时估算
 *
 * 为什么需要 expectedMs：analyzing / drafting / judging 这类整块的 LLM 调用，
 * 中途拿不到任何真实进度。没有它，进度条就只在两个瞬间动一下，其余几分钟纹丝不动
 * —— 用户看到的就是「只有 50% 和 100% 两个值」。有了它，阶段内按估算曲线连续推进，
 * 真实进度一旦报上来就交棒（取 max），所以估算永远不会盖过事实。
 *
 * 为什么按任务类型分表而不是共用一张：不同任务的阶段根本不是同一件事，
 * 塞进一张表要么互相迁就、要么让权重失去意义（体检没有「解析文档」这一步，
 * 导入也没有「抽样读取词条」）。早先只有导入一张表时，修订任务的阶段名
 * （reading / drafting / applying）查不到，computeProgress 对未知阶段返回 100 ——
 * 于是修订的进度条从点下去那一刻就是满的，那不是「估算不准」，是**在骗人**。
 */

/** 一个阶段的定义。四个字段各管一件事，别混。 */
export type JobStageDefinition = {
  stage: string;
  label: string;
  weight: number;
  expectedMs: number;
};

/** 一张阶段表。每张表的第一项固定是排队阶段（weight 0），见下面的说明。 */
export type JobStageTable = readonly JobStageDefinition[];

/**
 * 导入流水线的阶段。
 *
 * 数值来自本机实测（deepseek-v4.1-flash、max 思考档、4k 字符的输入）：
 * 分析约 110s、草稿约 130s；解析一份 docx 约 2s、PDF 走 docling 约 20s。
 */
export const INGEST_STAGES = [
  { stage: "uploaded", label: "已接收文件", weight: 3, expectedMs: 3_000 },
  { stage: "parsing", label: "解析文档", weight: 15, expectedMs: 25_000 },
  { stage: "analyzing", label: "分析内容", weight: 30, expectedMs: 110_000 },
  { stage: "drafting", label: "生成词条草稿", weight: 35, expectedMs: 130_000 },
  { stage: "reviewing", label: "等待你审阅", weight: 0, expectedMs: 0 },
  { stage: "committing", label: "写入知识库", weight: 17, expectedMs: 12_000 },
] as const;

/**
 * 体检的阶段。
 *
 * 与导入共用同一套进度语言（权重 + 估算曲线 + 1% 取整），但阶段完全不同：
 * 体检没有解析、没有草稿，它的重头是**一次整块的模型判断**。
 *
 * judging 给到 70% 是有意的：那一阶段真实耗时占整次体检的九成以上，
 * 前面的程序检查与抽样都是毫秒级的。权重与实际耗时对不上的话，
 * 进度条会在开头几毫秒冲过 30%，然后卡在 30% 不动两分钟 —— 比没有进度更糟。
 *
 * 起点速度：70% × (2.5 / 90s) ≈ 1.9%/秒，配合 400ms 的上报节拍与 1% 取整，
 * 界面上是每秒稳稳跳一格 —— 这正是「颗粒度到 1%」的实际手感。
 */
export const LINT_STAGES = [
  { stage: "uploaded", label: "已排队", weight: 0, expectedMs: 0 },
  { stage: "mechanical", label: "程序检查死链与孤儿页", weight: 6, expectedMs: 800 },
  { stage: "sampling", label: "抽样读取词条", weight: 8, expectedMs: 1_500 },
  { stage: "judging", label: "模型判断矛盾与过时论断", weight: 70, expectedMs: 90_000 },
  { stage: "queuing", label: "写入审阅队列", weight: 8, expectedMs: 1_000 },
  { stage: "committing", label: "收尾并提交", weight: 8, expectedMs: 3_000 },
] as const;

/** 按批注修订的阶段。同样以排队开头，合计 100。 */
export const REMEDIATE_STAGES = [
  { stage: "uploaded", label: "已排队", weight: 0, expectedMs: 0 },
  { stage: "reading", label: "读取相关词条", weight: 10, expectedMs: 1_500 },
  { stage: "drafting", label: "按批注修订", weight: 70, expectedMs: 60_000 },
  { stage: "applying", label: "写入知识库", weight: 12, expectedMs: 3_000 },
  { stage: "committing", label: "收尾并提交", weight: 8, expectedMs: 2_000 },
] as const;

/**
 * 批量处理回答 / 机械修复计划的阶段。同样以排队开头，合计 100。
 *
 * `reviewing` 这一项 weight 0 是**必须有的**：runner.saveDraft() 把 stage 硬写成
 * "reviewing"（见 lib/jobs/runner.ts），阶段表里查不到它就会落进 computeProgress
 * 的「未知阶段直接给满」分支 —— 方案一生成进度条立刻 100%，那不是估算不准，
 * 是在骗人。这与修订任务当初踩的坑同源。
 *
 * drafting 给到 62%：这一阶段是整块的模型调用（可能一次读进好几个词条的完整
 * 正文），真实耗时占九成以上。权重与实际耗时对不上，进度条会在开头几毫秒冲过
 * 一大截然后卡住不动 —— 比没有进度更糟。
 */
export const REVIEW_STAGES = [
  { stage: "uploaded", label: "已排队", weight: 0, expectedMs: 0 },
  { stage: "reading", label: "读取相关词条", weight: 8, expectedMs: 2_000 },
  { stage: "drafting", label: "模型正在处理这批回答", weight: 62, expectedMs: 90_000 },
  { stage: "applying", label: "写入知识库", weight: 18, expectedMs: 4_000 },
  { stage: "reviewing", label: "等待你确认", weight: 0, expectedMs: 0 },
  { stage: "committing", label: "收尾并提交", weight: 12, expectedMs: 2_000 },
] as const;

/**
 * 任务类型 → 阶段表。
 *
 * reindex / rebuild_graph / refile 这类没有自己阶段表的短任务落回导入表：
 * 它们要么秒级完成、要么根本不报进度，共用一张表不会有任何可见后果。
 */
export function stagesForKind(kind: string): JobStageTable {
  switch (kind) {
    case "lint":
      return LINT_STAGES;
    case "remediate":
      return REMEDIATE_STAGES;
    case "review_batch":
      return REVIEW_STAGES;
    default:
      return INGEST_STAGES;
  }
}

export type IngestStage = (typeof INGEST_STAGES)[number]["stage"];

export const TERMINAL_STATUSES = ["done", "failed", "cancelled"] as const;

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "committing"
  | "discarding"
  | "done"
  | "failed"
  | "cancelled";

export const JOB_KINDS = [
  "ingest",
  "lint",
  "reindex",
  "rebuild_graph",
  "refile",
  /** 按审阅事项的批注修订词条，见 lib/review/remediate.ts */
  "remediate",
  /** 批量处理用户的回答（或机械发现的修复计划），见 lib/review/batch.ts */
  "review_batch",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** 推送给前端的事件。SSE 的每一帧就是一个 JobEvent。 */
export type JobEvent =
  | { type: "status"; status: JobStatus; stage: string }
  | { type: "stage"; stage: string; label: string; message?: string }
  | { type: "progress"; progress: number; total: number }
  | { type: "delta"; text: string }
  | { type: "log"; message: string; level?: "info" | "warning" | "error" }
  | { type: "error"; message: string }
  | { type: "done"; result?: unknown };

/**
 * 累积进度：每个阶段有固定权重，避免进度条在阶段切换时跳变。
 *
 * `stages` 默认是导入表 —— 这个默认值必须保住：导入的进度换算与
 * tests/jobs.test.ts 的断言都建立在它之上，泛化不能顺手改掉既有行为。
 */
export function computeProgress(
  stage: string,
  stageFraction = 0,
  stages: JobStageTable = INGEST_STAGES,
): number {
  let accumulated = 0;
  for (const entry of stages) {
    if (entry.stage === stage) {
      return Math.min(100, accumulated + entry.weight * stageFraction);
    }
    accumulated += entry.weight;
  }
  // 未知阶段（如 done/failed）直接给满
  return 100;
}

export function stageLabel(stage: string, stages: JobStageTable = INGEST_STAGES): string {
  return stages.find((s) => s.stage === stage)?.label ?? stage;
}

/** 该阶段的预期时长（毫秒）。未知阶段按 0 处理。 */
export function stageExpectedMs(stage: string, stages: JobStageTable = INGEST_STAGES): number {
  return stages.find((s) => s.stage === stage)?.expectedMs ?? 0;
}

/**
 * 阶段内进度的估算曲线 —— 真实进度拿不到时的替身。
 *
 * 用 `1 - exp(-t/τ)`（τ = 预期时长 / 2.5）而不是线性：LLM 调用的耗时是长尾分布，
 * 线性会在预期时长处撞顶然后僵住（用户看到的是「卡在 90% 不动了」），
 * 指数曲线永远在爬，只是越来越慢 —— 那才是「还没好」的真实样子。
 *
 * 封顶 0.97：估算永远不自己走到本阶段终点。终点只有真实完成才配得上，
 * 否则进度条会先跳到 100% 再等两分钟。
 */
export function estimateStageFraction(
  stage: string,
  elapsedMs: number,
  stages: JobStageTable = INGEST_STAGES,
): number {
  const expected = stageExpectedMs(stage, stages);
  if (expected <= 0) return 1;
  return Math.min(0.97, 1 - Math.exp(-elapsedMs / (expected / 2.5)));
}

/** 阶段起点在整体进度里的位置（该阶段开始时的百分比） */
export function stageStartPercent(stage: string, stages: JobStageTable = INGEST_STAGES): number {
  return computeProgress(stage, 0, stages);
}

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
