import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, fail } from "@/lib/api";
import { mergePages } from "@/lib/vault/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 合并两个重复词条。
 *
 * 语义（对齐 MediaWiki + Obsidian 两家范式）：旧名折叠进新词条的 aliases、
 * 指向旧名的引用改写成 [[新名|旧名]] 保留原显示名、旧词条转为墓碑并写重定向。
 * 合并会做传递闭包，不留双重跳转。
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const body = await request.json().catch(() => null);
    const hash = z.string().regex(/^[a-f\d]{64}$/i);
    const parsed = z.object({
      sourcePageId: z.string().min(1),
      targetPageId: z.string().min(1),
      mergedContent: z.string().optional(),
      title: z.string().trim().min(1).max(120).optional(),
      expectedHashes: z.object({
        source: hash.optional(),
        target: hash.optional(),
      }).strict().optional(),
    }).strict().safeParse(body);
    if (!parsed.success) return fail("合并参数不完整或格式不正确。", 400);

    const input = parsed.data;

    if (input.sourcePageId === input.targetPageId) {
      return fail("不能把词条合并到它自己。", 400);
    }

    return mergePages({
      sourcePageId: input.sourcePageId,
      targetPageId: input.targetPageId,
      ...(input.mergedContent !== undefined ? { mergedContent: input.mergedContent } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.expectedHashes ? { expectedHashes: input.expectedHashes } : {}),
    });
  });
}
