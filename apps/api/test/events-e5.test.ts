import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
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
import type { BoxAgent } from '@oto/box-agent';
import {
  BOOKING_EVENT_PASSES_ONLINE_ONLY,
  KIOSK_DEVICE_SCOPES,
  KIOSK_PRIVATE_FIELD,
  KioskRedeemAnswerSchema,
  PublicEventPassesAnswerSchema,
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type BookingEventPass,
  type BookingPassCheckin,
  type EventDetailAnswer,
  type KioskRedeemAnswer,
} from '@oto/shared';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { bookingQrOf } from '../src/services/booking-payment';
import { writeBackBookingPasses } from '../src/services/booking-event-passes';
import { ATTENDEE_CREATE_RUN } from '../src/services/event-writes';
import { ATTENDEE_CHECKIN_RUN } from '../src/services/event-checkins';
import { bookingChange } from '../src/services/sync';
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
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * S2-20 E5 — EVENT PASSES BOUGHT ONLINE (SCRUM-217; consistency #21; plan
 * docs/progress/plans/events-kiosk/PLAN.md §3 "Online passes", §4, Q6, Q11 and
 * the E5 row of §9).
 *
 * The prototype (`createBooking`, mockApi.ts 1085-1115; Till.tsx 437-462): a
 * paid online booking registers each pass's attendee — today only, stamped
 * "Walk-up added by Online booking" — and redeeming the booking at the till
 * checks each pass in and prints its bands, with no second payment, a child
 * already in skipped. On the platform, driven here end to end:
 *
 *   - the booking site is OFFERED the camp and the events a pass is sold for
 *     (never a party, never a name), and the QUOTE prices each pass at its flat
 *     price for the visit date's rate, taxed as the till's pass is — the total
 *     is the platform's, and a refused pass writes nothing;
 *   - each pass is REGISTERED WITH THE PAYMENT and WRITTEN BACK to the OTO App
 *     under the attendee id the site minted — a replay there, retried from
 *     Failures when the app is down (H3);
 *   - the counter's REDEMPTION files the booking's money, passes and tickets,
 *     on one sale, and CHECKS EACH PASS IN — bands minted and queued, the
 *     check-in written back (H4, H5 hold as the board's do);
 *   - the KIOSK does the same (Q11): the pass's bands print with the tickets'
 *     before anything commits, and a printer that fails takes the passes'
 *     check-ins back with the rest (H13);
 *   - a counter with the link down sends a booking with passes to reception.
 *
 * The OTO App is real as far as it can be without its server: its own tables
 * (schema `otoapp`, its own migrations) and its own directory write code
 * (`server/directory/eventWrites.ts`), read back through `otoapp_v`.
 */

const PGW_SECRET = randomBytes(32).toString('hex');
const KIOSK_SECRET = randomBytes(32).toString('hex');
const SHA = (value: string) => createHash('sha256').update(value).digest('hex');

let ctx: TestContext;
let admin: string;
let reception: string;
let operatorId: string;
let central: string;
let till: string;
let kioskId: string;
let kioskBoxId: string;
let bandPrinterId: string;
let receiptPrinterId: string;
let twoHoursId: string;
let T: string;
let mode: 'weekday' | 'weekend';
let agent: BoxAgent;
let appPool: pg.Pool;
const link: CuttableLink = { cut: false };
const D = (n: number) => addDaysToIsoDate(T, n);

const appTenant = newId();
const appCentral = newId();
const ev = {
  camp: newId(),
  workshop: newId(),
  later: newId(),
  free: newId(),
  party: newId(),
  unpriced: newId(),
};
/** The flat prices, in baht as the OTO App keeps them. */
const PRICE = { camp: { weekday: 600, weekend: 700 }, workshop: { weekday: 350, weekend: 400 } };
const fee = (p: { weekday: number; weekend: number }) => (mode === 'weekend' ? p.weekend : p.weekday) * 100;

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
  recordAttendeeCheckin(pool: pg.Pool, event: AppEvent, attendeeId: string, input: DirectoryCheckinBody): Promise<AppOutcome<DirectoryCheckinAnswer>>;
}
let appWrites: AppWrites;

const plan: { attendee: Array<'app' | 'unreachable'> } = { attendee: [] };
const sent: { attendees: DirectoryAttendeeBody[]; checkins: string[] } = { attendees: [], checkins: [] };
const unreachable = { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };

function asOutcome<T>(outcome: AppOutcome<T>): DirectoryOutcome<T> {
  if (outcome.ok) return { ok: true, status: outcome.status, body: outcome.body };
  return { ok: false, status: outcome.status, code: `OTOAPP_${outcome.error.toUpperCase()}`, message: outcome.message, retryable: outcome.status >= 500 };
}

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body) {
    sent.attendees.push(body);
    if ((plan.attendee.shift() ?? 'app') === 'unreachable') return unreachable;
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return asOutcome(await appWrites.createEventAttendee(appPool, event, body));
  },
  async checkinAttendee(eventId, attendeeId, body) {
    sent.checkins.push(body.id);
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return asOutcome(await appWrites.recordAttendeeCheckin(appPool, event, attendeeId, body));
  },
};

// --- Helpers ---------------------------------------------------------------------

async function appEvent(e: {
  id: string;
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
      entry_price_weekday_thb, entry_price_weekend_thb, child_name, parent_name, num_children, num_adults, status)
    values (
      ${e.id}, ${appTenant}, ${appCentral}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null},
      '09:00', '15:00', ${price?.weekday ?? null}, ${price?.weekend ?? null},
      ${e.type === 'birthday' ? 'Mali' : null}, ${e.type === 'birthday' ? 'Nok' : null}, 12, 10, 'upcoming')`);
}

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.225.${Math.floor(family / 250)}.${(family % 250) + 1}`;
};

interface Pass {
  eventId: string;
  attendeeId: string;
  attendee: Record<string, unknown>;
}
const pass = (eventId: string, name: string, extra: Record<string, unknown> = {}): Pass => ({
  eventId,
  attendeeId: newId(),
  attendee: { name, parentName: 'Khun Mali', parentPhone: '+66812345678', ...extra },
});

async function makeBooking(lines: Array<Record<string, unknown>>, passes: Pass[], extra: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: '0812345678',
      parentName: 'Khun Mali',
      tier: 'tourist',
      visitDate: T,
      lines,
      ...(passes.length ? { eventPasses: passes } : {}),
      ...extra,
    },
  });
}

interface Paid {
  id: string;
  reference: string;
  qr: string;
  totalSatang: number;
  eventPasses: BookingEventPass[];
}

async function bookAndPay(lines: Array<Record<string, unknown>>, passes: Pass[]): Promise<Paid> {
  const made = await makeBooking(lines, passes);
  expect(made.statusCode, made.body).toBe(200);
  const id = made.json().id as string;
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
    payload: 'action=pay',
  });
  expect(pressed.statusCode, pressed.body).toBe(200);
  const [row] = await ctx.db.select().from(booking).where(eq(booking.id, id));
  expect(row!.status).toBe('paid');
  return {
    id,
    reference: row!.reference,
    qr: bookingQrOf(row!)!,
    totalSatang: row!.totalSatang,
    eventPasses: made.json().eventPasses as BookingEventPass[],
  };
}

const linkOf = async (id: string) => (await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, id)))[0] ?? null;
const linksOfBooking = (bookingId: string) =>
  ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.bookingId, bookingId));

async function appCampChild(id: string) {
  const res = await ctx.db.execute<{ attendance_days: unknown; special_notes: string | null; parent_attending: boolean; allergies: string | null }>(
    sql`select attendance_days, special_notes, parent_attending, allergies from otoapp.camp_registrations where id = ${id}`,
  );
  return res.rows;
}
async function appEventChild(id: string) {
  const res = await ctx.db.execute<{ source: string; notes: string | null }>(
    sql`select source, notes from otoapp.event_attendees where id = ${id}`,
  );
  return res.rows;
}
async function appDay(eventId: string, attendeeId: string, date: string) {
  const res = await ctx.db.execute<{ status: string; checkin_ref: string | null }>(sql`
    select status, checkin_ref from otoapp_v.event_attendance
     where event_id = ${eventId} and attendee_id = ${attendeeId} and attendance_date = ${date}`);
  return res.rows[0] ?? null;
}

async function redeemAtCounter(bookingId: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/bookings/${bookingId}/redeem`,
    headers: { cookie: reception, 'idempotency-key': newId() },
    payload: { stationId: till },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> & { eventPasses?: BookingPassCheckin[] } };
}

async function kioskRedeem(qr: string): Promise<{ statusCode: number; body: KioskRedeemAnswer }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${kioskId}/kiosk/redeem`,
    headers: { authorization: `Bearer ${KIOSK_SECRET}` },
    payload: { actionId: newId(), qr },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

const printouts = (deviceId: string) => agent.printing()!.printouts(deviceId).length;

async function collectAll(): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    const ran = await agent.runPendingCommands();
    await agent.printing()!.jobs.tick();
    if (ran === 0) return;
  }
  throw new Error('the kiosk box never ran out of commands');
}

function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.push(k);
      keysOf(v, into);
    }
  }
  return into;
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
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  await takeStation(ctx.app, reception, till);
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, central), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  const catalogue = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog?date=${T}` });
  mode = catalogue.json().rateMode.mode as 'weekday' | 'weekend';

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e5')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await appEvent({ id: ev.camp, type: 'camp', title: 'Ocean camp', date: D(-1), campEnd: D(2), price: PRICE.camp });
  await appEvent({ id: ev.workshop, type: 'workshop', title: 'Slime workshop', date: T });
  await appEvent({ id: ev.later, type: 'workshop', title: 'Next week’s robots', date: D(6) });
  await appEvent({ id: ev.free, type: 'other', title: 'Story time', date: T, price: { weekday: 0, weekend: 0 } });
  await appEvent({ id: ev.party, type: 'birthday', title: "Mali's 6th", date: T });
  await appEvent({ id: ev.unpriced, type: 'workshop', title: 'Not priced yet', date: T, price: null });

  // THE VIRTUAL KIOSK BOX (as K1's): a kiosk-role box, its two printers, the kiosk station.
  kioskBoxId = newId();
  await ctx.db.insert(box).values({
    id: kioskBoxId,
    operatorId,
    branchId: central,
    name: 'Kiosk box 1',
    slot: 'kiosk-1',
    role: 'kiosk',
    status: 'unclaimed',
  });
  bandPrinterId = newId();
  receiptPrinterId = newId();
  await ctx.db.insert(device).values([
    { id: bandPrinterId, operatorId, branchId: central, boxId: kioskBoxId, kind: 'band_printer', label: 'Kiosk Band Printer', transport: 'simulated', address: '192.168.88.241:9100', model: '4B-2082A', protocol: 'tspl2', reachability: 'reachable', paperStatus: 'ok' },
    { id: receiptPrinterId, operatorId, branchId: central, boxId: kioskBoxId, kind: 'receipt_printer', label: 'Kiosk Receipt Printer', transport: 'simulated', address: '192.168.88.242:9100', model: 'Xprinter XP-80', protocol: 'escpos', reachability: 'reachable', paperStatus: 'ok' },
  ]);
  kioskId = newId();
  await ctx.db.insert(station).values({
    id: kioskId,
    operatorId,
    branchId: central,
    boxId: kioskBoxId,
    name: 'Kiosk 1',
    kind: 'kiosk',
    codePrefix: 'K1',
    capabilities: [],
    accessScope: 'all_staff',
  });
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
    label: 'Kiosk 1 screen',
    secretHash: SHA(KIOSK_SECRET),
    scopes: [...KIOSK_DEVICE_SCOPES],
    pairedAt: new Date(),
  });
  agent = linkedAgent(ctx, kioskBoxId, 'kiosk-box-e5', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  attachInProcessBox(agent);
}, 300_000);

afterAll(async () => {
  if (agent) {
    agent.stop();
    detachInProcessBox(agent);
  }
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// The offer and the quote
// =============================================================================

describe('the booking site is offered passes, and the platform prices them', () => {
  it('offers the camp running that day and the events that day or later — never a party, an unpriced event, or a name', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/event-passes?date=${T}` });
    expect(res.statusCode, res.body).toBe(200);
    const answer = PublicEventPassesAnswerSchema.parse(res.json());
    const ids = answer.passes.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([ev.camp, ev.workshop, ev.later, ev.free]));
    expect(ids).not.toContain(ev.party);
    expect(ids).not.toContain(ev.unpriced);
    const camp = answer.passes.find((p) => p.id === ev.camp)!;
    expect(camp).toEqual({
      id: ev.camp,
      type: 'camp',
      title: 'Ocean camp',
      startDate: D(-1),
      endDate: D(2),
      startTime: '09:00',
      endTime: '15:00',
      location: null,
      entryPrice: { weekdaySatang: 60_000, weekendSatang: 70_000 },
    });
    // What a stranger may read: no roster, no party, nobody.
    expect(keysOf(res.json()).filter((k) => /attendee|parent|phone|child|allerg|roster/i.test(k))).toEqual([]);
    // The camp is over three days later.
    const after = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/event-passes?date=${D(3)}` });
    expect((after.json().passes as Array<{ id: string }>).map((p) => p.id)).not.toContain(ev.camp);
  });

  it('prices each pass at its flat price for the visit date, as a ticket, on top of the tickets — the total is the platform’s', async () => {
    const plain = await makeBooking([{ packageId: twoHoursId, kids: 1, adults: 0 }], []);
    expect(plain.statusCode, plain.body).toBe(200);
    const camp = pass(ev.camp, 'Nok', { parentAttending: true });
    const workshop = pass(ev.workshop, 'Pim');
    const both = await makeBooking([{ packageId: twoHoursId, kids: 1, adults: 0 }], [camp, workshop]);
    expect(both.statusCode, both.body).toBe(200);
    const answer = both.json() as { totalSatang: number; eventPasses: BookingEventPass[] };
    // 7% VAT inclusive, no service charge: a pass adds exactly its price.
    expect(answer.totalSatang - (plain.json().totalSatang as number)).toBe(fee(PRICE.camp) + fee(PRICE.workshop));
    expect(answer.eventPasses).toEqual([
      expect.objectContaining({
        eventId: ev.camp,
        attendeeId: camp.attendeeId,
        eventType: 'camp',
        eventDate: T,
        attendanceDays: [T],
        priceSatang: fee(PRICE.camp),
        serviceId: 'svc-camp-pass',
        label: 'Camp day pass',
        attendeeName: 'Nok',
        parentAttending: true,
      }),
      expect.objectContaining({
        eventId: ev.workshop,
        eventType: 'event',
        eventDate: T,
        attendanceDays: [],
        priceSatang: fee(PRICE.workshop),
        serviceId: 'svc-event-pass',
        label: 'Event entry pass',
      }),
    ]);
    // Never tiered (R-98): the same price at the expat rate.
    const expat = await makeBooking([], [pass(ev.camp, 'Nok')], { tier: 'expat' });
    if (expat.statusCode === 200) expect(expat.json().totalSatang).toBe(fee(PRICE.camp));
  });

  it('a booking of passes alone is priced and written, with no ticket line', async () => {
    const res = await makeBooking([], [pass(ev.workshop, 'Solo')]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ totalSatang: fee(PRICE.workshop), lines: [] });
  });

  it('refuses a party, an unpriced event, an event not on sale that day, a shown total that is not its own and a repeated id — writing nothing', async () => {
    const before = (await ctx.db.select().from(booking)).length;
    const party = await makeBooking([], [pass(ev.party, 'Guest')]);
    expect(party.statusCode).toBe(409);
    expect(party.json().error.code).toBe('EVENT_PASS_NOT_FOR_PARTY');
    const unpriced = await makeBooking([], [pass(ev.unpriced, 'Guest')]);
    expect(unpriced.statusCode).toBe(409);
    expect(unpriced.json().error.code).toBe('EVENT_NOT_PRICED');
    // The camp is over by then.
    const late = await makeBooking([], [pass(ev.camp, 'Late')], { visitDate: D(3) });
    expect(late.statusCode).toBe(400);
    // The workshop is today, so it is not on sale for a visit next week.
    const gone = await makeBooking([], [pass(ev.workshop, 'Gone')], { visitDate: D(4) });
    expect(gone.statusCode).toBe(400);
    const shown = await makeBooking([], [pass(ev.workshop, 'Shown')], { displayedTotalSatang: 1 });
    expect(shown.statusCode).toBe(409);
    expect(shown.json().error.code).toBe('BOOKING_TOTAL_CHANGED');
    const twice = pass(ev.workshop, 'Twice');
    const repeated = await makeBooking([], [twice, { ...twice, eventId: ev.camp }]);
    expect(repeated.statusCode).toBe(400);
    expect((await ctx.db.select().from(booking)).length).toBe(before);
  });
});

// =============================================================================
// Registered at payment, written back
// =============================================================================

describe('each pass is registered with the payment and written to the OTO App (H3)', () => {
  let paid: Paid;
  const camp = pass(ev.camp, 'Lin', { parentAttending: true, allergyFlag: true, allergyDetail: 'Peanuts' });
  const workshop = pass(ev.workshop, 'Arun');

  it('a paid booking registers each pass under the id the site minted, billed to the booking, and the OTO App holds the child', async () => {
    paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }], [camp, workshop]);
    const links = await linksOfBooking(paid.id);
    expect(links.map((l) => l.id).sort()).toEqual([camp.attendeeId, workshop.attendeeId].sort());
    for (const l of links) {
      expect(l).toMatchObject({
        source: 'booking',
        billing: 'booking',
        bookingId: paid.id,
        saleId: null,
        syncState: 'synced',
        accountId: null,
        stationId: null,
      });
      expect(l.otoappAttendeeId).toBe(l.id);
    }
    expect(await linkOf(camp.attendeeId)).toMatchObject({ attendanceDays: [T], parentAttending: true, priceSnapshotSatang: fee(PRICE.camp) });
    // The prototype's stamp, the visit date only, the parent staying, the allergy line.
    const [reg] = await appCampChild(camp.attendeeId);
    expect(reg).toMatchObject({ parent_attending: true, allergies: 'Peanuts' });
    expect(reg!.attendance_days).toEqual([T]);
    expect(reg!.special_notes).toContain('Walk-up added by Online booking (today only)');
    const [att] = await appEventChild(workshop.attendeeId);
    expect(att).toMatchObject({ source: 'booking' });
    // The app's own `bookingId` is ITS group booking, never this one.
    const body = sent.attendees.find((b) => b.id === camp.attendeeId)!;
    expect(body).toMatchObject({ source: 'booking', createdBy: 'Online booking' });
    expect(body.bookingId ?? null).toBeNull();
    // Audited with the payment, and each write-back an integration run.
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.attendee_create'), eq(auditLog.entityId, camp.attendeeId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ source: 'booking', bookingId: paid.id, billing: 'booking', stationId: null, boxId: null });
    const runs = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CREATE_RUN), sql`${opsRun.detail}->>'linkId' = ${camp.attendeeId}`));
    expect(runs.map((r) => r.outcome)).toEqual(['ok']);
  });

  it('the counter reads the booking with its passes', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/bookings/${paid.id}`, headers: { cookie: reception } });
    expect(res.statusCode, res.body).toBe(200);
    const passes = res.json().eventPasses as BookingEventPass[];
    expect(passes.map((p) => p.attendeeName)).toEqual(['Lin', 'Arun']);
    // No allergy text on the counter's booking view: the roster is where it is read.
    expect(JSON.stringify(passes)).not.toContain('Peanuts');
  });

  it('a second write-back sends nothing, and a replayed one is one child in the app', async () => {
    const before = sent.attendees.length;
    expect(await writeBackBookingPasses(ctx.db, undefined, paid.id)).toBe(0);
    expect(sent.attendees.length).toBe(before);
    // The app answers the same id as a replay, never a second child.
    const event = await appWrites.findTenantEvent(appPool, appTenant, ev.camp);
    const again = await appWrites.createEventAttendee(appPool, event!, sent.attendees.find((b) => b.id === camp.attendeeId)!);
    expect(again).toMatchObject({ ok: true, body: { replayed: true } });
    expect(await appCampChild(camp.attendeeId)).toHaveLength(1);
  });

  it('the app down at payment: the money stands, the pass waits pending, and one Retry from Failures sends it once', async () => {
    plan.attendee.push('unreachable');
    const lost = pass(ev.workshop, 'Waits');
    const waiting = await bookAndPay([], [lost]);
    expect(await linkOf(lost.attendeeId)).toMatchObject({ syncState: 'pending', bookingId: waiting.id });
    expect(await appEventChild(lost.attendeeId)).toHaveLength(0);
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CREATE_RUN), eq(opsRun.outcome, 'failed'), sql`${opsRun.detail}->>'linkId' = ${lost.attendeeId}`));
    expect(run).toBeDefined();
    const retried = await ctx.app.inject({ method: 'POST', url: `/ops/runs/${run!.id}/retry`, headers: { cookie: admin }, payload: {} });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ ok: true, syncState: 'synced' });
    expect(await linkOf(lost.attendeeId)).toMatchObject({ syncState: 'synced', otoappAttendeeId: lost.attendeeId });
    expect(await appEventChild(lost.attendeeId)).toHaveLength(1);
  });

  it('the roster shows the booked child as outstanding before the booking is redeemed', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/events/${ev.camp}?branchId=${central}`, headers: { cookie: reception } });
    const lin = (res.json() as EventDetailAnswer).event.attendees!.find((a) => a.id === camp.attendeeId)!;
    expect(lin).toMatchObject({ name: 'Lin', bucket: 'outstanding', allergy: 'Peanuts', parentAttending: true });
  });

  it('a counter with the link down sends a booking with passes to reception: the box copy calls it online-only', async () => {
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect((bookingChange(row!, null) as { status: string }).status).toBe(BOOKING_EVENT_PASSES_ONLINE_ONLY);
  });

  // ---------------------------------------------------------------------------
  // Redeemed at the counter
  // ---------------------------------------------------------------------------

  it('redeeming at the counter files the passes and the tickets on one sale for what was paid, and checks each pass in', async () => {
    const before = sent.checkins.length;
    const res = await redeemAtCounter(paid.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const saleView = res.body.sale as { id: string; totals: { grossSatang: number } };
    expect(saleView.totals.grossSatang).toBe(paid.totalSatang);
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleView.id));
    const passLines = lines.filter((l) => l.componentKey === 'svc-camp-pass' || l.componentKey === 'svc-event-pass');
    expect(passLines.map((l) => [l.componentKey, l.grossSatang, l.taxableCategory]).sort()).toEqual(
      [
        ['svc-camp-pass', fee(PRICE.camp), 'tickets'],
        ['svc-event-pass', fee(PRICE.workshop), 'tickets'],
      ].sort(),
    );
    // The ticket bands are the tickets' only: a pass owes no sale band.
    const saleBands = await ctx.db.select().from(band).where(eq(band.saleId, saleView.id));
    expect(saleBands.map((b) => b.kind).sort()).toEqual(['adult', 'kid']);
    // Each pass's money is on that sale now.
    expect(await linkOf(camp.attendeeId)).toMatchObject({ saleId: saleView.id, saleLineId: expect.any(String) });

    const passes = res.body.eventPasses!;
    const lin = passes.find((p) => p.attendeeId === camp.attendeeId)!;
    const arun = passes.find((p) => p.attendeeId === workshop.attendeeId)!;
    expect(lin).toMatchObject({ outcome: 'checked_in', message: null, eventTitle: 'Ocean camp' });
    expect(lin.checkin).toMatchObject({ date: T, status: 'checked_in', origin: 'till' });
    expect(lin.checkin!.kidBand).not.toBeNull();
    expect(lin.checkin!.parentBand, 'the parent is staying').not.toBeNull();
    expect(lin.printJobs.map((j) => j.kind).sort()).toEqual(['adult_wristband', 'kids_wristband']);
    expect(arun).toMatchObject({ outcome: 'checked_in' });
    expect(arun.checkin!.parentBand).toBeNull();
    // Written back after the commit: the OTO App has both check-ins, under the till's ids.
    expect(sent.checkins.length - before).toBe(2);
    const linRow = (await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, lin.checkin!.id)))[0]!;
    expect(linRow).toMatchObject({ syncState: 'synced', allergy: 'Peanuts', childName: 'Lin', origin: 'till', stationId: till });
    expect(await appDay(ev.camp, camp.attendeeId, T)).toEqual({ status: 'checked_in', checkin_ref: lin.checkin!.id });
    // The kid band reads the allergy line at the food counter (H9).
    const kid = (await ctx.db.select().from(band).where(eq(band.eventCheckinId, linRow.id))).find((b) => b.kind === 'kid')!;
    const scan = await ctx.app.inject({
      method: 'GET',
      url: `/wallets/scan?branchId=${central}&key=${encodeURIComponent(kid.code)}`,
      headers: { cookie: reception },
    });
    expect(scan.json().stay).toMatchObject({ childName: 'Lin', allergiesMedical: 'Peanuts' });
    // Audited as the board's check-in is, naming the booking.
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkin'), eq(auditLog.entityId, linRow.id)));
    expect(audit!.after).toMatchObject({ bookingId: paid.id, surface: 'counter', stationId: till });
    const [shared] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'booking.redeem.sale'), eq(auditLog.entityId, paid.id)));
    expect(shared!.after).toMatchObject({ eventPasses: 2 });
    const runs = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CHECKIN_RUN), sql`${opsRun.detail}->>'checkinId' = ${linRow.id}`));
    expect(runs.map((r) => r.outcome)).toEqual(['ok']);
  });

  it('the same child is not checked in twice: the board refuses it now (H4)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/events/${ev.camp}/attendees/${camp.attendeeId}/checkin`,
      headers: { cookie: reception },
      payload: { branchId: central, checkinId: newId(), stationId: till },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EVENT_ALREADY_CHECKED_IN');
  });
});

describe('a pass for a later day stays booked; a child already in is skipped', () => {
  it('a booking of passes alone is redeemed: the camp child checked in at the board first is skipped, the later event left booked', async () => {
    const camp = pass(ev.camp, 'Early');
    const later = pass(ev.later, 'Robo');
    const free = pass(ev.free, 'Story');
    const paid = await bookAndPay([], [camp, later, free]);
    expect(paid.totalSatang).toBe(fee(PRICE.camp) + fee(PRICE.workshop));
    expect(await linkOf(free.attendeeId)).toMatchObject({ billing: 'free', bookingId: paid.id, priceSnapshotSatang: 0 });
    // The family is at the camp's door before reception: checked in at the board by the till's link id.
    const atBoard = await ctx.app.inject({
      method: 'POST',
      url: `/events/${ev.camp}/attendees/${camp.attendeeId}/checkin`,
      headers: { cookie: reception },
      payload: { branchId: central, checkinId: newId(), stationId: till },
    });
    expect(atBoard.statusCode, atBoard.body).toBe(200);

    const res = await redeemAtCounter(paid.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byId = new Map(res.body.eventPasses!.map((p) => [p.attendeeId, p]));
    expect(byId.get(camp.attendeeId)).toMatchObject({ outcome: 'already_in', checkin: null, printJobs: [] });
    expect(byId.get(later.attendeeId)).toMatchObject({ outcome: 'not_today', checkin: null });
    expect(byId.get(later.attendeeId)!.message).toContain(D(6));
    expect(byId.get(free.attendeeId)).toMatchObject({ outcome: 'checked_in' });
    // The sale is the paid passes: the free one has no line, and the money is whole.
    const saleId = (res.body.sale as { id: string }).id;
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    expect(lines.map((l) => l.componentKey).sort()).toEqual(['svc-camp-pass', 'svc-event-pass']);
    expect((res.body.sale as { totals: { grossSatang: number } }).totals.grossSatang).toBe(paid.totalSatang);
    expect(await linkOf(free.attendeeId)).toMatchObject({ saleId: null });
    // One check-in of the camp child today: the board's.
    const campRows = await ctx.db
      .select()
      .from(eventCheckin)
      .where(and(eq(eventCheckin.otoappEventId, ev.camp), eq(eventCheckin.attendeeId, camp.attendeeId)));
    expect(campRows).toHaveLength(1);
  });
});

// =============================================================================
// The kiosk (Q11)
// =============================================================================

describe('the kiosk checks a booking’s passes in as the till does (Q11)', () => {
  it('issues the tickets’ bands and the pass’s bands, printed on the kiosk before anything commits, and tells the OTO App', async () => {
    const camp = pass(ev.camp, 'Kiki', { parentAttending: true, allergyFlag: true, allergyDetail: 'Sesame' });
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }], [camp]);
    const bandsBefore = printouts(bandPrinterId);
    const before = sent.checkins.length;
    const scan = await kioskRedeem(paid.qr);
    expect(scan.statusCode, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.outcome).toBe('issued');
    // Two ticket bands and the pass's kid and parent bands, every one out of the kiosk's printer.
    expect(scan.body.bands.map((b) => b.kind).sort()).toEqual(['adult', 'adult', 'kid', 'kid']);
    expect(printouts(bandPrinterId) - bandsBefore).toBe(4);
    // Nothing private on a kiosk answer (H15), the child's allergy included.
    expect(() => KioskRedeemAnswerSchema.parse(scan.body)).not.toThrow();
    expect(keysOf(scan.body).filter((k) => KIOSK_PRIVATE_FIELD.test(k))).toEqual([]);
    expect(JSON.stringify(scan.body)).not.toContain('Sesame');
    expect(JSON.stringify(scan.body)).not.toContain('Kiki');
    // The check-in, with its bands printed and no box command left to print them again.
    const [row] = await ctx.db
      .select()
      .from(eventCheckin)
      .where(and(eq(eventCheckin.otoappEventId, ev.camp), eq(eventCheckin.attendeeId, camp.attendeeId)));
    expect(row).toMatchObject({ stationId: kioskId, checkedInByAccountId: null, checkedInByName: 'Kiosk 1', syncState: 'synced' });
    const jobs = await ctx.db.select().from(printJob).where(and(eq(printJob.subjectType, 'band'), eq(printJob.stationId, kioskId)));
    const passJobs = jobs.filter((j) => j.subjectId === row!.kidBandId || j.subjectId === row!.parentBandId);
    expect(passJobs.map((j) => j.status)).toEqual(['printed', 'printed']);
    expect(sent.checkins.length - before).toBe(1);
    expect(await appDay(ev.camp, camp.attendeeId, T)).toEqual({ status: 'checked_in', checkin_ref: row!.id });
    const [session] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, scan.body.sessionId));
    expect((session!.bandIds as string[])).toEqual(expect.arrayContaining([row!.kidBandId!, row!.parentBandId!]));
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'kiosk.redeem'), eq(auditLog.entityId, scan.body.sessionId)));
    expect(audit!.after).toMatchObject({ eventCheckinIds: [row!.id], stationId: kioskId, boxId: kioskBoxId });
    await collectAll();
  });

  it('with the kiosk printer offline the whole redemption — the pass’s check-in included — is called off (H13)', async () => {
    const camp = pass(ev.camp, 'Offy');
    const paid = await bookAndPay([], [camp]);
    const fault = await ctx.app.inject({
      method: 'POST',
      url: `/boxes/${kioskBoxId}/simulate`,
      headers: { cookie: admin },
      payload: { action: 'printer.fault', deviceId: bandPrinterId, fault: 'unreachable' },
    });
    expect(fault.statusCode, fault.body).toBe(200);
    await collectAll();
    const before = sent.checkins.length;
    const scan = await kioskRedeem(paid.qr);
    expect(scan.body.outcome).toBe('failed');
    expect(scan.body.reason).toBe('PRINTER_UNREACHABLE');
    expect(scan.body.desk.required).toBe(true);
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect(row!.status).toBe('paid');
    expect(await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id))).toEqual([]);
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(eventCheckin)
        .where(and(eq(eventCheckin.otoappEventId, ev.camp), eq(eventCheckin.attendeeId, camp.attendeeId))),
    ).toEqual([]);
    expect(await linkOf(camp.attendeeId)).toMatchObject({ saleId: null });
    expect(sent.checkins.length).toBe(before);
    // The OTO App still has the child expected, not in.
    expect((await appDay(ev.camp, camp.attendeeId, T))?.status ?? 'waiting').toBe('waiting');

    // The printer back: the till still redeems it, and checks the child in.
    const clear = await ctx.app.inject({
      method: 'POST',
      url: `/boxes/${kioskBoxId}/simulate`,
      headers: { cookie: admin },
      payload: { action: 'printer.clear', deviceId: bandPrinterId },
    });
    expect(clear.statusCode, clear.body).toBe(200);
    await collectAll();
    const counter = await redeemAtCounter(paid.id);
    expect(counter.status, JSON.stringify(counter.body)).toBe(200);
    expect(counter.body.eventPasses![0]).toMatchObject({ outcome: 'checked_in' });
  });
});
