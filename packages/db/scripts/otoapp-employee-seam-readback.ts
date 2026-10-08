/**
 * The OTO App employee seam read-back (S2-17b round 2): whether the role this
 * runs as — run it with the platform api's own DATABASE_URL — can read
 * `otoapp_v.employees`, and what the copy would read there.
 *
 * The app's migrator publishes the view (`apps/oto-app/migrations/
 * 0005_otoapp_v_employees.sql`) and grants nothing: the role names differ
 * between deployments, so the post-import step gives the platform's api role
 * USAGE on `otoapp_v` and SELECT on its views, never on the app's tables. A
 * role missing either makes `job:otoapp.employee_sync` fail loudly on
 * Failures rather than copy nobody; this says which grant is missing before
 * the job does.
 *
 * READ ONLY. It runs inside a `read only` transaction and writes nothing. It
 * prints counts, never a name, an email or a phone.
 *
 * Usage, with DATABASE_URL pointing at the database to read, as the api's role:
 *   pnpm --filter @oto/db exec tsx scripts/otoapp-employee-seam-readback.ts
 *
 * The same questions in plain SQL, for a psql read-back as that role:
 *   select current_user,
 *          has_schema_privilege(to_regnamespace('otoapp_v')::oid, 'USAGE') as usage,
 *          has_table_privilege(to_regclass('otoapp_v.employees')::oid, 'SELECT') as can_select;
 *   select employment_state, count(*), count(platform_user_id) as linked
 *     from otoapp_v.employees group by 1 order by 1;
 *
 * The grants, as an administrator, where they are missing:
 *   grant usage on schema otoapp_v to <api role>;
 *   grant select on otoapp_v.employees to <api role>;
 *
 * Exits 0 when the role reads the view, 1 when the view is absent or a grant
 * is missing, 2 when it could not ask.
 */
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '../src/index';

async function main(): Promise<number> {
  const db = getDb(process.env.DATABASE_URL, { max: 1, applicationName: 'oto-otoapp-employee-readback' });
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const who = await tx.execute<{
        role: string;
        usage: boolean | null;
        can_select: boolean | null;
      }>(sql`select current_user as role,
                    has_schema_privilege(to_regnamespace('otoapp_v')::oid, 'USAGE') as usage,
                    case when has_schema_privilege(to_regnamespace('otoapp_v')::oid, 'USAGE')
                         then has_table_privilege(to_regclass('otoapp_v.employees')::oid, 'SELECT') end as can_select`);
      const { role, usage, can_select: canSelect } = who.rows[0]!;
      if (usage === null) {
        console.log(`OTO App employee seam: no schema otoapp_v on this database (role ${role}).`);
        return 1;
      }
      if (!usage) {
        console.log(`OTO App employee seam: role ${role} lacks USAGE on schema otoapp_v.`);
        return 1;
      }
      if (canSelect === null) {
        console.log(
          `OTO App employee seam: otoapp_v has no employees view yet — run the OTO App's migrator (0005).`,
        );
        return 1;
      }
      if (!canSelect) {
        console.log(`OTO App employee seam: role ${role} lacks SELECT on otoapp_v.employees.`);
        return 1;
      }
      const counts = await tx.execute<{ state: string; n: number; linked: number; mapped: number }>(
        sql`select employment_state as state, count(*)::int as n,
                   count(platform_user_id)::int as linked, count(branch_id)::int as mapped
              from otoapp_v.employees group by 1 order by 1`,
      );
      const total = counts.rows.reduce((sum, r) => sum + r.n, 0);
      console.log(`OTO App employee seam: role ${role} reads otoapp_v.employees — ${total} employee(s).`);
      for (const r of counts.rows) {
        console.log(
          `  - ${r.state}: ${r.n} (${r.linked} linked to a platform account, ${r.mapped} at a mapped branch)`,
        );
      }
      return 0;
    });
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      `OTO App employee seam read-back could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  },
);
