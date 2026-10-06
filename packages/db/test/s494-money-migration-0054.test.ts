import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-494 — a walk-in's tier claim with no document expiry (migration 0054),
 * against live databases built from the committed migrations.
 *
 *   - it builds from empty TWICE (two fresh databases), and a second `migrate`
 *     on a built one is a no-op;
 *   - 0054 is journal entry 54, after 0053 and later than it;
 *   - `pos.sale_tier_claim.evidence_expires_at` takes no date, and still takes one.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');

let first: { url: string; drop: () => Promise<void> };
let second: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  first = await createTestDatabase();
  second = await createTestDatabase();
  client = new pg.Client({ connectionString: first.url });
  await client.connect();
}, 300_000);

afterAll(async () => {
  await client?.end();
  await first?.drop();
  await second?.drop();
  await stopTestServer();
});

async function one<T = string>(text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query(text, values);
  return Object.values(rows[0] as Record<string, unknown>)[0] as T;
}

async function counter(): Promise<{ operatorId: string; branchId: string; accountId: string }> {
  const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'Claim Op') returning id`);
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Claim Park', 'tc-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const accountId = await one(
    `insert into core.account (id, operator_id, phone, status)
     values (gen_random_uuid(), $1, '+6683' || lpad(floor(random() * 10000000)::text, 7, '0'), 'active') returning id`,
    [operatorId],
  );
  return { operatorId, branchId, accountId };
}

const claim = (
  c: { operatorId: string; branchId: string; accountId: string },
  actionId: string,
  expiresOn: string | null,
) =>
  one<string | null>(
    `insert into pos.sale_tier_claim (id, operator_id, branch_id, account_id, action_id, to_tier, evidence_type, evidence_expires_at)
     values (gen_random_uuid(), $1, $2, $3, $4, 'expat', 'Passport', $5)
     returning evidence_expires_at::text`,
    [c.operatorId, c.branchId, c.accountId, actionId, expiresOn],
  );

describe('migration 0054 — a tier claim with no document expiry', () => {
  it('is journal entry 54, after 0053 and later than it', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const e53 = journal.entries.find((e) => e.idx === 53)!;
    const e54 = journal.entries.find((e) => e.idx === 54)!;
    expect(e53.tag).toBe('0053_band_gate_access');
    expect(e54.tag).toBe('0054_sale_tier_claim_expiry_optional');
    expect(e54.when).toBeGreaterThan(e53.when);
    expect(journal.entries.indexOf(e54)).toBe(journal.entries.indexOf(e53) + 1);
    // Every entry later than the one before it, whatever comes after 0054.
    for (let i = 1; i < journal.entries.length; i += 1) {
      expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    }
  });

  it('builds from empty twice, and migrating a built database again is a no-op', async () => {
    const other = new pg.Client({ connectionString: second.url });
    await other.connect();
    try {
      const { rows } = await other.query(
        `select is_nullable from information_schema.columns
          where table_schema = 'pos' and table_name = 'sale_tier_claim' and column_name = 'evidence_expires_at'`,
      );
      expect(rows[0].is_nullable).toBe('YES');
    } finally {
      await other.end();
    }
    expect(() =>
      execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
        cwd: PKG,
        env: { ...process.env, DATABASE_URL: first.url },
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('records a claim with no expiry date, and one with a date as before', async () => {
    const c = await counter();
    expect(await claim(c, 'no-expiry', null)).toBeNull();
    expect(await claim(c, 'dated', '2030-01-01')).toBe('2030-01-01');
  });
});
