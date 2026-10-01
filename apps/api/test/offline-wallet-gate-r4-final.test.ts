import { generateKeyPairSync } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, product, station, wallet, walletEntry } from '@oto/db';
import {
  WALLET_SPEND_TOTAL_DAY,
  WALLET_SPEND_TOTAL_SCOPE,
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { addDaysToIsoDate, businessDate, businessDayEndsAt, grantExpiresAt, mintVoucherQr, newId, parseDayStart } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { walletCacheItem } from '../src/services/sync-wallet';
import {
  createWalletWithGrant,
  debitWallet,
  expireWalletsForDay,
  lapsedCreditOf,
  reactivateWallet,
  walletPolicyOf,
} from '../src/services/wallet';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * GATE FINAL CHECK — S2-14a round 4, the reactivation expiry fix.
 *
 *   A. expired, reactivated, HALF SPENT ONLINE, then cached: the box offers
 *      exactly what the online counter could spend (balance less lapsed
 *      credit), and no WALLET_EXPIRED.
 *   B. genuinely expired (yesterday's credit, day end not run yet): ships as
 *      unspendable (฿0, past expiry); the box refuses WALLET_EXPIRED and
 *      writes nothing.
 *   C. genuinely expired and closed by the day end: not on the box at all;
 *      refused WALLET_NOT_ON_BOX, nothing written.
 *   D. reactivated, and then the REACTIVATION's own cutoff passed (day end
 *      not run yet): the fix must not make a reactivation live for ever —
 *      ships unspendable, refused WALLET_EXPIRED.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let till1: string;
let productId: string;
let unitSatang: number;
let agent: BoxAgent;
let boxId: string;
const link: CuttableLink = { cut: false };
const W: Record<'A' | 'B' | 'C' | 'D', { id: string; qr: string }> = {} as never;

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

async function offline<T>(fn: () => Promise<T>): Promise<T> {
  await agent.setOffline(true, { reason: 'wallet gate r4 final' });
  link.cut = true;
  try {
    return await fn();
  } finally {
    link.cut = false;
    await agent.setOffline(false);
  }
}

const lookup = (qr: string) =>
  call('POST', `/box/v1/station/${till1}/intents`, {
    type: 'wallet.lookup',
    lastSeenSequence: 0,
    payload: { key: qr },
    actionId: `l-${newId().slice(-12)}`,
  });

const press = (qr: string) =>
  call('POST', `/box/v1/station/${till1}/intents`, {
    type: 'payment.wallet',
    lastSeenSequence: 0,
    payload: {
      saleId: newId(),
      actionId: `pay-${newId().slice(-12)}`,
      staffName: 'Nok',
      cart: { items: [{ id: newId(), productId, quantity: 1 }], channel: 'fnb', pickupCode: '9', expectedTotalSatang: unitSatang },
      wallet: { key: qr, actionId: newId(), useCredit: true },
    },
    actionId: `g-${newId().slice(-12)}`,
  });

const onBox = (walletId: string) =>
  boxStoreFor(ctx.db).readCounter(boxId, { scope: WALLET_SPEND_TOTAL_SCOPE, key: walletId, businessDate: WALLET_SPEND_TOTAL_DAY });

beforeAll(async () => {
  ctx = await createTestContext({
    env: { OPS_TEST_CONTROLS: 'true', STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  });
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  boxId = box1.id;
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

  const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
  const tz = br!.timezone;
  const dayStart = parseDayStart(br!.businessDayStart);
  const policy = await walletPolicyOf(ctx.db, branchId);
  const today = businessDate(new Date(), tz, dayStart);
  const yesterday = addDaysToIsoDate(today, -1);
  const twoDaysAgo = addDaysToIsoDate(today, -2);
  const actor = { accountId: null, operatorId };
  const grant = async (day: string) => {
    const qr = mintVoucherQr();
    const g = await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, actor, {
        actionId: `test:grant:${newId()}`,
        branchId,
        holderName: 'Walk-in guest',
        amountSatang: 50_000,
        source: 'ticket_sale',
        keys: [{ kind: 'voucher_qr', value: qr }],
        expiresAt: grantExpiresAt(policy, day, tz, dayStart),
        businessDate: day,
      }),
    );
    return { id: g.wallet.id, qr };
  };

  // A and C: yesterday's credit; yesterday's day end takes both.
  W.A = await grant(yesterday);
  W.C = await grant(yesterday);
  // C spent to nothing would not close with money; leave it to the day end.
  expect((await expireWalletsForDay(ctx.db, branchId, yesterday, new Date())).ended).toBe(true);
  // A: brought back today, then half spent at a counter online.
  await ctx.db.transaction((tx) => reactivateWallet(tx, actor, { walletId: W.A.id, reason: 'guest came back, manager approved' }));
  await ctx.db.transaction((tx) =>
    debitWallet(tx, actor, { walletId: W.A.id, actionId: `test:online-spend:${newId()}`, amountSatang: 25_000, source: 'fnb_order', branchId }),
  );
  // B: yesterday's credit, created AFTER yesterday's day end ran (so not taken yet).
  W.B = await grant(yesterday);
  // D: two days ago's credit, expired by that day end, reactivated YESTERDAY —
  //    the reactivation's own cutoff (yesterday's end) has passed, and
  //    yesterday's day end has not been run for it.
  W.D = await grant(twoDaysAgo);
  expect((await expireWalletsForDay(ctx.db, branchId, twoDaysAgo, new Date())).ended).toBe(true);
  const midYesterday = new Date(businessDayEndsAt(yesterday, tz, dayStart).getTime() - 6 * 3600_000);
  await ctx.db.transaction((tx) => reactivateWallet(tx, actor, { walletId: W.D.id, reason: 'brought back yesterday', now: midYesterday }));

  const through = injectedTransport(ctx, link);
  const fetch: AgentFetch = (url, init) => through(url, init);
  agent = createBoxAgent({
    apiBaseUrl: 'http://wallet-gate-final-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'wallet-gate-final-box',
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

describe('GATE FINAL (1): expired, reactivated, half spent online, then cached', () => {
  it('the snapshot carries exactly the live spendable amount and a live expiry', async () => {
    const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, W.A.id));
    expect(row!.status).toBe('active');
    expect(row!.balanceSatang).toBe(25_000);
    const liveSpendable = row!.balanceSatang - (await lapsedCreditOf(ctx.db, row!, new Date()));
    expect(liveSpendable).toBe(25_000);
    const item = await walletCacheItem(ctx.db, { boxId, operatorId, branchId });
    const entry = item.wallets.find((w) => w.id === W.A.id)!;
    expect(entry.balanceSatang).toBe(liveSpendable);
    expect(entry.expiresAt === null || Date.parse(entry.expiresAt) > Date.now()).toBe(true);
  });

  it('the box offers exactly that with the link down, and a press takes it — no WALLET_EXPIRED', async () => {
    const res = await offline(async () => {
      const looked = await lookup(W.A.qr);
      expect(JSON.stringify(looked.body)).not.toContain('WALLET_EXPIRED');
      expect(looked.statusCode, JSON.stringify(looked.body)).toBe(200);
      const view = (looked.body.result as { wallet: { balanceSatang: number; spendableSatang: number; capSatang: number } }).wallet;
      expect(view.balanceSatang).toBe(25_000);
      expect(view.spendableSatang).toBe(Math.min(25_000, view.capSatang));
      return press(W.A.qr);
    });
    expect(JSON.stringify(res.body)).not.toContain('WALLET_EXPIRED');
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const spent = (res.body.result as { walletSpend: { amountSatang: number } }).walletSpend.amountSatang;
    expect(spent).toBe(Math.min(unitSatang, 25_000));
    expect(await onBox(W.A.id)).toBe(spent);
  });
});

describe('GATE FINAL (2): a genuinely expired wallet stays unspendable on the box', () => {
  it('B — credit lapsed, day end not run: ships at ฿0 with its past expiry; refused WALLET_EXPIRED, nothing written', async () => {
    const item = await walletCacheItem(ctx.db, { boxId, operatorId, branchId });
    const entry = item.wallets.find((w) => w.id === W.B.id)!;
    expect(entry, 'still active on the ledger until the day end runs').toBeTruthy();
    expect(entry.balanceSatang).toBe(0);
    expect(entry.expiresAt).not.toBeNull();
    expect(Date.parse(entry.expiresAt!)).toBeLessThanOrEqual(Date.now());
    const [looked, pressed] = await offline(async () => [await lookup(W.B.qr), await press(W.B.qr)] as const);
    for (const r of [looked, pressed]) {
      expect(r.statusCode).toBe(409);
      expect(JSON.stringify(r.body)).toContain('WALLET_EXPIRED');
      expect(JSON.stringify(r.body)).toContain('only a manager can bring it back');
    }
    expect(await onBox(W.B.id)).toBe(0);
  });

  it('C — closed by the day end: not on the box; refused WALLET_NOT_ON_BOX, nothing written', async () => {
    const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, W.C.id));
    expect(row!.status).toBe('expired');
    const item = await walletCacheItem(ctx.db, { boxId, operatorId, branchId });
    expect(item.wallets.find((w) => w.id === W.C.id)).toBeUndefined();
    const pressed = await offline(() => press(W.C.qr));
    expect(pressed.statusCode).toBe(404);
    expect(JSON.stringify(pressed.body)).toContain('WALLET_NOT_ON_BOX');
    expect(await onBox(W.C.id)).toBe(0);
  });

  it('D — reactivated, then the reactivation’s own cutoff passed: ships unspendable; refused WALLET_EXPIRED', async () => {
    const [react] = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, W.D.id), eq(walletEntry.kind, 'reactivate')));
    expect(react!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const item = await walletCacheItem(ctx.db, { boxId, operatorId, branchId });
    const entry = item.wallets.find((w) => w.id === W.D.id)!;
    expect(entry).toBeTruthy();
    expect(entry.balanceSatang).toBe(0);
    expect(Date.parse(entry.expiresAt!)).toBeLessThanOrEqual(Date.now());
    const pressed = await offline(() => press(W.D.qr));
    expect(pressed.statusCode).toBe(409);
    expect(JSON.stringify(pressed.body)).toContain('WALLET_EXPIRED');
    expect(await onBox(W.D.id)).toBe(0);
  });
});
