import { generateKeyPairSync, randomInt } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  box,
  boxCommand,
  paymentAttempt,
  product,
  station,
  syncAnomaly,
  ticketPackage,
  voucher,
  voucherDefinition,
  wallet,
  walletEntry,
} from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type BoxAgent } from '@oto/box-agent';
import {
  addDaysToIsoDate,
  businessDate as businessDateOf,
  countsAsTillTakings,
  mintBoothCode,
  newId,
  parseDayStart,
  type BridgeWalletSpendAnswer,
} from '@oto/shared';
import { BRANCH_MANAGER, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import {
  expireWalletsForDay,
  walletReportOf,
  writeWalletLiabilityFact,
  type WalletLiabilityDay,
} from '../src/services/wallet';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-14a ROUND 5 — THE CLOSING AUDIT OF THE WALLET STORY (rounds 1-5 together).
 *
 * One family's credit walked through every door the story built, in order,
 * through the real routes and — for the outage — the real box code:
 *
 *   grant       an Eat & Play sale (1 kid + 1 adult) closes and grants the kid
 *               full-price credit (round 1);
 *   spend       the kid's band… here its voucher QR pays an F&B order whole
 *               (round 2);
 *   refund      part of that order comes back onto the same wallet (round 2);
 *   expire      the trading day ends and the day-end job takes the rest (round 3);
 *   reactivate  a manager brings it back with a typed reason (round 3);
 *   offline     the mall link drops and Reception Till 1's box spends it under
 *               the cap (round 4);
 *   sync        the link returns and the box's spend is filed once (round 4);
 *   voucher     a promotional wallet-credit voucher loads a second wallet
 *               (round 5).
 *
 * After EVERY step: balance == sum(entries) for every wallet; every credit
 * movement's payment attempt answers countsAsTillTakings = false; the drawer
 * is never kicked by credit; and at the end the daily liability fact for both
 * trading days equals the ledger summed by hand and reconciles sign-exact.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let counter: string; // reception at Counter 2 (online, box 2)
let boxTill: string; // reception at Reception Till 1 (box 1, the one that goes offline)
let manager: string;
let operatorId: string;
let branchId: string;
let tz: string;
let dayStart: number;
let t1: typeof station.$inferSelect;
let t2: typeof station.$inferSelect;
let eatPlay: string;
let friesId: string;
let plateId: string;
let plateSatang: number;
let agent: BoxAgent | null = null;
const link: CuttableLink = { cut: false };

/** What the walk carries from step to step. */
const walk: {
  kidWallet?: string;
  kidQr?: string;
  grant?: number;
  fnbSale?: string;
  spent?: number;
  refunded?: number;
  expired?: number;
  offlineSale?: string;
  voucherWallet?: string;
} = {};

const yesterday = () => addDaysToIsoDate(businessDateOf(new Date(), tz, dayStart), -1);
const today = () => businessDateOf(new Date(), tz, dayStart);

async function call(cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, key?: string) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { statusCode: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Record<string, any> };
}

async function balanceOf(id: string): Promise<number> {
  const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, id));
  return row!.balanceSatang;
}

/** THE INVARIANTS, after every step. */
async function audit(step: string): Promise<void> {
  // 1. The ledger is the truth: every balance is the sum of its entries.
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total,
           (select count(*) from pos.wallet_entry e where e.wallet_id = w.id and e.balance_after < 0)::int as negative
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string; negative: number }[]) {
    expect(Number(r.balance), `${step}: wallet ${r.id} balance == sum(entries)`).toBe(Number(r.total));
    expect(Number(r.negative), `${step}: no entry left a wallet below zero`).toBe(0);
  }
  // 2. Every credit movement that is a payment answers "not till takings".
  const credit = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.method, 'wallet'));
  for (const a of credit) expect(countsAsTillTakings(a), `${step}: attempt ${a.id}`).toBe(false);
  // 3. Every wallet entry that names an attempt names a wallet attempt — credit
  // never rides on a cash, card or QR attempt that would count it as takings.
  const named = await ctx.db.execute<{ method: string }>(sql`
    select a.method from pos.wallet_entry e join pos.payment_attempt a on a.id = e.payment_attempt_id`);
  for (const r of named.rows) expect(r.method, `${step}: the attempt behind a wallet entry`).toBe('wallet');
}

async function drawerKicks(boxId: string): Promise<number> {
  return (await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.boxId, boxId), eq(boxCommand.kind, 'drawer_kick')))).length;
}

function boxAgentFor(boxId: string): BoxAgent {
  return createBoxAgent({
    apiBaseUrl: 'http://closing-audit-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'closing-audit-box',
    fetch: injectedTransport(ctx, link),
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { enabled: false },
    bands: { key: currentBandKey },
  });
}

async function drain(a: BoxAgent): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    for (let j = 0; j < 10; j += 1) {
      const outcome = await a.outbox()!.flush().catch(() => ({ state: 'deferred' as const }));
      if (outcome.state !== 'pushed') break;
    }
    if ((await a.outbox()!.depth()).queued === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: { OPS_TEST_CONTROLS: 'true', STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  });
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const box2 = await boxBySlot(ctx.db, 'virtual-2');
  const [s1] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  const [s2] = await ctx.db.select().from(station).where(and(eq(station.boxId, box2.id), eq(station.name, 'Counter 2')));
  t1 = s1!;
  t2 = s2!;
  branchId = t1!.branchId;
  operatorId = t1!.operatorId;
  const [br] = await ctx.db.execute<{ timezone: string; day_start: string }>(
    sql`select timezone, business_day_start::text as day_start from core.branch where id = ${branchId}::uuid`,
  ).then((r) => r.rows);
  tz = br!.timezone;
  dayStart = parseDayStart(br!.day_start);
  // Registered and online: a drawer kick can be queued for either box, so "no kick" means something.
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(inArray(box.id, [box1.id, box2.id]));
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  eatPlay = pkgs.find((p) => p.name === 'Eat & Play Kids Pass')!.id;
  const [fries] = await ctx.db.select().from(product).where(and(eq(product.operatorId, operatorId), eq(product.code, 'FB-FRIES'), isNull(product.archivedAt)));
  friesId = fries!.id;

  counter = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  expect((await call(counter, 'PUT', '/me/session/station', { stationId: t2!.id })).statusCode).toBe(200);
  boxTill = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  expect((await call(boxTill, 'PUT', '/me/session/station', { stationId: t1!.id })).statusCode).toBe(200);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);

  // A plate with nothing to choose, whose platform quote is its price — what the box sells offline.
  const menu = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.kind, 'menu'), isNull(product.archivedAt), or(isNull(product.branchId), eq(product.branchId, branchId))))
    .orderBy(asc(product.name));
  for (const p of menu) {
    if (!p.active || p.priceSatang <= 0 || p.priceSatang > 30_000) continue;
    const q = await call(boxTill, 'POST', '/sales/quote', { stationId: t1!.id, items: [{ id: newId(), productId: p.id, quantity: 1 }], channel: 'fnb', pickupCode: '9' });
    if (q.statusCode === 200 && q.body.quote?.totals?.grossSatang === p.priceSatang) {
      plateId = p.id;
      plateSatang = p.priceSatang;
      break;
    }
  }
  expect(plateId, 'a seeded plate with no required choices').toBeTruthy();
}, 240_000);

afterAll(async () => {
  if (agent) {
    agent.stop();
    detachInProcessBox(agent);
  }
  await ctx?.close();
  await teardownAll();
});

describe('the wallet story, walked end to end: grant → spend → refund → expire → reactivate → offline spend → sync → voucher credit', () => {
  it('1 · grant: an Eat & Play sale (1 kid + 1 adult) grants the kid full-price credit on one QR', async () => {
    const saleId = newId();
    const rung = await call(counter, 'POST', '/sales', { id: saleId, stationId: t2!.id, lines: [{ id: newId(), packageId: eatPlay, kids: 1, adults: 1 }] });
    expect(rung.statusCode, JSON.stringify(rung.body)).toBe(200);
    const paid = await call(counter, 'POST', `/sales/${saleId}/finalise`, { method: 'cash', kind: 'cash', actionId: newId() });
    expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.finalised).toBe(true);
    const grants = paid.body.grants as Array<{ walletId: string; role: string; creditSatang: number; qrCode: string }>;
    const kid = grants.find((g) => g.role === 'kid')!;
    expect(kid.creditSatang).toBe(130_000);
    walk.kidWallet = kid.walletId;
    walk.kidQr = kid.qrCode;
    walk.grant = kid.creditSatang;
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, kid.walletId));
    expect(entries.map((e) => [e.kind, e.source, e.amountSatang])).toEqual([['grant', 'ticket_sale', 130_000]]);
    // The cash that paid for the tickets is takings; the credit it granted is not a payment at all.
    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(attempts.every((a) => a.method === 'cash')).toBe(true);
    await audit('grant');
  });

  it('2 · spend: the QR pays an F&B order whole — one wallet attempt, not takings, no drawer', async () => {
    const saleId = newId();
    const rung = await call(counter, 'POST', '/sales', { id: saleId, stationId: t2!.id, channel: 'fnb', pickupCode: '21', items: [{ id: newId(), productId: friesId, quantity: 2 }] });
    expect(rung.statusCode, JSON.stringify(rung.body)).toBe(200);
    const owed = rung.body.sale.totals.grossSatang as number;
    const kicks = await drawerKicks(t2!.boxId!);
    const paid = await call(counter, 'POST', `/sales/${saleId}/finalise`, { wallet: { key: walk.kidQr, useCredit: true }, actionId: newId() });
    expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.finalised).toBe(true);
    expect(await drawerKicks(t2!.boxId!)).toBe(kicks);
    walk.fnbSale = saleId;
    walk.spent = owed;
    expect(await balanceOf(walk.kidWallet!)).toBe(walk.grant! - owed);
    await audit('spend');
  });

  it('3 · refund: half the order comes back onto the SAME wallet, credit first — and no drawer opens for it', async () => {
    const half = Math.floor(walk.spent! / 2);
    const kicks = await drawerKicks(t2!.boxId!);
    const refunded = await call(manager, 'POST', `/sales/${walk.fnbSale}/refunds`, { mode: 'custom', amountSatang: half, reason: 'Cold', actionId: newId() });
    expect(refunded.statusCode, JSON.stringify(refunded.body)).toBe(200);
    const back = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, walk.kidWallet!), eq(walletEntry.kind, 'refund')));
    expect(back.map((e) => e.amountSatang)).toEqual([half]);
    walk.refunded = half;
    expect(await drawerKicks(t2!.boxId!)).toBe(kicks);
    expect(await balanceOf(walk.kidWallet!)).toBe(walk.grant! - walk.spent! + half);
    await audit('refund');
  });

  it('4 · expire: the trading day ends and the day-end job takes the remainder, keeping the history', async () => {
    // The day ENDS: every movement so far moves to yesterday, as if the family
    // came yesterday — the clock moved, not the money (the r3 tests' device).
    const y = yesterday();
    await ctx.db.execute(sql`
      update pos.wallet_entry
         set business_date = ${y}::date,
             created_at = created_at - interval '1 day',
             expires_at = expires_at - interval '1 day'
       where wallet_id = ${walk.kidWallet!}::uuid`);
    const remainder = walk.grant! - walk.spent! + walk.refunded!;
    const cut = await expireWalletsForDay(ctx.db, branchId, y, new Date());
    expect(cut.expiredSatang).toBe(remainder);
    walk.expired = remainder;
    const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, walk.kidWallet!));
    expect(row).toMatchObject({ balanceSatang: 0, status: 'expired' });
    // A spend now is refused in the counter's words, writing nothing.
    const saleId = newId();
    expect((await call(counter, 'POST', '/sales', { id: saleId, stationId: t2!.id, channel: 'fnb', pickupCode: '22', items: [{ id: newId(), productId: friesId, quantity: 1 }] })).statusCode).toBe(200);
    const refused = await call(counter, 'POST', `/sales/${saleId}/finalise`, { wallet: { key: walk.kidQr, useCredit: true }, actionId: newId() });
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error.code).toBe('WALLET_EXPIRED');
    await call(counter, 'POST', `/sales/${saleId}/void`, { reason: 'Guest paid elsewhere' });
    await audit('expire');
  });

  it('5 · reactivate: a manager brings exactly the expired remainder back, with a typed reason, as its own entry', async () => {
    const res = await call(manager, 'POST', `/wallets/${walk.kidWallet}/reactivate`, { reason: 'Family came back the next morning' });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const back = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, walk.kidWallet!), eq(walletEntry.kind, 'reactivate')));
    expect(back.map((e) => [e.amountSatang, e.businessDate])).toEqual([[walk.expired!, today()]]);
    expect(await balanceOf(walk.kidWallet!)).toBe(walk.expired!);
    await audit('reactivate');
  });

  it('6 · offline spend: the link drops and Reception Till 1’s box spends the wallet under the cap; nothing reaches the ledger yet', async () => {
    const box1 = await boxBySlot(ctx.db, 'virtual-1');
    agent = boxAgentFor(box1.id);
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    await agent.syncCache();
    attachInProcessBox(agent);
    await agent.syncWallets();
    const before = await balanceOf(walk.kidWallet!);
    await agent.setOffline(true, { reason: 'closing audit' });
    link.cut = true;
    const order = { saleId: newId(), actionId: `pay-${newId().slice(-12)}`, staffName: 'Nok', cart: { items: [{ id: newId(), productId: plateId, quantity: 1 }], channel: 'fnb', pickupCode: '9', expectedTotalSatang: plateSatang } };
    const res = await call(boxTill, 'POST', `/box/v1/station/${t1!.id}/intents`, {
      type: 'payment.wallet',
      lastSeenSequence: 0,
      payload: { ...order, wallet: { key: walk.kidQr, actionId: newId(), useCredit: true } },
      actionId: `w-${newId().slice(-12)}`,
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const answer = res.body.result as BridgeWalletSpendAnswer;
    expect(answer.walletSpend.amountSatang).toBe(plateSatang);
    expect(answer.finalised).toBe(true);
    walk.offlineSale = order.saleId;
    expect(await balanceOf(walk.kidWallet!)).toBe(before);
    await audit('offline spend');
  });

  it('7 · sync: the link returns; the box’s spend is filed once, offline, at its station and box — no overdraft, no drawer', async () => {
    const kicks = await drawerKicks(t1!.boxId!);
    const before = await balanceOf(walk.kidWallet!);
    link.cut = false;
    await agent!.setOffline(false);
    await drain(agent!);
    const spend = await ctx.db
      .select()
      .from(walletEntry)
      .where(and(eq(walletEntry.walletId, walk.kidWallet!), eq(walletEntry.saleId, walk.offlineSale!)));
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({ kind: 'spend', amountSatang: -plateSatang, offline: true, stationId: t1!.id, boxId: t1!.boxId });
    expect(await balanceOf(walk.kidWallet!)).toBe(before - plateSatang);
    expect(await ctx.db.select().from(syncAnomaly).where(eq(syncAnomaly.kind, 'wallet_overdraft'))).toEqual([]);
    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, walk.offlineSale!));
    expect(attempts.map((a) => [a.method, a.offline])).toEqual([['wallet', true]]);
    expect(await drawerKicks(t1!.boxId!)).toBe(kicks);
    // A second drain finds nothing to send and writes nothing twice.
    await drain(agent!);
    expect(await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, walk.offlineSale!))).toHaveLength(1);
    await audit('sync');
  });

  it('8 · voucher credit: a promotional wallet-credit voucher loads a second wallet through the same ledger, once', async () => {
    const defId = newId();
    await ctx.db.insert(voucherDefinition).values({
      id: defId,
      operatorId,
      code: `r5-audit-${defId}`,
      nameEn: '฿100 food credit',
      kind: 'wallet_credit',
      valueType: 'amount',
      valueSatang: 10_000,
    });
    const vId = newId();
    const code = mintBoothCode('CP', (max) => randomInt(max));
    await ctx.db.insert(voucher).values({ id: vId, operatorId, branchId, voucherDefinitionId: defId, code, source: 'campaign', status: 'issued' });
    const saleId = newId();
    expect((await call(counter, 'POST', `/sales/${saleId}/vouchers`, { code })).statusCode).toBe(200);
    expect((await call(counter, 'POST', '/sales', { id: saleId, stationId: t2!.id, lines: [], items: [], promoCodes: [code], expectedTotalSatang: 0 })).statusCode).toBe(200);
    const kicks = await drawerKicks(t2!.boxId!);
    const closed = await call(counter, 'POST', `/sales/${saleId}/finalise`, {}, newId());
    expect(closed.statusCode, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.finalised).toBe(true);
    const loads = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.saleId, saleId), eq(walletEntry.source, 'promo_voucher')));
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ kind: 'grant', amountSatang: 10_000, businessDate: today() });
    walk.voucherWallet = loads[0]!.walletId;
    expect(await drawerKicks(t2!.boxId!)).toBe(kicks);
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toEqual([]);
    await audit('voucher credit');
  });

  it('9 · the daily fact for both trading days equals the ledger summed by hand and reconciles sign-exact; the report agrees; a rerun writes nothing', async () => {
    const y = yesterday();
    const t = today();
    const all = (await ctx.db.select().from(walletEntry)).filter((e) => e.branchId === null || e.branchId === branchId);
    const hand = (date: string) => {
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
    };
    const facts: WalletLiabilityDay[] = [];
    for (const d of [y, t]) {
      const written = await writeWalletLiabilityFact(ctx.db, branchId, d);
      const { branchId: _b, businessDate: _d, ...figures } = written.fact;
      expect(figures, d).toEqual(hand(d));
      facts.push(written.fact);
    }
    const [fy, ft] = facts as [WalletLiabilityDay, WalletLiabilityDay];
    // Yesterday: the grant, the spend, the refund and the day-end cut, nothing left.
    expect(fy).toMatchObject({
      grantedSatang: expect.any(Number),
      spentSatang: walk.spent!,
      refundedSatang: walk.refunded!,
      expiredSatang: walk.expired!,
      reactivatedSatang: 0,
    });
    // Today: the reactivation, the offline spend, the voucher's load.
    expect(ft.reactivatedSatang).toBe(walk.expired!);
    expect(ft.spentSatang).toBe(plateSatang);
    expect(ft.grantedSatang).toBeGreaterThanOrEqual(10_000);
    // Sign-exact: outstanding(today) = outstanding(yesterday) + granted - spent + refunded - expired + reactivated.
    expect(ft.outstandingSatang).toBe(
      fy.outstandingSatang + ft.grantedSatang - ft.spentSatang + ft.refundedSatang - ft.expiredSatang + ft.reactivatedSatang,
    );
    // And today's outstanding is what the wallets hold now.
    const live = (await ctx.db.select().from(wallet).where(eq(wallet.branchId, branchId))).reduce((s, w) => s + w.balanceSatang, 0);
    expect(ft.outstandingSatang).toBe(live);
    expect(await balanceOf(walk.kidWallet!)).toBe(walk.expired! - plateSatang);
    expect(await balanceOf(walk.voucherWallet!)).toBe(10_000);
    // The report reads the same ledger.
    const report = await walletReportOf(ctx.db, operatorId, { branchIds: [branchId], from: y, to: t });
    expect(report.summary).toMatchObject({
      grantedSatang: fy.grantedSatang + ft.grantedSatang,
      spentSatang: fy.spentSatang + ft.spentSatang,
      refundedSatang: fy.refundedSatang + ft.refundedSatang,
      expiredSatang: fy.expiredSatang + ft.expiredSatang,
      reactivatedSatang: fy.reactivatedSatang + ft.reactivatedSatang,
      outstandingSatang: live,
      ledgerOutstandingSatang: live,
    });
    // Idempotent: a rerun writes nothing.
    for (const d of [y, t]) expect((await writeWalletLiabilityFact(ctx.db, branchId, d)).written).toBe(false);
    await audit('facts');
  });
});
