import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  booking,
  branch,
  eventAttendeeLink,
  eventCheckin,
  idempotencyKey,
  printJob,
  sale,
  station,
  stationDevice,
  ticketPackage,
} from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import {
  addDaysToIsoDate,
  bandShortCode,
  businessDate,
  newId,
  parseDayStart,
  type BookingPassCheckin,
  type EventCheckinAnswer,
} from '@oto/shared';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryCheckinAnswer,
  DirectoryCheckinBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * S2-20 E5 — THE RE-CHECK OF THE E5 FIX ROUND (SCRUM-217). The first review
 * (`s220-e5-review.test.ts`) found E5R-1: the POS's own retry of an event
 * check-in was answered from the idempotency store, so a check-in the OTO App
 * took back since was replayed as "checked in" with revoked band codes. The fix
 * declares `replaysByOwnId` on the check-in route, so the store claims no key
 * for it and the check-in id replays through `replayOf`. This file attacks the
 * fix where it moves behaviour, on the OTO App's own write code:
 *
 *   A. THE POS'S OWN RETRY, NOW THE ROUTE'S — a lost answer retried under the
 *      POS's key is the same check-in, the same band codes, nothing minted,
 *      queued, printed, audited or written to the app twice, and no key in the
 *      store; a retry after the app was down at the press finishes the write
 *      once; a double press of one id at once (the store used to answer the
 *      second IN_FLIGHT) is one check-in, one set of bands, one row in the app;
 *      the same key and id for another child is refused, writing nothing; and
 *      the route's guards still hold with the store out of the way.
 *   B. THE SAME CLASS OF LATE REPLAY ON THE COUNTER'S REDEMPTION — whose answer
 *      still enters the store, with the booked pass child's check-in and band
 *      codes in it (an observation, pinned as it stands).
 *   C. A PASS WHOSE ID ANOTHER BOOKING HOLDS, now said at payment — once, on the
 *      booking that could not register it, naming no other child; the booking's
 *      other pass still registered and checked in; a replayed confirmation
 *      saying nothing twice.
 *   D. THE GUARDS, SWEPT — the new declaration reaches the check-in alone, and
 *      every write on the events, parties and bookings surface is turned away
 *      without a session and declares a permission or a machine credential.
 */

const PGW_SECRET = randomBytes(32).toString('hex');

let ctx: TestContext;
let reception: string;
let central: string;
let chalong: string;
let till: string;
let tillBoxId: string;
let tillBandPrinterIds: string[];
let twoHoursId: string;
let T: string;
let counterAgent: BoxAgent;
let appPool: pg.Pool;
let dbUrl: string;
const link: CuttableLink = { cut: false };
const D = (n: number) => addDaysToIsoDate(T, n);

const appTenant = newId();
const appCentral = newId();
const appChalong = newId();
const ev = { camp: newId(), workshop: newId(), chalong: newId() };
const PRICE = { camp: { weekday: 600, weekend: 700 }, workshop: { weekday: 350, weekend: 400 } };

// --- The OTO App's directory, from its own source, with an outage switch -------

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
type AppOutcome<X> = { ok: true; status: number; body: X } | { ok: false; status: number; error: string; message: string };
let appWrites: {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(pool: pg.Pool, event: AppEvent, input: DirectoryAttendeeBody): Promise<AppOutcome<DirectoryAttendeeAnswer>>;
  recordAttendeeCheckin(pool: pg.Pool, event: AppEvent, attendeeId: string, input: DirectoryCheckinBody): Promise<AppOutcome<DirectoryCheckinAnswer>>;
};

/** `app`: answered; `down`: never reached; `lost`: the app wrote it, and its answer never came back. */
type Mode = 'app' | 'down' | 'lost';
const plan: { attendee: Mode[]; checkin: Mode[] } = { attendee: [], checkin: [] };
const sent: { attendees: string[]; checkins: string[] } = { attendees: [], checkins: [] };
const unreachable = { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };

function asOutcome<X>(o: AppOutcome<X>): DirectoryOutcome<X> {
  if (o.ok) return { ok: true, status: o.status, body: o.body };
  return { ok: false, status: o.status, code: `OTOAPP_${o.error.toUpperCase()}`, message: o.message, retryable: o.status >= 500 };
}

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body) {
    sent.attendees.push(body.id);
    const m = plan.attendee.shift() ?? 'app';
    if (m === 'down') return unreachable;
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const outcome = asOutcome(await appWrites.createEventAttendee(appPool, event, body));
    return m === 'lost' ? unreachable : outcome;
  },
  async checkinAttendee(eventId, attendeeId, body) {
    sent.checkins.push(body.id);
    const m = plan.checkin.shift() ?? 'app';
    if (m === 'down') return unreachable;
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const outcome = asOutcome(await appWrites.recordAttendeeCheckin(appPool, event, attendeeId, body));
    return m === 'lost' ? unreachable : outcome;
  },
};

// --- Helpers ----------------------------------------------------------------------

async function appEvent(e: {
  id: string;
  appBranch?: string;
  type: string;
  title: string;
  date: string;
  campEnd?: string | null;
  price?: { weekday: number; weekend: number };
}) {
  const price = e.price ?? PRICE.workshop;
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
    values (
      ${e.id}, ${appTenant}, ${e.appBranch ?? appCentral}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null},
      '09:00', '15:00', ${price.weekday}, ${price.weekend}, 20, 20, 'upcoming')`);
}

async function register(id: string, eventId: string, name: string) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, attendance_days, parent_signature, signature_date, parent_attending)
    values (${id}, ${appTenant}, ${eventId}, ${name}, '2019-04-01', 'May', '+66812355100',
            'Sesame', '[]'::jsonb, 'signed', ${T}, true)`);
}

/** The OTO App's own "Undo check-in", stamped as the app stamps it. */
async function appUndoes(registrationId: string) {
  await ctx.db.execute(sql`
    update otoapp.camp_attendance
       set status = 'waiting', checked_in_at = null, checked_in_by = null, checked_out_at = null, checked_out_by = null,
           updated_at = (now() at time zone 'UTC')
     where camp_registration_id = ${registrationId} and attendance_date = ${T}`);
}

async function appDay(eventId: string, attendeeId: string) {
  const res = await ctx.db.execute<{ status: string; checkin_ref: string | null }>(sql`
    select status, checkin_ref from otoapp_v.event_attendance
     where event_id = ${eventId} and attendee_id = ${attendeeId} and attendance_date = ${T}`);
  return res.rows;
}

async function appChildren(id: string): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(sql`
    select (select count(*) from otoapp.camp_registrations where id = ${id})::int
         + (select count(*) from otoapp.event_attendees where id = ${id})::int as n`);
  return res.rows[0]!.n;
}

/** One press of the check-in as the POS sends it: its key is `event-checkin:<checkinId>`. */
function press(
  attendeeId: string,
  body: { checkinId: string; actionId: string; branchId?: string; stationId?: string },
  opts: { cookie?: string; eventId?: string; key?: string | null } = {},
) {
  const key = opts.key === undefined ? `event-checkin:${body.checkinId}` : opts.key;
  return ctx.app.inject({
    method: 'POST',
    url: `/events/${opts.eventId ?? ev.camp}/attendees/${attendeeId}/checkin`,
    headers: {
      ...(opts.cookie === '' ? {} : { cookie: opts.cookie ?? reception }),
      ...(key ? { 'idempotency-key': key } : {}),
      'x-oto-action-id': body.actionId,
    },
    payload: { branchId: body.branchId ?? central, checkinId: body.checkinId, stationId: body.stationId ?? till, actionId: body.actionId },
  });
}

async function drainBox(): Promise<void> {
  for (let round = 0; round < 60; round += 1) {
    const ran = await counterAgent.runPendingCommands();
    await counterAgent.printing()!.jobs.tick();
    if (ran === 0) return;
  }
  throw new Error('the box never ran out of commands');
}

/** The wristbands out of the till's own band printers so far. */
const tillBandPrints = () =>
  tillBandPrinterIds.reduce((sum, id) => sum + counterAgent.printing()!.printouts(id).length, 0);

const checkinsOf = (eventId: string, attendeeId: string) =>
  ctx.db
    .select()
    .from(eventCheckin)
    .where(and(eq(eventCheckin.otoappEventId, eventId), eq(eventCheckin.attendeeId, attendeeId)));
const bandsOf = (checkinId: string) => ctx.db.select().from(band).where(eq(band.eventCheckinId, checkinId));
const auditsOf = (action: string, entityId: string) =>
  ctx.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
const keysNamed = (key: string) => ctx.db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key));
const linkOf = async (id: string) => (await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, id)))[0] ?? null;
const count = (rows: unknown[]) => rows.length;

/** Take one child-day's lock (`lockChildDay`'s key) in a transaction of its own, left open. */
async function holdChildDay(alias: string, eventId: string = ev.camp): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  await client.query('begin');
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`event-checkin:${eventId}:${alias}:${T}`]);
  return {
    release: async () => {
      await client.query('commit');
      await client.end();
    },
  };
}

/** Wait until `n` statements on this database wait on a lock. */
async function waiting(n: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const res = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`);
    if ((res.rows[0]?.n ?? 0) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${n} statements ever waited on the held lock`);
}

async function snapshot(checkinId: string) {
  const bands = await bandsOf(checkinId);
  return {
    bands: bands.length,
    jobs: bands.length ? count(await ctx.db.select().from(printJob).where(inArray(printJob.subjectId, bands.map((b) => b.id)))) : 0,
    audits: count(await auditsOf('event.checkin', checkinId)),
    sentToApp: sent.checkins.filter((id) => id === checkinId).length,
  };
}

// --- Booking helpers (the booking site, then the gateway) --------------------------

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.232.${Math.floor(family / 250)}.${(family % 250) + 1}`;
};

interface Pass {
  eventId: string;
  attendeeId: string;
  attendee: Record<string, unknown>;
}
const pass = (eventId: string, name: string, extra: Record<string, unknown> = {}): Pass => ({
  eventId,
  attendeeId: newId(),
  attendee: { name, parentName: 'Khun Dao', parentPhone: '+66812345622', ...extra },
});

async function makeBooking(lines: Array<Record<string, unknown>>, passes: Pass[]) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: '0812345622',
      parentName: 'Khun Dao',
      tier: 'tourist',
      visitDate: T,
      lines,
      ...(passes.length ? { eventPasses: passes } : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id as string;
}

/** Open the hosted page and press pay; answers the attempt so it can be pressed again. */
async function pay(id: string): Promise<string> {
  const opened = await ctx.app.inject({
    method: 'POST',
    url: `/public/bookings/${id}/checkout`,
    remoteAddress: familyAddress(),
    payload: { method: 'card' },
  });
  expect(opened.statusCode, opened.body).toBe(200);
  const attemptId = opened.json().attemptId as string;
  await gatewaySays(attemptId);
  return attemptId;
}

async function gatewaySays(attemptId: string) {
  const pressed = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/hosted/${attemptId}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'action=pay',
  });
  expect(pressed.statusCode, pressed.body).toBe(200);
}

async function redeemAtCounter(bookingId: string, key: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/bookings/${bookingId}/redeem`,
    headers: { cookie: reception, 'idempotency-key': key },
    payload: { stationId: till },
  });
  return {
    status: res.statusCode,
    headers: res.headers,
    raw: res.body,
    body: res.json() as Record<string, unknown> & { eventPasses?: BookingPassCheckin[]; error?: { code: string } },
  };
}

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: 'OTOTESTMERCHANT',
      PGW_SECRET_KEY: PGW_SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  central = hkt!.id;
  const [chal] = await ctx.db.select().from(branch).where(eq(branch.code, CHALONG_BRANCH_CODE));
  chalong = chal!.id;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  tillBoxId = t1!.boxId!;
  expect(tillBoxId, 'the till stands at a box').toBeTruthy();
  await takeStation(ctx.app, reception, till);
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, central), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;

  dbUrl = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as typeof appWrites;
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e5-review-2')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central}),
           (${appChalong}, ${appTenant}, 'Robinson Chalong', 'Phuket', ${chalong})`);
  await appEvent({ id: ev.camp, type: 'camp', title: 'Reef camp', date: D(-1), campEnd: D(2), price: PRICE.camp });
  await appEvent({ id: ev.workshop, type: 'workshop', title: 'Clay workshop', date: T });
  await appEvent({ id: ev.chalong, appBranch: appChalong, type: 'workshop', title: 'Chalong clay', date: T });

  // THE TILL'S OWN BOX, running its printers: the bands print through it.
  const tillBands = await ctx.db
    .select({ id: stationDevice.deviceId })
    .from(stationDevice)
    .where(and(eq(stationDevice.stationId, till), inArray(stationDevice.role, ['kids_band', 'adult_band'])));
  tillBandPrinterIds = [...new Set(tillBands.map((d) => d.id))];
  expect(tillBandPrinterIds.length, 'the till has its band printers').toBeGreaterThan(0);
  counterAgent = linkedAgent(ctx, tillBoxId, 'counter-box-e5-review-2', link, { devices: true });
  expect(await counterAgent.ensureRegistered()).toBe(true);
  await counterAgent.syncConfig();
  attachInProcessBox(counterAgent);
}, 300_000);

afterAll(async () => {
  if (counterAgent) {
    counterAgent.stop();
    detachInProcessBox(counterAgent);
  }
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// A. The POS's own retry, now the route's
// =============================================================================

describe('A. the POS’s own retry of a check-in, answered by the route', () => {
  it('A1. an answer lost and retried under the POS’s key: the same check-in and band codes; nothing minted, queued, printed, audited or sent twice; no key stored', async () => {
    const mali = newId();
    await register(mali, ev.camp, 'Mali');
    await drainBox();
    const printedBefore = tillBandPrints();
    const ids = { checkinId: newId(), actionId: newId() };
    const first = await press(mali, ids);
    expect(first.statusCode, first.body).toBe(200);
    const one = first.json() as EventCheckinAnswer;
    expect(one.replayed).toBe(false);
    expect(one.printJobs.length).toBe(2);
    await drainBox();
    expect(tillBandPrints() - printedBefore, 'a kid band and a parent band').toBe(2);
    const before = await snapshot(ids.checkinId);

    // The answer never reached the till; it presses again with the same ids and key.
    const again = await press(mali, ids);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    const two = again.json() as EventCheckinAnswer;
    expect(two).toMatchObject({ replayed: true, printJobs: [], notes: [] });
    expect(two.checkin.id).toBe(one.checkin.id);
    const minted = await bandsOf(ids.checkinId);
    const codeOf = (kind: string) => bandShortCode(minted.find((b) => b.kind === kind)!.code);
    expect(one.checkin.kidBand?.shortCode).toBe(codeOf('kid'));
    expect(two.checkin.kidBand?.shortCode).toBe(codeOf('kid'));
    expect(two.checkin.parentBand?.shortCode).toBe(codeOf('adult'));
    expect(await snapshot(ids.checkinId)).toEqual(before);
    await drainBox();
    expect(tillBandPrints() - printedBefore, 'printed once').toBe(2);
    expect(await checkinsOf(ev.camp, mali)).toHaveLength(1);
    expect(await appDay(ev.camp, mali)).toEqual([{ status: 'checked_in', checkin_ref: ids.checkinId }]);
    // The route is out of the store: the POS's key claimed nothing.
    expect(await keysNamed(`event-checkin:${ids.checkinId}`)).toEqual([]);
  });

  it('A2. the app down at the press: the POS’s retry under its key finishes the write — once in the app, the bands untouched', async () => {
    const niran = newId();
    await register(niran, ev.camp, 'Niran');
    const ids = { checkinId: newId(), actionId: newId() };
    plan.checkin.push('down');
    const first = await press(niran, ids);
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as EventCheckinAnswer).checkin.syncState).not.toBe('synced');
    expect(await appDay(ev.camp, niran)).toEqual([]);
    const bandsBefore = (await bandsOf(ids.checkinId)).map((b) => [b.id, b.status]);

    const again = await press(niran, ids);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, checkin: { id: ids.checkinId, syncState: 'synced' } });
    expect(await appDay(ev.camp, niran)).toEqual([{ status: 'checked_in', checkin_ref: ids.checkinId }]);
    expect((await bandsOf(ids.checkinId)).map((b) => [b.id, b.status])).toEqual(bandsBefore);
    expect(count(await auditsOf('event.checkin', ids.checkinId))).toBe(1);
    // A third press sends nothing more to the app.
    const sentBefore = sent.checkins.filter((id) => id === ids.checkinId).length;
    expect((await press(niran, ids)).statusCode).toBe(200);
    expect(sent.checkins.filter((id) => id === ids.checkinId).length).toBe(sentBefore);
  });

  it('A3. a double press — one id sent twice at once, which the store used to answer IN_FLIGHT — is one check-in, one set of bands, printed once, one row in the app', async () => {
    const ploy = newId();
    await register(ploy, ev.camp, 'Ploy');
    await drainBox();
    const printedBefore = tillBandPrints();
    const ids = { checkinId: newId(), actionId: newId() };
    const [a, b] = await Promise.all([press(ploy, ids), press(ploy, ids)]);
    expect([a.statusCode, b.statusCode], `${a.body}\n${b.body}`).toEqual([200, 200]);
    const answers = [a.json(), b.json()] as EventCheckinAnswer[];
    expect(answers.map((x) => x.replayed).sort()).toEqual([false, true]);
    const kid = (await bandsOf(ids.checkinId)).find((x) => x.kind === 'kid')!;
    expect(answers.map((x) => x.checkin.kidBand?.shortCode)).toEqual([bandShortCode(kid.code), bandShortCode(kid.code)]);
    expect(await checkinsOf(ev.camp, ploy)).toHaveLength(1);
    expect(await bandsOf(ids.checkinId)).toHaveLength(2);
    expect(count(await auditsOf('event.checkin', ids.checkinId))).toBe(1);
    await drainBox();
    expect(tillBandPrints() - printedBefore).toBe(2);
    expect(await appDay(ev.camp, ploy)).toEqual([{ status: 'checked_in', checkin_ref: ids.checkinId }]);
    const [row] = await checkinsOf(ev.camp, ploy);
    expect(row!.syncState).toBe('synced');
  });

  it('A3b. the double press held at the child-day’s lock until both have read “no such check-in”: the second meets the first’s row under the lock and replays it', async () => {
    const dao = newId();
    await register(dao, ev.camp, 'Dao');
    const ids = { checkinId: newId(), actionId: newId() };
    const held = await holdChildDay(dao);
    const both = Promise.all([press(dao, ids), press(dao, ids)]);
    await waiting(2);
    await held.release();
    const [a, b] = await both;
    expect([a.statusCode, b.statusCode], `${a.body}\n${b.body}`).toEqual([200, 200]);
    expect(([a.json(), b.json()] as EventCheckinAnswer[]).map((x) => x.replayed).sort()).toEqual([false, true]);
    expect(await checkinsOf(ev.camp, dao)).toHaveLength(1);
    expect(await bandsOf(ids.checkinId)).toHaveLength(2);
    expect(count(await auditsOf('event.checkin', ids.checkinId))).toBe(1);
    expect(await appDay(ev.camp, dao)).toEqual([{ status: 'checked_in', checkin_ref: ids.checkinId }]);
  });

  it('A4. the same key and check-in id for another child — once IDEMPOTENCY_MISMATCH — is refused by the route, writing nothing', async () => {
    const first = newId();
    const second = newId();
    await register(first, ev.camp, 'First');
    await register(second, ev.camp, 'Second');
    const ids = { checkinId: newId(), actionId: newId() };
    expect((await press(first, ids)).statusCode).toBe(200);
    const bandsBefore = count(await ctx.db.select().from(band));
    const other = await press(second, ids);
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json().error.code).toBe('EVENT_CHECKIN_ID_IN_USE');
    for (const b of await bandsOf(ids.checkinId)) {
      expect(other.body).not.toContain(b.code);
      expect(other.body).not.toContain(bandShortCode(b.code)!);
    }
    expect(await checkinsOf(ev.camp, second)).toEqual([]);
    expect(count(await ctx.db.select().from(band))).toBe(bandsBefore);
    expect(await appDay(ev.camp, second)).toEqual([]);
  });

  /**
   * A broken or hostile client only: the till mints a check-in id per child.
   * The two presses take different child-day locks, so nothing orders them
   * but the primary key — and with the store out of the way nothing answers
   * the second first. It is refused 409 (the key's DUPLICATE), never a 500,
   * and writes nothing.
   */
  it('A4b. one check-in id sent for two children at once, both past the read: one is checked in, the other refused 409 with nothing written', async () => {
    const left = newId();
    const right = newId();
    await register(left, ev.camp, 'Left');
    await register(right, ev.camp, 'Right');
    const ids = { checkinId: newId(), actionId: newId() };
    const heldLeft = await holdChildDay(left);
    const heldRight = await holdChildDay(right);
    const bandsBefore = count(await ctx.db.select().from(band));
    const both = Promise.all([press(left, ids), press(right, ids)]);
    await waiting(2);
    await Promise.all([heldLeft.release(), heldRight.release()]);
    const [a, b] = await both;
    expect([a.statusCode, b.statusCode].sort(), `${a.body}\n${b.body}`).toEqual([200, 409]);
    const rows = [...(await checkinsOf(ev.camp, left)), ...(await checkinsOf(ev.camp, right))];
    expect(rows.map((r) => r.id)).toEqual([ids.checkinId]);
    expect(count(await ctx.db.select().from(band)) - bandsBefore).toBe(2);
    expect(count(await auditsOf('event.checkin', ids.checkinId))).toBe(1);
  });

  it('A5. with the store out of the way the guards still hold: no session, another park’s manager and its own branch, none reads the check-in’s bands or writes', async () => {
    const kanya = newId();
    await register(kanya, ev.camp, 'Kanya');
    const ids = { checkinId: newId(), actionId: newId() };
    const made = await press(kanya, ids);
    expect(made.statusCode).toBe(200);
    const codes = (await bandsOf(ids.checkinId)).flatMap((b) => [b.code, bandShortCode(b.code)!]);
    expect(codes).toHaveLength(4);
    const bandsBefore = count(await ctx.db.select().from(band));

    const anonymous = await press(kanya, ids, { cookie: '' });
    expect(anonymous.statusCode).toBe(401);
    const manager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const atCentral = await press(kanya, ids, { cookie: manager });
    expect(atCentral.statusCode).toBe(403);
    // Its own park named in the body, this park's event and check-in id.
    const atChalong = await press(kanya, { ...ids, branchId: chalong }, { cookie: manager });
    expect(atChalong.statusCode, atChalong.body).toBeGreaterThanOrEqual(400);
    expect(atChalong.statusCode).toBeLessThan(500);
    // Its own park's event, this park's check-in id.
    const ownEvent = await press(kanya, { ...ids, branchId: chalong }, { cookie: manager, eventId: ev.chalong });
    expect(ownEvent.statusCode, ownEvent.body).toBeGreaterThanOrEqual(400);
    expect(ownEvent.statusCode).toBeLessThan(500);
    for (const res of [anonymous, atCentral, atChalong, ownEvent]) {
      for (const code of codes) expect(res.body).not.toContain(code);
    }
    expect(count(await ctx.db.select().from(band))).toBe(bandsBefore);
    expect(await checkinsOf(ev.camp, kanya)).toHaveLength(1);
    expect(await keysNamed(`event-checkin:${ids.checkinId}`)).toEqual([]);
  });

  it('A6. the taken-back press under the POS’s key, retried twice, is refused both times — and the check-in that stands is untouched', async () => {
    const wan = newId();
    await register(wan, ev.camp, 'Wan');
    const firstIds = { checkinId: newId(), actionId: newId() };
    expect((await press(wan, firstIds)).statusCode).toBe(200);
    await appUndoes(wan);
    const secondIds = { checkinId: newId(), actionId: newId() };
    expect((await press(wan, secondIds)).statusCode).toBe(200);
    const standing = (await bandsOf(secondIds.checkinId)).map((b) => [b.id, b.status]);
    for (let i = 0; i < 2; i += 1) {
      const late = await press(wan, firstIds);
      expect(late.statusCode, late.body).toBe(409);
      expect(late.json().error.code).toBe('EVENT_CHECKIN_TAKEN_BACK');
    }
    expect((await bandsOf(firstIds.checkinId)).map((b) => b.status)).toEqual(['revoked', 'revoked']);
    expect((await bandsOf(secondIds.checkinId)).map((b) => [b.id, b.status])).toEqual(standing);
    expect(await appDay(ev.camp, wan)).toEqual([{ status: 'checked_in', checkin_ref: secondIds.checkinId }]);
  });
});

// =============================================================================
// B. The same class of late replay, on the counter's redemption
// =============================================================================

describe('B. a late replay of the counter’s redemption (observation)', () => {
  /**
   * OBSERVATION (low; the same class as E5R-1, on a narrower window) — the
   * counter's redemption still enters the replay store, and its answer carries
   * each booked pass child's check-in with its band codes. The till keys it
   * "one idempotency key per booking per open dialog" (Till.tsx
   * `redeemKeyRef`), so a late replay needs the dialog left open over a lost
   * answer while the OTO App undoes the pass child and the board checks them
   * in again. Then the stored answer says "checked in" with the codes of the
   * bands that check-in revoked. Nothing is minted or printed by the replay,
   * and the paper the family holds is from the first press. Pinned as it
   * stands, for the lander's notes.
   */
  it('the redemption replayed under its key after the pass child was taken back and checked in again names the revoked band codes', async () => {
    const lin = pass(ev.camp, 'Lin', { parentAttending: false });
    const id = await makeBooking([{ packageId: twoHoursId, kids: 1, adults: 0 }], [lin]);
    await pay(id);
    const key = newId();
    const first = await redeemAtCounter(id, key);
    expect(first.status, first.raw).toBe(200);
    expect(first.body.eventPasses!.map((p) => p.outcome)).toEqual(['checked_in']);
    const [row] = await checkinsOf(ev.camp, lin.attendeeId);
    const firstCode = first.body.eventPasses![0]!.checkin!.kidBand!.shortCode;
    // The app undoes the pass child; the board checks them in again.
    await appUndoes(lin.attendeeId);
    const again = await press(lin.attendeeId, { checkinId: newId(), actionId: newId() });
    expect(again.statusCode, again.body).toBe(200);
    const revoked = await bandsOf(row!.id);
    expect(revoked.map((b) => b.status)).toEqual(['revoked']);
    expect(firstCode).toBe(bandShortCode(revoked[0]!.code));
    const bandsBefore = count(await ctx.db.select().from(band));

    const late = await redeemAtCounter(id, key);
    expect(late.status).toBe(200);
    expect(late.headers['x-oto-replay']).toBe('true');
    expect(late.body.eventPasses![0]!).toMatchObject({ outcome: 'checked_in' });
    expect(late.body.eventPasses![0]!.checkin!.kidBand!.shortCode).toBe(firstCode);
    // Nothing happened twice: one sale, no band minted by the replay.
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, id))).toHaveLength(1);
    expect(await checkinsOf(ev.camp, lin.attendeeId)).toHaveLength(2);
    expect(count(await ctx.db.select().from(band))).toBe(bandsBefore);
  });
});

// =============================================================================
// C. A pass whose id another booking holds, said at payment
// =============================================================================

describe('C. a pass whose id another booking registered first', () => {
  const shared = pass(ev.workshop, 'Som');
  const fresh = pass(ev.workshop, 'Fah');
  let aId: string;
  let bId: string;
  let bAttempt: string;
  let aAttempt: string;

  it('C1. said once, on the booking that could not register it, naming no other child or booking; its other pass is registered and in the app', async () => {
    aId = await makeBooking([], [shared]);
    bId = await makeBooking([{ packageId: twoHoursId, kids: 1, adults: 0 }], [
      { ...shared, attendee: { ...shared.attendee, name: 'Not Som' } },
      fresh,
    ]);
    aAttempt = await pay(aId);
    bAttempt = await pay(bId);
    expect(await linkOf(shared.attendeeId)).toMatchObject({ bookingId: aId });
    expect(await linkOf(fresh.attendeeId)).toMatchObject({ bookingId: bId, syncState: 'synced' });
    expect(await appChildren(fresh.attendeeId)).toBe(1);
    const [bRow] = await ctx.db.select().from(booking).where(eq(booking.id, bId));
    expect(bRow!.status).toBe('paid');

    const onB = await auditsOf('booking.event_passes_unregistered', bId);
    expect(onB).toHaveLength(1);
    expect(onB[0]!.after).toEqual({
      reference: bRow!.reference,
      error: 'ATTENDEE_ID_IN_USE',
      attendeeId: shared.attendeeId,
      eventId: ev.workshop,
    });
    expect(onB[0]!.actorAccountId).toBeNull();
    const [aRow] = await ctx.db.select().from(booking).where(eq(booking.id, aId));
    const said = JSON.stringify(onB[0]);
    for (const other of [aId, aRow!.reference, 'Som"', 'Not Som']) expect(said).not.toContain(other);
    expect(await auditsOf('booking.event_passes_unregistered', aId)).toEqual([]);
  });

  it('C2. the gateway’s confirmations pressed again, on both bookings, say nothing more', async () => {
    await gatewaySays(aAttempt);
    await gatewaySays(bAttempt);
    expect(await auditsOf('booking.event_passes_unregistered', bId)).toHaveLength(1);
    expect(await auditsOf('booking.event_passes_unregistered', aId)).toEqual([]);
    expect(await linkOf(shared.attendeeId)).toMatchObject({ bookingId: aId });
  });

  it('C3. redeemed at the counter: the money for both passes is filed once; the held pass is never registered and the other is checked in; the first booking’s child is the first booking’s', async () => {
    const [bRow] = await ctx.db.select().from(booking).where(eq(booking.id, bId));
    const res = await redeemAtCounter(bId, newId());
    expect(res.status, res.raw).toBe(200);
    expect((res.body.sale as { totals: { grossSatang: number } }).totals.grossSatang).toBe(bRow!.totalSatang);
    const outcomes = Object.fromEntries(res.body.eventPasses!.map((p) => [p.attendeeId, p.outcome]));
    expect(outcomes).toEqual({ [shared.attendeeId]: 'not_found', [fresh.attendeeId]: 'checked_in' });
    expect(await checkinsOf(ev.workshop, shared.attendeeId)).toEqual([]);
    expect(await checkinsOf(ev.workshop, fresh.attendeeId)).toHaveLength(1);
    const firstRedeem = await redeemAtCounter(aId, newId());
    expect(firstRedeem.status, firstRedeem.raw).toBe(200);
    expect(firstRedeem.body.eventPasses!.map((p) => p.outcome)).toEqual(['checked_in']);
    expect(await checkinsOf(ev.workshop, shared.attendeeId)).toHaveLength(1);
    expect(await appChildren(shared.attendeeId)).toBe(1);
  });
});

// =============================================================================
// D. The guards, swept
// =============================================================================

describe('D. the guards, swept', () => {
  const SURFACE = /^\/(events|parties|bookings)(\/|$)/;
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  it('D1. the new way out of the replay store reaches the event check-in alone, and that route still names its permission and its branch', () => {
    const out = ctx.app.routeRegistry.filter((r) => r.config.replaysByOwnId);
    expect(out.map((r) => `${r.method} ${r.url.replace(/\/$/, '')}`)).toEqual(['POST /events/:id/attendees/:attendeeId/checkin']);
    expect(out[0]!.config).toMatchObject({ permission: 'pos:event:checkin', target: { branchId: 'body.branchId' } });
  });

  it('D2. every write on the events, parties and bookings surface, pressed with no session, is turned away — never a 2xx, never a 5xx', async () => {
    const routes = ctx.app.routeRegistry.filter((r) => SURFACE.test(r.url) && MUTATING.has(r.method));
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual(
      expect.arrayContaining(['POST /events/:id/attendees/:attendeeId/checkin', 'POST /bookings/:id/redeem']),
    );
    expect(routes.length).toBeGreaterThanOrEqual(9);
    const leaks: string[] = [];
    for (const r of routes) {
      const url = r.url.replace(/:[A-Za-z]+/g, () => newId());
      const res = await ctx.app.inject({ method: r.method as 'POST', url, headers: { 'idempotency-key': newId() }, payload: {} });
      if (res.statusCode < 400 || res.statusCode >= 500) leaks.push(`${r.method} ${r.url}: ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
    expect(leaks).toEqual([]);
  });

  it('D3. each of them declares a permission or a machine credential (no session-only or open write)', () => {
    const open = ctx.app.routeRegistry
      .filter((r) => SURFACE.test(r.url) && MUTATING.has(r.method))
      .filter((r) => !r.config.permission && !r.config.credential && !r.config.dynamicPermission)
      .map((r) => `${r.method} ${r.url}`);
    expect(open).toEqual([]);
  });
});
