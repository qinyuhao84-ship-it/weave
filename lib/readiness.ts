import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { VAULT_ROOT, ensureVaultLayout } from "@/lib/vault/paths";
import { getActiveProvider, isLlmConfigured } from "@/lib/settings";
import { checkDocling } from "@/lib/ingest/parse/docling";
import { listProviderModels } from "@/lib/llm/models";
import { LlmError } from "@/lib/llm/types";

export type ReadinessCheck = { name: string; status: "ok" | "warning" | "error"; detail: string };
export async function checkReadiness(probeModel = false): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  try {
    ensureVaultLayout();
    const probe = path.join(VAULT_ROOT, `.weave-write-check-${randomUUID()}`);
    fs.writeFileSync(probe, "", { flag: "wx" });
    fs.unlinkSync(probe);
    checks.push({ name: "知识库权限", status: "ok", detail: "当前目录可以创建和删除文件。" });
  } catch { checks.push({ name: "知识库权限", status: "error", detail: "无法写入知识库，请检查目录权限、剩余空间与 WEAVE_VAULT 配置。" }); }
  try {
    execFileSync("git", ["--version"], { timeout: 5000, stdio: "ignore" });
    checks.push({ name: "本地备份", status: "ok", detail: "Git 可用。" });
  } catch { checks.push({ name: "本地备份", status: "error", detail: "Git 不可用，请安装 Git 后重启服务。" }); }
  const docling = await checkDocling(probeModel);
  checks.push({ name: "文档解析", status: docling.available ? "ok" : "warning", detail: docling.available ? "Docling 可用，可处理 PDF、PPT 与 OCR。" : "基础文本和 Office 解析可用；高质量 PDF、PPT 与 OCR 需运行 pnpm docling:install 后重启。" });
  if (!isLlmConfigured()) {
    checks.push({ name: "模型服务", status: "error", detail: "请在设置的“模型服务”中填写 API 地址、模型名和所需密钥，保存后检查连接。也可通过 .env.local 配置并重启。" });
  } else if (!probeModel) {
    checks.push({ name: "模型服务", status: "warning", detail: "模型配置已存在，点击检查以验证端点和凭据。" });
  } else {
    const provider = getActiveProvider()!;
    try {
      const result = await listProviderModels(provider);
      if (!result.supported) checks.push({ name: "模型服务", status: "warning", detail: "端点可达，但不支持模型列表检查。请通过一条测试问答验证生成能力。" });
      else {
        const present = result.models.includes(provider.model);
        checks.push({ name: "模型服务", status: present ? "ok" : "warning", detail: present ? "端点和凭据有效，已找到配置的模型；生成质量仍需测试问答验证。" : "端点和凭据有效，但列表未确认配置的模型。请检查模型名并进行测试问答。" });
      }
    } catch (error) { checks.push({ name: "模型服务", status: "error", detail: error instanceof LlmError ? error.message : "连接失败或超时，请检查服务地址、网络与代理配置。" }); }
  }
  return checks;
}
