import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './index';

/**
 * SCRUM-1024 — THE FAMILY CHECKS (plan step F2, "V1" in section 3 of
 * `docs/progress/plans/dropoff-beo-20261119/FAMILY_PROFILES_PLAN.md`).
 *
 * Read only. Five counts, each of which must be zero after the backfill and
 * before any reader is switched to the family (plan step R1). The command
 * line is `scripts/family-verify.ts`, which exits non-zero when any count is
 * above zero; the runbook is `FAMILY_BACKFILL_RUNBOOK.md` beside the plan.
 *
 *   1. children with no family;
 *   2. live families with no live guardian. An archived family is left out:
 *      linking two records (plan section 4.1, step F5) archives the second
 *      family together with its guardian row, so it rightly has none;
 *   3. children whose family's live guardians are not exactly the child's
 *      own member (`child.member_id`): true of every family the backfill and
 *      the writers make, until a second parent is added (step F4);
 *   4. rows whose family, guardian member and child member disagree on the
 *      operator: a guardian row whose family or member is another
 *      operator's, and a child whose family is not its member's operator's;
 *   5. members who are a live guardian of more than one live family. Not one
 *      of the plan's four: it is the fault the writers' lock and the
 *      backfill's reuse of a member's own family exist to prevent, and checks
 *      1 to 4 cannot see it (two families of one member, each holding only
 *      that member, with the children split between them, pass all four).
 *      Zero until a second parent can be added (step F4), after which a
 *      member may rightly be in several and this check is retired.
 *
 * Archived members and archived children are counted like any other: the
 * column is to be made NOT NULL (step C1) over every row. Each check lists a
 * few row ids beside its count, never a name or a number.
 */

export const FAMILY_VERIFY_CHECKS = [
  { key: 'children_without_family', label: 'children with no family' },
  { key: 'families_without_guardian', label: 'live families with no live guardian' },
  {
    key: 'children_not_own_guardian',
    label: "children whose family's live guardians are not exactly the child's own member",
  },
  {
    key: 'operator_mismatch',
    label: 'rows whose family, guardian member and child member disagree on the operator',
  },
  {
    key: 'members_in_several_families',
    label: 'members who are a live guardian of more than one live family (until step F4)',
  },
] as const;

export type FamilyVerifyKey = (typeof FAMILY_VERIFY_CHECKS)[number]['key'];

export interface FamilyVerifyCheck {
  key: FamilyVerifyKey;
  label: string;
  count: number;
  /** Up to `sample` offending rows, as "<table> <id>". */
  samples: string[];
}

export interface FamilyVerifyReport {
  checks: FamilyVerifyCheck[];
  /** Every count is zero. */
  ok: boolean;
}

type Exec = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Each check as one query of offending rows: `tbl` and `id`. */
const OFFENDERS: Record<FamilyVerifyKey, SQL> = {
  children_without_family: sql`
    select 'crm.child' as tbl, c.id from crm.child c where c.family_id is null`,
  families_without_guardian: sql`
    select 'crm.family' as tbl, f.id from crm.family f
     where f.archived_at is null
       and not exists (select 1 from crm.family_guardian g where g.family_id = f.id and g.archived_at is null)`,
  children_not_own_guardian: sql`
    select 'crm.child' as tbl, c.id from crm.child c
     where c.family_id is not null
       and (not exists (select 1 from crm.family_guardian g
                         where g.family_id = c.family_id and g.archived_at is null and g.member_id = c.member_id)
            or exists (select 1 from crm.family_guardian g
                        where g.family_id = c.family_id and g.archived_at is null and g.member_id <> c.member_id))`,
  operator_mismatch: sql`
    select 'crm.family_guardian' as tbl, g.id from crm.family_guardian g
      join crm.family f on f.id = g.family_id
      join crm.member m on m.id = g.member_id
     where f.operator_id <> g.operator_id or m.operator_id <> g.operator_id
    union all
    select 'crm.child' as tbl, c.id from crm.child c
      join crm.family f on f.id = c.family_id
      join crm.member m on m.id = c.member_id
     where f.operator_id <> m.operator_id`,
  members_in_several_families: sql`
    select 'crm.member' as tbl, g.member_id as id from crm.family_guardian g
      join crm.family f on f.id = g.family_id
     where g.archived_at is null and f.archived_at is null
     group by g.member_id
    having count(distinct g.family_id) > 1`,
};

/** Run the five checks. Read only; safe on a live database at any time. */
export async function verifyFamilies(exec: Exec, opts: { sample?: number } = {}): Promise<FamilyVerifyReport> {
  const sample = Math.max(0, Math.floor(opts.sample ?? 20));
  const checks: FamilyVerifyCheck[] = [];
  for (const { key, label } of FAMILY_VERIFY_CHECKS) {
    const offenders = OFFENDERS[key];
    const counted = await exec.execute<{ n: number }>(sql`select count(*)::int as n from (${offenders}) o`);
    const count = counted.rows[0]?.n ?? 0;
    const samples =
      count > 0 && sample > 0
        ? (
            await exec.execute<{ tbl: string; id: string }>(
              sql`select o.tbl, o.id from (${offenders}) o order by o.tbl, o.id limit ${sample}`,
            )
          ).rows.map((r) => `${r.tbl} ${r.id}`)
        : [];
    checks.push({ key, label, count, samples });
  }
  return { checks, ok: checks.every((c) => c.count === 0) };
}
