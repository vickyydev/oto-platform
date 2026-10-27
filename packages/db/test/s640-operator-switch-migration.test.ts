import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as applyMigrations } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { createTestDatabase, stopTestServer } from '../src/testing';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');
type Entry = { idx: number; tag: string; when: number };
type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, unknown>; foreignKeys: Record<string, unknown>; indexes: Record<string, unknown> }>;
};
const journalOf = () => JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Entry[] };
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function removeTestMigrationsFolder(folder: string) {
  const target = resolve(folder), root = resolve(tmpdir());
  if (dirname(target) !== root || !/^oto-pre640-[A-Za-z0-9]+$/.test(basename(target))) {
    throw new Error('SCRUM_640_TEMP_DIRECTORY_OUTSIDE_TEST_ROOT');
  }
  rmSync(target, { recursive: true, force: true });
}

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };
let fixture: Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-640-operator-switch-migration' });
  await client.connect();
  fixture = await seed(client);
  await addAudit(client, fixture);
  await addAudit(client, fixture, false);
}, 300_000);

afterAll(async () => {
  try { await client?.end(); } finally {
    try { await database?.drop(); } finally { await stopTestServer(); }
  }
});

async function seed(c: pg.Client) {
  const home = newId(), target = newId(), account = newId(), branch = newId(), station = newId();
  await c.query(`insert into core.operator (id, name) values
    ($1, 'ZZ TEST 640 migration home'), ($2, 'ZZ TEST 640 migration target')`, [home, target]);
  await c.query(`insert into core.branch (id, operator_id, name, code)
    values ($1, $2, 'ZZ TEST 640 migration park', $3)`, [branch, home, branch]);
  await c.query(`insert into core.account (id, operator_id, phone, status)
    values ($1, $2, '+66000000640', 'active')`, [account, home]);
  await c.query(`insert into core.station (id, operator_id, branch_id, name, kind)
    values ($1, $2, $3, 'ZZ TEST 640 migration station', 'till')`, [station, home, branch]);
  return { home, target, account, branch, station };
}

async function addSession(c: pg.Client, f: Awaited<ReturnType<typeof seed>>, seated = true) {
  const id = newId();
  // A generated fingerprint only: no usable token or password exists in this fixture.
  const tokenHash = fingerprint(['ZZ TEST 640 non-credential fixture', id]);
  await c.query(`insert into core.session
    (id, account_id, token_hash, branch_id, station_id, expires_at, last_seen_at, created_at, locked_at)
    values ($1, $2, $3, $4, $5, '2026-12-01T12:34:56.789Z',
      '2026-10-25T01:02:03.456Z', '2026-10-25T01:00:00.123Z', '2026-10-25T01:01:00.234Z')`,
  [id, f.account, tokenHash, seated ? f.branch : null, seated ? f.station : null]);
  return id;
}

async function rowOf(c: pg.Client, id: string) {
  return (await c.query(`select to_jsonb(s) as row from core.session s where id = $1`, [id])).rows[0]!.row as Record<string, unknown>;
}

async function addAudit(c: pg.Client, f: Awaited<ReturnType<typeof seed>>, owned = true) {
  const id = newId();
  await c.query(`insert into core.audit_log
    (id, operator_id, branch_id, actor_account_id, request_id, action, entity_type, entity_id,
      "before", "after", action_id, source_event_id, created_at)
    values ($1, $2, $3, $4, $5, 'ZZ TEST 640 migration history', 'account', $6,
      $7::jsonb, $8::jsonb, $9, $10, '2026-10-25T01:03:00.345Z')`,
  [id, owned ? f.home : null, owned ? f.branch : null, owned ? f.account : null,
    `zz-test-640-${id}`, f.account, JSON.stringify({ count: 1, state: 'ZZ TEST before' }),
    JSON.stringify({ count: 2, nested: { unchanged: true } }), `zz-test-action-${id}`, newId()]);
  return id;
}

async function auditRowOf(c: pg.Client, id: string) {
  return (await c.query(`select to_jsonb(a) as row from core.audit_log a where id = $1`, [id])).rows[0]!.row as Record<string, unknown>;
}

function nativeMigrate(url: string) {
  execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
    cwd: PKG, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
  });
}

describe('SCRUM-640 expand-only session override and Q22 audit context migration', () => {
  it('adds a nullable UUID with no default to the session, never the home account', async () => {
    const columns = (await client.query(`select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'core'
      and table_name in ('session', 'account') and column_name = 'operator_override' order by table_name`)).rows;
    expect(columns).toEqual([{ table_name: 'session', column_name: 'operator_override', data_type: 'uuid',
      is_nullable: 'YES', column_default: null }]);
  });

  it('defaults newly created seated and branchless sessions to null without changing their identity or state', async () => {
    for (const seated of [true, false]) {
      const id = await addSession(client, fixture, seated);
      const row = (await client.query(`select id, account_id, token_hash, branch_id, station_id, operator_override,
        expires_at::text, last_seen_at::text, created_at::text, locked_at::text, revoked_at, class
        from core.session where id = $1`, [id])).rows[0]!;
      expect(row).toMatchObject({ id, account_id: fixture.account, branch_id: seated ? fixture.branch : null,
        station_id: seated ? fixture.station : null, operator_override: null, revoked_at: null, class: 'staff' });
      expect(row.token_hash).toBe(fingerprint(['ZZ TEST 640 non-credential fixture', id]));
      expect(new Date(row.expires_at).toISOString()).toBe('2026-12-01T12:34:56.789Z');
      expect(new Date(row.last_seen_at).toISOString()).toBe('2026-10-25T01:02:03.456Z');
      expect(new Date(row.created_at).toISOString()).toBe('2026-10-25T01:00:00.123Z');
      expect(new Date(row.locked_at).toISOString()).toBe('2026-10-25T01:01:00.234Z');
      expect((await client.query('select operator_id from core.account where id = $1', [fixture.account])).rows)
        .toEqual([{ operator_id: fixture.home }]);
    }
  });

  it('references only the new session column to the existing operator primary key', async () => {
    const references = (await client.query<{ columns: string[]; target_schema: string; target_table: string; target_columns: string[]; delete_action: string; update_action: string }>(`
      select array(select a.attname::text from pg_attribute a where a.attrelid = c.conrelid
        and a.attnum = any(c.conkey) order by array_position(c.conkey, a.attnum)) as columns,
        n.nspname as target_schema, t.relname as target_table,
        array(select a.attname::text from pg_attribute a where a.attrelid = c.confrelid
          and a.attnum = any(c.confkey) order by array_position(c.confkey, a.attnum)) as target_columns,
        c.confdeltype as delete_action, c.confupdtype as update_action
      from pg_constraint c join pg_class t on t.oid = c.confrelid join pg_namespace n on n.oid = t.relnamespace
      where c.conrelid = 'core.session'::regclass and c.contype = 'f'`)).rows
      .filter(row => row.columns.includes('operator_override'));
    expect(references).toEqual([{ columns: ['operator_override'], target_schema: 'core', target_table: 'operator',
      target_columns: ['id'], delete_action: 'a', update_action: 'a' }]);
  });

  it('accepts an existing other operator and clearing to null without rewriting home, seat or session fields', async () => {
    const id = await addSession(client, fixture), before = await rowOf(client, id);
    await client.query('update core.session set operator_override = $2 where id = $1', [id, fixture.target]);
    expect(fingerprint(await rowOf(client, id))).toBe(fingerprint({ ...before, operator_override: fixture.target }));
    await client.query('update core.session set operator_override = null where id = $1', [id]);
    expect(fingerprint(await rowOf(client, id))).toBe(fingerprint(before));
    expect((await client.query('select operator_id from core.account where id = $1', [fixture.account])).rows)
      .toEqual([{ operator_id: fixture.home }]);
  });

  it('refuses an unknown operator UUID and leaves the complete session unchanged', async () => {
    const id = await addSession(client, fixture), before = fingerprint(await rowOf(client, id));
    await expect(client.query('update core.session set operator_override = $2 where id = $1', [id, newId()]))
      .rejects.toMatchObject({ code: '23503' });
    expect(fingerprint(await rowOf(client, id))).toBe(before);
  });

  it('refuses malformed UUID data rather than storing an untyped context', async () => {
    const id = await addSession(client, fixture), before = fingerprint(await rowOf(client, id));
    await expect(client.query('update core.session set operator_override = $2 where id = $1', [id, 'ZZ TEST not a UUID']))
      .rejects.toMatchObject({ code: '22P02' });
    expect(fingerprint(await rowOf(client, id))).toBe(before);
  });

  it('adds exactly two nullable UUID audit context columns without defaults or account/session substitutes', async () => {
    const columns = (await client.query(`select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'core'
      and table_name in ('audit_log', 'session', 'account')
      and column_name in ('home_operator_id', 'effective_operator_id') order by table_name, column_name`)).rows;
    expect(columns).toEqual([
      { table_name: 'audit_log', column_name: 'effective_operator_id', data_type: 'uuid', is_nullable: 'YES', column_default: null },
      { table_name: 'audit_log', column_name: 'home_operator_id', data_type: 'uuid', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('references each new audit column only to operator.id with native NO ACTION', async () => {
    const references = (await client.query<{ columns: string[]; target_schema: string; target_table: string; target_columns: string[]; delete_action: string; update_action: string }>(`
      select array(select a.attname::text from pg_attribute a where a.attrelid = c.conrelid
        and a.attnum = any(c.conkey) order by array_position(c.conkey, a.attnum)) as columns,
        n.nspname as target_schema, t.relname as target_table,
        array(select a.attname::text from pg_attribute a where a.attrelid = c.confrelid
          and a.attnum = any(c.confkey) order by array_position(c.confkey, a.attnum)) as target_columns,
        c.confdeltype as delete_action, c.confupdtype as update_action
      from pg_constraint c join pg_class t on t.oid = c.confrelid join pg_namespace n on n.oid = t.relnamespace
      where c.conrelid = 'core.audit_log'::regclass and c.contype = 'f'`)).rows
      .filter(row => row.columns.some(column => ['home_operator_id', 'effective_operator_id'].includes(column)))
      .sort((a, b) => a.columns[0]!.localeCompare(b.columns[0]!));
    expect(references).toEqual(['effective_operator_id', 'home_operator_id'].map(column => ({ columns: [column],
      target_schema: 'core', target_table: 'operator', target_columns: ['id'], delete_action: 'a', update_action: 'a' })));
  });

  it('defaults audit attribution to null and validates both UUID references without changing event ownership or payloads', async () => {
    const id = await addAudit(client, fixture), before = await auditRowOf(client, id);
    expect(before.home_operator_id).toBeNull(); expect(before.effective_operator_id).toBeNull();
    await client.query(`update core.audit_log set home_operator_id = $2, effective_operator_id = $3 where id = $1`,
      [id, fixture.home, fixture.target]);
    expect(fingerprint(await auditRowOf(client, id))).toBe(fingerprint({ ...before,
      home_operator_id: fixture.home, effective_operator_id: fixture.target }));
    for (const column of ['home_operator_id', 'effective_operator_id'] as const) {
      const valid = fingerprint(await auditRowOf(client, id));
      await expect(client.query(`update core.audit_log set ${column} = $2 where id = $1`, [id, newId()]))
        .rejects.toMatchObject({ code: '23503' });
      expect(fingerprint(await auditRowOf(client, id))).toBe(valid);
      await expect(client.query(`update core.audit_log set ${column} = $2 where id = $1`, [id, 'ZZ TEST not a UUID']))
        .rejects.toMatchObject({ code: '22P02' });
      expect(fingerprint(await auditRowOf(client, id))).toBe(valid);
    }
    await client.query(`update core.audit_log set home_operator_id = null, effective_operator_id = null where id = $1`, [id]);
    expect(fingerprint(await auditRowOf(client, id))).toBe(fingerprint(before));
  });

  it('extends its predecessor snapshot by exactly three nullable columns and three foreign keys', () => {
    const journal = journalOf(), mine = journal.entries.find(entry => entry.tag.endsWith('_operator_switch'));
    expect(mine, 'The session override has one native journal entry.').toBeDefined();
    expect(journal.entries.filter(entry => entry.tag.endsWith('_operator_switch'))).toHaveLength(1);
    const previous = journal.entries[journal.entries.indexOf(mine!) - 1]!;
    expect(mine!.idx).toBe(previous.idx + 1); expect(mine!.when).toBeGreaterThan(previous.when);
    const load = (tag: string) => JSON.parse(readFileSync(join(MIGRATIONS, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as Snapshot;
    const before = load(previous.tag), after = load(mine!.tag), priorSession = before.tables['core.session']!, nextSession = after.tables['core.session']!;
    expect(after.prevId).toBe(before.id); expect(after.id).not.toBe(before.id);
    expect(Object.keys(nextSession.columns).filter(key => !(key in priorSession.columns))).toEqual(['operator_override']);
    expect(nextSession.columns.operator_override).toEqual({ name: 'operator_override', type: 'uuid', primaryKey: false, notNull: false });
    const addedKeys = Object.keys(nextSession.foreignKeys).filter(key => !(key in priorSession.foreignKeys));
    expect(addedKeys).toHaveLength(1);
    expect(nextSession.foreignKeys[addedKeys[0]!]).toMatchObject({ tableFrom: 'session', tableTo: 'operator',
      schemaTo: 'core', columnsFrom: ['operator_override'], columnsTo: ['id'], onDelete: 'no action', onUpdate: 'no action' });
    const expected = structuredClone(before); expected.id = after.id; expected.prevId = after.prevId;
    expected.tables['core.session']!.columns.operator_override = nextSession.columns.operator_override;
    expected.tables['core.session']!.foreignKeys[addedKeys[0]!] = nextSession.foreignKeys[addedKeys[0]!];
    const priorAudit = before.tables['core.audit_log']!, nextAudit = after.tables['core.audit_log']!;
    const addedAuditColumns = Object.keys(nextAudit.columns).filter(key => !(key in priorAudit.columns)).sort();
    expect(addedAuditColumns).toEqual(['effective_operator_id', 'home_operator_id']);
    const addedAuditKeys = Object.keys(nextAudit.foreignKeys).filter(key => !(key in priorAudit.foreignKeys));
    expect(addedAuditKeys).toHaveLength(2);
    for (const column of addedAuditColumns) {
      expect(nextAudit.columns[column]).toEqual({ name: column, type: 'uuid', primaryKey: false, notNull: false });
      const keys = addedAuditKeys.filter(key => (nextAudit.foreignKeys[key] as { columnsFrom: string[] }).columnsFrom.includes(column));
      expect(keys).toHaveLength(1);
      expect(nextAudit.foreignKeys[keys[0]!]).toMatchObject({ tableFrom: 'audit_log', tableTo: 'operator', schemaTo: 'core',
        columnsFrom: [column], columnsTo: ['id'], onDelete: 'no action', onUpdate: 'no action' });
      expected.tables['core.audit_log']!.columns[column] = nextAudit.columns[column];
      expected.tables['core.audit_log']!.foreignKeys[keys[0]!] = nextAudit.foreignKeys[keys[0]!];
    }
    expect(after).toEqual(expected);
    const sql = readFileSync(join(MIGRATIONS, `${mine!.tag}.sql`), 'utf8');
    const mutationSql = sql.replace(/\bON\s+DELETE\s+NO\s+ACTION\b/gi, '')
      .replace(/\bON\s+UPDATE\s+NO\s+ACTION\b/gi, '');
    expect(mutationSql).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT|DEFAULT)\b|ALTER COLUMN/i);
  });

  it('migrates a real predecessor database without backfilling or altering existing session or audit data', async () => {
    const name = `oto_test_pre640_${Date.now()}_${process.pid}_${newId().replaceAll('-', '').slice(-8)}`;
    await client.query(`create database ${name}`);
    const url = database.url.replace(/\/[^/]*$/, `/${name}`), c = new pg.Client({ connectionString: url });
    const folder = mkdtempSync(join(tmpdir(), 'oto-pre640-'));
    try {
      await c.connect();
      const journal = journalOf(), mine = journal.entries.findIndex(entry => entry.tag.endsWith('_operator_switch'));
      const predecessors = mine < 0 ? journal.entries : journal.entries.slice(0, mine);
      mkdirSync(join(folder, 'meta'));
      for (const entry of predecessors) copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
      writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: predecessors }));
      await applyMigrations(drizzle(c), { migrationsFolder: folder });
      const old = await seed(c), seated = await addSession(c, old), branchless = await addSession(c, old, false);
      const auditIds = [await addAudit(c, old), await addAudit(c, old, false)];
      const previousAudit = await Promise.all(auditIds.map(id => auditRowOf(c, id)));
      const previousRows = await Promise.all([seated, branchless].map(id => rowOf(c, id)));
      const previousAccount = fingerprint((await c.query('select to_jsonb(a) as row from core.account a where id = $1', [old.account])).rows[0]!.row);
      nativeMigrate(url);
      expect((await c.query('select id, operator_override from core.session where id = any($1::uuid[]) order by id', [[seated, branchless]])).rows)
        .toEqual([seated, branchless].sort().map(id => ({ id, operator_override: null })));
      const currentRows = await Promise.all([seated, branchless].map(id => rowOf(c, id)));
      expect(currentRows.map(row => { const original = { ...row }; delete original.operator_override; return fingerprint(original); }))
        .toEqual(previousRows.map(fingerprint));
      expect(fingerprint((await c.query('select to_jsonb(a) as row from core.account a where id = $1', [old.account])).rows[0]!.row)).toBe(previousAccount);
      expect((await c.query(`select id, home_operator_id, effective_operator_id from core.audit_log
        where id = any($1::uuid[]) order by id`, [auditIds])).rows)
        .toEqual([...auditIds].sort().map(id => ({ id, home_operator_id: null, effective_operator_id: null })));
      const currentAudit = await Promise.all(auditIds.map(id => auditRowOf(c, id)));
      // SCRUM-643 later adds three nullable audit context columns in the same chain; existing rows keep them empty.
      expect(currentAudit.map(row => [row.target_app, row.reason, row.origin])).toEqual(auditIds.map(() => [null, null, null]));
      // SCRUM-648 later adds the impersonation marks (actor_type, on_behalf_of); existing rows keep them empty too.
      expect(currentAudit.map(row => [row.actor_type, row.on_behalf_of])).toEqual(auditIds.map(() => [null, null]));
      expect(currentAudit.map(row => { const original = { ...row }; delete original.home_operator_id; delete original.effective_operator_id;
        delete original.target_app; delete original.reason; delete original.origin; delete original.actor_type; delete original.on_behalf_of;
        return fingerprint(original); })).toEqual(previousAudit.map(fingerprint));
    } finally {
      await c.end().catch(() => undefined);
      await client.query(`drop database if exists ${name} with (force)`);
      removeTestMigrationsFolder(folder);
    }
  }, 300_000);

  it('replays the complete native migration chain without another ledger row or any session/account/audit change', async () => {
    const ledger = (await client.query('select hash, created_at::text from drizzle.__drizzle_migrations order by created_at')).rows;
    const rows = fingerprint((await client.query('select to_jsonb(s) as row from core.session s where account_id = $1 order by id', [fixture.account])).rows);
    const owner = fingerprint((await client.query('select to_jsonb(a) as row from core.account a where id = $1', [fixture.account])).rows);
    const history = fingerprint((await client.query('select to_jsonb(a) as row from core.audit_log a order by id')).rows);
    nativeMigrate(database.url);
    expect((await client.query('select hash, created_at::text from drizzle.__drizzle_migrations order by created_at')).rows).toEqual(ledger);
    expect(fingerprint((await client.query('select to_jsonb(s) as row from core.session s where account_id = $1 order by id', [fixture.account])).rows)).toBe(rows);
    expect(fingerprint((await client.query('select to_jsonb(a) as row from core.account a where id = $1', [fixture.account])).rows)).toBe(owner);
    expect(fingerprint((await client.query('select to_jsonb(a) as row from core.audit_log a order by id')).rows)).toBe(history);
  }, 300_000);
});
