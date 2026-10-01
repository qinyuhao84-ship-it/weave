import { NextRequest } from "next/server";
import { fail, handle, intParam, readJsonObject } from "@/lib/api";
import { listSessions, countSessions, listTrashedSessions, createSession } from "@/lib/chat/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(() => {
    const params = new URL(request.url).searchParams;
    const trash = params.get("trash") === "1";
    if (trash) return { sessions: listTrashedSessions() };
    const limit = intParam(params.get("limit"), 100, 1, 100);
    const offset = intParam(params.get("offset"), 0, 0, 1_000_000);
    const query = (params.get("q") ?? "").slice(0, 200);
    return { sessions: listSessions(limit, offset, query), total: countSessions(query), limit, offset };
  });
}

export async function POST(request: NextRequest) {
  return handle(async () => {
    const body = (await readJsonObject(request)) as { title?: unknown };
    if (!body || typeof body !== "object" || (body.title !== undefined && typeof body.title !== "string")) return fail("对话标题格式不正确。", 400);
    if (typeof body.title === "string" && body.title.length > 60) return fail("对话标题不能超过 60 个字符。", 400);
    return { sessionId: createSession((body.title as string | undefined) ?? "新对话") };
  });
}
