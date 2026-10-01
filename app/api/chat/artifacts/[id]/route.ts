import { NextResponse } from "next/server";
import { fail, handle } from "@/lib/api";
import { formatHtmlCitations, getArtifact, previewHtml } from "@/lib/chat/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(() => {
    const artifact = getArtifact(id);
    if (!artifact) return fail("文件不存在，或所属对话已移入回收站。", 404);
    const content = artifact.mediaType === "text/html" && artifact.status !== "incomplete" && artifact.citations !== undefined
      ? formatHtmlCitations(artifact.content, artifact.citations) : artifact.content;
    if (new URL(request.url).searchParams.get("download") === "1") {
      return new NextResponse(content, { headers: {
        "Content-Type": `${artifact.mediaType}; charset=utf-8`,
        "Content-Disposition": `attachment; filename="answer.${artifact.mediaType === "text/html" ? "html" : artifact.mediaType === "text/markdown" ? "md" : "txt"}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      } });
    }
    return { content: artifact.mediaType === "text/html" ? previewHtml(content) : content, mediaType: artifact.mediaType, status: artifact.status };
  });
}
