import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api";
import { startIngest } from "@/lib/ingest/pipeline";
import { canImport } from "@/lib/ingest/parse/router";
import { isLlmConfigured } from "@/lib/settings";
import { ensureVaultLayout } from "@/lib/vault/paths";

/** 一次最多接收的文件大小：200MB。本机单用户，不做分片上传。 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export const runtime = "nodejs";
/** 上传本身要快，实际解析跑在后台任务里 */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  ensureVaultLayout();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("没有收到文件。请选择要导入的资料。", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail("没有收到文件。请选择要导入的资料。", 400);
  }

  if (file.size === 0) return fail("文件是空的。", 400);
  if (file.size > MAX_FILE_BYTES) {
    return fail(`文件太大了（${(file.size / 1024 / 1024).toFixed(0)}MB）。上限是 200MB。`, 413);
  }

  // 格式能不能处理，在上传阶段就告诉用户，别等解析到一半才失败
  const check = await canImport(file.name);
  if (!check.ok) {
    return fail(check.reason!, 415, { installHint: check.reason?.includes("docling") });
  }

  if (!isLlmConfigured()) {
    return fail(
      "模型服务暂不可用，这份资料还没有开始处理。请先在设置中配置你的模型，保存后重新处理。",
      412,
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { jobId } = startIngest({ fileName: file.name, buffer });

  return ok({ jobId, fileName: file.name, byteSize: file.size });
}
