import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { account, box, branch, device, opsLast, role, roleAssignment, rolePermission, session, station } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { stationChannels } from '../src/lib/station-channel';
import { integrationsSnapshot } from '../src/services/ops';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

type SchemaNode = { required?: string[]; properties?: Record<string, SchemaNode>; items?: SchemaNode };
type HealthBody = {
  status: string; checks: unknown[]; jobs: unknown[]; alerts: unknown[]; boxes: Array<Record<string, unknown>>;
  reach: { scope: string; branches: Array<{ id: string; name: string }> }; rollups: Array<{ branchId: string }>;
  watchdogAgeSeconds: number | null; generatedAt: string;
};
let ctx: TestContext, admin: string, reader: string;
const parkId = newId(), boxId = newId(), stationId = newId(), deviceId = newId();
const boxKeys = ['id', 'name', 'slot', 'role', 'status', 'state', 'branchId', 'branchName', 'openingHours', 'agentVersion',
  'minAgentVersion', 'agentBelowMinimum', 'lastHeartbeatAt', 'heartbeatAgeSeconds', 'uptimeSeconds', 'outboxDepth',
  'oldestUnackedAgeS', 'quarantineOpen', 'lastSyncAt', 'clockOffsetMs', 'tempC', 'currentEpoch', 'configVersion', 'devices', 'booths', 'conditions', 'detail'].sort();
const reported = { configVersion: 2.5, printerReachable: 'ZZ TEST raw reachability', paperStatus: 'ZZ TEST raw paper',
  vouchersPending: 1.5, pendingUnit: 'vouchers', lastSpinAt: 'ZZ TEST raw reported time', staffSignedIn: false,
  dailyCapsReached: ['ZZ TEST raw cap'], today: { businessDate: 'ZZ TEST raw business date', spins: 0, vouchers: 0 }, pointerPresent: null };
let restoreFetch: (() => void) | undefined, providerProbeCount = 0;

beforeAll(async () => {
  // Every provider probe in this file is captured; no fetch reaches a provider or staging.
  const fetchProbe = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    providerProbeCount += 1;
    return new Response('{"status":"ok"}', { status: 200 });
  });
  restoreFetch = () => fetchProbe.mockRestore();
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api', HANDOFF_APP_ORIGINS: 'oto_app=https://zz-test.invalid' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [home] = await ctx.db.select({ operatorId: account.operatorId }).from(account).where(eq(account.phone, normalizePhone(ADMIN.phone)!));
  const operatorId = home!.operatorId;
  await ctx.db.insert(branch).values({ id: parkId, operatorId, name: 'ZZ TEST 645 health park', code: 'zz-test-645-health' });
  await ctx.db.insert(box).values({ id: boxId, operatorId, branchId: parkId, name: 'ZZ TEST 645 health box', slot: 'ZZ645',
    role: 'booth', status: 'online', registeredAt: new Date(), lastHeartbeatAt: new Date(), agentVersion: '0.0.1',
    lastStatus: { uptimeS: 123.5, outboxDepth: 7, clockOffsetMs: -1234.5, configVersion: 'ZZ TEST config', booth: reported } });
  await ctx.db.insert(station).values({ id: stationId, operatorId, branchId: parkId, boxId, name: 'ZZ TEST 645 health booth', kind: 'booth' });
  await ctx.db.insert(device).values({ id: deviceId, operatorId, branchId: parkId, boxId, kind: 'receipt_printer',
    label: 'ZZ TEST 645 printer', transport: 'simulated', reachability: 'unknown', paperStatus: 'unknown' });
  const readerId = newId(), roleId = newId(), phone = normalizePhone('+66900000645')!, password = randomBytes(24).toString('hex');
  await ctx.db.insert(account).values({ id: readerId, operatorId, phone, passwordHash: await hash(password),
    status: 'active', mustChangePassword: false, phoneVerifiedAt: new Date() });
  await ctx.db.insert(role).values({ id: roleId, operatorId, name: 'ZZ TEST 645 park health' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission: 'admin:health:read' });
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: readerId, roleId, scopeType: 'branch', scopeId: parkId });
  reader = await signInAs(ctx.app, phone, password);
  await ctx.db.update(session).set({ branchId: parkId }).where(eq(session.accountId, readerId));
}, 180_000);
afterAll(async () => { try { await ctx?.close(); } finally { restoreFetch?.(); await teardownAll(); } });

function schemaOf(path: string, status = '200') {
  const doc = ctx.app.swagger() as { paths?: Record<string, { get?: { responses?: Record<string, {
    content?: Record<string, { schema?: SchemaNode }>;
  }> } }> };
  const schema = doc.paths?.[path]?.get?.responses?.[status]?.content?.['application/json']?.schema;
  expect(schema, 'the actual registered read must publish its existing response contract').toBeDefined();
  return schema!;
}
const get = (path: string, cookie = admin) => ctx.app.inject({ method: 'GET', url: path, headers: { cookie } });
const publicGet = (path: string) => ctx.app.inject({ method: 'GET', url: path });

describe('SCRUM-645 native Health and Integrations response schemas', () => {
  it('R1: the actual public liveness route declares its native response', () => {
    expect(schemaOf('/health').required).toEqual(['status']);
  });

  it('R2: readiness describes the same full native body for200 and503', () => {
    for (const status of ['200', '503']) {
      const schema = schemaOf('/ready', status);
      expect(schema.required?.slice().sort()).toEqual(['checks', 'status']);
      expect(Object.keys(schema.properties!.checks!.properties!).sort()).toEqual(['database', 'jobs', 'pool', 'stationChannels']);
    }
  });

  it('R3: estate and park Health schemas enumerate nested fleet, device, booth, reach and rollup fields', () => {
    const schema = schemaOf('/ops/health');
    expect(schema.required?.slice().sort()).toEqual(['alerts', 'boxes', 'checks', 'generatedAt', 'jobs', 'reach', 'rollups', 'status', 'watchdogAgeSeconds']);
    const fleet = schema.properties!.boxes!.items!;
    expect(Object.keys(fleet.properties!).sort()).toEqual(boxKeys);
    expect(Object.keys(fleet.properties!.devices!.items!.properties!).sort())
      .toEqual(['id', 'kind', 'label', 'lastError', 'lastSeenAt', 'paperStatus', 'reachability']);
    expect(Object.keys(fleet.properties!.booths!.items!.properties!).sort())
      .toEqual(['businessDate', 'codePrefix', 'name', 'reported', 'stationId', 'unattributedToday']);
  });

  it('R4: Integrations declares provider metadata and presence fields without a credential-value field', () => {
    const schema = schemaOf('/ops/integrations');
    expect(schema.required?.slice().sort()).toEqual(['providers', 'variables']);
    expect(Object.keys(schema.properties!.providers!.items!.properties!).sort())
      .toEqual(['category', 'detail', 'endpoint', 'key', 'lastDeliveryAt', 'lastDeliveryOutcome', 'missingVars', 'name', 'purpose', 'state']);
    expect(Object.keys(schema.properties!.variables!.items!.properties!).sort()).toEqual(['name', 'present', 'provider', 'purpose', 'required']);
  });

  it('R5: real native fleet serialization preserves raw reported strings/numbers and unknown/null measurements', async () => {
    const response = await get('/ops/health'); expect(response.statusCode).toBe(200);
    const body = response.json<HealthBody>(), found = body.boxes.find(b => b.id === boxId)!;
    expect(Object.keys(found).sort()).toEqual(boxKeys);
    expect(found).toMatchObject({ branchId: parkId, uptimeSeconds: 123.5, outboxDepth: 7, clockOffsetMs: -1234.5,
      tempC: null, oldestUnackedAgeS: null, lastSyncAt: null, configVersion: 'ZZ TEST config' });
    expect(found.devices).toEqual([{ id: deviceId, kind: 'receipt_printer', label: 'ZZ TEST 645 printer',
      reachability: 'unknown', paperStatus: 'unknown', lastError: null, lastSeenAt: null }]);
    const booth = (found.booths as Array<{ reported: unknown }>)[0]!;
    expect(booth.reported).toEqual(reported);
    expect(body.reach).toEqual({ scope: 'operator', branches: [] });
    expect(body.rollups.some(row => row.branchId === parkId)).toBe(true);
  });

  it('R6: branch-scoped native reads retain empty estate-only arrays and the exact owned park', async () => {
    const response = await get('/ops/health', reader); expect(response.statusCode).toBe(200);
    const body = response.json<HealthBody>();
    expect(body.checks).toEqual([]); expect(body.jobs).toEqual([]); expect(body.watchdogAgeSeconds).toBeNull();
    expect(body.boxes.map(b => b.id)).toEqual([boxId]);
    expect(body.reach).toEqual({ scope: 'branch', branches: [{ id: parkId, name: 'ZZ TEST 645 health park' }] });
    expect(body.rollups.map(row => row.branchId)).toEqual([parkId]);
  });

  it('R7: liveness, readiness station counts, degraded200 and database-only503 retain native status and unknowns', async () => {
    expect((await publicGet('/health')).json()).toEqual({ status: 'ok' });
    stationChannels.open(stationId); stationChannels.open(stationId);
    try {
      const response = await publicGet('/ready'); expect(response.statusCode).toBe(200);
      const body = response.json<{ status: string; checks: { jobs: { watchdogAgeS: number | null }; stationChannels: { perStation: Record<string, number> } } }>();
      expect(body.checks.stationChannels.perStation[stationId]).toBe(2);
      expect(body.checks.jobs.watchdogAgeS).toBeNull();
      const old = new Date(Date.now() - ctx.app.env.WATCHDOG_INTERVAL_S * 4_000);
      await ctx.db.insert(opsLast).values({ name: 'job:watchdog', kind: 'job', lastStartedAt: old, lastOkAt: old, lastOutcome: 'ok' });
      const degraded = await publicGet('/ready'); expect(degraded.statusCode).toBe(200); expect(degraded.json().status).toBe('degraded');
      const fail = vi.spyOn(ctx.db, 'execute').mockRejectedValueOnce(Error('ZZ_TEST_DATABASE_PROBE_FAILURE'));
      try {
        const down = await publicGet('/ready'); expect(down.statusCode).toBe(503);
        expect(down.json()).toMatchObject({ status: 'not_ready', checks: { database: { ok: false } } });
      } finally { fail.mockRestore(); }
    } finally { stationChannels.close(stationId); stationChannels.close(stationId); }
  });

  it('R8: actual provider/presence projections remain lossless with all outbound probes captured', async () => {
    const expected = await integrationsSnapshot({ db: ctx.db, env: ctx.app.env, storage: ctx.app.fileStorage, watchdogJob: 'job:watchdog' });
    const response = await get('/ops/integrations'); expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(providerProbeCount).toBeGreaterThan(0); expect(ctx.smsLog).toHaveLength(0);
  });
});
