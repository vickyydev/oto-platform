// SCRUM-523: real registered routes and PostgreSQL. Called by the API review
// wrapper after the deployed migrator builds a fresh disposable database.
// Only synthetic ZZ TEST records are created. No production/provider calls.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Request, Response } from "express";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=otoapp" });
const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
const password = randomBytes(24).toString("hex");
const salt = randomBytes(16).toString("hex");
const credential = `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
let child: ChildProcess | undefined;
let origin = "";
let stage = "setup";
// JSON responses are inspected field by field; this harness does not trust their shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Park = { tenant: string; branch: string; department: string; user: string; email: string; cookie: string };
type Rota = Awaited<ReturnType<typeof rota>>;
const results: Record<string, boolean> = {};
const details: Record<string, { status: number; unchanged: boolean }[]> = {};
const tables = ["schedule_week_plans", "shift_groups", "schedule_shift_rows", "schedule_shift_row_roles",
  "schedule_assignments", "schedule_shift_breaks", "schedule_templates", "schedule_template_rows",
  "schedule_template_row_roles", "schedule_template_assignments", "schedule_template_time_off",
  "schedule_template_duty_blocks", "schedule_audit_log", "employee_time_off", "duty_blocks", "duty_types"];
async function snapshot() {
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = await q(`select * from ${table} order by id`);
  return JSON.stringify(rows);
}
async function request(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(origin + path, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  let parsed: Json = null;
  try { parsed = JSON.parse(text); } catch { /* Empty 204 responses are expected. */ }
  return { status: response.status, body: parsed };
}
async function denied(key: string, cookie: string, method: string, path: string, body?: unknown) {
  stage = key;
  const before = await snapshot();
  const response = await request(cookie, method, path, body);
  const unchanged = before === await snapshot();
  (details[key] ??= []).push({ status: response.status, unchanged });
  const statuses = key === "malformedParents" ? [400, 404] : [404];
  results[key] = (results[key] ?? true) && statuses.includes(response.status) && unchanged;
}
async function park(label: string, isDefault = false): Promise<Park> {
  let tenant = randomUUID();
  const branch = randomUUID(), department = randomUUID(), user = randomUUID();
  const email = `${user}@zz-test.invalid`;
  if (isDefault) tenant = (await q("select id from tenants where slug='default'"))[0]?.id ?? tenant;
  await q("insert into tenants(id,name,slug) values($1,$2,$3) on conflict(slug) do nothing", [tenant, "ZZ TEST scheduling " + label, isDefault ? "default" : "zz-" + tenant]);
  await q("insert into branches(id,tenant_id,name,address) values($1,$2,$3,'ZZ TEST')", [branch, tenant, "ZZ TEST branch " + label]);
  await q("insert into departments(id,tenant_id,name) values($1,$2,$3)", [department, tenant, "ZZ TEST department " + label]);
  await q("insert into users(id,email,password,full_name,role,is_active,must_change_password) values($1,$2,$3,$4,'admin',true,false)", [user, email, credential, "ZZ TEST manager " + label]);
  await q("insert into user_branch_access(tenant_id,user_id,access_scope) values($1,$2,'all_branches')", [tenant, user]);
  return { tenant, branch, department, user, email, cookie: "" };
}
async function rota(p: Park) {
  const plan = randomUUID(), group = randomUUID(), row = randomUUID(), employee = randomUUID(), assignment = randomUUID();
  // Each scenario has its own branch so broad legacy operations cannot damage
  // another scenario's positive arrangement before the boundary is present.
  const branch = randomUUID();
  await q("insert into branches(id,tenant_id,name,address) values($1,$2,'ZZ TEST scenario','ZZ TEST')", [branch, p.tenant]);
  await q("insert into schedule_week_plans(id,tenant_id,branch_id,week_start_date) values($1,$2,$3,$4)", [plan, p.tenant, branch, day]);
  await q("insert into shift_groups(id,tenant_id,branch_id,name,sort_order) values($1,$2,$3,'ZZ TEST group',7)", [group, p.tenant, branch]);
  await q("insert into schedule_shift_rows(id,tenant_id,branch_id,department_id,week_plan_id,shift_group_id,start_time,end_time,label,sort_order_within_group) values($1,$2,$3,$4,$5,$6,'09:00','17:00','ZZ TEST row',7)", [row, p.tenant, branch, p.department, plan, group]);
  await q("insert into employees(id,tenant_id,branch_id,full_name,nickname,email,status) values($1,$2,$3,'ZZ TEST employee','ZZ TEST',$4,'active')", [employee, p.tenant, branch, employee + "@zz-test.invalid"]);
  await q("insert into schedule_assignments(id,tenant_id,week_plan_id,shift_row_id,shift_date,employee_id) values($1,$2,$3,$4,$5,$6)", [assignment, p.tenant, plan, row, day, employee]);
  const brk = randomUUID();
  await q("insert into schedule_shift_breaks(id,tenant_id,branch_id,shift_row_id,shift_date,employee_id,assignment_id,break_start_time,break_end_time) values($1,$2,$3,$4,$5,$6,$7,'12:00','13:00')", [brk, p.tenant, branch, row, day, employee, assignment]);
  return { ...p, branch, plan, group, row, employee, assignment, brk };
}
async function signIn(email: string) {
  const response = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: email, password }) });
  assert.equal(response.status, 200, "Synthetic manager signs in");
  return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
}
async function history(p: Rota, data: unknown) {
  const id = randomUUID();
  await q("insert into schedule_audit_log(id,tenant_id,branch_id,week_plan_id,action,performed_by,snapshot_data) values($1,$2,$3,$4,'clear_week',$5,$6::jsonb)", [id, p.tenant, p.branch, p.plan, p.user, JSON.stringify(data)]);
  return id;
}
async function template(p: Rota) {
  const id = randomUUID();
  await q("insert into schedule_templates(id,tenant_id,branch_id,shift_group_id,name,source_week_plan_id,created_by) values($1,$2,$3,$4,'ZZ TEST template',$5,$6)", [id, p.tenant, p.branch, p.group, p.plan, p.user]);
  await q("insert into schedule_template_rows(tenant_id,template_id,shift_group_id,start_time,end_time,label,row_order) values($1,$2,$3,'09:00','17:00','ZZ TEST saved row',0)", [p.tenant, id, p.group]);
  return id;
}

try {
  const a = await park("A", true), b = await park("B");
  child = spawn(process.execPath, [join(APP, "node_modules/tsx/dist/cli.mjs"), "tests/harness/serve-routes.ts"], { cwd: APP, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  origin = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Scheduling route startup timed out")), 90000);
    const read = (buffer: Buffer) => {
      output += buffer.toString();
      const match = /HARNESS_PORT=(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve("http://127.0.0.1:" + match[1]); }
    };
    child!.stdout!.on("data", read); child!.stderr!.on("data", read);
    child!.on("exit", () => { clearTimeout(timer); reject(new Error("Scheduling route process exited")); });
  });
  a.cookie = await signIn(a.email); b.cookie = await signIn(b.email);
  const own = await rota(a), foreign = await rota(b);
  const limitedId = randomUUID(), limitedEmail = `${limitedId}@zz-test.invalid`;
  await q("insert into users(id,email,password,full_name,role,is_active,must_change_password) values($1,$2,$3,'ZZ TEST limited manager','manager',true,false)", [limitedId, limitedEmail, credential]);
  await q("insert into user_branch_access(tenant_id,user_id,branch_id,access_scope) values($1,$2,$3,'selected_branches')", [a.tenant, limitedId, a.branch]);
  const limited = await signIn(limitedEmail);
  const read = await request(limited, "GET", `/api/schedule/week?branchId=${own.branch}&weekStartDate=${day}`);
  const write = await request(limited, "PATCH", `/api/schedule/shift-rows/${own.row}`, { label: "ZZ TEST same park edited" });
  results.sameParkBranchDefault = read.status === 200 && read.body?.shiftRows?.some((r: Json) => r.id === own.row) && write.status === 200 && (await q("select label from schedule_shift_rows where id=$1", [own.row]))[0]?.label === "ZZ TEST same park edited";
  const ownedWeek = await request(a.cookie, "POST", "/api/schedule/week", { branchId: own.branch, weekStartDate: day });
  results.ownedWeek = ownedWeek.status === 200 && ownedWeek.body?.id === own.plan;
  const anonymousBefore = await snapshot();
  const anonymous = await request("", "GET", `/api/schedule/week?branchId=${own.branch}&weekStartDate=${day}`);
  results.anonymous = anonymous.status === 401 && anonymousBefore === await snapshot();
  const { requireSchedulePark } = await import("../server/schedule-scope");
  let nextCalled = false;
  const missingContext = await new Promise<number>(resolve => {
    const response = { status(code: number) { return { json() { resolve(code); } }; } };
    requireSchedulePark({ userWithAccess: { id: a.user }, route: { path: "/api/schedule/week" }, params: {}, query: { branchId: own.branch }, body: {} } as unknown as Request,
      response as unknown as Response, () => { nextCalled = true; resolve(0); });
  });
  results.missingContext = missingContext === 403 && !nextCalled;
  await denied("malformedParents", a.cookie, "PATCH", "/api/schedule/shift-groups/reorder", { orderedIds: [own.group, { id: foreign.group }] });
  await denied("malformedParents", a.cookie, "GET", `/api/schedule/week?branchId[]=${own.branch}&branchId[]=${foreign.branch}&weekStartDate=${day}`);
  const tpl = await template(own);
  results.ownedTemplate = (await request(a.cookie, "GET", `/api/schedule/templates/${tpl}`)).body?.id === tpl;

  for (const path of [
    `/api/schedule/week?branchId=${own.branch}&weekStartDate=${day}`,
    `/api/schedule/shift-groups?branchId=${own.branch}`,
    `/api/schedule/shift-rows/${own.row}/eligible-employees?date=${day}`,
    `/api/schedule/shift-rows/${own.row}/borrow-candidates?date=${day}&branchId=${own.branch}`,
    `/api/schedule/employees/${own.employee}/assignments?date=${day}`,
    `/api/schedule/branches/${own.branch}/borrowed-out-assignments?startDate=${day}&endDate=${day}`,
    `/api/schedule/clear-preview?branchId=${own.branch}&departmentId=${a.department}&startDate=${day}&endDate=${day}`,
    `/api/rota?scope=branch&branchId=${own.branch}&from=${day}&to=${day}`,
  ]) await denied("foreignReads", b.cookie, "GET", path);

  for (const [method, path, body] of [
    ["POST", "/api/schedule/week", { branchId: own.branch, weekStartDate: "2099-01-05" }],
    ["POST", "/api/schedule/shift-groups", { branchId: own.branch, name: "ZZ TEST unavailable" }],
    ["PATCH", `/api/schedule/shift-groups/${own.group}`, { name: "ZZ TEST unavailable" }],
    ["PATCH", `/api/schedule/shift-rows/${own.row}`, { label: "ZZ TEST unavailable" }],
    ["POST", "/api/schedule/shift-rows", { branchId: own.branch, shiftGroupId: own.group, startTime: "18:00", endTime: "20:00" }],
  ] as const) await denied("foreignWrites", b.cookie, method, path, body);

  await denied("mixedParents", a.cookie, "POST", "/api/schedule/shift-rows", { branchId: own.branch, shiftGroupId: foreign.group, startTime: "18:00", endTime: "20:00" });
  await denied("mixedParents", a.cookie, "PATCH", `/api/schedule/shift-rows/${own.row}/move-group`, { shiftGroupId: foreign.group });
  const sharedRole = (await q("insert into roles(tenant_id,name) values($1,'ZZ TEST shared role') returning id", [b.tenant]))[0]!.id;
  const roleWrite = await request(a.cookie, "PATCH", `/api/schedule/shift-rows/${own.row}`, { roleIds: [sharedRole] });
  results.sharedRoleDefault = roleWrite.status === 200 && (await q("select id from schedule_shift_row_roles where shift_row_id=$1 and role_id=$2 and tenant_id=$3", [own.row, sharedRole, a.tenant])).length === 1;
  // Keep the later employee-assignment controls independent of role eligibility.
  await q("delete from schedule_shift_row_roles where shift_row_id=$1", [own.row]);
  await denied("mixedReorder", a.cookie, "PATCH", "/api/schedule/shift-groups/reorder", { orderedIds: [own.group, foreign.group] });
  await denied("mixedReorder", a.cookie, "PATCH", "/api/schedule/shift-rows/reorder", { shiftGroupId: own.group, orderedIds: [own.row, foreign.row] });
  for (const action of ["preview", "execute"]) await denied("mixedMerge", a.cookie, "POST", `/api/schedule/shift-rows/merge/${action}`, { targetRowId: own.row, sourceRowIds: [foreign.row] });

  const spare = (await q("insert into employees(tenant_id,branch_id,full_name,nickname,email,status) values($1,$2,'ZZ TEST spare','ZZ TEST',$3,'active') returning id", [a.tenant, own.branch, randomUUID() + "@zz-test.invalid"]))[0]!.id;
  await denied("mixedAssignments", a.cookie, "POST", "/api/schedule/assignments", { weekPlanId: foreign.plan, shiftRowId: own.row, shiftDate: day, employeeId: spare });
  await denied("mixedAssignments", a.cookie, "POST", "/api/schedule/assignments", { weekPlanId: own.plan, shiftRowId: own.row, shiftDate: day, employeeId: foreign.employee, isBorrowed: true, borrowedFromBranchId: foreign.branch });
  await denied("mixedBatch", a.cookie, "POST", "/api/schedule/assignments/batch", { weekPlanId: own.plan, shiftRowId: own.row, shiftDate: day, employeeIds: [spare, foreign.employee] });
  await denied("foreignAssignmentMove", b.cookie, "PATCH", `/api/schedule/assignments/${own.assignment}/move`, { shiftRowId: own.row, shiftDate: day });
  for (let i = 0; i < 2; i++) await denied("foreignReplay", b.cookie, "PATCH", `/api/schedule/assignments/${own.assignment}/reassign`, { employeeId: own.employee });
  await denied("foreignReplay", b.cookie, "DELETE", `/api/schedule/assignments/${own.assignment}`);
  await denied("mixedConflictResolution", a.cookie, "POST", "/api/schedule/conflicts/resolve", { employeeId: own.employee, date: day, keepAssignmentId: own.assignment, deleteAssignmentIds: [own.assignment, foreign.assignment] });
  await denied("foreignClear", b.cookie, "POST", "/api/schedule/clear", { branchId: own.branch, departmentId: a.department, startDate: day, endDate: day });
  await denied("foreignBreaks", b.cookie, "POST", `/api/schedule/shift-rows/${own.row}/regenerate-breaks`);
  await denied("foreignBreaks", b.cookie, "POST", `/api/schedule/week/${own.plan}/regenerate-breaks`);
  await denied("foreignBreaks", b.cookie, "POST", `/api/schedule/breaks/generate-all?branchId=${own.branch}`);
  for (const path of [`/api/schedule/templates?branchId=${own.branch}`, `/api/schedule/templates/${tpl}`]) await denied("foreignTemplates", b.cookie, "GET", path);
  for (const action of ["preview", "apply", "apply-safe"]) {
    await denied("foreignTemplates", b.cookie, "POST", `/api/schedule/templates/${tpl}/${action}`, { branchId: foreign.branch, weekStartDate: day });
    await denied("foreignTemplates", a.cookie, "POST", `/api/schedule/templates/${tpl}/${action}`, { branchId: foreign.branch, weekStartDate: day });
  }
  await denied("foreignTemplates", b.cookie, "POST", "/api/schedule/templates/save-week", { weekPlanId: own.plan, shiftGroupId: own.group, name: "ZZ TEST unavailable" });
  await denied("foreignTemplates", b.cookie, "DELETE", `/api/schedule/templates/${tpl}`);

  const { storage } = await import("../server/storage");
  const clean = await rota(a);
  const cleanSnapshot = await storage.snapshotWeekPlan(clean.plan);
  const entry = await history(clean, cleanSnapshot);
  const ownedHistory = await request(a.cookie, "GET", `/api/schedule/audit-log?branchId=${clean.branch}`);
  results.ownedHistory = ownedHistory.status === 200 && ownedHistory.body?.some((item: Json) => item.id === entry);
  const otherHistory = await request(b.cookie, "GET", "/api/schedule/audit-log");
  results.foreignHistoryList = otherHistory.status === 200 && Array.isArray(otherHistory.body) && !otherHistory.body.some((item: Json) => item.id === entry);
  for (let i = 0; i < 2; i++) await denied("foreignHistoryRestore", b.cookie, "POST", `/api/schedule/audit-log/${entry}/restore`);
  const victim = await rota(b);
  const mixed = await storage.snapshotWeekPlan(victim.plan);
  const poisoned = await history(clean, { ...mixed, weekPlan: cleanSnapshot.weekPlan });
  await denied("mixedSnapshot", a.cookie, "POST", `/api/schedule/audit-log/${poisoned}/restore`);
  // A rewritten tenant stamp must not confer ownership of existing foreign IDs.
  const forged = await history(clean, {
    ...mixed, weekPlan: cleanSnapshot.weekPlan,
    shiftRows: mixed.shiftRows.map((row: Json) => ({ ...row, tenantId: a.tenant, branchId: clean.branch, departmentId: a.department, shiftGroupId: clean.group, weekPlanId: clean.plan })),
    assignments: [], rowRoles: [], breaks: [],
  });
  await denied("mixedSnapshot", a.cookie, "POST", `/api/schedule/audit-log/${forged}/restore`);
  const foreignLink = (await q("insert into schedule_shift_row_roles(tenant_id,shift_row_id,role_id) values($1,$2,$3) returning id", [b.tenant, victim.row, sharedRole]))[0]!.id;
  const collidedLink = await history(clean, { ...cleanSnapshot, rowRoles: [{ id: foreignLink, tenantId: a.tenant, shiftRowId: clean.row, roleId: sharedRole }] });
  await denied("snapshotLinkCollision", a.cookie, "POST", `/api/schedule/audit-log/${collidedLink}/restore`);
  const restore1 = await request(a.cookie, "POST", `/api/schedule/audit-log/${entry}/restore`);
  const restore2 = await request(a.cookie, "POST", `/api/schedule/audit-log/${entry}/restore`);
  const storedCount = Number((await q("select count(*) n from schedule_assignments where id=$1", [clean.assignment]))[0]!.n);
  results.ownedRestoreReplay = restore1.status === 200 && restore2.status === 200 && storedCount === 1;
  // A later database write can fail after the restore has removed old rows.
  // Its own valid snapshot must either be fully restored or leave everything
  // as it was before the request, including assignments and saved breaks.
  await q(`create function zz_scheduling_restore_failure() returns trigger language plpgsql as $$ begin if NEW.employee_id = '${clean.employee}' then raise exception 'ZZ TEST restore interruption'; end if; return NEW; end $$`);
  await q("create trigger zz_scheduling_restore_failure before insert on schedule_assignments for each row execute function zz_scheduling_restore_failure()");
  try {
    const before = await snapshot();
    const interrupted = await request(a.cookie, "POST", `/api/schedule/audit-log/${entry}/restore`);
    results.restoreRollback = interrupted.status === 500 && before === await snapshot();
  } finally {
    await q("drop trigger zz_scheduling_restore_failure on schedule_assignments");
    await q("drop function zz_scheduling_restore_failure()");
  }

  const dutyType = (await q("insert into duty_types(tenant_id,name) values($1,'ZZ TEST duty') returning id", [a.tenant]))[0]!.id;
  const blockBody = { branchId: clean.branch, date: day, employeeId: clean.employee, assignmentId: clean.assignment, dutyTypeId: dutyType, startTime: "10:00", endTime: "10:30" };
  const block = await request(a.cookie, "POST", "/api/duty-blocks", blockBody);
  results.ownedDuty = block.status === 201 && !!block.body?.id;
  await denied("foreignDuty", b.cookie, "GET", `/api/duty-blocks?branchId=${clean.branch}&date=${day}`);
  await denied("foreignDuty", b.cookie, "POST", "/api/duty-blocks", blockBody);
  await denied("foreignDuty", b.cookie, "PATCH", `/api/duty-types/${dutyType}`, { name: "ZZ TEST unavailable" });
  if (block.body?.id) {
    await denied("foreignDuty", b.cookie, "PATCH", `/api/duty-blocks/${block.body.id}`, { notes: "ZZ TEST unavailable" });
    await denied("foreignDuty", b.cookie, "DELETE", `/api/duty-blocks/${block.body.id}`);
  }

  // Historical placement can disagree with a child's tenant stamp. Exercise
  // actual list joins and generator inputs, not just explicit request IDs.
  const visible = await rota(a), hidden = await rota(b);
  const badRow = randomUUID(), badAssignment = randomUUID();
  await q("insert into schedule_shift_rows(id,tenant_id,branch_id,shift_group_id,week_plan_id,start_time,end_time,label) values($1,$2,$3,$4,$5,'18:00','20:00','ZZ TEST mixed row')", [badRow, a.tenant, visible.branch, hidden.group, visible.plan]);
  await q("insert into schedule_assignments(id,tenant_id,week_plan_id,shift_row_id,shift_date,employee_id) values($1,$2,$3,$4,$5,$6)", [badAssignment, a.tenant, visible.plan, visible.row, day, hidden.employee]);
  const mixedWeek = await request(a.cookie, "GET", `/api/schedule/week?branchId=${visible.branch}&weekStartDate=${day}`);
  const mixedWeekText = JSON.stringify(mixedWeek.body);
  results.historicalWeek = mixedWeek.status === 200 && mixedWeekText.includes(visible.assignment) && !mixedWeekText.includes(badRow) && !mixedWeekText.includes(badAssignment) && !mixedWeekText.includes(hidden.employee);
  const visibleTemplate = await template(visible);
  const badTemplateRow = randomUUID();
  await q("insert into schedule_template_rows(id,tenant_id,template_id,shift_group_id,start_time,end_time) values($1,$2,$3,$4,'18:00','20:00')", [badTemplateRow, a.tenant, visibleTemplate, hidden.group]);
  const mixedTemplate = await request(a.cookie, "GET", `/api/schedule/templates/${visibleTemplate}`);
  results.historicalTemplate = mixedTemplate.status === 200 && mixedTemplate.body?.id === visibleTemplate && !JSON.stringify(mixedTemplate.body).includes(badTemplateRow);
  const badDuty = randomUUID();
  await q("insert into duty_blocks(id,tenant_id,branch_id,date,employee_id,assignment_id,duty_name,start_time,end_time) values($1,$2,$3,$4,$5,$6,'ZZ TEST mixed duty','10:00','10:30')", [badDuty, a.tenant, visible.branch, day, hidden.employee, hidden.assignment]);
  const mixedDuty = await request(a.cookie, "GET", `/api/duty-blocks?branchId=${visible.branch}&date=${day}`);
  results.historicalDuty = mixedDuty.status === 200 && Array.isArray(mixedDuty.body) && !JSON.stringify(mixedDuty.body).includes(badDuty);
  const regen = await request(a.cookie, "POST", `/api/schedule/shift-rows/${visible.row}/regenerate-breaks`);
  results.historicalBreaks = regen.status === 200 && (await q("select id from schedule_shift_breaks where assignment_id=$1", [badAssignment])).length === 0 && (await q("select id from schedule_shift_breaks where assignment_id=$1", [visible.assignment])).length > 0;

  const ownedBatch = await request(a.cookie, "POST", "/api/schedule/assignments/batch", { weekPlanId: own.plan, shiftRowId: own.row, shiftDate: day, employeeIds: [spare] });
  const repeatedBatch = await request(a.cookie, "POST", "/api/schedule/assignments/batch", { weekPlanId: own.plan, shiftRowId: own.row, shiftDate: day, employeeIds: [spare] });
  results.ownedBatchReplay = ownedBatch.status === 200 && ownedBatch.body?.assigned === 1 && repeatedBatch.status === 200 && repeatedBatch.body?.assigned === 0 && (await q("select id from schedule_assignments where shift_row_id=$1 and employee_id=$2 and shift_date=$3", [own.row, spare, day])).length === 1;
  const moveBefore = await snapshot();
  const limitedMove = await request(limited, "PATCH", `/api/schedule/assignments/${clean.assignment}/move`, { shiftRowId: clean.row, shiftDate: day });
  results.existingMoveBranchRule = limitedMove.status === 403 && moveBefore === await snapshot();
  // Parent ownership alone does not bound a physical FK cascade. Historical
  // foreign-owned children must make the operation stop before changing either
  // park, including SET NULL links and restore's replacement deletes.
  const guardedWeek = await rota(a);
  await q("insert into schedule_assignments(tenant_id,week_plan_id,shift_row_id,shift_date,employee_id) values($1,$2,$3,$4,$5)", [b.tenant, guardedWeek.plan, hidden.row, day, hidden.employee]);
  await denied("incomingForeignChildren", a.cookie, "DELETE", `/api/schedule/week/${guardedWeek.plan}`);
  const guardedTemplate = await template(visible);
  await q("insert into schedule_template_rows(tenant_id,template_id,shift_group_id,start_time,end_time) values($1,$2,$3,'18:00','20:00')", [b.tenant, guardedTemplate, hidden.group]);
  await denied("incomingForeignChildren", a.cookie, "DELETE", `/api/schedule/templates/${guardedTemplate}`);
  const guardedAssignment = await rota(a);
  await q("insert into schedule_shift_breaks(tenant_id,branch_id,shift_row_id,shift_date,employee_id,assignment_id,break_start_time,break_end_time) values($1,$2,$3,$4,$5,$6,'12:00','13:00')", [b.tenant, hidden.branch, hidden.row, day, hidden.employee, guardedAssignment.assignment]);
  await denied("incomingForeignChildren", a.cookie, "DELETE", `/api/schedule/assignments/${guardedAssignment.assignment}`);
  const guardedRestore = await rota(a);
  const guardedSnapshot = await storage.snapshotWeekPlan(guardedRestore.plan);
  const guardedEntry = await history(guardedRestore, guardedSnapshot);
  await q("insert into schedule_assignments(tenant_id,week_plan_id,shift_row_id,shift_date,employee_id) values($1,$2,$3,$4,$5)", [b.tenant, hidden.plan, guardedRestore.row, day, hidden.employee]);
  await denied("incomingForeignChildren", a.cookie, "POST", `/api/schedule/audit-log/${guardedEntry}/restore`);
  for (const path of [`/api/schedule/shift-rows/${clean.row}/assignments/${day}`, `/api/schedule/shift-rows/${clean.row}`, `/api/schedule/week/${clean.plan}`]) await denied("foreignDestructive", b.cookie, "DELETE", path);
  console.log("SCHEDULING_RESULTS=" + JSON.stringify(results));
  console.log("SCHEDULING_DETAILS=" + JSON.stringify(details));
  const { pool: appPool } = await import("../server/db");
  await appPool.end();
} catch (error) {
  const safe = error as { name?: string; code?: string; table?: string; column?: string };
  console.error("SCHEDULING_SETUP_ERROR=" + JSON.stringify({ stage, name: safe.name, code: safe.code, table: safe.table, column: safe.column }));
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    const closed = new Promise<void>(resolve => child!.once("exit", () => resolve()));
    child.kill();
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 2000))]);
  }
  await pool.end();
}
process.exit(process.exitCode ?? 0);
