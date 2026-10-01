import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

/** 与 Next 使用同一套 .env* 优先级，供 Next 启动前的脚本调用。 */
export function loadLocalEnv(mode) {
  process.env.NODE_ENV ??= mode === "dev" ? "development" : "production";
  loadEnvConfig(process.cwd(), mode === "dev", { info() {}, error: console.error });
}
