import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  account, alert, branch, operator, opsExpectation, opsLast, opsRun, role, roleAssignment, rolePermission,
} from '@oto/db';
import { newId } from '@oto/shared';
import { jobRegister, type AlertRow, type EnvVariable, type JobStatus } from '../src/services/ops';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

const PATHS = ['/platform/alerts', '/platform/jobs', '/platform/environment'];
const VARIABLE_NAMES = ['DATABASE_URL', 'ALLOWED_ORIGINS', 'SMS_ADAPTER', 'TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'MINIO_ENDPOINT', 'MINIO_PORT', 'MINIO_USE_SSL',
  'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_BUCKET', 'MINIO_REGION', 'HANDOFF_SIGNING_KEY', 'HANDOFF_APP_ORIGINS',
  'ALERT_CHANNELS', 'SENTRY_DSN'];
const rawMarker = 'ZZ TEST 639 private operational payload';
let ctx: TestContext;
let cookie: string;
let actorId: string, own: string, foreign: string, first: string, second: string;
let platformRole: string, operatorRole: string, healthRole: string, lookalikeRole: string, otherRole: string;

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [actor] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  actorId = actor!.id; own = actor!.operatorId;
  const systems = await ctx.db.select().from(role).where(isNull(role.operatorId));
  platformRole = systems.find(row => row.isSystem && row.name === 'platform_admin')!.id;
  operatorRole = systems.find(row => row.isSystem && row.name === 'operator_admin')!.id;
  foreign = newId(); first = newId(); second = newId();
  await ctx.db.insert(operator).values({ id: foreign, name: 'ZZ TEST 639 foreign operator' });
  await ctx.db.insert(branch).values([first, second].map(id => ({ id, operatorId: own, name: 'ZZ TEST 639 park', code: id })));
  healthRole = newId(); lookalikeRole = newId(); otherRole = newId();
  await ctx.db.insert(role).values([
    { id: healthRole, operatorId: own, name: 'ZZ TEST 639 health reader' },
    { id: lookalikeRole, operatorId: own, name: 'platform_admin' },
    { id: otherRole, operatorId: own, name: 'ZZ TEST 639 unrelated reader' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: healthRole, permission: 'admin:health:read' },
    { id: newId(), roleId: lookalikeRole, permission: 'admin:health:read' },
    { id: newId(), roleId: otherRole, permission: 'admin:role:read' },
  ]);
}, 180_000);
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

type Assignment = { roleId: string; scopeType: 'operator' | 'branch' | 'department' | 'record'; scopeId: string | null };
async function grants(rows: Assignment[]) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, actorId));
  if (rows.length) await ctx.db.insert(roleAssignment).values(rows.map(row => ({ id: newId(), accountId: actorId, ...row })));
}
beforeEach(async () => grants([{ roleId: platformRole, scopeType: 'operator', scopeId: null }]));
const get = (url: string, authenticated = true) => ctx.app.inject({ method: 'GET', url, headers: authenticated ? { cookie } : {} });
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function platformAlert(extra: Partial<typeof alert.$inferInsert> = {}) {
  const id = newId();
  await ctx.db.insert(alert).values({ id, key: `ZZ TEST ${id}`, category: 'ZZ_TEST_639', operatorId: null,
    subject: 'ZZ TEST platform device', summary: 'ZZ TEST platform condition', detail: { private: rawMarker }, ...extra });
  return id;
}
async function expectation(name: string, extra: Partial<typeof opsExpectation.$inferInsert> = {}) {
  await ctx.db.insert(opsExpectation).values({ name, intervalSeconds: 3600, graceSeconds: 60, createdAt: new Date(), ...extra });
}
async function last(name: string, extra: Partial<typeof opsLast.$inferInsert> = {}, detail: unknown = {}) {
  const id = newId(), at = new Date(Date.now() - 10_000);
  await ctx.db.insert(opsRun).values({ id, name, kind: 'job', outcome: extra.lastOutcome === 'failed' ? 'failed' : 'ok',
    startedAt: at, finishedAt: at, durationMs: 0, detail, errorMessage: extra.errorCode ? 'ZZ TEST safe failure sentence' : null });
  await ctx.db.insert(opsLast).values({ name, kind: 'job', lastOutcome: 'ok', lastStartedAt: at, lastFinishedAt: at,
    lastOkAt: at, lastRunId: id, ...extra });
  return id;
}
async function jobRows(): Promise<JobStatus[]> {
  const response = await get('/platform/jobs'); expect(response.statusCode).toBe(200);
  const body = response.json(); expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
  expect(Object.keys(body).sort()).toEqual(['generatedAt', 'jobs']);
  return body.jobs;
}

describe('SCRUM-639 actual Platform HTTP authority and query boundaries', () => {
  it('R1 high: all three genuine platform-wide reads exist and keep independent typed envelopes', async () => {
    for (const [url, key] of PATHS.map((url, index) => [url, ['alerts', 'jobs', 'variables'][index]!])) {
      const response = await get(url!); expect(response.statusCode).toBe(200);
      const body = response.json(); expect(Array.isArray(body[key!])).toBe(true);
      expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
  });
  it('R2 high: anonymous callers cannot read platform records or variable presence', async () => {
    for (const path of PATHS) expect((await get(path, false)).statusCode).toBe(401);
  });
  it('R3 high: the native operator-admin ALL bundle is not a platform-wide assignment', async () => {
    await grants([{ roleId: operatorRole, scopeType: 'operator', scopeId: own }]);
    for (const path of PATHS) expect((await get(path)).statusCode).toBe(403);
  });
  it('R4 high: a union of park health grants cannot manufacture platform reach', async () => {
    await grants([first, second].map(scopeId => ({ roleId: healthRole, scopeType: 'branch' as const, scopeId })));
    for (const path of PATHS) expect((await get(path)).statusCode).toBe(403);
  });
  it('R5 high: custom platform-admin names, department/record grants and foreign-operator grants do not confer platform authority', async () => {
    for (const assignment of [
      { roleId: lookalikeRole, scopeType: 'operator' as const, scopeId: own },
      { roleId: healthRole, scopeType: 'operator' as const, scopeId: foreign },
      { roleId: healthRole, scopeType: 'department' as const, scopeId: newId() },
      { roleId: healthRole, scopeType: 'record' as const, scopeId: newId() },
    ]) {
      await grants([assignment]);
      for (const path of PATHS) expect((await get(path)).statusCode).toBe(403);
    }
  });
  it('R6 high: a null-scope assignment without the health permission still refuses every read', async () => {
    await grants([{ roleId: otherRole, scopeType: 'operator', scopeId: null }]);
    for (const path of PATHS) expect((await get(path)).statusCode).toBe(403);
  });
  it('R7 high: removing platform authority is honored on the next request with the same session', async () => {
    for (const path of PATHS) expect((await get(path)).statusCode).toBe(200);
    await grants([{ roleId: healthRole, scopeType: 'operator', scopeId: own }]);
    for (const path of PATHS) expect((await get(path)).statusCode).toBe(403);
  });
  it('R8 medium: query grammar refuses target selectors, repeated parameters and invalid native pagination', async () => {
    for (const suffix of ['?operatorId=' + foreign, '?branchId=' + first, '?key=DATABASE_URL', '?state=open&state=resolved',
      '?limit=0', '?limit=101', '?offset=-1', '?limit=1.5', '?state=acknowledged', '?limit=1&limit=2']) {
      expect((await get('/platform/alerts' + suffix)).statusCode).toBe(400);
    }
    for (const path of ['/platform/jobs', '/platform/environment']) {
      for (const query of ['?operatorId=' + own, '?limit=1', '?name=DATABASE_URL']) expect((await get(path + query)).statusCode).toBe(400);
    }
  });
});

describe('SCRUM-639 null-operator alert projection', () => {
  it('R9 high: selects only null-operator rows and keeps native summary/subject/recovery/count fields without raw detail', async () => {
    const id = await platformAlert({ occurrences: 9, reopenCount: 2 });
    const ownId = await platformAlert({ operatorId: own }), foreignId = await platformAlert({ operatorId: foreign });
    const response = await get('/platform/alerts?limit=100'); expect(response.statusCode).toBe(200);
    const body = response.json(), found = (body.alerts as AlertRow[]).find(row => row.id === id)!;
    expect(found).toEqual({ id, key: `ZZ TEST ${id}`, severity: 'warning', title: 'ZZ TEST platform condition',
      detail: 'ZZ TEST platform device · recovered and broke again 2×', openedAt: expect.any(String),
      acknowledgedAt: null, resolvedAt: null, count: 9 });
    expect(body.alerts.some((row: AlertRow) => row.id === ownId || row.id === foreignId)).toBe(false);
    expect(response.body.includes(rawMarker)).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['alerts', 'generatedAt', 'limit', 'offset', 'total']);
    expect(body.limit).toBe(100); expect(body.offset).toBe(0);
  });
  it('R10 high: acknowledgment remains open; resolvedAt rather than a conflicting display status determines the native state', async () => {
    const at = new Date();
    const acknowledged = await platformAlert({ status: 'acknowledged', acknowledgedAt: at, acknowledgedByAccountId: actorId });
    const resolved = await platformAlert({ status: 'resolved', resolvedAt: at });
    const inconsistent = await platformAlert({ status: 'resolved', resolvedAt: null });
    const open = await get('/platform/alerts?state=open&limit=100'); expect(open.statusCode).toBe(200);
    expect(open.json().alerts.some((row: AlertRow) => row.id === acknowledged)).toBe(true);
    expect(open.json().alerts.some((row: AlertRow) => row.id === inconsistent)).toBe(true);
    expect(open.json().alerts.some((row: AlertRow) => row.id === resolved)).toBe(false);
    const closed = await get('/platform/alerts?state=resolved&limit=100'); expect(closed.statusCode).toBe(200);
    expect(closed.json().alerts.some((row: AlertRow) => row.id === resolved)).toBe(true);
    expect(closed.json().alerts.some((row: AlertRow) => row.id === acknowledged || row.id === inconsistent)).toBe(false);
    const all = await get('/platform/alerts?state=all&limit=100'); expect(all.statusCode).toBe(200);
    for (const id of [acknowledged, resolved, inconsistent]) expect(all.json().alerts.some((row: AlertRow) => row.id === id)).toBe(true);
  });
  it('R11 medium: native recency pagination is deterministic on ties and reports the full row count', async () => {
    const at = new Date(Date.now() + 60_000), ids = [];
    for (let i = 0; i < 3; i++) ids.push(await platformAlert({ lastSeenAt: at }));
    const expected = await ctx.db.select({ id: alert.id }).from(alert).where(and(isNull(alert.operatorId), isNull(alert.resolvedAt)))
      .orderBy(desc(alert.lastSeenAt), desc(alert.id));
    const a = await get('/platform/alerts?limit=2&offset=0'), b = await get('/platform/alerts?limit=2&offset=2');
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    expect(a.json().alerts.map((row: AlertRow) => row.id)).toEqual(expected.slice(0, 2).map(row => row.id));
    expect(b.json().alerts.map((row: AlertRow) => row.id)).toEqual(expected.slice(2, 4).map(row => row.id));
    expect(a.json().total).toBe(expected.length); expect(b.json().total).toBe(expected.length);
    expect(ids.every(id => expected.some(row => row.id === id))).toBe(true);
  });
  it('R12 medium: reading and filtering an alert never acknowledges, resolves or rewrites its source', async () => {
    const id = await platformAlert();
    const before = (await ctx.db.select().from(alert).where(eq(alert.id, id)))[0];
    for (const state of ['open', 'all', 'resolved']) expect((await get('/platform/alerts?state=' + state)).statusCode).toBe(200);
    expect(fingerprint((await ctx.db.select().from(alert).where(eq(alert.id, id)))[0])).toBe(fingerprint(before));
  });
});

describe('SCRUM-639 persisted native job register, without starting a runner', () => {
  it('R13 high: preserves disabled/muted/never-run and last-success overdue/failure distinctions', async () => {
    const prefix = `ZZ TEST 639 ${newId()}`, names = ['disabled', 'muted', 'never', 'overdue', 'failure', 'threshold'].map(s => `${prefix} ${s}`);
    await expectation(names[0]!, { enabled: false });
    await expectation(names[1]!, { mutedUntil: new Date(Date.now() + 3_600_000) });
    await last(names[1]!, { lastOutcome: 'failed', consecutiveFailures: 10 });
    await expectation(names[2]!);
    await expectation(names[3]!, { intervalSeconds: 60, graceSeconds: 0, severity: 'critical', createdAt: new Date(Date.now() - 3_600_000) });
    await last(names[3]!, { lastOutcome: 'failed', lastOkAt: new Date(Date.now() - 3_600_000), consecutiveFailures: 1 });
    await expectation(names[4]!); await last(names[4]!, { lastOutcome: 'failed', consecutiveFailures: 1, errorCode: 'ZZ_TEST_FAILURE' });
    await expectation(names[5]!); await last(names[5]!, { lastOutcome: 'failed', consecutiveFailures: ctx.app.env.ALERT_FAILURE_THRESHOLD });
    const rows = await jobRows();
    expect(names.map(name => rows.find(row => row.name === name)!.status)).toEqual(['unknown', 'unknown', 'unknown', 'down', 'warn', 'down']);
    expect(rows.find(row => row.name === names[4])!.lastError).toBe('ZZ TEST safe failure sentence');
    expect(rows.find(row => row.name === names[2])!.lastRunAt).toBeNull();
    for (const name of names) expect(Object.keys(rows.find(row => row.name === name)!).sort()).toEqual([
      'ageSeconds', 'expectedEverySeconds', 'lastError', 'lastOutcome', 'lastRunAt', 'name', 'status', 'waitingOn',
    ]);
  });
  it('R14 high: native refused and partially refused outcomes retain their sorted waiting-variable names', async () => {
    const a = `ZZ TEST 639 refused ${newId()}`, b = `ZZ TEST 639 partial ${newId()}`;
    await expectation(a); await expectation(b);
    await last(a, {}, { first: { state: 'refused', variable: 'ZZ_TEST_B' }, second: { state: 'refused', variable: 'ZZ_TEST_A' } });
    await last(b, {}, { first: { state: 'refused', variable: 'ZZ_TEST_A' }, second: { state: 'ok' } });
    const rows = await jobRows();
    expect(rows.find(row => row.name === a)).toMatchObject({ status: 'ok', lastOutcome: 'refused', waitingOn: ['ZZ_TEST_A', 'ZZ_TEST_B'] });
    expect(rows.find(row => row.name === b)).toMatchObject({ status: 'ok', lastOutcome: 'ok', waitingOn: ['ZZ_TEST_A'] });
  });
  it('R15 high: undeclared jobs remain visible while non-job last rows stay out, including pruned-run fallbacks', async () => {
    const a = `ZZ TEST 639 undeclared ${newId()}`, b = `ZZ TEST 639 http ${newId()}`, c = `ZZ TEST 639 pruned ${newId()}`;
    await last(a); await last(b, { kind: 'http' }); await last(c, { lastRunId: null, lastOutcome: 'failed', errorCode: 'ZZ_TEST_PRUNED' });
    const rows = await jobRows();
    expect(rows.find(row => row.name === a)).toMatchObject({ status: 'ok', expectedEverySeconds: null });
    expect(rows.some(row => row.name === b)).toBe(false);
    expect(rows.find(row => row.name === c)).toMatchObject({ status: 'warn', lastError: 'ZZ_TEST_PRUNED', expectedEverySeconds: null });
  });
  it('R16 high: matches the existing persisted reader and does not start or mutate any synthetic job', async () => {
    const name = `ZZ TEST 639 unchanged ${newId()}`;
    await expectation(name); await last(name);
    const snapshot = async () => fingerprint({
      expected: await ctx.db.select().from(opsExpectation).orderBy(opsExpectation.name),
      last: await ctx.db.select().from(opsLast).orderBy(opsLast.name),
      runs: await ctx.db.select().from(opsRun).where(eq(opsRun.kind, 'job')).orderBy(opsRun.id),
    });
    const before = await snapshot();
    const native = await jobRegister({ db: ctx.db, operatorId: own, watchdogJob: 'job:watchdog',
      watchdogIntervalSeconds: 60, failureThreshold: ctx.app.env.ALERT_FAILURE_THRESHOLD });
    const rows = await jobRows(), wanted = native.find(row => row.name === name)!;
    const actual = rows.find(row => row.name === name)!;
    expect({ ...actual, ageSeconds: null }).toEqual({ ...wanted, ageSeconds: null });
    expect(actual.ageSeconds).toBeGreaterThanOrEqual(wanted.ageSeconds!);
    expect(await snapshot()).toBe(before);
  });
});

describe('SCRUM-639 variables-only deployment metadata', () => {
  it('R17 high: exposes exactly the nineteen native metadata names and no provider probe or raw fields', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ZZ_TEST_PROVIDER_PROBE_REFUSED'));
    try {
      const response = await get('/platform/environment'); expect(response.statusCode).toBe(200);
      const body = response.json(); expect(Object.keys(body).sort()).toEqual(['generatedAt', 'variables']);
      expect((body.variables as EnvVariable[]).map(row => row.name)).toEqual(VARIABLE_NAMES);
      for (const row of body.variables as EnvVariable[]) {
        expect(Object.keys(row).sort()).toEqual(['name', 'present', 'provider', 'purpose', 'required']);
        expect(typeof row.present).toBe('boolean'); expect(typeof row.required).toBe('boolean');
        expect(typeof row.purpose).toBe('string'); expect(row.provider === null || typeof row.provider === 'string').toBe(true);
      }
      expect(network.mock.calls.length).toBe(0);
    } finally { network.mockRestore(); }
  });
  it('R18 high: presence remains native trimmed process metadata and never exposes a synthetic credential sentinel', async () => {
    const sentinel = `ZZ_TEST_PRIVATE_${newId()}`;
    vi.stubEnv('TWILIO_AUTH_TOKEN', sentinel); vi.stubEnv('SENTRY_DSN', '   ');
    try {
      const response = await get('/platform/environment'); expect(response.statusCode).toBe(200);
      const rows = response.json().variables as EnvVariable[];
      expect(rows.find(row => row.name === 'TWILIO_AUTH_TOKEN')!.present).toBe(true);
      expect(rows.find(row => row.name === 'SENTRY_DSN')!.present).toBe(false);
      expect(response.body.includes(sentinel)).toBe(false);
      expect(rows.find(row => row.name === 'DATABASE_URL')!.required).toBe(true);
      expect(rows.find(row => row.name === 'ALLOWED_ORIGINS')!.required).toBe(ctx.app.env.DEPLOY_ENV !== 'local');
      expect(rows.find(row => row.name === 'TWILIO_FROM')!.required).toBe(ctx.app.env.SMS_ADAPTER === 'twilio');
    } finally { vi.unstubAllEnvs(); }
  });
});
