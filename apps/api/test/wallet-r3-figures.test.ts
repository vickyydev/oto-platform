import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { box, branch, factWalletLiabilityDaily, product, station, wallet, walletEntry } from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate as businessDateOf,
  businessDayEndsAt,
  grantExpiresAt,
  mintVoucherQr,
  newId,
  parseDayStart,
} from '@oto/shared';
import {
  createWalletWithGrant,
  debitWallet,
  expireWalletsForDay,
  reactivateWallet,
  runWalletExpiryJob,
  runWalletLiabilityJob,
  walletLiabilityOf,
  writeWalletLiabilityFact,
} from '../src/services/wallet';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 3 — THE FIGURES (plan §2.5): the Wallet & Promo report, the
 * End of day `credit` line and `analytics.fact_wallet_liability_daily`, on a
 * ledger whose every entry this file wrote, so each figure can be summed by
 * hand.
 *
 * The story, at Central Floresta, over four business days (D1..D3 ended,
 * D4 = today):
 *
 *   D1  W1 granted ฿500 (same day) · W1 spends ฿120 at F&B · W2 granted
 *       ฿200 (days_n 2) · D1 ends: W1's ฿380 expires
 *   D2  W2 spends ฿50 at F&B · a manager reactivates W1's ฿380 · W1's
 *       unused food ฿30 handed back in cash (a release debit) · D2 ends:
 *       W1's ฿350 and W2's ฿150 expire
 *   D3  nothing
 *   D4  W3 granted ฿100 · an F&B order of ฿90 paid from W3 · ฿30 of it
 *       refunded back onto W3
 *
 * and the reconciliation, sign-exact for every day:
 *
 *   outstanding(D) = outstanding(D-1) + granted - spent + refunded - expired + reactivated
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let tz: string;
let dayStart: number;
let stationId: string;
let friesId: string;
let D0: string;
let D1: string;
let D2: string;
let D3: string;
let D4: string;
const W: Record<string, { id: string; qr: string }> = {};

const actor = () => ({ accountId: null, operatorId });
const noonOf = (date: string) => new Date(businessDayEndsAt(addDaysToIsoDate(date, -1), tz, dayStart).getTime() + 7 * 3_600_000);
const endOf = (date: string) => businessDayEndsAt(date, tz, dayStart);
const balance = async (id: string) => (await ctx.db.select().from(wallet).where(eq(wallet.id, id)))[0]!.balanceSatang;

async function grantOn(date: string | null, amountSatang: number, policy: { expiry: 'same_day' | 'days_n' | 'never'; expiryDays: number | null }) {
  const qr = mintVoucherQr();
  const at = date ? noonOf(date) : new Date();
  const day = date ?? businessDateOf(at, tz, dayStart);
  const made = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, actor(), {
      actionId: `fig:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qr }],
      businessDate: day,
      expiresAt: grantExpiresAt(policy, day, tz, dayStart),
      now: at,
    }),
  );
  return { id: made.wallet.id, qr };
}

const spendOn = (walletId: string, date: string, amountSatang: number, source: 'fnb_order' | 'refund') =>
  ctx.db.transaction((tx) =>
    debitWallet(tx, actor(), { walletId, actionId: `fig:${newId()}`, amountSatang, source, branchId, businessDate: date, now: noonOf(date) }),
  );

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  tz = hkt!.timezone;
  dayStart = parseDayStart(hkt!.businessDayStart);
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, till!.boxId!));
  const [fries] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'FB-FRIES'), isNull(product.archivedAt)));
  friesId = fries!.id;
  D4 = businessDateOf(new Date(), tz, dayStart);
  D3 = addDaysToIsoDate(D4, -1);
  D2 = addDaysToIsoDate(D4, -2);
  D1 = addDaysToIsoDate(D4, -3);
  D0 = addDaysToIsoDate(D4, -4);

  // D1
  W.one = await grantOn(D1, 50_000, { expiry: 'same_day', expiryDays: null });
  await spendOn(W.one.id, D1, 12_000, 'fnb_order');
  W.two = await grantOn(D1, 20_000, { expiry: 'days_n', expiryDays: 2 });
  await expireWalletsForDay(ctx.db, branchId, D1, new Date(endOf(D1).getTime() + 60_000));
  // D2
  await spendOn(W.two.id, D2, 5_000, 'fnb_order');
  await ctx.db.transaction((tx) => reactivateWallet(tx, actor(), { walletId: W.one!.id, reason: 'Came back', now: noonOf(D2) }));
  await ctx.db.transaction((tx) =>
    debitWallet(tx, actor(), { walletId: W.one!.id, actionId: `fig:${newId()}`, amountSatang: 3_000, source: 'refund', branchId, businessDate: D2, now: new Date(noonOf(D2).getTime() + 60_000) }),
  );
  await expireWalletsForDay(ctx.db, branchId, D2, new Date(endOf(D2).getTime() + 60_000));
  // D4 — the real counter: credit pays a ฿90 order, ฿30 of it refunded back.
  W.three = await grantOn(null, 10_000, { expiry: 'same_day', expiryDays: null });
  const saleId = newId();
  const committed = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '7', items: [{ id: newId(), productId: friesId, quantity: 1 }] },
  });
  expect(committed.statusCode, committed.body).toBe(200);
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: reception },
    payload: { wallet: { key: W.three.qr, useCredit: true }, actionId: newId() },
  });
  expect(paid.statusCode, paid.body).toBe(200);
  expect(paid.json().finalised).toBe(true);
  const refunded = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/refunds`,
    headers: { cookie: manager },
    payload: { mode: 'custom', amountSatang: 3_000, reason: 'Cold', actionId: newId() },
  });
  expect(refunded.statusCode, refunded.body).toBe(200);
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the story wrote what it says', () => {
  it('balances', async () => {
    expect(await balance(W.one!.id)).toBe(0);
    expect(await balance(W.two!.id)).toBe(0);
    expect(await balance(W.three!.id)).toBe(4_000);
  });
});

describe('the daily liability fact', () => {
  it('each day by hand, and the reconciliation sign-exact across every day', async () => {
    const days = [D0, D1, D2, D3, D4];
    const facts = [];
    for (const d of days) facts.push((await writeWalletLiabilityFact(ctx.db, branchId, d)).fact);
    const [f0, f1, f2, f3, f4] = facts as [typeof facts[0], typeof facts[0], typeof facts[0], typeof facts[0], typeof facts[0]];

    expect(f0).toMatchObject({ grantedSatang: 0, spentSatang: 0, refundedSatang: 0, expiredSatang: 0, reactivatedSatang: 0, outstandingSatang: 0 });
    expect(f1).toMatchObject({ grantedSatang: 70_000, spentSatang: 12_000, refundedSatang: 0, expiredSatang: 38_000, reactivatedSatang: 0, outstandingSatang: 20_000 });
    expect(f2).toMatchObject({ grantedSatang: 0, spentSatang: 8_000, refundedSatang: 0, expiredSatang: 50_000, reactivatedSatang: 38_000, outstandingSatang: 0 });
    expect(f3).toMatchObject({ grantedSatang: 0, spentSatang: 0, expiredSatang: 0, outstandingSatang: 0 });
    expect(f4).toMatchObject({ grantedSatang: 10_000, spentSatang: 9_000, refundedSatang: 3_000, expiredSatang: 0, reactivatedSatang: 0, outstandingSatang: 4_000 });

    for (let i = 1; i < facts.length; i += 1) {
      const y = facts[i - 1]!;
      const t = facts[i]!;
      expect(t.outstandingSatang, `${t.businessDate}`).toBe(
        y.outstandingSatang + t.grantedSatang - t.spentSatang + t.refundedSatang - t.expiredSatang + t.reactivatedSatang,
      );
    }
    // Today's outstanding is the live balances' sum.
    const { rows } = await ctx.db.execute<{ total: string }>(sql`select coalesce(sum(balance_satang),0)::bigint as total from pos.wallet where branch_id = ${branchId}`);
    expect(f4.outstandingSatang).toBe(Number(rows[0]!.total));
  });

  it('the job writes the ended days once: idempotent per branch and date, a rerun writes nothing', async () => {
    await ctx.db.delete(factWalletLiabilityDaily);
    const first = await runWalletLiabilityJob(ctx.db, new Date());
    expect(first.written).toBeGreaterThan(0);
    const again = await runWalletLiabilityJob(ctx.db, new Date());
    expect(again.written).toBe(0);
    const rows = await ctx.db.select().from(factWalletLiabilityDaily).where(eq(factWalletLiabilityDaily.branchId, branchId));
    const dates = rows.map((r) => r.businessDate);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates).toContain(D1);
    expect(dates).not.toContain(D4); // today has not ended
    const d1 = rows.find((r) => r.businessDate === D1)!;
    expect(d1).toMatchObject({ grantedSatang: 70_000, spentSatang: 12_000, expiredSatang: 38_000, outstandingSatang: 20_000 });
    // The expiry job's rerun over the same days writes nothing new either.
    const entries = async () => (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(walletEntry))[0]!.n;
    const before = await entries();
    expect(await runWalletExpiryJob(ctx.db, new Date())).toMatchObject({ expiredWallets: 0, closedAtZero: 0 });
    expect(await entries()).toBe(before);
    // And the fact for a day matches a fresh computation of it.
    expect(await walletLiabilityOf(ctx.db, branchId, D2)).toMatchObject({ outstandingSatang: 0, reactivatedSatang: 38_000 });
  });
});

describe('the Wallet & Promo report', () => {
  it('equals the entries summed by hand, and its outstanding snapshot equals the ledger', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/wallets/report?branchId=${branchId}&from=${D1}&to=${D4}&limit=500`, headers: { cookie: manager } });
    expect(res.statusCode, res.body).toBe(200);
    const { summary, rows } = res.json();

    // By hand, from every entry the story wrote.
    const all = await ctx.db.select().from(walletEntry);
    const sum = (kind: string) => all.filter((e) => e.kind === kind).reduce((s, e) => s + Math.abs(e.amountSatang), 0);
    expect(summary).toMatchObject({
      grantedSatang: sum('grant'),
      spentSatang: sum('spend'),
      refundedSatang: sum('refund'),
      expiredSatang: sum('expire'),
      reactivatedSatang: sum('reactivate'),
      entryCount: all.length,
    });
    expect(summary).toMatchObject({ grantedSatang: 80_000, spentSatang: 29_000, refundedSatang: 3_000, expiredSatang: 88_000, reactivatedSatang: 38_000 });
    expect(summary.outstandingSatang).toBe(4_000);
    expect(summary.ledgerOutstandingSatang).toBe(summary.outstandingSatang);
    expect(all.reduce((s, e) => s + e.amountSatang, 0)).toBe(summary.outstandingSatang);
    expect(rows).toHaveLength(all.length);
    expect(rows[0]).toMatchObject({ businessDate: D4 });
    for (const r of rows) expect(r.keyDisplay).toMatch(/^QR-/);

    // A one-day range sums that day only.
    const one = await ctx.app.inject({ method: 'GET', url: `/wallets/report?branchId=${branchId}&from=${D2}&to=${D2}`, headers: { cookie: manager } });
    expect(one.json().summary).toMatchObject({ grantedSatang: 0, spentSatang: 8_000, expiredSatang: 50_000, reactivatedSatang: 38_000 });
    // Without a branch: the parks this account reads reports for — Central Floresta's figures.
    const mine = await ctx.app.inject({ method: 'GET', url: `/wallets/report?from=${D1}&to=${D4}`, headers: { cookie: manager } });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().summary.grantedSatang).toBe(80_000);
    // The counter does not read reports.
    const counter = await ctx.app.inject({ method: 'GET', url: `/wallets/report?branchId=${branchId}&from=${D1}&to=${D4}`, headers: { cookie: reception } });
    expect(counter.statusCode).toBe(403);
  });
});

describe('the End of day credit line', () => {
  it('credit redeemed at the counters on the business date, net of restores of those spends', async () => {
    const today = await ctx.app.inject({ method: 'GET', url: `/wallets/credit-day?branchId=${branchId}&date=${D4}`, headers: { cookie: reception } });
    expect(today.statusCode, today.body).toBe(200);
    expect(today.json()).toMatchObject({ redeemedSatang: 9_000, restoredSatang: 3_000, netSatang: 6_000 });
    // D2: W2's ฿50 at F&B; W1's cash hand-back is not counter credit.
    const d2 = await ctx.app.inject({ method: 'GET', url: `/wallets/credit-day?branchId=${branchId}&date=${D2}`, headers: { cookie: reception } });
    expect(d2.json()).toMatchObject({ redeemedSatang: 5_000, restoredSatang: 0, netSatang: 5_000 });
    const quiet = await ctx.app.inject({ method: 'GET', url: `/wallets/credit-day?branchId=${branchId}&date=${D3}`, headers: { cookie: reception } });
    expect(quiet.json()).toMatchObject({ redeemedSatang: 0, netSatang: 0 });
  });
});
