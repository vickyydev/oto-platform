import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, desc, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  account,
  alert,
  auditLog,
  branch,
  integrationCredentialExpiry,
  opsRun,
  role,
  roleAssignment,
  rolePermission,
} from '@oto/db';
import { newId, normalizePhone, type Permission } from '@oto/shared';
import { expiryAlertKey, runIntegrationExpiryWatch } from '../src/services/integration-expiry';
import {
  createFakeIntegrationSeams,
  replaceIntegrationTestSeamsForTest,
  type IntegrationTestSeams,
} from '../src/services/integration-seams';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-645 / planner ruling Q26 — the Integrations controls over HTTP:
 * the test seams (fake adapters only, `OPS_TEST_CONTROLS` + the additive
 * permission, an `ops_run` kind `integration` and an audit row per press) and
 * the owner's credential expiry date (permission-guarded, audited, keyed).
 * Every fetch is captured and must stay at zero: nothing here calls a provider.
 */

let ctx: TestContext;
let admin: string;
let operatorId: string;
let healthOnly: string; // operator-wide admin:health:read, nothing else
let parkTester: string; // console:integration:test + admin:health:read at ONE park only
let fetchCalls = 0;
let restoreFetch: () => void;

async function accountWith(name: string, permissions: Permission[], scope: { type: 'operator' | 'branch'; id: string | null }) {
  const id = newId(), roleId = newId(), password = randomBytes(18).toString('hex');
  const phone = normalizePhone(`+669006450${String(Math.floor(Math.random() * 90) + 10)}`)!;
  await ctx.db.insert(account).values({ id, operatorId, phone, passwordHash: await hash(password), status: 'active',
    mustChangePassword: false, phoneVerifiedAt: new Date() });
  await ctx.db.insert(role).values({ id: roleId, operatorId, name: `ZZ TEST 645 ${name}` });
  for (const permission of permissions) await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission });
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: id, roleId, scopeType: scope.type, scopeId: scope.id });
  return signInAs(ctx.app, phone, password);
}

const post = (url: string, cookie = admin, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie, ...headers } });
const put = (url: string, body: unknown, cookie = admin, key: string | null = newId()) =>
  ctx.app.inject({ method: 'PUT', url, payload: body as object, headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) } });
const get = (url: string, cookie = admin) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

const runsOf = (name: string) => ctx.db.select().from(opsRun).where(eq(opsRun.name, name)).orderBy(desc(opsRun.startedAt));
const isoDay = (offsetDays: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * 86_400_000).toISOString().slice(0, 10);
};

beforeAll(async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    fetchCalls += 1;
    throw new Error('ZZ TEST: no provider may be called from the integration controls');
  });
  restoreFetch = () => spy.mockRestore();
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api', OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [home] = await ctx.db.select({ operatorId: account.operatorId }).from(account).where(eq(account.phone, normalizePhone(ADMIN.phone)!));
  operatorId = home!.operatorId;
  const [park] = await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  healthOnly = await accountWith('health only', ['admin:health:read'], { type: 'operator', id: operatorId });
  parkTester = await accountWith('park tester', ['admin:health:read', 'console:integration:test', 'console:integration:manage'], { type: 'branch', id: park!.id });
}, 180_000);

afterEach(() => {
  ctx.app.env.OPS_TEST_CONTROLS = true;
});

afterAll(async () => {
  try { await ctx?.close(); } finally { restoreFetch?.(); await teardownAll(); }
  expect(fetchCalls).toBe(0);
});

describe('integration test seams (Q26)', () => {
  it('each seam runs its fake round trip, records one ops_run kind integration and one audit row, and calls no provider', async () => {
    const fake = createFakeIntegrationSeams();
    const previous = replaceIntegrationTestSeamsForTest(fake);
    try {
      for (const [key, steps] of [
        ['gateway', ['mint', 'cancel']],
        ['sms', ['send']],
        ['storage', ['put', 'get', 'delete', 'confirm gone']],
        ['otlp', ['export']],
        ['webhook', ['ping']],
      ] as const) {
        const response = await post(`/ops/integrations/${key}/test`);
        expect(response.statusCode, key).toBe(200);
        const body = response.json<{ runId: string; outcome: string; adapter: string; steps: Array<{ step: string; outcome: string }>; message: string }>();
        expect(body, key).toMatchObject({ integration: key, outcome: 'ok', adapter: 'fake' });
        expect(body.steps.map((s) => s.step), key).toEqual(steps);
        expect(body.message).toContain('No real provider was called');
        const [run] = await runsOf(`integration:${key}.test`);
        expect(run, key).toMatchObject({ id: body.runId, kind: 'integration', outcome: 'ok', operatorId });
        expect(run!.detail).toMatchObject({ adapter: 'fake', steps: body.steps.map((s) => ({ ...s })) });
        const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'ops.integration_test'), eq(auditLog.entityId, body.runId)));
        expect(audits, key).toHaveLength(1);
        expect(audits[0]!.after).toMatchObject({ integration: key, outcome: 'ok', adapter: 'fake' });
      }
      expect(fake.capture.gateway.minted).toHaveLength(1);
      expect(fake.capture.gateway.cancelled).toEqual(fake.capture.gateway.minted);
      expect(fake.capture.sms).toHaveLength(1);
      // The SMS fake is addressed to the account, never to a phone number.
      expect(fake.capture.sms[0]!.recipientRef).toMatch(/^[0-9a-f-]{36}$/);
      expect(fake.capture.storage.size).toBe(0);
      expect(fake.capture.otlp).toEqual(['oto.integration.test']);
      expect(fake.capture.webhook).toEqual(['integration.test']);
    } finally {
      replaceIntegrationTestSeamsForTest(previous);
    }
  });

  it('a failing seam is recorded as a failed integration run naming the step, and the scratch object is still deleted', async () => {
    const fake = createFakeIntegrationSeams();
    const failing: IntegrationTestSeams = {
      ...fake,
      gateway: { ...fake.gateway, cancelToken: async () => { throw new Error('ZZ TEST cancel refused with secret detail'); } },
      storage: { ...fake.storage, get: async () => Uint8Array.from([1, 2, 3]) },
    };
    const previous = replaceIntegrationTestSeamsForTest(failing);
    try {
      const gateway = (await post('/ops/integrations/gateway/test')).json<{ runId: string; outcome: string; steps: unknown[]; message: string }>();
      expect(gateway).toMatchObject({ outcome: 'failed', steps: [{ step: 'mint', outcome: 'ok' }, { step: 'cancel', outcome: 'failed' }] });
      expect(gateway.message).toContain('cancel');
      const [run] = await runsOf('integration:gateway.test');
      expect(run).toMatchObject({ id: gateway.runId, kind: 'integration', outcome: 'failed', errorCode: 'IntegrationTestStepFailed' });
      expect(JSON.stringify(run)).not.toContain('secret detail');

      const storage = (await post('/ops/integrations/storage/test')).json<{ outcome: string; steps: Array<{ step: string; outcome: string }> }>();
      expect(storage.outcome).toBe('failed');
      expect(storage.steps).toEqual([
        { step: 'put', outcome: 'ok' }, { step: 'get', outcome: 'failed' }, { step: 'delete', outcome: 'ok' },
      ]);
      expect(fake.capture.storage.size).toBe(0);
    } finally {
      replaceIntegrationTestSeamsForTest(previous);
    }
  });

  it('a press retried under the same Idempotency-Key is answered from the first, not run twice', async () => {
    const fake = createFakeIntegrationSeams();
    const previous = replaceIntegrationTestSeamsForTest(fake);
    try {
      const key = newId();
      const first = await post('/ops/integrations/sms/test', admin, { 'idempotency-key': key });
      const again = await post('/ops/integrations/sms/test', admin, { 'idempotency-key': key });
      expect(first.statusCode).toBe(200);
      expect(again.headers['x-oto-replay']).toBe('true');
      expect(again.json()).toEqual(first.json());
      expect(fake.capture.sms).toHaveLength(1);
    } finally {
      replaceIntegrationTestSeamsForTest(previous);
    }
  });

  it('is refused without OPS_TEST_CONTROLS, and records nothing', async () => {
    const before = (await runsOf('integration:sms.test')).length;
    ctx.app.env.OPS_TEST_CONTROLS = false;
    const refused = await post('/ops/integrations/sms/test');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('off on this deployment');
    expect((await runsOf('integration:sms.test')).length).toBe(before);
  });

  it('is refused without the permission — an operator-wide health reader, reception, a park-scoped grant, another operator', async () => {
    const before = (await runsOf('integration:webhook.test')).length;
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    for (const [who, cookie] of [['health reader', healthOnly], ['reception', reception], ['park-scoped tester', parkTester]] as const) {
      expect((await post('/ops/integrations/webhook/test', cookie)).statusCode, who).toBe(403);
    }
    expect((await runsOf('integration:webhook.test')).length).toBe(before);
    // The other operator's administrator may press it — for their own operator.
    const theirs = await post('/ops/integrations/webhook/test', foreign);
    expect(theirs.statusCode).toBe(200);
    const [run] = await runsOf('integration:webhook.test');
    expect(run!.operatorId).not.toBe(operatorId);
  });

  it('an unknown integration is a validation error, not a run', async () => {
    expect((await post('/ops/integrations/twilio-live/test')).statusCode).toBe(400);
  });

  it('lists the tests with their history, and says who may press them here', async () => {
    await post('/ops/integrations/otlp/test');
    const listed = (await get('/ops/integrations/tests')).json<{ available: boolean; adapter: string; availability: string; tests: Array<{ integration: string; lastOutcome: string | null; lastOkAt: string | null }> }>();
    expect(listed).toMatchObject({ available: true, adapter: 'fake', availability: 'ok' });
    expect(listed.tests.map((t) => t.integration)).toEqual(['gateway', 'sms', 'storage', 'otlp', 'webhook']);
    expect(listed.tests.find((t) => t.integration === 'otlp')).toMatchObject({ lastOutcome: 'ok' });
    expect(listed.tests.find((t) => t.integration === 'otlp')!.lastOkAt).not.toBeNull();
    expect((await get('/ops/integrations/tests', healthOnly)).json().available).toBe(false);
    ctx.app.env.OPS_TEST_CONTROLS = false;
    expect((await get('/ops/integrations/tests')).json().available).toBe(false);
  });
});

describe('credential expiry dates (Q26)', () => {
  afterEach(async () => {
    await ctx.db.delete(integrationCredentialExpiry).where(eq(integrationCredentialExpiry.operatorId, operatorId));
    await ctx.db.delete(alert).where(like(alert.key, 'integration.expiry:%'));
  });

  it('a permitted caller records a date; it is audited, read back, and replay-safe under its key', async () => {
    const key = newId();
    const expiresOn = isoDay(20);
    const first = await put('/ops/integrations/meta_channel_token/expiry', { expiresOn }, admin, key);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ integration: 'meta_channel_token', expiresOn, daysLeft: 20, window: '30_days' });
    const replay = await put('/ops/integrations/meta_channel_token/expiry', { expiresOn }, admin, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'ops.integration_expiry_set'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ operatorId, before: { integration: 'meta_channel_token', expiresOn: null }, after: { integration: 'meta_channel_token', expiresOn } });

    const listed = (await get('/ops/integrations/credentials')).json<{ visible: boolean; canManage: boolean; availability: string; credentials: Array<{ integration: string; expiresOn: string | null; window: string }> }>();
    expect(listed).toMatchObject({ visible: true, canManage: true, availability: 'ok' });
    expect(listed.credentials.map((c) => [c.integration, c.expiresOn, c.window])).toEqual([
      ['meta_channel_token', expiresOn, '30_days'],
      ['pgw_maintenance_key', null, 'not_set'],
      ['otoapp_directory_key', null, 'not_set'],
    ]);

    // S2-23 acceptance: a date 20 days ahead opens the 30-day alert on the next run.
    await runIntegrationExpiryWatch({ db: ctx.db, channels: [], flapWindowSeconds: 0, now: new Date() });
    const [opened] = await ctx.db.select().from(alert).where(eq(alert.key, expiryAlertKey(operatorId, 'meta_channel_token', 30)));
    expect(opened).toMatchObject({ severity: 'warning', operatorId });
  });

  it('the same key with a different date is a conflict, not a second write', async () => {
    const key = newId();
    expect((await put('/ops/integrations/pgw_maintenance_key/expiry', { expiresOn: isoDay(40) }, admin, key)).statusCode).toBe(200);
    expect((await put('/ops/integrations/pgw_maintenance_key/expiry', { expiresOn: isoDay(41) }, admin, key)).statusCode).toBe(409);
  });

  it('clearing a date stores null and is audited as a change', async () => {
    await put('/ops/integrations/otoapp_directory_key/expiry', { expiresOn: isoDay(10) });
    const cleared = await put('/ops/integrations/otoapp_directory_key/expiry', { expiresOn: null });
    expect(cleared.json()).toMatchObject({ expiresOn: null, window: 'not_set', daysLeft: null });
    const [row] = await ctx.db.select().from(integrationCredentialExpiry).where(eq(integrationCredentialExpiry.integrationKey, 'otoapp_directory_key'));
    expect(row!.expiresOn).toBeNull();
  });

  it('refuses a missing key, a non-date, an unknown integration and an extra field', async () => {
    expect((await put('/ops/integrations/meta_channel_token/expiry', { expiresOn: isoDay(5) }, admin, null)).statusCode).toBe(400);
    expect((await put('/ops/integrations/meta_channel_token/expiry', { expiresOn: '2026-02-30' })).statusCode).toBe(400);
    expect((await put('/ops/integrations/meta_channel_token/expiry', { expiresOn: 'soon' })).statusCode).toBe(400);
    expect((await put('/ops/integrations/sentry/expiry', { expiresOn: isoDay(5) })).statusCode).toBe(400);
    expect((await put('/ops/integrations/meta_channel_token/expiry', { expiresOn: isoDay(5), token: 'x' })).statusCode).toBe(400);
    expect(await ctx.db.select().from(integrationCredentialExpiry).where(eq(integrationCredentialExpiry.operatorId, operatorId))).toEqual([]);
  });

  it('is refused without the permission at operator scope; the read answers who may change it', async () => {
    const manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    for (const [who, cookie] of [['health reader', healthOnly], ['park-scoped manager grant', parkTester], ['branch manager', manager]] as const) {
      expect((await put('/ops/integrations/meta_channel_token/expiry', { expiresOn: isoDay(5) }, cookie)).statusCode, who).toBe(403);
    }
    expect(await ctx.db.select().from(integrationCredentialExpiry).where(eq(integrationCredentialExpiry.operatorId, operatorId))).toEqual([]);
    expect((await get('/ops/integrations/credentials', healthOnly)).json()).toMatchObject({ visible: true, canManage: false });
    // A park reader is answered, not refused, and shown none of the operator's dates.
    expect((await get('/ops/integrations/credentials', manager)).json()).toEqual({
      visible: false, canManage: false, availability: 'unknown', detail: null, credentials: [],
    });
  });

  it('dates are per operator: another operator never reads or changes these', async () => {
    await put('/ops/integrations/meta_channel_token/expiry', { expiresOn: isoDay(12) });
    const foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    const theirs = (await get('/ops/integrations/credentials', foreign)).json<{ credentials: Array<{ expiresOn: string | null }> }>();
    expect(theirs.credentials.every((c) => c.expiresOn === null)).toBe(true);
    await put('/ops/integrations/meta_channel_token/expiry', { expiresOn: isoDay(90) }, foreign);
    const [ours] = await ctx.db.select().from(integrationCredentialExpiry)
      .where(and(eq(integrationCredentialExpiry.operatorId, operatorId), eq(integrationCredentialExpiry.integrationKey, 'meta_channel_token')));
    expect(ours!.expiresOn).toBe(isoDay(12));
    await ctx.db.delete(integrationCredentialExpiry).where(eq(integrationCredentialExpiry.integrationKey, 'meta_channel_token'));
  });
});
