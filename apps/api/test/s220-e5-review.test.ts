import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  booking,
  bookingRedemption,
  box,
  branch,
  device,
  deviceCredential,
  eventAttendeeLink,
  eventCheckin,
  kioskSession,
  opsRun,
  printJob,
  sale,
  saleLine,
  station,
  stationDevice,
  ticketPackage,
} from '@oto/db';
import { DEMO_BRANCH_CODE, seedDemoDay, seedDemoEvents } from '@oto/db/seed';
import type { BoxAgent } from '@oto/box-agent';
import {
  KIOSK_DEVICE_SCOPES,
  KIOSK_REASONS,
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type BookingPassCheckin,
  type EventCheckinAnswer,
  type EventDayAnswer,
  type KioskRedeemAnswer,
} from '@oto/shared';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { bookingQrOf } from '../src/services/booking-payment';
import { ATTENDEE_CREATE_RUN } from '../src/services/event-writes';
import { ATTENDEE_CHECKIN_RUN } from '../src/services/event-checkins';
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
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * S2-20 E5 — THE REVIEW OF THE LAST EVENTS ROUND (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md, the E5 row of §9, Q11, the
 * robustness note and §12's hazards). Driven against the lane, independently
 * of the builder's own suites, on the OTO App's own tables and its own
 * directory write code:
 *
 *   1. THE MONEY AND THE BAND ON AN ONLINE PASS — paid online and redeemed at
 *      the till (bands printed on the counter's own box) and at the kiosk
 *      (printed on the kiosk's printer): each pass child checked in exactly
 *      once, a replayed redemption — by its key, by a fresh press, by the
 *      kiosk's action id — issuing nothing twice; an unpaid or cancelled
 *      booking's passes never registered and never checked in; the public quote
 *      never pricing another park's, or another operator's, event; and two
 *      bookings carrying one attendee id never checking in each other's child.
 *   2. THE WRITE-BACK AT PAYMENT UNDER AN OUTAGE — both on Failures, one Retry
 *      sweeping both, an answer lost after the app wrote the child, and an app
 *      down at the payment AND at the redemption: one child in the app, always.
 *   3. THE CLOSING AUDIT (a)-(g) DRIVEN AGAIN, crossed with the booked pass
 *      where the item reaches it: (a) through the POS's own retry key, (c) on
 *      the reprint path, (d) and (g) on a redemption at the till and the kiosk,
 *      (f) on the public quote and on a redemption.
 *   4. THE SEED — two presses at once converge, Demo Branch 2 only.
 *   5. THE HAZARD MAP — H20 and H21 named to their tests (the register stops at
 *      H19), and the guards swept by scope: another park's manager and another
 *      operator's administrator.
 */

const PGW_SECRET = randomBytes(32).toString('hex');
const KIOSK_SECRET = randomBytes(32).toString('hex');
const SHA = (value: string) => createHash('sha256').update(value).digest('hex');
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

let ctx: TestContext;
let admin: string;
let reception: string;
let operatorId: string;
let central: string;
let chalong: string;
let till: string;
let tillBoxId: string;
let tillBandPrinterIds: string[];
let kioskId: string;
let kioskBoxId: string;
let bandPrinterId: string;
let twoHoursId: string;
let T: string;
let mode: 'weekday' | 'weekend';
let kioskAgent: BoxAgent;
let counterAgent: BoxAgent;
let appPool: pg.Pool;
let dbUrl: string;
const link: CuttableLink = { cut: false };
const D = (n: number) => addDaysToIsoDate(T, n);

const appTenant = newId();
const appCentral = newId();
const appChalong = newId();
const foreignTenant = newId();
const appForeign = newId();
const ev = {
  camp: newId(),
  workshop: newId(),
  later: newId(),
  chalong: newId(),
  foreign: newId(),
  /** (d) archived after its pass was paid. */
  doomed: newId(),
  /** (f) a stray date written after its pass was paid. */
  strayLater: newId(),
  /** (f) a stray date from the start. */
  strayNow: newId(),
};
const PRICE = { camp: { weekday: 600, weekend: 700 }, workshop: { weekday: 350, weekend: 400 } };
const fee = (p: { weekday: number; weekend: number }) => (mode === 'weekend' ? p.weekend : p.weekday) * 100;

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
  tenant?: string;
  appBranch?: string;
  type: string;
  title: string;
  date: string;
  campEnd?: string | null;
  price?: { weekday: number; weekend: number } | null;
}) {
  const price = e.price === undefined ? PRICE.workshop : e.price;
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
    values (
      ${e.id}, ${e.tenant ?? appTenant}, ${e.appBranch ?? appCentral}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null},
      '09:00', '15:00', ${price?.weekday ?? null}, ${price?.weekend ?? null}, 20, 20, 'upcoming')`);
}

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.231.${Math.floor(family / 250)}.${(family % 250) + 1}`;
};

interface Pass {
  eventId: string;
  attendeeId: string;
  attendee: Record<string, unknown>;
}
const pass = (eventId: string, name: string, extra: Record<string, unknown> = {}): Pass => ({
  eventId,
  attendeeId: newId(),
  attendee: { name, parentName: 'Khun Nid', parentPhone: '+66812345611', ...extra },
});

async function makeBooking(lines: Array<Record<string, unknown>>, passes: Pass[], extra: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: '0812345611',
      parentName: 'Khun Nid',
      tier: 'tourist',
      visitDate: T,
      lines,
      ...(passes.length ? { eventPasses: passes } : {}),
      ...extra,
    },
  });
}

async function payOrDecline(id: string, action: 'pay' | 'fail') {
  const opened = await ctx.app.inject({
    method: 'POST',
    url: `/public/bookings/${id}/checkout`,
    remoteAddress: familyAddress(),
    payload: { method: 'card' },
  });
  expect(opened.statusCode, opened.body).toBe(200);
  const pressed = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/hosted/${opened.json().attemptId as string}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `action=${action}`,
  });
  expect(pressed.statusCode, pressed.body).toBe(200);
}

interface Paid {
  id: string;
  reference: string;
  qr: string;
  totalSatang: number;
}

async function bookAndPay(lines: Array<Record<string, unknown>>, passes: Pass[]): Promise<Paid> {
  const made = await makeBooking(lines, passes);
  expect(made.statusCode, made.body).toBe(200);
  const id = made.json().id as string;
  await payOrDecline(id, 'pay');
  const [row] = await ctx.db.select().from(booking).where(eq(booking.id, id));
  expect(row!.status).toBe('paid');
  return { id, reference: row!.reference, qr: bookingQrOf(row!)!, totalSatang: row!.totalSatang };
}

async function redeemAtCounter(bookingId: string, key: string = newId(), cookie: string = reception) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/bookings/${bookingId}/redeem`,
    headers: { cookie, 'idempotency-key': key },
    payload: { stationId: till },
  });
  return {
    status: res.statusCode,
    headers: res.headers,
    raw: res.body,
    body: res.json() as Record<string, unknown> & { eventPasses?: BookingPassCheckin[]; error?: { code: string } },
  };
}

async function kioskRedeem(qr: string, actionId: string = newId()): Promise<{ statusCode: number; body: KioskRedeemAnswer }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${kioskId}/kiosk/redeem`,
    headers: { authorization: `Bearer ${KIOSK_SECRET}` },
    payload: { actionId, qr },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

async function drainBoxes(): Promise<void> {
  for (let round = 0; round < 60; round += 1) {
    const ran = (await kioskAgent.runPendingCommands()) + (await counterAgent.runPendingCommands());
    await kioskAgent.printing()!.jobs.tick();
    await counterAgent.printing()!.jobs.tick();
    if (ran === 0) return;
  }
  throw new Error('the boxes never ran out of commands');
}

/** The wristbands out of the till's own band printers so far. */
const tillBandPrints = () =>
  tillBandPrinterIds.reduce((sum, id) => sum + counterAgent.printing()!.printouts(id).length, 0);

const linkOf = async (id: string) => (await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, id)))[0] ?? null;
const checkinsOf = (eventId: string, attendeeId: string) =>
  ctx.db
    .select()
    .from(eventCheckin)
    .where(and(eq(eventCheckin.otoappEventId, eventId), eq(eventCheckin.attendeeId, attendeeId)));
const salesOfBooking = (bookingId: string) => ctx.db.select().from(sale).where(eq(sale.bookingId, bookingId));
const count = (rows: unknown[]) => rows.length;

async function appChildren(id: string): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(sql`
    select (select count(*) from otoapp.camp_registrations where id = ${id})::int
         + (select count(*) from otoapp.event_attendees where id = ${id})::int as n`);
  return res.rows[0]!.n;
}
async function appDay(eventId: string, attendeeId: string, date: string) {
  const res = await ctx.db.execute<{ status: string; checkin_ref: string | null }>(sql`
    select status, checkin_ref from otoapp_v.event_attendance
     where event_id = ${eventId} and attendee_id = ${attendeeId} and attendance_date = ${date}`);
  return res.rows;
}

async function failedRunOf(name: string, field: 'linkId' | 'checkinId', id: string) {
  const runs = await ctx.db
    .select()
    .from(opsRun)
    .where(and(eq(opsRun.name, name), eq(opsRun.outcome, 'failed'), sql`${opsRun.detail}->>${field} = ${id}`));
  return runs;
}

async function retry(runId: string) {
  const res = await ctx.app.inject({ method: 'POST', url: `/ops/runs/${runId}/retry`, headers: { cookie: admin }, payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { ok: boolean; syncState: string; sent: number; synced: number; waiting: number };
}

async function register(id: string, eventId: string, name: string, days: string[]) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, attendance_days, parent_signature, signature_date, parent_attending)
    values (${id}, ${appTenant}, ${eventId}, ${name}, '2019-04-01', 'May', '+66812355100',
            'Sesame', ${JSON.stringify(days)}::jsonb, 'signed', ${T}, true)`);
}

/** The OTO App's own "Undo check-in", stamped as the app stamps it. */
async function appUndoes(registrationId: string) {
  await ctx.db.execute(sql`
    update otoapp.camp_attendance
       set status = 'waiting', checked_in_at = null, checked_in_by = null, checked_out_at = null, checked_out_by = null,
           updated_at = (now() at time zone 'UTC')
     where camp_registration_id = ${registrationId} and attendance_date = ${T}`);
}

/** The OTO App's own check-in screen, which prints no band. */
async function appChecksIn(registrationId: string) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status, checked_in_at, checked_in_by)
    values (${registrationId}, ${appTenant}, ${ev.camp}, ${T}, 'checked_in', (now() at time zone 'UTC'), 'app staff')
    on conflict (camp_registration_id, attendance_date)
    do update set status = 'checked_in', checked_in_at = (now() at time zone 'UTC'), checked_in_by = 'app staff'`);
}

/** Wait until some statement on this database is waiting on a lock. */
async function someoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const res = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`);
    if ((res.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nothing waited on the open transaction');
}

/** A box's check-in row for the child, in a transaction of its own left open. */
async function openBoxRow(attendeeId: string): Promise<{ id: string; commit: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  await client.query('begin');
  const id = newId();
  await client.query(
    `insert into pos.event_checkin (
       id, operator_id, branch_id, otoapp_event_id, attendee_id, event_type, attendance_date, child_name,
       parent_attending, event_title, checked_in_at, origin, sync_state, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'camp', $6, 'Elsewhere', true, 'Coral camp', now(), 'box', 'pending', now(), now())`,
    [id, operatorId, central, ev.camp, attendeeId, T],
  );
  return {
    id,
    commit: async () => {
      await client.query('commit');
      await client.end();
    },
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
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  central = hkt!.id;
  operatorId = hkt!.operatorId;
  const [chal] = await ctx.db.select().from(branch).where(eq(branch.code, CHALONG_BRANCH_CODE));
  chalong = chal!.id;
  const [second] = await ctx.db.select().from(branch).where(eq(branch.code, SECOND_OPERATOR_BRANCH_CODE));
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
  const catalogue = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog?date=${T}` });
  mode = catalogue.json().rateMode.mode as 'weekday' | 'weekend';

  dbUrl = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as typeof appWrites;
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e5-review')`);
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${foreignTenant}, 'Other', 'other-e5-review')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central}),
           (${appChalong}, ${appTenant}, 'Robinson Chalong', 'Phuket', ${chalong}),
           (${appForeign}, ${foreignTenant}, 'Second park', 'Bangkok', ${second!.id})`);
  await appEvent({ id: ev.camp, type: 'camp', title: 'Coral camp', date: D(-1), campEnd: D(2), price: PRICE.camp });
  await appEvent({ id: ev.workshop, type: 'workshop', title: 'Kite workshop', date: T });
  await appEvent({ id: ev.later, type: 'workshop', title: 'Rocket workshop', date: D(5) });
  await appEvent({ id: ev.chalong, appBranch: appChalong, type: 'workshop', title: 'Chalong paint day', date: T });
  await appEvent({ id: ev.foreign, tenant: foreignTenant, appBranch: appForeign, type: 'workshop', title: 'Another operator’s day', date: T });
  await appEvent({ id: ev.doomed, type: 'workshop', title: 'Soon archived', date: T });
  await appEvent({ id: ev.strayLater, type: 'workshop', title: 'Soon mistyped', date: T });

  // THE VIRTUAL KIOSK BOX, as K1's and E5's: a kiosk-role box, its printers, the kiosk station.
  kioskBoxId = newId();
  await ctx.db.insert(box).values({ id: kioskBoxId, operatorId, branchId: central, name: 'Review kiosk box', slot: 'kiosk-r5', role: 'kiosk', status: 'unclaimed' });
  bandPrinterId = newId();
  const receiptPrinterId = newId();
  await ctx.db.insert(device).values([
    { id: bandPrinterId, operatorId, branchId: central, boxId: kioskBoxId, kind: 'band_printer', label: 'Review Kiosk Band Printer', transport: 'simulated', address: '192.168.88.231:9100', model: '4B-2082A', protocol: 'tspl2', reachability: 'reachable', paperStatus: 'ok' },
    { id: receiptPrinterId, operatorId, branchId: central, boxId: kioskBoxId, kind: 'receipt_printer', label: 'Review Kiosk Receipt Printer', transport: 'simulated', address: '192.168.88.232:9100', model: 'Xprinter XP-80', protocol: 'escpos', reachability: 'reachable', paperStatus: 'ok' },
  ]);
  kioskId = newId();
  await ctx.db.insert(station).values({ id: kioskId, operatorId, branchId: central, boxId: kioskBoxId, name: 'Review Kiosk', kind: 'kiosk', codePrefix: 'R5', capabilities: [], accessScope: 'all_staff' });
  await ctx.db.insert(stationDevice).values([
    { id: newId(), stationId: kioskId, role: 'kids_band', deviceId: bandPrinterId },
    { id: newId(), stationId: kioskId, role: 'adult_band', deviceId: bandPrinterId },
    { id: newId(), stationId: kioskId, role: 'receipt', deviceId: receiptPrinterId },
  ]);
  await ctx.db.insert(deviceCredential).values({
    id: newId(),
    operatorId,
    branchId: central,
    kind: 'kiosk',
    stationId: kioskId,
    label: 'Review Kiosk screen',
    secretHash: SHA(KIOSK_SECRET),
    scopes: [...KIOSK_DEVICE_SCOPES],
    pairedAt: new Date(),
  });
  kioskAgent = linkedAgent(ctx, kioskBoxId, 'kiosk-box-e5-review', link, { devices: true });
  expect(await kioskAgent.ensureRegistered()).toBe(true);
  await kioskAgent.syncConfig();
  attachInProcessBox(kioskAgent);

  // THE TILL'S OWN BOX, running its printers: the counter's pass bands print through it.
  const tillBands = await ctx.db
    .select({ id: stationDevice.deviceId })
    .from(stationDevice)
    .where(and(eq(stationDevice.stationId, till), inArray(stationDevice.role, ['kids_band', 'adult_band'])));
  tillBandPrinterIds = [...new Set(tillBands.map((d) => d.id))];
  expect(tillBandPrinterIds.length, 'the till has its band printers').toBeGreaterThan(0);
  counterAgent = linkedAgent(ctx, tillBoxId, 'counter-box-e5-review', link, { devices: true });
  expect(await counterAgent.ensureRegistered()).toBe(true);
  await counterAgent.syncConfig();
  attachInProcessBox(counterAgent);
}, 300_000);

afterAll(async () => {
  for (const agent of [kioskAgent, counterAgent]) {
    if (!agent) continue;
    agent.stop();
    detachInProcessBox(agent);
  }
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// 1. The money and the band on an online pass
// =============================================================================

describe('1. the money and the band on an online pass', () => {
  const ploy = pass(ev.camp, 'Ploy', { parentAttending: true, allergyFlag: true, allergyDetail: 'Shellfish' });
  const tum = pass(ev.workshop, 'Tum');
  let paid: Paid;
  const key = newId();
  let first: Awaited<ReturnType<typeof redeemAtCounter>>;
  let tillBandsBefore: number;

  it('1a. paid online and redeemed at the till: one sale for the sum paid, each pass child in once, the bands out of the counter’s own printer', async () => {
    paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }], [ploy, tum]);
    await drainBoxes();
    tillBandsBefore = tillBandPrints();
    first = await redeemAtCounter(paid.id, key);
    expect(first.status, first.raw).toBe(200);
    const sales = await salesOfBooking(paid.id);
    expect(sales).toHaveLength(1);
    expect((first.body.sale as { totals: { grossSatang: number } }).totals.grossSatang).toBe(paid.totalSatang);
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, sales[0]!.id));
    const passMoney = lines.filter((l) => l.componentKey === 'svc-camp-pass' || l.componentKey === 'svc-event-pass');
    expect(passMoney.reduce((s, l) => s + l.grossSatang, 0)).toBe(fee(PRICE.camp) + fee(PRICE.workshop));
    expect(first.body.eventPasses!.map((p) => p.outcome)).toEqual(['checked_in', 'checked_in']);
    expect(await checkinsOf(ev.camp, ploy.attendeeId)).toHaveLength(1);
    expect(await checkinsOf(ev.workshop, tum.attendeeId)).toHaveLength(1);
    // Each pass's link names this sale now, and only this one.
    expect(await linkOf(ploy.attendeeId)).toMatchObject({ saleId: sales[0]!.id, billing: 'booking' });
    expect(await linkOf(tum.attendeeId)).toMatchObject({ saleId: sales[0]!.id, billing: 'booking' });

    // The paper, through the counter box's real print pipeline: the ticket's kid
    // band, Ploy's kid and parent bands (her parent stays), Tum's kid band.
    await drainBoxes();
    expect(tillBandPrints() - tillBandsBefore).toBe(4);
    const [ployRow] = await checkinsOf(ev.camp, ploy.attendeeId);
    const passBandJobs = await ctx.db
      .select()
      .from(printJob)
      .where(inArray(printJob.subjectId, [ployRow!.kidBandId!, ployRow!.parentBandId!]));
    expect(passBandJobs.map((j) => [j.status, j.stationId])).toEqual([
      ['printed', till],
      ['printed', till],
    ]);
    // The OTO App holds each check-in once, under the till's ids.
    expect(await appDay(ev.camp, ploy.attendeeId, T)).toEqual([{ status: 'checked_in', checkin_ref: ployRow!.id }]);
  });

  it('1b. the same press replayed under its key is the same answer, and nothing happens twice', async () => {
    const before = {
      checkins: sent.checkins.length,
      bands: count(await ctx.db.select().from(band)),
      jobs: count(await ctx.db.select().from(printJob)),
    };
    const again = await redeemAtCounter(paid.id, key);
    expect(again.status).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await salesOfBooking(paid.id)).toHaveLength(1);
    expect(await checkinsOf(ev.camp, ploy.attendeeId)).toHaveLength(1);
    expect(await checkinsOf(ev.workshop, tum.attendeeId)).toHaveLength(1);
    expect(count(await ctx.db.select().from(band))).toBe(before.bands);
    expect(count(await ctx.db.select().from(printJob))).toBe(before.jobs);
    expect(sent.checkins.length).toBe(before.checkins);
  });

  it('1c. a fresh press on the redeemed booking is refused: no second sale, no second check-in, nothing told to the app', async () => {
    const bandsBefore = count(await ctx.db.select().from(band));
    const checkinsBefore = sent.checkins.length;
    const again = await redeemAtCounter(paid.id);
    expect(again.status).toBe(409);
    expect(again.body.error!.code).toBe('BOOKING_ALREADY_REDEEMED');
    expect(await salesOfBooking(paid.id)).toHaveLength(1);
    expect(await checkinsOf(ev.camp, ploy.attendeeId)).toHaveLength(1);
    expect(count(await ctx.db.select().from(band))).toBe(bandsBefore);
    expect(sent.checkins.length).toBe(checkinsBefore);
    // And the kiosk, scanning the same booking, is told it was redeemed.
    const scan = await kioskRedeem(paid.qr);
    expect(scan.body.outcome).toBe('failed');
    expect(scan.body.reason).toBe('BOOKING_ALREADY_REDEEMED');
    expect(await checkinsOf(ev.camp, ploy.attendeeId)).toHaveLength(1);
  });

  it('1d. the kiosk: one action id sent twice is one redemption, one check-in per pass child, one set of bands printed; the till then finds it redeemed', async () => {
    const nok = pass(ev.camp, 'Nok', { parentAttending: true });
    const kidPaid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }], [nok]);
    await drainBoxes();
    const printedBefore = kioskAgent.printing()!.printouts(bandPrinterId).length;
    const actionId = newId();
    const one = await kioskRedeem(kidPaid.qr, actionId);
    expect(one.statusCode, JSON.stringify(one.body)).toBe(200);
    expect(one.body.outcome).toBe('issued');
    // The ticket's kid and adult bands, and Nok's kid and parent bands: four, all from the kiosk.
    expect(one.body.bands).toHaveLength(4);
    expect(kioskAgent.printing()!.printouts(bandPrinterId).length - printedBefore).toBe(4);
    const two = await kioskRedeem(kidPaid.qr, actionId);
    expect(two.statusCode).toBe(200);
    expect(two.body).toMatchObject({ sessionId: one.body.sessionId, outcome: 'issued', replay: true });
    expect(two.body.bands.map((b) => b.shortCode).sort()).toEqual(one.body.bands.map((b) => b.shortCode).sort());
    await drainBoxes();
    expect(kioskAgent.printing()!.printouts(bandPrinterId).length - printedBefore).toBe(4);
    expect(await checkinsOf(ev.camp, nok.attendeeId)).toHaveLength(1);
    expect(await salesOfBooking(kidPaid.id)).toHaveLength(1);
    const sessions = await ctx.db.select().from(kioskSession).where(eq(kioskSession.bookingId, kidPaid.id));
    expect(sessions).toHaveLength(1);
    const counter = await redeemAtCounter(kidPaid.id);
    expect(counter.status).toBe(409);
    expect(counter.body.error!.code).toBe('BOOKING_ALREADY_REDEEMED');
    expect(await checkinsOf(ev.camp, nok.attendeeId)).toHaveLength(1);
  });

  it('1e. an unpaid booking’s passes are never registered, never in the app, and never checked in', async () => {
    const pim = pass(ev.camp, 'Pim');
    const made = await makeBooking([{ packageId: twoHoursId, kids: 1, adults: 0 }], [pim]);
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json().id as string;
    expect(await linkOf(pim.attendeeId)).toBeNull();
    expect(await appChildren(pim.attendeeId)).toBe(0);
    expect(sent.attendees).not.toContain(pim.attendeeId);
    const res = await redeemAtCounter(id);
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('BOOKING_NOT_REDEEMABLE');
    expect(await checkinsOf(ev.camp, pim.attendeeId)).toEqual([]);
    expect(await salesOfBooking(id)).toEqual([]);
    // Nor at the board: the child is on no roster.
    const board = await ctx.app.inject({
      method: 'POST',
      url: `/events/${ev.camp}/attendees/${pim.attendeeId}/checkin`,
      headers: { cookie: reception },
      payload: { branchId: central, checkinId: newId(), stationId: till },
    });
    expect(board.statusCode).toBe(404);
    // No QR is signed for an unpaid booking, so the kiosk has nothing to scan.
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    expect(bookingQrOf(row!)).toBeNull();
  });

  it('1f. a booking whose payment was declined: no link, nothing in the app, never redeemed — then cancelled, still nothing', async () => {
    const lek = pass(ev.workshop, 'Lek');
    const made = await makeBooking([], [lek]);
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json().id as string;
    await payOrDecline(id, 'fail');
    // A declined card leaves the booking open for another try, unpaid.
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    expect(row!.status).not.toBe('paid');
    expect(await linkOf(lek.attendeeId)).toBeNull();
    expect(await appChildren(lek.attendeeId)).toBe(0);
    const declined = await redeemAtCounter(id);
    expect(declined.status).toBe(409);
    expect(declined.body.error!.code).toBe('BOOKING_NOT_REDEEMABLE');
    // Closed as cancelled (the hosted page's payment failed for good): still no pass anywhere.
    await ctx.db.update(booking).set({ status: 'cancelled' }).where(eq(booking.id, id));
    expect(await linkOf(lek.attendeeId)).toBeNull();
    expect(await appChildren(lek.attendeeId)).toBe(0);
    const res = await redeemAtCounter(id);
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('BOOKING_NOT_REDEEMABLE');
    expect(await checkinsOf(ev.workshop, lek.attendeeId)).toEqual([]);
  });

  it('1g. the public quote never prices another park’s event, nor another operator’s — and writes nothing when it refuses', async () => {
    const offer = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/event-passes?date=${T}` });
    expect(offer.statusCode).toBe(200);
    const offered = (offer.json().passes as Array<{ id: string }>).map((p) => p.id);
    expect(offered).toContain(ev.workshop);
    expect(offered).not.toContain(ev.chalong);
    expect(offered).not.toContain(ev.foreign);
    // The Chalong event is live and priced: Chalong's own offer lists it.
    const atChalong = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CHALONG_BRANCH_CODE}/event-passes?date=${T}` });
    expect((atChalong.json().passes as Array<{ id: string }>).map((p) => p.id)).toContain(ev.chalong);
    const atSecond = await ctx.app.inject({ method: 'GET', url: `/public/branches/${SECOND_OPERATOR_BRANCH_CODE}/event-passes?date=${T}` });
    expect(JSON.stringify(atSecond.json())).not.toContain(ev.workshop);

    const before = count(await ctx.db.select().from(booking));
    for (const eventId of [ev.chalong, ev.foreign]) {
      const res = await makeBooking([{ packageId: twoHoursId, kids: 1, adults: 0 }], [pass(eventId, 'Stray')]);
      expect(res.statusCode, `${eventId}: ${res.body}`).toBe(400);
    }
    expect(count(await ctx.db.select().from(booking))).toBe(before);
  });

  /**
   * OBSERVATION (low; a hostile or broken booking site only) — the attendee id
   * is minted by the site, and `assertPassIdsFree` checks it against the links
   * when the booking is MADE. Two unpaid bookings carrying one id both pass
   * that check; the second to be paid meets the first's link (`on conflict do
   * nothing`) and its pass is silently not registered — no
   * `booking.event_passes_unregistered` row says so at payment. The counter is
   * told at the redemption ("never registered — ask a manager"), the money
   * stands, and — what matters — the second booking never checks in the
   * first's child.
   */
  it('1h. two bookings carrying one attendee id: the second never checks in the first’s child', async () => {
    const shared = pass(ev.workshop, 'Mook');
    const a = await makeBooking([], [shared]);
    const b = await makeBooking([], [{ ...shared, attendee: { ...shared.attendee, name: 'Someone else' } }]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    const aId = a.json().id as string;
    const bId = b.json().id as string;
    await payOrDecline(aId, 'pay');
    await payOrDecline(bId, 'pay');
    expect(await linkOf(shared.attendeeId)).toMatchObject({ bookingId: aId });
    const second = await redeemAtCounter(bId);
    expect(second.status, second.raw).toBe(200);
    expect(second.body.eventPasses!.map((p) => p.outcome)).toEqual(['not_found']);
    expect(await checkinsOf(ev.workshop, shared.attendeeId)).toEqual([]);
    // The first booking's child is checked in by the first booking.
    const firstRedeem = await redeemAtCounter(aId);
    expect(firstRedeem.status, firstRedeem.raw).toBe(200);
    expect(firstRedeem.body.eventPasses!.map((p) => p.outcome)).toEqual(['checked_in']);
    expect(await checkinsOf(ev.workshop, shared.attendeeId)).toHaveLength(1);
    expect(await appChildren(shared.attendeeId)).toBe(1);
  });
});

describe('1i. an owner note: Q12 now reaches the booking site', () => {
  /**
   * OBSERVATION (for the owner, with Q12; not a defect of this round) — the
   * public offer reads the till's own pass cards (`eventPassesFor`), which by
   * Q12's default (the prototype's `getActiveEventPasses`) never look at an
   * event's status. At the till a person sees the card; on the booking site a
   * stranger PAYS for it, and the pass is registered at payment. 10 of 156
   * production events are cancelled. Pinned as it stands, so Q12's answer
   * flips it on purpose.
   */
  it('a cancelled event is offered online and its pass is priced and booked, as the till’s cards show it', async () => {
    const cancelled = newId();
    await appEvent({ id: cancelled, type: 'workshop', title: 'Called-off workshop', date: T });
    await ctx.db.execute(sql`update otoapp.core_events set status = 'cancelled' where id = ${cancelled}`);
    const offer = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/event-passes?date=${T}` });
    expect((offer.json().passes as Array<{ id: string }>).map((p) => p.id)).toContain(cancelled);
    const quoted = await makeBooking([], [pass(cancelled, 'Wan')]);
    expect(quoted.statusCode, quoted.body).toBe(200);
    expect(quoted.json().totalSatang).toBe(fee(PRICE.workshop));
  });
});

// =============================================================================
// 2. The write-back at payment under an outage
// =============================================================================

describe('2. the write-back at payment under an outage', () => {
  it('2a. two bookings paid while the app is down: both wait on Failures, and one Retry sends each child once', async () => {
    const one = pass(ev.workshop, 'Outage One');
    const two = pass(ev.workshop, 'Outage Two');
    plan.attendee.push('down', 'down');
    await bookAndPay([], [one]);
    await bookAndPay([], [two]);
    expect(await linkOf(one.attendeeId)).toMatchObject({ syncState: 'pending' });
    expect(await linkOf(two.attendeeId)).toMatchObject({ syncState: 'pending' });
    expect(await appChildren(one.attendeeId)).toBe(0);
    const [run] = await failedRunOf(ATTENDEE_CREATE_RUN, 'linkId', two.attendeeId);
    expect(run, 'the outage is on Failures').toBeDefined();
    expect(await failedRunOf(ATTENDEE_CREATE_RUN, 'linkId', one.attendeeId)).toHaveLength(1);

    const swept = await retry(run!.id);
    expect(swept).toMatchObject({ ok: true, syncState: 'synced' });
    expect(swept.sent).toBeGreaterThanOrEqual(2);
    for (const p of [one, two]) {
      expect(await linkOf(p.attendeeId)).toMatchObject({ syncState: 'synced', otoappAttendeeId: p.attendeeId });
      expect(await appChildren(p.attendeeId)).toBe(1);
    }
    // A second press sends neither again.
    const sentBefore = sent.attendees.filter((id) => id === one.attendeeId || id === two.attendeeId).length;
    await retry(run!.id);
    expect(sent.attendees.filter((id) => id === one.attendeeId || id === two.attendeeId).length).toBe(sentBefore);
  });

  it('2b. the app wrote the child and its answer was lost: the Retry is a replay there, never a second child', async () => {
    const ghost = pass(ev.camp, 'Ghost answer');
    plan.attendee.push('lost');
    await bookAndPay([], [ghost]);
    expect(await linkOf(ghost.attendeeId)).toMatchObject({ syncState: 'pending' });
    expect(await appChildren(ghost.attendeeId)).toBe(1);
    const [run] = await failedRunOf(ATTENDEE_CREATE_RUN, 'linkId', ghost.attendeeId);
    await retry(run!.id);
    expect(await linkOf(ghost.attendeeId)).toMatchObject({ syncState: 'synced' });
    expect(await appChildren(ghost.attendeeId)).toBe(1);
  });

  it('2c. the app down at the payment AND at the redemption: the child is checked in from what the site sent, and later written once with their check-in', async () => {
    const dara = pass(ev.camp, 'Dara', { parentAttending: false });
    plan.attendee.push('down');
    const paid = await bookAndPay([], [dara]);
    // At the redemption the check-in's send tries the child first: still down.
    plan.attendee.push('down');
    const res = await redeemAtCounter(paid.id);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.eventPasses!.map((p) => p.outcome)).toEqual(['checked_in']);
    const [row] = await checkinsOf(ev.camp, dara.attendeeId);
    expect(row).toMatchObject({ syncState: 'pending', childName: 'Dara' });
    expect(await appChildren(dara.attendeeId)).toBe(0);
    // The app is back: the check-in's Retry writes the child, then the check-in.
    const [checkinRun] = await failedRunOf(ATTENDEE_CHECKIN_RUN, 'checkinId', row!.id);
    expect(checkinRun, 'the check-in is on Failures').toBeDefined();
    await retry(checkinRun!.id);
    expect(await checkinsOf(ev.camp, dara.attendeeId)).toEqual([expect.objectContaining({ id: row!.id, syncState: 'synced' })]);
    expect(await linkOf(dara.attendeeId)).toMatchObject({ syncState: 'synced' });
    expect(await appChildren(dara.attendeeId)).toBe(1);
    expect(await appDay(ev.camp, dara.attendeeId, T)).toEqual([{ status: 'checked_in', checkin_ref: row!.id }]);
    // The child's own old Failures entry, pressed now, sends nothing.
    const [childRun] = await failedRunOf(ATTENDEE_CREATE_RUN, 'linkId', dara.attendeeId);
    const sentBefore = sent.attendees.filter((id) => id === dara.attendeeId).length;
    await retry(childRun!.id);
    expect(sent.attendees.filter((id) => id === dara.attendeeId).length).toBe(sentBefore);
    expect(await appChildren(dara.attendeeId)).toBe(1);
  });
});

// =============================================================================
// 3. The closing audit, driven again
// =============================================================================

describe('3. the closing audit (a)-(g), driven again', () => {
  /**
   * FINDING E5R-1 (pinned with `it.fails`; the carried note (a) is closed for
   * a replay WITHOUT the POS's key only) — (a) THROUGH THE POS'S OWN RETRY.
   * The till sends every check-in press under
   * `Idempotency-Key: event-checkin:<checkinId>` with the same body on each
   * retry (apps/pos/src/api/events.ts `checkin`; `checkInOnPlatform` keeps the
   * press's ids for its retries). A press whose answer was lost is retried
   * exactly so — and that is the late replay (a) is about. The idempotency
   * store answers it before the route runs (plugins/idempotency.ts replays the
   * stored 200 for 24 hours), so `replayOf`'s new EVENT_CHECKIN_TAKEN_BACK
   * refusal is never reached: the counter is told "checked in" with the short
   * code of a kid band the set-aside revoked — the gate refuses it and the food
   * counter no longer reads its allergy line. Fix: the check-in route is
   * already idempotent by its check-in id (`replayOf`), so its answer should
   * not enter the replay store (a route declaration, as `secretResponse` keeps
   * a body out), or the POS should stop sending the key for this press.
   */
  const ana = newId();
  const firstId = newId();
  const firstAction = newId();
  /** The press's body as the POS keeps it for its retries: the same ids each time. */
  const firstBody = () => ({ branchId: central, checkinId: firstId, stationId: till, actionId: firstAction });
  const posKey = { 'idempotency-key': `event-checkin:${firstId}` };

  it('(a) the till checks Ana in as the POS sends it; the OTO App undoes it; the till checks her in again — the first is set aside, its bands revoked', async () => {
    await register(ana, ev.camp, 'Ana', []);
    const pressed = await ctx.app.inject({
      method: 'POST',
      url: `/events/${ev.camp}/attendees/${ana}/checkin`,
      headers: { cookie: reception, ...posKey },
      payload: firstBody(),
    });
    expect(pressed.statusCode, pressed.body).toBe(200);
    await appUndoes(ana);
    const secondId = newId();
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/events/${ev.camp}/attendees/${ana}/checkin`,
      headers: { cookie: reception, 'idempotency-key': `event-checkin:${secondId}` },
      payload: { branchId: central, checkinId: secondId, stationId: till, actionId: newId() },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect((await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, firstId)))[0]).toMatchObject({ undoneAt: expect.any(Date) });
    const revoked = (await ctx.db.select().from(band).where(eq(band.eventCheckinId, firstId))).map((b) => b.status);
    expect(revoked).toEqual(['revoked', 'revoked']);
  });

  it('(a) the same press replayed WITHOUT the POS’s key is told it was taken back (the closing audit’s fix, where it reaches)', async () => {
    const late = await ctx.app.inject({
      method: 'POST',
      url: `/events/${ev.camp}/attendees/${ana}/checkin`,
      headers: { cookie: reception },
      payload: firstBody(),
    });
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json().error.code).toBe('EVENT_CHECKIN_TAKEN_BACK');
  });

  it.fails('(a) a late replay of a taken-back check-in, sent as the POS sends it, is told it was taken back — never the revoked band codes', async () => {
    // The first press, retried by the POS after its answer was lost: the same body, the same key.
    const late = await ctx.app.inject({
      method: 'POST',
      url: `/events/${ev.camp}/attendees/${ana}/checkin`,
      headers: { cookie: reception, ...posKey },
      payload: firstBody(),
    });
    const answer = late.json() as EventCheckinAnswer & { error?: { code: string } };
    expect(
      { status: late.statusCode, code: answer.error?.code ?? null, kidBand: answer.checkin?.kidBand ?? null },
      'the POS’s own retry of the first press must not be answered "checked in" with its revoked bands',
    ).toEqual({ status: 409, code: 'EVENT_CHECKIN_TAKEN_BACK', kidBand: null });
  });

  it('(c) on the reprint path: the till reprints for a child the OTO App checked in while a box files her — decided again with the box’s row, never a 500', async () => {
    const zoe = newId();
    await register(zoe, ev.camp, 'Zoe', []);
    await appChecksIn(zoe);
    const elsewhere = await openBoxRow(zoe);
    const pressed = ctx.app.inject({
      method: 'POST',
      url: `/events/${ev.camp}/attendees/${zoe}/reprint`,
      headers: { cookie: reception },
      payload: { branchId: central, stationId: till },
    });
    await someoneWaitsOnALock();
    await elsewhere.commit();
    const res = await pressed;
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as EventCheckinAnswer).checkin).toMatchObject({ id: elsewhere.id, status: 'checked_in' });
    expect(await checkinsOf(ev.camp, zoe)).toHaveLength(1);
    // The box's row had no bands: the reprint issued them, once.
    const bands = await ctx.db.select().from(band).where(eq(band.eventCheckinId, elsewhere.id));
    expect(bands.map((b) => b.kind).sort()).toEqual(['adult', 'kid']);
  });

  it('(d) a booked pass whose event the OTO App archived: the till files the money and checks nobody in; the kiosk sends the family to the desk', async () => {
    const atTill = pass(ev.doomed, 'Archie');
    const atKiosk = pass(ev.doomed, 'Arch');
    const tillPaid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }], [atTill]);
    const kioskPaid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }], [atKiosk]);
    await ctx.db.execute(sql`update otoapp.core_events set is_archived = true where id = ${ev.doomed}`);
    const res = await redeemAtCounter(tillPaid.id);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.eventPasses!.map((p) => p.outcome)).toEqual(['not_found']);
    expect((res.body.sale as { totals: { grossSatang: number } }).totals.grossSatang).toBe(tillPaid.totalSatang);
    expect(await checkinsOf(ev.doomed, atTill.attendeeId)).toEqual([]);
    const scan = await kioskRedeem(kioskPaid.qr);
    expect(scan.statusCode, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body).toMatchObject({ outcome: 'handed_off', reason: KIOSK_REASONS.eventPassAtDesk });
    expect(scan.body.desk.required).toBe(true);
    // The ticket's band still came out of the kiosk; the pass child is the desk's.
    expect(scan.body.bands.map((b) => b.kind)).toEqual(['kid']);
    expect(await checkinsOf(ev.doomed, atKiosk.attendeeId)).toEqual([]);
    await drainBoxes();
  });

  it('(f) a stray date: the public offer still answers, a quote naming the event is refused (never a 500), and a redemption whose pass event went stray still files its money', async () => {
    const strayPaid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }], [pass(ev.strayLater, 'Sunny')]);
    await appEvent({ id: ev.strayNow, type: 'workshop', title: 'Slashed', date: `${T.slice(8)}/${T.slice(5, 7)}/${T.slice(0, 4)}` });
    await ctx.db.execute(sql`update otoapp.core_events set event_date = ${`${T.slice(8)}/${T.slice(5, 7)}/${T.slice(0, 4)}`} where id = ${ev.strayLater}`);
    const offer = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/event-passes?date=${T}` });
    expect(offer.statusCode, offer.body).toBe(200);
    const ids = (offer.json().passes as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(ev.workshop);
    expect(ids).not.toContain(ev.strayNow);
    const quoted = await makeBooking([], [pass(ev.strayNow, 'Rainy')]);
    expect(quoted.statusCode, quoted.body).toBe(400);
    const res = await redeemAtCounter(strayPaid.id);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.eventPasses!.map((p) => p.outcome)).toEqual(['not_found']);
    expect((res.body.sale as { totals: { grossSatang: number } }).totals.grossSatang).toBe(strayPaid.totalSatang);
    // The day itself still answers at the board.
    const day = await ctx.app.inject({ method: 'GET', url: `/events?branchId=${central}&date=${T}`, headers: { cookie: reception } });
    expect(day.statusCode).toBe(200);
    expect((day.json() as EventDayAnswer).events.map((e) => e.id)).toEqual(expect.arrayContaining([ev.camp, ev.workshop]));
  });

  it('(g) a booked pass whose registration the OTO App removed: not on the event — at the till by name, at the kiosk the desk’s', async () => {
    const tillChild = pass(ev.workshop, 'Gone One');
    const kioskChild = pass(ev.workshop, 'Gone Two');
    const tillPaid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }], [tillChild]);
    const kioskPaid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }], [kioskChild]);
    expect(await linkOf(tillChild.attendeeId)).toMatchObject({ syncState: 'synced' });
    await ctx.db.execute(sql`delete from otoapp.event_attendees where id in (${tillChild.attendeeId}, ${kioskChild.attendeeId})`);
    const res = await redeemAtCounter(tillPaid.id);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.eventPasses!).toEqual([expect.objectContaining({ outcome: 'not_found', checkin: null, printJobs: [] })]);
    expect(await checkinsOf(ev.workshop, tillChild.attendeeId)).toEqual([]);
    const scan = await kioskRedeem(kioskPaid.qr);
    expect(scan.body).toMatchObject({ outcome: 'handed_off', reason: KIOSK_REASONS.eventPassAtDesk });
    expect(await checkinsOf(ev.workshop, kioskChild.attendeeId)).toEqual([]);
    expect(await appChildren(kioskChild.attendeeId)).toBe(0);
    await drainBoxes();
  });
});

// =============================================================================
// 4. The seed
// =============================================================================

describe('4. the seed: convergent, Demo Branch 2 only', () => {
  it('two presses of the events seed at once write one camp, one workshop, one story time and one party — at the demo branch’s app row only', async () => {
    // The demo day itself first (it makes Demo Branch 2), then its events pressed twice at once.
    const first = await seedDemoDay(ctx.db);
    expect(first.events).toMatchObject({ skipped: null, events: 4 });
    const [demo] = await ctx.db.select().from(branch).where(eq(branch.code, DEMO_BRANCH_CODE));
    const ref = { id: demo!.id, name: demo!.name, operatorId: demo!.operatorId, timezone: demo!.timezone };
    // Another day, pressed twice at once, at the day's own instant (as `seedDemoDay` passes it).
    const other = D(1);
    const at = new Date(`${other}T00:00:00Z`);
    const [a, b] = await Promise.all([
      seedDemoEvents(ctx.db, ref, { on: other, at }),
      seedDemoEvents(ctx.db, ref, { on: other, at }),
    ]);
    expect(a.events + b.events).toBe(4);
    expect(a.eventsPresent + b.eventsPresent).toBe(4);
    // One app row for the demo branch, in the park's own tenant.
    const rows = await ctx.db.execute<{ id: string; tenant_id: string }>(sql`
      select id, tenant_id from otoapp.branches where core_branch_id = ${demo!.id}`);
    expect(rows.rows.map((r) => r.tenant_id)).toEqual([appTenant]);
    // Every seeded event is on that row and no other.
    const seeded = await ctx.db.execute<{ branch_id: string; n: number }>(sql`
      select branch_id, count(*)::int as n from otoapp.core_events
       where title in ('Oto Summer Camp — Week 1', 'Kids'' Art & Craft Workshop', 'Story Time', 'Sophia''s 5th Birthday Party')
       group by branch_id`);
    expect(seeded.rows).toEqual([{ branch_id: rows.rows[0]!.id, n: 8 }]);
    // Central's and Chalong's days gain nothing from it.
    for (const branchId of [central, chalong]) {
      const day = await ctx.app.inject({ method: 'GET', url: `/events?branchId=${branchId}&date=${T}`, headers: { cookie: admin } });
      expect(day.statusCode).toBe(200);
      const titles = (day.json() as EventDayAnswer).events.map((e) => e.title);
      expect(titles.filter((t) => /Summer Camp|Art & Craft|Story Time|Sophia/.test(t))).toEqual([]);
    }
    // A third press of the demo day writes nothing more.
    const again = await seedDemoDay(ctx.db);
    expect(again.events).toMatchObject({ events: 0, attendees: 0, eventsPresent: 4, skipped: null });
    // The booking site at the demo branch is offered the camp, the workshop and story time — never the party.
    const offer = await ctx.app.inject({ method: 'GET', url: `/public/branches/${DEMO_BRANCH_CODE}/event-passes?date=${T}` });
    expect(offer.statusCode, offer.body).toBe(200);
    // (Today's and tomorrow's: a camp running today, and one-off events today or later.)
    const titles = [...new Set((offer.json().passes as Array<{ title: string }>).map((p) => p.title))].sort();
    expect(titles).toEqual(["Kids' Art & Craft Workshop", 'Oto Summer Camp — Week 1', 'Story Time']);
  });
});

// =============================================================================
// 5. The hazard map and the guards
// =============================================================================

/** The title of every `it`/`describe`/`test` in a file, with how it is declared. */
function titlesOf(file: string): Array<{ call: string; title: string }> {
  const text = readFileSync(join(TEST_DIR, file), 'utf8');
  const found: Array<{ call: string; title: string }> = [];
  const re = /\b((?:it|describe|test)(?:\.\w+)?)\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
  for (const m of text.matchAll(re)) found.push({ call: m[1]!, title: m[3]! });
  return found;
}

describe('5. the hazard map and the guards', () => {
  it('H20 and H21 — the plan’s last two hazards, which the closing register stops short of — each name a plain test that runs', () => {
    const plan = readFileSync(join(TEST_DIR, '../../../docs/progress/plans/events-kiosk/PLAN.md'), 'utf8');
    const hazards = [...plan.matchAll(/^\| (H\d+) \|/gm)].map((m) => m[1]);
    expect(hazards).toEqual(Array.from({ length: 21 }, (_, i) => `H${i + 1}`));
    const register: Record<string, Array<[string, string]>> = {
      H20: [['s220-e3-review.test.ts', "00:30 on the day after the camp is the branch's business date"]],
      H21: [
        ['g17-round0-review.test.ts', "an id another tenant's attendee holds is refused"],
        ['g17-round0-review.test.ts', "tenant B's key on tenant A's event is 404 and writes nothing"],
      ],
    };
    const problems: string[] = [];
    for (const [hazard, tests] of Object.entries(register)) {
      for (const [file, fragment] of tests) {
        const hits = titlesOf(file).filter((t) => t.title.includes(fragment));
        if (hits.length === 0) problems.push(`${hazard}: no test in ${file} titled "${fragment}"`);
        for (const hit of hits) if (!['it', 'describe', 'test'].includes(hit.call)) problems.push(`${hazard}: ${file} is ${hit.call}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('another park’s manager can neither redeem this park’s booking nor check its pass child in; another operator’s administrator cannot find either', async () => {
    const kim = pass(ev.camp, 'Kim');
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }], [kim]);
    const chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);

    const byChalong = await redeemAtCounter(paid.id, newId(), chalongManager);
    expect(byChalong.status, byChalong.raw).toBe(403);
    const byForeign = await redeemAtCounter(paid.id, newId(), foreignAdmin);
    expect([403, 404], byForeign.raw).toContain(byForeign.status);
    for (const cookie of [chalongManager, foreignAdmin]) {
      const board = await ctx.app.inject({
        method: 'POST',
        url: `/events/${ev.camp}/attendees/${kim.attendeeId}/checkin`,
        headers: { cookie },
        payload: { branchId: central, checkinId: newId(), stationId: till },
      });
      expect([403, 404], board.body).toContain(board.statusCode);
      const read = await ctx.app.inject({ method: 'GET', url: `/bookings/${paid.id}`, headers: { cookie } });
      if (cookie === foreignAdmin) expect(read.statusCode).toBe(404);
    }
    // Nothing moved: the booking is still paid, nobody checked in, no sale.
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect(row!.status).toBe('paid');
    expect(await checkinsOf(ev.camp, kim.attendeeId)).toEqual([]);
    expect(await salesOfBooking(paid.id)).toEqual([]);
    expect(await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id))).toEqual([]);
    // The kiosk's credential is no staff session on the counter's redemption.
    const asKiosk = await ctx.app.inject({
      method: 'POST',
      url: `/bookings/${paid.id}/redeem`,
      headers: { authorization: `Bearer ${KIOSK_SECRET}`, 'idempotency-key': newId() },
      payload: { stationId: kioskId },
    });
    expect(asKiosk.statusCode).toBe(401);
    // And the audit trail of the passes' registration names no person.
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.attendee_create'), eq(auditLog.entityId, kim.attendeeId)));
    expect(audits.map((a) => a.actorAccountId)).toEqual([null]);
  });
});
