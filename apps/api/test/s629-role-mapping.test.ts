import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account, appIdentity, auditLog, branch, department, otoappUserBranchAccess, otoappUsers,
  role, roleAssignment, rolePermission,
} from '@oto/db';
import { newId } from '@oto/shared';
import * as identity from '../src/services/oto-app-users';
import type { Exec } from '../src/services/tx';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

type Grant = { roleName: string; isSystem: boolean; roleOperatorId: string | null;
  scopeType: 'operator' | 'branch' | 'department' | 'record'; scopeId: string | null };
type Context = { platformRolesEnabled: true; userId: string; operatorId: string; tenantId: string;
  role: 'admin' | 'manager' | 'staff'; permissions: { 'hr:salary:view': boolean } };
type Options = { operatorId: string; accountId: string; tenantId?: string;
  actorAccountId?: string | null; requestId?: string };
// Namespace access lets the unchanged feature baseline reach actual assertions before exports exist.
const subject = identity as typeof identity & {
  roleFor: (grants: readonly Grant[]) => Context['role'];
  resolveOtoAppRoleContext: (exec: Exec, opts: Options) => Promise<Context | null>;
  reconcileOtoAppRole: (exec: Exec, opts: Options) => Promise<Context | null>;
};
const canonical = (roleName: string, scopeType: Grant['scopeType'] = 'operator', scopeId: string | null = null): Grant =>
  ({ roleName, isSystem: true, roleOperatorId: null, scopeType, scopeId });

describe('SCRUM-629 canonical role mapping', () => {
  it('maps only the approved canonical roles, with admin precedence independent of grant order', () => {
    expect(subject.roleFor([])).toBe('staff');
    for (const name of ['staff', 'reception', 'platform_admin']) expect(subject.roleFor([canonical(name)])).toBe('staff');
    expect(subject.roleFor([canonical('branch_manager')])).toBe('manager');
    expect(subject.roleFor([canonical('operator_admin')])).toBe('admin');
    const grants = [canonical('branch_manager'), canonical('operator_admin'), canonical('staff')];
    expect(subject.roleFor(grants)).toBe('admin'); expect(subject.roleFor([...grants].reverse())).toBe('admin');
  });
  it('custom same-name or non-system role provenance never becomes administrative authority', () => {
    for (const name of ['operator_admin', 'branch_manager']) {
      expect(subject.roleFor([{ ...canonical(name), isSystem: false }])).toBe('staff');
      expect(subject.roleFor([{ ...canonical(name), roleOperatorId: newId() }])).toBe('staff');
    }
  });
  it('operator admin requires operator scope; manager admits validated owning branch/department but no record scope', () => {
    for (const scope of ['branch', 'department', 'record'] as const)
      expect(subject.roleFor([canonical('operator_admin', scope, newId())])).toBe('staff');
    for (const scope of ['branch', 'department'] as const)
      expect(subject.roleFor([canonical('branch_manager', scope, newId())])).toBe('manager');
    expect(subject.roleFor([canonical('branch_manager', 'record', newId())])).toBe('staff');
  });
});

let ctx: TestContext;
let adminCookie: string;
let operatorId: string;
let foreignOperatorId: string;
let park: string;
let foreignPark: string;
let tenant: string;
let foreignTenant: string;
let legalEntity: string;
let disabledEntity: string;
let foreignEntity: string;
let appPark: string;
let foreignAppPark: string;
let ownDepartment: string;
let serial = 0;

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [admin] = await ctx.db.select({ operatorId: account.operatorId }).from(account).where(eq(account.phone, ADMIN.phone));
  const parks = await ctx.db.select({ id: branch.id, operatorId: branch.operatorId }).from(branch);
  operatorId = admin!.operatorId; park = parks.find(row => row.operatorId === operatorId)!.id;
  const away = parks.find(row => row.operatorId !== operatorId)!;
  foreignOperatorId = away.operatorId; foreignPark = away.id;
  tenant = newId(); foreignTenant = newId(); legalEntity = newId(); disabledEntity = newId(); foreignEntity = newId();
  appPark = newId(); foreignAppPark = newId(); ownDepartment = newId();
  // This disposable fixture also works before the new app migration is added to the baseline.
  await ctx.db.execute(sql`alter table otoapp.operators add column if not exists platform_roles_enabled boolean not null default false`);
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values
    (${tenant}, 'ZZ TEST 629 own group', ${`zz-test-629-${tenant}`}),
    (${foreignTenant}, 'ZZ TEST 629 foreign group', ${`zz-test-629-${foreignTenant}`})`);
  await ctx.db.execute(sql`insert into otoapp.operators (id, tenant_id, name, platform_roles_enabled) values
    (${legalEntity}, ${tenant}, 'ZZ TEST 629 enabled entity', true),
    (${disabledEntity}, ${tenant}, 'ZZ TEST 629 disabled entity', false),
    (${foreignEntity}, ${foreignTenant}, 'ZZ TEST 629 foreign entity', true)`);
  await ctx.db.execute(sql`insert into otoapp.branches (id, tenant_id, operator_id, name, address, core_branch_id) values
    (${appPark}, ${tenant}, ${legalEntity}, 'ZZ TEST 629 own park', '', ${park}),
    (${foreignAppPark}, ${foreignTenant}, ${foreignEntity}, 'ZZ TEST 629 foreign park', '', ${foreignPark})`);
  await ctx.db.insert(department).values({ id: ownDepartment, operatorId, branchId: park, name: 'ZZ TEST 629 department' });
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function person(opts: { rawRole?: 'staff' | 'manager' | 'admin' | 'advisor'; entity?: string | null;
  status?: 'active' | 'invited' | 'inactive'; active?: boolean; owner?: string; linked?: boolean } = {}) {
  const accountId = newId(), userId = newId(), next = ++serial;
  await ctx.db.insert(account).values({ id: accountId, operatorId: opts.owner ?? operatorId,
    status: opts.status ?? 'active', phone: `+669990629${String(next).padStart(2, '0')}` });
  await ctx.db.insert(otoappUsers).values({ id: userId, email: `zz-test-629-${userId}@otopark.test`,
    password: 'ZZ TEST unusable local credential', fullName: `ZZ TEST 629 person ${next}`,
    role: opts.rawRole ?? 'staff', operatorId: opts.entity === undefined ? legalEntity : opts.entity,
    isActive: opts.active ?? true, mustChangePassword: false, platformUserId: accountId });
  if (opts.linked !== false) await ctx.db.insert(appIdentity).values({ id: newId(), app: 'oto_app', accountId, externalUserId: userId, createdBy: accountId });
  return { accountId, userId, operatorId };
}
async function grant(accountId: string, name: string, scopeType: Grant['scopeType'] = 'operator', scopeId: string | null = operatorId, exec: Exec = ctx.db) {
  const [system] = await exec.select({ id: role.id }).from(role).where(and(eq(role.name, name), isNull(role.operatorId))).limit(1);
  const id = newId(); await exec.insert(roleAssignment).values({ id, accountId, roleId: system!.id, scopeType, scopeId }); return id;
}
const rawRole = async (userId: string) => (await ctx.db.select({ role: otoappUsers.role }).from(otoappUsers).where(eq(otoappUsers.id, userId)))[0]!.role;
const roleAudits = (userId: string) => ctx.db.select().from(auditLog)
  .where(and(eq(auditLog.action, 'app_identity.role_sync'), eq(auditLog.entityId, userId)));
const resolve = (p: { accountId: string }, patch: Partial<Options> = {}) =>
  subject.resolveOtoAppRoleContext(ctx.db, { operatorId, accountId: p.accountId, ...patch });
const reconcile = (p: { accountId: string }, patch: Partial<Options> = {}) =>
  ctx.db.transaction(tx => subject.reconcileOtoAppRole(tx, { operatorId, accountId: p.accountId, ...patch }));

describe('SCRUM-629 anchored identity context and reconciliation', () => {
  it('returns enabled context only for the exact account/stamp/identity and app legal entity, without writing during resolution', async () => {
    const p = await person({ rawRole: 'admin' }); await grant(p.accountId, 'branch_manager', 'branch', park);
    expect(await resolve(p)).toEqual({ platformRolesEnabled: true, userId: p.userId, operatorId: legalEntity,
      tenantId: tenant, role: 'manager', permissions: { 'hr:salary:view': false } });
    expect(await rawRole(p.userId)).toBe('admin'); expect(await roleAudits(p.userId)).toHaveLength(0);
    expect(await resolve(p, { tenantId: foreignTenant })).toBeNull();
    expect(await resolve(p, { operatorId: foreignOperatorId })).toBeNull();
    const unlinked = await person({ linked: false }); expect(await resolve(unlinked)).toBeNull();
    await ctx.db.update(appIdentity).set({ externalUserId: unlinked.userId }).where(eq(appIdentity.accountId, p.accountId));
    expect(await resolve(p)).toBeNull();
    await ctx.db.update(otoappUsers).set({ platformUserId: null }).where(eq(otoappUsers.id, p.userId));
    expect(await resolve(p)).toBeNull();
  });
  it('off, null legal entity, inactive account/user and a foreign legal-entity tenant preserve the stored role', async () => {
    for (const opts of [{ entity: disabledEntity }, { entity: null }, { status: 'inactive' as const },
      { active: false }, { entity: foreignEntity }, { owner: foreignOperatorId }]) {
      const p = await person({ rawRole: 'manager', ...opts }); await grant(p.accountId, 'operator_admin');
      expect(await reconcile(p)).toBeNull(); expect(await rawRole(p.userId)).toBe('manager');
      expect(await roleAudits(p.userId)).toHaveLength(0);
    }
  });
  it('defaults off when the old legal-entity schema has no flag, without aborting its caller transaction', async () => {
    const p = await person({ rawRole: 'manager' });
    await expect(ctx.db.transaction(async tx => {
      await tx.execute(sql`alter table otoapp.operators drop column platform_roles_enabled`);
      expect(await subject.resolveOtoAppRoleContext(tx, p)).toBeNull();
      expect((await tx.execute<{ alive: number }>(sql`select 1 as alive`)).rows[0]!.alive).toBe(1);
      throw new Error('ZZ TEST rollback old-schema fixture');
    })).rejects.toThrow('ZZ TEST rollback old-schema fixture');
  });
  it('reconciles legitimate invited accounts and audits an ordinary role change once; a second run is a no-op', async () => {
    const p = await person({ status: 'invited' }); await grant(p.accountId, 'operator_admin');
    expect((await reconcile(p))?.role).toBe('admin'); expect(await rawRole(p.userId)).toBe('admin');
    expect(await roleAudits(p.userId)).toMatchObject([{ actorAccountId: null, operatorId,
      before: { role: 'staff' }, after: { role: 'admin' } }]);
    await reconcile(p); expect(await roleAudits(p.userId)).toHaveLength(1);
  });
  it('keeps a raw advisor marker and its empty policy-derived branch reach while returning the mapped effective role', async () => {
    const p = await person({ rawRole: 'advisor' }); await grant(p.accountId, 'branch_manager', 'department', ownDepartment);
    expect((await reconcile(p))?.role).toBe('manager'); expect(await rawRole(p.userId)).toBe('advisor');
    expect(await roleAudits(p.userId)).toHaveLength(0);
    expect(await ctx.db.select().from(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, p.userId))).toHaveLength(0);
  });
  it('freshly downgrades after withdrawal and sees grants made in the same transaction', async () => {
    const p = await person({ rawRole: 'admin' });
    await ctx.db.transaction(async tx => {
      const id = await grant(p.accountId, 'branch_manager', 'branch', park, tx);
      expect((await subject.reconcileOtoAppRole(tx, p))?.role).toBe('manager');
      await tx.delete(roleAssignment).where(eq(roleAssignment.id, id));
      expect((await subject.reconcileOtoAppRole(tx, p))?.role).toBe('staff');
    });
    expect(await rawRole(p.userId)).toBe('staff'); expect(await roleAudits(p.userId)).toHaveLength(2);
  });
  it('ignores archived assignments and archived branch targets only in the new mapping, leaving flag-off role untouched', async () => {
    const p = await person(), assignment = await grant(p.accountId, 'operator_admin');
    await ctx.db.update(roleAssignment).set({ archivedAt: new Date() }).where(eq(roleAssignment.id, assignment));
    expect((await resolve(p))?.role).toBe('staff');
    const archivedPark = newId(); await ctx.db.insert(branch).values({ id: archivedPark, operatorId,
      name: 'ZZ TEST 629 archived park', code: `zz-test-${archivedPark}`, archivedAt: new Date() });
    await grant(p.accountId, 'branch_manager', 'branch', archivedPark);
    expect((await resolve(p))?.role).toBe('staff');
    const q = await person({ entity: disabledEntity, rawRole: 'manager' });
    const withdrawn = await grant(q.accountId, 'operator_admin');
    await ctx.db.update(roleAssignment).set({ archivedAt: new Date() }).where(eq(roleAssignment.id, withdrawn));
    expect(await reconcile(q)).toBeNull(); expect(await rawRole(q.userId)).toBe('manager');
  });
  it('rolls back a role change and its audit with a later caller failure', async () => {
    const p = await person(); await grant(p.accountId, 'operator_admin');
    await expect(ctx.db.transaction(async tx => {
      await subject.reconcileOtoAppRole(tx, p); throw new Error('ZZ TEST later identity fault');
    })).rejects.toThrow('ZZ TEST later identity fault');
    expect(await rawRole(p.userId)).toBe('staff'); expect(await roleAudits(p.userId)).toHaveLength(0);
  });
  it('rejects foreign assignment targets and corrupt department branch ownership, even when system role names match', async () => {
    const foreignDept = newId(), corruptDept = newId();
    await ctx.db.insert(department).values([{ id: foreignDept, operatorId: foreignOperatorId, branchId: foreignPark, name: 'ZZ TEST foreign department' },
      { id: corruptDept, operatorId, branchId: foreignPark, name: 'ZZ TEST corrupt department branch' }]);
    for (const [scopeType, scopeId] of [['operator', foreignOperatorId], ['branch', foreignPark],
      ['department', foreignDept], ['department', corruptDept], ['record', park]] as const) {
      const p = await person(); await grant(p.accountId, 'branch_manager', scopeType, scopeId);
      expect((await resolve(p))?.role).toBe('staff');
    }
    const p = await person(), custom = newId();
    await ctx.db.insert(role).values({ id: custom, operatorId, name: 'operator_admin', isSystem: false });
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: p.accountId, roleId: custom, scopeType: 'operator', scopeId: operatorId });
    expect((await resolve(p))?.role).toBe('staff');
  });
  it('carries salary only from an actual operator-wide covering permission, never from mapped role or branch grant', async () => {
    const p = await person(); const administratorGrant = await grant(p.accountId, 'operator_admin');
    expect((await resolve(p))?.permissions['hr:salary:view']).toBe(true);
    const [administratorRole] = await ctx.db.select({ id: role.id }).from(role)
      .where(and(eq(role.name, 'operator_admin'), isNull(role.operatorId), eq(role.isSystem, true))).limit(1);
    const rollback = new Error('ZZ TEST restore administrator salary permission');
    await expect(ctx.db.transaction(async tx => {
      await tx.delete(rolePermission).where(and(eq(rolePermission.roleId, administratorRole!.id), eq(rolePermission.permission, 'hr:salary:view')));
      const withoutPermission = await subject.resolveOtoAppRoleContext(tx, { operatorId, accountId: p.accountId });
      expect(withoutPermission?.role).toBe('admin');
      expect(withoutPermission?.permissions['hr:salary:view']).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await resolve(p))?.permissions['hr:salary:view']).toBe(true);
    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.id, administratorGrant));
    const salary = newId(); await ctx.db.insert(role).values({ id: salary, operatorId, name: `ZZ TEST salary ${salary}` });
    await ctx.db.insert(rolePermission).values({ id: newId(), roleId: salary, permission: 'hr:salary:view' });
    const assignment = newId(); await ctx.db.insert(roleAssignment).values({ id: assignment, accountId: p.accountId,
      roleId: salary, scopeType: 'branch', scopeId: park });
    expect((await resolve(p))?.permissions['hr:salary:view']).toBe(false);
    await ctx.db.update(roleAssignment).set({ scopeType: 'operator', scopeId: operatorId }).where(eq(roleAssignment.id, assignment));
    expect((await resolve(p))?.permissions['hr:salary:view']).toBe(true);
    await ctx.db.update(roleAssignment).set({ scopeId: foreignOperatorId }).where(eq(roleAssignment.id, assignment));
    expect((await resolve(p))?.permissions['hr:salary:view']).toBe(false);
  });
  it('rejects conflicting access-row and referenced-branch tenants without rewriting branch access', async () => {
    const p = await person();
    await ctx.db.insert(otoappUserBranchAccess).values({ id: newId(), userId: p.userId, tenantId: tenant,
      branchId: foreignAppPark, accessScope: 'selected_branches' });
    expect(await resolve(p)).toBeNull();
    const q = await person(); await ctx.db.insert(otoappUserBranchAccess).values({ id: newId(), userId: q.userId,
      tenantId: foreignTenant, branchId: foreignAppPark, accessScope: 'selected_branches' });
    expect(await resolve(q)).toBeNull();
  });
  it('never enables a tenant anchored to two core operators, and does not infer an unanchored legal entity', async () => {
    const p = await person(), extraPark = newId(), extraAppPark = newId();
    await ctx.db.insert(branch).values({ id: extraPark, operatorId: foreignOperatorId, name: 'ZZ TEST ambiguous anchor', code: `zz-test-${extraPark}` });
    await ctx.db.execute(sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
      values (${extraAppPark}, ${tenant}, 'ZZ TEST ambiguous app anchor', '', ${extraPark})`);
    expect(await resolve(p)).toBeNull();
    await ctx.db.execute(sql`delete from otoapp.branches where id = ${extraAppPark}`);
    const unplacedTenant = newId(), unplacedEntity = newId();
    await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${unplacedTenant}, 'ZZ TEST unanchored', ${`zz-test-${unplacedTenant}`})`);
    await ctx.db.execute(sql`insert into otoapp.operators (id, tenant_id, name, platform_roles_enabled)
      values (${unplacedEntity}, ${unplacedTenant}, 'ZZ TEST unanchored entity', true)`);
    expect(await resolve(await person({ entity: unplacedEntity }))).toBeNull();
  });
  it('the actual link route reconciles after complete identity/grant insertion, with one role audit across replay', async () => {
    const p = await person({ linked: false }); await grant(p.accountId, 'branch_manager', 'branch', park);
    await ctx.db.insert(otoappUserBranchAccess).values({ id: newId(), userId: p.userId, tenantId: tenant,
      branchId: appPark, accessScope: 'selected_branches' });
    const headers = { cookie: adminCookie, 'idempotency-key': newId() };
    const request = { method: 'POST' as const, url: '/admin/apps/oto_app/users', headers,
      payload: { accountId: p.accountId, externalUserId: p.userId } };
    const linked = await ctx.app.inject(request); expect(linked.statusCode).toBe(200);
    expect(await rawRole(p.userId)).toBe('manager'); expect(await roleAudits(p.userId)).toHaveLength(1);
    const replay = await ctx.app.inject(request); expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(linked.json()); expect(await roleAudits(p.userId)).toHaveLength(1);
  });
  it('the actual create route keeps legacy role when the new user has no exact legal entity rather than inferring one', async () => {
    const accountId = newId(), next = ++serial;
    await ctx.db.insert(account).values({ id: accountId, operatorId, status: 'active', phone: `+669990629${String(next).padStart(2, '0')}` });
    const answer = await ctx.app.inject({ method: 'POST', url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie, 'idempotency-key': newId() }, payload: { accountId, branchIds: [park],
        otoApp: { email: `zz-test-629-create-${accountId}@otopark.test`, fullName: 'ZZ TEST 629 unplaced create', role: 'manager' } } });
    expect(answer.statusCode).toBe(200);
    const [created] = await ctx.db.select({ id: otoappUsers.id, operatorId: otoappUsers.operatorId, role: otoappUsers.role })
      .from(otoappUsers).where(eq(otoappUsers.platformUserId, accountId));
    expect(created).toMatchObject({ operatorId: null, role: 'manager' }); expect(await roleAudits(created!.id)).toHaveLength(0);
  });
});
