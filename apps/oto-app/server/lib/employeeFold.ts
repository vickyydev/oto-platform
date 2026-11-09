import type { Pool, PoolClient } from "pg";
import {
  EMPLOYEE_KEEPS,
  asBlocking,
  blockersOf,
  deleteEmployeeWithin,
  listBlockers,
  tableWords,
  type EmployeeDeletionInput,
  type RecordDeletionOutcome,
} from "./recordDeletion";

/**
 * Fold a duplicate employee profile into the original (SCRUM-794).
 *
 * A second profile made only to put somebody on the rota in a new position
 * carries their shifts, checklist and task assignments, while their login,
 * face and history stay on the original. The fold moves what the duplicate is
 * assigned to onto the original and then deletes the emptied duplicate
 * through the employee delete's own steps (`deleteEmployeeWithin`), all on
 * ONE transaction: a refusal anywhere, or a foreign key still pointing at the
 * duplicate, rolls every move back.
 *
 * What it moves:
 *  - schedule assignments (`schedule_assignments.employee_id`);
 *  - checklist template assignments (`checklist_template_assignees` and the
 *    template's first-named `assigned_employee_id`, SCRUM-658);
 *  - task assignments (`task_assignments` of type employee and the task's
 *    `assigned_employee_id`).
 * A move that would give the original an assignment it already has is
 * skipped and counted: the duplicate's copy goes with the duplicate.
 *
 * It refuses, before anything is written, a duplicate with contracts, time
 * records or payroll records (the delete's own counting, EMPLOYEE_KEEPS).
 * Attendance review items (`timekeeping_issues`) are time records there, so a
 * duplicate that has any is refused rather than folded: they and the clock-ins
 * they stand on are kept for the record on the profile that made them.
 *
 * With `write: false` (the preview) the same steps run and are rolled back, so
 * the preview's counts and refusals are the fold's own.
 *
 * Plain `pg`, like recordDeletion.ts: the pool carries `search_path=otoapp`.
 */

export interface FoldCounts {
  shifts: number;
  checklists: number;
  tasks: number;
}

export type FoldOutcome =
  | {
      folded: true;
      moved: FoldCounts;
      skipped: FoldCounts;
      deleted: { profile: 1; login: 0 | 1 };
    }
  | {
      folded: false;
      status: 400 | 404 | 409;
      message: string;
      reason?: "has_records" | "linked_to_platform" | "still_referenced";
      blocking?: { label: string; count: number }[];
    };

export interface FoldInput {
  duplicateId: string;
  targetId: string;
  tenantId: string;
  /** What the duplicate's delete takes with it, never the original's person or login. */
  deletion: Pick<EmployeeDeletionInput, "personId" | "leavingUserId">;
  actorId: string;
  write: boolean;
}

const FOREIGN_KEY_VIOLATION = "23503";
const FOLD_KEEPS_INSTEAD = "Its history is kept for the record, so it cannot be folded into another profile.";

type Exec = Pick<PoolClient, "query">;

async function count(client: Exec, text: string, values: unknown[]): Promise<number> {
  const { rows } = await client.query<{ n: number }>(text, values);
  return Number(rows[0]?.n ?? 0);
}

/** Moves the duplicate's shifts; a shift the target already works (same row, same day) is skipped. */
async function moveShifts(client: Exec, from: string, to: string) {
  const skipped = await client.query(
    `delete from schedule_assignments d
      using schedule_assignments t
      where d.employee_id = $1 and t.employee_id = $2
        and t.shift_row_id = d.shift_row_id and t.shift_date = d.shift_date`,
    [from, to],
  );
  const moved = await client.query("update schedule_assignments set employee_id = $2 where employee_id = $1", [from, to]);
  return { moved: moved.rowCount ?? 0, skipped: skipped.rowCount ?? 0 };
}

/** Counted per template: the target already named on it (either way) is a skip. */
async function moveChecklists(client: Exec, from: string, to: string) {
  const moved = await count(
    client,
    `with named as (
       select template_id as id from checklist_template_assignees where employee_id = $1
       union select id from checklist_templates where assigned_employee_id = $1
     )
     select count(*) filter (where not (
       exists (select 1 from checklist_template_assignees a where a.template_id = named.id and a.employee_id = $2)
       or exists (select 1 from checklist_templates t where t.id = named.id and t.assigned_employee_id = $2)
     ))::int as n from named`,
    [from, to],
  );
  const total = await count(
    client,
    `select count(*)::int as n from (
       select template_id from checklist_template_assignees where employee_id = $1
       union select id from checklist_templates where assigned_employee_id = $1
     ) named`,
    [from],
  );
  await client.query(
    `delete from checklist_template_assignees
      where employee_id = $1
        and template_id in (select template_id from checklist_template_assignees where employee_id = $2)`,
    [from, to],
  );
  await client.query("update checklist_template_assignees set employee_id = $2 where employee_id = $1", [from, to]);
  await client.query("update checklist_templates set assigned_employee_id = $2 where assigned_employee_id = $1", [from, to]);
  return { moved, skipped: total - moved };
}

/** Counted per task: the target already named on it (either way) is a skip. */
async function moveTasks(client: Exec, from: string, to: string) {
  const moved = await count(
    client,
    `with named as (
       select task_id as id from task_assignments where assignment_type = 'employee' and assignment_id = $1
       union select id from tasks where assigned_employee_id = $1
     )
     select count(*) filter (where not (
       exists (select 1 from task_assignments a where a.task_id = named.id and a.assignment_type = 'employee' and a.assignment_id = $2)
       or exists (select 1 from tasks t where t.id = named.id and t.assigned_employee_id = $2)
     ))::int as n from named`,
    [from, to],
  );
  const total = await count(
    client,
    `select count(*)::int as n from (
       select task_id from task_assignments where assignment_type = 'employee' and assignment_id = $1
       union select id from tasks where assigned_employee_id = $1
     ) named`,
    [from],
  );
  await client.query(
    `delete from task_assignments
      where assignment_type = 'employee' and assignment_id = $1
        and task_id in (select task_id from task_assignments where assignment_type = 'employee' and assignment_id = $2)`,
    [from, to],
  );
  await client.query(
    "update task_assignments set assignment_id = $2 where assignment_type = 'employee' and assignment_id = $1",
    [from, to],
  );
  await client.query("update tasks set assigned_employee_id = $2 where assigned_employee_id = $1", [from, to]);
  return { moved, skipped: total - moved };
}

const refusalOf = (outcome: Exclude<RecordDeletionOutcome, { deleted: true }>): FoldOutcome => ({
  folded: false,
  status: outcome.status,
  message: outcome.message,
  ...(outcome.status === 409 ? { reason: outcome.reason, ...(outcome.blocking ? { blocking: outcome.blocking } : {}) } : {}),
});

async function foldWithin(client: Exec, input: FoldInput): Promise<FoldOutcome> {
  const { duplicateId: from, targetId: to, tenantId } = input;
  if (from === to) return { folded: false, status: 400, message: "A profile cannot be folded into itself" };
  // Both rows locked, in id order, so two folds of the same pair queue rather than deadlock.
  const { rows } = await client.query<{ id: string; branch_id: string | null }>(
    "select id, branch_id from employees where id = any($1::varchar[]) and tenant_id = $2 order by id for update",
    [[from, to], tenantId],
  );
  const target = rows.find((r) => r.id === to);
  if (!rows.some((r) => r.id === from) || !target) return { folded: false, status: 404, message: "Employee not found" };

  const blockers = await blockersOf(client, from, EMPLOYEE_KEEPS);
  if (blockers.length > 0) {
    return {
      folded: false,
      status: 409,
      reason: "has_records",
      message: `This profile has ${listBlockers(blockers)}. ${FOLD_KEEPS_INSTEAD}`,
      blocking: asBlocking(blockers),
    };
  }

  const shifts = await moveShifts(client, from, to);
  const checklists = await moveChecklists(client, from, to);
  const tasks = await moveTasks(client, from, to);
  const moved: FoldCounts = { shifts: shifts.moved, checklists: checklists.moved, tasks: tasks.moved };
  const skipped: FoldCounts = { shifts: shifts.skipped, checklists: checklists.skipped, tasks: tasks.skipped };

  const deletion = await deleteEmployeeWithin(client, {
    employeeId: from,
    tenantId,
    personId: input.deletion.personId,
    leavingUserId: input.deletion.leavingUserId,
  });
  if (!deletion.deleted) return refusalOf(deletion);

  // The original's own record of what came onto it. No names: the counts and the folded id.
  await client.query(
    `insert into activity_log (tenant_id, branch_id, employee_id, activity_type, summary_text, metadata_json, created_by)
     values ($1, $2, $3, 'employee_updated', $4, $5, $6)`,
    [
      tenantId,
      target.branch_id,
      to,
      `A duplicate profile was folded into this one: ${moved.shifts} shift(s), ${moved.checklists} checklist(s) and ${moved.tasks} task(s) moved`,
      JSON.stringify({ foldedProfileId: from, moved, skipped }),
      input.actorId,
    ],
  );
  return { folded: true, moved, skipped, deleted: { profile: 1, login: input.deletion.leavingUserId ? 1 : 0 } };
}

export async function foldEmployeeInto(pool: Pool, input: FoldInput): Promise<FoldOutcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    let outcome: FoldOutcome;
    try {
      outcome = await foldWithin(client, input);
    } catch (err) {
      await client.query("rollback");
      const e = err as { code?: string; table?: string };
      if (e.code === FOREIGN_KEY_VIOLATION) {
        return {
          folded: false,
          status: 409,
          reason: "still_referenced",
          message: `This profile is still linked to ${tableWords(e.table)}, so nothing was folded.`,
        };
      }
      throw err;
    }
    await client.query(outcome.folded && input.write ? "commit" : "rollback");
    return outcome;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
