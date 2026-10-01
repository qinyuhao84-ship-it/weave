import type {
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  LlmProvider,
} from "./types";

/**
 * 可编程的假 provider。
 *
 * 存在的理由：结构化输出层的全部价值恰恰在于「模型不听话时怎么办」，
 * 而真实模型大部分时候是听话的 —— 用它没法稳定复现坏格式、截断、字段类型错
 * 这些场景。假 provider 让这些边界条件变成可断言的测试。
 *
 * 只在测试与本地演示里使用，绝不进入生产调用路径。
 */
export type FakeResponse =
  | string
  | { text: string; truncated?: boolean; usage?: CompletionUsage }
  | { error: string; retryable?: boolean }
  | ((request: CompletionRequest) => string);

export class FakeProvider implements LlmProvider {
  readonly id = "fake";
  readonly model: string;
  readonly supportsStrictSchema: boolean;

  /** 记录每一次调用，供测试断言 */
  readonly calls: CompletionRequest[] = [];
  private queue: FakeResponse[] = [];
  private fallback: FakeResponse;

  constructor(options: {
    responses?: FakeResponse[];
    fallback?: FakeResponse;
    model?: string;
    supportsStrictSchema?: boolean;
  } = {}) {
    this.queue = options.responses ?? [];
    this.fallback = options.fallback ?? "{}";
    this.model = options.model ?? "fake-model";
    this.supportsStrictSchema = options.supportsStrictSchema ?? false;
  }

  /** 追加一批预设响应 */
  push(...responses: FakeResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  private next(_request: CompletionRequest): FakeResponse {
    const item = this.queue.shift();
    return item ?? this.fallback;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request);
    const response = this.next(request);

    if (typeof response === "string") {
      return { text: response, usage: null, model: this.model, truncated: false };
    }
    if (typeof response === "function") {
      return { text: response(request), usage: null, model: this.model, truncated: false };
    }
    if ("error" in response) {
      const { LlmError } = await import("./types");
      throw new LlmError(response.error, 500, response.retryable ?? false);
    }
    return {
      text: response.text,
      // usage 默认仍是 null（多数断言不关心它），但可以显式给出来 ——
      // 「用真实 promptTokens 覆盖估算」那条路径没有它就完全测不到
      usage: response.usage ?? null,
      model: this.model,
      truncated: response.truncated ?? false,
    };
  }

  async *stream(request: CompletionRequest): AsyncGenerator<string, CompletionResult, void> {
    const result = await this.complete(request);
    // 按固定长度切片，模拟真实的流式分片
    const chunkSize = 8;
    for (let i = 0; i < result.text.length; i += chunkSize) {
      yield result.text.slice(i, i + chunkSize);
    }
    return result;
  }

  /** 最后一次调用实际发出的消息（用于断言 prompt 内容） */
  get lastMessages() {
    return this.calls.at(-1)?.messages ?? [];
  }
}
