import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, box, branch, product, role, rolePermission, station, ticketPackage, wallet, walletEntry, walletPolicy } from '@oto/db';
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
  expiryActionId,
  runWalletExpiryJob,
} from '../src/services/wallet';
import { BRANCH_MANAGER, CHALONG_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 3 — expiry, reactivation and the Wallet view's reads (plan
 * docs/progress/plans/wallet/PLAN.md §2.5).
 *
 *   - expiry across the three policies (same_day, days_n, never), including
 *     the boundary instant and the days_n last day;
 *   - the day-end job rerun writes nothing new;
 *   - grants record their expiry from the policy in force when they are made;
 *   - an expired wallet — by status, or by the clock before the job ran —
 *     refuses spend in the counter's words, writing nothing;
 *   - reactivation: happy (exactly the expired remainder, audited with the
 *     reason), replay, 403 without the permission, 400 without a reason,
 *     409 when nothing expired;
 *   - the lookup's permission.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let chalongManager: string;
let operatorId: string;
let branchId: string;
let tz: string;
let dayStart: number;
let stationId: string;
let friesId: string;
let twoHoursId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
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
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const actor = () => ({ accountId: null, operatorId });
const today = () => businessDateOf(new Date(), tz, dayStart);
/** Noon on a business date at the branch: well inside its day. */
const noonOf = (date: string) => new Date(businessDayEndsAt(addDaysToIsoDate(date, -1), tz, dayStart).getTime() + 7 * 3_600_000);
const endOf = (date: string) => businessDayEndsAt(date, tz, dayStart);

async function grantOn(date: string, amountSatang: number, policy: { expiry: 'same_day' | 'days_n' | 'never'; expiryDays: number | null }) {
  const qr = mintVoucherQr();
  const made = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, actor(), {
      actionId: `r3:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qr }],
      businessDate: date,
      expiresAt: grantExpiresAt(policy, date, tz, dayStart),
      now: noonOf(date),
    }),
  );
  return { id: made.wallet.id, qr };
}

const walletRow = async (id: string) => (await ctx.db.select().from(wallet).where(eq(wallet.id, id)))[0]!;
const entriesOf = (id: string) => ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, id));

async function assertLedgerTruth(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
  }
}

async function fnbOrder(): Promise<string> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '12', items: [{ id: newId(), productId: friesId, quantity: 1 }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return saleId;
}

const finalise = (saleId: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload });
const reactivate = (id: string, cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/wallets/${id}/reactivate`, headers: { cookie }, payload });

describe('expiry follows the policy each grant recorded', () => {
  it('same_day: nothing before the boundary, the remainder at it — an expire entry dated that day, the wallet closed', async () => {
    const d = addDaysToIsoDate(today(), -20);
    const w = await grantOn(d, 50_000, { expiry: 'same_day', expiryDays: null });
    await ctx.db.transaction((tx) =>
      debitWallet(tx, actor(), { walletId: w.id, actionId: `r3:${newId()}`, amountSatang: 12_000, source: 'fnb_order', branchId, businessDate: d, now: noonOf(d) }),
    );
    // One millisecond before the day ends: the day has not ended, nothing is looked at.
    const early = await expireWalletsForDay(ctx.db, branchId, d, new Date(endOf(d).getTime() - 1));
    expect(early).toMatchObject({ ended: false, expiredWallets: 0 });
    expect((await walletRow(w.id)).status).toBe('active');
    // At the boundary instant.
    const done = await expireWalletsForDay(ctx.db, branchId, d, endOf(d));
    expect(done.ended).toBe(true);
    expect(done.expiredSatang).toBeGreaterThanOrEqual(38_000);
    const row = await walletRow(w.id);
    expect(row).toMatchObject({ status: 'expired', balanceSatang: 0 });
    const expire = (await entriesOf(w.id)).find((e) => e.kind === 'expire')!;
    expect(expire).toMatchObject({ source: 'expiry', amountSatang: -38_000, businessDate: d, balanceAfter: 0, actionId: expiryActionId(branchId, d, w.id) });
    await assertLedgerTruth();
  });

  it('days_n (2): untouched at the first day’s end, expired at the last day’s end (the boundary day)', async () => {
    const d = addDaysToIsoDate(today(), -30);
    const w = await grantOn(d, 20_000, { expiry: 'days_n', expiryDays: 2 });
    await expireWalletsForDay(ctx.db, branchId, d, endOf(d));
    expect(await walletRow(w.id)).toMatchObject({ status: 'active', balanceSatang: 20_000 });
    const last = addDaysToIsoDate(d, 1);
    // A millisecond before the last day ends it is still spendable.
    expect((await expireWalletsForDay(ctx.db, branchId, last, new Date(endOf(last).getTime() - 1))).ended).toBe(false);
    await expireWalletsForDay(ctx.db, branchId, last, endOf(last));
    expect(await walletRow(w.id)).toMatchObject({ status: 'expired', balanceSatang: 0 });
    const expire = (await entriesOf(w.id)).find((e) => e.kind === 'expire')!;
    expect(expire).toMatchObject({ amountSatang: -20_000, businessDate: last });
    await assertLedgerTruth();
  });

  it('never: no expiry recorded, no day end touches it', async () => {
    const d = addDaysToIsoDate(today(), -40);
    const w = await grantOn(d, 7_000, { expiry: 'never', expiryDays: null });
    expect((await entriesOf(w.id))[0]!.expiresAt).toBeNull();
    for (const day of [d, addDaysToIsoDate(d, 1), addDaysToIsoDate(d, 35)]) {
      await expireWalletsForDay(ctx.db, branchId, day, endOf(day));
    }
    expect(await walletRow(w.id)).toMatchObject({ status: 'active', balanceSatang: 7_000 });
    expect((await entriesOf(w.id)).some((e) => e.kind === 'expire')).toBe(false);
  });

  it('a wallet already at ฿0 is closed without an entry; the rerun writes nothing new', async () => {
    const d = addDaysToIsoDate(today(), -5);
    const spent = await grantOn(d, 3_000, { expiry: 'same_day', expiryDays: null });
    await ctx.db.transaction((tx) =>
      debitWallet(tx, actor(), { walletId: spent.id, actionId: `r3:${newId()}`, amountSatang: 3_000, source: 'fnb_order', branchId, businessDate: d, now: noonOf(d) }),
    );
    const left = await grantOn(d, 4_000, { expiry: 'same_day', expiryDays: null });
    const first = await runWalletExpiryJob(ctx.db, new Date());
    expect(first.expiredWallets).toBeGreaterThanOrEqual(1);
    expect(await walletRow(spent.id)).toMatchObject({ status: 'expired', balanceSatang: 0 });
    expect((await entriesOf(spent.id)).some((e) => e.kind === 'expire')).toBe(false);
    expect(await walletRow(left.id)).toMatchObject({ status: 'expired', balanceSatang: 0 });

    const count = async () => {
      const entries = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(walletEntry);
      const audits = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eq(auditLog.entityType, 'wallet'));
      return { entries: entries[0]!.n, audits: audits[0]!.n };
    };
    const before = await count();
    const again = await runWalletExpiryJob(ctx.db, new Date());
    expect(again).toMatchObject({ expiredWallets: 0, expiredSatang: 0, closedAtZero: 0 });
    expect(await expireWalletsForDay(ctx.db, branchId, d, new Date())).toMatchObject({ expiredWallets: 0, closedAtZero: 0 });
    expect(await count()).toEqual(before);
    await assertLedgerTruth();
  });

  it('a grant records the expiry of the policy in force when it is made', async () => {
    await ctx.db.update(walletPolicy).set({ expiry: 'days_n', expiryDays: 3 }).where(eq(walletPolicy.branchId, branchId));
    try {
      const saleId = newId();
      const committed = await ctx.app.inject({
        method: 'POST',
        url: '/sales',
        headers: { cookie: reception },
        payload: { id: saleId, stationId, lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] },
      });
      expect(committed.statusCode, committed.body).toBe(200);
      const done = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
      expect(done.statusCode, done.body).toBe(200);
      const grants = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.saleId, saleId), eq(walletEntry.kind, 'grant')));
      expect(grants.length).toBeGreaterThan(0);
      const expected = grantExpiresAt({ expiry: 'days_n', expiryDays: 3 }, grants[0]!.businessDate!, tz, dayStart);
      for (const g of grants) expect(g.expiresAt?.toISOString()).toBe(expected!.toISOString());
      // The policy read answers the rules in force.
      const policy = await ctx.app.inject({ method: 'GET', url: `/wallets/policy?branchId=${branchId}`, headers: { cookie: reception } });
      expect(policy.statusCode, policy.body).toBe(200);
      expect(policy.json()).toMatchObject({ branchId, expiry: 'days_n', expiryDays: 3, offlineCapSatang: 30_000 });
    } finally {
      await ctx.db.update(walletPolicy).set({ expiry: 'same_day', expiryDays: null }).where(eq(walletPolicy.branchId, branchId));
    }
  });
});

describe('an expired wallet refuses spend in the counter’s words', () => {
  it('expired by the job, and expired by the clock before the job ran: 409 WALLET_EXPIRED, nothing written', async () => {
    const d = addDaysToIsoDate(today(), -3);
    const byJob = await grantOn(d, 5_000, { expiry: 'same_day', expiryDays: null });
    await expireWalletsForDay(ctx.db, branchId, d, endOf(d));
    expect((await walletRow(byJob.id)).status).toBe('expired');

    // Granted today with an expiry that has already passed, status still active.
    const qr = mintVoucherQr();
    const made = await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, actor(), {
        actionId: `r3:${newId()}`, branchId, holderName: 'Walk-in guest', amountSatang: 5_000, source: 'ticket_sale',
        keys: [{ kind: 'voucher_qr', value: qr }], expiresAt: new Date(Date.now() - 60_000),
      }),
    );
    const byClock = { id: made.wallet.id, qr };

    for (const w of [byJob, byClock]) {
      const before = await entriesOf(w.id);
      const saleId = await fnbOrder();
      const res = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('WALLET_EXPIRED');
      expect(res.json().error.message).toMatch(/expired .*only a manager can bring it back/);
      expect(await entriesOf(w.id)).toHaveLength(before.length);
    }
    await assertLedgerTruth();
  });
});

describe('reactivation', () => {
  it('a manager brings back exactly the expired remainder, with a reason, audited; a replay adds nothing', async () => {
    const d = addDaysToIsoDate(today(), -2);
    const w = await grantOn(d, 30_000, { expiry: 'same_day', expiryDays: null });
    await ctx.db.transaction((tx) =>
      debitWallet(tx, actor(), { walletId: w.id, actionId: `r3:${newId()}`, amountSatang: 4_500, source: 'fnb_order', branchId, businessDate: d, now: noonOf(d) }),
    );
    await expireWalletsForDay(ctx.db, branchId, d, endOf(d));
    expect(await walletRow(w.id)).toMatchObject({ status: 'expired', balanceSatang: 0 });

    const res = await reactivate(w.id, manager, { reason: 'Guest came back the next morning' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.wallet).toMatchObject({ id: w.id, status: 'active', balanceSatang: 25_500 });
    expect(Date.parse(body.wallet.expiresAt)).toBeGreaterThan(Date.now());
    const entry = (await entriesOf(w.id)).find((e) => e.kind === 'reactivate')!;
    expect(entry).toMatchObject({ source: 'reactivation', amountSatang: 25_500, balanceAfter: 25_500, businessDate: today() });
    expect(entry.payload).toMatchObject({ reason: 'Guest came back the next morning' });
    expect(entry.actorAccountId).not.toBeNull();
    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, w.id), eq(auditLog.action, 'wallet.reactivate')));
    expect(audited!.before).toMatchObject({ balanceSatang: 0, status: 'expired' });
    expect(audited!.after).toMatchObject({ balanceSatang: 25_500, status: 'active', reason: 'Guest came back the next morning' });
    expect(audited!.actorAccountId).toBe(entry.actorAccountId);

    const again = await reactivate(w.id, manager, { reason: 'Guest came back the next morning' });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().wallet.balanceSatang).toBe(25_500);
    expect((await entriesOf(w.id)).filter((e) => e.kind === 'reactivate')).toHaveLength(1);

    // Spendable again.
    const saleId = await fnbOrder();
    const spend = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() });
    expect(spend.statusCode, spend.body).toBe(200);
    await assertLedgerTruth();
  });

  it('refused: 403 without pos:wallet:reactivate, 400 without a reason, 409 when nothing expired, 404 at another park', async () => {
    const d = addDaysToIsoDate(today(), -4);
    const w = await grantOn(d, 9_000, { expiry: 'same_day', expiryDays: null });
    await expireWalletsForDay(ctx.db, branchId, d, endOf(d));
    const count = async () => (await entriesOf(w.id)).length;
    const n = await count();

    const forbidden = await reactivate(w.id, reception, { reason: 'Please' });
    expect(forbidden.statusCode).toBe(403);

    for (const reason of ['', '   ']) {
      const blank = await reactivate(w.id, manager, { reason });
      expect(blank.statusCode).toBe(400);
      expect(blank.json().error.code).toBe('REASON_REQUIRED');
    }
    const missing = await reactivate(w.id, manager, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('REASON_REQUIRED');

    const elsewhere = await reactivate(w.id, chalongManager, { reason: 'Not my park' });
    expect(elsewhere.statusCode).toBe(404);

    const live = await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, actor(), {
        actionId: `r3:${newId()}`, branchId, holderName: 'Walk-in guest', amountSatang: 1_000, source: 'ticket_sale',
        keys: [{ kind: 'voucher_qr', value: mintVoucherQr() }],
      }),
    );
    const notExpired = await reactivate(live.wallet.id, manager, { reason: 'Why not' });
    expect(notExpired.statusCode).toBe(409);
    expect(notExpired.json().error.code).toBe('WALLET_NOT_EXPIRED');

    expect(await count()).toBe(n);
    expect(await walletRow(w.id)).toMatchObject({ status: 'expired', balanceSatang: 0 });
  });
});

describe('the Wallet view’s read', () => {
  it('shows balance, status, expiry and the ledger to pos:wallet:read — and 403 without it', async () => {
    const w = await grantOn(today(), 2_500, { expiry: 'same_day', expiryDays: null });
    const ok = await ctx.app.inject({ method: 'GET', url: `/wallets/lookup?key=${encodeURIComponent(w.qr)}`, headers: { cookie: reception } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().wallet).toMatchObject({ id: w.id, status: 'active', balanceSatang: 2_500, holderName: 'Walk-in guest' });
    expect(ok.json().wallet.expiresAt).toBe(endOf(today()).toISOString());
    expect(ok.json().ledger).toHaveLength(1);
    expect(ok.json().ledger[0]).toMatchObject({ kind: 'grant', source: 'ticket_sale', amountSatang: 2_500 });

    const [receptionRole] = await ctx.db.select().from(role).where(and(eq(role.name, 'reception'), isNull(role.operatorId)));
    const roleId = receptionRole!.id;
    await ctx.db
      .delete(rolePermission)
      .where(and(eq(rolePermission.roleId, roleId), inArray(rolePermission.permission, ['pos:wallet:read'])));
    try {
      const refused = await ctx.app.inject({ method: 'GET', url: `/wallets/lookup?key=${encodeURIComponent(w.qr)}`, headers: { cookie: reception } });
      expect(refused.statusCode).toBe(403);
    } finally {
      await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission: 'pos:wallet:read' }).onConflictDoNothing();
    }
  });
});
