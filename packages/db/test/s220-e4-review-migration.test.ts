import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-20 E4 — REVIEW of the party tab migration (PROVISIONAL number; the
 * lander renumbers it and regenerates the snapshot):
 *
 *   - chained: the last journal entry, one past its predecessor, on a snapshot
 *     whose prevId is the predecessor's id, and the snapshot carries the three
 *     tables with the SQL's own foreign keys and indexes;
 *   - forward-only and expand-only: it creates three tables and touches no
 *     table that existed before it;
 *   - twice-clean: migrating a database already at head applies nothing and
 *     fails nothing (CI's "Migrations apply cleanly from empty (twice)");
 *   - every foreign key of the three tables leads an index; no party table
 *     names an OTO App table (C10 — the party is the app's, read through the
 *     seam, so the event id is a plain uuid).
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');
const TABLES = ['party_charge', 'party_payment', 'party_edit'];

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}
interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<string, { foreignKeys: Record<string, { tableTo: string; schemaTo?: string; onDelete?: string }>; indexes: Record<string, unknown> }>;
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
const mine = journal.entries.find((e) => e.tag.endsWith('_party_tab'))!;
const sqlText = readFileSync(join(MIGRATIONS, `${mine.tag}.sql`), 'utf8');
const snapshotOf = (idx: number) =>
  JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${String(idx).padStart(4, '0')}_snapshot.json`), 'utf8')) as Snapshot;

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

describe('review — the party tab migration', () => {
  it('is chained: the head of the journal, its snapshot following its predecessor’s, holding the three tables', () => {
    const at = journal.entries.indexOf(mine);
    expect(at).toBe(journal.entries.length - 1);
    const before = journal.entries[at - 1]!;
    expect(mine.idx).toBe(before.idx + 1);
    const snap = snapshotOf(mine.idx);
    expect(snap.prevId).toBe(snapshotOf(before.idx).id);
    for (const table of TABLES) {
      const t = snap.tables[`pos.${table}`];
      expect(t, table).toBeDefined();
      // Every FK in the SQL is in the snapshot under the same name, and the other way round.
      const inSql = [...sqlText.matchAll(new RegExp(`ALTER TABLE "pos"\\."${table}" ADD CONSTRAINT "([^"]+)" FOREIGN KEY`, 'g'))].map((m) => m[1]).sort();
      expect(Object.keys(t!.foreignKeys).sort()).toEqual(inSql);
      expect(Object.values(t!.foreignKeys).every((fk) => fk.onDelete === 'restrict')).toBe(true);
      const indexesInSql = [...sqlText.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "pos"\\."${table}"`, 'g'))].map((m) => m[1]).sort();
      expect(Object.keys(t!.indexes).sort()).toEqual(indexesInSql);
    }
  });

  it('is expand-only and forward-only: three new tables, nothing that existed is altered or dropped', () => {
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    for (const s of statements) {
      // A foreign key's own "ON DELETE … ON UPDATE …" is not a data change.
      const bare = s.replace(/ON (DELETE|UPDATE) (restrict|cascade|no action|set null|set default)/gi, '');
      expect(bare).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\b|\bUPDATE\b|\bINSERT\b/i);
      const altered = /^ALTER TABLE "([^"]+)"\."([^"]+)"/.exec(s);
      if (altered) {
        expect(TABLES).toContain(altered[2]);
        expect(s).toMatch(/ADD CONSTRAINT "[^"]+" FOREIGN KEY/);
      } else {
        expect(s).toMatch(/^CREATE (TABLE "pos"\."party_(charge|payment|edit)"|(UNIQUE )?INDEX "[^"]+" ON "pos"\."party_(charge|payment|edit)")/);
      }
    }
    expect(sqlText).not.toMatch(/"otoapp"\./);
  });

  it('is twice-clean: a database at head migrates again with nothing applied', async () => {
    const count = async () => Number((await client.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n);
    const before = await count();
    expect(before).toBe(journal.entries.length);
    execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
      cwd: PKG,
      env: { ...process.env, DATABASE_URL: db.url },
      stdio: 'pipe',
    });
    expect(await count()).toBe(before);
    for (const table of TABLES) {
      expect((await client.query(`select to_regclass('pos.${table}') as t`)).rows[0].t).toBe(`pos.${table}`);
    }
  });

  it('leads every foreign key of the three tables with an index', async () => {
    const unindexed = (
      await client.query(
        `select t.relname || '.' || a.attname as fk
           from pg_constraint c
           join pg_class t on t.oid = c.conrelid
           join pg_namespace n on n.oid = t.relnamespace
           join unnest(c.conkey) as k(attnum) on true
           join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
          where c.contype = 'f' and n.nspname = 'pos' and t.relname = any($1)
            and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
        [TABLES],
      )
    ).rows;
    expect(unindexed).toEqual([]);
    // The OTO App's event is named by id only — read through the seam, never joined.
    const toOtoApp = (
      await client.query(
        `select c.conname from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
           join pg_class r on r.oid = c.confrelid join pg_namespace rn on rn.oid = r.relnamespace
          where c.contype = 'f' and n.nspname = 'pos' and t.relname = any($1) and rn.nspname = 'otoapp'`,
        [TABLES],
      )
    ).rows;
    expect(toOtoApp).toEqual([]);
  });
});
