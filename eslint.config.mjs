import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**", "out/**", "build/**", "next-env.d.ts",
    ".claude/**", ".codex/**", ".pnpm-store/**", "docs/audits/**",
    "test-results/**", "playwright-report/**",
  ]),
  {
    rules: {
      // 网络请求、草稿恢复和本机偏好需要在 effect 中同步状态；保留其余 Hooks 检查。
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
]);
