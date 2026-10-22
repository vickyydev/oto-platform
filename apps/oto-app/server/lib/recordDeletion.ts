import type { Pool, PoolClient } from "pg";
import { deleteManagedUserWithin } from "./userDeletion";

/**
 * Whole-or-nothing deletes for the records whose delete used to run as a row
 * of separate statements (SCRUM-542): an employee, a person (an advisor), and
 * a branch. Each one
 *
 *  - opens ONE transaction and locks the record;
 *  - counts what must never be deleted with it (an employee's contracts, time
 *    and payroll records; an advisor's attendance; a branch's employees,
 *    contracts, template assignments and shifts) and, when anything is found,
 *    rolls back and answers a 409 naming it, so nothing is written;
 *  - only then deletes the login leaving with it (SCRUM-547): the record's own
 *    links to that login are cleared first, so they never hold it back, and
 *    the login goes through the one gate every user delete uses — whose
 *    refusal (a platform-linked login, or one something else still points at)
 *    is then the answer, and only ever about the login itself;
 *  - otherwise deletes what goes with the record and the record, and commits;
 *  - and if anything still refuses on a foreign key part-way, rolls the whole
 *    transaction back and answers a 409 naming what still points at it, so a
 *    refusal never leaves a half-deleted record behind.
 *
 * Plain `pg` and unqualified table names, like userDeletion.ts: the pool
 * carries `search_path=otoapp`.
 */

export interface Blocker {
  /** e.g. "contract" / "contracts". */
  singular: string;
  plural: string;
  count: number;
}

export type RecordDeletionOutcome =
  | { deleted: true; removed?: Record<string, number> }
  | { deleted: false; status: 404; message: string }
  | {
      deleted: false;
      status: 409;
      message: string;
      reason: "has_records" | "linked_to_platform" | "still_referenced";
      blocking?: { label: string; count: number }[];
    };

const FOREIGN_KEY_VIOLATION = "23503";

/** Plain words for a table a foreign-key refusal names. */
const TABLE_WORDS: Record<string, string> = {
  activity_log: "activity history",
  attention_items: "attention items",
  beo_party_host_assignments: "party host assignments",
  checklist_templates: "checklist templates",
  checklist_template_assignees: "checklist assignments",
  checklist_runs: "checklist runs",
  contract_instances: "contracts",
  core_events: "events",
  employees: "employees",
  employee_assets: "assets",
  employee_documents: "documents",
  // The leave catalogue's rows cascade with the employee, the type and the park
  // group (migration 0018), so they never block a delete; named for completeness.
  employee_leave_balance_openings: "opening leave balances",
  employee_leave_overrides: "leave overrides",
  employee_letters: "letters",
  employee_offboarding: "offboarding records",
  employee_time_off: "leave records",
  fix_reports: "fix reports",
  kiosk_auth_attempts: "clock-in records",
  kiosk_devices: "kiosk devices",
  leave_types: "leave types",
  nanny_reservations: "nanny reservations",
  org_nodes: "the org chart",
  service_checkins: "check-ins",
  shifts: "shifts",
  tasks: "tasks",
  template_assignments: "contract template assignments",
  time_entries: "time records",
  time_events: "clock-in records",
  user_branch_access: "user branch access",
  user_vouchers: "vouchers",
};

export const tableWords = (table: string | undefined): string =>
  (table && TABLE_WORDS[table]) || (table ? table.replace(/_/g, " ") : "other records");

/** "2 contracts, 14 time records and 1 payroll record". */
export function listBlockers(blockers: Blocker[]): string {
  const parts = blockers.map((b) => `${b.count} ${b.count === 1 ? b.singular : b.plural}`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

async function countOf(client: Pick<PoolClient, "query">, tables: string[], column: string, id: string): Promise<number> {
  const union = tables.map((t) => `select count(*)::int as n from ${t} where ${column} = $1`).join(" union all ");
  const { rows } = await client.query<{ n: number }>(`select coalesce(sum(n), 0)::int as n from (${union}) c`, [id]);
  return Number(rows[0]?.n ?? 0);
}

async function blockersOf(
  client: Pick<PoolClient, "query">,
  id: string,
  checks: { singular: string; plural: string; tables: string[]; column: string }[],
): Promise<Blocker[]> {
  const found: Blocker[] = [];
  for (const check of checks) {
    const count = await countOf(client, check.tables, check.column, id);
    if (count > 0) found.push({ singular: check.singular, plural: check.plural, count });
  }
  return found;
}

const asBlocking = (blockers: Blocker[]) => blockers.map((b) => ({ label: b.plural, count: b.count }));

/**
 * The login leaving with the record, deleted inside the transaction once
 * nothing the record keeps blocks it (SCRUM-547: blockers are named first), so
 * a refusal found after it takes the login's delete back too. Its refusal (a
 * platform-linked login, or one something else still points at) is the answer.
 */
async function leavingUserRefusal(client: Pick<PoolClient, "query">, userId: string | null): Promise<RecordDeletionOutcome | null> {
  if (!userId) return null;
  const user = await deleteManagedUserWithin(client, userId);
  return !user.deleted && user.status === 409
    ? { deleted: false, status: 409, message: user.message, reason: user.reason }
    : null;
}

/**
 * Runs `work` in one transaction. A refusal it returns rolls everything back;
 * a foreign-key refusal raised by Postgres part-way does too, and is answered
 * in words naming the table that still points at the record.
 */
async function inOneTransaction(
  pool: Pool,
  stillLinked: (table: string) => string,
  work: (client: PoolClient) => Promise<RecordDeletionOutcome>,
): Promise<RecordDeletionOutcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    let outcome: RecordDeletionOutcome;
    try {
      outcome = await work(client);
    } catch (err) {
      await client.query("rollback");
      const e = err as { code?: string; table?: string };
      if (e.code === FOREIGN_KEY_VIOLATION) {
        return { deleted: false, status: 409, message: stillLinked(tableWords(e.table)), reason: "still_referenced" };
      }
      throw err;
    }
    await client.query(outcome.deleted ? "commit" : "rollback");
    return outcome;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Employees ───────────────────────────────────────────────────────────────

/** What an employee delete refuses on: kept for the record, ended by offboarding. */
const EMPLOYEE_KEEPS = [
  { singular: "contract", plural: "contracts", tables: ["contract_instances"], column: "employee_id" },
  {
    singular: "time record",
    plural: "time records",
    tables: ["time_events", "time_entries", "time_adjustments", "timekeeping_issues"],
    column: "employee_id",
  },
  {
    singular: "payroll record",
    plural: "payroll records",
    tables: [
      "payroll_line_items",
      "payroll_employee_summaries",
      "payroll_day_reconciliations",
      "payroll_exceptions",
      "payslips",
      "salary_advances",
      "salary_advance_repayments",
      "statutory_calculation_results",
      // SCRUM-567: the company payroll's profile (ON DELETE RESTRICT) is kept for the record too.
      "payroll_profiles",
    ],
    column: "employee_id",
  },
];

export const EMPLOYEE_OFFBOARD_INSTEAD = "Their history is kept for the record; offboard them instead to end their employment.";

export async function deleteEmployeeWhole(
  pool: Pool,
  input: { employeeId: string; tenantId: string; personId: string | null; leavingUserId: string | null },
): Promise<RecordDeletionOutcome> {
  return inOneTransaction(
    pool,
    (what) => `This employee is still linked to ${what}, so nothing was deleted. ${EMPLOYEE_OFFBOARD_INSTEAD}`,
    async (client) => {
      const { rows } = await client.query<{ full_name: string }>(
        "select full_name from employees where id = $1 and tenant_id = $2 for update",
        [input.employeeId, input.tenantId],
      );
      const employee = rows[0];
      if (!employee) return { deleted: false, status: 404, message: "Employee not found" };

      // What the employee keeps is named first (SCRUM-547), so an employee
      // with a contract and a login hears about the contract.
      const blockers = await blockersOf(client, input.employeeId, EMPLOYEE_KEEPS);
      if (blockers.length > 0) {
        return {
          deleted: false,
          status: 409,
          reason: "has_records",
          message: `${employee.full_name} cannot be deleted: they have ${listBlockers(blockers)}. ${EMPLOYEE_OFFBOARD_INSTEAD}`,
          blocking: asBlocking(blockers),
        };
      }

      const id = input.employeeId;
      if (input.leavingUserId) {
        // The employee's own links to the login leaving with them (SCRUM-543
        // writes user_id and the policy's core_user_id at enable-login) must
        // not hold that login back; a refusal below still rolls them back.
        await client.query(
          `update employees set
             user_id = case when user_id = $2 then null else user_id end,
             updated_by = case when updated_by = $2 then null else updated_by end,
             profile_photo_updated_by = case when profile_photo_updated_by = $2 then null else profile_photo_updated_by end
           where id = $1`,
          [id, input.leavingUserId],
        );
        if (input.personId) {
          await client.query("update access_policies set core_user_id = null where person_id = $1 and core_user_id = $2", [
            input.personId,
            input.leavingUserId,
          ]);
        }
      }
      const userRefusal = await leavingUserRefusal(client, input.leavingUserId);
      if (userRefusal) return userRefusal;

      // History that names the employee keeps its rows, without the name.
      await client.query("update activity_log set employee_id = null where employee_id = $1", [id]);
      await client.query("update attention_items set employee_id = null where employee_id = $1", [id]);
      await client.query("update shifts set employee_id = null where employee_id = $1", [id]);
      // What belongs to the employee goes with them.
      await client.query(
        "delete from offboarding_checklist where employee_id = $1 or offboarding_id in (select id from employee_offboarding where employee_id = $1)",
        [id],
      );
      for (const table of [
        "employee_offboarding",
        "employee_changes",
        "employee_documents",
        "employee_letters",
        "employee_assets",
        "employee_time_off",
        "employee_roles",
        "employee_payroll_profiles",
        "enrollment_sessions",
        "kiosk_auth_attempts",
      ]) {
        await client.query(`delete from ${table} where employee_id = $1`, [id]);
      }
      await client.query("delete from employees where id = $1", [id]);

      // The person record (freeing its email for reuse) — unless another
      // employee row still carries it, which its cascade would take too.
      if (input.personId) {
        const others = await client.query("select 1 from employees where person_id = $1 limit 1", [input.personId]);
        if (others.rowCount === 0) {
          await client.query("delete from kiosk_auth_attempts where person_id = $1", [input.personId]);
          await client.query("delete from auth_reset_tokens where person_id = $1", [input.personId]);
          await client.query("delete from people where id = $1", [input.personId]);
        }
      }
      return { deleted: true };
    },
  );
}

// ─── People (advisors) ───────────────────────────────────────────────────────

export const ADVISOR_DEACTIVATE_INSTEAD = "Deactivate their login on the Users page instead.";

export async function deletePersonWhole(
  pool: Pool,
  input: { personId: string; leavingUserId: string | null },
): Promise<RecordDeletionOutcome> {
  return inOneTransaction(
    pool,
    (what) => `This person is still linked to ${what}, so nothing was deleted. ${ADVISOR_DEACTIVATE_INSTEAD}`,
    async (client) => {
      const { rows } = await client.query<{ full_name: string | null; email: string }>(
        "select full_name, email from people where id = $1 for update",
        [input.personId],
      );
      const person = rows[0];
      if (!person) return { deleted: false, status: 404, message: "Person not found" };
      const name = person.full_name || person.email;

      // What the person keeps is named first, then the login (SCRUM-547).
      // An employee record goes by the person's cascade; it is never deleted
      // from here.
      const employeeRows = await countOf(client, ["employees"], "person_id", input.personId);
      if (employeeRows > 0) {
        return {
          deleted: false,
          status: 409,
          reason: "has_records",
          message: `${name} has an employee record, so they cannot be deleted here. Delete or offboard them from Employees instead.`,
          blocking: [{ label: "employee records", count: employeeRows }],
        };
      }
      const blockers = await blockersOf(client, input.personId, [
        { singular: "attendance session", plural: "attendance sessions", tables: ["advisor_attendance_sessions"], column: "person_id" },
        { singular: "clock-in record", plural: "clock-in records", tables: ["kiosk_auth_attempts"], column: "person_id" },
      ]);
      if (blockers.length > 0) {
        return {
          deleted: false,
          status: 409,
          reason: "has_records",
          message: `${name} cannot be deleted: they have ${listBlockers(blockers)}, which are kept for the record. ${ADVISOR_DEACTIVATE_INSTEAD}`,
          blocking: asBlocking(blockers),
        };
      }

      if (input.leavingUserId) {
        // The person's own policy link to the login leaving with them.
        await client.query("update access_policies set core_user_id = null where person_id = $1 and core_user_id = $2", [
          input.personId,
          input.leavingUserId,
        ]);
      }
      const userRefusal = await leavingUserRefusal(client, input.leavingUserId);
      if (userRefusal) return userRefusal;

      await client.query("delete from auth_reset_tokens where person_id = $1", [input.personId]);
      // Access policy and face enrolment go by the person's cascade.
      await client.query("delete from people where id = $1", [input.personId]);
      return { deleted: true };
    },
  );
}

// ─── Branches ────────────────────────────────────────────────────────────────

/** What a branch delete refuses on. Its rota (week plans, shift groups and rows, schedule templates, duty blocks) goes with it. */
const BRANCH_KEEPS = [
  { singular: "employee", plural: "employees", tables: ["employees"], column: "branch_id" },
  { singular: "contract", plural: "contracts", tables: ["contract_instances"], column: "branch_id" },
  { singular: "contract template assignment", plural: "contract template assignments", tables: ["template_assignments"], column: "branch_id" },
  { singular: "shift", plural: "shifts", tables: ["shifts"], column: "branch_id" },
];

export async function deleteBranchWhole(pool: Pool, input: { branchId: string; tenantId: string }): Promise<RecordDeletionOutcome> {
  return inOneTransaction(
    pool,
    (what) => `This branch is still used by ${what}, so nothing was deleted. Move or remove those first.`,
    async (client) => {
      const { rows } = await client.query<{ name: string }>(
        "select name from branches where id = $1 and tenant_id = $2 for update",
        [input.branchId, input.tenantId],
      );
      const branch = rows[0];
      if (!branch) return { deleted: false, status: 404, message: "Branch not found" };

      const blockers = await blockersOf(client, input.branchId, BRANCH_KEEPS);
      if (blockers.length > 0) {
        return {
          deleted: false,
          status: 409,
          reason: "has_records",
          message: `${branch.name} cannot be deleted: it still has ${listBlockers(blockers)}. Move or remove those first.`,
          blocking: asBlocking(blockers),
        };
      }
      // Counted before the cascade takes them, so the answer can say what went.
      const removed = {
        weekPlans: await countOf(client, ["schedule_week_plans"], "branch_id", input.branchId),
        shiftRows: await countOf(client, ["schedule_shift_rows"], "branch_id", input.branchId),
        scheduleTemplates: await countOf(client, ["schedule_templates"], "branch_id", input.branchId),
      };
      await client.query("delete from branches where id = $1", [input.branchId]);
      return { deleted: true, removed };
    },
  );
}
