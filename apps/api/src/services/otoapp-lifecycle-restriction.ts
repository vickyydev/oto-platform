import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { account, role, roleAssignment, rolePermission, type Db } from '@oto/db';
import { AppError } from '../lib/errors';
import { assertNotLastOperatorAdmin } from './access-control';
import { appAccessRoleName, ensureAppAccessRole, grantAppAccess, type AppAccessBranches } from './app-identity';
import { audit } from './audit';
import { invalidateAllSessions } from './auth';
import { appAccessPermission } from './handoff';
import {
  lockOtoAppLifecycleUser, otoAppLifecycleUserIsOperators, readOtoAppLifecycleEvent, settleOtoAppLifecycleEvent,
} from './oto-app-users';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * SCRUM-769 — a leaver's suite access outside the OTO App, ended the night
 * after their last working day.
 *
 * The OTO App no longer switches a leaver's login off that night: it keeps it
 * on and limits it to My pay, so the person can read their payslips while the
 * final salary is settled. The launcher is their only road there (the app's
 * own password sign-in is off on deployments), so the platform account must
 * stay on. Everything else it reaches must not: the till, the booth, the
 * console and the inbox hold members', children's and sales data, and the
 * tester's rule is that offboarding ends access to internal data.
 *
 * So the app queues a `restrict` event when it puts a login in pay only (its
 * migration 0044, beside 0031's switch-off), and this consumes it:
 *
 *  - the account stays `active`;
 *  - its platform sessions and staff tokens end (`invalidateAllSessions`), so
 *    a till or launcher session open now closes;
 *  - every role assignment it holds is withdrawn but the operator's OTO App
 *    access role (`app_access_oto_app`), the launcher's road to My pay. When
 *    that road came only through a role withdrawn here (an administrator's
 *    bundle carries `app:oto_app:access`), the access role is granted at the
 *    same operator or branch scope, so the road stays exactly as wide as it
 *    was;
 *  - the withdrawn assignments are written into the audit row, so a platform
 *    administrator can give them back (Onboard Again's start tells them to;
 *    the app never grants anything here, as it never reactivates).
 *
 * Like the switch-off, the event is the durable receipt: a replay answers from
 * it, a login back to full access before delivery (Onboard Again's start, a
 * last working day moved later) has already superseded it in the app, and a
 * changed stamp or a login no longer in pay only settles it as superseded.
 * The last operator administrator is never stripped (the switch-off's guard).
 */

export interface ConsumedLifecycleRestriction {
  ok: true;
  eventId: string;
  state: 'delivered' | 'superseded';
  replayed: boolean;
}

/** The app's word for a login limited to My pay (`users.access_mode`, its migration 0043). */
const PAY_ONLY = 'pay_only';

/**
 * The login's access mode, through a JSON projection so an API instance can
 * run beside an app whose migrator has not added the column yet (no column:
 * every login has full access, so nothing is restricted).
 */
async function accessModeOf(exec: Exec, userId: string): Promise<string> {
  const row = (await exec.execute<{ mode: string | null }>(sql`
    select to_jsonb(u)->>'access_mode' as mode from otoapp.users u where u.id = ${userId}
  `)).rows[0];
  return row?.mode ?? 'full';
}

interface HeldAssignment {
  id: string;
  roleId: string;
  roleName: string;
  roleOperatorId: string | null;
  scopeType: string;
  scopeId: string | null;
  opensOtoApp: boolean;
}

/** Every assignment the account holds (withdrawn ones are history, left alone), with whether its role opens the OTO App. */
async function heldAssignments(exec: Exec, accountId: string): Promise<HeldAssignment[]> {
  const rows = await exec
    .select({
      id: roleAssignment.id,
      roleId: roleAssignment.roleId,
      roleName: role.name,
      roleOperatorId: role.operatorId,
      scopeType: roleAssignment.scopeType,
      scopeId: roleAssignment.scopeId,
    })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(and(eq(roleAssignment.accountId, accountId), isNull(roleAssignment.archivedAt)));
  if (rows.length === 0) return [];
  const opening = new Set(
    (await exec
      .select({ roleId: rolePermission.roleId })
      .from(rolePermission)
      .where(and(
        inArray(rolePermission.roleId, [...new Set(rows.map((r) => r.roleId))]),
        eq(rolePermission.permission, appAccessPermission('oto_app')),
      ))).map((r) => r.roleId),
  );
  return rows.map((r) => ({ ...r, opensOtoApp: opening.has(r.roleId) }));
}

/** Whether this assignment is the operator's OTO App access role: the one road kept. */
function isOtoAppRoad(held: HeldAssignment, operatorId: string): boolean {
  return held.roleOperatorId === operatorId && held.roleName === appAccessRoleName('oto_app');
}

/**
 * Which of these accounts still reach more than the OTO App's road to My pay,
 * as far as the platform can tell (the night's Failures case,
 * `otoapp-jobs.ts`): the newest restriction the app asked for has not been
 * delivered here (still waiting, or never asked), or it has and a role beyond
 * the OTO App's access role was given back since.
 */
export async function accountsBeyondMyPay(exec: Exec, operatorId: string, accountIds: readonly string[]): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const held = await exec
    .select({ accountId: roleAssignment.accountId, roleName: role.name, roleOperatorId: role.operatorId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(and(inArray(roleAssignment.accountId, [...accountIds]), isNull(roleAssignment.archivedAt)));
  const beyond = new Set(held
    .filter((r) => !(r.roleOperatorId === operatorId && r.roleName === appAccessRoleName('oto_app')))
    .map((r) => r.accountId));
  const restricted = await restrictionDelivered(exec, accountIds);
  return new Set(accountIds.filter((id) => !restricted.has(id) || beyond.has(id)));
}

/** The accounts whose newest restriction event (the app's 0044) the platform has had; none on an app without the queue. */
async function restrictionDelivered(exec: Exec, accountIds: readonly string[]): Promise<Set<string>> {
  const [queue] = (await exec.execute<{ readable: boolean | null }>(sql`
    select has_table_privilege(to_regclass('otoapp.login_lifecycle_events')::oid, 'SELECT') as readable
  `)).rows;
  if (!queue?.readable) return new Set();
  const newest = (await exec.execute<{ id: string; state: string }>(sql`
    select distinct on (e.platform_account_id) e.platform_account_id::text as id, e.state
    from otoapp.login_lifecycle_events e
    where e.platform_account_id in (${sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `)})
      and to_jsonb(e)->>'kind' = 'restrict'
    order by e.platform_account_id, e.created_at desc, e.id desc
  `)).rows;
  return new Set(newest.filter((row) => row.state === 'delivered').map((row) => row.id));
}

/**
 * Consume an app-owned restriction event (SCRUM-769) using its immutable
 * identity targets, as `consumeLifecycleDeactivation` consumes a switch-off:
 * the service key names only the owning operator, nobody supplies an account
 * or an acting administrator, and the event is the replay receipt.
 */
export async function consumeLifecycleRestriction(
  db: Db,
  ctx: OpContext,
  input: { operatorId: string; eventId: string },
): Promise<ConsumedLifecycleRestriction> {
  const missing = () => new AppError(404, 'NOT_FOUND', 'That lifecycle event is not available for this operator');
  const snapshot = await readOtoAppLifecycleEvent(db, input.eventId);
  if (!snapshot || snapshot.kind !== 'restrict') throw missing();

  return withTx(db, { ...ctx, operatorId: input.operatorId, actorAccountId: null, branchId: null },
    'app_identity.lifecycle_restriction', async (tx) => {
      // The switch-off's order: operator, platform account, app user, then its event.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.operatorId}, 633))`);
      const [target] = await tx.select({ id: account.id, operatorId: account.operatorId, status: account.status })
        .from(account).where(and(eq(account.id, snapshot.platformAccountId), eq(account.operatorId, input.operatorId))).for('no key update');
      if (!target) throw missing();
      const user = await lockOtoAppLifecycleUser(tx, snapshot.userId);
      if (!user) throw missing();
      const event = await readOtoAppLifecycleEvent(tx, input.eventId, { lock: true });
      if (!event || event.kind !== 'restrict' || event.userId !== snapshot.userId
        || event.platformAccountId !== snapshot.platformAccountId) throw missing();
      if (!(await otoAppLifecycleUserIsOperators(tx, { operatorId: input.operatorId, accountId: target.id, user }))) throw missing();

      if (event.state !== 'pending') {
        return { ok: true as const, eventId: event.id, state: event.state, replayed: true };
      }
      const superseded = user.platformUserId !== target.id || (await accessModeOf(tx, user.id)) !== PAY_ONLY;
      const state = superseded ? 'superseded' as const : 'delivered' as const;
      let withdrawn: HeldAssignment[] = [];
      let roadGranted: AppAccessBranches | 'none' = 'none';
      let sessionsEnded = 0;
      if (!superseded) {
        const held = await heldAssignments(tx, target.id);
        withdrawn = held.filter((h) => !isOtoAppRoad(h, input.operatorId));
        if (withdrawn.length > 0) {
          await assertNotLastOperatorAdmin(tx as Db, input.operatorId, { accountId: target.id });
          // The launcher's road to My pay stays as wide as it was.
          if (!held.some((h) => isOtoAppRoad(h, input.operatorId))) {
            const carriers = withdrawn.filter((h) => h.opensOtoApp);
            const branches = carriers.some((h) => h.scopeType === 'operator')
              ? null
              : [...new Set(carriers.flatMap((h) => (h.scopeType === 'branch' && h.scopeId ? [h.scopeId] : [])))];
            if (branches === null || branches.length > 0) {
              const roleId = await ensureAppAccessRole(tx, input.operatorId, 'oto_app');
              await grantAppAccess(tx, target.id, roleId, input.operatorId, branches);
              roadGranted = branches;
            }
          }
          await tx.delete(roleAssignment).where(inArray(roleAssignment.id, withdrawn.map((h) => h.id)));
        }
        sessionsEnded = await invalidateAllSessions(tx, target.id, 'restricted');
      }
      await settleOtoAppLifecycleEvent(tx, event.id, state);
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: input.operatorId,
        action: 'app_identity.lifecycle_restriction',
        entityType: 'app_identity',
        entityId: event.id,
        actionId: event.id,
        before: {
          status: target.status,
          roles: withdrawn.map((h) => ({ id: h.id, roleId: h.roleId, roleName: h.roleName, scopeType: h.scopeType, scopeId: h.scopeId })),
        },
        after: {
          sourceApp: 'oto_app', accountId: target.id, externalUserId: user.id, state,
          accountStatus: target.status, rolesWithdrawn: withdrawn.length, sessionsEnded,
          otoAppRoadGranted: roadGranted === 'none' ? null : { branches: roadGranted },
        },
        requestId: ctx.requestId,
      });
      return { ok: true as const, eventId: event.id, state, replayed: false };
    });
}
