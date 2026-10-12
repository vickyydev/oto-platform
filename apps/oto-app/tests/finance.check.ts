// S2-17b round 7, H16: real finance writers on a migrated disposable database.
// Xero responses are generated fixtures; no external accounting connection is used.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("finance.check: DATABASE_URL is not set");
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV = "local";
process.env.DB_SCHEMA = "otoapp";

const { pool } = await import("../server/db");
const { syncTracking, syncPL, syncCash } = await import("../server/finance-sync");
const control = new pg.Client({ connectionString: process.env.DATABASE_URL });
await control.connect();
await control.query("set search_path to otoapp");
const q = async (sql: string, args: unknown[] = []) => (await control.query(sql, args)).rows;
const count = async (table: string, org: string) => Number((await q(
  `select count(*) as n from ${table} where tenant_id = $1`, [org],
))[0].n);
const run = randomUUID();
const organisations = [`ZZ TEST Xero A ${run}`, `ZZ TEST Xero B ${run}`];
const originalFetch = globalThis.fetch;
let mode: "normal" | "tracking-fail" | "pl-fail" | "cash-fail" | "daily-fail" = "normal";
let revision = 1;

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://api.xero.com");
  assert.ok(organisations.includes(new Headers(init?.headers).get("Xero-tenant-id") ?? ""));
  if (url.pathname.endsWith("/TrackingCategories")) {
    return Response.json({ TrackingCategories: [{
      TrackingCategoryID: "ZZ TEST shared category", Name: "Location", Status: "ACTIVE",
      Options: [
        { TrackingOptionID: "ZZ TEST option", Name: `ZZ TEST Branch ${revision}`, Status: "ACTIVE" },
        ...(mode === "tracking-fail" ? [{ TrackingOptionID: "ZZ TEST failure option", Name: "ZZ TEST FAIL" }] : []),
      ],
    }] });
  }
  if (url.pathname.endsWith("/Reports/ProfitAndLoss")) {
    const cells = mode === "pl-fail"
      ? [...Array.from({ length: 500 }, (_, i) => ({ RowType: "Row", Cells: [{ Value: `ZZ TEST Line ${i}` }, { Value: "1" }] })),
        { RowType: "Row", Cells: [{ Value: "ZZ TEST FAIL" }, { Value: "1" }] }]
      : [
        { RowType: "Row", Cells: [{ Value: "ZZ TEST same label" }, { Value: "11" }] },
        { RowType: "Row", Cells: [{ Value: "ZZ TEST same label" }, { Value: "12" }] },
      ];
    return Response.json({ Reports: [{ Rows: [
      { RowType: "Header", Cells: [{ Value: "Account" }, { Value: "ZZ TEST Branch" }] },
      { RowType: "Section", Title: "Income", Rows: cells },
    ] }] });
  }
  if (url.pathname.endsWith("/BankTransactions")) {
    return Response.json({ BankTransactions: [
      { BankTransactionID: "ZZ TEST receipt", Date: "2026-10-12", Total: revision * 10 },
      { BankTransactionID: "ZZ TEST payment", Date: "2026-10-12", Total: -revision },
      ...(mode === "cash-fail" ? [{ BankTransactionID: "ZZ TEST FAIL", Date: "2026-10-12", Total: 100 }] : []),
    ] });
  }
  throw new Error("finance.check: unexpected external request");
};

try {
  for (const org of organisations) {
    const park = (await q("insert into tenants (name, slug) values ($1, $2) returning id", [
      `ZZ TEST Finance ${org}`, `zz-test-finance-${randomUUID()}`,
    ]))[0].id;
    await q(`insert into xero_tokens (tenant_id, xero_tenant_id, access_token, refresh_token, expires_at)
      values ($1, $2, $3, $4, now() + interval '1 hour')`, [
      park, org, randomBytes(24).toString("hex"), randomBytes(24).toString("hex"),
    ]);
  }
  // Distinct trigger functions avoid referencing a column another table lacks.
  for (const [table, column] of [
    ["xero_tracking_options", "name"], ["pl_facts", "line_name"], ["cash_txns", "xero_bank_transaction_id"],
  ]) {
    await q(`create function zz_test_failure_${table}() returns trigger language plpgsql as $$
      begin if NEW.${column} = 'ZZ TEST FAIL' then raise exception 'ZZ TEST finance failure'; end if; return NEW; end $$`);
    await q(`create trigger zz_test_failure before insert or update on ${table}
      for each row execute function zz_test_failure_${table}()`);
  }
  await q(`create function zz_test_daily_failure() returns trigger language plpgsql as $$
    begin if NEW.net = 27 then raise exception 'ZZ TEST daily failure'; end if; return NEW; end $$`);
  await q(`create trigger zz_test_failure before insert or update on cash_daily
    for each row execute function zz_test_daily_failure()`);

  for (const org of organisations) {
    await syncTracking(org);
    await syncCash(org, "2026-10-12", "2026-10-12");
  }
  revision = 2;
  await syncTracking(organisations[0]);
  await syncCash(organisations[0], "2026-10-12", "2026-10-12");
  assert.equal(await count("xero_tracking_categories", organisations[0]), 1);
  assert.equal(await count("xero_tracking_options", organisations[0]), 1);
  assert.equal(await count("cash_txns", organisations[0]), 2);
  assert.equal(await count("cash_daily", organisations[0]), 1);
  assert.deepEqual((await q("select tenant_id, net::text from cash_daily where tenant_id = any($1) order by tenant_id", [organisations]))
    .map((r) => r.net), ["18", "9"]);

  mode = "tracking-fail";
  revision = 3;
  await assert.rejects(syncTracking(organisations[0]), /ZZ TEST finance failure/);
  assert.equal((await q("select name from xero_tracking_options where tenant_id = $1", [organisations[0]]))[0].name, "ZZ TEST Branch 2");
  assert.equal(await count("xero_tracking_options", organisations[0]), 1);

  mode = "pl-fail";
  await assert.rejects(syncPL(organisations[0], "2026-10-01", "2026-10-31"), /ZZ TEST finance failure/);
  assert.equal(await count("xero_reports_raw", organisations[0]), 0);
  assert.equal(await count("pl_facts", organisations[0]), 0);
  mode = "normal";
  assert.deepEqual(await syncPL(organisations[0], "2026-10-01", "2026-10-31"), { reportsStored: 1, factsStored: 2 });
  await syncPL(organisations[0], "2026-10-01", "2026-10-31");
  assert.equal(await count("xero_reports_raw", organisations[0]), 2);
  assert.equal(await count("pl_facts", organisations[0]), 4);

  mode = "cash-fail";
  await assert.rejects(syncCash(organisations[0], "2026-10-12", "2026-10-12"), /ZZ TEST finance failure/);
  assert.equal((await q("select total::text from cash_txns where tenant_id = $1 and xero_bank_transaction_id = 'ZZ TEST receipt'", [organisations[0]]))[0].total, "20");
  assert.equal((await q("select net::text from cash_daily where tenant_id = $1", [organisations[0]]))[0].net, "18");
  mode = "daily-fail";
  await assert.rejects(syncCash(organisations[0], "2026-10-12", "2026-10-12"), /ZZ TEST daily failure/);
  assert.equal((await q("select total::text from cash_txns where tenant_id = $1 and xero_bank_transaction_id = 'ZZ TEST receipt'", [organisations[0]]))[0].total, "20");
  assert.equal((await q("select net::text from cash_daily where tenant_id = $1", [organisations[0]]))[0].net, "18");
  revision = 4;
  mode = "normal";
  await Promise.all([syncCash(organisations[0], "2026-10-12", "2026-10-12"), syncCash(organisations[0], "2026-10-12", "2026-10-12")]);
  assert.equal(await count("cash_txns", organisations[0]), 2);
  assert.equal((await q("select net::text from cash_daily where tenant_id = $1", [organisations[0]]))[0].net, "36");
  assert.equal((await q("select net::text from cash_daily where tenant_id = $1", [organisations[1]]))[0].net, "9");
  console.log("finance.check: four upsert keys, two organisations, replay, four failure points and P&L snapshots passed");
} finally {
  globalThis.fetch = originalFetch;
  for (const table of ["xero_tracking_options", "pl_facts", "cash_txns", "cash_daily"]) {
    await q(`drop trigger if exists zz_test_failure on ${table}`);
  }
  for (const name of ["zz_test_daily_failure", "zz_test_failure_xero_tracking_options", "zz_test_failure_pl_facts", "zz_test_failure_cash_txns"]) {
    await q(`drop function if exists ${name}()`);
  }
  for (const table of ["pl_facts", "xero_reports_raw", "cash_daily", "cash_txns", "xero_tracking_options", "xero_tracking_categories", "xero_sync_runs"]) {
    await q(`delete from ${table} where tenant_id = any($1)`, [organisations]);
  }
  const parks = (await q("delete from xero_tokens where xero_tenant_id = any($1) returning tenant_id", [organisations])).map((r) => r.tenant_id);
  await q("delete from tenants where id = any($1)", [parks]);
  await control.end();
  await pool.end();
}
