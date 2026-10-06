import { generateKeyPairSync } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, asc, eq, isNull, ne, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, product, sale, station, walletEntry } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import { addDaysToIsoDate, businessDate, grantExpiresAt, mintVoucherQr, newId, parseDayStart } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { walletCacheItem } from '../src/services/sync-wallet';
import { createWalletWithGrant, expireWalletsForDay, reactivateWallet, walletPolicyOf } from '../src/services/wallet';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * GATE RE-CHECK — S2-14a round 4, invariant (4) HONEST REFUSALS.
 *
 * A wallet a manager brought back (`reactivateWallet`) is live: status
 * `active`, its credit on a `reactivate` entry with a fresh `expires_at` from
 * today's policy. The `wallets` snapshot computes `expiresAt` from `grant`
 * entries only, so it ships the OLD grant's past cutoff, and the box refuses
 * the press as WALLET_EXPIRED — "only a manager can bring it back" — for a
 * wallet a manager just brought back. The online counter
 * (`creditExpiresAt`) reads grant AND reactivate entries.
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
let boxId: string;
const link: CuttableLink = { cut: false };

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

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

  // Yesterday's ticket grant, expired by yesterday's day end, then brought back today by a manager.
  qr = mintVoucherQr();
  const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
  const dayStart = parseDayStart(br!.businessDayStart);
  const policy = await walletPolicyOf(ctx.db, branchId);
  const today = businessDate(new Date(), br!.timezone, dayStart);
  const yesterday = addDaysToIsoDate(today, -1);
  const granted = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, { accountId: null, operatorId }, {
      actionId: `test:grant:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang: 50_000,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qr }],
      expiresAt: grantExpiresAt(policy, yesterday, br!.timezone, dayStart),
      businessDate: yesterday,
    }),
  );
  walletId = granted.wallet.id;
  const done = await expireWalletsForDay(ctx.db, branchId, yesterday, new Date());
  expect(done.ended).toBe(true);
  await ctx.db.transaction((tx) => reactivateWallet(tx, { accountId: null, operatorId }, { walletId, reason: 'guest came back, manager approved' }));

  const through = injectedTransport(ctx, link);
  const fetch: AgentFetch = (url, init) => through(url, init);
  agent = createBoxAgent({
    apiBaseUrl: 'http://wallet-gate-recheck-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'wallet-gate-recheck-box',
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

describe('GATE RE-CHECK (4): a wallet a manager reactivated', () => {
  it('ships in the snapshot with the reactivation’s expiry, not the dead grant’s', async () => {
    const [react] = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, walletId), eq(walletEntry.kind, 'reactivate')));
    expect(react?.expiresAt, 'the reactivation carries a fresh expiry').not.toBeNull();
    expect(react!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    const item = await walletCacheItem(ctx.db, { boxId, operatorId, branchId });
    const entry = item.wallets.find((w) => w.id === walletId);
    expect(entry, 'a live reactivated wallet is in the snapshot').toBeTruthy();
    expect(entry!.status).toBe('active');
    const at = entry!.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(entry!.expiresAt);
    expect(at, 'the snapshot must not say a live wallet expired').toBeGreaterThan(Date.now());
  });

  it('is spendable on the box lane with the link down, not refused as WALLET_EXPIRED', async () => {
    await agent.setOffline(true, { reason: 'wallet gate r4 recheck' });
    link.cut = true;
    try {
      const o = {
        saleId: newId(),
        actionId: `pay-${newId().slice(-12)}`,
        staffName: 'Nok',
        cart: { items: [{ id: newId(), productId, quantity: 1 }], channel: 'fnb', pickupCode: '9', expectedTotalSatang: unitSatang },
      };
      const res = await call('POST', `/box/v1/station/${till1}/intents`, {
        type: 'payment.wallet',
        lastSeenSequence: 0,
        payload: { ...o, wallet: { key: qr, actionId: newId(), useCredit: true } },
        actionId: `g-${newId().slice(-12)}`,
      });
      expect(JSON.stringify(res.body)).not.toContain('WALLET_EXPIRED');
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    } finally {
      link.cut = false;
      await agent.setOffline(false);
    }
  });
});

describe('an operator wallet at a second park', () => {
  it('ships only this operator’s digests, then spends offline at the box’s park and syncs once', async () => {
    const [issuingPark] = await ctx.db.select().from(branch).where(and(eq(branch.operatorId, operatorId), ne(branch.id, branchId)));
    const [foreignPark] = await ctx.db.select().from(branch).where(ne(branch.operatorId, operatorId));
    const crossKey = mintVoucherQr();
    const foreignKey = mintVoucherQr();
    const cross = await ctx.db.transaction((tx) => createWalletWithGrant(tx, { accountId: null, operatorId }, {
      actionId: `test:cross-park:${newId()}`, branchId: issuingPark!.id, holderName: 'Walk-in guest',
      amountSatang: 50_000, source: 'ticket_sale', keys: [{ kind: 'voucher_qr', value: crossKey }],
    }));
    const foreign = await ctx.db.transaction((tx) => createWalletWithGrant(tx, { accountId: null, operatorId: foreignPark!.operatorId }, {
      actionId: `test:foreign:${newId()}`, branchId: foreignPark!.id, holderName: 'Walk-in guest',
      amountSatang: 50_000, source: 'ticket_sale', keys: [{ kind: 'voucher_qr', value: foreignKey }],
    }));
    const snapshot = await walletCacheItem(ctx.db, { boxId, operatorId, branchId });
    expect(snapshot.branchId).toBe(branchId);
    expect(snapshot.capSatang).toBe((await walletPolicyOf(ctx.db, branchId)).offlineCapSatang);
    expect(snapshot.wallets.some((entry) => entry.id === cross.wallet.id)).toBe(true);
    expect(snapshot.wallets.some((entry) => entry.id === foreign.wallet.id)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(crossKey);
    expect(JSON.stringify(snapshot)).not.toContain(foreignKey);

    await agent.syncWallets();
    await agent.setOffline(true, { reason: 'cross-park wallet test' });
    link.cut = true;
    const saleId = newId();
    try {
      const order = {
        saleId, actionId: `pay-${newId().slice(-12)}`, staffName: 'Nok',
        cart: { items: [{ id: newId(), productId, quantity: 1 }], channel: 'fnb', pickupCode: '9', expectedTotalSatang: unitSatang },
      };
      const paid = await call('POST', `/box/v1/station/${till1}/intents`, {
        type: 'payment.wallet', lastSeenSequence: 0,
        payload: { ...order, wallet: { key: crossKey, actionId: newId(), useCredit: true } },
        actionId: `cross-${newId().slice(-12)}`,
      });
      expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
      expect((paid.body.result as { walletSpend: { amountSatang: number }; finalised: boolean }).walletSpend.amountSatang).toBe(unitSatang);
      expect((paid.body.result as { finalised: boolean }).finalised).toBe(true);
    } finally {
      link.cut = false;
      await agent.setOffline(false);
    }
    for (let i = 0; i < 5 && (await agent.outbox()!.depth()).queued > 0; i += 1) await agent.outbox()!.flush();
    expect((await agent.outbox()!.depth()).queued).toBe(0);
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, cross.wallet.id));
    expect(entries.find((entry) => entry.kind === 'grant')?.branchId).toBe(issuingPark!.id);
    expect(entries.filter((entry) => entry.kind === 'spend')).toHaveLength(1);
    expect(entries.find((entry) => entry.kind === 'spend')?.branchId).toBe(branchId);
    expect((await ctx.db.select().from(sale).where(eq(sale.id, saleId)))[0]?.status).toBe('finalised');
    await agent.outbox()!.replayLastBatch(50);
    for (let i = 0; i < 5 && (await agent.outbox()!.depth()).queued > 0; i += 1) await agent.outbox()!.flush();
    expect((await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, cross.wallet.id), eq(walletEntry.kind, 'spend'))))).toHaveLength(1);
  });
});
