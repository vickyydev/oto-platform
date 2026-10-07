import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-20 E2 — REVIEW of the migration (SCRUM-217; events-kiosk PLAN §8 "This
 * ticket"). Written against the lane, not beside it: nothing here is taken
 * from `events-e2-migration.test.ts`. The number is provisional (the lander
 * renumbers it), so the migration is found by its tag.
 *
 *  - CHAINED FROM ITS PREDECESSOR: the journal is contiguous end to end, and
 *    the new snapshot is the old one plus exactly the two new tables — no
 *    table of the predecessor added to, changed or lost.
 *  - EXPAND-ONLY: every statement creates one of the two tables, or alters,
 *    constrains or indexes one of them; nothing else is touched.
 *  - APPLIES TWICE FROM EMPTY: two fresh databases migrate, and migrating one
 *    of them again is a no-op.
 *  - THE PLACEHOLDER: `pos.attendee` is exactly as the predecessor's snapshot
 *    describes it, in the snapshot and in the live database.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');
const TAG_SUFFIX = '_event_attendee_link';
const NEW_TABLES = ['pos.event_attendee_link', 'pos.event_drop_in_pricing'];

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}
interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, { name: string; type: string; notNull: boolean }> }>;
  enums: unknown;
  schemas: unknown;
  views?: unknown;
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
const mine = journal.entries.find((e) => e.tag.endsWith(TAG_SUFFIX))!;
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

describe('E2 review — the attendee link migration', () => {
  it('sits on a contiguous journal, straight after its predecessor', () => {
    expect(mine).toBeDefined();
    journal.entries.forEach((entry, i) => expect(entry.idx, entry.tag).toBe(i));
    expect(mine.idx).toBe(before.idx + 1);
    expect(mine.when).toBeGreaterThan(before.when);
    // Found by tag, placed by its predecessor — never "the last entry":
    // lanes land behind this one and the journal keeps growing.
  });

  it("its snapshot is its predecessor's plus exactly the two new tables", () => {
    const prev = snap(before.tag);
    const next = snap(mine.tag);
    expect(next.prevId).toBe(prev.id);
    const added = Object.keys(next.tables).filter((t) => !(t in prev.tables));
    const lost = Object.keys(prev.tables).filter((t) => !(t in next.tables));
    const changed = Object.keys(prev.tables).filter(
      (t) => t in next.tables && JSON.stringify(prev.tables[t]) !== JSON.stringify(next.tables[t]),
    );
    expect(added.sort()).toEqual(NEW_TABLES);
    expect(lost).toEqual([]);
    expect(changed).toEqual([]);
    expect(next.enums).toEqual(prev.enums);
    expect(next.schemas).toEqual(prev.schemas);
    // The placeholder, word for word.
    expect(next.tables['pos.attendee']).toEqual(prev.tables['pos.attendee']);
  });

  it('is expand-only: every statement names one of its own two tables', () => {
    const text = readFileSync(join(MIGRATIONS, `${mine.tag}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    const statements = text
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/\bDROP\b/i);
    for (const statement of statements) {
      // No data is moved: not a statement that starts by writing rows.
      expect(statement, statement.slice(0, 80)).not.toMatch(/^(?:UPDATE|DELETE|TRUNCATE|INSERT)\b/i);
      const target = /^(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX "[^"]+" ON)\s+"pos"\."([a-z_]+)"/.exec(statement);
      expect(target, statement.slice(0, 80)).not.toBeNull();
      expect(['event_attendee_link', 'event_drop_in_pricing'], statement.slice(0, 80)).toContain(target![1]);
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
    expect(await tablesOf(first.url)).toEqual(await tablesOf(second.url));
    for (const t of NEW_TABLES) expect(await tablesOf(first.url)).toContain(t);
  }, 300_000);

  it('leaves the live pos.attendee placeholder as its predecessor described it, and nothing new points at it', async () => {
    const described = snap(before.tag).tables['pos.attendee']!;
    const live = await query<{ column_name: string; is_nullable: string }>(
      first.url,
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'pos' and table_name = 'attendee' order by column_name`,
    );
    expect(live.map((c) => c.column_name)).toEqual(Object.values(described.columns).map((c) => c.name).sort());
    for (const c of live) {
      const col = Object.values(described.columns).find((d) => d.name === c.column_name)!;
      expect(c.is_nullable === 'NO', c.column_name).toBe(col.notNull);
    }
    // Nothing new points at it.
    const refs = await query<{ conname: string }>(
      first.url,
      `select conname from pg_constraint where contype = 'f' and confrelid = 'pos.attendee'::regclass
         and conrelid in ('pos.event_attendee_link'::regclass, 'pos.event_drop_in_pricing'::regclass)`,
    );
    expect(refs).toEqual([]);
  });

  it('indexes every foreign key of both tables by its leading column', async () => {
    const rows = await query<{ tbl: string; col: string; indexed: boolean }>(
      first.url,
      `select t.relname as tbl, a.attname as col,
              exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum) as indexed
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join pg_attribute a on a.attrelid = t.oid and a.attnum = c.conkey[1]
        where c.contype = 'f' and n.nspname = 'pos' and t.relname in ('event_attendee_link', 'event_drop_in_pricing')`,
    );
    // Nine on the link (operator, branch, child, member, sale, sale line, account, station, box), three on the prices.
    expect(rows.filter((r) => r.tbl === 'event_attendee_link')).toHaveLength(9);
    expect(rows.filter((r) => r.tbl === 'event_drop_in_pricing')).toHaveLength(3);
    expect(rows.filter((r) => !r.indexed)).toEqual([]);
  });
});
