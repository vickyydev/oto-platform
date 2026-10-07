import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import {
  OtoAppSeamNotGrantedError,
  listBranchEvents,
  otoAppEventsInstalled,
} from '../src/services/otoapp-events';
import {
  CENTRAL_BRANCH_CODE,
  branchIdByCode,
  createTestContext,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * Re-check of lane H round 0 after its fix round (events-kiosk PLAN s8;
 * SCRUM-217), beside `g17-round0-review.test.ts`:
 *
 *  E. The in-flight replay fix under the interleavings the first review did not
 *     force: two copies of a one-off check-in held at the INSERT (no seeded
 *     row, so the new "row already carries this id" branch is not the path),
 *     with the ids in different cases; and three requests at one camp waiting
 *     row, two of them copies of one check-in.
 *  F. The grants check answers with a JavaScript error, never a Postgres one,
 *     so a transaction that asked is still usable afterwards.
 *  G. H1 over the app's events module as its own foreign keys define it: every
 *     table that hangs off `core_events` (directly or through another event
 *     table), not only those whose names start with an event prefix.
 */

const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_MIGRATIONS = join(APP_DIR, 'migrations');

interface DirectoryEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
interface Outcome {
  ok: boolean;
  status: number;
  error?: string;
  body?: { replayed?: boolean; checkin?: { checkinRef: string | null; status: string } };
}
interface WritesModule {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<DirectoryEvent | null>;
  createEventAttendee(
    pool: pg.Pool,
    event: DirectoryEvent,
    input: {
      id: string;
      childFullName: string;
      parentAttending: boolean;
      attendanceDays: string[];
      source: 'pos';
    },
  ): Promise<Outcome>;
  recordAttendeeCheckin(
    pool: pg.Pool,
    event: DirectoryEvent,
    attendeeId: string,
    input: { id: string; date: string },
  ): Promise<Outcome>;
}

let ctx: TestContext;
let appPool: pg.Pool;
let writes: WritesModule;
let central = '';
const tenant = newId();
const appCentral = newId();
const ev = { workshop: newId(), camp: newId() };
const D1 = '2026-12-14';
const D2 = '2026-12-15';
const D3 = '2026-12-16';

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  const { connectionString } = (ctx.db as unknown as { $client: pg.Pool }).$client.options;
  appPool = new pg.Pool({ connectionString, options: '-c search_path=otoapp', max: 10 });
  writes = (await import(
    /* @vite-ignore */ pathToFileURL(join(APP_DIR, 'server/directory/eventWrites.ts')).href
  )) as WritesModule;
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  await appPool.query(`insert into tenants (id, name, slug) values ($1, 'OTO', 'oto-review-2')`, [
    tenant,
  ]);
  await appPool.query(
    `insert into branches (id, tenant_id, name, address, core_branch_id)
     values ($1, $2, 'Central', 'Phuket', $3)`,
    [appCentral, tenant, central],
  );
  await appPool.query(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time)
     values ($1, $3, $4, 'workshop', 'Review workshop', $5, null, '09:00'),
            ($2, $3, $4, 'camp', 'Review camp', $5, $6, '09:00')`,
    [ev.workshop, ev.camp, tenant, appCentral, D1, D3],
  );
});

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

const kid = (attendanceDays: string[]) => ({
  id: newId(),
  childFullName: `Review ${newId().slice(-4)}`,
  parentAttending: false,
  attendanceDays,
  source: 'pos' as const,
});

const count = async (table: string, where: string, params: unknown[]) =>
  Number(
    (
      await appPool.query<{ n: string }>(
        `select count(*)::text as n from ${table} where ${where}`,
        params,
      )
    ).rows[0]!.n,
  );

async function whileLocked<T>(lockSql: string, params: unknown[], work: () => Promise<T>) {
  const holder = await appPool.connect();
  try {
    await holder.query('begin');
    await holder.query(lockSql, params);
    const running = work();
    await new Promise((r) => setTimeout(r, 300));
    await holder.query('commit');
    return await running;
  } finally {
    holder.release();
  }
}

const summary = (results: Outcome[]) =>
  results.map((r) => `${r.status}${r.error ? ` ${r.error}` : ''}`).sort();

describe('E. the in-flight replay, at the insert and three ways at one row', () => {
  it('two copies of a one-off check-in held at the insert, ids in different cases: one 201, one replay', async () => {
    const event = (await writes.findTenantEvent(appPool, tenant, ev.workshop))!;
    const child = kid([]);
    expect((await writes.createEventAttendee(appPool, event, child)).status).toBe(201);
    const ref = newId();
    // Both copies pass the replay lookup and find no day row; the table lock
    // holds them at the insert itself.
    const results = await whileLocked(
      'lock table event_attendee_checkins in share row exclusive mode',
      [],
      () =>
        Promise.all([
          writes.recordAttendeeCheckin(appPool, event, child.id, { id: ref, date: D1 }),
          writes.recordAttendeeCheckin(appPool, event, child.id.toUpperCase(), {
            id: ref.toUpperCase(),
            date: D1,
          }),
        ]),
    );
    expect(summary(results)).toEqual(['200', '201']);
    expect(results.find((r) => r.status === 200)?.body).toMatchObject({
      replayed: true,
      checkin: { checkinRef: ref, status: 'checked_in' },
    });
    expect(await count('event_attendee_checkins', 'attendee_id = $1', [child.id])).toBe(1);
  });

  it('a camp waiting row met by two copies of one check-in and a different one: the row decides each answer', async () => {
    const event = (await writes.findTenantEvent(appPool, tenant, ev.camp))!;
    const child = kid([D2]);
    expect((await writes.createEventAttendee(appPool, event, child)).status).toBe(201);
    const mine = newId();
    const theirs = newId();
    const results = await whileLocked(
      'select 1 from camp_attendance where camp_registration_id = $1 for update',
      [child.id],
      () =>
        Promise.all([
          writes.recordAttendeeCheckin(appPool, event, child.id, { id: mine, date: D2 }),
          writes.recordAttendeeCheckin(appPool, event, child.id.toUpperCase(), {
            id: mine.toUpperCase(),
            date: D2,
          }),
          writes.recordAttendeeCheckin(appPool, event, child.id, { id: theirs, date: D2 }),
        ]),
    );
    const row = (
      await appPool.query<{ checkin_ref: string; status: string }>(
        `select checkin_ref, status::text from camp_attendance where camp_registration_id = $1`,
        [child.id],
      )
    ).rows;
    expect(row).toHaveLength(1);
    expect(row[0]!.status).toBe('checked_in');
    const winner = row[0]!.checkin_ref;
    expect([mine, theirs]).toContain(winner);
    // Whoever holds the row, both copies of one check-in get the same kind of
    // answer: success (201 + replay) when theirs is the standing id, refusal
    // when it is not. Never one copy succeeding and the other refused.
    if (winner === mine) {
      expect(summary(results)).toEqual(['200', '201', '409 already_checked_in']);
      expect(results[2]).toMatchObject({ status: 409, error: 'already_checked_in' });
    } else {
      expect(summary(results)).toEqual(['201', '409 already_checked_in', '409 already_checked_in']);
      expect(results[2]!.status).toBe(201);
    }
  });
});

describe('F. the grants check raises nothing in Postgres', () => {
  it('a role without USAGE is told so, and the transaction that asked still runs', async () => {
    const role = `seam_review_${newId().replace(/-/g, '').slice(-12)}`;
    await ctx.db.execute(sql.raw(`create role ${role} nologin`));
    try {
      const after = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`set transaction read only`);
        await tx.execute(sql.raw(`set local role ${role}`));
        const refused = await otoAppEventsInstalled(tx).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(OtoAppSeamNotGrantedError);
        await expect(
          listBranchEvents(tx, { branchId: central, from: D1, to: D1 }),
        ).rejects.toBeInstanceOf(OtoAppSeamNotGrantedError);
        // Were either of those a Postgres error, this would answer 25P02.
        return (await tx.execute<{ ok: number }>(sql`select 1 as ok`)).rows[0]?.ok;
      });
      expect(after).toBe(1);
    } finally {
      await ctx.db.execute(sql.raw(`drop owned by ${role}`));
      await ctx.db.execute(sql.raw(`drop role ${role}`));
    }
  });
});

// --- G. H1 by foreign key ------------------------------------------------------

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The events module as the app's own foreign keys draw it: `core_events`, then
 * every table with a foreign key into a table already in the set, until
 * nothing more joins.
 */
function eventModuleByForeignKey(): string[] {
  const sqlText = readdirSync(APP_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(APP_MIGRATIONS, f), 'utf8'))
    .join('\n');
  const edges = [
    ...sqlText.matchAll(
      /ALTER TABLE "([a-z_0-9]+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \([^)]*\) REFERENCES "([a-z_0-9]+)"/g,
    ),
  ].map((m) => [m[1]!, m[2]!] as const);
  const module = new Set(['core_events']);
  for (let grew = true; grew;) {
    grew = false;
    for (const [from, to] of edges) {
      if (module.has(to) && !module.has(from)) {
        module.add(from);
        grew = true;
      }
    }
  }
  return [...module].sort();
}

describe('G. H1: no table hanging off core_events is named in apps/api/src', () => {
  const files = sourceFiles(SRC).map((path) => ({
    file: relative(SRC, path).split('\\').join('/'),
    text: code(readFileSync(path, 'utf8')),
  }));

  it('covers the tables the prefix rule misses', () => {
    const tables = eventModuleByForeignKey();
    expect(tables).toEqual(
      expect.arrayContaining([
        'camp_attendance',
        'event_attendee_checkins',
        'invitation_designs',
        'parent_portal_tokens',
        'parent_message_logs',
      ]),
    );
  });

  it('names none of them, schema-qualified or (for a distinctive name) bare', () => {
    const tables = eventModuleByForeignKey();
    // A one-word name ("tasks") is ordinary English in this codebase, so only
    // its schema-qualified form is a reference; a snake_case name is one either way.
    const distinctive = tables.filter((t) => t.includes('_'));
    const qualified = new RegExp(`\\botoapp\\.(${tables.join('|')})\\b`, 'g');
    const bare = new RegExp(`(?<![.\\w])(${distinctive.join('|')})\\b`, 'g');
    const hits = files.flatMap(({ file, text }) =>
      [...text.matchAll(qualified), ...text.matchAll(bare)].map((m) => `${file}: ${m[0]}`),
    );
    // The repository names its views schema-qualified, which `(?<![.\w])` skips.
    expect(hits).toEqual([]);
  });
});
