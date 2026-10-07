import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, bandEvent, branch, eventCheckin, opsRun, station } from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EventAttendeeWriteAnswer,
  type EventCheckinAnswer,
  type EventRosterAnswer,
} from '@oto/shared';
import { bandCopyFrom, decideGate } from '@oto/box-agent/gate';
import { ATTENDEE_CHECKIN_RUN, retryCheckinWriteBack } from '../src/services/event-checkins';
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
 * S2-20 E3 — REVIEW, ROUND 2: the fix round re-checked from the outside
 * (SCRUM-217; events-kiosk PLAN §9 E3, §4, §8, Q1; hazards H4, H5, H9).
 *
 * The first review's pins are flipped and pass. This file attacks what the fix
 * round built to flip them, rather than the pins again:
 *
 *  1. ONE CHILD, TWO IDS AT ONCE (F1/F2's fix) — a walk-up the OTO App merged
 *     into its registration is pressed by the till's link id and by the app's
 *     id in the same instant: one check-in, under the app's id, one set of
 *     bands, one row in the app. Then the other id reprints and checks out the
 *     same check-in, with the app's allergy line on the paper.
 *  2. THE UNDO, RACED (F4's fix) — after the app's own "Undo check-in", two
 *     tills check the child in again at once: one new check-in, the first set
 *     aside ONCE (its bands revoked once, one audit row), the app told once.
 *     The first press replayed and Retried afterwards changes nothing, and the
 *     gate's own copy of the bands refuses the parent band that was revoked.
 *  3. AN UNDO THE APP ITSELF REVERSED — the app undoes and then checks the
 *     child in again at its own screen: the POS's first check-in stands (it
 *     is not set aside), the till is refused a second, and checks the child
 *     out on the first.
 *
 * Written against the lane's code, not beside it: nothing is taken from the
 * builder's suites. The OTO App is its own write code
 * (`server/directory/eventWrites.ts`) over its own tables.
 */

let ctx: TestContext;
let central: string;
let operatorId: string;
let till: string;
let tillBox: string;
let reception: string;
let admin: string;
let T: string;
let appPool: pg.Pool;
const D = (n: number) => addDaysToIsoDate(T, n);

const appTenant = newId();
const appCentral = newId();
const camp = newId();
const kid = {
  /** Registered in the app for tomorrow with an allergy; sold today's pass at the till (merged). */
  pax: newId(),
  /** Every day; parent attending; checked in, undone in the app, then raced back in. */
  uno: newId(),
  /** Every day; checked in, undone in the app, then checked in again at the app's own screen. */
  duo: newId(),
};
const SHARED_PHONE = '+66812340001';

// --- The OTO App's directory, from its own source ------------------------------

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
type AppOutcome<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; message: string };
let appWrites: {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(pool: pg.Pool, event: AppEvent, input: DirectoryAttendeeBody): Promise<AppOutcome<DirectoryAttendeeAnswer>>;
  recordAttendeeCheckin(pool: pg.Pool, event: AppEvent, attendeeId: string, input: DirectoryCheckinBody): Promise<AppOutcome<DirectoryCheckinAnswer>>;
};

const sent: Array<{ attendeeId: string; body: DirectoryCheckinBody; answered: number }> = [];

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
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const outcome = await appWrites.recordAttendeeCheckin(appPool, event, attendeeId, body);
    sent.push({ attendeeId, body, answered: outcome.status });
    return asOutcome(outcome);
  },
};

// --- Helpers ---------------------------------------------------------------------

async function register(o: { id: string; name: string; days: string[]; allergies?: string; parentAttending?: boolean; phone: string }) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, attendance_days, parent_signature, signature_date, parent_attending)
    values (${o.id}, ${appTenant}, ${camp}, ${o.name}, '2019-04-01', 'May', ${o.phone},
            ${o.allergies ?? null}, ${JSON.stringify(o.days)}::jsonb, 'signed', ${T}, ${o.parentAttending ?? false})`);
}

async function post<T>(cookie: string, url: string, payload: unknown, headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { cookie, ...headers } });
  return { status: res.statusCode, body: res.json() as T };
}

async function get<T>(cookie: string, url: string) {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

const checkinUrl = (attendeeId: string) => `/events/${camp}/attendees/${attendeeId}/checkin`;
const checkoutUrl = (attendeeId: string) => `/events/${camp}/attendees/${attendeeId}/checkout`;
const reprintUrl = (attendeeId: string) => `/events/${camp}/attendees/${attendeeId}/reprint`;
const body = (checkinId = newId()) => ({ branchId: central, checkinId, stationId: till, actionId: newId() });
type Refusal = { error: { code: string } };

async function appRows(attendeeId: string, date: string) {
  const res = await ctx.db.execute<{ status: string; checkin_ref: string | null; checked_in_by: string | null }>(sql`
    select status::text as status, checkin_ref, checked_in_by from otoapp.camp_attendance
     where camp_registration_id = ${attendeeId} and attendance_date = ${date}`);
  return res.rows;
}

/** Every POS check-in of the camp today naming any of these ids (stored id or the till's link). */
async function posRows(ids: string[]) {
  return ctx.db
    .select()
    .from(eventCheckin)
    .where(
      and(
        eq(eventCheckin.otoappEventId, camp),
        eq(eventCheckin.attendanceDate, T),
        or(inArray(eventCheckin.attendeeId, ids), inArray(eventCheckin.linkId, ids)),
      ),
    )
    .orderBy(asc(eventCheckin.createdAt));
}

async function bandsOf(checkinId: string) {
  return ctx.db.select().from(band).where(eq(band.eventCheckinId, checkinId)).orderBy(asc(band.createdAt));
}

async function scan(code: string) {
  const res = await get<{ stay: Record<string, unknown> | null }>(reception, `/wallets/scan?branchId=${central}&key=${encodeURIComponent(code)}`);
  return res.status === 404 ? null : res.body.stay;
}

/** The OTO App's own "Undo check-in" (routes.ts `/api/core/camp-checkins/:id/undo-check-in`), as SQL: it leaves `checkin_ref`. */
async function appScreenUndo(registrationId: string) {
  await ctx.db.execute(sql`
    update otoapp.camp_attendance
       set status = 'waiting', checked_in_at = null, checked_in_by = null, checked_out_at = null, checked_out_by = null,
           updated_at = now()
     where camp_registration_id = ${registrationId} and attendance_date = ${T}`);
}

/** The OTO App's own camp check-in screen, as SQL: it sets the day's status and leaves `checkin_ref`. */
async function appScreenCheckIn(registrationId: string) {
  await ctx.db.execute(sql`
    update otoapp.camp_attendance
       set status = 'checked_in', checked_in_at = now() at time zone 'UTC', checked_in_by = 'App staff', updated_at = now()
     where camp_registration_id = ${registrationId} and attendance_date = ${T}`);
}

/** The gate's own copy of this branch's bands: the `bands` scope (active) and the `deny_list` scope (revoked, named). */
async function gateCopy() {
  const all = await ctx.db.select().from(band).where(eq(band.branchId, central));
  const active = JSON.parse(JSON.stringify(all.filter((b) => b.status === 'active'))) as unknown[];
  const revokedBands = all
    .filter((b) => b.status === 'revoked' || b.status === 'replaced')
    .map((b) => ({ id: b.id, kind: b.kind, gateAccess: b.gateAccess }));
  const copy = bandCopyFrom(active, [{ revokedBands }]);
  const key = currentBandKey()!;
  return (code: string) =>
    decideGate({ direction: 'entry', key, code, lookup: (id: string) => copy.lookup(id), inside: () => false, unknownMeans: 'not_found' });
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  tillBox = t1!.boxId!;

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 6 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as typeof appWrites;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e3-review-2')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
    values (${camp}, ${appTenant}, ${appCentral}, 'camp', 'Lagoon camp', ${D(-1)}, ${D(2)},
            '09:00', '15:00', 600, 700, 12, 10, 'upcoming')`);
  await register({ id: kid.pax, name: 'Pax', days: [D(1)], allergies: 'Sesame', phone: SHARED_PHONE });
  await register({ id: kid.uno, name: 'Uno', days: [], allergies: 'Milk', parentAttending: true, phone: '+66812340002' });
  await register({ id: kid.duo, name: 'Duo', days: [], phone: '+66812340003' });

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// 1. One child, two ids at once
// =============================================================================

describe("1. a merged walk-up pressed by the till's id and the app's id at once: one check-in, under the app's id", () => {
  let linkId: string;
  let winner: string;
  let loser: string;

  beforeAll(async () => {
    const sold = await post<EventAttendeeWriteAnswer>(reception, `/events/${camp}/passes`, {
      branchId: central,
      stationId: till,
      attendeeId: newId(),
      saleId: newId(),
      actionId: newId(),
      registerProperly: false,
      attendee: { name: 'Pax', parentName: 'May', parentPhone: SHARED_PHONE },
      tender: { method: 'cash', kind: 'cash', tenderedSatang: 100_000 },
    });
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    expect(sold.body.attendee).toMatchObject({ merged: true, otoappAttendeeId: kid.pax, syncState: 'synced' });
    linkId = sold.body.attendee.id;
    expect(linkId).not.toBe(kid.pax);
  });

  it('the two presses race: one is the check-in, the other is refused "already checked in"', async () => {
    const byLink = newId();
    const byApp = newId();
    const [a, b] = await Promise.all([
      post<EventCheckinAnswer | Refusal>(reception, checkinUrl(linkId), body(byLink)),
      post<EventCheckinAnswer | Refusal>(reception, checkinUrl(kid.pax), body(byApp)),
    ]);
    const made = [a, b].filter((r) => r.status === 200);
    expect(made, JSON.stringify([a.body, b.body])).toHaveLength(1);
    const refused = [a, b].find((r) => r.status !== 200)!;
    expect(refused.status).toBe(409);
    expect((refused.body as Refusal).error.code).toBe('EVENT_ALREADY_CHECKED_IN');
    winner = (made[0]!.body as EventCheckinAnswer).checkin.id;
    loser = winner === byLink ? byApp : byLink;
    expect((made[0]!.body as EventCheckinAnswer).replayed).toBe(false);
  });

  it("one POS row, stored under the app's id with the till's link beside it; one kid band; nothing for the refused press", async () => {
    const rows = await posRows([kid.pax, linkId]);
    expect(rows.map((r) => [r.id, r.attendeeId, r.linkId, r.allergy])).toEqual([[winner, kid.pax, linkId, 'Sesame']]);
    expect((await bandsOf(winner)).map((b) => b.kind)).toEqual(['kid']);
    expect(await bandsOf(loser)).toEqual([]);
    expect(await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, loser))).toEqual([]);
  });

  it("the OTO App holds one check-in, under the winner's id, sent to the app's registration — the refused id was never sent", async () => {
    expect(await appRows(kid.pax, T)).toEqual([{ status: 'checked_in', checkin_ref: winner, checked_in_by: expect.anything() }]);
    expect(sent.filter((s) => s.body.id === winner).map((s) => [s.attendeeId, s.answered])).toEqual([[kid.pax, 201]]);
    expect(sent.some((s) => s.body.id === loser)).toBe(false);
  });

  it("by the till's id, a reprint reprints the same band with the app's allergy line on the paper", async () => {
    const [kb] = await bandsOf(winner);
    const res = await post<EventCheckinAnswer>(reception, reprintUrl(linkId), { branchId: central, stationId: till, reason: 'Torn' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin).toMatchObject({ id: winner, kidBand: { id: kb!.id } });
    const doc = await buildPrintDocument(ctx.db, { boxId: tillBox, operatorId }, res.body.printJobs[0]!.id);
    expect(doc.job).toMatchObject({ data: { holderName: 'Pax', allergy: 'Sesame', bandCode: kb!.code } });
    expect(await scan(kb!.code)).toMatchObject({ childName: 'Pax', allergiesMedical: 'Sesame', mayOrderFood: false });
  });

  it("by the till's id, a check-out ends the same check-in; neither id checks the child in again; the band reads nobody", async () => {
    const [kb] = await bandsOf(winner);
    const out = await post<EventCheckinAnswer>(reception, checkoutUrl(linkId), { branchId: central, stationId: till });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.checkin).toMatchObject({ id: winner, status: 'checked_out' });
    for (const id of [kid.pax, linkId]) {
      const again = await post<Refusal>(reception, checkinUrl(id), body());
      expect(again.status, id).toBe(409);
      expect(again.body.error.code).toBe('EVENT_ALREADY_CHECKED_IN');
    }
    expect(await scan(kb!.code)).toBeNull();
    expect(await posRows([kid.pax, linkId])).toHaveLength(1);
  });
});

// =============================================================================
// 2. The undo, raced
// =============================================================================

describe("2. after the OTO App's own undo, two tills check the child in again at once", () => {
  const first = newId();
  const raceA = newId();
  const raceB = newId();
  let firstBands: (typeof band.$inferSelect)[];
  let winner: string;

  beforeAll(async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(kid.uno), body(first));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin.syncState).toBe('synced');
    firstBands = await bandsOf(first);
    expect(firstBands.map((b) => b.kind).sort()).toEqual(['adult', 'kid']);
    await appScreenUndo(kid.uno);
    expect(await appRows(kid.uno, T)).toEqual([{ status: 'waiting', checkin_ref: first, checked_in_by: null }]);
  });

  it('one new check-in, the other refused "already checked in"', async () => {
    const [a, b] = await Promise.all([
      post<EventCheckinAnswer | Refusal>(reception, checkinUrl(kid.uno), body(raceA)),
      post<EventCheckinAnswer | Refusal>(reception, checkinUrl(kid.uno), body(raceB)),
    ]);
    const made = [a, b].filter((r) => r.status === 200);
    expect(made, JSON.stringify([a.body, b.body])).toHaveLength(1);
    const refused = [a, b].find((r) => r.status !== 200)!;
    expect(refused.status).toBe(409);
    expect((refused.body as Refusal).error.code).toBe('EVENT_ALREADY_CHECKED_IN');
    winner = (made[0]!.body as EventCheckinAnswer).checkin.id;
  });

  it('the first check-in is set aside ONCE: one undone mark, each of its bands revoked once, one audit row', async () => {
    const rows = await posRows([kid.uno]);
    expect(rows.map((r) => [r.id, r.undoneAt === null])).toEqual([
      [first, false],
      [winner, true],
    ]);
    expect((await bandsOf(first)).map((b) => b.status)).toEqual(['revoked', 'revoked']);
    const revoked = await ctx.db
      .select()
      .from(bandEvent)
      .where(and(eq(bandEvent.kind, 'revoked'), inArray(bandEvent.bandId, firstBands.map((b) => b.id))));
    expect(revoked).toHaveLength(2);
    for (const r of revoked) expect(r.detail).toMatchObject({ eventCheckinId: first, nextCheckinId: winner });
    const undone = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkin_undone'), eq(auditLog.entityId, first)));
    expect(undone).toHaveLength(1);
  });

  it('the OTO App holds the winner, told once; the refused press was never sent', async () => {
    const loser = winner === raceA ? raceB : raceA;
    expect(await appRows(kid.uno, T)).toEqual([{ status: 'checked_in', checkin_ref: winner, checked_in_by: expect.anything() }]);
    expect(sent.filter((s) => s.body.id === winner)).toHaveLength(1);
    expect(sent.some((s) => s.body.id === loser)).toBe(false);
    expect(await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, loser))).toEqual([]);
  });

  it('the first press replayed afterwards, and its Retry, change nothing: no band, no send, the winner stands', async () => {
    const bandsBefore = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(band))[0]!.n;
    const sentBefore = sent.length;
    const replay = await post<EventCheckinAnswer>(reception, checkinUrl(kid.uno), body(first));
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, printJobs: [], checkin: { id: first } });
    await retryCheckinWriteBack({ db: ctx.db, directory }, { operatorId, checkinId: first, errorCode: null, reach: { kind: 'operator' } });
    expect(sent.slice(sentBefore).some((s) => s.body.id === first)).toBe(false);
    expect((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(band))[0]!.n).toBe(bandsBefore);
    expect(await appRows(kid.uno, T)).toEqual([{ status: 'checked_in', checkin_ref: winner, checked_in_by: expect.anything() }]);
    const rows = await posRows([kid.uno]);
    expect(rows.map((r) => [r.id, r.undoneAt === null])).toEqual([
      [first, false],
      [winner, true],
    ]);
    // The Failures page has nothing of the first press's left to offer.
    const failedRuns = await ctx.db
      .select()
      .from(opsRun)
      .where(
        and(eq(opsRun.name, ATTENDEE_CHECKIN_RUN), eq(opsRun.outcome, 'failed'), sql`${opsRun.detail}->>'checkinId' = ${first}`),
      );
    expect(failedRuns).toEqual([]);
  });

  it("the gate's own copy refuses the revoked parent band and admits the new one; the food counter reads only the new kid band", async () => {
    const gate = await gateCopy();
    const oldParent = firstBands.find((b) => b.kind === 'adult')!;
    const fresh = await bandsOf(winner);
    expect(gate(oldParent.code)).toMatchObject({ open: false, reason: 'BAND_REVOKED' });
    expect(gate(fresh.find((b) => b.kind === 'adult')!.code)).toMatchObject({ open: true });
    expect(await scan(firstBands.find((b) => b.kind === 'kid')!.code)).toBeNull();
    expect(await scan(fresh.find((b) => b.kind === 'kid')!.code)).toMatchObject({ childName: 'Uno', allergiesMedical: 'Milk' });
  });

  it('the roster shows the child in on the winner, with its bands', async () => {
    const { body: roster } = await get<EventRosterAnswer>(reception, `/events/${camp}/roster?branchId=${central}&date=${T}`);
    expect(roster.groups.in).toContain(kid.uno);
    const uno = roster.event.attendees!.find((a) => a.id === kid.uno)!;
    expect(uno.checkins.find((c) => c.date === T)).toMatchObject({ posCheckinId: winner, checkinRef: winner, status: 'checked_in' });
  });
});

// =============================================================================
// 3. An undo the app itself reversed
// =============================================================================

describe('3. the OTO App undoes, then checks the child in again at its own screen: the first POS check-in stands', () => {
  const first = newId();

  beforeAll(async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(kid.duo), body(first));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin.syncState).toBe('synced');
    await appScreenUndo(kid.duo);
    await appScreenCheckIn(kid.duo);
    expect(await appRows(kid.duo, T)).toEqual([{ status: 'checked_in', checkin_ref: first, checked_in_by: 'App staff' }]);
  });

  it('the roster shows the child in, and the till is refused a second check-in; nothing is set aside', async () => {
    const { body: roster } = await get<EventRosterAnswer>(reception, `/events/${camp}/roster?branchId=${central}&date=${T}`);
    expect(roster.groups.in).toContain(kid.duo);
    const again = await post<Refusal>(reception, checkinUrl(kid.duo), body());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('EVENT_ALREADY_CHECKED_IN');
    const rows = await posRows([kid.duo]);
    expect(rows.map((r) => [r.id, r.undoneAt])).toEqual([[first, null]]);
    expect((await bandsOf(first)).map((b) => b.status)).toEqual(['active']);
  });

  it('the till checks the child out on the first check-in', async () => {
    const out = await post<EventCheckinAnswer>(reception, checkoutUrl(kid.duo), { branchId: central, stationId: till });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.checkin).toMatchObject({ id: first, status: 'checked_out' });
    expect(await posRows([kid.duo])).toHaveLength(1);
  });
});

describe('what the attacks left behind', () => {
  it('one POS check-in per child per day stands, among the rows not set aside', async () => {
    const res = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from (
        select otoapp_event_id, attendee_id, attendance_date from pos.event_checkin
         where undone_at is null group by 1, 2, 3 having count(*) > 1) d`);
    expect(res.rows[0]!.n).toBe(0);
    const admins = await get<unknown>(admin, `/events/${camp}/roster?branchId=${central}&date=${T}`);
    expect(admins.status).toBe(200);
  });
});
