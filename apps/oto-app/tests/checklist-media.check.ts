// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) once, and
// needs a database whose otoapp schema the app's migrator has built.
//
// SCRUM-562 (R5) over HTTP, on the routes as registered:
//   - checklist item evidence takes a photo or a video: a real MP4 and a real
//     WebM (tests/fixtures/media) are accepted by their file signatures, while
//     a file whose bytes do not match its declared type is refused, and the
//     checker fail photo stays photo-only;
//   - item evidence is held to 20 MB and checker photos to 5 MB, each refused
//     with a 413 that says so;
//   - the private serving route answers a Range request with 206 and a correct
//     Content-Range (iPad Safari will not play video without it), the suffix
//     form included, and another park group still gets 404;
//   - the upload claim is still enforced: no item, no upload; a canonical URL
//     without its claim, or a claim made for another item, is refused on save;
//   - checklist history filters: periods validated (Monday weeks, whole
//     months, one-day days, both ends), dates read in the branch timezone,
//     employee and department narrowing, the no-period default (every
//     completed run plus this week's misses), assignedTo in the answer, and
//     every answer fenced to the caller's park group.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/checklist-media.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("checklist-media.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const SESSION_SECRET = randomBytes(24).toString("hex");
const fixture = (name: string) => readFileSync(join(APP_DIR, "tests", "fixtures", "media", name));
const MP4 = fixture("checklist-evidence.mp4");
const WEBM = fixture("checklist-evidence.webm");
const JPEG = fixture("checklist-evidence.jpg");

// ─── Rows ─────────────────────────────────────────────────────────────────────

async function parkGroup(label: string) {
  const tenant = randomUUID();
  const branch = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 562 ${label} ${run}`, `zz-562-${label}-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [branch, tenant, `ZZ TEST 562 park ${label} ${run}`]);
  return { tenant, branch };
}
const A = await parkGroup("a");
const B = await parkGroup("b");

async function user(tenant: string, role: string, label: string) {
  const id = randomUUID();
  const email = `zz-562-${label}-${id.slice(0, 6)}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
  return { id, email };
}
const managerA = await user(A.tenant, "manager", "manager-a");
const managerB = await user(B.tenant, "manager", "manager-b");
const staffA = await user(A.tenant, "staff", "staff-a");

const department = async (tenant: string, label: string) =>
  (await q<{ id: string }>("insert into departments (tenant_id, name) values ($1, $2) returning id", [tenant, `ZZ TEST 562 ${label} ${run}`]))[0]!.id;
const deptOne = await department(A.tenant, "dept one");
const deptTwo = await department(A.tenant, "dept two");
const deptB = await department(B.tenant, "dept b");

const employee = async (tenant: string, label: string, userId: string | null = null) =>
  (await q<{ id: string }>(
    "insert into employees (tenant_id, user_id, full_name, nickname, email) values ($1, $2, $3, 'ZZ', $4) returning id",
    [tenant, userId, `ZZ TEST 562 ${label}`, `zz-562-${label}-${randomUUID().slice(0, 6)}-${run}@example.com`],
  ))[0]!.id;
const empOne = await employee(A.tenant, "one", staffA.id);
const empTwo = await employee(A.tenant, "two");
const empB = await employee(B.tenant, "b");

async function template(tenant: string, branch: string, label: string, fields: { assignedEmployeeId?: string; departmentId?: string; assignedDepartmentId?: string }) {
  const id = (await q<{ id: string }>(
    `insert into checklist_templates (tenant_id, branch_id, name, department_id, assigned_employee_id, assigned_department_id, recurrence)
     values ($1, $2, $3, $4, $5, $6, 'daily') returning id`,
    [tenant, branch, `ZZ TEST 562 ${label} ${run}`, fields.departmentId ?? null, fields.assignedEmployeeId ?? null, fields.assignedDepartmentId ?? null],
  ))[0]!.id;
  const item = (await q<{ id: string }>(
    "insert into checklist_template_items (tenant_id, template_id, title, requires_photo) values ($1, $2, $3, true) returning id",
    [tenant, id, `ZZ TEST 562 ${label} item`],
  ))[0]!.id;
  return { id, item };
}
const tOne = await template(A.tenant, A.branch, "one", { assignedEmployeeId: empOne, departmentId: deptOne });
const tTwo = await template(A.tenant, A.branch, "two", { assignedDepartmentId: deptTwo });
const tB = await template(B.tenant, B.branch, "b", { assignedEmployeeId: empB, departmentId: deptB });

type RunFields = { status: string; completedAt?: string; dueAt?: string | "now"; assignedTo?: string; staff?: unknown[] };
async function checklistRun(tenant: string, branch: string, t: { id: string; item: string }, fields: RunFields) {
  const id = (await q<{ id: string }>(
    `insert into checklist_runs (tenant_id, template_id, branch_id, status, completed_at, due_at, missed_at, assigned_to, responsible_staff)
     values ($1, $2, $3, $4::text::core_checklist_status, $5::timestamp, $6::timestamp,
       case when $4::text = 'missed' then (now() at time zone 'UTC') end, $7, $8::jsonb) returning id`,
    [tenant, t.id, branch, fields.status, fields.completedAt ?? null,
      fields.dueAt === "now" ? new Date().toISOString().replace("T", " ").slice(0, 19) : fields.dueAt ?? null,
      fields.assignedTo ?? null, JSON.stringify(fields.staff ?? [{ name: "ZZ TEST on shift" }])],
  ))[0]!.id;
  const item = (await q<{ id: string }>(
    "insert into checklist_run_items (tenant_id, run_id, template_item_id) values ($1, $2, $3) returning id",
    [tenant, id, t.item],
  ))[0]!.id;
  return { id, item };
}
// Open runs that take evidence.
const open = await checklistRun(A.tenant, A.branch, tOne, { status: "in_progress" });
const openOther = await checklistRun(A.tenant, A.branch, tTwo, { status: "in_progress" });
// History. Timestamps are UTC; the branch is Asia/Bangkok (UTC+7).
const c1 = await checklistRun(A.tenant, A.branch, tOne, { status: "completed", completedAt: "2026-10-14 03:00" }); // Wed 14 Oct local
const c2 = await checklistRun(A.tenant, A.branch, tTwo, { status: "completed", completedAt: "2026-09-15 03:00" }); // 15 Sep
const c3 = await checklistRun(A.tenant, A.branch, tOne, { status: "completed", completedAt: "2026-10-11 18:00" }); // Mon 12 Oct 01:00 local (Sun 11 Oct UTC)
const c4 = await checklistRun(A.tenant, A.branch, tTwo, { status: "completed", completedAt: "2026-10-13 03:00", staff: [{ employeeId: empTwo, name: "ZZ TEST two" }] });
const c5 = await checklistRun(A.tenant, A.branch, tTwo, { status: "completed", completedAt: "2026-10-13 04:00", assignedTo: staffA.id });
const mNow = await checklistRun(A.tenant, A.branch, tTwo, { status: "missed", dueAt: "now" });
const mOld = await checklistRun(A.tenant, A.branch, tOne, { status: "missed", dueAt: "2026-09-02 03:00" });
const bDone = await checklistRun(B.tenant, B.branch, tB, { status: "completed", completedAt: "2026-10-14 03:00", staff: [{ employeeId: empOne, name: "ZZ TEST cross" }] });

// ─── The app ─────────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
async function serve(env: Record<string, string>): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "dev",
      DEPLOY_ENV: "local",
      OTOAPP_JOBS: "inprocess",
      STORAGE_ENV_PREFIX: "zz-test",
      OBJECT_STORAGE: "local",
      LOG_LEVEL: "warn",
      SESSION_SECRET,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise((resolve, reject) => {
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

try {
  const origin = await serve({ OTOAPP_LEGACY_LOGIN: "true" });
  const signIn = async (email: string) => {
    const login = await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: email, password: PASSWORD }),
    });
    assert.equal(login.status, 200, `${email} sign-in: ${login.status}`);
    return login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  };
  const cookieA = await signIn(managerA.email);
  const cookieB = await signIn(managerB.email);
  const read = async (res: Response) => {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const upload = async (path: string, bytes: Buffer, type: string, filename: string, itemId: string | null, cookie = cookieA) => {
    const form = new FormData();
    form.append("photo", new Blob([bytes], { type }), filename);
    if (itemId) form.append("itemId", itemId);
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { cookie }, body: form });
    return { status: res.status, body: await read(res) };
  };
  const call = async (method: string, path: string, payload?: unknown, cookie = cookieA) => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: { "content-type": "application/json", cookie },
      body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
    });
    return { status: res.status, body: await read(res) };
  };
  let passed = 0;

  // ── Video evidence by signature ──
  const mp4 = await upload("/api/checklist-evidence/upload", MP4, "video/mp4", "clip.mp4", open.item);
  assert.equal(mp4.status, 200, `MP4 upload: ${JSON.stringify(mp4.body)}`);
  assert.match(mp4.body.canonicalUrl, /^\/api\/files\/checkin-photos\/evidence_[0-9a-f-]+\.mp4$/);
  assert.match(mp4.body.url, /\.mp4\?claim=\d{13}\.[0-9a-f]{64}$/);
  const webm = await upload("/api/checklist-evidence/upload", WEBM, "video/webm", "clip.webm", open.item);
  assert.equal(webm.status, 200, `WebM upload: ${JSON.stringify(webm.body)}`);
  assert.match(webm.body.canonicalUrl, /\.webm$/);
  const mov = await upload("/api/checklist-evidence/upload", Buffer.concat([MP4.subarray(0, 8), Buffer.from("qt  "), MP4.subarray(12)]), "video/quicktime", "clip.mov", open.item);
  assert.equal(mov.status, 200, `QuickTime (ftyp qt) upload: ${JSON.stringify(mov.body)}`);
  assert.match(mov.body.canonicalUrl, /\.mov$/);
  const photo = await upload("/api/checklist-evidence/upload", JPEG, "image/jpeg", "photo.jpg", open.item);
  assert.equal(photo.status, 200, "a photo is still evidence");
  passed += 4;

  for (const [label, bytes, type, name] of [
    ["JPEG bytes named .mp4", JPEG, "video/mp4", "fake.mp4"],
    ["MP4 bytes declared WebM", MP4, "video/webm", "fake.webm"],
    ["WebM bytes declared MP4", WEBM, "video/mp4", "fake.mp4"],
    ["text named .mov", Buffer.from("ZZ TEST this is not a video at all, only words"), "video/quicktime", "fake.mov"],
    ["an ftyp box with an unknown brand", Buffer.concat([MP4.subarray(0, 8), Buffer.from("zzzz"), MP4.subarray(12)]), "video/mp4", "odd.mp4"],
    ["Matroska declared WebM", Buffer.from(WEBM.toString("latin1").replace("webm", "mtrk"), "latin1"), "video/webm", "fake.webm"],
    ["an unlisted type", MP4, "video/x-msvideo", "clip.avi"],
  ] as const) {
    const res = await upload("/api/checklist-evidence/upload", bytes, type, name, open.item);
    assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    passed++;
  }
  const checkerVideo = await upload("/api/checker-photos/upload", MP4, "video/mp4", "clip.mp4", open.item);
  assert.equal(checkerVideo.status, 400, "a checker fail photo stays a photo");
  assert.equal(checkerVideo.body.message, "A JPEG, PNG or WebP photo is required");
  passed++;

  // ── Size limits: 20 MB evidence, 5 MB checker photo, honest 413s ──
  const pad = (head: Buffer, size: number) => Buffer.concat([head, Buffer.alloc(size - head.length)]);
  const sixMbVideo = await upload("/api/checklist-evidence/upload", pad(MP4, 6 * 1024 * 1024), "video/mp4", "six.mp4", open.item);
  assert.equal(sixMbVideo.status, 200, "a 6 MB video is under the 20 MB evidence limit");
  const bigVideo = await upload("/api/checklist-evidence/upload", pad(MP4, 20 * 1024 * 1024 + 1), "video/mp4", "big.mp4", open.item);
  assert.equal(bigVideo.status, 413, JSON.stringify(bigVideo.body));
  assert.equal(bigVideo.body.message, "This file is larger than the 20 MB checklist evidence limit.");
  const bigChecker = await upload("/api/checker-photos/upload", pad(JPEG, 5 * 1024 * 1024 + 1), "image/jpeg", "big.jpg", open.item);
  assert.equal(bigChecker.status, 413, JSON.stringify(bigChecker.body));
  assert.equal(bigChecker.body.message, "This photo is still larger than the 5 MB upload limit. Try cropping it or choosing a smaller photo.");
  const checkerPhoto = await upload("/api/checker-photos/upload", JPEG, "image/jpeg", "fail.jpg", open.item);
  assert.equal(checkerPhoto.status, 200, "a small checker photo is taken");
  passed += 4;

  // ── The claim flow ──
  const noItem = await upload("/api/checklist-evidence/upload", MP4, "video/mp4", "clip.mp4", null);
  assert.equal(noItem.status, 400, "no checklist item, no upload");
  const otherGroupItem = await upload("/api/checklist-evidence/upload", MP4, "video/mp4", "clip.mp4", open.item, cookieB);
  assert.equal(otherGroupItem.status, 404, "another park group's item cannot take an upload");
  const unclaimed = await call("PATCH", `/api/checklist-run-items/${open.item}`, { photoEvidenceUrls: [mp4.body.canonicalUrl] });
  assert.equal(unclaimed.status, 400, "a canonical URL without its claim is refused");
  const otherItemClaim = await call("PATCH", `/api/checklist-run-items/${openOther.item}`, { photoEvidenceUrls: [mp4.body.url] });
  assert.equal(otherItemClaim.status, 400, "a claim made for another item is refused");
  const saved = await call("PATCH", `/api/checklist-run-items/${open.item}`, { photoEvidenceUrls: [mp4.body.url, webm.body.url] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const [stored] = await q<{ photo_evidence_urls: string[] }>("select photo_evidence_urls from checklist_run_items where id = $1", [open.item]);
  assert.deepEqual(stored!.photo_evidence_urls, [mp4.body.canonicalUrl, webm.body.canonicalUrl], "the canonical URLs are what is kept");
  passed += 5;

  // ── Private serving with byte ranges ──
  const whole = await fetch(`${origin}${mp4.body.canonicalUrl}`, { headers: { cookie: cookieA } });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), MP4);
  const firstTwo = await fetch(`${origin}${mp4.body.canonicalUrl}`, { headers: { cookie: cookieA, range: "bytes=0-1" } });
  assert.equal(firstTwo.status, 206, "Safari's opening probe gets a partial answer");
  assert.equal(firstTwo.headers.get("content-range"), `bytes 0-1/${MP4.length}`);
  assert.equal(firstTwo.headers.get("content-length"), "2");
  assert.deepEqual(Buffer.from(await firstTwo.arrayBuffer()), MP4.subarray(0, 2));
  const middle = await fetch(`${origin}${mp4.body.canonicalUrl}`, { headers: { cookie: cookieA, range: "bytes=100-" } });
  assert.equal(middle.status, 206);
  assert.equal(middle.headers.get("content-range"), `bytes 100-${MP4.length - 1}/${MP4.length}`);
  assert.deepEqual(Buffer.from(await middle.arrayBuffer()), MP4.subarray(100));
  const tail = await fetch(`${origin}${mp4.body.canonicalUrl}`, { headers: { cookie: cookieA, range: "bytes=-16" } });
  assert.equal(tail.status, 206, "the suffix form reads the last bytes");
  assert.equal(tail.headers.get("content-range"), `bytes ${MP4.length - 16}-${MP4.length - 1}/${MP4.length}`);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), MP4.subarray(MP4.length - 16));
  const beyond = await fetch(`${origin}${mp4.body.canonicalUrl}`, { headers: { cookie: cookieA, range: `bytes=${MP4.length + 10}-` } });
  assert.equal(beyond.status, 200, "a range past the end is answered with the whole file");
  await beyond.arrayBuffer();
  const webmRange = await fetch(`${origin}${webm.body.canonicalUrl}`, { headers: { cookie: cookieA, range: "bytes=0-3" } });
  assert.equal(webmRange.status, 206);
  assert.equal(webmRange.headers.get("content-type"), "video/webm");
  assert.deepEqual(Buffer.from(await webmRange.arrayBuffer()), WEBM.subarray(0, 4));
  const crossGroup = await fetch(`${origin}${mp4.body.canonicalUrl}`, { headers: { cookie: cookieB, range: "bytes=0-1" } });
  assert.equal(crossGroup.status, 404, "another park group cannot read the video, ranged or not");
  await crossGroup.arrayBuffer();
  const unsaved = await fetch(`${origin}${sixMbVideo.body.canonicalUrl}`, { headers: { cookie: cookieA } });
  assert.equal(unsaved.status, 404, "an upload never saved to an item is not served");
  await unsaved.arrayBuffer();
  passed += 8;

  // ── Checklist history filters ──
  const history = (query: string, cookie = cookieA) => call("GET", `/api/checklist-runs/history${query ? `?${query}` : ""}`, undefined, cookie);
  const ids = (body: { completed: { id: string }[]; missedGroups: { runs: { id: string }[] }[] }) => ({
    completed: new Set(body.completed.map((r) => r.id)),
    missed: new Set(body.missedGroups.flatMap((g) => g.runs.map((r) => r.id))),
  });

  for (const [label, query] of [
    ["a week starting on Tuesday", "period=week&from=2026-10-13&to=2026-10-19"],
    ["a week of the wrong length", "period=week&from=2026-10-12&to=2026-10-19"],
    ["a month that stops short", "period=month&from=2026-10-01&to=2026-10-30"],
    ["a month not from the first", "period=month&from=2026-10-02&to=2026-10-31"],
    ["a day spanning two days", "period=day&from=2026-10-12&to=2026-10-13"],
    ["a custom range backwards", "period=custom&from=2026-10-20&to=2026-10-01"],
    ["a period with one end", "period=custom&from=2026-10-01"],
    ["dates without a period", "from=2026-10-01&to=2026-10-31"],
    ["an impossible date", "period=custom&from=2026-02-30&to=2026-03-02"],
    ["an unknown period", "period=year&from=2026-01-01&to=2026-12-31"],
  ] as const) {
    const res = await history(query);
    assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    passed++;
  }

  // No period: every completed run, and only this week's misses.
  const all = await history("");
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const allIds = ids(all.body);
  for (const r of [c1, c2, c3, c4, c5]) assert.ok(allIds.completed.has(r.id), "every completed run is listed");
  assert.ok(allIds.missed.has(mNow.id), "this week's miss is listed");
  assert.ok(!allIds.missed.has(mOld.id), "an older miss waits for a period");
  assert.ok(!allIds.completed.has(bDone.id), "another park group's run never appears");
  const c5row = all.body.completed.find((r: { id: string }) => r.id === c5.id);
  assert.equal(c5row.assignedTo, staffA.id, "assignedTo is in the answer");
  passed += 2;

  // A Monday week, read in the branch's timezone.
  const week = ids((await history("period=week&from=2026-10-12&to=2026-10-18")).body);
  assert.deepEqual([...week.completed].filter((id) => [c1.id, c2.id, c3.id, c4.id, c5.id].includes(id)).sort(), [c1.id, c3.id, c4.id, c5.id].sort(),
    "the week holds the Monday-01:00-local completion and not September's");
  const priorWeek = ids((await history("period=week&from=2026-10-05&to=2026-10-11")).body);
  assert.ok(!priorWeek.completed.has(c3.id), "a completion on Sunday UTC but Monday local is not in the week before");
  const day = ids((await history("period=day&from=2026-10-12&to=2026-10-12")).body);
  assert.deepEqual([...day.completed].filter((id) => id === c3.id), [c3.id]);
  const month = await history("period=month&from=2026-09-01&to=2026-09-30");
  assert.equal(month.status, 200);
  const monthIds = ids(month.body);
  assert.ok(monthIds.completed.has(c2.id) && !monthIds.completed.has(c1.id), "a whole month");
  assert.ok(monthIds.missed.has(mOld.id) && !monthIds.missed.has(mNow.id), "the month's misses, not this week's");
  const custom = ids((await history("period=custom&from=2026-09-01&to=2026-10-13")).body);
  assert.ok(custom.completed.has(c2.id) && custom.completed.has(c3.id) && custom.completed.has(c4.id) && !custom.completed.has(c1.id), "a custom range");
  passed += 5;

  // Employee and department narrowing.
  const byOne = ids((await history(`employeeId=${empOne}`)).body);
  assert.deepEqual([...byOne.completed].sort(), [c1.id, c3.id, c5.id].sort(), "employee one: assigned on the template, or the run assigned to their user");
  const byTwo = ids((await history(`employeeId=${empTwo}`)).body);
  assert.deepEqual([...byTwo.completed], [c4.id], "employee two: named among the responsible staff");
  const byDeptTwo = ids((await history(`departmentId=${deptTwo}`)).body);
  assert.deepEqual([...byDeptTwo.completed].sort(), [c2.id, c4.id, c5.id].sort(), "department two");
  assert.ok(byDeptTwo.missed.has(mNow.id));
  const combined = ids((await history(`departmentId=${deptTwo}&employeeId=${empTwo}&period=week&from=2026-10-12&to=2026-10-18`)).body);
  assert.deepEqual([...combined.completed], [c4.id], "filters combine");
  passed += 4;

  // Fenced to the caller's park group.
  const foreignEmployee = await history(`employeeId=${empB}`);
  assert.equal(foreignEmployee.status, 200);
  assert.equal(foreignEmployee.body.completed.length, 0, "another park group's employee narrows to nothing");
  const foreignDept = await history(`departmentId=${deptB}`);
  assert.equal(foreignDept.body.completed.length, 0, "another park group's department narrows to nothing");
  const fromB = ids((await history(`employeeId=${empOne}`, cookieB)).body);
  assert.deepEqual([...fromB.completed], [bDone.id], "park group B sees only its own run, even naming A's employee");
  const bAll = ids((await history("", cookieB)).body);
  for (const r of [c1, c2, c3, c4, c5]) assert.ok(!bAll.completed.has(r.id));
  const staffCookie = await signIn(staffA.email);
  assert.equal((await history("", staffCookie)).status, 403, "history stays a manager's");
  passed += 5;

  console.log(`checklist-media.check: ${passed} checks passed`);
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
