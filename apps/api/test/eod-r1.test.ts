import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@oto/db';
import { seedDemoDay } from '@oto/db/seed';
import {
  DEFAULT_FLOAT,
  addDaysToIsoDate,
  businessDate,
  newId,
  recomputeEndOfDay,
  type EndOfDayRecord,
  type RefundAllocationEntry,
} from '@oto/shared';
import {
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  OTO_OPERATOR_NAME,
  type TestContext,
} from './helpers';
import { refundSale } from '../src/services/refunds';
import { channelOfRefundSlice, expectedLinesOf, NO_TERMINAL_TID } from '../src/services/end-of-day';
import { resetDemoData } from '../src/services/demo-reset';

/**
 * S2-15a round 1 — the End of Day on real data (plan
 * docs/progress/plans/cash/PLAN.md, revised 2 Oct): ONE combined cash count
 * for the whole branch per business day, the prototype's rules ported.
 *
 * A scripted day across TWO stations of Central Floresta, every figure summed
 * by hand below, then the close, the float carried to the next day, the
 * refund of an earlier day's sale, the second person on a paid-out or a safe
 * drop, and the replays.
 */

const TZ = 'Asia/Bangkok';
const DAY_START = 5 * 60;

let ctx: TestContext;
let operatorId: string;
let central: string;
let chalong: string;
let till1: string;
let counter2: string;
let chalongTill: string;
let edc1: { id: string; tid: string; boxId: string };
let edc2: { id: string; tid: string };
let receptionId: string;
let reception2Id: string;
let managerId: string;
let chalongManagerId: string;
let receptionCookie: string;
let managerCookie: string;
let chalongCookie: string;

/** Today's business day at Central Floresta, and the one before. */
const D = businessDate(new Date(), TZ, DAY_START);
const Y = addDaysToIsoDate(D, -1);

let receiptSeq = 0;

async function accountIdOf(phone: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: schema.account.id })
    .from(schema.account)
    .where(and(eq(schema.account.operatorId, operatorId), eq(schema.account.phone, phone)))
    .limit(1);
  if (!row) throw new Error(`no account ${phone}`);
  return row.id;
}

async function stationOf(branchId: string, name: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: schema.station.id })
    .from(schema.station)
    .where(and(eq(schema.station.branchId, branchId), eq(schema.station.name, name)))
    .limit(1);
  if (!row) throw new Error(`no station ${name}`);
  return row.id;
}

interface AttemptSpec {
  method: 'cash' | 'card' | 'qr' | 'wallet' | 'voucher' | 'transfer';
  methodCode: string;
  amountSatang: number;
  status?: string;
  provider?: 'manual' | 'ghl' | '2c2p' | 'simulator';
  deviceId?: string | null;
  tid?: string | null;
  stationId?: string | null;
  invoiceNo?: string | null;
}

/** A finalised sale and its attempts, dated by the platform's own `businessDate`. */
async function ringUp(opts: {
  branchId: string;
  stationId: string;
  at: Date;
  attempts: AttemptSpec[];
}): Promise<{ saleId: string; attemptIds: string[]; businessDate: string }> {
  const day = businessDate(opts.at, TZ, DAY_START);
  const gross = opts.attempts.reduce((s, a) => s + a.amountSatang, 0);
  const saleId = newId();
  receiptSeq += 1;
  await ctx.db.insert(schema.sale).values({
    id: saleId,
    operatorId,
    branchId: opts.branchId,
    stationId: opts.stationId,
    businessDate: day,
    businessDayStart: '05:00',
    timezone: TZ,
    occurredAt: opts.at,
    createdByAccountId: receptionId,
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    customerTier: 'tourist',
    engineVersion: 'eod-r1-test',
    taxConfig: {},
    taxBreakdown: {},
    subtotalSatang: gross,
    netSatang: gross,
    grossSatang: gross,
    receiptSeries: 'EODT',
    receiptSeq,
    receiptNumber: `EODT-${receiptSeq}`,
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

/** A wall-clock instant in Bangkok. */
const bkk = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);

async function getDay(cookie: string, date: string, branchId = central) {
  return ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/end-of-day?date=${date}`, headers: { cookie } });
}

const lineOf = (rec: EndOfDayRecord, channel: string) => rec.lines.find((l) => l.channel === channel);

beforeAll(async () => {
  ctx = await createTestContext();
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  till1 = await stationOf(central, 'Reception Till 1');
  counter2 = await stationOf(central, 'Counter 2');
  chalongTill = await stationOf(chalong, 'Reception Till 1');

  const [card] = await ctx.db
    .select({ id: schema.device.id, tid: schema.device.terminalId, boxId: schema.device.boxId })
    .from(schema.device)
    .where(and(eq(schema.device.branchId, central), eq(schema.device.terminalId, '65703235')))
    .limit(1);
  edc1 = { id: card!.id, tid: card!.tid!, boxId: card!.boxId };
  // A second card terminal at the branch, so two TIDs reconcile apart.
  const edc2Id = newId();
  await ctx.db.insert(schema.device).values({
    id: edc2Id,
    operatorId,
    branchId: central,
    boxId: edc1.boxId,
    kind: 'terminal',
    label: 'EDC 2',
    transport: 'simulated',
    model: 'NEXGO N5',
    protocol: 'ghl_linkpos',
    terminalId: '65703299',
    merchantId: '4648434010',
  });
  edc2 = { id: edc2Id, tid: '65703299' };

  receptionId = await accountIdOf(RECEPTION.phone);
  managerId = await accountIdOf(BRANCH_MANAGER.phone);
  chalongManagerId = await accountIdOf(CHALONG_MANAGER.phone);
  // A second member of reception at Central, to witness a safe drop.
  reception2Id = newId();
  await ctx.db.insert(schema.account).values({
    id: reception2Id,
    operatorId,
    phone: '+66900000077',
    status: 'active',
  });
  const [receptionRole] = await ctx.db
    .select({ id: schema.role.id })
    .from(schema.role)
    .where(and(eq(schema.role.name, 'reception'), isNull(schema.role.operatorId)))
    .limit(1);
  await ctx.db.insert(schema.roleAssignment).values({
    id: newId(),
    accountId: reception2Id,
    roleId: receptionRole!.id,
    scopeType: 'branch',
    scopeId: central,
  });

  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongCookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  await takeStation(ctx.app, receptionCookie, till1);
  await takeStation(ctx.app, managerCookie, till1);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// --- The yesterday the refunds and the float are about -----------------------------

let ySaleA: { saleId: string };
let ySaleB: { saleId: string };
let yClosed: EndOfDayRecord;

describe('yesterday: default float, a refund of its sale made today, the close by reception', () => {
  it('an open day with no earlier close carries the standard float', async () => {
    ySaleA = await ringUp({ branchId: central, stationId: till1, at: bkk(Y, '11:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 1_000_00 }] });
    ySaleB = await ringUp({ branchId: central, stationId: counter2, at: bkk(Y, '15:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 400_00 }] });
    const res = await getDay(receptionCookie, Y);
    expect(res.statusCode, res.body).toBe(200);
    const rec = res.json() as EndOfDayRecord;
    expect(rec.status).toBe('open');
    expect(rec.cashCount.floatSatang).toBe(DEFAULT_FLOAT);
    expect(rec.floatFromDate).toBeNull();
    expect(rec.floatLeftSatang).toBe(DEFAULT_FLOAT);
    expect(lineOf(rec, 'cash')!.expectedSatang).toBe(1_400_00);
  });

  it('a refund made today of yesterday’s sale comes off YESTERDAY', async () => {
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: managerId, operatorId, stationId: till1, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        ySaleA.saleId,
        { mode: 'custom', amountSatang: 250_00, reason: 'Left early', actionId: newId() },
      ),
    );
    const rec = (await getDay(receptionCookie, Y)).json() as EndOfDayRecord;
    expect(lineOf(rec, 'cash')!.expectedSatang).toBe(1_400_00 - 250_00);
  });

  it('reception closes the day: the server recomputes, stamps who and when, and audits it', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/close`,
      headers: { cookie: receptionCookie },
      payload: { date: Y, countedSatang: 6_000_00 + 1_150_00, floatLeftSatang: 5_000_00, actuals: [], vouchers: { handedOut: 3, redeemed: 1 } },
    });
    expect(res.statusCode, res.body).toBe(200);
    yClosed = res.json() as EndOfDayRecord;
    expect(yClosed.status).toBe('closed');
    expect(yClosed.closedBy!.accountId).toBe(receptionId);
    expect(yClosed.closedAt).not.toBeNull();
    expect(yClosed.cashCount.cashIncomeSatang).toBe(1_150_00);
    expect(lineOf(yClosed, 'cash')).toMatchObject({ expectedSatang: 1_150_00, actualSatang: 1_150_00, differenceSatang: 0 });
    // Closed with every other line pending and no notes, as the prototype allows.
    expect(lineOf(yClosed, 'promptpay')!.actualSatang).toBeNull();
    expect(yClosed.notes).toBeNull();
    expect(yClosed.vouchers).toEqual({ handedOut: 3, redeemed: 1 });
    const audit = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'end_of_day.close'), eq(schema.auditLog.entityId, yClosed.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorAccountId).toBe(receptionId);
  });

  it('a refund of a closed day’s sale changes nothing on the closed day', async () => {
    await ctx.db.transaction((tx) =>
      refundSale(
        tx,
        { accountId: managerId, operatorId, stationId: till1, assertBranchAllowed: async () => {}, assertCanApprove: async () => {} },
        ySaleB.saleId,
        { mode: 'whole', reason: 'Wrong ticket', actionId: newId() },
      ),
    );
    const after = (await getDay(receptionCookie, Y)).json() as EndOfDayRecord;
    expect(after).toEqual(yClosed);
  });
});

// --- Today: the scripted day ---------------------------------------------------------

describe('today: a scripted day across two stations, summed by hand', () => {
  it('builds the expected lines from this branch’s money on this business date only', async () => {
    // Cash at both stations.
    await ringUp({ branchId: central, stationId: till1, at: bkk(D, '10:15'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 1_500_00 }] });
    await ringUp({ branchId: central, stationId: counter2, at: bkk(D, '12:40'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 820_50 }] });
    // 06:30 in Bangkok is 23:30 UTC the day before: the business day, not the UTC one.
    const early = await ringUp({ branchId: central, stationId: till1, at: bkk(D, '06:30'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 60_00 }] });
    expect(early.businessDate).toBe(D);
    expect(bkk(D, '06:30').toISOString().slice(0, 10)).toBe(Y);
    // 01:30 the next calendar morning is still this trading day (day start 05:00).
    const late = await ringUp({ branchId: central, stationId: counter2, at: bkk(addDaysToIsoDate(D, 1), '01:30'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 100_00 }] });
    expect(late.businessDate).toBe(D);
    // QR.
    await ringUp({ branchId: central, stationId: counter2, at: bkk(D, '13:00'), attempts: [{ method: 'qr', methodCode: 'promptpay', provider: '2c2p', invoiceNo: `EODQR${Date.now()}`.slice(0, 20), amountSatang: 450_00 }] });
    // Card on two TIDs, and one keyed in with no TID.
    await ringUp({ branchId: central, stationId: till1, at: bkk(D, '14:00'), attempts: [{ method: 'card', methodCode: 'card', provider: 'ghl', deviceId: edc1.id, tid: edc1.tid, amountSatang: 1_200_00 }] });
    await ringUp({ branchId: central, stationId: counter2, at: bkk(D, '14:10'), attempts: [{ method: 'card', methodCode: 'card', provider: 'ghl', deviceId: edc2.id, tid: edc2.tid, amountSatang: 300_00 }] });
    const toVoid = await ringUp({ branchId: central, stationId: counter2, at: bkk(D, '14:20'), attempts: [{ method: 'card', methodCode: 'card', provider: 'ghl', deviceId: edc2.id, tid: edc2.tid, amountSatang: 180_00 }] });
    await ringUp({ branchId: central, stationId: till1, at: bkk(D, '14:30'), attempts: [{ method: 'card', methodCode: 'card', amountSatang: 99_99 }] });
    // NOT the till's: a booking-site attempt with no station, stored-value credit, paid online.
    await ctx.db.insert(schema.paymentAttempt).values({
      id: newId(), operatorId, branchId: central, saleId: null, stationId: null, businessDate: D,
      method: 'qr', methodCode: 'promptpay', provider: '2c2p', status: 'approved', amountSatang: 5_000_00,
      invoiceNo: `WEB${Date.now()}`.slice(0, 20), paidAt: bkk(D, '09:00'),
    });
    const credit = await ringUp({ branchId: central, stationId: till1, at: bkk(D, '15:00'), attempts: [{ method: 'wallet', methodCode: 'wallet_credit', amountSatang: 200_00 }] });
    await ringUp({ branchId: central, stationId: till1, at: bkk(D, '15:30'), attempts: [{ method: 'transfer', methodCode: 'paid_online', amountSatang: 2_500_00 }] });
    // Took nothing: a declined and a cancelled (voided) attempt.
    await ringUp({ branchId: central, stationId: till1, at: bkk(D, '16:00'), attempts: [
      { method: 'card', methodCode: 'card', provider: 'ghl', deviceId: edc1.id, tid: edc1.tid, amountSatang: 777_00, status: 'declined' },
      { method: 'cash', methodCode: 'cash', amountSatang: 333_00, status: 'cancelled' },
      { method: 'cash', methodCode: 'cash', amountSatang: 50_00 },
    ] });
    // Another branch's cash.
    await ringUp({ branchId: chalong, stationId: chalongTill, at: bkk(D, '11:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 999_00 }] });

    // A card refunded today by a void on the terminal (pending is still money going back).
    const allocation: RefundAllocationEntry[] = [
      { attemptId: toVoid.attemptIds[0]!, method: 'card', methodCode: 'card', provider: 'ghl', route: 'terminal_void', amountSatang: 180_00, status: 'pending' },
    ];
    await ctx.db.insert(schema.refund).values({
      id: newId(), operatorId, branchId: central, saleId: toVoid.saleId, stationId: counter2, number: 'EODT-R-1',
      amountSatang: 180_00, mode: 'whole', reason: 'Duplicate charge', approvedByAccountId: managerId,
      createdByAccountId: managerId, tenderAllocation: allocation,
    });

    // Credit: 200 redeemed at the F&B counter, 50 put back by a refund.
    const walletId = newId();
    await ctx.db.insert(schema.wallet).values({ id: walletId, operatorId, branchId: central, balanceSatang: 350_00 });
    await ctx.db.insert(schema.walletEntry).values([
      { id: newId(), walletId, operatorId, actionId: `eod-grant-${walletId}`, amountSatang: 500_00, kind: 'grant', source: 'ticket_sale', branchId: central, businessDate: D, balanceAfter: 500_00 },
      { id: newId(), walletId, operatorId, actionId: `eod-spend-${walletId}`, amountSatang: -200_00, kind: 'spend', source: 'fnb_order', paymentAttemptId: credit.attemptIds[0]!, branchId: central, businessDate: D, balanceAfter: 300_00 },
      { id: newId(), walletId, operatorId, actionId: `eod-restore-${walletId}`, amountSatang: 50_00, kind: 'refund', source: 'refund', paymentAttemptId: credit.attemptIds[0]!, branchId: central, businessDate: D, balanceAfter: 350_00 },
    ]);

    const res = await getDay(receptionCookie, D);
    expect(res.statusCode, res.body).toBe(200);
    const rec = res.json() as EndOfDayRecord;
    expect(rec.status).toBe('open');
    expect(rec.lines.map((l) => l.channel)).toEqual([
      'cash',
      'promptpay',
      `card:${edc1.tid}`,
      `card:${edc2.tid}`,
      `card:${NO_TERMINAL_TID}`,
      'ewallet',
      'bank_transfer',
      'party_prepay',
      'credit',
    ]);
    const expected = Object.fromEntries(rec.lines.map((l) => [l.channel, l.expectedSatang]));
    expect(expected).toEqual({
      cash: 1_500_00 + 820_50 + 60_00 + 100_00 + 50_00,
      promptpay: 450_00,
      [`card:${edc1.tid}`]: 1_200_00,
      [`card:${edc2.tid}`]: 300_00 + 180_00 - 180_00,
      [`card:${NO_TERMINAL_TID}`]: 99_99,
      ewallet: 0,
      bank_transfer: 0,
      party_prepay: 0,
      credit: 200_00 - 50_00,
    });
    expect(rec.totalExpectedSatang).toBe(Object.values(expected).reduce((a, b) => a + b, 0));
    expect(rec.terminals).toEqual(expect.arrayContaining([{ tid: edc1.tid, label: 'EDC 1' }, { tid: edc2.tid, label: 'EDC 2' }]));
    // Yesterday's refunds stayed on yesterday.
    expect(rec.cashMovements).toEqual([]);
  });
});

// --- The second person ---------------------------------------------------------------

const move = (cookie: string, payload: Record<string, unknown>, key?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/branches/${central}/cash-movements`,
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  });

describe('paid-outs and safe drops: the second person', () => {
  it('lists the branch’s people and who can approve', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/branches/${central}/cash-movements`, headers: { cookie: receptionCookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { businessDate: string; people: { accountId: string; canApprove: boolean }[] };
    expect(body.businessDate).toBe(D);
    const byId = new Map(body.people.map((p) => [p.accountId, p]));
    expect(byId.get(managerId)?.canApprove).toBe(true);
    expect(byId.get(receptionId)?.canApprove).toBe(false);
    expect(byId.get(reception2Id)?.canApprove).toBe(false);
    expect(byId.has(chalongManagerId)).toBe(false);
  });

  it('a paid-out needs an approver, never oneself, and one holding pos:cash:approve here', async () => {
    const base = { kind: 'paid_out', amountSatang: 300_00, reason: 'Ice from the shop next door' };
    const none = await move(receptionCookie, base);
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe('APPROVER_REQUIRED');
    const self = await move(managerCookie, { ...base, approverAccountId: managerId });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('SELF_APPROVAL');
    const noRight = await move(receptionCookie, { ...base, approverAccountId: reception2Id });
    expect(noRight.statusCode).toBe(403);
    expect(noRight.json().error.code).toBe('APPROVER_NOT_ALLOWED');
    const otherPark = await move(receptionCookie, { ...base, approverAccountId: chalongManagerId });
    expect(otherPark.statusCode).toBe(403);
    expect(otherPark.json().error.code).toBe('APPROVER_NOT_ALLOWED');
  });

  it('a safe drop needs a witness who is somebody else at the branch', async () => {
    const base = { kind: 'safe_drop', amountSatang: 1_000_00, reason: 'Midday drop' };
    expect((await move(receptionCookie, base)).json().error.code).toBe('WITNESS_REQUIRED');
    const self = await move(receptionCookie, { ...base, witnessAccountId: receptionId });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('SELF_WITNESS');
    const stranger = await move(receptionCookie, { ...base, witnessAccountId: chalongManagerId });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error.code).toBe('WITNESS_NOT_ALLOWED');
  });

  it('records both, audited, replayed once by action id and by idempotency key, and takes them off the expected cash', async () => {
    const paidOut = { kind: 'paid_out', amountSatang: 300_00, reason: 'Ice from the shop next door', approverAccountId: managerId, actionId: 'eod-po-1' };
    const first = await move(receptionCookie, paidOut, 'eod-po-key');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().replayed).toBe(false);
    const again = await move(receptionCookie, paidOut, 'eod-po-key');
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe(first.body);
    const mismatch = await move(receptionCookie, { ...paidOut, amountSatang: 301_00 }, 'eod-po-key');
    expect(mismatch.statusCode).toBe(409);
    // The same press without the key: the action id answers what it recorded.
    const pressAgain = await move(receptionCookie, paidOut);
    expect(pressAgain.statusCode).toBe(200);
    expect(pressAgain.json().replayed).toBe(true);
    expect(pressAgain.json().movement.id).toBe(first.json().movement.id);

    const drop = await move(receptionCookie, { kind: 'safe_drop', amountSatang: 1_000_00, reason: 'Midday drop', witnessAccountId: reception2Id, actionId: 'eod-sd-1' });
    expect(drop.statusCode, drop.body).toBe(200);
    expect(drop.json().movement.witness.accountId).toBe(reception2Id);

    const rows = await ctx.db.select().from(schema.cashMovement).where(eq(schema.cashMovement.branchId, central));
    expect(rows).toHaveLength(2);
    const audits = await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.entityType, 'cash_movement'));
    expect(audits.map((a) => a.action).sort()).toEqual(['cash_movement.paid_out', 'cash_movement.safe_drop']);

    const rec = (await getDay(receptionCookie, D)).json() as EndOfDayRecord;
    expect(lineOf(rec, 'cash')!.expectedSatang).toBe(1_500_00 + 820_50 + 60_00 + 100_00 + 50_00 - 300_00 - 1_000_00);
    expect(rec.cashMovements.map((m) => m.kind)).toEqual(['paid_out', 'safe_drop']);
  });
});

// --- Closing today ---------------------------------------------------------------------

describe('closing today', () => {
  let closed: EndOfDayRecord;

  it('carries the float from yesterday’s close', async () => {
    const rec = (await getDay(managerCookie, D)).json() as EndOfDayRecord;
    expect(rec.cashCount.floatSatang).toBe(5_000_00);
    expect(rec.floatFromDate).toBe(Y);
  });

  it('the till’s recompute matches the server; a tampered expected is ignored; the key replays', async () => {
    const open = (await getDay(managerCookie, D)).json() as EndOfDayRecord;
    const cashExpected = lineOf(open, 'cash')!.expectedSatang;
    const entries = {
      date: D,
      countedSatang: 5_000_00 + cashExpected + 20_00,
      floatLeftSatang: 6_000_00,
      actuals: [
        { channel: 'promptpay', actualSatang: 450_00 },
        { channel: `card:${edc1.tid}`, actualSatang: 1_200_00 },
        { channel: `card:${edc2.tid}`, actualSatang: 250_00 },
        { channel: 'cash', actualSatang: 1 },
      ],
      vouchers: { handedOut: 10, redeemed: 4 },
      notes: '  ฿50 short on EDC 2 — voided twice  ',
      // Tampering: none of this is read.
      lines: open.lines.map((l) => ({ ...l, expectedSatang: 1 })),
      totalExpectedSatang: 1,
    };
    // What the till shows before it presses Close Day, with the shared recompute.
    const tillView = recomputeEndOfDay({
      ...open,
      lines: open.lines.map((l) => {
        const a = entries.actuals.find((x) => x.channel === l.channel && l.channel !== 'cash');
        return a ? { ...l, actualSatang: a.actualSatang } : l;
      }),
      cashCount: { ...open.cashCount, countedSatang: entries.countedSatang },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/close`,
      headers: { cookie: managerCookie, 'idempotency-key': 'eod-close-d' },
      payload: entries,
    });
    expect(res.statusCode, res.body).toBe(200);
    closed = res.json() as EndOfDayRecord;
    expect(closed.lines.map((l) => l.expectedSatang)).toEqual(open.lines.map((l) => l.expectedSatang));
    expect(closed.lines).toEqual(tillView.lines);
    expect(closed.totalExpectedSatang).toBe(tillView.totalExpectedSatang);
    expect(closed.totalActualSatang).toBe(tillView.totalActualSatang);
    expect(closed.totalDifferenceSatang).toBe(tillView.totalDifferenceSatang);
    expect(lineOf(closed, 'cash')).toMatchObject({ actualSatang: cashExpected + 20_00, differenceSatang: 20_00 });
    expect(closed.notes).toBe('฿50 short on EDC 2 — voided twice');
    expect(closed.floatLeftSatang).toBe(6_000_00);

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/close`,
      headers: { cookie: managerCookie, 'idempotency-key': 'eod-close-d' },
      payload: entries,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(res.body);
    const mismatch = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/close`,
      headers: { cookie: managerCookie, 'idempotency-key': 'eod-close-d' },
      payload: { ...entries, countedSatang: 1 },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('a second close is refused in the counter’s words', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/close`,
      headers: { cookie: receptionCookie },
      payload: { date: D, countedSatang: null, floatLeftSatang: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'DAY_CLOSED', message: 'This day is already closed.' });
  });

  it('the closed day is frozen: later sales, refunds and movements change nothing on it', async () => {
    await ringUp({ branchId: central, stationId: till1, at: bkk(D, '19:00'), attempts: [{ method: 'cash', methodCode: 'cash', amountSatang: 42_00 }] });
    const late = await move(receptionCookie, { kind: 'safe_drop', amountSatang: 100_00, reason: 'After close', witnessAccountId: reception2Id });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('DAY_CLOSED');
    const after = (await getDay(receptionCookie, D)).json() as EndOfDayRecord;
    expect(after).toEqual(closed);
    // The database refuses an edit as well.
    await expect(
      ctx.db.update(schema.endOfDay).set({ notes: 'rewritten' }).where(eq(schema.endOfDay.id, closed.id)),
    ).rejects.toThrow();
  });

  it('refuses a day that has not started, and a branch outside the caller’s scope', async () => {
    const future = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/close`,
      headers: { cookie: managerCookie },
      payload: { date: addDaysToIsoDate(D, 2), countedSatang: null, floatLeftSatang: null },
    });
    expect(future.statusCode).toBe(400);
    expect((await getDay(chalongCookie, D)).statusCode).toBe(403);
    // Chalong's own day never saw Central's money.
    const theirs = (await getDay(chalongCookie, D, chalong)).json() as EndOfDayRecord;
    expect(lineOf(theirs, 'cash')!.expectedSatang).toBe(999_00);
  });
});

// --- Pure: the lines builder ----------------------------------------------------------

describe('expectedLinesOf and channelOfRefundSlice', () => {
  it('a method line per other kind of tender that took money; an unknown TID keeps its money', () => {
    const lines = expectedLinesOf({
      attempts: [
        { id: 'a', method: 'voucher', methodCode: 'gift', stationId: 's', tid: null, amountSatang: 70_00 },
        { id: 'b', method: 'card', methodCode: 'card', stationId: 's', tid: 'OLD-TID', amountSatang: 10_00 },
        { id: 'c', method: 'other', methodCode: 'partner_token', stationId: 's', tid: null, amountSatang: 30_00 },
      ],
      refundSlices: [],
      terminals: [{ tid: 'T1', label: 'EDC 1' }],
      creditSatang: 0,
      movementsSatang: 0,
    });
    expect(lines.map((l) => [l.channel, l.expectedSatang])).toEqual([
      ['cash', 0],
      ['promptpay', 0],
      ['card:T1', 0],
      ['card:OLD-TID', 10_00],
      ['method:gift', 70_00],
      ['method:partner_token', 30_00],
      ['ewallet', 0],
      ['bank_transfer', 0],
      ['party_prepay', 0],
      ['credit', 0],
    ]);
  });

  it('a refused reversal handed back in cash comes off cash; credit put back is the credit line’s', () => {
    const card = { id: 'c', method: 'card', methodCode: 'card', stationId: 's', tid: 'T1', amountSatang: 100_00 };
    const slice = { method: 'card', methodCode: 'card' };
    expect(channelOfRefundSlice({ ...slice, route: 'terminal_void', status: 'failed', fallback: 'cash' }, card, true)).toBe('cash');
    expect(channelOfRefundSlice({ ...slice, route: 'terminal_void', status: 'done', fallback: null }, card, true)).toBe('card:T1');
    expect(channelOfRefundSlice({ ...slice, route: 'wallet', status: 'done', fallback: null }, null, true)).toBeNull();
    expect(channelOfRefundSlice({ method: 'cash', methodCode: null, route: 'cash', status: 'done', fallback: null }, null, true)).toBe('cash');
    expect(channelOfRefundSlice({ method: 'other', methodCode: 'partner_token', route: 'manual', status: 'done', fallback: null }, null, true)).toBe('method:partner_token');
    // A paid-online tender was never on the till's lines, so its refund is not taken off them.
    expect(channelOfRefundSlice({ method: 'transfer', methodCode: 'paid_online', route: 'manual', status: 'done', fallback: null }, { ...card, method: 'transfer', methodCode: 'paid_online', tid: null }, false)).toBeNull();
  });
});

// --- The demo reset --------------------------------------------------------------------

describe('seed:demo-day End of Day fixture', () => {
  it('seeds each tender and a real voucher, wallet spend and cash refund once on an isolated day', async () => {
    const date = addDaysToIsoDate(D, -7);
    const first = await Promise.all([seedDemoDay(ctx.db, { on: date }), seedDemoDay(ctx.db, { on: date })]);
    expect(first.reduce((sum, run) => sum + run.sales, 0)).toBe(11);
    const second = await seedDemoDay(ctx.db, { on: date });
    expect(second).toMatchObject({ sales: 0, attempts: 0, skipped: 11 });

    const attempts = await ctx.db.select().from(schema.paymentAttempt)
      .where(and(eq(schema.paymentAttempt.branchId, central), eq(schema.paymentAttempt.businessDate, date)));
    const taken = attempts.filter((a) => a.status === 'approved' || a.status === 'awaiting_settlement');
    const walletAttempt = taken.find((a) => a.method === 'wallet');
    expect(walletAttempt).toMatchObject({ methodCode: 'wallet_credit', stationId: till1 });
    const entries = await ctx.db.select().from(schema.walletEntry)
      .where(and(eq(schema.walletEntry.branchId, central), eq(schema.walletEntry.businessDate, date)));
    expect(entries.map((e) => [e.kind, e.source])).toEqual([
      ['grant', 'ticket_sale'], ['spend', 'merch_order'],
    ]);
    expect(entries[1]?.paymentAttemptId).toBe(walletAttempt?.id);
    const [wallet] = await ctx.db.select().from(schema.wallet).where(eq(schema.wallet.id, entries[0]!.walletId));
    expect(wallet?.balanceSatang).toBe(entries.reduce((sum, e) => sum + e.amountSatang, 0));

    const [voucherSale] = await ctx.db.select().from(schema.sale)
      .where(eq(schema.sale.actionId, `demo-day/${date}/voucher-discount`));
    expect(voucherSale).toMatchObject({ promoDiscountSatang: 10_000, manualDiscountSatang: 0 });
    const [voucher] = await ctx.db.select({ id: schema.voucher.id, status: schema.voucher.status })
      .from(schema.voucher).where(eq(schema.voucher.saleId, voucherSale!.id));
    expect(voucher?.status).toBe('redeemed');
    const consumed = await ctx.db.select().from(schema.voucherRedemption)
      .where(and(eq(schema.voucherRedemption.voucherId, voucher!.id), eq(schema.voucherRedemption.kind, 'consumed')));
    expect(consumed).toHaveLength(1);

    const [cashRefund] = await ctx.db.select().from(schema.refund)
      .where(eq(schema.refund.actionId, `demo-day/${date}/open-cash/refund`));
    expect(cashRefund).toMatchObject({ amountSatang: 10_000, mode: 'custom' });
    expect(cashRefund?.tenderAllocation).toMatchObject([{ method: 'cash', route: 'cash', status: 'done' }]);

    const response = await getDay(managerCookie, date);
    expect(response.statusCode, response.body).toBe(200);
    const day = response.json() as EndOfDayRecord;
    const cashTaken = taken.filter((a) => a.method === 'cash').reduce((sum, a) => sum + a.amountSatang, 0);
    expect(lineOf(day, 'cash')?.expectedSatang).toBe(cashTaken - 10_000);
    expect(lineOf(day, 'credit')?.expectedSatang).toBe(-entries[1]!.amountSatang);
    expect(lineOf(day, 'promptpay')?.expectedSatang).toBe(taken.filter((a) => a.method === 'qr')
      .reduce((sum, a) => sum + a.amountSatang, 0));
    expect(new Set(taken.filter((a) => a.method === 'card').map((a) => a.tid)).size).toBe(2);
    expect(taken.filter((a) => a.method === 'card').every((a) => a.tid !== null)).toBe(true);
    for (const tid of new Set(taken.filter((a) => a.method === 'card').map((a) => a.tid))) {
      expect(lineOf(day, `card:${tid ?? NO_TERMINAL_TID}`)?.expectedSatang).toBe(taken.filter((a) => a.method === 'card' && a.tid === tid)
        .reduce((sum, a) => sum + a.amountSatang, 0));
    }
  });
});

// --- The demo reset --------------------------------------------------------------------

describe('demo reset', () => {
  it('clears the closed days and the cash movements with the rest of a day of play', async () => {
    const counts = await resetDemoData(ctx.db);
    expect(counts.end_of_day).toBe(2);
    expect(counts.cash_movement).toBe(2);
    expect(await ctx.db.select().from(schema.endOfDay)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.cashMovement)).toHaveLength(0);
    // The reset retains redeemed voucher history; a fresh demo on the same
    // business date must use a new voucher sale identity and still seed cleanly.
    expect((await seedDemoDay(ctx.db, { on: addDaysToIsoDate(D, -7) })).sales).toBe(11);
  });
});
