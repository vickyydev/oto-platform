import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, box, branch, product, refund, sale, station, wallet } from '@oto/db';
import { mintVoucherQr, newId, type EndOfDayRecord } from '@oto/shared';
import { createWalletWithGrant } from '../src/services/wallet';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-877 — A FOOD OR SHOP SALE THAT TOOK PART OF ITS MONEY IS REFUNDED FROM
 * HISTORY, AND THE DAY THEN CLOSES.
 *
 * At the F&B counter the guest's credit is spent first; when the rest never
 * comes the sale stays `tendering` with money taken on it. It is not a held
 * sale (a counter order never enters Held sales), it cannot be voided
 * (`SALE_HAS_PAYMENT`), and the End of Day refuses to close over it with a
 * sentence that sends the manager to History. The whole refund History now
 * sends (SCRUM-416's part-paid branch, `mode: 'whole'`) is what makes that
 * sentence true: everything taken goes back — credit to the wallet it was
 * spent from, cash as cash — the sale closes as void, and Close Day goes
 * through. Nothing was issued for the sale, so no kitchen ticket is involved,
 * and its lines carry no money on the refund.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let friesId: string;
let socksId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, till!.boxId!));
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await takeStation(ctx.app, reception, stationId);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  await takeStation(ctx.app, manager, stationId);
  const rows = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), isNull(product.archivedAt), inArray(product.code, ['FB-FRIES', 'MR-SOCKS'])));
  friesId = rows.find((r) => r.code === 'FB-FRIES')!.id;
  socksId = rows.find((r) => r.code === 'MR-SOCKS')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers ----------------------------------------------------------------------

/** A wallet with this much credit on it, found by its voucher QR. */
async function walletWith(amountSatang: number): Promise<{ id: string; qr: string }> {
  const qr = mintVoucherQr();
  const made = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, { accountId: null, operatorId }, {
      actionId: `test-grant:${newId()}`,
      branchId,
      holderName: 'ZZ TEST walk-in guest',
      amountSatang,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qr }],
    }),
  );
  return { id: made.wallet.id, qr };
}

async function balanceOfWallet(id: string): Promise<number> {
  const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, id));
  return row!.balanceSatang;
}

/** French Fries, ฿90, at the F&B counter. */
async function fnbOrder(): Promise<{ saleId: string; owed: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '12', items: [{ id: newId(), productId: friesId, quantity: 1 }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().sale.totals.grossSatang as number };
}

/** Grip socks (M), ฿120, at the shop. */
async function shopOrder(): Promise<{ saleId: string; owed: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'shop', items: [{ id: newId(), productId: socksId, quantity: 1, variant: { variantId: 'm', variantLabel: 'M' } }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().sale.totals.grossSatang as number };
}

const finalise = (saleId: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload });

/** What History sends: the whole of the sale, with the press's action id. */
const refundFromHistory = (cookie: string, saleId: string, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/refunds`,
    headers: { cookie, 'idempotency-key': newId() },
    payload: { mode: 'whole', reason: 'ZZ TEST guest could not pay the rest', ...body },
  });

async function saleRow(saleId: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  return row!;
}

async function endOfDay(date: string): Promise<EndOfDayRecord> {
  const res = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/end-of-day?date=${date}`, headers: { cookie: manager } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as EndOfDayRecord;
}

const closeDay = (date: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/branches/${branchId}/end-of-day/close`,
    headers: { cookie: manager, 'idempotency-key': newId() },
    payload: { date, actuals: [], countedSatang: null, floatLeftSatang: null, override: { reason: 'ZZ TEST rehearsal day' } },
  });

// =============================================================================

describe('SCRUM-877 — a part-paid F&B or shop sale is refunded whole from History', () => {
  let foodSaleId: string;
  let walletId: string;
  let date: string;

  it('credit spent and the rest never paid: the sale is part-paid at the counter, and End of Day says so in History\'s words', async () => {
    const w = await walletWith(5_000);
    walletId = w.id;
    const { saleId, owed } = await fnbOrder();
    foodSaleId = saleId;
    expect(owed).toBe(9_000);
    const first = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ finalised: false, outstandingSatang: 4_000 });
    expect(await balanceOfWallet(walletId)).toBe(0);
    const row = await saleRow(saleId);
    expect(row.status).toBe('tendering');
    date = row.businessDate;

    // History's read: money taken, every attempt settled, no tender in flight.
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: reception } });
    expect(read.statusCode).toBe(200);
    expect(read.json().attempts).toEqual([expect.objectContaining({ method: 'wallet', status: 'approved', amountSatang: 5_000 })]);
    expect(read.json().printJobs).toEqual([]);

    const record = await endOfDay(date);
    expect(record.openSales!.rows.find((r) => r.saleId === saleId)).toMatchObject({
      kind: 'part_paid',
      held: false,
      counter: 'other',
      paidSatang: 5_000,
      balanceSatang: 4_000,
    });
    const refused = await closeDay(date);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('PART_PAID_SALES');
    expect(refused.json().error.message).toContain('have a manager refund what was paid from History');
  });

  it('cannot be voided, and is not refunded by a till without the manager\'s approval or by any part', async () => {
    const voided = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${foodSaleId}/void`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { reason: 'ZZ TEST guest left' },
    });
    expect(voided.statusCode).toBe(409);
    expect(voided.json().error.code).toBe('SALE_HAS_PAYMENT');

    const unapproved = await refundFromHistory(reception, foodSaleId, { actionId: newId() });
    expect(unapproved.statusCode).toBe(403);
    expect(unapproved.json().error.code).toBe('REFUND_APPROVAL_REQUIRED');

    const part = await refundFromHistory(manager, foodSaleId, { mode: 'custom', amountSatang: 2_000, actionId: newId() });
    expect(part.statusCode).toBe(409);
    expect(part.json().error.code).toBe('PART_PAID_REFUND_WHOLE_ONLY');
    expect((await saleRow(foodSaleId)).status).toBe('tendering');
    expect(await balanceOfWallet(walletId)).toBe(0);
  });

  it('a manager refunds it whole from History: the credit goes back on the wallet, the sale closes as void, the press replays', async () => {
    const actionId = newId();
    const refunded = await refundFromHistory(manager, foodSaleId, { actionId });
    expect(refunded.statusCode, refunded.body).toBe(200);
    const answer = refunded.json();
    expect(answer).toMatchObject({
      replay: false,
      refund: { amountSatang: 5_000, mode: 'whole' },
      sale: { status: 'voided' },
      refundStatus: 'refunded',
      refundableSatang: 0,
    });
    // Where the money went: the wallet it was spent from, nothing in cash.
    const slices = answer.refund.tenderAllocation as { route: string; status: string; amountSatang: number }[];
    expect(slices).toEqual([expect.objectContaining({ route: 'wallet', status: 'done', amountSatang: 5_000 })]);
    expect(await balanceOfWallet(walletId)).toBe(5_000);
    // A part-paid sale's lines carry no money on the refund; nothing was issued for it.
    const lines = answer.refund.lines as { grossSatang: number }[];
    expect(lines.every((l) => l.grossSatang === 0)).toBe(true);
    expect((await saleRow(foodSaleId))).toMatchObject({ status: 'voided', voidReason: 'ZZ TEST guest could not pay the rest' });

    // The same press again is the refund it recorded, never a second one.
    const again = await refundFromHistory(manager, foodSaleId, { actionId });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ replay: true, refund: { id: answer.refund.id, number: answer.refund.number } });
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, foodSaleId))).toHaveLength(1);
    expect(await balanceOfWallet(walletId)).toBe(5_000);
  });

  it('a shop sale part-paid in cash goes the same way: the cash slice only, and Close Day then goes through', async () => {
    const { saleId, owed } = await shopOrder();
    const part = await finalise(saleId, { method: 'cash', kind: 'cash', amountSatang: 3_000, tenderedSatang: 3_000, actionId: newId() });
    expect(part.statusCode, part.body).toBe(200);
    expect(part.json()).toMatchObject({ finalised: false, outstandingSatang: owed - 3_000 });
    const listed = (await endOfDay(date)).openSales!.rows;
    expect(listed.find((r) => r.saleId === saleId)).toMatchObject({ kind: 'part_paid', counter: 'other', paidSatang: 3_000 });
    expect(listed.find((r) => r.saleId === foodSaleId)).toBeUndefined();

    const refunded = await refundFromHistory(manager, saleId, { actionId: newId() });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(refunded.json().refund.amountSatang).toBe(3_000);
    expect(refunded.json().refund.tenderAllocation).toEqual([expect.objectContaining({ route: 'cash', amountSatang: 3_000 })]);
    expect((await saleRow(saleId)).status).toBe('voided');

    expect((await endOfDay(date)).openSales!.rows.filter((r) => r.kind === 'part_paid')).toEqual([]);
    const closed = await closeDay(date);
    expect(closed.statusCode, closed.body).toBe(200);
    expect((closed.json() as EndOfDayRecord).closedAt).toBeTruthy();
  });
});

// =============================================================================

describe('SCRUM-891 — after the whole refund of a part-paid sale, the answer and the read agree', () => {
  type Read = { sale: { status: string; totals: { refundedSatang: number } }; refundStatus: string; refundableSatang: number };
  const readSale = async (saleId: string): Promise<Read> => {
    const res = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: manager } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Read;
  };
  const auditAfter = async (saleId: string) => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.refund')));
    expect(rows).toHaveLength(1);
    return rows[0]!.after as { refundStatus: string; refundedSatang: number };
  };

  it('a fully paid sale refunded whole reads refunded in the answer, the read and the audit', async () => {
    const { saleId, owed } = await shopOrder();
    const paid = await finalise(saleId, { method: 'cash', kind: 'cash', amountSatang: owed, tenderedSatang: owed, actionId: newId() });
    expect(paid.statusCode, paid.body).toBe(200);
    const refunded = await refundFromHistory(manager, saleId, { actionId: newId() });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(refunded.json()).toMatchObject({ refundStatus: 'refunded', refundableSatang: 0 });
    expect(await readSale(saleId)).toMatchObject({ refundStatus: 'refunded', refundableSatang: 0 });
    expect(await auditAfter(saleId)).toMatchObject({ refundStatus: 'refunded', refundedSatang: owed });
  });

  it('a part-paid sale refunded whole reads refunded the same way, its money unchanged', async () => {
    const { saleId, owed } = await shopOrder();
    const part = await finalise(saleId, { method: 'cash', kind: 'cash', amountSatang: 5_000, tenderedSatang: 5_000, actionId: newId() });
    expect(part.statusCode, part.body).toBe(200);
    expect(part.json()).toMatchObject({ finalised: false, outstandingSatang: owed - 5_000 });
    const refunded = await refundFromHistory(manager, saleId, { actionId: newId() });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(refunded.json()).toMatchObject({
      refund: { amountSatang: 5_000 },
      sale: { status: 'voided' },
      refundStatus: 'refunded',
      refundableSatang: 0,
    });
    // The read said partially_refunded here (50 of 175 in the proof): now it agrees with the answer.
    const read = await readSale(saleId);
    expect(read).toMatchObject({ sale: { status: 'voided', totals: { refundedSatang: 5_000 } }, refundStatus: 'refunded', refundableSatang: 0 });
    expect(await auditAfter(saleId)).toMatchObject({ refundStatus: 'refunded', refundedSatang: 5_000 });
    // Nothing about the money moved: the sale's own figures.
    expect(await saleRow(saleId)).toMatchObject({ status: 'voided', grossSatang: owed, refundedSatang: 5_000 });
  });
});
