import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // 串行执行：测试共享 process.env.WEAVE_VAULT 这一个全局状态
    fileParallelism: false,
    // 默认 5000ms 对 tests/ingest.test.ts 那条「同一份文件导入两次」的用例余量太小：
    // 它要做两轮完整 ingest（分析 + 草稿 + commit + 查重），实测通过时约 2.5s、
    // 机器忙时到 5.4s，于是绿灯与否取决于当时负载 —— 门禁必须确定性通过。
    //
    // 上调到 40s：这个仓库现在会出现**两个会话并发跑 vitest** 的情形（同一个
    // 仓库的两个 worktree、同一台机器的 CPU）。此时同一条用例实测在 8.5s 与
    // 23.5s 之间摆动 —— 20s 的余量已经盖不住长尾，绿灯重新变成看运气。
    // 代价是真正挂掉的用例要多等一会儿才报错；比「绿灯取决于当时谁在跑测试」小。
    testTimeout: 40000,
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
});
