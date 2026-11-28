import { sql } from 'drizzle-orm';
import type { Db } from '@oto/db';

/** The HR migration exposes the default booth rate only. Personal payroll rates stay in HR. */
export async function currentBoothBonus(db: Db, branchId: string, day: string) {
  const schema = await db.execute(sql`select has_schema_privilege(to_regnamespace('otoapp_v')::oid,'usage') as ok`);
  if (schema.rows[0]?.ok !== true) return null;
  const grant = await db.execute(
    sql`select has_table_privilege(to_regclass('otoapp_v.booth_bonus_rules'),'select') as ok`,
  );
  if (grant.rows[0]?.ok !== true) return null;
  const value =
    await db.execute(sql`select rate_satang as rate, redemption_window as window, effective_from::text as start
    from otoapp_v.booth_bonus_rules where core_branch_id=${branchId} and effective_from<=${day}::date
    order by effective_from desc limit 1`);
  const row = value.rows[0];
  return row
    ? { rateSatang: Number(row.rate), window: String(row.window), from: String(row.start) }
    : null;
}
