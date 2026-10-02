import { generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, bandEvent, sale, station, ticketPackage } from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import { newId, type BridgeSaleAnswer } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * SCRUM-494 register item 4, the box's half: a sale taken on the box with no
 * internet mints its bands there (OD-13), and each adult band takes Gate
 * access from its line's ticket package in the box's catalogue, as the
 * platform does online (`mockApi.ts:issueWalkInBands`: "from the adult's
 * ticket package"). The platform records the flag the box minted.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookie: string;
let tillId: string;
let gatePkgId: string;
let noGatePkgId: string;
let agent: BoxAgent;
const link: CuttableLink = { cut: false };

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      OPS_TEST_CONTROLS: 'true',
      STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
  });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, till!.branchId), eq(ticketPackage.name, '2 Hours Play')));
  gatePkgId = pkg!.id;
  noGatePkgId = newId();
  await ctx.db.insert(ticketPackage).values({
    ...pkg!,
    id: noGatePkgId,
    name: '2 Hours Play (no gate)',
    gateAccess: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  agent = linkedAgent(ctx, box1.id, 's494-gate-box', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx.close();
  await teardownAll();
});

describe('bands minted on the box carry their ticket line Gate access', () => {
  it('records the flag the box minted, not the ticket as it stands when the sale lands', async () => {
    const cart = {
      lines: [
        { id: newId(), packageId: gatePkgId, kids: 0, adults: 1 },
        { id: newId(), packageId: noGatePkgId, kids: 1, adults: 1 },
      ],
    };
    const quote = await call('POST', '/sales/quote', { stationId: tillId, ...cart });
    expect(quote.statusCode, JSON.stringify(quote.body)).toBe(200);
    const total = (quote.body.quote as { totals: { grossSatang: number } }).totals.grossSatang;

    await agent.setOffline(true, { reason: 's494 gate access offline' });
    link.cut = true;
    const saleId = newId();
    const res = await call('POST', `/box/v1/station/${tillId}/intents`, {
      type: 'sale.finalise',
      lastSeenSequence: 0,
      actionId: `sell-${newId().slice(-12)}`,
      payload: {
        saleId,
        actionId: `pay-${newId().slice(-12)}`,
        staffName: 'Reception',
        cart: { ...cart, expectedTotalSatang: total },
        tender: {
          actionId: `cash-${newId().slice(-12)}`,
          method: 'cash',
          kind: 'cash',
          amountSatang: total,
          tenderedSatang: total,
          changeSatang: 0,
        },
      },
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body.result as unknown as BridgeSaleAnswer).finalised).toBe(true);

    // The ticket changes while the box is offline: the band keeps what it was issued with.
    await ctx.db.update(ticketPackage).set({ gateAccess: true }).where(eq(ticketPackage.id, noGatePkgId));

    link.cut = false;
    await agent.setOffline(false);
    for (let i = 0; i < 10; i += 1) {
      const outcome = await agent.outbox()!.flush();
      if (outcome.state !== 'pushed') break;
    }

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('finalised');
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    expect(bands).toHaveLength(3);
    const adults = bands.filter((b) => b.kind === 'adult');
    expect(adults.map((b) => b.gateAccess).sort()).toEqual([false, true]);
    expect(bands.find((b) => b.kind === 'kid')!.gateAccess).toBe(false);

    const noGate = adults.find((b) => !b.gateAccess)!;
    const [minted] = await ctx.db
      .select()
      .from(bandEvent)
      .where(and(eq(bandEvent.bandId, noGate.id), eq(bandEvent.kind, 'minted')));
    expect(minted!.detail).toMatchObject({ gateAccess: false, origin: 'box' });
  });
});
