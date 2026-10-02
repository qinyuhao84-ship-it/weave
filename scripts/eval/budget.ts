import fs from "node:fs";
import type { CompletionRequest, CompletionResult, LlmProvider } from "../../lib/llm/types";
import { writeJson } from "./storage";

export const GO_MODEL = "deepseek-v4-flash";
export const GO_MAX_USD = 4.8;
export const GO_MAX_REQUESTS = 400;
export const GO_MAX_OUTPUT = 2048;
// 按官方当前高峰价格保守预留，不依赖缓存折扣。缺 usage 时保留全额预留。
export const costUsd = (input: number, output: number) => (input * .30 + output * 1.20) / 1_000_000;
export class BudgetStop extends Error {}
export type BudgetLedger = { startedAt: number; windowEnd: number; limitUsd: number; chargedUsd: number; attempts: number; stopped: boolean; reason: string | null };

export function goConditions(env: Record<string, string | undefined> = process.env, now = Date.now()) {
  if (!env.WEAVE_EVAL_GO_API_KEY) throw new BudgetStop("未配置评测专用 Go 凭据，问答未执行");
  const remaining = Number(env.WEAVE_EVAL_GO_REMAINING_USD); const checked = Date.parse(env.WEAVE_EVAL_GO_QUOTA_CHECKED_AT || ""); const end = Date.parse(env.WEAVE_EVAL_GO_WINDOW_END || "");
  if (env.WEAVE_EVAL_GO_BALANCE_FALLBACK !== "off" || !Number.isFinite(remaining) || remaining <= 0 || remaining > 6 || !Number.isFinite(checked) || now - checked > 600_000 || checked > now + 30_000 || !Number.isFinite(end) || end <= now || end > now + 5 * 3600_000 + 60_000) throw new BudgetStop("Go 剩余额度、窗口截止时间或关闭余额兜底的控制台确认缺失/过期，问答未执行");
  return { limitUsd: Math.min(GO_MAX_USD, remaining), windowEnd: end };
}

export class BudgetedProvider implements LlmProvider {
  readonly id: string; readonly model = GO_MODEL; readonly contextWindow = 32768; readonly supportsStrictSchema: boolean;
  readonly ledger: BudgetLedger;
  constructor(private readonly delegate: LlmProvider, private readonly file: string, conditions: { limitUsd: number; windowEnd: number }, private readonly now = () => Date.now()) {
    if (delegate.model !== GO_MODEL) throw new BudgetStop("问答模型与预算约定不一致");
    this.id = delegate.id; this.supportsStrictSchema = delegate.supportsStrictSchema;
    this.ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { startedAt: 0, windowEnd: conditions.windowEnd, limitUsd: Math.min(GO_MAX_USD, conditions.limitUsd), chargedUsd: 0, attempts: 0, stopped: false, reason: null };
    if (!Number.isFinite(this.ledger.chargedUsd) || this.ledger.chargedUsd < 0 || !Number.isInteger(this.ledger.attempts) || this.ledger.attempts < 0 || !Number.isFinite(this.ledger.limitUsd) || this.ledger.limitUsd <= 0 || this.ledger.limitUsd > GO_MAX_USD || !Number.isFinite(this.ledger.windowEnd)) throw new BudgetStop("预算账本无效，拒绝真实调用");
    this.ledger.limitUsd = Math.min(this.ledger.limitUsd, this.ledger.chargedUsd + conditions.limitUsd);
    this.ledger.windowEnd = Math.min(this.ledger.windowEnd, conditions.windowEnd);
  }
  private reserve(request: CompletionRequest) {
    request.signal?.throwIfAborted();
    if ((request.model ?? this.model) !== GO_MODEL) throw new BudgetStop("拒绝切换模型");
    const inputUpperBound = request.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf8") + 128, 512);
    const reserved = costUsd(inputUpperBound, GO_MAX_OUTPUT);
    if (this.ledger.stopped || this.now() >= this.ledger.windowEnd || (this.ledger.startedAt && this.now() - this.ledger.startedAt >= 5 * 3600_000) || this.ledger.attempts >= GO_MAX_REQUESTS || this.ledger.chargedUsd + reserved > this.ledger.limitUsd) {
      this.stop("额度、请求次数或本窗口预算到达上限"); throw new BudgetStop(this.ledger.reason!);
    }
    this.ledger.startedAt ||= this.now(); this.ledger.attempts++; this.ledger.chargedUsd += reserved; writeJson(this.file, this.ledger);
    return reserved;
  }
  stop(reason: string) { this.ledger.stopped = true; this.ledger.reason = reason; writeJson(this.file, this.ledger); }
  private settle(reserved: number, result: CompletionResult) {
    const usage = result.usage;
    if (usage && [usage.promptTokens, usage.completionTokens, usage.totalTokens].every(value => Number.isInteger(value) && value >= 0) && usage.totalTokens > 0) {
      const actual = costUsd(usage.promptTokens, usage.completionTokens);
      this.ledger.chargedUsd += actual - reserved;
      if (actual > reserved || this.ledger.chargedUsd > this.ledger.limitUsd) this.stop("上游 token 用量超过预留范围，已停止后续请求");
    }
    writeJson(this.file, this.ledger);
  }
  private bounded(request: CompletionRequest): CompletionRequest {
    const deadline = AbortSignal.timeout(Math.max(1, Math.floor(this.ledger.windowEnd - this.now())));
    return { ...request, maxTokens: GO_MAX_OUTPUT, reasoningEffort: undefined, signal: request.signal ? AbortSignal.any([request.signal, deadline]) : deadline };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const reserved = this.reserve(request);
    try { const result = await this.delegate.complete(this.bounded(request)); this.settle(reserved, result); return result; }
    catch { this.stop("模型调用失败或限流，保留预留金额并停止，未自动重试"); throw new BudgetStop(this.ledger.reason!); }
  }
  async *stream(request: CompletionRequest): AsyncGenerator<string, CompletionResult, void> {
    const reserved = this.reserve(request);
    const iterator = this.delegate.stream(this.bounded(request)); let finished = false;
    try {
      for (;;) { const step = await iterator.next(); if (step.done) { finished = true; this.settle(reserved, step.value); return step.value; } yield step.value; }
    } catch { this.stop("模型流失败或限流，保留预留金额并停止，未自动重试"); throw new BudgetStop(this.ledger.reason!); }
    finally { if (!finished) { try { await iterator.return({ text: "", model: this.model, usage: null, truncated: true }); } catch { /* 不回显上游异常正文。 */ } this.stop("模型流未完整结束，保留预留金额并停止"); } }
  }
}
