import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 每个测试文件在导入任何 lib 模块之前先跑这里。
 *
 * 为什么必须用 setupFiles 而不是在测试里设：lib/vault/paths.ts 在模块加载时
 * 就求值了 VAULT_ROOT，测试内部再设环境变量已经晚了。
 *
 * vitest 的 isolate + fileParallelism:false 保证每个测试文件拿到独立的模块
 * 注册表，所以这里创建的临时 vault 是文件级隔离的。
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weave-test-"));
process.env.WEAVE_VAULT = dir;
process.env.WEAVE_CONFIG_DIR = path.join(dir, "config");
// 单元测试不能探测作者已启动的 Docling 或继承真实模型配置。
process.env.DOCLING_ENDPOINT = "http://127.0.0.1:1";
for (const key of Object.keys(process.env)) if (key.startsWith("WEAVE_LLM_")) delete process.env[key];

process.on("exit", () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论
  }
});
