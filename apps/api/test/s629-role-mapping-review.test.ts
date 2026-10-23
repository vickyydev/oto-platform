import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account, appIdentity, auditLog, branch, handoffToken, otoappUserBranchAccess, otoappUsers,
  role, roleAssignment, session,
} from '@oto/db';
import { newId } from '@oto/shared';
import { hashToken, SESSION_COOKIE } from '../src/plugins/session';
import { handoffConfig, issueHandoff } from '../src/services/handoff';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-629 house review: actual exchange and provisioning transactions with
 * the real identity seam. No seam, resolver, audit or database mocks.
 * Passing pins cover prescribed protections; a reproduced defect gets a
 * severity/fix FINDING rather than being hidden by an assertion change.
 */
const origin = 'https://oto-app.s629-review.test';
const settings = { signingKey: `s629review:${randomBytes(32).toString('hex')}`,
  appOrigins: `oto_app=${origin}`, ttlSeconds: 60 };
let ctx: TestContext;
let operatorId: string;
let park: string;
let tenantId: string;
let legalEntity: string;
let appPark: string;
let actorId: string;
let actorCookie: string;
let serial = 0;

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true, env: { HANDOFF_SIGNING_KEY: settings.signingKey,
    HANDOFF_APP_ORIGINS: settings.appOrigins, ALLOWED_ORIGINS: origin } });
  const [administrator] = await ctx.db.select({ id: account.id, operatorId: account.operatorId }).from(account)
    .innerJoin(roleAssignment, eq(roleAssignment.accountId, account.id)).innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(and(eq(role.name, 'platform_admin'), isNull(role.operatorId), eq(account.status, 'active'))).limit(1);
  actorId = administrator!.id; operatorId = administrator!.operatorId;
  park = (await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId)).limit(1))[0]!.id;
  tenantId = newId(); legalEntity = newId(); appPark = newId();
  await ctx.db.execute(sql`alter table otoapp.operators add column if not exists platform_roles_enabled boolean not null default false`);
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug)
    values (${tenantId}, 'ZZ TEST 629 review group', ${`zz-test-629-review-${tenantId}`})`);
  await ctx.db.execute(sql`insert into otoapp.operators (id, tenant_id, name, platform_roles_enabled)
    values (${legalEntity}, ${tenantId}, 'ZZ TEST 629 review entity', true)`);
  await ctx.db.execute(sql`insert into otoapp.branches (id, tenant_id, operator_id, name, address, core_branch_id)
    values (${appPark}, ${tenantId}, ${legalEntity}, 'ZZ TEST 629 review park', '', ${park})`);
  const token = randomBytes(32).toString('hex');
  await ctx.db.insert(session).values({ id: newId(), accountId: actorId, branchId: park,
    tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) });
  actorCookie = `${SESSION_COOKIE}=${token}`;
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

interface Person { accountId: string; userId: string; sessionId: string; sessionToken: string }
async function person(rawRole: 'staff' | 'manager' | 'admin' | 'advisor' = 'staff', linked = true): Promise<Person> {
  const accountId = newId(), userId = newId(), sessionId = newId(), sessionToken = randomBytes(32).toString('hex');
  await ctx.db.insert(account).values({ id: accountId, operatorId, status: 'active', phone: `ZZ TEST 629 review ${++serial}` });
  await ctx.db.insert(otoappUsers).values({ id: userId, email: `zz-test-629-review-${userId}@otopark.test`,
    password: 'ZZ TEST unusable local credential', fullName: `ZZ TEST 629 review person ${serial}`,
    role: rawRole, operatorId: legalEntity, isActive: true, mustChangePassword: false, platformUserId: linked ? accountId : null });
  if (linked) await ctx.db.insert(appIdentity).values({ id: newId(), app: 'oto_app', accountId,
    externalUserId: userId, createdBy: actorId });
  await ctx.db.insert(session).values({ id: sessionId, accountId, branchId: park,
    tokenHash: hashToken(sessionToken), expiresAt: new Date(Date.now() + 3_600_000) });
  return { accountId, userId, sessionId, sessionToken };
}
async function manager(p: Person): Promise<string> {
  const [canonical] = await ctx.db.select({ id: role.id }).from(role)
    .where(and(eq(role.name, 'branch_manager'), isNull(role.operatorId), eq(role.isSystem, true))).limit(1);
  const id = newId(); await ctx.db.insert(roleAssignment).values({ id, accountId: p.accountId,
    roleId: canonical!.id, scopeType: 'branch', scopeId: park }); return id;
}
const mint = (p: Person) => issueHandoff(ctx.db, handoffConfig(settings), {
  sessionId: p.sessionId, accountId: p.accountId, sessionToken: p.sessionToken, audience: 'oto_app',
});
const exchange = (token: string) => ctx.app.inject({ method: 'POST', url: '/auth/handoff/exchange',
  headers: { origin }, payload: { token } });
const storedRole = async (p: Person) => (await ctx.db.select({ role: otoappUsers.role }).from(otoappUsers)
  .where(eq(otoappUsers.id, p.userId)))[0]!.role;
const roleAudits = (p: Person) => ctx.db.select({ actorAccountId: auditLog.actorAccountId,
  operatorId: auditLog.operatorId, before: auditLog.before, after: auditLog.after }).from(auditLog)
  .where(and(eq(auditLog.action, 'app_identity.role_sync'), eq(auditLog.entityId, p.userId)));
async function spent(jti: string) {
  const [state] = await ctx.db.select({ consumed: sql<boolean>`${handoffToken.consumedAt} is not null`,
    secretErased: sql<boolean>`${handoffToken.sessionSecret} is null` }).from(handoffToken).where(eq(handoffToken.jti, jti));
  return state;
}
async function withAuditFault(action: 'app_identity.role_sync' | 'app_identity.link', run: () => Promise<void>) {
  await ctx.db.execute(sql`create or replace function core.s629_review_fail() returns trigger language plpgsql
    as $$ begin raise exception 'ZZ TEST 629 review injected audit failure'; end; $$`);
  // action is a closed test-only literal union, never a request or credential.
  await ctx.db.execute(sql.raw(`create trigger s629_review_fail after insert on core.audit_log
    for each row when (new.action = '${action}') execute function core.s629_review_fail()`));
  try { await run(); } finally {
    await ctx.db.execute(sql`drop trigger if exists s629_review_fail on core.audit_log`);
    await ctx.db.execute(sql`drop function if exists core.s629_review_fail()`);
  }
}

describe('SCRUM-629 real identity-seam review', () => {
  it('R1 [high] a real manager exchange returns the anchored claim and persists/audits once; fix: reconcile through the strict seam inside a transaction', async () => {
    const p = await person(); await manager(p); const issued = await mint(p), response = await exchange(issued.token);
    expect(response.statusCode).toBe(200);
    expect(response.json().otoApp).toEqual({ platformRolesEnabled: true, userId: p.userId, operatorId: legalEntity,
      tenantId, role: 'manager', permissions: { 'hr:salary:view': false } });
    expect(await storedRole(p)).toBe('manager');
    expect(await roleAudits(p)).toMatchObject([{ actorAccountId: p.accountId, operatorId,
      before: { role: 'staff' }, after: { role: 'manager' } }]);
    expect(await spent(issued.jti)).toEqual({ consumed: true, secretErased: true });
    const fresh = await exchange((await mint(p)).token); expect(fresh.statusCode).toBe(200);
    expect(fresh.json().otoApp.role).toBe('manager'); expect(await roleAudits(p)).toHaveLength(1);
  });
  it('R2 [critical] withdrawing a grant after mint downgrades the actual exchange; fix: derive fresh assignments after claim/liveness checks', async () => {
    const p = await person('manager'), assignment = await manager(p), issued = await mint(p);
    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.id, assignment));
    const response = await exchange(issued.token); expect(response.statusCode).toBe(200);
    expect(response.json().otoApp.role).toBe('staff'); expect(await storedRole(p)).toBe('staff');
    expect(await roleAudits(p)).toMatchObject([{ before: { role: 'manager' }, after: { role: 'staff' } }]);
  });
  it('R3 [critical] flagged advisors get the mapped claim but retain their raw identity and branch policy; fix: never persist over advisor', async () => {
    const p = await person('advisor'); await manager(p); const response = await exchange((await mint(p)).token);
    expect(response.statusCode).toBe(200); expect(response.json().otoApp.role).toBe('manager');
    expect(await storedRole(p)).toBe('advisor'); expect(await roleAudits(p)).toHaveLength(0);
    expect(await ctx.db.select({ id: otoappUserBranchAccess.id }).from(otoappUserBranchAccess)
      .where(eq(otoappUserBranchAccess.userId, p.userId))).toHaveLength(0);
  });
  it('R4 [high] a real flag-off exchange has exactly the legacy shape and role; fix: omit context rather than synthesize a disabled claim', async () => {
    const p = await person('admin'); await manager(p);
    await ctx.db.execute(sql`update otoapp.operators set platform_roles_enabled = false where id = ${legalEntity}`);
    try {
      const response = await exchange((await mint(p)).token); expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json()).sort()).toEqual(['accountId', 'audience', 'mustChangePassword', 'sessionLocked']);
      expect(await storedRole(p)).toBe('admin'); expect(await roleAudits(p)).toHaveLength(0);
    } finally { await ctx.db.execute(sql`update otoapp.operators set platform_roles_enabled = true where id = ${legalEntity}`); }
  });
  it('R5 [critical] a conflicting platform stamp cannot supply a role claim through the real exchange; fix: require both identity sides to agree', async () => {
    const p = await person('admin'); await manager(p);
    await ctx.db.update(otoappUsers).set({ platformUserId: null }).where(eq(otoappUsers.id, p.userId));
    const response = await exchange((await mint(p)).token); expect(response.statusCode).toBe(200);
    expect(Object.hasOwn(response.json(), 'otoApp')).toBe(false);
    expect(await storedRole(p)).toBe('admin'); expect(await roleAudits(p)).toHaveLength(0);
  });
  it('R6 [critical] actual role/audit failure rolls both back while the committed jti remains spent; fix: keep claim and role transactions separate', async () => {
    const p = await person(); await manager(p); const issued = await mint(p);
    await withAuditFault('app_identity.role_sync', async () => {
      const failure = await exchange(issued.token); expect(failure.statusCode).toBe(500);
      expect(await storedRole(p)).toBe('staff'); expect(await roleAudits(p)).toHaveLength(0);
      expect(await spent(issued.jti)).toEqual({ consumed: true, secretErased: true });
    });
    const replay = await exchange(issued.token); expect(replay.statusCode).toBe(401);
    expect(replay.json().error.details.reason).toBe('replayed');
    const fresh = await exchange((await mint(p)).token); expect(fresh.statusCode).toBe(200);
    expect(await storedRole(p)).toBe('manager'); expect(await roleAudits(p)).toHaveLength(1);
  });
  it('R7 [critical] a later real link audit failure undoes stamp, identity, access and mapped role, then exact retry succeeds; fix: retain one provisioning transaction', async () => {
    const p = await person('staff', false); await manager(p);
    await ctx.db.insert(otoappUserBranchAccess).values({ id: newId(), userId: p.userId, tenantId,
      branchId: appPark, accessScope: 'selected_branches' });
    const payload = { accountId: p.accountId, externalUserId: p.userId };
    const request = { method: 'POST' as const, url: '/admin/apps/oto_app/users',
      headers: { cookie: actorCookie, 'idempotency-key': newId() }, payload };
    await withAuditFault('app_identity.link', async () => {
      const failure = await ctx.app.inject(request); expect(failure.statusCode).toBe(500);
      expect(await storedRole(p)).toBe('staff'); expect(await roleAudits(p)).toHaveLength(0);
      const [stamp] = await ctx.db.select({ platformUserId: otoappUsers.platformUserId }).from(otoappUsers).where(eq(otoappUsers.id, p.userId));
      expect(stamp!.platformUserId === null).toBe(true);
      expect(await ctx.db.select({ id: appIdentity.id }).from(appIdentity).where(eq(appIdentity.accountId, p.accountId))).toHaveLength(0);
      const access = await ctx.db.select({ id: roleAssignment.id }).from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId))
        .where(and(eq(roleAssignment.accountId, p.accountId), eq(role.name, 'app_access_oto_app')));
      expect(access).toHaveLength(0);
    });
    const retried = await ctx.app.inject(request); expect(retried.statusCode).toBe(200);
    expect(await storedRole(p)).toBe('manager'); expect(await roleAudits(p)).toHaveLength(1);
    const replay = await ctx.app.inject(request); expect(replay.statusCode).toBe(200);
    expect(await roleAudits(p)).toHaveLength(1);
    expect(await ctx.db.select({ id: appIdentity.id }).from(appIdentity).where(eq(appIdentity.accountId, p.accountId))).toHaveLength(1);
  });
});
