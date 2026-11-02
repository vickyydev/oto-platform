import { generateKeyPairSync } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { account, child, device, member, station, ticketPackage } from '@oto/db';
import { type BoxAgent, type BridgeTillCaller } from '@oto/box-agent';
import { newId, type BridgeSaleAnswer } from '@oto/shared';
import { boxStoreFor } from '../src/lib/box-store';
import { attachInProcessBox, boxAuthFromRow, configBundle, detachInProcessBox } from '../src/services/box';
import { cacheBundle } from '../src/services/sync';
import { linkedAgent, type CuttableLink } from './box-link';
import { ADMIN, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-717: the Pi bridge and the API-mounted virtual bridge must see the
 * same station decision. Missing readiness is unknown, not a new outage.
 * The native selling suite also pins every route and unresolved-money retry.
 */
let ctx: TestContext, agent: BoxAgent;
let cookie: string, stationId: string, boxId: string, packageId: string, memberId: string;
let childIds: string[], caller: BridgeTillCaller, originalRouting: unknown;
const link: CuttableLink = { cut: false };
const keys = generateKeyPairSync('ed25519');
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => ctx.app.inject({
  method, url, headers: { cookie, 'idempotency-key': newId() },
  ...(payload === undefined ? {} : { payload: payload as never }),
});
const intent = (type: string, payload: Record<string, unknown>) => call('POST', `/box/v1/station/${stationId}/intents`, {
  type, payload, lastSeenSequence: 0, actionId: newId(),
});
const lease = () => call('POST', `/box/v1/station/${stationId}/lease`, { holder: 's717-review' });

beforeAll(async () => {
  ctx = await createTestContext({ env: { OPS_TEST_CONTROLS: 'true',
    STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const box = await boxBySlot(ctx.db, 'virtual-1'); boxId = box.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, boxId), eq(station.name, 'Reception Till 1')));
  stationId = till!.id; originalRouting = till!.paymentRouting;
  const [staff] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, ADMIN.phone));
  caller = { kind: 'till', accountId: staff!.id, can: () => true, method: 'offline_token', offlineFresh: false, jti: newId() };
  expect((await call('PUT', '/me/session/station', { stationId })).statusCode).toBe(200);
  const [pkg] = await ctx.db.select({ id: ticketPackage.id }).from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, box.branchId), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;
  const [family] = await ctx.db.select({ id: member.id }).from(member).where(eq(member.phone, '+66811111111'));
  memberId = family!.id;
  childIds = (await ctx.db.select({ id: child.id }).from(child).where(eq(child.memberId, memberId)).orderBy(asc(child.name))).map(row => row.id);
  agent = linkedAgent(ctx, boxId, 's717-box', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig(); await agent.syncCache(); attachInProcessBox(agent);
}, 180_000);

afterEach(async () => {
  const session = await call('GET', `/box/v1/station/${stationId}/session`);
  const held = session.json().document?.lease?.leaseId;
  if (held) expect((await call('POST', `/box/v1/station/${stationId}/lease/release`, { leaseId: held })).statusCode).toBe(200);
  link.cut = false;
  await agent.setOffline(false);
  for (let round = 0; round < 10; round++) if ((await agent.outbox()!.flush()).state !== 'pushed') break;
  await ctx.db.update(station).set({ paymentRouting: originalRouting }).where(eq(station.id, stationId));
  await agent.syncConfig(); await agent.syncCache();
});
afterAll(async () => { agent?.stop(); if (agent) detachInProcessBox(agent); await ctx?.close(); await teardownAll(); });

async function routing(value: unknown) {
  await ctx.db.update(station).set({ paymentRouting: value }).where(eq(station.id, stationId));
  await agent.syncConfig(); await agent.syncCache();
}
async function offline() { await agent.setOffline(true); link.cut = true; }
async function tender(kind: 'card' | 'qr' | 'cash') {
  const cart = { memberId, lines: [{ id: newId(), packageId, kids: 2, adults: 1 }] };
  const quoted = await intent('cart.quote', cart);
  expect(quoted.statusCode, quoted.body).toBe(200);
  const total = quoted.json().result.quote.totals.grossSatang as number;
  const saleId = newId();
  const response = await intent(kind === 'cash' ? 'sale.finalise' : 'payment.start', {
    saleId, actionId: newId(), staffName: 'ZZ TEST s717', visitChildIds: childIds,
    cart: { ...cart, expectedTotalSatang: total },
    tender: { actionId: newId(), kind, method: kind === 'qr' ? 'promptpay' : kind, amountSatang: total,
      ...(kind === 'cash' ? { tenderedSatang: total, changeSatang: 0 } : {}) },
  });
  return { response, saleId };
}

describe('SCRUM-717: both configuration paths carry the shared selling decision', () => {
  it('HIGH pin: the Pi config and virtual cache include the same readiness and routing; keep both producers in step', async () => {
    await routing({ card: 'manual', qr: 'none' });
    const auth = boxAuthFromRow(await boxBySlot(ctx.db, 'virtual-1'));
    const config = (await configBundle(ctx.db, auth)).stations.find(row => row.id === stationId)!;
    const cached = (await cacheBundle(ctx.db, auth, { scopes: ['station_config'] })).scopes.station_config!.items as Array<Record<string, unknown>>;
    expect(config).toMatchObject({ paymentRouting: { card: 'manual', qr: 'none' }, readiness: { ready: true, reasons: [] } });
    expect(cached.find(row => row.id === stationId)).toMatchObject({ paymentRouting: config.paymentRouting, readiness: config.readiness });
  });

  it('HIGH pin: a known not-ready till is refused by the agent and the HTTP lease in the same words', async () => {
    const config = (await configBundle(ctx.db, boxAuthFromRow(await boxBySlot(ctx.db, 'virtual-1')))).stations.find(row => row.id === stationId)!;
    const terminalId = config.devices.find(row => row.role === 'qr_terminal')!.id;
    const original = config.devices.find(row => row.id === terminalId)!.protocol;
    try {
      await ctx.db.update(device).set({ protocol: null }).where(eq(device.id, terminalId));
      await routing({ card: 'manual' });
      await offline();
      const reply = await lease();
      expect(reply.statusCode).toBe(409);
      const expected = { code: 'STATION_NOT_READY', message: 'The assigned terminal has no supported protocol', details: { reasons: ['The assigned terminal has no supported protocol'] } };
      expect(reply.json().error).toMatchObject(expected);
      await expect(agent.bridge()!.claim(stationId, caller, 's717-agent', null)).rejects.toMatchObject(expected);
    } finally { await ctx.db.update(device).set({ protocol: original }).where(eq(device.id, terminalId)); }
  });

  it.each([undefined, { ready: false, reasons: [] }, { ready: 'false', reasons: ['No receipt prefix'] }])(
    'HIGH pin: an old or malformed cached readiness does not refuse a ready till (%j)', async (readiness) => {
      await routing({ card: 'manual', qr: 'none' });
      const store = boxStoreFor(ctx.db);
      const cached = (await store.readBundle(boxId, 'station_config'))!;
      const payload = cached.payload as { items: Array<Record<string, unknown>> };
      await store.writeBundle(boxId, { ...cached, payload: { ...payload, items: payload.items.map(row => row.id === stationId ? { ...row, readiness } : row) } });
      await offline();
      expect((await lease()).statusCode).toBe(200);
    },
  );
});

describe('SCRUM-717: the virtual mount uses routing while the platform is deliberately offline', () => {
  it('HIGH fixed finding: QR none must not reach an assigned PAX; publish the routing in the virtual box cache', async () => {
    await routing({ qr: 'none' }); await offline();
    const { response, saleId } = await tender('qr');
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'QR_DISABLED_FOR_STATION', message: 'This counter is not set up to take QR payments' });
    expect(await agent.sales()!.recorded(saleId)).toBeNull();
    expect((await agent.outbox()!.depth()).queued).toBe(0);
  });
  it.each([
    ['gateway QR', { qr: 'gateway' }, 'qr', 'BOX_LANE_2C2P_QR_REFUSED'],
    ['manual card', { card: 'manual' }, 'card', 'BOX_LANE_NO_TERMINAL'],
  ] as const)('HIGH pin: %s keeps its existing offline refusal and never falls through to a terminal', async (_label, value, kind, code) => {
    await routing(value); await offline();
    const { response, saleId } = await tender(kind);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe(code);
    expect(await agent.sales()!.recorded(saleId)).toBeNull();
  });
  it('control: a ready till takes a lease and records cash with the platform refusing its trading route', async () => {
    await routing({ card: 'manual', qr: 'none' }); await offline();
    expect((await lease()).statusCode).toBe(200);
    expect((await call('POST', '/sales/quote', { stationId, lines: [{ id: newId(), packageId, kids: 1, adults: 0 }] })).statusCode).toBe(503);
    const { response, saleId } = await tender('cash');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json().result as BridgeSaleAnswer;
    expect(result.finalised).toBe(true); expect(result.sale.receiptNumber).toMatch(/^T1-/);
    expect(await agent.sales()!.recorded(saleId)).not.toBeNull();
  });
});
