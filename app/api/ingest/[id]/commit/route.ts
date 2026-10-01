import { z } from "zod";
import { NextRequest } from "next/server";
import { fail, toUserMessage, ok } from "@/lib/api";
import {
  commitIngest, loadIngestDraft,
  type IngestDraft, type IngestDecision,
} from "@/lib/ingest/pipeline";
import { DraftSchema } from "@/lib/llm/prompts";
import { withCommitOperation } from "@/lib/git/auto-commit";
import { removeQueuedIngestForJob } from "@/lib/ingest/queue";

export const runtime = "nodejs";
export const maxDuration = 120;

/** 说明与 lib/llm/prompts.ts#formatDecisions 的上限一致 */
const MAX_NOTE_LENGTH = 500;
/** 回答的上限，与 lib/review/questions.ts 保持一致 */
const MAX_ANSWER_LENGTH = 500;

/**
 * 解析用户在导入界面当场做出的裁决。
 *
 * **逐条过滤而不是整体拒绝**：格式不对的那一条按「未裁决」处理，它会以 pending
 * 身份进体检队列，用户在那里还能再裁一次。整批拒绝是不可接受的代价 —— 用户
 * 已经在这份草稿上改了半天，不能因为一个下标越界就让他白做。
 */
function parseDecisions(raw: unknown): IngestDecision[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const out: IngestDecision[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { index, decision, note, answer, choiceId } = entry as Record<string, unknown>;

    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) continue;

    // 裁决与回答是两件独立的事：用户可以只回答不裁决（那条会落成 answered
    // 等模型处理），也可以只裁决不回答。两者都有时裁决优先 —— 它是终态。
    const verdict =
      decision === "accepted" || decision === "dismissed" ? decision : undefined;
    const trimmedAnswer = typeof answer === "string" ? answer.trim() : "";
    if (!verdict && !trimmedAnswer) continue;

    const trimmedNote = typeof note === "string" ? note.trim() : "";
    out.push({
      index,
      decision: verdict,
      note: trimmedNote ? trimmedNote.slice(0, MAX_NOTE_LENGTH) : undefined,
      answer: trimmedAnswer ? trimmedAnswer.slice(0, MAX_ANSWER_LENGTH) : undefined,
      choiceId: typeof choiceId === "string" && choiceId ? choiceId : undefined,
    });
  }

  return out.length > 0 ? out : undefined;
}

/**
 * 把审阅通过的草稿写入知识库。
 *
 * 请求体是用户在审阅界面编辑后的完整草稿 —— 前端改了什么，落盘的就是什么。
 * 服务端不"帮用户决定"，只做两件事：校验结构、事务性落盘。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("请求体不是合法的 JSON。", 400);
  }

  const staged = loadIngestDraft<IngestDraft>(id);
  if (!staged) {
    return fail("找不到这次导入的草稿，可能已经被提交或放弃了。", 404);
  }

  const parsed = z.object({ draft: DraftSchema, reviewRevision: z.number().int().nonnegative().optional(), overrides: z.object({ sourceTitle: z.string().max(120).optional(), skippedTitles: z.array(z.string().max(120)).max(1000).optional() }).optional(), decisions: z.unknown().optional() }).safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(`草稿结构不合法：${first?.path.join(".") ?? ""} — ${first?.message ?? ""}`, 400);
  }

  try {
    const result = await withCommitOperation(`导入《${staged.source.originalName}》`, () => commitIngest({
      jobId: id,
      draft: parsed.data.draft,
      reviewRevision: parsed.data.reviewRevision,
      overrides: parsed.data.overrides,
      decisions: parseDecisions(parsed.data.decisions),
    }));
    removeQueuedIngestForJob(id);
    return ok(result);
  } catch (error) {
    const { message, status } = toUserMessage(error);
    return fail(message, status);
  }
}
