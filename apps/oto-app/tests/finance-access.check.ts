// S2-17b round 7: the actual finance router over HTTP with isolated identities.
// Authentication is supplied by this harness; park ownership is product code.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("finance-access.check: DATABASE_URL is not set");
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV = "local";
process.env.DB_SCHEMA = "otoapp";
const { pool } = await import("../server/db");
const { default: router } = await import("../server/finance-sync-routes");
const control = new pg.Client({ connectionString: process.env.DATABASE_URL });
await control.connect();
await control.query("set search_path to otoapp");
const q = async (sql: string, args: unknown[] = []) => (await control.query(sql, args)).rows;
const parks = [randomUUID(), randomUUID(), randomUUID()];
const own = `ZZ TEST Finance A ${randomUUID()}`;
const foreign = `ZZ TEST Finance B ${randomUUID()}`;
const inactive = `ZZ TEST Finance Inactive ${randomUUID()}`;
const ambiguous = `ZZ TEST Finance Ambiguous ${randomUUID()}`;
const unplaced = `ZZ TEST Finance Unplaced ${randomUUID()}`;
const originalFetch = globalThis.fetch;
let externalRequests = 0;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.xero.com/")) return originalFetch(input, init);
  externalRequests++;
  const org = new Headers(init?.headers).get("Xero-tenant-id");
  assert.equal(org, own);
  const url = new URL(String(input));
  if (url.pathname.endsWith("/TrackingCategories")) return Response.json({ TrackingCategories: [{
    TrackingCategoryID: "ZZ TEST Location", Name: "Location", Options: [],
  }] });
  if (url.pathname.endsWith("/Reports/ProfitAndLoss")) return Response.json({ Reports: [] });
  if (url.pathname.endsWith("/BankTransactions")) return Response.json({ BankTransactions: [] });
  throw new Error("finance-access.check: unexpected external request");
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const park = req.header("x-zz-park");
  Object.assign(req, {
    user: park ? { id: "ZZ TEST finance user", role: "admin" } : undefined,
    userWithAccess: park ? { id: "ZZ TEST finance user", role: "admin", tenantId: park === "unplaced" ? undefined : park } : undefined,
    isAuthenticated: () => !!park,
  });
  next();
});
app.use("/api/finance", router);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/finance`;
const request = async (park: string | undefined, path: string, method = "GET", body?: unknown) => {
  const response = await fetch(base + path, {
    method, headers: { ...(park ? { "x-zz-park": park } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};
const doors = [
  { path: "/sync/tracking", method: "POST", body: {} },
  { path: "/sync/pl", method: "POST", body: { fromDate: "2026-10-01", toDate: "2026-10-31" } },
  { path: "/sync/cash", method: "POST", body: { fromDate: "2026-10-01", toDate: "2026-10-31" } },
  { path: "/pl/compare?fromDate=2026-10-01&toDate=2026-10-31", method: "GET" },
  { path: "/cash/series?fromDate=2026-10-01&toDate=2026-10-31", method: "GET" },
  { path: "/tracking-locations", method: "GET" },
  { path: "/sync-history", method: "GET" },
];
const target = (path: string, org: string) => `${path}${path.includes("?") ? "&" : "?"}tenantId=${encodeURIComponent(org)}`;

try {
  for (const [i, park] of parks.entries()) await q("insert into tenants(id,name,slug) values ($1,$2,$3)", [
    park, `ZZ TEST Finance Access ${i}`, `zz-test-finance-access-${park}`,
  ]);
  for (const [park, org, active] of [
    [parks[0], own, true], [parks[1], foreign, true], [parks[0], inactive, false],
    [parks[0], ambiguous, false], [parks[1], ambiguous, false], [parks[0], unplaced, false], [null, unplaced, false],
  ] as const) await q(`insert into xero_tokens(tenant_id,xero_tenant_id,access_token,refresh_token,expires_at,is_active,updated_at)
    values($1,$2,$3,$4,now()+interval '1 hour',$5,now()+case when $2=$6 then interval '1 hour' else interval '0 hours' end)`, [
    park, org, randomBytes(24).toString("hex"), randomBytes(24).toString("hex"), active, foreign,
  ]);
  for (const org of [own, foreign, inactive]) await q(`insert into xero_sync_runs(tenant_id,sync_type,status)
    values($1,'ZZ TEST HISTORY','OK')`, [org]);

  for (const door of doors) {
    assert.equal((await request(undefined, door.path, door.method, door.body)).status, 401);
    assert.equal((await request("unplaced", door.path, door.method, door.body)).status, 403);
    for (const org of [foreign, ambiguous, unplaced, `ZZ TEST Missing ${randomUUID()}`]) {
      const before = externalRequests;
      const result = door.method === "POST"
        ? await request(parks[0], door.path, door.method, { ...door.body, tenantId: org })
        : await request(parks[0], target(door.path, org));
      assert.equal(result.status, 404, `${door.method} ${door.path}: other or unplaced organisation refused`);
      assert.equal(externalRequests, before);
    }
  }
  // The latest global active token is B's, while A still reads its own history.
  const defaultHistory = await request(parks[0], "/sync-history");
  assert.equal(defaultHistory.status, 200);
  assert.equal(defaultHistory.body.length, 1);
  assert.equal(defaultHistory.body[0].tenantId, own);
  assert.equal((await request(parks[0], target("/sync-history", inactive))).status, 200);
  const noConnection = await request(parks[2], "/sync-history");
  assert.equal(noConnection.status, 500);
  assert.equal(noConnection.body.message, "No active Xero connection found");
  assert.equal((await request(parks[0], "/sync-history?tenantId=one&tenantId=two")).status, 400);
  for (const door of doors) {
    const result = door.method === "POST"
      ? await request(parks[0], door.path, door.method, { ...door.body, tenantId: own })
      : await request(parks[0], target(door.path, own));
    assert.equal(result.status, 200, `${door.method} ${door.path}: own organisation works`);
  }
  assert.equal(externalRequests, 3);
  console.log("finance-access.check: seven real HTTP doors, own/foreign/ambiguous/unplaced mappings and unconnected default passed");
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  const organisations = [own, foreign, inactive, ambiguous, unplaced];
  for (const table of ["pl_facts", "xero_reports_raw", "cash_daily", "cash_txns", "xero_tracking_options", "xero_tracking_categories", "xero_sync_runs"]) {
    await q(`delete from ${table} where tenant_id=any($1)`, [organisations]);
  }
  await q("delete from xero_tokens where xero_tenant_id=any($1)", [organisations]);
  await q("delete from tenants where id=any($1)", [parks]);
  await control.end();
  await pool.end();
}
