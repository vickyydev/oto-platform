// S2-17b round 7: actual Xero router HTTP with a generated SDK stand-in.
// Session state and credentials stay in memory; no accounting connection is used.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import session from "express-session";
import pg from "pg";
import type { XeroClient } from "xero-node";

if (!process.env.DATABASE_URL) throw new Error("xero-access.check: DATABASE_URL is not set");
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV = "local";
process.env.DB_SCHEMA = "otoapp";
process.env.XERO_REDIRECT_URI = "http://127.0.0.1/zz-test-xero/callback";
const { pool } = await import("../server/db");
const { createXeroRouter } = await import("../server/xero-routes");
const control = new pg.Client({ connectionString: process.env.DATABASE_URL });
await control.connect();
await control.query("set search_path to otoapp");
const q = async (sql: string, args: unknown[] = []) => (await control.query(sql, args)).rows;
const parks = Array.from({ length: 5 }, () => randomUUID());
const users = parks.map((park) => `zz-test-xero-user-${park}`);
const organisations = ["A", "B", "Callback", "Shared", "Unplaced"].map((label) => `ZZ TEST Xero ${label} ${randomUUID()}`);
let callbackOrganisation = organisations[2];
let exchanges = 0;
let reportCalls = 0;
const fakeClient = (state?: string) => {
  const report = async (organisation: string) => {
    reportCalls++;
    assert.ok(organisations.slice(0, 3).includes(organisation));
    return { body: { organisation, source: "ZZ TEST SDK" } };
  };
  return {
    buildConsentUrl: async () => `https://zz-test.invalid/consent?state=${state}`,
    apiCallback: async () => {
      exchanges++;
      return { access_token: randomBytes(24).toString("hex"), refresh_token: randomBytes(24).toString("hex"), expires_in: 3600 };
    },
    updateTenants: async () => undefined,
    tenants: [{ tenantId: callbackOrganisation, tenantName: "ZZ TEST Xero Callback" }],
    setTokenSet: () => undefined,
    accountingApi: {
      getReportProfitAndLoss: report, getReportBalanceSheet: report, getInvoices: report,
      getAccounts: report, getReportBankSummary: report, getOrganisations: report,
    },
  } as unknown as XeroClient;
};
const app = express();
app.use(express.json());
app.use(session({ secret: randomBytes(32).toString("hex"), resave: false, saveUninitialized: false }));
app.use((req, _res, next) => {
  const park = req.header("x-zz-park");
  const index = parks.indexOf(park ?? "");
  Object.assign(req, {
    user: park ? { id: users[index] ?? "zz-test-unplaced-user", role: "admin" } : undefined,
    userWithAccess: park ? { id: users[index], role: "admin", tenantId: park === "unplaced" ? undefined : park } : undefined,
    isAuthenticated: () => !!park,
  });
  next();
});
app.use("/api/auth/xero", createXeroRouter(fakeClient));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/xero`;
type Context = { park?: string; cookie?: string };
const request = async (ctx: Context, path: string, method = "GET") => {
  const response = await fetch(base + path, {
    method, redirect: "manual", headers: {
      ...(ctx.park ? { "x-zz-park": ctx.park } : {}), ...(ctx.cookie ? { Cookie: ctx.cookie } : {}),
    },
  });
  const cookie = response.headers.get("set-cookie");
  if (cookie) ctx.cookie = cookie.split(";")[0];
  const type = response.headers.get("content-type");
  const body = type?.includes("application/json") ? await response.json() : undefined;
  return { status: response.status, body, location: response.headers.get("location") };
};
const a: Context = { park: parks[0] }, b: Context = { park: parks[1] };
const reports = ["/profit-and-loss", "/balance-sheet", "/invoices", "/accounts", "/bank-summary", "/organisation"];
const begin = async () => {
  const result = await request(a, "/connect");
  assert.equal(result.status, 302);
  const state = new URL(result.location!).searchParams.get("state");
  assert.ok(state && /^[a-f0-9]{64}$/.test(state));
  return state!;
};
const callbackPath = (state: string) => `/callback?state=${state}&code=${randomBytes(24).toString("hex")}`;
const active = async (park: string) => Number((await q("select count(*) as n from xero_tokens where tenant_id=$1 and is_active", [park]))[0].n);

try {
  for (const [i, park] of parks.entries()) {
    await q("insert into tenants(id,name,slug) values($1,$2,$3)", [park, `ZZ TEST Xero Park ${i}`, `zz-test-xero-${park}`]);
    await q("insert into users(id,email,password,full_name) values($1,$2,$3,$4)", [users[i], `xero-${park}@zz-test.invalid`, randomBytes(24).toString("hex"), `ZZ TEST Xero User ${i}`]);
  }
  for (const [park, org] of [
    [parks[0], organisations[0]], [parks[1], organisations[1]],
    [parks[3], organisations[3]], [parks[1], organisations[3]],
    [parks[4], organisations[4]], [null, organisations[4]],
  ]) await q(`insert into xero_tokens(tenant_id,xero_tenant_id,xero_tenant_name,access_token,refresh_token,expires_at,updated_at)
    values($1,$2,$3,$4,$5,now()+interval '1 hour',now()+case when $2=$6 then interval '1 hour' else interval '0 hours' end)`, [
    park, org, park === parks[0] ? "ZZ TEST Xero A" : "ZZ TEST Xero B", randomBytes(24).toString("hex"), randomBytes(24).toString("hex"), organisations[1],
  ]);
  for (const path of ["/connect", "/callback", "/status", ...reports]) assert.equal((await request({}, path)).status, 401);
  assert.equal((await request({}, "/disconnect", "POST")).status, 401);
  assert.equal((await request({ park: "unplaced" }, "/status")).status, 403);
  assert.equal((await request({ park: "unplaced" }, "/disconnect", "POST")).status, 403);
  assert.equal((await request(a, "/status")).body.xeroTenantName, "ZZ TEST Xero A");
  assert.equal((await request(b, "/status")).body.xeroTenantName, "ZZ TEST Xero B");
  for (const path of reports) {
    const result = await request(a, path);
    assert.equal(result.status, 200);
    assert.equal(result.body.organisation, organisations[0]);
  }
  assert.equal(reportCalls, 6);
  assert.deepEqual((await request({ park: parks[2] }, "/status")).body, { connected: false });
  for (const path of reports) assert.equal((await request({ park: parks[2] }, path)).status, 400);
  for (const park of [parks[3], parks[4]]) {
    assert.equal((await request({ park }, "/status")).status, 404);
    for (const path of reports) assert.equal((await request({ park }, path)).status, 404);
  }

  const state = await begin();
  assert.ok((await request({ park: parks[1], cookie: a.cookie }, callbackPath(state))).location?.includes("xero=error"));
  assert.ok((await request(a, callbackPath(randomBytes(32).toString("hex")))).location?.includes("xero=error"));
  assert.equal(exchanges, 0);
  const beforeB = await active(parks[1]);
  const successful = await request(a, callbackPath(state));
  assert.ok(successful.location?.includes("xero=connected"));
  assert.equal(exchanges, 1);
  assert.equal(await active(parks[0]), 1);
  assert.equal(await active(parks[1]), beforeB);
  assert.ok((await request(a, callbackPath(state))).location?.includes("xero=error"));
  assert.equal(exchanges, 1);
  const saved = (await q("select tenant_id,connected_by from xero_tokens where xero_tenant_id=$1 and is_active", [organisations[2]]))[0];
  assert.equal(saved.tenant_id, parks[0]);
  assert.equal(saved.connected_by, users[0]);

  // Two callbacks with one session state exchange once after the session reload.
  const raced = await begin();
  const outcomes = await Promise.all([request(a, callbackPath(raced)), request(a, callbackPath(raced))]);
  assert.equal(outcomes.filter((r) => r.location?.includes("xero=connected")).length, 1);
  assert.equal(outcomes.filter((r) => r.location?.includes("xero=error")).length, 1);
  assert.equal(exchanges, 2);
  assert.equal(await active(parks[0]), 1);

  // A cannot connect an organisation already owned by B or an unplaced mapping.
  for (const org of [organisations[1], organisations[4]]) {
    callbackOrganisation = org;
    const guarded = await begin();
    const beforeA = await active(parks[0]);
    assert.ok((await request(a, callbackPath(guarded))).location?.includes("xero=error"));
    assert.equal(await active(parks[0]), beforeA);
    assert.equal(await active(parks[1]), beforeB);
  }
  assert.equal((await request(a, "/disconnect", "POST")).status, 200);
  assert.equal(await active(parks[0]), 0);
  assert.equal(await active(parks[1]), beforeB);
  assert.deepEqual((await request(a, "/status")).body, { connected: false });
  assert.equal((await request(b, "/status")).status, 200);
  assert.equal(Number((await q("select count(*) as n from xero_tokens where tenant_id=$1 and not is_active", [parks[0]]))[0].n), 3);
  console.log("xero-access.check: ten HTTP doors, own reports/disconnect, unconnected controls and bound/replayed OAuth state passed");
} finally {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  await q("delete from xero_tokens where xero_tenant_id=any($1)", [organisations]);
  await q("delete from users where id=any($1)", [users]);
  await q("delete from tenants where id=any($1)", [parks]);
  await control.end();
  await pool.end();
}
