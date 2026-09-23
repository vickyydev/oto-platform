import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Console smoke flows (CLAUDE.md §8 Testing), in the same shape as the POS's
 * `apps/pos/playwright.config.ts`: a config beside the app, an `e2e/` folder of
 * specs, and a package script that runs them.
 *
 * WHAT IS DIFFERENT, AND WHY. The POS's config points at a stack somebody has
 * already brought up with `pnpm dev`, so the database behind it is whatever
 * that person last did to it. The Console's cases read seeded rows and queue a
 * command at a box — "Booth 1 has had 0 spins today", "both parks are listed",
 * "the test print succeeded" — and every one of those readings is a claim about
 * a database in a known state. So this harness brings its OWN: `e2e/run.mjs`
 * creates a database per run, migrates and seeds it, and hands this config the
 * connection string and two free ports. The servers below are then started by
 * Playwright against that database and torn down with the run.
 *
 * Which is why the three variables are required rather than defaulted. A
 * default would silently point the run at the dev stack on :3001, queue a test
 * print at whatever box is on it, and drop somebody's working database on the
 * way out.
 */
const databaseUrl = process.env.CONSOLE_E2E_DATABASE_URL;
const apiPort = process.env.CONSOLE_E2E_API_PORT;
const consolePort = process.env.CONSOLE_E2E_PORT;

if (!databaseUrl || !apiPort || !consolePort) {
  throw new Error(
    'The Console e2e run is started by its harness, which makes the database these flows read.\n' +
      'Run `pnpm --filter @oto/console e2e` (add `-- --headed`, `-- --debug`, or a spec path to narrow it).',
  );
}

const repoRoot = resolve(import.meta.dirname, '..', '..');

/**
 * WHICH BROWSER, without editing this file: `CONSOLE_E2E_BROWSER`.
 *
 *   msedge     (the default) Microsoft Edge, matching the POS's pin. It is the
 *              Chromium already installed on every Windows machine here, so a
 *              local run downloads nothing.
 *   chromium   Playwright's own bundled Chromium — set no channel at all and
 *              the bundled browser is what runs. This is what CI uses: the
 *              runners are ubuntu-latest, where Edge would mean adding
 *              Microsoft's package repository to the image, and Chromium is
 *              the browser `playwright install --with-deps` ships for Linux.
 *
 * Any other value is passed through as a channel name (`chrome`, `msedge-beta`
 * …) and Playwright resolves it to a browser installed on the machine.
 */
const browser = process.env.CONSOLE_E2E_BROWSER || 'msedge';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  /**
   * Nothing is retried. The point of this set is to say whether the Console
   * works, and a case that only passes on the second attempt has not said so —
   * it is the flake this harness exists to make visible.
   */
  retries: 0,
  /**
   * One worker, deliberately. The four cases share one seeded park, one virtual
   * box and one sign-in throttle (`AUTH_MAX_FAILURES`, counted per phone): the
   * refused-password case would otherwise be counted against a sign-in another
   * worker was making at the same moment, with the same account.
   */
  workers: 1,
  /**
   * `list` is what a person watching a run wants. On CI nobody is watching, and
   * the log of a red run is the one thing left to read it by — so there the
   * HTML report is written as well, with the failure screenshots and error
   * context in it, and the workflow uploads it as an artifact.
   */
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${consolePort}`,
    // `chromium` means the bundled build, which is the absence of a channel
    // rather than a channel named "chromium"; everything else names one.
    ...(browser === 'chromium' ? {} : { channel: browser }),
    headless: true,
    viewport: { width: 1440, height: 1024 },
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      /**
       * The api, with the edge role — that is what starts the virtual box
       * inside it (`apps/api/src/index.ts`), and without the box there is
       * nothing to take a queued test print and report back on it.
       */
      command: 'pnpm --filter @oto/api exec tsx src/index.ts',
      cwd: repoRoot,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        DATABASE_URL: databaseUrl,
        API_PORT: apiPort,
        PROCESS_ROLES: 'api,edge',
        DEPLOY_ENV: 'local',
        NODE_ENV: 'development',
        COOKIE_SECURE: 'false',
        // The box polls every five seconds and logs each one; at `info` the
        // run's output is that poll and nothing else.
        LOG_LEVEL: 'warn',
      },
    },
    {
      // The same dev server `pnpm dev` runs, on a port of this run's own, with
      // its `/api` proxy pointed at the api above.
      command: 'pnpm --filter @oto/console exec vite --config vite.config.ts',
      cwd: repoRoot,
      url: `http://127.0.0.1:${consolePort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { CONSOLE_PORT: consolePort, API_PORT: apiPort },
    },
  ],
});
