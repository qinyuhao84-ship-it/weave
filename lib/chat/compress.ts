import { createLightProvider } from "@/lib/llm";
import { buildSummaryPrompt } from "@/lib/llm/prompts";
import type { LlmProvider } from "@/lib/llm/types";
import { estimateContextTokens, estimateMessagesContextTokens } from "./tokens";
import { buildHistory, writeSummary, type ChatHistory } from "./sessions";

/**
 * 上下文压缩。
 *
 * 把「一段对话历史」变成「一份摘要」。触发与切分由 lib/chat/context.ts 判定，
 * 这里只负责「取哪一段、怎么让模型摘要、结果怎么落库」。
 *
 * 三条贯穿本文件的纪律：
 *
 * 1. **绝不静默丢信息**。摘要只覆盖它真的读过的那一段，水位线永远等于那一
 *    段的最后一条消息。没被读到的消息一律原样保留在逐字历史里 ——
 *    宁可这一轮没压干净，也不能让某几条消息既没进摘要、又没进 prompt。
 *
 * 2. **摘要失败不能挡路**。用户提问是主路径；因为摘要没成而答不了问题，
 *    是本末倒置。所有失败都降级（返回原样的历史，让调用方走截断兜底），
 *    并把失败原因如实带出去，不吞掉。
 *
 * 3. **模型输出是数据不是事实**。摘要文本会被放进下一轮的 system 位置，
 *    所以：输入输出双向 wrapUntrusted、边界标记由 wrapUntrusted 确定性拆解、
 *    空摘要与过短摘要一律视为失败。
 */

/**
 * 压缩时逐字保留的最近消息条数（8 条 = 4 轮）。
 *
 * ⚠️ 这个数字**只在压缩发生时才生效**，它不是历史的长度上限。
 * 没有被摘要覆盖的历史一律完整保留（见下面 splitForCompression 的说明）。
 * 把「保留区」当成「窗口大小」是这套设计里最容易犯的错 ——
 * 那样在 8~12 条这个区间里被挤掉的消息既没保留也没进摘要，直接从 prompt 里消失。
 */
export const KEEP_RECENT_MESSAGES = 8;

/**
 * 摘要输入的字符上限。
 *
 * 超出时**从最旧的一端截取**，而不是从最新的一端。两种截法区别很大：
 * 取最旧的，水位线落在截取段的末尾，剩下的消息继续逐字保留 —— 什么都不丢；
 * 取最新的，中间那段就既没进摘要也没进 prompt，静默失忆。
 *
 * 80k 字符约合 80k token，一次摘要调用几十秒量级。设这个上限是因为：
 * 1M 窗口的模型在 85% 时可能有 80 万 token 的历史，不设限的话摘要本身就要跑很久，
 * 甚至自己撞上限。压不完的部分下一轮接着压。
 */
const SUMMARY_INPUT_CHAR_BUDGET = 80_000;

/**
 * 摘要调用的超时。
 *
 * 必须单独设。provider 的默认超时是 300 秒，而 app/api/chat/route.ts 的
 * maxDuration 也是 300 —— 摘要端点一慢，用户等来的不是「答案晚一点」，
 * 而是整条请求超时、一个字都拿不到。宁可放弃这次压缩。
 */
const SUMMARY_TIMEOUT_MS = 90_000;

/**
 * 摘要至少要省下这么多，否则视为无效。
 *
 * 短会话里「摘要比原文还长」是真实存在的：模型写的摘要带小标题和分点，
 * 原文却只有三句话。这种摘要落库的后果是水位线前进了、prompt 却没变短，
 * 于是下一轮又触发一次压缩 —— 每轮白等一次模型调用，占用率纹丝不动。
 */
const MIN_GAIN = 0.1;

/** 摘要文本短于这个长度就当作失败。空串、只有一个句号，都是模型没干活。 */
const MIN_SUMMARY_CHARS = 20;

/**
 * 摘要失败后的冷却窗口。
 *
 * 没有它的话，一次持续失败（配额耗尽、网关挂住）会让用户**每一轮**都白等一次
 * 完整的超时。放在进程内而不是库里：这只是节流，不是知识 ——
 * 重启后重试一次是合理的，而写进库又要多一列、多一种不一致。
 */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const failureCooldown = new Map<string, number>();

/**
 * 记一次失败，并顺手清掉已经过期的条目。
 *
 * 清过期条目不是可有可无的整洁：这个 Map 的键是 sessionId，而条目只在压缩成功时
 * 才被删掉 —— 于是「失败过一次、之后用户再没回来」的会话会永久占一个位置。
 * `pnpm start` 是长驻进程（仓库明确推荐用它跑导入这类长任务），跑上几周就是一条
 * 只增不减的内存增长。单个条目只是几十字节，但「没有上界」本身就是 bug。
 */
function markFailure(sessionId: string, now: number): void {
  for (const [id, until] of failureCooldown) {
    if (until <= now) failureCooldown.delete(id);
  }
  failureCooldown.set(sessionId, now + FAILURE_COOLDOWN_MS);
}

export type SplitPlan = {
  /** 本次要摘要掉的消息（从最旧一端开始，连成一段） */
  toCompress: ChatHistory["messages"];
  /** 水位线：摘要覆盖到这条消息为止 */
  coveredToMessageId: string | null;
};

/**
 * 决定这次摘要吃掉哪一段。
 *
 * 纯函数，没有 IO —— 边界条件太多（历史为空、比保留区还短、超出字符预算），
 * 混进异步流程就没法逐个构造出来测。
 *
 * 关键性质：**compressible ∪ keep = 全部历史消息**。也就是说这个函数只决定
 * 「哪些进摘要、哪些留原文」，不产生第三种去向。任何「既没进摘要也没保留」
 * 的消息都是 bug，而这条等式就是它的守卫（tests/context.test.ts 里直接断言）。
 */
export function splitForCompression(
  history: ChatHistory,
  options: { keepRecent?: number; charBudget?: number } = {},
): SplitPlan {
  const keepRecent = options.keepRecent ?? KEEP_RECENT_MESSAGES;
  const charBudget = options.charBudget ?? SUMMARY_INPUT_CHAR_BUDGET;
  const messages = history.messages;

  // 比保留区还短的历史没有可压缩的部分
  if (messages.length <= keepRecent) return { toCompress: [], coveredToMessageId: null };

  const compressible = messages.slice(0, messages.length - keepRecent);

  // 从最旧一端累加，超出预算就停
  const picked: ChatHistory["messages"] = [];
  let used = 0;
  for (const message of compressible) {
    const size = estimateContextTokens(message.content) + 8; // 角色标签与分隔符。
    if (used + size > charBudget) break;
    picked.push(message);
    used += size;
  }
  if (picked.length === 0) return { toCompress: [], coveredToMessageId: null };

  // 切点回调到「下一条是用户消息」的位置，别把一问一答劈开。
  // 劈开本身不会丢信息（两半都在），但摘要里只剩问题、原文里只剩回答，
  // 读起来会像是两个不相干的话题。
  //
  // 必须先判 `!== undefined`：预算够用时 picked 会正好吃掉整段 compressible
  // （这是常态），此时 `compressible[picked.length]` 是 undefined，而
  // `undefined?.role !== "user"` 求值为 true —— 会把末尾那条白弹掉，
  // 于是一问一答被劈成两半，正好是这段代码本来要防的事。
  while (
    picked.length > 1 &&
    compressible[picked.length] !== undefined &&
    compressible[picked.length].role !== "user"
  ) {
    picked.pop();
  }

  return { toCompress: picked, coveredToMessageId: picked.at(-1)!.id };
}

export type CompressionOutcome =
  | { status: "compressed"; history: ChatHistory; summaryTokens: number; model: string; compressedMessages: number }
  | { status: "skipped"; reason: "nothing-to-compress" | "cooldown"; history: ChatHistory }
  | { status: "failed"; reason: string; history: ChatHistory };

/**
 * 执行一次压缩。
 *
 * 返回的 history 是**重新从库里读出来**的，不是本地拼的 —— 落库之后的状态才是
 * 权威，用它去组装 prompt 才不会和别处的读取产生分歧。
 */
export async function compressHistory(input: {
  sessionId: string;
  history: ChatHistory;
  provider?: LlmProvider;
  signal?: AbortSignal;
  /**
   * 本轮提问在库里的消息 id / 提问原文。
   *
   * 必须由调用方传进来，且要和它自己组装历史时用的那一份完全一致。成功路径会
   * 重新从库里读历史，而 route 在这之前刚把提问落了库 —— 不排除它，同一个问题
   * 就会在 prompt 里出现两次（一次在历史里、一次在最后的 user 消息里）：
   * 占用反而因为刚做的压缩而变大，两条连续的 user 消息还有端点会判成畸形请求。
   */
  excludeMessageId?: string;
  excludeMessageIds?: string[];
  question?: string;
  /** 覆盖字符预算，仅供测试 */
  charBudget?: number;
  /** 覆盖保留条数，仅供测试 */
  keepRecent?: number;
  now?: number;
}): Promise<CompressionOutcome> {
  let plan = splitForCompression(input.history, {
    ...(input.charBudget !== undefined ? { charBudget: input.charBudget } : {}),
    ...(input.keepRecent !== undefined ? { keepRecent: input.keepRecent } : {}),
  });

  if (plan.toCompress.length === 0 || !plan.coveredToMessageId) {
    return { status: "skipped", reason: "nothing-to-compress", history: input.history };
  }

  const now = input.now ?? Date.now();
  const until = failureCooldown.get(input.sessionId);
  if (until !== undefined && now < until) {
    return { status: "skipped", reason: "cooldown", history: input.history };
  }
  // 已经过期的条目顺手删掉，不留着占位置（见 markFailure 的说明）
  if (until !== undefined) failureCooldown.delete(input.sessionId);

  let provider: LlmProvider;
  try {
    provider = input.provider ?? createLightProvider();
  } catch (error) {
    return { status: "failed", reason: toReason(error), history: input.history };
  }

  // 与调用方过滤后的历史快照一致；不能重新读取旧版本已混入失败回答的摘要。
  const existing = input.history.summary;
  if (provider.contextWindow) {
    const fixed = estimateMessagesContextTokens([{ content: buildSummaryPrompt({ previousSummary: existing?.content ?? null, transcript: "" }) }]);
    const available = Math.max(0, Math.floor(provider.contextWindow * 0.8) - fixed);
    plan = splitForCompression(input.history, {
      charBudget: Math.min(input.charBudget ?? SUMMARY_INPUT_CHAR_BUDGET, available),
      ...(input.keepRecent !== undefined ? { keepRecent: input.keepRecent } : {}),
    });
    if (!plan.toCompress.length || !plan.coveredToMessageId) {
      return { status: "skipped", reason: "nothing-to-compress", history: input.history };
    }
  }
  const transcript = plan.toCompress
    .map((message) => `【${message.role === "user" ? "用户" : "助手"}】${message.content}`)
    .join("\n\n");

  const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

  let summary: string;
  let model: string;
  try {
    const result = await provider.complete({
      sessionId: input.sessionId,
      messages: [{
        role: "user",
        content: buildSummaryPrompt({
          previousSummary: existing?.content ?? null,
          transcript,
        }),
      }],
      // 摘要要的是稳定复述，不是发挥
      temperature: 0.2,
      signal,
    });
    summary = result.text.trim();
    if (result.truncated) throw new Error("摘要输出被截断，保留原始历史并等待重试");
    model = result.model;
  } catch (error) {
    // 用户主动取消（关标签页、点停止、请求被中止）**不是**摘要的失败：模型和端点
    // 都没问题，只是调用方不要这次结果了。把它记进冷却的后果很具体 —— 用户紧接着
    // 在同一会话里再问一句，占用仍在 85% 以上，压缩却被「冷却中」跳过，
    // 直接掉进硬截断，丢掉的是真实的历史消息。
    if (isCallerAbort(input.signal, error)) {
      return {
        status: "failed",
        reason: "本轮请求已中断，这次压缩没有执行",
        history: input.history,
      };
    }
    // 如实带出失败原因，但不抛给调用方 —— 压缩失败不该让用户问不了问题
    markFailure(input.sessionId, now);
    return { status: "failed", reason: toReason(error), history: input.history };
  }

  // 空摘要 / 过短摘要都当作失败。
  // 不当作成功的后果很严重：水位线照样前进，被覆盖的历史却没有任何替代物，
  // 于是那一段对话就凭空消失了，而且没有任何地方会报错。
  if (summary.length < MIN_SUMMARY_CHARS) {
    markFailure(input.sessionId, now);
    return { status: "failed", reason: "模型返回的摘要为空或过短", history: input.history };
  }

  // 增益不足时**丢弃这次结果**：不落库、水位线不动，历史原样保留（不丢信息），
  // 并进冷却，免得下一轮又白调一次。
  //
  // 被替代的是「上一版摘要 + 这一段的原文」两份东西，不是只有原文 —— 模型拿到的
  // 就是这两份，产出的合并摘要要同时顶掉它们。只跟原文比会漏掉一个很常见的正常
  // 情形：上一版摘要比新段还长时，正确的合并结果必然比新段长，于是被判成
  // 「摘要没比原文短」扔掉，还顺手进 5 分钟冷却；冷却过后下一次触发同样被扔。
  // 结果是水位线永远不动、占用一直涨，最后一头撞上硬截断真丢消息。
  const before =
    estimateContextTokens(transcript) + (existing ? estimateContextTokens(existing.content) : 0);
  const after = estimateContextTokens(summary);
  if (after >= before * (1 - MIN_GAIN)) {
    markFailure(input.sessionId, now);
    return { status: "failed", reason: "摘要没有比原文更短，已放弃这次结果", history: input.history };
  }

  const written = writeSummary({
    sessionId: input.sessionId,
    content: summary,
    coveredToMessageId: plan.coveredToMessageId,
    coveredMessageCount: (existing?.coveredMessageCount ?? 0) + plan.toCompress.length,
    // 压缩次数只增不减。它是摘要链的层数，用来在排查时判断信息衰减到了第几层。
    compressionCount: (existing?.compressionCount ?? 0) + 1,
    tokenCount: after,
    model,
  });

  failureCooldown.delete(input.sessionId);

  // 竞争失败（另一个标签页同时压缩，且它的水位线更靠后）时，库里那份更新，
  // 但状态已经是「压缩过」了 —— 照样按压缩成功返回，只是条数以库里为准。
  return {
    status: "compressed",
    // 排除项与调用方组装历史时用的那一份保持一致。少了它，route 在调用前刚落库的
    // 这条提问会被当成历史再读回来，prompt 里就有两份同一个问题（见入参说明）。
    history: buildHistory(input.sessionId, {
      ...(input.excludeMessageId ? { excludeMessageId: input.excludeMessageId } : {}),
      ...(input.excludeMessageIds ? { excludeMessageIds: input.excludeMessageIds } : {}),
      ...(input.question !== undefined ? { question: input.question } : {}),
    }),
    summaryTokens: after,
    model,
    compressedMessages: written ? plan.toCompress.length : (existing?.coveredMessageCount ?? 0),
  };
}

/**
 * 这次中断是不是调用方自己按的取消。
 *
 * 只看两处：调用方传进来的 signal 是否已经 abort，以及错误的 name 是不是
 * AbortError。**刻意不看 TimeoutError** —— 那是 AbortSignal.timeout 到点了，
 * 端点太慢是真的失败，该进冷却。
 */
function isCallerAbort(signal: AbortSignal | undefined, error: unknown): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function toReason(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `摘要调用超过 ${Math.round(SUMMARY_TIMEOUT_MS / 1000)} 秒未返回`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 仅供测试：清掉冷却状态 */
export function resetCompressionCooldown(): void {
  failureCooldown.clear();
}
