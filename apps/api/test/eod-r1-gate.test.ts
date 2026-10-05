import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import { schema } from '@oto/db';
import {
  DEFAULT_FLOAT,
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EndOfDayRecord,
  type RefundAllocationEntry,
} from '@oto/shared';
import {
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { refundSale } from '../src/services/refunds';
import { NO_TERMINAL_TID } from '../src/services/end-of-day';

/**
 * S2-15a round 1 — FOCUSED GATE (revised plan, 2 Oct). Every attack on the
 * End of Day kept as a test: the lines (which money enters, which leaves, on
 * which line and which day, summed by hand to the satang), the close (the
 * server's own figures, one close, a frozen closed day, the float carried,
 * who may close, audit, replay), and the people (second person distinct and
 * entitled, scope enforced on the server).
 *
 * The scripted day G is three business days back, so it is never "today"
 * and closing it is allowed; P is the day before it, for the float and the
 * refund of an earlier day's sale.
 */

let ctx: TestContext;
let operatorId: string;
let central: string;
let chalong: string;
let tz: string;
let dayStart: number;
let till1: string;
let counter2: string;
let chalongTill: string;
let edc1: { id: string; tid: string };
let receptionId: string;
let managerId: string;
let chalongManagerId: string;
let staffId: string;
let inactiveManagerId: string;
let receptionCookie: string;
let managerCookie: string;
let chalongCookie: string;
let staffCookie: string;

let D: string;
let G: string;
let P: string;

let seq = 0;

async function stationOf(branchId: string, name: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: schema.station.id })
    .from(schema.station)
    .where(and(eq(schema.station.branchId, branchId), eq(schema.station.name, name)))
    .limit(1);
  if (!row) throw new Error(`no station ${name}`);
  return row.id;
}

async function accountIdOf(phone: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: schema.account.id })
    .from(schema.account)
    .where(and(eq(schema.account.operatorId, operatorId), eq(schema.account.phone, phone)))
    .limit(1);
  if (!row) throw new Error(`no account ${phone}`);
  return row.id;
}

async function roleId(name: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: schema.role.id })
    .from(schema.role)
    .where(and(eq(schema.role.name, name), isNull(schema.role.operatorId)))
    .limit(1);
  return row!.id;
}

async function makeAccount(phone: string, password: string, role: string, status: 'active' | 'inactive' = 'active'): Promise<string> {
  const id = newId();
  await ctx.db.insert(schema.account).values({ id, operatorId, phone, status, passwordHash: await hash(password) });
  await ctx.db.insert(schema.roleAssignment).values({ id: newId(), accountId: id, roleId: await roleId(role), scopeType: 'branch', scopeId: central });
  return id;
}

interface AttemptSpec {
  method: 'cash' | 'card' | 'qr' | 'wallet' | 'transfer';
  methodCode: string;
  amountSatang: number;
  status?: string;
  provider?: 'manual' | 'ghl' | '2c2p' | 'simulator';
  deviceId?: string | null;
  tid?: string | null;
  stationId?: string | null;
  invoiceNo?: string | null;
}

/** A wall-clock instant in the branch's zone (Bangkok, +07:00). */
const local = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);

/** A finalised sale and its attempts, dated with the platform's own business-date rule. */
async function ringUp(opts: { branchId: string; stationId: string; at: Date; attempts: AttemptSpec[] }) {
  const day = businessDate(opts.at, tz, dayStart);
  const gross = opts.attempts.reduce((s, a) => s + a.amountSatang, 0);
  const saleId = newId();
  seq += 1;
  await ctx.db.insert(schema.sale).values({
    id: saleId,
    operatorId,
    branchId: opts.branchId,
    stationId: opts.stationId,
    businessDate: day,
    businessDayStart: '05:00',
    timezone: tz,
    occurredAt: opts.at,
    createdByAccountId: receptionId,
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    customerTier: 'tourist',
    engineVersion: 'eod-r1-gate',
    taxConfig: {},
    taxBreakdown: {},
    subtotalSatang: gross,
    netSatang: gross,
    grossSatang: gross,
    receiptSeries: 'EODG',
    receiptSeq: seq,
    receiptNumber: `EODG-${seq}`,
    status: 'finalised',
    finalisedAt: opts.at,
  });
  const attemptIds: string[] = [];
  for (const a of opts.attempts) {
    const id = newId();
    attemptIds.push(id);
    await ctx.db.insert(schema.paymentAttempt).values({
      id,
      operatorId,
      branchId: opts.branchId,
      saleId,
      stationId: a.stationId === undefined ? opts.stationId : a.stationId,
      deviceId: a.deviceId ?? null,
      businessDate: day,
      method: a.method,
      methodCode: a.methodCode,
      provider: a.provider ?? 'manual',
      status: (a.status ?? 'approved') as 'approved',
      amountSatang: a.amountSatang,
      tid: a.tid ?? null,
      invoiceNo: a.invoiceNo ?? null,
      paidAt: opts.at,
      createdAt: opts.at,
    });
  }
  return { saleId, attemptIds, businessDate: day };
}

async function refundRow(saleId: string, amountSatang: number, allocation: RefundAllocationEntry[]) {
  seq += 1;
  await ctx.db.insert(schema.refund).values({
    id: newId(),
    operatorId,
    branchId: central,
    saleId,
    stationId: till1,
    number: `EODG-R-${seq}`,
    amountSatang,
    mode: 'custom',
    reason: 'gate',
    approvedByAccountId: managerId,
    createdByAccountId: managerId,
    tenderAllocation: allocation,
  });
}

const getDay = (cookie: string, date: string, branchId = central) =>
  ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/end-of-day?date=${date}`, headers: { cookie } });

const closeDay = (cookie: string, payload: Record<string, unknown>, key?: string, branchId = central) =>
  ctx.app.inject({
    method: 'POST',
    url: `/branches/${branchId}/end-of-day/close`,
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  });

const move = (cookie: string, payload: Record<string, unknown>, branchId = central) =>
  ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/cash-movements`, headers: { cookie }, payload });

const expectedOf = (rec: EndOfDayRecord) => Object.fromEntries(rec.lines.map((l) => [l.channel, l.expectedSatang]));

beforeAll(async () => {
  ctx = await createTestContext();
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [b] = await ctx.db
    .select({ tz: schema.branch.timezone, start: schema.branch.businessDayStart })
    .from(schema.branch)
    .where(eq(schema.branch.id, central));
  tz = b!.tz;
  dayStart = parseDayStart(b!.start);
  D = businessDate(new Date(), tz, dayStart);
  G = addDaysToIsoDate(D, -3);
  P = addDaysToIsoDate(G, -1);

  till1 = await stationOf(central, 'Reception Till 1');
  counter2 = await stationOf(central, 'Counter 2');
  chalongTill = await stationOf(chalong, 'Reception Till 1');
  const [card] = await ctx.db
    .select({ id: schema.device.id, tid: schema.device.terminalId })
    .from(schema.device)
    .where(and(eq(schema.device.branchId, central), eq(schema.device.terminalId, '65703235')))
    .limit(1);
  edc1 = { id: card!.id, tid: card!.tid! };

  receptionId = await accountIdOf(RECEPTION.phone);
  managerId = await accountIdOf(BRANCH_MANAGER.phone);
  chalongManagerId = await accountIdOf(CHALONG_MANAGER.phone);
  staffId = await makeAccount('+66900000881', 'staff1234', 'staff');
  inactiveManagerId = await makeAccount('+66900000882', 'gone1234', 'branch_manager', 'inactive');

  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongCookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  staffCookie = await signInAs(ctx.app, '+66900000881', 'staff1234');
  await takeStation(ctx.app, receptionCookie, till1);
  await takeStation(ctx.app, managerCookie, till1);
  await takeStation(ctx.app, staffCookie, till1);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// --- (2) THE LINES ----------------------------------------------------------------

let pSale: { saleId: string };
let gCardPartial: { saleId: string; attemptIds: string[] };

describe('gate (2): every attempt and refund lands on the right line and the right day', () => {
  it('a scripted day G, summed by hand to the satang', async () => {
    // Two stations' cash: ONE combined cash line.
    await ringUp({ branchId: central, stationId: till1, at: local(G, '10:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 1_000_00 }] });
    await ringUp({ branchId: central, stationId: counter2, at: local(G, '12:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 250_25 }] });
    // 01:30 local on the next calendar morning: still day G (the day starts 05:00).
    const late = await ringUp({ branchId: central, stationId: counter2, at: local(addDaysToIsoDate(G, 1), '01:30'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 30_00 }] });
    expect(late.businessDate).toBe(G);
    // 05:00 the next morning is the NEXT day — never on G.
    const next = await ringUp({ branchId: central, stationId: till1, at: local(addDaysToIsoDate(G, 1), '05:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 7_00 }] });
    expect(next.businessDate).toBe(addDaysToIsoDate(G, 1));

    // QR: a terminal QR taken on its own 4G (awaiting settlement IS money), and a gateway QR.
    await ringUp({ branchId: central, stationId: counter2, at: local(G, '13:00'), attempts: [{ method: 'qr', methodCode: 'promptpay', provider: 'ghl', deviceId: edc1.id, amountSatang: 120_00, status: 'awaiting_settlement' }] });
    const gwQr = await ringUp({ branchId: central, stationId: till1, at: local(G, '13:30'), attempts: [{ method: 'qr', methodCode: 'promptpay', provider: '2c2p', invoiceNo: `G1${Date.now()}`.slice(0, 20), amountSatang: 200_00 }] });
    // The gateway refused the refund; staff handed it back in cash: off CASH, not off QR.
    await refundRow(gwQr.saleId, 200_00, [
      { attemptId: gwQr.attemptIds[0]!, method: 'qr', methodCode: 'promptpay', provider: '2c2p', route: 'gateway_refund', amountSatang: 200_00, status: 'failed', fallback: 'cash' },
    ]);

    // Card on the branch terminal, whole sale voided on the terminal (done): off that TID.
    const voided = await ringUp({ branchId: central, stationId: till1, at: local(G, '14:00'), attempts: [{ method: 'card', methodCode: 'card', provider: 'ghl', deviceId: edc1.id, tid: edc1.tid, amountSatang: 800_00 }] });
    await refundRow(voided.saleId, 800_00, [
      { attemptId: voided.attemptIds[0]!, method: 'card', methodCode: 'card', provider: 'ghl', route: 'terminal_void', amountSatang: 800_00, status: 'done' },
    ]);
    // Card 150 with a partial refund of 50 handed back from the drawer (S2-11's route for a partial card).
    gCardPartial = await ringUp({ branchId: central, stationId: counter2, at: local(G, '14:30'), attempts: [{ method: 'card', methodCode: 'card', provider: 'ghl', deviceId: edc1.id, tid: edc1.tid, amountSatang: 150_00 }] });
    await refundRow(gCardPartial.saleId, 50_00, [
      { attemptId: gCardPartial.attemptIds[0]!, method: 'card', methodCode: 'card', provider: 'ghl', route: 'cash', amountSatang: 50_00, status: 'done' },
    ]);
    // A refused void with NO cash fallback moved no money: nothing comes off.
    const refused = await ringUp({ branchId: central, stationId: till1, at: local(G, '14:40'), attempts: [{ method: 'card', methodCode: 'card', provider: 'ghl', deviceId: edc1.id, tid: edc1.tid, amountSatang: 60_00 }] });
    await refundRow(refused.saleId, 60_00, [
      { attemptId: refused.attemptIds[0]!, method: 'card', methodCode: 'card', provider: 'ghl', route: 'terminal_void', amountSatang: 60_00, status: 'failed', fallback: null },
    ]);
    // Card keyed in with no TID: its own line, never dropped.
    await ringUp({ branchId: central, stationId: till1, at: local(G, '15:00'), attempts: [{ method: 'card', methodCode: 'card', amountSatang: 45_67 }] });

    // NOT the till's money.
    // - the booking site's own QR, with no station and no sale;
    await ctx.db.insert(schema.paymentAttempt).values({
      id: newId(), operatorId, branchId: central, saleId: null, stationId: null, businessDate: G,
      method: 'qr', methodCode: 'promptpay', provider: '2c2p', status: 'approved', amountSatang: 5_000_00,
      invoiceNo: `GW${Date.now()}`.slice(0, 20), paidAt: local(G, '09:00'),
    });
    // - a booking-site attempt carried onto a counter sale, refunded at the gateway: never on the lines, so never off them;
    const web = await ringUp({ branchId: central, stationId: till1, at: local(G, '15:10'), attempts: [{ method: 'qr', methodCode: 'promptpay', provider: '2c2p', stationId: null, invoiceNo: `GB${Date.now()}`.slice(0, 20), amountSatang: 700_00 }] });
    await refundRow(web.saleId, 700_00, [
      { attemptId: web.attemptIds[0]!, method: 'qr', methodCode: 'promptpay', provider: '2c2p', route: 'gateway_refund', amountSatang: 700_00, status: 'done' },
    ]);
    // - stored-value credit and the paid-online tender;
    await ringUp({ branchId: central, stationId: till1, at: local(G, '15:20'), attempts: [{ method: 'wallet', methodCode: 'wallet_credit', amountSatang: 300_00 }] });
    await ringUp({ branchId: central, stationId: till1, at: local(G, '15:30'), attempts: [{ method: 'transfer', methodCode: 'paid_online', amountSatang: 900_00 }] });
    // - every status that did not take money;
    await ringUp({ branchId: central, stationId: till1, at: local(G, '16:00'), attempts: ['created', 'sent_to_terminal', 'declined', 'cancelled', 'unknown', 'inquiring', 'not_found', 'awaiting_staff_confirmation'].map((status) => ({ method: 'cash' as const, methodCode: 'cash', amountSatang: 11_00, status })) });
    // - another branch's cash.
    await ringUp({ branchId: chalong, stationId: chalongTill, at: local(G, '11:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 999_00 }] });

    const res = await getDay(receptionCookie, G);
    expect(res.statusCode, res.body).toBe(200);
    const rec = res.json() as EndOfDayRecord;
    expect(rec.status).toBe('open');
    expect(expectedOf(rec)).toEqual({
      cash: 1_000_00 + 250_25 + 30_00 - 200_00 - 50_00,
      promptpay: 120_00 + 200_00,
      [`card:${edc1.tid}`]: 800_00 - 800_00 + 150_00 + 60_00,
      [`card:${NO_TERMINAL_TID}`]: 45_67,
      ewallet: 0,
      bank_transfer: 0,
      party_prepay: 0,
      credit: 0,
    });
    expect(rec.totalExpectedSatang).toBe(1_030_25 + 320_00 + 210_00 + 45_67);
  });

  it('a refund made now of an EARLIER day’s sale comes off that earlier day only', async () => {
    pSale = await ringUp({ branchId: central, stationId: till1, at: local(P, '15:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 400_00 }] });
    const beforeG = expectedOf((await getDay(receptionCookie, G)).json() as EndOfDayRecord);
    const beforeD = expectedOf((await getDay(receptionCookie, D)).json() as EndOfDayRecord);
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: managerId, operatorId, stationId: till1, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        pSale.saleId,
        { mode: 'custom', amountSatang: 100_00, reason: 'Left early', actionId: newId() },
      ),
    );
    expect(expectedOf((await getDay(receptionCookie, P)).json() as EndOfDayRecord).cash).toBe(300_00);
    expect(expectedOf((await getDay(receptionCookie, G)).json() as EndOfDayRecord)).toEqual(beforeG);
    expect(expectedOf((await getDay(receptionCookie, D)).json() as EndOfDayRecord)).toEqual(beforeD);
  });

  it('REPRO: an impossible calendar date is refused in the counter’s words, not a server error', async () => {
    const res = await getDay(receptionCookie, '2026-02-30');
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('That date is not on the calendar.');
    const close = await closeDay(managerCookie, { date: '2025-02-30', countedSatang: null, floatLeftSatang: null });
    expect(close.statusCode, close.body).toBe(400);
    expect(close.body).toContain('That date is not on the calendar.');
    const movements = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${central}/cash-movements?date=2026-04-31`,
      headers: { cookie: receptionCookie },
    });
    expect(movements.statusCode, movements.body).toBe(400);
    expect(movements.body).toContain('That date is not on the calendar.');
  });
});

// --- (3) THE CLOSE ------------------------------------------------------------------

describe('gate (3): the close', () => {
  let pClosed: EndOfDayRecord;
  let gClosed: EndOfDayRecord;

  it('a staff-role account (every role that opens Today) may close; float default; audited', async () => {
    const res = await closeDay(staffCookie, { date: P, countedSatang: 6_000_00 + 300_00, floatLeftSatang: 4_321_00 });
    expect(res.statusCode, res.body).toBe(200);
    pClosed = res.json() as EndOfDayRecord;
    expect(pClosed.closedBy!.accountId).toBe(staffId);
    expect(pClosed.cashCount.floatSatang).toBe(DEFAULT_FLOAT);
    expect(pClosed.floatFromDate).toBeNull();
    const audits = await ctx.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'end_of_day.close'), eq(schema.auditLog.entityId, pClosed.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorAccountId).toBe(staffId);
    expect(audits[0]!.branchId).toBe(central);
  });

  it('the server rebuilds expected and ignores the caller’s lines, totals, unknown channels and a cash actual', async () => {
    const open = (await getDay(receptionCookie, G)).json() as EndOfDayRecord;
    expect(open.cashCount.floatSatang).toBe(4_321_00);
    expect(open.floatFromDate).toBe(P);
    const res = await closeDay(
      receptionCookie,
      {
        date: G,
        countedSatang: 4_321_00 + 1_030_25,
        floatLeftSatang: null,
        actuals: [
          { channel: 'promptpay', actualSatang: 320_00 },
          { channel: 'cash', actualSatang: 1 },
          { channel: 'card:FAKE', actualSatang: 99_999_00 },
        ],
        lines: [{ channel: 'cash', expectedSatang: 1, actualSatang: 1, differenceSatang: 0 }],
        totalExpectedSatang: 1,
        closedBy: { accountId: managerId, name: 'Somebody else' },
      },
      'gate-close-g',
    );
    expect(res.statusCode, res.body).toBe(200);
    gClosed = res.json() as EndOfDayRecord;
    expect(gClosed.closedBy!.accountId).toBe(receptionId);
    expect(gClosed.lines.map((l) => l.channel)).toEqual(open.lines.map((l) => l.channel));
    expect(gClosed.lines.map((l) => l.expectedSatang)).toEqual(open.lines.map((l) => l.expectedSatang));
    expect(gClosed.lines.find((l) => l.channel === 'cash')).toMatchObject({ actualSatang: 1_030_25, differenceSatang: 0 });
    expect(gClosed.totalExpectedSatang).toBe(open.totalExpectedSatang);
    expect(gClosed.totalActualSatang).toBe(1_030_25 + 320_00);

    // Replay with the same key: the same answer, and one audit row.
    const replay = await closeDay(receptionCookie, { date: G, countedSatang: 4_321_00 + 1_030_25, floatLeftSatang: null, actuals: [{ channel: 'promptpay', actualSatang: 320_00 }, { channel: 'cash', actualSatang: 1 }, { channel: 'card:FAKE', actualSatang: 99_999_00 }], lines: [{ channel: 'cash', expectedSatang: 1, actualSatang: 1, differenceSatang: 0 }], totalExpectedSatang: 1, closedBy: { accountId: managerId, name: 'Somebody else' } }, 'gate-close-g');
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(res.body);
    const audits = await ctx.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'end_of_day.close'), eq(schema.auditLog.entityId, gClosed.id)));
    expect(audits).toHaveLength(1);
  });

  it('a second close is refused 409 DAY_CLOSED, whoever presses it', async () => {
    for (const cookie of [managerCookie, staffCookie]) {
      const res = await closeDay(cookie, { date: G, countedSatang: 1, floatLeftSatang: 1 });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DAY_CLOSED');
    }
  });

  it('a closed day reads back exactly as saved after later sales and refunds of its own sales', async () => {
    await ringUp({ branchId: central, stationId: till1, at: local(G, '19:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 42_00 }] });
    await refundRow(gCardPartial.saleId, 20_00, [
      { attemptId: null, method: 'cash', methodCode: null, provider: null, route: 'cash', amountSatang: 20_00, status: 'done' },
    ]);
    const after = (await getDay(receptionCookie, G)).json() as EndOfDayRecord;
    expect(after).toEqual(gClosed);
  });

  it('the float carries from the latest EARLIER close that left one; a close with none left is skipped', async () => {
    // G was closed with no float left, so the next day carries from P's 4,321.
    const next = (await getDay(receptionCookie, addDaysToIsoDate(G, 1))).json() as EndOfDayRecord;
    expect(next.cashCount.floatSatang).toBe(4_321_00);
    expect(next.floatFromDate).toBe(P);
    // A day before every close has the standard float.
    const early = (await getDay(receptionCookie, addDaysToIsoDate(P, -5))).json() as EndOfDayRecord;
    expect(early.cashCount.floatSatang).toBe(DEFAULT_FLOAT);
    expect(early.floatFromDate).toBeNull();
  });

  it('another branch’s manager can neither read nor close this branch; a foreign branch id is 403/404', async () => {
    expect((await getDay(chalongCookie, addDaysToIsoDate(G, 1))).statusCode).toBe(403);
    expect((await closeDay(chalongCookie, { date: addDaysToIsoDate(G, 1), countedSatang: null, floatLeftSatang: null })).statusCode).toBe(403);
    expect([403, 404]).toContain((await getDay(managerCookie, G, newId())).statusCode);
  });
});

// --- (4) THE PEOPLE -----------------------------------------------------------------

describe('gate (4): the second person, and the permissions on the server', () => {
  it('a staff-role account cannot record a paid-out or a safe drop', async () => {
    const res = await move(staffCookie, { kind: 'safe_drop', amountSatang: 100_00, reason: 'Drop', witnessAccountId: receptionId });
    expect(res.statusCode).toBe(403);
  });

  it('a paid-out approver must be somebody else, active, holding pos:cash:approve at THIS branch', async () => {
    const base = { kind: 'paid_out', amountSatang: 50_00, reason: 'Ice' };
    expect((await move(managerCookie, { ...base, approverAccountId: managerId })).json().error.code).toBe('SELF_APPROVAL');
    expect((await move(receptionCookie, { ...base, approverAccountId: staffId })).json().error.code).toBe('APPROVER_NOT_ALLOWED');
    expect((await move(receptionCookie, { ...base, approverAccountId: inactiveManagerId })).json().error.code).toBe('APPROVER_NOT_ALLOWED');
    expect((await move(receptionCookie, { ...base, approverAccountId: chalongManagerId })).json().error.code).toBe('APPROVER_NOT_ALLOWED');
    expect((await move(receptionCookie, { ...base, witnessAccountId: managerId })).statusCode).toBe(400);
    const ok = await move(receptionCookie, { ...base, approverAccountId: managerId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().movement.businessDate).toBe(D);
  });

  it('a safe-drop witness must be somebody else who works at THIS branch', async () => {
    const base = { kind: 'safe_drop', amountSatang: 70_00, reason: 'Drop' };
    expect((await move(receptionCookie, { ...base, witnessAccountId: receptionId })).json().error.code).toBe('SELF_WITNESS');
    expect((await move(receptionCookie, { ...base, witnessAccountId: chalongManagerId })).json().error.code).toBe('WITNESS_NOT_ALLOWED');
    expect((await move(receptionCookie, { ...base, witnessAccountId: inactiveManagerId })).json().error.code).toBe('WITNESS_NOT_ALLOWED');
    expect((await move(receptionCookie, { ...base, approverAccountId: managerId })).statusCode).toBe(400);
    const ok = await move(receptionCookie, { ...base, witnessAccountId: staffId });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('a Chalong manager cannot record against Central, and the database refuses an actor as their own second person', async () => {
    const res = await move(chalongCookie, { kind: 'safe_drop', amountSatang: 10_00, reason: 'x', witnessAccountId: managerId });
    expect(res.statusCode).toBe(403);
    await expect(
      ctx.db.insert(schema.cashMovement).values({
        id: newId(), operatorId, branchId: central, businessDate: D, kind: 'paid_out', amountSatang: 1, reason: 'x',
        actorAccountId: managerId, approverAccountId: managerId, actionId: newId(),
      }),
    ).rejects.toThrow();
  });

  it('today’s movements are taken off today’s expected cash, and only today’s', async () => {
    const today = (await getDay(receptionCookie, D)).json() as EndOfDayRecord;
    expect(today.cashMovements.map((m) => [m.kind, m.amountSatang])).toEqual([['paid_out', 50_00], ['safe_drop', 70_00]]);
    expect(expectedOf(today).cash).toBe(-(50_00 + 70_00));
    const g = (await getDay(receptionCookie, G)).json() as EndOfDayRecord;
    expect(g.cashMovements).toEqual([]);
  });
});
