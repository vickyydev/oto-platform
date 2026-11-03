// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// The Fix module over HTTP, on the routes as registered:
//
// SCRUM-656 — an urgent report alerts the Fix Department in the app:
//   1. A report created "urgent" (the highest of the schema's priorities)
//      puts one fix_report_urgent notification in the inbox of each Fix
//      Department member, naming the report's title and branch.
//   2. Its author is not told of their own report, even when a member, and a
//      login outside the Fix Department is not told at all.
//   3. A "normal" report notifies nobody.
//   4. The notification's link (the client's own notificationTarget) is the
//      Fix Board with the report's id, and that id opens the report for the
//      member who was told.
//
// SCRUM-657 — reports are seen by branch reach, on the server:
//   5. With a report at each of two branches, a Fix Department member who
//      reaches one branch reads only that branch's report in the Fix Board's
//      list (GET /api/fix-reports) and in My Queue, which is also what the
//      Today fix cards read (GET /api/fix-reports?myQueue=true); a manager
//      reaching one branch likewise on the board; the other branch's report
//      itself is refused.
//   6. A member with all-branch access, and an admin, read both.
//   7. An urgent report at the branch a member does not reach does not
//      alert that member (they could not open it); an all-branch member is.
//
// SCRUM-641 — report and comment improvements:
//   8. Opening a report names who reported it and when, and every comment
//      names its author and when; the author is the session's, never the
//      request's, and a supplier signs with the name on their link.
//   9. A manager or admin, at a branch they reach, deletes a report once: it
//      leaves every list, by-id read, media read, supplier read and checklist
//      read; the row and its comments stay, and one activity row records it.
//      Reporters, Fix Department members and all-branch staff are refused.
//  10. A comment can carry the author's own fresh uploads, photos, videos or
//      a PDF; they are served only under the owning report's access, shown in
//      the thread, and reach the supplier who can read the comment. A PDF
//      cannot go on a report itself, and a file that is not one is refused.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built:
//   npx tsx tests/fix-module.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { format, parseISO } from "date-fns";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FixActivityFeed, rawCommentToActivityEntry } from "../client/src/components/fix-activity-feed";
import { notificationTarget } from "../client/src/lib/notification-target";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("fix-module.check: DATABASE_URL is not set");
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
const SESSION_SECRET = randomBytes(24).toString("hex");
const JPEG = readFileSync(join(APP_DIR, "tests", "fixtures", "media", "checklist-evidence.jpg"));
const run = randomBytes(3).toString("hex");

// ─── One park group: two branches, the Fix Department and another ───────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST fix ${run}`, `zz-fix-${run}`]);
async function branch(label: string) {
  const id = randomUUID();
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
    id,
    tenant,
    `ZZ TEST ${label} ${run}`,
  ]);
  return { id, name: `ZZ TEST ${label} ${run}` };
}
const branchA = await branch("Patong");
const branchB = await branch("Central");

async function department(label: string) {
  const id = randomUUID();
  await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [id, tenant, `ZZ TEST ${label} ${run}`]);
  return id;
}
const fixDept = await department("Maintenance");
const otherDept = await department("Reception");
await q("insert into settings (tenant_id, key, value) values ($1, 'fix_department_id', $2)", [tenant, fixDept]);

interface Login {
  label: string;
  id: string;
  email: string;
}
/** A login with an employee record in `dept`, reaching `reach` (a list of branches, or every branch). */
async function login(label: string, role: string, dept: string | null, reach: string[] | "all"): Promise<Login> {
  const id = randomUUID();
  const email = `zz-fix-${label.toLowerCase()}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role],
  );
  if (reach === "all") {
    await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
  } else {
    for (const b of reach) {
      await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
        tenant,
        id,
        b,
      ]);
    }
  }
  if (dept) {
    await q(
      `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, primary_department_id)
       values ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
      [randomUUID(), tenant, reach === "all" ? branchA.id : reach[0], id, `ZZ TEST ${label} ${run}`, label, email, dept],
    );
  }
  return { label, id, email };
}

const author = await login("Author", "staff", otherDept, [branchA.id, branchB.id]);
const fixerAll = await login("FixerAll", "staff", fixDept, "all");
const fixerA = await login("FixerA", "staff", fixDept, [branchA.id]);
const outsider = await login("Outsider", "staff", otherDept, [branchA.id, branchB.id]);
const managerA = await login("ManagerA", "manager", null, [branchA.id]);
const admin = await login("Admin", "admin", null, "all");

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
  SESSION_SECRET,
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

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field below
}

let ORIGIN = "";
async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; form?: FormData } = {}): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the message.
  }
  return { status: res.status, body };
}
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body)}`;

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
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

try {
  ORIGIN = await serve();
  const cookie: Record<string, string> = {};
  for (const who of [author, fixerAll, fixerA, outsider, managerA, admin]) cookie[who.label] = await signIn(who.email);

  /** What the Fix page sends (client/src/pages/core/fix.tsx): the photo first, then the report. */
  const report = async (who: Login, title: string, priority: string, branchId: string) => {
    const form = new FormData();
    form.append("media", new Blob([JPEG], { type: "image/jpeg" }), "photo.jpg");
    const upload = await call("POST", "/api/fix-reports/upload", { cookie: cookie[who.label], form });
    assert.equal(upload.status, 200, `upload: ${show(upload)}`);
    const res = await call("POST", "/api/fix-reports", {
      cookie: cookie[who.label],
      body: { media: upload.body.urls, title, priority, branchId, tags: [] },
    });
    assert.equal(res.status, 201, `report: ${show(res)}`);
    return res.body as { id: string; assignedDepartmentId: string | null };
  };
  type Note = { id: string; type: string; title: string; body: string; referenceType: string | null; referenceId: string | null };
  const inbox = async (who: Login, reportId: string) => {
    const res = await call("GET", "/api/notifications", { cookie: cookie[who.label] });
    assert.equal(res.status, 200, `${who.label}'s inbox: ${show(res)}`);
    return (res.body as Note[]).filter((n) => n.referenceId === reportId);
  };

  // ─── SCRUM-656 ─────────────────────────────────────────────────────────────

  const urgentTitle = `ZZ TEST slide handrail loose ${run}`;
  const urgent = await report(author, urgentTitle, "urgent", branchA.id);

  await check("656: an urgent report is assigned to the Fix Department", () => {
    assert.equal(urgent.assignedDepartmentId, fixDept);
  });

  await check("656: each Fix Department member gets one fix_report_urgent naming the title and branch", async () => {
    for (const who of [fixerAll, fixerA]) {
      const notes = await inbox(who, urgent.id);
      assert.equal(notes.length, 1, `${who.label}: ${JSON.stringify(notes)}`);
      assert.equal(notes[0].type, "fix_report_urgent");
      assert.equal(notes[0].referenceType, "fix_report");
      assert.ok(notes[0].title.includes(urgentTitle.slice(0, 50)), `title: ${notes[0].title}`);
      assert.ok(notes[0].body.includes(branchA.name), `body: ${notes[0].body}`);
    }
  });

  await check("656: the author and a login outside the Fix Department are not told", async () => {
    assert.deepEqual(await inbox(author, urgent.id), []);
    assert.deepEqual(await inbox(outsider, urgent.id), []);
  });

  await check("656: a member who reports urgently is not told of their own report; the others are", async () => {
    const own = await report(fixerAll, `ZZ TEST own urgent ${run}`, "urgent", branchA.id);
    assert.deepEqual(await inbox(fixerAll, own.id), []);
    assert.equal((await inbox(fixerA, own.id)).length, 1);
  });

  await check("656: a normal report notifies nobody", async () => {
    const normal = await report(author, `ZZ TEST normal ${run}`, "normal", branchA.id);
    for (const who of [fixerAll, fixerA, author, outsider]) assert.deepEqual(await inbox(who, normal.id), [], who.label);
  });

  await check("656: the notification opens the report on the Fix Board", async () => {
    const [note] = await inbox(fixerA, urgent.id);
    const target = notificationTarget(note);
    assert.equal(target, `/core/fix-board?reportId=${urgent.id}`);
    const reportId = new URL(target!, ORIGIN).searchParams.get("reportId");
    const opened = await call("GET", `/api/fix-reports/${reportId}`, { cookie: cookie[fixerA.label] });
    assert.equal(opened.status, 200, show(opened));
    assert.equal(opened.body.id, urgent.id);
    // The page the link names is a route, and it reads the id it is given.
    const routes = readFileSync(join(APP_DIR, "client", "src", "App.tsx"), "utf8");
    assert.ok(routes.includes('path="/core/fix-board"'), "no /core/fix-board route");
    const board = readFileSync(join(APP_DIR, "client", "src", "pages", "core", "fix-board.tsx"), "utf8");
    assert.ok(board.includes(".get('reportId')"), "the Fix Board does not read ?reportId=");
  });

  // ─── SCRUM-657 ─────────────────────────────────────────────────────────────

  const atA = await report(author, `ZZ TEST at A ${run}`, "normal", branchA.id);
  const atB = await report(author, `ZZ TEST at B ${run}`, "normal", branchB.id);
  const listed = async (who: Login, path: string) => {
    const res = await call("GET", path, { cookie: cookie[who.label] });
    assert.equal(res.status, 200, `${who.label} ${path}: ${show(res)}`);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    return { a: ids.includes(atA.id), b: ids.includes(atB.id) };
  };

  await check("657: a one-branch member reads only that branch's report on the Fix Board", async () => {
    assert.deepEqual(await listed(fixerA, "/api/fix-reports"), { a: true, b: false });
  });

  await check("657: and only that branch's report in My Queue (the Today fix cards' read)", async () => {
    assert.deepEqual(await listed(fixerA, "/api/fix-reports?myQueue=true"), { a: true, b: false });
  });

  await check("657: a one-branch manager reads only that branch's report on the Fix Board", async () => {
    assert.deepEqual(await listed(managerA, "/api/fix-reports"), { a: true, b: false });
  });

  await check("657: the other branch's report is refused to them, by list filter and by id", async () => {
    const filtered = await call("GET", `/api/fix-reports?branchId=${branchB.id}`, { cookie: cookie[fixerA.label] });
    assert.equal(filtered.status, 403, show(filtered));
    const byId = await call("GET", `/api/fix-reports/${atB.id}/details`, { cookie: cookie[fixerA.label] });
    assert.equal(byId.status, 403, show(byId));
  });

  await check("657: an all-branch member reads both, on the board and in My Queue", async () => {
    assert.deepEqual(await listed(fixerAll, "/api/fix-reports"), { a: true, b: true });
    assert.deepEqual(await listed(fixerAll, "/api/fix-reports?myQueue=true"), { a: true, b: true });
  });

  await check("657: an admin reads both on the board", async () => {
    assert.deepEqual(await listed(admin, "/api/fix-reports"), { a: true, b: true });
  });

  await check("657: an urgent report alerts only the members who reach its branch", async () => {
    const urgentB = await report(author, `ZZ TEST urgent at B ${run}`, "urgent", branchB.id);
    assert.deepEqual(await inbox(fixerA, urgentB.id), []);
    assert.equal((await inbox(fixerAll, urgentB.id)).length, 1);
  });

  // ─── SCRUM-641 ─────────────────────────────────────────────────────────────

  const threaded = await report(author, `ZZ TEST thread ${run}`, "normal", branchA.id);
  const details = async (who: Login, id: string) => {
    const res = await call("GET", `/api/fix-reports/${id}/details`, { cookie: cookie[who.label] });
    assert.equal(res.status, 200, `${who.label} details: ${show(res)}`);
    return res.body;
  };

  await check("641: opening a report names who reported it and when", async () => {
    const opened = await details(fixerA, threaded.id);
    assert.deepEqual(opened.reporter, { id: author.id, name: `ZZ TEST Author ${run}` });
    assert.ok(!Number.isNaN(Date.parse(opened.report.createdAt)), opened.report.createdAt);
  });

  await check("641: a report stored without a name still names its author", async () => {
    await q("update fix_reports set reported_by_name = null where id = $1", [threaded.id]);
    assert.equal((await details(fixerA, threaded.id)).reporter.name, `ZZ TEST Author ${run}`);
  });

  await check("641: a comment's author is the session's, whatever the request says", async () => {
    const res = await call("POST", `/api/fix-reports/${threaded.id}/comments`, {
      cookie: cookie[fixerA.label],
      body: { message: "ZZ on my way", authorUserId: admin.id, authorType: "supplier_token", author: { fullName: "Somebody else" } },
    });
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.authorUserId, fixerA.id);
    assert.equal(res.body.authorType, "staff_user");
    const [comment] = (await details(admin, threaded.id)).comments;
    assert.equal(comment.author.fullName, `ZZ TEST FixerA ${run}`);
    assert.ok(!Number.isNaN(Date.parse(comment.createdAt)), comment.createdAt);
  });

  const supplierToken = randomBytes(32).toString("hex");
  const supplierName = `ZZ TEST Supplier ${run}`;
  const [supplier] = await q<{ id: string }>(
    `insert into fix_supplier_tokens (tenant_id, name, token_hash, allowed_branch_ids, created_by_user_id)
     values ($1, $2, $3, $4::jsonb, $5) returning id`,
    [tenant, supplierName, createHash("sha256").update(supplierToken).digest("hex"), JSON.stringify([branchA.id]), admin.id],
  );

  await check("641: a supplier's comment carries the name on their link", async () => {
    const res = await call("POST", `/api/supplier-portal/fix-reports/${threaded.id}/comments?token=${supplierToken}`, {
      body: { message: "ZZ arriving at noon" },
    });
    assert.equal(res.status, 201, show(res));
    const comment = (await details(admin, threaded.id)).comments.find((c: { supplierTokenId: string | null }) => c.supplierTokenId === supplier.id);
    assert.deepEqual(comment.supplierToken, { id: supplier.id, name: supplierName });
  });

  // tsx compiles the client's JSX with the classic transform, which reads a global React.
  (globalThis as { React?: unknown }).React = React;

  await check("641: the thread shows each author's name with the date and time", async () => {
    const opened = await details(admin, threaded.id);
    const html = renderToStaticMarkup(React.createElement(FixActivityFeed, {
      entries: opened.comments.map(rawCommentToActivityEntry),
      createdAt: opened.report.createdAt,
      reportedByName: opened.reporter.name,
      currentUserId: admin.id,
    }));
    const when = (iso: string) => format(parseISO(iso), "dd MMM yyyy, HH:mm");
    assert.ok(html.includes(`Report submitted by ZZ TEST Author ${run}`), html);
    assert.ok(html.includes(when(opened.report.createdAt)), html);
    assert.ok(html.includes(`ZZ TEST FixerA ${run}`), html);
    assert.ok(html.includes(supplierName), html);
    for (const comment of opened.comments) assert.ok(html.includes(when(comment.createdAt)), html);
    // One's own comment still reads as one's own, with the name beside it.
    const own = renderToStaticMarkup(React.createElement(FixActivityFeed, {
      entries: opened.comments.map(rawCommentToActivityEntry),
      currentUserId: fixerA.id,
    }));
    assert.ok(own.includes(`ZZ TEST FixerA ${run} (you)`), own);
  });

  const reportRow = async (id: string) =>
    (await q<{ archived_at: Date | null; archived_by_user_id: string | null }>(
      "select archived_at, archived_by_user_id from fix_reports where id = $1",
      [id],
    ))[0];
  const deletionRows = (id: string) =>
    q<{ branch_id: string; tenant_id: string; created_by: string; summary_text: string; metadata_json: string }>(
      // Matched as text: the job's shared activity_log holds rows whose metadata is not JSON.
      "select branch_id, tenant_id, created_by, summary_text, metadata_json from activity_log where activity_type = 'fix_report_deleted' and metadata_json like $1",
      [`%"fixReportId":"${id}"%`],
    );
  const remove = (who: Login, id: string) => call("DELETE", `/api/fix-reports/${id}`, { cookie: cookie[who.label] });

  const duplicateTitle = `ZZ TEST duplicate ${run}`;
  const duplicate = await report(author, duplicateTitle, "normal", branchA.id);
  await call("POST", `/api/fix-reports/${duplicate.id}/comments`, { cookie: cookie[fixerA.label], body: { message: "ZZ kept with the report" } });
  const [duplicateMedia] = (await details(admin, duplicate.id)).report.media as string[];

  await check("641: the reporter, Fix Department members and all-branch staff cannot delete a report", async () => {
    for (const who of [author, fixerA, fixerAll]) {
      const res = await remove(who, duplicate.id);
      assert.equal(res.status, 403, `${who.label}: ${show(res)}`);
    }
    assert.equal((await reportRow(duplicate.id)).archived_at, null);
    assert.deepEqual(await deletionRows(duplicate.id), []);
  });

  await check("641: a manager cannot delete a report at a branch they do not reach", async () => {
    const res = await remove(managerA, atB.id);
    assert.equal(res.status, 403, show(res));
    assert.equal((await reportRow(atB.id)).archived_at, null);
  });

  await check("641: a manager deletes a report at their branch, and the row and comments stay", async () => {
    const res = await remove(managerA, duplicate.id);
    assert.equal(res.status, 204, show(res));
    const row = await reportRow(duplicate.id);
    assert.ok(row.archived_at, "archived_at was not set");
    assert.equal(row.archived_by_user_id, managerA.id);
    const comments = await q("select id from fix_comments where fix_id = $1", [duplicate.id]);
    assert.equal(comments.length, 1);
  });

  await check("641: the delete is recorded once, naming the report and who deleted it", async () => {
    const rows = await deletionRows(duplicate.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].branch_id, branchA.id);
    assert.equal(rows[0].tenant_id, tenant);
    assert.equal(rows[0].created_by, managerA.id);
    assert.ok(rows[0].summary_text.includes(duplicateTitle), rows[0].summary_text);
    assert.ok(rows[0].summary_text.includes(`ZZ TEST ManagerA ${run}`), rows[0].summary_text);
    const meta = JSON.parse(rows[0].metadata_json);
    assert.equal(meta.title, duplicateTitle);
    assert.equal(meta.reportedBy, author.id);
  });

  await check("641: a deleted report leaves every list and by-id read", async () => {
    const paths = [`/api/fix-reports?branchId=${branchA.id}`, "/api/fix-reports", "/api/fix-reports?myQueue=true", "/api/fix-reports?myReports=true"];
    for (const who of [admin, fixerAll, author]) {
      for (const path of paths) {
        if (who === author && path !== "/api/fix-reports?myReports=true") continue;
        const res = await call("GET", path, { cookie: cookie[who.label] });
        assert.equal(res.status, 200, `${who.label} ${path}: ${show(res)}`);
        assert.ok(!(res.body as Array<{ id: string }>).some((r) => r.id === duplicate.id), `${who.label} ${path} still lists it`);
      }
    }
    const reads: Array<[string, string, unknown?]> = [
      ["GET", `/api/fix-reports/${duplicate.id}`],
      ["GET", `/api/fix-reports/${duplicate.id}/details`],
      ["GET", `/api/fix-reports/${duplicate.id}/comments`],
      ["POST", `/api/fix-reports/${duplicate.id}/comments`, { message: "ZZ too late" }],
      ["PATCH", `/api/fix-reports/${duplicate.id}/update`, { status: "in_progress" }],
      ["PATCH", `/api/fix-reports/${duplicate.id}`, { status: "in_progress" }],
      ["PATCH", `/api/fix-reports/${duplicate.id}/close`, {}],
      ["DELETE", `/api/fix-reports/${duplicate.id}`],
      ["GET", duplicateMedia],
    ];
    for (const [method, path, body] of reads) {
      const res = await call(method, path, { cookie: cookie[admin.label], body });
      assert.equal(res.status, 404, `${method} ${path}: ${show(res)}`);
    }
  });

  await check("641: a deleted report is gone from the supplier's link too", async () => {
    const list = await call("GET", `/api/supplier-portal/fix-reports?token=${supplierToken}`);
    assert.equal(list.status, 200, show(list));
    assert.ok(!(list.body as Array<{ id: string }>).some((r) => r.id === duplicate.id), "the supplier list still has it");
    const filename = duplicateMedia.split("/").pop();
    const reads: Array<[string, string, unknown?]> = [
      ["GET", `/api/supplier-portal/fix-reports/${duplicate.id}?token=${supplierToken}`],
      ["GET", `/api/supplier-portal/fix-reports/${duplicate.id}/media/${filename}?token=${supplierToken}`],
      ["POST", `/api/supplier-portal/fix-reports/${duplicate.id}/comments?token=${supplierToken}`, { message: "ZZ too late" }],
      ["PATCH", `/api/supplier-portal/fix-reports/${duplicate.id}/close?token=${supplierToken}`, {}],
    ];
    for (const [method, path, body] of reads) {
      const res = await call(method, path, { body });
      assert.equal(res.status, 404, `${method} ${path}: ${show(res)}`);
    }
  });

  await check("641: deleting twice at once deletes once and records once", async () => {
    const twice = await report(author, `ZZ TEST twice ${run}`, "normal", branchA.id);
    const answers = await Promise.all([remove(admin, twice.id), remove(managerA, twice.id)]);
    assert.deepEqual(answers.map((a) => a.status).sort(), [204, 404], answers.map(show).join(" | "));
    assert.equal((await deletionRows(twice.id)).length, 1);
  });

  await check("641: a report deleted from a checklist item no longer shows on that item", async () => {
    const [template] = await q<{ id: string }>(
      "insert into checklist_templates (tenant_id, branch_id, name, checklist_type) values ($1, $2, $3, 'operational') returning id",
      [tenant, branchA.id, `ZZ TEST checklist ${run}`],
    );
    const [templateItem] = await q<{ id: string }>(
      "insert into checklist_template_items (tenant_id, template_id, title, linked_to_fix) values ($1, $2, 'ZZ TEST handrail', true) returning id",
      [tenant, template.id],
    );
    const [checklistRun] = await q<{ id: string }>(
      "insert into checklist_runs (tenant_id, branch_id, template_id, status) values ($1, $2, $3, 'in_progress') returning id",
      [tenant, branchA.id, template.id],
    );
    const [runItem] = await q<{ id: string }>(
      "insert into checklist_run_items (tenant_id, run_id, template_item_id) values ($1, $2, $3) returning id",
      [tenant, checklistRun.id, templateItem.id],
    );
    const form = new FormData();
    form.append("media", new Blob([JPEG], { type: "image/jpeg" }), "photo.jpg");
    const upload = await call("POST", "/api/fix-reports/upload", { cookie: cookie[managerA.label], form });
    const linked = await call("POST", "/api/fix-reports", {
      cookie: cookie[managerA.label],
      body: { media: upload.body.urls, title: "ZZ", sourceChecklistRunItemId: runItem.id, tags: [] },
    });
    assert.equal(linked.status, 201, show(linked));
    const linkedIds = async () => {
      const source = await call("GET", `/api/fix-reports/checklist-source/${runItem.id}`, { cookie: cookie[managerA.label] });
      assert.equal(source.status, 200, show(source));
      const opened = await call("GET", `/api/checklist-runs/${checklistRun.id}`, { cookie: cookie[managerA.label] });
      assert.equal(opened.status, 200, show(opened));
      const item = (opened.body.items as Array<{ id: string; linkedFixReports?: Array<{ id: string }> }>).find((i) => i.id === runItem.id);
      return { source: source.body.reports.map((r: { id: string }) => r.id), run: (item?.linkedFixReports ?? []).map((r) => r.id) };
    };
    assert.deepEqual(await linkedIds(), { source: [linked.body.id], run: [linked.body.id] });
    assert.equal((await remove(managerA, linked.body.id)).status, 204);
    assert.deepEqual(await linkedIds(), { source: [], run: [] });
  });

  const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
  const uploadAs = async (who: Login, files: Array<{ bytes: Buffer; type: string; name: string }>, query = "?purpose=comment") => {
    const form = new FormData();
    for (const f of files) form.append("media", new Blob([f.bytes], { type: f.type }), f.name);
    return call("POST", `/api/fix-reports/upload${query}`, { cookie: cookie[who.label], form });
  };
  const photo = { bytes: JPEG, type: "image/jpeg", name: "photo.jpg" };
  const pdfFile = { bytes: PDF, type: "application/pdf", name: "quote.pdf" };
  const attached = await report(author, `ZZ TEST attachments ${run}`, "normal", branchA.id);
  const commentOn = (who: Login, id: string, body: unknown) =>
    call("POST", `/api/fix-reports/${id}/comments`, { cookie: cookie[who.label], body });
  const bytesOf = async (path: string, cookieValue?: string) => {
    const res = await fetch(`${ORIGIN}${path}`, { headers: cookieValue ? { cookie: cookieValue } : {} });
    return { status: res.status, type: res.headers.get("content-type"), sniff: res.headers.get("x-content-type-options"), bytes: Buffer.from(await res.arrayBuffer()) };
  };

  let photoUrl = "";
  let pdfUrl = "";
  await check("641: a comment carries a photo and a PDF, stored without their claims", async () => {
    const upload = await uploadAs(fixerA, [photo, pdfFile]);
    assert.equal(upload.status, 200, show(upload));
    const res = await commentOn(fixerA, attached.id, { message: "ZZ two attached", media: upload.body.urls });
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.authorUserId, fixerA.id);
    assert.equal(res.body.media.length, 2);
    [photoUrl, pdfUrl] = res.body.media;
    assert.match(photoUrl, /^\/api\/files\/fix-media\/[a-zA-Z0-9._-]+\.jpg$/);
    assert.match(pdfUrl, /^\/api\/files\/fix-media\/[a-zA-Z0-9._-]+\.pdf$/);
    const opened = await details(author, attached.id);
    assert.deepEqual(opened.comments[0].media, [photoUrl, pdfUrl]);
    assert.equal((opened.report.media as string[]).includes(photoUrl), false, "the report's own media took a comment's file");
  });

  await check("641: an attachment alone makes a comment; nothing at all is refused", async () => {
    const upload = await uploadAs(author, [photo]);
    const res = await commentOn(author, attached.id, { media: upload.body.urls });
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.message, "");
    for (const body of [{}, { message: "   " }, { message: "   ", media: [] }, { message: 5 }, { media: "x" }]) {
      const refused = await commentOn(author, attached.id, body);
      assert.equal(refused.status, 400, `${JSON.stringify(body)}: ${show(refused)}`);
    }
  });

  await check("641: a comment can only claim its author's own fresh upload", async () => {
    const upload = await uploadAs(fixerA, [photo]);
    const [claimed] = upload.body.urls as string[];
    const bare = claimed.split("?")[0];
    const tampered = claimed.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const eleven = Array.from({ length: 11 }, () => claimed);
    const cases: Array<[Login, unknown]> = [
      [author, [claimed]],
      [fixerA, [bare]],
      [fixerA, [tampered]],
      [fixerA, [photoUrl]],
      [fixerA, ["/api/files/fix-media/../../secret.jpg?claim=9999999999999.00"]],
      [fixerA, eleven],
      [fixerA, [claimed, claimed]],
    ];
    for (const [who, media] of cases) {
      const res = await commentOn(who, attached.id, { message: "ZZ", media });
      assert.equal(res.status, 400, `${who.label} ${JSON.stringify(media).slice(0, 80)}: ${show(res)}`);
    }
  });

  await check("641: an attachment is served only under the owning report's access", async () => {
    const full = await bytesOf(photoUrl, cookie[fixerA.label]);
    assert.equal(full.status, 200);
    assert.ok(full.bytes.equals(JPEG), "the photo's bytes changed");
    const thumb = await bytesOf(`${photoUrl}?thumb=1`, cookie[fixerA.label]);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.type, "image/jpeg");
    assert.equal((await bytesOf(photoUrl, cookie[author.label])).status, 200, "the report's author reads it");
    assert.equal((await bytesOf(photoUrl, cookie[outsider.label])).status, 403, "outside the report");
    assert.equal((await bytesOf(photoUrl)).status, 401, "not signed in");
    const atOtherBranch = await report(author, `ZZ TEST attachments at B ${run}`, "normal", branchB.id);
    const upload = await uploadAs(author, [photo]);
    const res = await commentOn(author, atOtherBranch.id, { media: upload.body.urls });
    assert.equal(res.status, 201, show(res));
    assert.equal((await bytesOf(res.body.media[0], cookie[managerA.label])).status, 403, "a manager of another branch");
    assert.equal((await bytesOf("/api/files/fix-media/fix_nothing.jpg", cookie[admin.label])).status, 404, "an unattached name");
  });

  await check("641: a PDF opens as one, and only a real PDF goes up", async () => {
    const opened = await bytesOf(pdfUrl, cookie[fixerA.label]);
    assert.equal(opened.status, 200);
    assert.equal(opened.type, "application/pdf");
    assert.equal(opened.sniff, "nosniff");
    assert.ok(opened.bytes.equals(PDF), "the PDF's bytes changed");
    assert.equal((await bytesOf(`${pdfUrl}?thumb=1`, cookie[fixerA.label])).type, "application/pdf");
    const fake = await uploadAs(fixerA, [{ bytes: JPEG, type: "application/pdf", name: "fake.pdf" }]);
    assert.equal(fake.status, 400, show(fake));
    assert.ok(String(fake.body.message).includes("fake.pdf"), show(fake));
  });

  await check("641: a PDF never reaches a report's own media", async () => {
    const plain = await uploadAs(fixerA, [pdfFile], "");
    assert.notEqual(plain.status, 200, show(plain));
    const upload = await uploadAs(fixerA, [pdfFile]);
    const created = await call("POST", "/api/fix-reports", {
      cookie: cookie[fixerA.label],
      body: { media: upload.body.urls, title: "ZZ", priority: "normal", branchId: branchA.id, tags: [] },
    });
    assert.equal(created.status, 400, show(created));
    const completed = await call("PATCH", `/api/fix-reports/${attached.id}/update`, {
      cookie: cookie[fixerA.label],
      body: { status: "in_progress", appendMedia: upload.body.urls },
    });
    assert.equal(completed.status, 400, show(completed));
  });

  await check("641: a video goes up on a comment as on a report", async () => {
    const video = readFileSync(join(APP_DIR, "tests", "fixtures", "media", "checklist-evidence.mp4"));
    const upload = await uploadAs(fixerA, [{ bytes: video, type: "video/mp4", name: "clip.mp4" }]);
    assert.equal(upload.status, 200, show(upload));
    const res = await commentOn(fixerA, attached.id, { message: "ZZ video", media: upload.body.urls });
    assert.equal(res.status, 201, show(res));
    assert.match(res.body.media[0], /\.mp4$/);
    assert.equal((await bytesOf(res.body.media[0], cookie[author.label])).status, 200);
  });

  await check("641: the thread shows attachments directly, and no empty line for an attachment alone", async () => {
    const opened = await details(admin, attached.id);
    const html = renderToStaticMarkup(React.createElement(FixActivityFeed, {
      entries: opened.comments.map(rawCommentToActivityEntry),
      createdAt: opened.report.createdAt,
      reportedByName: opened.reporter.name,
    }));
    assert.ok(html.includes(`src="${photoUrl}?thumb=1"`), html);
    assert.ok(html.includes(`href="${pdfUrl}"`), html);
    assert.ok(html.includes("PDF document"), html);
    assert.ok(!html.includes(`src="${pdfUrl}`), "a PDF was drawn as a picture");
    const alone = opened.comments.find((c: { message: string }) => c.message === "");
    const row = renderToStaticMarkup(React.createElement(FixActivityFeed, { entries: [rawCommentToActivityEntry(alone)] }));
    assert.ok(row.includes("fix-comment-attachments"), row);
    assert.ok(!row.includes('<p class="text-sm text-foreground/80'), row);
  });

  await check("641: a supplier who can read the comment can open its attachments", async () => {
    const opened = await call("GET", `/api/supplier-portal/fix-reports/${attached.id}?token=${supplierToken}`);
    assert.equal(opened.status, 200, show(opened));
    const comment = (opened.body.comments as Array<{ message: string; media: string[] }>).find((c) => c.message === "ZZ two attached");
    assert.equal(comment?.media.length, 2);
    const [supplierPhoto, supplierPdf] = comment!.media;
    assert.ok(supplierPhoto.startsWith(`/api/supplier-portal/fix-reports/${attached.id}/media/`), supplierPhoto);
    const photoBytes = await bytesOf(supplierPhoto);
    assert.equal(photoBytes.status, 200);
    assert.ok(photoBytes.bytes.equals(JPEG), "the photo's bytes changed");
    assert.equal((await bytesOf(supplierPdf)).type, "application/pdf");
    // Another report's route does not serve this comment's file, and a link
    // for the other branch does not reach this report.
    const filename = photoUrl.split("/").pop();
    assert.equal((await bytesOf(`/api/supplier-portal/fix-reports/${threaded.id}/media/${filename}?token=${supplierToken}`)).status, 404);
    const otherToken = randomBytes(32).toString("hex");
    await q(
      "insert into fix_supplier_tokens (tenant_id, name, token_hash, allowed_branch_ids, created_by_user_id) values ($1, $2, $3, $4::jsonb, $5)",
      [tenant, `ZZ TEST other supplier ${run}`, createHash("sha256").update(otherToken).digest("hex"), JSON.stringify([branchB.id]), admin.id],
    );
    assert.equal((await bytesOf(`/api/supplier-portal/fix-reports/${attached.id}/media/${filename}?token=${otherToken}`)).status, 403);
  });

  await check("641: a deleted report's attachments go with it", async () => {
    assert.equal((await remove(managerA, attached.id)).status, 204);
    assert.equal((await bytesOf(photoUrl, cookie[admin.label])).status, 404);
    const stored = await q<{ media: string[] }>("select media from fix_comments where fix_id = $1 and message = 'ZZ two attached'", [attached.id]);
    assert.deepEqual(stored[0].media, [photoUrl, pdfUrl], "the comment's record of them stays");
  });

  console.log(`fix-module.check: ${checks} checks passed`);
} catch (err) {
  console.error("fix-module.check FAILED:", err);
  process.exitCode = 1;
} finally {
  // The job shares one database across the app checks; the tenant-ownership
  // check later re-adds the baseline one-row-per-key unique on settings for a
  // staged simulation, so this check must not leave its park group's rows behind.
  await q("delete from settings where tenant_id = $1", [tenant]).catch(() => {});
  for (const child of children) child.kill();
  await pool.end();
}
