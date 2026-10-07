import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alert, box, branch, opsExpectation, opsLast, opsRun } from '@oto/db';
import {
  EventDayAnswerSchema,
  EventsCacheItemSchema,
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EventDayAnswer,
  type EventDetailAnswer,
  type EventPassesAnswer,
  type EventRosterAnswer,
} from '@oto/shared';
import { loadEnv } from '../src/env';
import type { BoxAuth } from '../src/services/box';
import { EVENTS_CACHE_REFRESH_JOB, eventsForDay, runEventsCacheRefresh } from '../src/services/events';
import { buildDefaultJobs, createJobRunner, runWatchdog } from '../src/services/jobs';
import { bundleVersionCovers, cacheBundle, pullChanges } from '../src/services/sync';
import type { AppError } from '../src/lib/errors';
import {
  BRANCH_MANAGER,
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
 * S2-20 E1 — THE EVENTS READ SEAM (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md §9 E1, check 1).
 *
 * The OTO App's own rows are written as its screens leave them, around the
 * branch's business date T: a five-day camp T-2..T+2 with six children (two
 * with an allergy, one parent staying, one registered for two days that are
 * not T, one whose day list says nothing — every day), a one-off workshop on T
 * priced for passes, a birthday party on T with its bill and deposit, an
 * unpriced event on T and a priced one next week. Check 1 is then read through
 * the routes the till reads: the Events tab for T lists the camp, the event and
 * the party; the camp's roster has per-day checked-in, outstanding and
 * not-today counts; and nothing in the api names an OTO App table (the H1 grep
 * in `otoapp-events-seam.test.ts` and the round 0 review suites, run beside
 * this one).
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let secondBranch: string;
let reception: string;
let manager: string;
let chalongManager: string;
let secondAdmin: string;
let T: string;
let centralAuth: BoxAuth;

const appTenant = newId();
const appCentral = newId();
const appChalong = newId();

const ev = {
  camp: newId(),
  workshop: newId(),
  party: newId(),
  unpriced: newId(),
  nextWeek: newId(),
  chalongCamp: newId(),
};
const kid = {
  ploy: newId(),
  win: newId(),
  mali: newId(),
  tee: newId(),
  fon: newId(),
  nam: newId(),
  guest: newId(),
  walkup: newId(),
};

const get = async <T>(cookie: string | null, url: string): Promise<{ status: number; body: T }> => {
  const res = await ctx.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: res.json() as T };
};

async function appEvent(e: {
  id: string;
  branch?: string;
  type: string;
  title: string;
  date: string;
  campEnd?: string | null;
  start?: string;
  end?: string;
  weekday?: number | null;
  weekend?: number | null;
  total?: number | null;
  deposit?: number | null;
  status?: string;
}) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, total_value, prepayment_amount, prepayment_date,
      child_name, kid_turning_age, parent_name, whatsapp_phone_e164, num_children, num_adults, location_text, status)
    values (
      ${e.id}, ${appTenant}, ${e.branch ?? appCentral}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null},
      ${e.start ?? '09:00'}, ${e.end ?? '15:00'}, ${e.weekday ?? null}, ${e.weekend ?? null}, ${e.total ?? null},
      ${e.deposit ?? null}, ${e.deposit ? addDaysToIsoDate(e.date, -14) : null},
      ${e.type === 'birthday' ? 'Mali' : null}, ${e.type === 'birthday' ? 6 : null},
      ${e.type === 'birthday' ? 'Nok' : null}, ${e.type === 'birthday' ? '+66812345678' : null},
      12, 10, 'Party room', ${e.status ?? 'upcoming'})`);
}

async function register(
  id: string,
  name: string,
  days: string[],
  o: { allergies?: string; food?: string; parentAttending?: boolean; dob?: string } = {},
) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, food_restrictions, attendance_days, parent_signature, signature_date, parent_attending)
    values (${id}, ${appTenant}, ${ev.camp}, ${name}, ${o.dob ?? '2019-04-01'}, 'Nok', '+66812345001',
            ${o.allergies ?? null}, ${o.food ?? null}, ${JSON.stringify(days)}::jsonb, 'signed', ${T},
            ${o.parentAttending ?? false})`);
}

async function campDay(id: string, date: string, status: string, inAt: string | null, outAt: string | null = null) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status,
      checked_in_at, checked_in_by, checked_out_at, checked_out_by)
    values (${id}, ${appTenant}, ${ev.camp}, ${date}, ${status}, ${inAt}, ${inAt ? 'som' : null},
            ${outAt}, ${outAt ? 'som' : null})`);
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  secondBranch = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  secondAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);

  const [row] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  T = businessDate(new Date(), row!.timezone, parseDayStart(row!.businessDayStart));

  const [boxRow] = await ctx.db.select().from(box).where(eq(box.branchId, central));
  centralAuth = {
    boxId: boxRow!.id,
    operatorId: boxRow!.operatorId,
    branchId: boxRow!.branchId,
    name: boxRow!.name,
    slot: boxRow!.slot,
    role: boxRow!.role,
    status: boxRow!.status,
    currentEpoch: boxRow!.currentEpoch,
    syncPublicKey: boxRow!.syncPublicKey,
    lastStatus: boxRow!.lastStatus as Record<string, unknown> | null,
  };

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central}),
           (${appChalong}, ${appTenant}, 'Robinson Chalong', 'Phuket', ${chalong})`);

  const D = (n: number) => addDaysToIsoDate(T, n);
  await appEvent({ id: ev.camp, type: 'camp', title: 'Ocean camp', date: D(-2), campEnd: D(2), start: '09:00', end: '15:00', weekday: 600, weekend: 700, status: 'in_progress' });
  await appEvent({ id: ev.workshop, type: 'workshop', title: 'Slime workshop', date: T, start: '14:00', end: '16:00', weekday: 350, weekend: 400 });
  await appEvent({ id: ev.party, type: 'birthday', title: "Mali's 6th", date: T, start: '11:00', end: '13:00', total: 12000, deposit: 3000 });
  await appEvent({ id: ev.unpriced, type: 'other', title: 'Halloween parade', date: T, start: '17:00', end: '18:00' });
  await appEvent({ id: ev.nextWeek, type: 'studio_event', title: 'Studio night', date: D(7), start: '18:00', end: '20:00', weekday: 250, weekend: 300 });
  await appEvent({ id: ev.chalongCamp, branch: appChalong, type: 'camp', title: 'Chalong camp', date: D(-1), campEnd: D(1), weekday: 500, weekend: 500 });

  // Six children on the camp.
  await register(kid.ploy, 'Ploy', [D(-2), D(-1), T], { allergies: 'Peanuts', parentAttending: true });
  await register(kid.win, 'Win', [], { food: 'No pork' }); // every day, the app's own rule
  await register(kid.mali, 'Mali', [D(-2), D(-1)]); // not today
  await register(kid.tee, 'Tee', [T, D(1)], { allergies: 'Shellfish' });
  await register(kid.fon, 'Fon', [T]);
  await register(kid.nam, 'Nam', [D(-1), T, D(1)], { dob: '2020-01-15' });

  // Ploy: in yesterday and out, in today. Win: in and out today. Mali: in two days ago.
  // Fon: the app seeded today waiting. Nam: in yesterday only.
  await campDay(kid.ploy, D(-1), 'checked_out', `${D(-1)} 02:30:00`, `${D(-1)} 08:00:00`);
  await campDay(kid.ploy, T, 'checked_in', `${T} 02:30:00`);
  await campDay(kid.win, T, 'checked_out', `${T} 02:00:00`, `${T} 07:00:00`);
  await campDay(kid.mali, D(-2), 'checked_in', `${D(-2)} 02:00:00`);
  await campDay(kid.fon, T, 'waiting', null);
  await campDay(kid.nam, D(-1), 'checked_in', `${D(-1)} 02:10:00`);

  // The party's guest list and a walk-up on the workshop.
  await ctx.db.execute(sql`
    insert into otoapp.event_attendees (id, tenant_id, event_id, child_full_name, parent_name, parent_phone, parent_attending, source)
    values (${kid.guest}, ${appTenant}, ${ev.party}, 'Guest one', 'Pim', '+66812345003', false, 'otoapp'),
           (${kid.walkup}, ${appTenant}, ${ev.workshop}, 'Walk-up', null, null, true, 'pos')`);
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('check 1 — the Events tab on the business date', () => {
  it('lists the camp, the one-off event and the birthday party, by start time, for today by default', async () => {
    const { status, body } = await get<EventDayAnswer>(reception, `/events?branchId=${central}`);
    expect(status).toBe(200);
    expect(EventDayAnswerSchema.safeParse(body).success).toBe(true);
    expect(body.date).toBe(T);
    expect(body.events.map((e) => [e.title, e.type])).toEqual([
      ['Ocean camp', 'camp'],
      ["Mali's 6th", 'party'],
      ['Slime workshop', 'event'],
      ['Halloween parade', 'event'],
    ]);
    // Never another branch's, never next week's.
    expect(body.events.every((e) => e.branchId === central)).toBe(true);
  });

  it('carries the camp as its range, in the status the app gave it, priced in satang', async () => {
    const { body } = await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${T}`);
    const camp = body.events.find((e) => e.id === ev.camp)!;
    expect(camp).toMatchObject({
      startDate: addDaysToIsoDate(T, -2),
      endDate: addDaysToIsoDate(T, 2),
      status: 'in_progress',
      entryPrice: { weekdaySatang: 60_000, weekendSatang: 70_000 },
      party: null,
      attendeeCount: 6,
    });
    const party = body.events.find((e) => e.id === ev.party)!;
    expect(party.party).toMatchObject({
      childName: 'Mali',
      kidTurningAge: 6,
      parentName: 'Nok',
      totalValueSatang: 1_200_000,
      depositSatang: 300_000,
    });
    expect(party.entryPrice).toBeNull();
  });

  it("the camp's roster shows the day's checked-in, outstanding and not-today counts", async () => {
    const { status, body } = await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}`);
    expect(status).toBe(200);
    expect(body.date).toBe(T);
    // Ploy in; Win in and out; Tee, Fon and Nam outstanding; Mali not today.
    expect(body.stats).toEqual({ arrived: 2, expected: 5, currentlyIn: 1, outstanding: 3, all: 6 });
    expect(body.groups.in).toEqual([kid.ploy]);
    expect(body.groups.out).toEqual([kid.win]);
    expect([...body.groups.outstanding].sort()).toEqual([kid.fon, kid.nam, kid.tee].sort());
    expect(body.groups.notToday).toEqual([kid.mali]);
    // The day list carries the same counts for the same day.
    const day = (await get<EventDayAnswer>(reception, `/events?branchId=${central}`)).body;
    expect(day.events.find((e) => e.id === ev.camp)!.roster).toEqual(body.stats);
  });

  it('is per day: yesterday the same camp counts other children', async () => {
    const Y = addDaysToIsoDate(T, -1);
    const { body } = await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${Y}`);
    // Ploy in and out; Nam in; Win and Mali outstanding; Tee and Fon not that day.
    expect(body.stats).toEqual({ arrived: 2, expected: 4, currentlyIn: 1, outstanding: 2, all: 6 });
    expect(body.groups.out).toEqual([kid.ploy]);
    expect(body.groups.in).toEqual([kid.nam]);
    expect([...body.groups.notToday].sort()).toEqual([kid.fon, kid.tee].sort());
  });

  it("reads each child as the till shows them: allergy, diet, the day's check-in, every day written out", async () => {
    const { body } = await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}`);
    const by = new Map(body.event.attendees!.map((a) => [a.id, a]));
    expect(by.get(kid.ploy)).toMatchObject({
      allergy: 'Peanuts',
      parentAttending: true,
      bucket: 'in',
      checkins: [expect.objectContaining({ date: T, status: 'checked_in', checkedInBy: 'som' })],
    });
    expect(by.get(kid.ploy)!.checkins[0]!.checkedInAt).toBe(new Date(`${T}T02:30:00Z`).toISOString());
    // Win named no day: every day of the camp, as the app reads it.
    expect(by.get(kid.win)).toMatchObject({ dietary: 'No pork', attendsAllDays: true, allergy: null });
    expect(by.get(kid.win)!.attendanceDays).toEqual([-2, -1, 0, 1, 2].map((n) => addDaysToIsoDate(T, n)));
    // A waiting row the app seeded is not a check-in.
    expect(by.get(kid.fon)).toMatchObject({ checkins: [], bucket: 'outstanding' });
    expect(by.get(kid.nam)!.age).toBeGreaterThanOrEqual(6);
    expect(by.get(kid.mali)).toMatchObject({ attendsOnDate: false, bucket: 'notToday' });
  });
});

describe('Q4 — a camp is listed on every day of its range', () => {
  it('from its first day to its last, and on no day outside it', async () => {
    for (const n of [-2, -1, 0, 1, 2]) {
      const date = addDaysToIsoDate(T, n);
      const { body } = await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${date}`);
      expect(body.events.map((e) => e.id), date).toContain(ev.camp);
    }
    for (const n of [-3, 3]) {
      const date = addDaysToIsoDate(T, n);
      const { body } = await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${date}`);
      expect(body.events.map((e) => e.id), date).not.toContain(ev.camp);
    }
  });

  it('a one-off event is listed on its own day only, and `type` narrows the list', async () => {
    const tomorrow = (await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${addDaysToIsoDate(T, 1)}`)).body;
    expect(tomorrow.events.map((e) => e.id)).toEqual([ev.camp]);
    const camps = (await get<EventDayAnswer>(reception, `/events?branchId=${central}&type=camp`)).body;
    expect(camps.events.map((e) => e.id)).toEqual([ev.camp]);
  });
});

describe('the passes the till sells', () => {
  it("a camp running today and events today or later, never a party or an unpriced event, by date", async () => {
    const { status, body } = await get<EventPassesAnswer>(reception, `/events/passes?branchId=${central}`);
    expect(status).toBe(200);
    expect(body.date).toBe(T);
    expect(body.passes.map((p) => p.id)).toEqual([ev.camp, ev.workshop, ev.nextWeek]);
    expect(body.passes.find((p) => p.id === ev.workshop)!.entryPrice).toEqual({ weekdaySatang: 35_000, weekendSatang: 40_000 });
    // The pass card reads no children.
    expect(body.passes.every((p) => p.attendees === undefined && p.attendeeCount === null)).toBe(true);
  });

  it('a camp that has ended is no longer sold, and one not yet begun is not sold either', async () => {
    const after = (await get<EventPassesAnswer>(reception, `/events/passes?branchId=${central}&date=${addDaysToIsoDate(T, 3)}`)).body;
    expect(after.passes.map((p) => p.id)).toEqual([ev.nextWeek]);
    const before = (await get<EventPassesAnswer>(reception, `/events/passes?branchId=${central}&date=${addDaysToIsoDate(T, -3)}`)).body;
    expect(before.passes.map((p) => p.id)).not.toContain(ev.camp);
  });
});

describe('one event', () => {
  it("carries every day's check-ins, with the buckets for the day asked about", async () => {
    const { status, body } = await get<EventDetailAnswer>(reception, `/events/${ev.camp}?branchId=${central}`);
    expect(status).toBe(200);
    const ploy = body.event.attendees!.find((a) => a.id === kid.ploy)!;
    expect(ploy.checkins.map((c) => [c.date, c.status])).toEqual([
      [addDaysToIsoDate(T, -1), 'checked_out'],
      [T, 'checked_in'],
    ]);
    expect(ploy.bucket).toBe('in');
  });

  it("a party's guests and a walk-up on a one-off event", async () => {
    const party = (await get<EventDetailAnswer>(reception, `/events/${ev.party}?branchId=${central}`)).body;
    expect(party.event.attendees!.map((a) => [a.name, a.parentName])).toEqual([['Guest one', 'Pim']]);
    const workshop = (await get<EventDetailAnswer>(reception, `/events/${ev.workshop}?branchId=${central}`)).body;
    expect(workshop.event.attendees![0]).toMatchObject({ name: 'Walk-up', parentName: null, parentAttending: true, attendanceDays: [], attendsOnDate: true });
  });
});

describe('pos:event:read, branch-scoped like every platform route', () => {
  it('reception and the branch manager hold it at Central; nobody signed out does', async () => {
    expect((await get(reception, `/events?branchId=${central}`)).status).toBe(200);
    expect((await get(manager, `/events/passes?branchId=${central}`)).status).toBe(200);
    expect((await get(null, `/events?branchId=${central}`)).status).toBe(401);
  });

  it("another park's manager is refused at Central, and reads only their own park", async () => {
    expect((await get(chalongManager, `/events?branchId=${central}`)).status).toBe(403);
    expect((await get(reception, `/events?branchId=${chalong}`)).status).toBe(403);
    const own = (await get<EventDayAnswer>(chalongManager, `/events?branchId=${chalong}`)).body;
    expect(own.events.map((e) => e.id)).toEqual([ev.chalongCamp]);
  });

  it("an event of another park, asked for under one's own, is not found", async () => {
    expect((await get(reception, `/events/${ev.chalongCamp}?branchId=${central}`)).status).toBe(404);
    expect((await get(reception, `/events/${ev.chalongCamp}/roster?branchId=${central}`)).status).toBe(404);
    expect((await get(reception, `/events/${newId()}?branchId=${central}`)).status).toBe(404);
  });

  it("another operator's administrator reads nothing of OTO's", async () => {
    const res = await get(secondAdmin, `/events?branchId=${central}`);
    expect([403, 404]).toContain(res.status);
    expect((await get<EventDayAnswer>(secondAdmin, `/events?branchId=${secondBranch}`)).body.events).toEqual([]);
  });

  it('refuses a malformed date or branch rather than guessing', async () => {
    expect((await get(reception, `/events?branchId=${central}&date=7-10-2026`)).status).toBe(400);
    expect((await get(reception, `/events?branchId=hkt-central`)).status).toBe(400);
  });
});

describe("a role the post-import grants have not reached", () => {
  it('is told so (503), never "no events today", and the refresh job fails on it', async () => {
    const role = `events_reader_${newId().replace(/-/g, '').slice(-12)}`;
    await ctx.db.execute(sql.raw(`create role ${role} nologin`));
    await ctx.db.execute(sql.raw(`grant usage on schema core to ${role}`));
    await ctx.db.execute(sql.raw(`grant select on core.branch to ${role}`));
    try {
      const refused = await ctx.db
        .transaction(async (tx) => {
          await tx.execute(sql.raw(`set local role ${role}`));
          return eventsForDay(tx, { operatorId: centralAuth.operatorId, branchId: central, now: new Date() });
        })
        .catch((e: unknown) => e);
      expect((refused as AppError).statusCode).toBe(503);
      expect((refused as AppError).code).toBe('EVENTS_SEAM_NOT_GRANTED');
      const job = await ctx.db
        .transaction(async (tx) => {
          await tx.execute(sql.raw(`set local role ${role}`));
          return runEventsCacheRefresh(tx, new Date());
        })
        .catch((e: unknown) => e);
      expect(job).toBeInstanceOf(Error);
    } finally {
      await ctx.db.execute(sql.raw(`drop owned by ${role}`));
      await ctx.db.execute(sql.raw(`drop role ${role}`));
    }
  });
});

describe("the box's copy of today's events", () => {
  it('is one volatile item: the day list cut down, with no phone, and never on the change feed', async () => {
    const answer = await cacheBundle(ctx.db, centralAuth, { scopes: ['events'] });
    expect(Object.keys(answer.scopes)).toEqual(['events']);
    expect(bundleVersionCovers(answer)).toBe(false);
    const item = EventsCacheItemSchema.parse(answer.scopes.events!.items[0]);
    expect(item.date).toBe(T);
    expect(item.events.map((e) => e.id)).toEqual([ev.camp, ev.party, ev.workshop, ev.unpriced]);
    const camp = item.events.find((e) => e.id === ev.camp)!;
    expect(camp.attendees.find((a) => a.id === kid.ploy)).toMatchObject({
      allergy: 'Peanuts',
      parentAttending: true,
      bucket: 'in',
      checkin: { status: 'checked_in' },
    });
    expect(JSON.stringify(item)).not.toContain('+668');
    // The full bundle carries it too, and its version does not move with it.
    const full = await cacheBundle(ctx.db, centralAuth, {});
    expect(Object.keys(full.scopes)).toContain('events');
    const fed = await pullChanges(ctx.db, centralAuth, { cursorSeq: 0, limit: 500, scopes: ['events' as never] });
    expect(fed.changes).toEqual([]);
  });

  it("has a version of its own that a check-in moves and a rebuild of the same day does not", async () => {
    const one = EventsCacheItemSchema.parse((await cacheBundle(ctx.db, centralAuth, { scopes: ['events'] })).scopes.events!.items[0]);
    const again = EventsCacheItemSchema.parse((await cacheBundle(ctx.db, centralAuth, { scopes: ['events'] })).scopes.events!.items[0]);
    expect(again.version).toBe(one.version);
    await ctx.db.execute(sql`
      update otoapp.camp_attendance set status = 'checked_in', checked_in_at = now(), checked_in_by = 'som'
       where camp_registration_id = ${kid.fon} and attendance_date = ${T}`);
    const moved = EventsCacheItemSchema.parse((await cacheBundle(ctx.db, centralAuth, { scopes: ['events'] })).scopes.events!.items[0]);
    expect(moved.version).not.toBe(one.version);
    await ctx.db.execute(sql`
      update otoapp.camp_attendance set status = 'waiting', checked_in_at = null, checked_in_by = null
       where camp_registration_id = ${kid.fon} and attendance_date = ${T}`);
  });
});

describe('job:events.cache_refresh', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://oto:oto@localhost:1/unused',
    PROCESS_ROLES: 'api,jobs',
  });

  it('is registered on the rollup cadence the other rollups run on', () => {
    const jobs = buildDefaultJobs({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const job = jobs.find((j) => j.name === EVENTS_CACHE_REFRESH_JOB);
    expect(job, 'the events refresh is not registered').toBeTruthy();
    expect(job!.intervalSeconds).toBe(env.ROLLUP_INTERVAL_S);
  });

  it('runs as an operations job with counts only, and registering it wrote its expectation', async () => {
    const all = buildDefaultJobs({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const runner = createJobRunner({
      db: ctx.db,
      env,
      log: ctx.app.log,
      channels: [],
      jobs: all.filter((j) => j.name === EVENTS_CACHE_REFRESH_JOB),
    });
    await runner.start();
    await runner.stop();
    const [expectation] = await ctx.db.select().from(opsExpectation).where(eq(opsExpectation.name, EVENTS_CACHE_REFRESH_JOB));
    expect(expectation).toMatchObject({ kind: 'job', intervalSeconds: env.ROLLUP_INTERVAL_S, enabled: true });
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, EVENTS_CACHE_REFRESH_JOB))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    expect(run).toMatchObject({ kind: 'job', outcome: 'ok' });
    const detail = run!.detail as Record<string, number>;
    expect(Object.keys(detail).sort()).toEqual(['attendees', 'branches', 'events']);
    expect(detail.events).toBeGreaterThanOrEqual(5); // Central's four today and Chalong's camp
    expect(JSON.stringify(detail)).not.toContain('Ploy');
  });

  it('H19 — a missed refresh raises the expectation alert, and a run closes it', async () => {
    const [expectation] = await ctx.db.select().from(opsExpectation).where(eq(opsExpectation.name, EVENTS_CACHE_REFRESH_JOB));
    const late = new Date(Date.now() - (expectation!.intervalSeconds + expectation!.graceSeconds + 600) * 1000);
    await ctx.db.update(opsLast).set({ lastOkAt: late, lastStartedAt: late }).where(eq(opsLast.name, EVENTS_CACHE_REFRESH_JOB));
    await runWatchdog({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const key = `ops.missing:${EVENTS_CACHE_REFRESH_JOB}`;
    const [open] = await ctx.db.select().from(alert).where(eq(alert.key, key));
    expect(open).toMatchObject({ category: 'ops.missing', status: 'open' });

    await ctx.db.update(opsLast).set({ lastOkAt: new Date() }).where(eq(opsLast.name, EVENTS_CACHE_REFRESH_JOB));
    await runWatchdog({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const [closed] = await ctx.db.select().from(alert).where(eq(alert.key, key));
    expect(closed!.status).toBe('resolved');
  });
});
