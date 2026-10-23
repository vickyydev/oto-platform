// seed: none — no database, no server, no browser. Not a Playwright file (the
// suite collects *.spec.ts and *.test.ts; this is neither).
//
// SCRUM-572 (payroll R7, the UI cutover), the access check over the client
// route table (PLAN §9 R7 "Checks"), read from the source as written:
//
//   1. The sidebar's Payroll section by role, from the one navigation table
//      the hub also reads: payroll roles (hr.view_salary) see every payroll
//      page; managers and staff see My Payslips only; nobody signed out.
//   2. Every old payroll screen (PLAN §7 "Old pages") is gone from disk and
//      from App.tsx, and every one of its addresses redirects: to its new
//      home for a payroll role, to the person's own payslips for anyone else,
//      and every redirect target is a registered route. Downloads are per
//      locked version (R5's /payroll/downloads/:entityId/:month/:version), so
//      the hub's Downloads card opens History and is not a sidebar entry.
//   3. Every /payroll route in App.tsx is held to payroll roles, except the
//      hub address (which sends everyone else to their payslips) and the
//      self-payslip page (every signed-in employee); the sidebar carries no
//      payroll address of its own.
//   4. The DialogBody sweep (PLAN §7): every payroll page and component that
//      opens a dialog keeps the recipe — a DialogContent has a DialogBody,
//      and no sheet, drawer or alert dialog bypasses it.
//   5. The HR employee editor's Payroll tab keeps our gated pay fields and
//      links payroll roles to the person's payroll profile.
//
// Usage, from apps/oto-app:
//   npx tsx tests/payroll-cutover.check.ts
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OLD_PAYROLL_REDIRECTS, PAYROLL_ENTRIES, PAYROLL_HUB_CARDS, PAYROLL_PATHS, payrollMenuFor, redirectTarget,
} from "../client/src/lib/payroll/nav";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(APP, "client", "src");
const read = (path: string) => readFileSync(join(CLIENT, path), "utf8");

let failures = 0;
let passed = 0;
async function check(name: string, body: () => void | Promise<void>) {
  try {
    await body();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

const PAYROLL_ROLES = ["global_admin", "admin", "operator_admin"];
const OTHER_ROLES = ["manager", "staff"];
const ALL_ROLES = [...PAYROLL_ROLES, ...OTHER_ROLES];
const SELF_ROLE_LIST = '["staff", "manager", "operator_admin", "global_admin", "admin"]';

/** PLAN §7 "Old pages, removed from the router and sidebar in R7", with the address each served. */
const OLD_PAGES: [file: string, path: string | null][] = [
  ["payroll-overview-page", "/payroll"],
  ["payroll-periods-page", "/payroll/periods"],
  ["payroll-period-detail-page", "/payroll/periods/:periodId"],
  ["payroll-run-detail-page", "/payroll/runs/:runId"],
  ["payroll-exceptions-page", "/payroll/runs/:runId/exceptions"],
  ["payroll-exception-detail-page", "/payroll/runs/:runId/exceptions/:exceptionId"],
  ["payroll-employees-page", "/payroll/runs/:runId/employees"],
  ["payroll-employee-detail-page", "/payroll/runs/:runId/employees/:employeeId"],
  ["payroll-exports-page", "/payroll/runs/:runId/exports"],
  ["payroll-statutory-rules-page", "/payroll/statutory-rules"],
  ["my-payslips-page", "/my-payslips"],
  ["payroll-page", null], // lazy-loaded, never routed
];

/** Where a payroll role lands from each old address (the people page keeps the employee). */
const EXPECTED_HOMES: Record<string, string> = {
  "/payroll/periods": "/payroll/history",
  "/payroll/periods/:periodId": "/payroll/history",
  "/payroll/runs/:runId": "/payroll/month-end",
  "/payroll/runs/:runId/exceptions": "/payroll/month-end?tab=preview",
  "/payroll/runs/:runId/exceptions/:exceptionId": "/payroll/month-end?tab=preview",
  "/payroll/runs/:runId/employees": "/payroll/people",
  "/payroll/runs/:runId/employees/:employeeId": "/payroll/people/emp%201",
  "/payroll/runs/:runId/exports": "/payroll/history",
  "/payroll/statutory-rules": "/payroll/setup?tab=statutory",
  "/my-payslips": "/payroll/me/payslips",
};
const SAMPLE_PARAMS = { periodId: "p1", runId: "r1", exceptionId: "x1", employeeId: "emp 1" };

const app = read("App.tsx");
/** Every literal ProtectedRoute in App.tsx: its path and its requiredRole list as written. */
const routes = [...app.matchAll(/<ProtectedRoute path="([^"]+)"[^\n]*?requiredRole=\{?(\[[^\]]*\]|"[^"]*")\}?/g)].map((m) => ({ path: m[1], roles: m[2] }));
const routePaths = new Set(routes.map((r) => r.path));

console.log("payroll-cutover.check (SCRUM-572, R7)");

await check("1. the Payroll menu by role: payroll roles every page, managers and staff their own payslips only", () => {
  const every = PAYROLL_ENTRIES.map((e) => e.id);
  for (const role of PAYROLL_ROLES) assert.deepEqual(payrollMenuFor(role).map((e) => e.id), ["hub", "run", "people", "history", "documents", "setup", "myPayslips"], role);
  for (const role of OTHER_ROLES) assert.deepEqual(payrollMenuFor(role).map((e) => e.id), ["myPayslips"], role);
  assert.deepEqual(payrollMenuFor(undefined), []);
  assert.deepEqual(payrollMenuFor("advisor").map((e) => e.id), ["myPayslips"], "an unknown role falls to staff");
  assert.deepEqual(every, ["hub", "run", "people", "history", "downloads", "documents", "setup", "myPayslips"]);
  assert.deepEqual(PAYROLL_HUB_CARDS.map((e) => e.id), ["run", "people", "history", "downloads", "documents", "setup"]);
  assert.ok(PAYROLL_ENTRIES.find((e) => e.id === "hub")?.exact, "the hub is active on its own address only");
  const downloads = PAYROLL_ENTRIES.find((e) => e.id === "downloads");
  assert.equal(downloads?.url, PAYROLL_PATHS.history, "the Downloads card opens History, where each locked version links its downloads");
  assert.ok(downloads?.hubOnly, "Downloads is a hub card, not a second sidebar entry for History");
});

await check("1b. the sidebar and the hub read that table and carry no payroll address of their own", () => {
  const sidebar = read("components/app-sidebar.tsx");
  assert.match(sidebar, /payrollMenuFor\(subject\)/);
  assert.equal([...sidebar.matchAll(/["'`]\/(payroll|my-payslips)\b/g)].length, 0, "no payroll address literal in the sidebar");
  const hub = read("pages/payroll-hub-page.tsx");
  assert.match(hub, /PAYROLL_HUB_CARDS\.map/);
  assert.equal([...hub.matchAll(/["'`]\/payroll/g)].length, 0, "the hub links through PAYROLL_PATHS only");
});

await check("2. every old payroll screen is gone from disk and from App.tsx", () => {
  for (const [file] of OLD_PAGES) {
    assert.ok(!existsSync(join(CLIENT, "pages", `${file}.tsx`)), `${file}.tsx still exists`);
    assert.ok(!app.includes(`@/pages/${file}"`), `App.tsx still imports ${file}`);
  }
  for (const [, path] of OLD_PAGES) {
    if (!path || path === "/payroll") continue;
    assert.ok(!routePaths.has(path), `${path} is still a page route`);
  }
  assert.match(app, /OLD_PAYROLL_REDIRECTS\.map\(\(r\) => <ProtectedRoute key=\{r\.from\} path=\{r\.from\} component=\{\(\) => <OldPayrollRedirect redirect=\{r\} \/>\} requiredRole=\{\["staff", "manager", "operator_admin", "global_admin", "admin"\]\} \/>\)/,
    "the redirects are registered for every signed-in role");
});

await check("2b. every old address redirects: its new home for a payroll role, own payslips for anyone else", () => {
  const old = OLD_PAGES.map(([, path]) => path).filter((p): p is string => !!p && p !== "/payroll");
  assert.deepEqual(OLD_PAYROLL_REDIRECTS.map((r) => r.from).sort(), [...old].sort(), "one redirect per old address");
  for (const r of OLD_PAYROLL_REDIRECTS) {
    for (const role of PAYROLL_ROLES) assert.equal(redirectTarget(r, SAMPLE_PARAMS, role), EXPECTED_HOMES[r.from], `${r.from} as ${role}`);
    for (const role of OTHER_ROLES) assert.equal(redirectTarget(r, SAMPLE_PARAMS, role), PAYROLL_PATHS.myPayslips, `${r.from} as ${role}`);
  }
});

await check("2c. every redirect target and every hub/menu address is a registered route, R5's per-version downloads included", () => {
  assert.ok(routePaths.has("/payroll/downloads/:entityId/:month/:version"), "R5's downloads page is registered");
  assert.ok(routePaths.has(PAYROLL_PATHS.documents), "R6's statutory documents page is registered");
  assert.match(read("pages/payroll-hub-page.tsx"), /downloadsPath\(entityId, month, run\.version\)/, "a locked current month links its downloads from the hub");
  const targets = new Set([...OLD_PAYROLL_REDIRECTS.flatMap((r) => ALL_ROLES.map((role) => redirectTarget(r, SAMPLE_PARAMS, role))), ...PAYROLL_ENTRIES.map((e) => e.url)]);
  for (const target of targets) {
    const path = target.split("?")[0].replace(/^\/payroll\/people\/[^/]+$/, "/payroll/people/:employeeId");
    assert.ok(routePaths.has(path), `${target} is not a registered route`);
  }
});

await check("3. company payroll pages use the claim-aware read guard; the hub and own payslips keep their paths", () => {
  const payroll = routes.filter((r) => r.path.startsWith("/payroll"));
  assert.ok(payroll.length >= 8, `only ${payroll.length} payroll routes found`);
  for (const r of payroll) {
    assert.equal(r.roles, SELF_ROLE_LIST, `${r.path} authenticated roles`);
    if (r.path !== "/payroll" && r.path !== PAYROLL_PATHS.myPayslips) {
      const route = app.split("\n").find(line => line.includes(`path="${r.path}"`));
      assert.ok(route?.includes("<PayrollProtectedLayout component="), `${r.path} retains the claim-aware read guard`);
    }
  }
  assert.match(app, /<ProtectedRoute path="\/payroll" component=\{PayrollHome\}/);
  assert.match(app, /function PayrollHome\(\) \{\n {2}const \{ user \} = useAuth\(\);\n {2}if \(!canViewHrSalary\(user\)\) return <Redirect to=\{PAYROLL_PATHS\.myPayslips\} replace \/>;/,
    "below a payroll role /payroll is the person's own payslips");
});

await check("4. the DialogBody sweep over every payroll page and component", () => {
  const files = [
    ...readdirSync(join(CLIENT, "pages")).filter((f) => f.startsWith("payroll-") && f.endsWith(".tsx")).map((f) => `pages/${f}`),
    ...readdirSync(join(CLIENT, "components", "payroll")).filter((f) => f.endsWith(".tsx")).map((f) => `components/payroll/${f}`),
  ];
  assert.ok(files.length >= 9, `only ${files.length} payroll files found`);
  for (const file of files) {
    const source = read(file);
    const contents = (source.match(/<DialogContent\b/g) ?? []).length;
    const bodies = (source.match(/<DialogBody\b/g) ?? []).length;
    assert.ok(bodies >= contents, `${file}: ${contents} DialogContent, ${bodies} DialogBody`);
    assert.doesNotMatch(source, /<(SheetContent|DrawerContent|AlertDialogContent)\b/, `${file} opens a dialog outside the recipe`);
    assert.doesNotMatch(source, /from "@\/components\/ui\/(sheet|drawer|alert-dialog)"/, `${file} imports a dialog outside the recipe`);
  }
});

await check("5. the HR editor's Payroll tab: our gated pay fields, and a payroll profile link for payroll roles", () => {
  const editor = read("pages/employee-editor-page.tsx");
  const pane = editor.slice(editor.indexOf('data-testid="pane-payroll"'), editor.indexOf('data-testid="pane-payroll-records"'));
  assert.ok(pane.length > 0, "the Payroll pane was not found");
  assert.match(pane, /\{canViewSalary && !isNew && id && \(/, "the link is for payroll roles on a saved employee only");
  assert.match(pane, /href=\{`\/payroll\/people\/\$\{encodeURIComponent\(id\)\}`\}/);
  assert.match(pane, /name="defaultMergeData\.salaryThb"/, "the gated pay fields stay the editing surface");
  assert.doesNotMatch(pane, /payroll-prototype|employee-payroll-panel/, "no prototype payroll panel");
});

console.log(`payroll-cutover.check: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
