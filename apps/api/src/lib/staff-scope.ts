import { and, eq, or, sql } from 'drizzle-orm';
import { account, employee } from '@oto/db';

/**
 * Who counts as the staff of a branch (S2-04, widened S2-06).
 *
 * A leaf module rather than a function inside `services/fleet.ts`, because two
 * things now ask the question and the second one is not a route: the fleet's
 * station picker, and the `staff` scope of the cache bundle a box takes so it
 * can check a password with no internet. Importing the service into
 * `services/sync.ts` to get at it would close a loop — sync to fleet to box to
 * sync — for the sake of one predicate. A rule read by two callers lives
 * where neither owns it.
 *
 * The query using it must join `employee` on `account.employee_id`: the
 * predicate reads `employee.branch_id`, and a query without that join is a SQL
 * error rather than a silently wrong answer.
 */

/**
 * The staff of a branch, which has no single definition in the schema: there is
 * no `account.branch_id`.
 *
 * The union of three honest halves — somebody whose employee record says they
 * work here, somebody granted a role scoped to this branch, and somebody who
 * administers the whole operator — because any one alone drops real people.
 * The seeded reception account has the employee link and no branch-scoped
 * assignment; a manager granted `branch_manager` here may have no employee row
 * at all. Deactivated accounts are excluded: putting somebody who cannot sign
 * in on a till's list is a list entry that does nothing.
 *
 * The third half is the owner's ruling (2026-09-20). Without it an
 * operator-wide administrator belongs to no branch, so they cannot be put on a
 * restricted station's list and — because `visibleToAccount` has no
 * administrator escape hatch — that station is then absent from their own
 * picker. It worked until now only because the seeded owner's employee record
 * happens to sit at HKT Central, and a second branch would have broken it the
 * day it opened.
 *
 * Taken here rather than as an exception inside the picker, deliberately:
 * widening who counts as staff keeps ONE visibility rule with no special case,
 * while an administrator override would split the rule back into two places
 * and make "absent, not refused" a thing that needs explaining every time
 * somebody asks why a manager can see a booth they are not on. The cost is
 * that a branch's staff picker lists every operator administrator, which grows
 * with the head-office estate; that is a noisier picker, not a wrong one.
 */
export function atBranch(branchId: string) {
  return and(
    sql`${account.status} <> 'inactive'`,
    or(
      eq(employee.branchId, branchId),
      sql`exists (
        select 1 from core.role_assignment ra
         join core.role r on r.id = ra.role_id
         where ra.account_id = ${account.id}
           and (
             (ra.scope_type = 'branch' and ra.scope_id = ${branchId})
             -- Operator-wide, and an ADMINISTRATOR. The owner's ruling was
             -- that operator-wide administrators belong to every branch; the
             -- first version of this clause admitted any operator-scoped
             -- role, and a two-branch proof found that a reception or staff
             -- role assigned at operator scope made its holder "staff of"
             -- both parks — visible on every till's list and, through the
             -- account writes that use this rule to decide dominance, within
             -- a manager's reach at a branch they never work. scope_id names
             -- the operator, or is null for a platform-wide assignment.
             or (ra.scope_type = 'operator'
                 and r.name in ('operator_admin', 'platform_admin')
                 and (ra.scope_id is null or ra.scope_id = ${account.operatorId}))
           )
      )`,
    ),
  );
}

