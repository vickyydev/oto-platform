import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-1024 — family profiles, plan step F1 (migration E1): the family behind
 * a member's children (`docs/progress/plans/dropoff-beo-20261119/
 * FAMILY_PROFILES_PLAN.md` §2.2 and §3), against live databases built from the
 * committed migrations.
 *
 *   - It is EXPAND ONLY: two new tables, two nullable columns on `crm.child`,
 *     their foreign keys and indexes. Nothing is dropped, renamed, tightened or
 *     written, so every child already saved keeps working with NULL.
 *   - It builds from empty twice, and migrating a built database again is a
 *     no-op.
 *   - The database holds the shape the service relies on: one live guardian
 *     row per family and member, a guardian row only on its own operator's
 *     family, every foreign key RESTRICT and leading an index.
 *   - Its undo file, run by hand as one transaction, leaves `crm` exactly as
 *     it was before the migration.
 *
 * Found by its tag suffix, never by number: built as 0136 while 0135 belonged
 * to another lane, and renumbered at landing if needed.
 */
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const at = journal.entries.findIndex((e) => /_family_profiles$/.test(e.tag));
const entry = journal.entries[at];

type Snapshot = { id: string; prevId: string; tables: Record<string, unknown> };
const snapshotOf = (tag: string) =>
  JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as Snapshot;

let first: { url: string; drop: () => Promise<void> };
let second: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  first = await createTestDatabase();
  second = await createTestDatabase();
  client = new pg.Client({ connectionString: first.url, application_name: 'oto-test-1024-family-migration' });
  await client.connect();
}, 300_000);

afterAll(async () => {
  try {
    await client?.end();
  } finally {
    try {
      await first?.drop();
      await second?.drop();
    } finally {
      await stopTestServer();
    }
  }
});

/** The Postgres error code a statement fails with, or null when it succeeds. */
async function codeOf(text: string, values: unknown[] = []): Promise<string | null> {
  await client.query('savepoint probe');
  try {
    await client.query(text, values);
    await client.query('release savepoint probe');
    return null;
  } catch (error) {
    await client.query('rollback to savepoint probe');
    return (error as { code?: string }).code ?? 'unknown';
  }
}

/** A minimal operator, member and account, all ZZ TEST. */
async function tenant(label: string) {
  const operatorId = newId();
  const memberId = newId();
  const otherMemberId = newId();
  await client.query(`insert into core.operator (id, name) values ($1, $2)`, [operatorId, `ZZ TEST 1024 ${label}`]);
  await client.query(
    `insert into crm.member (id, operator_id, phone, nickname) values
       ($1, $3, '+66990001' || $4, 'ZZ TEST 1024 parent'), ($2, $3, '+66990002' || $4, 'ZZ TEST 1024 other parent')`,
    [memberId, otherMemberId, operatorId, String(Math.floor(Math.random() * 1000)).padStart(3, '0')],
  );
  return { operatorId, memberId, otherMemberId };
}

async function makeFamily(operatorId: string, source = 'till'): Promise<string> {
  const id = newId();
  await client.query(`insert into crm.family (id, operator_id, source) values ($1, $2, $3)`, [id, operatorId, source]);
  return id;
}

const guardianSql = `insert into crm.family_guardian (id, operator_id, family_id, member_id, source, archived_at)
  values ($1, $2, $3, $4, 'till', $5)`;

describe('SCRUM-1024 family profiles migration', () => {
  it('is journalled straight after its predecessor, later than it, on its snapshot', () => {
    expect(entry, 'a journalled *_family_profiles migration').toBeDefined();
    journal.entries.forEach((e, i) => expect(e.idx, e.tag).toBe(i));
    const before = journal.entries[at - 1]!;
    expect(entry!.idx).toBe(before.idx + 1);
    expect(entry!.when, `after ${before.tag}`).toBeGreaterThan(before.when);
    expect(snapshotOf(entry!.tag).prevId).toBe(snapshotOf(before.tag).id);
    const added = Object.keys(snapshotOf(entry!.tag).tables).filter((t) => !(t in snapshotOf(before.tag).tables));
    expect(added.sort()).toEqual(['crm.family', 'crm.family_guardian']);
  });

  it('only expands: two tables, two nullable child columns, their keys and indexes; nothing dropped, tightened or written', () => {
    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !/^--(?!>)/.test(line))
      .join('\n');
    const statements = sqlText.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    const created = statements.flatMap((s) => [...s.matchAll(/CREATE TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`));
    expect(created).toEqual(['crm.family', 'crm.family_guardian']);
    // The FKs say "ON DELETE restrict ON UPDATE no action": not a DML statement.
    const ddl = sqlText.replace(/ON (?:DELETE|UPDATE) [a-z ]+?(?= ON | REFERENCES|;|$)/gim, '');
    expect(ddl).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN|SET NOT NULL|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/);
    const altered = [...sqlText.matchAll(/ALTER TABLE "([a-z_]+)"\."([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(altered)).toEqual(new Set(['crm.family', 'crm.family_guardian', 'crm.child']));
    // On the existing table: two columns with no default and no NOT NULL, two
    // foreign keys and two indexes — nothing else.
    const onChild = statements.filter((s) => s.includes('"crm"."child"'));
    expect(onChild).toEqual([
      'ALTER TABLE "crm"."child" ADD COLUMN "family_id" uuid;',
      'ALTER TABLE "crm"."child" ADD COLUMN "merged_into_child_id" uuid;',
      'ALTER TABLE "crm"."child" ADD CONSTRAINT "child_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "crm"."family"("id") ON DELETE restrict ON UPDATE no action;',
      'ALTER TABLE "crm"."child" ADD CONSTRAINT "child_merged_into_child_id_child_id_fk" FOREIGN KEY ("merged_into_child_id") REFERENCES "crm"."child"("id") ON DELETE restrict ON UPDATE no action;',
      'CREATE INDEX "child_family_idx" ON "crm"."child" USING btree ("family_id");',
      'CREATE INDEX "child_merged_into_idx" ON "crm"."child" USING btree ("merged_into_child_id");',
    ]);
  });

  it('builds from empty twice, and migrating a built database again is a no-op', async () => {
    const other = new pg.Client({ connectionString: second.url });
    await other.connect();
    try {
      const { rows } = await other.query<{ n: number }>(
        `select count(*)::int as n from information_schema.tables
          where table_schema = 'crm' and table_name in ('family', 'family_guardian')`,
      );
      expect(rows[0]!.n).toBe(2);
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
  }, 120_000);

  it('a child saved before families keeps working with no family', async () => {
    await client.query('begin');
    try {
      const t = await tenant('legacy');
      const childId = newId();
      expect(
        await codeOf(`insert into crm.child (id, member_id, name) values ($1, $2, 'ZZ TEST 1024 legacy child')`, [
          childId,
          t.memberId,
        ]),
      ).toBeNull();
      const { rows } = await client.query(`select family_id, merged_into_child_id from crm.child where id = $1`, [childId]);
      expect(rows).toEqual([{ family_id: null, merged_into_child_id: null }]);
    } finally {
      await client.query('rollback');
    }
  });

  it('indexes every foreign key of the new tables and columns, and none of them cascades', async () => {
    const { rows: unindexed } = await client.query(
      `select t.relname || '.' || a.attname as fk
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join unnest(c.conkey) as k(attnum) on true
         join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
        where c.contype = 'f' and n.nspname = 'crm'
          and (t.relname in ('family', 'family_guardian') or a.attname in ('family_id', 'merged_into_child_id'))
          and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum and i.indpred is null)`,
    );
    expect(unindexed).toEqual([]);
    const { rows: actions } = await client.query<{ name: string; confdeltype: string }>(
      `select c.conname as name, c.confdeltype
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where c.contype = 'f' and n.nspname = 'crm'
          and (t.relname in ('family', 'family_guardian') or c.conname like 'child_%family%' or c.conname like 'child_merged%')
        order by c.conname`,
    );
    expect(actions.map((r) => r.name)).toEqual([
      'child_family_id_family_id_fk',
      'child_merged_into_child_id_child_id_fk',
      'family_created_by_account_id_account_id_fk',
      'family_guardian_added_by_account_id_account_id_fk',
      'family_guardian_branch_id_branch_id_fk',
      'family_guardian_family_fk',
      'family_guardian_member_id_member_id_fk',
      'family_guardian_operator_id_operator_id_fk',
      'family_guardian_station_id_station_id_fk',
      'family_operator_id_operator_id_fk',
    ]);
    expect(new Set(actions.map((r) => r.confdeltype))).toEqual(new Set(['r']));
  });

  it('holds one live guardian row per family and member; an archived one frees the pair', async () => {
    await client.query('begin');
    try {
      const t = await tenant('unique');
      const familyId = await makeFamily(t.operatorId);
      expect(await codeOf(guardianSql, [newId(), t.operatorId, familyId, t.memberId, null])).toBeNull();
      expect(await codeOf(guardianSql, [newId(), t.operatorId, familyId, t.memberId, null])).toBe('23505');
      // Another member on the same family, and the same member on another family.
      expect(await codeOf(guardianSql, [newId(), t.operatorId, familyId, t.otherMemberId, null])).toBeNull();
      expect(await codeOf(guardianSql, [newId(), t.operatorId, await makeFamily(t.operatorId), t.memberId, null])).toBeNull();
      // A taken-off row is kept as the record and does not hold the pair.
      await client.query(`update crm.family_guardian set archived_at = now() where family_id = $1 and member_id = $2`, [
        familyId,
        t.memberId,
      ]);
      expect(await codeOf(guardianSql, [newId(), t.operatorId, familyId, t.memberId, null])).toBeNull();
    } finally {
      await client.query('rollback');
    }
  });

  it("refuses a guardian row on another operator's family, an unknown source, and a child in a family that does not exist", async () => {
    await client.query('begin');
    try {
      const mine = await tenant('fence mine');
      const theirs = await tenant('fence theirs');
      const theirFamily = await makeFamily(theirs.operatorId);
      // The row claims my operator but names their family: the composite key refuses it.
      expect(await codeOf(guardianSql, [newId(), mine.operatorId, theirFamily, mine.memberId, null])).toBe('23503');
      expect(await codeOf(`insert into crm.family (id, operator_id, source) values ($1, $2, 'seed')`, [newId(), mine.operatorId])).toBe('23514');
      expect(
        await codeOf(
          `insert into crm.family_guardian (id, operator_id, family_id, member_id, source) values ($1, $2, $3, $4, 'import')`,
          [newId(), theirs.operatorId, theirFamily, theirs.memberId],
        ),
      ).toBe('23514');
      expect(
        await codeOf(`insert into crm.child (id, member_id, name, family_id) values ($1, $2, 'ZZ TEST 1024 child', $3)`, [
          newId(),
          mine.memberId,
          newId(),
        ]),
      ).toBe('23503');
      // A family that still names a child, or a guardian, cannot be deleted from under it.
      const familyId = await makeFamily(mine.operatorId);
      await client.query(`insert into crm.child (id, member_id, name, family_id) values ($1, $2, 'ZZ TEST 1024 child', $3)`, [
        newId(),
        mine.memberId,
        familyId,
      ]);
      expect(await codeOf(`delete from crm.family where id = $1`, [familyId])).toBe('23503');
    } finally {
      await client.query('rollback');
    }
  });

  it('its undo file, run as one transaction, leaves crm exactly as it was before the migration', async () => {
    const undo = readFileSync(join(MIGRATIONS, 'undo', `${entry!.tag}.sql`), 'utf8');
    const db = await createTestDatabase();
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    try {
      const catalogue = async () => {
        const columns = await other.query<{ k: string }>(
          `select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '-') as k
             from information_schema.columns where table_schema = 'crm'`,
        );
        const constraints = await other.query<{ k: string }>(
          `select t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid) as k
             from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
            where n.nspname = 'crm'`,
        );
        const indexes = await other.query<{ k: string }>(`select indexdef as k from pg_indexes where schemaname = 'crm'`);
        return [...columns.rows, ...constraints.rows, ...indexes.rows].map((r) => r.k).sort();
      };
      const before = await catalogue();
      const ours = (k: string) =>
        /^family(_guardian)?\.|crm\.family(_guardian)?\b|\bfamily_id\b|merged_into_child_id|child_family_idx|child_merged_into_idx/.test(k);
      const added = before.filter(ours);
      expect(added.length).toBeGreaterThan(30);
      await other.query('begin');
      await other.query(undo);
      await other.query('commit');
      expect(await catalogue()).toEqual(before.filter((k) => !ours(k)));
    } finally {
      await other.end();
      await db.drop();
    }
  }, 300_000);
});
