import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { box, branch, factWalletLiabilityDaily, product, sale, station, wallet, walletEntry } from '@oto/db';
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
  creditRedeemedOn,
  debitWallet,
  expireWalletsForDay,
  reactivateWallet,
  runWalletLiabilityJob,
  writeWalletLiabilityFact,
  type WalletLiabilityDay,
} from '../src/services/wallet';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 3 — THE GATE'S FINAL CHECK, after the fix round for R1/R2/R2b.
 *
 * One scripted week at Central Floresta (X0..X6, X6 = today), with three
 * cross-day movements in it:
 *   - a spend in the LAST half hour of X1 (after midnight, before the 05:00
 *     day start) — filed under X1;
 *   - a tab rung on X1, paid from credit in the FIRST minute of X2 — filed X2;
 *   - a wallet granted TODAY paying a tab rung YESTERDAY through the real
 *     finalise route, then refunded in part — filed under today, in today's
 *     credit line and taken by today's expiry cut, nothing in yesterday's.
 * Every day's liability fact, the report and the End of day credit line are
 * checked against the ledger summed by hand, sign-exact; the fact writer
 * runs clean (no CHECK refusal) and its rerun writes nothing.
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
const X: string[] = [];
const ids: Record<string, string> = {};
let fries = 0;

const actor = () => ({ accountId: null, operatorId });
const SAME_DAY = { expiry: 'same_day' as const, expiryDays: null };
const startOf = (date: string) => businessDayEndsAt(addDaysToIsoDate(date, -1), tz, dayStart);
const at = (date: string, hours: number) => new Date(startOf(date).getTime() + hours * 3_600_000);
const endOf = (date: string) => businessDayEndsAt(date, tz, dayStart);
const afterEnd = (date: string) => new Date(endOf(date).getTime() + 60_000);
const row = async (id: string) => (await ctx.db.select().from(wallet).where(eq(wallet.id, id)))[0]!;

async function grant(date: string, amountSatang: number, when: Date, policy: { expiry: 'same_day' | 'days_n' | 'never'; expiryDays: number | null } = SAME_DAY) {
  const qr = mintVoucherQr();
  const made = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, actor(), {
      actionId: `fin:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qr }],
      businessDate: date,
      expiresAt: grantExpiresAt(policy, date, tz, dayStart),
      now: when,
    }),
  );
  return { id: made.wallet.id, qr };
}

/** A spend with NO business date passed — the ledger must take the clock's day of `when`. */
const spend = (walletId: string, amountSatang: number, when: Date, source: 'fnb_order' | 'refund' = 'fnb_order', saleId: string | null = null) =>
  ctx.db.transaction((tx) => debitWallet(tx, actor(), { walletId, actionId: `fin:${newId()}`, amountSatang, source, branchId, saleId, now: when }));

const reactivate = (walletId: string, when: Date) =>
  ctx.db.transaction((tx) => reactivateWallet(tx, actor(), { walletId, reason: 'Guest came back', now: when }));

async function tab(quantity: number, rungOn: string, pickupCode: string): Promise<string> {
  const saleId = newId();
  const committed = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode, items: [{ id: newId(), productId: friesId, quantity }] },
  });
  expect(committed.statusCode, committed.body).toBe(200);
  await ctx.db.update(sale).set({ businessDate: rungOn }).where(eq(sale.id, saleId));
  return saleId;
}

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
  const [f] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'FB-FRIES'), isNull(product.archivedAt)));
  friesId = f!.id;
  const today = businessDateOf(new Date(), tz, dayStart);
  for (let i = 6; i >= 0; i -= 1) X.push(addDaysToIsoDate(today, -i));
  const [X0, X1, X2, X3, X4, X5, X6] = X as [string, string, string, string, string, string, string];

  // X0: A ฿300 same-day, ฿100 at F&B; day end takes ฿200.
  const A = await grant(X0, 30_000, at(X0, 7));
  ids.A = A.id;
  await spend(A.id, 10_000, at(X0, 8));
  await expireWalletsForDay(ctx.db, branchId, X0, afterEnd(X0));

  // X1: A reactivated (฿200); B ฿500 days_n 3; B ฿50 at 13:00; B ฿30 at 04:30 the next
  // calendar morning — still X1's trading day. The X1 job crashes and reruns.
  await reactivate(A.id, at(X1, 7));
  const B = await grant(X1, 50_000, at(X1, 7.5), { expiry: 'days_n', expiryDays: 3 });
  ids.B = B.id;
  await spend(B.id, 5_000, at(X1, 8));
  await spend(B.id, 3_000, new Date(endOf(X1).getTime() - 30 * 60_000));
  await expireWalletsForDay(ctx.db, branchId, X1, afterEnd(X1));
  await expireWalletsForDay(ctx.db, branchId, X1, new Date(afterEnd(X1).getTime() + 3_600_000));

  // X2: a tab rung on X1, paid from B in X2's first minute (filed X2); a ฿20 release debit.
  const lateTab = await tab(1, X1, '61');
  ids.lateTab = lateTab;
  await spend(B.id, 12_000, new Date(endOf(X1).getTime() + 60_000), 'fnb_order', lateTab);
  await spend(B.id, 2_000, at(X2, 7), 'refund');
  await expireWalletsForDay(ctx.db, branchId, X2, afterEnd(X2));

  // X3: C ฿100 same-day; day end takes B's ฿280 and C's ฿100.
  const C = await grant(X3, 10_000, at(X3, 7));
  ids.C = C.id;
  await expireWalletsForDay(ctx.db, branchId, X3, afterEnd(X3));

  // X4: B reactivated (฿280), ฿80 at F&B, day end takes ฿200.
  await reactivate(B.id, at(X4, 7));
  await spend(B.id, 8_000, at(X4, 8));
  await expireWalletsForDay(ctx.db, branchId, X4, afterEnd(X4));

  // X5 (yesterday): a tab rung, unpaid.
  const yTab = await tab(1, X5, '62');
  ids.yTab = yTab;

  // X6 (today): D granted now pays yesterday's tab through the counter; ฿30 refunded back.
  const D = await grant(X6, 20_000, new Date());
  ids.D = D.id;
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${yTab}/finalise`,
    headers: { cookie: reception },
    payload: { wallet: { key: D.qr, useCredit: true }, actionId: newId() },
  });
  expect(paid.statusCode, paid.body).toBe(200);
  fries = -(await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, D.id), eq(walletEntry.kind, 'spend'))))[0]!.amountSatang;
  const refunded = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${yTab}/refunds`,
    headers: { cookie: manager },
    payload: { mode: 'custom', amountSatang: 3_000, reason: 'Cold', actionId: newId() },
  });
  expect(refunded.statusCode, refunded.body).toBe(200);
  // The late job catches up yesterday: D is today's credit, nothing of it goes.
  await expireWalletsForDay(ctx.db, branchId, X5, new Date());
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function handSum(date: string): Promise<Omit<WalletLiabilityDay, 'branchId' | 'businessDate'>> {
  const all = await ctx.db.select().from(walletEntry);
  const on = all.filter((e) => e.businessDate === date);
  const sum = (kind: string) => on.filter((e) => e.kind === kind).reduce((s, e) => s + Math.abs(e.amountSatang), 0);
  return {
    grantedSatang: sum('grant'),
    spentSatang: sum('spend'),
    refundedSatang: sum('refund'),
    expiredSatang: sum('expire'),
    reactivatedSatang: sum('reactivate'),
    outstandingSatang: all.filter((e) => e.businessDate! <= date).reduce((s, e) => s + e.amountSatang, 0),
  };
}

describe('the cross-day movements are filed under the day the money moved', () => {
  it('every entry carries a business date; the late-night spend is X1, the first-minute tab payment X2, today’s D spend today', async () => {
    const all = await ctx.db.select().from(walletEntry);
    expect(all.every((e) => e.businessDate !== null)).toBe(true);
    const [, X1, X2, , , , X6] = X as [string, string, string, string, string, string, string];
    const bSpends = all.filter((e) => e.walletId === ids.B && e.kind === 'spend').map((e) => [e.amountSatang, e.businessDate]);
    expect(bSpends).toEqual(expect.arrayContaining([[-5_000, X1], [-3_000, X1], [-12_000, X2], [-2_000, X2]]));
    const late = all.find((e) => e.saleId === ids.lateTab)!;
    expect(late.businessDate).toBe(X2);
    const dSpend = all.find((e) => e.walletId === ids.D && e.kind === 'spend')!;
    expect(dSpend).toMatchObject({ businessDate: X6, saleId: ids.yTab });
    const dRefund = all.find((e) => e.walletId === ids.D && e.kind === 'refund')!;
    expect(dRefund).toMatchObject({ businessDate: X6, amountSatang: 3_000 });
    // balance == sum for every wallet
    for (const id of Object.values(ids).filter((v) => [ids.A, ids.B, ids.C, ids.D].includes(v))) {
      const total = all.filter((e) => e.walletId === id).reduce((s, e) => s + e.amountSatang, 0);
      expect((await row(id)).balanceSatang, id).toBe(total);
    }
  });

  it("D (granted today, paying yesterday's tab) is in today's figures and today's expiry cut, nowhere in yesterday's", async () => {
    const [, , , , , X5, X6] = X as [string, string, string, string, string, string, string];
    expect(fries).toBeGreaterThan(0);
    expect((await row(ids.D!)).balanceSatang).toBe(20_000 - fries + 3_000);
    const y = await creditRedeemedOn(ctx.db, operatorId, branchId, X5);
    expect(y).toMatchObject({ redeemedSatang: 0, restoredSatang: 0, netSatang: 0 });
    const t = await ctx.app.inject({ method: 'GET', url: `/wallets/credit-day?branchId=${branchId}&date=${X6}`, headers: { cookie: reception } });
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json()).toMatchObject({ redeemedSatang: fries, restoredSatang: 3_000, netSatang: fries - 3_000 });
    // The X5 catch-up took nothing of D; today's cut takes exactly what D holds.
    expect((await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, ids.D!), eq(walletEntry.kind, 'expire'))))).toHaveLength(0);
    const cut = await expireWalletsForDay(ctx.db, branchId, X6, afterEnd(X6));
    expect(cut.expiredSatang).toBe(20_000 - fries + 3_000);
    expect(await row(ids.D!)).toMatchObject({ balanceSatang: 0, status: 'expired' });
  });
});

describe('the liability fact across the scripted week', () => {
  it('writes clean for every day, matches the ledger summed by hand, reconciles sign-exact, and a rerun writes nothing', async () => {
    const [X0, X1, X2, X3, X4, X5, X6] = X as [string, string, string, string, string, string, string];
    const facts: WalletLiabilityDay[] = [];
    for (const d of X) {
      const w = await writeWalletLiabilityFact(ctx.db, branchId, d);
      expect(w.written, d).toBe(true);
      facts.push(w.fact);
      const { branchId: _b, businessDate: _d, ...figures } = w.fact;
      expect(figures, d).toEqual(await handSum(d));
    }
    const by = Object.fromEntries(facts.map((f) => [f.businessDate, f]));
    expect(by[X0]).toMatchObject({ grantedSatang: 30_000, spentSatang: 10_000, expiredSatang: 20_000, reactivatedSatang: 0, outstandingSatang: 0 });
    expect(by[X1]).toMatchObject({ grantedSatang: 50_000, spentSatang: 8_000, expiredSatang: 20_000, reactivatedSatang: 20_000, outstandingSatang: 42_000 });
    expect(by[X2]).toMatchObject({ grantedSatang: 0, spentSatang: 14_000, expiredSatang: 0, outstandingSatang: 28_000 });
    expect(by[X3]).toMatchObject({ grantedSatang: 10_000, expiredSatang: 38_000, outstandingSatang: 0 });
    expect(by[X4]).toMatchObject({ spentSatang: 8_000, expiredSatang: 20_000, reactivatedSatang: 28_000, outstandingSatang: 0 });
    expect(by[X5]).toMatchObject({ grantedSatang: 0, spentSatang: 0, refundedSatang: 0, expiredSatang: 0, reactivatedSatang: 0, outstandingSatang: 0 });
    expect(by[X6]).toMatchObject({ grantedSatang: 20_000, spentSatang: fries, refundedSatang: 3_000, expiredSatang: 20_000 - fries + 3_000, outstandingSatang: 0 });
    for (let i = 1; i < facts.length; i += 1) {
      const yd = facts[i - 1]!;
      const t = facts[i]!;
      expect(t.outstandingSatang, t.businessDate).toBe(
        yd.outstandingSatang + t.grantedSatang - t.spentSatang + t.refundedSatang - t.expiredSatang + t.reactivatedSatang,
      );
    }
    for (const d of X) expect((await writeWalletLiabilityFact(ctx.db, branchId, d)).written, d).toBe(false);
    // The job over every ended day: no branch-day refused.
    await ctx.db.delete(factWalletLiabilityDaily);
    const job = await runWalletLiabilityJob(ctx.db, new Date());
    expect(job.written).toBeGreaterThan(0);
    // The outstanding snapshot equals live balances.
    const { rows } = await ctx.db.execute<{ total: string }>(sql`select coalesce(sum(balance_satang),0)::bigint as total from pos.wallet where branch_id = ${branchId}`);
    expect(by[X6]!.outstandingSatang).toBe(Number(rows[0]!.total));
  });

  it('the report over the week and the End of day credit line agree with the facts', async () => {
    const [X0, X1, X2, , , , X6] = X as [string, string, string, string, string, string, string];
    const res = await ctx.app.inject({ method: 'GET', url: `/wallets/report?branchId=${branchId}&from=${X0}&to=${X6}&limit=500`, headers: { cookie: manager } });
    expect(res.statusCode, res.body).toBe(200);
    const { summary } = res.json();
    const facts = await ctx.db.select().from(factWalletLiabilityDaily);
    const week = await Promise.all(X.map((d) => handSum(d)));
    const total = (k: keyof Awaited<ReturnType<typeof handSum>>) => week.reduce((s, f) => s + f[k], 0);
    expect(summary).toMatchObject({
      grantedSatang: total('grantedSatang'),
      spentSatang: total('spentSatang'),
      refundedSatang: total('refundedSatang'),
      expiredSatang: total('expiredSatang'),
      reactivatedSatang: total('reactivatedSatang'),
      outstandingSatang: 0,
      ledgerOutstandingSatang: 0,
    });
    expect(facts.length).toBeGreaterThan(0);
    // EOD credit line: counter spends only (the release debit is not credit redeemed).
    expect(await creditRedeemedOn(ctx.db, operatorId, branchId, X1)).toMatchObject({ redeemedSatang: 8_000, netSatang: 8_000 });
    expect(await creditRedeemedOn(ctx.db, operatorId, branchId, X2)).toMatchObject({ redeemedSatang: 12_000, netSatang: 12_000 });
  });
});
