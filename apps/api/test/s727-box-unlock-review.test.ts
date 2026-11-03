import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { box, station, staffToken } from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import { boxBridgeOrigin, readBoxBridgeOrigin } from '../src/lib/box-bridge-origin';
import { boxStoreFor } from '../src/lib/box-store';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { lastTokenByAccountOnBox, revokeStaffTokens, revokedStaffTokenIds } from '../src/services/staff-token';
import { linkedAgent } from './box-link';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/** Adversarial review: each HIGH finding is fixed and retained as a passing pin. */
describe('SCRUM-727 HIGH: trust at save and read, including a stale previously saved address', () => {
  const policy = { DEPLOY_ENV: 'staging' as const, BOX_BRIDGE_ALLOW_LOOPBACK: false, BOX_BRIDGE_ZONE: 'boxes.example.test' };
  it.each(['https://evil.example', 'https://0.0.0.0', 'https://[::]', 'https://zz.boxes.example.test.evil.test'])('PIN: %s cannot be saved or returned; validate both directions', value => {
    expect(() => boxBridgeOrigin(value, policy)).toThrow(/DNS zone/);
    expect(readBoxBridgeOrigin(value, policy)).toBeNull();
  });
  it('PIN: no configured zone means no address, including one already in the database', () => {
    const value = 'https://zz-test.boxes.example.test';
    expect(() => boxBridgeOrigin(value, { ...policy, BOX_BRIDGE_ZONE: '' })).toThrow();
    expect(readBoxBridgeOrigin(value, { ...policy, BOX_BRIDGE_ZONE: '' })).toBeNull();
  });
});

describe('SCRUM-727 HIGH: the API delivers the same policy and ended-shift evidence to both box mounts', () => {
  let ctx: TestContext, agent: BoxAgent;
  let cookie: string, admin: string, stationId: string, boxId: string, branchId: string, operatorId: string, jti: string, accountId: string;
  beforeAll(async () => {
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    ctx = await createTestContext({ env: { STAFF_TOKEN_PRIVATE_KEY: key, STAFF_OFFLINE_SIGN_IN: 'false', BOX_BRIDGE_ZONE: 'boxes.example.test' } });
    admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const row = await boxBySlot(ctx.db, 'virtual-1');
    boxId = row.id; branchId = row.branchId; operatorId = row.operatorId;
    const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, boxId), eq(station.kind, 'till')));
    stationId = till!.id;
    const picked = await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId } });
    expect(picked.statusCode).toBe(200); jti = picked.json().staffToken.jti as string;
    accountId = (await ctx.db.select().from(staffToken).where(eq(staffToken.jti, jti)))[0]!.accountId;
    agent = linkedAgent(ctx, boxId, 'zz-test-727', { cut: false });
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig(); await agent.syncCache(); attachInProcessBox(agent);
  }, 180_000);
  afterAll(async () => { if (agent) { detachInProcessBox(agent); agent.stop(); } await ctx?.close(); await teardownAll(); });
  const unlock = () => ctx.app.inject({ method: 'POST', url: `/box/v1/station/${stationId}/unlock`, headers: { cookie }, payload: { password: RECEPTION.password } });

  it('PIN: one false/true setting reaches config, changes its version, and controls the virtual mount', async () => {
    expect(agent.config()?.staffOfflineSignIn).toBe(false);
    const version = agent.config()!.configVersion;
    expect((await unlock()).json().error.code).toBe('OFFLINE_NO_TOKEN');
    ctx.app.env.STAFF_OFFLINE_SIGN_IN = true;
    await agent.syncConfig();
    expect(agent.config()?.staffOfflineSignIn).toBe(true);
    expect(agent.config()?.configVersion).not.toBe(version);
    const allowed = await unlock(); expect(allowed.statusCode).toBe(200);
    expect(allowed.json().offlineFresh).toBe(true);
    expect(allowed.json().method).toBe('offline_sign_in');
  });
  it('PIN: an older cache refuses fresh sign-in until a complete staff pull restores shift evidence', async () => {
    const store = boxStoreFor(ctx.db), bundle = (await store.readBundle(boxId, 'staff'))!;
    const payload = bundle.payload as { items: Array<{ accountId: string; lastTokenId?: string; lastTokenRevoked?: boolean }> };
    const record = payload.items.find(s => s.accountId === accountId)!;
    delete record.lastTokenId; delete record.lastTokenRevoked;
    await store.writeBundle(boxId, { ...bundle, payload });
    const refused = await unlock(); expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe('OFFLINE_REVOCATION_UNKNOWN');
    // The damaged copy still has today's ETag. Exercise the normal complete
    // refresh command, rather than treating a 304 as a refreshed staff copy.
    const refresh = await ctx.app.inject({ method: 'POST', url: `/boxes/${boxId}/commands`,
      headers: { cookie: admin }, payload: { kind: 'clear_cache' } });
    expect(refresh.statusCode).toBe(200);
    expect(await agent.runPendingCommands()).toBe(1);
    expect((await unlock()).statusCode).toBe(200);
  });
  it('PIN: ending a shift reaches the cache and refuses the same person with the token left out', async () => {
    await revokeStaffTokens(ctx.db, { jti, operatorId, branchId }, 'admin');
    await agent.syncCache();
    const staff = await boxStoreFor(ctx.db).readBundle(boxId, 'staff');
    const record = (staff!.payload as { items: Array<{ accountId: string; lastTokenId: string; lastTokenRevoked: boolean }> }).items.find(s => s.accountId === accountId)!;
    expect(record.lastTokenId).toBe(jti); expect(record.lastTokenRevoked).toBe(true);
    const refused = await unlock(); expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe('STAFF_TOKEN_REVOKED');
  });
  it('PIN: revocation survives token expiry throughout the fresh-sign-in window', async () => {
    await ctx.db.update(staffToken).set({ issuedAt: new Date(Date.now() - 7200000), expiresAt: new Date(Date.now() - 1000) }).where(eq(staffToken.jti, jti));
    expect(await revokedStaffTokenIds(ctx.db, operatorId)).toContain(jti);
    expect((await lastTokenByAccountOnBox(ctx.db, boxId)).get(accountId)?.revoked).toBe(true);
    await ctx.db.update(staffToken).set({ revokedAt: null, revokedReason: null }).where(eq(staffToken.jti, jti));
    expect(await revokeStaffTokens(ctx.db, { jti, operatorId, branchId }, 'admin')).toContain(jti);
  });
  it('PIN: a new online shift can restore access after an earlier ended shift', async () => {
    cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const picked = await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId } });
    expect(picked.statusCode).toBe(200);
    expect(picked.json().staffToken.jti).not.toBe(jti);
    await agent.syncCache();
    expect((await lastTokenByAccountOnBox(ctx.db, boxId)).get(accountId)?.revoked).toBe(false);
    expect((await unlock()).statusCode).toBe(200);
  });
  it('PIN: a previously saved foreign origin is suppressed on both box and station reads', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/boxes`, headers: { cookie: admin }, payload: {
      name: 'ZZ TEST trust review', slot: 'zz-test-727-trust', role: 'counter', bridgeOrigin: 'https://zz-test.boxes.example.test',
    } });
    expect(created.statusCode).toBe(200); const id = created.json().box.id as string;
    const made = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/stations`, headers: { cookie: admin }, payload: { name: 'ZZ TEST trust till', boxId: id, kind: 'till', codePrefix: 'Z727' } });
    expect(made.statusCode).toBe(200); expect(made.json().station.bridgeOrigin).toBe('https://zz-test.boxes.example.test');
    const key = randomUUID();
    const patch = { method: 'PATCH' as const, url: `/boxes/${id}`, headers: { cookie: admin, 'idempotency-key': key }, payload: { name: 'ZZ TEST trust renamed' } };
    const first = await ctx.app.inject(patch); expect(first.statusCode).toBe(200);
    expect(first.json().box.bridgeOrigin).toBe('https://zz-test.boxes.example.test');
    ctx.app.env.BOX_BRIDGE_ZONE = '';
    const replay = await ctx.app.inject(patch); expect(replay.statusCode).toBe(200);
    expect(replay.json().box.bridgeOrigin).toBeNull();
    ctx.app.env.BOX_BRIDGE_ZONE = 'boxes.example.test';
    await ctx.db.update(box).set({ bridgeOrigin: 'https://evil.example' }).where(eq(box.id, id));
    const stations = await ctx.app.inject({ method: 'GET', url: `/stations/${made.json().station.id}`, headers: { cookie: admin } });
    expect(stations.json().station.bridgeOrigin).toBeNull();
    const boxes = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/boxes`, headers: { cookie: admin } });
    expect(boxes.json().boxes.find((b: { id: string }) => b.id === id).bridgeOrigin).toBeNull();
    const badSave = await ctx.app.inject({ method: 'PATCH', url: `/boxes/${id}`, headers: { cookie: admin }, payload: { name: 'ZZ TEST unchanged trust' } });
    expect(badSave.statusCode).toBe(400);
  });
});
