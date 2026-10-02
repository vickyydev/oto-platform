import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert,
  box,
  boxOutbox,
  product,
  sale,
  station,
  stockItem,
  stockLevel,
  stockLocation,
  syncAnomaly,
  syncQuarantine,
} from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import { newId, type BridgeSaleAnswer } from '@oto/shared';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * SCRUM-486 — THE BOX ADOPTS THE PLATFORM'S EPOCH; A PAID SALE ON A REPLACED
 * ONE IS NEVER LOST.
 *
 * Reception Till 1's box — the code a Pi runs, over the platform's own `edge`
 * store — joined to the api by a link the test can cut, and whose answer to a
 * command result the test can lose on the way back.
 *
 *  1. Reset the store with its answer lost; the platform has minted the next
 *     epoch, the box's store has not heard. The next heartbeat names it, and
 *     the box adopts it into the STORE. A cap sold with the link down is
 *     sealed on the new epoch and, back online, FILED: in the ledger, and off
 *     the stock level. (Before SCRUM-486 the heartbeat set only the in-memory
 *     epoch, the sale was sealed on the replaced one, and it came back
 *     `epoch_regressed`.)
 *  2. A cap sold BEFORE the box adopts (sealed on the old epoch) and pushed
 *     after: not lost and not applied on the wrong journal — set aside in
 *     quarantine with a CRITICAL alert, and the quarantine row names the sale,
 *     its money and its goods (Oto Cap × 1) as still counted on the shelf, so
 *     staff can record them by hand. The ledger and the stock level are
 *     untouched by it.
 */

let ctx: TestContext;
let cookies: { till1: string; admin: string };
let operatorId: string;
let till1: string;
let box1Id: string;
let capId: string;
let capItemId: string;
let capUnitSatang: number;
let agent: BoxAgent;
const link: CuttableLink = { cut: false };
/** The next command result reaches the platform, and its answer is lost on the way back. */
const loseResultAnswer = { next: false };

function epochAgent(boxId: string): BoxAgent {
  const through = injectedTransport(ctx, link);
  const fetch: AgentFetch = async (url, init) => {
    const res = await through(url, init);
    if (/\/box\/v1\/commands\/[^/]+\/result$/.test(new URL(url).pathname) && loseResultAnswer.next) {
      loseResultAnswer.next = false;
      throw new Error('ECONNRESET: the answer was lost on the way back');
    }
    return res;
  };
  return createBoxAgent({
    apiBaseUrl: 'http://epoch-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'epoch-box',
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

/** One cap, rung up at Reception Till 1 on the box lane, paid in cash. */
async function sellCap(): Promise<string> {
  const saleId = newId();
  const res = await call(cookies.till1, 'POST', `/box/v1/station/${till1}/intents`, {
    type: 'sale.finalise',
    lastSeenSequence: 0,
    actionId: `s-${newId().slice(-12)}`,
    payload: {
      saleId,
      actionId: `pay-${newId().slice(-12)}`,
      staffName: 'Nok',
      cart: { items: [{ id: newId(), productId: capId, quantity: 1 }], channel: 'shop', expectedTotalSatang: capUnitSatang },
      tender: {
        actionId: `cash-${newId().slice(-12)}`,
        method: 'cash',
        kind: 'cash',
        amountSatang: capUnitSatang,
        tenderedSatang: capUnitSatang,
        changeSatang: 0,
      },
    },
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  expect((res.body.result as BridgeSaleAnswer).finalised).toBe(true);
  return saleId;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    for (let j = 0; j < 10; j += 1) {
      const outcome = await agent.outbox()!.flush().catch(() => ({ state: 'deferred' as const }));
      if (outcome.state !== 'pushed') break;
    }
    if ((await agent.outbox()!.depth()).queued === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const platformEpoch = async (): Promise<number> =>
  (await ctx.db.select({ epoch: box.currentEpoch }).from(box).where(eq(box.id, box1Id)))[0]!.epoch;
const storeEpoch = async (): Promise<number> => (await boxStoreFor(ctx.db).readState(box1Id)).journalEpoch;
const capTotal = async (): Promise<number> =>
  (await ctx.db.select({ quantity: stockLevel.quantity }).from(stockLevel).where(eq(stockLevel.stockItemId, capItemId))).reduce(
    (sum, r) => sum + r.quantity,
    0,
  );

async function queueReset(): Promise<void> {
  const queued = await call(cookies.admin, 'POST', `/boxes/${box1Id}/commands`, { kind: 'reset_store' });
  expect(queued.statusCode, JSON.stringify(queued.body)).toBe(200);
}

beforeAll(async () => {
  ctx = await createTestContext();
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  box1Id = box1.id;
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  till1 = t1!.id;
  operatorId = t1!.operatorId;
  cookies = {
    till1: await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password),
    admin: await signInAs(ctx.app, ADMIN.phone, ADMIN.password),
  };
  expect((await call(cookies.till1, 'PUT', '/me/session/station', { stationId: till1 })).statusCode).toBe(200);

  const [cap] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'MR-CAP'), isNull(product.archivedAt)));
  capId = cap!.id;
  const quoted = await call(cookies.till1, 'POST', '/sales/quote', {
    stationId: till1,
    items: [{ id: newId(), productId: capId, quantity: 1 }],
    channel: 'shop',
  });
  expect(quoted.statusCode, JSON.stringify(quoted.body)).toBe(200);
  capUnitSatang = (quoted.body.quote as { totals: { grossSatang: number } }).totals.grossSatang;
  const [item] = await ctx.db
    .select()
    .from(stockItem)
    .where(and(eq(stockItem.branchId, t1!.branchId), eq(stockItem.productId, capId), isNull(stockItem.archivedAt)));
  capItemId = item!.id;
  expect((await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, t1!.branchId))).length).toBeGreaterThan(0);

  agent = epochAgent(box1.id);
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
  attachInProcessBox(agent);
  // A heartbeat, so the Console knows the outbox is empty and allows a reset.
  await agent.heartbeat();
}, 240_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-486: a lost reset_store answer', () => {
  it('the heartbeat after it carries the new epoch into the box STORE, and the next offline sale is filed — ledger and stock', async () => {
    const before = await platformEpoch();
    expect(await storeEpoch()).toBe(before);

    await queueReset();
    loseResultAnswer.next = true;
    await expect(agent.runPendingCommands()).rejects.toThrow(/ECONNRESET/);
    expect(await platformEpoch()).toBe(before + 1);
    expect(await storeEpoch(), 'the lost answer told the store nothing').toBe(before);

    // A quiet box: nothing queued, so nothing pushes. The heartbeat is all it hears.
    await agent.heartbeat();
    expect(await storeEpoch(), 'adopted into the store, not only into memory').toBe(before + 1);
    expect(agent.state.epoch).toBe(before + 1);

    const capsBefore = await capTotal();
    await agent.setOffline(true, { reason: 'SCRUM-486 link down' });
    link.cut = true;
    const saleId = await sellCap();
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);

    link.cut = false;
    await agent.setOffline(false);
    await drain();

    const [filed] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(filed, 'the sale is in the ledger').toBeTruthy();
    expect(await capTotal(), 'and its cap came off the stock level').toBe(capsBefore - 1);
    const regressed = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, box1Id), eq(syncQuarantine.reason, 'epoch_regressed')));
    expect(regressed, 'nothing set aside for its epoch').toHaveLength(0);
  });

  it('a sale sealed BEFORE the adoption and pushed after it is set aside with a critical alert naming its money and its goods — never lost, never applied on the wrong journal', async () => {
    await agent.heartbeat();
    const before = await platformEpoch();
    expect(await storeEpoch()).toBe(before);
    // Queued while the outbox is empty, as the Console requires.
    await queueReset();

    // The link goes; a cap is sold and sealed on the CURRENT epoch.
    await agent.setOffline(true, { reason: 'SCRUM-486 link down again' });
    link.cut = true;
    const capsBefore = await capTotal();
    const saleId = await sellCap();
    const [queued] = (
      await ctx.db
        .select()
        .from(boxOutbox)
        .where(and(eq(boxOutbox.boxId, box1Id), eq(boxOutbox.type, 'sale.finalised'), eq(boxOutbox.state, 'queued')))
    ).filter((e) => (e.payload as { saleId?: string }).saleId === saleId);
    expect(queued?.journalEpoch, 'sealed on the epoch the platform is still on').toBe(before);

    // The toggle goes back on disk with nothing pushed, the link returns, and
    // the next heartbeat finds the reset: the platform mints, the answer is lost.
    await boxStoreFor(ctx.db).setOffline(box1Id, false);
    link.cut = false;
    loseResultAnswer.next = true;
    await expect(agent.heartbeat()).rejects.toThrow(/ECONNRESET/);
    expect(await platformEpoch()).toBe(before + 1);
    await agent.heartbeat();
    expect(await storeEpoch()).toBe(before + 1);

    // Now the old-epoch sale goes up.
    await drain();
    expect((await agent.outbox()!.depth()).queued, 'settled on the box, not re-sent for ever').toBe(0);

    // Not applied: no sale, and the cap is still counted on the shelf.
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);
    expect(await capTotal()).toBe(capsBefore);

    // Set aside, with a row that names the money and the goods.
    const [row] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, box1Id), eq(syncQuarantine.eventId, queued!.eventId)));
    expect(row).toMatchObject({ reason: 'epoch_regressed', status: 'open', type: 'sale.finalised', journalEpoch: before });
    expect(row!.errorMessage).toContain(`replaced by ${before + 1}`);
    expect(row!.errorMessage).toContain('PAID SALE set aside');
    expect(row!.errorMessage).toContain(saleId);
    expect(row!.errorMessage).toContain('NOT in the ledger');
    expect(row!.errorMessage).toContain('Oto Cap × 1');
    expect(row!.errorMessage).toContain("NOT taken off the platform's stock level");
    expect((row!.payload as { payload: { saleId: string } }).payload.saleId, 'the whole envelope is kept').toBe(saleId);

    const [anomaly] = await ctx.db
      .select()
      .from(syncAnomaly)
      .where(and(eq(syncAnomaly.eventId, queued!.eventId), eq(syncAnomaly.kind, 'epoch_regressed')));
    expect(anomaly?.detail).toMatchObject({
      sentEpoch: before,
      currentEpoch: before + 1,
      paid: {
        type: 'sale.finalised',
        saleId,
        takenSatang: capUnitSatang,
        units: [{ item: 'Oto Cap', productId: capId, quantity: 1 }],
      },
    });

    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, `sync.epoch_regressed:${box1Id}`));
    expect(raised).toMatchObject({ category: 'sync.epoch_regressed', severity: 'critical' });
    expect(raised!.summary).toContain('PAID');
    expect(raised!.detail).toMatchObject({ paidCount: 1, paidSatang: capUnitSatang, paidSaleIds: [saleId] });

    // And the next sale is on the new journal, and filed.
    await agent.setOffline(true, { reason: 'SCRUM-486 one more' });
    link.cut = true;
    const next = await sellCap();
    link.cut = false;
    await agent.setOffline(false);
    await drain();
    expect(await ctx.db.select().from(sale).where(eq(sale.id, next))).toHaveLength(1);
    expect(await capTotal()).toBe(capsBefore - 1);
  });
});
