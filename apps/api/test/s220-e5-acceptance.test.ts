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
  checkin,
  device,
  deviceCredential,
  eventAttendeeLink,
  eventCheckin,
  eventDropInPricing,
  kioskSession,
  opsRun,
  printJob,
  sale,
  station,
  stationDevice,
  ticketPackage,
} from '@oto/db';
import { DEMO_BRANCH_CODE, describeDemoDay, seedDemoDay } from '@oto/db/seed';
import type { BoxAgent } from '@oto/box-agent';
import {
  KIOSK_DEVICE_SCOPES,
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EndOfDayRecord,
  type EventAttendeeWriteAnswer,
  type EventCheckinAnswer,
  type EventDayAnswer,
  type EventDetailAnswer,
  type EventDropInPricingAnswer,
  type EventRosterAnswer,
  type KioskRedeemAnswer,
} from '@oto/shared';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { bookingQrOf } from '../src/services/booking-payment';
import { checkInEventAttendee } from '../src/services/event-checkins';
import { ATTENDEE_CREATE_RUN } from '../src/services/event-writes';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryCheckinAnswer,
  DirectoryCheckinBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import { ADMIN, CENTRAL_BRANCH_CODE, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * S2-20 E5 — THE EVENTS STORY'S ACCEPTANCE, DRIVEN END TO END ON THE SEEDED
 * DEMO DAY (SCRUM-217; SPRINT_2_PLAN S2-20 acceptance criteria and QA steps
 * 1-7; plan docs/progress/plans/events-kiosk/PLAN.md, the E5 row of §9).
 *
 * `seed:demo-day` writes the story's day at Demo Branch 2 (`demo-events.ts`):
 * a five-day camp spanning the day with six children, a one-off workshop, a
 * free story time, a birthday party with a paid deposit, and the walk-up
 * prices. The OTO App is real as far as it can be without its server (its own
 * tables and its own directory write code); the demo branch is given its app
 * row through the SCRUM-268 seam, beside the park's own. Each check below is
 * what the lander walks on staging, with its screenshot; here it is driven
 * through the routes the screens call:
 *
 *   1. the Events tab lists the camp, the event and the party; the camp roster
 *      has per-day counts; the app holds the same children;
 *   2. a pass sold with cash is a sale and an attendee on both systems; a paid
 *      pass with no payment writes nothing; the free event adds the child with
 *      no sale; a party walk-up charges the tab and takes no payment;
 *   3. an F&B charge and a card payment move the party's balance, and the
 *      payment is on End of Day's `party_prepay`, not under card;
 *   4. a camp check-in prints the kid and parent bands with the event's title,
 *      day and diet; a second the same day is refused; the next day succeeds;
 *      no supervision gate at any point;
 *   5. the kiosk issues a paid booking once, its event pass with it (Q11), and
 *      a second scan is told it was redeemed;
 *   6. the kiosk printer offline calls the redemption off and the till still
 *      redeems it; a forced write-back failure is retried from Failures;
 *   7. every action has its Activity row with the station and the box.
 */

const PGW_SECRET = randomBytes(32).toString('hex');
const KIOSK_SECRET = randomBytes(32).toString('hex');
const SHA = (value: string) => createHash('sha256').update(value).digest('hex');

let ctx: TestContext;
let admin: string;
let operatorId: string;
let demo: string;
let till: string;
let tillBox: string;
let kioskId: string;
let kioskBoxId: string;
let bandPrinterId: string;
let T: string;
let agent: BoxAgent;
let appPool: pg.Pool;
let appTenant: string;
const link: CuttableLink = { cut: false };
const D = (n: number) => addDaysToIsoDate(T, n);

/** The seeded events, by title. */
const seeded: Record<'camp' | 'workshop' | 'story' | 'party', string> = { camp: '', workshop: '', story: '', party: '' };

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
const plan: { attendee: Array<'app' | 'unreachable'> } = { attendee: [] };
const unreachable = { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };

function asOutcome<T>(o: AppOutcome<T>): DirectoryOutcome<T> {
  if (o.ok) return { ok: true, status: o.status, body: o.body };
  return { ok: false, status: o.status, code: `OTOAPP_${o.error.toUpperCase()}`, message: o.message, retryable: o.status >= 500 };
}
const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body) {
    if ((plan.attendee.shift() ?? 'app') === 'unreachable') return unreachable;
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return asOutcome(await appWrites.createEventAttendee(appPool, event, body));
  },
  async checkinAttendee(eventId, attendeeId, body) {
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return asOutcome(await appWrites.recordAttendeeCheckin(appPool, event, attendeeId, body));
  },
};

async function call<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: admin, ...headers },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

const child = (name: string, extra: Record<string, unknown> = {}) => ({ name, parentName: 'Khun Dao', parentPhone: '+66812340099', ...extra });

async function auditOf(action: string, entityId: string) {
  return ctx.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
}

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.226.${Math.floor(family / 250)}.${(family % 250) + 1}`;
};

async function bookAndPay(lines: Array<Record<string, unknown>>, passes: Array<Record<string, unknown>> = []) {
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: DEMO_BRANCH_CODE,
      phone: '0812345678',
      parentName: 'Khun Dao',
      tier: 'tourist',
      visitDate: T,
      lines,
      ...(passes.length ? { eventPasses: passes } : {}),
    },
  });
  expect(made.statusCode, made.body).toBe(200);
  const id = made.json().id as string;
  const opened = await ctx.app.inject({ method: 'POST', url: `/public/bookings/${id}/checkout`, remoteAddress: familyAddress(), payload: { method: 'card' } });
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
  return { id, reference: row!.reference, qr: bookingQrOf(row!)!, totalSatang: row!.totalSatang };
}

async function kioskRedeem(qr: string): Promise<KioskRedeemAnswer> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${kioskId}/kiosk/redeem`,
    headers: { authorization: `Bearer ${KIOSK_SECRET}` },
    payload: { actionId: newId(), qr },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function collectAll(): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    const ran = await agent.runPendingCommands();
    await agent.printing()!.jobs.tick();
    if (ran === 0) return;
  }
}

/** A box beside a station at the demo branch, its band printer serving both band roles (the demo till has none of its own). */
async function boxFor(stationId: string, role: 'counter' | 'kiosk', slot: string, prefix: string) {
  const boxId = newId();
  await ctx.db.insert(box).values({ id: boxId, operatorId, branchId: demo, name: `Demo ${role} box`, slot, role, status: 'unclaimed' });
  const printer = newId();
  const receipt = newId();
  await ctx.db.insert(device).values([
    { id: printer, operatorId, branchId: demo, boxId, kind: 'band_printer', label: `${prefix} Band Printer`, transport: 'simulated', address: '192.168.88.251:9100', model: '4B-2082A', protocol: 'tspl2', reachability: 'reachable', paperStatus: 'ok' },
    { id: receipt, operatorId, branchId: demo, boxId, kind: 'receipt_printer', label: `${prefix} Receipt Printer`, transport: 'simulated', address: '192.168.88.252:9100', model: 'Xprinter XP-80', protocol: 'escpos', reachability: 'reachable', paperStatus: 'ok' },
  ]);
  await ctx.db.update(station).set({ boxId }).where(eq(station.id, stationId));
  await ctx.db.insert(stationDevice).values([
    { id: newId(), stationId, role: 'kids_band', deviceId: printer },
    { id: newId(), stationId, role: 'adult_band', deviceId: printer },
    { id: newId(), stationId, role: 'receipt', deviceId: receipt },
  ]);
  return { boxId, printer };
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
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  operatorId = hkt!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as typeof appWrites;
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
// The seed
// =============================================================================

describe('seed:demo-day writes the events story at Demo Branch 2, convergent on a second press', () => {
  it('with no branch of the operator in the OTO App to place it beside, it writes the walk-up prices and says why it wrote no events', async () => {
    const counts = await seedDemoDay(ctx.db);
    expect(counts.events).toMatchObject({ events: 0, attendees: 0, pricing: true, skipped: 'no_app_anchor' });
    expect(describeDemoDay(counts)).toContain('Events: none written — the OTO App holds no branch of this operator');
    const [demoRow] = await ctx.db.select().from(branch).where(eq(branch.code, DEMO_BRANCH_CODE));
    demo = demoRow!.id;
    const [prices] = await ctx.db.select().from(eventDropInPricing).where(eq(eventDropInPricing.branchId, demo));
    expect(prices).toMatchObject({ campDayWeekdaySatang: 60_000, eventDayWeekdaySatang: 35_000, partyGuestWeekdaySatang: 45_000 });
  });

  it('beside the park’s own app branch: the camp, the workshop, story time and the party, at Demo Branch 2 only', async () => {
    appTenant = newId();
    await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e5-acceptance')`);
    const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
    await ctx.db.execute(sql`
      insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
      values (${newId()}, ${appTenant}, 'Central Floresta', 'Phuket', ${hkt!.id})`);
    const counts = await seedDemoDay(ctx.db);
    expect(counts.events).toMatchObject({ events: 4, attendees: 11, eventsPresent: 0, pricing: false, skipped: null });
    expect(describeDemoDay(counts)).toContain('Events: 4 events added (11 children), 0 already present.');
    // The demo branch's row in the app, in the park's own tenant.
    const mapped = await ctx.db.execute<{ tenant_id: string }>(sql`select tenant_id from otoapp.branches where core_branch_id = ${demo}`);
    expect(mapped.rows.map((r) => r.tenant_id)).toEqual([appTenant]);
    // Nothing at the park itself.
    const atPark = await call<EventDayAnswer>('GET', `/events?branchId=${hkt!.id}&date=${T}`);
    expect(atPark.body.events).toEqual([]);
    const day = await call<EventDayAnswer>('GET', `/events?branchId=${demo}&date=${T}`);
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    for (const e of day.body.events) {
      if (e.title.startsWith('Oto Summer Camp')) seeded.camp = e.id;
      if (e.title.startsWith("Kids' Art")) seeded.workshop = e.id;
      if (e.title === 'Story Time') seeded.story = e.id;
      if (e.title.startsWith("Sophia's")) seeded.party = e.id;
    }
    expect(Object.values(seeded).every(Boolean), JSON.stringify(day.body.events.map((e) => e.title))).toBe(true);
  });

  it('a second press the same day writes nothing, and keeps a walk-up price somebody edited', async () => {
    const edited = await call<EventDropInPricingAnswer>('PUT', `/branches/${demo}/event-drop-in-pricing`, {
      campDay: { weekday: 60_000, weekend: 60_000 }, eventDay: { weekday: 35_000, weekend: 35_000 }, partyGuest: { weekday: 50_000, weekend: 50_000 },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const before = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from otoapp.core_events`);
    const again = await seedDemoDay(ctx.db);
    expect(again.events).toMatchObject({ events: 0, attendees: 0, eventsPresent: 4, pricing: false, skipped: null });
    const after = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from otoapp.core_events`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    const [prices] = await ctx.db.select().from(eventDropInPricing).where(eq(eventDropInPricing.branchId, demo));
    expect(prices!.partyGuestWeekdaySatang).toBe(50_000);
    // Back to the prototype's ฿450 for the checks below.
    await call('PUT', `/branches/${demo}/event-drop-in-pricing`, {
      campDay: { weekday: 60_000, weekend: 60_000 }, eventDay: { weekday: 35_000, weekend: 35_000 }, partyGuest: { weekday: 45_000, weekend: 45_000 },
    });
  });

  it('the demo branch is made ready to print and to run a kiosk (the walkthrough’s fixtures, not the seed’s)', async () => {
    const [t] = await ctx.db.select().from(station).where(and(eq(station.branchId, demo), eq(station.name, 'Reception Till 1')));
    till = t!.id;
    tillBox = (await boxFor(till, 'counter', 'demo-counter-1', 'D2')).boxId;
    kioskId = newId();
    await ctx.db.insert(station).values({
      id: kioskId,
      operatorId,
      branchId: demo,
      name: 'Demo Kiosk',
      kind: 'kiosk',
      codePrefix: 'DK',
      capabilities: [],
      accessScope: 'all_staff',
    });
    const k = await boxFor(kioskId, 'kiosk', 'demo-kiosk-1', 'DK');
    kioskBoxId = k.boxId;
    bandPrinterId = k.printer;
    await ctx.db.insert(deviceCredential).values({
      id: newId(),
      operatorId,
      branchId: demo,
      kind: 'kiosk',
      stationId: kioskId,
      label: 'Demo Kiosk screen',
      secretHash: SHA(KIOSK_SECRET),
      scopes: [...KIOSK_DEVICE_SCOPES],
      pairedAt: new Date(),
    });
    agent = linkedAgent(ctx, kioskBoxId, 'demo-kiosk-box', link, { devices: true });
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    attachInProcessBox(agent);
  });
});

// =============================================================================
// Checks 1-7
// =============================================================================

describe('check 1 — the Events tab on the seeded day', () => {
  it('lists the camp, the one-off event and the party; the camp roster has its per-day counts', async () => {
    const day = await call<EventDayAnswer>('GET', `/events?branchId=${demo}&date=${T}`);
    const types = Object.fromEntries(day.body.events.map((e) => [e.id, e.type]));
    expect(types[seeded.camp]).toBe('camp');
    expect(types[seeded.workshop]).toBe('event');
    expect(types[seeded.party]).toBe('party');
    const roster = await call<EventRosterAnswer>('GET', `/events/${seeded.camp}/roster?branchId=${demo}&date=${T}`);
    expect(roster.status).toBe(200);
    // Six children: Mia is registered for the last two days only.
    expect(roster.body.stats).toEqual({ arrived: 0, expected: 5, currentlyIn: 0, outstanding: 5, all: 6 });
    const names = (ids: string[]) => ids.map((id) => roster.body.event.attendees!.find((a) => a.id === id)!.name);
    expect(names(roster.body.groups.notToday)).toEqual(['Mia Tanaka']);
    const flagged = roster.body.event.attendees!.filter((a) => a.allergy).map((a) => a.name).sort();
    expect(flagged).toEqual(['Emma Wattanasin', 'Noah Prasert']);
    expect(roster.body.event.attendees!.filter((a) => a.parentAttending).map((a) => a.name)).toEqual(['Lucas Bernard']);
    // The next day, Lily is not on and Mia is.
    const next = await call<EventRosterAnswer>('GET', `/events/${seeded.camp}/roster?branchId=${demo}&date=${D(1)}`);
    expect(names(next.body.groups.notToday)).toEqual(['Lily Chen']);
    // The OTO App's own roster holds the same six.
    const app = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from otoapp.camp_registrations where event_id = ${seeded.camp}`);
    expect(app.rows[0]!.n).toBe(6);
  });
});

describe('check 2 — passes, a free event and a party walk-up', () => {
  it('a pass sold with cash is a sale and an attendee in the OTO App', async () => {
    const attendeeId = newId();
    const saleId = newId();
    const res = await call<EventAttendeeWriteAnswer>('POST', `/events/${seeded.workshop}/passes`, {
      branchId: demo,
      stationId: till,
      attendeeId,
      saleId,
      actionId: newId(),
      registerProperly: false,
      attendee: child('Pita'),
      tender: { method: 'cash', kind: 'cash', tenderedSatang: 100_000 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ attendee: { syncState: 'synced', billing: 'sale' }, sale: { id: saleId, status: 'finalised' } });
    const app = await ctx.db.execute<{ source: string }>(sql`select source from otoapp.event_attendees where id = ${attendeeId}`);
    expect(app.rows).toEqual([{ source: 'pos' }]);
    const [audit] = await auditOf('event.pass_sell', attendeeId);
    expect(audit!.after).toMatchObject({ stationId: till, boxId: tillBox, saleId });
  });

  it('cancelled at payment — a paid pass with no tender — writes no attendee and no sale (H2)', async () => {
    const attendeeId = newId();
    const before = (await ctx.db.select().from(sale).where(eq(sale.branchId, demo))).length;
    const res = await call<{ error: { code: string } }>('POST', `/events/${seeded.workshop}/attendees`, {
      branchId: demo,
      stationId: till,
      attendeeId,
      actionId: newId(),
      attendee: child('Unpaid'),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_PASS_NEEDS_PAYMENT');
    expect(await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, attendeeId))).toEqual([]);
    expect((await ctx.db.select().from(sale).where(eq(sale.branchId, demo))).length).toBe(before);
  });

  it('the seeded free event adds the child with no sale', async () => {
    const res = await call<EventAttendeeWriteAnswer>('POST', `/events/${seeded.story}/attendees`, {
      branchId: demo,
      stationId: till,
      attendeeId: newId(),
      actionId: newId(),
      attendee: child('Free'),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ attendee: { billing: 'free', priceSatang: 0 }, sale: null });
  });

  it('a birthday walk-up charges the party-guest price to the tab and takes no payment', async () => {
    const res = await call<EventAttendeeWriteAnswer>('POST', `/events/${seeded.party}/attendees`, {
      branchId: demo,
      stationId: till,
      attendeeId: newId(),
      actionId: newId(),
      attendee: child('Walky'),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ attendee: { billing: 'party_tab', priceSatang: 45_000 }, sale: null });
    const party = await call<EventDetailAnswer>('GET', `/parties/${seeded.party}?branchId=${demo}`);
    expect(party.body.event.party!.walkUpCharges.map((c) => [c.name, c.amountSatang])).toEqual([['Walky', 45_000]]);
  });
});

describe('check 3 — the party tab, its charge, its card payment and End of Day', () => {
  it('an F&B charge and a card payment move the balance; the payment is on party_prepay, not under card (H10)', async () => {
    const before = await call<EndOfDayRecord>('GET', `/branches/${demo}/end-of-day?date=${T}`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const line = (rec: EndOfDayRecord, channel: string) => rec.lines.find((l) => l.channel === channel)?.expectedSatang ?? 0;
    const cards = (rec: EndOfDayRecord) => rec.lines.filter((l) => l.channel.startsWith('card:')).reduce((s, l) => s + l.expectedSatang, 0);

    const opened = await call<EventDetailAnswer>('GET', `/parties/${seeded.party}?branchId=${demo}`);
    // The seeded bill: a ฿12,000 package, the ฿450 walk-up, a ฿5,000 deposit paid.
    expect(opened.body.event.party!.bill).toMatchObject({ baseSatang: 1_200_000, depositSatang: 500_000, outstandingSatang: 745_000 });
    const chargeId = newId();
    const charged = await call<{ party: { party: { bill: { outstandingSatang: number } } } }>('POST', `/parties/${seeded.party}/charges`, {
      branchId: demo,
      stationId: till,
      chargeId,
      actionId: newId(),
      kind: 'fnb',
      items: [{ name: 'Pad Thai', qty: 2, lineTotalSatang: 46_000 }],
      totalSatang: 46_000,
    });
    expect(charged.status, JSON.stringify(charged.body)).toBe(200);
    expect(charged.body.party.party.bill.outstandingSatang).toBe(791_000);
    const paymentId = newId();
    const paid = await call<{ party: { party: { bill: { outstandingSatang: number } } } }>('POST', `/parties/${seeded.party}/payments`, {
      branchId: demo,
      stationId: till,
      paymentId,
      actionId: newId(),
      amountSatang: 300_000,
      tender: { method: 'card', kind: 'card' },
      expectedOutstandingSatang: 791_000,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.party.party.bill.outstandingSatang).toBe(491_000);
    const after = await call<EndOfDayRecord>('GET', `/branches/${demo}/end-of-day?date=${T}`);
    expect(line(after.body, 'party_prepay') - line(before.body, 'party_prepay')).toBe(300_000);
    expect(cards(after.body)).toBe(cards(before.body));
    const [audit] = await auditOf('party.payment', paymentId);
    expect(audit!.after).toMatchObject({ stationId: till, boxId: tillBox, amountSatang: 300_000 });
  });
});

describe('check 4 — a camp check-in, its bands, a second refused, the next day', () => {
  let lucas: string;

  it('Lucas (parent staying, vegetarian) is checked in: a kid band and a parent band, printing the event’s title, day and diet', async () => {
    const roster = await call<EventRosterAnswer>('GET', `/events/${seeded.camp}/roster?branchId=${demo}&date=${T}`);
    lucas = roster.body.event.attendees!.find((a) => a.name === 'Lucas Bernard')!.id;
    const stays = (await ctx.db.select().from(checkin)).length;
    const checkinId = newId();
    const res = await call<EventCheckinAnswer>('POST', `/events/${seeded.camp}/attendees/${lucas}/checkin`, {
      branchId: demo,
      checkinId,
      stationId: till,
      actionId: newId(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin.kidBand).not.toBeNull();
    expect(res.body.checkin.parentBand).not.toBeNull();
    expect(res.body.printJobs.map((j) => [j.kind, j.status]).sort()).toEqual([
      ['adult_wristband', 'queued'],
      ['kids_wristband', 'queued'],
    ]);
    const [row] = await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, checkinId));
    expect(row).toMatchObject({ eventTitle: 'Oto Summer Camp — Week 1', attendanceDate: T, dietary: 'Vegetarian — no meat or fish', syncState: 'synced' });
    // No supervision gate: no drop-off stay was opened (H6).
    expect((await ctx.db.select().from(checkin)).length).toBe(stays);
    const [audit] = await auditOf('event.checkin', checkinId);
    expect(audit!.after).toMatchObject({ stationId: till, boxId: tillBox });
  });

  it('the same child again the same day is refused "already checked in"', async () => {
    const res = await call<{ error: { code: string; message: string } }>('POST', `/events/${seeded.camp}/attendees/${lucas}/checkin`, {
      branchId: demo,
      checkinId: newId(),
      stationId: till,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'EVENT_ALREADY_CHECKED_IN', message: 'This child is already checked in for today.' });
  });

  it('the next camp day succeeds', async () => {
    const [demoRow] = await ctx.db.select().from(branch).where(eq(branch.id, demo));
    // Noon on the next business day, at the branch.
    const tomorrowNoon = new Date(`${D(1)}T05:00:00Z`);
    expect(businessDate(tomorrowNoon, demoRow!.timezone, parseDayStart(demoRow!.businessDayStart))).toBe(D(1));
    const [account] = (await ctx.db.execute<{ id: string }>(sql`select id from core.account where phone = ${ADMIN.phone}`)).rows;
    const done = await checkInEventAttendee(
      { db: ctx.db, directory },
      { operatorId, branchId: demo },
      { accountId: account!.id, operatorId, branchId: demo },
      seeded.camp,
      lucas,
      { branchId: demo, checkinId: newId(), stationId: till },
      tomorrowNoon,
    );
    expect(done.answer.checkin).toMatchObject({ date: D(1), status: 'checked_in' });
  });
});

describe('check 5 — the kiosk redeems a paid booking once, its event pass with it (Q11)', () => {
  let paid: Awaited<ReturnType<typeof bookAndPay>>;

  it('issues the ticket and pass bands and the wallet credit, printed on the kiosk; the camp child is checked in', async () => {
    const [pkg] = await ctx.db
      .select()
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, demo), eq(ticketPackage.name, '2 Hours Play')));
    const passId = newId();
    paid = await bookAndPay(
      [{ packageId: pkg!.id, kids: 1, adults: 1 }],
      [{ eventId: seeded.camp, attendeeId: passId, attendee: child('Kai', { parentAttending: true }) }],
    );
    const answer = await kioskRedeem(paid.qr);
    expect(answer.outcome).toBe('issued');
    expect(answer.bands.map((b) => b.kind).sort()).toEqual(['adult', 'adult', 'kid', 'kid']);
    expect(answer.walletCreditSatang).toBeGreaterThanOrEqual(0);
    const [row] = await ctx.db
      .select()
      .from(eventCheckin)
      .where(and(eq(eventCheckin.otoappEventId, seeded.camp), eq(eventCheckin.attendeeId, passId)));
    expect(row).toMatchObject({ stationId: kioskId, syncState: 'synced' });
    const [audit] = await auditOf('kiosk.redeem', answer.sessionId);
    expect(audit!.after).toMatchObject({ stationId: kioskId, boxId: kioskBoxId, eventCheckinIds: [row!.id] });
    await collectAll();
  });

  it('scanning it again shows already-redeemed', async () => {
    const again = await kioskRedeem(paid.qr);
    expect(again).toMatchObject({ outcome: 'failed', reason: 'BOOKING_ALREADY_REDEEMED', bands: [] });
  });
});

describe('check 6 — the kiosk printer offline, and a write-back retried from Failures', () => {
  it('the redemption is called off, the booking stays paid and unredeemed, and the till still redeems it', async () => {
    const [pkg] = await ctx.db
      .select()
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, demo), eq(ticketPackage.name, '2 Hours Play')));
    const paid = await bookAndPay([{ packageId: pkg!.id, kids: 1, adults: 0 }]);
    const fault = await call('POST', `/boxes/${kioskBoxId}/simulate`, { action: 'printer.fault', deviceId: bandPrinterId, fault: 'unreachable' });
    expect(fault.status, JSON.stringify(fault.body)).toBe(200);
    await collectAll();
    const aborted = await kioskRedeem(paid.qr);
    expect(aborted).toMatchObject({ outcome: 'failed', reason: 'PRINTER_UNREACHABLE' });
    expect(aborted.desk.required).toBe(true);
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect(row!.status).toBe('paid');
    expect(await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id))).toEqual([]);
    const [session] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, aborted.sessionId));
    expect(session).toMatchObject({ outcome: 'failed', reason: 'PRINTER_UNREACHABLE' });
    const [abort] = await auditOf('kiosk.abort', aborted.sessionId);
    expect(abort!.after).toMatchObject({ stationId: kioskId, boxId: kioskBoxId });
    await call('POST', `/boxes/${kioskBoxId}/simulate`, { action: 'printer.clear', deviceId: bandPrinterId });
    const atTill = await call<Record<string, unknown>>('POST', `/bookings/${paid.id}/redeem`, { stationId: till }, { 'idempotency-key': newId() });
    expect(atTill.status, JSON.stringify(atTill.body)).toBe(200);
  });

  it('a forced directory failure leaves the child pending, and Retry on Failures writes it once', async () => {
    plan.attendee.push('unreachable');
    const attendeeId = newId();
    const sold = await call<EventAttendeeWriteAnswer>('POST', `/events/${seeded.workshop}/passes`, {
      branchId: demo,
      stationId: till,
      attendeeId,
      saleId: newId(),
      actionId: newId(),
      attendee: child('Flaky'),
      tender: { method: 'cash', kind: 'cash', tenderedSatang: 100_000 },
    });
    expect(sold.body.attendee.syncState).toBe('pending');
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CREATE_RUN), eq(opsRun.outcome, 'failed'), sql`${opsRun.detail}->>'linkId' = ${attendeeId}`));
    const retried = await call<{ syncState: string }>('POST', `/ops/runs/${run!.id}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.syncState).toBe('synced');
    const app = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from otoapp.event_attendees where id = ${attendeeId}`);
    expect(app.rows[0]!.n).toBe(1);
  });
});

describe('check 7 — every action has its Activity row with the station and the box', () => {
  it('pass sales, check-ins, party payments and kiosk redemptions each name where they happened', async () => {
    for (const action of ['event.pass_sell', 'event.checkin', 'party.payment', 'kiosk.redeem']) {
      const rows = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.branchId, demo)));
      expect(rows.length, action).toBeGreaterThan(0);
      for (const r of rows) {
        const after = r.after as { stationId?: string | null; boxId?: string | null };
        expect(after.stationId, `${action} ${r.entityId}`).toBeTruthy();
        expect(after.boxId, `${action} ${r.entityId}`).toBeTruthy();
      }
    }
    // Every band the kiosk issued is a printed job on the kiosk's own printer.
    const kioskBands = await ctx.db.select().from(printJob).where(and(eq(printJob.stationId, kioskId), eq(printJob.subjectType, 'band')));
    expect(kioskBands.length).toBeGreaterThan(0);
    expect(kioskBands.every((j) => j.status === 'printed')).toBe(true);
    expect((await ctx.db.select().from(band).where(eq(band.branchId, demo))).length).toBeGreaterThan(0);
  });
});
