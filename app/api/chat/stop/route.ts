import { NextRequest } from "next/server";
import { fail, handle, readJsonObject } from "@/lib/api";
import { stopStream } from "@/lib/chat/streams";

export const runtime = "nodejs";

/**
 * 停止本轮回答的生成。
 *
 * 前端点「停止」时会同时中断它那一侧的 fetch（读流立即结束），但真正要停下的是
 * **服务端正在跑的模型请求** —— 不把它掐断，那一轮会继续生成到结束，
 * 白烧一份额度，而界面上看起来早就停了。所以这个接口是必须的，不是锦上添花。
 *
 * 已经生成的那部分不会丢：answer() 捕获中止后会把正文落库并标记 interrupted
 * （见 lib/chat/answer.ts），刷新页面后还在，只是标着「已停止生成」。
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    let body: { sessionId?: unknown };
    try {
      body = (await readJsonObject(request)) as { sessionId?: unknown };
    } catch {
      return fail("请求体不是合法的 JSON。", 400);
    }

    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) return fail("要停止哪一段对话？请带上会话 id。", 400);

    const stopped = stopStream(sessionId);
    return {
      stopped,
      // 如实说明，不谎报成功：没停到多半是因为生成刚好结束了
      note: stopped
        ? "已请求停止，已经生成的部分会保留下来。"
        : "这段对话当前没有正在生成的回答 —— 它可能刚好答完了。",
    };
  });
}
