import { generateKeyPairSync, randomInt } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  box,
  boxCommand,
  member,
  ticketPackage,
  paymentAttempt,
  product,
  sale,
  station,
  syncAnomaly,
  voucher,
  voucherDefinition,
  wallet,
  walletEntry,
} from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type BoxAgent } from '@oto/box-agent';
import {
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
import { offlineUnexpiresOf } from '../src/services/sync-wallet';
import { expireWalletsForDay, voucherLoadActionId } from '../src/services/wallet';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * GATE — S2-14a round 5, the gate's own construction (kept as a reproduction).
 *
 * One wallet-credit promotion with a GLOBAL LIMIT OF ONE, attacked and then
 * walked across rounds 1-5:
 *
 *   race      two tills each hold a voucher of it (the first hold lapsed, so
 *             both reservations stand) and press Pay at the SAME moment on a
 *             ฿0 stand-alone sale: exactly one sale is written, the other is
 *             refused VOUCHER_LIMIT_REACHED with nothing written;
 *   replay    the winner's close is replayed with its key and with a fresh
 *             one: the credit is loaded exactly once, through the landed
 *             ledger (`voucher:<id>:load`), with no payment attempt;
 *   offline   the voucher-loaded wallet is cached by Reception Till 1's box,
 *             the link drops and the box spends it under the cap;
 *   expiry    the platform's day end runs BEFORE the box reconnects and takes
 *             the whole credit (it has not heard of the spend);
 *   sync      the box reconnects: the spend is filed once, net of a keyed
 *             put-back, no overdraft, balance == sum(entries), and the wallet
 *             attempt is not till takings;
 *   report    the foregone-revenue line counts the redemption at ฿0 foregone
 *             and the credit beside it, never in it.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let counter: string; // Counter 2, box 2 (stays online)
let boxTill: string; // Reception Till 1, box 1 (goes offline)
let manager: string;
let operatorId: string;
let branchId: string;
let tz: string;
let dayStart: number;
let t1: typeof station.$inferSelect;
let t2: typeof station.$inferSelect;
let plateId: string;
let plateSatang: number;
let defId: string;
let agent: BoxAgent | null = null;
const link: CuttableLink = { cut: false };

const CREDIT = 50_000;

const walk: { winner?: string; winnerSale?: string; walletId?: string; qr?: string; closeKey?: string; closeBody?: string } = {};

async function call(cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, key?: string) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { statusCode: res.statusCode, raw: res.body, body: (res.body ? JSON.parse(res.body) : {}) as Record<string, any> };
}

async function invariants(step: string): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string }[]) {
    expect(Number(r.balance), `${step}: wallet ${r.id} balance == sum(entries)`).toBe(Number(r.total));
  }
  for (const a of await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.method, 'wallet'))) {
    expect(countsAsTillTakings(a), `${step}: wallet attempt ${a.id}`).toBe(false);
  }
  // The voucher's load is ONE ledger entry, for ever.
  if (walk.winner && walk.closeBody) {
    const loads = await ctx.db
      .select()
      .from(walletEntry)
      .where(and(eq(walletEntry.operatorId, operatorId), eq(walletEntry.actionId, voucherLoadActionId(walk.winner))));
    expect(loads, `${step}: the voucher loaded once`).toHaveLength(1);
    expect(await ctx.db.select().from(walletEntry).where(eq(walletEntry.source, 'promo_voucher'))).toHaveLength(1);
  }
}

async function issue(): Promise<{ id: string; code: string }> {
  const id = newId();
  const code = mintBoothCode('CP', (max) => randomInt(max));
  await ctx.db.insert(voucher).values({ id, operatorId, branchId, voucherDefinitionId: defId, code, source: 'campaign', status: 'issued' });
  return { id, code };
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
  [t1] = (await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')))) as [typeof station.$inferSelect];
  [t2] = (await ctx.db.select().from(station).where(and(eq(station.boxId, box2.id), eq(station.name, 'Counter 2')))) as [typeof station.$inferSelect];
  branchId = t1.branchId;
  operatorId = t1.operatorId;
  const [br] = await ctx.db
    .execute<{ timezone: string; day_start: string }>(sql`select timezone, business_day_start::text as day_start from core.branch where id = ${branchId}::uuid`)
    .then((r) => r.rows);
  tz = br!.timezone;
  dayStart = parseDayStart(br!.day_start);
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(inArray(box.id, [box1.id, box2.id]));

  counter = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  expect((await call(counter, 'PUT', '/me/session/station', { stationId: t2.id })).statusCode).toBe(200);
  boxTill = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  expect((await call(boxTill, 'PUT', '/me/session/station', { stationId: t1.id })).statusCode).toBe(200);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);

  const menu = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.kind, 'menu'), isNull(product.archivedAt), or(isNull(product.branchId), eq(product.branchId, branchId))))
    .orderBy(asc(product.name));
  for (const p of menu) {
    if (!p.active || p.priceSatang <= 0 || p.priceSatang > 30_000) continue;
    const q = await call(boxTill, 'POST', '/sales/quote', { stationId: t1.id, items: [{ id: newId(), productId: p.id, quantity: 1 }], channel: 'fnb', pickupCode: '9' });
    if (q.statusCode === 200 && q.body.quote?.totals?.grossSatang === p.priceSatang) {
      plateId = p.id;
      plateSatang = p.priceSatang;
      break;
    }
  }
  expect(plateId).toBeTruthy();

  defId = newId();
  await ctx.db.insert(voucherDefinition).values({
    id: defId,
    operatorId,
    code: `r5-gate-${defId}`,
    nameEn: '฿500 food credit — first guest only',
    kind: 'wallet_credit',
    valueType: 'amount',
    valueSatang: CREDIT,
    usageLimit: 1,
  });
}, 240_000);

afterAll(async () => {
  if (agent) {
    agent.stop();
    detachInProcessBox(agent);
  }
  await ctx?.close();
  await teardownAll();
});

describe('GATE r5: a limit-of-one wallet credit, raced, replayed, spent offline, expired and synced', () => {
  it('race: both reservations stand (one lapsed), both tills press Pay at once — one sale, one honest refusal', async () => {
    const v1 = await issue();
    const v2 = await issue();
    const s1 = newId();
    const s2 = newId();
    expect((await call(boxTill, 'POST', `/sales/${s1}/vouchers`, { code: v1.code })).statusCode).toBe(200);
    // Till 1's cart sat: its reservation lapsed, so Counter 2 may reserve the use too.
    await ctx.db.update(voucher).set({ heldAt: new Date(Date.now() - 20 * 60_000) }).where(eq(voucher.id, v1.id));
    const held2 = await call(counter, 'POST', `/sales/${s2}/vouchers`, { code: v2.code });
    expect(held2.statusCode, held2.raw).toBe(200);

    const cart = (stationId: string, code: string, id: string) => ({ id, stationId, lines: [], items: [], promoCodes: [code], expectedTotalSatang: 0 });
    const [a, b] = await Promise.all([
      call(boxTill, 'POST', '/sales', cart(t1.id, v1.code, s1)),
      call(counter, 'POST', '/sales', cart(t2.id, v2.code, s2)),
    ]);
    const answers = [a, b];
    expect(answers.filter((r) => r.statusCode === 200), answers.map((r) => r.raw).join(' | ')).toHaveLength(1);
    const lost = answers.find((r) => r.statusCode !== 200)!;
    expect(lost.statusCode).toBe(409);
    expect(lost.body.error).toMatchObject({ code: 'VOUCHER_LIMIT_REACHED', message: 'This promotion is used up — its one redemption has been taken' });
    const written = await ctx.db.select().from(sale).where(inArray(sale.id, [s1, s2]));
    expect(written).toHaveLength(1);
    walk.winnerSale = written[0]!.id;
    walk.winner = walk.winnerSale === s1 ? v1.id : v2.id;
    const loserCode = walk.winnerSale === s1 ? v2.code : v1.code;
    const loserTill = walk.winnerSale === s1 ? counter : boxTill;
    // The loser's own till, scanning it again, hears the limit.
    const again = await call(loserTill, 'GET', `/vouchers/lookup?code=${encodeURIComponent(loserCode)}`);
    expect(again.statusCode).toBe(409);
    expect(again.body.error.code).toBe('VOUCHER_LIMIT_REACHED');
    // Rung up, not yet closed: nothing is loaded before the close.
    expect(await ctx.db.select().from(walletEntry).where(eq(walletEntry.source, 'promo_voucher'))).toEqual([]);
    await invariants('race');
  });

  it('per customer: two anonymous vouchers, one member, two tills pressing Pay at once — one sale, one refusal', async () => {
    const perDef = newId();
    await ctx.db.insert(voucherDefinition).values({
      id: perDef,
      operatorId,
      code: `r5-gate-pc-${perDef}`,
      nameEn: '฿50 off — once per guest',
      kind: 'discount',
      valueType: 'amount',
      valueSatang: 5_000,
      perCustomerLimit: 1,
    });
    const [m] = await ctx.db.select().from(member).where(and(eq(member.operatorId, operatorId), eq(member.phone, '+66844444444')));
    const [pkg] = await ctx.db.select().from(ticketPackage).where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
    const mk = async () => {
      const id = newId();
      const code = mintBoothCode('CP', (max) => randomInt(max));
      await ctx.db.insert(voucher).values({ id, operatorId, branchId, voucherDefinitionId: perDef, code, source: 'campaign', status: 'issued' });
      return { id, code };
    };
    for (let round = 0; round < 3; round += 1) {
      const [a, b] = [await mk(), await mk()];
      const [sa, sb] = [newId(), newId()];
      expect((await call(boxTill, 'POST', `/sales/${sa}/vouchers`, { code: a.code })).statusCode).toBe(200);
      expect((await call(counter, 'POST', `/sales/${sb}/vouchers`, { code: b.code })).statusCode).toBe(200);
      const cart = (stationId: string, code: string, id: string) => ({
        id,
        stationId,
        memberId: m!.id,
        lines: [{ id: newId(), packageId: pkg!.id, kids: 1, adults: 1 }],
        promoCodes: [code],
      });
      const answers = await Promise.all([
        call(boxTill, 'POST', '/sales', cart(t1.id, a.code, sa)),
        call(counter, 'POST', '/sales', cart(t2.id, b.code, sb)),
      ]);
      const ok = answers.filter((r) => r.statusCode === 200);
      expect(ok, `round ${round}: ${answers.map((r) => r.raw.slice(0, 160)).join(' | ')}`).toHaveLength(1);
      const lost = answers.find((r) => r.statusCode !== 200)!;
      expect(lost.body.error.code).toBe('VOUCHER_CUSTOMER_LIMIT');
      // Void the rung-up one so the next round starts from nothing used.
      const won = ok[0]!.body.sale.id as string;
      const voider = won === sa ? boxTill : counter;
      const voided = await call(voider, 'POST', `/sales/${won}/void`, { reason: 'gate round' });
      expect(voided.statusCode, voided.raw).toBe(200);
    }
  });

  it('replay: the close replayed with its key and with a fresh key loads nothing twice; no payment attempt', async () => {
    const at = walk.winnerSale!;
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, at));
    const cookie = row!.stationId === t1.id ? boxTill : counter;
    walk.closeKey = newId();
    const closed = await call(cookie, 'POST', `/sales/${at}/finalise`, {}, walk.closeKey);
    expect(closed.statusCode, closed.raw).toBe(200);
    expect(closed.body.finalised).toBe(true);
    walk.closeBody = closed.raw;
    const replay = await call(cookie, 'POST', `/sales/${at}/finalise`, {}, walk.closeKey);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(JSON.parse(walk.closeBody!));
    const fresh = await call(cookie, 'POST', `/sales/${at}/finalise`, {}, newId());
    expect([200, 409]).toContain(fresh.statusCode);
    const [load] = await ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, voucherLoadActionId(walk.winner!)));
    expect(load).toMatchObject({ kind: 'grant', source: 'promo_voucher', amountSatang: CREDIT, saleId: at });
    walk.walletId = load!.walletId;
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, at))).toEqual([]);
    const credit = await call(cookie, 'GET', `/vouchers/${walk.winner}/credit`);
    expect(credit.statusCode, credit.raw).toBe(200);
    expect(credit.body.wallet.id).toBe(walk.walletId);
    walk.qr = credit.body.qrCode;
    expect(walk.qr).toBeTruthy();
    await invariants('replay');
  });

  it('offline + expiry + sync: the box spends the voucher credit offline, the day end runs first, the spend is filed once with no overdraft', async () => {
    const box1 = await boxBySlot(ctx.db, 'virtual-1');
    agent = createBoxAgent({
      apiBaseUrl: 'http://r5-gate-box.test',
      credentials: memoryCredentialStore(),
      hostname: 'r5-gate-box',
      fetch: injectedTransport(ctx, link),
      store: boxStoreFor(ctx.db),
      claimCode: async () => (await issueClaimCode(ctx.db, box1.id)).code,
      booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
      bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
      printing: { retryDelayMs: 0 },
      terminal: { enabled: false },
      bands: { key: currentBandKey },
    });
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    await agent.syncCache();
    attachInProcessBox(agent);
    await agent.syncWallets();

    await agent.setOffline(true, { reason: 'r5 gate' });
    link.cut = true;
    const order = {
      saleId: newId(),
      actionId: `pay-${newId().slice(-12)}`,
      staffName: 'Nok',
      cart: { items: [{ id: newId(), productId: plateId, quantity: 1 }], channel: 'fnb', pickupCode: '9', expectedTotalSatang: plateSatang },
    };
    const press = newId();
    const res = await call(boxTill, 'POST', `/box/v1/station/${t1.id}/intents`, {
      type: 'payment.wallet',
      lastSeenSequence: 0,
      payload: { ...order, wallet: { key: walk.qr, actionId: press, useCredit: true } },
      actionId: `w-${newId().slice(-12)}`,
    });
    expect(res.statusCode, res.raw).toBe(200);
    const answer = res.body.result as BridgeWalletSpendAnswer;
    expect(answer.walletSpend.amountSatang).toBe(plateSatang);
    expect(answer.finalised).toBe(true);

    // The platform closes the trading day before the box is heard from.
    const [grant] = await ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, voucherLoadActionId(walk.winner!)));
    expect(grant!.expiresAt).not.toBeNull();
    const day = businessDateOf(new Date(), tz, dayStart);
    const cut = await expireWalletsForDay(ctx.db, branchId, day, new Date(grant!.expiresAt!.getTime() + 60_000));
    expect(cut.ended).toBe(true);
    const [expired] = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, walk.walletId!), eq(walletEntry.kind, 'expire')));
    expect(expired?.amountSatang).toBe(-CREDIT);
    await invariants('expiry before sync');

    const kicks = (await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.boxId, t1.boxId!), eq(boxCommand.kind, 'drawer_kick')))).length;
    link.cut = false;
    await agent.setOffline(false);
    await drain(agent);
    expect((await agent.outbox()!.depth()).queued).toBe(0);

    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, walk.walletId!));
    const spends = entries.filter((e) => e.kind === 'spend');
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ amountSatang: -plateSatang, offline: true, saleId: order.saleId });
    expect(await ctx.db.select().from(syncAnomaly).where(eq(syncAnomaly.kind, 'wallet_overdraft'))).toEqual([]);
    const unexpires = await offlineUnexpiresOf(ctx.db, operatorId, walk.walletId!);
    const lapsed = entries.filter((e) => e.kind === 'expire').reduce((s, e) => s + e.amountSatang, 0) + unexpires.reduce((s, e) => s + e.amountSatang, 0);
    expect(lapsed, 'the day lost what the box did not spend').toBe(-(CREDIT - plateSatang));
    const [w] = await ctx.db.select().from(wallet).where(eq(wallet.id, walk.walletId!));
    expect(w).toMatchObject({ balanceSatang: 0, status: 'expired' });
    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, order.saleId));
    expect(attempts.map((a) => [a.method, a.offline, countsAsTillTakings(a)])).toEqual([['wallet', true, false]]);
    expect((await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.boxId, t1.boxId!), eq(boxCommand.kind, 'drawer_kick')))).length).toBe(kicks);
    // A second drain writes nothing twice.
    await drain(agent);
    expect(await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, order.saleId))).toHaveLength(entries.filter((e) => e.saleId === order.saleId).length);
    await invariants('sync');
  });

  it('report: the redemption is on the foregone-revenue line at ฿0 foregone, its credit beside it', async () => {
    const day = businessDateOf(new Date(), tz, dayStart);
    const res = await call(manager, 'GET', `/vouchers/promotions/report?branchId=${branchId}&from=${day}&to=${day}`);
    expect(res.statusCode, res.raw).toBe(200);
    const row = (res.body.rows as Array<Record<string, unknown>>).find((r) => r.definitionId === defId);
    expect(row).toMatchObject({ redemptions: 1, foregoneSatang: 0, creditLoadedSatang: CREDIT, kind: 'wallet_credit' });
    await invariants('report');
  });
});
