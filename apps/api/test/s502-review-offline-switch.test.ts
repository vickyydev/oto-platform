import { generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, checkin, product, station, ticketPackage } from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * SCRUM-503 REVIEW, item 4 — the Console's Go offline switch and the
 * counter's band scan, on a real band in a real stay.
 *
 * The switch is the box command the Console sends (`go_offline`), whose
 * handler is `agent.setOffline`. With it on, the platform must refuse the
 * scan the way it refuses every other trading call at that till, so the till
 * reads the band from its box — and the box must hold the same child, the
 * same allergy line and the same prepaid food. Off again, the platform reads
 * it as before. Nobody else is caught: a till on another box, a Console
 * account with no till, and the till's own non-trading reads.
 */

const keys = generateKeyPairSync('ed25519');
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let cookie: string;
let consoleCookie: string;
let tillId: string;
let branchId: string;
let operatorId: string;
let twoHoursId: string;
let agent: BoxAgent;
const link: CuttableLink = { cut: false };
let hotDog: { id: string; name: string; priceSatang: number };

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, as = cookie) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: as, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads deep into each answer's shape
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

const scan = (key: string, as = cookie) =>
  call('GET', `/wallets/scan?${new URLSearchParams({ key, branchId })}`, undefined, as);

const onBox = (type: string, payload: Record<string, unknown>) =>
  call('POST', `/box/v1/station/${tillId}/intents`, { type, lastSeenSequence: 0, payload, actionId: `s502r-${newId().slice(-12)}` });

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      OPS_TEST_CONTROLS: 'true',
      STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
  });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  consoleCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  branchId = till!.branchId;
  operatorId = till!.operatorId;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  const [pkg] = await ctx.db.select().from(ticketPackage).where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  const [row] = await ctx.db.select().from(product).where(and(eq(product.operatorId, operatorId), eq(product.code, 'FB-HOTDOG')));
  hotDog = { id: row!.id, name: row!.name, priceSatang: row!.priceSatang };
  agent = linkedAgent(ctx, box1.id, 's502-review-switch-box', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx?.close();
  await teardownAll();
});

/** A drop-off child registered, paid for with one prepaid hot dog, checked in and banded. */
async function childInPark(name: string, allergies: string) {
  const checkinId = newId();
  const food = {
    mode: 'prepaid_items' as const,
    paidSatang: hotDog.priceSatang,
    items: [{ menuItemId: hotDog.id, menuItemName: hotDog.name, unitSatang: hotDog.priceSatang, qty: 1, redeemedQty: 0 }],
  };
  const reg = await call('POST', '/checkin/registrations', {
    id: newId(), branchId, stationId: tillId, guardianName: 'Ploy', guardianPhone: '0812345678', contactChannel: 'whatsapp',
    consentAcknowledged: true, acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
    children: [{ checkinId, name, ageYears: 6, service: 'drop_off', allergies, foodRestrictions: 'No pork', foodProvision: food }],
  });
  expect(reg.statusCode, JSON.stringify(reg.body)).toBe(200);
  const saleId = newId();
  const commit = await call('POST', '/sales', {
    id: saleId, stationId: tillId,
    lines: [{ id: checkinId, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 }, foodProvision: { mode: food.mode, paidSatang: food.paidSatang } }],
  });
  expect(commit.statusCode, JSON.stringify(commit.body)).toBe(200);
  expect((await call('POST', `/sales/${saleId}/finalise`, {})).statusCode).toBe(200);
  const now = await call('POST', '/checkin/check-in-now', { saleId, entries: [{ checkinId, nannyId: null }] });
  expect(now.statusCode, JSON.stringify(now.body)).toBe(200);
  const [row] = await ctx.db.select({ code: band.code }).from(checkin).innerJoin(band, eq(band.id, checkin.bandId)).where(eq(checkin.id, checkinId));
  return { checkinId, bandCode: row!.code };
}

/** The parts of a stay the counter acts on, wherever it was read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stay arrives as parsed JSON from either surface
function counterView(stay: Record<string, any>) {
  return {
    checkinId: stay.checkinId,
    childName: stay.childName,
    allergiesMedical: stay.allergiesMedical,
    foodRestrictions: stay.foodRestrictions,
    mayOrderFood: stay.mayOrderFood,
    items: (stay.foodProvision?.items ?? []).map((i: Record<string, unknown>) => ({ menuItemId: i.menuItemId, qty: i.qty, redeemedQty: i.redeemedQty ?? 0 })),
  };
}

describe('SCRUM-503 review — the Go offline switch and the band scan', () => {
  it('on: the platform refuses the scan as a trading call and the box reads the same child; off: the platform reads it again', async () => {
    const mint = await childInPark('Mint', 'Peanuts');

    const before = await scan(mint.bandCode);
    expect(before.statusCode, JSON.stringify(before.body)).toBe(200);
    expect(before.body.stay).toMatchObject({ checkinId: mint.checkinId, childName: 'Mint' });
    expect(before.body.stay.allergiesMedical).toContain('Peanuts');
    const online = counterView(before.body.stay);

    // The Console's switch, as its box command flips it.
    await agent.syncCache();
    await agent.setOffline(true, { reason: 's502 review' });
    try {
      const during = await scan(mint.bandCode);
      expect(during.statusCode, JSON.stringify(during.body)).toBe(503);
      expect(during.body.error.code).toBe('STATION_FORCED_OFFLINE');

      // Exactly what a real outage leaves the till: the box, answering from its copy.
      const status = await call('GET', `/box/v1/station/${tillId}/status`);
      expect(status.statusCode, JSON.stringify(status.body)).toBe(200);
      expect(status.body.link.lane).toBe('box');
      const fromBox = await onBox('checkin.band_food', { key: mint.bandCode });
      expect(fromBox.statusCode, JSON.stringify(fromBox.body)).toBe(200);
      expect(counterView(fromBox.body.result.stay)).toEqual(online);

      // Nobody else is caught: a Console account with no till scans on the platform,
      // and the till's own non-trading reads still answer.
      const consoleScan = await scan(mint.bandCode, consoleCookie);
      expect(consoleScan.statusCode, JSON.stringify(consoleScan.body)).toBe(200);
      expect(counterView(consoleScan.body.stay)).toEqual(online);
      expect((await call('GET', '/me')).statusCode).toBe(200);
      expect((await call('GET', '/me/permissions')).statusCode).toBe(200);
      expect((await call('GET', `/wallets/policy?${new URLSearchParams({ branchId })}`)).statusCode).not.toBe(503);
    } finally {
      await agent.setOffline(false);
    }

    const after = await scan(mint.bandCode);
    expect(after.statusCode, JSON.stringify(after.body)).toBe(200);
    expect(counterView(after.body.stay)).toEqual(online);
  });

  it('a key nobody holds is answered the same with the switch off and refused the same as any band with it on', async () => {
    expect((await scan('NO-SUCH-BAND')).statusCode).toBe(404);
    await agent.setOffline(true, { reason: 's502 review' });
    try {
      const during = await scan('NO-SUCH-BAND');
      expect(during.statusCode).toBe(503);
      expect(during.body.error.code).toBe('STATION_FORCED_OFFLINE');
    } finally {
      await agent.setOffline(false);
    }
    expect((await scan('NO-SUCH-BAND')).statusCode).toBe(404);
  });
});
