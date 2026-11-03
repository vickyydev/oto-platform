// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-659, the owner's ruling of 3 November 2026 — a deliberate change from
// the prototype. Creating a checklist for two branches has always made one
// template per branch; editing and adding a branch made one shared template.
// The editor now chooses, and the server holds these whatever the screen sends:
//
//   1. Creating a checklist does not change.
//   2. "Save as a new checklist" (POST with copiedFromTemplateId) makes an
//      independent checklist from the edited values and writes nothing to the
//      original: the row, its items, its named employees, its media, its runs.
//   3. A copy carries everything the create path carries: items and their
//      settings, schedule, recurrence, checker rounds, named employees, the
//      older department, role and department assignment, location, and
//      reference media. What the request leaves out comes from the original.
//   4. A copy starts with a clean history: version 1, no runs; past runs and an
//      in-progress run stay with the original, untouched.
//   5. Reference media opens for staff at the copy's branch, removing it from
//      one checklist leaves it on the other, and the stored object goes only
//      with the last row that names it.
//   6. "Make a separate copy" while adding a branch (PATCH branchCopyChoice
//      "copy") makes one independent template per added branch; the original
//      keeps its branches and takes the rest of the edit.
//   7. "Share", or a caller naming no choice, does what an edit always did.
//      Removing a branch does too, with or without a copy.
//   8. A checklist already shared, or on no branch, is not split by anything
//      here: no change happens that nobody asked for.
//   9. The recurring run creator makes one run per branch per period for a
//      copy, and no extra run on the original.
//  10. The branch check create uses, requireManager and the park group fence
//      hold on every target branch of a copy, before anything is written.
//  11. A manager at the second branch of a shared checklist can read it and
//      copy it to their own branch; a plain save stays refused as before.
//  12. The editor's wording: the shared note names only branches the person may
//      see, and the two answers read as the owner wrote them.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/checklist-copies.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  addedBranchIds,
  addedBranchQuestion,
  checklistBranchIds,
  sameBranches,
  saveAsNewSummary,
  sharedChecklistNote,
} from "../client/src/lib/checklist-branch-edit";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("checklist-copies.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, any>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");

// ─── Rows ─────────────────────────────────────────────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
const otherTenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST cc ${run}`, `zz-cc-${run}`]);
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [otherTenant, `ZZ TEST cc2 ${run}`, `zz-cc2-${run}`]);

async function branch(tenantId: string, label: string): Promise<string> {
  const id = randomUUID();
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
    id,
    tenantId,
    `ZZ TEST ${label} ${run}`,
  ]);
  return id;
}
const hkt = await branch(tenant, "HKT");
const robinson = await branch(tenant, "Robinson");
const patong = await branch(tenant, "Patong");
const foreignBranch = await branch(otherTenant, "Foreign");

async function user(
  tenantId: string,
  role: string,
  label: string,
  scope: { all: true } | { branches: string[] },
): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `zz-cc-${label.toLowerCase()}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role],
  );
  if ("all" in scope) {
    await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenantId, id]);
  } else {
    for (const branchId of scope.branches) {
      await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
        tenantId,
        id,
        branchId,
      ]);
    }
  }
  return { id, email };
}
const people = {
  admin: await user(tenant, "admin", "Admin", { all: true }),
  managerHkt: await user(tenant, "manager", "ManagerHkt", { branches: [hkt] }),
  managerRobinson: await user(tenant, "manager", "ManagerRobinson", { branches: [robinson] }),
  managerBoth: await user(tenant, "manager", "ManagerBoth", { branches: [hkt, robinson] }),
  staffPatong: await user(tenant, "staff", "StaffPatong", { branches: [patong] }),
  managerForeign: await user(otherTenant, "manager", "ManagerForeign", { branches: [foreignBranch] }),
};
type Who = keyof typeof people;

async function department(label: string): Promise<string> {
  const id = randomUUID();
  await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [id, tenant, `ZZ TEST ${label} ${run}`]);
  return id;
}
const floor = await department("Floor");
const kitchen = await department("Kitchen");

async function employee(label: string, branchId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status)
     values ($1, $2, $3, $4, $5, $6, 'active')`,
    [id, tenant, branchId, `ZZ TEST ${label} ${run}`, label, `zz-cc-emp-${label.toLowerCase()}-${run}@example.com`],
  );
  return id;
}
const ann = await employee("Ann", hkt);
const bob = await employee("Bob", hkt);

const location = randomUUID();
await q("insert into locations (id, tenant_id, name) values ($1, $2, $3)", [location, tenant, `ZZ TEST Pool ${run}`]);

// ─── A stand-in bucket: signed URLs need a host, and deletes are what matter ─

const BUCKET = `zz-cc-${run}`;
const bucketDeletes: string[] = [];
const bucketServer = createServer((req, res) => {
  if (req.method === "DELETE") bucketDeletes.push(decodeURIComponent(new URL(req.url ?? "/", "http://bucket").pathname));
  res.writeHead(204);
  res.end();
});
await new Promise<void>((resolve) => bucketServer.listen(0, "127.0.0.1", resolve));
const BUCKET_PORT = (bucketServer.address() as AddressInfo).port;

// ─── The server ──────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
const HARNESS_ENV = {
  NODE_ENV: "test",
  APP_ENV: "dev",
  STORAGE_ENV_PREFIX: "zz-test",
  OTOAPP_LEGACY_LOGIN: "true",
  LOG_LEVEL: "warn",
  TZ: "UTC",
  DEPLOY_ENV: "local",
  OTOAPP_JOBS: "platform",
  USE_AWS_REKOGNITION: "false",
  OBJECT_STORAGE: "s3",
  S3_BUCKET: BUCKET,
  S3_ENDPOINT: "127.0.0.1",
  S3_PORT: String(BUCKET_PORT),
  S3_USE_SSL: "false",
  AWS_REGION: "auto",
  AWS_ACCESS_KEY_ID: "zz-access",
  AWS_SECRET_ACCESS_KEY: "zz-secret",
  SESSION_SECRET: `zz-session-${run}`,
};

async function serve(): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 180_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${code}:\n${output}`));
    });
  });
}

let ORIGIN = "";
const cookies = new Map<Who, string>();

async function signIn(who: Who): Promise<void> {
  const res = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: people[who].email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in as ${who}: ${res.status} ${await res.text()}`);
  cookies.set(who, res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "));
}

async function api(who: Who, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), cookie: cookies.get(who)! },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON: kept as text for the message */
  }
  return { status: res.status, body: parsed };
}

let checks = 0;
const check = async (title: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

// ─── What the tests look at ──────────────────────────────────────────────────

const ROW = "select * from checklist_templates where id = $1";
const templateRow = async (id: string) => (await q(ROW, [id]))[0];
const itemsOf = (id: string) => q("select * from checklist_template_items where template_id = $1 order by sort_order, id", [id]);
const namedOf = async (id: string) =>
  (await q<{ e: string }>("select employee_id as e from checklist_template_assignees where template_id = $1 order by created_at", [id])).map((r) => r.e);
const runsOf = (id: string) => q("select * from checklist_runs where template_id = $1 order by created_at, id", [id]);
const headerMediaOf = (id: string) => q("select * from checklist_attachments where checklist_template_id = $1 order by sort_order, id", [id]);
const itemMediaOf = (itemId: string) => q("select * from checklist_attachments where checklist_template_item_id = $1 order by sort_order, id", [itemId]);

/** Every row that says what a checklist is and has done, in one comparable value. */
async function snapshot(id: string): Promise<string> {
  const items = await itemsOf(id);
  const runs = await runsOf(id);
  const itemIds = items.map((i) => i.id);
  const runIds = runs.map((r) => r.id);
  return JSON.stringify({
    template: await templateRow(id),
    items,
    assignees: await q("select * from checklist_template_assignees where template_id = $1 order by id", [id]),
    header: await headerMediaOf(id),
    itemMedia: itemIds.length
      ? await q("select * from checklist_attachments where checklist_template_item_id = any($1::uuid[]) order by id", [itemIds])
      : [],
    runs,
    runItems: runIds.length ? await q("select * from checklist_run_items where run_id = any($1::uuid[]) order by id", [runIds]) : [],
  });
}

const createdWithName = (name: string) => q("select * from checklist_templates where tenant_id = $1 and name = $2 order by created_at", [tenant, name]);

async function attach(target: { templateId?: string; itemId?: string }, label: string, sortOrder = 0): Promise<{ id: string; s3Key: string }> {
  const owner = target.templateId ?? target.itemId;
  const s3Key = `checklists/${owner}/${target.templateId ? "header" : `items/${owner}`}/${randomUUID()}.jpg`;
  const [row] = await q<{ id: string }>(
    `insert into checklist_attachments
       (tenant_id, checklist_template_id, checklist_template_item_id, type, s3_key, mime_type, file_size, original_filename, width, height, sort_order, created_by_user_id)
     values ($1, $2, $3, 'image', $4, 'image/jpeg', 1234, $5, 640, 480, $6, $7) returning id`,
    [tenant, target.templateId ?? null, target.itemId ?? null, s3Key, `${label}.jpg`, sortOrder, people.admin.id],
  );
  return { id: row.id, s3Key };
}

/** A checklist with everything on it, saved through the route the editors use. */
async function fullChecklist(label: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; name: string; items: any[] }> {
  const name = `ZZ TEST ${label} ${run}`;
  const created = await api("admin", "POST", "/api/checklists/templates", {
    name,
    description: `${label} description`,
    branchIds: [hkt],
    departmentId: floor,
    recurrence: "weekly",
    weeklyDays: ["mon", "thu"],
    scheduledTime: "08:15",
    locationId: location,
    assignedEmployeeIds: [ann, bob],
    referenceMediaUrls: ["https://example.invalid/header.jpg"],
    items: [
      {
        title: "First",
        description: "First description",
        requiresNote: true,
        requiresPhoto: true,
        cameraEnabled: false,
        galleryEnabled: true,
        isCritical: true,
        linkedToFix: true,
        departmentId: kitchen,
        zoneLabel: "Zone A",
        referenceMediaUrls: ["https://example.invalid/first.jpg"],
      },
      { title: "Second" },
      { title: "Third" },
    ],
    ...overrides,
  });
  assert.equal(created.status, 201, `making ${label}: ${created.status} ${JSON.stringify(created.body)}`);
  return { id: created.body.id, name, items: await itemsOf(created.body.id) };
}

/** What the editor sends for an item it read back. */
const asSent = (item: any) => ({
  id: item.id,
  title: item.title,
  description: item.description,
  requiresNote: item.requires_note === true,
  requiresPhoto: item.requires_photo === true,
  cameraEnabled: item.camera_enabled,
  galleryEnabled: item.gallery_enabled,
  isCritical: item.is_critical === true,
  linkedToFix: item.linked_to_fix === true,
  departmentId: item.department_id,
  zoneLabel: item.zone_label,
  referenceMediaUrls: item.reference_media_urls,
});

try {
  ORIGIN = await serve();
  for (const who of Object.keys(people) as Who[]) await signIn(who);

  // ── 1. Creating does not change ───────────────────────────────────────────

  await check("creating a checklist for two branches still makes one independent template per branch", async () => {
    const name = `ZZ TEST Create ${run}`;
    const res = await api("admin", "POST", "/api/checklists/templates", { name, branchIds: [hkt, robinson], recurrence: "daily", items: [{ title: "One" }] });
    assert.equal(res.status, 201);
    assert.equal(res.body.createdCount, 2);
    assert.deepEqual(res.body.branchIds, [hkt, robinson]);
    assert.equal(res.body.message, "Created 2 templates (one per branch)");
    assert.equal("copiedFromTemplateId" in res.body, false, "a plain create names a source");
    const rows = await createdWithName(name);
    assert.deepEqual(rows.map((r) => r.branch_id).sort(), [hkt, robinson].sort());
    for (const row of rows) assert.deepEqual(row.branch_ids, [], "a created template stores a branch list");
  });

  // ── 2, 3. Save as a new checklist ─────────────────────────────────────────

  const source = await fullChecklist("Source");
  const header = await attach({ templateId: source.id }, "header");
  const firstItemMedia = await attach({ itemId: source.items[0].id }, "first-a");
  await attach({ itemId: source.items[0].id }, "first-b", 1);
  const removedItemMedia = await attach({ itemId: source.items[2].id }, "third");
  const editedName = `ZZ TEST Source copied ${run}`;
  let copyId = "";

  await check("save as new: a new checklist from the edited values, and the original exactly as it was", async () => {
    const before = await snapshot(source.id);
    // The editor's own payload: the third item taken off, the first reworded,
    // one added; it does not send the older department or the template's media.
    const res = await api("admin", "POST", "/api/checklists/templates", {
      copiedFromTemplateId: source.id,
      name: editedName,
      description: "Edited description",
      recurrence: "weekly",
      weeklyDays: ["tue"],
      scheduledTime: "09:45",
      locationId: location,
      checklistType: "operational",
      assignedEmployeeIds: [bob],
      assignedRoleId: null,
      assignedDepartmentId: null,
      branchIds: [robinson],
      items: [
        { ...asSent(source.items[0]), title: "First reworded" },
        asSent(source.items[1]),
        { title: "Added", requiresNote: true },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    copyId = res.body.id;
    assert.notEqual(copyId, source.id);
    assert.equal(res.body.copiedFromTemplateId, source.id);
    assert.equal(res.body.createdCount, 1);
    assert.equal(await snapshot(source.id), before, "the original changed");

    const copy = await templateRow(copyId);
    assert.equal(copy.name, editedName);
    assert.equal(copy.description, "Edited description");
    assert.equal(copy.branch_id, robinson);
    assert.deepEqual(copy.branch_ids, [], "a copy is one branch's own template, like a created one");
    assert.equal(copy.recurrence, "weekly");
    assert.deepEqual(copy.weekly_days, ["tue"]);
    assert.equal(copy.scheduled_time, "09:45");
    assert.equal(copy.location_id, location);
    assert.equal(copy.department_id, floor, "the older department did not come from the original");
    assert.deepEqual(copy.reference_media_urls, ["https://example.invalid/header.jpg"], "the template's media URLs did not come across");
    assert.equal(copy.assigned_employee_id, bob);
    assert.deepEqual(await namedOf(copyId), [bob]);
    assert.equal(copy.created_by, people.admin.id);
    assert.equal(copy.is_active, true);

    const items = await itemsOf(copyId);
    assert.deepEqual(items.map((i) => i.title), ["First reworded", "Second", "Added"]);
    assert.equal(items[0].description, "First description");
    assert.equal(items[0].requires_note, true);
    assert.equal(items[0].requires_photo, true);
    assert.equal(items[0].camera_enabled, false);
    assert.equal(items[0].gallery_enabled, true);
    assert.equal(items[0].is_critical, true);
    assert.equal(items[0].linked_to_fix, true);
    assert.equal(items[0].department_id, kitchen);
    assert.equal(items[0].zone_label, "Zone A");
    assert.deepEqual(items[0].reference_media_urls, ["https://example.invalid/first.jpg"]);
    assert.equal(items[2].requires_note, true);
    for (const item of items) assert.ok(!source.items.some((s) => s.id === item.id), "the copy shares an item row with the original");
  });

  await check("save as new carries the role, the department assignment and a monthly schedule", async () => {
    const byRole = await fullChecklist("By role", { recurrence: "monthly", weeklyDays: [], monthlyDay: 12, assignedEmployeeIds: [], assignedRoleId: "zz-role" });
    const roleCopy = await api("admin", "POST", "/api/checklists/templates", {
      copiedFromTemplateId: byRole.id,
      name: `${byRole.name} copy`,
      branchIds: [patong],
      assignedEmployeeIds: [],
      assignedRoleId: "zz-role",
      assignedDepartmentId: null,
    });
    assert.equal(roleCopy.status, 201);
    const roleRow = await templateRow(roleCopy.body.id);
    assert.equal(roleRow.assigned_role_id, "zz-role");
    assert.equal(roleRow.monthly_day, 12, "the editor sends the month day only when it applies; a copy keeps it");
    assert.equal(roleRow.recurrence, "monthly");
    assert.deepEqual(await namedOf(roleCopy.body.id), []);

    const byDepartment = await fullChecklist("By department", { assignedEmployeeIds: [], assignedDepartmentId: floor });
    const departmentCopy = await api("admin", "POST", "/api/checklists/templates", {
      copiedFromTemplateId: byDepartment.id,
      name: `${byDepartment.name} copy`,
      branchIds: [hkt],
      assignedEmployeeIds: [],
      assignedRoleId: null,
      assignedDepartmentId: floor,
    });
    assert.equal(departmentCopy.status, 201);
    assert.equal((await templateRow(departmentCopy.body.id)).assigned_department_id, floor);
  });

  await check("save as new carries a checker's rounds, round times and allowed roles", async () => {
    const checker = await fullChecklist("Checker", {
      checklistType: "checker",
      recurrence: "daily",
      weeklyDays: [],
      checkerRounds: 3,
      scheduleTime1: "10:30",
      scheduleTime2: "15:30",
      scheduleTime3: "18:00",
      allowedCheckerRoles: ["manager", "supervisor"],
      assignedEmployeeIds: [],
    });
    const res = await api("admin", "POST", "/api/checklists/templates", {
      copiedFromTemplateId: checker.id,
      name: `${checker.name} copy`,
      branchIds: [patong],
      checklistType: "checker",
      checkerRounds: 2,
      scheduleTime1: "11:00",
      scheduleTime2: "16:00",
      scheduleTime3: "18:00",
      scheduleTime4: null,
      scheduleTime5: null,
      items: [{ ...asSent(checker.items[0]), linkedToFix: true }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await templateRow(res.body.id);
    assert.equal(row.checklist_type, "checker");
    assert.equal(row.checker_rounds, 2);
    assert.equal(row.schedule_time_1, "11:00");
    assert.equal(row.schedule_time_2, "16:00");
    assert.deepEqual(row.allowed_checker_roles, ["manager", "supervisor"], "the editor does not send them; they come from the original");
    const items = await itemsOf(res.body.id);
    assert.equal(items[0].linked_to_fix, false, "a checker's item is never linked to Fix, as the create path has it");
    assert.equal(items[0].zone_label, "Zone A");
  });

  await check("a request that leaves everything out copies the original to the original's branches", async () => {
    const res = await api("managerHkt", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await templateRow(res.body.id);
    const original = await templateRow(source.id);
    assert.equal(row.name, original.name);
    assert.equal(row.branch_id, hkt);
    assert.equal(row.scheduled_time, original.scheduled_time);
    assert.deepEqual(row.weekly_days, original.weekly_days);
    assert.deepEqual(await namedOf(res.body.id), [ann, bob]);
    assert.deepEqual((await itemsOf(res.body.id)).map((i) => i.title), source.items.map((i) => i.title));
    assert.equal((await headerMediaOf(res.body.id)).length, 1);
    assert.equal(row.created_by, people.managerHkt.id);
  });

  await check("save as new for two branches makes one independent template each, as creating does", async () => {
    const name = `ZZ TEST Two copies ${run}`;
    const res = await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id, name, branchIds: [robinson, patong] });
    assert.equal(res.status, 201);
    assert.equal(res.body.createdCount, 2);
    const rows = await createdWithName(name);
    assert.deepEqual(rows.map((r) => r.branch_id).sort(), [robinson, patong].sort());
    const [a, b] = rows;
    assert.notEqual(a.id, b.id);
    const itemsA = await itemsOf(a.id);
    const itemsB = await itemsOf(b.id);
    assert.ok(itemsA.every((i) => !itemsB.some((j) => j.id === i.id)), "two copies share an item row");
    assert.equal((await itemMediaOf(itemsA[0].id)).length, 2);
    assert.equal((await itemMediaOf(itemsB[0].id)).length, 2);
  });

  await check("save as new with no branch selected follows the create path: all branches for an admin, the person's own for a manager", async () => {
    const adminCopy = await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id, name: `ZZ TEST No branch admin ${run}`, branchIds: [] });
    assert.equal(adminCopy.status, 201);
    assert.equal((await templateRow(adminCopy.body.id)).branch_id, null);
    const managerCopy = await api("managerRobinson", "POST", "/api/checklists/templates", {
      copiedFromTemplateId: (await fullChecklist("Everywhere", { branchIds: [], items: [{ title: "One" }] })).id,
      name: `ZZ TEST No branch manager ${run}`,
      branchIds: [],
    });
    assert.equal(managerCopy.status, 201, JSON.stringify(managerCopy.body));
    assert.equal((await templateRow(managerCopy.body.id)).branch_id, robinson);
  });

  // ── 4. Clean history ──────────────────────────────────────────────────────

  await check("a copy starts with a clean history; past runs and an in-progress run stay with the original, untouched", async () => {
    const daily = await fullChecklist("History", { recurrence: "daily", weeklyDays: [] });
    const past = randomUUID();
    await q(
      `insert into checklist_runs (id, tenant_id, template_id, branch_id, status, completed_at, period_start, period_end)
       values ($1, $2, $3, $4, 'completed', now() - interval '3 days', now() - interval '4 days', now() - interval '3 days')`,
      [past, tenant, daily.id, hkt],
    );
    const started = await api("managerHkt", "POST", "/api/checklist-runs/start", { templateId: daily.id, branchId: hkt });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await q(
      "update checklist_run_items set is_completed = true, completed_at = now(), note = 'ZZ done' where id in (select id from checklist_run_items where run_id = $1 limit 1)",
      [started.body.id],
    );
    const before = await snapshot(daily.id);

    const res = await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: daily.id, name: `${daily.name} copy`, branchIds: [hkt] });
    assert.equal(res.status, 201);
    assert.equal(await snapshot(daily.id), before, "the original's runs or its row changed");
    assert.deepEqual(await runsOf(res.body.id), [], "runs came across to the copy");
    const copy = await templateRow(res.body.id);
    assert.equal(copy.template_version, 1, "a copy does not carry the original's version");

    // The separate-copy answer on a plain edit: the in-progress run keeps its work.
    const runItemsBefore = await q("select id, is_completed, note, completed_at from checklist_run_items where run_id = $1 order by id", [started.body.id]);
    const patched = await api("admin", "PATCH", `/api/checklists/templates/${daily.id}`, { branchIds: [hkt, patong], branchId: hkt, branchCopyChoice: "copy" });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(await q("select id, is_completed, note, completed_at from checklist_run_items where run_id = $1 order by id", [started.body.id]), runItemsBefore);
    const [stillRunning] = await q("select status, branch_id from checklist_runs where id = $1", [started.body.id]);
    assert.equal(stillRunning.status, "in_progress");
    assert.equal(stillRunning.branch_id, hkt);
    assert.deepEqual(await runsOf(patched.body.createdCopies[0].id), [], "runs came across to the branch copy");
    assert.deepEqual((await q("select status from checklist_runs where id = $1", [past]))[0].status, "completed");
  });

  // ── 5. Media ──────────────────────────────────────────────────────────────

  await check("the copy's media is its own rows: header and items, for the items it kept and none for those it dropped", async () => {
    const copyHeader = await headerMediaOf(copyId);
    assert.equal(copyHeader.length, 1);
    assert.equal(copyHeader[0].s3_key, header.s3Key);
    assert.notEqual(copyHeader[0].id, header.id);
    assert.equal(copyHeader[0].original_filename, "header.jpg");
    assert.equal(copyHeader[0].width, 640);
    const items = await itemsOf(copyId);
    const firstMedia = await itemMediaOf(items[0].id);
    assert.deepEqual(firstMedia.map((m) => m.original_filename), ["first-a.jpg", "first-b.jpg"], "the first item's media did not follow it");
    assert.equal((await itemMediaOf(items[2].id)).length, 0, "an added item took media");
    assert.ok(
      (await q("select 1 from checklist_attachments where s3_key = $1 and checklist_template_item_id = any($2::uuid[])", [removedItemMedia.s3Key, items.map((i) => i.id)])).length === 0,
      "the dropped item's media came across",
    );
  });

  await check("media opens for the people at the copy's branch and not for people out of reach of it", async () => {
    const staffCopy = await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id, name: `ZZ TEST Staff media ${run}`, branchIds: [patong] });
    assert.equal(staffCopy.status, 201);
    const listed = await api("staffPatong", "GET", `/api/checklist-media/by-template/${staffCopy.body.id}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.attachments.length, 1);
    const byItem = await api("staffPatong", "GET", `/api/checklist-media/items-by-template/${staffCopy.body.id}`);
    assert.equal(byItem.status, 200);
    assert.equal(Object.keys(byItem.body.attachmentsByItem).length, 2, "both of the copy's items with media are listed");

    // The object's first row belongs to the original, at a branch this person cannot reach.
    const opened = await api("staffPatong", "GET", `/api/checklist-media/url?s3Key=${encodeURIComponent(header.s3Key)}`);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(new URL(opened.body.url).host, `127.0.0.1:${BUCKET_PORT}`);
    assert.equal(new URL(opened.body.url).searchParams.has("X-Amz-Signature"), true);
    const openedItem = await api("staffPatong", "GET", `/api/checklist-media/url?s3Key=${encodeURIComponent(firstItemMedia.s3Key)}`);
    assert.equal(openedItem.status, 200, JSON.stringify(openedItem.body));

    const unrelated = await fullChecklist("Unrelated media");
    const unrelatedHeader = await attach({ templateId: unrelated.id }, "unrelated");
    assert.equal((await api("staffPatong", "GET", `/api/checklist-media/url?s3Key=${encodeURIComponent(unrelatedHeader.s3Key)}`)).status, 404, "a file on no checklist of theirs opened");
    assert.equal((await api("managerForeign", "GET", `/api/checklist-media/url?s3Key=${encodeURIComponent(header.s3Key)}`)).status, 404, "another park group opened the file");
  });

  await check("removing media from one checklist leaves it on the other; the object goes with the last row", async () => {
    const own = await fullChecklist("Own media");
    const file = await attach({ templateId: own.id }, "own");
    const res = await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: own.id, name: `${own.name} copy`, branchIds: [robinson] });
    assert.equal(res.status, 201);
    const [copyRow] = await headerMediaOf(res.body.id);
    assert.equal(copyRow.s3_key, file.s3Key);

    bucketDeletes.length = 0;
    assert.equal((await api("admin", "DELETE", `/api/checklist-media/${copyRow.id}`)).status, 200);
    assert.equal((await headerMediaOf(res.body.id)).length, 0);
    assert.deepEqual(bucketDeletes, [], "removing it from the copy deleted the original's file");
    assert.equal((await api("managerHkt", "GET", `/api/checklist-media/url?s3Key=${encodeURIComponent(file.s3Key)}`)).status, 200, "the original's media no longer opens");

    assert.equal((await api("admin", "DELETE", `/api/checklist-media/${file.id}`)).status, 200);
    assert.deepEqual(bucketDeletes, [`/${BUCKET}/${file.s3Key}`], "the last row's removal did not delete the file");
  });

  await check("each is edited on its own, and deleting the original leaves the copy and its media", async () => {
    const own = await fullChecklist("Independent");
    const file = await attach({ templateId: own.id }, "independent");
    const res = await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: own.id, name: `${own.name} copy`, branchIds: [robinson] });
    const copy = res.body.id as string;

    const copyBefore = await snapshot(copy);
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${own.id}`, { name: `${own.name} renamed`, items: [{ title: "Only" }] })).status, 200);
    assert.equal(await snapshot(copy), copyBefore, "an edit of the original reached the copy");

    const ownBefore = await snapshot(own.id);
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${copy}`, { name: "ZZ TEST copy renamed", items: [{ title: "Other" }] })).status, 200);
    assert.equal(await snapshot(own.id), ownBefore, "an edit of the copy reached the original");

    bucketDeletes.length = 0;
    assert.equal((await api("admin", "DELETE", `/api/checklists/templates/${own.id}`)).status, 200);
    assert.ok(await templateRow(copy), "deleting the original took the copy");
    assert.equal((await headerMediaOf(copy)).length, 1);
    assert.deepEqual(bucketDeletes, []);
    assert.equal((await api("managerRobinson", "GET", `/api/checklist-media/url?s3Key=${encodeURIComponent(file.s3Key)}`)).status, 200);
  });

  // ── 6. A separate copy while adding a branch ──────────────────────────────

  await check("separate copy: the original keeps its branch and the rest of the edit; each added branch gets its own", async () => {
    const original = await fullChecklist("Adding");
    const media = await attach({ templateId: original.id }, "adding");
    const res = await api("admin", "PATCH", `/api/checklists/templates/${original.id}`, {
      name: `${original.name} edited`,
      branchId: hkt,
      branchIds: [hkt, robinson, patong],
      branchCopyChoice: "copy",
      items: [asSent(original.items[0]), asSent(original.items[1]), { title: "Added here" }],
      assignedEmployeeIds: [ann],
      assignedRoleId: null,
      assignedDepartmentId: null,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.createdCopies.length, 2);

    const row = await templateRow(original.id);
    assert.equal(row.branch_id, hkt);
    assert.deepEqual(row.branch_ids, [], "the original's branches were written");
    assert.equal(row.name, `${original.name} edited`, "the rest of the edit did not save to the original");
    assert.equal(row.template_version, 2);
    assert.deepEqual(await namedOf(original.id), [ann]);
    assert.deepEqual((await itemsOf(original.id)).map((i) => i.title), ["First", "Second", "Added here"]);

    const copies = await Promise.all(res.body.createdCopies.map((c: { id: string }) => templateRow(c.id)));
    assert.deepEqual(copies.map((c) => c.branch_id).sort(), [robinson, patong].sort());
    for (const copy of copies) {
      assert.equal(copy.name, `${original.name} edited`);
      assert.deepEqual(copy.branch_ids, []);
      assert.equal(copy.department_id, floor);
      assert.equal(copy.template_version, 1);
      assert.deepEqual(await namedOf(copy.id), [ann]);
      const items = await itemsOf(copy.id);
      assert.deepEqual(items.map((i) => i.title), ["First", "Second", "Added here"]);
      assert.equal((await headerMediaOf(copy.id))[0].s3_key, media.s3Key);
      assert.ok(items.every((i) => i.template_id === copy.id));
    }
  });

  await check("separate copy on a shared checklist, removing a branch in the same edit: the removal behaves as today", async () => {
    const shared = await fullChecklist("Shared swap");
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${shared.id}`, { branchId: hkt, branchIds: [hkt, robinson] })).status, 200);
    const res = await api("admin", "PATCH", `/api/checklists/templates/${shared.id}`, { branchId: hkt, branchIds: [hkt, patong], branchCopyChoice: "copy" });
    assert.equal(res.status, 200);
    const row = await templateRow(shared.id);
    assert.equal(row.branch_id, hkt);
    assert.deepEqual(row.branch_ids, [hkt]);
    assert.equal(res.body.createdCopies.length, 1);
    assert.equal(res.body.createdCopies[0].branchId, patong);
  });

  await check("separate copy that keeps none of the original's branches leaves them where they are", async () => {
    const moving = await fullChecklist("Moving");
    const res = await api("admin", "PATCH", `/api/checklists/templates/${moving.id}`, { branchId: robinson, branchIds: [robinson], branchCopyChoice: "copy" });
    assert.equal(res.status, 200);
    const row = await templateRow(moving.id);
    assert.equal(row.branch_id, hkt);
    assert.deepEqual(row.branch_ids, []);
    assert.equal(res.body.createdCopies[0].branchId, robinson);
  });

  await check("separate copy with nothing added makes nothing, and a checklist on no branch stays on no branch", async () => {
    const plain = await fullChecklist("Nothing added");
    const none = await api("admin", "PATCH", `/api/checklists/templates/${plain.id}`, { branchId: hkt, branchIds: [hkt], branchCopyChoice: "copy" });
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.createdCopies, []);
    assert.equal((await templateRow(plain.id)).branch_id, hkt);

    const everywhere = await fullChecklist("Everywhere two", { branchIds: [] });
    assert.equal((await templateRow(everywhere.id)).branch_id, null);
    const res = await api("admin", "PATCH", `/api/checklists/templates/${everywhere.id}`, { branchId: robinson, branchIds: [robinson], branchCopyChoice: "copy" });
    assert.equal(res.status, 200);
    const row = await templateRow(everywhere.id);
    assert.equal(row.branch_id, null, "the all-branches checklist was narrowed");
    assert.deepEqual(row.branch_ids, []);
    assert.equal(res.body.createdCopies[0].branchId, robinson);
  });

  // ── 7. Share, no choice, and removal keep today's behaviour ───────────────

  await check("share, and a caller naming no choice, widen the one template as an edit always did", async () => {
    for (const choice of ["share", undefined]) {
      const one = await fullChecklist(`Share ${choice ?? "none"}`);
      const res = await api("admin", "PATCH", `/api/checklists/templates/${one.id}`, {
        branchId: hkt,
        branchIds: [hkt, robinson],
        ...(choice ? { branchCopyChoice: choice } : {}),
      });
      assert.equal(res.status, 200);
      assert.equal("createdCopies" in res.body, false, "a plain edit answered with copies");
      const row = await templateRow(one.id);
      assert.equal(row.branch_id, hkt);
      assert.deepEqual(row.branch_ids, [hkt, robinson]);
      assert.equal((await createdWithName(one.name)).length, 1, "a share made a second template");
    }
  });

  await check("a plain edit leaves the rest as it was: no branch fields, no branch change; removing a branch narrows the one template", async () => {
    const one = await fullChecklist("Plain");
    const res = await api("admin", "PATCH", `/api/checklists/templates/${one.id}`, { name: `${one.name} two` });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.propagatedRunCount, "number");
    const row = await templateRow(one.id);
    assert.equal(row.name, `${one.name} two`);
    assert.equal(row.branch_id, hkt);
    assert.deepEqual(row.branch_ids, []);
    assert.equal(row.template_version, 2);

    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${one.id}`, { branchId: hkt, branchIds: [hkt, robinson] })).status, 200);
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${one.id}`, { branchId: robinson, branchIds: [robinson] })).status, 200);
    const narrowed = await templateRow(one.id);
    assert.equal(narrowed.branch_id, robinson);
    assert.deepEqual(narrowed.branch_ids, [robinson]);
  });

  // ── 8. Nothing is split behind anyone's back ──────────────────────────────

  await check("a shared checklist and one on no branch stay one template through a plain edit", async () => {
    const shared = await fullChecklist("Stays shared");
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${shared.id}`, { branchId: hkt, branchIds: [hkt, robinson] })).status, 200);
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${shared.id}`, { name: shared.name, description: "Edited" })).status, 200);
    assert.equal((await createdWithName(shared.name)).length, 1);
    assert.deepEqual((await templateRow(shared.id)).branch_ids, [hkt, robinson]);

    const everywhere = await fullChecklist("Stays everywhere", { branchIds: [] });
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${everywhere.id}`, { description: "Edited" })).status, 200);
    assert.equal((await createdWithName(everywhere.name)).length, 1);
    assert.equal((await templateRow(everywhere.id)).branch_id, null);
  });

  // ── 9. The recurring run creator ──────────────────────────────────────────

  await check("one run per branch per period for a copy, and no extra run on the original", async () => {
    const daily = await fullChecklist("Runs", { recurrence: "daily", weeklyDays: [] });
    const asNew = await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: daily.id, name: `${daily.name} new`, branchIds: [robinson] });
    const added = await api("admin", "PATCH", `/api/checklists/templates/${daily.id}`, { branchId: hkt, branchIds: [hkt, patong], branchCopyChoice: "copy" });
    assert.equal(asNew.status, 201);
    assert.equal(added.status, 200);
    const branchCopy = added.body.createdCopies[0].id as string;

    for (let i = 0; i < 2; i++) {
      const board = await api("admin", "GET", "/api/checklist-runs/ops?branchId=all");
      assert.equal(board.status, 200, JSON.stringify(board.body).slice(0, 300));
    }
    const count = async (template: string) =>
      (await q<{ branch_id: string; n: number }>("select branch_id, count(*)::int as n from checklist_runs where template_id = $1 group by branch_id", [template])).map((r) => [r.branch_id, r.n]);
    assert.deepEqual(await count(daily.id), [[hkt, 1]], "the original made a run anywhere but its own branch, or more than one");
    assert.deepEqual(await count(asNew.body.id), [[robinson, 1]]);
    assert.deepEqual(await count(branchCopy), [[patong, 1]]);
    for (const [template, itemCount] of [[asNew.body.id, 3], [branchCopy, 3]] as const) {
      const [{ id }] = await q("select id from checklist_runs where template_id = $1", [template]);
      assert.equal((await q("select 1 from checklist_run_items where run_id = $1", [id])).length, itemCount, "the copy's run does not hold its own items");
      const refs = await q("select template_item_id from checklist_run_items where run_id = $1", [id]);
      const own = (await itemsOf(template)).map((i) => i.id);
      assert.ok(refs.every((r) => own.includes(r.template_item_id)), "the copy's run points at the original's items");
    }
  });

  // ── 10. The server's rules, whatever the screen sends ─────────────────────

  await check("staff cannot copy, whichever door they use", async () => {
    const before = (await q("select count(*)::int as n from checklist_templates where tenant_id = $1", [tenant]))[0].n;
    assert.equal((await api("staffPatong", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id, branchIds: [patong] })).status, 403);
    assert.equal((await api("staffPatong", "PATCH", `/api/checklists/templates/${source.id}`, { branchIds: [hkt, patong], branchCopyChoice: "copy" })).status, 403);
    assert.equal((await q("select count(*)::int as n from checklist_templates where tenant_id = $1", [tenant]))[0].n, before);
  });

  await check("every target branch answers to the branch check create uses, and nothing is written when one fails", async () => {
    const own = await fullChecklist("Refused");
    const before = await snapshot(own.id);
    const refused = await api("managerHkt", "POST", "/api/checklists/templates", { copiedFromTemplateId: own.id, name: `${own.name} no`, branchIds: [hkt, patong] });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, "Access denied to create templates for one or more branches");
    assert.equal((await createdWithName(`${own.name} no`)).length, 0, "a copy was made for the reachable branch of a refused request");

    const patched = await api("managerHkt", "PATCH", `/api/checklists/templates/${own.id}`, { name: "ZZ TEST must not save", branchId: hkt, branchIds: [hkt, patong], branchCopyChoice: "copy" });
    assert.equal(patched.status, 403);
    assert.equal(await snapshot(own.id), before, "a refused copy still saved the edit");
    assert.equal((await createdWithName("ZZ TEST must not save")).length, 0);
  });

  await check("a branch of another park group is refused, even for an all-branches account", async () => {
    const own = await fullChecklist("Foreign target");
    const before = await snapshot(own.id);
    assert.equal((await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: own.id, name: `${own.name} no`, branchIds: [foreignBranch] })).status, 403);
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${own.id}`, { branchIds: [hkt, foreignBranch], branchCopyChoice: "copy" })).status, 403);
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${own.id}`, { branchIds: [hkt, "not-a-branch"], branchCopyChoice: "copy" })).status, 403);
    assert.equal(await snapshot(own.id), before);
    assert.equal((await q("select 1 from checklist_templates where branch_id = $1", [foreignBranch])).length, 0);
  });

  await check("a source out of reach is not found or refused, and a malformed request says so", async () => {
    assert.equal((await api("managerForeign", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id, name: "ZZ TEST no", branchIds: [foreignBranch] })).status, 404);
    assert.equal((await api("managerRobinson", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id, name: "ZZ TEST no", branchIds: [robinson] })).status, 403);
    assert.equal((await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: "not-an-id", name: "ZZ TEST no" })).status, 400);
    assert.equal((await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: randomUUID(), name: "ZZ TEST no" })).status, 404);
    assert.equal((await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id, name: "ZZ TEST no", branchIds: "x" })).status, 400);
    assert.equal((await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id, name: "" })).status, 400);
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${source.id}`, { branchCopyChoice: "both" })).status, 400);
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${source.id}`, { branchIds: "x", branchCopyChoice: "copy" })).status, 400);
    assert.equal((await createdWithName("ZZ TEST no")).length, 0);
  });

  await check("a copy's items answer to the create path's photo rule", async () => {
    const res = await api("admin", "POST", "/api/checklists/templates", {
      copiedFromTemplateId: source.id,
      name: `ZZ TEST Photo no ${run}`,
      branchIds: [hkt],
      items: [{ title: "Needs a photo", requiresPhoto: true, cameraEnabled: false, galleryEnabled: false }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, '"Needs a photo" requires a photo, so enable Camera or Gallery');
    assert.equal((await createdWithName(`ZZ TEST Photo no ${run}`)).length, 0);
  });

  // ── 11. A manager at the second branch of a shared checklist ──────────────

  await check("a manager at the second branch can read a shared checklist and copy it to their branch; a plain save stays refused", async () => {
    const shared = await fullChecklist("Second branch");
    assert.equal((await api("admin", "PATCH", `/api/checklists/templates/${shared.id}`, { branchId: hkt, branchIds: [hkt, robinson] })).status, 200);
    const read = await api("managerRobinson", "GET", `/api/checklists/templates/${shared.id}`);
    assert.equal(read.status, 200, "the second branch's manager cannot open the checklist they can see");
    assert.equal(read.body.items.length, 3);
    assert.equal((await api("staffPatong", "GET", `/api/checklists/templates/${shared.id}`)).status, 403, "a person at neither branch read it");

    const before = await snapshot(shared.id);
    assert.equal((await api("managerRobinson", "PATCH", `/api/checklists/templates/${shared.id}`, { name: "ZZ TEST no" })).status, 403);
    const split = await api("managerRobinson", "POST", "/api/checklists/templates", { copiedFromTemplateId: shared.id, name: `${shared.name} split`, branchIds: [robinson] });
    assert.equal(split.status, 201, JSON.stringify(split.body));
    assert.equal(await snapshot(shared.id), before, "splitting off a copy changed the shared checklist");
    assert.equal((await templateRow(split.body.id)).branch_id, robinson);
    assert.deepEqual((await templateRow(shared.id)).branch_ids, [hkt, robinson]);
  });

  await check("named employees and a location go to a copy as sent, as the create path has them", async () => {
    const res = await api("admin", "POST", "/api/checklists/templates", { copiedFromTemplateId: source.id, name: `ZZ TEST As sent ${run}`, branchIds: [patong], assignedEmployeeIds: [ann] });
    assert.equal(res.status, 201);
    const row = await templateRow(res.body.id);
    assert.equal(row.location_id, location);
    assert.deepEqual(await namedOf(res.body.id), [ann]);
  });

  // ── 12. The editor's wording ──────────────────────────────────────────────

  await check("the shared note names only the branches the person may see, and counts the rest", () => {
    const visible = [
      { id: "hkt", name: "HKT Central" },
      { id: "rob", name: "Robinson" },
      { id: "pat", name: "Patong" },
    ];
    const note = (originalBranchIds: string[], activeBranchId: string | null, visibleBranches = visible) =>
      sharedChecklistNote({ originalBranchIds, visibleBranches, activeBranchId, branchCount: 3 });
    assert.equal(note(["hkt", "rob"], "hkt"), "This is shared with Robinson. Changes apply to both branches.");
    assert.equal(note(["hkt", "rob"], null), "This is shared with HKT Central and Robinson. Changes apply to both branches.");
    assert.equal(note(["hkt", "rob", "pat"], "hkt"), "This is shared with Robinson and Patong. Changes apply to all 3 branches.");
    assert.equal(note(["hkt", "rob"], "pat"), "This is shared with HKT Central and Robinson. Changes apply to both branches.");
    assert.equal(note(["hkt", "rob"], "hkt", [visible[0]]), "This is shared with 1 other branch. Changes apply to both branches.");
    assert.equal(note(["hkt", "rob", "pat"], "hkt", [visible[0]]), "This is shared with 2 other branches. Changes apply to all 3 branches.");
    assert.equal(note(["hkt", "rob", "pat"], "hkt", [visible[0], visible[1]]), "This is shared with Robinson and 1 other branch. Changes apply to all 3 branches.");
    assert.equal(note(["hkt"], "hkt"), null, "a one-branch checklist has no note");
    assert.equal(note([], "hkt"), "This is shared with all branches. Changes apply to every branch.");
    assert.equal(sharedChecklistNote({ originalBranchIds: [], visibleBranches: [visible[0]], activeBranchId: "hkt", branchCount: 1 }), null, "a one-branch park has nothing to share with");
  });

  await check("the two answers read as the owner wrote them; a change that keeps none of the branches says it moves", () => {
    const branches = [
      { id: "hkt", name: "HKT Central" },
      { id: "rob", name: "Robinson" },
      { id: "pat", name: "Patong" },
    ];
    const one = addedBranchQuestion({ added: ["rob"], selectedBranchIds: ["hkt", "rob"], originalBranchIds: ["hkt"], branches });
    assert.equal(one.question, "How should Robinson be added?");
    assert.equal(one.copyLabel, "Make a separate copy for this branch");
    assert.equal(one.shareLabel, "Share one checklist across both");
    const two = addedBranchQuestion({ added: ["rob", "pat"], selectedBranchIds: ["hkt", "rob", "pat"], originalBranchIds: ["hkt"], branches });
    assert.equal(two.question, "How should Robinson and Patong be added?");
    assert.equal(two.copyLabel, "Make a separate copy for each new branch");
    assert.equal(two.shareLabel, "Share one checklist across all of them");
    const moved = addedBranchQuestion({ added: ["rob"], selectedBranchIds: ["rob"], originalBranchIds: ["hkt"], branches });
    assert.equal(moved.shareLabel, "Move this checklist to Robinson");
    assert.match(moved.copyHint, /stays at HKT Central/);
  });

  await check("the branch arithmetic: an empty list is the one branch, a checklist on no branch has nothing added to it", () => {
    assert.deepEqual(checklistBranchIds({ branchId: "hkt", branchIds: [] }), ["hkt"]);
    assert.deepEqual(checklistBranchIds({ branchId: "hkt", branchIds: null }), ["hkt"]);
    assert.deepEqual(checklistBranchIds({ branchId: "hkt", branchIds: ["hkt", "rob"] }), ["hkt", "rob"]);
    assert.deepEqual(checklistBranchIds({ branchId: null, branchIds: [] }), []);
    assert.deepEqual(addedBranchIds(["hkt"], ["hkt", "rob"]), ["rob"]);
    assert.deepEqual(addedBranchIds(["hkt"], ["rob"]), ["rob"]);
    assert.deepEqual(addedBranchIds(["hkt", "rob"], ["hkt"]), [], "removing a branch asks nothing");
    assert.deepEqual(addedBranchIds([], ["rob"]), [], "picking a branch on an all-branches checklist narrows it");
    assert.equal(sameBranches(["a", "b"], ["b", "a"]), true);
    assert.equal(sameBranches(["a"], ["a", "b"]), false);
  });

  await check("the summary under the checkbox says what the save will make", () => {
    const branches = [{ id: "hkt", name: "HKT Central" }];
    assert.match(saveAsNewSummary({ selectedBranchIds: ["hkt"], branches, canReachAllBranches: true }), /^Creates one new checklist for HKT Central\. The original stays exactly as it is/);
    assert.match(saveAsNewSummary({ selectedBranchIds: ["hkt", "rob"], branches, canReachAllBranches: true }), /^Creates 2 new checklists, one for each selected branch\./);
    assert.match(saveAsNewSummary({ selectedBranchIds: [], branches, canReachAllBranches: true }), /^Creates one new checklist for all branches\./);
    assert.match(saveAsNewSummary({ selectedBranchIds: [], branches, canReachAllBranches: false }), /^Creates one new checklist for your branch\./);
  });

  console.log(`checklist-copies.check: ${checks} checks passed`);
} catch (err) {
  console.error("checklist-copies.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  bucketServer.close();
  await pool.end();
}
