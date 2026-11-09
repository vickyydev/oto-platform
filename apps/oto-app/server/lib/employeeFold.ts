import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import type { DbExecutor } from "../storage";
import { bangkokToday } from "./engagementDates";
import { activateEngagementWithin, type LoginOutcome } from "./onboardAgain";
import {
  PAYROLL_KEPT,
  TIME_RECORDS_KEPT,
  asBlocking,
  blockersOf,
  deleteEmployeeWithin,
  linksBeyondEmployeeDelete,
  listBlockers,
  tableWords,
  type EmployeeDeletionInput,
  type RecordDeletionOutcome,
} from "./recordDeletion";

/**
 * Fold a duplicate employee profile into the original (SCRUM-794).
 *
 * A second profile made to put somebody to work in a new position carries
 * their shifts, checklist and task assignments, and often their new contract,
 * their clock-ins and a face enrolment of its own, while their login, face and
 * history stay on the original. The fold moves what the duplicate holds onto
 * the original and then deletes the emptied duplicate through the employee
 * delete's own steps (`deleteEmployeeWithin`), all on ONE transaction: a
 * refusal anywhere, or a foreign key still pointing at the duplicate, rolls
 * every move back.
 *
 * What it moves:
 *  - schedule assignments (`schedule_assignments.employee_id`), with the
 *    duties and breaks planned on them (`duty_blocks`,
 *    `schedule_shift_breaks`: both name the employee as well as the shift,
 *    and go with the employee's delete otherwise);
 *  - the weekly template's shifts (`schedule_template_assignments`);
 *  - the roles the duplicate holds (`employee_roles`), which shift rows that
 *    need a role check;
 *  - checklist template assignments (`checklist_template_assignees` and the
 *    template's first-named `assigned_employee_id`, SCRUM-658);
 *  - task assignments (`task_assignments` of type employee and the task's
 *    `assigned_employee_id`);
 *  - its contracts, every status, as they are. Its ACTIVE contract becomes the
 *    original's active contract: the original's own active one is superseded
 *    (its end is the last working day the original's offboarding records);
 *  - its time records (`time_events`, `time_entries`, `time_adjustments`) and
 *    attendance review items (`timekeeping_issues`), the ones the employee
 *    delete counts;
 *  - its face enrolment, when the original has none. When both have one the
 *    original keeps its own, and the duplicate's face is removed from the face
 *    collection once the fold has committed (by the route: the collection is
 *    outside the database). The app holds one face per profile
 *    (`employees.face_id`, which re-enrolment and reset replace or remove), and
 *    the face service indexes a face under the profile id it was enrolled for,
 *    which cannot be changed afterwards; a second face under the original
 *    would be neither recorded nor removable, so it is not kept;
 *  - its documents, letters (signed ones included) and company property
 *    (`employee_documents`, `employee_letters`, `employee_assets`); a letter
 *    written for an offboarding of the duplicate's keeps the letter without
 *    that link, as the offboarding goes with the duplicate;
 *  - its leave records (`employee_time_off`), its role unavailability days
 *    (`employee_role_availability`) and the weekly template's days off
 *    (`schedule_template_time_off`);
 *  - the rows a profile holds one of: its payroll profile
 *    (`employee_payroll_profiles`: salary, bank account, tax and social
 *    security ids), its cost allocations (`staff_cost_allocations`) and its
 *    leave settings per leave type (`employee_leave_balance_openings`,
 *    `employee_leave_overrides`). The duplicate's are taken when the original
 *    has none, or when the original is onboarded again into the duplicate's
 *    employment (the original's own are then replaced, and counted); when both
 *    have one otherwise, the fold refuses and names them;
 *  - its live clock-in state (`employee_presence`), when it is later than the
 *    original's (the time records it follows are merged);
 *  - its history: activity entries, attention items (the open ones the
 *    attention engine raised for the duplicate itself resolved, as its own
 *    run resolves an item no profile triggers any more), staff movement
 *    entries, kiosk sign-in attempts and missing clock-in notices;
 *  - its org chart entries (`org_nodes.person_employee_id`), chart by chart
 *    (park group, live or draft, the company chart or a branch's): one in a
 *    chart where the original has no entry (one not marked deleted) becomes
 *    the original's, in its place, under its parent; one in a chart where the
 *    original already has its entry is deleted outright (a row folded away,
 *    not the chart's soft mark), and the entries that reported to it report to
 *    the original's (`orgChartMoved`, `orgChartDropped`). The Org Chart page
 *    adds an entry for every active employee missing from the chart it reads,
 *    so a working duplicate is usually on a chart.
 * A move that would give the original an assignment it already has is
 * skipped and counted: the duplicate's copy goes with the duplicate (a
 * skipped shift's duties and breaks with it, the original keeping its own);
 * so is a leave record on dates the original already has off, and a role
 * unavailability day or template day off the original already has. Days with
 * time records on both profiles are counted (`clockedOnBoth`): the same hours
 * may be recorded twice, and the stray approvals of those days are left for a
 * manager (lib/reviewRematch.ts).
 *
 * When the original's employment has ended or is ending (Left or Leaving) and
 * the duplicate is the one working (active), the fold finishes as Onboard
 * Again's start does (`activateEngagementWithin`): an employment from the
 * moved active contract's start date, in the duplicate's department, branch,
 * position and employment basis, following the original's open offboarding;
 * the original reads active in it, its offboarding re-onboarded, its login
 * switched back on; it takes the duplicate's daily rate, probation and salary
 * (the employment's terms); the movement logged as "onboard again (from a
 * folded profile)". A start date still to come is planned instead, for the
 * 03:00 batch to start, as Onboard Again plans one.
 *
 * It refuses, before anything is written, a duplicate with payroll records
 * (kept on the profile they were paid to); two active contracts while the
 * original's has no last working day; an Onboard Again employment already
 * planned on the original when the fold would start one; a re-onboarding
 * with no department or branch to put the original in; a re-onboarding still
 * to come whose terms (basis, daily rate, probation, salary) differ from the
 * original's, which runs its current contract on them until its last working
 * day (fold on or after the start date); and a payroll profile, cost
 * allocations or leave settings on both profiles when nobody is onboarded
 * again. Once everything has moved, a row anything else still points at the
 * duplicate with (a foreign key to `employees` the fold does not move and the
 * employee delete has no step for) refuses the fold naming each table, "still
 * linked by …", rather than the first foreign-key error alone.
 *
 * With `write: false` (the preview) the same steps run and are rolled back, so
 * the preview's counts and refusals are the fold's own.
 *
 * Plain `pg`, like recordDeletion.ts: the pool carries `search_path=otoapp`.
 * Onboard Again's start runs on the same connection through Drizzle.
 */

export interface FoldCounts {
  shifts: number;
  /** Duty blocks planned on those shifts. */
  duties: number;
  /** Breaks planned on those shifts. */
  breaks: number;
  /** The weekly template's shifts (a template row on a day of the week). */
  templateShifts: number;
  roles: number;
  checklists: number;
  tasks: number;
  /** Contracts of every status, re-pointed as they are. */
  contracts: number;
  /** Clock-ins, time entries, time adjustments and attendance review items. */
  timeRecords: number;
  /** Uploaded documents (ID card, certificates). */
  documents: number;
  /** Letters, signed ones included. */
  letters: number;
  /** Company property handed out. */
  assets: number;
  /** Leave records; one on dates the original already has off is skipped. */
  timeOff: number;
  /** Role unavailability days and the weekly template's days off; one the original already has is skipped. */
  availability: number;
  /** Opening leave balances and leave overrides, one per leave type. */
  leaveSettings: number;
  /** The payroll profile (salary, bank account, tax and social security ids): 0 or 1. */
  payrollProfile: number;
  /** Cost allocations across branches. */
  costAllocations: number;
  /** Activity entries, attention items, staff movement entries, kiosk sign-in attempts and missing clock-in notices. */
  history: number;
}

/** The original's own rows the duplicate's replace, when the original is onboarded again into the duplicate's employment. */
export interface FoldReplaced {
  payrollProfile: number;
  costAllocations: number;
  leaveSettings: number;
}

/** The duplicate's face enrolment: none, taken by the original, or left out (the original keeps its own). */
export type FoldFace = "none" | "taken" | "original_kept";

export interface FoldReonboard {
  engagementId: string;
  startDate: string;
  /** Started by the fold; false when the start date is still to come (the 03:00 batch starts it). */
  started: boolean;
  department: { id: string; name: string | null };
  branch: { id: string; name: string | null };
  positionTitle: string | null;
  /** The duplicate's employment basis, the employment's own. */
  employmentBasis: string;
  /** The duplicate's probation end, the original's once started; null when it has none. */
  probationEndDate: string | null;
  /** The moved active contract the employment starts with. */
  contractId: string | null;
  /** The login once started: switched back on, already on, none, or one the app does not place in the park group. */
  login: LoginOutcome | null;
  /** The platform was already told of a switch-off; reactivating there is a platform administrator's step. */
  platformDeactivationDelivered: boolean;
}

export type FoldOutcome =
  | {
      folded: true;
      moved: FoldCounts;
      skipped: FoldCounts;
      face: FoldFace;
      /** The duplicate's face to remove from the face collection after the commit; never sent to the browser. */
      faceToRemove: string | null;
      /** The original's earlier active contracts superseded by the duplicate's. */
      supersededContracts: number;
      /** The original's own one-per-profile rows the duplicate's replace (a re-onboarding only). */
      replaced: FoldReplaced;
      /** Days with time records on both profiles: the same hours may be recorded twice; left for a manager to check. */
      clockedOnBoth: number;
      /** The duplicate's org chart entries the original takes, in their place and under their parent. */
      orgChartMoved: number;
      /** The duplicate's org chart entries deleted, in charts where the original already has its own entry. */
      orgChartDropped: number;
      reonboard: FoldReonboard | null;
      deleted: { profile: 1; login: 0 | 1 };
    }
  | {
      folded: false;
      status: 400 | 404 | 409;
      message: string;
      reason?:
        | "has_records"
        | "linked_to_platform"
        | "still_referenced"
        | "both_active"
        | "planned_employment"
        | "no_department"
        | "terms_differ";
      blocking?: { label: string; count: number }[];
    };

export interface FoldInput {
  duplicateId: string;
  targetId: string;
  tenantId: string;
  /** What the duplicate's delete takes with it, never the original's person or login. */
  deletion: Pick<EmployeeDeletionInput, "personId" | "leavingUserId">;
  /** Whether the original's login is one the app places in the park group (the one a re-onboarding switches back on). */
  loginInParkGroup: boolean;
  actorId: string;
  write: boolean;
}

const FOREIGN_KEY_VIOLATION = "23503";
const PAYROLL_STAYS = "Payroll records stay on the profile they were paid to, so it cannot be folded into another profile.";

type Exec = Pick<PoolClient, "query">;

async function count(client: Exec, text: string, values: unknown[]): Promise<number> {
  const { rows } = await client.query<{ n: number }>(text, values);
  return Number(rows[0]?.n ?? 0);
}

type Moved = { moved: number; skipped: number };

/**
 * Moves the duplicate's shifts, and the duties and breaks planned on them; a
 * shift the target already works (same row, same day) is skipped, and its
 * duties and breaks go with it (they cascade with the shift).
 */
async function moveShifts(client: Exec, from: string, to: string): Promise<{ shifts: Moved; duties: Moved; breaks: Moved }> {
  const { rows } = await client.query<{ id: string }>(
    `select d.id from schedule_assignments d
       join schedule_assignments t on t.shift_row_id = d.shift_row_id and t.shift_date = d.shift_date
      where d.employee_id = $1 and t.employee_id = $2`,
    [from, to],
  );
  const skippedIds = [...new Set(rows.map((r) => r.id))];
  const skippedDuties = await count(client, "select count(*)::int as n from duty_blocks where assignment_id = any($1::varchar[])", [skippedIds]);
  const skippedBreaks = await count(client, "select count(*)::int as n from schedule_shift_breaks where assignment_id = any($1::varchar[])", [skippedIds]);
  const skipped = await client.query("delete from schedule_assignments where id = any($1::varchar[])", [skippedIds]);
  const moved = await client.query("update schedule_assignments set employee_id = $2 where employee_id = $1", [from, to]);
  const duties = await client.query("update duty_blocks set employee_id = $2 where employee_id = $1", [from, to]);
  const breaks = await client.query("update schedule_shift_breaks set employee_id = $2 where employee_id = $1", [from, to]);
  return {
    shifts: { moved: moved.rowCount ?? 0, skipped: skipped.rowCount ?? 0 },
    duties: { moved: duties.rowCount ?? 0, skipped: skippedDuties },
    breaks: { moved: breaks.rowCount ?? 0, skipped: skippedBreaks },
  };
}

/** The weekly template's shifts; one the target already has (same template row, same day of the week) is skipped. */
async function moveTemplateShifts(client: Exec, from: string, to: string): Promise<Moved> {
  const skipped = await client.query(
    `delete from schedule_template_assignments d
      using schedule_template_assignments t
      where d.employee_id = $1 and t.employee_id = $2
        and t.template_row_id = d.template_row_id and t.day_of_week = d.day_of_week`,
    [from, to],
  );
  const moved = await client.query("update schedule_template_assignments set employee_id = $2 where employee_id = $1", [from, to]);
  return { moved: moved.rowCount ?? 0, skipped: skipped.rowCount ?? 0 };
}

/**
 * The roles the duplicate holds; one the target already holds is skipped. A
 * primary role stays primary only when the target has none of its own.
 */
async function moveRoles(client: Exec, from: string, to: string): Promise<Moved> {
  const skipped = await client.query(
    `delete from employee_roles d
      using employee_roles t
      where d.employee_id = $1 and t.employee_id = $2 and t.role_id = d.role_id`,
    [from, to],
  );
  const moved = await client.query(
    `update employee_roles
        set employee_id = $2::varchar,
            is_primary = is_primary and not exists (select 1 from employee_roles p where p.employee_id = $2::varchar and p.is_primary)
      where employee_id = $1`,
    [from, to],
  );
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

/** The duplicate's time records and attendance review items, every table the employee delete counts. */
async function moveTimeRecords(client: Exec, from: string, to: string): Promise<number> {
  let moved = 0;
  for (const table of TIME_RECORDS_KEPT.tables) {
    moved += (await client.query(`update ${table} set employee_id = $2 where employee_id = $1`, [from, to])).rowCount ?? 0;
  }
  return moved;
}

/**
 * Days with time entries on both profiles (a rejected one counts on neither):
 * the same hours may be recorded twice once the records are merged.
 */
async function daysClockedOnBoth(client: Exec, from: string, to: string): Promise<number> {
  return count(
    client,
    `select count(distinct d.shift_date)::int as n
       from time_entries d
       join time_entries t on t.employee_id = $2 and t.shift_date = d.shift_date and t.status <> 'REJECTED'
      where d.employee_id = $1 and d.status <> 'REJECTED'`,
    [from, to],
  );
}

/**
 * Documents, letters and company property, as they are. A letter written for
 * an offboarding of the duplicate's keeps the letter without that link: the
 * offboarding goes with the duplicate.
 */
async function moveFiles(client: Exec, from: string, to: string) {
  const documents = (await client.query("update employee_documents set employee_id = $2 where employee_id = $1", [from, to])).rowCount ?? 0;
  const letters = (await client.query(
    `update employee_letters
        set employee_id = $2,
            offboarding_id = case when offboarding_id in (select id from employee_offboarding where employee_id = $1) then null else offboarding_id end
      where employee_id = $1`,
    [from, to],
  )).rowCount ?? 0;
  const assets = (await client.query("update employee_assets set employee_id = $2 where employee_id = $1", [from, to])).rowCount ?? 0;
  return { documents, letters, assets };
}

/**
 * Leave records; one on dates the target already has off is skipped (two half
 * days of the same day in different halves are not the same time off).
 */
async function moveTimeOff(client: Exec, from: string, to: string): Promise<Moved> {
  const skipped = await client.query(
    `delete from employee_time_off d
      using employee_time_off t
      where d.employee_id = $1 and t.employee_id = $2
        and d.start_date <= t.end_date and t.start_date <= d.end_date
        and not (d.is_half_day and t.is_half_day and d.half_day_period is distinct from t.half_day_period)`,
    [from, to],
  );
  const moved = await client.query("update employee_time_off set employee_id = $2 where employee_id = $1", [from, to]);
  return { moved: moved.rowCount ?? 0, skipped: skipped.rowCount ?? 0 };
}

/** Role unavailability days and the weekly template's days off; one the target already has is skipped. */
async function moveAvailability(client: Exec, from: string, to: string): Promise<Moved> {
  const skippedDays = await client.query(
    `delete from employee_role_availability d
      using employee_role_availability t
      where d.employee_id = $1 and t.employee_id = $2 and t.role_id = d.role_id and t.unavailable_date = d.unavailable_date`,
    [from, to],
  );
  const skippedTemplate = await client.query(
    `delete from schedule_template_time_off d
      using schedule_template_time_off t
      where d.employee_id = $1 and t.employee_id = $2 and t.template_id = d.template_id and t.day_of_week = d.day_of_week`,
    [from, to],
  );
  const days = await client.query("update employee_role_availability set employee_id = $2 where employee_id = $1", [from, to]);
  const template = await client.query("update schedule_template_time_off set employee_id = $2 where employee_id = $1", [from, to]);
  return {
    moved: (days.rowCount ?? 0) + (template.rowCount ?? 0),
    skipped: (skippedDays.rowCount ?? 0) + (skippedTemplate.rowCount ?? 0),
  };
}

/** The rows a profile holds one of (per leave type for the leave settings), counted on both profiles. */
async function heldOnBoth(client: Exec, from: string, to: string) {
  const both = (table: string) =>
    count(client, `select (exists (select 1 from ${table} where employee_id = $1) and exists (select 1 from ${table} where employee_id = $2))::int as n`, [from, to]);
  const leaveTypes = (table: string) =>
    count(
      client,
      `select count(*)::int as n from ${table} d where d.employee_id = $1
          and exists (select 1 from ${table} t where t.employee_id = $2 and t.leave_type_id = d.leave_type_id)`,
      [from, to],
    );
  return {
    payrollProfile: await both("employee_payroll_profiles"),
    costAllocations: await both("staff_cost_allocations"),
    leaveSettings: (await leaveTypes("employee_leave_balance_openings")) + (await leaveTypes("employee_leave_overrides")),
  };
}

/**
 * The payroll profile, the cost allocations and the leave settings. The
 * target's own are replaced (deleted, and counted) only when `replace` (a
 * re-onboarding into the duplicate's employment); otherwise the caller has
 * refused a fold where both hold one.
 */
async function moveOnePerProfile(client: Exec, from: string, to: string, replace: boolean) {
  const replaced: FoldReplaced = { payrollProfile: 0, costAllocations: 0, leaveSettings: 0 };
  const holds = async (table: string, id: string) => (await count(client, `select count(*)::int as n from ${table} where employee_id = $1`, [id])) > 0;

  if (replace && (await holds("employee_payroll_profiles", from))) {
    replaced.payrollProfile = (await client.query("delete from employee_payroll_profiles where employee_id = $1", [to])).rowCount ?? 0;
  }
  const payrollProfile = (await client.query("update employee_payroll_profiles set employee_id = $2 where employee_id = $1", [from, to])).rowCount ?? 0;

  if (replace && (await holds("staff_cost_allocations", from))) {
    replaced.costAllocations = (await client.query("delete from staff_cost_allocations where employee_id = $1", [to])).rowCount ?? 0;
  }
  const costAllocations = (await client.query("update staff_cost_allocations set employee_id = $2 where employee_id = $1", [from, to])).rowCount ?? 0;

  let leaveSettings = 0;
  for (const table of ["employee_leave_balance_openings", "employee_leave_overrides"]) {
    if (replace) {
      replaced.leaveSettings += (await client.query(
        `delete from ${table} t where t.employee_id = $2
            and exists (select 1 from ${table} d where d.employee_id = $1 and d.leave_type_id = t.leave_type_id)`,
        [from, to],
      )).rowCount ?? 0;
    }
    leaveSettings += (await client.query(`update ${table} set employee_id = $2 where employee_id = $1`, [from, to])).rowCount ?? 0;
  }
  return { payrollProfile, costAllocations, leaveSettings, replaced };
}

/** The live clock-in state: the later of the two, as the merged time records read. */
async function movePresence(client: Exec, from: string, to: string): Promise<void> {
  const { rows } = await client.query<{ later: boolean }>(
    `select d.last_event_at is not null and (t.employee_id is null or t.last_event_at is null or d.last_event_at > t.last_event_at) as later
       from employee_presence d left join employee_presence t on t.employee_id = $2
      where d.employee_id = $1`,
    [from, to],
  );
  if (!rows[0]?.later) return;
  await client.query("delete from employee_presence where employee_id = $1", [to]);
  await client.query("update employee_presence set employee_id = $2 where employee_id = $1", [from, to]);
}

/**
 * The staff movement entries. Their history is not rewritten (migration
 * 0015's trigger refuses an update that changes anything but the contract
 * link), so each entry moves whole: taken off the duplicate and written again
 * under the original with its own id, dates, author and words unchanged.
 */
async function moveChanges(client: Exec, from: string, to: string): Promise<number> {
  const { rows } = await client.query<{ entry: Record<string, unknown> }>(
    "delete from employee_changes where employee_id = $1 returning to_jsonb(employee_changes) as entry",
    [from],
  );
  if (rows.length === 0) return 0;
  await client.query(
    `insert into employee_changes
     select (jsonb_populate_record(null::employee_changes, entry || jsonb_build_object('employee_id', $2::text))).*
       from jsonb_array_elements($1::jsonb) as entry`,
    [JSON.stringify(rows.map((r) => r.entry)), to],
  );
  return rows.length;
}

/**
 * The duplicate's history, every row naming it: activity entries, attention
 * items, staff movement entries, kiosk sign-in attempts (with the person the
 * original is, as the duplicate's person record goes with it) and missing
 * clock-in notices. The open attention items the engine raised for the
 * duplicate itself (keyed to it) are resolved, as the engine's own run
 * resolves an item no profile triggers any more; the engine raises the
 * original's own once the fold has committed.
 */
async function moveHistory(client: Exec, from: string, to: string): Promise<number> {
  let moved = 0;
  moved += (await client.query("update activity_log set employee_id = $2 where employee_id = $1", [from, to])).rowCount ?? 0;
  const now = "(now() at time zone 'utc')";
  await client.query(
    `update attention_items set status = 'resolved', resolved_at = ${now}, updated_at = ${now}
      where employee_id = $1 and status = 'open' and (entity_key = $2::text or entity_key like ($2::text || ':%'))`,
    [from, `employee:${from}`],
  );
  moved += (await client.query("update attention_items set employee_id = $2 where employee_id = $1", [from, to])).rowCount ?? 0;
  moved += await moveChanges(client, from, to);
  moved += (await client.query(
    `update kiosk_auth_attempts
        set employee_id = $2::varchar,
            person_id = case when person_id is null then null else (select person_id from employees where id = $2::varchar) end
      where employee_id = $1`,
    [from, to],
  )).rowCount ?? 0;
  moved += (await client.query("update presence_notification_deliveries set employee_id = $2 where employee_id = $1", [from, to])).rowCount ?? 0;
  return moved;
}

/**
 * The duplicate's org chart entries in the park group, chart by chart (a chart
 * is the park group's live or draft chart of the company or of one branch).
 * Its entries not marked deleted go first, so the one it shows on a chart is
 * the one kept there.
 *
 *  - The original has no entry on that chart (none not marked deleted): the
 *    entry becomes the original's as it stands, its place, parent, position
 *    and name override unchanged. The chart shows a person's entry with the
 *    employee's own nickname, so it reads as the original at once.
 *  - The original has its entry there already: the duplicate's is deleted
 *    outright (a row folded away; the chart's own soft mark would leave it
 *    naming the duplicate, which the delete refuses). The entries that reported to
 *    it report to the original's, as they reported to the same person; the
 *    chart draws only an entry whose parent it holds. When the original's
 *    entry is itself below the duplicate's, the one of those entries on the
 *    way down to it takes the dropped entry's parent instead, so no entry
 *    ends up below itself. An entry already marked deleted keeps the entries
 *    under it as they are: the chart draws none of them now, and still none.
 */
async function moveOrgChart(client: Exec, from: string, to: string, tenantId: string): Promise<{ moved: number; dropped: number }> {
  const { rows: entries } = await client.query<{ id: string; mode: string; scope_type: string; scope_branch_id: string | null; reports_to_node_id: string | null; is_deleted: boolean }>(
    `select id, mode::text as mode, scope_type::text as scope_type, scope_branch_id, reports_to_node_id, is_deleted
       from org_nodes where person_employee_id = $1 and tenant_id = $2
      order by is_deleted, sort_order, created_at, id`,
    [from, tenantId],
  );
  let moved = 0;
  let dropped = 0;
  for (const entry of entries) {
    const { rows: own } = await client.query<{ id: string }>(
      `select id from org_nodes
        where person_employee_id = $1 and tenant_id = $2 and not is_deleted
          and mode::text = $3 and scope_type::text = $4 and scope_branch_id is not distinct from $5
        order by sort_order, created_at, id limit 1`,
      [to, tenantId, entry.mode, entry.scope_type, entry.scope_branch_id],
    );
    const kept = own[0]?.id;
    if (!kept) {
      await client.query("update org_nodes set person_employee_id = $2, updated_at = now() where id = $1", [entry.id, to]);
      moved += 1;
      continue;
    }
    if (!entry.is_deleted) {
      // The entry under the dropped one on the way down to the original's, if the original's is below it.
      const { rows: path } = await client.query<{ id: string }>(
        `with recursive up(id, parent, depth) as (
           select id, reports_to_node_id, 0 from org_nodes where id = $1
           union all
           select n.id, n.reports_to_node_id, up.depth + 1 from org_nodes n join up on n.id = up.parent
            where up.depth < 1000 and up.parent <> $2
         )
         select id from up where parent = $2 limit 1`,
        [kept, entry.id],
      );
      await client.query(
        `update org_nodes set reports_to_node_id = case when id = $4 then $3 else $2 end, updated_at = now()
          where reports_to_node_id = $1 and tenant_id = $5`,
        [entry.id, kept, entry.reports_to_node_id, path[0]?.id ?? null, tenantId],
      );
    }
    await client.query("delete from org_nodes where id = $1", [entry.id]);
    dropped += 1;
  }
  return { moved, dropped };
}

const refusalOf = (outcome: Exclude<RecordDeletionOutcome, { deleted: true }>): FoldOutcome => ({
  folded: false,
  status: outcome.status,
  message: outcome.message,
  ...(outcome.status === 409 ? { reason: outcome.reason, ...(outcome.blocking ? { blocking: outcome.blocking } : {}) } : {}),
});

interface ProfileRow {
  id: string;
  branch_id: string | null;
  status: string;
  employment_state: string;
  primary_department_id: string | null;
  position_title: string | null;
  face_enrollment_status: string | null;
  face_id: string | null;
  start_day: string | null;
  last_day: string | null;
  employment_basis: string;
  probation_end_day: string | null;
}

/** An employment's terms on the profile: what the original takes from the duplicate when it is onboarded again into its employment. */
const TERMS = [
  "employment_basis",
  "daily_rate",
  "probation_days",
  "probation_end_date",
  "probation_review_completed_at",
] as const;
/** The pay fields of the profile's contract defaults (`default_merge_data`). */
const PAY_DEFAULTS = ["salaryThb"] as const;

const LABEL_ONE_PER_PROFILE: Record<keyof FoldReplaced, string> = {
  payrollProfile: "payroll profiles",
  costAllocations: "cost allocations",
  leaveSettings: "leave settings",
};

/** Left, or Leaving: the profile's employment has ended or has a last working day. */
const isEnding = (p: ProfileRow) =>
  p.employment_state === "LEAVING" || p.employment_state === "LEFT" || p.status === "resigned" || p.status === "terminated";
const hasFace = (p: ProfileRow) => !!p.face_id || p.face_enrollment_status === "ENROLLED";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const isoDay = (value: string | null | undefined) => (value && ISO_DAY.test(value) ? value.slice(0, 10) : null);
const words = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

async function foldWithin(client: PoolClient, input: FoldInput): Promise<FoldOutcome> {
  const { duplicateId: from, targetId: to, tenantId } = input;
  if (from === to) return { folded: false, status: 400, message: "A profile cannot be folded into itself" };
  // Offboarding's own per-employee lock (the offboarding route's and Onboard
  // Again's), both profiles in id order, then both rows in id order, so a fold
  // queues behind an offboarding or a plan of either profile, and two folds of
  // the same pair queue rather than deadlock.
  for (const id of [from, to].sort()) {
    await client.query("select pg_advisory_xact_lock(hashtext('employee_offboarding'), hashtext($1::text))", [id]);
  }
  const { rows } = await client.query<ProfileRow>(
    `select id, branch_id, status, employment_state, primary_department_id,
            default_merge_data->>'positionTitle' as position_title, face_enrollment_status, face_id,
            to_char(start_date, 'YYYY-MM-DD') as start_day, to_char(last_working_day, 'YYYY-MM-DD') as last_day,
            employment_basis, to_char(probation_end_date, 'YYYY-MM-DD') as probation_end_day
       from employees where id = any($1::varchar[]) and tenant_id = $2 order by id for update`,
    [[from, to], tenantId],
  );
  const duplicate = rows.find((r) => r.id === from);
  const target = rows.find((r) => r.id === to);
  if (!duplicate || !target) return { folded: false, status: 404, message: "Employee not found" };

  // Payroll records stay where they were paid; contracts and time records move.
  const blockers = await blockersOf(client, from, [PAYROLL_KEPT]);
  if (blockers.length > 0) {
    return {
      folded: false,
      status: 409,
      reason: "has_records",
      message: `This profile has ${listBlockers(blockers)}. ${PAYROLL_STAYS}`,
      blocking: asBlocking(blockers),
    };
  }

  const ending = isEnding(target);
  const { rows: duplicateActive } = await client.query<{ id: string; start: string | null; position: string | null }>(
    `select id, merge_data_json->>'startDate' as start, merge_data_json->>'positionTitle' as position
       from contract_instances where employee_id = $1 and status = 'active' order by created_at desc`,
    [from],
  );
  const active = duplicateActive[0] ?? null;
  if (active && !ending && (await count(client, "select count(*)::int as n from contract_instances where employee_id = $1 and status = 'active'", [to])) > 0) {
    return {
      folded: false,
      status: 409,
      reason: "both_active",
      message: "Both profiles have an active contract, and the contract of the profile kept has no last working day. " +
        "Offboard it first (its last working day ends it), then fold: this profile's contract becomes the active one.",
    };
  }

  // The original's employment ended (or ends), and the duplicate is the one working: it is onboarded again.
  const reonboard = ending && duplicate.status === "active";
  const departmentId = duplicate.primary_department_id ?? target.primary_department_id;
  const branchId = duplicate.branch_id ?? target.branch_id;
  const startDate = isoDay(active?.start) ?? duplicate.start_day ?? bangkokToday();
  const startsNow = startDate <= bangkokToday();
  if (reonboard) {
    const { rows: planned } = await client.query<{ start_date: string }>(
      "select start_date::text as start_date from employee_engagements where employee_id = $1 and status = 'planned' limit 1",
      [to],
    );
    if (planned[0]) {
      return {
        folded: false,
        status: 409,
        reason: "planned_employment",
        message: `The profile kept has an Onboard Again employment planned from ${planned[0].start_date}. ` +
          "Cancel that plan first: the fold starts the employment this profile already works.",
      };
    }
    if (!departmentId || !branchId) {
      return {
        folded: false,
        status: 409,
        reason: "no_department",
        message: "Set this profile's department and branch first: the profile kept is onboarded again into them.",
      };
    }
    // A start still to come: the original runs its current contract on its
    // own terms until its last working day, and the planned employment carries
    // only its basis, so the duplicate's other terms would have nowhere to wait.
    if (!startsNow) {
      const terms = [...TERMS, ...PAY_DEFAULTS.map((k) => `default_merge_data->'${k}'`)];
      const differ = await count(
        client,
        `select ((${terms.map((t) => `d.${t}`).join(", ")}) is distinct from (${terms.map((t) => `t.${t}`).join(", ")}))::int as n
           from employees d, employees t where d.id = $1 and t.id = $2`,
        [from, to],
      );
      if (differ > 0) {
        return {
          folded: false,
          status: 409,
          reason: "terms_differ",
          message: `This profile's employment starts on ${startDate} on different terms (employment basis, daily rate, probation or salary) ` +
            `from the profile kept, which works its current contract on its own terms until its last working day. Fold on or after ${startDate}: ` +
            "the profile kept then takes this profile's terms with the employment.",
        };
      }
    }
  }

  // A payroll profile, cost allocations or leave settings on both: one of
  // each stays. Onboarded again, the original takes the duplicate's with its
  // employment; otherwise the fold does not choose between them.
  const onBoth = await heldOnBoth(client, from, to);
  if (!reonboard) {
    const both = (Object.keys(onBoth) as (keyof FoldReplaced)[]).filter((k) => onBoth[k] > 0);
    if (both.length > 0) {
      return {
        folded: false,
        status: 409,
        reason: "has_records",
        message: `This profile and the profile kept both have their own ${both.map((k) => LABEL_ONE_PER_PROFILE[k]).join(" and ")}, ` +
          "and a profile holds one of each. Remove this profile's first, then fold.",
        blocking: both.map((k) => ({ label: LABEL_ONE_PER_PROFILE[k], count: onBoth[k] })),
      };
    }
  }

  // Counted before the time records merge: the days both profiles were clocked on.
  const clockedOnBoth = await daysClockedOnBoth(client, from, to);

  const { shifts, duties, breaks } = await moveShifts(client, from, to);
  const templateShifts = await moveTemplateShifts(client, from, to);
  const roles = await moveRoles(client, from, to);
  const checklists = await moveChecklists(client, from, to);
  const tasks = await moveTasks(client, from, to);
  const files = await moveFiles(client, from, to);
  const timeOff = await moveTimeOff(client, from, to);
  const availability = await moveAvailability(client, from, to);
  const onePerProfile = await moveOnePerProfile(client, from, to, reonboard);
  await movePresence(client, from, to);
  const history = await moveHistory(client, from, to);
  const orgChart = await moveOrgChart(client, from, to, tenantId);

  // Contracts. The duplicate's active contract is the person's contract now:
  // the original's active one is superseded — at once, or, when the
  // employment it starts is still to come, by Onboard Again's start on that
  // day (the moved contract waits, signed, as a contract signed for a planned
  // employment waits).
  let supersededContracts = 0;
  if (active) {
    await client.query("update contract_instances set status = 'superseded' where employee_id = $1 and status = 'active' and id <> $2", [from, active.id]);
    if (reonboard && !startsNow) {
      await client.query("update contract_instances set status = 'finalized' where id = $1", [active.id]);
    } else {
      supersededContracts = (await client.query("update contract_instances set status = 'superseded' where employee_id = $1 and status = 'active'", [to])).rowCount ?? 0;
    }
  }
  const contracts = (await client.query("update contract_instances set employee_id = $2 where employee_id = $1", [from, to])).rowCount ?? 0;
  const timeRecords = await moveTimeRecords(client, from, to);

  // The face: the duplicate's, when the original has none.
  let face: FoldFace = "none";
  let faceToRemove: string | null = null;
  if (hasFace(duplicate)) {
    if (!hasFace(target)) {
      await client.query(
        `update employees t set face_enrollment_status = d.face_enrollment_status, face_id = d.face_id, face_enrolled_at = d.face_enrolled_at
           from employees d where t.id = $1 and d.id = $2`,
        [to, from],
      );
      face = "taken";
    } else {
      face = "original_kept";
      faceToRemove = duplicate.face_id;
    }
  }

  // Onboard Again's start, on this transaction.
  let reonboarded: FoldReonboard | null = null;
  if (reonboard && departmentId && branchId) {
    const positionTitle = words(duplicate.position_title) ?? words(active?.position);
    const { rows: open } = await client.query<{ id: string; last_day: string | null }>(
      `select id, to_char(last_working_day, 'YYYY-MM-DD') as last_day from employee_offboarding
        where employee_id = $1 and reonboarded_at is null order by created_at desc limit 1`,
      [to],
    );
    const offboarding = open[0] ?? null;
    const { rows: made } = await client.query<{ id: string }>(
      `insert into employee_engagements (tenant_id, employee_id, start_date, department_id, branch_id, position_title, employment_basis,
                                         contract_instance_id, offboarding_id, status, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'planned', $10) returning id`,
      [
        tenantId, to, startDate, departmentId, branchId, positionTitle, duplicate.employment_basis,
        active?.id ?? null, offboarding?.id ?? null, input.actorId,
      ],
    );
    const engagementId = made[0]!.id;
    // The employment's terms are the duplicate's: its daily rate, probation
    // and salary (the basis comes with the engagement). Started now only: a
    // start still to come was refused above unless they already match.
    if (startsNow) {
      const pay = (side: "d" | "t") => PAY_DEFAULTS.map((k) => `${side}.default_merge_data ? '${k}'`).join(" or ");
      await client.query(
        `update employees t
            set ${TERMS.filter((c) => c !== "employment_basis").map((c) => `${c} = d.${c}`).join(", ")},
                default_merge_data = case
                  when ${pay("d")} or ${pay("t")}
                    then (coalesce(t.default_merge_data, '{}'::jsonb) - $3::text[])
                         || jsonb_strip_nulls(jsonb_build_object(${PAY_DEFAULTS.map((k) => `'${k}', d.default_merge_data->'${k}'`).join(", ")}))
                  else t.default_merge_data end
           from employees d where t.id = $1 and d.id = $2`,
        [to, from, [...PAY_DEFAULTS]],
      );
    }
    // Onboard Again's own start, on this connection: Drizzle over the same
    // client, so it is this transaction. The cast only names the executor type
    // the start is written for; the client underneath is this one.
    const tx = drizzle(client, { schema }) as unknown as DbExecutor;
    const started = startsNow
      ? await activateEngagementWithin(tx, engagementId, { actorId: input.actorId, loginInParkGroup: async () => input.loginInParkGroup })
      : null;
    if (startsNow && !started) throw new Error("The employment the fold planned could not be started");

    // The staff movement entry, as Onboard Again writes it.
    const { rows: known } = await client.query<{ id: string }>(
      "select id from departments where tenant_id = $1 and id = any($2::varchar[])",
      [tenantId, [target.primary_department_id, departmentId].filter((v): v is string => !!v)],
    );
    const knownDepartment = (value: string | null) => (value && known.some((d) => d.id === value) ? value : null);
    const lastDay = offboarding?.last_day ?? target.last_day;
    await client.query(
      `insert into employee_changes (employee_id, change_type, effective_date, old_title, new_title, old_branch_id, new_branch_id,
                                     old_department_id, new_department_id, note, contract_generated, contract_instance_id, created_by)
       values ($1, 'onboard_again', $2::date::timestamp, $3, $4, $5, $6, $7, $8, $9, false, $10, $11)`,
      [
        to, startDate, words(target.position_title), positionTitle ?? words(target.position_title), target.branch_id, branchId,
        knownDepartment(target.primary_department_id), knownDepartment(departmentId),
        `Onboard again (from a folded profile) from ${startDate}` + (lastDay ? `; the earlier contract ended on its last working day ${lastDay}` : ""),
        active?.id ?? null, input.actorId,
      ],
    );
    const { rows: names } = await client.query<{ department: string | null; branch: string | null }>(
      "select (select name from departments where id = $1) as department, (select name from branches where id = $2) as branch",
      [departmentId, branchId],
    );
    reonboarded = {
      engagementId,
      startDate,
      started: !!started,
      department: { id: departmentId, name: names[0]?.department ?? null },
      branch: { id: branchId, name: names[0]?.branch ?? null },
      positionTitle,
      employmentBasis: duplicate.employment_basis,
      probationEndDate: duplicate.probation_end_day,
      contractId: active?.id ?? null,
      login: started?.login ?? null,
      platformDeactivationDelivered: started?.platformDeactivationDelivered ?? false,
    };
  }

  const movedOnly = (side: keyof Moved, n: number) => (side === "moved" ? n : 0);
  const counted = (side: keyof Moved): FoldCounts => ({
    shifts: shifts[side],
    duties: duties[side],
    breaks: breaks[side],
    templateShifts: templateShifts[side],
    roles: roles[side],
    checklists: checklists[side],
    tasks: tasks[side],
    contracts: movedOnly(side, contracts),
    timeRecords: movedOnly(side, timeRecords),
    documents: movedOnly(side, files.documents),
    letters: movedOnly(side, files.letters),
    assets: movedOnly(side, files.assets),
    timeOff: timeOff[side],
    availability: availability[side],
    leaveSettings: movedOnly(side, onePerProfile.leaveSettings),
    payrollProfile: movedOnly(side, onePerProfile.payrollProfile),
    costAllocations: movedOnly(side, onePerProfile.costAllocations),
    history: movedOnly(side, history),
  });
  const moved = counted("moved");
  const skipped = counted("skipped");

  // Anything else still pointing at the duplicate, every table named in plain
  // words before the delete's foreign keys would name only the first.
  const linked = await linksBeyondEmployeeDelete(client, from);
  if (linked.length > 0) {
    const words = linked.map((l) => l.words);
    return {
      folded: false,
      status: 409,
      reason: "still_referenced",
      message: `This profile is still linked by ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0]}, ` +
        "which a fold does not move, so nothing was folded. Move those to the profile kept, or remove them, first.",
      blocking: linked.map((l) => ({ label: `still linked by ${l.words}`, count: l.count })),
    };
  }

  const deletion = await deleteEmployeeWithin(client, {
    employeeId: from,
    tenantId,
    personId: input.deletion.personId,
    leavingUserId: input.deletion.leavingUserId,
  });
  if (!deletion.deleted) return refusalOf(deletion);

  // The original's own record of what came onto it. No names: the counts and the folded id.
  const lastDay = target.last_day;
  const { replaced } = onePerProfile;
  const replacedWords = (Object.keys(replaced) as (keyof FoldReplaced)[])
    .filter((k) => replaced[k] > 0)
    .map((k) => `${replaced[k]} ${LABEL_ONE_PER_PROFILE[k]}`)
    .join(", ");
  await client.query(
    `insert into activity_log (tenant_id, branch_id, employee_id, activity_type, summary_text, metadata_json, created_by)
     values ($1, $2, $3, 'employee_updated', $4, $5, $6)`,
    [
      tenantId,
      reonboarded?.started ? reonboarded.branch.id : target.branch_id,
      to,
      `A duplicate profile was folded into this one: ${moved.contracts} contract(s), ${moved.timeRecords} time record(s), ` +
        `${moved.shifts} shift(s) with ${moved.duties} duty block(s) and ${moved.breaks} break(s), ` +
        `${moved.templateShifts} weekly template shift(s), ${moved.roles} role(s), ${moved.checklists} checklist(s) and ${moved.tasks} task(s) moved` +
        `, with ${moved.documents} document(s), ${moved.letters} letter(s), ${moved.assets} asset(s), ${moved.timeOff} leave record(s), ` +
        `${moved.availability} availability day(s), ${moved.leaveSettings} leave setting(s), ${moved.payrollProfile} payroll profile(s), ` +
        `${moved.costAllocations} cost allocation(s) and ${moved.history} history entr(ies)` +
        (orgChart.moved + orgChart.dropped > 0
          ? `; ${orgChart.moved} org chart entr(ies) taken, ${orgChart.dropped} dropped where this profile already had its entry`
          : "") +
        (replacedWords ? `; its own ${replacedWords} replaced by the folded profile's` : "") +
        (clockedOnBoth > 0 ? `; ${clockedOnBoth} day(s) have time records from both profiles, to be checked` : "") +
        (supersededContracts > 0
          ? `; its own active contract superseded by the folded profile's${lastDay ? `, ended on its last working day ${lastDay}` : ""}`
          : "") +
        (face === "taken" ? "; the folded profile's face enrolment taken" : "") +
        (face === "original_kept" ? "; this profile keeps its own face enrolment, the folded profile's is removed from the face collection" : "") +
        (reonboarded
          ? reonboarded.started
            ? `; onboarded again (from a folded profile) from ${reonboarded.startDate}`
            : `; onboard again (from a folded profile) planned from ${reonboarded.startDate}`
          : ""),
      JSON.stringify({
        foldedProfileId: from,
        moved,
        skipped,
        face,
        ...(faceToRemove ? { foldedFaceId: faceToRemove } : {}),
        supersededContracts,
        replaced,
        clockedOnBoth,
        orgChartMoved: orgChart.moved,
        orgChartDropped: orgChart.dropped,
        ...(reonboarded ? { engagementId: reonboarded.engagementId, started: reonboarded.started } : {}),
      }),
      input.actorId,
    ],
  );
  return {
    folded: true,
    moved,
    skipped,
    face,
    faceToRemove,
    supersededContracts,
    replaced,
    clockedOnBoth,
    orgChartMoved: orgChart.moved,
    orgChartDropped: orgChart.dropped,
    reonboard: reonboarded,
    deleted: { profile: 1, login: input.deletion.leavingUserId ? 1 : 0 },
  };
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
