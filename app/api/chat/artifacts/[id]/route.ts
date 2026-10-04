import { NextResponse } from "next/server";
import { fail, handle, ok } from "@/lib/api";
import { formatHtmlCitations, getArtifact, previewHtml } from "@/lib/chat/artifacts";
import { HTML_PREVIEW_CSP } from "@/lib/documents/html";
import { retryAnswerArtifact } from "@/lib/chat/artifact-generation";
import { cancel, getJob } from "@/lib/jobs/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(() => {
    const artifact = getArtifact(id);
    if (!artifact) return fail("文件不存在，或所属对话已移入回收站。", 404);
    if (["pending", "failed", "cancelled"].includes(artifact.status)) {
      if (new URL(request.url).searchParams.has("download") || new URL(request.url).searchParams.has("preview")) return fail("交互页面尚未生成完成。", 409);
      return ok({ content: "", mediaType: artifact.mediaType, status: artifact.status, error: artifact.error });
    }
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
    const preview = artifact.mediaType === "text/html" ? previewHtml(content) : content;
    if (artifact.mediaType === "text/html" && new URL(request.url).searchParams.get("preview") === "1") {
      return new NextResponse(preview, { headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": HTML_PREVIEW_CSP,
      } });
    }
    const response = ok({ content: preview, mediaType: artifact.mediaType, status: artifact.status });
    response.headers.set("Content-Security-Policy", HTML_PREVIEW_CSP);
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(() => { retryAnswerArtifact(id); return { status: "pending" }; });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(() => {
    if (!getArtifact(id) || getJob(id)?.kind !== "chat_artifact") return fail("找不到这个交互页面任务。", 404);
    if (cancel(id) !== "cancelled") return fail("交互页面任务已经结束，请刷新状态。", 409);
    return { status: "cancelled" };
  });
}
