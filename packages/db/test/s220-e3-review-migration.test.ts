import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-20 E3 — REVIEW of the migration (SCRUM-217; events-kiosk PLAN §8 "This
 * ticket": `pos.event_checkin` and the band change). Written against the lane,
 * not beside it: nothing here is taken from `events-e3-migration.test.ts`. The
 * number is provisional (the lander renumbers it), so it is found by its tag.
 *
 *  - CHAINED FROM 0070: the journal is contiguous, the migration sits straight
 *    after the attendee link, and its snapshot is that one's plus exactly the
 *    new table and the band's own change — no other table touched.
 *  - EXPAND-ONLY: every statement creates, alters or indexes the new table or
 *    `pos.band`; the one DROP is the band's NOT NULL on `sale_id`; no rows move.
 *  - APPLIES TWICE FROM EMPTY: two fresh databases migrate alike, and migrating
 *    one of them again is a no-op.
 *  - EVERY FOREIGN KEY LEADS AN INDEX, on the new table and the new column.
 *  - THE BAND'S OWNER: a band names a sale or a check-in, exactly one.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}
interface Table {
  columns: Record<string, { name: string; type: string; notNull: boolean }>;
  indexes: Record<string, unknown>;
  foreignKeys: Record<string, unknown>;
  checkConstraints?: Record<string, unknown>;
  [k: string]: unknown;
}
interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<string, Table>;
  enums: unknown;
  schemas: unknown;
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
const mine = journal.entries.find((e) => e.tag.endsWith('_event_checkin'))!;
const before = journal.entries[journal.entries.indexOf(mine) - 1]!;
const snap = (tag: string) =>
  JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as Snapshot;

let first: { url: string; drop: () => Promise<void> };
let second: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  first = await createTestDatabase();
  second = await createTestDatabase();
}, 600_000);

afterAll(async () => {
  await first?.drop();
  await second?.drop();
  await stopTestServer();
}, 180_000);

async function query<R>(url: string, text: string, values: unknown[] = []): Promise<R[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text, values)).rows as R[];
  } finally {
    await client.end();
  }
}

async function refusal(url: string, text: string, values: unknown[] = []): Promise<string | null> {
  try {
    await query(url, text, values);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('E3 review — the event check-in migration', () => {
  it('sits on a contiguous journal, straight after its predecessor, later than it', () => {
    expect(mine).toBeDefined();
    journal.entries.forEach((entry, i) => expect(entry.idx, entry.tag).toBe(i));
    // Placed by its predecessor, whichever migration landed before it:
    // lanes land between each other and the journal keeps growing.
    expect(mine.idx).toBe(before.idx + 1);
    expect(mine.when).toBeGreaterThan(before.when);
  });

  it("its snapshot is its predecessor's plus the new table, and pos.band's own change — nothing else", () => {
    const prev = snap(before.tag);
    const next = snap(mine.tag);
    expect(next.prevId).toBe(prev.id);
    expect(Object.keys(next.tables).filter((t) => !(t in prev.tables))).toEqual(['pos.event_checkin']);
    expect(Object.keys(prev.tables).filter((t) => !(t in next.tables))).toEqual([]);
    const changed = Object.keys(prev.tables).filter(
      (t) => t in next.tables && JSON.stringify(prev.tables[t]) !== JSON.stringify(next.tables[t]),
    );
    expect(changed).toEqual(['pos.band']);
    expect(next.enums).toEqual(prev.enums);
    expect(next.schemas).toEqual(prev.schemas);

    const was = prev.tables['pos.band']!;
    const now = next.tables['pos.band']!;
    const movedColumns = Object.keys(now.columns).filter(
      (c) => JSON.stringify(was.columns[c]) !== JSON.stringify(now.columns[c]),
    );
    expect(movedColumns.sort()).toEqual(['event_checkin_id', 'sale_id']);
    expect(was.columns.sale_id!.notNull).toBe(true);
    expect(now.columns.sale_id!.notNull).toBe(false);
    expect({ ...now.columns.sale_id, notNull: true }).toEqual(was.columns.sale_id);
    expect(now.columns.event_checkin_id).toMatchObject({ type: 'uuid', notNull: false });
    // Only additions on the band otherwise: one index, one foreign key, one check.
    expect(Object.keys(was.columns).filter((c) => !(c in now.columns))).toEqual([]);
    expect(Object.keys(was.indexes).filter((i) => !(i in now.indexes))).toEqual([]);
    expect(Object.keys(now.indexes).filter((i) => !(i in was.indexes))).toEqual(['band_event_checkin_idx']);
    expect(Object.keys(now.foreignKeys).filter((f) => !(f in was.foreignKeys))).toEqual(['band_event_checkin_id_event_checkin_id_fk']);
    expect(Object.keys(was.foreignKeys).filter((f) => !(f in now.foreignKeys))).toEqual([]);
    expect(Object.keys(now.checkConstraints ?? {}).filter((c) => !(c in (was.checkConstraints ?? {})))).toEqual(['band_owner_check']);
    for (const k of Object.keys(now).filter((k) => !['columns', 'indexes', 'foreignKeys', 'checkConstraints'].includes(k))) {
      expect(now[k], k).toEqual(was[k]);
    }
  });

  it('is expand-only: every statement names the new table or pos.band, the one DROP is the NOT NULL, and no rows move', () => {
    const text = readFileSync(join(MIGRATIONS, `${mine.tag}.sql`), 'utf8')
      .split('\n')
      // A comment line goes; the breakpoint marker on a line of its own stays.
      .filter((line) => !line.trimStart().startsWith('--') || line.trimStart().startsWith('--> statement-breakpoint'))
      .join('\n');
    const statements = text
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    const drops = statements.filter((s) => /\bDROP\b/i.test(s));
    expect(drops).toHaveLength(1);
    expect(drops[0]!.replace(/\s+/g, ' ')).toMatch(/^ALTER TABLE "pos"\."band" ALTER COLUMN "sale_id" DROP NOT NULL;?$/);
    for (const statement of statements) {
      expect(statement, statement.slice(0, 80)).not.toMatch(/^(?:UPDATE|DELETE|TRUNCATE|INSERT)\b/i);
      const target = /^(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX "[^"]+" ON)\s+"pos"\."([a-z_]+)"/.exec(statement);
      expect(target, statement.slice(0, 80)).not.toBeNull();
      expect(['event_checkin', 'band'], statement.slice(0, 80)).toContain(target![1]);
    }
  });

  it('applies to two empty databases alike, and a second migrate of one is a no-op', async () => {
    const tablesOf = async (url: string) =>
      (
        await query<{ t: string }>(
          url,
          `select table_schema || '.' || table_name as t from information_schema.tables
            where table_schema not in ('pg_catalog', 'information_schema') order by 1`,
        )
      ).map((r) => r.t);
    const applied = async (url: string) =>
      Number((await query<{ n: string }>(url, 'select count(*) as n from drizzle.__drizzle_migrations'))[0]!.n);
    expect(await tablesOf(first.url)).toEqual(await tablesOf(second.url));
    expect(await applied(first.url)).toBe(journal.entries.length);
    execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
      cwd: PKG,
      env: { ...process.env, DATABASE_URL: first.url },
      stdio: 'pipe',
    });
    expect(await applied(first.url)).toBe(journal.entries.length);
    expect(await tablesOf(first.url)).toContain('pos.event_checkin');
  }, 300_000);

  it('indexes every foreign key of the new table, and the band’s new one, by its leading column', async () => {
    const rows = await query<{ tbl: string; col: string; indexed: boolean }>(
      first.url,
      `select t.relname as tbl, a.attname as col,
              exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum) as indexed
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join pg_attribute a on a.attrelid = t.oid and a.attnum = c.conkey[1]
        where c.contype = 'f' and n.nspname = 'pos'
          and (t.relname = 'event_checkin' or (t.relname = 'band' and a.attname = 'event_checkin_id'))`,
    );
    // Nine on the check-in (operator, branch, link, two accounts, two bands, station, box), one on the band.
    expect(rows.filter((r) => r.tbl === 'event_checkin')).toHaveLength(9);
    expect(rows.filter((r) => r.tbl === 'band')).toHaveLength(1);
    expect(rows.filter((r) => !r.indexed)).toEqual([]);
  });

  it('a band names a sale or a check-in, exactly one; a check-in is one per child per day', async () => {
    const def = (
      await query<{ def: string }>(
        first.url,
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'band_owner_check'`,
      )
    )[0]!.def;
    expect(def).toMatch(/sale_id IS NULL\) <> \(event_checkin_id IS NULL/);
    const unique = await query<{ def: string }>(
      first.url,
      `select pg_get_indexdef(i.indexrelid) as def from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = 'event_checkin_attendee_day_unique' and i.indisunique`,
    );
    expect(unique[0]!.def).toMatch(/\(otoapp_event_id, attendee_id, attendance_date\)/);
    // A band with neither owner is refused by the check before any foreign key is read.
    expect(
      await refusal(
        first.url,
        `insert into pos.band (id, operator_id, branch_id, kind, gate_access, code, status)
         values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'kid', false, 'X', 'active')`,
      ),
    ).toMatch(/^23/);
  });
});
