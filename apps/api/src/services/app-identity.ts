import { and, eq } from 'drizzle-orm';
import { role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import { appAccessPermission, type HandoffApp } from './handoff';
import type { Exec } from './tx';

/**
 * Granting access to one of the suite's apps (S2-17a).
 *
 * A permission reaches an account only through a role (CLAUDE.md §3), so
 * "grant `app:<app>:access`" means an operator-owned role carrying exactly
 * that one permission, assigned at operator scope. A role of its own rather
 * than the permission added to `reception` or `branch_manager`: who may open
 * the OTO App is not a property of the job someone does at the till, and the
 * two lists move for different reasons and at different times.
 *
 * The role is created the first time an operator provisions someone into an
 * app and reused after that. It is not a system role: `platform:sync` owns
 * the seeded bundles and would withdraw a permission it did not put there.
 */

/** One role per operator per app, named so it reads as what it is. */
export function appAccessRoleName(app: HandoffApp): string {
  return `app_access_${app}`;
}

/** Find or create the operator's access role for one app; returns its id. */
export async function ensureAppAccessRole(
  tx: Exec,
  operatorId: string,
  app: HandoffApp,
): Promise<string> {
  const name = appAccessRoleName(app);
  const id = newId();
  // Insert first and fall back to a read, rather than read-then-insert: two
  // administrators provisioning into the same app at the same moment would
  // otherwise both find nothing and both insert.
  const [inserted] = await tx
    .insert(role)
    .values({
      id,
      operatorId,
      name,
      description: `Opens the ${app} app`,
      isSystem: false,
    })
    .onConflictDoNothing({ target: [role.operatorId, role.name] })
    .returning({ id: role.id });
  if (inserted) {
    await tx
      .insert(rolePermission)
      .values({ id: newId(), roleId: inserted.id, permission: appAccessPermission(app) });
    return inserted.id;
  }
  const [existing] = await tx
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.operatorId, operatorId), eq(role.name, name)))
    .limit(1);
  // The conflict target is the unique index the insert just collided with,
  // so the row is there.
  return existing!.id;
}

/**
 * Assign the access role at operator scope. Answers whether it had to be
 * granted, so the audit row records what actually changed rather than what
 * was asked for.
 */
export async function grantAppAccess(
  tx: Exec,
  accountId: string,
  roleId: string,
  operatorId: string,
): Promise<boolean> {
  const [existing] = await tx
    .select({ id: roleAssignment.id })
    .from(roleAssignment)
    .where(
      and(
        eq(roleAssignment.accountId, accountId),
        eq(roleAssignment.roleId, roleId),
        eq(roleAssignment.scopeType, 'operator'),
        eq(roleAssignment.scopeId, operatorId),
      ),
    )
    .limit(1);
  if (existing) return false;
  await tx.insert(roleAssignment).values({
    id: newId(),
    accountId,
    roleId,
    scopeType: 'operator',
    scopeId: operatorId,
  });
  return true;
}

/**
 * Withdraw the access role when an identity is unlinked, so a tile cannot
 * stay open on an account with no identity behind it.
 *
 * Only the grant this service made is withdrawn. An operator administrator
 * holds `app:<app>:access` through their own bundle and keeps it: that access
 * was never a consequence of the link, and stripping it here would be this
 * route quietly editing a role it does not own.
 */
export async function revokeAppAccess(
  tx: Exec,
  accountId: string,
  operatorId: string,
  app: HandoffApp,
): Promise<boolean> {
  const [roleRow] = await tx
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.operatorId, operatorId), eq(role.name, appAccessRoleName(app))))
    .limit(1);
  if (!roleRow) return false;
  const removed = await tx
    .delete(roleAssignment)
    .where(and(eq(roleAssignment.accountId, accountId), eq(roleAssignment.roleId, roleRow.id)))
    .returning({ id: roleAssignment.id });
  return removed.length > 0;
}
