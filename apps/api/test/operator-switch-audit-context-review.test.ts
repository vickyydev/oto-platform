import { existsSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, auditLog, branch, operator, role, roleAssignment, rolePermission, session } from '@oto/db';
import { newId } from '@oto/shared';
import { errors } from '../src/lib/errors';
import { hashToken, newSessionToken, resolveSessionAuth, SESSION_COOKIE, type AuthContext } from '../src/plugins/session';
import { audit } from '../src/services/audit';
import { switchSessionOperator } from '../src/services/operator-switch';
import { opCtx, withTx } from '../src/services/tx';
import { createTestContext, teardownAll, type TestContext } from './helpers';

type Attribution = Readonly<{ homeOperatorId: string; effectiveOperatorId: string }>;
interface AuditContextModule {
  runWithAuditContext<T>(auth: Readonly<AuthContext> | null, continuation: () => T): T;
  auditContextForActor(actorAccountId: string | null): Attribution | null;
}
type PersistedAudit = {
  operator_id: string | null; branch_id: string | null; actor_account_id: string | null;
  home_operator_id: string | null; effective_operator_id: string | null;
  action: string; before: unknown; after: unknown; request_id: string | null;
};
type RequestBody = { marker: string; rollback?: boolean; before?: unknown; after?: unknown;
  actorAccountId?: string; homeOperatorId?: string; effectiveOperatorId?: string };
const ROUTE = '/__test640/audit-context';
const ACTION = 'test.operator_audit_context';
const HANDOFF_ORIGIN = 'https://pos.zz-test-640-audit.test';
let ctx: TestContext;
let module: AuditContextModule | null = null;
let f: Awaited<ReturnType<typeof fixture>>;
let fixtureSequence = 0;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
function holdPoint() { return { entered: deferred(), release: deferred() }; }
const holds = new Map<string, ReturnType<typeof holdPoint>>();

// Only absence of this exact new module uses the current no-context behavior.
// An existing module's import/dependency failure is never swallowed.
async function loadAuditContextModule(): Promise<AuditContextModule | null> {
  const url = new URL('../src/services/audit-context.ts', import.meta.url);
  if (!existsSync(url)) return null;
  const loaded = await import(url.href) as Partial<AuditContextModule>;
  if (typeof loaded.runWithAuditContext !== 'function' || typeof loaded.auditContextForActor !== 'function') {
    throw new Error('Native audit-context contract missing');
  }
  return loaded as AuditContextModule;
}
const run = <T>(auth: Readonly<AuthContext> | null, continuation: () => T): T =>
  module ? module.runWithAuditContext(auth, continuation) : continuation();
const attribution = (actor: string | null) => module?.auditContextForActor(actor) ?? null;

beforeAll(async () => {
  module = await loadAuditContextModule();
  ctx = await createTestContext({ env: { HANDOFF_SIGNING_KEY: 's640audit:' + newSessionToken(),
    HANDOFF_APP_ORIGINS: `pos=${HANDOFF_ORIGIN}`, ALLOWED_ORIGINS: HANDOFF_ORIGIN } });
  // The fixture supplies only a business operation. Cookie auth, the request
  // continuation, native audit.record and withTx remain the production code.
  ctx.app.post<{ Body: RequestBody }>(ROUTE, { config: { auth: 'session' } }, async req => {
    const auth = req.requireAuth(), context = opCtx(req), body = req.body;
    const held = holds.get(body.marker);
    held?.entered.resolve();
    if (held) await held.release.promise;
    return withTx(ctx.db, context, ACTION, async tx => {
      await audit.record(tx, { actorAccountId: auth.accountId, operatorId: f.target, branchId: f.targetBranch,
        action: ACTION, entityType: 'zz_test_audit_context', entityId: body.marker,
        before: body.before, after: body.after, requestId: req.id });
      if (body.rollback) throw errors.conflict('ZZ_TEST_AUDIT_ROLLBACK', 'Synthetic rollback');
      return { ok: true };
    });
  });
}, 300_000);
beforeEach(async () => { holds.clear(); f = await fixture(); });
afterAll(async () => { holds.forEach(held => held.release.resolve()); try { await ctx?.close(); } finally { await teardownAll(); } });

async function fixture() {
  const ids = { home: newId(), target: newId(), otherHome: newId(), actor: newId(), otherActor: newId(),
    session: newId(), otherSession: newId(), targetBranch: newId(), grantRole: newId() };
  await ctx.db.insert(operator).values([{ id: ids.home, name: 'ZZ TEST 640 audit home' },
    { id: ids.target, name: 'ZZ TEST 640 audit target' }, { id: ids.otherHome, name: 'ZZ TEST 640 audit other home' }]);
  await ctx.db.insert(branch).values({ id: ids.targetBranch, operatorId: ids.target, name: 'ZZ TEST audit branch',
    code: `zz-audit-${ids.targetBranch}`, timezone: 'Asia/Bangkok' });
  const number = ++fixtureSequence;
  await ctx.db.insert(account).values([{ id: ids.actor, operatorId: ids.home,
    phone: `+669964${String(number * 2).padStart(5, '0')}`, status: 'active' },
  { id: ids.otherActor, operatorId: ids.otherHome,
    phone: `+669964${String(number * 2 + 1).padStart(5, '0')}`, status: 'active' }]);
  await ctx.db.insert(role).values({ id: ids.grantRole, operatorId: ids.home, name: 'ZZ TEST audit switch grant', isSystem: false });
  await ctx.db.insert(rolePermission).values([{ id: newId(), roleId: ids.grantRole, permission: 'platform:operator:switch' },
    { id: newId(), roleId: ids.grantRole, permission: 'app:pos:access' }]);
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: ids.actor, roleId: ids.grantRole, scopeType: 'operator', scopeId: null });
  const token = newSessionToken(), otherToken = newSessionToken();
  await ctx.db.insert(session).values([{ id: ids.session, accountId: ids.actor, tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000) }, { id: ids.otherSession, accountId: ids.otherActor,
    tokenHash: hashToken(otherToken), expiresAt: new Date(Date.now() + 3_600_000) }]);
  return { ...ids, token, otherToken, cookie: `${SESSION_COOKIE}=${token}`, otherCookie: `${SESSION_COOKIE}=${otherToken}` };
}

async function verified(token = f.token) {
  const auth = await resolveSessionAuth(ctx.db, token);
  if (!auth) throw new Error('Own native session did not resolve');
  return auth;
}
const selected = () => switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.session,
  operatorId: f.target, expectedRevision: 0 }, { actorAccountId: f.actor, operatorId: f.home, requestId: newId() });
const inject = (body: RequestBody, cookie = f.cookie) => ctx.app.inject({ method: 'POST', url: ROUTE, headers: { cookie }, payload: body });
async function rows(entityId: string) {
  const result = await ctx.db.execute<PersistedAudit>(sql`
    select a.operator_id, a.branch_id, a.actor_account_id, a.action, a."before", a."after", a.request_id,
      to_jsonb(a)->>'home_operator_id' as home_operator_id,
      to_jsonb(a)->>'effective_operator_id' as effective_operator_id
    from ${auditLog} a where a.entity_id = ${entityId} order by a.created_at, a.id`);
  return result.rows;
}
const entry = (entityId: string, actor = f.actor) => ({ actorAccountId: actor,
  operatorId: f.target, branchId: f.targetBranch, action: ACTION, entityType: 'zz_test_audit_context', entityId });
function columns(row: PersistedAudit | undefined, home: string | null, effective: string | null) {
  expect(row).toBeDefined();
  expect(row).toMatchObject({ home_operator_id: home, effective_operator_id: effective });
}

describe('SCRUM-640 Q22 trusted audit-context native house review', () => {
  it('R1 [high] installs the actual carrier and nullable columns; fix: append the expand migration and native module', async () => {
    expect(module, 'The no-context baseline is for RED only; GREEN requires the actual module').not.toBeNull();
    const result = await ctx.db.execute<{ column_name: string; data_type: string; is_nullable: string }>(sql`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'core' and table_name = 'audit_log'
        and column_name in ('home_operator_id', 'effective_operator_id') order by column_name`);
    expect(result.rows).toEqual([{ column_name: 'effective_operator_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'home_operator_id', data_type: 'uuid', is_nullable: 'YES' }]);
  });

  it('R2 [critical] native HTTP derives home attribution from verified auth, ignores body JSON, and preserves event-owner/payload; fix: capture the request continuation', async () => {
    const marker = newId(), before = { operatorId: f.otherHome, role: 'unchanged', nested: [0, null, 'before'] };
    const after = { auth: { actorAccountId: f.otherActor, homeOperatorId: f.otherHome, effectiveOperatorId: f.otherHome }, nested: ['after', false] };
    const response = await inject({ marker, actorAccountId: f.otherActor, homeOperatorId: f.otherHome,
      effectiveOperatorId: f.otherHome, before, after });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ok: true });
    const actual = await rows(marker); expect(actual).toHaveLength(1);
    columns(actual[0], f.home, f.home);
    expect(actual[0]).toMatchObject({ actor_account_id: f.actor, operator_id: f.target,
      branch_id: f.targetBranch, before, after, action: ACTION });
  });

  it('R3 [critical] native HTTP preserves real home while attributing the chosen working operator; fix: use the captured effective scope', async () => {
    await selected();
    expect(await verified()).toMatchObject({ accountId: f.actor, homeOperatorId: f.home, operatorId: f.target, operatorOverride: f.target });
    const marker = newId(), response = await inject({ marker, after: { unchanged: 'selected' } });
    expect(response.statusCode).toBe(200);
    const actual = await rows(marker); expect(actual).toHaveLength(1); columns(actual[0], f.home, f.target);
    expect((await ctx.db.select({ home: account.operatorId }).from(account).where(eq(account.id, f.actor)))[0]?.home).toBe(f.home);
  });

  it('R4 [critical] overlapping native request continuations never inherit the other actor; fix: AsyncLocalStorage.run around the native done continuation', async () => {
    const a = newId(), b = newId(), first = holdPoint(), second = holdPoint(); holds.set(a, first); holds.set(b, second);
    const requestA = Promise.resolve(inject({ marker: a }));
    let requestB: Promise<unknown> | undefined;
    try {
      await first.entered.promise;
      const launched = Promise.resolve(inject({ marker: b }, f.otherCookie)); requestB = launched;
      await second.entered.promise;
      first.release.resolve(); expect((await requestA).statusCode).toBe(200);
      second.release.resolve(); expect((await launched).statusCode).toBe(200);
      columns((await rows(a))[0], f.home, f.home); columns((await rows(b))[0], f.otherHome, f.otherHome);
    } finally {
      first.release.resolve(); second.release.resolve(); await Promise.allSettled([requestA, ...(requestB ? [requestB] : [])]);
    }
  });

  it('R5 [critical] an old native continuation is not resampled after a concurrent real session switch; fix: freeze attribution once at verified resolution', async () => {
    const marker = newId(), held = holdPoint(); holds.set(marker, held);
    const request = Promise.resolve(inject({ marker, after: { unchanged: 'old continuation' } }));
    try {
      await held.entered.promise; await selected();
      expect(await verified()).toMatchObject({ operatorId: f.target, homeOperatorId: f.home });
      held.release.resolve(); expect((await request).statusCode).toBe(200);
      const actual = await rows(marker); expect(actual).toHaveLength(1); columns(actual[0], f.home, f.home);
      expect(actual[0]?.after).toEqual({ unchanged: 'old continuation' });
    } finally { held.release.resolve(); await Promise.allSettled([request]); }
  });

  it('R6 [critical] copied input and exposed attribution cannot mutate a post-await snapshot; fix: store immutable scalar copies', async () => {
    const auth = await verified(), marker = newId(), originalAccount = auth.accountId;
    await run(auth, async () => {
      auth.homeOperatorId = f.otherHome; auth.operatorId = f.otherHome; auth.accountId = f.otherActor;
      const exposed = attribution(originalAccount) as { homeOperatorId: string; effectiveOperatorId: string } | null;
      if (exposed) { try { exposed.homeOperatorId = f.otherHome; exposed.effectiveOperatorId = f.otherHome; } catch { /* A frozen result is also valid. */ } }
      await Promise.resolve();
      expect(attribution(originalAccount)).toEqual({ homeOperatorId: f.home, effectiveOperatorId: f.home });
      await audit.record(ctx.db, entry(marker, originalAccount));
    });
    columns((await rows(marker))[0], f.home, f.home);
    expect(attribution(originalAccount)).toBeNull();
  });

  it('R7 [critical] interleaved same-account home/selected snapshots stay isolated; fix: run-scoped storage without enterWith', async () => {
    const home = await verified(); await selected(); const target = await verified();
    const first = holdPoint(), a = newId(), b = newId();
    const pending = Promise.resolve(run(home, async () => {
      first.entered.resolve(); await first.release.promise; await audit.record(ctx.db, entry(a));
    }));
    try {
      await first.entered.promise;
      await run(target, async () => { await Promise.resolve(); await audit.record(ctx.db, entry(b)); });
      first.release.resolve(); await pending;
      columns((await rows(a))[0], f.home, f.home); columns((await rows(b))[0], f.home, f.target);
      expect(attribution(f.actor)).toBeNull();
    } finally { first.release.resolve(); await Promise.allSettled([pending]); }
  });

  it('R8 [control] mismatched actors never acquire somebody else\'s attribution', async () => {
    const marker = newId(); await run(await verified(), () => audit.record(ctx.db, entry(marker, f.otherActor)));
    const actual = (await rows(marker))[0]; columns(actual, null, null);
    expect(actual).toMatchObject({ actor_account_id: f.otherActor, operator_id: f.target, branch_id: f.targetBranch });
  });

  it('R9 [control] system and unwrapped records retain nullable attribution rather than guessing from event ownership', async () => {
    const system = newId(), outside = newId();
    await run(await verified(), () => audit.record(ctx.db, { ...entry(system), actorAccountId: null }));
    await audit.record(ctx.db, entry(outside));
    columns((await rows(system))[0], null, null); columns((await rows(outside))[0], null, null);
  });

  it('R10 [critical] a nested null scope masks then restores the outer verified context; fix: run(null) must not reuse an outer store', async () => {
    const outer = newId(), masked = newId(), after = newId();
    await run(await verified(), async () => {
      await audit.record(ctx.db, entry(outer));
      const result = await run(null, async () => { expect(attribution(f.actor)).toBeNull(); await audit.record(ctx.db, entry(masked)); return 'unchanged'; });
      expect(result).toBe('unchanged'); await audit.record(ctx.db, entry(after));
    });
    columns((await rows(outer))[0], f.home, f.home); columns((await rows(masked))[0], null, null);
    columns((await rows(after))[0], f.home, f.home); expect(attribution(f.actor)).toBeNull();
  });

  for (const revision of [undefined, 0]) {
    it(`R11 [high] truthful legacy home with ${revision === 0 ? 'zero' : 'absent'} revision remains compatible; fix: narrow fallback to unselected home`, async () => {
      const auth = await verified(), marker = newId(); delete auth.homeOperatorId; auth.operatorOverride = null;
      if (revision === undefined) delete auth.operatorRevision; else auth.operatorRevision = revision;
      await run(auth, () => audit.record(ctx.db, entry(marker))); columns((await rows(marker))[0], f.home, f.home);
    });
  }

  for (const invalid of ['missing-home-override', 'missing-home-revision', 'contradictory-effective', 'contradictory-override'] as const) {
    it(`R12 [high] ${invalid} yields null attribution; fix: reject contradictory context without inventing home`, async () => {
      const auth = await verified(), marker = newId();
      if (invalid.startsWith('missing-home')) delete auth.homeOperatorId;
      if (invalid === 'missing-home-override') { auth.operatorOverride = f.target; auth.operatorId = f.target; }
      if (invalid === 'missing-home-revision') auth.operatorRevision = 1;
      if (invalid === 'contradictory-effective') auth.operatorId = f.target;
      if (invalid === 'contradictory-override') auth.operatorOverride = f.target;
      await run(auth, async () => { expect(attribution(f.actor)).toBeNull(); await audit.record(ctx.db, entry(marker)); });
      columns((await rows(marker))[0], null, null);
    });
  }

  it('R13 [critical] caller entry fields and nested JSON cannot override a trusted attribution; fix: audit.record reads only the matching carrier', async () => {
    const marker = newId(), before = { homeOperatorId: f.otherHome }, after = { effectiveOperatorId: f.otherHome, actorAccountId: f.otherActor };
    const supplied = { ...entry(marker), homeOperatorId: f.otherHome, effectiveOperatorId: f.otherHome, before, after };
    await run(await verified(), () => audit.record(ctx.db, supplied));
    const actual = (await rows(marker))[0]; columns(actual, f.home, f.home);
    expect(actual).toMatchObject({ operator_id: f.target, branch_id: f.targetBranch, actor_account_id: f.actor, before, after });
  });

  it('R14 [critical] rollback removes the success/business change but preserves the frozen failure attribution after a later switch; fix: keep withTx failure continuation inside run', async () => {
    const auth = await verified(), marker = newId(), held = holdPoint();
    const original = (await ctx.db.select({ name: operator.name }).from(operator).where(eq(operator.id, f.target)))[0]!.name;
    const failure = errors.conflict('ZZ_TEST_AUDIT_ROLLBACK', 'Synthetic rollback');
    const work = Promise.resolve(run(auth, () => withTx(ctx.db, { actorAccountId: f.actor, operatorId: f.target,
      branchId: f.targetBranch, requestId: marker }, ACTION, async tx => {
      held.entered.resolve(); await held.release.promise;
      await tx.update(operator).set({ name: 'ZZ TEST rolled-back audit change' }).where(eq(operator.id, f.target));
      await audit.record(tx, { ...entry(marker), before: { unchanged: 1 }, after: { rolledBack: true } });
      throw failure;
    }))).then(() => ({ error: null }), error => ({ error: error as unknown }));
    try {
      await held.entered.promise; await selected(); expect((await verified()).operatorId).toBe(f.target);
      held.release.resolve(); expect((await work).error).toBe(failure);
      expect((await ctx.db.select({ name: operator.name }).from(operator).where(eq(operator.id, f.target)))[0]?.name).toBe(original);
      const actual = await rows(marker); expect(actual).toHaveLength(1); columns(actual[0], f.home, f.home);
      expect(actual[0]).toMatchObject({ actor_account_id: f.actor, operator_id: f.target, branch_id: f.targetBranch,
        action: `${ACTION}.failed`, before: null, after: { error: 'ZZ_TEST_AUDIT_ROLLBACK' }, request_id: marker });
    } finally { held.release.resolve(); await work; }
  });

  it('R15 [control] withTx failure attribution remains null when its operation actor mismatches the verified human', async () => {
    const marker = newId(), failure = errors.conflict('ZZ_TEST_AUDIT_MISMATCH', 'Synthetic mismatch');
    await expect(run(await verified(), () => withTx(ctx.db, { actorAccountId: f.otherActor, operatorId: f.target,
      branchId: f.targetBranch, requestId: marker }, ACTION, async () => { throw failure; }))).rejects.toBe(failure);
    const actual = await rows(marker); expect(actual).toHaveLength(1); columns(actual[0], null, null);
    expect(actual[0]).toMatchObject({ actor_account_id: f.otherActor, operator_id: f.target,
      branch_id: f.targetBranch, after: { error: 'ZZ_TEST_AUDIT_MISMATCH' } });
  });

  it('R16 [critical] public exchange attributes the sealed verified actor despite an unrelated valid cookie, without exposing internal context; fix: scope only its success audit to auditAuth', async () => {
    await selected();
    const minted = await ctx.app.inject({ method: 'POST', url: '/auth/handoff', headers: { cookie: f.cookie }, payload: { app: 'pos' } });
    expect(minted.statusCode).toBe(200);
    const token = (minted.json() as { token?: unknown }).token;
    if (typeof token !== 'string') throw new Error('Own native handoff did not mint a token');
    const exchanged = await ctx.app.inject({ method: 'POST', url: '/auth/handoff/exchange',
      headers: { origin: HANDOFF_ORIGIN, cookie: f.otherCookie }, payload: { token } });
    expect(exchanged.statusCode).toBe(200);
    const body = exchanged.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['accountId', 'audience', 'mustChangePassword', 'sessionLocked']);
    expect(body).toEqual({ accountId: f.actor, audience: 'pos', mustChangePassword: false, sessionLocked: false });
    const actual = (await rows(f.session)).filter(row => row.action === 'auth.handoff_exchange');
    expect(actual).toHaveLength(1); columns(actual[0], f.home, f.target);
    expect(actual[0]).toMatchObject({ actor_account_id: f.actor, operator_id: f.target, branch_id: null, before: null });
    const after = actual[0]?.after as { jti?: unknown; audience?: unknown };
    expect(Object.keys(after).sort()).toEqual(['audience', 'jti']);
    expect(after.audience).toBe('pos'); expect(typeof after.jti).toBe('string');
    expect(await verified(f.otherToken)).toMatchObject({ accountId: f.otherActor, homeOperatorId: f.otherHome,
      operatorId: f.otherHome, sessionId: f.otherSession });
  });
});
