import base from '../../apps/pos/playwright.config.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerRoot = dirname(fileURLToPath(import.meta.url));
const runId = process.env.SNAPSHOT_VERIFICATION_RUN;
if (!runId || !/^[a-z0-9_-]+$/.test(runId)) throw new Error('A safe native run ID is required.');
export default {
  ...base,
  testDir: resolve(runnerRoot, '../../apps/pos/e2e'),
  testMatch: 'smoke.spec.ts',
  outputDir: resolve(runnerRoot, 'artifacts', runId),
  webServer: undefined,
  projects: undefined,
  globalSetup: undefined,
  globalTeardown: undefined,
  captureGitInfo: undefined,
  workers: 1,
  retries: 0,
  globalTimeout: 360_000,
  reporter: [[resolve(runnerRoot, 'safe-reporter.mjs')]],
  use: { ...base.use, screenshot: 'off', trace: 'off', video: 'off' },
};
