import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { box, branch, product, sale, station, wallet, walletEntry, walletPolicy } from '@oto/db';
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
  lapsedCreditOf,
  loadWallet,
  walletLiabilityOf,
} from '../src/services/wallet';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 3 — THE GATE'S RE-CHECK (fix round). Attacks on invariants 1-3.
 *
 *   (R1) FIXED (round 3, fix round 3). A tab rung up before the boundary and
 *        paid with credit after it USED to file its spend under the SALE's
 *        business date (sale.ts passes `row.businessDate`): `debitForSale`
 *        decided what is spendable from ALL lots at "now" (so the spend took
 *        today's load), but the late job's catch-up of yesterday read only
 *        entries DATED through yesterday — so it counted that spend against
 *        yesterday's credit and expired too little. The wallet ledger now
 *        dates every entry by the day its money MOVES (`tradingDayAt` in
 *        wallet.ts; the attempt keeps the sale's day): the spend is today's,
 *        the catch-up takes yesterday's credit whole, nothing is left.
 *   (R2) FIXED. Same path, larger spend: the wallet's ledger dated through
 *        yesterday summed NEGATIVE — the daily liability fact for that day
 *        read below zero (the fact's CHECK refused it and `job:wallet.liability`
 *        failed every tick for a week). Dated by the clock, it never does.
 *   (R2b) FIXED. Needs neither a reload nor a late job: a wallet granted
 *        TODAY pays a tab rung up yesterday; the ฿90 spend is filed under
 *        today, and yesterday's figures carry nothing of it.
 *   H-*  attacks that held: rerun after a crash writes nothing; a policy
 *        change mid-day binds only later grants; a grant in the day's last
 *        minute lives to the cutoff, not past it; reactivation without the
 *        permission / without a reason / replayed; restored = the expire's
 *        remainder, not the historic grant.
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

async function grantOn(date: string, amountSatang: number, at: Date = noonOf(date), policy: { expiry: 'same_day' | 'days_n' | 'never'; expiryDays: number | null } = SAME_DAY) {
  const qr = mintVoucherQr();
  const made = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, actor(), {
      actionId: `rc:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang,
      source: 'prepaid_food',
      keys: [{ kind: 'voucher_qr', value: qr }],
      businessDate: date,
      expiresAt: grantExpiresAt(policy, date, tz, dayStart),
      now: at,
    }),
  );
  return { id: made.wallet.id, qr };
}

const loadOn = (walletId: string, date: string, amountSatang: number, at: Date = noonOf(date)) =>
  ctx.db.transaction((tx) =>
    loadWallet(tx, actor(), {
      walletId,
      actionId: `rc:${newId()}`,
      amountSatang,
      source: 'prepaid_food',
      branchId,
      businessDate: date,
      expiresAt: grantExpiresAt(SAME_DAY, date, tz, dayStart),
      now: at,
    }),
  );

async function assertLedgerTruth(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
  }
}

/** An F&B tab rung up YESTERDAY (before the boundary) and still open: the sale carries yesterday's business date. */
async function tabFromYesterday(quantity: number, yesterday: string, pickupCode: string): Promise<string> {
  const saleId = newId();
  const committed = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode, items: [{ id: newId(), productId: friesId, quantity }] },
  });
  expect(committed.statusCode, committed.body).toBe(200);
  // The tab was opened before last night's boundary: its business day is yesterday.
  await ctx.db.update(sale).set({ businessDate: yesterday }).where(eq(sale.id, saleId));
  return saleId;
}

describe('(R1) a tab from yesterday paid with credit after a reload, the job late', () => {
  it("yesterday's same-day credit still dies whole: the catch-up must not count today's spend against it", async () => {
    const d2 = today();
    const d1 = addDaysToIsoDate(d2, -1);
    // Yesterday: ฿200 same-day credit. The job is down across yesterday's end.
    const w = await grantOn(d1, 20_000);
    // Today: the child is back and loaded ฿100.
    await loadOn(w.id, d2, 10_000, new Date());
    const saleId = await tabFromYesterday(2, d1, '41');
    // The counter offers only today's ฿100 (correct) and takes it.
    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception },
      payload: { wallet: { key: w.qr, useCredit: true }, actionId: newId() },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    const spend = (await entriesOf(w.id)).find((e) => e.kind === 'spend')!;
    expect(spend.amountSatang).toBe(-10_000);
    // Filed under the day the credit moved (today), not the tab's day — the
    // sale backlink and the attempt still carry yesterday.
    expect(spend.businessDate).toBe(d2);
    expect(spend.saleId).toBe(saleId);
    expect((await walletRow(w.id)).balanceSatang).toBe(20_000);
    // The job comes back and catches up yesterday.
    await expireWalletsForDay(ctx.db, branchId, d1, new Date());
    await assertLedgerTruth();
    const row = await walletRow(w.id);
    // Correct: yesterday's ฿200 died with yesterday and today's ฿100 was spent — nothing is left to spend.
    const spendable = row.balanceSatang - (await lapsedCreditOf(ctx.db, row, new Date()));
    expect(spendable, `balance ${row.balanceSatang}, status ${row.status}`).toBe(0);
  });
});

describe('(R2) the same path, a bigger spend: the day the ledger files it under goes negative', () => {
  it("the wallet's ledger through yesterday never reads below zero (the liability fact's outstanding)", async () => {
    const d2 = today();
    const d1 = addDaysToIsoDate(d2, -1);
    const w = await grantOn(d1, 5_000);
    await loadOn(w.id, d2, 20_000, new Date());
    const saleId = await tabFromYesterday(2, d1, '42');
    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception },
      payload: { wallet: { key: w.qr, useCredit: true }, actionId: newId() },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    const spent = -(await entriesOf(w.id)).find((e) => e.kind === 'spend')!.amountSatang;
    expect(spent).toBeGreaterThan(5_000);
    const { rows } = await ctx.db.execute<{ total: string }>(sql`
      select coalesce(sum(amount_satang), 0)::bigint as total from pos.wallet_entry
      where wallet_id = ${w.id} and coalesce(business_date, ${d2}::date) <= ${d1}::date`);
    expect(Number(rows[0]!.total), 'this wallet, dated through yesterday').toBeGreaterThanOrEqual(0);
    // And the branch's fact for yesterday is writable (no negative outstanding).
    expect((await walletLiabilityOf(ctx.db, branchId, d1)).outstandingSatang).toBeGreaterThanOrEqual(0);
  });
});

describe('(R2b) no reload, no late job: a wallet granted TODAY pays a tab rung up yesterday', () => {
  it("yesterday's figures never carry a spend of credit that did not exist until today", async () => {
    const d2 = today();
    const d1 = addDaysToIsoDate(d2, -1);
    const w = await grantOn(d2, 20_000, new Date());
    const saleId = await tabFromYesterday(1, d1, '43');
    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception },
      payload: { wallet: { key: w.qr, useCredit: true }, actionId: newId() },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    const { rows } = await ctx.db.execute<{ total: string }>(sql`
      select coalesce(sum(amount_satang), 0)::bigint as total from pos.wallet_entry
      where wallet_id = ${w.id} and coalesce(business_date, ${d2}::date) <= ${d1}::date`);
    // The wallet held nothing through yesterday; the ledger filed a ฿90 spend there.
    expect(Number(rows[0]!.total), 'this wallet, dated through yesterday').toBe(0);
  });
});

describe('(H) expiry truth that held', () => {
  it('a rerun after a crash mid-branch writes nothing new; balance stays the sum', async () => {
    const d = addDaysToIsoDate(today(), -20);
    const a = await grantOn(d, 7_000);
    const b = await grantOn(d, 3_000);
    const after = new Date(endOf(d).getTime() + 60_000);
    const first = await expireWalletsForDay(ctx.db, branchId, d, after);
    expect(first.expiredWallets).toBeGreaterThanOrEqual(2);
    const count = async () => (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(walletEntry))[0]!.n;
    const before = await count();
    const again = await expireWalletsForDay(ctx.db, branchId, d, new Date(after.getTime() + 3_600_000));
    expect(again).toMatchObject({ expiredWallets: 0, expiredSatang: 0, closedAtZero: 0 });
    expect(await count()).toBe(before);
    expect((await walletRow(a.id)).balanceSatang).toBe(0);
    expect((await walletRow(b.id)).balanceSatang).toBe(0);
    await assertLedgerTruth();
  });

  it('a grant in the last minute of the day lives to the cutoff and not a second past it', async () => {
    const d = addDaysToIsoDate(today(), -22);
    const lastMinute = new Date(endOf(d).getTime() - 60_000);
    const w = await grantOn(d, 4_000, lastMinute);
    const row = await walletRow(w.id);
    expect(await lapsedCreditOf(ctx.db, row, new Date(endOf(d).getTime() - 1))).toBe(0);
    expect(await lapsedCreditOf(ctx.db, row, endOf(d))).toBe(4_000);
    await expireWalletsForDay(ctx.db, branchId, d, new Date(endOf(d).getTime() + 1));
    expect(await walletRow(w.id)).toMatchObject({ balanceSatang: 0, status: 'expired' });
  });

  it('a policy changed mid-day binds only the grants made after it', async () => {
    const d = addDaysToIsoDate(today(), -24);
    const before = await grantOn(d, 6_000, noonOf(d), SAME_DAY);
    // The office switches to `never` at 14:00; the next grant records no expiry.
    const after = await grantOn(d, 6_000, new Date(noonOf(d).getTime() + 2 * 3_600_000), { expiry: 'never', expiryDays: null });
    await expireWalletsForDay(ctx.db, branchId, d, new Date(endOf(d).getTime() + 60_000));
    expect(await walletRow(before.id)).toMatchObject({ balanceSatang: 0, status: 'expired' });
    expect(await walletRow(after.id)).toMatchObject({ balanceSatang: 6_000, status: 'active' });
    // Days later the `never` credit is still whole.
    await expireWalletsForDay(ctx.db, branchId, addDaysToIsoDate(d, 3), new Date(endOf(addDaysToIsoDate(d, 3)).getTime() + 60_000));
    expect((await walletRow(after.id)).balanceSatang).toBe(6_000);
    await assertLedgerTruth();
  });

  it('the live policy row the route reads is the seeded same_day', async () => {
    const [row] = await ctx.db.select().from(walletPolicy).where(eq(walletPolicy.branchId, branchId));
    const res = await ctx.app.inject({ method: 'GET', url: `/wallets/policy?branchId=${branchId}`, headers: { cookie: reception } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ expiry: row?.expiry ?? 'same_day' });
    expect(res.json().expiry).toBe('same_day');
  });
});

describe('(H) reactivation that held', () => {
  it('without the permission 403, without a reason 400, replayed once; restores the expire remainder, not the grant', async () => {
    const d = addDaysToIsoDate(today(), -26);
    const w = await grantOn(d, 9_000);
    await ctx.db.transaction((tx) =>
      debitWallet(tx, actor(), { walletId: w.id, actionId: `rc:${newId()}`, amountSatang: 2_500, source: 'fnb_order', branchId, businessDate: d, now: noonOf(d) }),
    );
    await expireWalletsForDay(ctx.db, branchId, d, new Date(endOf(d).getTime() + 60_000));
    expect(await walletRow(w.id)).toMatchObject({ balanceSatang: 0, status: 'expired' });
    const count = async () => (await entriesOf(w.id)).length;
    const n0 = await count();

    const counter = await ctx.app.inject({ method: 'POST', url: `/wallets/${w.id}/reactivate`, headers: { cookie: reception }, payload: { reason: 'Please' } });
    expect(counter.statusCode, counter.body).toBe(403);
    const blank = await ctx.app.inject({ method: 'POST', url: `/wallets/${w.id}/reactivate`, headers: { cookie: manager }, payload: { reason: '   ' } });
    expect(blank.statusCode, blank.body).toBe(400);
    expect(blank.json().error.code).toBe('REASON_REQUIRED');
    const none = await ctx.app.inject({ method: 'POST', url: `/wallets/${w.id}/reactivate`, headers: { cookie: manager }, payload: {} });
    expect(none.statusCode, none.body).toBe(400);
    expect(await count()).toBe(n0);

    const key = newId();
    const first = await ctx.app.inject({ method: 'POST', url: `/wallets/${w.id}/reactivate`, headers: { cookie: manager, 'idempotency-key': key }, payload: { reason: 'Guest came back' } });
    expect(first.statusCode, first.body).toBe(200);
    const sameKey = await ctx.app.inject({ method: 'POST', url: `/wallets/${w.id}/reactivate`, headers: { cookie: manager, 'idempotency-key': key }, payload: { reason: 'Guest came back' } });
    expect(sameKey.statusCode, sameKey.body).toBe(200);
    const newKey = await ctx.app.inject({ method: 'POST', url: `/wallets/${w.id}/reactivate`, headers: { cookie: manager }, payload: { reason: 'Pressed twice' } });
    expect(newKey.statusCode, newKey.body).toBe(200);
    expect(newKey.json().replayed).toBe(true);
    const re = (await entriesOf(w.id)).filter((e) => e.kind === 'reactivate');
    expect(re).toHaveLength(1);
    expect(re[0]!.amountSatang).toBe(6_500); // the remainder, not the ฿90 grant
    expect((await walletRow(w.id)).balanceSatang).toBe(6_500);
    const { rows } = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from core.audit_log where entity_id = ${w.id} and action = 'wallet.reactivate' and after->>'reason' = 'Guest came back'`);
    expect(rows[0]!.n).toBe(1);
    await assertLedgerTruth();
  });
});
