import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import {
  LlmError,
  StructuredOutputError,
  type ChatMessage,
  type LlmProvider,
} from "./types";

/**
 * 结构化输出：把「让模型吐 JSON」从祈祷变成工程。
 *
 * 为什么必须有这一层（这是调研里最硬的一条结论）：
 * 不同服务商、模型和套餐对 JSON Schema 的支持不同，不能只凭供应商品牌判断。
 * 所有输出都必须经过本地结构校验，不兼容格式会降级并修正重试。
 *
 * 对「长文档 → 结构化词条」这种不能出错的场景，格式崩溃是直接阻塞流水线的，
 * 而抽取准确率可以靠 prompt 迭代和人工审阅补。所以这一层的价值高于模型选择。
 *
 * 工程纪律（四条，都来自实测经验）：
 *   1. 两阶段生成：先自由推理，再受约束格式化。绝不在 JSON 约束解码过程中
 *      跑复杂推理 —— 会显著劣化结果。
 *   2. schema 尽量减少必填字段。每个必填字段都是一个失败点。
 *   3. 校验失败时把「具体的校验错误」回填进重试 prompt，而不是原样重试。
 *   4. **字段清单必须从第一次调用起就给全**，不能只在重试时才补。
 *      实测证据：opencode go 网关连 json_object 都不支持（自动降级为 none），
 *      模型第一次只看到「输出 JSON」，于是自创了一套顶层键名
 *      （source / compilation_notes ……），校验必然失败；第二次拿到 schema 才通过。
 *      用户看到的就是「每次导入都失败一次、重试一下又好了」—— 每次白等 70 秒的
 *      max 思考档重试，第一次的产出全部作废。代价是多出约 2k token 的 prompt，
 *      换来的是省掉一整轮（约 12k 输出 token）的调用。
 */

/** 从模型输出里抠出 JSON，容忍 markdown 围栏与前后废话 */
export function extractJson(text: string): string | null {
  const trimmed = text.trim();

  // 1. 直接的 JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const candidate = balanceScan(trimmed);
    if (candidate) return candidate;
  }

  // 2. ```json ... ``` 围栏
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    const inner = fenced[1].trim();
    const candidate = balanceScan(inner);
    if (candidate) return candidate;
  }

  // 3. 从任意位置找第一个平衡的 JSON 块
  const start = trimmed.search(/[{[]/);
  if (start >= 0) {
    const candidate = balanceScan(trimmed.slice(start));
    if (candidate) return candidate;
  }

  return null;
}

/** 从字符串开头扫描出一个括号平衡的 JSON 片段（正确处理字符串内的括号与转义） */
function balanceScan(text: string): string | null {
  const open = text[0];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

/** 把 Zod 校验错误整理成模型能看懂、能据此修正的中文说明 */
export function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(根)";
      return `- 字段 ${path}：${issue.message}`;
    })
    .join("\n");
}

export type StructuredOptions<T> = {
  provider: LlmProvider;
  schema: z.ZodType<T>;
  /** schema 名称，严格模式下会传给服务商 */
  schemaName: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 最大尝试次数（含首次） */
  maxAttempts?: number;
  /** 每次失败后的回调，用于向前端推送进度 */
  onAttempt?: (attempt: number, error: string) => void;
  /**
   * 单次调用的超时（毫秒）。
   *
   * 这个选项曾经是死的：声明了却从没往下传，于是「让导入等久一点」这个意图
   * 在代码里表达得清清楚楚，实际却永远吃 provider 的默认值 —— 一份 16KB 的
   * 资料就是这样在起草到一半被 5 分钟上限掐断的。
   */
  timeoutMs?: number;
};

export type StructuredResult<T> = {
  data: T;
  /** 实际尝试了几次。0.5-2% 的重试率是正常基线，飙到 5-10% 说明 prompt 漂移。 */
  attempts: number;
  /** 是否走了严格 Schema 路径 */
  usedStrictSchema: boolean;
};

/**
 * 调模型并拿到一个通过校验的结构化对象。
 *
 * 重试策略：把校验错误原文回填给模型，让它自己修。实测这比原样重试有效得多 ——
 * 模型看到「字段 entity.type 的值 '人' 不在枚举内」时几乎总能一次修对。
 */
export async function completeStructured<T>(options: StructuredOptions<T>): Promise<StructuredResult<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  const useStrict = options.provider.supportsStrictSchema;

  // 严格模式让服务商保证结构；非严格模式只能靠 prompt + 校验兜底
  const jsonSchema = useStrict ? safeToJsonSchema(options.schema, options.schemaName) : null;

  const messages: ChatMessage[] = [...options.messages];
  if (!useStrict) {
    messages.push({
      role: "system",
      content:
        "输出要求：只返回一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。" +
        "所有字符串值内部的双引号必须转义。\n\n" +
        "字段名必须与下面这份 JSON Schema 完全一致：不要自创字段名（例如把 gist 写成 " +
        "summary、把 gaps 写成 notes），也不要省略任何必填字段。\n\n" +
        describeSchema(options.schema),
    });
  }

  let lastRaw = "";
  let lastIssues = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const request = {
      messages,
      temperature: attempt === 1 ? (options.temperature ?? 0.2) : 0,
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      responseFormat: jsonSchema
        ? { type: "json_schema", json_schema: { name: options.schemaName, schema: jsonSchema, strict: true } }
        : { type: "json_object" },
    } satisfies Parameters<LlmProvider["complete"]>[0];
    // 只重试尚未交付结果的请求；取消、参数与鉴权错误立即返回。
    let result;
    for (let retry = 0; ; retry++) {
      options.signal?.throwIfAborted();
      try { result = await options.provider.complete(request); break; }
      catch (error) {
        options.signal?.throwIfAborted();
        if (!(error instanceof LlmError) || !error.retryable || retry >= 2) throw error;
        options.onAttempt?.(attempt, "模型连接暂时中断或服务繁忙，正在自动重试；已完成进度已保存。");
        await delay(1000 * 2 ** retry, undefined, { signal: options.signal });
      }
    }

    lastRaw = result.text;

    if (result.truncated) {
      lastIssues = "输出被 token 上限截断，JSON 不完整。";
      options.onAttempt?.(attempt, lastIssues);
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: "上一次输出被长度限制截断了。请输出更精简的内容，确保 JSON 结构完整闭合。",
      });
      continue;
    }

    const json = extractJson(result.text);
    if (!json) {
      lastIssues = "没有找到可解析的 JSON。";
      options.onAttempt?.(attempt, lastIssues);
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: "上一次的输出里没有解析到 JSON。请只输出一个 JSON 对象，不要任何其它文字。",
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      lastIssues = `JSON 语法错误：${error instanceof Error ? error.message : String(error)}`;
      options.onAttempt?.(attempt, lastIssues);
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: `上一次的 JSON 有语法错误（${lastIssues}）。请修正后重新输出完整 JSON。`,
      });
      continue;
    }

    const validation = options.schema.safeParse(parsed);
    if (validation.success) {
      return { data: validation.data, attempts: attempt, usedStrictSchema: useStrict };
    }

    lastIssues = formatValidationIssues(validation.error);
    options.onAttempt?.(attempt, lastIssues);
    messages.push({ role: "assistant", content: result.text });
    messages.push({
      role: "user",
      content:
        `上一次的输出不符合结构要求，具体问题：\n${lastIssues}\n\n` +
        `请严格按下面的字段要求重新输出完整 JSON，不要省略任何必填字段：\n` +
        describeSchema(options.schema),
    });
  }

  throw new StructuredOutputError(
    `结构化输出连续 ${maxAttempts} 次未通过校验。最后一次的问题：\n${lastIssues}`,
    maxAttempts,
    lastRaw,
    lastIssues,
  );
}

/** 把 Zod schema 转成 JSON Schema；失败时返回 null 走降级路径 */
function safeToJsonSchema(schema: z.ZodType, _name: string): Record<string, unknown> | null {
  try {
    const toJson = (z as unknown as { toJSONSchema?: (s: unknown, o?: unknown) => unknown }).toJSONSchema;
    if (typeof toJson !== "function") return null;
    const result = toJson(schema, { target: "draft-7", io: "output" });
    if (!result || typeof result !== "object") return null;
    // 部分服务商要求根节点必须是 object
    return result as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 用自然语言描述 schema，供非严格模式的修正提示使用 */
function describeSchema(schema: z.ZodType): string {
  try {
    const toJson = (z as unknown as { toJSONSchema?: (s: unknown, o?: unknown) => unknown }).toJSONSchema;
    if (typeof toJson !== "function") return "（无法生成字段说明，请严格遵循上文要求）";
    return JSON.stringify(toJson(schema, { target: "draft-7", io: "output" }), null, 2);
  } catch {
    return "（无法生成字段说明，请严格遵循上文要求）";
  }
}
