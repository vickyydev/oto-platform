import type { Pool } from "pg";

/**
 * Match an employee's stray "Unscheduled work" approvals to their shifts
 * (SCRUM-794).
 *
 * A face clock-in with no shift that day becomes an UNSCHEDULED_WORK item on
 * the attendance review: an OPEN `timekeeping_issues` row whose linked time
 * entry waits as PENDING_APPROVAL. When the shifts were on a duplicate profile,
 * every clock-in landed on the original with no shift. After a fold or an
 * Onboard Again start has put the shifts on the profile that clocked in, each pending item
 * whose day (the item's `issue_date`, the day the kiosk recorded the clock-in
 * under) now has a shift for that employee at that item's branch is settled
 * exactly as a manager's approval settles it (timekeeping-review-routes.ts):
 * the entry APPROVED with the approver and time, the item RESOLVED with the
 * resolver, the time and the note below. Items on a day with no shift stay
 * pending for a manager, and so do items at a branch the caller cannot reach.
 * So does an item whose employee already has another time entry (any but a
 * rejected one) on that day, or one running over its clock-in: after a fold
 * the duplicate's own entry for the shift is that employee's now, and
 * approving the stray one as well would count the same hours twice.
 *
 * One transaction, every row it settles locked first, so a manager's own
 * approve or reject at the same moment either goes first (and the row is no
 * longer pending here) or waits.
 */

export const REMATCH_NOTE = "matched to a shift after Onboard Again or a fold";

export interface RematchScope {
  tenantId: string;
  employeeId: string;
  actorId: string;
  /** `null` reaches every branch of the park group. */
  branchIds: string[] | null;
}

export interface RematchCounts {
  matched: number;
  stillPending: number;
}

export async function rematchUnscheduledWork(pool: Pool, scope: RematchScope): Promise<RematchCounts> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ issue_id: string; entry_id: string; has_shift: boolean; has_other_entry: boolean }>(
      `select i.id as issue_id, e.id as entry_id,
              exists (
                select 1 from schedule_assignments sa
                  join schedule_shift_rows sr on sr.id = sa.shift_row_id
                 where sa.employee_id = i.employee_id
                   and sa.tenant_id = i.tenant_id
                   and sr.branch_id = i.branch_id
                   -- the CASE keeps a malformed day from failing the cast: it matches nothing
                   and sa.shift_date = case when i.issue_date ~ '^\\d{4}-\\d{2}-\\d{2}$' then i.issue_date::date end
              ) as has_shift,
              exists (
                select 1 from time_entries o
                 where o.employee_id = e.employee_id
                   and o.tenant_id = e.tenant_id
                   and o.id <> e.id
                   and o.status <> 'REJECTED'
                   and (o.shift_date = e.shift_date or o.shift_date = i.issue_date
                        or (o.clock_in_at <= e.clock_in_at and o.clock_out_at > e.clock_in_at))
              ) as has_other_entry
         from timekeeping_issues i
         join time_entries e
           on e.id = i.linked_time_entry_id and e.tenant_id = i.tenant_id
          and e.employee_id = i.employee_id and e.branch_id = i.branch_id
          and e.status = 'PENDING_APPROVAL'
        where i.tenant_id = $1 and i.employee_id = $2
          and i.issue_type = 'UNSCHEDULED_WORK' and i.status = 'OPEN'
          and ($3::varchar[] is null or i.branch_id = any($3::varchar[]))
        order by i.issue_date, i.id
          for update of i, e`,
      [scope.tenantId, scope.employeeId, scope.branchIds],
    );
    const matched = rows.filter((r) => r.has_shift && !r.has_other_entry);
    if (matched.length > 0) {
      // UTC, as the review route's Drizzle writes store these timestamp columns.
      const now = "(now() at time zone 'utc')";
      await client.query(
        `update time_entries set status = 'APPROVED', approved_at = ${now}, approved_by = $2, updated_at = ${now}
          where id = any($1::varchar[])`,
        [matched.map((r) => r.entry_id), scope.actorId],
      );
      await client.query(
        `update timekeeping_issues set status = 'RESOLVED', resolved_at = ${now}, resolved_by = $2, resolution_note = $3, updated_at = ${now}
          where id = any($1::varchar[])`,
        [matched.map((r) => r.issue_id), scope.actorId, REMATCH_NOTE],
      );
    }
    await client.query("commit");
    return { matched: matched.length, stillPending: rows.length - matched.length };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
