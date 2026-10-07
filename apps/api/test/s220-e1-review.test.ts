import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  alert,
  branch,
  opsExpectation,
  opsLast,
  opsRun,
  role,
  roleAssignment,
  rolePermission,
  station,
} from '@oto/db';
import {
  EventDayAnswerSchema,
  EventsCacheItemSchema,
  addDaysToIsoDate,
  businessDate,
  newId,
  normalizePhone,
  parseDayStart,
  type EventDayAnswer,
  type EventDetailAnswer,
  type EventPassesAnswer,
  type EventRosterAnswer,
  type EventsCacheItem,
} from '@oto/shared';
import {
  SqlBoxStore,
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  type AgentFetch,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import { loadEnv } from '../src/env';
import { provisionVirtualBox } from '../src/services/box';
import { boxStoreFor } from '../src/lib/box-store';
import { EVENTS_CACHE_REFRESH_JOB } from '../src/services/events';
import { buildDefaultJobs, createJobRunner, runWatchdog, type JobRunner } from '../src/services/jobs';
import { cacheScopesOffered } from '../src/services/sync';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-20 E1 — REVIEW, from the outside (SCRUM-217; events-kiosk PLAN §9 E1,
 * §4, §10, hazards H1 and H19).
 *
 * Written against the lane, not beside it: nothing here was taken from the
 * builder's own suite (`events-e1.test.ts`). It attacks four things.
 *
 *  1. THE REPOSITORY AND ITS FENCES — the H1 grep read again from the source;
 *     a camp on every day of its range with both edges, a one-day camp, an
 *     open-ended camp; an event at an app branch the platform has not mapped
 *     (no id, a malformed id, the right id in capitals in another tenant)
 *     absent everywhere and never an error; a platform branch with no app
 *     branch answering an empty day; another operator's events invisible both
 *     ways.
 *  2. PERMISSION AND SCOPE ON EVERY GET — signed out 401, a role without
 *     `pos:event:read` 403, another park's manager 403, the right person 200.
 *  3. THE BOX'S COPY — the job builds today's events from the live seam and
 *     counts what it built; it fails while a seam view is missing and the
 *     watchdog says so after the threshold, then resolves on the mended seam;
 *     its expectation raises `ops.missing` when it stops; and the REAL agent
 *     writes the copy, leaves it alone when nothing moved, rewrites it after a
 *     check-in, and keeps it when the seam breaks.
 *
 * The OTO App's rows are written with SQL, as its own screens leave them.
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let secondBranch: string;
let reception: string;
let chalongManager: string;
let secondAdmin: string;
let noEvents: string;
let T: string;
const D = (n: number) => addDaysToIsoDate(T, n);

const appTenant = newId();
const otherTenant = newId();
const shadowTenant = newId();
const app = {
  central: newId(),
  unmapped: newId(),
  malformed: newId(),
  shadow: newId(),
  second: newId(),
};

const ev = {
  camp: newId(),
  dayCamp: newId(),
  openCamp: newId(),
  oldOpenCamp: newId(),
  unmapped: newId(),
  malformed: newId(),
  shadow: newId(),
  secondOp: newId(),
  late: newId(),
};
const kid = {
  allDays: newId(),
  edges: newId(),
  openAll: newId(),
  oldOpenAll: newId(),
  secondKid: newId(),
};

const get = async <B>(cookie: string | null, url: string): Promise<{ status: number; body: B }> => {
  const res = await ctx.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: res.json() as B };
};

async function appEvent(e: {
  id: string;
  tenant?: string;
  branch?: string;
  type: string;
  title: string;
  date: string;
  campEnd?: string | null;
  weekday?: number | null;
  weekend?: number | null;
  start?: string;
}) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, location_text, status)
    values (
      ${e.id}, ${e.tenant ?? appTenant}, ${e.branch ?? app.central}, ${e.type}, ${e.title}, ${e.date},
      ${e.campEnd ?? null}, ${e.start ?? '09:00'}, '15:00', ${e.weekday ?? null}, ${e.weekend ?? null},
      10, 4, 'Studio', 'upcoming')`);
}

async function register(id: string, eventId: string, name: string, days: string[], tenant = appTenant) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, attendance_days, parent_signature, signature_date)
    values (${id}, ${tenant}, ${eventId}, ${name}, '2019-04-01', 'Guardian', '+66812349999',
            'Sesame', ${JSON.stringify(days)}::jsonb, 'signed', ${T})`);
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  secondBranch = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  secondAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);

  const [centralRow] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  T = businessDate(new Date(), centralRow!.timezone, parseDayStart(centralRow!.businessDayStart));

  // A counter role of OTO's own that can look a member up and nothing about events.
  const roleId = newId();
  await ctx.db.insert(role).values({ id: roleId, operatorId: centralRow!.operatorId, name: 'review_no_events' });
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId, permission: 'pos:member:read' },
    { id: newId(), roleId, permission: 'app:pos:access' },
  ]);
  const accountId = newId();
  await ctx.db.insert(account).values({
    id: accountId,
    operatorId: centralRow!.operatorId,
    phone: normalizePhone('+66900000077')!,
    passwordHash: await hash('noevents1234'),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db
    .insert(roleAssignment)
    .values({ id: newId(), accountId, roleId, scopeType: 'branch', scopeId: central });
  noEvents = await signInAs(ctx.app, '+66900000077', 'noevents1234');

  // The OTO App's tenants and branches. Chalong is deliberately NOT mapped.
  await ctx.db.execute(sql`
    insert into otoapp.tenants (id, name, slug)
    values (${appTenant}, 'OTO', 'oto-review'), (${otherTenant}, 'Second', 'second-review'),
           (${shadowTenant}, 'Shadow', 'shadow-review')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${app.central}, ${appTenant}, 'Central', 'Phuket', ${central}),
           (${app.unmapped}, ${appTenant}, 'Head Office', 'Phuket', null),
           (${app.malformed}, ${appTenant}, 'Typo branch', 'Phuket', 'hkt-central'),
           (${app.shadow}, ${shadowTenant}, 'Shadow', 'Phuket', ${central.toUpperCase()}),
           (${app.second}, ${otherTenant}, 'Second park', 'Bangkok', ${secondBranch})`);

  await appEvent({ id: ev.camp, type: 'camp', title: 'Edge camp', date: D(-2), campEnd: D(2), weekday: 600, weekend: 700 });
  await appEvent({ id: ev.dayCamp, type: 'camp', title: 'One-day camp', date: T, campEnd: T, weekday: 300, weekend: 300 });
  await appEvent({ id: ev.openCamp, type: 'camp', title: 'Open camp', date: D(-3), campEnd: null, weekday: 500, weekend: 500 });
  await appEvent({ id: ev.oldOpenCamp, type: 'camp', title: 'Year-round club', date: D(-400), campEnd: null, weekday: 450, weekend: 450 });
  await appEvent({ id: ev.unmapped, branch: app.unmapped, type: 'workshop', title: 'Head office workshop', date: T, weekday: 100, weekend: 100 });
  await appEvent({ id: ev.malformed, branch: app.malformed, type: 'workshop', title: 'Typo workshop', date: T, weekday: 100, weekend: 100 });
  await appEvent({ id: ev.shadow, tenant: shadowTenant, branch: app.shadow, type: 'workshop', title: 'Shadow workshop', date: T, weekday: 100, weekend: 100 });
  await appEvent({ id: ev.secondOp, tenant: otherTenant, branch: app.second, type: 'camp', title: 'Second camp', date: D(-1), campEnd: D(1), weekday: 100, weekend: 100 });

  await register(kid.allDays, ev.camp, 'Every-day child', []);
  await register(kid.edges, ev.camp, 'Edge-days child', [D(-2), D(2)]);
  await register(kid.openAll, ev.openCamp, 'Open-camp child', []);
  await register(kid.oldOpenAll, ev.oldOpenCamp, 'Club child', []);
  await register(kid.secondKid, ev.secondOp, 'Second child', [], otherTenant);
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- 1. The repository and its fences -------------------------------------------

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const POS_SRC = fileURLToPath(new URL('../../pos/src', import.meta.url));
const APP_EVENT_TABLES = /\b(core_events|camp_registrations|camp_attendance|event_attendee_checkins|studio_event_bookings)\b|otoapp\.event_attendees\b|\bfrom\s+event_attendees\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('H1, read again from the source', () => {
  it('only the read-only repository names otoapp_v; the E1 service and route name no view and no app table', () => {
    const naming = sourceFiles(SRC)
      .filter((f) => readFileSync(f, 'utf8').includes('otoapp_v'))
      .map((f) => relative(SRC, f).split('\\').join('/'));
    expect(naming).toEqual(['services/otoapp-events.ts']);
    for (const rel of ['services/events.ts', 'routes/events.ts']) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect(src, rel).not.toMatch(/otoapp_v|otoapp\./);
      expect(src, rel).not.toMatch(APP_EVENT_TABLES);
      // No SQL of its own: every OTO App fact reaches E1 through the repository.
      expect(src, rel).not.toMatch(/\bsql`|\.execute\(/);
    }
  });

  it('the repository only reads: no insert, update, delete or DDL against the views', () => {
    const src = readFileSync(join(SRC, 'services/otoapp-events.ts'), 'utf8');
    expect(src).not.toMatch(/\b(insert\s+into|update\s+otoapp|delete\s+from|create\s+view|drop\s+view|alter\s+)/i);
  });

  it('the POS app names no OTO App table and no view: it reads the platform only', () => {
    const offenders = sourceFiles(POS_SRC).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return src.includes('otoapp_v') || APP_EVENT_TABLES.test(src);
    });
    expect(offenders).toEqual([]);
  });
});

describe('a camp on every day of its range (Q4), with its edges', () => {
  it('is listed on its first and last day and each day between, and on neither day outside', async () => {
    for (const n of [-3, -2, -1, 0, 1, 2, 3]) {
      const { status, body } = await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${D(n)}`);
      expect(status, D(n)).toBe(200);
      const listed = body.events.some((e) => e.id === ev.camp);
      expect(listed, `day ${n}`).toBe(n >= -2 && n <= 2);
    }
  });

  it('a one-day camp is listed and sold on its day only', async () => {
    for (const n of [-1, 0, 1]) {
      const day = (await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${D(n)}`)).body;
      expect(day.events.some((e) => e.id === ev.dayCamp), `listed ${n}`).toBe(n === 0);
      const passes = (await get<EventPassesAnswer>(reception, `/events/passes?branchId=${central}&date=${D(n)}`)).body;
      expect(passes.passes.some((e) => e.id === ev.dayCamp), `sold ${n}`).toBe(n === 0);
    }
  });

  it("a child registered for the two edge days is expected on each edge and 'not today' between", async () => {
    const bucketOn = async (date: string) => {
      const { body } = await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${date}`);
      return body.event.attendees!.find((a) => a.id === kid.edges)!.bucket;
    };
    expect(await bucketOn(D(-2))).toBe('outstanding');
    expect(await bucketOn(T)).toBe('notToday');
    expect(await bucketOn(D(2))).toBe('outstanding');
    // The every-day child is expected on both edges too.
    const first = (await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${D(-2)}`)).body;
    expect(first.groups.outstanding).toContain(kid.allDays);
    const last = (await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${D(2)}`)).body;
    expect(last.groups.outstanding).toContain(kid.allDays);
  });

  it('an open-ended camp is listed from its first day on, and its every-day child is expected each day', async () => {
    for (const n of [-4, -3, 0, 30]) {
      const day = (await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${D(n)}`)).body;
      const open = day.events.find((e) => e.id === ev.openCamp);
      expect(!!open, `listed ${n}`).toBe(n >= -3);
      if (open) {
        expect(open.endDate).toBeNull();
        expect(open.attendees!.find((a) => a.id === kid.openAll)!.bucket, `bucket ${n}`).toBe('outstanding');
      }
    }
  });

  /**
   * KNOWN DEFECT, PINNED (review finding 1). `attendanceDaysOf` writes an
   * every-day registration out through `campDays`, which stops at
   * `CAMP_MAX_DAYS` (366) from the camp's start. An open-ended camp the OTO
   * App still runs (no end date) that began more than a year ago is listed
   * today, but its every-day children read `attendsOnDate: false` and sit in
   * "not today" — the Check in button greyed with "Not registered for today".
   * The OTO App reads the same registration as attending today
   * (`/api/core/camp-checkins/today`). No such camp is in the production dump
   * today (all eight camps carry an end date), so this does not block E1.
   * `it.fails` holds the defect in view: when it is fixed this goes red, and
   * the fix flips it to `it`.
   */
  it.fails('an open-ended camp that began more than a year ago still expects its every-day child today', async () => {
    // The OTO App's rule: an empty day list attends every day of the camp,
    // and an open-ended camp runs until it is given an end.
    const day = (await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${T}`)).body;
    const club = day.events.find((e) => e.id === ev.oldOpenCamp);
    expect(club, 'the open-ended camp is listed today').toBeTruthy();
    const child = club!.attendees!.find((a) => a.id === kid.oldOpenAll)!;
    expect(child.attendsAllDays).toBe(true);
    expect(child.attendsOnDate).toBe(true);
    expect(child.bucket).toBe('outstanding');
  });
});

describe('fences: unmapped app branches, unmapped platform branches, other operators', () => {
  const hidden = () => [ev.unmapped, ev.malformed, ev.shadow, ev.secondOp];

  it("an event at an app branch the platform has not mapped is on no list, and its id answers 404, never 500", async () => {
    const day = await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${T}`);
    expect(day.status).toBe(200);
    expect(EventDayAnswerSchema.safeParse(day.body).success).toBe(true);
    expect(day.body.events.map((e) => e.id)).toContain(ev.camp);
    for (const id of hidden()) {
      expect(day.body.events.some((e) => e.id === id), id).toBe(false);
      expect((await get(reception, `/events/${id}?branchId=${central}`)).status, id).toBe(404);
      expect((await get(reception, `/events/${id}/roster?branchId=${central}`)).status, id).toBe(404);
    }
    const passes = await get<EventPassesAnswer>(reception, `/events/passes?branchId=${central}`);
    expect(passes.status).toBe(200);
    for (const id of hidden()) expect(passes.body.passes.some((e) => e.id === id), id).toBe(false);
  });

  it('a platform branch no OTO App branch maps to answers an empty day and no passes, not an error', async () => {
    const day = await get<EventDayAnswer>(chalongManager, `/events?branchId=${chalong}&date=${T}`);
    expect(day.status).toBe(200);
    expect(day.body).toMatchObject({ branchId: chalong, date: T, events: [] });
    const passes = await get<EventPassesAnswer>(chalongManager, `/events/passes?branchId=${chalong}`);
    expect(passes.status).toBe(200);
    expect(passes.body.passes).toEqual([]);
    // Central's camp asked for under Chalong is not Chalong's.
    expect((await get(chalongManager, `/events/${ev.camp}?branchId=${chalong}`)).status).toBe(404);
    expect((await get(chalongManager, `/events/${ev.camp}/roster?branchId=${chalong}`)).status).toBe(404);
  });

  it("another operator's camp is invisible to OTO's staff, and OTO's to theirs, on every route", async () => {
    expect((await get(reception, `/events/${ev.secondOp}?branchId=${central}`)).status).toBe(404);
    expect((await get(reception, `/events/${ev.secondOp}/roster?branchId=${central}`)).status).toBe(404);

    // Their administrator, at their own branch, sees their camp and nothing of OTO's.
    const theirs = await get<EventDayAnswer>(secondAdmin, `/events?branchId=${secondBranch}&date=${T}`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.events.map((e) => e.id)).toEqual([ev.secondOp]);
    expect(JSON.stringify(theirs.body)).not.toMatch(/Edge camp|Every-day child|Sesame.*Edge/);
    for (const id of [ev.camp, ev.dayCamp, ev.openCamp]) {
      expect((await get(secondAdmin, `/events/${id}?branchId=${secondBranch}`)).status, id).toBe(404);
      expect((await get(secondAdmin, `/events/${id}/roster?branchId=${secondBranch}`)).status, id).toBe(404);
    }

    // At OTO's branch they are refused on every route, with nothing of OTO's in the answer.
    for (const url of [
      `/events?branchId=${central}`,
      `/events/passes?branchId=${central}`,
      `/events/${ev.camp}?branchId=${central}`,
      `/events/${ev.camp}/roster?branchId=${central}`,
    ]) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: secondAdmin } });
      expect([403, 404], url).toContain(res.statusCode);
      expect(res.body, url).not.toMatch(/Edge camp|Every-day child/);
    }
  });
});

// --- 2. Permission and scope on each GET ---------------------------------------------

describe('pos:event:read on every GET', () => {
  const urls = () => [
    `/events?branchId=${central}`,
    `/events/passes?branchId=${central}`,
    `/events/${ev.camp}?branchId=${central}`,
    `/events/${ev.camp}/roster?branchId=${central}`,
  ];

  it('signed out: 401 on every route', async () => {
    for (const url of urls()) expect((await get(null, url)).status, url).toBe(401);
  });

  it("a role at Central without pos:event:read: 403 on every route, nothing of the event in the answer", async () => {
    for (const url of urls()) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: noEvents } });
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).not.toMatch(/Edge camp|Every-day child|Sesame/);
    }
  });

  it("another park's manager, who holds it at Chalong only: 403 at Central on every route", async () => {
    for (const url of urls()) expect((await get(chalongManager, url)).status, url).toBe(403);
  });

  it('reception at Central: 200 on every route', async () => {
    for (const url of urls()) expect((await get(reception, url)).status, url).toBe(200);
  });

  it('carries the allergy text only to someone holding the permission', async () => {
    const detail = await get<EventDetailAnswer>(reception, `/events/${ev.camp}?branchId=${central}`);
    expect(detail.body.event.attendees!.find((a) => a.id === kid.allDays)!.allergy).toBe('Sesame');
  });
});

// --- 3. The box's copy -------------------------------------------------------------

describe("job:events.cache_refresh — today's events for the boxes", () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://oto:oto@localhost:1/unused',
    PROCESS_ROLES: 'api,jobs',
  });
  let runner: JobRunner;

  const lastRun = async () =>
    (
      await ctx.db
        .select()
        .from(opsRun)
        .where(eq(opsRun.name, EVENTS_CACHE_REFRESH_JOB))
        .orderBy(desc(opsRun.startedAt))
        .limit(1)
    )[0]!;

  beforeAll(async () => {
    runner = createJobRunner({
      db: ctx.db,
      env,
      log: ctx.app.log,
      channels: [],
      jobs: buildDefaultJobs({ db: ctx.db, env, log: ctx.app.log, channels: [] }).filter(
        (j) => j.name === EVENTS_CACHE_REFRESH_JOB,
      ),
    });
    await runner.start();
  });

  afterAll(async () => {
    await runner.stop();
  });

  it('builds the live day: a new event today is counted on the next run', async () => {
    expect(await runner.runJob(EVENTS_CACHE_REFRESH_JOB, { force: true })).toBe('ok');
    const before = (await lastRun()).detail as { events: number; branches: number };
    await appEvent({ id: ev.late, type: 'studio_event', title: 'Late addition', date: T, start: '19:00', weekday: 200, weekend: 200 });
    expect(await runner.runJob(EVENTS_CACHE_REFRESH_JOB, { force: true })).toBe('ok');
    const after = (await lastRun()).detail as { events: number; branches: number };
    expect(after.events).toBe(before.events + 1);
    expect(after.branches).toBe(before.branches);
    // Counts only, never a title or a child's name.
    expect(JSON.stringify(after)).not.toMatch(/Late addition|Every-day child/);
  });

  it('fails while a seam view is missing, the watchdog raises ops.failing at the threshold, and the mended seam resolves it', async () => {
    const failKey = `ops.failing:${EVENTS_CACHE_REFRESH_JOB}`;
    await ctx.db.execute(sql.raw('alter view otoapp_v.children rename to children_review_broken'));
    try {
      for (let i = 0; i < env.ALERT_FAILURE_THRESHOLD; i += 1) {
        expect(await runner.runJob(EVENTS_CACHE_REFRESH_JOB, { force: true })).toBe('failed');
      }
      // The routes say so too, rather than "nothing on today".
      const refused = await get<{ error: { code: string } }>(reception, `/events?branchId=${central}`);
      expect(refused.status).toBe(503);
      expect(refused.body.error.code).toBe('EVENTS_SEAM_NOT_GRANTED');
      await runWatchdog({ db: ctx.db, env, log: ctx.app.log, channels: [] });
      const [open] = await ctx.db.select().from(alert).where(eq(alert.key, failKey));
      expect(open).toMatchObject({ category: 'ops.failing', status: 'open' });
    } finally {
      await ctx.db.execute(sql.raw('alter view otoapp_v.children_review_broken rename to children'));
    }
    expect(await runner.runJob(EVENTS_CACHE_REFRESH_JOB, { force: true })).toBe('ok');
    await runWatchdog({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const [closed] = await ctx.db.select().from(alert).where(eq(alert.key, failKey));
    expect(closed!.status).toBe('resolved');
  });

  it('H19 — its expectation raises ops.missing when the refresh stops running', async () => {
    const [expectation] = await ctx.db
      .select()
      .from(opsExpectation)
      .where(eq(opsExpectation.name, EVENTS_CACHE_REFRESH_JOB));
    expect(expectation).toMatchObject({ kind: 'job', intervalSeconds: env.ROLLUP_INTERVAL_S, enabled: true });
    const late = new Date(Date.now() - (expectation!.intervalSeconds + expectation!.graceSeconds + 60) * 1000);
    await ctx.db
      .update(opsLast)
      .set({ lastOkAt: late, lastStartedAt: late })
      .where(eq(opsLast.name, EVENTS_CACHE_REFRESH_JOB));
    await runWatchdog({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const [open] = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `ops.missing:${EVENTS_CACHE_REFRESH_JOB}`));
    expect(open).toMatchObject({ category: 'ops.missing', status: 'open' });
  });
});

describe("a till's box sees its copy of today's events refresh (the real agent, the real routes)", () => {
  let agent: BoxAgent;
  let boxId: string;

  function injectTransport(): AgentFetch {
    return async (url, init) => {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const res = await ctx.app.inject({
        method: init.method as 'GET',
        url: path,
        headers: init.headers,
        payload: init.body,
      });
      return {
        status: res.statusCode,
        json: async () => (res.body ? JSON.parse(res.body) : null),
        text: async () => res.body,
        header: (name) => {
          const value = res.headers[name.toLowerCase()];
          return typeof value === 'string' ? value : null;
        },
      };
    };
  }

  /** What the box holds, read through a store built after the write. */
  async function held(): Promise<EventsCacheItem | null> {
    const client = (ctx.db as unknown as { $client: PgPoolLike }).$client;
    const store = new SqlBoxStore({ driver: postgresBoxDriver(client) });
    const bundle = await store.readBundle(boxId, 'events');
    if (!bundle) return null;
    return EventsCacheItemSchema.parse((bundle.payload as { items: unknown[] }).items[0]);
  }

  beforeAll(async () => {
    const [till] = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, central), eq(station.name, 'Reception Till 1')))
      .limit(1);
    boxId = till!.boxId!;
    agent = createBoxAgent({
      apiBaseUrl: 'http://virtual-box.test',
      credentials: memoryCredentialStore(),
      hostname: 's220-e1-review',
      fetch: injectTransport(),
      claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
      store: boxStoreFor(ctx.db),
    });
    await agent.ensureRegistered();
    await agent.syncConfig();
  }, 120_000);

  it("only a box that runs only booths is not offered the scope", () => {
    expect(cacheScopesOffered('booth_only')).not.toContain('events');
  });

  it('writes the copy, keeps it when nothing moved, rewrites it after a check-in, and keeps it when the seam breaks', async () => {
    expect(await agent.syncEvents()).toBe(true);
    const first = await held();
    expect(first).not.toBeNull();
    expect(first!.date).toBe(T);
    expect(first!.branchId).toBe(central);
    expect(first!.events.map((e) => e.id)).toEqual(expect.arrayContaining([ev.camp, ev.dayCamp, ev.openCamp]));
    for (const id of [ev.unmapped, ev.malformed, ev.shadow, ev.secondOp]) {
      expect(first!.events.some((e) => e.id === id), id).toBe(false);
    }
    // No phone and no guardian number on a Pi in a mall.
    expect(JSON.stringify(first)).not.toContain('+6681234');

    // Nothing moved: no rewrite.
    expect(await agent.syncEvents()).toBe(false);

    // A check-in made in the OTO App reaches the box on its next tick.
    await ctx.db.execute(sql`
      insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status,
        checked_in_at, checked_in_by)
      values (${kid.allDays}, ${appTenant}, ${ev.camp}, ${T}, 'checked_in', now() at time zone 'UTC', 'review')`);
    expect(await agent.syncEvents()).toBe(true);
    const moved = await held();
    expect(moved!.version).not.toBe(first!.version);
    const child = moved!.events.find((e) => e.id === ev.camp)!.attendees.find((a) => a.id === kid.allDays)!;
    expect(child).toMatchObject({ bucket: 'in', checkin: { status: 'checked_in' } });

    // The seam breaks: the cloud leaves the scope out and the box keeps what it holds.
    await ctx.db.execute(sql.raw('alter view otoapp_v.event_attendance rename to event_attendance_review_broken'));
    try {
      expect(await agent.syncEvents()).toBe(false);
      expect((await held())!.version).toBe(moved!.version);
      // And the rest of the cache is still served and applied: the full pull
      // lands its other scopes and leaves the events copy as it was.
      const applied = await agent.syncCache();
      expect(applied).toEqual(expect.arrayContaining(['staff', 'deny_list']));
      expect(applied).not.toContain('events');
      expect((await held())!.version).toBe(moved!.version);
    } finally {
      await ctx.db.execute(sql.raw('alter view otoapp_v.event_attendance_review_broken rename to event_attendance'));
    }
    // Mended: the next tick has nothing new to write.
    expect(await agent.syncEvents()).toBe(false);
  });
});
