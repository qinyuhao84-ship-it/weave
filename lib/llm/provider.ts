import {
  LlmError,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
  type ReasoningEffort,
  type ResponseFormat,
} from "./types";
import { canonicalReasoningEffort, reasoningCapability, supportsTemperature } from "./capabilities";
import { cachedModelCapability } from "./models";
import { isOpenCodeGoBaseUrl, OPENCODE_GO_USER_AGENT } from "./presets";

/**
 * OpenAI 兼容协议的 provider。
 *
 * 选这条路而不是各厂商 SDK：阿里云百炼同时托管 Qwen / DeepSeek / GLM / Kimi /
 * MiniMax，一个账号、一把 Key、一个 base_url 就能全部调通，切模型只改一个
 * 字符串。对「本机单用户、不做部署」的场景这是最省事的选择，也为将来换主力
 * 模型留了零成本退路。
 */

export type OpenAiCompatibleConfig = {
  /** 例如 https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  /** 该模型是否支持严格 JSON Schema */
  supportsStrictSchema?: boolean;
  /** 默认采样温度 */
  defaultTemperature?: number;
  /** 默认思考强度。请求里没指定时用它。 */
  defaultReasoningEffort?: ReasoningEffort;
  /**
   * 附加请求头。
   * 有些网关要求特定头才能路由（实测 opencode go 需要 x-opencode-session）。
   */
  headers?: Record<string, string>;
  /** 单次请求超时 */
  timeoutMs?: number;
  /** 显示名，用于界面 */
  label?: string;
};

export { PROVIDER_PRESETS, isPresetKey } from "./presets";
export type { ProviderPresetKey } from "./presets";

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = "openai-compatible";
  readonly model: string;
  readonly contextWindow?: number;
  readonly supportsStrictSchema: boolean;
  readonly label: string;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.model = config.model;
    this.contextWindow = config.contextWindow;
    this.supportsStrictSchema = config.supportsStrictSchema ?? false;
    this.label = config.label ?? config.model;
  }

  private buildBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.config.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
    };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    // 思考强度。参数名是 reasoning_effort —— 用 effort 会被静默忽略。
    const model = String(body.model);
    const metadata = cachedModelCapability(this.config.baseUrl, model);
    const configured = canonicalReasoningEffort(this.config.baseUrl, model, request.reasoningEffort ?? this.config.defaultReasoningEffort ?? "default", metadata);
    const capability = reasoningCapability(this.config.baseUrl, model, metadata);
    const effort = configured !== "default" && (!capability.known || capability.efforts.includes(configured)) ? configured : undefined;
    if (effort) body.reasoning_effort = effort;
    if (supportsTemperature(this.config.baseUrl, String(body.model), effort)) {
      body.temperature = request.temperature ?? this.config.defaultTemperature ?? 0.3;
    }
    const officialReasoning = !supportsTemperature(this.config.baseUrl, String(body.model));
    if (request.maxTokens && officialReasoning) {
      delete body.max_tokens;
      body.max_completion_tokens = request.maxTokens;
    }
    if (stream && new URL(this.config.baseUrl).hostname === "api.openai.com") body.stream_options = { include_usage: true };

    const format = request.responseFormat;
    if (format && format.type !== "none") {
      // 不支持严格 Schema 的端点收到 json_schema 会报错，这里降级成 json_object
      if (format.type === "json_schema" && this.supportsStrictSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: format.json_schema.name,
            schema: format.json_schema.schema,
            strict: format.json_schema.strict,
          },
        };
      } else {
        body.response_format = { type: "json_object" };
      }
    }

    return body;
  }

  /**
   * 端点在运行期被证实支持的格式档位。
   * 一旦降级过就记住，后续调用不再抱着侥幸重试那个档位。
   */
  private degradedFormat: "json_schema" | "json_object" | "none" | null = null;

  /** 真正发出请求（拆出来是为了让降级重试复用） */
  private async send(
    request: CompletionRequest,
    signal: AbortSignal,
    stream: boolean,
  ): Promise<Response> {
    const body = this.buildBody(request, stream);
    // 已经被证实要降级时，直接发降级后的档位，不再白撞一次
    if (this.degradedFormat && body.response_format) {
      body.response_format =
        this.degradedFormat === "none" ? undefined : { type: this.degradedFormat };
      if (body.response_format === undefined) delete body.response_format;
    }
    try {
      return await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: this.headers(request.headers, request.sessionId),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted) throw signal.reason;
      throw new LlmError(`模型连接中断（${message}）。请检查服务地址、网络与代理，已完成的导入进度会保留。`, undefined, true);
    }
  }

  private headers(extra?: Record<string, string>, sessionId?: string): Record<string, string> {
    const isOpenCodeGo = isOpenCodeGoBaseUrl(this.config.baseUrl);
    return {
      "Content-Type": "application/json",
      ...(isOpenCodeGo ? { "User-Agent": OPENCODE_GO_USER_AGENT } : {}),
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...this.config.headers,
      ...(isOpenCodeGo && sessionId ? { "x-opencode-session": sessionId } : {}),
      ...extra,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    // 调用方可以按用途放宽：后台任务等得起，交互式问答等不起
    const timeout = request.timeoutMs ?? this.config.timeoutMs ?? 300_000;
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);

    let response = await this.send(request, signal, false);

    /**
     * response_format 不被支持时逐级降级。
     *
     * 为什么不靠配置里那个 supportsStrictSchema 开关：配置会过期、会填错、
     * 换个端点就失效。实测两种真实的拒绝：
     *   · DeepSeek 官方端点：json_schema → "This response_format type is
     *     unavailable now"，但 json_object 可用
     *   · opencode go 网关：json_schema 与 json_object 都返回 400，只能用 none
     * 与其让用户去猜开关，不如撞上了就自己往下降一级，上层完全不用知道。
     *
     * 降级只影响「借不借服务商的格式约束」，结构安全的最终保证始终是
     * Zod 校验 + 重试闭环 —— 所以降级不会牺牲正确性。
     */
    let format = this.degradedFormat ?? (request.responseFormat?.type === "json_schema" && !this.supportsStrictSchema ? "json_object" : request.responseFormat?.type);
    while (!response.ok && (format === "json_schema" || format === "json_object")) {
      const detail = await response.clone().text().catch(() => "");
      // 只对格式不兼容降级；限流与服务故障保留原请求格式。
      const looksUnsupported = [400, 422].includes(response.status) &&
        /response_format|json_schema|json_object|structured.?output/i.test(detail);
      // 空响应体也是线索：opencode go 只回 {"model":"..."} 什么都不说
      const bodyTooThin = detail.length < 120 && !/choices/i.test(detail);

      if (looksUnsupported || (response.status === 400 && bodyTooThin)) {
        const next: ResponseFormat =
          format === "json_schema" ? { type: "json_object" } : { type: "none" };
        this.degradedFormat = next.type;
        console.warn(
          `[llm] 该端点不支持 ${format}（HTTP ${response.status}），` +
            `已自动降级为 ${next.type} + 校验重试。`,
        );
        response = await this.send({ ...request, responseFormat: next }, signal, false);
        format = next.type;
      } else break;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // 429 与 5xx 值得重试；4xx 里的参数错误重试没有意义
      const retryable = response.status === 429 || response.status >= 500;
      throw new LlmError(formatHttpError(response.status, detail), response.status, retryable);
    }

    let payload: ChatCompletionResponse;
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof TypeError) {
        throw new LlmError("模型连接在接收回答时中断，请重试。", 502, true);
      }
      if (error instanceof SyntaxError) {
        throw new LlmError("模型返回了无效的 JSON，无法读取回答。", 502);
      }
      throw error;
    }
    const choice = payload.choices?.[0];
    if (!choice) {
      throw new LlmError("模型返回了空的 choices");
    }

    const text = typeof choice.message?.content === "string" ? choice.message.content : "";
    const finish = choice.finish_reason ?? "";

    // HTTP 200 / a populated choices array does not prove the model completed its answer.
    // Keep length as a structured-output retry signal; all other non-success endings fail.
    if (finish !== "stop" && finish !== "length") {
      if (finish === "content_filter") {
        throw new LlmError("模型服务中止了这次回答，请调整问题后重试。", 502);
      }
      throw new LlmError("模型连接在回答完成前结束，请重试。", 502, true);
    }
    if (!text.trim()) {
      throw new LlmError("模型没有返回回答正文。请重试或检查所选模型。", 502, true);
    }

    return {
      text,
      usage: payload.usage
        ? {
            promptTokens: payload.usage.prompt_tokens ?? 0,
            completionTokens: payload.usage.completion_tokens ?? 0,
            totalTokens: payload.usage.total_tokens ?? 0,
          }
        : null,
      model: payload.model ?? this.config.model,
      truncated: finish === "length",
    };
  }

  async *stream(request: CompletionRequest): AsyncGenerator<string, CompletionResult, void> {
    const timeout = request.timeoutMs ?? this.config.timeoutMs ?? 300_000;
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);

    const response = await this.send(request, signal, true);

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new LlmError(formatHttpError(response.status, detail), response.status, false);
    }
    if (!response.body) throw new LlmError("模型返回的响应没有 body，无法流式读取");

    let full = "";
    let usage: CompletionResult["usage"] = null;
    let finishReason = "";

    try {
      for await (const chunk of parseSseStream(response.body)) {
        if (chunk === "[DONE]") break;
        let parsed: ChatCompletionChunk;
        try {
          parsed = JSON.parse(chunk) as ChatCompletionChunk;
        } catch {
          // parseSseStream 已按完整 SSE 事件切分，事件内的坏 JSON 不能静默丢弃。
          throw new LlmError("模型返回了无效的流式数据，回答尚未完成。请重试。", 502, true);
        }
        const choice = parsed.choices?.[0];

        // 推理增量单独回调，不混进正文 —— 它是思考过程，不是答案
        const reasoning = choice?.delta?.reasoning_content;
        if (reasoning) request.onReasoningDelta?.(reasoning);

        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) {
          full += delta;
          yield delta;
        }
        if (parsed.choices?.[0]?.finish_reason) {
          finishReason = parsed.choices[0].finish_reason!;
        }
        if (parsed.usage) {
          usage = {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
          };
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof TypeError) {
        throw new LlmError("模型连接在接收流式回答时中断，请重试。", 502, true);
      }
      throw error;
    }

    signal.throwIfAborted();
    // HTTP 200 / 字节流 EOF 只证明连接结束；必须收到模型的完成原因才算完整回答。
    // length 保留给结构化输出的精简重试，问答层会保存正文并标记失败。
    if (finishReason !== "stop" && finishReason !== "length") {
      const message = finishReason === "content_filter"
        ? "模型服务中止了这次回答，已保留生成的部分内容。可以调整问题后重试。"
        : "模型连接在回答完成前结束，已保留生成的部分内容。请重试。";
      throw new LlmError(message, 502, true);
    }
    if (!full.trim()) throw new LlmError("模型没有返回回答正文。请重试或检查所选模型。", 502, true);

    return {
      text: full,
      usage,
      model: this.config.model,
      truncated: finishReason === "length",
    };
  }
}

/** 把 SSE 字节流切成一个个 data 载荷 */
async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件；同时兼容 \r\n
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const data = part.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) yield data;
      }
    }
    // 冲刷残留
    if (buffer.trim().startsWith("data:")) {
      yield buffer.trim().slice(5).trim();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function formatHttpError(status: number, detail: string): string {
  const hint =
    status === 401
      ? "模型服务授权暂不可用，请在设置中检查模型地址、名称及凭据，保存后重试"
      : status === 402 || status === 403
        ? "模型服务暂不可用，请在设置中检查模型地址、名称及凭据，保存后重试"
        : status === 404
          ? "模型服务配置异常，请打开设置查看模型配置说明"
          : status === 429
            ? "服务繁忙，请稍后重试"
            : status >= 500
              ? "模型服务暂时出错，请稍后重试"
              : "请求被拒绝";
  // 上游错误正文可能包含端点、账号或部署细节，不直接回显给浏览器用户。
  void detail;
  return `模型调用暂未完成（${status}）：${hint}`;
}

type ChatCompletionResponse = {
  model?: string;
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export type { ChatMessage, ResponseFormat };
