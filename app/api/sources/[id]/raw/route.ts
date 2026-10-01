import fs from "node:fs";
import { Readable } from "node:stream";
import { fail } from "@/lib/api";
import { getSource, resolveSourceFile } from "@/lib/ingest/source-files";
import { previewHtml } from "@/lib/documents/html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const source = getSource(id);
  if (!source) return fail("找不到这份原始资料。", 404);
  const filePath = resolveSourceFile(source, "raw");
  if (!filePath) return fail("原件当前不可读取，文件可能已移动或不在资料目录内。", 404);

  const safeName = source.originalName.replace(/[\r\n"\\]/g, "_").slice(0, 180) || "source";
  const fallback = safeName.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(safeName).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const isPdf = /\.pdf$/i.test(source.originalName);
  const inlinePdf = isPdf && new URL(request.url).searchParams.get("view") === "1";
  const isHtml = /\.html?$/i.test(source.originalName) || source.mimeType === "text/html";
  if (isHtml && new URL(request.url).searchParams.get("view") === "1") {
    return new Response(previewHtml(fs.readFileSync(filePath, "utf8")), { headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
    } });
  }
  const contentType = isPdf
    ? "application/pdf"
    : typeof source.mimeType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(source.mimeType)
    ? source.mimeType
    : "application/octet-stream";
  const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${inlinePdf ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
