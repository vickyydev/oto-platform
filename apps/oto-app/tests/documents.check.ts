// seed: its own — two park groups' worth of ZZ TEST rows (and the slug-`default`
// park group only when the database has none), made here. Not a Playwright file
// (the suite collects *.spec.ts and *.test.ts; this is neither): it boots the
// app's real routes against a database whose otoapp schema is migrated, with a
// stand-in for the platform bucket served from this process.
//
// S2-17b round 6 — the document modules as the app does them, over HTTP
// against the routes as registered (plan section 8 round 6; hazard H16;
// ticket check 2; questions Q31, Q40 and Q47 onwards):
//
//   1. Templates per park group (own only): another park group's template is
//      never listed, read, changed, assigned, forked or used, and its branch
//      is never assigned; each park group keeps its own last active template.
//   2. Policies per park group (own only; the lift's 503 is gone): a second
//      park group writes, versions and publishes its own, and its contract
//      acknowledges its own.
//   3. The asset catalogue per park group (own only; the 503 is gone).
//   4. Leave policies per park group (Q31), the default park group's
//      company-wide policy read where a park group has none (Q28's rule, Q49);
//      and the leave reads' remaining park-group crossings (Q40).
//   5. Contracts and letters: another park group's — or its employee or
//      template — is the app's 404 at every door, and the app's branch rule is
//      kept where it has one (FINDING Q50 where it has none).
//   6. Offboarding in one transaction (H16): a failure injected in the middle
//      and at the very end leaves nothing behind; the app's linked-login
//      switch-off; the database's one-offboarding-per-employee backstop.
//   7. The PDF and storage gate (ticket check 2): a contract and a letter
//      signed and a BEO generated, each opening only from a short-lived signed
//      URL after the check on its owner, an unauthorised read refused, and the
//      bucket itself never answering an unsigned request.
//   8. The org chart counted first: its GET writes the missing person nodes —
//      exactly those, once — and nothing for a reader the app does not let
//      write (FINDING Q52 for two GETs at once).
//   9. The HR employee doors (round 6's review, finding 1): every one of the
//      45 `/api/employees/:id*` doors in the census
//      (server/lib/employeeParkGroups.ts), driven as another park group's
//      admin against this park group's employee — each the answer the census
//      declares, nothing written — then the doors as the app has them within
//      the park group, and the ids an edit may not name.
//   Round 6's review also adds, in place: the branch-wide leave balances by
//   another park group's branch, and the app's leave-policy candidate set per
//   park group (section 4, findings 3 and 4); the wizard's six personal fields
//   (section 5, finding 2); and the offboarding's login backstop (section 6).
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/documents.check.ts
// PDFs are rendered by Chromium, as in the app's image: PUPPETEER_EXECUTABLE_PATH
// names it, or a usual install path is found. The platform's suite runs it the
// same way against a fresh test database when the app's node_modules are
// present (apps/api/test/s217b-r6.test.ts).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  BRANCH_NOT_FOUND,
  CATALOG_ITEM_NOT_FOUND,
  DOCUMENT_READ_RULES,
  LEAVE_POLICY_NOT_FOUND,
  LETTER_NOT_FOUND,
  POLICY_NOT_FOUND,
  PUBLIC_HOLIDAY_NOT_FOUND,
  TEMPLATE_NOT_FOUND,
} from "../server/lib/documentParkGroups";
import {
  CHANGE_NOT_FOUND,
  DEPARTMENT_NOT_FOUND,
  EMPLOYEE_DOORS,
  PERSON_NOT_FOUND,
  ROLE_NOT_FOUND,
  USER_NOT_FOUND,
  WIZARD_EMPLOYEE_FIELDS,
} from "../server/lib/employeeParkGroups";
import { FACE_ENROLMENT_OFF_REFUSAL } from "../server/lib/faceOff";
import { offboardingReasonLabel } from "../shared/schema";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("documents.check: DATABASE_URL is not set");
  process.exit(2);
}

const CHROMIUM = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p): p is string => !!p && existsSync(p));
if (!CHROMIUM) {
  console.error("documents.check: no Chromium to render PDFs with — set PUPPETEER_EXECUTABLE_PATH (the app's image has /usr/bin/chromium)");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 6 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");

/** A Bangkok calendar date `n` days from today. */
const day = (n: number) => new Date(Date.now() + 7 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

// ─── The park groups ─────────────────────────────────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const DEFAULT = (await q<{ id: string }>("select id from tenants where slug = 'default'"))[0]!.id;

interface ParkGroup {
  tenant: string;
  /** Branch X: the limited manager's branch. */
  x: string;
  /** Branch Y: the same park group's other branch. */
  y: string;
  admin: { id: string; email: string };
  /** A manager limited to branch X. */
  limited: { id: string; email: string };
}

async function user(tenant: string, role: string, email: string, branch: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    tenant,
    id,
    branch,
    branch ? "selected_branches" : "all_branches",
  ]);
  return id;
}

async function employee(tenant: string, branch: string, label: string, fields: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const cols = ["id", "tenant_id", "branch_id", "full_name", "nickname", "email", "status", ...Object.keys(fields)];
  const vals = [id, tenant, branch, `ZZ TEST ${run} ${label}`, "ZZ", `zz-r6-${label}-${id.slice(0, 8)}@example.com`, "active", ...Object.values(fields)];
  await q(`insert into employees (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  return id;
}

async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST r6 ${label} ${run}`, `zz-r6-${label}-${run}`]);
  const x = randomUUID();
  const y = randomUUID();
  for (const [id, suffix] of [[x, "x"], [y, "y"]] as const) {
    await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
      id,
      tenant,
      `ZZ TEST r6 ${label} ${suffix} ${run}`,
    ]);
  }
  const adminEmail = `zz-r6-${label}-admin-${run}@example.com`;
  const limitedEmail = `zz-r6-${label}-limited-${run}@example.com`;
  return {
    tenant,
    x,
    y,
    admin: { id: await user(tenant, "admin", adminEmail, null), email: adminEmail },
    limited: { id: await user(tenant, "manager", limitedEmail, x), email: limitedEmail },
  };
}

const A = await parkGroup("a");
const B = await parkGroup("b");
assert.notEqual(B.tenant, DEFAULT, "B is a park group other than the default one: the lift's 503 answered it");

// ─── A stand-in for the platform bucket ─────────────────────────────────────
//
// Private, as the real one is: it answers only a request the SDK signed — an
// Authorization header, or a presigned URL's query — and refuses anything else
// with S3's AccessDenied. It keeps what was put, by path.

const BUCKET = `zz-docs-${run}`;
const objects = new Map<string, { body: Buffer; type: string }>();
const bucketLog: Array<{ method: string; path: string; presigned: boolean; expires: string | null }> = [];

/** The SDK may stream a body as aws-chunked (`<hex>[;ext]\r\n<data>\r\n ... 0\r\n<trailers>\r\n\r\n`). */
function decodeAwsChunked(raw: Buffer): Buffer {
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = raw.indexOf("\r\n", at);
    if (eol < 0) break;
    const size = parseInt(raw.subarray(at, eol).toString("latin1").split(";")[0]!, 16);
    if (!size) break;
    out.push(raw.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

const bucketServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://bucket");
  const path = decodeURIComponent(url.pathname);
  const presigned = url.searchParams.has("X-Amz-Signature");
  const signed = presigned || /^AWS4-HMAC-SHA256 /.test(String(req.headers.authorization ?? ""));
  bucketLog.push({ method: req.method ?? "", path, presigned, expires: url.searchParams.get("X-Amz-Expires") });
  if (!signed) {
    res.writeHead(403, { "content-type": "application/xml" });
    res.end("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
    return;
  }
  if (req.method === "PUT") {
    const raw = await readBody(req);
    const chunked = /aws-chunked/.test(String(req.headers["content-encoding"] ?? "")) ||
      String(req.headers["x-amz-content-sha256"] ?? "").startsWith("STREAMING-");
    objects.set(path, { body: chunked ? decodeAwsChunked(raw) : raw, type: String(req.headers["content-type"] ?? "application/octet-stream") });
    res.writeHead(200, { etag: '"zz"' });
    res.end();
    return;
  }
  const object = objects.get(path);
  if (req.method === "DELETE") {
    objects.delete(path);
    res.writeHead(204);
    res.end();
    return;
  }
  if (!object) {
    res.writeHead(404, { "content-type": "application/xml" });
    res.end(req.method === "HEAD" ? undefined : "<Error><Code>NoSuchKey</Code></Error>");
    return;
  }
  res.writeHead(200, { "content-type": object.type, "content-length": String(object.body.length) });
  res.end(req.method === "HEAD" ? undefined : object.body);
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
  // The platform bucket, as on a deployment — here the stand-in above.
  OBJECT_STORAGE: "s3",
  S3_BUCKET: BUCKET,
  S3_ENDPOINT: "127.0.0.1",
  S3_PORT: String(BUCKET_PORT),
  S3_USE_SSL: "false",
  AWS_REGION: "auto",
  AWS_ACCESS_KEY_ID: "zz-access",
  AWS_SECRET_ACCESS_KEY: "zz-secret",
  PUPPETEER_EXECUTABLE_PATH: CHROMIUM,
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
  location: string | null;
}

let ORIGIN = "";
async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the message.
  }
  return { status: res.status, body, location: res.headers.get("location") };
}
const show = (a: Answer) => `${a.status} ${typeof a.body === "string" ? a.body.slice(0, 300) : JSON.stringify(a.body)?.slice(0, 300)}`;

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

/** A PNG data URL long enough for the app's signature check. */
const SIGNATURE = `data:image/png;base64,${Buffer.from(randomBytes(120)).toString("base64")}`;

const INJECT = `zz_r6_inject_${run}`;

try {
  ORIGIN = await serve();
  const cookie = {
    a: await signIn(A.admin.email),
    aLimited: await signIn(A.limited.email),
    b: await signIn(B.admin.email),
  };

  // ── 1. Templates ────────────────────────────────────────────────────────────
  console.log("1. templates, each park group's own:");
  assert.equal(DOCUMENT_READ_RULES.templates, "own");
  const newTemplate = async (who: string, name: string, templateType = "employment") => {
    const made = await call("POST", "/api/templates", {
      cookie: who,
      body: { name, htmlBody: `<p>{{employee.full_name}} — ${name}</p>`, templateType },
    });
    assert.equal(made.status, 201, show(made));
    return made.body as { id: string; tenantId: string };
  };
  const tA = await newTemplate(cookie.a, `ZZ r6 A ${run}`);
  const tA2 = await newTemplate(cookie.a, `ZZ r6 A2 ${run}`);
  const tB = await newTemplate(cookie.b, `ZZ r6 B ${run}`);

  await check("a template is made in its maker's park group; the body cannot name another", async () => {
    assert.equal(tA.tenantId, A.tenant);
    assert.equal(tB.tenantId, B.tenant);
    const forged = await call("POST", "/api/templates", {
      cookie: cookie.b,
      body: { name: `ZZ r6 forged ${run}`, htmlBody: "<p>x</p>", tenantId: A.tenant },
    });
    assert.equal(forged.status, 201, show(forged));
    assert.equal(forged.body.tenantId, B.tenant);
    const moved = await call("PATCH", `/api/templates/${forged.body.id}`, { cookie: cookie.b, body: { tenantId: A.tenant, name: `ZZ r6 forged2 ${run}` } });
    assert.equal(moved.status, 200, show(moved));
    assert.equal((await q<{ tenant_id: string }>("select tenant_id from templates where id = $1", [forged.body.id]))[0]!.tenant_id, B.tenant);
  });

  await check("lists, reads, assignments and counts are the park group's own; another's template is the same as none", async () => {
    const listB = (await call("GET", "/api/templates", { cookie: cookie.b })).body as { id: string }[];
    assert.ok(listB.some((t) => t.id === tB.id) && !listB.some((t) => t.id === tA.id), "B lists its own only");
    const withAssignments = (await call("GET", "/api/templates/with-assignments", { cookie: cookie.b })).body as { id: string }[];
    assert.ok(!withAssignments.some((t) => t.id === tA.id));
    const readA = await call("GET", `/api/templates/${tA.id}`, { cookie: cookie.b });
    assert.equal(readA.status, 404, show(readA));
    assert.deepEqual(readA.body, TEMPLATE_NOT_FOUND);
    assert.equal((await call("GET", `/api/templates/${tA.id}`, { cookie: cookie.a })).status, 200);
    assert.deepEqual((await call("GET", `/api/templates/${tA.id}/assignments`, { cookie: cookie.b })).body, []);
    assert.deepEqual((await call("GET", `/api/templates/${tA.id}/contract-count`, { cookie: cookie.b })).body, { count: 0 });
  });

  await check("assignments: only the park group's own template, to its own branch (the app's 404 words)", async () => {
    const own = await call("POST", `/api/templates/${tA.id}/assignments`, { cookie: cookie.a, body: { branchId: A.x } });
    assert.equal(own.status, 200, show(own));
    const toForeignBranch = await call("POST", `/api/templates/${tA.id}/assignments`, { cookie: cookie.a, body: { branchId: B.x } });
    assert.equal(toForeignBranch.status, 404, show(toForeignBranch));
    assert.deepEqual(toForeignBranch.body, BRANCH_NOT_FOUND);
    const foreignTemplate = await call("POST", `/api/templates/${tA.id}/assignments`, { cookie: cookie.b, body: { branchId: B.x } });
    assert.equal(foreignTemplate.status, 404, show(foreignTemplate));
    const viaList = await call("POST", "/api/template-assignments", { cookie: cookie.b, body: { templateId: tA.id, branchId: B.x } });
    assert.equal(viaList.status, 404, show(viaList));
    // B's branch listing and B's view of the assignments never show A's template.
    assert.deepEqual((await call("GET", `/api/templates?branchId=${A.x}`, { cookie: cookie.b })).body, []);
    const assignmentsB = (await call("GET", "/api/template-assignments", { cookie: cookie.b })).body as { templateId: string }[];
    assert.ok(!assignmentsB.some((a) => a.templateId === tA.id));
    // Removing it through another park group leaves it standing.
    assert.equal((await call("DELETE", `/api/templates/${tA.id}/assignments/${A.x}`, { cookie: cookie.b })).status, 204);
    assert.equal((await call("DELETE", `/api/template-assignments/${tA.id}/${A.x}`, { cookie: cookie.b })).status, 204);
    assert.equal(await count("select count(*) as n from template_assignments where template_id = $1 and branch_id = $2", [tA.id, A.x]), 1);
    assert.equal(await count("select count(*) as n from template_assignments a join templates t on t.id = a.template_id join branches b on b.id = a.branch_id where t.tenant_id <> b.tenant_id and t.id = any($1)", [[tA.id, tA2.id, tB.id]]), 0);
  });

  await check("edit, fork and delete keep to the park group; the last active template is each park group's own", async () => {
    assert.equal((await call("PATCH", `/api/templates/${tA.id}`, { cookie: cookie.b, body: { name: "ZZ hijack" } })).status, 404);
    assert.equal((await call("POST", `/api/templates/${tA.id}/fork`, { cookie: cookie.b, body: { branchId: B.x } })).status, 404);
    assert.equal((await call("DELETE", `/api/templates/${tA.id}`, { cookie: cookie.b })).status, 404);
    assert.equal(await count("select count(*) as n from templates where id = $1 and name = $2", [tA.id, `ZZ r6 A ${run}`]), 1);
    const fork = await call("POST", `/api/templates/${tA.id}/fork`, { cookie: cookie.a, body: { branchId: A.y } });
    assert.equal(fork.status, 201, show(fork));
    assert.equal(fork.body.tenantId, A.tenant);
    const forkToB = await call("POST", `/api/templates/${tA.id}/fork`, { cookie: cookie.a, body: { branchId: B.y } });
    assert.equal(forkToB.status, 404, show(forkToB));
    // A third park group with one active template: the app's rule refuses deleting it.
    const C = await parkGroup("c");
    const cCookie = await signIn(C.admin.email);
    const tC = await newTemplate(cCookie, `ZZ r6 C ${run}`);
    const last = await call("DELETE", `/api/templates/${tC.id}`, { cookie: cCookie });
    assert.equal(last.status, 400, show(last));
    assert.match(String(last.body.message), /Cannot delete the last active template/);
  });

  // ── 2. Policies ─────────────────────────────────────────────────────────────
  console.log("2. policies, each park group's own (the lift's 503 gone):");
  assert.equal(DOCUMENT_READ_RULES.policies, "own");
  const policyTitle = `ZZ r6 Rules ${run}`;
  const newPolicy = async (who: string) => {
    const made = await call("POST", "/api/policies", { cookie: who, body: { title: policyTitle, contentHtml: `<p>${who.length}</p>` } });
    assert.equal(made.status, 201, show(made));
    return made.body as { id: string; tenantId: string; versionInt: number };
  };
  const pA1 = await newPolicy(cookie.a);
  const pA2 = await newPolicy(cookie.a);
  const pB1 = await newPolicy(cookie.b);

  await check("a second park group writes, versions and publishes its own policies; no 503", async () => {
    assert.equal(pB1.tenantId, B.tenant);
    assert.equal(pA1.tenantId, A.tenant);
    assert.equal(pA2.versionInt, pA1.versionInt + 1);
    assert.equal(pB1.versionInt, 1, "B's first policy of this title is its version 1, whatever A holds");
    const published = await call("POST", `/api/policies/${pB1.id}/publish`, { cookie: cookie.b });
    assert.equal(published.status, 200, show(published));
    assert.equal((await call("POST", `/api/policies/${pA2.id}/publish`, { cookie: cookie.a })).status, 200);
    const latestB = await call("GET", "/api/policies/latest-published", { cookie: cookie.b });
    assert.equal(latestB.body?.id, pB1.id);
    const listB = (await call("GET", "/api/policies", { cookie: cookie.b })).body as { id: string }[];
    assert.ok(listB.some((p) => p.id === pB1.id) && !listB.some((p) => [pA1.id, pA2.id].includes(p.id)));
  });

  await check("another park group's policy is the app's 404 to read, edit, publish or archive", async () => {
    for (const [method, path] of [
      ["GET", `/api/policies/${pA1.id}`],
      ["PATCH", `/api/policies/${pA1.id}`],
      ["POST", `/api/policies/${pA1.id}/publish`],
      ["POST", `/api/policies/${pA1.id}/archive`],
    ] as const) {
      const answer = await call(method, path, { cookie: cookie.b, ...(method === "PATCH" ? { body: { title: "ZZ hijack" } } : {}) });
      assert.equal(answer.status, 404, `${method} ${path}: ${show(answer)}`);
      assert.deepEqual(answer.body, POLICY_NOT_FOUND);
    }
    assert.equal(await count("select count(*) as n from policy_documents where id = $1 and status = 'draft' and title = $2", [pA1.id, policyTitle]), 1);
    const onForeignBranch = await call("POST", "/api/policies", { cookie: cookie.b, body: { title: `ZZ ${run}`, isCompanyWide: false, branchId: A.x } });
    assert.equal(onForeignBranch.status, 403, `the app's own words for a branch it cannot reach: ${show(onForeignBranch)}`);
  });

  // ── 3. The asset catalogue ──────────────────────────────────────────────────
  console.log("3. the asset catalogue, each park group's own (the 503 gone):");
  assert.equal(DOCUMENT_READ_RULES.assetCatalog, "own");
  const eB = await employee(B.tenant, B.x, "b-assets");
  const eA = await employee(A.tenant, A.x, "a-assets");
  const itemA = (await call("POST", "/api/assets/catalog", { cookie: cookie.a, body: { name: `ZZ r6 laptop ${run}`, category: "technology" } })).body as { id: string; tenantId: string };
  const itemB = await call("POST", "/api/assets/catalog", { cookie: cookie.b, body: { name: `ZZ r6 radio ${run}`, category: "equipment" } });

  await check("a second park group lists and adds to its own catalogue, and assigns from it", async () => {
    assert.equal(itemB.status, 201, show(itemB));
    assert.equal(itemB.body.tenantId, B.tenant);
    assert.equal(itemA.tenantId, A.tenant);
    const listB = (await call("GET", "/api/assets/catalog", { cookie: cookie.b })).body as { id: string }[];
    assert.ok(listB.some((i) => i.id === itemB.body.id) && !listB.some((i) => i.id === itemA.id));
    const assigned = await call("POST", `/api/employees/${eB}/assets`, { cookie: cookie.b, body: { assetNameSnapshot: "ZZ radio", catalogAssetId: itemB.body.id } });
    assert.equal(assigned.status, 201, show(assigned));
  });

  await check("another park group's catalogue item is the app's 404, and nothing is assigned", async () => {
    const foreign = await call("POST", `/api/employees/${eB}/assets`, { cookie: cookie.b, body: { assetNameSnapshot: "ZZ laptop", catalogAssetId: itemA.id } });
    assert.equal(foreign.status, 404, show(foreign));
    assert.deepEqual(foreign.body, CATALOG_ITEM_NOT_FOUND);
    assert.equal(await count("select count(*) as n from employee_assets where catalog_asset_id = $1", [itemA.id]), 0);
    const ownA = await call("POST", `/api/employees/${eA}/assets`, { cookie: cookie.a, body: { assetNameSnapshot: "ZZ laptop", catalogAssetId: itemA.id } });
    assert.equal(ownA.status, 201, show(ownA));
  });

  // ── 4. Leave policies and the leave reads ──────────────────────────────────
  console.log("4. leave policies (Q31) and the leave reads (Q40):");
  assert.equal(DOCUMENT_READ_RULES.leavePolicies, "own-then-default");
  const inheritedName = `ZZ r6 default company-wide ${run}`;
  const inherited = randomUUID();
  // The default park group's company-wide policy, the latest effective one there.
  await q(
    `insert into leave_policies (id, tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active)
     values ($1, $2, null, $3, 3, 1, now() + interval '1 day', true)`,
    [inherited, DEFAULT, inheritedName],
  );

  await check("a park group with no policy of its own is worked out by the default park group's company-wide one (Q28's rule)", async () => {
    const eBLeave = await employee(B.tenant, B.x, "b-leave");
    const balance = await call("GET", `/api/employees/${eBLeave}/leave-balance`, { cookie: cookie.b });
    assert.equal(balance.status, 200, show(balance));
    assert.equal(balance.body.policyName, inheritedName);
    // Its list holds only what it can change: its own, none yet.
    assert.deepEqual((await call("GET", "/api/leave-policies", { cookie: cookie.b })).body, []);
    // Its own company-wide policy takes over, and the default park group's stays as it was.
    const own = await call("POST", "/api/leave-policies", { cookie: cookie.b, body: { name: `ZZ r6 B leave ${run}`, daysWorkedRequired: 6, daysOffEarned: 1 } });
    assert.equal(own.status, 201, show(own));
    assert.equal(own.body.tenantId, B.tenant);
    const after = await call("GET", `/api/employees/${eBLeave}/leave-balance`, { cookie: cookie.b });
    assert.equal(after.body.policyName, `ZZ r6 B leave ${run}`);
    assert.equal(await count("select count(*) as n from leave_policies where id = $1 and name = $2 and tenant_id = $3", [inherited, inheritedName, DEFAULT]), 1);
  });

  await check("leave policies: another park group's branch or policy is a 404 in words; lists keep to the park group", async () => {
    const onForeign = await call("POST", "/api/leave-policies", { cookie: cookie.b, body: { name: "ZZ x", daysWorkedRequired: 5, daysOffEarned: 2, branchId: A.x } });
    assert.equal(onForeign.status, 404, show(onForeign));
    assert.deepEqual(onForeign.body, BRANCH_NOT_FOUND);
    const aPolicy = await call("POST", "/api/leave-policies", { cookie: cookie.a, body: { name: `ZZ r6 A leave ${run}`, daysWorkedRequired: 5, daysOffEarned: 2, branchId: A.x } });
    assert.equal(aPolicy.status, 201, show(aPolicy));
    for (const [method, body] of [["PATCH", { name: "ZZ hijack" }], ["DELETE", undefined]] as const) {
      const answer = await call(method, `/api/leave-policies/${aPolicy.body.id}`, { cookie: cookie.b, ...(body ? { body } : {}) });
      assert.equal(answer.status, 404, `${method}: ${show(answer)}`);
      assert.deepEqual(answer.body, LEAVE_POLICY_NOT_FOUND);
    }
    const moved = await call("PATCH", `/api/leave-policies/${aPolicy.body.id}`, { cookie: cookie.a, body: { branchId: B.x } });
    assert.equal(moved.status, 404, show(moved));
    assert.equal(await count("select count(*) as n from leave_policies where id = $1 and name = $2 and branch_id = $3", [aPolicy.body.id, `ZZ r6 A leave ${run}`, A.x]), 1);
    const byForeignBranch = await call("GET", `/api/leave-policies?branchId=${A.x}`, { cookie: cookie.b });
    assert.equal(byForeignBranch.status, 404, show(byForeignBranch));
    const listA = (await call("GET", "/api/leave-policies", { cookie: cookie.a })).body as { id: string }[];
    assert.ok(listA.some((p) => p.id === aPolicy.body.id) && !listA.some((p) => p.id === inherited));
  });

  await check("the leave reads' remaining crossings (Q40): balances and holidays keep to the park group", async () => {
    const eALeave = await employee(A.tenant, A.x, "a-leave");
    assert.equal((await call("GET", `/api/leave-balances?branchId=${A.x}`, { cookie: cookie.b })).status, 404);
    assert.equal((await call("GET", `/api/leave-balances/employee/${eALeave}`, { cookie: cookie.b })).status, 404);
    assert.equal((await call("GET", `/api/sick-leave-balances?branchId=${A.x}`, { cookie: cookie.b })).status, 404);
    assert.equal((await call("GET", `/api/employees/${eALeave}/sick-leave-balance`, { cookie: cookie.b })).status, 404);
    assert.equal((await call("GET", `/api/leave-balances?branchId=${A.x}`, { cookie: cookie.a })).status, 200);
    assert.equal((await call("GET", `/api/employees/${eALeave}/sick-leave-balance`, { cookie: cookie.a })).status, 200);
    const holiday = await call("POST", "/api/public-holidays", { cookie: cookie.a, body: { name: `ZZ r6 ${run}`, date: day(40) } });
    assert.equal(holiday.status, 201, show(holiday));
    for (const [method, body] of [["PATCH", { name: "ZZ hijack" }], ["DELETE", undefined]] as const) {
      const answer = await call(method, `/api/public-holidays/${holiday.body.id}`, { cookie: cookie.b, ...(body ? { body } : {}) });
      assert.equal(answer.status, 404, `${method}: ${show(answer)}`);
      assert.deepEqual(answer.body, PUBLIC_HOLIDAY_NOT_FOUND);
    }
    assert.equal(await count("select count(*) as n from public_holidays where id = $1 and name = $2", [holiday.body.id, `ZZ r6 ${run}`]), 1);
    assert.equal((await call("PATCH", `/api/public-holidays/${holiday.body.id}`, { cookie: cookie.a, body: { name: `ZZ r6 b ${run}` } })).status, 200);
  });

  await check("round 6's review, F3: the branch-wide leave balances take another park group's branch as the app's 404, and answer the park group's own", async () => {
    const eAll = await employee(A.tenant, A.x, "a-all-leave");
    const foreign = await call("GET", `/api/all-leave-balances?branchId=${A.x}`, { cookie: cookie.b });
    assert.equal(foreign.status, 404, show(foreign));
    assert.deepEqual(foreign.body, BRANCH_NOT_FOUND);
    const own = await call("GET", `/api/all-leave-balances?branchId=${A.x}`, { cookie: cookie.a });
    assert.equal(own.status, 200, show(own));
    assert.ok((own.body as { employeeId: string }[]).some((r) => r.employeeId === eAll));
    // The app's list never kept to the branch it names (its rule, kept: A's branch Y lists X's people too),
    // but it keeps to the park group: B's own branch lists none of A's people.
    const ownY = await call("GET", `/api/all-leave-balances?branchId=${A.y}`, { cookie: cookie.a });
    assert.ok((ownY.body as { employeeId: string }[]).some((r) => r.employeeId === eAll));
    const bOwn = await call("GET", `/api/all-leave-balances?branchId=${B.x}`, { cookie: cookie.b });
    assert.equal(bOwn.status, 200, show(bOwn));
    const bIds = (bOwn.body as { employeeId: string }[]).map((r) => r.employeeId);
    assert.ok(!bIds.includes(eAll));
    assert.deepEqual(
      new Set(bIds),
      new Set((await q<{ id: string }>("select id from employees where tenant_id = $1", [B.tenant])).map((r) => r.id)),
      "B's list is exactly B's people",
    );
  });

  await check("round 6's review, F4: a balance weighs the branch's own policies and the company-wide slot — the default park group's while the park group has none of its own — newest effective first", async () => {
    // A has a policy on branch X (made above, effective now) and no company-wide policy of its
    // own: the default park group's (effective tomorrow) is weighed beside it, and is the newer.
    const onX = await employee(A.tenant, A.x, "a-leave-x");
    const onY = await employee(A.tenant, A.y, "a-leave-y");
    const policyOf = async (id: string) => (await call("GET", `/api/employees/${id}/leave-balance`, { cookie: cookie.a })).body.policyName as string;
    assert.equal(await policyOf(onX), inheritedName, "before 0008 the newer company-wide policy won over the branch's own");
    assert.equal(await policyOf(onY), inheritedName);
    // A branch policy newer than the default's wins, as before 0008.
    const newest = `ZZ r6 A newest ${run}`;
    await q(
      `insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active)
       values ($1, $2, $3, 4, 1, now() + interval '2 days', true)`,
      [A.tenant, A.x, newest],
    );
    assert.equal(await policyOf(onX), newest);
    assert.equal(await policyOf(onY), inheritedName);
    // A company-wide policy of its own takes the default's place in the weighing, though it is older.
    const ownWide = `ZZ r6 A company-wide ${run}`;
    await q(
      `insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active)
       values ($1, null, $2, 5, 2, now() - interval '10 days', true)`,
      [A.tenant, ownWide],
    );
    assert.equal(await policyOf(onY), ownWide);
    assert.equal(await policyOf(onX), newest);
  });

  await check("recalculate-probation reaches only the caller's own park group (Q31)", async () => {
    const start = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const eAProb = await employee(A.tenant, A.x, "a-prob", { start_date: start });
    const eBProb = await employee(B.tenant, B.x, "b-prob", { start_date: start });
    const answer = await call("POST", "/api/employees/recalculate-probation", { cookie: cookie.b });
    assert.equal(answer.status, 200, show(answer));
    const ends = await q<{ id: string; probation_end_date: Date | null }>("select id, probation_end_date from employees where id = any($1)", [[eAProb, eBProb]]);
    const end = Object.fromEntries(ends.map((r) => [r.id, r.probation_end_date]));
    assert.ok(end[eBProb], "B's own employee is recalculated");
    assert.equal(end[eAProb], null, "A's is left as it was");
  });

  // ── 5. Contracts and letters ────────────────────────────────────────────────
  console.log("5. contracts and letters, each park group's own:");
  const eAc = await employee(A.tenant, A.x, "a-contract");
  const eBc = await employee(B.tenant, B.x, "b-contract");
  const merge = { positionTitle: "ZZ Host", salaryThb: 15000, startDate: day(1) };
  const contractA = await call("POST", "/api/contracts/finalize", { cookie: cookie.a, body: { employeeId: eAc, templateId: tA.id, mergeDataJson: merge, generateSigningLink: true } });
  const contractB = await call("POST", "/api/contracts/finalize", { cookie: cookie.b, body: { employeeId: eBc, templateId: tB.id, mergeDataJson: merge, generateSigningLink: true } });

  await check("a second park group finalizes its own contract, acknowledging its own policy (no 503)", async () => {
    assert.equal(contractA.status, 201, show(contractA));
    assert.equal(contractB.status, 201, show(contractB));
    assert.equal(contractB.body.policyDocumentId, pB1.id);
    assert.equal(contractA.body.policyDocumentId, pA2.id);
  });

  await check("another park group's contract is the app's 404 at every door, and nothing changes", async () => {
    const id = contractA.body.id;
    for (const [method, path, body] of [
      ["GET", `/api/contracts/${id}`, undefined],
      ["DELETE", `/api/contracts/${id}`, undefined],
      ["PATCH", `/api/contracts/${id}/archive`, undefined],
      ["POST", `/api/contracts/${id}/finalize`, undefined],
      ["POST", `/api/contracts/${id}/send`, { to: "zz@example.com", subject: "x", body: "x" }],
      ["POST", `/api/contracts/${id}/generate-signing-link`, undefined],
    ] as const) {
      const answer = await call(method, path, { cookie: cookie.b, ...(body ? { body } : {}) });
      assert.equal(answer.status, 404, `${method} ${path}: ${show(answer)}`);
      assert.equal(answer.body.message, "Contract not found");
    }
    const row = (await q<{ status: string; signing_token: string }>("select status, signing_token from contract_instances where id = $1", [id]))[0]!;
    assert.equal(row.status, "finalized");
    assert.equal(row.signing_token, contractA.body.signingToken);
    const listB = (await call("GET", "/api/contracts", { cookie: cookie.b })).body as { id: string }[];
    assert.ok(listB.some((c) => c.id === contractB.body.id) && !listB.some((c) => c.id === id));
    assert.deepEqual((await call("GET", `/api/employees/${eAc}/contracts`, { cookie: cookie.b })).body, []);
    assert.equal((await call("GET", `/api/employees/${eAc}/active-contract`, { cookie: cookie.b })).body, null);
  });

  await check("making a contract: another park group's employee or template is the app's 404, and nothing is written", async () => {
    const before = await count("select count(*) as n from contract_instances where employee_id = any($1)", [[eAc, eBc]]);
    for (const path of ["/api/contracts/preview", "/api/contracts", "/api/contracts/generate", "/api/contracts/finalize"]) {
      const foreignEmployee = await call("POST", path, { cookie: cookie.b, body: { employeeId: eAc, templateId: tB.id, mergeDataJson: merge, ...merge } });
      assert.equal(foreignEmployee.status, 404, `${path} with A's employee: ${show(foreignEmployee)}`);
      assert.equal(foreignEmployee.body.message, "Employee not found");
      const foreignTemplate = await call("POST", path, { cookie: cookie.b, body: { employeeId: eBc, templateId: tA.id, mergeDataJson: merge, ...merge } });
      assert.equal(foreignTemplate.status, 404, `${path} with A's template: ${show(foreignTemplate)}`);
      assert.equal(foreignTemplate.body.message, "Template not found");
    }
    assert.equal(await count("select count(*) as n from contract_instances where employee_id = any($1)", [[eAc, eBc]]), before);
  });

  await check("the wizard's employee edits are the six personal fields its own client sends (round 6's review, F2): no park group, branch, login, person, department or status rides in", async () => {
    assert.deepEqual([...WIZARD_EMPLOYEE_FIELDS], ["fullName", "nickname", "email", "phone", "address", "nationalId"]);
    const eBw = await employee(B.tenant, B.x, "b-wizard");
    const aLogin = await user(A.tenant, "staff", `zz-r6-wizard-a-login-${run}@example.com`, A.x);
    const department = (await q<{ id: string }>("insert into departments (tenant_id, name) values ($1, $2) returning id", [A.tenant, `ZZ r6 wizard ${run}`]))[0]!.id;
    const personal = {
      fullName: `ZZ TEST ${run} wizard`,
      nickname: "ZZ moved",
      email: `zz-r6-wizard-${run}@example.com`,
      phone: "0812345678",
      address: "ZZ TEST road",
      nationalId: "1234567890123",
    };
    const generated = await call("POST", "/api/contracts/generate", {
      cookie: cookie.b,
      body: {
        employeeId: eBw,
        templateId: tB.id,
        mergeDataJson: merge,
        employeeUpdates: { ...personal, tenantId: A.tenant, branchId: A.x, userId: aLogin, primaryDepartmentId: department, status: "terminated", employmentState: "LEFT" },
      },
    });
    assert.equal(generated.status, 201, show(generated));
    const row = (await q("select tenant_id, branch_id, user_id, primary_department_id, status, employment_state, full_name, nickname, email, phone, address from employees where id = $1", [eBw]))[0];
    assert.deepEqual(row, {
      tenant_id: B.tenant,
      branch_id: B.x,
      user_id: null,
      primary_department_id: null,
      status: "active",
      employment_state: "ACTIVE",
      full_name: personal.fullName,
      nickname: personal.nickname,
      email: personal.email,
      phone: personal.phone,
      address: personal.address,
    });
    // Even a branch of its own park group is not the wizard's to change: the app's wizard sends none.
    const ownBranch = await call("POST", "/api/contracts/generate", { cookie: cookie.b, body: { employeeId: eBw, templateId: tB.id, mergeDataJson: merge, employeeUpdates: { branchId: B.y } } });
    assert.equal(ownBranch.status, 201, show(ownBranch));
    assert.equal((await q<{ branch_id: string }>("select branch_id from employees where id = $1", [eBw]))[0]!.branch_id, B.x);
  });

  const warningA = await newTemplate(cookie.a, `ZZ r6 warning A ${run}`, "warning");
  const letterA = await call("POST", `/api/employees/${eAc}/letters`, { cookie: cookie.a, body: { letterType: "warning", templateId: warningA.id } });

  await check("letters: another park group's letter, employee or template is the app's 404; counts keep to the park group", async () => {
    assert.equal(letterA.status, 201, show(letterA));
    const read = await call("GET", `/api/letters/${letterA.body.id}`, { cookie: cookie.b });
    assert.equal(read.status, 404, show(read));
    assert.deepEqual(read.body, LETTER_NOT_FOUND);
    assert.deepEqual((await call("GET", `/api/employees/${eAc}/letters`, { cookie: cookie.b })).body, []);
    assert.equal((await call("POST", `/api/employees/${eAc}/letters`, { cookie: cookie.b, body: { letterType: "warning" } })).status, 404);
    assert.equal((await call("POST", `/api/employees/${eAc}/warnings`, { cookie: cookie.b, body: { reasonCode: "x", severity: "x", incidentDate: day(0), description: "x" } })).status, 404);
    const foreignTemplate = await call("POST", `/api/employees/${eBc}/letters`, { cookie: cookie.b, body: { letterType: "warning", templateId: warningA.id } });
    assert.equal(foreignTemplate.status, 404, show(foreignTemplate));
    assert.deepEqual(foreignTemplate.body, TEMPLATE_NOT_FOUND);
    assert.equal(await count("select count(*) as n from employee_letters where employee_id = $1", [eBc]), 0);
    const countA = (await call("GET", "/api/letters/unsigned/count", { cookie: cookie.a })).body.count as number;
    const countB = (await call("GET", "/api/letters/unsigned/count", { cookie: cookie.b })).body.count as number;
    assert.equal(countA, await count("select count(*) as n from employee_letters l join employees e on e.id = l.employee_id where l.status = 'signing_link_created' and e.tenant_id = $1", [A.tenant]));
    assert.equal(countB, 0);
  });

  await check("FINDING Q50: the app has no branch rule on a letter's creation — a manager limited to branch X writes one for branch Y's employee", async () => {
    const eAy = await employee(A.tenant, A.y, "a-y-letter");
    const made = await call("POST", `/api/employees/${eAy}/letters`, { cookie: cookie.aLimited, body: { letterType: "warning" } });
    assert.equal(made.status, 201, `the app's behaviour, kept (Q50): ${show(made)}`);
    const contract = await call("POST", "/api/contracts", { cookie: cookie.aLimited, body: { employeeId: eAy, templateId: tA.id, mergeDataJson: merge } });
    assert.equal(contract.status, 403, `where the app has a branch rule it stands: ${show(contract)}`);
  });

  // ── 6. Offboarding (H16) ────────────────────────────────────────────────────
  console.log("6. offboarding in one transaction (H16):");
  const rota = async (branch: string) => {
    const plan = randomUUID();
    await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [plan, A.tenant, branch, day(0)]);
    const group = randomUUID();
    await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [group, A.tenant, branch, `ZZ TEST r6 ${run}`]);
    const row = randomUUID();
    await q(
      `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time, label)
       values ($1, $2, $3, $4, $5, '09:00', '17:00', 'ZZ TEST')`,
      [row, A.tenant, branch, group, plan],
    );
    return { plan, row };
  };
  const shifts = await rota(A.x);
  /** An employee with a linked login, a shift after the leaving date and an asset to return. */
  const leaver = async (label: string) => {
    const login = await user(A.tenant, "staff", `zz-r6-${label}-${run}@example.com`, A.x);
    const id = await employee(A.tenant, A.x, label, { user_id: login, employment_state: "ACTIVE" });
    await q(
      `insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, employee_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), A.tenant, shifts.plan, shifts.row, day(3), id],
    );
    const asset = randomUUID();
    await q(
      `insert into employee_assets (id, employee_id, branch_id, asset_name_snapshot, quantity, assigned_by, return_required)
       values ($1, $2, $3, 'ZZ keys', 1, $4, true)`,
      [asset, id, A.x, A.admin.id],
    );
    return { id, login, asset };
  };
  /** Everything an offboarding writes, for one employee. */
  const footprint = async (p: { id: string; login: string; asset: string }) => ({
    offboardings: await count("select count(*) as n from employee_offboarding where employee_id = $1", [p.id]),
    checklist: await count("select count(*) as n from offboarding_checklist where employee_id = $1", [p.id]),
    changes: await count("select count(*) as n from employee_changes where employee_id = $1", [p.id]),
    activity: await count("select count(*) as n from activity_log where employee_id = $1", [p.id]),
    attention: await count("select count(*) as n from attention_items where employee_id = $1", [p.id]),
    employee: (await q("select status, employment_state, end_reason, last_working_day from employees where id = $1", [p.id]))[0],
    loginActive: (await q<{ is_active: boolean }>("select is_active from users where id = $1", [p.login]))[0]!.is_active,
    assetDue: (await q<{ expected_return_by: Date | null }>("select expected_return_by from employee_assets where id = $1", [p.asset]))[0]!.expected_return_by,
  });
  const offboard = (id: string, lastWorkingDay: string) =>
    call("POST", `/api/employees/${id}/offboarding`, {
      cookie: cookie.a,
      body: { offboardingType: "termination", reasonCode: "misconduct", lastWorkingDay },
    });
  const injectAt = async (table: string, when: string) => {
    await q(`create or replace function ${INJECT}() returns trigger language plpgsql as $$
             begin raise exception 'zz injected failure (round 6, H16)'; end $$`);
    await q(`create trigger ${INJECT} before insert on ${table} for each row when (${when}) execute function ${INJECT}()`);
  };
  const removeInjection = async (table: string) => {
    await q(`drop trigger if exists ${INJECT} on ${table}`);
  };

  for (const [where, table, when] of [
    ["in the middle (the change record, after the login, the alert and the asset dates)", "employee_changes", "true"],
    ["at the very end (the sixth checklist item)", "offboarding_checklist", "new.sort_order = 6"],
  ] as const) {
    await check(`H16: a failure injected ${where} leaves nothing behind`, async () => {
      const p = await leaver(`h16-${table}`);
      const before = await footprint(p);
      await injectAt(table, when);
      try {
        const failed = await offboard(p.id, day(-2));
        assert.equal(failed.status, 500, show(failed));
      } finally {
        await removeInjection(table);
      }
      assert.deepEqual(await footprint(p), before, "not one of the app's steps survived the failure");
      assert.equal(before.loginActive, true);
      // And the same request, nothing failing, does all of it.
      const done = await offboard(p.id, day(-2));
      assert.equal(done.status, 201, show(done));
      const after = await footprint(p);
      assert.equal(after.offboardings, 1);
      assert.equal(after.checklist, 6);
      assert.equal(after.changes, 1);
      assert.equal(after.activity, 2);
      assert.equal(after.attention, 1, "one coverage alert for the shift after the leaving date");
      assert.equal((after.employee as { status: string }).status, "terminated");
      assert.equal((after.employee as { employment_state: string }).employment_state, "LEFT");
      assert.equal(after.loginActive, false, "a last working day already passed switches the linked login off, as the app does");
      assert.ok(after.assetDue, "the asset's return date is set");
    });
  }

  await check("H16: a failure in an update of the last working day leaves the offboarding as it was", async () => {
    const p = await leaver("h16-update");
    assert.equal((await offboard(p.id, day(20))).status, 201);
    const before = await footprint(p);
    await injectAt("activity_log", `new.activity_type = 'offboarding_updated' and new.employee_id = '${p.id}'`);
    try {
      const failed = await call("PATCH", `/api/employees/${p.id}/offboarding`, { cookie: cookie.a, body: { lastWorkingDay: day(25) } });
      assert.equal(failed.status, 500, show(failed));
    } finally {
      await removeInjection("activity_log");
    }
    assert.deepEqual(await footprint(p), before);
    assert.equal(await count("select count(*) as n from employee_offboarding where employee_id = $1 and last_working_day::date = $2::date", [p.id, day(20)]), 1);
    const ok = await call("PATCH", `/api/employees/${p.id}/offboarding`, { cookie: cookie.a, body: { lastWorkingDay: day(25) } });
    assert.equal(ok.status, 200, show(ok));
  });

  await check("the linked login as the app does it: a leaving date still to come leaves it on (the 03:00 batch's work), and a second offboarding is the lift's 409", async () => {
    const p = await leaver("h16-future");
    const done = await offboard(p.id, day(10));
    assert.equal(done.status, 201, show(done));
    const after = await footprint(p);
    assert.equal((after.employee as { employment_state: string }).employment_state, "LEAVING");
    assert.equal(after.loginActive, true);
    const again = await offboard(p.id, day(11));
    assert.equal(again.status, 409, show(again));
    assert.equal((await footprint(p)).offboardings, 1);
  });

  await check("round 6's review, F2's backstop: the offboarding switches off only a login the strict placement puts in the employee's park group", async () => {
    // A link standing from before the fix (written here in the database): B's employee, A's person's login.
    const aLogin = await user(A.tenant, "staff", `zz-r6-backstop-a-${run}@example.com`, A.x);
    const crossed = await employee(B.tenant, B.x, "b-backstop", { user_id: aLogin });
    const offB = await call("POST", `/api/employees/${crossed}/offboarding`, {
      cookie: cookie.b,
      body: { offboardingType: "termination", reasonCode: "misconduct", lastWorkingDay: day(-2) },
    });
    assert.equal(offB.status, 201, show(offB));
    assert.equal((await q<{ employment_state: string }>("select employment_state from employees where id = $1", [crossed]))[0]!.employment_state, "LEFT");
    assert.equal((await q<{ is_active: boolean }>("select is_active from users where id = $1", [aLogin]))[0]!.is_active, true, "A's person's login stays on");
    // The park group's own login is switched off, as the app does (the H16 checks above too).
    const own = await leaver("backstop-own");
    assert.equal((await offboard(own.id, day(-2))).status, 201);
    assert.equal((await footprint(own)).loginActive, false);
  });

  await check("the database's backstop (0008, the census clean): a second offboarding row for one employee is refused", async () => {
    const index = await count(
      "select count(*) as n from pg_indexes where schemaname = 'otoapp' and indexname = 'employee_offboarding_employee_unique'",
    );
    assert.equal(index, 1);
    const p = await leaver("h16-backstop");
    assert.equal((await offboard(p.id, day(5))).status, 201);
    await assert.rejects(
      q(
        `insert into employee_offboarding (employee_id, offboarding_type, reason_code, last_working_day, created_by)
         values ($1, 'resignation', 'other', now(), $2)`,
        [p.id, A.admin.id],
      ),
      /employee_offboarding_employee_unique/,
    );
  });

  await check("the readable reason: a code reads as the form's words, free text as it was written", async () => {
    assert.equal(offboardingReasonLabel("personal_reasons"), "Personal reasons");
    assert.equal(offboardingReasonLabel("health_issues"), "Health reasons");
    assert.equal(offboardingReasonLabel("Moved to Chiang Mai"), "Moved to Chiang Mai");
    assert.equal(offboardingReasonLabel(null), null);
  });

  // ── 7. The PDF and storage gate (ticket check 2) ───────────────────────────
  console.log("7. the PDF and storage gate (ticket check 2):");
  /** A signed URL from the app: the stand-in bucket's host, signed, short-lived. */
  const assertSignedUrl = async (answer: Answer, what: string) => {
    assert.equal(answer.status, 302, `${what}: ${show(answer)}`);
    const url = new URL(answer.location ?? "");
    assert.equal(url.host, `127.0.0.1:${BUCKET_PORT}`, what);
    assert.ok(url.pathname.startsWith(`/${BUCKET}/zz-test/`), `${what}: ${url.pathname}`);
    assert.ok(url.searchParams.get("X-Amz-Signature"), `${what} is signed`);
    const expires = Number(url.searchParams.get("X-Amz-Expires"));
    assert.ok(expires > 0 && expires <= 300, `${what} lives ${expires}s`);
    const pdf = await fetch(url);
    assert.equal(pdf.status, 200, what);
    assert.equal((await pdf.arrayBuffer().then((b) => Buffer.from(b))).subarray(0, 5).toString("latin1"), "%PDF-", `${what} is a PDF`);
    // The bucket itself: the same object without the signature is refused.
    const bare = await fetch(`http://127.0.0.1:${BUCKET_PORT}${url.pathname}`);
    assert.equal(bare.status, 403, `${what}: the bucket answers no unsigned read`);
    return url.pathname;
  };

  const signed = await call("POST", `/api/signing/${contractA.body.signingToken}/sign`, {
    body: { signatureImage: SIGNATURE, agreedToTerms: true, agreedToPolicy: true },
  });

  await check("a contract signed: its PDF opens only from a short-lived signed URL, after the check on its employee", async () => {
    assert.equal(signed.status, 200, show(signed));
    const row = (await q<{ signed_pdf_path: string; signing_status: string }>("select signed_pdf_path, signing_status from contract_instances where id = $1", [contractA.body.id]))[0]!;
    assert.equal(row.signing_status, "signed");
    assert.ok(row.signed_pdf_path.startsWith(`/${BUCKET}/zz-test/contracts/`), row.signed_pdf_path);
    for (const path of [`/api/contracts/${contractA.body.id}/signed-pdf`, `/api/contracts/${contractA.body.id}/download-signed-pdf-auth`]) {
      await assertSignedUrl(await call("GET", path, { cookie: cookie.a }), path);
    }
    // The signer's own download link (the app's 24-hour token) ends at the same gate.
    await assertSignedUrl(await call("GET", `/api/contracts/${contractA.body.id}/download-signed-pdf?token=${encodeURIComponent(signed.body.downloadToken)}`), "the signer's link");
  });

  await check("an unauthorised read of the contract PDF is refused, and no URL is handed out", async () => {
    const eAy = await employee(A.tenant, A.y, "a-y-contract");
    const yContract = await call("POST", "/api/contracts/finalize", { cookie: cookie.a, body: { employeeId: eAy, templateId: tA.id, mergeDataJson: merge, generateSigningLink: true } });
    assert.equal(yContract.status, 201, show(yContract));
    const ySigned = await call("POST", `/api/signing/${yContract.body.signingToken}/sign`, { body: { signatureImage: SIGNATURE, agreedToTerms: true, agreedToPolicy: true } });
    assert.equal(ySigned.status, 200, show(ySigned));
    for (const path of [`/api/contracts/${contractA.body.id}/signed-pdf`, `/api/contracts/${contractA.body.id}/download-signed-pdf-auth`, `/api/contracts/${contractA.body.id}/pdf`]) {
      const signedOut = await call("GET", path);
      assert.equal(signedOut.status, 401, `${path} signed out: ${show(signedOut)}`);
      const otherParkGroup = await call("GET", path, { cookie: cookie.b });
      assert.ok([403, 404].includes(otherParkGroup.status), `${path} for another park group: ${show(otherParkGroup)}`);
      assert.equal(otherParkGroup.location, null);
    }
    const otherBranch = await call("GET", `/api/contracts/${yContract.body.id}/signed-pdf`, { cookie: cookie.aLimited });
    assert.equal(otherBranch.status, 403, `a manager of branch X, branch Y's contract: ${show(otherBranch)}`);
    const forged = await call("GET", `/api/contracts/${contractA.body.id}/download-signed-pdf?token=${encodeURIComponent(`${contractA.body.id}:${Date.now() + 60_000}:${"0".repeat(64)}`)}`);
    assert.equal(forged.status, 401, `a forged download token: ${show(forged)}`);
    assert.equal(forged.location, null);
  });

  await check("a letter signed: its PDF opens only from a short-lived signed URL; an unauthorised read is refused", async () => {
    const token = (await q<{ signing_token: string }>("select signing_token from employee_letters where id = $1", [letterA.body.id]))[0]!.signing_token;
    const signedLetter = await call("POST", `/api/letter-sign/${token}`, { body: { signatureImage: SIGNATURE, signedName: "ZZ Signer" } });
    assert.equal(signedLetter.status, 200, show(signedLetter));
    assert.ok(String(signedLetter.body.signedPdfPath).startsWith(`/${BUCKET}/zz-test/letters/`), signedLetter.body.signedPdfPath);
    const path = `/api/employees/${eAc}/letters/${letterA.body.id}/download`;
    await assertSignedUrl(await call("GET", path, { cookie: cookie.a }), "the signed letter");
    assert.equal((await call("GET", path)).status, 401);
    const otherParkGroup = await call("GET", path, { cookie: cookie.b });
    assert.equal(otherParkGroup.status, 404, show(otherParkGroup));
    assert.equal(otherParkGroup.location, null);
  });

  await check("a BEO generated: it opens only from a short-lived signed URL; another park group's or a signed-out read is refused", async () => {
    const event = randomUUID();
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time)
       values ($1, $2, $3, 'birthday', $4, $5, '10:00')`,
      [event, A.tenant, A.x, `ZZ r6 party ${run}`, day(14)],
    );
    const beo = await call("GET", `/api/events/${event}/beo/pdf`, { cookie: cookie.a });
    const where = await assertSignedUrl(beo, "the BEO");
    assert.ok(where.includes("/beo-pdfs/"), where);
    assert.equal((await call("GET", `/api/events/${event}/beo/pdf`)).status, 401);
    const otherParkGroup = await call("GET", `/api/events/${event}/beo/pdf`, { cookie: cookie.b });
    assert.equal(otherParkGroup.status, 404, show(otherParkGroup));
    assert.equal(otherParkGroup.location, null);
  });

  await check("every URL the app handed out (each one followed above) was presigned for at most five minutes", async () => {
    const handedOut = bucketLog.filter((r) => r.presigned);
    assert.ok(handedOut.length >= 5, String(handedOut.length));
    for (const r of handedOut) assert.ok(Number(r.expires) <= 300, `${r.path} ${r.expires}`);
  });

  // ── 8. The org chart, counted first ────────────────────────────────────────
  console.log("8. the org chart, counted first:");
  const O = await parkGroup("o");
  const oCookie = await signIn(O.admin.email);
  const oLimited = await signIn(O.limited.email);
  const people = await Promise.all([1, 2, 3].map((n) => employee(O.tenant, n === 3 ? O.y : O.x, `org-${n}`)));
  const nodes = () => count("select count(*) as n from org_nodes where tenant_id = $1 and mode = 'live' and scope_type = 'company' and is_deleted = false", [O.tenant]);
  const missing = () =>
    count(
      `select count(*) as n from employees e where e.tenant_id = $1 and e.status = 'active'
          and not exists (select 1 from org_nodes n where n.person_employee_id = e.id and n.tenant_id = $1
                            and n.mode = 'live' and n.scope_type = 'company' and n.is_deleted = false)`,
      [O.tenant],
    );

  await check("a reader the app does not let write (a branch-limited manager) reads without writing", async () => {
    const before = await nodes();
    assert.equal(before, 0);
    assert.equal(await missing(), people.length);
    const read = await call("GET", "/api/org-chart/nodes?mode=live&scopeType=company", { cookie: oLimited });
    assert.equal(read.status, 200, show(read));
    assert.equal(await nodes(), before);
  });

  await check("an all-branch admin's GET writes exactly the missing person nodes, once; a second GET writes nothing", async () => {
    const before = await nodes();
    const toWrite = await missing();
    const first = await call("GET", "/api/org-chart/nodes?mode=live&scopeType=company", { cookie: oCookie });
    assert.equal(first.status, 200, show(first));
    assert.equal(await nodes(), before + toWrite, "the GET wrote one node per missing active employee (the plan's known effect)");
    assert.equal(await missing(), 0);
    const second = await call("GET", "/api/org-chart/nodes?mode=live&scopeType=company", { cookie: oCookie });
    assert.equal(second.status, 200);
    assert.equal(await nodes(), before + toWrite);
    // Another park group's GET writes nothing here.
    const elsewhere = await count("select count(*) as n from org_nodes where tenant_id = $1", [O.tenant]);
    assert.equal((await call("GET", "/api/org-chart/nodes?mode=live&scopeType=company", { cookie: cookie.b })).status, 200);
    assert.equal(await count("select count(*) as n from org_nodes where tenant_id = $1", [O.tenant]), elsewhere);
  });

  await check("FINDING Q52: two GETs at once both write the same missing nodes (no lock, no unique — the app's own race, kept)", async () => {
    const extra = await Promise.all([4, 5, 6].map((n) => employee(O.tenant, O.x, `org-${n}`)));
    const toWrite = await missing();
    assert.equal(toWrite, extra.length);
    const before = await nodes();
    // The instant between one GET's read of the chart and its insert, held
    // open: the insert waits half a second before it lands, as a slow database
    // would, while the other GET reads the same chart without it.
    await q(`create or replace function ${INJECT}_slow() returns trigger language plpgsql as $$
             begin perform pg_sleep(0.5); return null; end $$`);
    await q(`create trigger ${INJECT}_slow before insert on org_nodes for each statement execute function ${INJECT}_slow()`);
    let answers: Answer[];
    try {
      answers = await Promise.all([1, 2].map(() => call("GET", "/api/org-chart/nodes?mode=live&scopeType=company", { cookie: oCookie })));
    } finally {
      await q(`drop trigger if exists ${INJECT}_slow on org_nodes`);
      await q(`drop function if exists ${INJECT}_slow()`);
    }
    for (const a of answers) assert.equal(a.status, 200, show(a));
    const written = (await nodes()) - before;
    const doubled = await count(
      `select count(*) as n from (select person_employee_id from org_nodes where tenant_id = $1 and mode = 'live'
          and scope_type = 'company' and is_deleted = false and person_employee_id = any($2)
          group by person_employee_id having count(*) > 1) d`,
      [O.tenant, extra],
    );
    console.log(`      FINDING Q52: two GETs at once wrote ${written} node(s) for ${toWrite} missing employee(s); ${doubled} of them are now on the chart twice`);
    assert.equal(written, 2 * toWrite, "each GET wrote every missing node");
    assert.equal(doubled, toWrite, "every one of them twice — the app's own race (Q52)");
  });

  // ── 9. The HR employee doors (round 6's review, F1) ────────────────────────
  console.log("9. the HR employee doors, each park group's own (round 6's review):");
  const hrLogin = await user(A.tenant, "staff", `zz-r6-hr-login-${run}@example.com`, A.x);
  const eHR = await employee(A.tenant, A.x, "hr-census", {
    user_id: hrLogin,
    start_date: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    timeclock_pin_hash: "zz",
  });
  const roleOf = async (tenant: string, label: string) =>
    (await q<{ id: string }>("insert into roles (tenant_id, name) values ($1, $2) returning id", [tenant, `ZZ r6 role ${label} ${run}`]))[0]!.id;
  const roleDefault = await roleOf(DEFAULT, "default");
  const roleA = await roleOf(A.tenant, "a");
  const roleB = await roleOf(B.tenant, "b");
  await q("insert into employee_roles (employee_id, role_id) values ($1, $2)", [eHR, roleDefault]);
  const deptOf = async (tenant: string, label: string) =>
    (await q<{ id: string }>("insert into departments (tenant_id, name) values ($1, $2) returning id", [tenant, `ZZ r6 dept ${label} ${run}`]))[0]!.id;
  const deptA = await deptOf(A.tenant, "a");
  const deptB = await deptOf(B.tenant, "b");
  const changeOf = async (employeeId: string) =>
    (await q<{ id: string }>(
      "insert into employee_changes (employee_id, change_type, effective_date, note, created_by) values ($1, 'title_change', now(), 'ZZ', $2) returning id",
      [employeeId, A.admin.id],
    ))[0]!.id;
  const changeHR = await changeOf(eHR);
  const docHR = randomUUID();
  await q(
    `insert into employee_documents (id, employee_id, branch_id, document_type, file_name, file_path, mime_type, uploaded_by)
     values ($1, $2, $3, 'other', 'zz.pdf', '/api/files/employee-documents/zz-r6-hr.pdf', 'application/pdf', $4)`,
    [docHR, eHR, A.x, A.admin.id],
  );
  const letterHR = randomUUID();
  await q("insert into employee_letters (id, employee_id, branch_id, letter_type, status, created_by) values ($1, $2, $3, 'warning', 'draft', $4)", [
    letterHR,
    eHR,
    A.x,
    A.admin.id,
  ]);
  await q("insert into staff_cost_allocations (tenant_id, employee_id, branch_id, allocation_percent) values ($1, $2, $3, 100)", [A.tenant, eHR, A.x]);

  /** Everything of A's employee a door could write, read whole. */
  const hrSnapshot = async () => ({
    employee: (await q<{ row: string }>("select row_to_json(e)::text as row from employees e where id = $1", [eHR]))[0]!.row,
    login: (await q("select is_active, password, must_change_password, permission_review_required from users where id = $1", [hrLogin]))[0],
    roles: await q("select role_id from employee_roles where employee_id = $1 order by role_id", [eHR]),
    allocations: await q("select branch_id, allocation_percent from staff_cost_allocations where employee_id = $1 order by branch_id", [eHR]),
    changes: await q("select id, employee_id, note, new_branch_id from employee_changes where employee_id = $1 or id = $2 order by id", [eHR, changeHR]),
    counts: await Promise.all(
      ["employee_documents", "employee_letters", "employee_offboarding", "employee_assets", "enrollment_sessions", "activity_log", "contract_instances", "employee_time_off"].map(
        (table) => count(`select count(*) as n from ${table} where employee_id = $1`, [eHR]),
      ),
    ),
    users: await count("select count(*) as n from users where email ilike $1", [`%hr-census%`]),
  });

  /** A multipart request, as the app's upload doors take one. */
  const callForm = async (method: string, path: string, who: string, fields: Record<string, string>, file: { field: string; name: string; type: string; body: string }): Promise<Answer> => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append(file.field, new Blob([file.body], { type: file.type }), file.name);
    const res = await fetch(`${ORIGIN}${path}`, { method, redirect: "manual", headers: { cookie: who }, body: form });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON — kept as text for the message.
    }
    return { status: res.status, body, location: res.headers.get("location") };
  };

  /** What each door answers for another park group's employee, by the census's word. */
  const foreignAnswer: Record<(typeof EMPLOYEE_DOORS)[number]["foreign"], { status: number; body: unknown }> = {
    "employee-not-found": { status: 404, body: { message: "Employee not found" } },
    "empty-list": { status: 200, body: [] },
    null: { status: 200, body: null },
    "access-denied": { status: 403, body: { message: "Access denied" } },
    "face-off": { status: 403, body: FACE_ENROLMENT_OFF_REFUSAL },
  };
  /** A body that passes each door's own checks, so its answer is the park group's. */
  const doorBodies: Record<string, unknown> = {
    "PATCH /api/employees/:id/roles": { roleIds: [] },
    "PATCH /api/employees/:id/department": { departmentId: null },
    "POST /api/employees/:id/profile-photo": {},
    "PATCH /api/employees/:id": { nickname: "ZZ hijack", tenantId: B.tenant },
    "POST /api/employees/:id/enable-login": { password: "zz-hijack-password" },
    "POST /api/employees/:id/generate-login": {},
    "POST /api/employees/:id/reset-password": {},
    "POST /api/employees/:id/toggle-login": {},
    "PUT /api/employees/:id/cost-allocations": { allocations: [{ branchId: B.x, allocationPercent: 100 }] },
    "POST /api/employees/:id/complete-probation-review": {},
    "POST /api/employees/:employeeId/changes": { changeType: "title_change", effectiveDate: day(0), newTitle: "ZZ hijack" },
    "PATCH /api/employees/:employeeId/changes/:changeId": { note: "ZZ hijack" },
    "POST /api/employees/:employeeId/transfer": { effectiveDate: day(1), newBranchId: B.x },
    "POST /api/employees/:employeeId/offboarding": { offboardingType: "termination", reasonCode: "misconduct", lastWorkingDay: day(-2) },
    "PATCH /api/employees/:employeeId/offboarding": { lastWorkingDay: day(5) },
    "POST /api/employees/:employeeId/warnings": { reasonCode: "x", severity: "x", incidentDate: day(0), description: "x" },
    "POST /api/employees/:employeeId/letters": { letterType: "warning" },
    "POST /api/employees/:employeeId/assets": { assetNameSnapshot: "ZZ hijack" },
    "POST /api/employees/:employeeId/enrollment-session": {},
    "POST /api/employees/:employeeId/reset-face-enrollment": {},
    "POST /api/employees/:employeeId/pin": { pin: "1234" },
  };
  const doorPath = (path: string) =>
    path.replace(/:id\b|:employeeId\b/, eHR).replace(":changeId", changeHR).replace(":docId", docHR).replace(":letterId", letterHR);

  await check("the census: all 45 doors, as another park group's admin against this park group's employee, answer as the census says, and nothing is written", async () => {
    assert.equal(EMPLOYEE_DOORS.length, 45);
    const before = await hrSnapshot();
    const wrong: string[] = [];
    for (const door of EMPLOYEE_DOORS) {
      const key = `${door.method} ${door.path}`;
      const path = doorPath(door.path);
      const answer =
        key === "POST /api/employees/:employeeId/documents"
          ? await callForm("POST", path, cookie.b, { documentType: "other" }, { field: "file", name: "zz.pdf", type: "application/pdf", body: "%PDF-1.4 zz" })
          : await call(door.method, path, { cookie: cookie.b, ...(doorBodies[key] !== undefined ? { body: doorBodies[key] } : {}) });
      const want = foreignAnswer[door.foreign];
      if (answer.status !== want.status || JSON.stringify(answer.body) !== JSON.stringify(want.body)) {
        wrong.push(`${key}: ${show(answer)} — the census says ${want.status} ${JSON.stringify(want.body)}`);
      }
    }
    assert.deepEqual(wrong, []);
    assert.deepEqual(await hrSnapshot(), before, "nothing of the employee, their login or their records changed");
    console.log(`      the census: ${EMPLOYEE_DOORS.length} doors — ${EMPLOYEE_DOORS.filter((d) => d.fence === "review").length} fenced by round 6's review, ${EMPLOYEE_DOORS.filter((d) => d.fence === "lift").length} before it, ${EMPLOYEE_DOORS.filter((d) => d.fence === "app").length} by the app itself`);
  });

  await check("within the park group the doors are the app's: the employee read, edited and moved, roles, department, allocations, history, PIN, probation and the login", async () => {
    const read = await call("GET", `/api/employees/${eHR}`, { cookie: cookie.a });
    assert.equal(read.status, 200, show(read));
    assert.equal(read.body.id, eHR);
    // The editor re-sends what the employee already holds: unchanged ids are not weighed; a park group named is dropped.
    const edited = await call("PATCH", `/api/employees/${eHR}`, { cookie: cookie.a, body: { nickname: "ZZ edited", userId: hrLogin, branchId: A.x, tenantId: B.tenant } });
    assert.equal(edited.status, 200, show(edited));
    assert.deepEqual((await q("select tenant_id, nickname, user_id from employees where id = $1", [eHR]))[0], { tenant_id: A.tenant, nickname: "ZZ edited", user_id: hrLogin });
    const moved = await call("PATCH", `/api/employees/${eHR}`, { cookie: cookie.a, body: { branchId: A.y, primaryDepartmentId: deptA } });
    assert.equal(moved.status, 200, show(moved));
    assert.deepEqual((await q("select branch_id, primary_department_id from employees where id = $1", [eHR]))[0], { branch_id: A.y, primary_department_id: deptA });
    assert.equal((await call("PATCH", `/api/employees/${eHR}`, { cookie: cookie.a, body: { branchId: A.x } })).status, 200);
    const roles = await call("PATCH", `/api/employees/${eHR}/roles`, { cookie: cookie.a, body: { roleIds: [roleDefault, roleA] } });
    assert.equal(roles.status, 200, show(roles));
    assert.equal((await call("GET", `/api/employees/${eHR}/roles`, { cookie: cookie.a })).body.length, 2);
    assert.equal((await call("PATCH", `/api/employees/${eHR}/department`, { cookie: cookie.a, body: { departmentId: null } })).status, 200);
    const allocations = await call("PUT", `/api/employees/${eHR}/cost-allocations`, {
      cookie: cookie.a,
      body: { allocations: [{ branchId: A.x, allocationPercent: 60 }, { branchId: A.y, allocationPercent: 40 }] },
    });
    assert.equal(allocations.status, 200, show(allocations));
    assert.equal((await call("GET", `/api/employees/${eHR}/cost-allocations`, { cookie: cookie.a })).body.length, 2);
    assert.ok(((await call("GET", `/api/employees/${eHR}/changes`, { cookie: cookie.a })).body as { id: string }[]).some((c) => c.id === changeHR));
    assert.equal((await call("POST", `/api/employees/${eHR}/changes`, { cookie: cookie.a, body: { changeType: "title_change", effectiveDate: day(0), newTitle: "ZZ Host" } })).status, 201);
    // An update cannot move the change to another employee: it stays this one's.
    const otherA = await employee(A.tenant, A.x, "hr-other");
    const noted = await call("PATCH", `/api/employees/${eHR}/changes/${changeHR}`, { cookie: cookie.a, body: { note: "ZZ noted", employeeId: otherA } });
    assert.equal(noted.status, 200, show(noted));
    assert.deepEqual((await q("select employee_id, note from employee_changes where id = $1", [changeHR]))[0], { employee_id: eHR, note: "ZZ noted" });
    assert.equal((await call("GET", `/api/employees/${eHR}/timekeeping-status`, { cookie: cookie.a })).body.hasPinSet, true);
    assert.equal((await call("DELETE", `/api/employees/${eHR}/pin`, { cookie: cookie.a })).status, 200);
    assert.equal((await call("POST", `/api/employees/${eHR}/pin`, { cookie: cookie.a, body: { pin: "4321" } })).status, 200);
    assert.equal((await call("POST", `/api/employees/${eHR}/complete-probation-review`, { cookie: cookie.a })).status, 200);
    const off = await call("POST", `/api/employees/${eHR}/toggle-login`, { cookie: cookie.a });
    assert.deepEqual([off.status, off.body.isActive], [200, false]);
    const on = await call("POST", `/api/employees/${eHR}/toggle-login`, { cookie: cookie.a });
    assert.deepEqual([on.status, on.body.isActive], [200, true]);
    const reset = await call("POST", `/api/employees/${eHR}/reset-password`, { cookie: cookie.a });
    assert.equal(reset.status, 200, show(reset));
    assert.ok(reset.body.tempPassword);
  });

  await check("an edit naming another park group's branch, login, person, department or role is refused in the app's words for it (404), and writes nothing", async () => {
    const personB = randomUUID();
    await q("insert into people (id, full_name, email, person_type) values ($1, $2, $3, 'EMPLOYEE')", [personB, `ZZ TEST r6 person ${run}`, `zz-r6-person-b-${run}@example.com`]);
    await q("insert into access_policies (tenant_id, person_id, access_level, modules, branch_scope) values ($1, $2, 'STAFF', '{}'::jsonb, 'SELECTED')", [B.tenant, personB]);
    const changeOther = await changeOf(await employee(A.tenant, A.x, "hr-other-change"));
    const before = await hrSnapshot();
    const refusals: Array<[string, string, unknown, number, unknown]> = [
      ["PATCH", `/api/employees/${eHR}`, { branchId: B.x }, 404, BRANCH_NOT_FOUND],
      ["PATCH", `/api/employees/${eHR}`, { nickname: "ZZ hijack", userId: B.limited.id }, 404, USER_NOT_FOUND],
      ["PATCH", `/api/employees/${eHR}`, { updatedBy: B.admin.id }, 404, USER_NOT_FOUND],
      ["PATCH", `/api/employees/${eHR}`, { personId: personB }, 404, PERSON_NOT_FOUND],
      ["PATCH", `/api/employees/${eHR}`, { primaryDepartmentId: deptB }, 404, DEPARTMENT_NOT_FOUND],
      ["PATCH", `/api/employees/${eHR}/roles`, { roleIds: [roleDefault, roleB] }, 404, ROLE_NOT_FOUND],
      ["PATCH", `/api/employees/${eHR}/department`, { departmentId: deptB }, 404, DEPARTMENT_NOT_FOUND],
      ["PUT", `/api/employees/${eHR}/cost-allocations`, { allocations: [{ branchId: B.x, allocationPercent: 100 }] }, 400, { message: "One or more invalid branch IDs" }],
      ["POST", `/api/employees/${eHR}/changes`, { changeType: "branch_transfer", effectiveDate: day(1), newBranchId: B.x }, 404, BRANCH_NOT_FOUND],
      ["PATCH", `/api/employees/${eHR}/changes/${changeHR}`, { newBranchId: B.x }, 404, BRANCH_NOT_FOUND],
      ["PATCH", `/api/employees/${eHR}/changes/${changeOther}`, { note: "ZZ hijack" }, 404, CHANGE_NOT_FOUND],
    ];
    for (const [method, path, body, status, words] of refusals) {
      const answer = await call(method, path, { cookie: cookie.a, body });
      assert.equal(answer.status, status, `${method} ${path} ${JSON.stringify(body)}: ${show(answer)}`);
      assert.deepEqual(answer.body, words, `${method} ${path} ${JSON.stringify(body)}`);
    }
    assert.deepEqual(await hrSnapshot(), before);
    assert.equal((await q<{ note: string }>("select note from employee_changes where id = $1", [changeOther]))[0]!.note, "ZZ");
  });

  console.log(`documents.check: ${checks} checks passed`);
} catch (err) {
  console.error("documents.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  for (const table of ["employee_changes", "offboarding_checklist", "activity_log"]) {
    await q(`drop trigger if exists ${INJECT} on ${table}`).catch(() => undefined);
  }
  await q(`drop function if exists ${INJECT}()`).catch(() => undefined);
  await q(`drop trigger if exists ${INJECT}_slow on org_nodes`).catch(() => undefined);
  await q(`drop function if exists ${INJECT}_slow()`).catch(() => undefined);
  // The default park group's leave policy made above goes: it would set every
  // later check's park groups' accrual.
  await q("delete from leave_policies where tenant_id = $1 and name like $2", [DEFAULT, `ZZ r6 default company-wide ${run}`]).catch(() => undefined);
  bucketServer.close();
  await pool.end();
}
