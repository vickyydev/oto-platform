import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, auditLog, box, branch, operator, role, roleAssignment, rolePermission,
  session, staffToken, station } from '@oto/db';
import { newId } from '@oto/shared';
import { switchSessionOperator } from '../src/services/operator-switch';
import { createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

const keypair = generateKeyPairSync('ed25519');
const privateKey = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let ctx: TestContext;
let f: Awaited<ReturnType<typeof fixture>>;
let fixtureSequence = 0;

beforeAll(async () => {
  ctx = await createTestContext({ env: { STAFF_TOKEN_PRIVATE_KEY: privateKey } });
}, 300_000);
beforeEach(async () => { f = await fixture(); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (f) await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie: f.cookie } });
});
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

async function fixture() {
  const ids = { home: newId(), target: newId(), branch: newId(), box: newId(), station: newId(),
    actor: newId(), role: newId(), assignment: newId() };
  await ctx.db.insert(operator).values([{ id: ids.home, name: 'ZZ TEST 640 station race home' },
    { id: ids.target, name: 'ZZ TEST 640 station race target' }]);
  await ctx.db.insert(branch).values({ id: ids.branch, operatorId: ids.home, name: 'ZZ TEST 640 station race park', code: `zz-test-${ids.branch}` });
  await ctx.db.insert(box).values({ id: ids.box, operatorId: ids.home, branchId: ids.branch,
    name: 'ZZ TEST 640 station race box', slot: `zz-test-${ids.box}` });
  await ctx.db.insert(station).values({ id: ids.station, operatorId: ids.home, branchId: ids.branch,
    boxId: ids.box, name: 'ZZ TEST 640 station race till', kind: 'till', accessScope: 'all_staff' });
  // Generated only in memory; the actual local sign-in and token mint remain native.
  const password = randomBytes(24).toString('hex'), phone = '+669' + String(88100640 + fixtureSequence++);
  expect((await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, phone))).length).toBe(0);
  await ctx.db.insert(account).values({ id: ids.actor, operatorId: ids.home, phone,
    passwordHash: await hash(password), status: 'active' });
  await ctx.db.insert(role).values({ id: ids.role, operatorId: ids.home, name: 'ZZ TEST 640 station race platform grant', isSystem: false });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: ids.role, permission: 'platform:operator:switch' });
  await ctx.db.insert(roleAssignment).values({ id: ids.assignment, accountId: ids.actor,
    roleId: ids.role, scopeType: 'operator', scopeId: null });
  const cookie = await signInAs(ctx.app, phone, password);
  const tokenHash = createHash('sha256').update(cookie.slice('oto_session='.length)).digest('hex');
  const [owned] = await ctx.db.select({ id: session.id, branchId: session.branchId, stationId: session.stationId })
    .from(session).where(and(eq(session.accountId, ids.actor), eq(session.tokenHash, tokenHash)));
  expect(owned?.branchId).toBe(ids.branch);
  expect(owned?.stationId).toBeNull();
  return { ...ids, session: owned!.id, cookie };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function reachedWithin(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ZZ_TEST_640_NATIVE_PICK_BARRIER_NOT_REACHED')), 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

const seat = async () => (await ctx.db.select({ accountId: session.accountId, operatorOverride: session.operatorOverride,
  branchId: session.branchId, stationId: session.stationId }).from(session).where(eq(session.id, f.session)))[0]!;
const tokens = () => ctx.db.select({ jti: staffToken.jti, accountId: staffToken.accountId, sessionId: staffToken.sessionId,
  operatorId: staffToken.operatorId, branchId: staffToken.branchId, stationId: staffToken.stationId,
  boxId: staffToken.boxId, revokedAt: staffToken.revokedAt }).from(staffToken).where(eq(staffToken.sessionId, f.session));
const successes = () => ctx.db.select({ id: auditLog.id, action: auditLog.action }).from(auditLog)
  .where(and(eq(auditLog.actorAccountId, f.actor), inArray(auditLog.action, ['session.station_pick', 'staff_token.mint'])));
const pick = () => ctx.app.inject({ method: 'PUT', url: '/me/session/station',
  headers: { cookie: f.cookie }, payload: { stationId: f.station } });

describe('SCRUM-640 native station-pick isolation house review', () => {
  it('R1 [critical] refuses an authorized A pick resumed after a real B switch, before mint or success audit', async () => {
    const beforeTokens = await tokens();
    expect(beforeTokens).toEqual([]);
    const reached = deferred(), resume = deferred(), transact = ctx.db.transaction.bind(ctx.db);
    // Native pick reaches withTx only after its real station, grant, seat and
    // staff-list checks. Pause transaction entry, not any database operation.
    const paused = vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(async (callback, config) => {
      reached.resolve(); await resume.promise;
      return transact(callback, config);
    });
    const picking = pick().then(response => response);
    try {
      await reachedWithin(reached.promise);
      const switched = await switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.session,
        operatorId: f.target, expectedRevision: 0 }, { actorAccountId: f.actor, requestId: `zz-test-640-race-${newId()}` });
      expect(switched).toMatchObject({ effectiveOperatorId: f.target, operatorOverride: f.target,
        branchId: null, stationId: null, revision: 1, changed: true });
      const switchedSeat = { accountId: f.actor, operatorOverride: f.target, branchId: null, stationId: null };
      expect(await seat()).toEqual(switchedSeat);
      resume.resolve();
      const response = await picking;
      // Capture only safe metadata before asserting, so a failing run proves
      // whether the stale request also wrote a seat, token or success audit.
      const outcome = { statusCode: response.statusCode,
        errorCode: (response.json() as { error?: { code?: string } }).error?.code ?? null,
        seat: await seat(), tokens: await tokens(), successActions: (await successes()).map(row => row.action).sort() };
      expect(outcome).toEqual({ statusCode: 409, errorCode: 'SESSION_CONTEXT_CHANGED',
        seat: switchedSeat, tokens: beforeTokens, successActions: [] });
      expect((await ctx.db.select({ operatorId: account.operatorId }).from(account).where(eq(account.id, f.actor)))[0])
        .toEqual({ operatorId: f.home });
    } finally {
      resume.resolve();
      try { await picking; } finally { paused.mockRestore(); }
    }
  });

  it('R2 [high] the same real key and owned box mint a usable native shift-token response without a context change', async () => {
    const response = await pick();
    expect(response.statusCode).toBe(200);
    const body = response.json() as { station: { id: string }; staffToken: { token: string; jti: string } | null; staffTokenUnavailable: string | null };
    // Compare only safe metadata/booleans; a failed assertion never prints a bearer.
    expect(body.station.id).toBe(f.station);
    expect(typeof body.staffToken?.token === 'string' && body.staffToken.token.length > 0).toBe(true);
    expect(body.staffTokenUnavailable).toBeNull();
    const rows = await tokens();
    expect(rows).toEqual([{ jti: body.staffToken!.jti, accountId: f.actor, sessionId: f.session,
      operatorId: f.home, branchId: f.branch, stationId: f.station, boxId: f.box, revokedAt: null }]);
    expect(await seat()).toEqual({ accountId: f.actor, operatorOverride: null, branchId: f.branch, stationId: f.station });
    expect((await successes()).map(row => row.action).sort()).toEqual(['session.station_pick', 'staff_token.mint']);
  });
});
