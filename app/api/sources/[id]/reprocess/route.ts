import fs from "node:fs";
import { NextRequest } from "next/server";
import { handle, fail } from "@/lib/api";
import { hasUnfinishedIngestDraft, startIngest } from "@/lib/ingest/pipeline";
import { getSource, resolveSourceFile } from "@/lib/ingest/source-files";
import { canImport } from "@/lib/ingest/parse/router";
import { isLlmConfigured } from "@/lib/settings";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(async () => {
    const source = getSource(id);
    if (!source) return fail("找不到这份原始资料。", 404);
    if (source.status === "parsing") return fail("这份资料正在处理中，请等当前任务结束。", 409);
    if (source.status === "awaiting_review" || hasUnfinishedIngestDraft(source.id)) {
      return fail("这份资料已有草稿等待处理，请先提交、放弃或解决现有草稿。", 409);
    }
    if (!isLlmConfigured()) {
      return fail("模型服务暂不可用。资料没有开始处理；请在设置中检查模型地址、名称及凭据，保存后重试。", 412);
    }
    const capability = await canImport(source.originalName);
    if (!capability.ok) return fail(capability.reason ?? "当前暂时无法处理这种格式。", 415);
    const filePath = resolveSourceFile(source, "raw");
    if (!filePath) return fail("原件当前不可读取，无法重新处理。", 404);

    const { jobId } = startIngest({
      fileName: source.originalName,
      buffer: fs.readFileSync(filePath),
      reprocessSourceId: source.id,
    });
    return { jobId, sourceId: source.id };
  });
}
