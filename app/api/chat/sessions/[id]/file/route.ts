import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, fail } from "@/lib/api";
import { getMessages, markFiled } from "@/lib/chat/sessions";
import { createPage, updatePage, loadPageFile } from "@/lib/vault/service";
import { truncate } from "@/lib/utils";
import { getSource } from "@/lib/ingest/source-files";

export const runtime = "nodejs";

/**
 * 把一条好的问答答案归档为新词条，或并入已有词条。
 *
 * 这是原始理念里明确写的复利机制：原文说 "good answers can be filed back
 * into the wiki as new pages"，让探索也产生积累 —— 问过的好问题不该
 * 随着对话窗口关闭而消失。
 *
 * 归档走的是正常的服务层写入，因此同样进 git、同样进索引、同样产生双链。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;
  return handle(async () => {
    const body = await request.json().catch(() => null);
    const parsed = z.object({
      messageId: z.string().trim().min(1).max(100),
      title: z.string().trim().min(1).max(120).optional(),
      targetPageId: z.string().trim().min(1).max(100).optional(),
      expectedHash: z.string().regex(/^[a-f\d]{64}$/i).optional(),
      content: z.string().max(1_000_000).optional(),
    }).strict().safeParse(body);
    if (!parsed.success) return fail("归档内容不完整或格式不正确。", 400);

    const input = parsed.data;
    if (input.targetPageId
      ? (!input.expectedHash || !input.content?.trim() || input.title !== undefined)
      : input.expectedHash !== undefined) {
      return fail("合并词条需要正文版本信息；新建词条不应包含版本信息。", 400);
    }

    const message = getMessages(sessionId).find((m) => m.id === input.messageId);
    if (!message) return fail("找不到这条回答。", 404);
    if (message.role !== "assistant") return fail("只能归档助手的回答。", 400);
    if (message.filedAsPageId) return fail("这条回答已经归档过了。", 409);

    const title = input.title || truncate(message.content.replace(/\[\s*ID\s*[:：]\s*\d+\s*\]/gi, ""), 40);
    if (!title) return fail("无法从回答里推断标题，请手动指定。", 400);

    // 归档时保留引用角标指向的来源信息，让归档后的词条仍然可溯源
    const citations = message.citations as { list?: Array<{ pageTitle: string; excerpt: string }> } | null;
    const sourceRefs = (citations?.list ?? []).flatMap((citation) => {
      const refs = (citation as { sourceRefs?: Array<{ sourceId?: string | null; page?: number | null; quote?: string | null }> }).sourceRefs ?? [];
      const originals = refs.flatMap((ref) => {
        if (!ref.sourceId) return [];
        const source = getSource(ref.sourceId);
        if (!source) return [];
        return [{ doc: source.docPath, ...(ref.page ? { page: ref.page } : {}), ...(ref.quote ? { quote: truncate(ref.quote, 200) } : {}) }];
      });
      return [
        { doc: `query://${sessionId}`, quote: truncate(citation.excerpt, 200) },
        ...originals,
      ];
    });
    const sources = [...new Map(sourceRefs.map((ref) => [`${ref.doc}:${ref.page ?? ""}:${ref.quote ?? ""}`, ref])).values()];

    if (input.targetPageId) {
      const file = loadPageFile(input.targetPageId);
      const mergedSources = [...new Map(
        [...file.data.sources, ...sources].map((ref) => [
          `${ref.doc}:${ref.page ?? ""}:${ref.quote ?? ""}`,
          ref,
        ]),
      ).values()];
      const result = updatePage(input.targetPageId, {
        content: input.content!,
        sources: mergedSources,
        expectedHash: input.expectedHash!,
      });
      markFiled(input.messageId, result.pageId);
      return { pageId: result.pageId, title: file.data.title, note: "已合并到词条。" };
    }

    const result = createPage({
      type: "query",
      title,
      content: input.content?.trim() || message.content,
      tags: ["问答归档"],
      sources,
      confidence: "medium",
    });
    markFiled(input.messageId, result.pageId);
    return { pageId: result.pageId, title, note: "已归档为词条，可以在知识库里继续编辑它。" };
  });
}
