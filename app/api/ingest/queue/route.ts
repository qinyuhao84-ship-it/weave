import { NextRequest } from "next/server";
import { fail, handle, ok } from "@/lib/api";
import { canImport } from "@/lib/ingest/parse/router";
import { listIngestQueue, stageIngestFile } from "@/lib/ingest/queue";
import { ensureVaultLayout } from "@/lib/vault/paths";

const MAX_FILE_BYTES = 200 * 1024 * 1024;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return handle(() => ({ items: listIngestQueue() }));
}

/** 逐份上传到 vault 内的暂存目录，写入完成后才显示为已排队。 */
export async function POST(request: NextRequest) {
  ensureVaultLayout();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("没有收到文件。请选择要导入的资料。", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return fail("没有收到文件。请选择要导入的资料。", 400);
  if (file.size === 0) return fail("文件是空的。", 400);
  if (file.size > MAX_FILE_BYTES) {
    return fail(`文件太大了（${(file.size / 1024 / 1024).toFixed(0)}MB）。上限是 200MB。`, 413);
  }

  const check = await canImport(file.name);
  if (!check.ok) return fail(check.reason ?? "不支持这个文件格式。", 415);

  const item = await stageIngestFile(file.name, Buffer.from(await file.arrayBuffer()));
  return ok(item);
}
