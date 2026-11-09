// seed: its own — one park group with two branches of ZZ TEST rows, made
// here. Not a Playwright file (the suite collects *.spec.ts and *.test.ts;
// this is neither): it boots the app's real routes and needs a database with
// the otoapp schema migrated.
//
// SCRUM-751 — an overdue checklist could not be continued from Today while
// the Ops module still opened it. Today (GET /api/checklists/today) took the
// newest run written today for the checklist, in any branch and in any state,
// and offered Continue only on an in_progress run. The recurring run creator
// writes a missed run for an earlier period on the day it catches up, so that
// read-only run could stand in for today's open one: Today showed View, and
// View opened a run nobody can finish. The rule now (shared/checklist-today-run.ts):
//
//   1. Today's run is taken from the branch Today is showing; an open run
//      (pending, in progress, completed with issues) wins over a newer missed
//      one and over another branch's run, and Today offers Continue on it,
//      overdue or not, with the link the Ops module opens it by.
//   2. Completing it from there succeeds: the last item, then the run.
//   3. Once completed, that run is Today's run and the checklist reads
//      completed (the page then leaves it out), not the newer missed run.
//   4. Missed keeps its meaning: a checklist whose only run today is missed
//      is offered View, and the run stays read-only.
//   5. The button rule itself: Start without a run, Continue on every open
//      status, View on every closed one.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/checklist-overdue-today.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { todayChecklistAction } from "../shared/checklist-today-run";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("checklist-overdue-today.check: DATABASE_URL is not set");
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

// ─── One park group, two branches, one staff login on the first ─────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST od ${run}`, `zz-od-${run}`]);
async function branchRow(label: string): Promise<string> {
  const id = randomUUID();
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
    id,
    tenant,
    `ZZ TEST od ${label} ${run}`,
  ]);
  return id;
}
const branch = await branchRow("Robinson");
const otherBranch = await branchRow("Central");

const staff = { id: randomUUID(), email: `zz-od-staff-${run}@example.com` };
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password)
   values ($1, $2, $3, $4, 'staff', true, false)`,
  [staff.id, staff.email, hash(PASSWORD), `ZZ TEST Staff ${run}`],
);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
  tenant,
  staff.id,
  branch,
]);

// ─── Today's period in the branches' timezone, and yesterday's ───────────────

const HOUR = 3_600_000;
const bangkokDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
const [by, bm, bd] = bangkokDate.split("-").map(Number);
const todayStart = new Date(Date.UTC(by, bm - 1, bd) - 7 * HOUR);
const todayEnd = new Date(todayStart.getTime() + 24 * HOUR);
const yesterdayStart = new Date(todayStart.getTime() - 24 * HOUR);
/** Written a few seconds ago, oldest first, never before the server's (UTC) midnight. */
const utcMidnight = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").getTime();
const writtenAt = (order: number) => new Date(Math.max(Date.now() - 3000, utcMidnight) + order).toISOString();

/** A daily "Everyone" checklist on both branches, due at midnight: overdue the whole day. */
async function checklist(label: string, itemCount: number): Promise<{ id: string; items: string[] }> {
  const id = randomUUID();
  await q(
    `insert into checklist_templates
       (id, tenant_id, branch_id, branch_ids, name, checklist_type, recurrence, scheduled_time, template_version, created_by)
     values ($1, $2, $3, $4::jsonb, $5, 'operational', 'daily', '00:00', 2, $6)`,
    [id, tenant, branch, JSON.stringify([branch, otherBranch]), `ZZ TEST ${label} ${run}`, staff.id],
  );
  const items: string[] = [];
  for (let i = 0; i < itemCount; i++) {
    const itemId = randomUUID();
    await q("insert into checklist_template_items (id, tenant_id, template_id, title, sort_order) values ($1, $2, $3, $4, $5)", [
      itemId,
      tenant,
      id,
      `ZZ TEST item ${i + 1}`,
      i,
    ]);
    items.push(itemId);
  }
  return { id, items };
}

/** A run as the recurring creator and the start route write it, with its items. */
async function runRow(opts: {
  templateId: string;
  templateItems: string[];
  branchId: string;
  status: "pending" | "in_progress" | "missed";
  periodStart: Date;
  createdAt: string;
  done: number;
}): Promise<{ id: string; items: string[] }> {
  const id = randomUUID();
  const periodEnd = new Date(opts.periodStart.getTime() + 24 * HOUR);
  await q(
    `insert into checklist_runs
       (id, tenant_id, template_id, branch_id, status, template_version_applied, started_at, due_at,
        period_start, period_end, missed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $11)`,
    [
      id,
      tenant,
      opts.templateId,
      opts.branchId,
      opts.status,
      opts.status === "in_progress" ? opts.createdAt : null,
      opts.periodStart.toISOString(),
      opts.periodStart.toISOString(),
      periodEnd.toISOString(),
      opts.status === "missed" ? periodEnd.toISOString() : null,
      opts.createdAt,
    ],
  );
  const items: string[] = [];
  for (const [i, templateItemId] of opts.templateItems.entries()) {
    const itemId = randomUUID();
    const done = i < opts.done;
    await q(
      `insert into checklist_run_items (id, tenant_id, run_id, template_item_id, is_completed, completed_by, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [itemId, tenant, id, templateItemId, done, done ? staff.id : null, done ? opts.createdAt : null],
    );
    items.push(itemId);
  }
  return { id, items };
}

// The report's case: today's run in this branch, in progress with 2 of 3
// done; then, written later today, yesterday's run as missed and another
// branch's run for today. The old rule ("newest run written today") took one
// of those two.
const overdue = await checklist("Overdue", 3);
const openRun = await runRow({
  templateId: overdue.id,
  templateItems: overdue.items,
  branchId: branch,
  status: "in_progress",
  periodStart: todayStart,
  createdAt: writtenAt(0),
  done: 2,
});
const missedRun = await runRow({
  templateId: overdue.id,
  templateItems: overdue.items,
  branchId: branch,
  status: "missed",
  periodStart: yesterdayStart,
  createdAt: writtenAt(1),
  done: 0,
});
const otherBranchRun = await runRow({
  templateId: overdue.id,
  templateItems: overdue.items,
  branchId: otherBranch,
  status: "in_progress",
  periodStart: todayStart,
  createdAt: writtenAt(2),
  done: 0,
});

// Only a missed run today (check 4).
const missedOnly = await checklist("Missed only", 1);
const onlyMissedRun = await runRow({
  templateId: missedOnly.id,
  templateItems: missedOnly.items,
  branchId: branch,
  status: "missed",
  periodStart: yesterdayStart,
  createdAt: writtenAt(0),
  done: 0,
});

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
let COOKIE = "";

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { cookie: COOKIE, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

type TodayRow = { id: string; computedStatus: string; todayRun: { id: string; status: string } | null };
/** The checklist's row in Today, asked for as the Today page asks for it. */
async function todayRow(templateId: string): Promise<TodayRow> {
  const res = await call("GET", `/api/checklists/today?branchId=${branch}`);
  assert.equal(res.status, 200, `Today: ${res.status} ${res.text}`);
  const row = (res.json as TodayRow[]).find((t) => t.id === templateId);
  assert.ok(row, "the checklist is missing from Today");
  return row;
}

let checks = 0;
const check = async (title: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

try {
  ORIGIN = await serve();
  COOKIE = await signIn(staff.email);

  await check("the fixture is the report's case: the missed run and another branch's run were written after the open one", async () => {
    const rows = await q<{ id: string }>(
      "select id from checklist_runs where template_id = $1 order by created_at desc",
      [overdue.id],
    );
    assert.deepEqual(rows.map((r) => r.id), [otherBranchRun.id, missedRun.id, openRun.id]);
    assert.ok(todayStart.getTime() < Date.now() && Date.now() < todayEnd.getTime(), "today's period does not hold now");
  });

  await check("an overdue run with items left is Today's run and is offered Continue, on the link Ops opens it by", async () => {
    const row = await todayRow(overdue.id);
    assert.equal(row.todayRun?.id, openRun.id, `Today took run ${row.todayRun?.id} (${row.todayRun?.status}), not the open one`);
    assert.equal(row.computedStatus, "in_progress");
    assert.deepEqual(todayChecklistAction(row.todayRun), { kind: "continue", href: `/core/checklist/${openRun.id}` });
    const opened = await call("GET", `/api/checklist-runs/${openRun.id}`);
    assert.equal(opened.status, 200, `opening the run: ${opened.status} ${opened.text}`);
    assert.equal(opened.json.status, "in_progress");
  });

  await check("completing it from there succeeds: the last item, then the run", async () => {
    const item = await call("PATCH", `/api/checklist-run-items/${openRun.items[2]}`, { completed: true });
    assert.equal(item.status, 200, `completing the last item: ${item.status} ${item.text}`);
    const done = await call("PATCH", `/api/checklist-runs/${openRun.id}`, { status: "completed" });
    assert.equal(done.status, 200, `completing the run: ${done.status} ${done.text}`);
    const [stored] = await q<{ status: string; completed_by: string | null }>(
      "select status, completed_by from checklist_runs where id = $1",
      [openRun.id],
    );
    assert.equal(stored.status, "completed");
    assert.equal(stored.completed_by, staff.id);
  });

  await check("once completed, that run is Today's run and the checklist reads completed, not the newer missed run", async () => {
    const row = await todayRow(overdue.id);
    assert.equal(row.todayRun?.id, openRun.id);
    assert.equal(row.computedStatus, "completed");
    assert.equal(todayChecklistAction(row.todayRun).kind, "view");
  });

  await check("missed keeps its meaning: a checklist whose only run today is missed is offered View, and the run stays read-only", async () => {
    const row = await todayRow(missedOnly.id);
    assert.equal(row.todayRun?.id, onlyMissedRun.id);
    assert.deepEqual(todayChecklistAction(row.todayRun), { kind: "view", href: `/core/checklist/${onlyMissedRun.id}` });
    const item = await call("PATCH", `/api/checklist-run-items/${onlyMissedRun.items[0]}`, { completed: true });
    assert.equal(item.status, 409, `a missed run's item took a change: ${item.status} ${item.text}`);
    const [stored] = await q<{ status: string }>("select status from checklist_runs where id = $1", [onlyMissedRun.id]);
    assert.equal(stored.status, "missed");
  });

  await check("the button rule: Start without a run, Continue on every open status, View on every closed one", () => {
    assert.deepEqual(todayChecklistAction(null), { kind: "start" });
    assert.deepEqual(todayChecklistAction(undefined), { kind: "start" });
    for (const status of ["pending", "in_progress", "issues"]) {
      assert.deepEqual(todayChecklistAction({ id: "r", status }), { kind: "continue", href: "/core/checklist/r" }, status);
    }
    for (const status of ["completed", "missed", "cancelled"]) {
      assert.deepEqual(todayChecklistAction({ id: "r", status }), { kind: "view", href: "/core/checklist/r" }, status);
    }
  });

  console.log(`checklist-overdue-today.check: ${checks} checks passed`);
} catch (err) {
  console.error("checklist-overdue-today.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
