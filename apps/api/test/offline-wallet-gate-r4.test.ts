import { generateKeyPairSync } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alert, branch, paymentAttempt, product, station, syncAnomaly, wallet, walletEntry } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import { businessDate, grantExpiresAt, mintVoucherQr, newId, parseDayStart, type BridgeSaleAnswer, type BridgeWalletSpendAnswer } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { offlineUnexpireActionId, offlineUnexpiresOf } from '../src/services/sync-wallet';
import { createWalletWithGrant, expireWalletsForDay, walletPolicyOf } from '../src/services/wallet';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * GATE — S2-14a round 4, invariant (3): a normal within-balance offline spend
 * raises nothing, and the overdraft is only ever what the wallet did not have.
 *
 * The seeded wallet policy is SAME-DAY expiry. A counter whose link is down in
 * the evening spends ฿300 of a ฿500 wallet — well within what it held — and
 * reconnects the next morning, after the platform's `job:wallet.expiry` has
 * closed the day. Kept as a reproduction: the spend must be filed as the spend
 * it was (the remainder expired, not the whole balance), with no
 * `wallet_overdraft` anomaly and no critical alert.
 *
 * The ledger is append-only, so "the remainder expired" is read NET: the
 * day end's `expire` entry stands at what it took, and the sync writes a keyed
 * compensating `reactivate` (`offline:<press>:unexpire:<expire>`) for the part
 * the box had already spent, then the `spend`. Expired net of the put-back is
 * what the day lost.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let till1: string;
let productId: string;
let unitSatang: number;
let walletId: string;
let qr: string;
let agent: BoxAgent;
let grantDay: string;
const link: CuttableLink = { cut: false };

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

async function onBox<T = BridgeSaleAnswer>(type: string, payload: Record<string, unknown>): Promise<T> {
  const res = await call('POST', `/box/v1/station/${till1}/intents`, { type, lastSeenSequence: 0, payload, actionId: `g-${newId().slice(-12)}` });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body.result as T;
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: { OPS_TEST_CONTROLS: 'true', STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  });
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  till1 = t1!.id;
  branchId = t1!.branchId;
  operatorId = t1!.operatorId;
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  expect((await call('PUT', '/me/session/station', { stationId: till1 })).statusCode).toBe(200);

  const menu = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.kind, 'menu'), isNull(product.archivedAt), or(isNull(product.branchId), eq(product.branchId, branchId))))
    .orderBy(asc(product.name));
  for (const p of menu) {
    if (!p.active || p.priceSatang <= 0 || p.priceSatang > 30_000) continue;
    const quoted = await call('POST', '/sales/quote', { stationId: till1, items: [{ id: newId(), productId: p.id, quantity: 1 }], channel: 'fnb', pickupCode: '9' });
    const gross = (quoted.body.quote as { totals?: { grossSatang: number } } | undefined)?.totals?.grossSatang;
    if (quoted.statusCode === 200 && gross === p.priceSatang) {
      productId = p.id;
      unitSatang = p.priceSatang;
      break;
    }
  }
  expect(productId).toBeTruthy();

  qr = mintVoucherQr();
  // The grant as a ticket sale writes it: expiring by the branch's seeded policy (same day).
  const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
  const dayStart = parseDayStart(br!.businessDayStart);
  const policy = await walletPolicyOf(ctx.db, branchId);
  expect(policy.expiry).toBe('same_day');
  grantDay = businessDate(new Date(), br!.timezone, dayStart);
  const expiresAt = grantExpiresAt(policy, grantDay, br!.timezone, dayStart);
  const granted = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, { accountId: null, operatorId }, {
      actionId: `test:grant:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang: 50_000,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qr }],
      expiresAt,
      businessDate: grantDay,
    }),
  );
  walletId = granted.wallet.id;

  const through = injectedTransport(ctx, link);
  const fetch: AgentFetch = (url, init) => through(url, init);
  agent = createBoxAgent({
    apiBaseUrl: 'http://wallet-gate-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'wallet-gate-box',
    fetch,
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
}, 240_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx?.close();
  await teardownAll();
});

describe('GATE (3): an evening offline spend that syncs after the trading day closed', () => {
  it('is filed as a spend within balance — no overdraft anomaly, no critical alert, only the remainder expired', async () => {
    const [grant] = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, walletId), eq(walletEntry.kind, 'grant')));
    expect(grant!.expiresAt, 'the seeded policy expires credit at the end of the trading day').not.toBeNull();

    // The link goes down; the counter spends ฿300 of the ฿500 the wallet holds.
    await agent.setOffline(true, { reason: 'wallet gate r4' });
    link.cut = true;
    const plates = Math.ceil(30_000 / unitSatang) + 1;
    const o = {
      saleId: newId(),
      actionId: `pay-${newId().slice(-12)}`,
      staffName: 'Nok',
      cart: { items: [{ id: newId(), productId, quantity: plates }], channel: 'fnb', pickupCode: '9', expectedTotalSatang: plates * unitSatang },
    };
    const press = newId();
    const held = await onBox<BridgeWalletSpendAnswer>('payment.wallet', { ...o, wallet: { key: qr, actionId: press, useCredit: true } });
    expect(held.walletSpend.amountSatang).toBe(30_000);
    const rest = o.cart.expectedTotalSatang - 30_000;
    const closed = await onBox('sale.finalise', {
      ...o,
      tender: { actionId: `cash-${newId().slice(-12)}`, method: 'cash', kind: 'cash', amountSatang: rest, tenderedSatang: rest, changeSatang: 0 },
    });
    expect(closed.finalised).toBe(true);

    // Overnight the platform closes the trading day: the expiry job runs
    // (`job:wallet.expiry`) before the counter's link comes back.
    const after = new Date(grant!.expiresAt!.getTime() + 60_000);
    const expired = await expireWalletsForDay(ctx.db, branchId, grantDay, after);
    expect(expired.ended).toBe(true);
    const [expireEntry] = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, walletId), eq(walletEntry.kind, 'expire')));
    expect(expireEntry?.amountSatang, 'the day end took the whole ฿500: the spend was not filed yet').toBe(-50_000);

    // Morning: the link is back and the box syncs.
    link.cut = false;
    await agent.setOffline(false);
    for (let i = 0; i < 40 && (await agent.outbox()!.depth()).queued > 0; i += 1) {
      await agent.outbox()!.flush().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await agent.outbox()!.depth()).queued).toBe(0);

    const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, walletId));
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, walletId));
    const sum = entries.reduce((s, e) => s + e.amountSatang, 0);
    expect(sum, 'balance == sum of entries').toBe(row!.balanceSatang);

    // The guest spent ฿300 of ฿500 while the credit was live: no overdraft.
    const anomalies = await ctx.db.select().from(syncAnomaly).where(eq(syncAnomaly.kind, 'wallet_overdraft'));
    expect(anomalies.map((a) => a.detail), 'a within-balance spend raises no overdraft').toEqual([]);
    const alerts = await ctx.db.select().from(alert).where(eq(alert.category, 'wallet.offline_overdraft'));
    expect(alerts, 'and no critical alert').toHaveLength(0);
    // The ledger says what happened: ฿300 spent, ฿200 expired (net of the put-back).
    const unexpires = await offlineUnexpiresOf(ctx.db, operatorId, walletId);
    const spent = entries.filter((e) => e.kind === 'spend').reduce((s, e) => s + e.amountSatang, 0);
    const lapsed = entries.filter((e) => e.kind === 'expire').reduce((s, e) => s + e.amountSatang, 0) + unexpires.reduce((s, e) => s + e.amountSatang, 0);
    expect({ spent, lapsed }).toEqual({ spent: -30_000, lapsed: -20_000 });

    // The put-back: one keyed entry against the one expiry, for exactly what
    // the box spent, expiring at the cutoff it reverses, so it is never live
    // credit — and the wallet ends as the day end left it: closed at ฿0.
    expect(unexpires).toHaveLength(1);
    expect(unexpires[0]).toMatchObject({
      actionId: offlineUnexpireActionId(press, expireEntry!.id),
      kind: 'reactivate',
      source: 'reactivation',
      amountSatang: 30_000,
      offline: true,
      saleId: o.saleId,
      stationId: till1,
      balanceAfter: 30_000,
    });
    expect(unexpires[0]!.expiresAt?.toISOString()).toBe(grant!.expiresAt!.toISOString());
    expect(unexpires[0]!.payload).toMatchObject({ unexpire: true, unexpireOf: expireEntry!.id, pressActionId: press, askedSatang: 30_000 });
    expect(row).toMatchObject({ status: 'expired', balanceSatang: 0 });
    const spendEntry = entries.find((e) => e.kind === 'spend');
    expect(spendEntry).toMatchObject({ amountSatang: -30_000, balanceAfter: 0, offline: true, saleId: o.saleId });
    expect(spendEntry!.payload).toMatchObject({ askedSatang: 30_000, unexpiredSatang: 30_000 });
    // The tender stands at what the box took, with no overdraft on it.
    const [credit] = await ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.saleId, o.saleId), eq(paymentAttempt.method, 'wallet')));
    expect(credit).toMatchObject({ amountSatang: 30_000, offline: true, status: 'approved' });
    expect((credit!.payload as { overdraftSatang?: number }).overdraftSatang).toBeUndefined();
  });
});
