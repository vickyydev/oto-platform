import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, appIdentity, auditLog, branch, employee, handoffToken, operator, otoappUserBranchAccess,
  otoappUsers, role, roleAssignment, rolePermission, session } from '@oto/db';
import { newId } from '@oto/shared';
import { hashToken } from '../src/plugins/session';
import { exchangeHandoff, handoffConfig, signHandoffToken, verifyToken, type HandoffApp } from '../src/services/handoff';
import { switchSessionOperator } from '../src/services/operator-switch';
import { createTestContext, teardownAll, type TestContext } from './helpers';

// House review: real native mint/exchange, session cookies, switch transactions and
// identity seam. Only generated local credentials are held in memory.
const POS = 'https://pos.zz-test-640.test', OTO = 'https://oto.zz-test-640.test';
const settings = { signingKey: `s640handoff:${randomBytes(32).toString('hex')}`,
  appOrigins: `pos=${POS},oto_app=${OTO}`, ttlSeconds: 60 };
const config = handoffConfig(settings);
let ctx: TestContext, f: Awaited<ReturnType<typeof fixture>>, serial = 0;
beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true, env: { HANDOFF_SIGNING_KEY: settings.signingKey,
    HANDOFF_APP_ORIGINS: settings.appOrigins, ALLOWED_ORIGINS: `${POS},${OTO}` } });
  await ctx.db.execute(sql`alter table otoapp.operators add column if not exists platform_roles_enabled boolean not null default false`);
}, 300_000);
beforeEach(async () => { f = await fixture(); });
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

async function fixture() {
  const ids = { home: newId(), target: newId(), homeBranch: newId(), targetBranch: newId(), actor: newId(),
    employee: newId(), role: newId(), assignment: newId() };
  await ctx.db.insert(operator).values([{ id: ids.home, name: 'ZZ TEST 640 handoff home' },
    { id: ids.target, name: 'ZZ TEST 640 handoff target' }]);
  await ctx.db.insert(branch).values([{ id: ids.homeBranch, operatorId: ids.home, name: 'ZZ TEST 640 home park', code: `zz-${ids.homeBranch}` },
    { id: ids.targetBranch, operatorId: ids.target, name: 'ZZ TEST 640 target park', code: `zz-${ids.targetBranch}` }]);
  await ctx.db.insert(employee).values({ id: ids.employee, operatorId: ids.home, branchId: ids.homeBranch, name: 'ZZ TEST 640 handoff employee' });
  const password = randomBytes(24).toString('hex'), phone = '+669' + String(87106400 + serial++);
  await ctx.db.insert(account).values({ id: ids.actor, operatorId: ids.home, employeeId: ids.employee,
    phone, passwordHash: await hash(password), status: 'active' });
  await ctx.db.insert(role).values({ id: ids.role, operatorId: ids.home, isSystem: false, name: `ZZ TEST 640 handoff grant ${ids.role}` });
  for (const permission of ['platform:operator:switch', 'app:pos:access', 'app:oto_app:access', 'admin:branch:read'] as const)
    await ctx.db.insert(rolePermission).values({ id: newId(), roleId: ids.role, permission });
  await ctx.db.insert(roleAssignment).values({ id: ids.assignment, accountId: ids.actor, roleId: ids.role, scopeType: 'operator', scopeId: null });
  const signed = await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { phone, password } });
  expect(signed.statusCode).toBe(200);
  const header = signed.headers['set-cookie'], cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0];
  expect(typeof cookie === 'string' && cookie.startsWith('oto_session=')).toBe(true);
  const sessionToken = cookie!.slice('oto_session='.length);
  const [owned] = await ctx.db.select({ id: session.id }).from(session).where(and(eq(session.accountId, ids.actor), eq(session.tokenHash, hashToken(sessionToken))));
  expect(typeof owned?.id).toBe('string');
  return { ...ids, session: owned!.id, cookie: cookie!, sessionToken };
}
const move = (operatorId: string | null = f.target, expectedRevision = 0) => switchSessionOperator(ctx.db,
  { accountId: f.actor, sessionId: f.session, operatorId, expectedRevision }, { actorAccountId: f.actor, requestId: `zz-test-640-handoff-${newId()}` });
const mintResponse = (app: HandoffApp = 'pos') => ctx.app.inject({ method: 'POST', url: '/auth/handoff', headers: { cookie: f.cookie }, payload: { app } });
async function mint(app: HandoffApp = 'pos') {
  const response = await mintResponse(app); expect(response.statusCode).toBe(200);
  const token = (response.json() as { token?: unknown }).token;
  expect(typeof token === 'string' && token.length > 20).toBe(true);
  const claims = verifyToken(config.keys, token as string);
  if (!claims) throw new Error('ZZ_TEST_640_NATIVE_MINT_SIGNATURE_REQUIRED');
  return { token: token as string, claims };
}
async function consume(token: string, origin = POS) {
  try {
    const result = await exchangeHandoff(ctx.db, config, { token, origin, requestId: `zz-test-640-exchange-${newId()}` });
    return { accepted: true, accountId: result.accountId, operatorId: result.operatorId, sessionId: result.sessionId,
      branchId: result.branchId, cookieMatches: hashToken(result.sessionToken) === hashToken(f.sessionToken),
      mustChangePassword: result.mustChangePassword, sessionLocked: result.sessionLocked };
  } catch (error) {
    const refusal = error as { statusCode?: number; code?: string; reason?: string };
    return { accepted: false, statusCode: refusal.statusCode ?? null, code: refusal.code ?? null, reason: refusal.reason ?? null };
  }
}
const nativeExchange = (token: string, origin = POS) => ctx.app.inject({ method: 'POST', url: '/auth/handoff/exchange', headers: { origin }, payload: { token } });
const spent = async (jti: string) => (await ctx.db.select({ consumed: sql<boolean>`${handoffToken.consumedAt} is not null`,
  secretErased: sql<boolean>`${handoffToken.sessionSecret} is null` }).from(handoffToken).where(eq(handoffToken.jti, jti)))[0];
const homeIdentity = async () => (await ctx.db.select({ operatorId: account.operatorId, employeeId: account.employeeId })
  .from(account).where(eq(account.id, f.actor)))[0];

// Mint binds the freshly resolved context under its account/session locks.
// These pins do not add a captured-request ABA refusal or protected ask policy.
// Historical wire fixtures use the native AES-GCM/HKDF protocol and the
// generated local key. No cookie, ciphertext or key is an assertion value.
async function replaceSealedPayload(jti: string, plaintext: string) {
  const key = config.keys[0]!, iv = randomBytes(12);
  const derived = Buffer.from(hkdfSync('sha256', key.secret, jti, 'oto-handoff-session-token', 32));
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  cipher.setAAD(Buffer.from(jti, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  await ctx.db.update(handoffToken).set({ sessionSecret: sealed }).where(eq(handoffToken.jti, jti));
}
const homeContextPayload = (cookie = f.sessionToken) => ({ version: 1, cookie, homeOperatorId: f.home,
  operatorId: f.home, operatorOverride: null, operatorRevision: 0 });

async function appIdentityFixture(rawRole: 'staff' | 'advisor' = 'staff', linked = true) {
  const tenant = newId(), entity = newId(), appBranch = newId(), user = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants(id,name,slug) values(${tenant},'ZZ TEST 640 handoff tenant',${`zz-test-640-${tenant}`})`);
  await ctx.db.execute(sql`insert into otoapp.operators(id,tenant_id,name,platform_roles_enabled)
    values(${entity},${tenant},'ZZ TEST 640 handoff legal entity',true)`);
  await ctx.db.execute(sql`insert into otoapp.branches(id,tenant_id,operator_id,name,address,core_branch_id)
    values(${appBranch},${tenant},${entity},'ZZ TEST 640 handoff app park','',${f.homeBranch})`);
  await ctx.db.insert(otoappUsers).values({ id: user, email: `zz-test-640-${user}@otopark.test`, password: 'ZZ TEST unusable app credential',
    fullName: 'ZZ TEST 640 handoff app identity', role: rawRole, operatorId: entity, platformUserId: linked ? f.actor : null,
    isActive: true, mustChangePassword: false });
  if (linked) await ctx.db.insert(appIdentity).values({ id: newId(), app: 'oto_app', accountId: f.actor, externalUserId: user, createdBy: f.actor });
  const [manager] = await ctx.db.select({ id: role.id }).from(role).where(and(eq(role.name, 'branch_manager'), isNull(role.operatorId), eq(role.isSystem, true)));
  expect(typeof manager?.id).toBe('string');
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: f.actor, roleId: manager!.id, scopeType: 'branch', scopeId: f.homeBranch });
  return { tenant, entity, appBranch, user };
}
async function appSnapshot(user: string) {
  return { home: await homeIdentity(), users: await ctx.db.select({ id: otoappUsers.id, role: otoappUsers.role, operatorId: otoappUsers.operatorId,
    platformUserId: otoappUsers.platformUserId, updatedAt: otoappUsers.updatedAt }).from(otoappUsers).where(eq(otoappUsers.id, user)),
  identities: await ctx.db.select({ id: appIdentity.id, accountId: appIdentity.accountId, externalUserId: appIdentity.externalUserId })
    .from(appIdentity).where(eq(appIdentity.accountId, f.actor)),
  placements: await ctx.db.select().from(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, user)),
  employees: await ctx.db.select({ id: employee.id, operatorId: employee.operatorId, branchId: employee.branchId })
    .from(employee).where(eq(employee.id, f.employee)),
  roleLinkAuditIds: (await ctx.db.select({ id: auditLog.id, action: auditLog.action }).from(auditLog)
    .where(and(eq(auditLog.actorAccountId, f.actor), sql`${auditLog.action} in ('app_identity.role_sync','app_identity.link','app_identity.create')`))) };
}

describe('SCRUM-640 native handoff context house review', () => {
  it('R1 [critical] a fresh B handoff exchanges as B while the account and employee remain at home A', async () => {
    await move(); const issued = await mint(), result = await consume(issued.token);
    expect(result).toMatchObject({ accepted: true, accountId: f.actor, operatorId: f.target, sessionId: f.session, branchId: null, cookieMatches: true });
    expect(await homeIdentity()).toEqual({ operatorId: f.home, employeeId: f.employee });
    expect(await spent(issued.claims.jti)).toEqual({ consumed: true, secretErased: true });
  });
  it('R2 [critical] minting at A then switching to B invalidates the original handoff and permanently consumes its claim', async () => {
    const issued = await mint(); await move();
    expect(await consume(issued.token)).toMatchObject({ accepted: false, statusCode: 401 });
    expect(await spent(issued.claims.jti)).toEqual({ consumed: true, secretErased: true });
    expect(await consume(issued.token)).toMatchObject({ accepted: false, reason: 'replayed' });
  });
  it('R3 [critical] B to A to B cannot revive a handoff from the original B revision', async () => {
    await move(); const old = await mint(); await move(null, 1); await move(f.target, 2);
    expect(await consume(old.token)).toMatchObject({ accepted: false, statusCode: 401 });
    const fresh = await mint(); expect(await consume(fresh.token)).toMatchObject({ accepted: true, operatorId: f.target, cookieMatches: true });
  });
  it('R4 [high] the fresh native app cookie sees only B branches while /me still names home account A', async () => {
    await move(); const response = await nativeExchange((await mint()).token); expect(response.statusCode).toBe(200);
    const set = response.headers['set-cookie'], cookie = (Array.isArray(set) ? set[0] : set)?.split(';')[0];
    expect(typeof cookie === 'string' && hashToken(cookie.slice('oto_session='.length)) === hashToken(f.sessionToken)).toBe(true);
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(me.statusCode).toBe(200); expect(me.json().account.operatorId).toBe(f.home);
    const parks = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie } }); expect(parks.statusCode).toBe(200);
    expect((parks.json() as { branches: Array<{ id: string }> }).branches.map(row => row.id)).toEqual([f.targetBranch]);
    expect(Object.keys(response.json()).sort()).toEqual(['accountId', 'audience', 'mustChangePassword', 'sessionLocked']);
  });
  it.each(['withdrawn switch permission', 'archived switch assignment', 'archived target'] as const)(
    'R5 [critical] rejects B after %s rather than falling back to home authority', async kind => {
      await move(); const issued = await mint();
      if (kind === 'withdrawn switch permission') await ctx.db.delete(rolePermission).where(and(eq(rolePermission.roleId, f.role), eq(rolePermission.permission, 'platform:operator:switch')));
      if (kind === 'archived switch assignment') await ctx.db.update(roleAssignment).set({ archivedAt: new Date() }).where(eq(roleAssignment.id, f.assignment));
      if (kind === 'archived target') await ctx.db.update(operator).set({ archivedAt: new Date() }).where(eq(operator.id, f.target));
      expect(await consume(issued.token)).toMatchObject({ accepted: false, statusCode: 401 });
      expect(await homeIdentity()).toEqual({ operatorId: f.home, employeeId: f.employee });
    });
  it.each(['revoked', 'expired', 'inactive account'] as const)('R6 [high] retains native %s liveness refusal after mint', async kind => {
    await move(); const issued = await mint();
    if (kind === 'revoked') await ctx.db.update(session).set({ revokedAt: new Date() }).where(eq(session.id, f.session));
    if (kind === 'expired') await ctx.db.update(session).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(session.id, f.session));
    if (kind === 'inactive account') await ctx.db.update(account).set({ status: 'inactive' }).where(eq(account.id, f.actor));
    expect(await consume(issued.token)).toMatchObject({ accepted: false, statusCode: 401, reason: 'revoked' });
  });
  it.each([false, true])('R7 [high] preserves existing lock/password exchange flags at override=%s; mint and business access still refuse', async overridden => {
    if (overridden) await move(); const locked = await mint();
    await ctx.db.update(session).set({ lockedAt: new Date() }).where(eq(session.id, f.session));
    expect(await consume(locked.token)).toMatchObject({ accepted: true, operatorId: overridden ? f.target : f.home, sessionLocked: true, mustChangePassword: false });
    expect((await mintResponse()).statusCode).toBe(423);
    expect((await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie: f.cookie } })).statusCode).toBe(423);
    await ctx.db.update(session).set({ lockedAt: null }).where(eq(session.id, f.session));
    const temporary = await mint(); await ctx.db.update(account).set({ mustChangePassword: true }).where(eq(account.id, f.actor));
    expect(await consume(temporary.token)).toMatchObject({ accepted: true, operatorId: overridden ? f.target : f.home, sessionLocked: false, mustChangePassword: true });
    expect((await mintResponse()).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie: f.cookie } })).statusCode).toBe(403);
  });
  it('R8 [high] home single-use/origin/audience controls stay unchanged and no public claims are added', async () => {
    const issued = await mint(); expect(Object.keys(issued.claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
    expect(await consume(issued.token, OTO)).toMatchObject({ accepted: false, statusCode: 401, reason: 'origin' });
    expect(await consume(issued.token)).toMatchObject({ accepted: false, reason: 'replayed' });
    const changed = await mint(), forged = signHandoffToken(config.keys[0]!, { ...changed.claims, aud: 'oto_app' });
    expect(await consume(forged, OTO)).toMatchObject({ accepted: false, statusCode: 401, reason: 'audience' });
    const fresh = await mint(); expect(await consume(fresh.token)).toMatchObject({ accepted: true, operatorId: f.home });
    expect(await consume(fresh.token)).toMatchObject({ accepted: false, reason: 'replayed' });
  });
  it.each([true, false])('R9 [critical] foreign-effective OTO refuses before role/link/provisioning writes, linked=%s', async linked => {
    const app = await appIdentityFixture('staff', linked); await move(); const before = await appSnapshot(app.user);
    const issued = await mintResponse('oto_app');
    const response = issued.statusCode === 200 ? await nativeExchange((issued.json() as { token: string }).token, OTO) : issued;
    const outcome = { refused: response.statusCode === 401 || response.statusCode === 403,
      cookieIssued: response.headers['set-cookie'] !== undefined, unchanged: JSON.stringify(await appSnapshot(app.user)) === JSON.stringify(before) };
    expect(outcome).toEqual({ refused: true, cookieIssued: false, unchanged: true });
  });
  it.each(['staff', 'advisor'] as const)('R10 [high] home OTO %s still resolves its actual identity and Q14 raw-role policy', async rawRole => {
    const app = await appIdentityFixture(rawRole), before = await appSnapshot(app.user);
    const response = await nativeExchange((await mint('oto_app')).token, OTO); expect(response.statusCode).toBe(200);
    expect(response.json().otoApp).toMatchObject({ userId: app.user, operatorId: app.entity, tenantId: app.tenant, role: 'manager' });
    const after = await appSnapshot(app.user); expect(after.users[0]!.role).toBe(rawRole === 'advisor' ? 'advisor' : 'manager');
    expect(after.identities).toEqual(before.identities); expect(after.placements).toEqual(before.placements);
    expect(after.home).toEqual(before.home); expect(after.employees).toEqual(before.employees);
    expect(after.roleLinkAuditIds.filter(row => row.action === 'app_identity.role_sync').length).toBe(rawRole === 'advisor' ? 0 : 1);
  });
  it('R11 [high] opens a pre-version opaque-cookie handoff at unchanged home revision zero', async () => {
    const issued = await mint();
    await replaceSealedPayload(issued.claims.jti, f.sessionToken);
    expect(await consume(issued.token)).toMatchObject({ accepted: true, accountId: f.actor,
      sessionId: f.session, operatorId: f.home, cookieMatches: true });
    expect(await spent(issued.claims.jti)).toEqual({ consumed: true, secretErased: true });
    expect(await consume(issued.token)).toMatchObject({ accepted: false, reason: 'replayed' });
  });
  it('R12 [critical] a legacy handoff cannot become valid again after a real B to home A round trip', async () => {
    const issued = await mint();
    await replaceSealedPayload(issued.claims.jti, f.sessionToken);
    await move(); await move(null, 1);
    expect(await homeIdentity()).toEqual({ operatorId: f.home, employeeId: f.employee });
    expect(await consume(issued.token)).toMatchObject({ accepted: false, statusCode: 401, reason: 'revoked' });
    expect(await spent(issued.claims.jti)).toEqual({ consumed: true, secretErased: true });
    expect(await consume(issued.token)).toMatchObject({ accepted: false, reason: 'replayed' });
  });
  it.each(['unknown version', 'malformed JSON', 'missing revision', 'unexpected field'] as const)(
    'R13 [high] refuses a sealed context with %s, consuming its claim without issuing a cookie', async kind => {
      const issued = await mint();
      let plaintext: string;
      if (kind === 'unknown version') plaintext = 'oto-session-context-v2:' + JSON.stringify({ ...homeContextPayload(), version: 2 });
      else if (kind === 'malformed JSON') plaintext = 'oto-session-context-v1:{';
      else if (kind === 'missing revision') {
        plaintext = 'oto-session-context-v1:' + JSON.stringify({ version: 1, cookie: f.sessionToken,
          homeOperatorId: f.home, operatorId: f.home, operatorOverride: null });
      } else plaintext = 'oto-session-context-v1:' + JSON.stringify({ ...homeContextPayload(), extra: true });
      await replaceSealedPayload(issued.claims.jti, plaintext);
      const response = await nativeExchange(issued.token);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.details.reason).toBe('signature');
      expect(response.headers['set-cookie'] === undefined).toBe(true);
      expect(await spent(issued.claims.jti)).toEqual({ consumed: true, secretErased: true });
      expect(await consume(issued.token)).toMatchObject({ accepted: false, reason: 'replayed' });
    });
  it('R14 [critical] refuses a valid sibling session cookie sealed into another session handoff', async () => {
    const issued = await mint(), siblingToken = randomBytes(32).toString('hex'), siblingId = newId();
    await ctx.db.insert(session).values({ id: siblingId, accountId: f.actor, branchId: f.homeBranch,
      tokenHash: hashToken(siblingToken), expiresAt: new Date(Date.now() + 3_600_000) });
    const validSibling = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: 'oto_session=' + siblingToken } });
    expect(validSibling.statusCode).toBe(200); expect(validSibling.json().account.id).toBe(f.actor);
    await replaceSealedPayload(issued.claims.jti, 'oto-session-context-v1:' + JSON.stringify(homeContextPayload(siblingToken)));
    const response = await nativeExchange(issued.token);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.details.reason).toBe('revoked');
    expect(response.headers['set-cookie'] === undefined).toBe(true);
    expect(await spent(issued.claims.jti)).toEqual({ consumed: true, secretErased: true });
    expect(await consume(issued.token)).toMatchObject({ accepted: false, reason: 'replayed' });
    const siblingStillLive = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: 'oto_session=' + siblingToken } });
    expect(siblingStillLive.statusCode).toBe(200); expect(siblingStillLive.json().account.id).toBe(f.actor);
  });

  it('R15 [critical] OTO role-sync audit uses the verified exchanger rather than an unrelated incoming cookie; fix: run reconciliation in its locked verified audit context', async () => {
    const app = await appIdentityFixture('staff'), before = await appSnapshot(app.user);
    expect(before.users[0]?.role).toBe('staff');
    const otherActor = newId(), otherSession = newId(), otherToken = randomBytes(32).toString('hex');
    await ctx.db.insert(account).values({ id: otherActor, operatorId: f.target, status: 'active',
      phone: `ZZ TEST 640 role audit bystander ${otherActor}` });
    await ctx.db.insert(session).values({ id: otherSession, accountId: otherActor,
      tokenHash: hashToken(otherToken), expiresAt: new Date(Date.now() + 3_600_000) });
    const otherCookie = 'oto_session=' + otherToken;
    const otherBefore = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: otherCookie } });
    expect(otherBefore.statusCode).toBe(200);
    expect(otherBefore.json().account.id).toBe(otherActor);
    expect(otherBefore.json().operatorContext).toMatchObject({ homeOperatorId: f.target, effectiveOperatorId: f.target });

    const issued = await mint('oto_app');
    const response = await ctx.app.inject({ method: 'POST', url: '/auth/handoff/exchange',
      headers: { origin: OTO, cookie: otherCookie }, payload: { token: issued.token } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountId: f.actor, audience: 'oto_app', mustChangePassword: false,
      sessionLocked: false, otoApp: { platformRolesEnabled: true, userId: app.user, operatorId: app.entity,
        tenantId: app.tenant, role: 'manager', permissions: { 'hr:salary:view': false } } });
    const after = await appSnapshot(app.user);
    expect(after.users[0]?.role).toBe('manager');
    expect(after.identities).toEqual(before.identities); expect(after.placements).toEqual(before.placements);
    expect(after.home).toEqual(before.home); expect(after.employees).toEqual(before.employees);
    expect(await spent(issued.claims.jti)).toEqual({ consumed: true, secretErased: true });

    const observed = await ctx.db.execute<{ actor_account_id: string | null; operator_id: string | null;
      branch_id: string | null; entity_type: string; before: unknown; after: unknown;
      home_operator_id: string | null; effective_operator_id: string | null }>(sql`
      select a.actor_account_id, a.operator_id, a.branch_id, a.entity_type, a."before", a."after",
        to_jsonb(a)->>'home_operator_id' as home_operator_id,
        to_jsonb(a)->>'effective_operator_id' as effective_operator_id
      from ${auditLog} a where a.action = 'app_identity.role_sync' and a.entity_id = ${app.user}`);
    expect(observed.rows).toHaveLength(1);
    expect(observed.rows[0]).toMatchObject({ actor_account_id: f.actor, operator_id: f.home,
      branch_id: null, entity_type: 'otoapp.user' });
    expect(observed.rows[0]?.before).toEqual({ role: 'staff' });
    expect(observed.rows[0]?.after).toEqual({ role: 'manager', platformAccountId: f.actor,
      appOperatorId: app.entity, tenantId: app.tenant });
    expect(observed.rows[0]).toMatchObject({ home_operator_id: f.home, effective_operator_id: f.home });
    const otherAfter = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: otherCookie } });
    expect(otherAfter.statusCode).toBe(200); expect(otherAfter.json().account.id).toBe(otherActor);
    expect(otherAfter.json().operatorContext).toMatchObject({ homeOperatorId: f.target, effectiveOperatorId: f.target });
  });

});
