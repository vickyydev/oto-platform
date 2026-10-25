import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, auditLog, idempotencyKey, operator, role, roleAssignment, rolePermission, session } from '@oto/db';
import { newId } from '@oto/shared';
import { hashToken, newSessionToken, SESSION_COOKIE } from '../src/plugins/session';
import { audit } from '../src/services/audit';
import { operatorSwitchOptionsOf, switchSessionOperator } from '../src/services/operator-switch';
import { opCtx, withTx } from '../src/services/tx';
import { createTestContext, teardownAll, type TestContext } from './helpers';

const ORDINARY = '/__test640/idempotency';
const SWITCH = '/me/session/operator';
const PERMISSION = 'platform:operator:switch';
const ACTION = 'test.operator_context_write';
type Payload = { marker: string; mode?: 'reject' | 'fail-once' | 'credential' };
type Selection = { operatorId: string | null; expectedRevision: number };
let ctx: TestContext;
let f: Awaited<ReturnType<typeof fixture>>;
let calls = 0;
let hold: Promise<void> | undefined;
let entered: (() => void) | undefined;

beforeAll(async () => {
  ctx = await createTestContext();
  // Only the otherwise unregistered Q20 operation is supplied by this fixture.
  // Authentication, permission resolution, claims and transactions remain native.
  if (!ctx.app.hasRoute({ method: 'PUT', url: SWITCH })) {
    ctx.app.put<{ Body: Selection }>(SWITCH, {
      config: { permission: PERMISSION, target: { operator: true } },
    }, async req => {
      const auth = req.requireAuth();
      return switchSessionOperator(ctx.db, { accountId: auth.accountId, sessionId: auth.sessionId,
        operatorId: req.body.operatorId, expectedRevision: req.body.expectedRevision }, opCtx(req));
    });
  }
  ctx.app.post<{ Body: Payload }>(ORDINARY, { config: { auth: 'session' } }, async (req, reply) => {
    const auth = req.requireAuth();
    calls++;
    entered?.();
    await hold;
    if (req.body.mode === 'fail-once' && calls === 1) {
      return reply.code(503).send({ error: { code: 'ZZ_TEST_TRANSIENT', message: 'Synthetic transient failure' } });
    }
    if (req.body.mode === 'reject') {
      return reply.code(400).send({ error: { code: 'ZZ_TEST_CONTEXT_REFUSAL', message: 'Synthetic context refusal' },
        operatorId: auth.operatorId, marker: req.body.marker });
    }
    if (req.body.mode === 'credential') return { temporaryPassword: 'synthetic-not-issued' };
    return withTx(ctx.db, opCtx(req), ACTION, async tx => {
      await audit.record(tx, { actorAccountId: auth.accountId, operatorId: auth.operatorId, branchId: auth.branchId,
        action: ACTION, entityType: 'account', entityId: auth.accountId, after: { marker: req.body.marker }, requestId: req.id });
      return { accountId: auth.accountId, operatorId: auth.operatorId, sessionId: auth.sessionId,
        marker: req.body.marker, sequence: calls };
    });
  });
}, 300_000);

beforeEach(async () => {
  calls = 0; hold = undefined; entered = undefined;
  f = await fixture();
});
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

async function fixture() {
  const ids = { home: newId(), target: newId(), actor: newId(), role: newId(), assignment: newId(),
    session: newId(), secondSession: newId() };
  await ctx.db.insert(operator).values([{ id: ids.home, name: 'ZZ TEST 640 cache home' },
    { id: ids.target, name: 'ZZ TEST 640 cache target' }]);
  await ctx.db.insert(account).values({ id: ids.actor, operatorId: ids.home, phone: '+66999996403', status: 'active' });
  await ctx.db.insert(role).values({ id: ids.role, operatorId: ids.home, name: 'ZZ TEST 640 cache switch grant', isSystem: false });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: ids.role, permission: PERMISSION });
  await ctx.db.insert(roleAssignment).values({ id: ids.assignment, accountId: ids.actor,
    roleId: ids.role, scopeType: 'operator', scopeId: null });
  const firstToken = newSessionToken(), secondToken = newSessionToken();
  await ctx.db.insert(session).values([{ id: ids.session, accountId: ids.actor, tokenHash: hashToken(firstToken),
    expiresAt: new Date(Date.now() + 3_600_000) }, { id: ids.secondSession, accountId: ids.actor,
    tokenHash: hashToken(secondToken), expiresAt: new Date(Date.now() + 3_600_000) }]);
  return { ...ids, cookie: `${SESSION_COOKIE}=${firstToken}`, secondCookie: `${SESSION_COOKIE}=${secondToken}` };
}

const key = () => `zz-test-640-${newId()}`;
const ordinary = (idempotency: string, payload: Payload = { marker: 'ordinary' }, cookie = f.cookie) => ctx.app.inject({
  method: 'POST', url: ORDINARY, headers: { cookie, 'idempotency-key': idempotency }, payload,
});
const selection = (idempotency: string, payload: Selection, cookie = f.cookie) => ctx.app.inject({
  method: 'PUT', url: SWITCH, headers: { cookie, 'idempotency-key': idempotency }, payload,
});
const move = (operatorId: string | null, expectedRevision: number, sessionId = f.session) => switchSessionOperator(ctx.db,
  { accountId: f.actor, sessionId, operatorId, expectedRevision }, { actorAccountId: f.actor, operatorId: f.home, requestId: newId() });
const options = (sessionId = f.session) => operatorSwitchOptionsOf(ctx.db, { accountId: f.actor, sessionId });
const stored = async (idempotency: string) => (await ctx.db.select().from(idempotencyKey).where(and(
  eq(idempotencyKey.accountId, f.actor), eq(idempotencyKey.key, idempotency))))[0];
const switchAudits = () => ctx.db.select().from(auditLog).where(and(eq(auditLog.actorAccountId, f.actor),
  eq(auditLog.action, 'session.operator_switch')));
const writeAudits = () => ctx.db.select().from(auditLog).where(and(eq(auditLog.actorAccountId, f.actor), eq(auditLog.action, ACTION)));
const originalHash = (method: string, url: string, payload: unknown) => createHash('sha256')
  .update(method).update('\n').update(url).update('\n').update(JSON.stringify(payload ?? null)).digest('hex');

async function putLegacy(idempotency: string, method: string, url: string, payload: unknown, responseBody: unknown) {
  await ctx.db.insert(idempotencyKey).values({ key: idempotency, accountId: f.actor,
    requestHash: originalHash(method, url, payload), statusCode: 200, responseBody,
    expiresAt: new Date(Date.now() + 60_000) });
}
function refusedCached(response: Awaited<ReturnType<typeof selection>>) {
  expect([401, 403, 404, 409, 423]).toContain(response.statusCode);
  expect(response.headers['x-oto-replay']).not.toBe('true');
}

describe('SCRUM-640 native HTTP operator-context idempotency house review', () => {
  it('R1 [high] same-key home retry preserves the original atomic answer and one write/audit', async () => {
    const idempotency = key(), first = await ordinary(idempotency);
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ operatorId: f.home, sessionId: f.session });
    const retry = await ordinary(idempotency);
    expect(retry.statusCode).toBe(200); expect(retry.headers['x-oto-replay']).toBe('true'); expect(retry.json()).toEqual(first.json());
    expect(calls).toBe(1); expect(await writeAudits()).toHaveLength(1);
    expect(await stored(idempotency)).toMatchObject({ statusCode: 200, responseBody: first.json() });
  });

  it.each(['success', 'client refusal'] as const)('R2 [critical] an ordinary cached %s from A cannot replay into the same session working in B; bind effective operator', async kind => {
    const idempotency = key(), payload: Payload = { marker: 'operator-bound', ...(kind === 'client refusal' ? { mode: 'reject' } : {}) };
    const first = await ordinary(idempotency, payload); expect(first.statusCode).toBe(kind === 'success' ? 200 : 400);
    expect(first.json()).toMatchObject({ operatorId: f.home });
    const homeRetry = await ordinary(idempotency, payload);
    expect(homeRetry.statusCode).toBe(first.statusCode); expect(homeRetry.headers['x-oto-replay']).toBe('true'); expect(homeRetry.json()).toEqual(first.json());
    await move(f.target, 0); expect(await options()).toMatchObject({ effectiveOperatorId: f.target, revision: 1 });
    const retry = await ordinary(idempotency, payload);
    expect(retry.statusCode).toBe(409); expect(retry.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(retry.headers['x-oto-replay']).not.toBe('true'); expect(calls).toBe(1);
    expect((await stored(idempotency))?.responseBody).toEqual(first.json());
  });

  it('R3 [high] a different key in B performs the write using B without changing the account home', async () => {
    await move(f.target, 0);
    const response = await ordinary(key()); expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ operatorId: f.target, accountId: f.actor, sessionId: f.session });
    expect((await ctx.db.select().from(account).where(eq(account.id, f.actor)))[0]!.operatorId).toBe(f.home);
    expect(await writeAudits()).toMatchObject([{ operatorId: f.target, actorAccountId: f.actor }]);
  });

  it('R4 [critical] a genuine lost selection acknowledgement replays only this live session at the exact committed revision and target', async () => {
    const idempotency = key(), payload = { operatorId: f.target, expectedRevision: 0 };
    const first = await selection(idempotency, payload);
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ homeOperatorId: f.home,
      effectiveOperatorId: f.target, operatorOverride: f.target, revision: 1, changed: true });
    const retry = await selection(idempotency, payload);
    expect(retry.statusCode).toBe(200); expect(retry.headers['x-oto-replay']).toBe('true'); expect(retry.json()).toEqual(first.json());
    expect(await options()).toMatchObject({ effectiveOperatorId: f.target, revision: 1 }); expect(await switchAudits()).toHaveLength(1);
  });

  it.each(['home', 'same target after ABA'] as const)('R5 [critical] refuses an old cached confirmation when current context is %s; compare revision rather than target alone', async kind => {
    const idempotency = key(), payload = { operatorId: f.target, expectedRevision: 0 };
    expect((await selection(idempotency, payload)).statusCode).toBe(200);
    await move(null, 1); if (kind === 'same target after ABA') await move(f.target, 2);
    const before = await options(), audits = await switchAudits();
    refusedCached(await selection(idempotency, payload));
    expect(await options()).toEqual(before); expect(await switchAudits()).toEqual(audits);
  });

  it('R6 [critical] an account-shared key cannot replay another session confirmation even when both target and revision coincide', async () => {
    const idempotency = key(), payload = { operatorId: f.target, expectedRevision: 0 };
    expect((await selection(idempotency, payload)).statusCode).toBe(200); await move(f.target, 0, f.secondSession);
    const before = await options(f.secondSession), audits = await switchAudits();
    refusedCached(await selection(idempotency, payload, f.secondCookie));
    expect(await options(f.secondSession)).toEqual(before); expect(await switchAudits()).toEqual(audits);
  });

  it('R7 [critical] changing the original selection body cannot reuse a successful selection claim', async () => {
    const idempotency = key(); expect((await selection(idempotency, { operatorId: f.target, expectedRevision: 0 })).statusCode).toBe(200);
    refusedCached(await selection(idempotency, { operatorId: f.target, expectedRevision: 1 }));
    expect(await options()).toMatchObject({ effectiveOperatorId: f.target, revision: 1 }); expect(await switchAudits()).toHaveLength(1);
  });

  it.each(['grant withdrawn', 'session revoked', 'session expired', 'session locked', 'target archived'] as const)(
    'R8 [critical] cached success cannot bypass a fresh %s refusal', async kind => {
      const idempotency = key(), payload = { operatorId: f.target, expectedRevision: 0 };
      expect((await selection(idempotency, payload)).statusCode).toBe(200);
      if (kind === 'grant withdrawn') await ctx.db.update(roleAssignment).set({ archivedAt: new Date() }).where(eq(roleAssignment.id, f.assignment));
      if (kind === 'session revoked') await ctx.db.update(session).set({ revokedAt: new Date() }).where(eq(session.id, f.session));
      if (kind === 'session expired') await ctx.db.update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.id, f.session));
      if (kind === 'session locked') await ctx.db.update(session).set({ lockedAt: new Date() }).where(eq(session.id, f.session));
      if (kind === 'target archived') await ctx.db.update(operator).set({ archivedAt: new Date() }).where(eq(operator.id, f.target));
      const audits = await switchAudits(), response = await selection(idempotency, payload);
      refusedCached(response);
      expect(response.statusCode).toBe(kind === 'grant withdrawn' ? 403 : kind === 'session locked' ? 423 : 401);
      expect(await switchAudits()).toEqual(audits);
    },
  );

  it('R9 [high] preserves a pre-upgrade ordinary hash only for a truthful home session with no override', async () => {
    const idempotency = key(), payload = { marker: 'legacy-home' }, answer = { marker: 'legacy-home', operatorId: f.home, legacy: true };
    await putLegacy(idempotency, 'POST', ORDINARY, payload, answer);
    const response = await ordinary(idempotency, payload);
    expect(response.statusCode).toBe(200); expect(response.headers['x-oto-replay']).toBe('true'); expect(response.json()).toEqual(answer); expect(calls).toBe(0);
  });

  it('R10 [critical] a pre-upgrade ordinary hash cannot be treated as a foreign-operator answer', async () => {
    const idempotency = key(), payload = { marker: 'legacy-not-foreign' };
    await putLegacy(idempotency, 'POST', ORDINARY, payload, { operatorId: f.home, legacy: true }); await move(f.target, 0);
    const response = await ordinary(idempotency, payload);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(response.headers['x-oto-replay']).not.toBe('true'); expect(calls).toBe(0);
  });

  it('R11 [critical] legacy account-only switch hashes are not proof of this session committing a selection', async () => {
    const idempotency = key(), payload = { operatorId: f.target, expectedRevision: 0 };
    await putLegacy(idempotency, 'PUT', SWITCH, payload, { homeOperatorId: f.home, effectiveOperatorId: f.target,
      operatorOverride: f.target, branchId: null, stationId: null, revision: 1, changed: true });
    refusedCached(await selection(idempotency, payload));
    expect(await options()).toMatchObject({ effectiveOperatorId: f.home, revision: 0 }); expect(await switchAudits()).toEqual([]);
  });

  it('R12 [high] concurrent ordinary retries keep one atomic claim, one committed answer and one audit', async () => {
    const idempotency = key(); let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = ordinary(idempotency).then(response => response);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('ZZ_TEST_HANDLER_NOT_REACHED')), 5000);
      })]);
      const rival = await ordinary(idempotency);
      expect(rival.statusCode).toBe(409); expect(rival.json().error.code).toBe('IDEMPOTENCY_IN_FLIGHT'); expect(rival.headers['retry-after']).toBe('1');
    } finally { clearTimeout(timeout); release(); }
    const winner = await first; expect(winner.statusCode).toBe(200);
    const retry = await ordinary(idempotency); expect(retry.json()).toEqual(winner.json());
    expect(calls).toBe(1); expect(await writeAudits()).toHaveLength(1); expect(await stored(idempotency)).toMatchObject({ statusCode: 200 });
  });

  it('R13 [high] an expired A claim is taken over by actual B work rather than replaying A', async () => {
    const idempotency = key(); expect((await ordinary(idempotency)).statusCode).toBe(200);
    await ctx.db.update(idempotencyKey).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(idempotencyKey.accountId, f.actor), eq(idempotencyKey.key, idempotency)));
    await move(f.target, 0); const retry = await ordinary(idempotency);
    expect(retry.statusCode).toBe(200); expect(retry.headers['x-oto-replay']).not.toBe('true'); expect(retry.json()).toMatchObject({ operatorId: f.target });
    expect(calls).toBe(2); expect(await writeAudits()).toHaveLength(2);
  });

  it('R14 [high] a 5xx still releases its claim and the genuine same-body retry commits normally', async () => {
    const idempotency = key(), payload: Payload = { marker: 'retry-after-fault', mode: 'fail-once' };
    expect((await ordinary(idempotency, payload)).statusCode).toBe(503); expect(await stored(idempotency)).toBeUndefined();
    expect((await ordinary(idempotency, payload)).statusCode).toBe(200); expect(calls).toBe(2); expect(await writeAudits()).toHaveLength(1);
  });

  it('R15 [critical] context binding never turns a credential-shaped response into a cacheable answer', async () => {
    const idempotency = key(), payload: Payload = { marker: 'credential-backstop', mode: 'credential' };
    expect((await ordinary(idempotency, payload)).statusCode).toBe(200); expect(await stored(idempotency)).toBeUndefined();
    expect((await ordinary(idempotency, payload)).statusCode).toBe(200); expect(await stored(idempotency)).toBeUndefined(); expect(calls).toBe(2);
  });
});
