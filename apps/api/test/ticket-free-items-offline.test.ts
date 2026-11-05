import { generateKeyPairSync } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, child, employee, member, sale, saleLine, station, ticketPackage } from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import { newId, saleReceiptDocument, type BridgeSaleAnswer } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * SCRUM-768 — THE TICKET'S FREE ITEMS TRAVEL WITH THE BOX'S CATALOGUE COPY.
 *
 * The box prices a sale with the same shared engine when the link is down,
 * from its own copy of the catalogue. The copy carries the free items Admin set
 * on the ticket, so the box takes the same money the platform would, prints the
 * free units at ฿0, and files the sale with the free items it was priced with
 * even when Admin changes them before the link comes back. The harness is
 * `offline-selling.test.ts`'s: the virtual box's agent behind the api's mount
 * of the station bridge, with its link cut.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookie: string;
let tillId: string;
let packageId: string;
let maliId: string;
let children: string[];
let staffName: string;
let agent: BoxAgent;
const link: CuttableLink = { cut: false };

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

async function onBox(type: string, payload: Record<string, unknown>): Promise<BridgeSaleAnswer> {
  const res = await call('POST', `/box/v1/station/${tillId}/intents`, {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `sell-${newId().slice(-12)}`,
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body.result as unknown as BridgeSaleAnswer;
}

/** Admin → Tickets saving the ticket's free items, as its form saves them. */
async function setFreebies(freebies: unknown[] | null) {
  await ctx.db.update(ticketPackage).set({ freebies: freebies as never }).where(eq(ticketPackage.id, packageId));
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
  packageId = pkg!.id;
  const [mali] = await ctx.db.select().from(member).where(eq(member.phone, '+66811111111'));
  maliId = mali!.id;
  children = (
    await ctx.db.select({ id: child.id }).from(child).where(eq(child.memberId, maliId)).orderBy(asc(child.name))
  ).map((c) => c.id);
  const [staff] = await ctx.db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.phone, RECEPTION.phone));
  staffName = staff?.nickname ?? staff?.name ?? 'Reception';

  // The ticket bundles a free child and a free adult for every seeded tier,
  // and the box pulls its catalogue copy after Admin saved them.
  const tiers = ['tourist', 'expat', 'thai'];
  await setFreebies([
    { id: 'fb-child', kind: 'child', quantity: 1, tiers },
    { id: 'fb-adult', kind: 'adult', quantity: 1, tiers },
  ]);
  agent = linkedAgent(ctx, box1.id, 'free-items-box', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
  expect(await agent.heartbeat(), 'the box could not measure its clock').toBeTruthy();
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx.close();
  await teardownAll();
});

describe('a sale taken on the box with the link down', () => {
  it('is priced with the free items, printed with them, and filed with them', async () => {
    // Two kids and an adult for Mali: one child and the adult are free.
    const cart = { memberId: maliId, lines: [{ id: newId(), packageId, kids: 2, adults: 1 }] };
    const quote = await call('POST', '/sales/quote', { stationId: tillId, ...cart });
    expect(quote.statusCode, JSON.stringify(quote.body)).toBe(200);
    const quoted = quote.body.quote as { totals: { grossSatang: number }; lines: Array<{ componentKey: string; grossSatang: number }> };
    const total = quoted.totals.grossSatang;
    expect(quoted.lines.map((l) => [l.componentKey, l.grossSatang])).toEqual([
      ['kids', total],
      ['kids-free', 0],
      ['adults-free', 0],
    ]);

    await agent.setOffline(true, { reason: 'free items offline' });
    link.cut = true;
    const taken = await onBox('sale.finalise', {
      saleId: newId(),
      actionId: `pay-${newId().slice(-12)}`,
      staffName,
      visitChildIds: children,
      cart: { ...cart, expectedTotalSatang: total },
      tender: {
        actionId: `cash-${newId().slice(-12)}`,
        method: 'cash',
        kind: 'cash',
        amountSatang: total,
        tenderedSatang: total,
        changeSatang: 0,
      },
    });
    expect(taken.finalised).toBe(true);
    expect(taken.sale.totals.grossSatang).toBe(total);
    const logged = await agent.sales()!.recorded(taken.sale.id);
    const printed = saleReceiptDocument(logged!.snapshot!).lines;
    expect(printed.map((l) => [l.qty, l.name, l.price])).toEqual(
      expect.arrayContaining([
        [1, expect.stringContaining('Kids (free)'), '฿0'],
        [1, expect.stringContaining('Adults (free)'), '฿0'],
      ]),
    );

    // Admin takes the free items off before the link comes back: the sale is
    // still filed at the money the box took, with the free items it was priced with.
    await setFreebies(null);
    link.cut = false;
    await agent.setOffline(false);
    for (let i = 0; i < 10; i += 1) {
      const outcome = await agent.outbox()!.flush();
      if (outcome.state !== 'pushed') break;
    }
    const [filed] = await ctx.db.select().from(sale).where(eq(sale.id, taken.sale.id));
    expect(filed).toMatchObject({ status: 'finalised', origin: 'box', grossSatang: total });
    const lines = await ctx.db
      .select()
      .from(saleLine)
      .where(eq(saleLine.saleId, taken.sale.id))
      .orderBy(asc(saleLine.lineNo));
    expect(lines.map((l) => [l.componentKey, l.quantity, l.grossSatang])).toEqual([
      ['kids', 1, total],
      ['kids-free', 1, 0],
      ['adults-free', 1, 0],
    ]);
  });
});
