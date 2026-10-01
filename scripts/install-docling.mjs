import { spawn } from "node:child_process";

const processHandle = spawn("uv", [
  "tool", "install", "--force", "docling-serve[rapidocr]==1.35.0",
  "--with", "docling-slim[standard]==2.130.0",
], {
  stdio: "inherit",
  env: { ...process.env, UV_HTTP_TIMEOUT: "300", UV_HTTP_RETRIES: "8" },
});

processHandle.once("error", (error) => {
  console.error(`无法运行 uv：${error.message}`);
  process.exitCode = 1;
});
processHandle.once("close", (code) => {
  process.exitCode = code ?? 1;
});
