// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file: it boots the app's real routes, needs a database with the otoapp schema
// migrated, and renders the profile page's real Onboard Again button, its
// dialog and the app's toaster under jsdom against them, inside the app's real
// auth provider.
//
// SCRUM-811 — what the Onboard Again screen says of the till and Console roles
// the platform took back when the person left (SCRUM-769). The screen's half of
// tests/employee-onboard-again.check.ts, which reads the route's answer: here
// the answer travels from the real route to the real toast, the road the
// sentence was lost on. Each profile is offboarded through the app's own route
// with a last day already past (its login goes to My pay only), then the
// administrator presses Onboard Again and confirms the dialog as it opens:
//
//   1. The platform had had the restriction, so the roles were taken back
//      there: the toast says the new employment has started and "Their till
//      and Console roles were taken back when they left; a Console
//      administrator gives them back on Login users."
//   2. The restriction was still waiting for the platform: it is withdrawn,
//      nothing was taken back, and the toast says only that the employment has
//      started.
//   3. A login with no platform account: nothing to take back, the same.
//   4. A profile still working its notice, planned for a later start: the
//      toast says the plan, and nothing of roles.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/employee-onboard-again-ui.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createRequire, Module } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("employee-onboard-again-ui.check: DATABASE_URL is not set");
  process.exit(2);
}

// ─── jsdom, before React loads ───────────────────────────────────────────────

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/employees", pretendToBeVisual: true });
/* eslint-disable @typescript-eslint/no-explicit-any -- the jsdom globals and the compiled bundle's exports are read untyped */
const g = globalThis as Record<string, any>;
const win = dom.window as unknown as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLImageElement", "HTMLTextAreaElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history", "localStorage", "sessionStorage"]) {
  try { g[key] = win[key]; } catch { /* a read-only global */ }
}
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[key] = win[key].bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = win.ResizeObserver = ResizeObserverStub;
class PointerEventStub extends dom.window.MouseEvent {
  pointerId = 1;
  pointerType = "mouse";
  isPrimary = true;
}
g.PointerEvent = win.PointerEvent = PointerEventStub;
Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {}, hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {} });
win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
const doc = dom.window.document;
const realLog = console.log;
console.log = (...args: unknown[]) => {
  if (!/^\[auth-diag/.test(String(args[0]))) realLog(...args);
};

// ─── The button, compiled as Vite would give it its build-time env ───────────

const built = buildSync({
  absWorkingDir: APP_DIR,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  write: false,
  tsconfig: join(APP_DIR, "tests", "tsconfig.jsx.json"),
  define: { "import.meta.env": "{}", "import.meta.url": JSON.stringify("file:///employee-onboard-again-ui.native.cjs") },
  logLevel: "silent",
  stdin: {
    resolveDir: APP_DIR,
    loader: "tsx",
    contents: `
      export * as React from 'react';
      export { act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { QueryClientProvider } from '@tanstack/react-query';
      export { queryClient } from './client/src/lib/queryClient';
      export { AuthProvider } from './client/src/hooks/use-auth';
      export { ThemeProvider } from './client/src/components/theme-provider';
      export { I18nProvider } from './client/src/lib/i18n';
      export { TooltipProvider } from './client/src/components/ui/tooltip';
      export { Toaster } from './client/src/components/ui/toaster';
      export { toast } from './client/src/hooks/use-toast';
      export { OnboardAgainAction } from './client/src/components/employee-onboard-again-actions';
    `,
  },
});
const nativeRequire = createRequire(join(APP_DIR, "package.json"));
const compiled = new Module(join(APP_DIR, "tests", "employee-onboard-again-ui.native.cjs")) as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = join(APP_DIR, "tests", "employee-onboard-again-ui.native.cjs");
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthProvider, ThemeProvider, I18nProvider, TooltipProvider, Toaster, toast, OnboardAgainAction } = compiled.exports;

// ─── Rows ────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const DAY_MS = 86_400_000;
/** Bangkok's calendar day, as the routes compare days. */
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [TENANT, `ZZ TEST s811ui ${run}`, `zz-s811ui-${run}`]);
const BRANCH = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [BRANCH, TENANT, `ZZ TEST s811ui ${run}`]);
const DEPARTMENT = randomUUID();
const DEPARTMENT_NAME = `ZZ TEST s811ui reception ${run}`;
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [DEPARTMENT, TENANT, DEPARTMENT_NAME]);
const TEMPLATE = randomUUID();
await q("insert into templates (id, tenant_id, name, html_body) values ($1, $2, $3, $4)", [
  TEMPLATE, TENANT, `ZZ TEST s811ui ${run}`, "<p>{{contract.position_title}} from {{contract.start_date}}</p>",
]);

async function login(role: string, label: string, platformUserId: string | null): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `zz-s811ui-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
     values ($1, $2, $3, $4, $5, true, false, $6)`,
    [id, email, hash(PASSWORD), `ZZ TEST s811ui ${label} ${run}`, role, platformUserId],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    TENANT, id, role === "admin" ? null : BRANCH, role === "admin" ? "all_branches" : "selected_branches",
  ]);
  return { id, email };
}
/** A profile with its own login; `linked`: the login has a platform account, so the platform is told of a restriction. */
async function person(label: string, linked: boolean): Promise<{ id: string; userId: string }> {
  const user = await login("staff", label, linked ? randomUUID() : null);
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, employment_state, default_merge_data, primary_department_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'active', 'ACTIVE', $8, $9)`,
    [id, TENANT, BRANCH, user.id, `ZZ TEST s811ui ${label} ${run}`, label, `zz-s811ui-emp-${label}-${run}@example.com`,
      JSON.stringify({ positionTitle: "ZZ Receptionist", salaryThb: 15000 }), DEPARTMENT],
  );
  return { id, userId: user.id };
}
const admin = await login("admin", "admin", null);
const withdrawn = await person("withdrawn", true);
const waiting = await person("waiting", true);
const unlinked = await person("unlinked", false);
const inNotice = await person("in-notice", true);

const access = async (userId: string) =>
  (await q<{ is_active: boolean; access_mode: string }>("select is_active, access_mode from users where id = $1", [userId]))[0]!;
/** What the platform has been asked about the login, as kind:state. */
const lifecycle = async (userId: string) => (await q<{ kind: string; state: string }>(
  "select kind, state from login_lifecycle_events where user_id = $1 order by created_at, id", [userId])).map((r) => `${r.kind}:${r.state}`);
const engagements = async (employeeId: string) => (await q<{ status: string }>(
  "select status from employee_engagements where employee_id = $1 order by created_at", [employeeId])).map((r) => r.status);

// ─── The server ──────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
async function serve(): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
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
      SESSION_SECRET: `zz-session-${run}`,
    },
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

let checks = 0;
const check = async (title: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  realLog(`  ok  ${title}`);
};

const realFetch = globalThis.fetch;
const settle = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
/** Every write the screen sends, with the server's answer to it. */
const writes: Array<{ method: string; path: string; status: number; answer: unknown }> = [];
const page = () => (doc.body.textContent ?? "").replace(/\s+/g, " ");
const waitFor = async <T,>(what: string, find: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}; the screen wrote ${JSON.stringify(writes)} and shows: ${page().slice(0, 600)}`);
    }
    await settle(50);
  }
};
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
let root: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- a React root from the compiled bundle
let host: HTMLElement | null = null;

const ROLES_WITHDRAWN = "Their till and Console roles were taken back when they left; a Console administrator gives them back on Login users.";
const STARTED = "The new employment has started.";

try {
  const ORIGIN = await serve();
  const signedIn = await realFetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: admin.email, password: PASSWORD }),
  });
  assert.equal(signedIn.status, 200, `sign-in: ${signedIn.status} ${await signedIn.text()}`);
  const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await realFetch(`${ORIGIN}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), cookie },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    assert.ok(res.ok, `${method} ${path}: ${res.status} ${text}`);
    return JSON.parse(text);
  };
  /** Offboard, through the app's own route, as the administrator. */
  const offboard = (employeeId: string, lastWorkingDay: string) =>
    api("POST", `/api/employees/${employeeId}/offboarding`, { offboardingType: "resignation", reasonCode: "personal_reasons", lastWorkingDay });

  /** Everything the screen asks, on to the real routes as the administrator. */
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const res = await realFetch(`${ORIGIN}${url.pathname}${url.search}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), cookie },
    });
    if (method !== "GET") writes.push({ method, path: url.pathname, status: res.status, answer: await res.clone().json().catch(() => null) });
    return res;
  };

  /** The toast on show: its title and its words. */
  const shown = () => {
    const open = doc.querySelector('li[data-state="open"]');
    if (!open) return null;
    const [title, description] = [...open.querySelectorAll(".grid > div")].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
    return { title: title ?? "", description: description ?? "" };
  };

  /**
   * The profile page's Onboard Again button for a profile, as the page mounts
   * it: pressed, and the dialog confirmed as it opens — the start date the day
   * after the last working day, the profile's own department, the template of
   * its latest contract. Answers the route's answer and the toast.
   */
  const onboardAgain = async (profile: { id: string }) => {
    if (root) await act(async () => root.unmount());
    host?.remove();
    await act(async () => { queryClient.clear(); });
    // The toast of the profile before is taken down: each check reads its own.
    await act(async () => { toast({ title: "ZZ TEST" }).dismiss(); });
    writes.length = 0;
    const employee = await api("GET", `/api/employees/${profile.id}`);
    host = doc.createElement("div");
    doc.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(QueryClientProvider, { client: queryClient },
          React.createElement(ThemeProvider, null,
            React.createElement(I18nProvider, null,
              React.createElement(AuthProvider, null,
                React.createElement(TooltipProvider, null,
                  React.createElement(Toaster),
                  React.createElement(OnboardAgainAction, {
                    employee,
                    branches: [],
                    departments: [{ id: DEPARTMENT, name: DEPARTMENT_NAME, isActive: true }],
                    defaultTemplateId: TEMPLATE,
                  })))))),
      );
    });
    const button = await waitFor("the Onboard Again button", () => byTestId("button-onboard-again"));
    await settle(100);
    assert.equal(shown(), null, "no toast is on show before the button is pressed");
    await act(async () => { button.click(); });
    const confirm = await waitFor("the dialog's Onboard Again, ready to press", () => {
      const el = byTestId("button-confirm-onboard-again") as HTMLButtonElement | null;
      return el && !el.disabled ? el : null;
    });
    await act(async () => { confirm.click(); });
    await waitFor("the toast", () => shown());
    const posts = writes.filter((w) => w.method === "POST" && w.path === `/api/employees/${profile.id}/onboard-again`);
    assert.equal(posts.length, 1, `one Onboard Again was sent: ${JSON.stringify(writes)}`);
    assert.equal(posts[0]!.status, 201, JSON.stringify(posts[0]));
    return { answer: posts[0]!.answer as Record<string, unknown>, toast: shown()! };
  };

  console.log("1. the platform had taken the roles back:");
  await check("the toast says the employment has started and that a Console administrator gives the roles back", async () => {
    await offboard(withdrawn.id, plus(-3));
    assert.deepEqual(await access(withdrawn.userId), { is_active: true, access_mode: "pay_only" });
    assert.deepEqual(await lifecycle(withdrawn.userId), ["restrict:pending"]);
    // What the platform's consumer marks once it has had the restriction (the harness runs no transport).
    await q("update login_lifecycle_events set state = 'delivered', settled_at = now() where user_id = $1 and state = 'pending'", [withdrawn.userId]);
    const { answer, toast: said } = await onboardAgain(withdrawn);
    assert.deepEqual([answer.started, answer.platformRestrictionDelivered], [true, true], JSON.stringify(answer));
    assert.deepEqual(said, { title: "Onboarded again", description: `${STARTED} ${ROLES_WITHDRAWN}` });
    // What Onboard Again does is as it was: the whole app again, nothing asked of the platform.
    assert.deepEqual(await access(withdrawn.userId), { is_active: true, access_mode: "full" });
    assert.deepEqual(await lifecycle(withdrawn.userId), ["restrict:delivered"]);
  });

  console.log("2. nothing was taken back on the platform:");
  await check("the restriction was still waiting for the platform: withdrawn, and the toast says only that the employment has started", async () => {
    await offboard(waiting.id, plus(-3));
    assert.deepEqual(await lifecycle(waiting.userId), ["restrict:pending"]);
    const { answer, toast: said } = await onboardAgain(waiting);
    assert.deepEqual([answer.started, answer.platformRestrictionDelivered], [true, false], JSON.stringify(answer));
    assert.deepEqual(said, { title: "Onboarded again", description: STARTED });
    assert.ok(!page().includes("roles were taken back"), page().slice(-400));
    assert.deepEqual(await access(waiting.userId), { is_active: true, access_mode: "full" });
    assert.deepEqual(await lifecycle(waiting.userId), ["restrict:superseded"]);
  });
  await check("a login with no platform account: the toast says only that the employment has started", async () => {
    await offboard(unlinked.id, plus(-3));
    assert.deepEqual(await access(unlinked.userId), { is_active: true, access_mode: "pay_only" });
    assert.deepEqual(await lifecycle(unlinked.userId), []);
    const { answer, toast: said } = await onboardAgain(unlinked);
    assert.deepEqual([answer.started, answer.platformRestrictionDelivered], [true, false], JSON.stringify(answer));
    assert.deepEqual(said, { title: "Onboarded again", description: STARTED });
    assert.ok(!page().includes("roles were taken back"), page().slice(-400));
    assert.deepEqual(await access(unlinked.userId), { is_active: true, access_mode: "full" });
  });

  console.log("3. planned for a later start:");
  await check("a profile in its notice, planned for the day after its last day: the toast says the plan and nothing of roles", async () => {
    await offboard(inNotice.id, plus(2));
    assert.deepEqual(await access(inNotice.userId), { is_active: true, access_mode: "full" });
    const { answer, toast: said } = await onboardAgain(inNotice);
    assert.deepEqual([answer.started, answer.startDate, "platformRestrictionDelivered" in answer], [false, plus(3), false], JSON.stringify(answer));
    assert.equal(said.title, "Onboard Again planned");
    assert.match(said.description, /^The new employment starts on .+\. Its shifts can be added from that date, and a draft contract is ready\.$/);
    assert.ok(!page().includes("roles were taken back"), page().slice(-400));
    assert.deepEqual(await engagements(inNotice.id), ["planned"]);
  });

  console.log(`employee-onboard-again-ui.check: ${checks} checks passed`);
} catch (err) {
  console.error("employee-onboard-again-ui.check FAILED:", err);
  process.exitCode = 1;
} finally {
  if (root) {
    try { await act(async () => root.unmount()); } catch { /* the screen is already down */ }
  }
  if (host) host.remove();
  for (const child of children) child.kill();
  await pool.end();
}
process.exit(process.exitCode ?? 0);
