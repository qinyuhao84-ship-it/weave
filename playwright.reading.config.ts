import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/reading-e2e",
  workers: 1,
  timeout: 90_000,
  use: { baseURL: "http://127.0.0.1:3350", trace: "retain-on-failure" },
  outputDir: "test-results/reading-pages",
  reporter: "list",
  webServer: { command: "pnpm exec tsx scripts/reading-e2e-server.mts", url: "http://127.0.0.1:3350/api/vault", reuseExistingServer: false, timeout: 60_000 },
});
