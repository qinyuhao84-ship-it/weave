import { NextRequest } from "next/server";
import { handle, fail, readJsonObject } from "@/lib/api";
import {
  getSession,
  getTrashedSession,
  getMessages,
  getActiveChatRun,
  renameSession,
  trashSession,
  permanentlyDeleteSession,
  saveSessionConfig,
} from "@/lib/chat/sessions";
import { sessionContextUsage } from "@/lib/chat/context";
import { isStreaming } from "@/lib/chat/streams";
import { ChatConfigSchema } from "@/lib/chat/config";
import { resolveChatConfig } from "@/lib/chat/config-server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    const session = getSession(id);
    if (!session) return fail("找不到这个对话。", 404);
    // context 一并给出：头部那个占用指示器在页面打开时就要有数，
    // 不能等到用户再问一句才出现
    return {
      session,
      messages: getMessages(id),
      context: sessionContextUsage(id),
      activeRun: getActiveChatRun(id),
    };
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(async () => {
    const body = z.object({ title: z.string().optional(), config: ChatConfigSchema.optional() }).strict().parse(await readJsonObject(request));
    if (!getSession(id)) return fail("找不到这个对话。", 404);
    if (body.config) {
      if (isStreaming(id)) return fail("请等当前回答完成后再切换配置。", 409);
      saveSessionConfig(id, resolveChatConfig(body.config));
    }
    if (body.title === undefined && body.config) return { session: getSession(id) };
    if (typeof body.title !== "string" || !body.title.trim()) return fail("标题不能为空。", 400);
    if (body.title.trim().length > 60) return fail("对话标题不能超过 60 个字符。", 400);
    if (!getSession(id)) return fail("找不到这个对话。", 404);
    renameSession(id, body.title);
    return { session: getSession(id) };
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    if (isStreaming(id)) return fail("这段对话正在生成，请先停止生成再删除。", 409);

    const permanently = new URL(request.url).searchParams.get("permanent") === "1";
    if (permanently) {
      if (!getTrashedSession(id)) return fail("回收站里找不到这段对话。", 404);
      permanentlyDeleteSession(id);
      return { deleted: true, permanent: true };
    }

    if (!getSession(id)) return fail("找不到这个对话。", 404);
    trashSession(id);
    return { deleted: true, permanent: false };
  });
}
