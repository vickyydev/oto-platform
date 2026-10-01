import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { box, branch, product, sale, station, wallet, walletEntry } from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate as businessDateOf,
  businessDayEndsAt,
  grantExpiresAt,
  mintVoucherQr,
  newId,
  parseDayStart,
} from '@oto/shared';
import { createWalletWithGrant, debitWallet, expireWalletsForDay, loadWallet } from '../src/services/wallet';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 3 — THE GATE'S REPRODUCTIONS (focused gate, invariants 1-2).
 *
 * G1-G3 were kept by the gate as `it.fails` — each states the CORRECT
 * behaviour and failed before the fix; the fix round flipped them to `it()`.
 * H1 is an attack that held.
 *
 *   (G1) credit survives its policy when the job is late and the wallet is
 *        loaded again before it catches up: `creditExpiresAt` reads only the
 *        LATEST grant's expiry, so the catch-up run for the missed day sees a
 *        later date and expires nothing — yesterday's same-day credit is
 *        spendable today.
 *   (G2) a refund restored onto a wallet the job already closed (status
 *        `expired`) is credit nobody can spend, nobody can reactivate and no
 *        job ever expires (the candidates are `status = 'active'` only) — a
 *        liability on the books for ever.
 *   (G3) reactivation brings back an OLD expiry's remainder after the wallet
 *        was loaded again and ran out — its own doc (and the POS view's
 *        `reactivatableSatang`, which answers null here) say "ran out before
 *        it expired: nothing to bring back".
 *   (H1) two concurrent reactivation presses write exactly one entry.
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
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const SAME_DAY = { expiry: 'same_day' as const, expiryDays: null };
const actor = () => ({ accountId: null, operatorId });
const today = () => businessDateOf(new Date(), tz, dayStart);
const noonOf = (date: string) => new Date(businessDayEndsAt(addDaysToIsoDate(date, -1), tz, dayStart).getTime() + 7 * 3_600_000);
const endOf = (date: string) => businessDayEndsAt(date, tz, dayStart);
const walletRow = async (id: string) => (await ctx.db.select().from(wallet).where(eq(wallet.id, id)))[0]!;
const entriesOf = (id: string) => ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, id));

async function grantOn(date: string, amountSatang: number) {
  const qr = mintVoucherQr();
  const made = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, actor(), {
      actionId: `g3:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang,
      source: 'prepaid_food',
      keys: [{ kind: 'voucher_qr', value: qr }],
      businessDate: date,
      expiresAt: grantExpiresAt(SAME_DAY, date, tz, dayStart),
      now: noonOf(date),
    }),
  );
  return { id: made.wallet.id, qr };
}

const loadOn = (walletId: string, date: string, amountSatang: number) =>
  ctx.db.transaction((tx) =>
    loadWallet(tx, actor(), {
      walletId,
      actionId: `g3:${newId()}`,
      amountSatang,
      source: 'prepaid_food',
      branchId,
      businessDate: date,
      expiresAt: grantExpiresAt(SAME_DAY, date, tz, dayStart),
      now: noonOf(date),
    }),
  );

const reactivate = (id: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/wallets/${id}/reactivate`, headers: { cookie: manager }, payload });

async function assertLedgerTruth(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
  }
}

describe('(G1) a late job and a reload', () => {
  it("yesterday's same-day credit still expires as yesterday's when the wallet was loaded again before the job caught up", async () => {
    const d1 = addDaysToIsoDate(today(), -12);
    const d2 = addDaysToIsoDate(d1, 1);
    const w = await grantOn(d1, 20_000);
    // The job is down across d1's end; the child is back at noon on d2 and loaded again.
    await loadOn(w.id, d2, 10_000);
    expect((await walletRow(w.id)).balanceSatang).toBe(30_000);
    // The job comes back an hour later and catches up the day it missed.
    const caughtUp = await expireWalletsForDay(ctx.db, branchId, d1, new Date(noonOf(d2).getTime() + 3_600_000));
    expect(caughtUp.ended).toBe(true);
    // d1's ฿200 was same-day credit: it ended with d1. Only d2's ฿100 is spendable on d2.
    expect((await walletRow(w.id)).balanceSatang).toBe(10_000);
    const expire = (await entriesOf(w.id)).find((e) => e.kind === 'expire');
    expect(expire).toMatchObject({ amountSatang: -20_000, businessDate: d1 });
    await assertLedgerTruth();
  });

  it("the counter's clock check agrees: before the job catches up, only today's load is spendable, and the view says how much has lapsed", async () => {
    const d2 = today();
    const d1 = addDaysToIsoDate(d2, -1);
    const w = await grantOn(d1, 20_000);
    await loadOn(w.id, d2, 10_000);
    // The view: ฿300 on it, ฿200 of which died with yesterday.
    const seen = await ctx.app.inject({ method: 'GET', url: `/wallets/lookup?key=${encodeURIComponent(w.qr)}`, headers: { cookie: reception } });
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json().wallet).toMatchObject({ status: 'active', balanceSatang: 30_000, lapsedSatang: 20_000 });
    // Two fries (฿180): an exact ฿150 is more than the ฿100 that is live — refused, nothing written.
    const saleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '33', items: [{ id: newId(), productId: friesId, quantity: 2 }] },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const before = (await entriesOf(w.id)).length;
    const tooMuch = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception },
      payload: { wallet: { key: w.qr, amountSatang: 15_000 }, actionId: newId() },
    });
    expect(tooMuch.statusCode, tooMuch.body).toBe(409);
    expect(tooMuch.json().error.code).toBe('WALLET_INSUFFICIENT');
    expect(tooMuch.json().error.message).toContain('฿100');
    expect((await entriesOf(w.id)).length).toBe(before);
    // "Use credit" takes the ฿100 that is live, not the ฿200 that died yesterday.
    const used = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception },
      payload: { wallet: { key: w.qr, useCredit: true }, actionId: newId() },
    });
    expect(used.statusCode, used.body).toBe(200);
    const spend = (await entriesOf(w.id)).find((e) => e.kind === 'spend');
    expect(spend?.amountSatang).toBe(-10_000);
    expect((await walletRow(w.id)).balanceSatang).toBe(20_000);
    // The job catches up yesterday: exactly yesterday's ฿200 goes, dated yesterday.
    const caughtUp = await expireWalletsForDay(ctx.db, branchId, d1, new Date());
    expect(caughtUp.ended).toBe(true);
    expect(await walletRow(w.id)).toMatchObject({ balanceSatang: 0, status: 'expired' });
    expect((await entriesOf(w.id)).find((e) => e.kind === 'expire')).toMatchObject({ amountSatang: -20_000, businessDate: d1 });
    await assertLedgerTruth();
  });
});

describe('(G2) a refund put back onto a wallet the job closed', () => {
  it('is expired by the next day end (or can be brought back) — never credit nobody can spend, reactivate or expire', async () => {
    const d = today();
    // A same-day wallet that pays an F&B order in full with its credit.
    const saleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '32', items: [{ id: newId(), productId: friesId, quantity: 1 }] },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const price = Number((await ctx.db.select().from(sale).where(eq(sale.id, saleId)))[0]!.grossSatang);
    expect(price).toBeGreaterThan(0);
    const qr = mintVoucherQr();
    const made = await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, actor(), {
        actionId: `g3:${newId()}`, branchId, holderName: 'Walk-in guest', amountSatang: price, source: 'ticket_sale',
        keys: [{ kind: 'voucher_qr', value: qr }], businessDate: d, expiresAt: grantExpiresAt(SAME_DAY, d, tz, dayStart),
      }),
    );
    const walletId = made.wallet.id;
    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception },
      payload: { wallet: { key: qr, useCredit: true }, actionId: newId() },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await walletRow(walletId)).balanceSatang).toBe(0);

    // The day ends: the job closes the empty wallet (no entry — no money moved).
    const closed = await expireWalletsForDay(ctx.db, branchId, d, new Date(endOf(d).getTime() + 60_000));
    expect(closed.closedAtZero).toBeGreaterThanOrEqual(1);
    expect((await walletRow(walletId)).status).toBe('expired');

    // The order is refunded: the credit goes back onto the SAME wallet (round 2's rule).
    const refunded = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/refunds`,
      headers: { cookie: manager },
      payload: { mode: 'custom', amountSatang: price, reason: 'Cold', actionId: newId() },
    });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(await walletRow(walletId)).toMatchObject({ status: 'expired', balanceSatang: price });
    await assertLedgerTruth();

    // Today: the counter refuses it (expired), and a manager is told there is nothing to bring back.
    const back = await reactivate(walletId, { reason: 'Refunded order' });
    const reactivated = back.statusCode === 200;
    // The next day ends.
    const next = addDaysToIsoDate(d, 1);
    await expireWalletsForDay(ctx.db, branchId, next, new Date(endOf(next).getTime() + 60_000));
    const after = await walletRow(walletId);
    // Correct: either a manager could bring it back, or the day end took it — never neither.
    expect(reactivated || after.balanceSatang === 0, `reactivate answered ${back.statusCode} ${back.body}; balance ${after.balanceSatang}, status ${after.status}`).toBe(true);
  });
});

describe('(G3) reactivation after a reload that ran out', () => {
  it("refuses: the wallet's last closing took nothing — an older expiry's remainder is not 'the expired remainder'", async () => {
    const d1 = addDaysToIsoDate(today(), -10);
    const d2 = addDaysToIsoDate(d1, 1);
    const w = await grantOn(d1, 5_000);
    await expireWalletsForDay(ctx.db, branchId, d1, new Date(endOf(d1).getTime() + 60_000));
    expect(await walletRow(w.id)).toMatchObject({ status: 'expired', balanceSatang: 0 });
    // d2: loaded again, all of it spent at F&B, closed at ฿0 by d2's end.
    await loadOn(w.id, d2, 3_000);
    await ctx.db.transaction((tx) =>
      debitWallet(tx, actor(), { walletId: w.id, actionId: `g3:${newId()}`, amountSatang: 3_000, source: 'fnb_order', branchId, businessDate: d2, now: noonOf(d2) }),
    );
    await expireWalletsForDay(ctx.db, branchId, d2, new Date(endOf(d2).getTime() + 60_000));
    expect(await walletRow(w.id)).toMatchObject({ status: 'expired', balanceSatang: 0 });

    const res = await reactivate(w.id, { reason: 'Asked at the desk' });
    // Today: 200 and ฿50 from d1 comes back. The view's own rule offers nothing here.
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NOTHING_TO_REACTIVATE');
    expect((await walletRow(w.id)).balanceSatang).toBe(0);
  });
});

describe('(H1) concurrent reactivation presses', () => {
  it('write exactly one reactivate entry, restoring exactly the expired remainder', async () => {
    const d = addDaysToIsoDate(today(), -8);
    const w = await grantOn(d, 8_000);
    await ctx.db.transaction((tx) =>
      debitWallet(tx, actor(), { walletId: w.id, actionId: `g3:${newId()}`, amountSatang: 1_500, source: 'fnb_order', branchId, businessDate: d, now: noonOf(d) }),
    );
    await expireWalletsForDay(ctx.db, branchId, d, new Date(endOf(d).getTime() + 60_000));
    expect(await walletRow(w.id)).toMatchObject({ status: 'expired', balanceSatang: 0 });
    const presses = await Promise.all([
      reactivate(w.id, { reason: 'Came back' }),
      reactivate(w.id, { reason: 'Came back' }),
      reactivate(w.id, { reason: 'Came back again' }),
    ]);
    for (const p of presses) expect(p.statusCode, p.body).toBe(200);
    const re = (await entriesOf(w.id)).filter((e) => e.kind === 'reactivate');
    expect(re).toHaveLength(1);
    expect(re[0]!.amountSatang).toBe(6_500);
    expect((await walletRow(w.id)).balanceSatang).toBe(6_500);
    await assertLedgerTruth();
  });
});
