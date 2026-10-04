/** LLM 层的公共契约。所有上层代码只依赖这些类型，不直接碰具体 SDK。 */

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/** JSON Schema 约束（严格模式）。是否支持取决于端点和具体模型。 */
export type JsonSchemaFormat = {
  name: string;
  schema: Record<string, unknown>;
  strict: boolean;
};

export type ResponseFormat =
  /** 明确要求服务商保证结构 —— 只有少数厂商支持 */
  | { type: "json_schema"; json_schema: JsonSchemaFormat }
  /** 只保证是合法 JSON，不保证键名与类型 */
  | { type: "json_object" }
  /**
   * 完全不发 response_format 字段。
   *
   * 这不是「不要求 JSON」，而是「不借助服务商的格式约束」—— 指令仍然写在
   * prompt 里，结构仍由 Zod 校验兜底。有些网关（实测 opencode go）对
   * response_format 直接返回 400，那时这是唯一能走通的路。
   */
  | { type: "none" };

/**
 * 思考强度档位。
 *
 * 这是 DeepSeek 系列的参数（实测确认：请求参数名是 reasoning_effort，
 * 而 /models 返回的 `effort` 只是能力描述字段——传 effort 会被静默忽略）。
 * 低档与最高档的差距是数量级的：同一道数学证明题，low 思考 661 字，
 * max 思考 3203 字。
 */
export const REASONING_EFFORTS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type CompletionRequest = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
  /** 覆盖本次调用的超时（毫秒）。不传则用 provider 的默认值 */
  timeoutMs?: number;
  /** 覆盖本次调用使用的模型 */
  model?: string;
  /** 覆盖默认请求头（例如网关要求的会话标识） */
  headers?: Record<string, string>;
  /** 会话标识；OpenCode Go 会将它用于 x-opencode-session。 */
  sessionId?: string;
  /** 思考强度。仅在端点支持时发送；不支持时在设置中选择不发送参数。 */
  reasoningEffort?: ReasoningEffort;
  /**
   * 推理过程的增量回调。
   *
   * 支持思考的模型（如 DeepSeek 系列）会在 delta 里额外返回 reasoning_content ——
   * 那是模型真实的思考过程。把它接出来展示，用户等待时看到的不再是
   * 「正在输入…」这种空话，而是模型此刻真的在想什么。
   */
  onReasoningDelta?: (text: string) => void;
};

export type CompletionUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type CompletionResult = {
  text: string;
  usage: CompletionUsage | null;
  model: string;
  /** 是否因为达到 token 上限而被截断 */
  truncated: boolean;
};

/**
 * provider 抽象。
 *
 * 为什么不直接用某个厂商的 SDK：调研结论是国内模型迭代很快（型号名半年一换），
 * 而「严格 JSON Schema」这种关键能力各家支持程度差别很大。把差异收敛到这一层，
 * 换模型就只是改配置，不用动业务代码。
 */
export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  /** 已配置的上下文容量，供摘要等辅助任务控制输入。 */
  readonly contextWindow?: number;
  /** 是否支持严格 JSON Schema（约束解码级保证，而非仅仅"是合法 JSON"） */
  readonly supportsStrictSchema: boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** 流式输出：逐块产出文本增量 */
  stream(request: CompletionRequest): AsyncGenerator<string, CompletionResult, void>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastRaw: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}
