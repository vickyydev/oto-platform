import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alert, box, boxOutbox, product, sale, station, stockItem, stockLevel, syncEvent, syncQuarantine } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import { newId, type BridgeSaleAnswer } from '@oto/shared';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { describeRegressedPaidFact } from '../src/services/sync-epoch-regressed';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * SCRUM-486 gate reproduction — A SALE ALREADY IN THE LEDGER, RE-SENT ACROSS A
 * RESET, MUST NOT BE REPORTED AS "NOT IN THE LEDGER — RECORD IT BY HAND".
 *
 * The push that filed the sale lost its answer, so the box keeps the event and
 * re-sends it. Before that re-send, the reset the Console queued (while the
 * box last reported an empty outbox) runs and the platform mints the next
 * epoch. The re-sent event is on the replaced epoch, and the epoch check runs
 * before the duplicate check — so it is quarantined `epoch_regressed`, and the
 * SCRUM-486 note tells staff the sale and its money are NOT in the ledger and
 * its goods are still on the shelf, and to record it by hand. The sale IS in
 * the ledger and its cap IS off the stock level: following the row's
 * instruction records the sale, its money and its stock movement twice.
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
/** The next sync push reaches the platform, and its answer is lost on the way back. */
const losePushAnswer = { next: false };

function resendAgent(boxId: string): BoxAgent {
  const through = injectedTransport(ctx, link);
  const fetch: AgentFetch = async (url, init) => {
    const res = await through(url, init);
    if (new URL(url).pathname === '/box/v1/sync/push' && losePushAnswer.next) {
      losePushAnswer.next = false;
      throw new Error('ECONNRESET: the push answer was lost on the way back');
    }
    return res;
  };
  return createBoxAgent({
    apiBaseUrl: 'http://resend-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'resend-box',
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
const capTotal = async (): Promise<number> =>
  (await ctx.db.select({ quantity: stockLevel.quantity }).from(stockLevel).where(eq(stockLevel.stockItemId, capItemId))).reduce(
    (sum, r) => sum + r.quantity,
    0,
  );

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

  agent = resendAgent(box1.id);
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
  attachInProcessBox(agent);
  await agent.heartbeat();
}, 240_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-486 gate: an applied sale re-sent across a reset', () => {
  it('is not reported as a paid sale missing from the ledger (no instruction to record it twice)', async () => {
    const before = await platformEpoch();
    // The Console allows the reset: the box last reported an empty outbox.
    const queued = await call(cookies.admin, 'POST', `/boxes/${box1Id}/commands`, { kind: 'reset_store' });
    expect(queued.statusCode, JSON.stringify(queued.body)).toBe(200);

    // A cap sold with the link down, sealed on the current epoch.
    await agent.setOffline(true, { reason: 'gate: link down' });
    link.cut = true;
    const capsBefore = await capTotal();
    const saleId = await sellCap();
    const [event] = (
      await ctx.db.select().from(boxOutbox).where(and(eq(boxOutbox.boxId, box1Id), eq(boxOutbox.type, 'sale.finalised')))
    ).filter((e) => (e.payload as { saleId?: string }).saleId === saleId);
    expect(event?.journalEpoch).toBe(before);

    // The link returns; the push FILES the sale, and its answer is lost.
    link.cut = false;
    await boxStoreFor(ctx.db).setOffline(box1Id, false);
    losePushAnswer.next = true;
    const lost = await agent.outbox()!.flush();
    expect(lost.state).toBe('deferred');
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId)), 'the sale IS in the ledger').toHaveLength(1);
    expect(await capTotal(), 'and its cap IS off the stock level').toBe(capsBefore - 1);
    expect(await ctx.db.select().from(syncEvent).where(eq(syncEvent.eventId, event!.eventId))).toHaveLength(1);

    // The heartbeat runs the reset; the platform mints the next epoch.
    await agent.heartbeat();
    expect(await platformEpoch()).toBe(before + 1);

    // The box re-sends the event it never heard back about.
    await drain();

    const [row] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, box1Id), eq(syncQuarantine.eventId, event!.eventId)));
    // Whatever becomes of the re-sent event, it must not tell staff that a sale
    // the ledger holds is missing from it and must be recorded by hand.
    expect(row?.errorMessage ?? '', 'quarantine row tells staff to record an applied sale again').not.toContain(
      'NOT in the ledger',
    );
    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, `sync.epoch_regressed:${box1Id}`));
    expect(raised?.severity ?? null, 'a critical alert counting money that IS in the ledger').not.toBe('critical');
    expect(await capTotal()).toBe(capsBefore - 1);
    // The fix: the ledger holds it at its own address, so the re-send is answered duplicate.
    expect(row, 'an applied fact re-sent across a reset is a duplicate, not set aside').toBeUndefined();
    expect((await agent.outbox()!.depth()).queued).toBe(0);

    // With no sync_event row to vouch for it (swept), the regressed note still reads the ledger.
    const swept = await describeRegressedPaidFact(ctx.db, operatorId, 'sale.finalised', { payload: event!.payload });
    expect(swept?.detail.inLedger, JSON.stringify(swept)).toBe(true);
    expect(swept?.message).not.toContain('NOT in the ledger');
    expect(swept?.message).toContain('Already in the ledger');
    const elsewhere = await describeRegressedPaidFact(ctx.db, operatorId, 'sale.finalised', {
      payload: { ...(event!.payload as Record<string, unknown>), saleId: newId() },
    });
    expect(elsewhere?.detail.inLedger, 'a sale the ledger does not hold is still money to record').toBe(false);
    expect(elsewhere?.message).toContain('NOT in the ledger');
  });
});
