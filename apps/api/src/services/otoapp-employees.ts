import { sql } from 'drizzle-orm';
import { OtoAppSeamNotGrantedError } from './otoapp-events';
import type { Exec } from './tx';

/**
 * THE PLATFORM'S ONLY WINDOW ON THE OTO APP'S STAFF — read-only (S2-17b round
 * 2; PLAN section 5, conflict C13).
 *
 * The OTO App is the employee master. The platform reads its staff through
 * the one view the app's own migrator publishes for them, `otoapp_v.employees`
 * (`apps/oto-app/migrations/0005_otoapp_v_employees.sql`), and never names the
 * app's HR tables: beside the events repository (`otoapp-events.ts`), this is
 * the only file in `src` that may name `otoapp_v`, and the section D grep
 * (`test/g17-round0-review.test.ts`) and the H1 grep
 * (`test/otoapp-events-seam.test.ts`) hold every other file to that by
 * reading the source.
 *
 * Two readers, one rule. The copy into `core.employee`
 * (`otoapp-employee-sync.ts`) and the booth's day roster (`booth-duty.ts`)
 * both take a person's platform account from `platform_user_id` here — the
 * app's own user-to-employee rule, applied once, inside the view — so the two
 * can never name two accounts for one person (H24).
 *
 * WHAT IS NOT FENCED HERE, said plainly. The view answers for every park group,
 * because the copy has to decide each park group's operator itself (the anchor
 * rule). The account a row names may belong to any operator — the app's email
 * match crosses park groups — and whether it counts is the caller's question,
 * answered against the operator the row's park group is anchored to (H23).
 *
 * A deployment without the OTO App, or with an app whose migrator has not
 * reached 0005, has no `otoapp_v.employees`: every read here answers empty and
 * `otoAppEmployeesInstalled` says false. A deployment that HAS the view but has
 * not granted this role USAGE on `otoapp_v` and SELECT on it is not answered
 * empty — that would read as "everybody has left" — and gets an
 * `OtoAppSeamNotGrantedError` naming the missing grant instead.
 */

export interface AppEmployee {
  /** The OTO App's id: `core.employee.external_id` on a copied row. */
  id: string;
  /** The app's park group. */
  tenantId: string;
  /** The app's own branch id, or null. */
  otoappBranchId: string | null;
  /** The platform branch that app branch is mapped to, or null. */
  branchId: string | null;
  fullName: string;
  nickname: string;
  /** E.164, as the app keeps it. */
  phone: string | null;
  email: string;
  /** pending, active, resigned or terminated. */
  status: string;
  /** ACTIVE, LEAVING or LEFT. */
  employmentState: string;
  lastWorkingDay: Date | null;
  updatedAt: Date;
  /** The platform account the app's own rule links to this employee, or null. */
  platformUserId: string | null;
}

const VIEW = 'otoapp_v.employees';

/**
 * Is the employee seam on this database, and may this role read it? Asked
 * through catalog functions only, so the check itself never raises (see
 * `otoAppEventsInstalled`).
 */
export async function otoAppEmployeesInstalled(exec: Exec): Promise<boolean> {
  const schema = await exec.execute<{ usage: boolean | null }>(
    sql`select has_schema_privilege(to_regnamespace('otoapp_v')::oid, 'USAGE') as usage`,
  );
  const usage = schema.rows[0]?.usage ?? null;
  if (usage === null) return false;
  if (!usage) throw new OtoAppSeamNotGrantedError(['USAGE on schema otoapp_v']);
  const view = await exec.execute<{ readable: boolean | null }>(
    sql`select has_table_privilege(to_regclass(${VIEW})::oid, 'SELECT') as readable`,
  );
  const readable = view.rows[0]?.readable ?? null;
  // The schema without this view: an app whose migrator has not reached 0005.
  if (readable === null) return false;
  if (!readable) throw new OtoAppSeamNotGrantedError([`SELECT on ${VIEW}`]);
  return true;
}

type Row = {
  id: string;
  tenant_id: string;
  otoapp_branch_id: string | null;
  branch_id: string | null;
  full_name: string;
  nickname: string;
  phone: string | null;
  email: string;
  status: string;
  employment_state: string;
  last_working_day: Date | string | null;
  updated_at: Date | string;
  platform_user_id: string | null;
};

const COLUMNS = sql.raw(`id, tenant_id::text as tenant_id, otoapp_branch_id, branch_id::text as branch_id,
  full_name, nickname, phone, email, status, employment_state, last_working_day, updated_at,
  platform_user_id::text as platform_user_id`);

const instant = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

const toEmployee = (r: Row): AppEmployee => ({
  id: r.id,
  tenantId: r.tenant_id,
  otoappBranchId: r.otoapp_branch_id,
  branchId: r.branch_id,
  fullName: r.full_name,
  nickname: r.nickname,
  phone: r.phone,
  email: r.email,
  status: r.status,
  employmentState: r.employment_state,
  lastWorkingDay: instant(r.last_working_day),
  updatedAt: new Date(r.updated_at),
  platformUserId: r.platform_user_id,
});

/** Every employee the app holds, in every park group, by id. Empty where there is no seam. */
export async function listAppEmployees(exec: Exec): Promise<AppEmployee[]> {
  if (!(await otoAppEmployeesInstalled(exec))) return [];
  const res = await exec.execute<Row>(sql`select ${COLUMNS} from otoapp_v.employees order by id`);
  return res.rows.map(toEmployee);
}

/** Some employees by the app's id; an id the app does not hold has no row. */
export async function listAppEmployeesByIds(
  exec: Exec,
  ids: readonly string[],
): Promise<AppEmployee[]> {
  const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  if (wanted.length === 0) return [];
  if (!(await otoAppEmployeesInstalled(exec))) return [];
  const res = await exec.execute<Row>(sql`
    select ${COLUMNS}
      from otoapp_v.employees
     where id in (${sql.join(
       wanted.map((id) => sql`${id}`),
       sql`, `,
     )})
     order by id`);
  return res.rows.map(toEmployee);
}
