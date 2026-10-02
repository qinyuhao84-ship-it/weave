import { eq, or, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, fail, toUserMessage } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { pages, links } from "@/lib/db/schema";
import { loadPageFile, updatePage, deletePage, type DeleteStrategy } from "@/lib/vault/service";
import { sha256 } from "@/lib/vault/atomic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 词条详情：正文 + 元信息 + 反向链接 + 出链 + 内容哈希（供乐观并发控制） */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(() => {
    const file = loadPageFile(id);
    const db = getDb();

    const allLinks = db.select().from(links).where(or(eq(links.srcPageId, id), eq(links.dstPageId, id))).all();
    const outgoing = allLinks.filter((l) => l.srcPageId === id);
    const incoming = allLinks.filter((l) => l.dstPageId === id);

    const relatedIds = [...new Set(allLinks.flatMap(link => [link.srcPageId, link.dstPageId]).filter((pageId): pageId is string => Boolean(pageId)))];
    const titleById = new Map(relatedIds.length
      ? db.select({ id: pages.id, title: pages.title }).from(pages).where(inArray(pages.id, relatedIds)).all().map(page => [page.id, page.title])
      : []);

    return {
      id: file.pageId,
      title: file.data.title,
      type: file.data.type,
      // slug 与磁盘相对路径刻意不返回：界面没有任何地方该显示它们 ——
      // 用户要的是「这个词条讲了什么」，不是「它落在磁盘的哪个文件里」。
      // 按不变式 6 的口径，不返回才是消除病因，前端不显示只是消除症状。
      aliases: file.data.aliases,
      tags: file.data.tags,
      sources: file.data.sources,
      confidence: file.data.confidence,
      created: file.data.created,
      updated: file.data.updated,
      content: file.content,
      /** 前端编辑时带着它提交，服务端据此检测外部改动 */
      // 与返回正文来自同一份读取快照，避免外部编辑恰好发生在两次读盘之间时，
      // 把新文件的哈希配给旧正文，导致下一次保存绕过并发冲突检查。
      contentHash: sha256(file.raw),
      backlinks: incoming
        .filter((l) => l.dstPageId)
        .map((l) => ({
          pageId: l.srcPageId,
          title: titleById.get(l.srcPageId) ?? "（已删除）",
          occurrences: l.occurrences,
        })),
      outgoing: outgoing.map((l) => ({
        raw: l.dstRaw,
        resolved: Boolean(l.dstPageId),
        pageId: l.dstPageId,
        title: l.dstPageId ? (titleById.get(l.dstPageId) ?? null) : null,
      })),
    };
  });
}

/** 编辑词条。带上 contentHash 时启用乐观并发控制。 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(async () => {
    const body = await request.json().catch(() => null);
    const parsed = z.object({
      content: z.string().optional(),
      title: z.string().trim().min(1).max(120).optional(),
      aliases: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
      tags: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
      confidence: z.enum(["high", "medium", "low"]).optional(),
      expectedHash: z.string().regex(/^[a-f\d]{64}$/i).optional(),
    }).strict().safeParse(body);
    if (!parsed.success) return fail("编辑内容不合法，请检查标题、别名、标签和版本信息。", 400);

    const input = parsed.data;
    if (input.content === undefined && input.title === undefined &&
        input.aliases === undefined && input.tags === undefined && input.confidence === undefined) {
      return fail("请至少提供一项要修改的内容。", 400);
    }

    const result = updatePage(id, {
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.expectedHash ? { expectedHash: input.expectedHash } : {}),
    });

    return result;
  });
}

/**
 * 删除词条。
 *
 * 必须显式指定引用处理策略 —— 这是刻意的：业界教训是「删除的语义」
 * 如果不明确，就会静默产生死链（Obsidian 官方就是留残骸，需要额外插件补救）。
 * 三个选项：清理引用降级为纯文本 / 重定向到另一词条 / 保留死链待巡检处理。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(async () => {
    const body = await request.json().catch(() => null);
    const parsed = z.object({
      strategy: z.enum(["keep_dangling", "clean_refs", "redirect"]),
      targetPageId: z.string().min(1).optional(),
      expectedHash: z.string().regex(/^[a-f\d]{64}$/i).optional(),
    }).strict().safeParse(body);
    if (!parsed.success) return fail("请明确选择如何处理词条引用。", 400);

    const { strategy: kind, targetPageId, expectedHash } = parsed.data;
    let strategy: DeleteStrategy;
    if (kind === "redirect") {
      if (!targetPageId) {
        return fail("重定向删除需要指定目标词条。", 400);
      }
      if (targetPageId === id) return fail("不能把词条重定向到它自己。", 400);
      strategy = { kind: "redirect", targetPageId };
    } else if (kind === "clean_refs") {
      strategy = { kind: "clean_refs" };
    } else {
      strategy = { kind: "keep_dangling" };
    }

    try {
      return deletePage(id, strategy, expectedHash);
    } catch (error) {
      const { message, status } = toUserMessage(error);
      return fail(message, status);
    }
  });
}
