// SCRUM-945 / SCRUM-981 point 9: execute the actual migrated view, not a copied reader.
// All fixtures and DDL are rolled back, including controlled applied-0050 reproduction.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL;
assert.ok(url, "a migrated scratch database is required");
assert.equal(process.env.DB_SCHEMA, "otoapp", "use the app's scratch harness");
const pool = new pg.Pool({ connectionString: url, options: "-c search_path=otoapp", max: 1 });
const client = await pool.connect();
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await client.query<T>(sql, params)).rows;
const oldSql = readFileSync(new URL("../migrations/0050_otoapp_v_event_packages_kitchen_plan.sql", import.meta.url), "utf8");
const fixedSql = readFileSync(new URL("../migrations/0051_otoapp_set_audience_provenance.sql", import.meta.url), "utf8");
const original = process.env.S945_APPLIED_0050 === "1";
let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed += 1; console.log(`  ok ${name}`); }
  catch (error) { failed += 1; console.error(`  FAIL ${name}: ${String(error).slice(0, 850)}`); }
};

type InputLine = { id: string; itemName: string; quantity: number; source: string; notes: string; productCode?: string; groupId?: string; price?: number };
type PlanLine = { line_id: string | null; source: string; name: string; qty: number | null; chosen_option: string | null; product_code: string | null; audience?: string; adults_note?: string; unit_price_satang: number | null };
type Plan = { lines: PlanLine[] };
const run = randomUUID().replace(/-/g, "").slice(0, 10);
const schema = `zz_s945_${run}`;
const tenant = randomUUID();
const park = randomUUID();
const coreBranch = randomUUID();
const menu = randomUUID();
const foreignTenant = randomUUID();
const foreignMenu = randomUUID();
const FRIES = "s945-fries";
const A = "s945-main-a";
const B = "s945-main-b";
const items = [
  { id: FRIES, type: "always_included", label: "French fries", qty: 1, productCode: "CF-11" },
  { id: A, type: "choice_group", label: "Main A", options: ["Chicken", "Shrimp"], qty: 1, optionProductCodes: { Chicken: "CF-50", Shrimp: "CF-51" } },
  { id: B, type: "choice_group", label: "Main B", options: ["Chicken", "Veggie"], qty: 1, optionProductCodes: { Chicken: "CF-60", Veggie: "CF-61" } },
];
const line = (id: string, name: string, extra: Partial<InputLine> = {}): InputLine =>
  ({ id, itemName: name, quantity: 1, source: "extra", notes: "", ...extra });
const set = (id: string, name: string, groupId: string, extra: Partial<InputLine> = {}) => line(id, name, { source: "set_menu", groupId, ...extra });
async function fixture(kids: InputLine[], adults: InputLine[], over: { differ?: boolean; menuId?: string; tenantId?: string; parkId?: string } = {}) {
  const id = randomUUID();
  await q(`insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
    values ($1,$2,$3,'birthday',$4,'2099-12-01','14:00','16:00',2,1,'upcoming')`, [id, over.tenantId ?? tenant, over.parkId ?? park, `ZZ TEST 945 ${run}`]);
  const menus = { kids, adults, adultsDiffer: over.differ ?? true };
  await q(`insert into beo_kitchen_plans (id,event_id,set_menu_enabled,set_menu_template_id,menus,simplified_menus,cake_mode)
    values ($1,$2,true,$3,$4,$4,'NONE')`, [randomUUID(), id, over.menuId ?? menu, JSON.stringify(menus)]);
  return id;
}
async function plan(id: string) {
  const rows = await q<{ kitchen_plan: Plan }>("select kitchen_plan from otoapp_v.event_packages where event_id=$1", [id]);
  assert.equal(rows.length, 1);
  return rows[0]!.kitchen_plan.lines;
}
const base = (rows: PlanLine[], group: string) => {
  const name = group === FRIES ? "French fries" : group === A ? "Main A" : "Main B";
  const found = rows.find(l => l.source === "set_menu" && l.name === name);
  assert.ok(found, `base ${name}`);
  return found;
};

try {
  await q("begin");
  if (original) await q(oldSql);
  await q(`create schema ${schema}`);
  await q("insert into tenants (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenant, `ZZ TEST 945 ${run}`, `zz-945-${run}`, foreignTenant, `ZZ TEST 945 foreign ${run}`, `zz-945-other-${run}`]);
  await q("insert into branches (id,tenant_id,name,address,timezone,core_branch_id) values ($1,$2,'ZZ TEST 945','ZZ TEST','Asia/Bangkok',$3)", [park, tenant, coreBranch]);
  await q("insert into beo_set_menu_templates (id,tenant_id,name,items) values ($1,$2,'ZZ TEST 945',$3),($4,$5,'ZZ TEST 945 foreign',$6)", [menu, tenant, JSON.stringify(items), foreignMenu, foreignTenant, JSON.stringify([{ id: "foreign", type: "always_included", label: "FOREIGN MUST NOT APPEAR", qty: 8 }])]);

  await check("HIGH fixed: a kids EXTRA does not make the same-name fallback base SET kids-only", async () => {
    for (const source of ["extra", "additional"]) {
      const rows = await plan(await fixture([line("extra-fries", "French fries", { source, quantity: 2, productCode: "CF-11", price: 175 })], []));
      assert.equal(base(rows, FRIES).audience, undefined, source);
      const extra = rows.find(l => l.line_id === "extra-fries");
      assert.ok(extra);assert.equal(extra.audience, "kids");assert.equal(extra.qty, 2);assert.equal(extra.unit_price_satang, 17500);
    }
  });
  await check("CONTROL: an actual kids-only SET keeps its audience", async () => {
    const rows = await plan(await fixture([set("kids-set", "French fries", FRIES)], []));
    assert.equal(base(rows, FRIES).audience, "kids");
  });
  await check("HIGH fixed: an adults EXTRA cannot hide a real kids-only SET or lend it a note", async () => {
    for (const source of ["extra", "additional"]) {
      const rows = await plan(await fixture([set("kids-set", "French fries", FRIES)], [line("adults-extra", "French fries", { source, notes: "EXTRA note" })]));
      assert.equal(base(rows, FRIES).audience, "kids", source);assert.equal(base(rows, FRIES).adults_note, undefined);
    }
  });
  await check("LEGACY control: an unbadged adult row keeps its existing shared mark and note", async () => {
    const rows = await plan(await fixture([set("kids-set", "French fries", FRIES)], [line("old-adult", "French fries", { source: undefined, notes: "legacy note" })]));
    assert.equal(base(rows, FRIES).audience, undefined);assert.equal(base(rows, FRIES).adults_note, "legacy note");
  });
  await check("LEGACY control: an unbadged kids row retains 0050's mark without inferred intent", async () => {
    const rows = await plan(await fixture([line("old-kids", "French fries", { source: undefined })], []));
    assert.equal(base(rows, FRIES).audience, "kids");
  });
  await check("CONTROL: same-group shared SET and real adults note remain", async () => {
    const rows = await plan(await fixture([set("kids-set", "French fries", FRIES, { productCode: "CF-11" })], [set("adult-set", "French fries", FRIES, { productCode: "CF-11", notes: "no salt" })]));
    assert.equal(base(rows, FRIES).audience, undefined);assert.equal(base(rows, FRIES).adults_note, "no salt");
  });
  await check("HIGH fixed: the same dish in another choice group does not make this SET shared", async () => {
    const rows = await plan(await fixture([set("kids-a", "Chicken", A, { productCode: "CF-50" })], [set("adults-b", "Chicken", B, { productCode: "CF-60" })]));
    assert.equal(base(rows, A).audience, "kids");
    assert.ok(rows.some(l => l.line_id === "adults-b" && l.audience === "adults" && l.product_code === "CF-60"));
  });
  await check("HIGH fixed: another group's matching dishes cannot lend an adults note", async () => {
    const rows = await plan(await fixture([set("kids-a", "Chicken", A), set("kids-b", "Chicken", B)], [set("adults-a", "Chicken", A, { notes: "A note" }), set("adults-b", "Chicken", B, { notes: "B note" })]));
    assert.equal(base(rows, A).adults_note, "A note");assert.equal(base(rows, B).adults_note, "B note");
  });
  await check("HIGH fixed: a SET with an unrelated groupId is not the base item's member", async () => {
    const rows = await plan(await fixture([set("orphan-set", "French fries", "no-such-group")], []));
    assert.equal(base(rows, FRIES).audience, undefined);assert.ok(rows.some(l => l.line_id === "orphan-set" && l.audience === "kids"));
  });
  await check("CONTROL: old fixed SET lines without groupId still match by name and empty note", async () => {
    const rows = await plan(await fixture([line("old-fixed", "French fries", { source: "set_menu" })], []));
    assert.equal(base(rows, FRIES).audience, "kids");
  });
  await check("HIGH fixed: old choice SET lines match their own group note, not another group", async () => {
    const rows = await plan(await fixture([line("old-a", "Chicken", { source: "set_menu", notes: "(Main A)" })], [line("old-b", "Chicken", { source: "set_menu", notes: "(Main B)" })]));
    assert.equal(base(rows, A).audience, "kids");
  });
  await check("CONTROL: multiple choice options retain their separate audiences and unset shared count", async () => {
    const rows = await plan(await fixture([set("kids-chicken", "Chicken", A), set("kids-shrimp", "Shrimp", A)], [set("adults-chicken", "Chicken", A)]));
    const choices = rows.filter(l => l.name === "Main A");assert.equal(choices.length, 2);
    assert.deepEqual(choices.map(l => [l.chosen_option,l.qty,l.audience ?? null,l.product_code]), [["Chicken",null,null,"CF-50"],["Shrimp",null,"kids","CF-51"]]);
  });
  await check("CONTROL: adult own dish keeps its code, count, price and adults-only audience", async () => {
    const rows = await plan(await fixture([set("kids-chicken", "Chicken", A, { productCode: "CF-50" })], [set("adult-shrimp", "Shrimp", A, { quantity: 3, productCode: "CF-51", price: 400 })]));
    const adult = rows.find(l => l.line_id === "adult-shrimp");assert.ok(adult);
    assert.deepEqual([adult.qty,adult.product_code,adult.unit_price_satang,adult.audience], [3,"CF-51",40000,"adults"]);
    assert.equal(base(rows, A).audience, "kids");
  });
  await check("HELD Q17 control: adultsDiffer off historical repeated coded lists are not rewritten or deduplicated", async () => {
    const rows = await plan(await fixture([line("old-kids", "Nuggets", { productCode: "CF-77" })], [line("old-adults", "Nuggets", { productCode: "CF-77" })], { differ: false }));
    assert.deepEqual(rows.filter(l => l.name === "Nuggets").map(l => [l.line_id,l.audience ?? null]), [["old-kids",null],["old-adults",null]]);
  });
  await check("CONTROL: foreign-tenant template is not exposed and branch identity is unchanged", async () => {
    const id = await fixture([], [], { menuId: foreignMenu });const rows = await plan(id);
    assert.ok(!rows.some(l => l.name === "FOREIGN MUST NOT APPEAR"));
    const [row] = await q<{ core_branch_id: string }>("select core_branch_id from otoapp_v.event_packages where event_id=$1", [id]);assert.equal(row!.core_branch_id, coreBranch);
  });
  await check("CONTROL: every first-thirteen legacy value remains identical to applied 0050", async () => {
    const before = await q<{ event_id: string; held: unknown }>(`select event_id,to_jsonb(v)-array(select attname::text from pg_attribute where attrelid='otoapp_v.event_packages'::regclass and attnum>13 and not attisdropped) as held from otoapp_v.event_packages v where event_id in (select id::varchar from core_events where tenant_id=$1) order by event_id`, [tenant]);
    await q(oldSql.replace('CREATE OR REPLACE VIEW otoapp_v.event_packages', `CREATE OR REPLACE VIEW ${schema}.before_packages`));
    const old = await q<{ event_id: string; held: unknown }>(`select event_id,to_jsonb(v)-'kitchen_plan' as held from ${schema}.before_packages v where event_id in (select id::varchar from core_events where tenant_id=$1) order by event_id`, [tenant]);
    assert.deepEqual(before,old);
  });
  await check("CONTROL: CREATE OR REPLACE retains view OID, owner, grants and all fourteen column names/types", async () => {
    await q("savepoint ddl_contract");
    try {
      const role = `zz_s945_${run}`;
      const view = `${schema}.contract_packages`;
      await q(oldSql.replace('CREATE OR REPLACE VIEW otoapp_v.event_packages', `CREATE OR REPLACE VIEW ${view}`));
      await q(`create role ${role}`);await q(`grant usage on schema ${schema} to ${role}`);await q(`grant select on ${view} to ${role}`);
      const metadata = async () => ({
        view: await q("select oid,relowner,relacl::text as acl from pg_class where oid=$1::regclass", [view]),
        columns: await q("select attname,atttypid,atttypmod from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum", [view]),
      });
      const before = await metadata();assert.equal(before.columns.length,14);assert.equal(before.columns.at(-1)!.attname,"kitchen_plan");
      const replacement = fixedSql.replace('CREATE OR REPLACE VIEW otoapp_v.event_packages', `CREATE OR REPLACE VIEW ${view}`);
      await q(replacement);await q(replacement);assert.deepEqual(await metadata(),before);
      const [granted] = await q<{ allowed: boolean }>("select has_table_privilege($1,$2,'SELECT') as allowed", [role,view]);assert.equal(granted!.allowed,true);
    } finally { await q("rollback to savepoint ddl_contract"); }
  });
} finally {
  await q("rollback").catch(() => undefined);client.release();await pool.end();
}
console.log(`s945-kitchen-view.check: ${passed} passed, ${failed} failed; applied0050=${original}`);
process.exitCode = failed > 0 ? 1 : 0;
