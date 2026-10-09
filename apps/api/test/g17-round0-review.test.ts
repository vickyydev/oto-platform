import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type Db } from '@oto/db';
import { seed } from '@oto/db/seed';
import { applyOtoAppMigrations, createTestDatabase } from '@oto/db/testing';
import { newId } from '@oto/shared';
import {
  getBranchEvent,
  listBranchEvents,
  listEventAttendance,
  listEventAttendees,
  listSeamChildren,
} from '../src/services/otoapp-events';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  teardownAll,
} from './helpers';

/**
 * Review of lane H round 0 (events-kiosk PLAN s8 round 0; SCRUM-217): an
 * independent attack on the OTO App migration, the otoapp_v views, the
 * tenant-bound directory writes and the POS read, beside the builder's own
 * `otoapp-events-seam.test.ts`.
 *
 *  A. The migration against a database in the LIVE state (the app's 0000-0002
 *     applied, real rows in it): 0003 and 0004 applied by the app's own
 *     migrator when its node_modules are present (the same committed SQL
 *     through the same Drizzle migrator otherwise), then applied again. Nothing
 *     that existed changes, every addition is nullable or defaulted, nothing
 *     lands in `public`, and the previous release's writes still work.
 *  B. The views over seeded rows: a camp on every day of its range, the Q10
 *     mapping over EVERY value of the app's enum, and the branch seam for an
 *     unmapped, malformed or cross-tenant app branch.
 *  C. The directory writes: a replay with the same id makes one row (also when
 *     the copies race), a second tenant's key cannot reach the first tenant's
 *     event, and a bad body writes nothing. The write functions are loaded
 *     straight from the app's source (they import only types); the HTTP router
 *     needs express from the app's own node_modules, which CI does not install,
 *     so that block runs only where they exist.
 *  D. H1: a grep over apps/api/src against EVERY event-module table in the
 *     app's migrations (not a hand-kept list), and the repository run inside a
 *     READ ONLY transaction.
 */

const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_MODULES =
  existsSync(join(APP_NODE_MODULES, 'pg', 'package.json')) &&
  existsSync(join(APP_NODE_MODULES, 'drizzle-orm', 'package.json'));
const HAS_EXPRESS = existsSync(join(APP_NODE_MODULES, 'express', 'package.json'));

// --- The app's directory modules, typed here (they live outside this package) ---

interface DirectoryEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}

interface Outcome {
  ok: boolean;
  status: number;
  body?: {
    replayed?: boolean;
    merged?: boolean;
    attendee?: { id: string; attendanceDays: string[]; parentAttending: boolean };
    checkin?: { id: string; checkinRef: string | null; status: string; date: string };
  };
  error?: string;
  message?: string;
  details?: { checkin?: { checkinRef: string | null } };
}

interface AttendeeInput {
  id: string;
  childFullName: string;
  dateOfBirth?: string | null;
  ageYears?: number | null;
  parentName?: string | null;
  parentPhone?: string | null;
  allergies?: string | null;
  parentAttending: boolean;
  attendanceDays: string[];
  bookingId?: string | null;
  source: 'pos' | 'booking' | 'kiosk';
}

interface CheckinInput {
  id: string;
  date: string;
  checkedInAt?: string | null;
  checkedInBy?: string | null;
}

interface WritesModule {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<DirectoryEvent | null>;
  createEventAttendee(pool: pg.Pool, event: DirectoryEvent, input: AttendeeInput): Promise<Outcome>;
  recordAttendeeCheckin(
    pool: pg.Pool,
    event: DirectoryEvent,
    attendeeId: string,
    input: CheckinInput,
  ): Promise<Outcome>;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  locals: Record<string, unknown>;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  setHeader(name: string, value: string): void;
}

interface AuthModule {
  hashDirectoryKey(key: string): string;
  requireDirectoryClient(
    pool: pg.Pool,
    scope: string,
  ): (
    req: { headers: Record<string, string> },
    res: FakeRes,
    next: (err?: unknown) => void,
  ) => Promise<unknown>;
}

interface ExpressApp {
  use(handler: unknown): void;
  listen(port: number, cb: () => void): Server;
}
interface ExpressModule {
  (): ExpressApp;
  json(): unknown;
}

const loadApp = async <T>(rel: string): Promise<T> =>
  (await import(/* @vite-ignore */ pathToFileURL(join(APP_DIR, rel)).href)) as T;

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const newKey = () => 'odk_' + randomBytes(32).toString('base64url');

// =============================================================================
// A. The migration against the live state
// =============================================================================

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

/** A copy of the app's migrations holding only what is live before this round. */
function liveMigrationsFolder(): string {
  const journal = JSON.parse(
    readFileSync(join(APP_MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: JournalEntry[];
  };
  const live = journal.entries.filter((e) => e.idx <= 2);
  expect(live.map((e) => e.tag)).toEqual([
    '0000_otoapp_baseline',
    '0001_platform_user_id',
    '0002_core_branch_id_unique',
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'otoapp-live-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: live }));
  for (const e of live)
    copyFileSync(join(APP_MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

interface Shape {
  columns: Map<string, string>;
  constraints: Map<string, string>;
  indexes: Map<string, string>;
  enums: Map<string, string>;
  tables: Set<string>;
  publicObjects: string[];
}

async function shapeOf(c: pg.Client): Promise<Shape> {
  const cols = await c.query<{ t: string; col: string; def: string }>(`
    select c.relname as t, a.attname as col,
           format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull ||
           ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '<none>') as def
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where n.nspname = 'otoapp' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped`);
  const cons = await c.query<{ t: string; name: string; def: string }>(`
    select coalesce(cl.relname, '<type>') as t, co.conname as name, pg_get_constraintdef(co.oid) as def
      from pg_constraint co left join pg_class cl on cl.oid = co.conrelid
     where co.connamespace = 'otoapp'::regnamespace`);
  const idx = await c.query<{ t: string; name: string; def: string }>(`
    select tablename as t, indexname as name, indexdef as def from pg_indexes where schemaname = 'otoapp'`);
  const enums = await c.query<{ name: string; labels: string }>(`
    select t.typname as name, string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
      from pg_type t join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'otoapp' group by t.typname`);
  const pub = await c.query<{ name: string }>(`
    select c.relkind::text || ':' || c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
    union all
    select 'type:' || t.typname from pg_type t
      join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'
     order by 1`);
  return {
    columns: new Map(cols.rows.map((r) => [`${r.t}.${r.col}`, r.def])),
    constraints: new Map(cons.rows.map((r) => [`${r.t}:${r.name}`, r.def])),
    indexes: new Map(idx.rows.map((r) => [`${r.t}:${r.name}`, r.def])),
    enums: new Map(enums.rows.map((r) => [r.name, r.labels])),
    tables: new Set(cols.rows.map((r) => r.t)),
    publicObjects: pub.rows.map((r) => r.name),
  };
}

const SEEDED_TABLES = [
  'tenants',
  'branches',
  'core_events',
  'camp_registrations',
  'camp_attendance',
  'studio_event_bookings',
] as const;

async function rowsOf(c: pg.Client): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const t of SEEDED_TABLES) {
    const res = await c.query<{ id: string; row: Record<string, unknown> }>(
      `select id::text as id, to_jsonb(x) as row from otoapp.${t} x`,
    );
    for (const r of res.rows) out.set(`${t}:${r.id}`, r.row);
  }
  return out;
}

/**
 * Writes the previous release makes: only the columns that existed before this
 * round, exactly as the app's own forms and check-in screen leave them.
 */
async function oldReleaseWrites(c: pg.Client, ids: { tenant: string; branch: string }) {
  const event = newId();
  const camp = newId();
  const reg = newId();
  const regEmpty = newId();
  const regNull = newId();
  const regObject = newId();
  const types = ['birthday', 'private_event', 'school_group', 'other', 'studio_event', 'workshop'];
  for (const type of types) {
    await c.query(
      `insert into otoapp.core_events (tenant_id, branch_id, event_type, title, event_date, start_time,
         total_value, prepayment_amount, num_children)
       values ($1, $2, $3, $4, '2026-11-10', '10:00', 9000, 2000, 8)`,
      [ids.tenant, ids.branch, type, `Old ${type}`],
    );
  }
  await c.query(
    `insert into otoapp.core_events (id, tenant_id, branch_id, event_type, title, event_date, camp_end_date,
       camp_cancelled_days, start_time)
     values ($1, $2, $3, 'camp', 'Old camp', '2026-11-09', '2026-11-13', '["2026-11-11"]'::jsonb, '09:00')`,
    [camp, ids.tenant, ids.branch],
  );
  await c.query(
    `insert into otoapp.core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time)
     values ($1, $2, $3, 'workshop', 'Old workshop', '2026-11-09', '09:00')`,
    [event, ids.tenant, ids.branch],
  );
  const register = (id: string, days: string) =>
    c.query(
      `insert into otoapp.camp_registrations (id, tenant_id, event_id, child_full_name, date_of_birth,
         parent_guardian_name, emergency_contact_number, attendance_days, parent_signature, signature_date,
         checked_in_at)
       values ($1, $2, $3, $4, '2019-01-01', 'Nok', '+66812340000', ${days}, 'signed', '2026-11-01',
               '2026-11-09 02:00:00')`,
      [id, ids.tenant, camp, `Child ${id.slice(-4)}`],
    );
  await register(reg, `'["2026-11-09","2026-11-10"]'::jsonb`);
  await register(regEmpty, `'[]'::jsonb`);
  await register(regNull, 'null');
  await register(regObject, `'{"not":"a list"}'::jsonb`);
  await c.query(
    `insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status,
       checked_in_at, checked_in_by, payment_method)
     values ($1, $2, $3, '2026-11-09', 'checked_out', '2026-11-09 02:00:00', 'u1', 'cash'),
            ($1, $2, $3, '2026-11-10', 'waiting', null, null, null)`,
    [reg, ids.tenant, camp],
  );
  // The app's own check-in screen: an upsert on (registration, day).
  await c.query(
    `insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status,
       checked_in_at, checked_in_by)
     values ($1, $2, $3, '2026-11-10', 'checked_in', '2026-11-10 02:00:00', 'u2')
     on conflict (camp_registration_id, attendance_date)
     do update set status = 'checked_in', checked_in_at = excluded.checked_in_at,
                   checked_in_by = excluded.checked_in_by, updated_at = now()`,
    [reg, ids.tenant, camp],
  );
  await c.query(
    `insert into otoapp.studio_event_bookings (event_id, booking_name, kids_count, adults_count, kid_names)
     values ($1, 'Smith family', 2, 1, 'A, B')`,
    [event],
  );
  return { camp, event, reg, regEmpty, regNull, regObject };
}

describe('A. the OTO App migration, from a seeded live state', () => {
  let url = '';
  let drop: () => Promise<void> = async () => undefined;
  let before: Shape;
  let beforeRows: Map<string, Record<string, unknown>>;
  let liveDir = '';
  const tenant = newId();
  const mappedBranch = newId();
  const platformBranch = newId();
  let seeded: Awaited<ReturnType<typeof oldReleaseWrites>>;
  const runs: string[] = [];

  /** The app's own migrator when it can run here; else the same SQL through the same Drizzle migrator. */
  async function upgrade(): Promise<void> {
    if (HAS_APP_MODULES) {
      const out = spawnSync(process.execPath, [join(APP_DIR, 'script', 'migrate.mjs')], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
      });
      expect(out.status, out.stderr).toBe(0);
      runs.push(out.stdout.trim());
    } else {
      await applyOtoAppMigrations(url);
      runs.push('applyOtoAppMigrations');
    }
  }

  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase());
    liveDir = liveMigrationsFolder();
    await withClient(url, async (c) => {
      await c.query('set search_path to otoapp');
      await migrate(drizzle(c), { migrationsFolder: liveDir, migrationsSchema: 'otoapp' });
      await c.query('reset search_path');
      await c.query(`insert into otoapp.tenants (id, name, slug) values ($1, 'OTO', 'oto')`, [
        tenant,
      ]);
      await c.query(
        `insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
         values ($1, $2, 'Central', 'Phuket', $3)`,
        [mappedBranch, tenant, platformBranch],
      );
      seeded = await oldReleaseWrites(c, { tenant, branch: mappedBranch });
      before = await shapeOf(c);
      beforeRows = await rowsOf(c);
    });
    expect(before.tables.has('event_attendees')).toBe(false);
    await upgrade();
  });

  afterAll(async () => {
    rmSync(liveDir, { recursive: true, force: true });
    await drop();
  });

  it('applies 0003 and 0004 on the live state, then nothing on a second run', async () => {
    await upgrade();
    if (HAS_APP_MODULES) {
      expect(runs[0]).toContain('applied 0003_events_seam');
      expect(runs[0]).toContain('applied 0004_otoapp_v_views');
      // S2-17b round 2's employee view rides the same upgrade.
      expect(runs[0]).toContain('applied 0005_otoapp_v_employees');
      // And round 4a's tenant columns (s217b-r4a.test.ts proves their backfill),
      // and round 4b's contraction of them (s217b-r4b.test.ts).
      expect(runs[0]).toContain('applied 0006_tenant_ownership_expand');
      expect(runs[0]).toContain('applied 0007_tenant_ownership_contract');
      // And round 6's document tables (s217b-r6.test.ts).
      expect(runs[0]).toContain('applied 0008_document_tenant_ownership_expand');
      expect(runs[1]).toMatch(/up to date .* 9 migration/);
    }
    await withClient(url, async (c) => {
      const ledger = await c.query<{ n: string }>(
        'select count(*)::text as n from otoapp.__drizzle_migrations',
      );
      expect(ledger.rows[0]!.n).toBe('9');
    });
  });

  it('changes nothing that existed: columns, constraints, indexes, enums, and nothing in public', async () => {
    const after = await withClient(url, shapeOf);
    for (const [key, def] of before.columns) expect(after.columns.get(key), key).toBe(def);
    // The one declared exception: round 4b's 0007 drops the baseline's one-row-
    // per-key unique on settings, a release after 4a stopped relying on it
    // (expand/contract; s217b-r4b.test.ts proves the contraction).
    const contracted = new Set(['settings:settings_key_unique']);
    for (const [key, def] of before.constraints) {
      if (contracted.has(key)) expect(after.constraints.has(key), key).toBe(false);
      else expect(after.constraints.get(key), key).toBe(def);
    }
    for (const [key, def] of before.indexes) {
      if (contracted.has(key)) expect(after.indexes.has(key), key).toBe(false);
      else expect(after.indexes.get(key), key).toBe(def);
    }
    expect(after.enums).toEqual(before.enums);
    expect(after.publicObjects).toEqual(before.publicObjects);

    // The only new tables are the three of 0003.
    const newTables = [...after.tables].filter((t) => !before.tables.has(t)).sort();
    expect(newTables).toEqual(['directory_clients', 'event_attendee_checkins', 'event_attendees']);

    // Every column added to an existing table is nullable or defaulted.
    const added = [...after.columns].filter(
      ([key]) => !before.columns.has(key) && before.tables.has(key.split('.')[0]!),
    );
    expect(added.map(([k]) => k).sort()).toEqual([
      // S2-17b round 4a (0006): each nullable, backfilled, NOT NULL only in 4b.
      'activity_log.tenant_id',
      // S2-17b round 6 (0008): nullable, backfilled, NOT NULL only in round 7.
      'asset_catalog.tenant_id',
      'attention_items.tenant_id',
      'camp_attendance.checkin_ref',
      'camp_registrations.parent_attending',
      'core_events.entry_price_weekday_thb',
      'core_events.entry_price_weekend_thb',
      'leave_policies.tenant_id',
      'policy_documents.tenant_id',
      'settings.tenant_id',
      'templates.tenant_id',
    ]);
    // Round 4b's 0007 makes the three tenant columns NOT NULL, once it has placed
    // every row (they are backfilled, and the migration stops while one is left).
    const contractedColumns = new Set(['activity_log.tenant_id', 'attention_items.tenant_id', 'settings.tenant_id']);
    for (const [key, def] of added) {
      if (contractedColumns.has(key)) expect(def.includes('notnull=true'), key).toBe(true);
      else expect(def.includes('notnull=false') || !def.includes('default=<none>'), key).toBe(true);
    }
    // Nothing is added to an existing table but the one CHECK and the one
    // partial index — and, from S2-17b round 4a (0006), the three tenant
    // columns' foreign keys and indexes, settings' (tenant_id, key) unique
    // beside the baseline's settings_key_unique, which stays.
    const addedConstraints = [...after.constraints.keys()].filter(
      (k) => !before.constraints.has(k) && before.tables.has(k.split(':')[0]!),
    );
    expect(addedConstraints.sort()).toEqual([
      'activity_log:activity_log_tenant_id_tenants_id_fk',
      'asset_catalog:asset_catalog_tenant_id_tenants_id_fk',
      'attention_items:attention_items_tenant_id_tenants_id_fk',
      'core_events:core_events_entry_price_check',
      'leave_policies:leave_policies_tenant_id_tenants_id_fk',
      'policy_documents:policy_documents_tenant_id_tenants_id_fk',
      'settings:settings_tenant_id_tenants_id_fk',
      'templates:templates_tenant_id_tenants_id_fk',
    ]);
    const addedIndexes = [...after.indexes.keys()].filter(
      (k) => !before.indexes.has(k) && before.tables.has(k.split(':')[0]!),
    );
    expect(addedIndexes.sort()).toEqual([
      'activity_log:idx_activity_log_tenant',
      'asset_catalog:idx_asset_catalog_tenant',
      'attention_items:idx_attention_items_tenant',
      'camp_attendance:uq_camp_attendance_checkin_ref',
      // Round 6 (0008): the census found nobody with two offboardings here.
      'employee_offboarding:employee_offboarding_employee_unique',
      'leave_policies:idx_leave_policies_tenant',
      'policy_documents:idx_policy_documents_tenant',
      'settings:settings_tenant_id_key_unique',
      'templates:idx_templates_tenant',
    ]);
  });

  it('leaves every seeded row as it was, with the new columns null or their default', async () => {
    const afterRows = await withClient(url, rowsOf);
    expect(afterRows.size).toBe(beforeRows.size);
    for (const [key, row] of beforeRows) {
      const now = afterRows.get(key);
      expect(now, key).toBeDefined();
      for (const [col, value] of Object.entries(row))
        expect(now![col], `${key}.${col}`).toEqual(value);
      const extra = Object.keys(now!).filter((col) => !(col in row));
      for (const col of extra) {
        const expected = col === 'parent_attending' ? false : null;
        expect(now![col], `${key}.${col}`).toEqual(expected);
      }
    }
  });

  it("still takes the previous release's writes, including its check-in upsert", async () => {
    await withClient(url, async (c) => {
      await oldReleaseWrites(c, { tenant, branch: mappedBranch });
    });
  });

  it('publishes the seeded rows through the views, malformed day lists included', async () => {
    await withClient(url, async (c) => {
      const events = await c.query<{ id: string; type: string; branch_id: string }>(
        `select id, type, branch_id::text from otoapp_v.events where id = $1`,
        [seeded.camp],
      );
      expect(events.rows).toEqual([{ id: seeded.camp, type: 'camp', branch_id: platformBranch }]);
      const attendees = await c.query<{
        id: string;
        attends_all_days: boolean;
        attendance_days: string[];
      }>(
        `select id, attends_all_days, attendance_days from otoapp_v.event_attendees where event_id = $1`,
        [seeded.camp],
      );
      const byId = new Map(attendees.rows.map((r) => [r.id, r]));
      expect(byId.get(seeded.reg)).toMatchObject({
        attends_all_days: false,
        attendance_days: ['2026-11-09', '2026-11-10'],
      });
      expect(byId.get(seeded.regEmpty)?.attends_all_days).toBe(true);
      expect(byId.get(seeded.regNull)?.attends_all_days).toBe(true);
      // A day list that is not a list is no day, and does not break the read.
      expect(byId.get(seeded.regObject)).toMatchObject({
        attends_all_days: false,
        attendance_days: [],
      });
      const days = await c.query<{ attendance_date: string; status: string }>(
        `select attendance_date, status from otoapp_v.event_attendance where attendee_id = $1
          order by attendance_date`,
        [seeded.reg],
      );
      expect(days.rows).toEqual([
        { attendance_date: '2026-11-09', status: 'checked_out' },
        { attendance_date: '2026-11-10', status: 'checked_in' },
      ]);
    });
  });
});

// =============================================================================
// B, C, D share one database with the platform seed and the app's migrations
// =============================================================================

let url = '';
let drop: () => Promise<void> = async () => undefined;
let platformPool: pg.Pool;
let db: Db;
let appPool: pg.Pool;
let writes: WritesModule;
let auth: AuthModule;
let central = '';
let chalong = '';
let secondOperatorBranch = '';

const tenantA = newId();
const tenantB = newId();
const appCentral = newId();
const appChalong = newId();
const appSecond = newId();
const appUnmapped = newId();
const appJunk = newId();

const D0 = '2026-12-06';
const D1 = '2026-12-07';
const D2 = '2026-12-08';
const D3 = '2026-12-09';
const D4 = '2026-12-10';
const D5 = '2026-12-11';
const D6 = '2026-12-12';

const ev = {
  camp: newId(),
  openCamp: newId(),
  workshop: newId(),
  party: newId(),
  archived: newId(),
  unmapped: newId(),
  junk: newId(),
  crossTenant: newId(),
  campB: newId(),
  workshopB: newId(),
};

const keys = {
  a: newKey(),
  b: newKey(),
  revoked: newKey(),
  inactive: newKey(),
  noScope: newKey(),
};

async function appEvent(e: {
  id: string;
  tenant?: string;
  branch?: string;
  type: string;
  date?: string;
  campEnd?: string | null;
  archived?: boolean;
}) {
  await appPool.query(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, camp_end_date,
       start_time, is_archived)
     values ($1, $2, $3, $4, $5, $6, $7, '09:00', $8)`,
    [
      e.id,
      e.tenant ?? tenantA,
      e.branch ?? appCentral,
      e.type,
      `${e.type} ${e.id.slice(-4)}`,
      e.date ?? D1,
      e.campEnd ?? null,
      e.archived ?? false,
    ],
  );
}

const count = async (table: string, where: string, params: unknown[]) =>
  Number(
    (
      await appPool.query<{ n: string }>(
        `select count(*)::text as n from ${table} where ${where}`,
        params,
      )
    ).rows[0]!.n,
  );

async function eventFor(tenant: string, id: string): Promise<DirectoryEvent> {
  const found = await writes.findTenantEvent(appPool, tenant, id);
  if (!found) throw new Error(`no event ${id} for tenant ${tenant}`);
  return found;
}

const child = (over: Partial<AttendeeInput> = {}): AttendeeInput => ({
  id: newId(),
  childFullName: 'Ploy',
  parentAttending: false,
  attendanceDays: [],
  source: 'pos',
  ...over,
});

/**
 * Hold a row lock on one table while `work` runs, so concurrent requests are
 * forced to interleave at the lock rather than by luck; release it after `ms`.
 */
async function whileLocked<T>(
  lockSql: string,
  params: unknown[],
  work: () => Promise<T>,
  ms = 300,
) {
  const holder = await appPool.connect();
  try {
    await holder.query('begin');
    await holder.query(lockSql, params);
    const running = work();
    await new Promise((r) => setTimeout(r, ms));
    await holder.query('commit');
    return await running;
  } finally {
    holder.release();
  }
}

beforeAll(async () => {
  ({ url, drop } = await createTestDatabase({ otoapp: true }));
  platformPool = new pg.Pool({ connectionString: url });
  db = drizzle(platformPool, { schema }) as Db;
  await seed(db);
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 10 });
  writes = await loadApp<WritesModule>('server/directory/eventWrites.ts');
  auth = await loadApp<AuthModule>('server/directory/clientAuth.ts');

  central = await branchIdByCode(db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(db, CHALONG_BRANCH_CODE);
  secondOperatorBranch = await branchIdByCode(
    db,
    SECOND_OPERATOR_BRANCH_CODE,
    SECOND_OPERATOR_NAME,
  );

  await appPool.query(
    `insert into tenants (id, name, slug) values ($1, 'A', 'a-review'), ($2, 'B', 'b-review')`,
    [tenantA, tenantB],
  );
  await appPool.query(
    `insert into branches (id, tenant_id, name, address, core_branch_id) values
       ($1, $6, 'Central', 'Phuket', $7),
       ($2, $6, 'Chalong', 'Phuket', $8),
       ($3, $10, 'Second', 'Bangkok', $9),
       ($4, $6, 'Head Office', 'Phuket', null),
       ($5, $6, 'Junk', 'Phuket', 'HKT-CENTRAL')`,
    [
      appCentral,
      appChalong,
      appSecond,
      appUnmapped,
      appJunk,
      tenantA,
      central,
      chalong,
      secondOperatorBranch,
      tenantB,
    ],
  );

  await appEvent({ id: ev.camp, type: 'camp', campEnd: D5 });
  await appEvent({ id: ev.openCamp, type: 'camp', campEnd: null });
  await appEvent({ id: ev.workshop, type: 'workshop' });
  await appEvent({ id: ev.party, type: 'birthday' });
  await appEvent({ id: ev.archived, type: 'workshop', archived: true });
  await appEvent({ id: ev.unmapped, type: 'workshop', branch: appUnmapped });
  await appEvent({ id: ev.junk, type: 'workshop', branch: appJunk });
  // Tenant A's event pointed at tenant B's (mapped) branch: the view's tenant join must drop it.
  await appEvent({ id: ev.crossTenant, type: 'workshop', branch: appSecond });
  await appEvent({ id: ev.campB, tenant: tenantB, branch: appSecond, type: 'camp', campEnd: D5 });
  await appEvent({ id: ev.workshopB, tenant: tenantB, branch: appSecond, type: 'workshop' });

  await appPool.query(
    `insert into directory_clients (tenant_id, name, key_hash, scopes, is_active, revoked_at) values
       ($1, 'pos-a', $3, '{events:write}', true, null),
       ($2, 'pos-b', $4, '{events:write}', true, null),
       ($1, 'revoked', $5, '{events:write}', false, now()),
       ($1, 'inactive', $6, '{events:write}', false, null),
       ($1, 'no-scope', $7, '{}', true, null)`,
    [
      tenantA,
      tenantB,
      hashKey(keys.a),
      hashKey(keys.b),
      hashKey(keys.revoked),
      hashKey(keys.inactive),
      hashKey(keys.noScope),
    ],
  );
});

afterAll(async () => {
  await appPool?.end();
  await platformPool?.end();
  await drop();
  await teardownAll();
});

// =============================================================================
// B. The views
// =============================================================================

describe('B. the otoapp_v views over seeded rows', () => {
  it('maps EVERY value of the app enum per Q10, and the enum holds no type the mapping has not met', async () => {
    const labels = (
      await appPool.query<{ v: string }>(
        `select unnest(enum_range(null::core_event_type))::text as v`,
      )
    ).rows.map((r) => r.v);
    const Q10: Record<string, string> = {
      birthday: 'party',
      private_event: 'party',
      school_group: 'party',
      camp: 'camp',
      other: 'event',
      studio_event: 'event',
      workshop: 'event',
    };
    // A new app type would fall to 'event' silently; this is where it is caught.
    expect([...labels].sort()).toEqual(Object.keys(Q10).sort());
    const day = '2027-01-15';
    const made = new Map<string, string>();
    for (const label of labels) {
      const id = newId();
      made.set(id, label);
      await appEvent({ id, type: label, date: day, campEnd: label === 'camp' ? day : null });
    }
    // The open-ended camp of the shared fixture is on this day too; only the ones made here count.
    const listed = (await listBranchEvents(db, { branchId: central, from: day, to: day })).filter(
      (e) => made.has(e.id),
    );
    expect(listed).toHaveLength(labels.length);
    for (const e of listed) {
      const label = made.get(e.id)!;
      expect(e.appEventType).toBe(label);
      expect(e.type, label).toBe(Q10[label]);
    }
  });

  it('lists a camp on every day of its range, cancelled day included, and on no day outside it', async () => {
    for (const day of [D1, D2, D3, D4, D5]) {
      const ids = (await listBranchEvents(db, { branchId: central, from: day, to: day })).map(
        (e) => e.id,
      );
      expect(ids, day).toContain(ev.camp);
    }
    for (const day of [D0, D6]) {
      const ids = (await listBranchEvents(db, { branchId: central, from: day, to: day })).map(
        (e) => e.id,
      );
      expect(ids, day).not.toContain(ev.camp);
    }
    // An open-ended camp (no end date, the app's reading) runs on from its first day.
    const far = await listBranchEvents(db, {
      branchId: central,
      from: '2027-06-01',
      to: '2027-06-01',
    });
    expect(far.map((e) => e.id)).toContain(ev.openCamp);
    const early = await listBranchEvents(db, { branchId: central, from: D0, to: D0 });
    expect(early.map((e) => e.id)).not.toContain(ev.openCamp);
    // A one-day event is on its day only.
    const later = await listBranchEvents(db, { branchId: central, from: D2, to: D2 });
    expect(later.map((e) => e.id)).not.toContain(ev.workshop);
  });

  it('a camp child is on each of its registered days, and its check-in reaches the view', async () => {
    const camp = await eventFor(tenantA, ev.camp);
    const kid = child({
      childFullName: 'Day kid',
      parentPhone: '+66811110001',
      attendanceDays: [D2, D4],
    });
    const made = await writes.createEventAttendee(appPool, camp, kid);
    expect(made.status).toBe(201);
    const attendees = await listEventAttendees(db, { branchId: central, eventId: ev.camp });
    expect(attendees.find((a) => a.id === kid.id)).toMatchObject({
      attendanceDays: [D2, D4],
      attendsAllDays: false,
      isOneTime: true,
    });
    const days = (await listEventAttendance(db, { branchId: central, eventId: ev.camp }))
      .filter((a) => a.attendeeId === kid.id)
      .map((a) => [a.attendanceDate, a.status]);
    expect(days).toEqual([
      [D2, 'waiting'],
      [D4, 'waiting'],
    ]);
    const ref = newId();
    const done = await writes.recordAttendeeCheckin(appPool, camp, kid.id, { id: ref, date: D4 });
    expect(done.status).toBe(201);
    const d4 = await listEventAttendance(db, { branchId: central, eventId: ev.camp, date: D4 });
    expect(d4.find((a) => a.attendeeId === kid.id)).toMatchObject({
      status: 'checked_in',
      checkinRef: ref,
    });
  });

  it('the branch seam: an unmapped, a malformed or a cross-tenant app branch has no rows anywhere', async () => {
    const all = (await appPool.query<{ id: string }>(`select id from otoapp_v.events`)).rows.map(
      (r) => r.id,
    );
    expect(all).not.toContain(ev.unmapped);
    expect(all).not.toContain(ev.junk);
    expect(all).not.toContain(ev.crossTenant);
    // Tenant B's own events are mapped to B's platform branch, never to A's.
    expect(await getBranchEvent(db, { branchId: central, eventId: ev.campB })).toBeNull();
    expect(
      await getBranchEvent(db, { branchId: secondOperatorBranch, eventId: ev.campB }),
    ).not.toBeNull();
    // A child added to an unmapped event through the directory is invisible to every POS read.
    const unmapped = await eventFor(tenantA, ev.unmapped);
    const kid = child({ childFullName: 'Hidden' });
    expect((await writes.createEventAttendee(appPool, unmapped, kid)).status).toBe(201);
    for (const view of ['event_attendees', 'children']) {
      const rows = await appPool.query(`select 1 from otoapp_v.${view} where id = $1`, [kid.id]);
      expect(rows.rowCount, view).toBe(0);
    }
    for (const branchId of [central, chalong, secondOperatorBranch]) {
      expect(await listEventAttendees(db, { branchId, eventId: ev.unmapped })).toEqual([]);
      expect(await listSeamChildren(db, { branchId, ids: [kid.id] })).toEqual([]);
    }
  });
});

// =============================================================================
// C. The directory writes
// =============================================================================

describe('C. the directory writes: identity, replay, tenant fence, bad input', () => {
  async function authenticate(header?: string) {
    const res: FakeRes = {
      statusCode: 0,
      body: undefined,
      headers: {},
      locals: {},
      status(code) {
        res.statusCode = code;
        return res;
      },
      json(body) {
        res.body = body;
        return res;
      },
      setHeader(name, value) {
        res.headers[name] = value;
      },
    };
    let passed = false;
    await auth.requireDirectoryClient(appPool, 'events:write')(
      { headers: header === undefined ? {} : { authorization: header } },
      res,
      (err) => {
        if (err) throw err;
        passed = true;
      },
    );
    return {
      outcome: passed ? 'next' : res.statusCode,
      client: res.locals.directoryClient as { tenantId: string } | undefined,
    };
  }

  it('the key alone names the tenant; no, unknown, revoked, inactive and scopeless keys are refused', async () => {
    expect(auth.hashDirectoryKey(keys.a)).toBe(hashKey(keys.a));
    expect(await authenticate()).toMatchObject({ outcome: 401 });
    expect(await authenticate(`Basic ${keys.a}`)).toMatchObject({ outcome: 401 });
    expect(await authenticate(`Bearer ${newKey()}`)).toMatchObject({ outcome: 403 });
    expect(await authenticate(`Bearer ${keys.revoked}`)).toMatchObject({ outcome: 403 });
    expect(await authenticate(`Bearer ${keys.inactive}`)).toMatchObject({ outcome: 403 });
    expect(await authenticate(`Bearer ${keys.noScope}`)).toMatchObject({ outcome: 403 });
    // The hash itself is not a key.
    expect(await authenticate(`Bearer ${hashKey(keys.a)}`)).toMatchObject({ outcome: 403 });
    const a = await authenticate(`Bearer ${keys.a}`);
    expect(a.outcome).toBe('next');
    expect(a.client?.tenantId).toBe(tenantA);
    expect((await authenticate(`Bearer ${keys.b}`)).client?.tenantId).toBe(tenantB);
  });

  it("a second tenant's identity cannot find the first tenant's events, archived ones are gone too", async () => {
    expect(await writes.findTenantEvent(appPool, tenantB, ev.camp)).toBeNull();
    expect(await writes.findTenantEvent(appPool, tenantB, ev.workshop)).toBeNull();
    expect(await writes.findTenantEvent(appPool, tenantA, ev.campB)).toBeNull();
    expect(await writes.findTenantEvent(appPool, tenantA, ev.archived)).toBeNull();
    expect(await writes.findTenantEvent(appPool, tenantA, 'not-a-uuid')).toBeNull();
    expect(await writes.findTenantEvent(appPool, tenantA, ev.workshop)).toMatchObject({
      isCamp: false,
    });
  });

  it('a replayed attendee POST makes one row, for a one-off event and for a camp', async () => {
    const workshop = await eventFor(tenantA, ev.workshop);
    const kid = child({ childFullName: 'Replay one-off' });
    const first = await writes.createEventAttendee(appPool, workshop, kid);
    const again = await writes.createEventAttendee(appPool, workshop, kid);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body?.replayed).toBe(true);
    expect(await count('event_attendees', 'id = $1', [kid.id])).toBe(1);

    const camp = await eventFor(tenantA, ev.camp);
    const campKid = child({ childFullName: 'Replay camp', attendanceDays: [D1, D2] });
    const c1 = await writes.createEventAttendee(appPool, camp, campKid);
    const c2 = await writes.createEventAttendee(appPool, camp, {
      ...campKid,
      attendanceDays: [D1, D2, D3],
    });
    expect([c1.status, c2.status]).toEqual([201, 200]);
    expect(c2.body?.replayed).toBe(true);
    // A replay answers what was made; it does not edit it.
    expect(c2.body?.attendee?.attendanceDays).toEqual([D1, D2]);
    expect(await count('camp_registrations', 'id = $1', [campKid.id])).toBe(1);
    expect(await count('camp_attendance', 'camp_registration_id = $1', [campKid.id])).toBe(2);
  });

  it('copies of one attendee POST racing at an insert lock still make one row', async () => {
    const workshop = await eventFor(tenantA, ev.workshop);
    const kid = child({ childFullName: 'Racing one-off' });
    const results = await whileLocked(
      'lock table event_attendees in share row exclusive mode',
      [],
      () => Promise.all([1, 2, 3].map(() => writes.createEventAttendee(appPool, workshop, kid))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(results.filter((r) => r.body?.replayed).length).toBe(2);
    expect(await count('event_attendees', 'id = $1', [kid.id])).toBe(1);

    const camp = await eventFor(tenantA, ev.camp);
    const campKid = child({
      childFullName: 'Racing camp',
      parentPhone: '+66811110002',
      attendanceDays: [D3],
    });
    const campResults = await whileLocked(
      'lock table camp_registrations in share row exclusive mode',
      [],
      () => Promise.all([1, 2, 3].map(() => writes.createEventAttendee(appPool, camp, campKid))),
    );
    expect(campResults.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await count('camp_registrations', 'id = $1', [campKid.id])).toBe(1);
    expect(await count('camp_attendance', 'camp_registration_id = $1', [campKid.id])).toBe(1);
  });

  it("an id another tenant's attendee holds is refused, and neither tenant's rows change", async () => {
    const workshopA = await eventFor(tenantA, ev.workshop);
    const workshopB = await eventFor(tenantB, ev.workshopB);
    const kid = child({ childFullName: 'Owned by A', allergies: 'Peanuts' });
    expect((await writes.createEventAttendee(appPool, workshopA, kid)).status).toBe(201);
    const stolen = await writes.createEventAttendee(appPool, workshopB, {
      ...kid,
      childFullName: 'Taken by B',
      allergies: null,
    });
    expect(stolen).toMatchObject({ ok: false, status: 409, error: 'id_in_use' });
    const row = await appPool.query<{
      tenant_id: string;
      child_full_name: string;
      allergies: string;
    }>(`select tenant_id, child_full_name, allergies from event_attendees where id = $1`, [kid.id]);
    expect(row.rows).toEqual([
      { tenant_id: tenantA, child_full_name: 'Owned by A', allergies: 'Peanuts' },
    ]);
    // Tenant B checking in A's attendee under B's own event: not found, nothing written.
    const checkin = newId();
    const out = await writes.recordAttendeeCheckin(appPool, workshopB, kid.id, {
      id: checkin,
      date: D1,
    });
    expect(out).toMatchObject({ status: 404, error: 'attendee_not_found' });
    expect(await count('event_attendee_checkins', 'attendee_id = $1', [kid.id])).toBe(0);
  });

  it('a bad body writes nothing', async () => {
    const camp = await eventFor(tenantA, ev.camp);
    const workshop = await eventFor(tenantA, ev.workshop);
    const tries: [DirectoryEvent, AttendeeInput, number, string][] = [
      [camp, child({ attendanceDays: [] }), 400, 'attendance_days_required'],
      [workshop, child({ attendanceDays: [D1] }), 400, 'attendance_days_not_applicable'],
      [camp, child({ attendanceDays: [D1], bookingId: newId() }), 400, 'booking_not_applicable'],
      [workshop, child({ bookingId: newId() }), 404, 'booking_not_found'],
    ];
    for (const [event, input, status, error] of tries) {
      const out = await writes.createEventAttendee(appPool, event, input);
      expect(out, error).toMatchObject({ ok: false, status, error });
      expect(await count('event_attendees', 'id = $1', [input.id])).toBe(0);
      expect(await count('camp_registrations', 'id = $1', [input.id])).toBe(0);
      expect(await count('camp_attendance', 'camp_registration_id = $1', [input.id])).toBe(0);
    }
    // A check-in for an attendee that is not on the event, or an id that is not one.
    const out = await writes.recordAttendeeCheckin(appPool, workshop, 'nope', {
      id: newId(),
      date: D1,
    });
    expect(out.status).toBe(404);
  });

  it("the app's camp merge rule: same name and phone merges the days, the new id is stored nowhere", async () => {
    const camp = await eventFor(tenantA, ev.camp);
    const first = child({
      childFullName: 'Merge Kid',
      parentPhone: '+66811110003',
      attendanceDays: [D1],
    });
    expect((await writes.createEventAttendee(appPool, camp, first)).status).toBe(201);
    const second = child({
      childFullName: '  merge kid ',
      parentPhone: '+66811110003',
      attendanceDays: [D1, D5],
    });
    const out = await writes.createEventAttendee(appPool, camp, second);
    expect(out).toMatchObject({ status: 200, body: { merged: true, replayed: false } });
    expect(out.body?.attendee?.id).toBe(first.id);
    expect(out.body?.attendee?.attendanceDays).toEqual([D1, D5]);
    expect(await count('camp_registrations', 'id = $1', [second.id])).toBe(0);
    expect(await count('camp_attendance', 'camp_registration_id = $1', [first.id])).toBe(2);
  });

  it('a replayed check-in answers the stored row; another id for the day, or the id for another day, is refused', async () => {
    const workshop = await eventFor(tenantA, ev.workshop);
    const kid = child({ childFullName: 'Checkin one-off' });
    await writes.createEventAttendee(appPool, workshop, kid);
    const ref = newId();
    const first = await writes.recordAttendeeCheckin(appPool, workshop, kid.id, {
      id: ref,
      date: D1,
    });
    const again = await writes.recordAttendeeCheckin(appPool, workshop, kid.id, {
      id: ref,
      date: D1,
    });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body?.replayed).toBe(true);
    const other = await writes.recordAttendeeCheckin(appPool, workshop, kid.id, {
      id: newId(),
      date: D1,
    });
    expect(other).toMatchObject({ status: 409, error: 'already_checked_in' });
    const moved = await writes.recordAttendeeCheckin(appPool, workshop, kid.id, {
      id: ref,
      date: D2,
    });
    expect(moved).toMatchObject({ status: 409, error: 'id_in_use' });
    expect(await count('event_attendee_checkins', 'attendee_id = $1', [kid.id])).toBe(1);
  });

  it('two tills checking the same camp child in with different ids: one wins, one is refused', async () => {
    const camp = await eventFor(tenantA, ev.camp);
    const kid = child({ childFullName: 'Two tills', attendanceDays: [D2] });
    await writes.createEventAttendee(appPool, camp, kid);
    const results = await whileLocked(
      `select 1 from camp_attendance where camp_registration_id = $1 for update`,
      [kid.id],
      () =>
        Promise.all(
          [newId(), newId()].map((id) =>
            writes.recordAttendeeCheckin(appPool, camp, kid.id, { id, date: D2 }),
          ),
        ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await count('camp_attendance', 'camp_registration_id = $1', [kid.id])).toBe(1);
  });

  it("a check-in retried while the first copy still holds the day's row is answered as a replay", async () => {
    // The box sends, times out, and sends the same check-in again while the
    // first is still in flight. Both copies pass the replay lookup before the
    // first commits and then queue on the waiting row's lock. Same id, so the
    // second must be a replay, not "already checked in" — otherwise the POS's
    // write-back records a refusal for a check-in that succeeded.
    const camp = await eventFor(tenantA, ev.camp);
    const kid = child({ childFullName: 'Retried in flight', attendanceDays: [D3] });
    await writes.createEventAttendee(appPool, camp, kid);
    const ref = newId();
    const results = await whileLocked(
      `select 1 from camp_attendance where camp_registration_id = $1 for update`,
      [kid.id],
      () =>
        Promise.all(
          [1, 2].map(() =>
            writes.recordAttendeeCheckin(appPool, camp, kid.id, { id: ref, date: D3 }),
          ),
        ),
    );
    const summary = results.map((r) => `${r.status}${r.error ? ` ${r.error}` : ''}`).sort();
    expect(summary).toEqual(['200', '201']);
    expect(results.find((r) => r.status === 200)?.body?.replayed).toBe(true);
    expect(await count('camp_attendance', 'checkin_ref = $1', [ref])).toBe(1);
  });

  describe.skipIf(!HAS_EXPRESS)(
    'over HTTP, through the mounted router (needs the app node_modules)',
    () => {
      let server: Server;
      let base = '';

      beforeAll(async () => {
        const require = createRequire(join(APP_DIR, 'package.json'));
        const express = require('express') as ExpressModule;
        const routes = await loadApp<{ directoryEventRouter(pool: pg.Pool): unknown }>(
          'server/directory/eventRoutes.ts',
        );
        const app = express();
        app.use(express.json());
        app.use(routes.directoryEventRouter(appPool));
        await new Promise<void>((resolve) => {
          server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      });

      afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
      });

      async function post(path: string, body: unknown, key: string | null = keys.a) {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      }

      it("tenant B's key on tenant A's event is 404 and writes nothing, for an add and a check-in", async () => {
        const id = newId();
        const add = await post(
          `/api/directory/events/${ev.workshop}/attendees`,
          { id, childFullName: 'X' },
          keys.b,
        );
        expect(add).toMatchObject({ status: 404, body: { error: 'event_not_found' } });
        expect(await count('event_attendees', 'id = $1', [id])).toBe(0);
        const campAdd = await post(
          `/api/directory/events/${ev.camp}/attendees`,
          { id, childFullName: 'X', attendanceDays: [D1] },
          keys.b,
        );
        expect(campAdd.status).toBe(404);
        expect(await count('camp_registrations', 'id = $1', [id])).toBe(0);

        const mine = newId();
        expect(
          (
            await post(`/api/directory/events/${ev.camp}/attendees`, {
              id: mine,
              childFullName: 'HTTP camp',
              attendanceDays: [D1],
            })
          ).status,
        ).toBe(201);
        const ref = newId();
        const theirs = await post(
          `/api/directory/events/${ev.camp}/attendees/${mine}/checkins`,
          { id: ref, date: D1 },
          keys.b,
        );
        expect(theirs.status).toBe(404);
        const day = await appPool.query<{ status: string; checkin_ref: string | null }>(
          `select status::text, checkin_ref from camp_attendance where camp_registration_id = $1`,
          [mine],
        );
        expect(day.rows).toEqual([{ status: 'waiting', checkin_ref: null }]);
      });

      it('a replay over HTTP makes one row', async () => {
        const id = newId();
        const body = { id, childFullName: 'HTTP replay', parentAttending: true };
        const a = await post(`/api/directory/events/${ev.party}/attendees`, body);
        const b = await post(`/api/directory/events/${ev.party}/attendees`, body);
        expect([a.status, b.status]).toEqual([201, 200]);
        expect(b.body.replayed).toBe(true);
        expect(await count('event_attendees', 'id = $1', [id])).toBe(1);
      });

      it('no key is 401, a revoked or scopeless key is 403, and none of them writes', async () => {
        const id = newId();
        const body = { id, childFullName: 'Nobody' };
        expect(
          (await post(`/api/directory/events/${ev.workshop}/attendees`, body, null)).status,
        ).toBe(401);
        expect(
          (await post(`/api/directory/events/${ev.workshop}/attendees`, body, keys.revoked)).status,
        ).toBe(403);
        expect(
          (await post(`/api/directory/events/${ev.workshop}/attendees`, body, keys.noScope)).status,
        ).toBe(403);
        expect(await count('event_attendees', 'id = $1', [id])).toBe(0);
      });

      it('a bad body is 400 and writes nothing; a tenant named in the body is refused, not obeyed', async () => {
        const bad: Record<string, unknown>[] = [
          { id: 'not-a-uuid', childFullName: 'X' },
          { id: newId(), childFullName: '   ' },
          { id: newId(), childFullName: 'X', dateOfBirth: '2020-02-30' },
          { id: newId(), childFullName: 'X', ageYears: -1 },
          { id: newId(), childFullName: 'X', source: 'otoapp' },
          { id: newId(), childFullName: 'X', tenantId: tenantB },
          { id: newId(), childFullName: 'X', eventId: ev.workshopB },
        ];
        for (const body of bad) {
          const out = await post(`/api/directory/events/${ev.workshop}/attendees`, body);
          expect(out.status, JSON.stringify(body)).toBe(400);
          if (typeof body.id === 'string' && /^[0-9a-f-]{36}$/.test(body.id)) {
            expect(await count('event_attendees', 'id = $1', [body.id])).toBe(0);
          }
        }
        const kid = newId();
        await post(`/api/directory/events/${ev.workshop}/attendees`, {
          id: kid,
          childFullName: 'Bad checkins',
        });
        const badCheckins: Record<string, unknown>[] = [
          { id: newId(), date: '07/12/2026' },
          { id: newId(), date: '2026-13-01' },
          { id: 'x', date: D1 },
          { id: newId(), date: D1, checkedInAt: 'yesterday' },
          { id: newId(), date: D1, status: 'checked_out' },
        ];
        for (const body of badCheckins) {
          const out = await post(
            `/api/directory/events/${ev.workshop}/attendees/${kid}/checkins`,
            body,
          );
          expect(out.status, JSON.stringify(body)).toBe(400);
        }
        expect(await count('event_attendee_checkins', 'attendee_id = $1', [kid])).toBe(0);
      });
    },
  );
});

// =============================================================================
// D. H1: the POS reads events through otoapp_v only, and only reads
// =============================================================================

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const REPOSITORY = 'services/otoapp-events.ts';
/** S2-17b round 2: the read-only window on the app's staff, `otoapp_v.employees` only. */
const EMPLOYEE_REPOSITORY = 'services/otoapp-employees.ts';

/**
 * S2-17b round 2 (H19) — THE DECLARED SEAMS, the only app tables the
 * platform may name, each with its reason:
 *
 *  - provisioning and the sign-on: `users`, `user_branch_access`;
 *  - the branch seam (SCRUM-268): `branches`;
 *  - the booth's day roster (SCRUM-473, Q11): the rota tables it walks, and
 *    `employees` for one column only (`user_id`, the unmatched reason) — who
 *    a person is comes from `otoapp_v.employees`.
 *
 * Everything else of the HR record and the rota is the app's: read through a
 * view or not at all.
 */
const DECLARED_SEAMS = [
  'users',
  'user_branch_access',
  'branches',
  'schedule_assignments',
  'schedule_shift_rows',
  'shift_groups',
  'departments',
  'roles',
  'schedule_shift_row_roles',
  'duty_blocks',
  'duty_types',
  'employees',
  'casual_workers',
].sort();
/** The booth seam's tables: imported by the roster reader and nothing else. */
const BOOTH_SEAM = [
  'schedule_assignments',
  'schedule_shift_rows',
  'shift_groups',
  'departments',
  'roles',
  'schedule_shift_row_roles',
  'duty_blocks',
  'duty_types',
  'employees',
  'casual_workers',
];
const BOOTH_READER = 'services/booth-duty.ts';

/** The app's HR and rota tables, read from its own migrations rather than a hand-kept list. */
function appHrAndRotaTables(): string[] {
  const sqlText = readdirSync(APP_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(APP_MIGRATIONS, f), 'utf8'))
    .join('\n');
  const tables = [...sqlText.matchAll(/CREATE TABLE "([a-z_0-9]+)"/g)].map((m) => m[1]!);
  return [
    ...new Set(
      tables.filter((t) =>
        /^(employees|employee_[a-z_]+|people|access_policies|payroll_[a-z_]+|payslips|salary_advance[a-z_]*|statutory_[a-z_]+|contract_instances|employee_letters|schedule_[a-z_]+|shift_groups|shifts|duty_[a-z_]+|casual_workers|time_events|time_entries|time_adjustments|timekeeping_issues|employee_time_off|leave_policies|sick_leave_policies)$/.test(
          t,
        ),
      ),
    ),
  ].sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every table of the app's events module, read from its own migrations rather than a hand-kept list. */
function appEventTables(): string[] {
  const sqlText = readdirSync(APP_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(APP_MIGRATIONS, f), 'utf8'))
    .join('\n');
  const tables = [...sqlText.matchAll(/CREATE TABLE "([a-z_0-9]+)"/g)].map((m) => m[1]!);
  return tables.filter((t) =>
    /^(core_events|camp_|beo_|studio_event|rsvp_|event_|birthday_|guest_invite|branch_events)/.test(
      t,
    ),
  );
}

describe('D. H1: the POS reads OTO App events through otoapp_v only', () => {
  const files = sourceFiles(SRC).map((path) => ({
    file: relative(SRC, path).split('\\').join('/'),
    text: code(readFileSync(path, 'utf8')),
  }));

  it('no file in apps/api/src names ANY table of the app events module', () => {
    const tables = appEventTables();
    expect(tables.length).toBeGreaterThan(30);
    expect(tables).toEqual(
      expect.arrayContaining([
        'core_events',
        'camp_registrations',
        'camp_attendance',
        'event_attendees',
        'event_attendee_checkins',
        'studio_event_bookings',
        'beo_event_billing',
        'rsvp_entries',
      ]),
    );
    const pattern = new RegExp(`(?<!otoapp_v\\.)\\b(?:otoapp\\.)?(${tables.join('|')})\\b`, 'g');
    const hits = files.flatMap(({ file, text }) =>
      [...text.matchAll(pattern)].map((m) => `${file}: ${m[0]}`),
    );
    expect(hits).toEqual([]);
  });

  it('every otoapp.* relation the api names is one of the HR/identity seams, never an event table', () => {
    const named = new Set(
      files.flatMap(({ text }) => [...text.matchAll(/\botoapp\.([a-z_]+)\b/g)].map((m) => m[1]!)),
    );
    const events = new Set(appEventTables());
    expect([...named].filter((t) => events.has(t))).toEqual([]);
  });

  it('only the repositories name otoapp_v, and no packages/db schema declares an app event table', () => {
    // S2-17b round 2: the employee repository beside the events one.
    expect(
      files
        .filter(({ text }) => /\botoapp_v\b/.test(text))
        .map((f) => f.file)
        .sort(),
    ).toEqual([EMPLOYEE_REPOSITORY, REPOSITORY].sort());
    const schemaDir = fileURLToPath(new URL('../../../packages/db/src/schema', import.meta.url));
    const events = appEventTables();
    for (const f of readdirSync(schemaDir).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(join(schemaDir, f), 'utf8');
      const declared = [...text.matchAll(/\.table\(\s*'([a-z_]+)'/g)].map((m) => m[1]!);
      expect(
        declared.filter((t) => events.includes(t)),
        f,
      ).toEqual([]);
    }
  });

  // --- S2-17b round 2 (H19): the HR and rota tables, apart from the declared seams ---

  it('no file in apps/api/src names an app HR or rota table in SQL, qualified or not', () => {
    const tables = appHrAndRotaTables();
    expect(tables).toEqual(
      expect.arrayContaining([
        'employees',
        'employee_payroll_profiles',
        'employee_changes',
        'people',
        'access_policies',
        'contract_instances',
        'payslips',
        'schedule_assignments',
        'duty_blocks',
        'casual_workers',
        'employee_time_off',
      ]),
    );
    const qualified = new RegExp(`\\botoapp\\.(${tables.join('|')})\\b`, 'g');
    const unqualified = new RegExp(
      `\\b(?:from|join|into|update)\\s+"?(?:otoapp\\.)?"?(${tables.join('|')})"?\\b`,
      'gi',
    );
    const hits = files.flatMap(({ file, text }) => [
      ...[...text.matchAll(qualified)].map((m) => `${file}: ${m[0]}`),
      ...[...text.matchAll(unqualified)].map((m) => `${file}: ${m[0]}`),
    ]);
    expect(hits, 'an app HR or rota table named in SQL outside a view').toEqual([]);
  });

  it('packages/db declares exactly the declared seams of the app, and nothing more of its HR record', () => {
    const declarations = readFileSync(
      fileURLToPath(new URL('../../../packages/db/src/schema/otoapp.ts', import.meta.url)),
      'utf8',
    );
    const declared = [...declarations.matchAll(/otoapp\.table\(\s*'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...declared].sort()).toEqual(DECLARED_SEAMS);
    // The roster's `employees` carries one column: who a person is is the view's.
    const employees = /otoapp\.table\(\s*'employees',\s*\{([\s\S]*?)\n\}\);/.exec(declarations);
    expect(employees, 'the employees declaration').not.toBeNull();
    const columns = [...employees![1]!.matchAll(/\b(?:varchar|text|uuid|boolean|timestamp)\('([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(columns.sort()).toEqual(['id', 'user_id']);
  });

  it('the booth seam’s declarations are imported by the roster reader alone', () => {
    const declarations = readFileSync(
      fileURLToPath(new URL('../../../packages/db/src/schema/otoapp.ts', import.meta.url)),
      'utf8',
    );
    const symbols = [
      ...declarations.matchAll(/export const (\w+) = otoapp\.table\(\s*'([a-z_]+)'/g),
    ].flatMap((m) => (BOOTH_SEAM.includes(m[2]!) ? [m[1]!] : []));
    expect(symbols).toHaveLength(BOOTH_SEAM.length);
    for (const symbol of symbols) {
      const users = files
        .filter(({ text }) => new RegExp(`\\b${symbol}\\b`).test(text))
        .map((f) => f.file);
      expect(users, symbol).toEqual([BOOTH_READER]);
    }
  });

  it('the employee repository reads otoapp_v.employees and nothing else, and writes nothing', () => {
    const repo = files.find((f) => f.file === EMPLOYEE_REPOSITORY)!.text;
    const relations = [...repo.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)]
      .map((m) => m[1]!)
      .filter((name) => !/^['"]/.test(name));
    expect(relations.length).toBeGreaterThanOrEqual(2);
    for (const relation of relations) expect(relation).toBe('otoapp_v.employees');
    expect(repo).not.toMatch(
      /\b(insert\s+into|update\s+\w|delete\s+from|truncate|merge\s+into|alter\s+|create\s+|drop\s+)/i,
    );
    expect(repo).not.toMatch(/from '@oto\/db'/);
  });

  it('the repository runs entirely inside a READ ONLY transaction', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const exec = tx;
      await listBranchEvents(exec, { branchId: central, from: D0, to: D6 });
      await getBranchEvent(exec, { branchId: central, eventId: ev.camp });
      await listEventAttendees(exec, { branchId: central, eventId: ev.camp });
      await listEventAttendance(exec, { branchId: central, eventId: ev.camp });
      await listEventAttendance(exec, { branchId: central, eventId: ev.camp, date: D2 });
      await listSeamChildren(exec, { branchId: central, ids: [ev.camp] });
    });
  });
});
