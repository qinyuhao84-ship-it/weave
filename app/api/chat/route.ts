import { NextRequest, after } from "next/server";
import { fail, handle } from "@/lib/api";
import { createSession, getSession, beginChatRun } from "@/lib/chat/sessions";
import { registerStream } from "@/lib/chat/streams";
import { runChatRun } from "@/lib/chat/run";
import { isLlmConfigured } from "@/lib/settings";
import { ensureVaultLayout } from "@/lib/vault/paths";
import { ensureGitRepo } from "@/lib/git/auto-commit";
import { z } from "zod";
import { ChatConfigSchema } from "@/lib/chat/config";
import { resolveChatConfig } from "@/lib/chat/config-server";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 创建一轮问答后立即返回；模型在服务端运行，不依赖浏览器连接。 */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("请求体不是合法的 JSON。", 400);
  }

  const parsed = z.object({ question: z.string().trim().min(1).max(2000), sessionId: z.string().min(1).nullable().optional(), config: ChatConfigSchema.optional() }).safeParse(raw);
  if (!parsed.success) return fail("请提交文字问题（1–2000 字），以及有效的对话编号。", 400);
  const body = parsed.data;
  const question = body.question;
  if (!isLlmConfigured() && !body.config) {
    return fail("问答服务暂不可用。请稍后重试；如果一直无法使用，请打开设置查看模型配置说明。", 412);
  }

  return handle(() => {
    const session = body.sessionId ? getSession(body.sessionId) : null;
    const config = resolveChatConfig(body.config ?? session?.config ?? undefined);
    ensureVaultLayout();
    ensureGitRepo();
    const sessionId = body.sessionId && getSession(body.sessionId)
      ? body.sessionId
      : createSession();
    const run = beginChatRun(sessionId, question, config);
    const controller = registerStream(sessionId, run.id, run.assistantMessageId, run.createdAt, config);

    after(() => runChatRun({ run, question, controller }));
    return {
      runId: run.id,
      sessionId,
      questionMessageId: run.questionMessageId,
      assistantMessageId: run.assistantMessageId,
      createdAt: run.createdAt,
      config,
    };
  });
}
