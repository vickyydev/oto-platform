import { createHash } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account, auditLog, booking, branch, dailySummary, endOfDay, factWalletLiabilityDaily, operator, partyPayment,
  paymentAttempt, receiptSeries, refund, role, roleAssignment, rolePermission, sale, settlementBatch,
  settlementLine, station, wallet, walletEntry,
} from '@oto/db';
import { newId } from '@oto/shared';
import { getEndOfDay } from '../src/services/end-of-day';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-647 — Money oversight. Every integrity check is proved by a fixture
 * that CREATES its failure at one park (`fault`) and a clean park whose same
 * shapes must produce no row; the page's sections are proved against the
 * services they compose; and every read is proved to write its audit row and
 * nothing else.
 */

let ctx: TestContext;
let cookie: string;
let actorId: string, own: string, foreign: string;
let fault: string, clean: string, foreignPark: string;
let readRole: string, investigateRole: string;
let faultTill: string, faultTill2: string, cleanTill: string;
const D1 = '2026-10-01';
const D2 = '2026-10-02';
const at = new Date('2026-10-01T06:00:00.000Z');
const ids: Record<string, string> = {};

type Grant = { roleId: string; scopeType: 'operator' | 'branch'; scopeId: string };
async function grants(rows: Grant[]) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, actorId));
  if (rows.length) await ctx.db.insert(roleAssignment).values(rows.map((row) => ({ id: newId(), accountId: actorId, ...row })));
}
const investigateEverywhere = () => grants([
  { roleId: investigateRole, scopeType: 'operator', scopeId: own },
]);

const get = (path: string, query: string) => ctx.app.inject({ method: 'GET', url: `/console/money/${path}${query}`, headers: { cookie } });
async function read<T>(path: string, query: string): Promise<T> {
  const response = await get(path, query);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as T;
}
const range = (parks: string[], from = D1, to = D2) => `?branches=${parks.join(',')}&from=${from}&to=${to}`;

type Row = { branchId: string; title: string; saleId: string | null; attemptId: string | null; receiptNumber: string | null; walletId: string | null; actionId: string | null; trace: { kind: string; id: string; href: string } };
type Integrity = { checks: Array<{ key: string; window: string; rows: Row[]; truncated: boolean }>; pendingMinutes: number };
const check = (body: Integrity, key: string) => body.checks.find((c) => c.key === key)!;

function saleRow(over: Partial<typeof sale.$inferInsert>): typeof sale.$inferInsert {
  return {
    id: newId(), operatorId: own, branchId: fault, stationId: faultTill, createdByAccountId: actorId,
    businessDate: D1, businessDayStart: '05:00', timezone: 'Asia/Bangkok', occurredAt: at,
    pricingMode: 'weekday', pricingModeReason: 'ZZ TEST 647', customerTier: 'tourist', engineVersion: 'ZZ TEST 647',
    taxConfig: {}, taxBreakdown: {}, status: 'finalised', finalisedAt: at, ...over,
  };
}
const receipt = (series: string, seq: number) => ({ receiptSeries: series, receiptSeq: seq, receiptNumber: `${series}-${String(seq).padStart(6, '0')}` });
function attemptRow(over: Partial<typeof paymentAttempt.$inferInsert>): typeof paymentAttempt.$inferInsert {
  return {
    id: newId(), operatorId: own, branchId: fault, stationId: faultTill, businessDate: D1, method: 'cash',
    methodCode: 'cash', provider: 'manual', status: 'approved', amountSatang: 0, paidAt: at, ...over,
  };
}
function refundRow(over: Partial<typeof refund.$inferInsert> & { saleId: string; number: string; amountSatang: number }): typeof refund.$inferInsert {
  return {
    id: newId(), operatorId: own, branchId: fault, stationId: faultTill, mode: 'custom', reason: 'ZZ TEST 647 refund',
    approvedByAccountId: actorId, createdByAccountId: actorId, ...over,
  };
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [actor] = await ctx.db.select({ id: account.id, operatorId: account.operatorId }).from(account).where(eq(account.phone, ADMIN.phone));
  actorId = actor!.id; own = actor!.operatorId;
  foreign = newId(); fault = newId(); clean = newId(); foreignPark = newId();
  await ctx.db.insert(operator).values({ id: foreign, name: 'ZZ TEST 647 foreign operator' });
  await ctx.db.insert(branch).values([
    { id: fault, operatorId: own, name: 'ZZ TEST 647 faults', code: fault, timezone: 'Asia/Bangkok' },
    { id: clean, operatorId: own, name: 'ZZ TEST 647 clean', code: clean, timezone: 'Asia/Bangkok' },
    { id: foreignPark, operatorId: foreign, name: 'ZZ TEST 647 foreign', code: foreignPark },
  ]);
  faultTill = newId(); faultTill2 = newId(); cleanTill = newId();
  await ctx.db.insert(station).values([
    { id: faultTill, operatorId: own, branchId: fault, name: 'ZZ Fault till', codePrefix: 'ZZF' },
    { id: faultTill2, operatorId: own, branchId: fault, name: 'ZZ Fault till 2', codePrefix: 'ZZG' },
    { id: cleanTill, operatorId: own, branchId: clean, name: 'ZZ Clean till', codePrefix: 'ZZC' },
  ]);
  readRole = newId(); investigateRole = newId();
  await ctx.db.insert(role).values([
    { id: readRole, operatorId: own, name: 'ZZ TEST 647 money read' },
    { id: investigateRole, operatorId: own, name: 'ZZ TEST 647 money investigate' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: readRole, permission: 'console:money:read' },
    { id: newId(), roleId: investigateRole, permission: 'console:money:read' },
    { id: newId(), roleId: investigateRole, permission: 'console:money:investigate' },
  ]);

  // --- (a) receipt gaps: ZZF has 1, 2, 4 and a high-water mark of 7 -------------------
  ids.gap1 = newId(); ids.gap2 = newId(); ids.gap4 = newId();
  await ctx.db.insert(sale).values([
    saleRow({ id: ids.gap1, ...receipt('ZZF', 1) }),
    saleRow({ id: ids.gap2, ...receipt('ZZF', 2) }),
    saleRow({ id: ids.gap4, ...receipt('ZZF', 4) }),
    // Clean: 1, 2 (voided — it keeps its number), 3, and the mark agrees.
    saleRow({ branchId: clean, stationId: cleanTill, ...receipt('ZZC', 1) }),
    saleRow({ branchId: clean, stationId: cleanTill, ...receipt('ZZC', 2), status: 'voided', voidedAt: at, voidedByAccountId: actorId, voidReason: 'ZZ TEST 647 void' }),
    saleRow({ branchId: clean, stationId: cleanTill, ...receipt('ZZC', 3) }),
  ]);
  await ctx.db.insert(receiptSeries).values([
    { id: newId(), operatorId: own, branchId: fault, stationId: faultTill, series: 'ZZF', kind: 'sale', nextSeq: 7 },
    { id: newId(), operatorId: own, branchId: clean, stationId: cleanTill, series: 'ZZC', kind: 'sale', nextSeq: 4 },
  ]);

  // --- (b) a recorded sale with no settled payment ------------------------------------
  ids.unpaid = newId(); ids.awaiting = newId(); ids.paidClean = newId();
  await ctx.db.insert(sale).values([
    saleRow({ id: ids.unpaid, stationId: faultTill2, ...receipt('ZZG', 1), grossSatang: 50_000, netSatang: 50_000, subtotalSatang: 50_000, actionId: 'ZZ-647-unpaid' }),
    saleRow({ id: ids.awaiting, stationId: faultTill2, ...receipt('ZZG', 2), grossSatang: 30_000, netSatang: 30_000, subtotalSatang: 30_000 }),
    saleRow({ id: ids.paidClean, branchId: clean, stationId: cleanTill, ...receipt('ZZC', 4), grossSatang: 20_000, netSatang: 20_000, subtotalSatang: 20_000 }),
  ]);
  await ctx.db.update(receiptSeries).set({ nextSeq: 5 }).where(eq(receiptSeries.series, 'ZZC'));
  await ctx.db.insert(paymentAttempt).values([
    // Declined money is not money: the sale is still unpaid.
    attemptRow({ saleId: ids.unpaid, stationId: faultTill2, method: 'card', methodCode: 'card', status: 'declined', amountSatang: 50_000 }),
    // Awaiting settlement IS money taken — reconciliation pending, not unpaid.
    attemptRow({ saleId: ids.awaiting, stationId: faultTill2, method: 'qr', methodCode: 'promptpay', provider: 'digio', status: 'awaiting_settlement', amountSatang: 30_000 }),
    attemptRow({ saleId: ids.paidClean, branchId: clean, stationId: cleanTill, amountSatang: 20_000 }),
  ]);

  // --- (c) money with no sale, beside the attempts that belong to a party or a booking ---
  ids.orphan = newId(); ids.party = newId(); ids.bookingOwned = newId(); ids.bookingNamed = newId();
  await ctx.db.insert(paymentAttempt).values([
    attemptRow({ id: ids.orphan, method: 'qr', methodCode: 'promptpay', amountSatang: 7_000, actionId: 'ZZ-647-orphan', businessDate: D2 }),
    attemptRow({ id: ids.party, amountSatang: 9_000, businessDate: D2 }),
    attemptRow({ id: ids.bookingOwned, stationId: null, method: 'qr', methodCode: 'promptpay', provider: '2c2p', amountSatang: 11_000, businessDate: D2 }),
    attemptRow({ id: ids.bookingNamed, stationId: null, method: 'qr', methodCode: 'promptpay', provider: '2c2p', amountSatang: 12_000, businessDate: D2 }),
  ]);
  await ctx.db.insert(partyPayment).values({ id: newId(), operatorId: own, branchId: fault, otoappEventId: newId(), paymentAttemptId: ids.party, partyDate: D2 });
  const namedBooking = newId();
  await ctx.db.insert(booking).values([
    { id: newId(), operatorId: own, branchId: fault, reference: 'ZZ647A', bookingDate: D2, status: 'paid', paymentAttemptId: ids.bookingOwned },
    { id: namedBooking, operatorId: own, branchId: fault, reference: 'ZZ647B', bookingDate: D2, status: 'paid' },
  ]);
  await ctx.db.update(paymentAttempt).set({ payload: { bookingId: namedBooking } }).where(eq(paymentAttempt.id, ids.bookingNamed));

  // --- (d) a till's attempt stuck past PAYMENT_PENDING_MIN (10 by default) -------------
  const now = Date.now();
  ids.stuck = newId();
  await ctx.db.insert(paymentAttempt).values([
    attemptRow({ id: ids.stuck, method: 'card', methodCode: 'card', status: 'unknown', amountSatang: 4_000, paidAt: null, createdAt: new Date(now - 30 * 60_000), actionId: 'ZZ-647-stuck' }),
    // Younger than the threshold, and one with no station (the web page's own): neither is the till's stuck tender.
    attemptRow({ method: 'card', methodCode: 'card', status: 'unknown', amountSatang: 4_100, paidAt: null, createdAt: new Date(now - 2 * 60_000) }),
    attemptRow({ stationId: null, method: 'qr', methodCode: 'promptpay', provider: '2c2p', status: 'inquiring', amountSatang: 4_200, paidAt: null, createdAt: new Date(now - 30 * 60_000) }),
    attemptRow({ branchId: clean, stationId: cleanTill, method: 'card', methodCode: 'card', status: 'unknown', amountSatang: 4_300, paidAt: null, createdAt: new Date(now - 60_000) }),
  ]);

  // --- (e) refunds exceeding their sale; the refund series also skips number 2 ---------
  ids.overRefunded = newId(); ids.cleanRefunded = newId();
  await ctx.db.insert(sale).values([
    saleRow({ id: ids.overRefunded, stationId: faultTill2, ...receipt('ZZG', 3), grossSatang: 100_000, netSatang: 100_000, subtotalSatang: 100_000, status: 'refunded', refundedSatang: 100_000, refundedAt: at }),
    saleRow({ id: ids.cleanRefunded, branchId: clean, stationId: cleanTill, ...receipt('ZZC', 5), grossSatang: 100_000, netSatang: 100_000, subtotalSatang: 100_000, refundedSatang: 40_000 }),
  ]);
  await ctx.db.update(receiptSeries).set({ nextSeq: 6 }).where(eq(receiptSeries.series, 'ZZC'));
  await ctx.db.insert(paymentAttempt).values([
    attemptRow({ saleId: ids.overRefunded, stationId: faultTill2, amountSatang: 100_000 }),
    attemptRow({ saleId: ids.cleanRefunded, branchId: clean, stationId: cleanTill, amountSatang: 100_000 }),
  ]);
  ids.refund1 = newId();
  await ctx.db.insert(refund).values([
    refundRow({ id: ids.refund1, saleId: ids.overRefunded, number: 'ZZF-R-000001', amountSatang: 60_000 }),
    refundRow({ saleId: ids.overRefunded, number: 'ZZF-R-000003', amountSatang: 60_000 }),
    refundRow({ branchId: clean, stationId: cleanTill, saleId: ids.cleanRefunded, number: 'ZZC-R-000001', amountSatang: 40_000 }),
  ]);

  // --- (f) a wallet whose projection disagrees with its ledger -------------------------
  ids.badWallet = newId(); ids.goodWallet = newId();
  await ctx.db.insert(wallet).values([
    { id: ids.badWallet, operatorId: own, branchId: fault, balanceSatang: 50_000 },
    { id: ids.goodWallet, operatorId: own, branchId: clean, balanceSatang: 30_000 },
  ]);
  await ctx.db.insert(walletEntry).values([
    { id: newId(), walletId: ids.badWallet, operatorId: own, actionId: 'ZZ-647-bad-grant', amountSatang: 30_000, kind: 'grant', source: 'ticket_sale', branchId: fault, businessDate: D1, balanceAfter: 30_000 },
    { id: newId(), walletId: ids.goodWallet, operatorId: own, actionId: 'ZZ-647-good-grant', amountSatang: 30_000, kind: 'grant', source: 'ticket_sale', branchId: clean, businessDate: D1, balanceAfter: 30_000 },
  ]);
  await ctx.db.insert(factWalletLiabilityDaily).values({
    id: newId(), operatorId: own, branchId: clean, businessDate: D1, grantedSatang: 30_000, outstandingSatang: 30_000,
  });

  // --- Sections: a stored day, a saved close and a settlement file --------------------
  await ctx.db.insert(dailySummary).values({
    id: newId(), operatorId: own, branchId: clean, businessDate: D1, source: 'oto_pos', formulaVersion: 1,
    computedAt: at, inputFingerprint: 'ZZ TEST 647', ticketsSatang: 100_000, fnbSatang: 23_400, revenueSatang: 123_400,
    txnCount: 3, refundsSatang: 40_000,
  });
  await ctx.db.insert(endOfDay).values({
    id: newId(), operatorId: own, branchId: clean, businessDate: D2,
    lines: [{ channel: 'cash', expectedSatang: 10_000, actualSatang: 10_500, differenceSatang: 500 }],
    countedSatang: 610_500, floatSatang: 600_000, floatLeftSatang: 600_000,
    totalExpectedSatang: 10_000, totalActualSatang: 10_500, totalDifferenceSatang: 500,
    closedByAccountId: actorId, closedAt: at,
  });
  const batch = newId();
  ids.unsettledQr = newId();
  await ctx.db.insert(paymentAttempt).values(attemptRow({
    id: ids.unsettledQr, method: 'qr', methodCode: 'promptpay', provider: '2c2p', amountSatang: 15_000, invoiceNo: 'ZZ647INV1', businessDate: D1,
  }));
  await ctx.db.insert(settlementBatch).values({
    id: batch, operatorId: own, branchId: fault, businessDate: D1, source: '2c2p', state: 'attention', sourceKey: 'ZZ TEST 647', fileName: 'zz.csv', unmatched: 1,
  });
  await ctx.db.insert(settlementLine).values({
    id: newId(), batchId: batch, lineNo: 1, method: 'qr', amountSatang: 8_800, invoiceNo: 'ZZ647NOPE', transactionType: 'payment', match: 'unmatched',
  });
}, 240_000);

afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });
beforeEach(investigateEverywhere);

/** Every money row the fixtures touch, hashed: a read that changed one would change this. */
async function moneyFingerprint(): Promise<string> {
  const parks = [fault, clean];
  const rows = await Promise.all([
    ctx.db.select().from(sale).where(inArray(sale.branchId, parks)).orderBy(asc(sale.id)),
    ctx.db.select().from(paymentAttempt).where(inArray(paymentAttempt.branchId, parks)).orderBy(asc(paymentAttempt.id)),
    ctx.db.select().from(refund).where(inArray(refund.branchId, parks)).orderBy(asc(refund.id)),
    ctx.db.select().from(receiptSeries).where(inArray(receiptSeries.branchId, parks)).orderBy(asc(receiptSeries.id)),
    ctx.db.select().from(wallet).where(inArray(wallet.branchId, parks)).orderBy(asc(wallet.id)),
    ctx.db.select().from(walletEntry).where(inArray(walletEntry.branchId, parks)).orderBy(asc(walletEntry.id)),
    ctx.db.select().from(endOfDay).where(inArray(endOfDay.branchId, parks)).orderBy(asc(endOfDay.id)),
    ctx.db.select().from(settlementBatch).where(inArray(settlementBatch.branchId, parks)).orderBy(asc(settlementBatch.id)),
    ctx.db.select().from(factWalletLiabilityDaily).where(inArray(factWalletLiabilityDaily.branchId, parks)).orderBy(asc(factWalletLiabilityDaily.id)),
  ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

describe('SCRUM-647 money integrity panel — each check finds the failure it was built for', () => {
  it('(a) receipt-number gaps: a missing number between two documents and numbers issued past the last, per station and series', async () => {
    const body = await read<Integrity>('integrity', range([fault]));
    const gaps = check(body, 'receipt_gaps');
    expect(gaps.window).toBe('series_history');
    const titles = gaps.rows.map((r) => r.title).sort();
    expect(titles).toEqual([
      'Refund series ZZF-R: number 2 missing',
      'Sale series ZZF: number 3 missing',
      'Sale series ZZF: numbers 5 to 6 missing',
    ]);
    const internal = gaps.rows.find((r) => r.title === 'Sale series ZZF: number 3 missing')!;
    expect(internal).toMatchObject({ branchId: fault, receiptNumber: 'ZZF-000002' });
    expect(internal.trace).toEqual({ kind: 'receipt', id: 'ZZF-000002', href: '/support?trace=ZZF-000002&kind=receipt' });
    // A date filter outside every document cannot hide or invent a gap.
    const elsewhere = await read<Integrity>('integrity', range([fault], '2026-09-01', '2026-09-02'));
    expect(check(elsewhere, 'receipt_gaps').rows.map((r) => r.title).sort()).toEqual(titles);
  });

  it('(b) sales with no settled payment: declined money leaves the sale unpaid; awaiting settlement counts as taken', async () => {
    const rows = check(await read<Integrity>('integrity', range([fault])), 'sales_without_payment').rows;
    expect(rows.map((r) => r.saleId)).toEqual([ids.unpaid]);
    expect(rows[0]).toMatchObject({ receiptNumber: 'ZZG-000001', actionId: 'ZZ-647-unpaid', amountSatang: 50_000 });
    expect(rows[0]!.trace.href).toBe(`/support?trace=${ids.unpaid}&kind=sale`);
  });

  it('(c) payments with no sale: an orphan is listed; party and booking payments are not', async () => {
    const rows = check(await read<Integrity>('integrity', range([fault])), 'payments_without_sale').rows;
    // The settlement fixture's QR money (day 1) has no sale either, so it is a second, genuine orphan.
    expect(rows.map((r) => r.attemptId)).toEqual([ids.unsettledQr, ids.orphan]);
    for (const owned of [ids.party, ids.bookingOwned, ids.bookingNamed]) expect(rows.map((r) => r.attemptId)).not.toContain(owned);
    expect(rows[1]).toMatchObject({ actionId: 'ZZ-647-orphan', amountSatang: 7_000, saleId: null });
    expect(rows[1]!.trace).toMatchObject({ kind: 'payment_attempt', id: ids.orphan });
  });

  it('(d) attempts stuck past PAYMENT_PENDING_MIN: only a till attempt older than the threshold', async () => {
    const body = await read<Integrity>('integrity', range([fault]));
    expect(body.pendingMinutes).toBe(10);
    const rows = check(body, 'stuck_attempts').rows;
    expect(check(body, 'stuck_attempts').window).toBe('now');
    expect(rows.map((r) => r.attemptId)).toEqual([ids.stuck]);
    expect(rows[0]).toMatchObject({ actionId: 'ZZ-647-stuck', amountSatang: 4_000 });
  });

  it('(e) refunds exceeding their sale: the refund ledger adds up past the gross', async () => {
    const rows = check(await read<Integrity>('integrity', range([fault])), 'refunds_exceed_sale').rows;
    expect(rows.map((r) => r.saleId)).toEqual([ids.overRefunded]);
    expect(rows[0]).toMatchObject({ receiptNumber: 'ZZG-000003', amountSatang: 20_000 });
    expect(rows[0]!.title).toContain('refunded ฿1200.00 of ฿1000.00');
  });

  it('(f) wallet projection against its ledger: the balance that disagrees is listed with its wallet', async () => {
    const rows = check(await read<Integrity>('integrity', range([fault])), 'wallet_ledger_mismatch').rows;
    expect(rows.map((r) => r.walletId)).toEqual([ids.badWallet]);
    expect(rows[0]).toMatchObject({ amountSatang: 20_000 });
    expect(rows[0]!.trace).toEqual({ kind: 'wallet', id: ids.badWallet, href: `/support?trace=${ids.badWallet}&kind=wallet` });
  });

  it('clean-state control: the clean park, built of the same shapes, lists nothing in any check', async () => {
    const body = await read<Integrity>('integrity', range([clean]));
    expect(body.checks.map((c) => c.key)).toEqual([
      'receipt_gaps', 'sales_without_payment', 'payments_without_sale', 'stuck_attempts', 'refunds_exceed_sale', 'wallet_ledger_mismatch',
    ]);
    for (const c of body.checks) expect(c.rows, c.key).toEqual([]);
  });
});

describe('SCRUM-647 money oversight — permissions, scope and audit', () => {
  it('the integrity panel and the row identifiers need console:money:investigate; the figures need only console:money:read', async () => {
    await grants([{ roleId: readRole, scopeType: 'operator', scopeId: own }]);
    expect((await get('integrity', range([fault]))).statusCode).toBe(403);
    const refunds = await read<{ refunds: { rows: Array<{ refundId: string | null; saleId: string | null; trace: unknown; number: string }> } }>('refunds', range([fault]));
    expect(refunds.refunds.rows.length).toBe(2);
    for (const row of refunds.refunds.rows) expect([row.refundId, row.saleId, row.trace]).toEqual([null, null, null]);
    await investigateEverywhere();
    const opened = await read<typeof refunds>('refunds', range([fault]));
    expect(opened.refunds.rows.map((r) => r.saleId)).toEqual([ids.overRefunded, ids.overRefunded]);
  });

  it('no money grant is 403; a foreign or unknown park is 404; a park outside a branch grant is omitted', async () => {
    await grants([]);
    expect((await get('sales', range([clean]))).statusCode).toBe(403);
    await investigateEverywhere();
    expect((await get('sales', range([foreignPark]))).statusCode).toBe(404);
    expect((await get('sales', range([newId()]))).statusCode).toBe(404);
    await grants([{ roleId: investigateRole, scopeType: 'branch', scopeId: clean }]);
    const body = await read<{ scope: { branches: Array<{ branchId: string }>; omitted: string[] } }>('cash', range([clean, fault]));
    expect(body.scope.branches.map((b) => b.branchId)).toEqual([clean]);
    expect(body.scope.omitted).toEqual([fault]);
    expect((await get('integrity', range([fault]))).statusCode).toBe(403);
  });

  it('refuses a reversed or over-long range', async () => {
    expect((await get('sales', range([clean], D2, D1))).statusCode).toBe(400);
    expect((await get('sales', range([clean], '2026-08-01', '2026-10-01'))).statusCode).toBe(400);
  });

  it('every read writes one audit row naming the section and filters, never a figure, and changes no money row', async () => {
    const before = await moneyFingerprint();
    const sections = ['sales', 'refunds', 'discounts', 'cash', 'settlement', 'wallets', 'costs', 'integrity'];
    for (const section of sections) {
      const response = await get(section, range([fault, clean]));
      expect(response.statusCode, `${section} ${response.body}`).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      const requestId = response.headers['x-request-id'] as string;
      expect(requestId, section).toBeTruthy();
      const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.requestId, requestId));
      // Exactly one row for the read, and it is the read's own.
      expect(rows.length, section).toBe(1);
      const row = rows[0]!;
      expect(row).toMatchObject({ entityType: 'console.money', entityId: requestId, actorAccountId: actorId, operatorId: own });
      expect(row.action).toBe(section === 'integrity' ? 'console.money.investigate' : 'console.money.read');
      expect(row.after).toEqual({
        section,
        filters: { branchIds: [fault, clean], from: D1, to: D2 },
        branchIds: [fault, clean],
        omitted: [],
      });
      expect(JSON.stringify(row.after)).not.toMatch(/Satang|amount|gross/i);
    }
    expect(await moneyFingerprint()).toBe(before);
  });
});

describe('SCRUM-647 money oversight — each section is its owning reader', () => {
  it('cash: a day reads exactly as the POS End of Day reads it, a saved close is shown as saved, a refused day is not available', async () => {
    const body = await read<{
      toleranceSatang: number;
      branches: Array<{ branchId: string; days: Array<Record<string, unknown> & { businessDate: string; available: boolean }> }>;
    }>('cash', range([clean, fault]));
    expect(body.toleranceSatang).toBe(100);
    const cleanDays = body.branches.find((b) => b.branchId === clean)!.days;
    const open = cleanDays.find((d) => d.businessDate === D1)!;
    const native = await getEndOfDay(ctx.db, own, clean, D1);
    expect(open).toMatchObject({
      available: true, status: 'open', totalExpectedSatang: native.totalExpectedSatang,
      totalActualSatang: native.totalActualSatang, totalDifferenceSatang: native.totalDifferenceSatang,
      floatSatang: native.cashCount.floatSatang,
    });
    expect((open.lines as Array<{ channel: string; expectedSatang: number }>).map((l) => [l.channel, l.expectedSatang]))
      .toEqual(native.lines.map((l) => [l.channel, l.expectedSatang]));
    const closed = cleanDays.find((d) => d.businessDate === D2)!;
    expect(closed).toMatchObject({ available: true, status: 'closed', verdict: 'off', linesOff: 1, totalDifferenceSatang: 500 });
    // Party money on the day with no OTO App events seam: End of Day refuses the day, so the page says not available.
    const refused = body.branches.find((b) => b.branchId === fault)!.days.find((d) => d.businessDate === D2)!;
    expect(refused).toMatchObject({ available: false, code: 'EVENTS_SEAM_MISSING' });
    expect(refused).not.toHaveProperty('totalExpectedSatang');
  });

  it('settlement: an imported file with an unmatched line, unmatched taken QR money, and a day with no file said as such', async () => {
    const body = await read<{
      gatewayFileFormat: string;
      branches: Array<{ branchId: string; days: Array<{ businessDate: string; gateway: { state: string; files: number }; unmatchedLines: Array<{ amountSatang: number; source: string }>; unmatchedAttempts: Array<{ amountSatang: number; attemptId: string | null }> }> }>;
    }>('settlement', range([fault, clean]));
    expect(body.gatewayFileFormat).toBe('fixture_only');
    const faultD1 = body.branches.find((b) => b.branchId === fault)!.days.find((d) => d.businessDate === D1)!;
    expect(faultD1.gateway).toEqual({ state: 'attention', files: 1 });
    expect(faultD1.unmatchedLines).toMatchObject([{ amountSatang: 8_800, source: '2c2p' }]);
    expect(faultD1.unmatchedAttempts.map((a) => a.attemptId)).toContain(ids.unsettledQr);
    const cleanD1 = body.branches.find((b) => b.branchId === clean)!.days.find((d) => d.businessDate === D1)!;
    expect(cleanD1.gateway).toEqual({ state: 'no_file', files: 0 });
  });

  it('wallets: a written liability day, a day the job has not written, and the projection beside its ledger', async () => {
    const body = await read<{
      outstanding: { projectionSatang: number; ledgerSatang: number };
      branches: Array<{ branchId: string; outstanding: { projectionSatang: number; ledgerSatang: number }; days: Array<Record<string, unknown>> }>;
    }>('wallets', range([fault, clean]));
    const cleanPark = body.branches.find((b) => b.branchId === clean)!;
    expect(cleanPark.days).toEqual([
      { businessDate: D1, written: true, grantedSatang: 30_000, spentSatang: 0, refundedSatang: 0, expiredSatang: 0, reactivatedSatang: 0, outstandingSatang: 30_000 },
      { businessDate: D2, written: false, reason: 'not_yet_written' },
    ]);
    expect(cleanPark.outstanding).toEqual({ projectionSatang: 30_000, ledgerSatang: 30_000 });
    expect(body.branches.find((b) => b.branchId === fault)!.outstanding).toEqual({ projectionSatang: 50_000, ledgerSatang: 30_000 });
    expect(body.outstanding).toEqual({ projectionSatang: 80_000, ledgerSatang: 60_000 });
  });

  it('sales: the stored daily summary per park and date by revenue category, with its marks', async () => {
    const body = await read<{ basis: string; branches: Array<{ branchId: string; days: Array<Record<string, unknown>>; total: Record<string, unknown> }> }>('sales', range([clean]));
    expect(body.basis).toBe('stored-daily-summary');
    const park = body.branches[0]!;
    expect(park.days.find((d) => d.businessDate === D1)).toMatchObject({ revenueSatang: 123_400, ticketsSatang: 100_000, fnbSatang: 23_400, refundsSatang: 40_000, rolledDays: 1 });
    expect(park.total).toMatchObject({ revenueSatang: 123_400, txnCount: 3 });
  });

  it('refunds and voids: approver, reason and the original sale; discounts and costs answer from their reports', async () => {
    const body = await read<{
      refunds: { count: number; totalSatang: number; rows: Array<{ number: string; approvedBy: string | null; reason: string; sale: { receiptNumber: string | null } }> };
      voids: { count: number; rows: Array<{ receiptNumber: string | null; reason: string | null; voidedBy: string | null }> };
    }>('refunds', range([clean]));
    expect(body.refunds).toMatchObject({ count: 1, totalSatang: 40_000 });
    expect(body.refunds.rows[0]).toMatchObject({ number: 'ZZC-R-000001', reason: 'ZZ TEST 647 refund', sale: { receiptNumber: 'ZZC-000005' } });
    expect(body.refunds.rows[0]!.approvedBy).not.toBeNull();
    expect(body.voids.count).toBe(1);
    expect(body.voids.rows[0]).toMatchObject({ receiptNumber: 'ZZC-000002', reason: 'ZZ TEST 647 void' });
    const discounts = await read<{ foregoneSatang: number; compSatang: number; manualDiscountSatang: number; promoSatang: number }>('discounts', range([clean]));
    expect(discounts.foregoneSatang).toBe(discounts.compSatang + discounts.manualDiscountSatang + discounts.promoSatang);
    const costs = await read<{ booths: { prizeCostSatang: number }; benefits: { appliedSatang: number } }>('costs', range([clean]));
    expect(costs.booths.prizeCostSatang).toBe(0);
    expect(costs.benefits.appliedSatang).toBe(0);
  });
});
