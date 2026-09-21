import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, branch, operator, role, roleAssignment } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-239 — access that was taken away can be given back, and the one
 * removal that cannot be undone is refused.
 *
 * The register found `POST /accounts/:id/role-assignments` built, tested and
 * called by nobody: an account could be stripped of its last role from the
 * permissions drawer and no screen could put one back. The endpoint half was
 * sound. What was missing here is the case that proves the round trip —
 * strip, confirm the account has nothing, grant, confirm it has it again —
 * and the rule that stops the same drawer emptying the operator's own set of
 * administrators.
 */

let ctx: TestContext;
let adminCookie: string;
let operatorId: string;
let branchId: string;
let receptionId: string;
let adminId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [op] = await ctx.db.select().from(operator).limit(1);
  operatorId = op!.id;
  const [br] = await ctx.db.select().from(branch).where(eq(branch.operatorId, operatorId)).limit(1);
  branchId = br!.id;
  const [rec] = await ctx.db
    .select()
    .from(account)
    .where(eq(account.phone, RECEPTION.phone))
    .limit(1);
  receptionId = rec!.id;
  const [adm] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone)).limit(1);
  adminId = adm!.id;
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const permissionsOf = async (accountId: string) => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/accounts/${accountId}/permissions`,
    headers: { cookie: adminCookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    assignments: Array<{ id: string; roleName: string; scopeType: string; scopeId: string | null }>;
    effective: Array<{ permission: string }>;
  };
};

describe('a role can be taken away and given back (SCRUM-239)', () => {
  it('restores an account stripped of its last role', async () => {
    const before = await permissionsOf(receptionId);
    expect(before.assignments).toHaveLength(1);
    expect(before.effective.length).toBeGreaterThan(0);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/accounts/${receptionId}/role-assignments/${before.assignments[0]!.id}`,
      headers: { cookie: adminCookie },
    });
    expect(removed.statusCode).toBe(200);

    // The state the register described: an account with no access at all.
    const stripped = await permissionsOf(receptionId);
    expect(stripped.assignments).toHaveLength(0);
    expect(stripped.effective).toHaveLength(0);

    const granted = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${receptionId}/role-assignments`,
      headers: { cookie: adminCookie },
      payload: { roleName: 'reception', scopeType: 'branch', scopeId: branchId },
    });
    expect(granted.statusCode).toBe(200);

    const after = await permissionsOf(receptionId);
    expect(after.assignments).toHaveLength(1);
    expect(after.assignments[0]!.roleName).toBe('reception');
    expect(after.effective.map((e) => e.permission)).toContain('pos:member:read');
  });

  it('records the grant in the audit log', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/audit?action=role_assignment.create&limit=10',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries as Array<{ entityType: string; actorAccountId: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.entityType).toBe('role_assignment');
    expect(entries[0]!.actorAccountId).toBe(adminId);
  });

  it('refuses a grant of more than the granter holds, to itself included', async () => {
    // A branch manager holds `admin:role:assign` — over their own branch. The
    // self-grant is the one worth naming: the drawer that can add a role is
    // the drawer the manager can open on their own account.
    const [managerRole] = await ctx.db
      .select()
      .from(role)
      .where(eq(role.name, 'branch_manager'))
      .limit(1);
    const managerId = newId();
    await ctx.db.insert(account).values({
      id: managerId,
      operatorId,
      phone: normalizePhone('+66900000020')!,
      passwordHash: await hash('manager1234'),
      phoneVerifiedAt: new Date(),
      status: 'active',
    });
    await ctx.db.insert(roleAssignment).values({
      id: newId(),
      accountId: managerId,
      roleId: managerRole!.id,
      scopeType: 'branch',
      scopeId: branchId,
    });
    const managerCookie = await signInAs(ctx.app, '+66900000020', 'manager1234');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${managerId}/role-assignments`,
      headers: { cookie: managerCookie },
      payload: { roleName: 'operator_admin', scopeType: 'operator', scopeId: operatorId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ROLE_NOT_DOMINATED');
  });
});

describe("an account's phone can be corrected (SCRUM-239)", () => {
  it('changes the phone and the account signs in on the new one', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${receptionId}`,
      headers: { cookie: adminCookie },
      payload: { phone: '0900000099' },
    });
    expect(res.statusCode).toBe(200);

    // Typed the way reception types it; stored the way everything reads it.
    const [after] = await ctx.db.select().from(account).where(eq(account.id, receptionId)).limit(1);
    expect(after!.phone).toBe('+66900000099');
    await expect(signInAs(ctx.app, '+66900000099', RECEPTION.password)).resolves.toBeTruthy();

    // Put it back — later cases in this file sign in as reception.
    const back = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${receptionId}`,
      headers: { cookie: adminCookie },
      payload: { phone: RECEPTION.phone },
    });
    expect(back.statusCode).toBe(200);
  });

  it('refuses a phone another account in the operator already has', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${receptionId}`,
      headers: { cookie: adminCookie },
      payload: { phone: ADMIN.phone },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ACCOUNT_PHONE_EXISTS');
  });

  it('refuses a phone that is not one', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${receptionId}`,
      headers: { cookie: adminCookie },
      payload: { phone: 'not-a-phone' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the last administrator cannot be removed (SCRUM-239)', () => {
  it('allows the first of two operator-scoped grants to go', async () => {
    // The seeded administrator holds two: platform_admin platform-wide and
    // operator_admin over this operator. One of them may go.
    const perms = await permissionsOf(adminId);
    const platformWide = perms.assignments.find(
      (a) => a.scopeType === 'operator' && a.scopeId === null,
    );
    expect(platformWide).toBeTruthy();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/accounts/${adminId}/role-assignments/${platformWide!.id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses the last one', async () => {
    const perms = await permissionsOf(adminId);
    const operatorWide = perms.assignments.find(
      (a) => a.scopeType === 'operator' && a.scopeId === operatorId,
    );
    expect(operatorWide).toBeTruthy();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/accounts/${adminId}/role-assignments/${operatorWide!.id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LAST_OPERATOR_ADMIN');
    // And it is still there.
    expect((await permissionsOf(adminId)).assignments).toHaveLength(1);
  });

  it('refuses deactivating the only administrator', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { status: 'inactive' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LAST_OPERATOR_ADMIN');
    const [still] = await ctx.db.select().from(account).where(eq(account.id, adminId)).limit(1);
    expect(still!.status).toBe('active');
  });

  it('allows both once a second administrator exists', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { cookie: adminCookie },
      payload: {
        phone: '+66900000021',
        employeeName: 'Second Admin',
        roles: [{ roleName: 'operator_admin', scopeType: 'operator', scopeId: operatorId }],
      },
    });
    expect(created.statusCode).toBe(200);
    const secondId = created.json().id as string;
    // An INVITED account is not yet an administrator — nobody has proved they
    // can sign in — so the seeded one is still the only one.
    const refused = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { status: 'inactive' },
    });
    expect(refused.statusCode).toBe(409);

    await ctx.db.update(account).set({ status: 'active' }).where(eq(account.id, secondId));

    const allowed = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { status: 'inactive' },
    });
    expect(allowed.statusCode).toBe(200);
  });
});
