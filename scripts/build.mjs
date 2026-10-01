import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// 构建可能执行 instrumentation；始终隔离，不能迁移或修改用户知识库。
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weave-build-"));
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    WEAVE_VAULT: path.join(temporary, "vault"),
    WEAVE_CONFIG_DIR: path.join(temporary, "config"),
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
const stop = signal => child.kill(signal);
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("error", error => { console.error("构建启动失败：", error.message); process.exitCode = 1; });
child.once("close", (code, signal) => {
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exitCode = code ?? (signal ? 1 : 0);
});
