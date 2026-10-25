import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, auditLog, branch, handoffToken, idempotencyKey, operator, role, roleAssignment, rolePermission, session, station } from '@oto/db';
import { newId } from '@oto/shared';
import { hashToken, newSessionToken } from '../src/plugins/session';
import { audit } from '../src/services/audit';
import { switchSessionOperator } from '../src/services/operator-switch';
import { createTestContext, teardownAll, type TestContext } from './helpers';

// Apply only as apps/api/test/operator-switch-request-race-review.test.ts.
// Q22 audit/auth lifecycle additions remain held; these cases exercise the
// existing native routes, transactions, session loader and replay store.
let ctx: TestContext;
let f: Awaited<ReturnType<typeof fixture>>;
type Gate = ReturnType<typeof deferred>;
let replayPause: { key: string; entered: Gate; resume: Gate; observedOperatorId: string | null } | undefined;

beforeAll(async () => {
  ctx = await createTestContext({ env: { HANDOFF_SIGNING_KEY: 'local:' + newSessionToken(),
    HANDOFF_APP_ORIGINS: 'pos=http://127.0.0.1:16400' } });
  // Registered after the native session onRequest and before any injection.
  // Hold a real replay after authentication, not a fabricated request context.
  ctx.app.addHook('onRequest', async req => {
    const pause = replayPause;
    if (!pause || req.method !== 'PUT' || req.routeOptions.url !== '/me/preferences'
      || req.headers['idempotency-key'] !== pause.key) return;
    replayPause = undefined; pause.observedOperatorId = req.auth?.operatorId ?? null;
    pause.entered.resolve(); await pause.resume.promise;
  });
}, 300_000);
beforeEach(async () => { f = await fixture(); });
afterEach(() => { replayPause?.resume.resolve(); replayPause = undefined; vi.restoreAllMocks(); });
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

async function fixture() {
  const ids = { home: newId(), target: newId(), a1: newId(), a2: newId(), b1: newId(), b2: newId(),
    aStation: newId(), bStation: newId(), actor: newId(), role: newId(), assignment: newId(), live: newId(), other: newId() };
  await ctx.db.insert(operator).values([{ id: ids.home, name: 'ZZ TEST 640 race home' }, { id: ids.target, name: 'ZZ TEST 640 race target' }]);
  await ctx.db.insert(branch).values([
    { id: ids.a1, operatorId: ids.home, name: 'ZZ TEST 640 A1', code: 'zz-test-a1' },
    { id: ids.a2, operatorId: ids.home, name: 'ZZ TEST 640 A2', code: 'zz-test-a2' },
    { id: ids.b1, operatorId: ids.target, name: 'ZZ TEST 640 B1', code: 'zz-test-b1' },
    { id: ids.b2, operatorId: ids.target, name: 'ZZ TEST 640 B2', code: 'zz-test-b2' },
  ]);
  await ctx.db.insert(station).values([
    { id: ids.aStation, operatorId: ids.home, branchId: ids.a1, name: 'ZZ TEST 640 A1 station' },
    { id: ids.bStation, operatorId: ids.target, branchId: ids.b1, name: 'ZZ TEST 640 B1 station' },
  ]);
  await ctx.db.insert(account).values({ id: ids.actor, operatorId: ids.home, phone: '+66999996407', status: 'active' });
  await ctx.db.insert(role).values({ id: ids.role, operatorId: ids.home, name: 'ZZ TEST 640 race platform authority' });
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: ids.role, permission: 'platform:operator:switch' },
    { id: newId(), roleId: ids.role, permission: 'admin:branch:read' },
  ]);
  await ctx.db.insert(roleAssignment).values({ id: ids.assignment, accountId: ids.actor, roleId: ids.role, scopeType: 'operator', scopeId: null });
  const token = newSessionToken(), expiresAt = new Date(Date.now() + 3_600_000), lastSeenAt = new Date();
  await ctx.db.insert(session).values([
    { id: ids.live, accountId: ids.actor, branchId: ids.a1, stationId: ids.aStation, tokenHash: hashToken(token), expiresAt, lastSeenAt },
    { id: ids.other, accountId: ids.actor, branchId: ids.a1, stationId: ids.aStation, tokenHash: hashToken(newSessionToken()), expiresAt, lastSeenAt },
  ]);
  return { ...ids, cookie: `oto_session=${token}` };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function reachedWithin(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('ZZ_TEST_640_NATIVE_BARRIER_NOT_REACHED')), 15_000);
  })]); } finally { clearTimeout(timer); }
}
const settle = <T>(promise: PromiseLike<T>) => Promise.resolve(promise).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
function unwrap<T>(result: Awaited<ReturnType<typeof settle<T>>>): T { if (!result.ok) throw result.error; return result.value; }
const key = () => `zz-test-640-${newId()}`;
const pickBranch = (branchId: string) => ctx.app.inject({ method: 'PUT', url: '/me/session/branch', headers: { cookie: f.cookie }, payload: { branchId } });
const preferences = (idempotency: string) => ctx.app.inject({ method: 'PUT', url: '/me/preferences',
  headers: { cookie: f.cookie, 'idempotency-key': idempotency }, payload: { theme: 'dark' } });
const selection = (idempotency: string, operatorId: string) => ctx.app.inject({ method: 'PUT', url: '/me/session/operator',
  headers: { cookie: f.cookie, 'idempotency-key': idempotency }, payload: { operatorId, expectedRevision: 0 } });
const move = () => switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.live, operatorId: f.target, expectedRevision: 0 });
const seat = async () => (await ctx.db.select({ accountId: session.accountId, operatorOverride: session.operatorOverride,
  branchId: session.branchId, stationId: session.stationId }).from(session).where(eq(session.id, f.live)))[0]!;
const successes = (action: string) => ctx.db.select({ id: auditLog.id, actorAccountId: auditLog.actorAccountId,
  operatorId: auditLog.operatorId, branchId: auditLog.branchId }).from(auditLog).where(and(
  eq(auditLog.actorAccountId, f.actor), eq(auditLog.action, action), eq(auditLog.entityId, action === 'account.preferences' ? f.actor : f.live)));
const stored = async (idempotency: string) => (await ctx.db.select().from(idempotencyKey).where(and(
  eq(idempotencyKey.accountId, f.actor), eq(idempotencyKey.key, idempotency))))[0]!;
const stable = async () => ({
  account: (await ctx.db.select({ operatorId: account.operatorId, status: account.status, uiTheme: account.uiTheme }).from(account).where(eq(account.id, f.actor)))[0],
  grants: await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, f.actor)),
  other: (await ctx.db.select().from(session).where(eq(session.id, f.other)))[0],
});

describe('SCRUM-640 native request races and accepted UUID representations', () => {
  for (const switchDuringWait of [false, true]) it(`R1 [critical] ${switchDuringWait ? 'FINDING: refuse stale A branch attachment after B switch' : 'control: preserve the native branch move without a context change'}`, async () => {
    // Keep this control independent of R2's station-clearing finding.
    await ctx.db.update(session).set({ stationId: null }).where(eq(session.id, f.live));
    const unchanged = await stable(), entered = deferred(), resume = deferred(), transact = ctx.db.transaction.bind(ctx.db);
    const paused = vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(async (callback, config) => {
      entered.resolve(); await resume.promise; return transact(callback, config);
    });
    const pending = settle(pickBranch(f.a2));
    try {
      await reachedWithin(entered.promise);
      if (switchDuringWait) expect(await move()).toMatchObject({ effectiveOperatorId: f.target, revision: 1, branchId: null, stationId: null });
      resume.resolve(); const response = unwrap(await pending);
      const outcome = { statusCode: response.statusCode, errorCode: response.json().error?.code ?? null,
        seat: await seat(), successCount: (await successes('session.branch_switch')).length };
      expect(outcome).toEqual(switchDuringWait
        ? { statusCode: 409, errorCode: 'SESSION_CONTEXT_CHANGED', seat: { accountId: f.actor, operatorOverride: f.target, branchId: null, stationId: null }, successCount: 0 }
        : { statusCode: 200, errorCode: null, seat: { accountId: f.actor, operatorOverride: null, branchId: f.a2, stationId: null }, successCount: 1 });
      expect(await stable()).toEqual(unchanged);
    } finally { resume.resolve(); try { await pending; } finally { paused.mockRestore(); } }
  });

  for (const differentBranch of [false, true]) it(`R2 [high] ${differentBranch ? 'FINDING: a valid B1-to-B2 move clears the incompatible station' : 'control: same-branch selection retains its valid station'}`, async () => {
    await move(); await ctx.db.update(session).set({ branchId: f.b1, stationId: f.bStation }).where(eq(session.id, f.live));
    const unchanged = await stable(), selected = differentBranch ? f.b2 : f.b1, response = await pickBranch(selected);
    const current = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: f.cookie } });
    const outcome = { statusCode: response.statusCode, seat: await seat(), currentStatus: current.statusCode,
      successCount: (await successes('session.branch_switch')).length };
    expect(outcome).toEqual({ statusCode: 200, seat: { accountId: f.actor, operatorOverride: f.target,
      branchId: selected, stationId: differentBranch ? null : f.bStation }, currentStatus: 200, successCount: 1 });
    expect(current.json()).toMatchObject({ account: { id: f.actor, operatorId: f.home },
      operatorContext: { effectiveOperatorId: f.target, branchId: selected, stationId: differentBranch ? null : f.bStation } });
    expect(await stable()).toEqual(unchanged);
  });

  for (const switchDuringWait of [false, true]) it(`R3 [critical] ${switchDuringWait ? 'FINDING: revalidate an ordinary cached answer after request authentication was superseded' : 'control: same-context cached retry preserves its native answer and single audit'}`, async () => {
    const idempotency = key(), first = await preferences(idempotency); expect(first.statusCode).toBe(200);
    const original = await stored(idempotency), unchanged = await stable(), pause = { key: idempotency,
      entered: deferred(), resume: deferred(), observedOperatorId: null as string | null };
    replayPause = pause; const pending = settle(preferences(idempotency));
    try {
      await reachedWithin(pause.entered.promise); expect(pause.observedOperatorId).toBe(f.home);
      if (switchDuringWait) await move();
      const currentSeat = await seat(); pause.resume.resolve(); const response = unwrap(await pending);
      const outcome = { statusCode: response.statusCode, replayed: response.headers['x-oto-replay'] === 'true',
        errorCode: response.json().error?.code ?? null, successCount: (await successes('account.preferences')).length };
      if (switchDuringWait) {
        expect(outcome).toMatchObject({ statusCode: 409, replayed: false, successCount: 1 });
        expect(['IDEMPOTENCY_MISMATCH', 'SESSION_CONTEXT_CHANGED']).toContain(outcome.errorCode);
      } else {
        expect(outcome).toEqual({ statusCode: 200, replayed: true, errorCode: null, successCount: 1 }); expect(response.json()).toEqual(first.json());
      }
      expect(await seat()).toEqual(currentSeat); expect(await stored(idempotency)).toEqual(original); expect(await stable()).toEqual(unchanged);
    } finally { pause.resume.resolve(); replayPause = undefined; await pending; }
  });

  it('R4 [high] FINDING: an accepted uppercase home UUID canonicalizes to a null no-op and retains the valid native seat', async () => {
    const unchanged = await stable(), response = await selection(key(), f.home.toUpperCase());
    const outcome = { statusCode: response.statusCode, body: response.json(), seat: await seat(),
      successCount: (await successes('session.operator_switch')).length };
    expect(outcome).toEqual({ statusCode: 200, body: { homeOperatorId: f.home, effectiveOperatorId: f.home, operatorOverride: null,
      branchId: f.a1, stationId: f.aStation, revision: 1, changed: false },
    seat: { accountId: f.actor, operatorOverride: null, branchId: f.a1, stationId: f.aStation }, successCount: 1 });
    expect(await stable()).toEqual(unchanged);
  });
  it('R5 [high] FINDING: an accepted uppercase target UUID preserves a genuine same-key lost-ack retry and one native audit', async () => {
    const idempotency = key(), unchanged = await stable(), target = f.target.toUpperCase();
    const first = await selection(idempotency, target), retry = await selection(idempotency, target);
    const outcome = { firstStatus: first.statusCode, first: first.json(), retryStatus: retry.statusCode,
      retry: retry.json(), replayed: retry.headers['x-oto-replay'] === 'true',
      seat: await seat(), successCount: (await successes('session.operator_switch')).length };
    const answer = { homeOperatorId: f.home, effectiveOperatorId: f.target, operatorOverride: f.target,
      branchId: null, stationId: null, revision: 1, changed: true };
    expect(outcome).toEqual({ firstStatus: 200, first: answer, retryStatus: 200, retry: answer, replayed: true,
      seat: { accountId: f.actor, operatorOverride: f.target, branchId: null, stationId: null }, successCount: 1 });
    expect(await stable()).toEqual(unchanged);
  });
});


/**
 * Add one real PID read before each native transaction callback. Neither its
 * handle nor SQL result is replaced. The audit pause is after the branch's
 * actual UPDATE has acquired the session row.
 */
async function branchWriterAgainst<T>(consume: () => PromiseLike<T>) {
  const paused = deferred(), resume = deferred(), pids = new WeakMap<object, number>(), consumerPids = new Set<number>();
  const transact = ctx.db.transaction.bind(ctx.db), record = audit.record.bind(audit);
  let collecting = false, branchPid: number | undefined;
  const transactions = vi.spyOn(ctx.db, 'transaction').mockImplementation(async (callback, config) =>
    transact(async tx => {
      const actual = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::integer as pid`);
      const pid = actual.rows[0]!.pid; pids.set(tx, pid);
      if (collecting) consumerPids.add(pid);
      return callback(tx);
    }, config));
  const auditing = vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
    if (entry.action === 'session.branch_switch' && entry.actorAccountId === f.actor && entry.entityId === f.live) {
      branchPid = pids.get(tx as object);
      paused.resolve(); await resume.promise;
    }
    return record(tx, entry);
  });
  const branchWrite = settle(pickBranch(f.a2));
  let consumer: ReturnType<typeof settle<T>> | undefined;
  try {
    await reachedWithin(paused.promise); expect(Number.isSafeInteger(branchPid)).toBe(true);
    collecting = true; consumer = settle(Promise.resolve().then(consume));
    let waiting: { pid: number; blocked: boolean } | undefined;
    const deadline = Date.now() + 10_000;
    while (!waiting && Date.now() < deadline) {
      if (consumerPids.size) {
        const actual = await ctx.db.execute<{ pid: number; blocked: boolean }>(sql`
          select pid::integer as pid, ${branchPid!}::integer = any(pg_blocking_pids(pid)) as blocked
          from pg_stat_activity
          where datname = current_database() and pid = any(array[${sql.join([...consumerPids].map(pid => sql`${pid}`), sql`, `)}]::integer[])
            and wait_event_type = 'Lock'
        `);
        waiting = actual.rows.find(row => row.blocked);
      }
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting, 'The actual consumer must wait on the paused native branch transaction').toMatchObject({ blocked: true });
    expect(consumerPids.has(waiting!.pid)).toBe(true); expect(waiting!.pid).not.toBe(branchPid);
    resume.resolve();
    const [branchResult, consumerResult] = await Promise.all([branchWrite, consumer]);
    return { branchResult, consumerResult, branchPid, waitingPid: waiting!.pid };
  } finally {
    resume.resolve();
    try { await Promise.all([branchWrite, ...(consumer ? [consumer] : [])]); }
    finally { auditing.mockRestore(); transactions.mockRestore(); }
  }
}

describe('SCRUM-640 native account/session lock ordering review', () => {
  it('R6 [critical] FINDING: branch audit and operator selection must not deadlock; use an account lock compatible with the audit actor FK', async () => {
    const unchanged = await stable(), run = await branchWriterAgainst(move);
    const response = unwrap(run.branchResult);
    const outcome = { branchStatus: response.statusCode, branchCode: response.json().error?.code ?? null,
      switchSucceeded: run.consumerResult.ok,
      switchCode: run.consumerResult.ok ? null : (run.consumerResult.error as { code?: string }).code ?? null };
    expect(outcome).toEqual({ branchStatus: 200, branchCode: null, switchSucceeded: true, switchCode: null });
    const switched = unwrap(run.consumerResult);
    expect(switched).toMatchObject({ homeOperatorId: f.home, effectiveOperatorId: f.target, operatorOverride: f.target,
      branchId: null, stationId: null, revision: 1, changed: true });
    expect(await seat()).toEqual({ accountId: f.actor, operatorOverride: f.target, branchId: null, stationId: null });
    expect(await successes('session.branch_switch')).toHaveLength(1);
    expect(await successes('session.operator_switch')).toHaveLength(1);
    const [switchedAudit] = await ctx.db.select({ before: auditLog.before, after: auditLog.after }).from(auditLog)
      .where(and(eq(auditLog.actorAccountId, f.actor), eq(auditLog.entityId, f.live), eq(auditLog.action, 'session.operator_switch')));
    expect(switchedAudit).toMatchObject({ before: { branchId: f.a2, stationId: null },
      after: { effectiveOperatorId: f.target, branchId: null, stationId: null, revision: 1 } });
    expect(await stable()).toEqual(unchanged);
  });

  it('R7 [critical] FINDING: a native handoff mint waiting behind the branch writer must settle without deadlock and never mint the old seat', async () => {
    await ctx.db.insert(rolePermission).values({ id: newId(), roleId: f.role, permission: 'app:pos:access' });
    const unchanged = await stable(), run = await branchWriterAgainst(() => ctx.app.inject({
      method: 'POST', url: '/auth/handoff', headers: { cookie: f.cookie, 'idempotency-key': key() }, payload: { app: 'pos' },
    }));
    const branchResponse = unwrap(run.branchResult), handoffResponse = unwrap(run.consumerResult);
    expect({ branchStatus: branchResponse.statusCode, handoffStatus: handoffResponse.statusCode })
      .toMatchObject({ branchStatus: 200, handoffStatus: expect.any(Number) });
    expect([200, 401]).toContain(handoffResponse.statusCode);
    const body = handoffResponse.json();
    const safe = { hasToken: typeof body.token === 'string', hasLaunchUrl: typeof body.launchUrl === 'string',
      errorCode: body.error?.code ?? null };
    const tokens = await ctx.db.select({ jti: handoffToken.jti }).from(handoffToken)
      .where(and(eq(handoffToken.accountId, f.actor), eq(handoffToken.sessionId, f.live)));
    const minted = await successes('auth.handoff_issue');
    if (handoffResponse.statusCode === 401) {
      expect(safe).toMatchObject({ hasToken: false, hasLaunchUrl: false }); expect(tokens).toEqual([]); expect(minted).toEqual([]);
    } else {
      expect(safe).toEqual({ hasToken: true, hasLaunchUrl: true, errorCode: null });
      expect(tokens).toHaveLength(1); expect(minted).toMatchObject([{ operatorId: f.home, branchId: f.a2 }]);
    }
    expect(await seat()).toEqual({ accountId: f.actor, operatorOverride: null, branchId: f.a2, stationId: null });
    expect(await successes('session.branch_switch')).toHaveLength(1);
    expect(await successes('session.operator_switch')).toEqual([]);
    expect(await stable()).toEqual(unchanged);
  });
});
