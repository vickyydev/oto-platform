import { generateKeyPairSync } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert,
  paymentAttempt,
  product,
  sale,
  station,
  syncAnomaly,
  syncEvent,
  wallet,
  walletEntry,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import {
  mintVoucherQr,
  newId,
  type BridgeSaleAnswer,
  type BridgeWalletSpendAnswer,
  type WalletSnapshotItem,
} from '@oto/shared';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { overdraftAlertKey } from '../src/services/sync-wallet';
import { createWalletWithGrant } from '../src/services/wallet';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-14a ROUND 4 — OFFLINE SPEND UNDER THE CAP, the closing audit of the
 * lifecycle (plan docs/progress/plans/wallet/PLAN.md §2.6).
 *
 * Two virtual boxes — Reception Till 1 on box 1, Counter 2 on box 2 — run the
 * code a Pi runs over the platform's own `edge` store, joined to the api by a
 * link the test cuts. A wallet is granted ONLINE; both boxes take its balance
 * snapshot; the mall's link goes down; each counter spends the same wallet to
 * the ฿300 cap, and a third press above it is refused in the counter's words;
 * the link comes back and each box syncs ONCE — box 1's answer is lost on the
 * way back and it sends again — and the second box's spend lands over what the
 * wallet holds: filed, the wallet at zero, and ONE `wallet_overdraft` anomaly
 * with ONE critical alert naming wallet, box, station and amount. Replaying
 * either push, or the same fact under a new envelope, writes nothing twice.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookies: { till1: string; counter2: string; admin: string };
let operatorId: string;
let branchId: string;
let till1: string;
let counter2: string;
let box1Id: string;
let box2Id: string;
let productId: string;
let unitSatang: number;
let walletId: string;
let qr: string;
let qrB: string;
let walletB: string;
let agent1: BoxAgent;
let agent2: BoxAgent;
const link1: CuttableLink = { cut: false };
const link2: CuttableLink = { cut: false };
/** Box 1's next push is applied and its answer lost on the way back — a restart mid-queue. */
const dropAnswer = { box1: false };

function walletAgent(boxId: string, name: string, link: CuttableLink, drop?: () => boolean): BoxAgent {
  const through = injectedTransport(ctx, link);
  const fetch: AgentFetch = async (url, init) => {
    const res = await through(url, init);
    if (url.includes('/box/v1/sync/push') && drop?.()) throw new Error('ECONNRESET: the answer was lost on the way back');
    return res;
  };
  return createBoxAgent({
    apiBaseUrl: `http://${name}.test`,
    credentials: memoryCredentialStore(),
    hostname: name,
    fetch,
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { enabled: false },
    bands: { key: currentBandKey },
  });
}

async function call(
  cookie: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

async function onBox<T = BridgeSaleAnswer>(
  cookie: string,
  stationId: string,
  type: string,
  payload: Record<string, unknown>,
  expected = 200,
): Promise<{ statusCode: number; body: Record<string, unknown>; result: T }> {
  const res = await call(cookie, 'POST', `/box/v1/station/${stationId}/intents`, {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `w-${newId().slice(-12)}`,
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(expected);
  return { ...res, result: res.body.result as T };
}

/** A food order of `quantity` plates, as the till rings it up, with the platform's own total. */
async function foodOrder(cookie: string, stationId: string, quantity: number) {
  const cart = { items: [{ id: newId(), productId, quantity }], channel: 'fnb', pickupCode: '9' };
  return {
    saleId: newId(),
    actionId: `pay-${newId().slice(-12)}`,
    staffName: 'Nok',
    cart: { ...cart, expectedTotalSatang: quantity * unitSatang },
  };
}

const cash = (amount: number) => ({
  actionId: `cash-${newId().slice(-12)}`,
  method: 'cash',
  kind: 'cash',
  amountSatang: amount,
  tenderedSatang: amount,
  changeSatang: 0,
});

async function flush(agent: BoxAgent): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    const outcome = await agent.outbox()!.flush().catch(() => ({ state: 'deferred' as const }));
    if (outcome.state !== 'pushed') break;
  }
}

/** Send until the queue is empty, waiting out the backoff a lost answer leaves. */
async function drain(agent: BoxAgent): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await flush(agent);
    if ((await agent.outbox()!.depth()).queued === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function balanceAndLedger() {
  const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, walletId));
  const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, walletId)).orderBy(asc(walletEntry.createdAt));
  return { balance: row!.balanceSatang, entries, sum: entries.reduce((s, e) => s + e.amountSatang, 0) };
}

const overdrafts = () => ctx.db.select().from(syncAnomaly).where(eq(syncAnomaly.kind, 'wallet_overdraft'));

beforeAll(async () => {
  ctx = await createTestContext({
    env: { OPS_TEST_CONTROLS: 'true', STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  });
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const box2 = await boxBySlot(ctx.db, 'virtual-2');
  box1Id = box1.id;
  box2Id = box2.id;
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  const [c2] = await ctx.db.select().from(station).where(and(eq(station.boxId, box2.id), eq(station.name, 'Counter 2')));
  till1 = t1!.id;
  counter2 = c2!.id;
  branchId = t1!.branchId;
  operatorId = t1!.operatorId;
  cookies = {
    till1: await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password),
    counter2: await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password),
    admin: await signInAs(ctx.app, ADMIN.phone, ADMIN.password),
  };
  expect((await call(cookies.till1, 'PUT', '/me/session/station', { stationId: till1 })).statusCode).toBe(200);
  expect((await call(cookies.counter2, 'PUT', '/me/session/station', { stationId: counter2 })).statusCode).toBe(200);

  // A plate the kitchen sells with nothing to choose: the platform's own quote decides.
  const menu = await ctx.db
    .select()
    .from(product)
    .where(
      and(
        eq(product.operatorId, operatorId),
        eq(product.kind, 'menu'),
        isNull(product.archivedAt),
        or(isNull(product.branchId), eq(product.branchId, branchId)),
      ),
    )
    .orderBy(asc(product.name));
  for (const p of menu) {
    if (!p.active || p.priceSatang <= 0 || p.priceSatang > 30_000) continue;
    const quoted = await call(cookies.till1, 'POST', '/sales/quote', {
      stationId: till1,
      items: [{ id: newId(), productId: p.id, quantity: 1 }],
      channel: 'fnb',
      pickupCode: '9',
    });
    const gross = (quoted.body.quote as { totals?: { grossSatang: number } } | undefined)?.totals?.grossSatang;
    if (quoted.statusCode === 200 && gross === p.priceSatang) {
      productId = p.id;
      unitSatang = p.priceSatang;
      break;
    }
  }
  expect(productId, 'a seeded plate with no required choices').toBeTruthy();

  // GRANT ONLINE: ฿500 of credit on a voucher.
  qr = mintVoucherQr();
  const granted = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, { accountId: null, operatorId }, {
      actionId: `test:grant:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang: 50_000,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qr }],
    }),
  );
  walletId = granted.wallet.id;
  // And a second wallet holding exactly one plate, for an order credit covers whole.
  qrB = mintVoucherQr();
  const plate = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, { accountId: null, operatorId }, {
      actionId: `test:grant:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang: unitSatang,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qrB }],
    }),
  );
  walletB = plate.wallet.id;

  agent1 = walletAgent(box1.id, 'wallet-box-1', link1, () => {
    if (!dropAnswer.box1) return false;
    dropAnswer.box1 = false;
    return true;
  });
  agent2 = walletAgent(box2.id, 'wallet-box-2', link2);
  for (const agent of [agent1, agent2]) {
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    await agent.syncCache();
    attachInProcessBox(agent);
  }
}, 240_000);

afterAll(async () => {
  for (const agent of [agent1, agent2]) {
    agent?.stop();
    if (agent) detachInProcessBox(agent);
  }
  await ctx?.close();
  await teardownAll();
});

describe('offline spend under the cap: grant online, two boxes spend to the cap, sync once each, the overdraft surfaces (plan §2.6)', () => {
  it('both boxes hold the wallet as a snapshot with the cap — and never the voucher code', async () => {
    for (const [agent, id] of [[agent1, box1Id], [agent2, box2Id]] as const) {
      // Written by the cache pull at start; this tick finds the same copy and
      // rewrites nothing (`WALLET_SNAPSHOT_REWRITE_AFTER_MS`).
      expect(await agent.syncWallets()).toBe(false);
      const held = await boxStoreFor(ctx.db).readBundle(id, 'wallets');
      const item = (held!.payload as { items: WalletSnapshotItem[] }).items[0]!;
      expect(item.capSatang).toBe(30_000);
      const mine = item.wallets.find((w) => w.id === walletId);
      expect(mine?.balanceSatang).toBe(50_000);
      expect(mine?.boxSpentSatang).toBe(0);
      expect(JSON.stringify(held!.payload)).not.toContain(qr);
    }
  });

  it('with the link down, Reception Till 1 and Counter 2 each spend the wallet to ฿300; a press above the cap is refused', async () => {
    for (const agent of [agent1, agent2]) await agent.setOffline(true, { reason: 'wallet round 4' });
    link1.cut = true;
    link2.cut = true;
    const plates = Math.ceil(30_000 / unitSatang) + 1;

    // Box 1: use credit — the cap binds, the rest is owed and taken in cash.
    const first = await foodOrder(cookies.till1, till1, plates);
    const credit1 = { key: qr.toLowerCase(), actionId: newId(), useCredit: true };
    const held = await onBox<BridgeWalletSpendAnswer>(cookies.till1, till1, 'payment.wallet', { ...first, wallet: credit1 });
    expect(held.result.walletSpend.amountSatang).toBe(30_000);
    expect(held.result.finalised).toBe(false);
    const rest = first.cart.expectedTotalSatang - 30_000;
    expect(held.result.outstandingSatang).toBe(rest);
    const closed = await onBox(cookies.till1, till1, 'sale.finalise', { ...first, tender: cash(rest) });
    expect(closed.result.finalised).toBe(true);
    receipts.set(first.saleId, closed.result.sale.receiptNumber!);
    sales.box1 = first.saleId;

    // Credit that covers an order whole: closed on the box with no cash at all.
    const whole = await foodOrder(cookies.till1, till1, 1);
    const covered = await onBox<BridgeWalletSpendAnswer>(cookies.till1, till1, 'payment.wallet', {
      ...whole,
      wallet: { key: qrB, actionId: newId(), useCredit: true },
    });
    expect(covered.result.finalised).toBe(true);
    expect(covered.result.attempt).toBeNull();
    expect(covered.result.walletSpend.amountSatang).toBe(unitSatang);
    receipts.set(whole.saleId, covered.result.sale.receiptNumber!);
    sales.whole = whole.saleId;

    // Above the cap on the same box: refused, in the counter's words, nothing written.
    const more = await foodOrder(cookies.till1, till1, 1);
    const refused = await onBox(cookies.till1, till1, 'payment.wallet', { ...more, wallet: { key: qr, actionId: newId(), useCredit: true } }, 409);
    const error = refused.body.error as { code: string; message: string };
    expect(error.code).toBe('WALLET_OFFLINE_CAP');
    expect(error.message).toMatch(/online only above ฿300 per day/);

    // Box 2: an exact ฿300 with the cash for the rest in one press.
    const second = await foodOrder(cookies.counter2, counter2, plates);
    const credit2 = { key: qr, actionId: newId(), amountSatang: 30_000 };
    const one = await onBox<BridgeWalletSpendAnswer>(cookies.counter2, counter2, 'payment.wallet', {
      ...second,
      wallet: credit2,
      tender: cash(second.cart.expectedTotalSatang - 30_000),
    });
    expect(one.result.finalised).toBe(true);
    expect(one.result.walletSpend.amountSatang).toBe(30_000);
    receipts.set(second.saleId, one.result.sale.receiptNumber!);
    sales.box2 = second.saleId;
    presses.box2 = credit2.actionId;

    // Nothing reached the ledger.
    expect((await balanceAndLedger()).balance).toBe(50_000);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, first.saleId))).toHaveLength(0);
  });

  it('box 1 reconnects, its answer is lost and it sends again: its spend is filed once, offline, at its station and box', async () => {
    link1.cut = false;
    // Set before the box goes online: going online sends the queue at once.
    dropAnswer.box1 = true;
    await agent1.setOffline(false);
    await flush(agent1);
    expect(dropAnswer.box1, 'the answer to the first push was lost').toBe(false);
    expect((await agent1.outbox()!.depth()).queued, 'so the box still holds what it sent').toBeGreaterThan(0);
    await drain(agent1);
    expect((await agent1.outbox()!.depth()).queued).toBe(0);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, sales.box1!));
    expect(row?.status).toBe('finalised');
    expect(row?.receiptNumber).toBe(receipts.get(sales.box1!));
    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, sales.box1!));
    const credit = attempts.filter((a) => a.methodCode === 'wallet_credit');
    expect(credit).toHaveLength(1);
    expect(credit[0]!.method).toBe('wallet');
    expect(credit[0]!.offline).toBe(true);
    expect(credit[0]!.amountSatang).toBe(30_000);
    const { balance, entries, sum } = await balanceAndLedger();
    expect(balance).toBe(20_000);
    expect(sum).toBe(balance);
    const spend = entries.filter((e) => e.kind === 'spend');
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({ amountSatang: -30_000, offline: true, stationId: till1, boxId: box1Id, paymentAttemptId: credit[0]!.id, source: 'fnb_order' });
    expect(await overdrafts()).toHaveLength(0);

    // The order credit covered whole: one attempt, the wallet's, and the sale
    // closed by it under the number the box printed.
    const [wholeRow] = await ctx.db.select().from(sale).where(eq(sale.id, sales.whole!));
    expect(wholeRow).toMatchObject({ status: 'finalised', receiptNumber: receipts.get(sales.whole!) });
    const wholeAttempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, sales.whole!));
    expect(wholeAttempts.map((a) => [a.method, a.amountSatang, a.offline])).toEqual([['wallet', unitSatang, true]]);
    const [b] = await ctx.db.select().from(wallet).where(eq(wallet.id, walletB));
    expect(b!.balanceSatang).toBe(0);

    // Box 1's next snapshot reflects what it filed, so it is not taken off twice.
    expect(await agent1.syncWallets()).toBe(true);
    const held = await boxStoreFor(ctx.db).readBundle(box1Id, 'wallets');
    const mine = (held!.payload as { items: WalletSnapshotItem[] }).items[0]!.wallets.find((w) => w.id === walletId);
    expect(mine).toMatchObject({ balanceSatang: 20_000, boxSpentSatang: 30_000 });
  });

  it('box 2 reconnects: its ฿300 lands on ฿200 — filed, the wallet at zero, ONE overdraft anomaly and ONE critical alert', async () => {
    link2.cut = false;
    await agent2.setOffline(false);
    await flush(agent2);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, sales.box2!));
    expect(row?.status).toBe('finalised');
    expect(row?.receiptNumber).toBe(receipts.get(sales.box2!));
    const credit = (await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, sales.box2!))).filter(
      (a) => a.methodCode === 'wallet_credit',
    );
    expect(credit.map((a) => a.amountSatang)).toEqual([30_000]);
    const { balance, entries, sum } = await balanceAndLedger();
    expect(balance).toBe(0);
    expect(sum).toBe(0);
    const fromBox2 = entries.filter((e) => e.boxId === box2Id);
    expect(fromBox2).toHaveLength(1);
    expect(fromBox2[0]).toMatchObject({ amountSatang: -20_000, offline: true, stationId: counter2, balanceAfter: 0 });
    expect(fromBox2[0]!.payload).toMatchObject({ askedSatang: 30_000, overdraftSatang: 10_000 });

    const anomalies = await overdrafts();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.boxId).toBe(box2Id);
    expect(anomalies[0]!.detail).toMatchObject({ walletId, boxId: box2Id, stationId: counter2, overdraftSatang: 10_000, spentSatang: 30_000, coveredSatang: 20_000 });
    const alerts = await ctx.db.select().from(alert).where(eq(alert.key, overdraftAlertKey(operatorId, presses.box2!)));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', category: 'wallet.offline_overdraft', occurrences: 1 });
    expect(alerts[0]!.summary).toMatch(/Counter 2/);
    expect(alerts[0]!.summary).toMatch(/฿100/);

    // On the Failures surface, with its kind.
    const page = await call(cookies.admin, 'GET', '/ops/anomalies?kind=wallet_overdraft');
    expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
    const listed = page.body.anomalies as Array<{ kind: string; detail: Record<string, unknown> }>;
    expect(listed.some((a) => a.kind === 'wallet_overdraft' && a.detail.walletId === walletId)).toBe(true);
  });

  it('replaying either push, or the same fact under a new envelope, writes nothing twice', async () => {
    const before = await balanceAndLedger();
    const attemptsBefore = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.methodCode, 'wallet_credit'));
    expect(await agent1.outbox()!.replayLastBatch(50)).toBeGreaterThan(0);
    expect(await agent2.outbox()!.replayLastBatch(50)).toBeGreaterThan(0);
    await flush(agent1);
    await flush(agent2);

    // The same `wallet.spent` again under a new envelope — a restored store, a re-queue.
    const [filed] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(and(eq(paymentAttempt.methodCode, 'wallet_credit'), eq(paymentAttempt.actionId, presses.box2!)));
    expect(filed).toBeTruthy();
    const [event] = await ctx.db
      .select()
      .from(syncEvent)
      .where(and(eq(syncEvent.boxId, box2Id), eq(syncEvent.type, 'wallet.spent')));
    await agent2.outbox()!.queue({
      type: 'wallet.spent',
      payload: event!.payload as Record<string, unknown>,
      stationId: counter2,
      actorKind: 'account',
      actorAccountId: event!.actorAccountId,
      actionId: event!.actionId,
    });
    await flush(agent2);

    const after = await balanceAndLedger();
    expect(after.balance).toBe(before.balance);
    expect(after.entries).toHaveLength(before.entries.length);
    const attemptsAfter = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.methodCode, 'wallet_credit'));
    expect(attemptsAfter).toHaveLength(attemptsBefore.length);
    expect(await overdrafts()).toHaveLength(1);
    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, overdraftAlertKey(operatorId, presses.box2!)));
    expect(raised!.occurrences).toBe(1);
  });
});

const receipts = new Map<string, string>();
const sales: { box1?: string; box2?: string; whole?: string } = {};
const presses: { box2?: string } = {};
