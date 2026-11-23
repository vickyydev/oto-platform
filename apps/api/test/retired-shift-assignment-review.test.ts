import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@oto/db/testing';
import { expect, it } from 'vitest';

const app = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const tsx = join(app, 'node_modules/tsx/dist/cli.mjs');

it.skipIf(!existsSync(tsx))(
  'a retired shift releases employees and casual workers while active overlaps still block',
  async () => {
    const { url, drop } = await createTestDatabase({ otoapp: true });
    try {
      const run = spawnSync(process.execPath, [tsx, 'tests/retired-shift-assignment.check.ts'], {
        cwd: app,
        encoding: 'utf8',
        timeout: 90_000,
        env: {
          ...process.env,
          DATABASE_URL: url,
          DB_SCHEMA: 'otoapp',
          APP_ENV: 'dev',
          OBJECT_STORAGE: 'local',
          STORAGE_ENV_PREFIX: 'test',
        },
      });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain(
        'Retired assignments, inclusive boundaries and touching shifts passed.',
      );
    } finally {
      await drop();
    }
  },
  180_000,
);
