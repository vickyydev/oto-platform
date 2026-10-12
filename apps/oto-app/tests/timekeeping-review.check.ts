// Isolated HTTP registration of the production review handlers, real migrated
// PostgreSQL, and synthetic authenticated contexts. No face path is enabled.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../shared/schema";
import { registerTimekeepingReviewRoutes } from "../server/timekeeping-review-routes";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the isolated test database");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=otoapp", max: 6 });
const db = drizzle(pool, { schema });
const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows;
const run = randomUUID().slice(0, 8);
const parks = [randomUUID(), randomUUID()];
const branchIds = [randomUUID(), randomUUID(), randomUUID()];
const employeeIds = [randomUUID(), randomUUID(), randomUUID()];
const actors = {
  a: { id: randomUUID(), tenantId: parks[0]!, role: "manager", access: [{ accessScope: "all_branches", branchId: null as string | null }] },
  limited: { id: randomUUID(), tenantId: parks[0]!, role: "manager", access: [{ accessScope: "selected_branches", branchId: branchIds[0]! }] },
  empty: { id: randomUUID(), tenantId: parks[0]!, role: "manager", access: [] },
  b: { id: randomUUID(), tenantId: parks[1]!, role: "manager", access: [{ accessScope: "all_branches", branchId: null as string | null }] },
  staff: { id: randomUUID(), tenantId: parks[0]!, role: "staff", access: [] },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const actor = actors[req.header("x-test-actor") as keyof typeof actors];
  if (actor) { req.user = { id: actor.id } as never; req.userWithAccess = actor as never; }
  next();
});
const authenticated: RequestHandler = (req, res, next) => { if (!req.user) res.sendStatus(401); else next(); };
const manager: RequestHandler = (req, res, next) => { if (req.userWithAccess?.role !== "manager") res.sendStatus(403); else next(); };
registerTimekeepingReviewRoutes(app, {
  db, requireAuth: authenticated, requireManager: manager,
  getUserBranchAccess: async id => Object.values(actors).find(actor => actor.id === id)?.access || [],
  displayName: employee => employee.fullName,
});
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: "Review could not be saved" }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const call = async (actor: string, path: string, body?: object) => {
  const response = await fetch(`${base}/api/timekeeping/${path}`, {
    method: body ? "POST" : "GET", headers: { "x-test-actor": actor, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const ids: string[] = [];
async function fixture(options: { park?: number; branch?: number; entryPark?: number; entryBranch?: number; entryEmployee?: number; entryStatus?: string; issueStatus?: string } = {}) {
  const park = options.park ?? 0;
  const branch = options.branch ?? (park === 0 ? 0 : 2);
  const employee = park === 0 ? 0 : 2;
  const entry = randomUUID(); const issue = randomUUID(); ids.push(issue);
  await q(`insert into time_entries(id,tenant_id,employee_id,branch_id,shift_date,clock_in_at,clock_out_at,status,source_in)
    values($1,$2,$3,$4,'2026-10-13','2026-10-13 08:00','2026-10-13 17:00',$5,'MANUAL')`,
    [entry, parks[options.entryPark ?? park], employeeIds[options.entryEmployee ?? employee], branchIds[options.entryBranch ?? branch], options.entryStatus ?? "PENDING_APPROVAL"]);
  await q(`insert into timekeeping_issues(id,tenant_id,employee_id,branch_id,issue_date,issue_type,status,linked_time_entry_id,user_proposed_clock_in_at,note)
    values($1,$2,$3,$4,'2026-10-13','MISSING_CLOCK_IN',$5,$6,'2026-10-13 08:00','ZZ TEST original note')`,
    [issue, parks[park], employeeIds[employee], branchIds[branch], options.issueStatus ?? "OPEN", entry]);
  return { entry, issue };
}
const read = async (issue: string) => (await q(`select i.status issue_status,i.resolved_at,i.resolved_by,i.resolution_note,i.updated_at issue_updated,
  e.status entry_status,e.approved_at,e.approved_by,e.clock_in_at,e.clock_out_at,e.updated_at entry_updated
  from timekeeping_issues i join time_entries e on e.id=i.linked_time_entry_id where i.id=$1`, [issue]))[0];
let checks = 0;
try {
  for (let n = 0; n < parks.length; n++) await q("insert into tenants(id,name,slug) values($1,$2,$3)", [parks[n], `ZZ TEST review ${run}`, `zz-review-${run}-${n}`]);
  for (let n = 0; n < branchIds.length; n++) await q("insert into branches(id,tenant_id,name,address) values($1,$2,$3,'ZZ TEST')", [branchIds[n], parks[n === 2 ? 1 : 0], `ZZ TEST branch ${run}-${n}`]);
  for (let n = 0; n < employeeIds.length; n++) await q("insert into employees(id,tenant_id,branch_id,full_name,nickname,email,status) values($1,$2,$3,$4,$4,$5,'active')", [employeeIds[n], parks[n === 2 ? 1 : 0], branchIds[n], `ZZ TEST employee ${run}-${n}`, `zz-review-${run}-${n}@example.test`]);
  for (const actor of Object.values(actors)) await q("insert into users(id,email,password,full_name,role,is_active) values($1,$2,$3,'ZZ TEST reviewer',$4,true)", [actor.id, `zz-review-${actor.id}@example.test`, randomUUID(), actor.role]);

  const own = await fixture(); const otherBranch = await fixture({ branch: 1 }); const foreign = await fixture({ park: 1 });
  const mismatches = [
    await fixture({ entryPark: 1, entryBranch: 2, entryEmployee: 2 }),
    await fixture({ entryEmployee: 1 }), await fixture({ entryBranch: 1 }),
    await fixture({ branch: 2, entryBranch: 2 }),
  ];
  const raw = await fixture({ entryStatus: "RAW" });
  const list = await call("a", "pending-issues");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.issues.map((row: { id: string }) => row.id).sort(), [own.issue, otherBranch.issue].sort());
  assert.equal(list.body.issues[0].note, "ZZ TEST original note");
  assert(list.body.issues[0].userProposedClockInAt);
  const limited = await call("limited", "pending-issues");
  assert.deepEqual(limited.body.issues.map((row: { id: string }) => row.id), [own.issue]);
  assert.equal((await call("empty", "pending-issues")).body.count, 0);
  assert.equal((await call("a", `pending-issues?branchId=${branchIds[2]}`)).body.count, 0);
  assert.equal((await call("limited", `pending-issues?branchId=${branchIds[1]}`)).status, 403); checks++;

  assert.equal((await call("", "pending-issues")).status, 401);
  assert.equal((await call("staff", "pending-issues")).status, 403);
  assert.equal((await call("b", `issues/${own.issue}/resolve`, { action: "approve" })).status, 404);
  assert.equal((await call("limited", `issues/${otherBranch.issue}/resolve`, { action: "approve" })).status, 403);
  assert.equal((await call("empty", `issues/${own.issue}/resolve`, { action: "approve" })).status, 403);
  for (const invalid of mismatches) assert.equal((await call("a", `issues/${invalid.issue}/resolve`, { action: "approve" })).status, 404);
  assert.equal((await call("a", `issues/${raw.issue}/resolve`, { action: "approve" })).status, 409);
  assert.equal((await read(foreign.issue)).issue_status, "OPEN"); checks++;

  const before = await read(own.issue);
  const approval = await call("limited", `issues/${own.issue}/resolve`, { action: "approve", managerNote: "ZZ TEST approved" });
  assert.equal(approval.status, 200); assert.equal(approval.body.issue.status, "RESOLVED");
  const saved = await read(own.issue);
  assert.equal(saved.entry_status, "APPROVED"); assert.equal(saved.issue_status, "RESOLVED");
  assert.equal(saved.approved_by, actors.limited.id); assert.equal(saved.resolved_by, actors.limited.id);
  assert.equal(saved.resolution_note, "ZZ TEST approved");
  assert.deepEqual(saved.clock_in_at, before.clock_in_at); assert.deepEqual(saved.clock_out_at, before.clock_out_at);
  assert.equal((await call("a", `issues/${own.issue}/resolve`, { action: "approve", managerNote: "ZZ TEST retry" })).status, 200);
  assert.deepEqual(await read(own.issue), saved);
  assert.equal((await call("a", `issues/${own.issue}/resolve`, { action: "reject" })).status, 409);
  assert.deepEqual(await read(own.issue), saved); checks++;

  const rejection = await call("a", `issues/${otherBranch.issue}/resolve`, { action: "reject", managerNote: "ZZ TEST rejected" });
  assert.equal(rejection.status, 200);
  const rejected = await read(otherBranch.issue);
  assert.equal(rejected.entry_status, "REJECTED"); assert.equal(rejected.issue_status, "REJECTED");
  assert.equal(rejected.approved_at, null); assert.equal(rejected.approved_by, null);
  assert.equal(rejected.resolved_by, actors.a.id); assert.equal(rejected.resolution_note, "ZZ TEST rejected");
  assert.equal((await call("a", `issues/${otherBranch.issue}/resolve`, { action: "reject" })).status, 200);
  assert.deepEqual(await read(otherBranch.issue), rejected);
  assert.equal((await call("a", "pending-issues")).body.count, 0); checks++;

  const rollback = await fixture();
  const original = await read(rollback.issue);
  await q(`create function zz_review_rollback() returns trigger language plpgsql as $$ begin
    if NEW.resolution_note = 'ZZ TEST rollback' then raise exception 'ZZ TEST injected review rollback'; end if; return NEW; end $$`);
  await q("create trigger zz_review_rollback before update on timekeeping_issues for each row execute function zz_review_rollback()");
  assert.equal((await call("a", `issues/${rollback.issue}/resolve`, { action: "approve", managerNote: "ZZ TEST rollback" })).status, 500);
  assert.deepEqual(await read(rollback.issue), original);
  await q("drop trigger zz_review_rollback on timekeeping_issues"); await q("drop function zz_review_rollback()"); checks++;

  const race = await fixture();
  const results = await Promise.all([call("a", `issues/${race.issue}/resolve`, { action: "approve" }), call("limited", `issues/${race.issue}/resolve`, { action: "reject" })]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const final = await read(race.issue);
  assert(["APPROVED:RESOLVED", "REJECTED:REJECTED"].includes(`${final.entry_status}:${final.issue_status}`)); checks++;
  console.log(`PASS: ${checks} real-handler/DB scenarios (pending scopes and parent placement, refusals, approval/replay, rejection/replay, rollback, competing decisions).`);
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await q("drop trigger if exists zz_review_rollback on timekeeping_issues");
  await q("drop function if exists zz_review_rollback()");
  await q("delete from timekeeping_issues where id=any($1::varchar[])", [ids]);
  await q("delete from time_entries where tenant_id=any($1::uuid[])", [parks]);
  await q("delete from employees where id=any($1::varchar[])", [employeeIds]);
  await q("delete from branches where id=any($1::varchar[])", [branchIds]);
  await q("delete from users where id=any($1::varchar[])", [Object.values(actors).map(actor => actor.id)]);
  await q("delete from tenants where id=any($1::uuid[])", [parks]);
  await pool.end();
}
