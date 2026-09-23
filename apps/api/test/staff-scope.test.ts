import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, role, roleAssignment, rolePermission } from '@oto/db';
import { newId, ROLE_BUNDLES, normalizePhone, type Permission } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-330 — who counts as staff at EVERY branch.
 *
 * `atBranch` (apps/api/src/lib/staff-scope.ts) is the one answer to "who works
 * at this park", and three places take it: the fleet's station picker, the
 * cache a box holds so it can check a password with no internet, and the
 * account reads and writes that decide whether a manager may touch somebody.
 * Its third half — an operator-wide administrator belongs at every park —
 * asked who was an administrator by ROLE NAME.
 *
 * Role names are unique per operator and nothing reserves the system ones, so
 * an operator minting its own role called `operator_admin` — a plausible name
 * for "manages our admin paperwork" — handed everybody holding it the whole
 * estate. It is now asked as the permission that MEANS operator-wide,
 * `admin:operator:all`, which is the answer SCRUM-318 already gave to the same
 * question in the OTO App's seating.
 *
 * Driven through `GET /branches/:branchId/staff`, the real route the station
 * editor's picker calls, on the seed's two parks and two operators: a rule
 * about branches proves nothing where only one branch is open, and a rule
 * about operators proves nothing with only one tenant.
 */

let ctx: TestContext;

let otoOperatorId: string;
let florestaId: string;
let chalongId: string;
let adminCookie: string;
/** Khun Dao, who manages Robinson Chalong and nothing wider. */
let chalongManagerCookie: string;

/** Som, at Central Floresta: reception, one branch-scoped grant. */
let receptionAccountId: string;
/** Khun Anan, the operator's real administrator. */
let adminAccountId: string;
/** The other tenant's administrator, operator-wide inside its own operator. */
let foreignAdminAccountId: string;
/** Nobody's employee, holding only a custom role that carries the permission. */
let deputyAccountId: string;

const accountIdByPhone = async (phone: string): Promise<string> => {
  const [row] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, normalizePhone(phone)!))
    .limit(1);
  return row!.id;
};

/** An operator's OWN role — `operator_id` set, `is_system` false. */
const mintOperatorRole = async (name: string, permissions: Permission[]): Promise<string> => {
  const id = newId();
  await ctx.db.insert(role).values({ id, operatorId: otoOperatorId, name, isSystem: false });
  for (const permission of permissions) {
    await ctx.db.insert(rolePermission).values({ id: newId(), roleId: id, permission });
  }
  return id;
};

const grantAtOperator = async (accountId: string, roleId: string): Promise<void> => {
  await ctx.db.insert(roleAssignment).values({
    id: newId(),
    accountId,
    roleId,
    scopeType: 'operator',
    scopeId: otoOperatorId,
  });
};

/** The staff list of one park, as the picker reads it. */
const staffAt = async (branchId: string): Promise<{ ids: string[]; body: string }> => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/branches/${branchId}/staff`,
    headers: { cookie: adminCookie },
  });
  expect(res.statusCode).toBe(200);
  const staff = res.json().staff as Array<{ accountId: string }>;
  return { ids: staff.map((s) => s.accountId), body: res.body };
};

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  otoOperatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  florestaId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);

  /**
   * Seated on her own park deliberately: sign-in puts every session on the
   * operator's first branch whatever the grants say (SCRUM-263, another
   * slice's), so Chalong's manager lands at Floresta and is refused before any
   * of this is reached.
   */
  chalongManagerCookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  const moved = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/branch',
    headers: { cookie: chalongManagerCookie },
    payload: { branchId: chalongId },
  });
  expect(moved.statusCode).toBe(200);

  adminAccountId = await accountIdByPhone(ADMIN.phone);
  receptionAccountId = await accountIdByPhone(RECEPTION.phone);
  foreignAdminAccountId = await accountIdByPhone(SECOND_OPERATOR_ADMIN.phone);

  /**
   * The impostor: the operator's own role, named exactly like the platform's
   * administrator bundle and carrying a counter bundle — no wider a grant than
   * the reception account already holds at its own park. Asserted rather than
   * assumed, because the whole case rests on this role NOT being an
   * administrator by anything but its name.
   */
  expect(ROLE_BUNDLES.reception).not.toContain('admin:operator:all');
  const impostor = await mintOperatorRole('operator_admin', ROLE_BUNDLES.reception);
  await grantAtOperator(receptionAccountId, impostor);

  /**
   * And the deliberate grant, which must go on working: an operator's own role
   * that carries the operator-wide permission. Somebody covering the estate
   * for a week is a role the operator may define, and the permission existing
   * is what makes that sayable — so this account has no employee record and no
   * branch-scoped grant, and nothing but the permission can put it at a park.
   */
  const deputy = await mintOperatorRole('estate_cover', [
    'admin:operator:all',
    'admin:station:read',
  ]);
  deputyAccountId = newId();
  await ctx.db.insert(account).values({
    id: deputyAccountId,
    operatorId: otoOperatorId,
    phone: '+66900000330',
    status: 'active',
  });
  await grantAtOperator(deputyAccountId, deputy);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-330 — an operator-wide administrator is a permission, not a role name', () => {
  it("keeps a role merely NAMED operator_admin off the other park's staff list", async () => {
    const chalong = await staffAt(chalongId);
    expect(chalong.ids).not.toContain(receptionAccountId);
    // Not merely absent from the id list — absent from the payload, which is
    // where the name and phone number of somebody at the other park would be.
    expect(chalong.body).not.toContain(RECEPTION.phone.replace('+', ''));
  });

  it('leaves that account staff at the park it actually works at', async () => {
    // Som's employee record says Central Floresta, and the first half of the
    // rule is unaffected by any of this. A fix that dropped her from her own
    // park's picker would be the worse defect.
    const floresta = await staffAt(florestaId);
    expect(floresta.ids).toContain(receptionAccountId);
  });

  it('still puts the real operator administrator at both parks', async () => {
    expect((await staffAt(florestaId)).ids).toContain(adminAccountId);
    expect((await staffAt(chalongId)).ids).toContain(adminAccountId);
  });

  it("honours an operator's own role that CARRIES the operator-wide permission", async () => {
    // The point of deciding this by permission rather than by name: an
    // operator may define an administrator bundle of its own, and this account
    // has nothing else — no employee row, no branch grant — to place it.
    expect((await staffAt(florestaId)).ids).toContain(deputyAccountId);
    expect((await staffAt(chalongId)).ids).toContain(deputyAccountId);
  });

  it("never lets another operator's administrator onto either list", async () => {
    // Their grant is operator-wide inside THEIR operator, which the clause
    // reads against `account.operator_id`; the tenancy filter on the query is
    // the second fence, and neither is allowed to be the only one.
    for (const branchId of [florestaId, chalongId]) {
      const list = await staffAt(branchId);
      expect(list.ids).not.toContain(foreignAdminAccountId);
      expect(list.body).not.toContain(SECOND_OPERATOR_ADMIN.phone.replace('+', ''));
    }
  });

  it("keeps that account off the other park's manager's account list too", async () => {
    /**
     * The second caller of the rule, and the one the ticket is really about:
     * `GET /accounts` reaches through `atBranch` as well, and the same by-id
     * predicate fences the account WRITES — a temporary password, a phone
     * change, an end to somebody's working day. A name putting Som on
     * Chalong's list put her within Khun Dao's reach, at a park she has never
     * worked at.
     */
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/accounts',
      headers: { cookie: chalongManagerCookie },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().accounts as Array<{ id: string }>).map((a) => a.id);
    expect(ids).not.toContain(receptionAccountId);
    expect(res.body).not.toContain(RECEPTION.phone.replace('+', ''));

    // And the administrator above her is still on it, which is the half of the
    // rule that exists so a manager can see who runs the estate.
    expect(ids).toContain(adminAccountId);
  });

  it('counts the impostor role as the ordinary operator-scoped grant it is', async () => {
    // Belt and braces on the fixture: the grant really is operator-scoped, so
    // the case above is the clause being asked the question, not an assignment
    // that never reached it.
    const [held] = await ctx.db
      .select({ scopeType: roleAssignment.scopeType, scopeId: roleAssignment.scopeId })
      .from(roleAssignment)
      .innerJoin(role, eq(role.id, roleAssignment.roleId))
      .where(
        and(
          eq(roleAssignment.accountId, receptionAccountId),
          eq(role.name, 'operator_admin'),
          eq(role.operatorId, otoOperatorId),
        ),
      )
      .limit(1);
    expect(held).toEqual({ scopeType: 'operator', scopeId: otoOperatorId });
  });
});
