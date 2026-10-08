/**
 * The offboarding duplicate census (S2-17b round 6; plan hazard H16, Q47, Q48).
 *
 * One offboarding per employee. Since the lift the route refuses a second one
 * (409, under a per-employee advisory lock), but the app it came from did not:
 * a double click on Offboard, or an employee set back to active and offboarded
 * again, made a second row with its own six checklist items. Migration 0008
 * adds the database's backstop — the unique index
 * `employee_offboarding_employee_unique` on employee_id — only where this same
 * count finds nobody with two; otherwise it leaves the index unmade and says so.
 *
 * This answers, against the database the app runs on:
 *   - how many offboarding rows there are, for how many employees;
 *   - every employee with more than one, by id (never a name), with their park
 *     group, how many rows, and each row's id, created_at and checklist count,
 *     so a person can settle them;
 *   - whether the unique index stands.
 *
 * The app has no "closed" state for an offboarding — every row stays the
 * employee's offboarding and the route reads the newest — so every row counts
 * as open here (Q47).
 *
 * READ ONLY: it runs inside a `read only` transaction and writes nothing.
 * Plain JavaScript (no tsx in the runtime image), so it runs from a
 * deployment's own shell as the app's database role:
 *   npm run offboarding:census
 *
 * In plain SQL, for a psql read-back:
 *   select employee_id, count(*) from otoapp.employee_offboarding
 *    group by employee_id having count(*) > 1;
 *
 * Exits 0 when no employee has two, 1 when one does, 2 when it could not ask.
 */
import pg from "pg";

const SCHEMA = "otoapp";

if (!process.env.DATABASE_URL) {
  console.error("offboarding-census: DATABASE_URL is not set.");
  process.exit(2);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  application_name: "oto-app-offboarding-census",
});
const q = async (text, params = []) => (await client.query(text, params)).rows;

async function main() {
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set transaction read only");
    await client.query(`set local search_path to ${SCHEMA}`);

    const present = (await q(
      `select count(*)::int as n from information_schema.tables where table_schema = $1 and table_name = 'employee_offboarding'`,
      [SCHEMA],
    ))[0].n;
    if (present === 0) {
      console.log("Offboarding census: the OTO App is not installed on this database (no otoapp.employee_offboarding).");
      return 0;
    }

    const totals = (await q(
      `select count(*)::int as rows, count(distinct employee_id)::int as employees from employee_offboarding`,
    ))[0];
    const index = (await q(
      `select count(*)::int as n from pg_indexes where schemaname = $1 and tablename = 'employee_offboarding'
          and indexname = 'employee_offboarding_employee_unique'`,
      [SCHEMA],
    ))[0].n === 1;
    const duplicates = await q(
      `select o.employee_id, e.tenant_id, t.name as park_group, count(*)::int as n,
              json_agg(json_build_object(
                'id', o.id,
                'created_at', o.created_at,
                'checklist', (select count(*) from offboarding_checklist c where c.offboarding_id = o.id)
              ) order by o.created_at) as rows
         from employee_offboarding o
         left join employees e on e.id = o.employee_id
         left join tenants t on t.id = e.tenant_id
        group by o.employee_id, e.tenant_id, t.name
       having count(*) > 1
        order by count(*) desc, o.employee_id`,
    );

    console.log(
      `Offboarding census — ${totals.rows} offboarding row${totals.rows === 1 ? "" : "s"} for ${totals.employees} employee${totals.employees === 1 ? "" : "s"}; ` +
        `${duplicates.length} employee${duplicates.length === 1 ? " has" : "s have"} more than one.`,
    );
    for (const d of duplicates) {
      console.log(`  employee ${d.employee_id} (${d.park_group ?? "no park group"}): ${d.n} offboardings`);
      for (const r of d.rows) console.log(`    ${r.id}  created ${new Date(r.created_at).toISOString()}  ${r.checklist} checklist item(s)`);
    }
    console.log(
      `employee_offboarding_employee_unique: ${index ? "stands (the database refuses a second offboarding)" : "NOT made"}` +
        (index ? "." : duplicates.length > 0
          ? " — migration 0008 left it for these employees to be settled first (plan Q48)."
          : " — migration 0008 has not run here, or ran while a duplicate stood; nothing stands in its way now."),
    );
    await client.query("rollback");
    return duplicates.length > 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`offboarding-census could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
