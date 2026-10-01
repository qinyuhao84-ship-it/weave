import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { localNextArgs } from "./local-host.mjs";
import { loadLocalEnv } from "./env.mjs";

const mode = process.argv[2] === "start" ? "start" : "dev";
loadLocalEnv(mode);
process.env.NEXT_TELEMETRY_DISABLED ??= "1";
const nextArgs = process.argv.slice(3);
if (nextArgs[0] === "--") nextArgs.shift();
const safeNextArgs = localNextArgs(nextArgs);
const endpoint = process.env.DOCLING_ENDPOINT ?? "http://127.0.0.1:5001";
const sidecarAllowed = !process.env.DOCLING_ENDPOINT || isLoopback(endpoint);
let sidecar = null;
let next = null;

if (sidecarAllowed && !(await isHealthy(endpoint))) {
  const executable = resolveSidecar();
  sidecar = spawn(executable, ["run", "--host", "127.0.0.1", "--port", new URL(endpoint).port || "5001"], {
    stdio: "inherit",
    env: process.env,
  });
  sidecar.once("error", (error) => {
    console.warn(`[docling] 未能启动本地解析服务：${error.message}`);
    console.warn("[docling] 可运行 `pnpm docling:install` 安装，再重启应用。PDF 将暂时使用内置解析器。");
  });
  void reportHealth(endpoint, sidecar);
} else if (sidecarAllowed) {
  console.info("[docling] 本地解析服务已在运行，将复用现有进程。");
} else {
  console.info("[docling] 使用 DOCLING_ENDPOINT 指定的解析服务，不启动本地实例。");
}

next = spawn("pnpm", ["exec", "next", mode, ...safeNextArgs], {
  stdio: "inherit",
  env: process.env,
});

const stop = () => {
  if (next && next.exitCode === null) next.kill("SIGTERM");
  if (sidecar && sidecar.exitCode === null) sidecar.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

next.once("error", (error) => {
  console.error(`[next] 无法启动：${error.message}`);
  stop();
  process.exitCode = 1;
});
next.once("close", (code, signal) => {
  if (sidecar && sidecar.exitCode === null) sidecar.kill("SIGTERM");
  process.exitCode = code ?? (signal ? 1 : 0);
});

function resolveSidecar() {
  if (process.env.DOCLING_SERVE_BIN) return process.env.DOCLING_SERVE_BIN;
  const local = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "docling-serve.exe" : "docling-serve");
  return fs.existsSync(local) ? local : "docling-serve";
}

function isLoopback(value) {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

async function isHealthy(base) {
  try {
    const response = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function reportHealth(base, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000 && child.exitCode === null) {
    if (await isHealthy(base)) {
      console.info("[docling] 本地 PDF / PowerPoint 解析服务已就绪。");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (child.exitCode === null) {
    console.warn("[docling] 服务尚未就绪；首次启动可能需要稍等，应用仍可继续使用。");
    console.warn("[docling] 安装说明：`pnpm docling:install`。");
  }
}
