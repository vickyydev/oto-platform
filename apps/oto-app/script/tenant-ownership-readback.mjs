/**
 * The tenant ownership read-back (S2-17b round 4a; plan section 7, hazard H10,
 * and the root-table census).
 *
 * Two questions, against the database the app runs on:
 *
 *  1. Did migration 0006 place every row? For `settings`, `activity_log` and
 *     `attention_items`: how many rows each park group holds, and how many
 *     hold none. A row with no park group is one the previous release wrote
 *     during the hand-over; round 4b's migration 0007 runs 0006's backfill
 *     again over them, refuses to go on while any is left, and then sets NOT
 *     NULL. Also: which uniques `settings` carries (both in 4a; the new one
 *     alone after 0007), whether `tenant_id` is NOT NULL yet, whether any key
 *     is held twice, and whether any activity row's park group disagrees with
 *     its branch's.
 *  2. The root-table census: the six tables with no tenant column of their
 *     own, each counted through the parent that carries one (or, for `people`,
 *     the children that do), so the written dispositions in the plan can be
 *     checked against live rows.
 *
 * READ ONLY. It runs inside a `read only` transaction and writes nothing. It
 * prints counts and park group names, never a person's name, email or phone.
 *
 * Plain JavaScript for the same reason as migrate.mjs: the runtime image has no
 * tsx, and this has to run there, as the app's own database role.
 *
 * Usage, from apps/oto-app, with DATABASE_URL pointing at the database to read:
 *   npm run tenant:readback
 *
 * The 4b gate in plain SQL, for a psql read-back:
 *   select 'settings' as t, count(*) filter (where tenant_id is null) from otoapp.settings
 *   union all select 'activity_log', count(*) filter (where tenant_id is null) from otoapp.activity_log
 *   union all select 'attention_items', count(*) filter (where tenant_id is null) from otoapp.attention_items;
 *
 * Exits 0 when every row has its park group, 1 when a row has none (or the
 * columns are not there yet), 2 when it could not ask.
 */
import pg from "pg";

const SCHEMA = "otoapp";

if (!process.env.DATABASE_URL) {
  console.error("tenant-ownership-readback: DATABASE_URL is not set.");
  process.exit(2);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  application_name: "oto-app-tenant-readback",
});

const q = async (text, params = []) => (await client.query(text, params)).rows;
const n = (v) => Number(v ?? 0);

async function main() {
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set transaction read only");
    await client.query(`set local search_path to ${SCHEMA}`);

    const installed = await q(
      `select table_name, column_name from information_schema.columns
        where table_schema = $1 and table_name in ('settings', 'activity_log', 'attention_items')
          and column_name = 'tenant_id'`,
      [SCHEMA],
    );
    const tables = (await q(
      `select count(*)::int as n from information_schema.tables where table_schema = $1 and table_name = 'settings'`,
      [SCHEMA],
    ))[0].n;
    if (tables === 0) {
      console.log("Tenant ownership read-back: the OTO App is not installed on this database (no otoapp.settings).");
      return 0;
    }
    if (installed.length < 3) {
      console.log(
        `Tenant ownership read-back: migration 0006 has not run here — ${installed.length} of the 3 tenant_id columns exist.`,
      );
      return 1;
    }

    const parkGroups = new Map(
      (await q("select id, name, slug from tenants order by created_at, name")).map((t) => [t.id, t]),
    );
    const label = (id) => {
      if (!id) return "(no park group)";
      const t = parkGroups.get(id);
      return t ? `${t.name} [${t.slug}]` : `${id} (not in tenants)`;
    };
    // The app's rule (getDefaultParkGroupId, 0006): slug `default`, else the only park group.
    const defaultParkGroup =
      [...parkGroups.values()].find((t) => t.slug === "default") ??
      (parkGroups.size === 1 ? [...parkGroups.values()][0] : undefined);
    console.log(
      `Tenant ownership read-back — ${parkGroups.size} park group${parkGroups.size === 1 ? "" : "s"}; ` +
        `default park group: ${defaultParkGroup ? label(defaultParkGroup.id) : "NONE"}.`,
    );

    // 1. Every row placed?
    let unplaced = 0;
    for (const table of ["settings", "activity_log", "attention_items"]) {
      const rows = await q(`select tenant_id, count(*)::int as n from ${table} group by tenant_id order by 2 desc`);
      const total = rows.reduce((sum, r) => sum + r.n, 0);
      const none = rows.find((r) => r.tenant_id === null)?.n ?? 0;
      unplaced += none;
      console.log(`\n${table}: ${total} row${total === 1 ? "" : "s"}, ${none} with no park group.`);
      for (const r of rows) console.log(`  ${String(r.n).padStart(7)}  ${label(r.tenant_id)}`);
    }

    const uniques = (
      await q(
        `select indexname from pg_indexes where schemaname = $1 and tablename = 'settings'
            and indexname in ('settings_key_unique', 'settings_tenant_id_key_unique') order by 1`,
        [SCHEMA],
      )
    ).map((r) => r.indexname);
    const shape =
      uniques.length === 2
        ? "both uniques (round 4a: only the default park group saves settings)"
        : uniques.includes("settings_tenant_id_key_unique")
          ? "(tenant_id, key) alone (round 4b: every park group saves its own)"
          : `UNEXPECTED: ${uniques.join(", ") || "neither unique"}`;
    console.log(`\nsettings uniques: ${shape}.`);
    const notNull = await q(
      `select table_name, is_nullable from information_schema.columns
        where table_schema = $1 and column_name = 'tenant_id'
          and table_name in ('settings', 'activity_log', 'attention_items') order by 1`,
      [SCHEMA],
    );
    console.log(
      `tenant_id NOT NULL (round 4b, 0007): ${notNull.map((c) => `${c.table_name} ${c.is_nullable === "NO" ? "yes" : "no"}`).join(", ")}.`,
    );
    const twice = n((await q(
      `select count(*) as n from (select tenant_id, key from settings group by 1, 2 having count(*) > 1) d`,
    ))[0].n);
    console.log(`settings keys held twice by one park group: ${twice}.`);
    const disagree = n((await q(
      `select count(*) as n from activity_log a join branches b on b.id = a.branch_id
        where a.tenant_id is not null and a.tenant_id <> b.tenant_id`,
    ))[0].n);
    console.log(`activity rows whose park group is not their branch's: ${disagree}.`);

    // 2. The root-table census.
    console.log("\nThe root-table census (no tenant column of their own):");
    const census = [
      [
        "leave_policies",
        `select coalesce(b.tenant_id::text, '(no branch: shared by every park group)') as k, count(*)::int as n
           from leave_policies p left join branches b on b.id = p.branch_id group by 1 order by 2 desc`,
      ],
      [
        "coverage_rules",
        `select b.tenant_id::text as k, count(*)::int as n
           from coverage_rules r join branches b on b.id = r.branch_id group by 1 order by 2 desc`,
      ],
      [
        "invitation_designs",
        `select e.tenant_id::text as k, count(*)::int as n
           from invitation_designs d join core_events e on e.id = d.event_id group by 1 order by 2 desc`,
      ],
      [
        "i18n_translations",
        `select f.tenant_id::text as k, count(*)::int as n
           from i18n_translations t join dropoff_form_versions v on v.id = t.version_id
           join dropoff_forms f on f.id = v.form_id group by 1 order by 2 desc`,
      ],
      [
        "package_line_item_templates",
        `select p.tenant_id::text as k, count(*)::int as n
           from package_line_item_templates i join birthday_package_templates p on p.id = i.package_template_id
          group by 1 order by 2 desc`,
      ],
    ];
    for (const [table, sql] of census) {
      const rows = await q(sql);
      const total = rows.reduce((sum, r) => sum + r.n, 0);
      console.log(`  ${table}: ${total}`);
      for (const r of rows) console.log(`    ${String(r.n).padStart(7)}  ${parkGroups.has(r.k) ? label(r.k) : r.k}`);
    }
    const people = (await q(
      `with placed as (
         select p.id,
                (select count(distinct t) from (
                   select a.tenant_id as t from access_policies a where a.person_id = p.id
                   union select e.tenant_id from employees e where e.person_id = p.id) x) as groups
           from people p)
       select count(*)::int as total,
              count(*) filter (where groups = 1)::int as one,
              count(*) filter (where groups = 0)::int as none,
              count(*) filter (where groups > 1)::int as several
         from placed`,
    ))[0];
    console.log(
      `  people: ${people.total} — ${people.one} placed in one park group by their access policy or employee rows, ` +
        `${people.none} in none, ${people.several} in more than one.`,
    );

    await client.query("rollback");
    if (unplaced > 0) {
      console.log(
        `\n${unplaced} row${unplaced === 1 ? " has" : "s have"} no park group: migration 0007 (round 4b) runs 0006's backfill again over them before NOT NULL.`,
      );
      return 1;
    }
    console.log("\nEvery settings, activity and attention row has its park group.");
    return 0;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`tenant-ownership-readback could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
