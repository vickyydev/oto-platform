import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  band,
  bandEvent,
  branch,
  checkin,
  eventAttendeeLink,
  eventCheckin,
  opsRun,
  printJob,
  station,
} from '@oto/db';
import {
  addDaysToIsoDate,
  bandShortCode,
  businessDate,
  newId,
  normalizePhone,
  parseDayStart,
  verifyBandCode,
  type EventAttendeeWriteAnswer,
  type EventCheckinAnswer,
  type EventRosterAnswer,
} from '@oto/shared';
import { bandCopyFrom, decideGate } from '@oto/box-agent/gate';
import { ATTENDEE_CHECKIN_RUN, checkInEventAttendee, retryCheckinWriteBack } from '../src/services/event-checkins';
import { currentBandKey } from '../src/services/bands';
import { buildPrintDocument } from '../src/services/sale-printing';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryCheckinAnswer,
  DirectoryCheckinBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-20 E3 — REVIEW, from the outside (SCRUM-217; events-kiosk PLAN §9 E3, §4,
 * §8, Q1, Q4, Q13; hazards H4-H9 and H20).
 *
 * Written against the lane, not beside it: nothing here is taken from the
 * builder's suites (`events-e3*.test.ts`). The OTO App is its own write code
 * (`server/directory/eventWrites.ts`) over its own tables, so every answer the
 * POS gets from "the app" is the one round 0 really gives. It attacks:
 *
 *  1. THE MIRROR — the same check-in id twice at once lands once in the app;
 *     a lost answer and its Retry land once; the app's own check-in (its
 *     screen) beats a POS one racing it; an undo in the app is not undone by
 *     a replay or a Retry — and (a finding, fixed) not by the roster either.
 *  2. THE BAND — the real codes against the park's key and the gate's own copy
 *     of the bands; the food counter's scan by short code, and nothing once the
 *     child is out; a reprint replayed under one key prints once, through the
 *     S2-11 reprint path, audited; no supervision gate on any event path.
 *  3. THE SERVER RULE, WHATEVER IDS ARE SENT — capitals, another event's child,
 *     a check-in id spent on another child, and (a finding, fixed) the till's
 *     own id for a child the app merged into its registration.
 *  4. (a finding, fixed) A MERGED WALK-UP'S BAND carries the app's allergy line.
 *  5. THE CAMP RANGE END TO END — its first and last day in, the days outside
 *     out, and 00:30 on the day after on the branch's business date (H20).
 *
 * A defect found is pinned with `it.fails` (the E1 review's convention): the
 * suite stays green while it stands and turns red the day it is fixed, so the
 * fix flips it to `it`. The E3 fix round flipped every pin in this file.
 */

let ctx: TestContext;
let central: string;
let operatorId: string;
let till: string;
let tillBox: string;
let reception: string;
let admin: string;
let accountId: string;
let T: string;
let tz: string;
let dayStart: number;
let appPool: pg.Pool;
const D = (n: number) => addDaysToIsoDate(T, n);

const appTenant = newId();
const appCentral = newId();
const ev = { camp: newId(), workshop: newId() };
const kid = {
  race: newId(),
  copy: newId(),
  lost: newId(),
  appWins: newId(),
  undo: newId(),
  band: newId(),
  edges: newId(),
  out: newId(),
  first: newId(),
  last: newId(),
  midnight: newId(),
  /** Registered in the app for tomorrow, with an allergy; walks up today. */
  mergedAllergy: newId(),
  /** Registered in the app for tomorrow; walks up today; then moved off today. */
  mergedMoved: newId(),
};
let workshopKid: string;

// --- The OTO App's directory, from its own source ------------------------------

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
type AppOutcome<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; message: string };
interface AppWrites {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(pool: pg.Pool, event: AppEvent, input: DirectoryAttendeeBody): Promise<AppOutcome<DirectoryAttendeeAnswer>>;
  recordAttendeeCheckin(
    pool: pg.Pool,
    event: AppEvent,
    attendeeId: string,
    input: DirectoryCheckinBody,
  ): Promise<AppOutcome<DirectoryCheckinAnswer>>;
}
let appWrites: AppWrites;

type Plan = 'app' | 'unreachable' | 'lost_answer';
const plan: { checkin: Plan[] } = { checkin: [] };
const sent: Array<{ attendeeId: string; body: DirectoryCheckinBody; answered: number | null }> = [];
const unreachable = { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'no answer', retryable: true };

function asOutcome<T>(o: AppOutcome<T>): DirectoryOutcome<T> {
  if (o.ok) return { ok: true, status: o.status, body: o.body };
  return { ok: false, status: o.status, code: `OTOAPP_${o.error.toUpperCase()}`, message: o.message, retryable: o.status >= 500 };
}

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body) {
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return asOutcome(await appWrites.createEventAttendee(appPool, event, body));
  },
  async checkinAttendee(eventId, attendeeId, body) {
    const next = plan.checkin.shift() ?? 'app';
    if (next === 'unreachable') {
      sent.push({ attendeeId, body, answered: null });
      return unreachable;
    }
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const outcome = await appWrites.recordAttendeeCheckin(appPool, event, attendeeId, body);
    sent.push({ attendeeId, body, answered: outcome.status });
    if (next === 'lost_answer') return unreachable;
    return asOutcome(outcome);
  },
};

// --- Helpers ---------------------------------------------------------------------

async function appEvent(e: { id: string; type: string; title: string; date: string; campEnd?: string | null }) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
    values (
      ${e.id}, ${appTenant}, ${appCentral}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null},
      '09:00', '15:00', 600, 700, 12, 10, 'upcoming')`);
}

async function register(o: {
  id: string;
  name: string;
  days: string[];
  allergies?: string | null;
  diet?: string | null;
  parentAttending?: boolean;
  phone?: string;
}) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, food_restrictions, attendance_days, parent_signature, signature_date, parent_attending)
    values (${o.id}, ${appTenant}, ${ev.camp}, ${o.name}, '2019-04-01', 'May', ${o.phone ?? '+66812349999'},
            ${o.allergies ?? null}, ${o.diet ?? null}, ${JSON.stringify(o.days)}::jsonb, 'signed', ${T},
            ${o.parentAttending ?? false})`);
}

async function post<T>(cookie: string | null, url: string, payload: unknown, headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

async function get<T>(cookie: string, url: string) {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

const checkinUrl = (eventId: string, attendeeId: string) => `/events/${eventId}/attendees/${attendeeId}/checkin`;
const checkoutUrl = (eventId: string, attendeeId: string) => `/events/${eventId}/attendees/${attendeeId}/checkout`;
const reprintUrl = (eventId: string, attendeeId: string) => `/events/${eventId}/attendees/${attendeeId}/reprint`;
const body = (checkinId = newId()) => ({ branchId: central, checkinId, stationId: till, actionId: newId() });

/** The OTO App's own rows for one child's day, read straight from its table (both states, the seeded waiting included). */
async function appRows(attendeeId: string, date: string) {
  const res = await ctx.db.execute<{ status: string; checkin_ref: string | null; checked_in_by: string | null }>(sql`
    select status::text as status, checkin_ref, checked_in_by from otoapp.camp_attendance
     where camp_registration_id = ${attendeeId} and attendance_date = ${date}`);
  return res.rows;
}

async function posRows(attendeeIds: string[], date: string) {
  return ctx.db
    .select()
    .from(eventCheckin)
    .where(and(inArray(eventCheckin.attendeeId, attendeeIds), eq(eventCheckin.attendanceDate, date)));
}

async function bandsOf(checkinId: string) {
  return ctx.db.select().from(band).where(eq(band.eventCheckinId, checkinId)).orderBy(asc(band.createdAt));
}

async function lastRunOf(checkinId: string) {
  const [run] = await ctx.db
    .select()
    .from(opsRun)
    .where(and(eq(opsRun.name, ATTENDEE_CHECKIN_RUN), sql`${opsRun.detail}->>'checkinId' = ${checkinId}`))
    .orderBy(desc(opsRun.startedAt))
    .limit(1);
  return run!;
}

/** The OTO App's own camp check-in screen (`POST /api/core/camp-checkins/:id/check-in`, routes.ts), as SQL. */
async function appScreenCheckIn(registrationId: string, date: string) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status, checked_in_at, checked_in_by)
    values (${registrationId}, ${appTenant}, ${ev.camp}, ${date}, 'checked_in', now() at time zone 'UTC', 'App staff')
    on conflict (camp_registration_id, attendance_date) do update
      set status = 'checked_in', checked_in_at = now() at time zone 'UTC', checked_in_by = 'App staff', updated_at = now()`);
}

/** The OTO App's own "Undo check-in" (`POST /api/core/camp-checkins/:id/undo-check-in`, routes.ts), as SQL. */
async function appScreenUndo(registrationId: string, date: string) {
  await ctx.db.execute(sql`
    update otoapp.camp_attendance
       set status = 'waiting', checked_in_at = null, checked_in_by = null, checked_out_at = null, checked_out_by = null,
           updated_at = now()
     where camp_registration_id = ${registrationId} and attendance_date = ${date}`);
}

/** A paid camp day pass for a walk-up the app already has under the same name and phone (E2: merged). */
async function sellMergedPass(name: string): Promise<EventAttendeeWriteAnswer> {
  const res = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.camp}/passes`, {
    branchId: central,
    stationId: till,
    attendeeId: newId(),
    saleId: newId(),
    actionId: newId(),
    registerProperly: false,
    attendee: { name, parentName: 'May', parentPhone: '+66812349999' },
    tender: { method: 'cash', kind: 'cash', tenderedSatang: 100_000 },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** A Date at hh:mm on `date` in the branch's own clock (the branch is Asia/Bangkok, UTC+7, no DST). */
const localAt = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  tz = hkt!.timezone;
  dayStart = parseDayStart(hkt!.businessDayStart);
  expect(tz).toBe('Asia/Bangkok');
  T = businessDate(new Date(), tz, dayStart);
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  tillBox = t1!.boxId!;
  const [rec] = await ctx.db.select().from(account).where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
  accountId = rec!.id;

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 6 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e3-review')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await appEvent({ id: ev.camp, type: 'camp', title: 'Reef camp', date: D(-1), campEnd: D(2) });
  await appEvent({ id: ev.workshop, type: 'workshop', title: 'Kite workshop', date: T });

  for (const [id, name] of [
    [kid.race, 'Racer'],
    [kid.copy, 'Copy'],
    [kid.lost, 'Lost'],
    [kid.appWins, 'Appy'],
    [kid.undo, 'Undone'],
    [kid.out, 'Outie'],
    [kid.first, 'Firsty'],
    [kid.last, 'Lasty'],
    [kid.midnight, 'Midnight'],
  ] as const) {
    await register({ id, name, days: [], phone: `+6681${id.slice(-7).replace(/[^0-9]/g, '1').padEnd(7, '1')}` });
  }
  await register({ id: kid.band, name: 'Banda', days: [], allergies: 'Sesame', diet: 'Halal', parentAttending: true, phone: '+66810000001' });
  await register({ id: kid.edges, name: 'Edgy', days: [D(-1), D(2)], phone: '+66810000002' });
  await register({ id: kid.mergedAllergy, name: 'Mia', days: [D(1)], allergies: 'Peanuts', phone: '+66812349999' });
  await register({ id: kid.mergedMoved, name: 'Moe', days: [D(1)], phone: '+66812349999' });

  const workshop = (await appWrites.findTenantEvent(appPool, appTenant, ev.workshop))!;
  workshopKid = newId();
  const made = await appWrites.createEventAttendee(appPool, workshop, {
    id: workshopKid,
    childFullName: 'Kit',
    parentAttending: false,
    attendanceDays: [],
    source: 'pos',
  });
  expect(made.status).toBe(201);

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  plan.checkin.length = 0;
});

// =============================================================================
// 1. The mirror
// =============================================================================

describe('1. the mirror: a POS check-in lands in the OTO App once, and the app stays master', () => {
  it('the same check-in id sent twice at once: one check-in, one set of bands, one row in the app under that id', async () => {
    const id = newId();
    const [a, b] = await Promise.all([
      post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.race), body(id)),
      post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.race), body(id)),
    ]);
    // One of the two made it; the other is a replay of it — or, when its
    // read of the app ran after the first copy's write-back, refused "already
    // checked in" (the pinned finding below). Never a second check-in.
    const made = [a, b].filter((r) => r.status === 200 && !r.body.replayed);
    expect(made, JSON.stringify([a.body, b.body])).toHaveLength(1);
    for (const r of [a, b]) {
      if (r.status === 200) expect(r.body.checkin.id).toBe(id);
      else expect((r.body as unknown as { error: { code: string } }).error.code).toBe('EVENT_ALREADY_CHECKED_IN');
    }
    expect(await posRows([kid.race], T)).toHaveLength(1);
    expect(await bandsOf(id)).toHaveLength(1);
    const rows = await appRows(kid.race, T);
    expect(rows).toEqual([{ status: 'checked_in', checkin_ref: id, checked_in_by: expect.any(String) }]);
    // Every send the app answered was the same body under the same id.
    const mine = sent.filter((s) => s.body.id === id);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(new Set(mine.map((s) => JSON.stringify(s.body))).size).toBe(1);
    const [row] = await posRows([kid.race], T);
    expect(row!.syncState).toBe('synced');
  });

  /**
   * WAS A DEFECT (low; pinned with `it.fails`, fixed in the E3 fix round) — the
   * replay contract ("the same check-in id again answers what it made") gave
   * way to the app read: a second copy of one press whose `prior` read ran
   * before the first copy committed, and whose read of the app ran after the
   * first copy's write-back, found the app holding the child — under ITS OWN
   * check-in id — and was refused "Already checked in" (seen in the race
   * above). `appDayOf` now passes by the app's row whose `checkinRef` is this
   * very id. Pinned deterministically from the state that copy sees: the app
   * holds this id, the POS's read of its own rows came up empty.
   */
  it("a copy of one press that finds the app already holding its own check-in id is answered as that check-in, not refused", async () => {
    const id = newId();
    const event = (await appWrites.findTenantEvent(appPool, appTenant, ev.camp))!;
    expect((await appWrites.recordAttendeeCheckin(appPool, event, kid.copy, { id, date: T })).status).toBe(201);
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.copy), body(id));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin).toMatchObject({ id, status: 'checked_in', syncState: 'synced' });
  });

  it('the app took it but the answer was lost: pending here, one Retry, still one row in the app — a replay there', async () => {
    plan.checkin.push('lost_answer');
    const id = newId();
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.lost), body(id));
    expect(res.status).toBe(200);
    expect(res.body.checkin.syncState).toBe('pending');
    expect(await appRows(kid.lost, T)).toEqual([{ status: 'checked_in', checkin_ref: id, checked_in_by: expect.any(String) }]);

    const retried = await post<{ syncState: string }>(admin, `/ops/runs/${(await lastRunOf(id)).id}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.syncState).toBe('synced');
    expect(await appRows(kid.lost, T)).toHaveLength(1);
    const twice = sent.filter((s) => s.body.id === id);
    expect(twice.map((s) => s.answered)).toEqual([201, 200]);
    expect(new Set(twice.map((s) => JSON.stringify(s.body))).size).toBe(1);
  });

  it("the app's own screen checks the child in while the POS one waits: the app's stands, the POS's is refused there and stays refused", async () => {
    plan.checkin.push('unreachable');
    const id = newId();
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.appWins), body(id));
    expect(res.status).toBe(200);
    expect(res.body.checkin.syncState).toBe('pending');
    // Meanwhile, at the OTO App's own camp check-in screen.
    await appScreenCheckIn(kid.appWins, T);

    for (let press = 0; press < 2; press += 1) {
      const retried = await post<{ syncState: string }>(admin, `/ops/runs/${(await lastRunOf(id)).id}/retry`, {});
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      expect(retried.body.syncState).toBe('failed');
      // The app's own check-in is the one that stands, untouched by the POS's.
      expect(await appRows(kid.appWins, T)).toEqual([{ status: 'checked_in', checkin_ref: null, checked_in_by: 'App staff' }]);
    }
    const [row] = await posRows([kid.appWins], T);
    expect(row).toMatchObject({ syncState: 'failed' });
    expect(row!.syncError).toMatch(/^OTOAPP_ALREADY_CHECKED_IN/);
    // And no third POS check-in can be made for the child's day.
    const again = await post<{ error: { code: string } }>(reception, checkinUrl(ev.camp, kid.appWins), body());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('EVENT_ALREADY_CHECKED_IN');
  });

  describe("an undo in the OTO App after the POS's check-in reached it", () => {
    const id = newId();

    beforeAll(async () => {
      const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.undo), body(id));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.checkin.syncState).toBe('synced');
      await appScreenUndo(kid.undo, T);
      expect(await appRows(kid.undo, T)).toEqual([{ status: 'waiting', checkin_ref: id, checked_in_by: null }]);
    });

    it("is not undone by the till's replay of the same check-in id, nor by a Retry sweep (round 0's replay semantics)", async () => {
      const replay = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.undo), body(id));
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      await retryCheckinWriteBack(
        { db: ctx.db, directory },
        { operatorId, checkinId: id, errorCode: null, reach: { kind: 'operator' } },
      );
      // Sent straight to the app again — what a replay would land as — the
      // app answers its replay and still holds the day as "waiting".
      const event = (await appWrites.findTenantEvent(appPool, appTenant, ev.camp))!;
      const direct = await appWrites.recordAttendeeCheckin(appPool, event, kid.undo, { id, date: T });
      expect(direct).toMatchObject({ ok: true, status: 200, body: { replayed: true, checkin: { status: 'waiting' } } });
      expect(await appRows(kid.undo, T)).toEqual([{ status: 'waiting', checkin_ref: id, checked_in_by: null }]);
    });

    /**
     * WAS A DEFECT (Q1; pinned with `it.fails`, fixed in the E3 fix round) —
     * the roster laid the POS's synced mirror over the app's "waiting" and
     * showed the child IN after the app undid the check-in: the mirror
     * resurrected on the board what the master took back, against
     * `mergedCheckins`' own contract ("stands for a day the app does not show
     * YET"). The till was then also refused a fresh check-in for the child;
     * that is covered in `events-e3.test.ts` ("an undo in the OTO App").
     */
    it('the roster follows the app: the child is no longer in once the app undid the check-in', async () => {
      const { body: roster } = await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${T}`);
      expect(roster.groups.in).not.toContain(kid.undo);
      expect(roster.groups.outstanding).toContain(kid.undo);
    });
  });
});

// =============================================================================
// 2. The band
// =============================================================================

describe('2. the band: verified at the gate and at the food counter, reprinted through S2-11, no supervision', () => {
  const id = newId();
  let kidBand: typeof band.$inferSelect;
  let parentBand: typeof band.$inferSelect;

  beforeAll(async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.band), body(id));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await bandsOf(id);
    kidBand = rows.find((b) => b.kind === 'kid')!;
    parentBand = rows.find((b) => b.kind === 'adult')!;
  });

  it("both codes are the park's, signed for their own band ids; the gate's own copy of the bands denies the kid and admits the parent", async () => {
    const key = currentBandKey()!;
    expect(verifyBandCode(kidBand.code, key)).toMatchObject({ ok: true });
    expect(verifyBandCode(parentBand.code, key)).toMatchObject({ ok: true });
    // The branch's bands as the `bands` scope ships them, through the box's own reader.
    const shipped = JSON.parse(
      JSON.stringify(await ctx.db.select().from(band).where(and(eq(band.branchId, central), eq(band.status, 'active')))),
    ) as unknown[];
    const copy = bandCopyFrom(shipped, []);
    const common = { direction: 'entry' as const, key, lookup: (b: string) => copy.lookup(b), inside: () => false, unknownMeans: 'not_found' as const };
    expect(decideGate({ ...common, code: kidBand.code })).toMatchObject({ open: false, reason: 'KID_BAND' });
    expect(decideGate({ ...common, code: parentBand.code })).toMatchObject({ open: true, bandId: parentBand.id });
  });

  it('the food counter finds the child by the short code under the QR: the allergy and diet lines, no food', async () => {
    const res = await get<{ stay: Record<string, unknown> | null }>(
      reception,
      `/wallets/scan?branchId=${central}&key=${encodeURIComponent(bandShortCode(kidBand.code)!)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stay).toMatchObject({
      source: 'event',
      childName: 'Banda',
      allergiesMedical: 'Sesame',
      foodRestrictions: 'Halal',
      mayOrderFood: false,
      foodProvision: null,
    });
  });

  /**
   * WAS A DEFECT (low; pinned with `it.fails`, fixed in the E3 fix round) —
   * the PARENT band at the food counter resolved to the child:
   * `eventBandStayForKey` took any band of the check-in, so the parent's own
   * band read "Banda — Sesame", and an order taken on it named the child as
   * its holder (the prep ticket printed the child's allergy on the parent's
   * food). The prototype's parent wristband names the parent and carries no
   * allergy line (mockApi.ts:3829-3838: holderName = parentName, no
   * allergiesMedical); a drop-off guardian's band resolves to no stay at all,
   * and now so does the event parent band.
   */
  it("the parent band is the parent's: it does not read as the child, nor carry the child's allergy", async () => {
    const parent = await get<{ stay: Record<string, unknown> | null }>(
      reception,
      `/wallets/scan?branchId=${central}&key=${encodeURIComponent(parentBand.code)}`,
    );
    const stay = parent.status === 404 ? null : parent.body.stay;
    expect(stay?.childName ?? null).not.toBe('Banda');
    expect(stay?.allergiesMedical ?? null).toBeNull();
  });

  it('a reprint sent twice under one Idempotency-Key prints once, as copies of the original paper, through the S2-11 reprint path, audited once', async () => {
    const before = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(band);
    const payload = { branchId: central, stationId: till, reason: 'Band torn', actionId: newId() };
    const send = () =>
      post<EventCheckinAnswer>(reception, reprintUrl(ev.camp, kid.band), payload, {
        'idempotency-key': `e3-review-reprint-${id}`,
      });
    const first = await send();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);

    expect(first.body.checkin.kidBand!.id).toBe(kidBand.id);
    expect(first.body.checkin.parentBand!.id).toBe(parentBand.id);
    expect((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(band))[0]!.n).toBe(before[0]!.n);
    const [kidNow] = await ctx.db.select().from(band).where(eq(band.id, kidBand.id));
    expect(kidNow!.code).toBe(kidBand.code);

    expect(first.body.printJobs.map((j) => [j.kind, j.reprintOf, j.reprintReason])).toEqual([
      ['kids_wristband', kidBand.printedJobId, 'Band torn'],
      ['adult_wristband', parentBand.printedJobId, 'Band torn'],
    ]);
    const reprinted = await ctx.db
      .select()
      .from(bandEvent)
      .where(and(inArray(bandEvent.bandId, [kidBand.id, parentBand.id]), eq(bandEvent.kind, 'reprinted')));
    expect(reprinted).toHaveLength(2);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.band_reprint'), eq(auditLog.entityId, id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({
      reason: 'Band torn',
      bandIds: [kidBand.id, parentBand.id],
      printJobIds: first.body.printJobs.map((j) => j.id),
      stationId: till,
      boxId: tillBox,
    });
    // The reprinted kid band still carries the allergy line.
    const doc = await buildPrintDocument(ctx.db, { boxId: tillBox, operatorId }, first.body.printJobs[0]!.id);
    expect(doc.job).toMatchObject({ data: { holderName: 'Banda', allergy: 'Sesame', dietaryRequirement: 'Halal', bandCode: kidBand.code } });
  });

  it('once the child is checked out the food counter finds nobody behind the band, and a reprint is refused', async () => {
    const id2 = newId();
    expect((await post(reception, checkinUrl(ev.camp, kid.out), body(id2))).status).toBe(200);
    const [kb] = await bandsOf(id2);
    expect((await post(reception, checkoutUrl(ev.camp, kid.out), { branchId: central, stationId: till })).status).toBe(200);
    const scan = await get<{ stay: unknown }>(reception, `/wallets/scan?branchId=${central}&key=${encodeURIComponent(kb!.code)}`);
    expect(scan.status === 404 || scan.body.stay === null).toBe(true);
    const reprint = await post<{ error: { code: string } }>(reception, reprintUrl(ev.camp, kid.out), { branchId: central, stationId: till });
    expect(reprint.status).toBe(409);
    expect(reprint.body.error.code).toBe('EVENT_NOT_CHECKED_IN');
  });

  it('no supervision gate anywhere on the event path: no stay row, no supervision audit, and no event source names the gate', async () => {
    expect((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(checkin))[0]!.n).toBe(0);
    const supervision = await ctx.db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} like '%supervision%'`);
    expect(supervision).toEqual([]);
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    for (const file of [
      'apps/api/src/services/event-checkins.ts',
      'apps/api/src/services/sync-events.ts',
      'packages/box-agent/src/events-desk.ts',
      'packages/shared/src/event-checkin.ts',
    ]) {
      const code = readFileSync(join(root, file), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      expect(code, file).not.toMatch(/supervis/i);
    }
  });
});

// =============================================================================
// 3. The server rule, whatever ids are sent
// =============================================================================

describe('3. "Not registered for today" through every door, whatever ids are sent', () => {
  it('the attendee id in capitals is the same child: refused, nothing written, nothing sent', async () => {
    const id = newId();
    const res = await post<{ error: { code: string } }>(reception, checkinUrl(ev.camp.toUpperCase(), kid.edges.toUpperCase()), body(id));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_NOT_REGISTERED_TODAY');
    expect(await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, id))).toEqual([]);
    expect(sent.some((s) => s.body.id === id)).toBe(false);
  });

  it("another event's child, sent under this event: not on this event, nothing written", async () => {
    const id = newId();
    const res = await post<{ error: { code: string } }>(reception, checkinUrl(ev.camp, workshopKid), body(id));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_ATTENDEE_NOT_FOUND');
    expect(await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, id))).toEqual([]);
  });

  it("a check-in id already spent on another child (in capitals, too) is refused, and checks nobody in", async () => {
    const [raced] = await posRows([kid.race], T);
    const res = await post<{ error: { code: string } }>(
      reception,
      checkinUrl(ev.workshop, workshopKid),
      body(raced!.id.toUpperCase()),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_CHECKIN_ID_IN_USE');
    expect(await posRows([workshopKid], T)).toEqual([]);
  });

  /**
   * WAS A DEFECT (H5; pinned with `it.fails`, fixed in the E3 fix round) — the
   * till's own id for a child the OTO App MERGED into a registration it already
   * had (E2: same name and phone) bypassed the rule. `eventChildOf` found no
   * registration under the till's id and fell back to the link's own record of
   * the days it sent ([today]), never the app's registration, which has since
   * moved the child off today. The app's id was refused; the till's id — the
   * one "Check in now" sends after a pass sale — checked the child in, banded
   * them and wrote an attendance row into the app for a day the child is not
   * registered. A synced link is now read through to the app's registration.
   */
  describe("a walk-up the app merged into its registration, then moved off today in the app", () => {
    let linkId: string;

    beforeAll(async () => {
      const sold = await sellMergedPass('Moe');
      expect(sold.attendee).toMatchObject({ merged: true, otoappAttendeeId: kid.mergedMoved, syncState: 'synced' });
      linkId = sold.attendee.id;
      // The app's own "attendance days updated": today taken off, its waiting row with it.
      await ctx.db.execute(sql`
        update otoapp.camp_registrations set attendance_days = ${JSON.stringify([D(1)])}::jsonb where id = ${kid.mergedMoved}`);
      await ctx.db.execute(sql`
        delete from otoapp.camp_attendance where camp_registration_id = ${kid.mergedMoved} and attendance_date = ${T} and status = 'waiting'`);
    });

    it("by the app's id: refused, nothing written", async () => {
      const res = await post<{ error: { code: string } }>(reception, checkinUrl(ev.camp, kid.mergedMoved), body());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EVENT_NOT_REGISTERED_TODAY');
    });

    it("by the till's own id for the same child: refused the same, nothing written, nothing sent", async () => {
      const id = newId();
      const res = await post<{ error: { code: string } }>(reception, checkinUrl(ev.camp, linkId), body(id));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EVENT_NOT_REGISTERED_TODAY');
      expect(await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, id))).toEqual([]);
      expect(await appRows(kid.mergedMoved, T)).toEqual([]);
    });
  });
});

// =============================================================================
// 4. A merged walk-up's band
// =============================================================================

/**
 * WAS A DEFECT (H9, Q13; pinned with `it.fails`, fixed in the E3 fix round) —
 * the allergy line of a child the OTO App merged into a registration it
 * already had came from the till's walk-up form, not from the app's
 * registration: "Check in now" after the pass sale names the child by the
 * till's id, `eventChildOf` fell back to the body the till sent, and an
 * allergy the app holds ("Peanuts") was printed on no band and read by no food
 * counter. The roster (by the app's id) showed the allergy; the band did not.
 * The check-in now reads the app's registration and is stored under its id.
 */
describe('4. a returning camp child sold a day pass at the till: the band carries the allergy the app holds', () => {
  let linkId: string;
  let answer: EventCheckinAnswer;

  beforeAll(async () => {
    const sold = await sellMergedPass('Mia');
    expect(sold.attendee).toMatchObject({ merged: true, otoappAttendeeId: kid.mergedAllergy });
    linkId = sold.attendee.id;
    // "Check in now": the till's own id, as `handleEventPassCheckIn` sends it.
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, linkId), body());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    answer = res.body;
  });

  it("the roster, by the app's id, shows the child in with the app's allergy", async () => {
    const { body: roster } = await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${T}`);
    expect(roster.groups.in).toContain(kid.mergedAllergy);
    expect(roster.event.attendees!.find((a) => a.id === kid.mergedAllergy)).toMatchObject({ allergy: 'Peanuts' });
  });

  it('the kid band prints the allergy line, and the food counter reads it', async () => {
    const [kb] = await bandsOf(answer.checkin.id);
    const doc = await buildPrintDocument(ctx.db, { boxId: tillBox, operatorId }, kb!.printedJobId!);
    expect(doc.job).toMatchObject({ data: { holderName: 'Mia', allergy: 'Peanuts' } });
    const scan = await get<{ stay: Record<string, unknown> | null }>(
      reception,
      `/wallets/scan?branchId=${central}&key=${encodeURIComponent(kb!.code)}`,
    );
    expect(scan.body.stay).toMatchObject({ childName: 'Mia', allergiesMedical: 'Peanuts', mayOrderFood: false });
  });
});

// =============================================================================
// 5. The camp range, end to end
// =============================================================================

describe('5. a camp on every day of its range, and on no other, by the branch business date', () => {
  const at = async (attendeeId: string, now: Date) => {
    try {
      return await checkInEventAttendee(
        { db: ctx.db, directory },
        {},
        { accountId, operatorId, branchId: central },
        ev.camp,
        attendeeId,
        { branchId: central, checkinId: newId(), stationId: till },
        now,
      );
    } catch (err) {
      return err as { code?: string };
    }
  };

  it('its first day and its last day check the every-day child in; the days either side are not on', async () => {
    const before = await at(kid.first, localAt(D(-2), '12:00'));
    expect(before).toMatchObject({ code: 'EVENT_NOT_TODAY' });
    const first = await at(kid.first, localAt(D(-1), '12:00'));
    expect(first).toMatchObject({ answer: { checkin: { date: D(-1), status: 'checked_in' } } });
    const last = await at(kid.last, localAt(D(2), '12:00'));
    expect(last).toMatchObject({ answer: { checkin: { date: D(2), status: 'checked_in' } } });
    const after = await at(kid.last, localAt(D(3), '12:00'));
    expect(after).toMatchObject({ code: 'EVENT_NOT_TODAY' });
    // The app holds each day under the POS's id.
    expect(await appRows(kid.first, D(-1))).toEqual([expect.objectContaining({ status: 'checked_in' })]);
    expect(await appRows(kid.last, D(2))).toEqual([expect.objectContaining({ status: 'checked_in' })]);
  });

  it("the edge child is in on each edge day and refused between (H5), from the camp's own range", async () => {
    const day0 = await at(kid.edges, localAt(D(-1), '10:00'));
    expect(day0).toMatchObject({ answer: { checkin: { date: D(-1) } } });
    const mid = await at(kid.edges, localAt(D(1), '10:00'));
    expect(mid).toMatchObject({ code: 'EVENT_NOT_REGISTERED_TODAY' });
    const day3 = await at(kid.edges, localAt(D(2), '10:00'));
    expect(day3).toMatchObject({ answer: { checkin: { date: D(2) } } });
  });

  it("00:30 on the day after the camp is the branch's business date, never the device's (H20)", async () => {
    const now = localAt(D(3), '00:30');
    const day = businessDate(now, tz, dayStart);
    const res = await at(kid.midnight, now);
    if (day === D(2)) {
      // The business day has not turned yet: still the camp's last day.
      expect(res).toMatchObject({ answer: { checkin: { date: D(2) } } });
    } else {
      expect(day).toBe(D(3));
      expect(res).toMatchObject({ code: 'EVENT_NOT_TODAY' });
    }
  });
});

// =============================================================================
// The write-back left nothing behind it did not mean to
// =============================================================================

describe('what the attacks left behind', () => {
  it('no POS check-in of this file is left without a sync state, and every refused write-back says why', async () => {
    const rows = await ctx.db.select().from(eventCheckin);
    for (const r of rows) {
      expect(['synced', 'pending', 'failed']).toContain(r.syncState);
      if (r.syncState !== 'synced') expect(r.syncError, r.id).toBeTruthy();
    }
    // The link of each merged walk-up is synced: the app holds them.
    const links = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.merged, true));
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const l of links) expect(l.syncState).toBe('synced');
    // Every event band names its check-in, and none a sale.
    const eventBands = await ctx.db.select().from(band).where(sql`${band.eventCheckinId} is not null`);
    for (const b of eventBands) expect(b.saleId).toBeNull();
    const jobs = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(printJob).where(eq(printJob.subjectType, 'band'));
    expect(jobs[0]!.n).toBeGreaterThan(0);
  });
});
