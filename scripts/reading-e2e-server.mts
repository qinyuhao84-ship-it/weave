import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const output = path.resolve(process.env.WEAVE_READING_EVIDENCE_DIR || "docs/evidence/reading-pages-2026-10-03");
const manifest = JSON.parse(fs.readFileSync(path.join(output, "generation.json"), "utf8")) as { source: string; cases: Array<{ name: string; question: string }> };
assert.equal(manifest.source, "real-model", "浏览器验收必须使用真实模型生成的文件。");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weave-reading-browser-"));
process.env.WEAVE_VAULT = path.join(temporary, "vault");
process.env.WEAVE_CONFIG_DIR = path.join(temporary, "config");
const { closeDb } = await import("../lib/db/client");
try {
  const { createSession, appendMessage } = await import("../lib/chat/sessions");
  const { saveArtifact } = await import("../lib/chat/artifacts");
  const samples = [];
  for (const entry of manifest.cases) {
    const sessionId = createSession(entry.question);
    appendMessage({ sessionId, role: "user", content: entry.question });
    const messageId = appendMessage({ sessionId, role: "assistant", content: fs.readFileSync(path.join(output, `${entry.name}.md`), "utf8") });
    const artifact = saveArtifact({ messageId, content: fs.readFileSync(path.join(output, `${entry.name}.html`), "utf8"), status: "ready" });
    samples.push({ name: entry.name, sessionId, artifactId: artifact.id });
  }
  const basicSession = createSession("基础阅读版");
  const basicMessage = appendMessage({ sessionId: basicSession, role: "assistant", content: "矩形面积等于长度乘以宽度。" });
  const { basicHtml } = await import("../lib/chat/artifacts");
  const basic = saveArtifact({ messageId: basicMessage, content: basicHtml("矩形面积等于长度乘以宽度。"), status: "basic" });
  samples.push({ name: "basic", sessionId: basicSession, artifactId: basic.id });
  fs.writeFileSync(path.join(output, "browser-sessions.json"), JSON.stringify(samples, null, 2) + "\n");
  closeDb();
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "-p", "3350"], { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const [code] = await once(child, "exit");
  process.exitCode = typeof code === "number" ? code : 0;
} finally {
  closeDb();
  fs.rmSync(temporary, { recursive: true, force: true });
}
