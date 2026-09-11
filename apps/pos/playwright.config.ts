import { defineConfig } from '@playwright/test';

/**
 * Smoke flows (CLAUDE.md §3 Testing): a handful of end-to-end checks against
 * the running dev stack (API :3001 + POS :25741 + seeded database).
 * Uses the system Edge channel — no browser download needed.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${process.env.POS_PORT ?? 25741}`,
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1024 },
  },
});
