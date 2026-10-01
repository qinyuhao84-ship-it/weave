import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: { ...(process.env.WEAVE_E2E_BROWSER_CHANNEL ? { channel: process.env.WEAVE_E2E_BROWSER_CHANNEL } : {}), baseURL: 'http://127.0.0.1:3300', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: { command: 'node scripts/e2e-server.mjs', url: 'http://127.0.0.1:3300/api/vault', reuseExistingServer: false, timeout: 60_000 },
});
