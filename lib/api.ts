import { NextResponse } from "next/server";
import { z } from "zod";
import { ConflictError, PageNotFoundError, VaultRecoveryError } from "@/lib/vault/service";
import { LlmError, StructuredOutputError } from "@/lib/llm/types";
import { UnsupportedFormatError, ParseQualityError } from "@/lib/ingest/parse/types";
import { ContextOverflowError } from "@/lib/chat/context";

/**
 * API 层的统一出口。
 *
 * 一条纪律：**错误信息是给用户看的**，不是给日志看的。
 * 「Cannot read property 'x' of undefined」对用户毫无意义，
 * 但「这份 PDF 是扫描件，需要 OCR」能立刻告诉他该做什么。
 * 所以这里把内部异常翻译成可操作的中文说明。
 *
 * 这条纪律还有下半句：**翻译意味着不留原文**。未登记的异常一律走末尾的通用
 * 文案，不透传 error.message —— 内部消息里常带着词条 id、vault 绝对路径和英文
 * 堆栈，它们对用户是噪音，对排查也没用（排查看日志）。
 * 所以新增错误类型时要记得在这里登记，否则用户只会看到一句「出了个意料之外的问题」。
 */

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  const codes: Record<number, string> = { 400: "INVALID_REQUEST", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 412: "PRECONDITION_FAILED", 413: "PAYLOAD_TOO_LARGE", 415: "UNSUPPORTED_FORMAT", 422: "UNPROCESSABLE_CONTENT", 502: "UPSTREAM_ERROR" };
  return NextResponse.json({ ok: false, error: message, code: codes[status] ?? "INTERNAL_ERROR", ...extra }, { status });
}

/** 把内部异常翻译成用户能据以行动的中文说明 */
export function toUserMessage(error: unknown): { message: string; status: number; code?: string } {
  if (error instanceof VaultRecoveryError) return { message: error.message, status: 500, code: "VAULT_RECOVERY_REQUIRED" };
  if (error instanceof PageNotFoundError) {
    return { message: error.message, status: 404 };
  }
  if (error instanceof ConflictError) {
    return { message: error.message, status: 409 };
  }
  if (error instanceof UnsupportedFormatError) {
    return { message: error.message, status: 415 };
  }
  if (error instanceof ParseQualityError) {
    return { message: error.message, status: 422 };
  }
  if (error instanceof ContextOverflowError) {
    // 413：请求本身合法，只是这一份塞不进模型的窗口。
    // 消息里已经写了「谁最大、能改哪个旋钮」，直接透传。
    return { message: error.message, status: 413 };
  }
  if (error instanceof LlmError) {
    // 模型层的错误已经带了可操作提示（额度不足 / 模型名不对 / 限流）
    return { message: error.message, status: error.status && error.status >= 400 ? 502 : 500 };
  }
  if (error instanceof StructuredOutputError) {
    return {
      message:
        `模型连续 ${error.attempts} 次没有输出符合要求的结构。` +
        `这通常说明这份资料的结构比较特殊。可以重试一次，或者换一个更强的模型。`,
      status: 502,
    };
  }
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    const path = first?.path.join(".");
    return { message: `参数有误：${path ? `${path} — ` : ""}${first?.message ?? ""}`, status: 400 };
  }
  // 兜底：没有在上面登记过的异常。
  //
  // 这里**刻意不透传 error.message**。理由是这个分支收到的消息是写给日志的，
  // 不是写给用户的：它可能是 "ENOENT: no such file or directory, open
  // '/Users/example/Documents/织识/wiki/entities/01M3FC1XVW6...md'" —— 一次把内部
  // 路径和词条 id 全端到用户面前。用户该看到的是一句能据以行动的说明；
  // 真正的错误进日志（handle() 里也会记一次）。
  //
  // 反过来说：这个分支命中就意味着「有个异常忘了登记」——它出现在用户眼前
  // 的那一刻，也就是该往上面加一个分支的时候。
  console.error("[api] 未登记的错误类型，已按通用文案返回：", error);
  return {
    message:
      "这一步没有完成 —— 出了个意料之外的问题。可以先重试一次；" +
      "如果一直失败，多半是刚才那步操作涉及的内容有异常。技术细节已经记进日志。",
    status: 500,
  };
}

/** 统一的错误处理包装，省掉每个路由里的 try/catch */
export async function handle<T>(fn: () => Promise<T> | T): Promise<NextResponse> {
  try {
    const result = await fn();
    if (result instanceof NextResponse) return result;
    return ok(result);
  } catch (error) {
    const { message, status, code } = toUserMessage(error);
    if (status >= 500) console.error("[api]", error);
    return fail(message, status, code ? { code } : undefined);
  }
}

/**
 * 解析查询参数里的整数。
 *
 * 注意这里必须显式处理 null 与空串：`Number(null)` 是 **0** 而不是 NaN，
 * 所以「参数没传」会被误判成「传了 0」，然后被 clamp 到 min ——
 * 结果是缺省值永远不生效，所有分页都退化成 1 条。
 * 这类 bug 单测很难覆盖（要真的发一次不带参数的请求），只能靠端到端验证抓。
 */
export function intParam(value: string | null, fallback: number, min = 1, max = 1000): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/** 所有 JSON 写入口先验证对象形状，避免 null、数组或标量触发内部异常。 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => null);
  return z.record(z.string(), z.unknown()).parse(value);
}
