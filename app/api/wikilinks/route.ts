import { handle } from "@/lib/api";
import { buildWikilinkTable } from "@/lib/index/wikilink-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 双链解析表，供前端把正文里的 [[X]] 渲染成可点击的胶囊。
 *
 * 为什么服务端出这张表而不是前端自己拼：优先级规则（title > slug > alias）
 * 与重定向跟随只应该有一份实现，见 lib/index/wikilink-table.ts。
 * 键已经归一化过，前端拿到后只需把待解析的名字同样归一化再查表。
 */
export async function GET() {
  return handle(() => ({ table: buildWikilinkTable() }));
}
