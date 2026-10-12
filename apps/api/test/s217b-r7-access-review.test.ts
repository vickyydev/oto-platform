import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * SCRUM-191 round 7 administration, driven as another park group and with
 * replays of body IDs. Passing pins preserve the owner's own actions.
 * FINDING 1 (high): labelField=password exposed hashes through options.
 * Prescribed fix: refuse credential label fields; ordinary options stay open.
 * FINDING 2 (medium): a shared role's branch replacement removed another
 * park group's assignment. Prescribed fix: replace only caller-owned branches.
 * FINDING 3 (medium): Data Admin created unplaced logins in a multi-group
 * database. Prescribed fix: insert the user and its own access row together.
 * FINDING 4 (high): a router-wide voucher notice caught unrelated API writes.
 * Prescribed fix: mount the notice on the seven voucher write routes only.
 * Their pins start as it.fails and flip after the prescribed fixes pass.
 * FINDING 5 (medium): the employee presence custom key bypassed base lookup ownership.
 * Prescribed fix: scope the override and use its employee primary key for mutations.
 * FINDING 6 (medium): soft user/branch links need owner checks, including legacy partial updates.
 * Prescribed fix: validate effective links and supplied JSON branch arrays.
 * FINDING 7 (high): generic private file/platform aliases bypass their module writer.
 * Prescribed fix: preserve existing values and direct changed links to the module screen.
 * FINDING 8 (medium): camp mutations selected default park rather than caller/event.
 * Prescribed fix: resolve caller/kiosk tenant and event branch before all five writes.
 * Standing questions: historical unplaced identities Q56, anonymous auth
 * rate-limit ownership Q57; they receive explicit ownership notices.
 */
const app = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(app, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
let result: { results: Record<string, boolean>; failures: Record<string, string> };

describe.skipIf(!available)('round 7 administration review over real HTTP', () => {
  beforeAll(async () => {
    const database = await createTestDatabase();
    try {
      const migrated = spawnSync(process.execPath, [join(app, 'script', 'migrate.mjs')], {
        cwd: app,
        env: { ...process.env, DATABASE_URL: database.url },
        encoding: 'utf8',
        timeout: 180_000,
      });
      expect(migrated.status, migrated.stderr).toBe(0);
      const response = spawnSync(
        process.execPath,
        [join(app, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'tests/administration.check.ts'],
        {
          cwd: app,
          env: { ...process.env, DATABASE_URL: database.url },
          encoding: 'utf8',
          timeout: 300_000,
        },
      );
      expect(response.status, response.stderr).toBe(0);
      const payload = /ADMINISTRATION_RESULTS=(.+)/.exec(response.stdout);
      expect(payload, response.stdout).toBeTruthy();
      result = JSON.parse(payload![1]!);
    } finally {
      await database.drop();
    }
  }, 500_000);
  for (const module of [
    'people',
    'permissions',
    'forms',
    'vouchers',
    'userScopeDefaults',
    'userScopeDefaultsSingle',
    'standingArrangements',
    'presence',
    'camp',
    'softLinks',
    'privateReferences',
  ]) {
    it(module + ': own actions remain and foreign IDs are refused', () => {
      expect(result.results[module], result.failures[module]).toBe(true);
    });
  }
  it('FINDING 1+3 high/medium: scoped Data Admin counts, options, writes and created-login ownership', () => {
    expect(result.results.dataAdmin, result.failures.dataAdmin).toBe(true);
  });
  it('FINDING 2 medium: shared roles keep another park group branches through replacement and replay', () => {
    expect(result.results.roles, result.failures.roles).toBe(true);
  });
});

describe.skipIf(!available)('standing administration questions', () => {
  it.fails(
    'Q54 low: shared role metadata belongs only to its owner (default remains shared authoring/deactivation)',
    () => {
      expect(result.results.sharedRoleMetadataOwnerOnly).toBe(true);
    },
  );
  it.fails(
    'Q56 low: historical unplaced people are assigned a park group (default remains unplaced pending the owner)',
    () => {
      expect(result.results.legacyPlacement).toBe(true);
    },
  );
  it.fails(
    'Q57 low: anonymous rate-limit administration has an ownership link (default remains an explicit notice)',
    () => {
      expect(result.results.anonymousRateAdministration).toBe(true);
    },
  );
});

describe('administration scope inventory', () => {
  it('all registered models use the same scoped CRUD infrastructure', () => {
    const source = readFileSync(join(app, 'server', 'data-admin', 'admin.ts'), 'utf8');
    expect(source).toContain('rowScope(this.table, currentTenant())');
    expect(source).toContain('rowScope(relatedAdmin.table, currentTenant(), true)');
    expect(source).toMatch(/DataAdminScopeError\(\s*409/);
  });
});
