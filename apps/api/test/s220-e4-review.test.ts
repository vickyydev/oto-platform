import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  band,
  box,
  branch,
  eventAttendeeLink,
  opsRun,
  partyCharge,
  partyEdit,
  partyPayment,
  paymentAttempt,
  printJob,
  sale,
  saleLine,
  station,
  stockMovement,
  walletEntry,
} from '@oto/db';
import {
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EndOfDayRecord,
  type EventDetailAnswer,
  type PartyWriteAnswer,
} from '@oto/shared';
import { PARTY_UPDATE_RUN, payParty } from '../src/services/parties';
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
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  ADMIN,
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
 * S2-20 E4 — REVIEW of the party tab against the money, the day rule, the
 * write-back, reach and the migration (SCRUM-217; events-kiosk PLAN, the E4
 * row of §9, §4, §6, §10, H10-H12, Q3's default in full: charges are a ledger
 * only — no sale, no kitchen ticket, no stock, no bands; a payment is real
 * money through the tender machine but not a sale of goods; a party's money
 * counts on the day the payment is taken for that day's party).
 *
 *   1. ONE STORY TO THE SATANG. A party charged in awkward satang, with a
 *      walk-up, paid by card under an Idempotency-Key (replayed, mismatched),
 *      raced from two tills, paid in cash at the second till, on a day with a
 *      part-refunded cash sale — the ledger (GET /parties/:id), the tender
 *      machine (pos.payment_attempt), End of Day's party_prepay and its other
 *      lines, and the closed day all say the same thing; no party write made a
 *      sale, a sale line, a print job, a stock movement, a band or a wallet
 *      entry.
 *   2. THE DAY RULE across the 05:00 boundary: 04:30 the next calendar morning
 *      is still the day that is finishing; 05:00 is the next day. Money taken
 *      for another day's party is on no line of either day (plan §6).
 *   3. PATCH: protected fields refused / ignored; an allowed change written
 *      back once under an Idempotency-Key replay and under a lost answer at
 *      the app; an outage's edits on two parties reached by one Retry, oldest
 *      first, beside an E2 child the party Retry leaves to its own group.
 *   4. REACH: another operator's party is 404; a Chalong manager is refused at
 *      Central, and Central's party is not Chalong's.
 *
 * The till-side half of the money story (what the screens send on the press
 * after a refusal and on the retry after a lost answer) is
 * `apps/pos/test/s220-e4-review-press.test.ts`.
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let foreignBranch: string;
let operatorId: string;
let till: string;
let till2: string;
let receptionId: string;
let reception: string;
let admin: string;
let chalongManager: string;
let foreignAdmin: string;
let T: string;
let tz: string;
let appPool: pg.Pool;

const appTenant = newId();
const appCentral = newId();

const ev = {
  money: newId(),
  today: newId(),
  tomorrow: newId(),
  edit: newId(),
  editX: newId(),
  editY: newId(),
  reach: newId(),
};

// --- The OTO App's directory, from its own source ------------------------------

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
  isParty?: boolean;
}
type AppOutcome<R> = { ok: true; status: number; body: R } | { ok: false; status: number; error: string; message: string };
interface AppWrites {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(pool: pg.Pool, event: AppEvent, input: DirectoryAttendeeBody): Promise<AppOutcome<DirectoryAttendeeAnswer>>;
  editPartyEvent(pool: pg.Pool, event: AppEvent, input: DirectoryEventEditBody): Promise<AppOutcome<DirectoryEventEditAnswer>>;
}
let appWrites: AppWrites;

/** `app`: answered by the app. `unreachable`: never arrives. `lost`: the app applies it, the answer never comes back. */
type Plan = 'app' | 'unreachable' | 'lost';
const editPlan: Plan[] = [];
const attendeePlan: Plan[] = [];
const editCalls: Array<{ eventId: string; body: DirectoryEventEditBody }> = [];

function outcomeOf<R>(outcome: AppOutcome<R>): DirectoryOutcome<R> {
  if (outcome.ok) return { ok: true, status: outcome.status, body: outcome.body };
  return {
    ok: false,
    status: outcome.status,
    code: `OTOAPP_${outcome.error.toUpperCase()}`,
    message: outcome.message,
    retryable: outcome.status >= 500,
  };
}
const unreachable = <R>(): DirectoryOutcome<R> => ({
  ok: false,
  status: null,
  code: 'OTOAPP_DIRECTORY_UNREACHABLE',
  message: 'The OTO App did not answer',
  retryable: true,
});

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body) {
    const next = attendeePlan.shift() ?? 'app';
    if (next === 'unreachable') return unreachable();
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const out = outcomeOf(await appWrites.createEventAttendee(appPool, event, body));
    return next === 'lost' ? unreachable() : out;
  },
  async checkinAttendee() {
    // E4's reviews never check a child in; the seam only has to type.
    return unreachable();
  },
  async editEvent(eventId, body) {
    editCalls.push({ eventId, body });
    const next = editPlan.shift() ?? 'app';
    if (next === 'unreachable') return unreachable();
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const out = outcomeOf(await appWrites.editPartyEvent(appPool, event, body));
    return next === 'lost' ? unreachable() : out;
  },
};

// --- Helpers ---------------------------------------------------------------------

async function appEvent(e: { id: string; title: string; date: string; total: number; deposit: number }) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      total_value, prepayment_amount, prepayment_date, child_name, parent_name, whatsapp_phone_e164,
      kid_turning_age, num_children, num_adults, location_text, decoration, status, created_at, updated_at)
    values (
      ${e.id}, ${appTenant}, ${appCentral}, 'birthday', ${e.title}, ${e.date}, '13:00', '16:00',
      ${e.total}, ${e.deposit}, ${T}, 'Mali', 'Nok', '+66812345678',
      6, 15, 12, 'Party room 1', 'Ocean', 'upcoming',
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
}

async function call<R>(
  method: 'GET' | 'POST' | 'PATCH',
  cookie: string,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: R; raw: string; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { cookie, ...headers },
  });
  return { status: res.statusCode, body: res.json() as R, raw: res.body, headers: res.headers };
}
const errorCode = (body: unknown) => (body as { error?: { code?: string } }).error?.code;

const getParty = (id: string, cookie = reception, branchId = central) =>
  call<EventDetailAnswer>('GET', cookie, `/parties/${id}?branchId=${branchId}`);
const billOf = async (id: string) => (await getParty(id)).body.event.party!.bill!;

function paymentBody(o: { paymentId?: string; amount: number; method?: string; kind?: string; tendered?: number; expected?: number; stationId?: string; branchId?: string }) {
  return {
    branchId: o.branchId ?? central,
    stationId: o.stationId ?? till,
    paymentId: o.paymentId ?? newId(),
    actionId: newId(),
    amountSatang: o.amount,
    tender: {
      method: o.method ?? 'card',
      kind: o.kind ?? (o.method === 'cash' ? 'cash' : o.method === 'promptpay' ? 'qr' : 'card'),
      ...(o.tendered !== undefined ? { tenderedSatang: o.tendered } : {}),
    },
    ...(o.expected !== undefined ? { expectedOutstandingSatang: o.expected } : {}),
  };
}
const pay = (id: string, body: ReturnType<typeof paymentBody>, cookie = reception, headers: Record<string, string> = {}) =>
  call<PartyWriteAnswer>('POST', cookie, `/parties/${id}/payments`, body, headers);
const charge = (id: string, totalSatang: number, cookie = reception, branchId = central) =>
  call<PartyWriteAnswer>('POST', cookie, `/parties/${id}/charges`, {
    branchId,
    stationId: till,
    chargeId: newId(),
    actionId: newId(),
    kind: 'fnb',
    items: [{ name: 'Pad Thai', qty: 3, lineTotalSatang: totalSatang }],
    totalSatang,
  });
const patch = (id: string, body: Record<string, unknown>, cookie = reception, headers: Record<string, string> = {}) =>
  call<PartyWriteAnswer>('PATCH', cookie, `/parties/${id}`, { branchId: central, editId: newId(), ...body }, headers);

async function endOfDay(date: string): Promise<EndOfDayRecord> {
  const res = await call<EndOfDayRecord>('GET', reception, `/branches/${central}/end-of-day?date=${date}`);
  expect(res.status, res.raw).toBe(200);
  return res.body;
}
const lineOf = (rec: EndOfDayRecord, channel: string) => rec.lines.find((l) => l.channel === channel)?.expectedSatang ?? 0;
const cardTotal = (rec: EndOfDayRecord) =>
  rec.lines.filter((l) => l.channel.startsWith('card:')).reduce((s, l) => s + l.expectedSatang, 0);

/** What the tender machine holds for one party: the attempts behind its payments. */
async function attemptsOf(eventId: string) {
  return ctx.db
    .select({ attempt: paymentAttempt, payment: partyPayment })
    .from(partyPayment)
    .innerJoin(paymentAttempt, eq(paymentAttempt.id, partyPayment.paymentAttemptId))
    .where(eq(partyPayment.otoappEventId, eventId));
}

/**
 * The party_prepay rule straight off the tables: taken on D, at Central, for
 * the parties the OTO App holds on D as it is read now (`getPartiesForDate`).
 */
async function partyPrepayFromTables(date: string): Promise<number> {
  const rows = await ctx.db
    .select({ amount: paymentAttempt.amountSatang, eventId: partyPayment.otoappEventId })
    .from(partyPayment)
    .innerJoin(paymentAttempt, eq(paymentAttempt.id, partyPayment.paymentAttemptId))
    .where(
      and(
        eq(paymentAttempt.branchId, central),
        eq(paymentAttempt.businessDate, date),
        inArray(paymentAttempt.status, [...PAYMENT_ATTEMPT_TAKEN_STATUSES]),
      ),
    );
  const held = await ctx.db.execute<{ id: string }>(
    sql`select id::text as id from otoapp.core_events where event_date = ${date}`,
  );
  const heldThatDay = new Set(held.rows.map((r) => r.id));
  return rows.filter((r) => heldThatDay.has(r.eventId)).reduce((s, r) => s + r.amount, 0);
}

/** Every table a sale of goods, a kitchen ticket, a stock move or a band would touch. */
async function goodsCounts() {
  const n = async (table: typeof sale | typeof saleLine | typeof printJob | typeof stockMovement | typeof band | typeof walletEntry) =>
    (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(table))[0]!.n;
  return {
    sales: await n(sale),
    saleLines: await n(saleLine),
    printJobs: await n(printJob),
    stockMovements: await n(stockMovement),
    bands: await n(band),
    walletEntries: await n(walletEntry),
  };
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  foreignBranch = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  tz = hkt!.timezone;
  T = businessDate(new Date(), tz, parseDayStart(hkt!.businessDayStart));
  expect(hkt!.businessDayStart.startsWith('05:00')).toBe(true);
  const [som] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionId = som!.id;
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  const [t2] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T2')));
  till = t1!.id;
  till2 = t2!.id;
  for (const id of [t1!.boxId!, t2!.boxId!]) {
    await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, id));
  }

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e4-review')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await appEvent({ id: ev.money, title: 'Money party', date: T, total: 10_000, deposit: 2_000 });
  await appEvent({ id: ev.today, title: 'Today party', date: T, total: 3_000, deposit: 0 });
  await appEvent({ id: ev.tomorrow, title: 'Tomorrow party', date: addDaysToIsoDate(T, 1), total: 3_000, deposit: 0 });
  await appEvent({ id: ev.edit, title: 'Edit party', date: T, total: 8_000, deposit: 2_000 });
  await appEvent({ id: ev.editX, title: 'Party X', date: T, total: 6_000, deposit: 1_000 });
  await appEvent({ id: ev.editY, title: 'Party Y', date: T, total: 7_000, deposit: 1_000 });
  await appEvent({ id: ev.reach, title: 'Reach party', date: T, total: 5_000, deposit: 0 });

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  editPlan.length = 0;
  attendeePlan.length = 0;
});

// =============================================================================
// 1. One story to the satang
// =============================================================================

describe('1 — one party, replayed, raced, beside a part-refunded sale: the ledger, the tender machine and End of Day agree to the satang', () => {
  let eodBefore: EndOfDayRecord;
  let goodsBefore: Awaited<ReturnType<typeof goodsCounts>>;
  const taken: number[] = [];
  let walkUp = 0;

  it('a cash sale rung up today is part-refunded: the cash line nets it, nothing else moves', async () => {
    const before = await endOfDay(T);
    const saleId = newId();
    await ctx.db.insert(sale).values({
      id: saleId,
      operatorId,
      branchId: central,
      stationId: till,
      businessDate: T,
      businessDayStart: '05:00',
      timezone: tz,
      occurredAt: new Date(),
      createdByAccountId: receptionId,
      pricingMode: 'weekday',
      pricingModeReason: 'Weekday pricing',
      customerTier: 'tourist',
      engineVersion: 'e4-review',
      taxConfig: {},
      taxBreakdown: {},
      subtotalSatang: 50_000,
      netSatang: 50_000,
      grossSatang: 50_000,
      receiptSeries: 'E4R',
      receiptSeq: 1,
      receiptNumber: 'E4R-1',
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
      amountSatang: 50_000,
      paidAt: new Date(),
    });
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: receptionId, operatorId, stationId: till, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        saleId,
        { mode: 'custom', amountSatang: 20_000, reason: 'One ticket not used', actionId: newId() },
      ),
    );
    const after = await endOfDay(T);
    expect(lineOf(after, 'cash')).toBe(lineOf(before, 'cash') + 30_000);
    expect(lineOf(after, 'party_prepay')).toBe(lineOf(before, 'party_prepay'));
    eodBefore = after;
    goodsBefore = await goodsCounts();
  });

  it('the tab: ฿10,000 base, ฿2,000 deposit, F&B in satang and a walk-up — the balance is exactly their sum', async () => {
    expect((await charge(ev.money, 123_450)).status).toBe(200);
    const guest = await call<{ attendee: { priceSatang: number; billing: string } }>('POST', reception, `/events/${ev.money}/attendees`, {
      branchId: central,
      stationId: till,
      attendeeId: newId(),
      actionId: newId(),
      registerProperly: false,
      attendee: { name: 'Guest', parentName: 'May' },
    });
    expect(guest.status, guest.raw).toBe(200);
    expect(guest.body.attendee.billing).toBe('party_tab');
    walkUp = guest.body.attendee.priceSatang;
    expect(await billOf(ev.money)).toMatchObject({
      baseSatang: 1_000_000,
      chargesSatang: 123_450 + walkUp,
      totalSatang: 1_123_450 + walkUp,
      depositSatang: 200_000,
      paidSatang: 0,
      outstandingSatang: 923_450 + walkUp,
    });
  });

  it('a card payment under an Idempotency-Key: replayed verbatim, by key and by id; the same key with another body is refused; one attempt', async () => {
    const owed = (await billOf(ev.money)).outstandingSatang;
    const body = paymentBody({ amount: 300_000, expected: owed });
    const key = { 'idempotency-key': `party-payment:${body.paymentId}` };
    const first = await pay(ev.money, body, reception, key);
    expect(first.status, first.raw).toBe(200);
    expect(first.body.payment).toMatchObject({ amountSatang: 300_000, businessDate: T, kind: 'card' });
    taken.push(300_000);

    const again = await pay(ev.money, body, reception, key);
    expect(again.status).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.body).toEqual(first.body);

    const byId = await pay(ev.money, { ...body, actionId: newId() });
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ replayed: true, payment: { id: body.paymentId, amountSatang: 300_000 } });

    const mismatch = await pay(ev.money, { ...body, amountSatang: 100_000 }, reception, key);
    expect(mismatch.status).toBe(409);
    expect(errorCode(mismatch.body)).toBe('IDEMPOTENCY_MISMATCH');

    expect(await attemptsOf(ev.money)).toHaveLength(1);
    expect((await billOf(ev.money)).outstandingSatang).toBe(owed - 300_000);
  });

  it('two tills, each shown the same balance, each taking ฿3,000: one is recorded, the other refused with nothing taken', async () => {
    const owed = (await billOf(ev.money)).outstandingSatang;
    const [a, b] = await Promise.all([
      pay(ev.money, paymentBody({ amount: 300_000, expected: owed, stationId: till })),
      pay(ev.money, paymentBody({ amount: 300_000, expected: owed, stationId: till2 })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect(errorCode(refused.body)).toBe('PARTY_BALANCE_CHANGED');
    expect((refused.body as unknown as { error: { details: { outstandingSatang: number } } }).error.details.outstandingSatang).toBe(owed - 300_000);
    taken.push(300_000);
    expect(await attemptsOf(ev.money)).toHaveLength(2);
  });

  it('a charge and a payment racing: the payment is never recorded against a bill it was not shown', async () => {
    const owed = (await billOf(ev.money)).outstandingSatang;
    const body = paymentBody({ amount: 10_000, expected: owed, stationId: till2 });
    const [c, p] = await Promise.all([charge(ev.money, 5_000), pay(ev.money, body)]);
    expect(c.status).toBe(200);
    if (p.status === 200) {
      taken.push(10_000);
      const [row] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.payment'), eq(auditLog.entityId, body.paymentId)));
      expect(row!.before).toEqual({ outstandingSatang: owed });
    } else {
      expect(errorCode(p.body)).toBe('PARTY_BALANCE_CHANGED');
    }
  });

  it('cash at the second till: whole baht, its change, its own counter on the attempt', async () => {
    const res = await pay(ev.money, paymentBody({ amount: 100_099, method: 'cash', tendered: 200_000, stationId: till2 }));
    expect(res.status, res.raw).toBe(200);
    expect(res.body.payment!.amountSatang).toBe(100_000);
    taken.push(100_000);
    const [row] = (await attemptsOf(ev.money)).filter((r) => r.payment.id === res.body.payment!.id);
    expect(row!.attempt).toMatchObject({ saleId: null, stationId: till2, method: 'cash', amountSatang: 100_000, changeSatang: 100_000 });
  });

  it('the ledger, the tender machine and End of Day tell one story; party money is on no other line', async () => {
    const paid = taken.reduce((s, n) => s + n, 0);
    const party = (await getParty(ev.money)).body.event.party!;
    // The ledger.
    expect(party.bill!.paidSatang).toBe(paid);
    expect(party.payments!.reduce((s, p) => s + p.amountSatang, 0)).toBe(paid);
    expect(party.bill!.outstandingSatang).toBe(party.bill!.totalSatang - 200_000 - paid);
    // The tender machine: one approved attempt per payment, no sale behind any.
    const rows = await attemptsOf(ev.money);
    expect(rows).toHaveLength(taken.length);
    expect(rows.every((r) => r.attempt.saleId === null && r.attempt.status === 'approved' && r.attempt.businessDate === T)).toBe(true);
    expect(rows.reduce((s, r) => s + r.attempt.amountSatang, 0)).toBe(paid);
    expect(new Set(rows.map((r) => r.attempt.id))).toEqual(new Set(party.payments!.map((p) => p.attemptId)));
    // End of Day: all of it on party_prepay, none on cash, card or PromptPay.
    const after = await endOfDay(T);
    expect(lineOf(after, 'party_prepay') - lineOf(eodBefore, 'party_prepay')).toBe(paid);
    expect(lineOf(after, 'cash')).toBe(lineOf(eodBefore, 'cash'));
    expect(cardTotal(after)).toBe(cardTotal(eodBefore));
    expect(lineOf(after, 'promptpay')).toBe(lineOf(eodBefore, 'promptpay'));
    expect(lineOf(after, 'party_prepay')).toBe(await partyPrepayFromTables(T));
    expect(after.totalExpectedSatang).toBe(after.lines.reduce((s, l) => s + l.expectedSatang, 0));
  });

  it("the card terminal's settlement sees the party's card money, and End of Day's card lines plus the party's card payments are exactly it (plan §6)", async () => {
    const res = await call<{ unmatchedAttempts: Array<{ id: string; method: string; amountSatang: number }> }>(
      'GET',
      admin,
      `/branches/${central}/settlements?date=${T}`,
    );
    expect(res.status, res.raw).toBe(200);
    const partyCard = (await attemptsOf(ev.money)).filter((r) => r.attempt.method === 'card');
    expect(partyCard.length).toBeGreaterThan(0);
    const listed = new Map(res.body.unmatchedAttempts.map((a) => [a.id, a]));
    for (const r of partyCard) expect(listed.get(r.attempt.id)).toMatchObject({ method: 'card', amountSatang: r.attempt.amountSatang });
    const settlementCard = res.body.unmatchedAttempts.filter((a) => a.method === 'card').reduce((s, a) => s + a.amountSatang, 0);
    const partyCardSum = partyCard.reduce((s, r) => s + r.attempt.amountSatang, 0);
    expect(settlementCard).toBe(cardTotal(await endOfDay(T)) + partyCardSum);
  });

  it('nothing on the tab was a sale of goods: no sale, line, print job, stock movement, band or wallet entry', async () => {
    expect(await goodsCounts()).toEqual(goodsBefore);
    // The walk-up charge is the E2 link, billed to the tab — not a sale either.
    const [link] = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.otoappEventId, ev.money));
    expect(link).toMatchObject({ billing: 'party_tab', saleId: null, priceSnapshotSatang: walkUp });
  });
});

// =============================================================================
// 2. The day rule, across the 05:00 boundary
// =============================================================================

describe("2 — Q3's day rule: the day the money is taken, for that day's party, on the branch's business day", () => {
  const actor = () => ({
    accountId: receptionId,
    operatorId,
    branchId: central,
    requestId: 'e4-review',
    assertBranchAllowed: async () => {},
  });
  const deps = () => ({ db: ctx.db, directory });
  const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);
  const payAt = (partyId: string, amount: number, now: Date) =>
    payParty(deps(), {}, actor(), partyId, paymentBody({ amount, method: 'card' }), now);

  it("04:30 the next calendar morning is still the day that is finishing: today's party counts today", async () => {
    const before = lineOf(await endOfDay(T), 'party_prepay');
    const { answer } = await payAt(ev.today, 10_000, at(addDaysToIsoDate(T, 1), '04:30'));
    expect(answer.payment).toMatchObject({ businessDate: T });
    expect(lineOf(await endOfDay(T), 'party_prepay')).toBe(before + 10_000);
  });

  it("04:59, for tomorrow's party: on no line today, nor tomorrow (plan §6)", async () => {
    const today = lineOf(await endOfDay(T), 'party_prepay');
    const tomorrow = lineOf(await endOfDay(addDaysToIsoDate(T, 1)), 'party_prepay');
    const { answer } = await payAt(ev.tomorrow, 10_000, at(addDaysToIsoDate(T, 1), '04:59'));
    expect(answer.payment).toMatchObject({ businessDate: T });
    expect(lineOf(await endOfDay(T), 'party_prepay')).toBe(today);
    expect(lineOf(await endOfDay(addDaysToIsoDate(T, 1)), 'party_prepay')).toBe(tomorrow);
  });

  it("05:00 is the next day: tomorrow's party counts tomorrow; today's party, paid then, counts on neither", async () => {
    const d1 = addDaysToIsoDate(T, 1);
    const today = lineOf(await endOfDay(T), 'party_prepay');
    const tomorrow = lineOf(await endOfDay(d1), 'party_prepay');
    const forTomorrow = await payAt(ev.tomorrow, 20_000, at(d1, '05:00'));
    expect(forTomorrow.answer.payment).toMatchObject({ businessDate: d1 });
    const forToday = await payAt(ev.today, 20_000, at(d1, '05:00'));
    expect(forToday.answer.payment).toMatchObject({ businessDate: d1 });
    expect(lineOf(await endOfDay(T), 'party_prepay')).toBe(today);
    expect(lineOf(await endOfDay(d1), 'party_prepay')).toBe(tomorrow + 20_000);
    expect(lineOf(await endOfDay(d1), 'party_prepay')).toBe(await partyPrepayFromTables(d1));
    // Tomorrow has taken nothing but party money so far: every tender line is ฿0 (H10).
    const rec = await endOfDay(d1);
    expect(rec.lines.filter((l) => l.channel !== 'party_prepay').every((l) => l.expectedSatang === 0)).toBe(true);
  });
});

// =============================================================================
// 3. PATCH — protected fields, written back once, Failures
// =============================================================================

describe('3 — PATCH /parties/:id: protected fields, one write-back under replay, an outage swept from Failures', () => {
  const appRow = async (id: string) =>
    (
      await ctx.db.execute<Record<string, unknown>>(
        sql`select title, decoration, activities, location_text, total_value, prepayment_amount, branch_id, tenant_id,
                   (extract(epoch from (updated_at at time zone 'UTC')) * 1000)::bigint::text as updated_ms
              from otoapp.core_events where id = ${id}`,
      )
    ).rows[0]!;
  const ledgerRows = async (id: string) => ({
    charges: (await ctx.db.select().from(partyCharge).where(eq(partyCharge.otoappEventId, id))).length,
    payments: (await ctx.db.select().from(partyPayment).where(eq(partyPayment.otoappEventId, id))).length,
  });
  const callsFor = (id: string) => editCalls.filter((c) => c.eventId === id).length;
  const editOf = async (id: string) => (await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, id)))[0]!;

  it('a body of protected fields only: refused, nothing saved, nothing sent', async () => {
    expect((await charge(ev.edit, 10_000)).status).toBe(200);
    expect((await pay(ev.edit, paymentBody({ amount: 50_000 }))).status).toBe(200);
    const ledgers = await ledgerRows(ev.edit);
    const before = await appRow(ev.edit);
    const edits = (await ctx.db.select().from(partyEdit).where(eq(partyEdit.otoappEventId, ev.edit))).length;
    const calls = callsFor(ev.edit);
    const res = await patch(ev.edit, {
      id: newId(),
      partyExtraCharges: [],
      partyPayments: [{ id: 'p', amount: 1 }],
      charges: [],
      payments: [],
      lastEditedBy: 'Nobody',
      branch: chalong,
    });
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe('PARTY_EDIT_EMPTY');
    expect((await ctx.db.select().from(partyEdit).where(eq(partyEdit.otoappEventId, ev.edit))).length).toBe(edits);
    expect(callsFor(ev.edit)).toBe(calls);
    expect(await ledgerRows(ev.edit)).toEqual(ledgers);
    expect(await appRow(ev.edit)).toEqual(before);
  });

  it('an allowed change beside protected ones: the change is written, the protected ones are named and change nothing', async () => {
    const ledgers = await ledgerRows(ev.edit);
    const before = (await getParty(ev.edit)).body.event;
    const res = await patch(ev.edit, { decoration: 'Jungle', charges: [], payments: [], id: newId() });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.edit).toMatchObject({ syncState: 'synced', ignored: ['charges', 'id', 'payments'] });
    expect(res.body.party).toMatchObject({ id: ev.edit, branchId: central });
    expect(res.body.party.party!.charges).toEqual(before.party!.charges);
    expect(res.body.party.party!.payments).toEqual(before.party!.payments);
    expect(res.body.party.party!.bill).toEqual(before.party!.bill);
    expect(await ledgerRows(ev.edit)).toEqual(ledgers);
    expect(await appRow(ev.edit)).toMatchObject({ decoration: 'Jungle', branch_id: appCentral, tenant_id: appTenant });
  });

  it('an Idempotency-Key replay is the stored answer: one edit, one call to the app; the key with another body is refused', async () => {
    const editId = newId();
    const body = { editId, activities: 'Bubbles' };
    const key = { 'idempotency-key': `party-edit:${editId}` };
    const calls = callsFor(ev.edit);
    const first = await patch(ev.edit, body, reception, key);
    expect(first.status, first.raw).toBe(200);
    const again = await patch(ev.edit, body, reception, key);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(callsFor(ev.edit) - calls).toBe(1);
    expect(await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, editId))).toHaveLength(1);
    const mismatch = await patch(ev.edit, { ...body, activities: 'Magic' }, reception, key);
    expect(mismatch.status).toBe(409);
    expect(errorCode(mismatch.body)).toBe('IDEMPOTENCY_MISMATCH');
    expect((await appRow(ev.edit)).activities).toBe('Bubbles');
  });

  it('the app took it but its answer was lost: the replay of the same edit is the app’s replay — written once, then synced', async () => {
    const editId = newId();
    editPlan.push('lost');
    const first = await patch(ev.edit, { editId, location: 'Party room 2' });
    expect(first.status).toBe(200);
    expect(first.body.edit).toMatchObject({ syncState: 'pending' });
    const landed = await appRow(ev.edit);
    expect(landed.location_text).toBe('Party room 2');
    // The app stamps the event with the edit's own moment: what makes a second send a replay.
    const stamp = (await editOf(editId)).createdAt.getTime();
    expect(Number(landed.updated_ms)).toBe(stamp);

    const replay = await patch(ev.edit, { editId, location: 'Party room 2' });
    expect(replay.status).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.body.edit).toMatchObject({ id: editId, syncState: 'synced' });
    // The app's own word on the second send: the same edit, already applied.
    const runs = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, PARTY_UPDATE_RUN), sql`${opsRun.detail}->>'editId' = ${editId}`))
      .orderBy(opsRun.startedAt);
    expect(runs.map((r) => r.outcome)).toEqual(['failed', 'ok']);
    expect(runs[1]!.detail).toMatchObject({ replayed: true });
    expect(await appRow(ev.edit)).toMatchObject({ location_text: 'Party room 2', updated_ms: landed.updated_ms });
    expect(await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, editId))).toHaveLength(1);
  });

  it('an outage leaves edits on two parties and an E2 child waiting: the party Retry reaches every party edit, oldest first, and leaves the child to its own group', async () => {
    editPlan.push('unreachable', 'unreachable', 'unreachable');
    const x1 = await patch(ev.editX, { decoration: 'Pirates' });
    const y1 = await patch(ev.editY, { decoration: 'Space' });
    const x2 = await patch(ev.editX, { decoration: 'Dinosaurs', activities: 'Slime' });
    for (const r of [x1, y1, x2]) expect(r.body.edit!.syncState).toBe('pending');
    // While waiting, the party shows as the till last edited it, marked.
    expect((await getParty(ev.editX)).body.event.party).toMatchObject({ decoration: 'Dinosaurs', editSync: { state: 'pending' } });
    attendeePlan.push('unreachable');
    const childId = newId();
    const child = await call<unknown>('POST', reception, `/events/${ev.editX}/attendees`, {
      branchId: central,
      stationId: till,
      attendeeId: childId,
      actionId: newId(),
      registerProperly: false,
      attendee: { name: 'Late guest', parentName: 'Ploy' },
    });
    expect(child.status, child.raw).toBe(200);

    const page = await call<{ groups: Array<{ name: string; retryable: boolean; lastRunId: string }> }>(
      'GET',
      admin,
      '/ops/failures?windowHours=1&kind=integration',
    );
    const party = page.body.groups.find((g) => g.name === PARTY_UPDATE_RUN);
    const children = page.body.groups.find((g) => g.name === 'otoapp:attendee.create');
    expect(party).toMatchObject({ retryable: true });
    expect(children).toMatchObject({ retryable: true });

    // Not a Chalong manager's to press, nor another operator's.
    expect((await call('POST', chalongManager, `/ops/runs/${party!.lastRunId}/retry`, {})).status).toBe(403);
    expect((await call('POST', foreignAdmin, `/ops/runs/${party!.lastRunId}/retry`, {})).status).toBe(404);

    const calls = editCalls.length;
    const retried = await call<{ outcome: string; sent: number; synced: number; waiting: number }>('POST', admin, `/ops/runs/${party!.lastRunId}/retry`, {});
    expect(retried.status, retried.raw).toBe(200);
    expect(retried.body).toMatchObject({ outcome: 'ok', waiting: 0 });
    for (const r of [x1, y1, x2]) expect(await editOf(r.body.edit!.id)).toMatchObject({ syncState: 'synced' });
    // Each party's edits reached the app in the order they were made: X ends as its last edit said.
    expect(await appRow(ev.editX)).toMatchObject({ decoration: 'Dinosaurs', activities: 'Slime' });
    expect(await appRow(ev.editY)).toMatchObject({ decoration: 'Space' });
    const sent = editCalls.slice(calls);
    expect(sent.length).toBeLessThanOrEqual(3);
    // The child is E2's, and its own group's Retry sends it.
    const [link] = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, childId));
    expect(link!.syncState).toBe('pending');
    const childRetry = await call<{ syncState: string }>('POST', admin, `/ops/runs/${children!.lastRunId}/retry`, {});
    expect(childRetry.status, childRetry.raw).toBe(200);
    const [after] = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, childId));
    expect(after!.syncState).toBe('synced');
    expect((await getParty(ev.editX)).body.event.party!.editSync).toBeNull();
  });
});

// =============================================================================
// 4. Reach
// =============================================================================

describe('4 — reach: another operator’s party, another branch’s manager', () => {
  const written = async () => ({
    charges: (await ctx.db.select().from(partyCharge)).length,
    payments: (await ctx.db.select().from(partyPayment)).length,
    edits: (await ctx.db.select().from(partyEdit)).length,
    attempts: (await ctx.db.select({ id: paymentAttempt.id }).from(paymentAttempt)).length,
  });

  it("another operator's admin, at their own branch, finds no such party: 404 for every read and write, nothing written", async () => {
    const before = await written();
    expect((await getParty(ev.reach, foreignAdmin, foreignBranch)).status).toBe(404);
    expect((await charge(ev.reach, 1_000, foreignAdmin, foreignBranch)).status).toBe(404);
    expect((await pay(ev.reach, paymentBody({ amount: 1_000, branchId: foreignBranch, stationId: newId() }), foreignAdmin)).status).toBe(404);
    expect(
      (await call('PATCH', foreignAdmin, `/parties/${ev.reach}`, { branchId: foreignBranch, editId: newId(), title: 'Hijack' })).status,
    ).toBe(404);
    expect(await written()).toEqual(before);
  });

  it("another operator's admin naming Central: refused, nothing written", async () => {
    const before = await written();
    for (const res of [
      await getParty(ev.reach, foreignAdmin),
      await charge(ev.reach, 1_000, foreignAdmin),
      await pay(ev.reach, paymentBody({ amount: 1_000 }), foreignAdmin),
      await patch(ev.reach, { title: 'Hijack' }, foreignAdmin),
    ]) {
      expect([403, 404]).toContain(res.status);
    }
    expect(await written()).toEqual(before);
  });

  it('a Chalong manager at Central: 403 for every read and write; naming Chalong, Central’s party is not found', async () => {
    const before = await written();
    expect((await getParty(ev.reach, chalongManager)).status).toBe(403);
    expect((await charge(ev.reach, 1_000, chalongManager)).status).toBe(403);
    expect((await pay(ev.reach, paymentBody({ amount: 1_000 }), chalongManager)).status).toBe(403);
    expect((await patch(ev.reach, { title: 'Hijack' }, chalongManager)).status).toBe(403);
    expect((await getParty(ev.reach, chalongManager, chalong)).status).toBe(404);
    expect((await charge(ev.reach, 1_000, chalongManager, chalong)).status).toBe(404);
    expect(
      (await call('PATCH', chalongManager, `/parties/${ev.reach}`, { branchId: chalong, editId: newId(), title: 'Hijack' })).status,
    ).toBe(404);
    expect(await written()).toEqual(before);
    expect((await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.update'), sql`${auditLog.after}->>'eventId' = ${ev.reach}`))).length).toBe(0);
  });
});

// =============================================================================
// 5. The day closes
// =============================================================================

describe('5 — the day closes: the closed record keeps party_prepay where S2-15a keeps it, as the tables say', () => {
  it('Close Day for today: party_prepay closed at what the tables hold, the line order unchanged, totals add up', async () => {
    const open = await endOfDay(T);
    const prepay = lineOf(open, 'party_prepay');
    expect(prepay).toBe(await partyPrepayFromTables(T));
    expect(prepay).toBeGreaterThan(0);
    const res = await call<EndOfDayRecord>('POST', admin, `/branches/${central}/end-of-day/close`, {
      date: T,
      countedSatang: 500_000 + lineOf(open, 'cash'),
      floatLeftSatang: 500_000,
      actuals: [{ channel: 'party_prepay', actualSatang: prepay }],
      vouchers: { handedOut: null, redeemed: null },
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(res.body.lines.map((l) => [l.channel, l.expectedSatang])).toEqual(open.lines.map((l) => [l.channel, l.expectedSatang]));
    expect(res.body.lines.find((l) => l.channel === 'party_prepay')).toMatchObject({ expectedSatang: prepay, actualSatang: prepay, differenceSatang: 0 });
    expect(res.body.lines.map((l) => l.channel).slice(-4)).toEqual(['ewallet', 'bank_transfer', 'party_prepay', 'credit']);
    expect(res.body.totalExpectedSatang).toBe(res.body.lines.reduce((s, l) => s + l.expectedSatang, 0));
    // The audit row of the close carries the same line.
    const [closeRow] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'end_of_day.close'), eq(auditLog.branchId, central)))
      .orderBy(desc(auditLog.createdAt));
    const lines = (closeRow!.after as { lines: Array<{ channel: string; expectedSatang: number }> }).lines;
    expect(lines.find((l) => l.channel === 'party_prepay')!.expectedSatang).toBe(prepay);
  });
});
