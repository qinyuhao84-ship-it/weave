import { execFile } from "node:child_process";
import { promisify } from "node:util";
const runFile = promisify(execFile);
import path from "node:path";
import { NextRequest } from "next/server";
import { fail, handle, readJsonObject } from "@/lib/api";
import { VAULT_ROOT } from "@/lib/vault/paths";
import { isVaultPathOverridden, requestVaultMove } from "@/lib/vault/location";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open the current vault in Finder or queue a verified move to a chosen parent folder. */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const body = (await readJsonObject(request)) as { action?: unknown };
    if (body.action === "open") {
      if (process.platform !== "darwin") return fail("打开文件夹目前仅支持 macOS，请根据设置中的路径手动打开。", 412);
      await runFile("open", [VAULT_ROOT]);
      return { opened: true };
    }

    if (body.action !== "choose") return fail("不支持的知识库位置操作。", 400);
    if (isVaultPathOverridden()) return fail("WEAVE_VAULT 环境变量指定了知识库位置，不能在设置中修改。", 409);
    if (process.platform !== "darwin") return fail("选择文件夹目前仅支持 macOS，请通过 WEAVE_VAULT 配置位置。", 412);

    let selected: string;
    try {
      selected = (await runFile(
        "osascript",
        ["-e", 'POSIX path of (choose folder with prompt "选择知识库存放位置，将在其中创建‘织识’文件夹")'],
        { encoding: "utf8" },
      )).stdout.trim();
    } catch (error) {
      const details = error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : "";
      if (details.includes("User canceled") || details.includes("-128")) return { cancelled: true };
      throw new Error(`无法打开文件夹选择器：${details.trim() || String(error)}`);
    }

    if (!selected) return { cancelled: true };
    const target = path.join(path.resolve(selected), "织识");
    if (path.resolve(target) === path.resolve(VAULT_ROOT)) return { pendingRoot: null, unchanged: true };
    let pending: { from: string; to: string };
    try {
      pending = requestVaultMove(VAULT_ROOT, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : "目标位置不可用。";
      if (message.startsWith("已有一个") || message.startsWith("新位置不能") || message.startsWith("目标知识库目录")) {
        return fail(message, 409);
      }
      throw error;
    }
    return { pendingRoot: pending.to, restartRequired: true };
  });
}
