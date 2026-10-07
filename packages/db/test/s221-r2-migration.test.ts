import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-21 (SCRUM-218) round 2 — the benefit QR's record, found by its tag
 * (`*_benefit_credentials`) rather than its number, which is provisional
 * (0069) until the lander renumbers it.
 *
 *   - forward-only and additive: the previous snapshot survives intact, the
 *     only new table is `promo.benefit_credential`, and the SQL drops,
 *     renames and retypes nothing;
 *   - every foreign key on it leads an index;
 *   - its CHECKs hold what the service relies on, and an employee or account
 *     with a QR on record cannot be deleted from under it.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');

interface Journal {
  entries: Array<{ idx: number; when: number; tag: string }>;
}
interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<string, Record<string, Record<string, unknown> | undefined>>;
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
) as Journal;
const entry = journal.entries.find((e) => e.tag.endsWith('_benefit_credentials'))!;
const previous = journal.entries[journal.entries.indexOf(entry) - 1]!;
const snapshotOf = (tag: string) =>
  JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8'),
  ) as Snapshot;
const SQL = readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), 'utf8');

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 300_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
  await stopTestServer();
});

async function sqlState(text: string, values: unknown[] = []): Promise<string | null> {
  await client.query('savepoint review');
  try {
    await client.query(text, values);
    await client.query('rollback to savepoint review');
    return null;
  } catch (err) {
    await client.query('rollback to savepoint review');
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('the benefit credential migration (SCRUM-218 round 2)', () => {
  it('is in the journal once, directly after the previous entry, later than it, on its snapshot', () => {
    expect(journal.entries.filter((e) => e.tag.endsWith('_benefit_credentials'))).toHaveLength(1);
    expect(entry.idx).toBe(previous.idx + 1);
    expect(entry.when).toBeGreaterThan(previous.when);
    expect(snapshotOf(entry.tag).prevId).toBe(snapshotOf(previous.tag).id);
  });

  it('is additive: the previous snapshot survives intact and only promo.benefit_credential is new', () => {
    const before = snapshotOf(previous.tag).tables;
    const after = snapshotOf(entry.tag).tables;
    const changed: string[] = [];
    for (const [name, table] of Object.entries(before)) {
      const now = after[name];
      if (!now) {
        changed.push(`table ${name} removed`);
        continue;
      }
      for (const part of [
        'columns',
        'indexes',
        'foreignKeys',
        'uniqueConstraints',
        'checkConstraints',
      ] as const) {
        for (const [k, v] of Object.entries(table[part] ?? {})) {
          if (JSON.stringify(now[part]?.[k]) !== JSON.stringify(v))
            changed.push(`${name} ${part} ${k}`);
        }
        for (const k of Object.keys(now[part] ?? {})) {
          if (!(k in (table[part] ?? {}))) changed.push(`${name} ${part} ${k} added`);
        }
      }
    }
    expect(changed).toEqual([]);
    expect(Object.keys(after).filter((t) => !before[t])).toEqual(['promo.benefit_credential']);
    const statements = SQL.split('--> statement-breakpoint')
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .replace(/ON (DELETE|UPDATE) (no action|restrict|cascade|set null)/gi, '')
          .trim(),
      )
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s, s).toMatch(
        /^(CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE "promo"\."benefit_credential" ADD CONSTRAINT)/,
      );
      expect(s, s).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT)\b|ALTER COLUMN/i);
    }
  });

  it('every foreign key on the new table leads an index', async () => {
    const { rows } = await client.query(`
      select c.conname,
             exists (
               select 1 from pg_index i
                where i.indrelid = c.conrelid
                  and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey
             ) as indexed
        from pg_constraint c
       where c.contype = 'f' and c.conrelid = 'promo.benefit_credential'::regclass`);
    expect(rows.length).toBe(4);
    expect(rows.filter((r: { indexed: boolean }) => !r.indexed)).toEqual([]);
  });

  it('holds its CHECKs, its one-code-one-row index, and keeps what it names from being deleted', async () => {
    await client.query('begin');
    try {
      const operator = '00000000-0000-7000-8000-0000000000a1';
      const emp = '00000000-0000-7000-8000-0000000000a2';
      const acct = '00000000-0000-7000-8000-0000000000a3';
      await client.query(`insert into core.operator (id, name) values ($1, 'Review')`, [operator]);
      await client.query(
        `insert into core.employee (id, operator_id, name) values ($1, $2, 'Review')`,
        [emp, operator],
      );
      await client.query(
        `insert into core.account (id, operator_id, phone, status) values ($1, $2, '+66999990001', 'active')`,
        [acct, operator],
      );
      const insert = (
        id: string,
        hash: string,
        over: {
          issued?: string;
          expires?: string;
          revoked?: string | null;
          revokedBy?: string | null;
          version?: number;
        } = {},
      ) =>
        sqlState(
          `insert into promo.benefit_credential
             (id, operator_id, employee_id, kid, version, code_hash, issued_by_account_id, issued_at, expires_at, revoked_at, revoked_by_account_id)
           values ($1, $2, $3, '0123456789abcdef', $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            operator,
            emp,
            over.version ?? 1,
            hash,
            acct,
            over.issued ?? '2026-10-07T00:00:00Z',
            over.expires ?? '2027-10-07T00:00:00Z',
            over.revoked ?? null,
            over.revokedBy ?? null,
          ],
        );
      // Expiring before it was issued, a version below one, and a revoker
      // with no revocation are each refused.
      expect(
        await insert('00000000-0000-7000-8000-0000000000b1', 'h1', {
          expires: '2026-10-06T00:00:00Z',
        }),
      ).toBe('23514');
      expect(await insert('00000000-0000-7000-8000-0000000000b2', 'h2', { version: 0 })).toBe(
        '23514',
      );
      expect(await insert('00000000-0000-7000-8000-0000000000b3', 'h3', { revokedBy: acct })).toBe(
        '23514',
      );
      expect(await insert('00000000-0000-7000-8000-0000000000b4', 'h4')).toBeNull();
      await client.query(
        `insert into promo.benefit_credential (id, operator_id, employee_id, kid, code_hash, issued_by_account_id, expires_at)
         values ('00000000-0000-7000-8000-0000000000b5', $1, $2, 'k', 'h5', $3, now() + interval '1 day')`,
        [operator, emp, acct],
      );
      // One printed code, one row.
      expect(await insert('00000000-0000-7000-8000-0000000000b6', 'h5')).toBe('23505');
      // A revoked row carries its revoker.
      expect(
        await insert('00000000-0000-7000-8000-0000000000b7', 'h7', {
          revoked: '2026-10-08T00:00:00Z',
          revokedBy: acct,
        }),
      ).toBeNull();
      // Nobody with a QR on record is deleted from under it.
      expect(await sqlState('delete from core.employee where id = $1', [emp])).toBe('23503');
      expect(await sqlState('delete from core.account where id = $1', [acct])).toBe('23503');
    } finally {
      await client.query('rollback');
    }
  });
});
