import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const databaseUrl = process.env.POS_E2E_DATABASE_URL;
const apiPort = process.env.POS_E2E_API_PORT;
const posPort = process.env.POS_E2E_PORT;
const isolated = Boolean(databaseUrl);
if (isolated && (!apiPort || !posPort || process.env.SMOKE_BASE_URL)) {
  throw new Error('The isolated till smoke needs its own ports and no SMOKE_BASE_URL');
}
const browser = process.env.POS_E2E_BROWSER || 'msedge';
const root = resolve(import.meta.dirname, '../..');

/**
 * Smoke flows (CLAUDE.md §8 Testing): a handful of end-to-end checks against
 * a running stack with a seeded database.
 *
 * `SMOKE_BASE_URL` points them at a deployment instead of the dev server
 * (S2-01c): on Render the POS is a static site that rewrites `/api/*` to the
 * api service, so the same flows exercise the real two-service topology —
 * cookie, rewrite and all — without a single change to the specs. Unset, it
 * runs against the local Vite proxy as before.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: isolated ? 0 : process.env.SMOKE_BASE_URL ? 1 : 0,
  workers: isolated ? 1 : undefined,
  reporter: [
    ['list'],
    ...(process.env.CI ? [['html', { open: 'never' }] as const] : []),
    ...(isolated ? [['./e2e/required-cases.ts'] as const] : []),
  ],
  use: {
    baseURL: isolated ? `http://127.0.0.1:${posPort}` : process.env.SMOKE_BASE_URL ?? `http://localhost:${process.env.POS_PORT ?? 25741}`,
    ...(browser === 'chromium' ? {} : { channel: browser }),
    headless: true,
    viewport: { width: 1440, height: 1024 },
    // A deployment is across the sea from here; the dev server is not.
    actionTimeout: process.env.SMOKE_BASE_URL ? 20_000 : 10_000,
  },
  webServer: isolated ? [
    {
      command: 'pnpm --filter @oto/api exec tsx src/index.ts', cwd: root,
      url: `http://127.0.0.1:${apiPort}/health`, reuseExistingServer: false,
      timeout: 120_000, stdout: 'ignore', stderr: 'pipe',
      env: {
        DATABASE_URL: databaseUrl!, API_PORT: apiPort!, PROCESS_ROLES: 'api,edge',
        DEPLOY_ENV: 'local', NODE_ENV: 'development', COOKIE_SECURE: 'false', LOG_LEVEL: 'warn',
      },
    },
    {
      command: process.env.POS_E2E_BUILT === '1'
        ? 'pnpm --filter @oto/pos exec vite preview --config vite.config.ts'
        : 'pnpm --filter @oto/pos exec vite --config vite.config.ts',
      cwd: root, url: `http://127.0.0.1:${posPort}/`, reuseExistingServer: false,
      timeout: 120_000, stdout: 'ignore', stderr: 'pipe',
      env: { POS_PORT: posPort!, API_PORT: apiPort! },
    },
  ] : undefined,
});
