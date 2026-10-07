import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  band,
  box,
  boxCommand,
  branch,
  opsRun,
  partyCharge,
  partyEdit,
  partyPayment,
  paymentAttempt,
  printJob,
  sale,
  station,
  stockMovement,
} from '@oto/db';
import {
  EventDetailAnswerSchema,
  PartyWriteAnswerSchema,
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EndOfDayRecord,
  type EventDetailAnswer,
  type PartyWriteAnswer,
} from '@oto/shared';
import { PARTY_UPDATE_RUN } from '../src/services/parties';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryEventEditAnswer,
  DirectoryEventEditBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import { refundSale } from '../src/services/refunds';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-20 E4 — THE PARTY TAB (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md, the E4 row of §9: check 3; §4's
 * two-tills fix; §6's known effects; §10; hazards H10, H11 and H12; Q3's
 * default).
 *
 * Check 3: "The party tab shows base price, deposit, POS charges and payments
 * with the outstanding balance; adding an F&B charge and taking a card payment
 * updates the balance, and the payment appears in End of Day under
 * party_prepay, not under card."
 *
 * The OTO App is as real as it can be without its server, as in E2: its tables
 * are built by its own migrations in schema `otoapp`, and the directory the api
 * calls is the app's own write code (`server/directory/eventWrites.ts`) run
 * against them, wrapped in a stub that can be told to fail.
 */

let ctx: TestContext;
let central: string;
let operatorId: string;
let till: string;
let tillBox: string;
let receptionId: string;
let reception: string;
let admin: string;
let chalongManager: string;
let foreignAdmin: string;
let T: string;
let appPool: pg.Pool;

const appTenant = newId();
const appCentral = newId();

const ev = {
  party: newId(),
  rush: newId(),
  tomorrow: newId(),
  edited: newId(),
  camp: newId(),
};

// --- The OTO App's directory, from its own source ------------------------------

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
  isParty?: boolean;
}
type AppOutcome<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; message: string };
interface AppWrites {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(pool: pg.Pool, event: AppEvent, input: DirectoryAttendeeBody): Promise<AppOutcome<DirectoryAttendeeAnswer>>;
  editPartyEvent(pool: pg.Pool, event: AppEvent, input: DirectoryEventEditBody): Promise<AppOutcome<DirectoryEventEditAnswer>>;
}
let appWrites: AppWrites;

/** The keys the app's edit body takes (`editBodySchema`, strict). */
const EDIT_KEYS = new Set(['id', 'editedAt', 'fields']);
const EDIT_FIELD_KEYS = new Set([
  'title',
  'status',
  'eventDate',
  'startTime',
  'endTime',
  'location',
  'numChildren',
  'numAdults',
  'childName',
  'kidTurningAge',
  'parentName',
  'whatsappPhone',
  'decoration',
  'activities',
  'totalValueThb',
  'prepaymentAmountThb',
  'prepaymentDate',
]);

type Plan = 'app' | 'unreachable' | 'refused';
const editPlan: Plan[] = [];
const editCalls: Array<{ eventId: string; body: DirectoryEventEditBody }> = [];

function refusalOf<T>(outcome: AppOutcome<T>): DirectoryOutcome<T> {
  if (outcome.ok) return { ok: true, status: outcome.status, body: outcome.body };
  return {
    ok: false,
    status: outcome.status,
    code: `OTOAPP_${outcome.error.toUpperCase()}`,
    message: outcome.message,
    retryable: outcome.status >= 500,
  };
}

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body) {
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return refusalOf(await appWrites.createEventAttendee(appPool, event, body));
  },
  async editEvent(eventId, body) {
    editCalls.push({ eventId, body });
    for (const key of Object.keys(body)) expect(EDIT_KEYS.has(key), key).toBe(true);
    for (const key of Object.keys(body.fields)) expect(EDIT_FIELD_KEYS.has(key), key).toBe(true);
    const next = editPlan.shift() ?? 'app';
    if (next === 'unreachable') {
      return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };
    }
    if (next === 'refused') {
      return { ok: false, status: 400, code: 'OTOAPP_VALIDATION_ERROR', message: 'The request body is not valid', retryable: false };
    }
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return refusalOf(await appWrites.editPartyEvent(appPool, event, body));
  },
};

// --- Helpers ---------------------------------------------------------------------

async function appEvent(e: {
  id: string;
  type: string;
  title: string;
  date: string;
  total?: number | null;
  deposit?: number | null;
  campEnd?: string | null;
}) {
  // Written as the app writes them: naive UTC, whatever the session's zone.
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      total_value, prepayment_amount, prepayment_date, child_name, parent_name, whatsapp_phone_e164,
      kid_turning_age, num_children, num_adults, location_text, decoration, status, created_at, updated_at)
    values (
      ${e.id}, ${appTenant}, ${appCentral}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null}, '13:00', '16:00',
      ${e.total ?? null}, ${e.deposit ?? null}, ${e.deposit ? T : null}, 'Mali', 'Nok', '+66812345678',
      6, 15, 12, 'Party room 1', 'Ocean', 'upcoming',
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
}

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
  cookie: string,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { cookie, ...headers },
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

const getParty = (id: string, cookie = reception) =>
  call<EventDetailAnswer>('GET', cookie, `/parties/${id}?branchId=${central}`);

function chargeBody(o: { chargeId?: string; kind?: 'fnb' | 'ticket'; total: number; items?: Array<{ name: string; qty: number; lineTotalSatang: number }> }) {
  return {
    branchId: central,
    stationId: till,
    chargeId: o.chargeId ?? newId(),
    actionId: newId(),
    kind: o.kind ?? 'fnb',
    items: o.items ?? [{ name: 'Pad Thai', qty: 2, lineTotalSatang: o.total }],
    totalSatang: o.total,
  };
}

function paymentBody(o: {
  paymentId?: string;
  amount: number;
  method?: string;
  kind?: string;
  tendered?: number;
  expected?: number;
}) {
  return {
    branchId: central,
    stationId: till,
    paymentId: o.paymentId ?? newId(),
    actionId: newId(),
    amountSatang: o.amount,
    tender: {
      method: o.method ?? 'cash',
      kind: o.kind ?? (o.method === 'card' ? 'card' : o.method === 'promptpay' ? 'qr' : 'cash'),
      ...(o.tendered !== undefined ? { tenderedSatang: o.tendered } : {}),
    },
    ...(o.expected !== undefined ? { expectedOutstandingSatang: o.expected } : {}),
  };
}

const charge = (id: string, body: ReturnType<typeof chargeBody>, cookie = reception) =>
  call<PartyWriteAnswer>('POST', cookie, `/parties/${id}/charges`, body);
const pay = (id: string, body: ReturnType<typeof paymentBody>, cookie = reception) =>
  call<PartyWriteAnswer>('POST', cookie, `/parties/${id}/payments`, body);
const patch = (id: string, body: Record<string, unknown>, cookie = reception) =>
  call<PartyWriteAnswer>('PATCH', cookie, `/parties/${id}`, { branchId: central, editId: newId(), ...body });

async function endOfDay(date: string): Promise<EndOfDayRecord> {
  const res = await call<EndOfDayRecord>('GET', reception, `/branches/${central}/end-of-day?date=${date}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}
const line = (rec: EndOfDayRecord, channel: string) => rec.lines.find((l) => l.channel === channel)?.expectedSatang ?? 0;
const cardTotal = (rec: EndOfDayRecord) =>
  rec.lines.filter((l) => l.channel.startsWith('card:')).reduce((s, l) => s + l.expectedSatang, 0);

async function attemptsOfParty(eventId: string) {
  return ctx.db
    .select({ attempt: paymentAttempt, payment: partyPayment })
    .from(partyPayment)
    .innerJoin(paymentAttempt, eq(paymentAttempt.id, partyPayment.paymentAttemptId))
    .where(eq(partyPayment.otoappEventId, eventId));
}

async function appRow(id: string) {
  const res = await ctx.db.execute<Record<string, unknown>>(
    sql`select title, decoration, total_value, prepayment_amount, whatsapp_phone_e164, num_children, updated_at
          from otoapp.core_events where id = ${id}`,
  );
  return res.rows[0]!;
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  const [som] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionId = som!.id;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  tillBox = t1!.boxId!;
  // A command is queued only for a box that has registered, as the park's box
  // does when it is first switched on (payments-cash.test.ts).
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, tillBox));

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e4')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await appEvent({ id: ev.party, type: 'birthday', title: "Mali's 6th", date: T, total: 12_000, deposit: 3_000 });
  await appEvent({ id: ev.rush, type: 'birthday', title: "Ton's 5th", date: T, total: 5_000, deposit: 0 });
  await appEvent({ id: ev.tomorrow, type: 'school_group', title: 'School trip', date: addDaysToIsoDate(T, 1), total: 4_000, deposit: 1_000 });
  await appEvent({ id: ev.edited, type: 'private_event', title: 'Company party', date: T, total: 8_000, deposit: 2_000 });
  await appEvent({ id: ev.camp, type: 'camp', title: 'Ocean camp', date: T, campEnd: addDaysToIsoDate(T, 2) });

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  editPlan.length = 0;
});

// =============================================================================
// Check 3 — the party tab shows its bill, and a charge and a card payment move it
// =============================================================================

describe('check 3 — the party tab: base price, deposit, POS charges, payments and the outstanding balance', () => {
  let eodBefore: EndOfDayRecord;
  const cardPaymentId = newId();

  it('GET /parties/:id reads the OTO App bill: base ฿12,000, deposit ฿3,000, nothing on the tab, ฿9,000 owed', async () => {
    eodBefore = await endOfDay(T);
    const res = await getParty(ev.party);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(EventDetailAnswerSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.event).toMatchObject({ id: ev.party, type: 'party', title: "Mali's 6th" });
    expect(res.body.event.party).toMatchObject({
      totalValueSatang: 1_200_000,
      depositSatang: 300_000,
      walkUpCharges: [],
      charges: [],
      payments: [],
      lastEdited: null,
      editSync: null,
      bill: { baseSatang: 1_200_000, chargesSatang: 0, totalSatang: 1_200_000, depositSatang: 300_000, paidSatang: 0, outstandingSatang: 900_000 },
    });
    // The day's list carries the same tab, which is what the Events tab renders.
    const day = await call<{ events: Array<{ id: string; party: unknown }> }>('GET', reception, `/events?branchId=${central}`);
    expect(day.body.events.find((e) => e.id === ev.party)!.party).toEqual(res.body.event.party);
  });

  it('a walk-up guest (E2) is on the tab at the party-guest price and in the balance', async () => {
    const res = await call<{ attendee: { priceSatang: number; billing: string } }>('POST', reception, `/events/${ev.party}/attendees`, {
      branchId: central,
      stationId: till,
      attendeeId: newId(),
      actionId: newId(),
      registerProperly: false,
      attendee: { name: 'Guest', parentName: 'May' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.attendee.billing).toBe('party_tab');
    const guest = res.body.attendee.priceSatang;
    const { body } = await getParty(ev.party);
    expect(body.event.party!.walkUpCharges).toHaveLength(1);
    expect(body.event.party!.bill).toMatchObject({ chargesSatang: guest, outstandingSatang: 900_000 + guest });
  });

  it('an F&B charge is a ledger entry that raises the balance: no sale, no kitchen ticket, no stock, no band', async () => {
    const before = await getParty(ev.party);
    const owed = before.body.event.party!.bill!.outstandingSatang;
    const sales = (await ctx.db.select({ id: sale.id }).from(sale)).length;
    const prints = (await ctx.db.select({ id: printJob.id }).from(printJob)).length;
    const stock = (await ctx.db.select({ id: stockMovement.id }).from(stockMovement)).length;
    const bands = (await ctx.db.select({ id: band.id }).from(band)).length;

    const body = chargeBody({
      kind: 'fnb',
      total: 52_000,
      items: [
        { name: 'Pad Thai', qty: 2, lineTotalSatang: 30_000 },
        { name: 'Mango smoothie', qty: 2, lineTotalSatang: 24_000 },
      ],
    });
    const res = await charge(ev.party, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PartyWriteAnswerSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.replayed).toBe(false);
    expect(res.body.charge).toMatchObject({
      id: body.chargeId,
      kind: 'fnb',
      totalSatang: 52_000,
      items: body.items,
      chargedBy: 'Som (Reception)',
    });
    expect(res.body.party.party!.bill!.outstandingSatang).toBe(owed + 52_000);

    expect((await ctx.db.select({ id: sale.id }).from(sale)).length).toBe(sales);
    expect((await ctx.db.select({ id: printJob.id }).from(printJob)).length).toBe(prints);
    expect((await ctx.db.select({ id: stockMovement.id }).from(stockMovement)).length).toBe(stock);
    expect((await ctx.db.select({ id: band.id }).from(band)).length).toBe(bands);

    const [row] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.charge'), eq(auditLog.entityId, body.chargeId)));
    expect(row).toMatchObject({ branchId: central, actionId: body.actionId });
    expect(row!.after).toMatchObject({ eventId: ev.party, kind: 'fnb', totalSatang: 52_000, items: 2, stationId: till, boxId: tillBox });
  });

  it('the same charge id again is the same charge: answered again, nothing added', async () => {
    const body = chargeBody({ kind: 'ticket', total: 40_000, items: [{ name: '1 Hour Play · Kids', qty: 2, lineTotalSatang: 40_000 }] });
    const first = await charge(ev.party, body);
    expect(first.status).toBe(200);
    const again = await charge(ev.party, { ...body, totalSatang: 99_900 });
    expect(again.status).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.body).toMatchObject({ replayed: true, charge: { id: body.chargeId, totalSatang: 40_000, kind: 'ticket' } });
    expect(await ctx.db.select().from(partyCharge).where(eq(partyCharge.id, body.chargeId))).toHaveLength(1);
    // Extra tickets issue no bands: a charge is never a sale.
    expect(await ctx.db.select().from(band).where(sql`${band.createdAt} > now() - interval '1 minute'`)).toHaveLength(0);
  });

  it('a total below zero is clamped to ฿0 (the charge is never negative)', async () => {
    const res = await charge(ev.party, chargeBody({ total: -5_000, items: [{ name: 'Comp', qty: 1, lineTotalSatang: 0 }] }));
    expect(res.status).toBe(200);
    expect(res.body.charge!.totalSatang).toBe(0);
  });

  it('a card payment is real money through the tender machine, with no sale, and lowers the balance', async () => {
    const owed = (await getParty(ev.party)).body.event.party!.bill!.outstandingSatang;
    const res = await pay(ev.party, paymentBody({ paymentId: cardPaymentId, amount: 500_000, method: 'card', expected: owed }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.payment).toMatchObject({
      id: cardPaymentId,
      amountSatang: 500_000,
      method: 'card',
      kind: 'card',
      takenBy: 'Som (Reception)',
      businessDate: T,
      partyDate: T,
    });
    expect(res.body.party.party!.bill!.outstandingSatang).toBe(owed - 500_000);
    expect(res.body.party.party!.bill!.paidSatang).toBe(500_000);

    const rows = await attemptsOfParty(ev.party);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempt).toMatchObject({
      saleId: null,
      method: 'card',
      methodCode: 'card',
      provider: 'manual',
      status: 'approved',
      stationId: till,
      businessDate: T,
      amountSatang: 500_000,
      actionId: `party-payment:${cardPaymentId}`,
    });
    expect(rows[0]!.attempt.paidAt).not.toBeNull();
    const [row] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.payment'), eq(auditLog.entityId, cardPaymentId)));
    expect(row!.before).toEqual({ outstandingSatang: owed });
    expect(row!.after).toMatchObject({ eventId: ev.party, amountSatang: 500_000, method: 'card', kind: 'card', partyDate: T, businessDate: T, stationId: till, boxId: tillBox });
    // A card opens no drawer.
    const kicks = await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.kind, 'drawer_kick'), sql`${boxCommand.payload}->>'attemptId' = ${rows[0]!.attempt.id}`));
    expect(kicks).toHaveLength(0);
  });

  it('End of Day: the payment is on party_prepay, not on a card line (H10)', async () => {
    const after = await endOfDay(T);
    expect(line(after, 'party_prepay')).toBe(500_000);
    expect(cardTotal(after)).toBe(cardTotal(eodBefore));
    expect(line(after, 'cash')).toBe(line(eodBefore, 'cash'));
    expect(line(after, 'promptpay')).toBe(line(eodBefore, 'promptpay'));
    // The order the S2-15a record keeps: the party line where it always was.
    expect(after.lines.map((l) => l.channel).slice(-4)).toEqual(['ewallet', 'bank_transfer', 'party_prepay', 'credit']);
  });

  it('the same payment id again takes nothing: answered again, one attempt', async () => {
    const res = await pay(ev.party, paymentBody({ paymentId: cardPaymentId, amount: 500_000, method: 'card' }));
    expect(res.status).toBe(200);
    expect(res.headers['x-oto-replay']).toBe('true');
    expect(res.body).toMatchObject({ replayed: true, payment: { id: cardPaymentId, amountSatang: 500_000 } });
    expect(await attemptsOfParty(ev.party)).toHaveLength(1);
    expect(line(await endOfDay(T), 'party_prepay')).toBe(500_000);
  });

  it('cash is whole baht, its change worked out, and it opens the drawer once it has committed', async () => {
    const id = newId();
    const res = await pay(ev.party, paymentBody({ paymentId: id, amount: 100_050, tendered: 200_000 }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // `Math.floor(amount)`: the satang are not taken.
    expect(res.body.payment!.amountSatang).toBe(100_000);
    const [row] = (await attemptsOfParty(ev.party)).filter((r) => r.payment.id === id);
    expect(row!.attempt).toMatchObject({ method: 'cash', amountSatang: 100_000, tenderedSatang: 200_000, changeSatang: 100_000 });
    const kicks = await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.kind, 'drawer_kick'), sql`${boxCommand.payload}->>'attemptId' = ${row!.attempt.id}`));
    expect(kicks).toHaveLength(1);
    expect(kicks[0]!.payload).not.toHaveProperty('saleId');
    expect(line(await endOfDay(T), 'party_prepay')).toBe(600_000);
    expect(line(await endOfDay(T), 'cash')).toBe(line(eodBefore, 'cash'));
  });

  it('a balance that moved since the till showed it is refused, and nothing is taken', async () => {
    const owed = (await getParty(ev.party)).body.event.party!.bill!.outstandingSatang;
    const before = (await attemptsOfParty(ev.party)).length;
    const res = await pay(ev.party, paymentBody({ amount: 10_000, expected: owed + 10_000 }));
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string; details: unknown } }).error).toMatchObject({
      code: 'PARTY_BALANCE_CHANGED',
      details: { outstandingSatang: owed },
    });
    expect(await attemptsOfParty(ev.party)).toHaveLength(before);
  });

  it('more than is owed is capped at the balance; then ฿0 is owed and the next payment is refused', async () => {
    const owed = (await getParty(ev.party)).body.event.party!.bill!.outstandingSatang;
    const res = await pay(ev.party, paymentBody({ amount: owed + 1_000_000, method: 'card' }));
    expect(res.status).toBe(200);
    expect(res.body.payment!.amountSatang).toBe(owed);
    expect(res.body.party.party!.bill!.outstandingSatang).toBe(0);
    const before = (await attemptsOfParty(ev.party)).length;
    const refused = await pay(ev.party, paymentBody({ amount: 10_000 }));
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_NOTHING_OWED');
    expect(await attemptsOfParty(ev.party)).toHaveLength(before);
  });

  it('a tender nobody may pick is refused with nothing taken', async () => {
    const res = await pay(ev.rush, paymentBody({ amount: 10_000, method: 'wallet_credit', kind: 'cash' }));
    expect(res.status).toBe(400);
    expect(await attemptsOfParty(ev.rush)).toHaveLength(0);
  });
});

// =============================================================================
// H11 — two tills taking the last of a balance
// =============================================================================

describe('H11 — two tills paying the whole balance at once', () => {
  it('one succeeds; the other is capped to ฿0 and refused; one attempt', async () => {
    const owed = (await getParty(ev.rush)).body.event.party!.bill!.outstandingSatang;
    expect(owed).toBe(500_000);
    const [a, b] = await Promise.all([
      pay(ev.rush, paymentBody({ amount: owed, method: 'card' })),
      pay(ev.rush, paymentBody({ amount: owed, method: 'card' })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect((refused.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_NOTHING_OWED');
    const rows = await attemptsOfParty(ev.rush);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempt.amountSatang).toBe(owed);
  });
});

// =============================================================================
// Q3's default and plan §6 — which day a payment counts on, and refunds
// =============================================================================

describe("Q3's default — a payment counts on the day it is taken, for that day's party", () => {
  it("money taken today for tomorrow's party is on no line today, nor tomorrow (plan §6)", async () => {
    const today = await endOfDay(T);
    const res = await pay(ev.tomorrow, paymentBody({ amount: 100_000 }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.payment).toMatchObject({ businessDate: T, partyDate: addDaysToIsoDate(T, 1) });
    const after = await endOfDay(T);
    expect(line(after, 'party_prepay')).toBe(line(today, 'party_prepay'));
    expect(line(after, 'cash')).toBe(line(today, 'cash'));
    expect(line(await endOfDay(addDaysToIsoDate(T, 1)), 'party_prepay')).toBe(0);
  });

  it('refund-safe: a refund of the day’s sale leaves the party line alone, and party money is in no sale to refund', async () => {
    const before = await endOfDay(T);
    // A cash sale rung up today, then refunded whole.
    const saleId = newId();
    await ctx.db.insert(sale).values({
      id: saleId,
      operatorId,
      branchId: central,
      stationId: till,
      businessDate: T,
      businessDayStart: '05:00',
      timezone: 'Asia/Bangkok',
      occurredAt: new Date(),
      createdByAccountId: receptionId,
      pricingMode: 'weekday',
      pricingModeReason: 'Weekday pricing',
      customerTier: 'tourist',
      engineVersion: 'e4-test',
      taxConfig: {},
      taxBreakdown: {},
      subtotalSatang: 30_000,
      netSatang: 30_000,
      grossSatang: 30_000,
      receiptSeries: 'E4T',
      receiptSeq: 1,
      receiptNumber: 'E4T-1',
      status: 'finalised',
      finalisedAt: new Date(),
    });
    await ctx.db.insert(paymentAttempt).values({
      id: newId(),
      operatorId,
      branchId: central,
      saleId,
      stationId: till,
      businessDate: T,
      method: 'cash',
      methodCode: 'cash',
      provider: 'manual',
      status: 'approved',
      amountSatang: 30_000,
      paidAt: new Date(),
    });
    const mid = await endOfDay(T);
    expect(line(mid, 'cash')).toBe(line(before, 'cash') + 30_000);
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: receptionId, operatorId, stationId: till, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        saleId,
        { mode: 'whole', reason: 'Wrong ticket', actionId: newId() },
      ),
    );
    const after = await endOfDay(T);
    expect(line(after, 'cash')).toBe(line(before, 'cash'));
    expect(line(after, 'party_prepay')).toBe(line(before, 'party_prepay'));
    // Every party attempt stands, approved, with no sale for a refund to reach.
    const party = await ctx.db.select({ saleId: paymentAttempt.saleId, status: paymentAttempt.status }).from(paymentAttempt).innerJoin(partyPayment, eq(partyPayment.paymentAttemptId, paymentAttempt.id));
    expect(party.length).toBeGreaterThan(0);
    expect(party.every((p) => p.saleId === null && p.status === 'approved')).toBe(true);
  });
});

// =============================================================================
// Item 1 — PATCH /parties/:id: the protected fields, and the write-back
// =============================================================================

describe('PATCH /parties/:id — the protected fields (H12) and the write-back to the OTO App', () => {
  const editId = newId();

  it('saves the editable fields, ignores the protected ones and says so, and writes back under the edit id', async () => {
    const before = (await getParty(ev.edited)).body.event.party!;
    const calls = editCalls.length;
    const res = await call<PartyWriteAnswer>('PATCH', reception, `/parties/${ev.edited}`, {
      branchId: central,
      editId,
      stationId: till,
      title: 'Company party (moved room)',
      decoration: 'Jungle',
      basePriceSatang: 900_000,
      whatsapp: '081 234 5679',
      // None of these is a field a till may change (H12):
      id: newId(),
      partyExtraCharges: [{ id: 'x', kind: 'fnb', items: [], total: 1 }],
      partyPayments: [{ id: 'y', amount: 1_000 }],
      charges: [],
      payments: [],
      kitchen: { needed: true },
      lastEditedBy: 'Nobody',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.edit).toMatchObject({
      id: editId,
      syncState: 'synced',
      syncError: null,
      ignored: ['charges', 'id', 'kitchen', 'lastEditedBy', 'partyExtraCharges', 'partyPayments', 'payments'],
    });
    expect(res.body.party).toMatchObject({ id: ev.edited, title: 'Company party (moved room)', branchId: central });
    expect(res.body.party.party).toMatchObject({
      decoration: 'Jungle',
      totalValueSatang: 900_000,
      parentPhone: '+66812345679',
      charges: before.charges,
      payments: before.payments,
      lastEdited: { by: 'Som (Reception)' },
      editSync: null,
    });
    // One directory call, carrying the edit's own id and the app's words.
    expect(editCalls.length - calls).toBe(1);
    expect(editCalls.at(-1)).toMatchObject({
      eventId: ev.edited,
      body: { id: editId, fields: { title: 'Company party (moved room)', decoration: 'Jungle', totalValueThb: 9_000, whatsappPhone: '+66812345679' } },
    });
    // The OTO App holds it.
    expect(await appRow(ev.edited)).toMatchObject({
      title: 'Company party (moved room)',
      decoration: 'Jungle',
      total_value: 9_000,
      whatsapp_phone_e164: '+66812345679',
    });
    const [run] = await ctx.db.select().from(opsRun).where(and(eq(opsRun.name, PARTY_UPDATE_RUN), sql`${opsRun.detail}->>'editId' = ${editId}`));
    expect(run).toMatchObject({ kind: 'integration', outcome: 'ok', branchId: central, stationId: till });
    const [entry] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.update'), eq(auditLog.entityId, editId)));
    expect(entry!.before).toEqual({ title: 'Company party', decoration: 'Ocean', basePriceSatang: 800_000, whatsapp: '+66812345678' });
    expect(entry!.after).toMatchObject({
      title: 'Company party (moved room)',
      decoration: 'Jungle',
      basePriceSatang: 900_000,
      whatsapp: '+66812345679',
      eventId: ev.edited,
      ignored: ['charges', 'id', 'kitchen', 'lastEditedBy', 'partyExtraCharges', 'partyPayments', 'payments'],
    });
  });

  it('the same edit id again is the same edit: answered again, nothing more written or sent', async () => {
    const calls = editCalls.length;
    const res = await call<PartyWriteAnswer>('PATCH', reception, `/parties/${ev.edited}`, {
      branchId: central,
      editId,
      title: 'Something else',
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-oto-replay']).toBe('true');
    expect(res.body).toMatchObject({ replayed: true, edit: { id: editId, syncState: 'synced' }, party: { title: 'Company party (moved room)' } });
    expect(editCalls.length).toBe(calls);
    expect(await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, editId))).toHaveLength(1);
  });

  it('an edit to the base price or deposit moves the balance, as the bill reads them', async () => {
    const res = await patch(ev.edited, { depositSatang: 400_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.party.party!.bill).toMatchObject({ baseSatang: 900_000, depositSatang: 400_000, outstandingSatang: 500_000 });
  });

  it('nothing a till may change: refused, nothing written', async () => {
    const rows = (await ctx.db.select().from(partyEdit)).length;
    const res = await patch(ev.edited, { kitchen: { needed: true }, partyPayments: [] });
    expect(res.status).toBe(400);
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_EDIT_EMPTY');
    expect((await ctx.db.select().from(partyEdit)).length).toBe(rows);
  });

  it('a WhatsApp that is not a phone number, money that is not whole baht: refused', async () => {
    expect((await patch(ev.edited, { whatsapp: 'not a phone' })).status).toBe(400);
    expect((await patch(ev.edited, { basePriceSatang: 900_050 })).status).toBe(400);
  });

  it('a camp is not a party here: 404, and so is an event of another operator', async () => {
    expect((await getParty(ev.camp)).status).toBe(404);
    expect((await patch(ev.camp, { title: 'x' })).status).toBe(404);
    expect((await charge(ev.camp, chargeBody({ total: 1_000 }))).status).toBe(404);
    expect((await pay(ev.camp, paymentBody({ amount: 1_000 }))).status).toBe(404);
    expect((await getParty(newId())).status).toBe(404);
  });
});

describe('the write-back when the OTO App does not answer, and Failures', () => {
  type RetryAnswer = { ok: boolean; outcome: string; syncState: string; sent: number; synced: number; waiting: number };

  async function failedRunOf(editId: string) {
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, PARTY_UPDATE_RUN), eq(opsRun.outcome, 'failed'), sql`${opsRun.detail}->>'editId' = ${editId}`))
      .orderBy(desc(opsRun.startedAt));
    return run!;
  }
  const editOf = async (id: string) => (await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, id)))[0]!;

  it('the edit stands as pending and the party is shown as the till edited it, marked', async () => {
    editPlan.push('unreachable');
    const res = await patch(ev.edited, { decoration: 'Space' });
    expect(res.status).toBe(200);
    expect(res.body.edit).toMatchObject({ syncState: 'pending' });
    expect(res.body.edit!.syncError).toMatch(/OTOAPP_DIRECTORY_UNREACHABLE/);
    expect(res.body.party.party).toMatchObject({ decoration: 'Space', editSync: { editId: res.body.edit!.id, state: 'pending' } });
    expect((await appRow(ev.edited)).decoration).toBe('Jungle');
  });

  it('a newer edit carries the older one still waiting, in order, and the app takes both', async () => {
    const [waiting] = await ctx.db.select().from(partyEdit).where(eq(partyEdit.syncState, 'pending'));
    const calls = editCalls.length;
    const res = await patch(ev.edited, { expectedKids: 20 });
    expect(res.body.edit).toMatchObject({ syncState: 'synced' });
    expect(editCalls.length - calls).toBe(1);
    expect(editCalls.at(-1)!.body.fields).toEqual({ decoration: 'Space', numChildren: 20 });
    expect(await editOf(waiting!.id)).toMatchObject({ syncState: 'synced', syncAttempts: 2 });
    expect(await appRow(ev.edited)).toMatchObject({ decoration: 'Space', num_children: 20 });
    expect(res.body.party.party!.editSync).toBeNull();
  });

  it('Failures offers Retry for it, and the Retry sends the waiting edits', async () => {
    editPlan.push('unreachable');
    const first = await patch(ev.edited, { activities: 'Bubbles' });
    expect(first.body.edit!.syncState).toBe('pending');
    const page = await call<{ groups: Array<{ name: string; retryable: boolean; lastRunId: string }> }>(
      'GET',
      admin,
      '/ops/failures?windowHours=1&kind=integration',
    );
    const group = page.body.groups.find((g) => g.name === PARTY_UPDATE_RUN)!;
    expect(group).toMatchObject({ retryable: true });
    const retried = await call<RetryAnswer>('POST', admin, `/ops/runs/${group.lastRunId}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ ok: true, outcome: 'ok', syncState: 'synced', waiting: 0 });
    expect(await editOf(first.body.edit!.id)).toMatchObject({ syncState: 'synced', syncError: null });
    const [entry] = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'ops.run_retry')).orderBy(desc(auditLog.createdAt));
    expect(entry!.after).toMatchObject({ integration: PARTY_UPDATE_RUN, editId: first.body.edit!.id, syncState: 'synced' });
  });

  it('a change made in the OTO App after the edit wins: the edit is refused there, failed here, and not shown', async () => {
    editPlan.push('unreachable');
    const res = await patch(ev.edited, { title: 'Till title' });
    expect(res.body.party.title).toBe('Till title');
    // The app's own screen changes the party after the till's edit.
    await ctx.db.execute(sql`
      update otoapp.core_events set title = 'App title', updated_at = (now() at time zone 'UTC') + interval '1 second'
       where id = ${ev.edited}`);
    // Shown as the app has it now: the till's older edit will not land.
    expect((await getParty(ev.edited)).body.event.title).toBe('App title');
    const retried = await call<RetryAnswer>('POST', admin, `/ops/runs/${(await failedRunOf(res.body.edit!.id)).id}/retry`, {});
    expect(retried.body).toMatchObject({ syncState: 'failed' });
    expect(await editOf(res.body.edit!.id)).toMatchObject({ syncState: 'failed' });
    expect((await editOf(res.body.edit!.id)).syncError).toMatch(/OTOAPP_EDIT_SUPERSEDED/);
    expect((await appRow(ev.edited)).title).toBe('App title');
    const { body } = await getParty(ev.edited);
    expect(body.event.title).toBe('App title');
    expect(body.event.party!.editSync).toMatchObject({ state: 'failed' });
  });

  it('a refusal of another kind is failed and left out of the outage’s Retry', async () => {
    editPlan.push('refused');
    const res = await patch(ev.party, { activities: 'Magic show' });
    expect(res.body.edit).toMatchObject({ syncState: 'failed' });
    expect(res.body.edit!.syncError).toMatch(/OTOAPP_VALIDATION_ERROR/);
    expect(res.body.party.party!.activities).toBeNull();
  });
});

// =============================================================================
// Who may, and where
// =============================================================================

describe('who may, and where', () => {
  it('another branch’s manager, another operator’s admin: refused, nothing written', async () => {
    const rows = {
      charges: (await ctx.db.select().from(partyCharge)).length,
      payments: (await ctx.db.select().from(partyPayment)).length,
      edits: (await ctx.db.select().from(partyEdit)).length,
    };
    for (const cookie of [chalongManager, foreignAdmin]) {
      expect((await getParty(ev.rush, cookie)).status).toBeGreaterThanOrEqual(403);
      expect((await charge(ev.rush, chargeBody({ total: 1_000 }), cookie)).status).toBeGreaterThanOrEqual(403);
      expect((await pay(ev.rush, paymentBody({ amount: 1_000 }), cookie)).status).toBeGreaterThanOrEqual(403);
      expect((await patch(ev.rush, { title: 'Hijack' }, cookie)).status).toBeGreaterThanOrEqual(403);
    }
    expect((await ctx.db.select().from(partyCharge)).length).toBe(rows.charges);
    expect((await ctx.db.select().from(partyPayment)).length).toBe(rows.payments);
    expect((await ctx.db.select().from(partyEdit)).length).toBe(rows.edits);
  });

  it('reception holds the three party permissions; read-only staff hold none (plan §10)', async () => {
    const { ROLE_BUNDLES } = await import('@oto/shared');
    for (const p of ['pos:party:charge', 'pos:party:payment', 'pos:party:update'] as const) {
      expect(ROLE_BUNDLES.reception).toContain(p);
      expect(ROLE_BUNDLES.branch_manager).toContain(p);
      expect(ROLE_BUNDLES.staff).not.toContain(p);
    }
  });

  it('every party payment attempt is one of the party ledger’s, and one each', async () => {
    const rows = await ctx.db.select({ id: partyPayment.paymentAttemptId }).from(partyPayment);
    const attempts = await ctx.db
      .select({ id: paymentAttempt.id })
      .from(paymentAttempt)
      .where(inArray(paymentAttempt.id, rows.map((r) => r.id)));
    expect(attempts).toHaveLength(rows.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});
