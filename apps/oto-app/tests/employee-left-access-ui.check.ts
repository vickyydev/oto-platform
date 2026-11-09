// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file: it boots the app's real routes, needs a database with the otoapp schema
// migrated, and renders the app's real pay-only gate under jsdom against them,
// inside the app's real auth provider.
//
// SCRUM-769 — what a login whose employment has ended sees (the client half of
// tests/employee-left-access.check.ts, which drives the server):
//
//   1. Signed in, the person lands on My pay whatever address they opened —
//      Today, a deep link into the employee pages — with one plain line saying
//      why, and the header holds My pay and Logout and nothing else. The full
//      app is never rendered for them.
//   2. Everything the screen asks the server for is a route the server's fence
//      lets through: the client asks for nothing it would only be refused.
//   3. Logout signs them out.
//   4. A colleague with full access gets the full app, as before.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/employee-left-access-ui.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createRequire, Module } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import pg from "pg";
import { PAY_ONLY_MESSAGE } from "../shared/payOnly";
import { payOnlyRefuses } from "../server/lib/payOnlyRoutes";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("employee-left-access-ui.check: DATABASE_URL is not set");
  process.exit(2);
}

// ─── jsdom, before React loads ───────────────────────────────────────────────

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/core/today", pretendToBeVisual: true });
/* eslint-disable @typescript-eslint/no-explicit-any -- the jsdom globals and the compiled bundle's exports are read untyped */
const g = globalThis as Record<string, any>;
const win = dom.window as unknown as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLImageElement", "HTMLVideoElement", "HTMLTextAreaElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history", "localStorage", "sessionStorage"]) {
  try { g[key] = win[key]; } catch { /* a read-only global */ }
}
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[key] = win[key].bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = win.ResizeObserver = ResizeObserverStub;
win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
const doc = dom.window.document;
const realLog = console.log;
console.log = (...args: unknown[]) => {
  if (!/^\[auth-diag/.test(String(args[0]))) realLog(...args);
};

// ─── The gate, compiled as Vite would give it its build-time env ─────────────

const built = buildSync({
  absWorkingDir: APP_DIR,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  write: false,
  tsconfig: join(APP_DIR, "tests", "tsconfig.jsx.json"),
  define: { "import.meta.env": "{}", "import.meta.url": JSON.stringify("file:///employee-left-access-ui.native.cjs") },
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
      export { PayOnlyGate } from './client/src/components/pay-only-app';
    `,
  },
});
const nativeRequire = createRequire(join(APP_DIR, "package.json"));
const compiled = new Module(join(APP_DIR, "tests", "employee-left-access-ui.native.cjs")) as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = join(APP_DIR, "tests", "employee-left-access-ui.native.cjs");
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthProvider, ThemeProvider, I18nProvider, PayOnlyGate } = compiled.exports;

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

const TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [TENANT, `ZZ TEST s769ui ${run}`, `zz-s769ui-${run}`]);
const BRANCH = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [BRANCH, TENANT, `ZZ TEST s769ui ${run}`]);

/** A staff login and its profile. `ended`: the state the 03:00 batch leaves a leaver in (tests/employee-left-access.check.ts). */
async function person(label: string, ended: boolean): Promise<{ email: string; name: string }> {
  const userId = randomUUID();
  const email = `zz-s769ui-${label}-${run}@example.com`;
  const name = `ZZ TEST s769ui ${label} ${run}`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, access_mode)
     values ($1, $2, $3, $4, 'staff', true, false, $5)`,
    [userId, email, hash(PASSWORD), name, ended ? "pay_only" : "full"],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [TENANT, userId, BRANCH]);
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, employment_state, last_working_day)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [randomUUID(), TENANT, BRANCH, userId, name, label, `zz-s769ui-emp-${label}-${run}@example.com`,
      ended ? "resigned" : "active", ended ? "LEFT" : "ACTIVE", ended ? "2026-01-01" : null],
  );
  return { email, name };
}
const leaver = await person("leaver", true);
const colleague = await person("colleague", false);

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
const waitFor = async <T,>(what: string, find: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what} at ${dom.window.location.pathname}; the screen asked ${JSON.stringify(asked)} and shows: ${doc.body.textContent?.slice(0, 400)}`);
    }
    await settle(50);
  }
};
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
/** Every request the screen makes (below, as the fetch the app sees). */
const asked: Array<{ method: string; path: string; status: number }> = [];
let root: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- a React root from the compiled bundle
let host: HTMLElement | null = null;

try {
  const ORIGIN = await serve();
  const signIn = async (email: string) => {
    const res = await realFetch(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: email, password: PASSWORD }),
    });
    assert.equal(res.status, 200, `sign-in as ${email}: ${res.status}`);
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  };

  /** Every request the screen makes, on to the real routes as the signed-in person. */
  let cookie = "";
  g.fetch =async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const res = await realFetch(`${ORIGIN}${url.pathname}${url.search}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), cookie },
    });
    asked.push({ method, path: url.pathname, status: res.status });
    return res;
  };

  // The app, from the sign-in down, once per person and address.
  const FULL_APP = "zz-full-app";
  const mount = async (who: { email: string }, address: string) => {
    if (root) await act(async () => root.unmount());
    host?.remove();
    await act(async () => { queryClient.clear(); });
    cookie = await signIn(who.email);
    asked.length = 0;
    dom.window.history.replaceState(null, "", address);
    host = doc.createElement("div");
    doc.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(QueryClientProvider, { client: queryClient },
          React.createElement(ThemeProvider, null,
            React.createElement(I18nProvider, null,
              React.createElement(AuthProvider, null,
                React.createElement(PayOnlyGate, null,
                  React.createElement("div", { "data-testid": FULL_APP }, "the full app")))))),
      );
    });
  };

  console.log("1. a login whose employment has ended:");
  for (const address of ["/core/today", "/employees/zz-somebody", "/payroll/me/payslips"]) {
    await check(`opening ${address} lands on My pay, with the plain line, My pay and Logout alone, and never the full app`, async () => {
      await mount(leaver, address);
      // The page read the person's own payslips: their profile, none locked yet.
      await waitFor("the person's own payslips", () => byTestId("page-my-payslips")?.textContent?.includes("No locked payslips yet."));
      assert.equal(dom.window.location.pathname, "/payroll/me/payslips");
      assert.equal(byTestId("pay-only-notice")?.textContent, PAY_ONLY_MESSAGE);
      assert.equal(byTestId(FULL_APP), null, "the full app is not rendered");
      const header = byTestId("pay-only-shell")!.querySelector("header")!;
      const controls = [...header.querySelectorAll("a, button")].map((el) => el.getAttribute("data-testid"));
      assert.deepEqual(controls, ["nav-my-pay", "button-logout-pay-only"]);
      assert.match(byTestId("nav-my-pay")!.textContent ?? "", /My pay/);
      assert.ok(header.textContent?.includes(leaver.name), "the header names who is signed in");
    });
    await check(`opening ${address}: everything the screen asked for is a route the fence lets through, and none was refused`, async () => {
      assert.ok(asked.length > 0, "the screen asked for something");
      for (const r of asked) {
        assert.equal(payOnlyRefuses(r.method, r.path), false, `${r.method} ${r.path} is not one of pay only's routes`);
        assert.notEqual(r.status, 403, `${r.method} ${r.path} was refused`);
      }
      assert.ok(asked.some((r) => r.path === "/api/payroll/me/payslips" && r.status === 200));
    });
  }
  await check("Logout signs the person out", async () => {
    await act(async () => { byTestId("button-logout-pay-only")!.click(); });
    await waitFor("the signed-out app", () => byTestId(FULL_APP));
    assert.ok(asked.some((r) => r.method === "POST" && r.path === "/api/logout" && r.status === 200));
    assert.equal(byTestId("pay-only-shell"), null);
  });

  console.log("2. a colleague with full access:");
  await check("gets the full app, as before", async () => {
    await mount(colleague, "/core/today");
    await waitFor("the user to load", () => asked.some((r) => r.path === "/api/user" && r.status === 200));
    await settle(100);
    assert.ok(byTestId(FULL_APP), "the full app is rendered");
    assert.equal(byTestId("pay-only-shell"), null);
    assert.equal(dom.window.location.pathname, "/core/today");
  });

  console.log(`employee-left-access-ui.check: ${checks} checks passed`);
} catch (err) {
  console.error("employee-left-access-ui.check FAILED:", err);
  process.exitCode = 1;
} finally {
  if (host) host.remove();
  for (const child of children) child.kill();
  await pool.end();
}
process.exit(process.exitCode ?? 0);
