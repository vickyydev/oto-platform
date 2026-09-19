import { defineConfig } from '@playwright/test';

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
  retries: process.env.SMOKE_BASE_URL ? 1 : 0,
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? `http://localhost:${process.env.POS_PORT ?? 25741}`,
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1024 },
    // A deployment is across the sea from here; the dev server is not.
    actionTimeout: process.env.SMOKE_BASE_URL ? 20_000 : 10_000,
  },
});
