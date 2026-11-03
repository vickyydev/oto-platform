import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { box, station } from '@oto/db';
import { boxBridgeOrigin } from '../src/lib/box-bridge-origin';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

const ordinary = { DEPLOY_ENV: 'staging' as const, BOX_BRIDGE_ALLOW_LOOPBACK: false, BOX_BRIDGE_ZONE: 'example.test' };

describe('SCRUM-713 origin boundary: HIGH pins', () => {
  it('PIN HIGH: a trailing DNS dot must not bypass the loopback test gate; normalize the hostname before classifying it', () => {
    for (const origin of ['https://localhost.', 'https://counter.localhost.']) {
      expect(() => boxBridgeOrigin(origin, ordinary)).toThrow();
    }
  });
  it('accepts a bare HTTPS origin and preserves the absent-field path', () => {
    expect(boxBridgeOrigin('https://counter.example.test:8443/', ordinary)).toBe('https://counter.example.test:8443');
    expect(boxBridgeOrigin(null, ordinary)).toBeNull();
    expect(boxBridgeOrigin(undefined, ordinary)).toBeNull();
  });
  it.each(['', 'http://counter.example.test', 'https://user:pass@counter.example.test',
    'https://counter.example.test/path', 'https://counter.example.test?query=1',
    'https://counter.example.test#fragment', '//counter.example.test',
    ' https://counter.example.test', 'https://counter.example.test\n',
    'https://127.0.0.1', 'https://localhost', 'https://[::1]', 'https://[::ffff:7f00:1]'])('HIGH: rejects credentials, non-origins and unapproved loopback: %s', (origin) => {
    // Prescribed fix: validate before persistence, not only in the Console.
    expect(() => boxBridgeOrigin(origin, ordinary)).toThrow();
  });
  it('HIGH: permits loopback only with the explicit flag outside production', () => {
    for (const origin of ['http://counter.example.test.localhost:8471']) {
      expect(boxBridgeOrigin(origin, { ...ordinary, BOX_BRIDGE_ALLOW_LOOPBACK: true, BOX_BRIDGE_ZONE: 'example.test.localhost' })).toBe(origin);
      expect(() => boxBridgeOrigin(origin, { ...ordinary, DEPLOY_ENV: 'production', BOX_BRIDGE_ALLOW_LOOPBACK: true, BOX_BRIDGE_ZONE: 'example.test.localhost' })).toThrow();
    }
    expect(() => boxBridgeOrigin('http://192.168.1.20', { ...ordinary, BOX_BRIDGE_ALLOW_LOOPBACK: true, BOX_BRIDGE_ZONE: 'example.test.localhost' })).toThrow();
  });
});

describe('SCRUM-713 fleet writes and station contract', () => {
  let ctx: TestContext;
  let admin: string;
  let reception: string;
  let branchId: string;
  let virtualId: string;
  beforeAll(async () => {
    ctx = await createTestContext({ env: { BOX_BRIDGE_ALLOW_LOOPBACK: 'true', BOX_BRIDGE_ZONE: 'example.test' } });
    admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const seeded = await boxBySlot(ctx.db, 'virtual-1');
    branchId = seeded.branchId; virtualId = seeded.id;
  }, 180_000);
  afterAll(async () => { await ctx?.close(); await teardownAll(); });

  it('HIGH: virtual boxes cannot acquire an external bridge; old stations remain readable', async () => {
    const result = await ctx.app.inject({ method: 'PATCH', url: `/boxes/${virtualId}`, headers: { cookie: admin }, payload: { bridgeOrigin: 'https://counter.example.test' } });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('VIRTUAL_BOX_BRIDGE');
    const [stored] = await ctx.db.select().from(box).where(eq(box.id, virtualId));
    expect(stored!.bridgeOrigin).toBeNull();
    const list = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/stations`, headers: { cookie: admin } });
    expect(list.statusCode).toBe(200);
    const virtualStations = (list.json().stations as Array<{ boxId: string; bridgeOrigin: string | null }>).filter(s => s.boxId === virtualId);
    expect(virtualStations.length).toBeGreaterThan(0);
    expect(virtualStations.every(s => s.bridgeOrigin === null)).toBe(true);
  });

  it('records a configured origin, exposes it on the station, and permits clearing it', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/boxes`, headers: { cookie: admin }, payload: { name: 'ZZ TEST bridge', slot: 'zz-test-713', role: 'counter', bridgeOrigin: 'https://counter.example.test:8471' } });
    expect(created.statusCode).toBe(200);
    const id = created.json().box.id as string;
    const made = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/stations`, headers: { cookie: admin }, payload: { name: 'ZZ TEST bridge till', kind: 'till', boxId: id, codePrefix: 'Z713' } });
    expect(made.statusCode).toBe(200);
    expect(made.json().station.bridgeOrigin).toBe('https://counter.example.test:8471');
    const denied = await ctx.app.inject({ method: 'PATCH', url: `/boxes/${id}`, headers: { cookie: reception }, payload: { bridgeOrigin: 'https://wrong.example.test' } });
    expect(denied.statusCode).toBe(403);
    const invalid = await ctx.app.inject({ method: 'PATCH', url: `/boxes/${id}`, headers: { cookie: admin }, payload: { bridgeOrigin: 'https://counter.example.test/path' } });
    expect(invalid.statusCode).toBe(400);
    expect((await ctx.db.select().from(box).where(eq(box.id, id)))[0]!.bridgeOrigin).toBe('https://counter.example.test:8471');
    const cleared = await ctx.app.inject({ method: 'PATCH', url: `/boxes/${id}`, headers: { cookie: admin }, payload: { bridgeOrigin: null } });
    expect(cleared.statusCode).toBe(200);
    const stationId = made.json().station.id as string;
    expect((await ctx.db.select().from(station).where(eq(station.id, stationId)))[0]!.boxId).toBe(id);
    const read = await ctx.app.inject({ method: 'GET', url: `/stations/${stationId}`, headers: { cookie: admin } });
    expect(read.statusCode).toBe(200); expect(read.json().station.bridgeOrigin).toBeNull();
  });
});
