import { and, eq, isNull, or } from 'drizzle-orm';
import {
  account,
  branch,
  department,
  role,
  roleAssignment,
  rolePermission,
  type Db,
} from '@oto/db';
import type { Permission, ScopeType } from '@oto/shared';
import { AppError } from '../lib/errors';
import {
  hasPermission,
  isPlatformWide,
  resolveEffectivePermissions,
  type EffectivePermission,
  type ScopeTarget,
} from './permissions';

/**
 * Administrative access control (S2-01a).
 *
 * Sprint 1 checked only that the caller held `admin:role:assign`, so any
 * holder — a branch manager included — could grant `platform_admin` platform
 * wide, reset the operator admin's password, or act on an account belonging
 * to another operator. Three rules close that:
 *
 *  1. **Tenancy.** The target account must belong to the caller's operator.
 *     Anything else is 404, never 403: the existence of another operator's
 *     account is not ours to disclose.
 *  2. **Scope ownership.** A branch or department named in a scope must
 *     belong to the caller's operator, and only a platform-wide caller may
 *     use the platform-wide scope (operator scope with a null id).
 *  3. **Dominance.** You cannot grant what you do not hold. The caller must
 *     hold *every* permission the role carries, at a scope that covers the
 *     scope being granted. The same rule guards destructive account actions:
 *     to deactivate an account, change its phone, issue it a temporary
 *     password or read its permissions, the caller must dominate the roles
 *     that account already holds.
 *
 * SCRUM-239 adds a fourth, which is not about privilege but about a door that
 * only opens one way:
 *
 *  4. **No last-administrator lockout.** Access is handed out by an account
 *     holding `admin:role:assign` at operator scope. Take the last one of
 *     those away — by removing its assignment, or by deactivating the account
 *     that holds it — and nobody inside the operator can grant it back: a
 *     branch manager holds the same permission but only over their own
 *     branch, and `loadTargetAccount` puts every other operator's
 *     administrator behind a 404. So the removal is refused while it is still
 *     a sentence on a screen, instead of being discovered by the person it
 *     locked out.
 */

export const accessErrors = {
  accountNotFound: () =>
    new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found'),
  roleNotDominated: (permission: Permission) =>
    new AppError(
      403,
      'ROLE_NOT_DOMINATED',
      `You cannot grant or act on a role that carries a permission you do not hold yourself (${permission})`,
    ),
  scopeNotOwned: (message = 'That scope does not belong to your operator') =>
    new AppError(403, 'SCOPE_NOT_OWNED', message),
  unknownRole: (name: string) =>
    new AppError(400, 'UNKNOWN_ROLE', `Unknown role ${name}`),
  lastOperatorAdmin: () =>
    new AppError(
      409,
      'LAST_OPERATOR_ADMIN',
      'This is the only active account that can hand out access for this operator. Give somebody else an operator-wide administrator role first, then try again.',
    ),
};

export interface AssignmentScope {
  scopeType: ScopeType;
  scopeId: string | null;
}

/** The permission-check target an assignment's scope resolves to. */
export function scopeToTarget(operatorId: string, scope: AssignmentScope): ScopeTarget {
  switch (scope.scopeType) {
    case 'branch':
      return { operatorId, branchId: scope.scopeId ?? undefined };
    case 'department':
      return { operatorId, departmentId: scope.scopeId ?? undefined };
    case 'record':
      return { operatorId, recordId: scope.scopeId ?? undefined };
    case 'operator':
      return { operatorId };
  }
}

/** Load a role by name, visible to this operator (its own, or a system role). */
export async function loadRoleForOperator(db: Db, operatorId: string, roleName: string) {
  const [row] = await db
    .select()
    .from(role)
    .where(
      and(
        eq(role.name, roleName),
        or(isNull(role.operatorId), eq(role.operatorId, operatorId)),
      ),
    )
    .limit(1);
  if (!row) throw accessErrors.unknownRole(roleName);
  return row;
}

/** Rule 1 — the target account exists inside the caller's operator. */
export async function loadTargetAccount(db: Db, operatorId: string, accountId: string) {
  const [row] = await db.select().from(account).where(eq(account.id, accountId)).limit(1);
  if (!row || row.operatorId !== operatorId) throw accessErrors.accountNotFound();
  return row;
}

/** Rule 2 — the scope is one the caller's operator owns and may use. */
export async function assertScopeOwned(
  db: Db,
  callerEffective: EffectivePermission[],
  operatorId: string,
  scope: AssignmentScope,
): Promise<void> {
  if (scope.scopeType === 'operator') {
    if (scope.scopeId === null) {
      // Platform-wide. Only a platform-wide caller may hand that out.
      if (!isPlatformWide(callerEffective)) {
        throw accessErrors.scopeNotOwned(
          'Only a platform-wide administrator can assign a platform-wide scope',
        );
      }
      return;
    }
    if (scope.scopeId !== operatorId) throw accessErrors.scopeNotOwned();
    return;
  }

  if (!scope.scopeId) {
    throw accessErrors.scopeNotOwned(`A ${scope.scopeType} scope needs the ${scope.scopeType} id`);
  }

  if (scope.scopeType === 'branch') {
    const [row] = await db.select().from(branch).where(eq(branch.id, scope.scopeId)).limit(1);
    if (!row || row.operatorId !== operatorId) throw accessErrors.scopeNotOwned();
    return;
  }
  if (scope.scopeType === 'department') {
    const [row] = await db.select().from(department).where(eq(department.id, scope.scopeId)).limit(1);
    if (!row || row.operatorId !== operatorId) throw accessErrors.scopeNotOwned();
    return;
  }
  // 'record' — the record's own route validates it; the id is scoped by the
  // permission check that follows.
}

/** Rule 3 — the caller holds every permission this role carries, at a covering scope. */
export async function assertRoleDominated(
  db: Db,
  callerEffective: EffectivePermission[],
  operatorId: string,
  roleId: string,
  scope: AssignmentScope,
): Promise<void> {
  const granted = await db
    .select({ permission: rolePermission.permission })
    .from(rolePermission)
    .where(eq(rolePermission.roleId, roleId));

  const target = scopeToTarget(operatorId, scope);
  const platformWide = scope.scopeType === 'operator' && scope.scopeId === null;

  for (const g of granted) {
    const permission = g.permission as Permission;
    if (platformWide) {
      // Platform-wide grants need the caller to hold the permission platform
      // wide too, not merely inside one operator.
      const held = callerEffective.some(
        (e) => e.permission === permission && e.scopeType === 'operator' && e.scopeId === null,
      );
      if (!held) throw accessErrors.roleNotDominated(permission);
      continue;
    }
    if (!hasPermission(callerEffective, permission, target)) {
      throw accessErrors.roleNotDominated(permission);
    }
  }
}

/**
 * Rule 3 applied to an existing account: the caller must dominate every role
 * that account already holds before deactivating it, changing its phone,
 * issuing a temporary password or reading its permissions.
 */
export async function assertDominatesAccount(
  db: Db,
  callerEffective: EffectivePermission[],
  operatorId: string,
  targetAccountId: string,
): Promise<void> {
  const rows = await db
    .select({
      permission: rolePermission.permission,
      scopeType: roleAssignment.scopeType,
      scopeId: roleAssignment.scopeId,
    })
    .from(roleAssignment)
    .innerJoin(rolePermission, eq(rolePermission.roleId, roleAssignment.roleId))
    .where(eq(roleAssignment.accountId, targetAccountId));

  for (const r of rows) {
    const permission = r.permission as Permission;
    const scope: AssignmentScope = { scopeType: r.scopeType, scopeId: r.scopeId };
    if (scope.scopeType === 'operator' && scope.scopeId === null) {
      const held = callerEffective.some(
        (e) => e.permission === permission && e.scopeType === 'operator' && e.scopeId === null,
      );
      if (!held) throw accessErrors.roleNotDominated(permission);
      continue;
    }
    if (!hasPermission(callerEffective, permission, scopeToTarget(operatorId, scope))) {
      throw accessErrors.roleNotDominated(permission);
    }
  }
}

/**
 * The permission that decides who counts as an administrator for rule 4.
 *
 * Not `admin:account:create` — making accounts is no use if you cannot put a
 * role on one — and not the `operator_admin` role by name, because an
 * operator may define a role of its own that carries the same grant.
 */
export const OPERATOR_ADMIN_PERMISSION: Permission = 'admin:role:assign';

interface AdminGrant {
  assignmentId: string;
  accountId: string;
}

/**
 * Every live grant that can hand out access across this operator: an
 * operator-scoped assignment (this operator's id, or platform-wide) of a role
 * carrying `admin:role:assign`, held by an account that can sign in today.
 *
 * `status = 'active'` and nothing else. An `invited` account may never be
 * claimed — a mistyped phone on the invitation is exactly how an operator
 * ends up with an administrator who does not exist — so it is not counted as
 * one; an `inactive` one cannot sign in at all.
 */
async function operatorAdminGrants(db: Db, operatorId: string): Promise<AdminGrant[]> {
  const rows = await db
    .select({ assignmentId: roleAssignment.id, accountId: roleAssignment.accountId })
    .from(roleAssignment)
    .innerJoin(account, eq(account.id, roleAssignment.accountId))
    .innerJoin(rolePermission, eq(rolePermission.roleId, roleAssignment.roleId))
    .where(
      and(
        eq(account.operatorId, operatorId),
        eq(account.status, 'active'),
        eq(roleAssignment.scopeType, 'operator'),
        or(isNull(roleAssignment.scopeId), eq(roleAssignment.scopeId, operatorId)),
        eq(rolePermission.permission, OPERATOR_ADMIN_PERMISSION),
      ),
    );
  // One row per permission on the role, so the same assignment arrives many
  // times over; the count that matters is of assignments, not of rows.
  const seen = new Map<string, AdminGrant>();
  for (const r of rows) seen.set(r.assignmentId, r);
  return [...seen.values()];
}

/**
 * Rule 4 — refuse a change that would leave the operator with no active
 * account able to grant access.
 *
 * `losing.assignmentId` is the assignment about to be deleted; without it the
 * whole account is about to be deactivated and every grant it holds goes with
 * it. A change that takes none of these grants away is not this rule's
 * business and returns at once.
 */
export async function assertNotLastOperatorAdmin(
  db: Db,
  operatorId: string,
  losing: { accountId: string; assignmentId?: string },
): Promise<void> {
  const grants = await operatorAdminGrants(db, operatorId);
  const surviving = grants.filter((g) =>
    losing.assignmentId ? g.assignmentId !== losing.assignmentId : g.accountId !== losing.accountId,
  );
  if (surviving.length === grants.length) return;
  if (surviving.length === 0) throw accessErrors.lastOperatorAdmin();
}

/** Convenience for routes: caller's own effective permissions. */
export async function callerPermissions(db: Db, accountId: string): Promise<EffectivePermission[]> {
  return resolveEffectivePermissions(db, accountId);
}
