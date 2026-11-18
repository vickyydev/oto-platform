import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, box, branch, paymentAttempt, printJob, receiptSeries, sale, saleLine, station } from '@oto/db';
import { deriveId, newId, type PartyAdditionalBill, type PartyDetailAnswer, type PartySettleAnswer, type PartyWriteAnswer } from '@oto/shared';
import { syncBeoAdditionalCharges } from '../src/services/beo-additional-charges';
import { branchClockFor, currentBusinessDate, getEndOfDay } from '../src/services/end-of-day';
import { partyFactsOf } from '../src/services/analytics-parties';
import { simulateGatewayEvent } from '../src/services/payments/gateway';
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
 * SCRUM-1002 — THE OWNER'S TWO RULINGS ON A PARTY'S ADDITIONAL BILLS
 * (18 November 2026, his decisions page):
 *
 *   1. "Should an additional bill get its own receipt?" — "Yes, its own receipt."
 *   2. "Which End of Day line should it be on?" — "By how it was paid: cash with
 *      cash, QR with QR."
 *
 * Pinned here against the routes and the ledger: the bill paid in full gets a
 * receipt numbered in the paying station's series, carrying that bill's lines,
 * its VAT line and its payments only, printed there, once however often the
 * payment is replayed; a part payment spends no number; the first receipt is
 * never touched. End of Day counts the bill's cash with the cash (and so in
 * Expected cash), its QR with the QR payments, and neither on the party line;
 * the day's sales summary counts the bill once.
 */

let ctx: TestContext;
let central: string;
let operatorId: string;
let till: string;
let reception: string;
let admin: string;
let today: string;
let timezone: string;

const appTenant = newId();
const appCentral = newId();
const GATEWAY_SECRET = randomBytes(32).toString('hex');

const FLORESTA = {
  template_id: '391b269d-159a-4039-89a2-51ac132da747',
  name: 'Floresta Birthday',
  hours: 3,
  kids_included: 10,
  adults_included: 4,
  socks_included: -1,
  price_weekday_satang: 1_690_000,
  price_weekend_satang: 2_090_000,
  extra_child_weekday_satang: 130_000,
  extra_child_weekend_satang: 150_000,
  extra_adult_weekday_satang: 35_000,
  extra_adult_weekend_satang: 50_000,
  included_lines: [{ label: 'Birthday set menu' }],
};

async function call<T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { cookie: reception },
  });
  return { status: res.statusCode, body: res.json() as T };
}

const detail = async (id: string) => (await call<PartyDetailAnswer>('GET', `/parties/${id}?branchId=${central}`)).body.event.party!;
const billsOf = async (id: string): Promise<PartyAdditionalBill[]> => (await detail(id)).additionalBills ?? [];

/** A party held today, settled at the till and its balance taken in cash: the first receipt. */
async function settledParty(title: string) {
  const id = newId();
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      total_value, prepayment_amount, child_name, parent_name, whatsapp_phone_e164,
      kid_turning_age, num_children, num_adults, location_text, status, created_at, updated_at)
    values (
      ${id}, ${appTenant}, ${appCentral}, 'birthday', ${title}, ${today}, '13:00', '16:00',
      16900, 0, 'Mali', 'Nok', '+66812345678', 6, 10, 4, 'Party room 1', 'upcoming',
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
  await ctx.db.execute(sql`
    insert into zz_party_contract.event_packages values (
      ${id}, ${central}::uuid, ${today}::date, '13:00'::time, '16:00'::time,
      ${JSON.stringify(FLORESTA)}::jsonb, ${JSON.stringify({ kids_expected: 10, adults_expected: 4 })}::jsonb,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      ${JSON.stringify({ kids_food_time: '14:00', adults_food_time: '14:30', ready_offset_minutes: 20, slips_time: '11:00' })}::jsonb,
      ${JSON.stringify({ deposit_satang: 0, pos_sale_id: null })}::jsonb)`);
  const settled = await call<PartySettleAnswer>('POST', `/parties/${id}/settle`, {
    branchId: central, stationId: till, settlementId: newId(), saleId: newId(), addOnIds: [], entertainmentIds: [], kids: 10, adults: 4, socksGiven: 0,
  });
  expect(settled.status, JSON.stringify(settled.body)).toBe(200);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${settled.body.sale.id}/finalise`,
    payload: { method: 'cash', tenderedSatang: settled.body.sale.outstandingSatang },
    headers: { cookie: reception, 'x-oto-action-id': newId() },
  });
  expect(res.statusCode, res.body).toBe(200);
  const [main] = await ctx.db.select().from(sale).where(eq(sale.id, settled.body.sale.id));
  expect(main!.receiptNumber).toMatch(/^T1-/);
  return { id, mainSaleId: main!.id, mainReceipt: main!.receiptNumber! };
}

/** The first receipt as it stands: its sale, its lines, its payments. */
async function firstReceipt(saleId: string): Promise<string> {
  return JSON.stringify({
    sale: await ctx.db.select().from(sale).where(eq(sale.id, saleId)),
    lines: await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId)).orderBy(asc(saleLine.lineNo)),
    payments: await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId)).orderBy(asc(paymentAttempt.createdAt)),
  });
}

const beoExtra = (eventId: string, lineId: string, name: string, area: 'food' | 'bar', quantity: number, unitSatang: number) =>
  syncBeoAdditionalCharges(ctx.db, { operatorId }, operatorId, eventId, {
    actorAppUserId: 'zz-test-staff',
    lines: [{ lineId, name, productCode: null, area, quantity, unitSatang, included: false }],
  });

const payCash = (eventId: string, billId: string, paymentId: string, amountSatang: number, expectedOutstandingSatang: number, tenderedSatang?: number) =>
  call<PartyWriteAnswer>('POST', `/parties/${eventId}/payments`, {
    branchId: central, stationId: till, additionalBillId: billId, paymentId, amountSatang, expectedOutstandingSatang,
    tender: { method: 'cash', ...(tenderedSatang === undefined ? {} : { tenderedSatang }) },
  });

const line = (eod: Awaited<ReturnType<typeof getEndOfDay>>, channel: string) => eod.lines.find((l) => l.channel === channel)?.expectedSatang ?? 0;
const endOfDayNow = () => getEndOfDay(ctx.db, operatorId, central, today);

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: { PGW_PROVIDER: 'simulator', PGW_MERCHANT_ID: 'OTO1002MERCHANT', PGW_SECRET_KEY: GATEWAY_SECRET, PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential' },
  });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, t1!.boxId!));
  const clock = await branchClockFor(ctx.db, operatorId, central);
  today = currentBusinessDate(clock);
  timezone = clock.timezone;
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-1002')`);
  await ctx.db.execute(sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id) values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await ctx.db.execute(sql.raw(`
    create schema zz_party_contract;
    create table zz_party_contract.event_packages (
      event_id varchar not null, core_branch_id uuid, party_date date, start_time time, end_time time,
      package jsonb, counts jsonb, add_ons jsonb, entertainment jsonb, set_menu jsonb, bar_items jsonb,
      kitchen jsonb, settlement jsonb);
    drop view if exists otoapp_v.event_packages;
    create view otoapp_v.event_packages as select * from zz_party_contract.event_packages;`));
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-1002 ruling 1: an additional bill paid in full gets its own receipt', () => {
  it('cash: a part payment spends no number; the payment that pays it off numbers it in the till series with that bill only', async () => {
    const party = await settledParty('ZZ TEST 1002 cash bill');
    const first = await firstReceipt(party.mainSaleId);
    await beoExtra(party.id, 'ZZ-TEST-1002-drink', 'ZZ TEST 1002 juice', 'bar', 2, 5003);
    const [bill] = await billsOf(party.id);
    expect(bill).toMatchObject({ state: 'open', totalSatang: 10006, outstandingSatang: 10006 });
    const receiptSaleId = deriveId(bill!.id, 'party-additional-bill-receipt');

    // Performance's party takings, before: the bill's money is not among them after either.
    const partyTakings = async () => (await partyFactsOf(ctx.db, { id: central, operatorId, timezone }, today)).payments.reduce((sum, p) => sum + p.amountSatang, 0);
    const takingsBefore = await partyTakings();

    // A part payment: the bill stays open and no number is spent.
    const [seriesBefore] = await ctx.db.select().from(receiptSeries).where(and(eq(receiptSeries.stationId, till), eq(receiptSeries.kind, 'sale')));
    const part = await payCash(party.id, bill!.id, newId(), 4000, 10006);
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    expect((await billsOf(party.id))[0]).toMatchObject({ state: 'open', outstandingSatang: 6006, receipt: null });
    expect(await ctx.db.select().from(sale).where(eq(sale.id, receiptSaleId))).toEqual([]);
    const [seriesPart] = await ctx.db.select().from(receiptSeries).where(and(eq(receiptSeries.stationId, till), eq(receiptSeries.kind, 'sale')));
    expect(seriesPart!.nextSeq).toBe(seriesBefore!.nextSeq);

    // The rest, with change: the bill is paid and its receipt issued at this till.
    const lastId = newId();
    const last = await payCash(party.id, bill!.id, lastId, 6006, 6006, 10000);
    expect(last.status, JSON.stringify(last.body)).toBe(200);
    const paid = (await billsOf(party.id))[0]!;
    expect(paid.state).toBe('paid');
    expect(paid.receipt?.receiptNumber).toMatch(/^T1-/);
    expect(paid.receipt!.receiptNumber).not.toBe(party.mainReceipt);
    expect(paid.receipt!.saleId).toBe(receiptSaleId);

    const [own] = await ctx.db.select().from(sale).where(eq(sale.id, receiptSaleId));
    expect(own).toMatchObject({ status: 'finalised', stationId: till, grossSatang: 10006, receiptNumber: paid.receipt!.receiptNumber });
    // 7% VAT inside 100.06, as any sale's receipt works it out.
    expect(own!.taxInclusiveSatang).toBe(Math.round((10006 * 7) / 107));
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, receiptSaleId));
    expect(lines.map((l) => l.label)).toEqual(['ZZ TEST 1002 juice']);
    expect(lines.reduce((sum, l) => sum + l.grossSatang, 0)).toBe(10006);

    // The paper: that bill's line, the VAT line, the total and both cash payments — nothing of the main bill.
    const paper = paid.receipt!.document;
    expect(paper.receiptNumber).toBe(paid.receipt!.receiptNumber);
    expect(paper.lines).toEqual([{ qty: 2, name: 'ZZ TEST 1002 juice', price: expect.stringContaining('100.06') }]);
    expect(paper.total).toContain('100.06');
    expect(paper.vat).toBeDefined();
    // Both cash payments by their method, and the change on the last.
    expect(paper.tenders?.map((t) => t.label)).toEqual(['Cash', 'Cash', 'Cash tendered', 'Change']);
    expect(JSON.stringify(paper.lines)).not.toMatch(/Birthday|package|Children|Adults/i);
    expect(paper.total).not.toContain('16,900');
    // The receipt is printed at the paying till.
    const jobs = await ctx.db.select().from(printJob).where(and(eq(printJob.subjectId, receiptSaleId), eq(printJob.kind, 'receipt')));
    expect(jobs).toHaveLength(1);

    // The same press again: one receipt, one number, nothing printed twice.
    const again = await payCash(party.id, bill!.id, lastId, 6006, 6006, 10000);
    expect(again.status).toBe(200);
    expect((await billsOf(party.id))[0]!.receipt!.receiptNumber).toBe(paid.receipt!.receiptNumber);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, receiptSaleId))).toHaveLength(1);
    expect(await ctx.db.select().from(printJob).where(and(eq(printJob.subjectId, receiptSaleId), eq(printJob.kind, 'receipt')))).toHaveLength(1);
    const [seriesAfter] = await ctx.db.select().from(receiptSeries).where(and(eq(receiptSeries.stationId, till), eq(receiptSeries.kind, 'sale')));
    expect(seriesAfter!.nextSeq).toBe(seriesBefore!.nextSeq + 1);

    // The first receipt is untouched.
    expect(await firstReceipt(party.mainSaleId)).toBe(first);
    // The bill is a receipted sale, counted with the day's sales: Performance's party takings do not count it again.
    expect(await partyTakings()).toBe(takingsBefore);
  });

  it('QR: the gateway answer issues the receipt with the money; the till recording it answers the same receipt', async () => {
    const party = await settledParty('ZZ TEST 1002 qr bill');
    const first = await firstReceipt(party.mainSaleId);
    // A charge the till added after settlement: its own lines at their own totals.
    const charge = await call('POST', `/parties/${party.id}/charges`, {
      branchId: central, stationId: till, chargeId: newId(), kind: 'fnb', totalSatang: 15000,
      items: [{ name: 'ZZ TEST 1002 pizza', qty: 2, lineTotalSatang: 15000 }],
    });
    expect(charge.status).toBe(200);
    const [bill] = await billsOf(party.id);
    const [before] = await ctx.db.select({ routing: station.paymentRouting }).from(station).where(eq(station.id, till));
    await ctx.db.update(station).set({ paymentRouting: { qr: 'gateway' } }).where(eq(station.id, till));
    try {
      const body = { branchId: central, stationId: till, additionalBillId: bill!.id, paymentId: newId(), amountSatang: 15000, expectedOutstandingSatang: 15000, tender: { method: 'promptpay', kind: 'qr' }, requestQrPayload: true, qrDirection: 'show', actionId: newId() };
      const start = await call<{ attempt: { id: string } }>('POST', `/parties/${party.id}/payments/tender`, body);
      expect(start.status, JSON.stringify(start.body)).toBe(200);
      expect((await billsOf(party.id))[0]!.receipt ?? null).toBeNull();
      await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId: start.body.attempt.id, event: 'paid', operatorId });
      const issued = (await billsOf(party.id))[0]!;
      expect(issued.state).toBe('paid');
      expect(issued.receipt?.receiptNumber).toMatch(/^T1-/);
      expect(issued.receipt!.document.lines).toEqual([{ qty: 2, name: 'ZZ TEST 1002 pizza', price: expect.stringContaining('150') }]);
      expect(issued.receipt!.document.tenders?.map((t) => t.label).join(' ')).toMatch(/PromptPay|QR/i);
      const recorded = await call<PartyWriteAnswer>('POST', `/parties/${party.id}/payments`, { ...body, tender: { method: 'promptpay', kind: 'qr' } });
      expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
      expect((await billsOf(party.id))[0]!.receipt!.receiptNumber).toBe(issued.receipt!.receiptNumber);
      const [attempt] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, start.body.attempt.id));
      expect(attempt!.saleId).toBe(issued.receipt!.saleId);
    } finally {
      await ctx.db.update(station).set({ paymentRouting: before!.routing }).where(eq(station.id, till));
    }
    expect(await firstReceipt(party.mainSaleId)).toBe(first);
  });

  it('a bill whose lines do not come to what it charged gets no receipt; the payment stands and the till is told why', async () => {
    const party = await settledParty('ZZ TEST 1002 discounted bill');
    // Taken on the till with a discount: lines of 200.00 charged at 150.00.
    await call('POST', `/parties/${party.id}/charges`, {
      branchId: central, stationId: till, chargeId: newId(), kind: 'fnb', totalSatang: 15000,
      items: [{ name: 'ZZ TEST 1002 cake', qty: 1, lineTotalSatang: 20000 }],
    });
    const [bill] = await billsOf(party.id);
    const paid = await payCash(party.id, bill!.id, newId(), 15000, 15000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment?.amountSatang).toBe(15000);
    expect(paid.body.receiptNotes?.join(' ')).toMatch(/no receipt was issued for Additional bill 1/);
    expect((await billsOf(party.id))[0]).toMatchObject({ state: 'paid', receipt: null });
    const failed = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.additional_bill_receipt_failed'), eq(auditLog.entityId, bill!.id)));
    expect(failed).toHaveLength(1);
  });
});

describe('SCRUM-1002 adversarial review', () => {
  /**
   * FINDING (MEDIUM, stands as an owner question, recorded on SCRUM-1002): the
   * bill's receipt is a sale, so History offers it a refund like any sale. A
   * refund there gives the money back but the party's bill still reads paid,
   * because the bill reads its payments, not its receipt. Prescribed fix, once
   * ruled: either refuse a refund of an additional bill's receipt from History
   * (409, "refund it from the party") or reopen the bill when its receipt is
   * refunded. Nothing in this lane decides which.
   */
  it.fails('a refunded additional-bill receipt does not leave the bill reading paid', async () => {
    const party = await settledParty('ZZ TEST 1002 refund question');
    await beoExtra(party.id, 'ZZ-TEST-1002-refund', 'ZZ TEST 1002 cookie', 'food', 1, 3000);
    const [bill] = await billsOf(party.id);
    expect((await payCash(party.id, bill!.id, newId(), 3000, 3000)).status).toBe(200);
    const receipt = (await billsOf(party.id))[0]!.receipt!;
    const refunded = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${receipt.saleId}/refunds`,
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { mode: 'whole', reason: 'ZZ TEST 1002 refund question', actionId: newId() },
    });
    const after = (await billsOf(party.id))[0]!;
    expect(refunded.statusCode === 409 || after.state === 'open').toBe(true);
  });
});

describe('SCRUM-1002 ruling 2: End of Day shows an additional bill by how it was paid', () => {
  it('cash with the cash (in Expected cash), QR with the QR payments, neither on the party line; the summary counts it once', async () => {
    const party = await settledParty('ZZ TEST 1002 end of day');
    await beoExtra(party.id, 'ZZ-TEST-1002-eod-food', 'ZZ TEST 1002 nuggets', 'food', 1, 12345);
    const eodBefore = await endOfDayNow();
    const [cashBill] = await billsOf(party.id);
    expect((await payCash(party.id, cashBill!.id, newId(), 12345, 12345)).status).toBe(200);

    const eodCash = await endOfDayNow();
    expect(line(eodCash, 'cash') - line(eodBefore, 'cash')).toBe(12345);
    expect(line(eodCash, 'party_prepay')).toBe(line(eodBefore, 'party_prepay'));
    expect(eodCash.totalExpectedSatang - eodBefore.totalExpectedSatang).toBe(12345);

    // A second bill, paid by QR through the gateway.
    await beoExtra(party.id, 'ZZ-TEST-1002-eod-drink', 'ZZ TEST 1002 soda', 'bar', 1, 4321);
    const qrBill = (await billsOf(party.id))[1]!;
    const [before] = await ctx.db.select({ routing: station.paymentRouting }).from(station).where(eq(station.id, till));
    await ctx.db.update(station).set({ paymentRouting: { qr: 'gateway' } }).where(eq(station.id, till));
    try {
      const body = { branchId: central, stationId: till, additionalBillId: qrBill.id, paymentId: newId(), amountSatang: 4321, expectedOutstandingSatang: 4321, tender: { method: 'promptpay', kind: 'qr' }, requestQrPayload: true, qrDirection: 'show', actionId: newId() };
      const start = await call<{ attempt: { id: string } }>('POST', `/parties/${party.id}/payments/tender`, body);
      expect(start.status).toBe(200);
      await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId: start.body.attempt.id, event: 'paid', operatorId });
    } finally {
      await ctx.db.update(station).set({ paymentRouting: before!.routing }).where(eq(station.id, till));
    }
    const eodQr = await endOfDayNow();
    expect(line(eodQr, 'promptpay') - line(eodCash, 'promptpay')).toBe(4321);
    expect(line(eodQr, 'cash')).toBe(line(eodCash, 'cash'));
    expect(line(eodQr, 'party_prepay')).toBe(line(eodBefore, 'party_prepay'));
    expect(eodQr.totalExpectedSatang - eodBefore.totalExpectedSatang).toBe(12345 + 4321);
  });
});
