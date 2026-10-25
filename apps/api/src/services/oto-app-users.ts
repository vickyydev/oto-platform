import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  account,
  appIdentity,
  appTenantAnchors,
  branch,
  canonicalCoreBranchId,
  department,
  employee,
  findAppBranchForCore,
  mappedAppBranches,
  otoAppBranchesInstalled,
  otoappBranches,
  otoappUserBranchAccess,
  otoappUsers,
  role,
  roleAssignment,
  rolePermission,
  type OtoAppUserRole,
} from '@oto/db';
import { newId, type Permission, type ScopeType } from '@oto/shared';
import { AppError } from '../lib/errors';
import type { BranchReach } from './access-control';
import { audit } from './audit';
import { hasPermission, resolveEffectivePermissions } from './permissions';
import type { Exec } from './tx';

/**
 * The one place in this api that reads or writes the OTO App's own schema
 * (S2-17a).
 *
 * Everything else about provisioning a person — the platform account, the
 * role, the grant, the `core.app_identity` row — is the platform's own
 * business and lives in `routes/app-identities.ts`. This file writes
 * `otoapp.users`, and nothing else here may. One file to read when the app's
 * schema moves, one file to change, and a grep for `otoappUsers` that answers
 * "what do we write over there" with a complete list.
 *
 * Why the boundary is drawn as a function call rather than a call to the app.
 * The two run on one database. Provisioning has to be all-or-nothing — an
 * account with no user in the app is a tile that opens onto a refusal, and a
 * user in the app with no account is a person nobody can reach — so it is one
 * transaction, and an HTTP call to the app would be a network call held inside
 * that transaction: the transaction stays open for as long as another service
 * takes to answer, and if the half on the other side has already committed
 * there is nothing here that can take it back. The only other way to keep the
 * two sides in step is the administrator creating the same person twice, in
 * two places, and pasting an id between them — which is the thing this ticket
 * exists to remove.
 *
 * What the app owns and this does not touch: access policies, and the employee
 * record a user is matched to. Those are set inside the OTO App.
 *
 * Branch access (`otoapp.user_branch_access`) used to be on that list and no
 * longer is. Provisioning seats a new person in the branch they already work at
 * (`seatInAppBranch`, SCRUM-268), or in exactly the branches the administrator
 * chose (`seatInChosenBranches`, SCRUM-469); the same choice, made again later
 * from the account's Apps dialog, replaces their rows through
 * `setOtoAppUserBranches`. Nothing else on the platform writes that table.
 */

/** Read back from every call. Never the password. */
const SELECTION = {
  id: otoappUsers.id,
  email: otoappUsers.email,
  fullName: otoappUsers.fullName,
  role: otoappUsers.role,
  isActive: otoappUsers.isActive,
  phoneE164: otoappUsers.phoneE164,
  platformUserId: otoappUsers.platformUserId,
};

export interface OtoAppUser {
  id: string;
  email: string;
  fullName: string;
  role: OtoAppUserRole;
  isActive: boolean;
  phoneE164: string | null;
  platformUserId: string | null;
}

/** By the app's id for them, or by the platform account they are stamped with. */
export async function findOtoAppUser(
  exec: Exec,
  by: { id?: string; platformUserId?: string },
): Promise<OtoAppUser | null> {
  const where = by.id
    ? eq(otoappUsers.id, by.id)
    : by.platformUserId
      ? eq(otoappUsers.platformUserId, by.platformUserId)
      : null;
  if (!where) throw new Error('findOtoAppUser needs an id or a platformUserId');
  const [row] = await exec.select(SELECTION).from(otoappUsers).where(where).limit(1);
  return row ?? null;
}

/**
 * Stamp an existing OTO App user with the platform account they are — the
 * case where the person already works in that app and is only now being given
 * a platform account.
 *
 * Null when no row was stamped: either there is no such user, or the one
 * named already belongs to somebody else. The caller decides which answer
 * that is; this refuses to overwrite either way, because the stamp is what
 * `platformSignOn.ts` signs a person in by, and moving one would sign the
 * wrong person into that user's record.
 *
 * A row already carrying THIS account matches, so the same request arriving
 * twice is a no-op that still answers with the user.
 */
export async function linkOtoAppUser(
  exec: Exec,
  opts: { userId: string; platformAccountId: string },
): Promise<OtoAppUser | null> {
  const [row] = await exec
    .update(otoappUsers)
    /**
     * SCRUM-539: and the app's own forced password change switched off. The
     * app sets `must_change_password` on every user it creates and at every
     * admin reset, and its client sends anybody carrying it to
     * `/change-password`, which asks for the app password they hold — which a
     * person signing in from the launcher never uses. `createOtoAppUser` writes
     * false for the same reason; a linked user is the same person afterwards.
     */
    .set({ platformUserId: opts.platformAccountId, mustChangePassword: false, updatedAt: new Date() })
    .where(
      and(
        eq(otoappUsers.id, opts.userId),
        or(
          isNull(otoappUsers.platformUserId),
          eq(otoappUsers.platformUserId, opts.platformAccountId),
        ),
      ),
    )
    .returning(SELECTION);
  return row ?? null;
}

/**
 * Take the stamp off again when an account is unlinked from the app.
 *
 * Needed because withdrawing the grant is not always enough: `revokeAppAccess`
 * removes only the role this provisioning made, and somebody who also holds
 * `app:oto_app:access` through their operator-admin bundle keeps the tile. A
 * stamp left behind would still resolve them to this user, so "unlinked" would
 * be a word for something that had not happened.
 *
 * Scoped to the account being unlinked, so it can never clear a stamp that
 * belongs to somebody else. Answers whether there was one.
 */
export async function unlinkOtoAppUser(
  exec: Exec,
  opts: { platformAccountId: string },
): Promise<boolean> {
  const cleared = await exec
    .update(otoappUsers)
    .set({ platformUserId: null, updatedAt: new Date() })
    .where(eq(otoappUsers.platformUserId, opts.platformAccountId))
    .returning({ id: otoappUsers.id });
  // SCRUM-288: a session the stamp opened outlives the stamp otherwise. The
  // app keeps serving it as the same user until it expires, so "unlinked"
  // would still be signed in. The user row itself stays active: unlinking is
  // not offboarding.
  await endOtoAppSessions(
    exec,
    cleared.map((u) => u.id),
  );
  return cleared.length > 0;
}

/** What deactivating a platform account did to the OTO App user stamped with it. */
export interface OtoAppUserDeactivation {
  /** `otoapp.users.id` switched off — empty for an account with no app user. */
  userIds: string[];
  /** Live app sessions ended for them. */
  sessionsEnded: number;
}

/** What reactivating a platform account changed on its stamped app user. */
export interface OtoAppUserActivation {
  userIds: string[];
}

/**
 * Switch off the OTO App user a platform account is stamped on, and end their
 * live sessions there (SCRUM-288).
 *
 * Deactivating somebody on the platform ends their platform sessions, and a
 * launcher session in the app finds that out on its next liveness check. Two
 * doors stayed open: the app's own password login, which is off only while
 * `OTOAPP_LEGACY_LOGIN` stays unset on the deployment, and an app session that
 * is not backed by a platform session at all. `is_active = false` closes the
 * first — the app refuses an inactive user at sign-in and at every
 * `requireAuth` — and removing the session rows closes the second.
 *
 * The stamp stays: the person is still the same person, and the app keeps
 * their history under it. An explicit platform reactivation switches the same
 * app user back on through `activateOtoAppUser` (SCRUM-633).
 *
 * Runs on the caller's transaction, so it commits with the deactivation or not
 * at all. A database with no OTO App on it answers with nothing done.
 */
export async function deactivateOtoAppUser(
  exec: Exec,
  opts: { platformAccountId: string },
): Promise<OtoAppUserDeactivation> {
  if (!(await relationInstalled(exec, 'otoapp.users'))) return { userIds: [], sessionsEnded: 0 };
  const switchedOff = await exec
    .update(otoappUsers)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(otoappUsers.platformUserId, opts.platformAccountId))
    .returning({ id: otoappUsers.id });
  const userIds = switchedOff.map((u) => u.id);
  return { userIds, sessionsEnded: await endOtoAppSessions(exec, userIds) };
}

/**
 * Enable the same app user when its platform account is explicitly reactivated.
 * Identity, role, branch access and closed sessions stay as they are. Runs on
 * the caller's transaction, after the platform account update, so neither side
 * can commit alone. Databases without the app and accounts without a stamped
 * user need no provisioning here.
 */
export async function activateOtoAppUser(
  exec: Exec,
  opts: { platformAccountId: string },
): Promise<OtoAppUserActivation> {
  if (!(await relationInstalled(exec, 'otoapp.users'))) return { userIds: [] };
  const switchedOn = await exec
    .update(otoappUsers)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(eq(otoappUsers.platformUserId, opts.platformAccountId), eq(otoappUsers.isActive, false)))
    .returning({ id: otoappUsers.id });
  return { userIds: switchedOn.map((u) => u.id) };
}

export type OtoAppLifecycleEventState = 'pending' | 'delivered' | 'superseded';

/** Immutable delivery targets plus the app-owned outbox's current outcome. */
export type OtoAppLifecycleEvent = {
  id: string;
  userId: string;
  platformAccountId: string;
  state: OtoAppLifecycleEventState;
};

export interface OtoAppLifecycleUser {
  id: string;
  role: string;
  operatorId: string | null;
  platformUserId: string | null;
  isActive: boolean;
}

/** Read without a lock to discover the account, then re-read after user locking. */
export async function readOtoAppLifecycleEvent(
  exec: Exec,
  eventId: string,
  opts: { lock?: boolean } = {},
): Promise<OtoAppLifecycleEvent | null> {
  for (const name of ['otoapp.login_lifecycle_events', 'otoapp.users', 'otoapp.branches',
    'otoapp.user_branch_access', 'otoapp.operators', 'otoapp.tenants']) {
    if (!(await relationInstalled(exec, name))) {
      throw new AppError(503, 'OTOAPP_LIFECYCLE_UNAVAILABLE', 'The OTO App lifecycle queue is not available on this database');
    }
  }
  const row = (await exec.execute<OtoAppLifecycleEvent>(sql`
    select id::text as id, user_id as "userId", platform_account_id::text as "platformAccountId", state
    from otoapp.login_lifecycle_events where id=${eventId}
    ${opts.lock ? sql`for update` : sql``}
  `)).rows[0];
  if (!row) return null;
  if (!['pending', 'delivered', 'superseded'].includes(row.state)) {
    throw new AppError(503, 'OTOAPP_LIFECYCLE_UNAVAILABLE', 'The OTO App lifecycle queue has an unsupported outcome');
  }
  return row;
}

/** The caller already holds the owning operator and platform account locks. */
export async function lockOtoAppLifecycleUser(exec: Exec, userId: string): Promise<OtoAppLifecycleUser | null> {
  const [user] = await exec.select({ id: otoappUsers.id, role: otoappUsers.role, operatorId: otoappUsers.operatorId,
    platformUserId: otoappUsers.platformUserId, isActive: otoappUsers.isActive })
    .from(otoappUsers).where(eq(otoappUsers.id, userId)).for('update');
  return user ?? null;
}

/**
 * Prove the event's original identity and its user's current tenant ownership.
 * A changed stamp is handled as superseded by the caller, never as a new target.
 */
export async function otoAppLifecycleUserIsOperators(
  exec: Exec,
  opts: { operatorId: string; accountId: string; user: OtoAppLifecycleUser },
): Promise<boolean> {
  const [identity] = await exec.select({ id: appIdentity.id }).from(appIdentity)
    .where(and(eq(appIdentity.app, 'oto_app'), eq(appIdentity.accountId, opts.accountId), eq(appIdentity.externalUserId, opts.user.id)))
    .limit(1);
  if (!identity) return false;
  const place = (await placeAppUsers(exec, [opts.user])).get(opts.user.id);
  if (!place?.tenantId) return false;
  const anchors = (await appTenantAnchors(exec)).get(place.tenantId);
  if (anchors?.length !== 1 || anchors[0] !== opts.operatorId) return false;
  if (opts.user.operatorId) {
    const entity = (await exec.execute<{ tenant_id: string }>(sql`
      select tenant_id::text as tenant_id from otoapp.operators where id::text=${opts.user.operatorId}
    `)).rows[0];
    if (entity?.tenant_id !== place.tenantId) return false;
  }
  return true;
}

/** Settle only the locked pending event; the app pump owns attempt counting. */
export async function settleOtoAppLifecycleEvent(
  exec: Exec,
  eventId: string,
  state: Exclude<OtoAppLifecycleEventState, 'pending'>,
): Promise<void> {
  const settled = await exec.execute<{ id: string }>(sql`
    update otoapp.login_lifecycle_events set state=${state}, settled_at=now(), last_error_code=null
    where id=${eventId} and state='pending' returning id::text as id
  `);
  if (settled.rows.length !== 1) {
    throw new AppError(409, 'OTOAPP_LIFECYCLE_CHANGED', 'That lifecycle event changed before it could be settled');
  }
}

/**
 * Remove the OTO App's session rows for these users.
 *
 * The app keeps its sessions in `otoapp.session` (express-session through
 * `connect-pg-simple`), one jsonb `sess` per row, and passport writes the
 * signed-in user's id at `sess.passport.user`. A row gone is a request that
 * arrives unauthenticated, which the app answers with 401.
 */
async function endOtoAppSessions(exec: Exec, userIds: readonly string[]): Promise<number> {
  if (userIds.length === 0) return 0;
  if (!(await relationInstalled(exec, 'otoapp.session'))) return 0;
  const ended = await exec.execute<{ sid: string }>(
    sql`delete from otoapp.session where sess -> 'passport' ->> 'user' in (${sql.join(
      userIds.map((id) => sql`${id}`),
      sql`, `,
    )}) returning sid`,
  );
  return ended.rows.length;
}

/**
 * Is this relation on the database? `to_regclass` answers null rather than
 * raising, because a missing relation inside a transaction would abort the
 * operation it is part of.
 */
async function relationInstalled(exec: Exec, name: string): Promise<boolean> {
  const res = await exec.execute<{ reg: string | null }>(
    sql`select to_regclass(${name})::text as reg`,
  );
  return Boolean(res.rows[0]?.reg);
}

export type MappedOtoAppRole = 'admin' | 'manager' | 'staff';

/** Assignment provenance whose owning scope has already been validated. */
export interface OtoAppRoleGrant {
  roleName: string;
  isSystem: boolean;
  roleOperatorId: string | null;
  scopeType: ScopeType;
  scopeId: string | null;
}

/**
 * The approved mapping, after validating ownership of each assignment target.
 * A custom role may share a system role's name; that does not make it that role.
 * The literal mapping deliberately gives platform_admin alone the staff fallback.
 */
export function roleFor(grants: readonly OtoAppRoleGrant[]): MappedOtoAppRole {
  let mapped: MappedOtoAppRole = 'staff';
  for (const grant of grants) {
    if (!grant.isSystem || grant.roleOperatorId !== null || grant.scopeType === 'record') continue;
    if (grant.scopeType !== 'operator' && grant.scopeId === null) continue;
    if (grant.roleName === 'operator_admin' && grant.scopeType === 'operator') return 'admin';
    if (grant.roleName === 'branch_manager') mapped = 'manager';
  }
  return mapped;
}

/** Enabled-only exchange context. operatorId names the app's legal entity. */
export interface OtoAppRoleContext {
  platformRolesEnabled: true;
  userId: string;
  operatorId: string;
  tenantId: string;
  role: MappedOtoAppRole;
  permissions: { 'hr:salary:view': boolean };
}

export interface OtoAppRoleContextOptions {
  /** core.operator.id, never otoapp.operators.id. */
  operatorId: string;
  accountId: string;
  /** The copy job supplies the tenant it independently anchored. */
  tenantId?: string;
}

/**
 * Read the opt-in context through an exact completed identity link. No first
 * tenant or legal entity is guessed, and no app user is created by a read.
 * An old app schema without the flag is the same as a flag that is off.
 */
export async function resolveOtoAppRoleContext(
  exec: Exec,
  opts: OtoAppRoleContextOptions,
): Promise<OtoAppRoleContext | null> {
  for (const name of ['otoapp.users', 'otoapp.operators', 'otoapp.branches', 'otoapp.user_branch_access']) {
    if (!(await relationInstalled(exec, name))) return null;
  }
  const [linked] = await exec
    .select({
      id: otoappUsers.id,
      operatorId: otoappUsers.operatorId,
      isActive: otoappUsers.isActive,
      status: account.status,
    })
    .from(account)
    .innerJoin(appIdentity, and(eq(appIdentity.accountId, account.id), eq(appIdentity.app, 'oto_app')))
    .innerJoin(otoappUsers, and(eq(otoappUsers.id, appIdentity.externalUserId), eq(otoappUsers.platformUserId, account.id)))
    .where(and(eq(account.id, opts.accountId), eq(account.operatorId, opts.operatorId)))
    .limit(1);
  if (!linked?.operatorId || !linked.isActive || !['active', 'invited'].includes(linked.status)) return null;

  // JSON projection does not name the new column in SQL, so an API instance
  // can coexist with an app whose own migrator has not added it yet.
  const entity = (await exec.execute<{ id: string; tenant_id: string; enabled: string | null }>(sql`
    select o.id::text as id, o.tenant_id::text as tenant_id,
      to_jsonb(o)->>'platform_roles_enabled' as enabled
    from otoapp.operators o where o.id::text = ${linked.operatorId}
  `)).rows[0];
  if (!entity || entity.enabled !== 'true' || (opts.tenantId !== undefined && opts.tenantId !== entity.tenant_id)) return null;
  const anchors = (await appTenantAnchors(exec)).get(entity.tenant_id);
  if (anchors?.length !== 1 || anchors[0] !== opts.operatorId) return null;

  // A legal entity plus its uniquely anchored tenant can place an advisor
  // whose branch reach comes from an access policy. Existing access rows,
  // when present, must all agree; they are never changed by this mapping.
  const access = await exec.select({ tenantId: otoappUserBranchAccess.tenantId,
    branchId: otoappUserBranchAccess.branchId, accessScope: otoappUserBranchAccess.accessScope })
    .from(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, linked.id));
  const appBranchIds = access.flatMap(row => row.branchId ? [row.branchId] : []);
  const appBranches = new Map((appBranchIds.length
    ? await exec.select({ id: otoappBranches.id, tenantId: otoappBranches.tenantId }).from(otoappBranches)
      .where(inArray(otoappBranches.id, appBranchIds)) : []).map(row => [row.id, row.tenantId]));
  if (access.some(row => row.tenantId !== entity.tenant_id
    || (row.accessScope === 'selected_branches' && (!row.branchId || appBranches.get(row.branchId) !== entity.tenant_id))
    || (row.accessScope === 'all_branches' && row.branchId !== null))) return null;

  const ownBranches = new Set((await exec.select({ id: branch.id }).from(branch)
    .where(and(eq(branch.operatorId, opts.operatorId), isNull(branch.archivedAt)))).map(row => row.id));
  const ownDepartments = new Set((await exec.select({ id: department.id, branchId: department.branchId }).from(department)
    .where(eq(department.operatorId, opts.operatorId)))
    .filter(row => row.branchId === null || ownBranches.has(row.branchId)).map(row => row.id));
  const assignments = await exec.select({ roleName: role.name, isSystem: role.isSystem, roleOperatorId: role.operatorId,
    scopeType: roleAssignment.scopeType, scopeId: roleAssignment.scopeId, salaryPermission: rolePermission.permission })
    .from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId))
    .leftJoin(rolePermission, and(eq(rolePermission.roleId, role.id), eq(rolePermission.permission, 'hr:salary:view')))
    .where(and(eq(roleAssignment.accountId, opts.accountId), isNull(roleAssignment.archivedAt),
      or(isNull(role.operatorId), eq(role.operatorId, opts.operatorId))));
  const grants = assignments.filter(grant => {
    switch (grant.scopeType) {
      case 'operator': return grant.scopeId === null || grant.scopeId === opts.operatorId;
      case 'branch': return grant.scopeId !== null && ownBranches.has(grant.scopeId);
      case 'department': return grant.scopeId !== null && ownDepartments.has(grant.scopeId);
      case 'record': return false;
    }
  });
  return { platformRolesEnabled: true, userId: linked.id, operatorId: entity.id, tenantId: entity.tenant_id,
    role: roleFor(grants), permissions: { 'hr:salary:view': grants.some(grant =>
      grant.scopeType === 'operator' && grant.salaryPermission === 'hr:salary:view') } };
}

/**
 * Reconcile inside the caller's transaction, after its identity and grants
 * exist. Exchange calls this after consuming/checking the handoff; the copy
 * calls it inside its operator transaction. Advisors retain their identity
 * marker and receive only the effective session role, as Q14 requires.
 */
export async function reconcileOtoAppRole(
  exec: Exec,
  opts: OtoAppRoleContextOptions & { actorAccountId?: string | null; requestId?: string },
): Promise<OtoAppRoleContext | null> {
  const initial = await resolveOtoAppRoleContext(exec, opts);
  if (!initial) return null;
  const locked = (await exec.execute<{ role: string }>(sql`
    select role from otoapp.users where id = ${initial.userId}
      and platform_user_id = ${opts.accountId} for update
  `)).rows[0];
  if (!locked) return null;
  const context = await resolveOtoAppRoleContext(exec, opts);
  if (!context || context.userId !== initial.userId) return null;
  if (locked.role === 'advisor' || locked.role === context.role) return context;
  const [updated] = await exec.update(otoappUsers).set({ role: context.role, updatedAt: new Date() })
    .where(and(eq(otoappUsers.id, context.userId), eq(otoappUsers.platformUserId, opts.accountId), sql`${otoappUsers.role} = ${locked.role}`))
    .returning({ id: otoappUsers.id });
  if (!updated) return null;
  await audit.record(exec, { actorAccountId: opts.actorAccountId ?? null, operatorId: opts.operatorId,
    action: 'app_identity.role_sync', entityType: 'otoapp.user', entityId: context.userId,
    before: { role: locked.role }, after: { role: context.role, platformAccountId: opts.accountId,
      appOperatorId: context.operatorId, tenantId: context.tenantId }, requestId: opts.requestId });
  return context;
}

/** How the OTO App's branch was found for a person being provisioned. */
export type OtoAppBranchMatch = 'core_branch_id' | 'name';

/**
 * WHICH platform branch was taken as theirs, which is the whole question
 * (SCRUM-268, decision 3). Three candidates, in this order:
 *
 * - `request` — the provisioning named a branch outright. The most explicit
 *   thing in the request wins.
 * - `employee` — their employee record says where they work. This is what the
 *   platform already knows about THIS person, so it beats where the
 *   administrator happens to be standing.
 * - `session` — the branch the provisioning was done at, for somebody the
 *   platform does not place anywhere yet: an account created by this very
 *   request has an employee record with no branch on it. Last, never first: a
 *   session branch is a value the caller sets for themselves (SCRUM-264), so
 *   it must not override what the platform knows.
 * - `operator_wide` — they administer the whole operator, so they are given
 *   every mapped branch rather than one.
 * - `chosen` — the administrator picked the branches the grant covers
 *   (SCRUM-469). Not a candidate in the order above: a choice replaces the
 *   whole question, see `seatInChosenBranches`.
 */
export type OtoAppSeatSource = 'request' | 'employee' | 'session' | 'operator_wide' | 'chosen';

/**
 * Why they were seated in none. Each is a different thing to fix, so they are
 * separate values rather than one "failed":
 *
 * - `no_platform_branch` — nothing said where this person works: no branch in
 *   the request, none on their employee record, and no branch on the
 *   provisioning session either.
 * - `no_app_branch` — the platform knows the branch and the OTO App has no row
 *   carrying its id and none of that name.
 * - `ambiguous_name` — more than one OTO App branch carries that name, and
 *   guessing between two parks is worse than seating them in neither.
 * - `no_mapped_branch` — they administer the whole operator, and not one of its
 *   branches is joined to a row in the app yet. `POST /branches/oto-app/reconcile`
 *   is what fixes that.
 */
export type OtoAppBranchUnplaced =
  | 'no_platform_branch'
  | 'no_app_branch'
  | 'ambiguous_name'
  | 'no_mapped_branch';

/**
 * Where a provisioned person landed in the OTO App's own branch list — and,
 * when nowhere, why (SCRUM-268).
 *
 * Returned rather than thrown, deliberately. A person who has an account, a
 * tile and a user in the app but no branch is worse off silently than loudly:
 * the app answers every screen with nothing and looks broken. So provisioning
 * still succeeds, and this travels out to the caller so the tile can say the
 * person needs their branch access set inside the OTO App.
 */
export interface OtoAppBranchPlacement {
  /** `otoapp.branches.id` they were seated in — the first, when more than one. */
  branchId: string | null;
  branchName: string | null;
  /** Every app branch written for them. One, or every mapped branch. */
  branchIds: string[];
  matchedBy: OtoAppBranchMatch | null;
  seatedFrom: OtoAppSeatSource | null;
  unplacedReason: OtoAppBranchUnplaced | null;
}

export interface ProvisionedOtoAppUser extends OtoAppUser {
  branch: OtoAppBranchPlacement;
}

/**
 * Seat a newly provisioned person in the OTO App branch they work at
 * (SCRUM-268, decision 3).
 *
 * **The boundary this crosses, deliberately.** `otoapp.user_branch_access` is
 * the app's own record of who may see which park, and the platform used to
 * leave it alone on principle — with the result that everybody provisioned from
 * the launcher landed in NO branch at either park and somebody had to open the
 * OTO App and set it by hand. "Which branch do they land in" has to have an
 * answer, so one row is written here. Changing anybody's branch access
 * afterwards is still the app's own screen.
 *
 * **Which branch is theirs** is the whole question, and `OtoAppSeatSource`
 * above is the order it is answered in: the branch the request named, then
 * their employee record, then the branch the provisioning was done at.
 * Somebody who administers the whole operator is given every mapped branch
 * instead of one.
 *
 * **Which APP row that platform branch is** goes through
 * `findAppBranchForCore`: `core_branch_id` first, which survives a rename on
 * either side, and the trimmed case-folded name for a deployment whose rows
 * have not been reconciled yet. Two rows of that name is `ambiguous_name` and
 * not a coin toss — a person seated in the wrong park's data is invisible
 * afterwards, and one seated nowhere is stated in the answer.
 *
 * **What is still not checked, said plainly.** The app's own tenant is not
 * matched against the platform's operator: `otoapp.operators` is a different
 * table from `core.operator` with different ids and no correspondence between
 * them. What bounds the name step instead is the platform branch, which is
 * loaded inside this account's operator before anything is looked up.
 *
 * Runs inside the provisioning transaction, so a failure anywhere after it
 * takes this row with the user it belongs to.
 */
async function seatInAppBranch(
  exec: Exec,
  opts: {
    userId: string;
    platformAccountId: string;
    /** A branch the provisioning named outright. */
    branchId?: string | null;
    /** The branch the provisioning was done at. Last resort — see `OtoAppSeatSource`. */
    sessionBranchId?: string | null;
  },
): Promise<OtoAppBranchPlacement> {
  const unplaced = (reason: OtoAppBranchUnplaced): OtoAppBranchPlacement => ({
    branchId: null,
    branchName: null,
    branchIds: [],
    matchedBy: null,
    seatedFrom: null,
    unplacedReason: reason,
  });

  const [holder] = await exec
    .select({ operatorId: account.operatorId, employeeBranchId: employee.branchId })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.id, opts.platformAccountId))
    .limit(1);
  // Provisioning loaded this account before it got here, so there is one.
  const operatorId = holder!.operatorId;

  /**
   * Somebody who administers the whole operator belongs at every park, and the
   * app has to be told so in rows — its `getUserWithBranchAccess` reads this
   * table and a user with none sees nothing.
   *
   * Asked as "holds the one permission that MEANS operator-wide, at operator
   * scope", never as "holds anything operator-wide" and no longer as "holds a
   * role called operator_admin" (SCRUM-318). The app-access grant this same
   * provisioning writes is itself operator-scoped, so the loosest reading would
   * make every person provisioned into the app an administrator of every park —
   * which is the door the branch isolation register found open at `atBranch`.
   */
  if (await administersWholeOperator(exec, opts.platformAccountId, operatorId)) {
    const mapped = await mappedAppBranches(exec, operatorId);
    if (mapped.length === 0) return unplaced('no_mapped_branch');
    for (const row of mapped) {
      await exec.insert(otoappUserBranchAccess).values({
        id: newId(),
        tenantId: row.tenantId,
        userId: opts.userId,
        branchId: row.id,
        accessScope: 'selected_branches',
      });
    }
    return {
      branchId: mapped[0]!.id,
      branchName: mapped[0]!.name,
      branchIds: mapped.map((r) => r.id),
      matchedBy: 'core_branch_id',
      seatedFrom: 'operator_wide',
      unplacedReason: null,
    };
  }

  /** The platform branch that is theirs, and where that answer came from. */
  const candidates: Array<{ id: string; from: OtoAppSeatSource }> = [
    ...(opts.branchId ? [{ id: opts.branchId, from: 'request' as const }] : []),
    ...(holder!.employeeBranchId ? [{ id: holder!.employeeBranchId, from: 'employee' as const }] : []),
    ...(opts.sessionBranchId ? [{ id: opts.sessionBranchId, from: 'session' as const }] : []),
  ];
  const chosen = candidates[0];
  if (!chosen) return unplaced('no_platform_branch');

  // Inside this operator, always: a branch id in a request carries no tenancy
  // of its own (SCRUM-248), and seating somebody in another operator's park is
  // the one outcome worse than seating them nowhere.
  const [seat] = await exec
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.id, chosen.id), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!seat) return unplaced('no_platform_branch');

  const found = await findAppBranchForCore(exec, {
    operatorId,
    coreBranchId: seat.id,
    name: seat.name,
  });
  if (found === 'ambiguous') return unplaced('ambiguous_name');
  if (!found) return unplaced('no_app_branch');

  await exec.insert(otoappUserBranchAccess).values({
    id: newId(),
    // The app requires a tenant on this row and takes the session's tenant
    // from the first one a user has, so it comes off the branch they are being
    // seated in rather than from anywhere on the platform.
    tenantId: found.tenantId,
    userId: opts.userId,
    branchId: found.id,
    accessScope: 'selected_branches',
  });
  return {
    branchId: found.id,
    branchName: found.name,
    branchIds: [found.id],
    matchedBy: found.matchedBy,
    seatedFrom: chosen.from,
    unplacedReason: null,
  };
}

/**
 * Seat a person in exactly the platform branches an administrator chose for
 * their OTO App access (SCRUM-469), instead of the one branch
 * `seatInAppBranch` would pick.
 *
 * All or nothing, and refused rather than half done: a choice that lands
 * somewhere other than chosen is worse than an answer saying why it could not.
 * Every chosen branch must be a live branch of this account's operator
 * (`BRANCH_NOT_FOUND`), every one must have its row in the OTO App
 * (`OTO_APP_BRANCH_UNMAPPED`, which `POST /branches/oto-app/reconcile` fixes),
 * and all of them must sit in one park group (`OTO_APP_BRANCH_TENANTS`): the
 * app takes a session's tenant from the FIRST access row a user has, so rows in
 * two tenants would put them in whichever came back first.
 *
 * Rows are `selected_branches`, one per branch, never `all_branches`: that
 * scope would also hand them Head Office and everything else in the park group
 * (see `mappedAppBranches`), which is wider than the platform decides.
 */
async function seatInChosenBranches(
  exec: Exec,
  opts: { userId: string; platformAccountId: string; branchIds: readonly string[] },
): Promise<OtoAppBranchPlacement> {
  const wanted = [...new Set(opts.branchIds)];
  if (wanted.length === 0) {
    throw new AppError(400, 'BAD_REQUEST', 'Choose at least one branch, or all branches');
  }
  const [holder] = await exec
    .select({ operatorId: account.operatorId })
    .from(account)
    .where(eq(account.id, opts.platformAccountId))
    .limit(1);
  // Provisioning loaded this account before it got here, so there is one.
  const operatorId = holder!.operatorId;

  // Inside this operator, always (SCRUM-248): a branch id carries no tenancy
  // of its own, and an archived park is not somewhere to send anybody.
  const platformRows = await exec
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(
      and(
        inArray(branch.id, wanted),
        eq(branch.operatorId, operatorId),
        isNull(branch.archivedAt),
      ),
    );
  const byId = new Map(platformRows.map((b) => [b.id, b]));
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new AppError(
      400,
      'BRANCH_NOT_FOUND',
      'One of the chosen branches is not an open branch of this operator',
      { branchIds: missing },
    );
  }

  const seats: Array<{ id: string; name: string; tenantId: string; matchedBy: OtoAppBranchMatch }> =
    [];
  for (const id of wanted) {
    const platform = byId.get(id)!;
    const found = await findAppBranchForCore(exec, {
      operatorId,
      coreBranchId: platform.id,
      name: platform.name,
    });
    if (!found || found === 'ambiguous') {
      throw new AppError(
        409,
        'OTO_APP_BRANCH_UNMAPPED',
        `${platform.name} has no single matching branch in the OTO App yet, so nobody can be given access to it there. Reconcile the branch lists first.`,
        { branchId: platform.id, reason: found === 'ambiguous' ? 'ambiguous_name' : 'no_app_branch' },
      );
    }
    seats.push(found);
  }
  if (new Set(seats.map((s) => s.tenantId)).size > 1) {
    throw new AppError(
      409,
      'OTO_APP_BRANCH_TENANTS',
      'The chosen branches belong to different park groups in the OTO App, and one person can only be in one',
    );
  }

  for (const seat of seats) {
    await exec.insert(otoappUserBranchAccess).values({
      id: newId(),
      tenantId: seat.tenantId,
      userId: opts.userId,
      branchId: seat.id,
      accessScope: 'selected_branches',
    });
  }
  return {
    branchId: seats[0]!.id,
    branchName: seats[0]!.name,
    branchIds: seats.map((s) => s.id),
    matchedBy: seats[0]!.matchedBy,
    seatedFrom: 'chosen',
    unplacedReason: null,
  };
}

/**
 * An advisor's branches are not this table's to say: the app resolves them
 * from the advisor's access policy (`getUserWithBranchAccess`, intake 01 §3),
 * and rows written here would only ever be read as a fallback nobody chose.
 */
function refuseAdvisor(role: string): void {
  if (role === 'advisor') {
    throw new AppError(
      409,
      'OTO_APP_ADVISOR_BRANCHES',
      "An advisor's branches come from their access policy in the OTO App and are set there",
    );
  }
}

/**
 * Change which branches of the OTO App a provisioned person covers
 * (SCRUM-469): the branch choice made again, later, from the same dialog.
 *
 * Replaces every branch-access row the user has, including any set inside the
 * app since: the administrator is looking at the current answer when they
 * change it, and a merge would leave rows nobody chose. `null` is "all
 * branches", and means exactly what it means at provisioning: the seat
 * `seatInAppBranch` gives (their own branch, or every mapped branch for
 * somebody who administers the whole operator).
 *
 * Runs on the caller's transaction, beside the grant's own scope change.
 */
export async function setOtoAppUserBranches(
  exec: Exec,
  opts: {
    userId: string;
    platformAccountId: string;
    branchIds: readonly string[] | null;
    sessionBranchId?: string | null;
  },
): Promise<OtoAppBranchPlacement> {
  const [user] = await exec
    .select({ role: otoappUsers.role })
    .from(otoappUsers)
    .where(eq(otoappUsers.id, opts.userId))
    .limit(1);
  if (!user) throw new AppError(404, 'NOT_FOUND', 'The OTO App has no user for this account');
  refuseAdvisor(user.role);
  await exec.delete(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, opts.userId));
  return opts.branchIds === null
    ? seatInAppBranch(exec, {
        userId: opts.userId,
        platformAccountId: opts.platformAccountId,
        sessionBranchId: opts.sessionBranchId ?? null,
      })
    : seatInChosenBranches(exec, {
        userId: opts.userId,
        platformAccountId: opts.platformAccountId,
        branchIds: opts.branchIds,
      });
}

/** Where a linked user sits in the OTO App's branch list, as the Apps dialog shows it. */
export interface OtoAppUserBranches {
  /** An `all_branches` row: every branch of their park group, set inside the app. */
  allBranches: boolean;
  branches: UnlinkedOtoAppUserBranch[];
}

/**
 * One user's branch access, for the dialog's "in the OTO App" line
 * (SCRUM-469). Null on a database with no OTO App on it.
 */
export async function readOtoAppUserBranches(
  exec: Exec,
  userId: string,
): Promise<OtoAppUserBranches | null> {
  if (!(await otoAppBranchesInstalled(exec))) return null;
  const rows = await exec
    .select({
      branchId: otoappUserBranchAccess.branchId,
      accessScope: otoappUserBranchAccess.accessScope,
    })
    .from(otoappUserBranchAccess)
    .where(eq(otoappUserBranchAccess.userId, userId));
  const ids = rows.flatMap((r) => (r.branchId ? [r.branchId] : []));
  const named = ids.length
    ? await exec
        .select({
          id: otoappBranches.id,
          name: otoappBranches.name,
          coreBranchId: otoappBranches.coreBranchId,
        })
        .from(otoappBranches)
        .where(inArray(otoappBranches.id, ids))
    : [];
  return {
    allBranches: rows.some((r) => r.accessScope === 'all_branches'),
    branches: named
      .map((b) => ({
        id: b.id,
        name: b.name,
        platformBranchId: b.coreBranchId ? canonicalCoreBranchId(b.coreBranchId) : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The permission that says someone's reach is the whole operator rather than
 * one park. `platform_admin` and `operator_admin` carry it because they carry
 * the whole vocabulary; no branch-scoped bundle does.
 */
const OPERATOR_WIDE_PERMISSION: Permission = 'admin:operator:all';

/**
 * Does this account administer the whole operator?
 *
 * Asked as a PERMISSION held at operator scope, through the same resolver every
 * guard uses — never as a role NAME (SCRUM-318). Role names are unique per
 * operator and nothing reserves the system ones, so an operator that mints its
 * own role literally called `operator_admin` — a plausible name for "manages
 * our admin paperwork" — was read here as administering the estate, and
 * everybody holding it was seated in every park of the OTO App. The same
 * reasoning is already written down at `OPERATOR_ADMIN_PERMISSION` in
 * `access-control.ts`: an operator may define a role of its own carrying any
 * name, so a name is not an authority.
 *
 * `hasPermission` with an operator-only target is exactly "held at operator
 * scope, covering this operator": a branch-, department- or record-scoped grant
 * covers nothing when the target names no branch, department or record.
 *
 * Resolved on `exec` and not on the pool, so a role granted earlier in THIS
 * transaction — provisioning creates the account and its grants in one — is
 * visible to the question.
 */
async function administersWholeOperator(
  exec: Exec,
  accountId: string,
  operatorId: string,
): Promise<boolean> {
  const effective = await resolveEffectivePermissions(exec, accountId);
  return hasPermission(effective, OPERATOR_WIDE_PERMISSION, { operatorId });
}

export interface CreateOtoAppUserInput {
  /** `core.account.id`, written straight into `platform_user_id`. */
  platformAccountId: string;
  email: string;
  fullName: string;
  role: OtoAppUserRole;
  /**
   * `otoapp.operators.id`, and null unless the caller knows one. It is a
   * foreign key into the app's own operator table, which is a different table
   * from `core.operator` with different ids, and no correspondence between
   * the two has been established — so passing the platform's operator id here
   * would be a foreign-key violation dressed up as a tenant.
   */
  operatorId?: string | null;
  phoneE164?: string | null;
  /**
   * The platform branch this person is being provisioned at, when the request
   * named one, and the branch the provisioning session is standing at. Which
   * of the two — and where their employee record comes in between them — is
   * `OtoAppSeatSource`.
   */
  branchId?: string | null;
  sessionBranchId?: string | null;
  /**
   * The branches the administrator chose for this person's access (SCRUM-469).
   * When given, exactly these are written and `branchId` / `sessionBranchId`
   * play no part; when absent, the seat is `seatInAppBranch`'s, as before.
   */
  branchIds?: readonly string[] | null;
}

/**
 * Create the OTO App's user for a platform account, stamped with it.
 *
 * Refuses rather than duplicating when the app already has someone on that
 * email or phone: both are unique there, so the alternative is a constraint
 * violation surfacing as a 500, and the honest answer is "that person is
 * already in the OTO App — link them".
 *
 * Seats them in an OTO App branch where one can be resolved, and says on the
 * answer when it could not (SCRUM-268) — `branch`.
 */
export async function createOtoAppUser(
  exec: Exec,
  input: CreateOtoAppUserInput,
): Promise<ProvisionedOtoAppUser> {
  // Lower-cased because the app resolves a user by `email.toLowerCase()` (its
  // local sign-in and the employee match in `getUserWithBranchAccess`), so a
  // capitalised address stored here is one those lookups never find.
  const email = input.email.trim().toLowerCase();
  const phoneE164 = input.phoneE164?.trim() || null;
  const chosen = input.branchIds ?? null;
  if (chosen) refuseAdvisor(input.role);

  const clash = await findClash(exec, email, phoneE164);
  if (clash) {
    throw new AppError(
      409,
      'OTO_APP_USER_EXISTS',
      clash.email === email
        ? `The OTO App already has a user on ${email}. Link that user (${clash.id}) instead of creating a second one.`
        : `The OTO App already has a user on that phone number. Link that user (${clash.id}) instead of creating a second one.`,
      { externalUserId: clash.id },
    );
  }

  const [row] = await exec
    .insert(otoappUsers)
    .values({
      id: newId(),
      email,
      password: unusablePassword(),
      fullName: input.fullName.trim(),
      role: input.role,
      operatorId: input.operatorId ?? null,
      isActive: true,
      /**
       * False on purpose, and the one column here that is not simply copied
       * from the request. The app's default is true and its client sends any
       * authenticated user carrying it to `/change-password`, which asks for
       * the password they hold today — and a person provisioned from the
       * launcher was never given one. Leaving the default would land them on
       * a form they cannot complete, on their first visit, every visit.
       */
      mustChangePassword: false,
      phoneNumber: phoneE164,
      phoneE164,
      platformUserId: input.platformAccountId,
    })
    .returning(SELECTION);
  // The insert names every NOT NULL column and nothing filtered the row out.
  const user = row!;
  return {
    ...user,
    branch: chosen
      ? await seatInChosenBranches(exec, {
          userId: user.id,
          platformAccountId: input.platformAccountId,
          branchIds: chosen,
        })
      : await seatInAppBranch(exec, {
          userId: user.id,
          platformAccountId: input.platformAccountId,
          branchId: input.branchId ?? null,
          sessionBranchId: input.sessionBranchId ?? null,
        }),
  };
}

/** The two columns that are unique in the app's own schema. */
async function findClash(
  exec: Exec,
  email: string,
  phoneE164: string | null,
): Promise<OtoAppUser | null> {
  const [row] = await exec
    .select(SELECTION)
    .from(otoappUsers)
    .where(
      phoneE164
        ? or(eq(otoappUsers.email, email), eq(otoappUsers.phoneE164, phoneE164))
        : eq(otoappUsers.email, email),
    )
    .limit(1);
  return row ?? null;
}

/**
 * A password nothing can ever be, for a person who has none here.
 *
 * `otoapp.users.password` is NOT NULL, and someone provisioned from the
 * launcher signs in through the hand-off rather than through that app's form.
 * The app compares with `comparePasswords` in its `server/auth.ts`: it splits
 * the stored value on "." and `timingSafeEqual`s a 64-byte scrypt output
 * against the first half, so a value that is not 64 bytes of hex and a salt
 * makes the comparison throw instead of answering false. What is stored is
 * therefore well formed and random — no supplied password produces it, and
 * nothing about a restart or a redeploy makes it guessable.
 *
 * This is not a placeholder waiting for a real hash, and nothing should
 * "fix" it by writing one. A local password for these people would be a
 * second way in: one that survives being deactivated on the platform, and
 * that signing out everywhere would never reach. That is the same reason the
 * app's own local login is off (`legacyLoginEnabled`).
 */
function unusablePassword(): string {
  return `${randomBytes(64).toString('hex')}.${randomBytes(16).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// The app's users with no suite sign-in (S2-17b round 1)
// ---------------------------------------------------------------------------

/** An app branch an unlinked user is seated in, as the Console shows it. */
export interface UnlinkedOtoAppUserBranch {
  /** `otoapp.branches.id`. */
  id: string;
  name: string;
  /** The platform branch it is joined to, when it is. */
  platformBranchId: string | null;
}

/** One user of the OTO App that no platform account is stamped on. */
export interface UnlinkedOtoAppUser {
  /** `otoapp.users.id` — what the existing Link action claims. */
  id: string;
  fullName: string;
  email: string;
  phoneE164: string | null;
  /**
   * The app's word, as stored. Usually one of `OTO_APP_USER_ROLES`, but the
   * column is plain text in the app's database (the six-value list is the
   * app's TypeScript, not a check), so restored data or a hand edit can carry
   * any other word — and one such row must show as it is, not take the whole
   * list down.
   */
  role: string;
  isActive: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** Their `all_branches` access: every branch of their park group. */
  allBranches: boolean;
  branches: UnlinkedOtoAppUserBranch[];
}

export interface UnlinkedOtoAppUsers {
  /** False on a database with no OTO App on it. */
  installed: boolean;
  /**
   * False when not one of this operator's branches is joined to an app row
   * yet: no app park group can then be said to be this operator's, so nobody
   * is listed (`POST /branches/oto-app/reconcile` is what joins them).
   */
  anchored: boolean;
  users: UnlinkedOtoAppUser[];
}

/**
 * The OTO App's users that nobody can reach from the launcher — the list
 * beside the existing Link action (S2-17b round 1, plan section 4 and Q6).
 *
 * With legacy password sign-in off, a user made in the app's own Users screen
 * (`POST /api/users`, or "enable login" on an employee) carries a password
 * nothing accepts and no `platform_user_id`, so they have no way in at all.
 * The fix is not a second way to create people: it is showing an
 * administrator who they are, so the existing claim-by-id link
 * (`POST /admin/apps/oto_app/users` with `externalUserId`) can be pointed at
 * them. The app's own screens are unchanged (Q5).
 *
 * **Whose users these are.** The app's park group (its tenant) is not a
 * platform operator, and the two id spaces share nothing, so the answer is
 * read the way the rest of the seam reads it: the park groups this operator is
 * anchored in are the tenants of the app rows joined to its branches. A user
 * belongs to a park group by the app's own rule (`managedUserTenant` in the
 * app's routes): every branch-access row in one tenant and on that tenant's
 * branches, an operator admin's operator in the same tenant, and a user with no
 * access row only in a database that holds a single tenant. A user the app
 * itself cannot place is not listed — showing them would be guessing whose
 * person they are.
 *
 * **Who sees whom.** The caller's reach on `admin:account:read`. Reaching the
 * whole operator, they see everybody in its park groups. Reaching some
 * branches, they see the users seated in an app branch joined to one of those
 * — never somebody whose access is the whole park group or nothing, because
 * that person is not any one branch's to see.
 *
 * Read only: linking stays the existing route, with its own permission
 * (`admin:role:assign`), dominance check and audit row.
 */
export async function listUnlinkedOtoAppUsers(
  exec: Exec,
  opts: { operatorId: string; reach: BranchReach },
): Promise<UnlinkedOtoAppUsers> {
  if (!(await otoAppBranchesInstalled(exec))) return { installed: false, anchored: false, users: [] };

  const mapped = await mappedAppBranches(exec, opts.operatorId);
  const ourTenants = new Set(mapped.map((m) => m.tenantId));
  if (ourTenants.size === 0) return { installed: true, anchored: false, users: [] };

  const users = await exec
    .select({
      id: otoappUsers.id,
      fullName: otoappUsers.fullName,
      email: otoappUsers.email,
      phoneE164: otoappUsers.phoneE164,
      role: otoappUsers.role,
      isActive: otoappUsers.isActive,
      operatorId: otoappUsers.operatorId,
      createdAt: otoappUsers.createdAt,
    })
    .from(otoappUsers)
    .where(isNull(otoappUsers.platformUserId))
    .orderBy(asc(otoappUsers.fullName), asc(otoappUsers.id));
  if (users.length === 0) return { installed: true, anchored: true, users: [] };

  const placed = await placeAppUsers(exec, users);

  const held = opts.reach.kind === 'operator' ? null : new Set(opts.reach.branchIds);
  const listed: UnlinkedOtoAppUser[] = [];
  for (const u of users) {
    const place = placed.get(u.id)!;
    if (!place.tenantId || !ourTenants.has(place.tenantId)) continue;
    if (held) {
      const reachable =
        !place.allBranches &&
        place.branches.some((b) => b.platformBranchId !== null && held.has(b.platformBranchId));
      if (!reachable) continue;
    }
    listed.push({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      phoneE164: u.phoneE164,
      role: u.role,
      isActive: u.isActive,
      createdAt: u.createdAt.toISOString(),
      allBranches: place.allBranches,
      branches: place.branches,
    });
  }
  return { installed: true, anchored: true, users: listed };
}

/** Where one app user belongs, by the app's own rule. */
interface AppUserPlace {
  /** Their park group, or null when the app itself cannot place them. */
  tenantId: string | null;
  allBranches: boolean;
  branches: UnlinkedOtoAppUserBranch[];
}

/**
 * The app's `managedUserTenant`, over every user named at once: every
 * branch-access row in one tenant and on that tenant's branches, an operator
 * admin's operator in the same tenant, and a user with no access row only in a
 * database that holds a single tenant. Shared by the unlinked list and by Link,
 * so the two can never disagree about whose person somebody is.
 */
async function placeAppUsers(
  exec: Exec,
  users: ReadonlyArray<{ id: string; role: string; operatorId: string | null }>,
): Promise<Map<string, AppUserPlace>> {
  const access = users.length
    ? await exec
        .select({
          userId: otoappUserBranchAccess.userId,
          tenantId: otoappUserBranchAccess.tenantId,
          branchId: otoappUserBranchAccess.branchId,
          accessScope: otoappUserBranchAccess.accessScope,
        })
        .from(otoappUserBranchAccess)
        .where(
          inArray(
            otoappUserBranchAccess.userId,
            users.map((u) => u.id),
          ),
        )
    : [];
  const appBranches = new Map(
    (
      await exec
        .select({
          id: otoappBranches.id,
          tenantId: otoappBranches.tenantId,
          name: otoappBranches.name,
          coreBranchId: otoappBranches.coreBranchId,
        })
        .from(otoappBranches)
    ).map((b) => [b.id, b]),
  );
  // The app's own operator table — a different table from `core.operator`,
  // which no platform id names. Read only to apply the app's rule that an
  // operator admin's operator is in their own park group.
  const appOperators = new Map(
    (
      await exec.execute<{ id: string; tenant_id: string }>(
        sql`select id::text as id, tenant_id::text as tenant_id from otoapp.operators`,
      )
    ).rows.map((r) => [r.id, r.tenant_id]),
  );
  const tenants = (
    await exec.execute<{ id: string }>(sql`select id::text as id from otoapp.tenants limit 2`)
  ).rows;
  const onlyTenant = tenants.length === 1 ? tenants[0]!.id : null;

  const accessOf = new Map<string, typeof access>();
  for (const row of access) accessOf.set(row.userId, [...(accessOf.get(row.userId) ?? []), row]);

  const tenantOf = (u: (typeof users)[number]): string | null => {
    const rows = accessOf.get(u.id) ?? [];
    if (rows.length === 0) return onlyTenant;
    const tenantId = rows[0]!.tenantId;
    if (!rows.every((r) => r.tenantId === tenantId)) return null;
    for (const r of rows) {
      if (r.branchId && appBranches.get(r.branchId)?.tenantId !== tenantId) return null;
    }
    if (u.role === 'operator_admin' && u.operatorId && appOperators.get(u.operatorId) !== tenantId) {
      return null;
    }
    return tenantId;
  };

  return new Map(
    users.map((u) => {
      const rows = accessOf.get(u.id) ?? [];
      return [
        u.id,
        {
          tenantId: tenantOf(u),
          allBranches: rows.some((r) => r.accessScope === 'all_branches'),
          branches: rows.flatMap((r) => {
            const b = r.branchId ? appBranches.get(r.branchId) : undefined;
            return b
              ? [
                  {
                    id: b.id,
                    name: b.name,
                    platformBranchId: b.coreBranchId ? canonicalCoreBranchId(b.coreBranchId) : null,
                  },
                ]
              : [];
          }),
        },
      ];
    }),
  );
}

/**
 * May this operator claim this app user? (S2-17b round 2, round 1's standing
 * pin 1.) Only a user the unlinked list could show it: one the app places in a
 * park group this operator is anchored in. Link used to stamp ANY unstamped
 * user by typed id, whatever park group they were in, and the account then
 * opened that park group's data from the launcher; the list was fenced and the
 * claim was not.
 *
 * Asked whatever the user's stamp: whether they are already somebody's is the
 * link's own question, answered after this one.
 */
export async function otoAppUserIsOperators(
  exec: Exec,
  opts: { operatorId: string; userId: string },
): Promise<boolean> {
  if (!(await otoAppBranchesInstalled(exec))) return false;
  const ourTenants = new Set((await mappedAppBranches(exec, opts.operatorId)).map((m) => m.tenantId));
  if (ourTenants.size === 0) return false;
  const [user] = await exec
    .select({ id: otoappUsers.id, role: otoappUsers.role, operatorId: otoappUsers.operatorId })
    .from(otoappUsers)
    .where(eq(otoappUsers.id, opts.userId))
    .limit(1);
  if (!user) return false;
  const place = (await placeAppUsers(exec, [user])).get(user.id)!;
  return place.tenantId !== null && ourTenants.has(place.tenantId);
}
