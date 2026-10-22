// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-597 — the checklists in Today (GET /api/checklists/today) resolve the
// signed-in person the way My Account and Tasks Today do (resolveSelfEmployeeId,
// server/core/selfEmployee.ts: by login, then email, then phone, within their
// own park group). The visibility rules themselves are unchanged:
//
//   1. A login whose employee record is attached reads its department's
//      checklist and the checklist assigned to it by name (unchanged path).
//   2. An employee record with no login attached but the login's email reads
//      its department's checklist and its own checklist; a record matched by
//      phone alone likewise, and neither reads the other's.
//   3. A record of another park group carrying the login's email is not taken
//      for that login, nor is a same-group record that belongs to another login.
//   4. A login with no employee record still reads only the "Everyone"
//      checklists (no assignment, no department).
//   5. Staff never read checker checklists, even for their own department; a
//      manager still does.
//
// SCRUM-658 — a checklist can name several employees (checklist_template_assignees,
// migration 0027; the template's assigned_employee_id stays the first of them):
//
//   6. A checklist the editor's route (POST /api/checklists/templates) saves
//      for two people shows in the Today of both — one resolved by login, one
//      by email — and not in the Today of a person it does not name; Today's
//      label names both. The column holds the first, the join table both.
//   7. Re-saving it (PATCH) for a third person moves it: the two leave, the
//      third (resolved by phone) arrives; the column follows.
//   8. A checklist written before the join table — its one employee in the
//      column alone, no join rows — still shows to that person (the
//      For Linked / ByEmail / ByPhone checklists above are written that way).
//      Department and Everyone checklists are unchanged (checks 1-5).
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/checklist-assignees-today.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("checklist-assignees-today.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");

// ─── Two park groups, one branch each, three departments ─────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ca ${run}`, `zz-ca-${run}`]);
const branch = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
  branch,
  tenant,
  `ZZ TEST ca ${run}`,
]);
const otherTenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [otherTenant, `ZZ TEST ca2 ${run}`, `zz-ca2-${run}`]);
const otherBranch = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
  otherBranch,
  otherTenant,
  `ZZ TEST ca2 ${run}`,
]);

async function department(label: string): Promise<string> {
  const id = randomUUID();
  await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [id, tenant, `ZZ TEST ${label} ${run}`]);
  return id;
}
const reception = await department("Reception");
const kitchen = await department("Kitchen");
const floor = await department("Floor");

async function user(role: string, label: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `zz-ca-${label.toLowerCase()}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
    tenant,
    id,
    branch,
  ]);
  return { id, email };
}

async function employee(opts: {
  tenantId: string;
  branchId: string;
  label: string;
  userId: string | null;
  email: string;
  phone?: string | null;
  departmentId: string | null;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, phone, primary_department_id, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
    [
      id,
      opts.tenantId,
      opts.branchId,
      opts.userId,
      `ZZ TEST ${opts.label} ${run}`,
      opts.label,
      opts.email,
      opts.phone ?? null,
      opts.departmentId,
    ],
  );
  return id;
}

/** A login whose employee record is attached to it, in Floor. */
const linked = await user("staff", "Linked");
const linkedEmployee = await employee({
  tenantId: tenant,
  branchId: branch,
  label: "Linked",
  userId: linked.id,
  email: linked.email,
  departmentId: floor,
});
/** Email match only: a record with no login whose email differs from the login's only in case, in Reception. */
const byEmail = await user("staff", "ByEmail");
const byEmailEmployee = await employee({
  tenantId: tenant,
  branchId: branch,
  label: "ByEmail",
  userId: null,
  email: byEmail.email.toUpperCase(),
  departmentId: reception,
});
/** Phone match only: a different email, the login's E.164 phone written the local way, in Kitchen. */
const byPhone = await user("staff", "ByPhone");
const phoneDigits = String(Date.now()).slice(-8);
await q("update users set phone_e164 = $2, phone_number = $3 where id = $1", [byPhone.id, `+669${phoneDigits}`, `09${phoneDigits}`]);
const byPhoneEmployee = await employee({
  tenantId: tenant,
  branchId: branch,
  label: "ByPhone",
  userId: null,
  email: `zz-ca-byphone-other-${run}@example.com`,
  phone: `09-${phoneDigits}`,
  departmentId: kitchen,
});
/**
 * No employee record of its own. Its email is carried by a record of another
 * park group (in Reception, so a wrong match would show) and by a same-group
 * record attached to the manager's login (in Kitchen).
 */
const lone = await user("staff", "Lone");
const foreignEmployee = await employee({
  tenantId: otherTenant,
  branchId: otherBranch,
  label: "Foreign",
  userId: null,
  email: lone.email,
  departmentId: reception,
});
const manager = await user("manager", "Manager");
const managerEmployee = await employee({
  tenantId: tenant,
  branchId: branch,
  label: "ManagerRecord",
  userId: manager.id,
  email: lone.email,
  departmentId: kitchen,
});

// ─── The checklists, as the editors store them ───────────────────────────────

async function template(
  label: string,
  fields: { type?: "operational" | "checker"; dept?: string; employee?: string; legacyDept?: string },
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into checklist_templates
       (id, tenant_id, branch_id, name, checklist_type, assigned_department_id, assigned_employee_id, department_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      tenant,
      branch,
      `ZZ TEST ${label} ${run}`,
      fields.type ?? "operational",
      fields.dept ?? null,
      fields.employee ?? null,
      fields.legacyDept ?? null,
      manager.id,
    ],
  );
  return id;
}
const T = {
  everyone: await template("Everyone", {}),
  receptionDept: await template("Reception dept", { dept: reception }),
  kitchenDept: await template("Kitchen dept", { dept: kitchen }),
  floorDept: await template("Floor dept", { dept: floor }),
  legacyReception: await template("Legacy Reception", { legacyDept: reception }),
  forLinked: await template("For Linked", { employee: linkedEmployee }),
  forByEmail: await template("For ByEmail", { employee: byEmailEmployee }),
  forByPhone: await template("For ByPhone", { employee: byPhoneEmployee }),
  forForeign: await template("For Foreign", { employee: foreignEmployee }),
  forManagerRecord: await template("For ManagerRecord", { employee: managerEmployee }),
  checkerReception: await template("Checker Reception", { type: "checker", dept: reception }),
  checkerEveryone: await template("Checker Everyone", { type: "checker" }),
};
const ALL: string[] = Object.values(T);
/** The checklist the editor saves for several people (check 6), made once the server is up. */
let multiNamed = "";

// ─── The server ──────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
const HARNESS_ENV = {
  NODE_ENV: "test",
  APP_ENV: "dev",
  STORAGE_ENV_PREFIX: "zz-test",
  OBJECT_STORAGE: "local",
  OTOAPP_LEGACY_LOGIN: "true",
  LOG_LEVEL: "warn",
  TZ: "UTC",
  DEPLOY_ENV: "local",
  OTOAPP_JOBS: "platform",
  USE_AWS_REKOGNITION: "false",
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
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 90_000);
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

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let checks = 0;
const check = async (title: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

try {
  ORIGIN = await serve();
  const cookie = {
    Linked: await signIn(linked.email),
    ByEmail: await signIn(byEmail.email),
    ByPhone: await signIn(byPhone.email),
    Lone: await signIn(lone.email),
    Manager: await signIn(manager.email),
  };

  /** This run's checklists that the person's Today lists, asked for as the Today page asks. */
  const todayFor = async (who: keyof typeof cookie): Promise<string[]> => {
    const res = await fetch(`${ORIGIN}/api/checklists/today?branchId=${branch}`, { headers: { cookie: cookie[who] } });
    const text = await res.text();
    assert.equal(res.status, 200, `${who}: ${res.status} ${text}`);
    const ids = (JSON.parse(text) as Array<{ id: string }>).map((t) => t.id);
    return ALL.filter((id) => ids.includes(id));
  };
  const nameOf = (id: string) => (id === multiNamed ? "multiNamed" : Object.entries(T).find(([, v]) => v === id)?.[0] ?? id);
  const expectExactly = async (who: keyof typeof cookie, expected: string[]) => {
    const got = (await todayFor(who)).map(nameOf).sort();
    assert.deepEqual(got, expected.map(nameOf).sort(), `${who}'s Today lists the wrong checklists`);
  };

  // SCRUM-658: saved through the editor's own route, for two people.
  {
    const res = await fetch(`${ORIGIN}/api/checklists/templates`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie.Manager },
      body: JSON.stringify({
        name: `ZZ TEST Linked and ByEmail ${run}`,
        branchIds: [branch],
        recurrence: "daily",
        items: [{ title: "ZZ TEST item" }],
        assignedEmployeeIds: [linkedEmployee, byEmailEmployee],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 201, `saving a checklist for two people: ${res.status} ${text}`);
    multiNamed = (JSON.parse(text) as { id: string }).id;
    ALL.push(multiNamed);
  }
  const namedOf = async (templateId: string) => ({
    column: (await q<{ e: string | null }>("select assigned_employee_id as e from checklist_templates where id = $1", [templateId]))[0]?.e ?? null,
    rows: (await q<{ e: string }>("select employee_id as e from checklist_template_assignees where template_id = $1", [templateId]))
      .map((r) => r.e)
      .sort(),
  });

  await check("a checklist saved for two people keeps the first in the column and both in the join table", async () => {
    const named = await namedOf(multiNamed);
    assert.equal(named.column, linkedEmployee, "the column does not hold the first person named");
    assert.deepEqual(named.rows, [linkedEmployee, byEmailEmployee].sort(), "the join table does not hold both people");
    const res = await fetch(`${ORIGIN}/api/checklists/templates/${multiNamed}`, { headers: { cookie: cookie.Manager } });
    const body = (await res.json()) as { assignedEmployeeIds?: string[] };
    assert.deepEqual(body.assignedEmployeeIds, [linkedEmployee, byEmailEmployee], "the editor's read does not name both, in order");
  });

  await check("a login with its employee record attached reads Everyone, its department's and its own checklists", async () => {
    await expectExactly("Linked", [T.everyone, T.floorDept, T.forLinked, multiNamed]);
  });

  await check("a record with no login but the login's email reads its department's and its own checklists", async () => {
    await expectExactly("ByEmail", [T.everyone, T.receptionDept, T.legacyReception, T.forByEmail, multiNamed]);
  });

  await check("a record matched by phone alone reads its department's and its own checklists", async () => {
    await expectExactly("ByPhone", [T.everyone, T.kitchenDept, T.forByPhone]);
  });

  await check("another park group's record and a record attached to another login are not taken", async () => {
    const got = await todayFor("Lone");
    assert.ok(!got.includes(T.forForeign), "Lone's Today shows the checklist of another park group's record");
    assert.ok(!got.includes(T.receptionDept), "Lone's Today shows Reception's checklist through another park group's record");
    assert.ok(!got.includes(T.forManagerRecord), "Lone's Today shows the checklist of the manager's record");
    assert.ok(!got.includes(T.kitchenDept), "Lone's Today shows Kitchen's checklist through the manager's record");
  });

  await check("a login with no employee record still reads only the Everyone checklists", async () => {
    await expectExactly("Lone", [T.everyone]);
  });

  await check("a checklist named for two people shows to both (by login and by email), not to a person it does not name", async () => {
    assert.ok((await todayFor("Linked")).includes(multiNamed), "Linked (by login) does not see the checklist naming them");
    assert.ok((await todayFor("ByEmail")).includes(multiNamed), "ByEmail (by email) does not see the checklist naming them");
    assert.ok(!(await todayFor("ByPhone")).includes(multiNamed), "ByPhone sees a checklist that does not name them");
    assert.ok(!(await todayFor("Lone")).includes(multiNamed), "Lone sees a checklist that does not name them");
    const res = await fetch(`${ORIGIN}/api/checklists/today?branchId=${branch}`, { headers: { cookie: cookie.Linked } });
    const row = ((await res.json()) as Array<{ id: string; assignedEmployeeName: string | null }>).find((t) => t.id === multiNamed);
    assert.equal(row?.assignedEmployeeName, "Linked, ByEmail", "Today's label does not name both people");
  });

  await check("a checklist written before the join table (its one employee in the column alone) still shows to that person", async () => {
    for (const [who, templateId, employeeId] of [
      ["Linked", T.forLinked, linkedEmployee],
      ["ByEmail", T.forByEmail, byEmailEmployee],
      ["ByPhone", T.forByPhone, byPhoneEmployee],
    ] as const) {
      const named = await namedOf(templateId);
      assert.equal(named.column, employeeId);
      assert.deepEqual(named.rows, [], `${nameOf(templateId)} has join rows; it is meant to be a column-only checklist`);
      assert.ok((await todayFor(who)).includes(templateId), `${who} no longer sees the checklist naming them in the column alone`);
    }
  });

  await check("re-saving the checklist for someone else moves it: the two leave, the third arrives", async () => {
    const res = await fetch(`${ORIGIN}/api/checklists/templates/${multiNamed}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: cookie.Manager },
      body: JSON.stringify({ assignedEmployeeIds: [byPhoneEmployee], assignedRoleId: null, assignedDepartmentId: null }),
    });
    assert.equal(res.status, 200, `re-saving: ${res.status} ${await res.text()}`);
    const named = await namedOf(multiNamed);
    assert.equal(named.column, byPhoneEmployee, "the column does not follow the new first person");
    assert.deepEqual(named.rows, [byPhoneEmployee], "the join table still holds the people taken off");
    assert.ok(!(await todayFor("Linked")).includes(multiNamed), "Linked still sees a checklist that no longer names them");
    assert.ok(!(await todayFor("ByEmail")).includes(multiNamed), "ByEmail still sees a checklist that no longer names them");
    assert.ok((await todayFor("ByPhone")).includes(multiNamed), "ByPhone (by phone) does not see the checklist now naming them");
  });

  await check("staff never read checker checklists, even for their own department; a manager does", async () => {
    for (const who of ["Linked", "ByEmail", "ByPhone", "Lone"] as const) {
      const got = await todayFor(who);
      assert.ok(!got.includes(T.checkerReception) && !got.includes(T.checkerEveryone), `${who}'s Today shows a checker checklist`);
    }
    assert.ok((await todayFor("Manager")).includes(T.checkerEveryone), "the manager's Today has no unassigned checker checklist");
  });

  console.log(`checklist-assignees-today.check: ${checks} checks passed`);
} catch (err) {
  console.error("checklist-assignees-today.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
