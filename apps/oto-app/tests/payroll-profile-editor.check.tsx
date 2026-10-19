// seed: none — no database, no server. Not a Playwright file.
//
// SCRUM-567 R2, the profile editor's "Proposed from HR data" panel on the
// page as written: the real PayrollPersonPage, react-query, wouter and the
// app's AuthProvider, rendered under jsdom with the API answered in-process
// (the shapes server/payroll/profiles.ts returns). Every "Use" button is
// clicked and the value must land in the form at once, show as "In the form",
// and stay there when the page's data is replaced by a changed refetch; a
// proposal the form already holds is marked rather than offered; and every
// field the server can propose has a landing (no silent no-op).
//
// Usage, from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/payroll-profile-editor.check.tsx
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/payroll/people/emp-1", pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Node", "Element", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "location", "history"]) {
  try { g[key] = (dom.window as unknown as Record<string, unknown>)[key]; } catch { /* read-only global */ }
}
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[key] = (dom.window as unknown as Record<string, (...a: unknown[]) => unknown>)[key].bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = ResizeObserverStub;
(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
(dom.window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
const quiet = console.log; console.log = (...args: unknown[]) => { if (!String(args[0]).startsWith("[auth-diag]")) quiet(...args); };

const ENTITY = "11111111-1111-4111-8111-111111111111";
const BRANCH = "branch-central";
const setup = {
  entities: [{ id: ENTITY, name: "ZZ Co.", country: "TH", operatorId: null, defaultPayDay: 28, archivedAt: null }],
  accounts: [],
  branches: [{ id: BRANCH, name: "ZZ Central", timezone: "Asia/Bangkok", detailsHistory: [{ id: "d1", effectiveFrom: "2025-01-01", foodAllowanceDefault: 60, reason: "x", who: "x", at: "x",
    details: { country: "TH", currency: "THB", payingEntityId: ENTITY, name: "ZZ Central", legalEntity: "", employerNumber: "", taxId: "", address: "", timezone: "Asia/Bangkok", payDate: 28, payrollBank: "", approvalChain: ["GM", "Owner"] } }] }],
  ruleSets: [], deductionLists: [], ewfSettings: [], ewfRemittances: [], revenueStreams: [], canManage: true,
};
const suggestions = [
  { field: "workerType", label: "Worker type", value: "monthly", source: "HR employment basis" },
  { field: "jobTitle", label: "Job title", value: "General Manager", source: "HR position title" },
  { field: "department", label: "Department", value: "Management", source: "HR department" },
  { field: "joinedOn", label: "Joining date", value: "2026-01-05", source: "HR start date" },
  { field: "monthlySalary", label: "Monthly salary", value: 85000, source: "HR contract salary" },
  { field: "dayRate", label: "Day rate", value: 900, source: "HR daily rate" },
  { field: "foodAllowancePerDay", label: "Food per day", value: 60, source: "HR food allowance" },
  { field: "taxId", label: "Tax ID", value: "1234567890123", source: "HR tax ID" },
  { field: "ssoNumber", label: "SSO number", value: "9876543210", source: "HR SSO number" },
  { field: "nationality", label: "Nationality", value: "Thai", source: "HR nationality" },
  { field: "bankDetails.bank", label: "Bank", value: "SCB", source: "Old payroll profile" },
  { field: "bankDetails.accountNumber", label: "Account number", value: "111-2-33333-4", source: "Old payroll profile" },
  { field: "bankDetails.accountName", label: "Account name", value: "ZZ GM", source: "Old payroll profile" },
  { field: "advance", label: "Salary advance outstanding", value: 4000, source: "Old advance" },
];
/** A needs-review draft as the server's draft action leaves it: identity only, no pay, no department. */
const draftProfile = {
  linkedEmployeeId: "emp-1", workerType: "monthly", jobTitle: "", monthlySalary: 0, dayRate: 0, fixedFee: 0, joinedOn: "", lastWorkingDay: null,
  taxId: "", ssoNumber: "", foodAllowanceEligible: true, foodAllowancePerDay: 0, ssoEligible: true, pnd1Eligible: true, serviceChargeEligible: true, otEligible: true,
  pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0, paymentMethod: "bank-transfer", bankDetails: { bank: "", accountNumber: "", accountName: "" }, thirdPartyReason: "",
  allocations: [{ effectiveFrom: "2026-01-05", homeBranchId: BRANCH, lines: [{ costCentre: BRANCH, percent: 100, entityId: ENTITY, payingAccountId: null }] }],
  studentLoanMonthly: 0, advances: [], separatePayments: [], notes: "",
};
const view = (profile: unknown) => ({
  employee: { id: "emp-1", name: "ZZ GM", branchId: BRANCH, branchName: "ZZ Central", employmentState: "ACTIVE", startDate: "2026-01-05" },
  profile, reviewState: profile ? "needs-review" : null, revision: 0, suggestions, validationErrors: [], warnings: [], readiness: null, changes: [], canManage: true,
});
let currentView: unknown = view(draftProfile);
let viewFetches = 0;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
g.fetch = async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input).replace("http://localhost", "");
  if (url === "/api/user") return json({ id: "u1", role: "admin", fullName: "ZZ Admin", email: "zz@example.com", branchAccess: [] });
  if (url === "/api/payroll/setup") return json(setup);
  if (url.startsWith("/api/payroll/profiles/emp-1")) { viewFetches++; return json(currentView); }
  return json({});
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { Router } = await import("wouter");
const { queryClient } = await import("../client/src/lib/queryClient");
const { AuthProvider } = await import("../client/src/hooks/use-auth");
const { default: PayrollPersonPage } = await import("../client/src/pages/payroll-person-page");

const settle = async (ms = 30) => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const byLabel = (label: string) => dom.window.document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
const inputUnder = (label: string) => {
  for (const el of Array.from(dom.window.document.querySelectorAll("label"))) {
    if (el.textContent?.trim().startsWith(label)) return el.parentElement?.querySelector("input, select") as HTMLInputElement | null;
  }
  return null;
};

let passed = 0;
const { PROPOSAL_FIELDS, applyProposal } = await import("../client/src/pages/payroll-person-page");
const { readFileSync } = await import("node:fs");

// ── The sweep: every field the server can propose has a landing in the form ──
const serverSource = readFileSync(new URL("../server/payroll/profiles.ts", import.meta.url), "utf8");
const proposed = [...serverSource.matchAll(/add\("([a-zA-Z.]+)",/g)].map((m) => m[1]);
assert.ok(proposed.length >= 14, "the server's proposal list was read");
for (const field of proposed) assert.ok((PROPOSAL_FIELDS as readonly string[]).includes(field), `proposal ${field} has no landing in the form`);
assert.throws(() => applyProposal({} as never, "notAField", "x"), /Unknown proposal field/, "an unknown proposal is refused, never ignored");
passed += 2;

const PANEL_FIELDS = suggestions.map((s) => s.field);
const formValues = (host: HTMLElement) => {
  const q = (sel: string) => (host.querySelector(sel) as HTMLInputElement | null)?.value;
  return {
    jobTitle: q("[data-testid=input-job-title]"), department: q("[data-testid=input-department]"),
    joinedOn: inputUnder("Joining date")?.value,
    monthlySalary: byLabel("Monthly salary")?.value, dayRate: byLabel("Day rate")?.value, food: byLabel("Food per day")?.value,
    taxId: inputUnder("Tax ID")?.value, sso: inputUnder("SSO number")?.value, nationality: inputUnder("Nationality")?.value,
    bank: inputUnder("Bank")?.value, accountNumber: inputUnder("Account number")?.value, accountName: inputUnder("Account name")?.value,
    advance: byLabel("Principal")?.value,
  };
};
const EVERYTHING = {
  jobTitle: "General Manager", department: "Management", joinedOn: "2026-01-05",
  monthlySalary: "85000", dayRate: "900", food: "60", taxId: "1234567890123", sso: "9876543210", nationality: "Thai",
  bank: "SCB", accountNumber: "111-2-33333-4", accountName: "ZZ GM", advance: "4000",
};

async function scenario(name: string, profile: unknown, expectInFormAtStart: string[]) {
  currentView = view(profile);
  queryClient.clear();
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(AuthProvider, null, React.createElement(Router, { ssrPath: "/payroll/people/emp-1" }, React.createElement(PayrollPersonPage)))));
  });
  await settle();
  const inForm = () => PANEL_FIELDS.filter((f) => host.querySelector(`[data-testid="proposal-in-form-${f}"]`));
  const useButton = (f: string) => host.querySelector(`[data-testid="button-use-${f}"]`) as HTMLButtonElement | null;
  // A proposal the form already holds says so; every other one offers a live Use.
  assert.deepEqual(inForm(), expectInFormAtStart, `${name}: proposals already in the form are marked, not offered`);
  for (const f of PANEL_FIELDS) assert.ok(expectInFormAtStart.includes(f) || useButton(f), `${name}: ${f} offers Use`);
  passed += 2;
  // Click every Use; each must land at once and turn into "In the form".
  for (const f of PANEL_FIELDS) {
    const button = useButton(f);
    if (!button) continue;
    await act(async () => { button.click(); });
    await settle(5);
    assert.ok(!useButton(f) && inForm().includes(f), `${name}: Use on ${f} landed in the form`);
    passed++;
  }
  assert.deepEqual(formValues(host), EVERYTHING, `${name}: every proposal is in the form`);
  // The data the page holds is replaced (a refetch with a changed answer under the same profile state,
  // here new timeline rows and a renamed entity): nothing taken from a proposal is thrown away.
  await act(async () => {
    queryClient.setQueryData(["/api/payroll/profiles", "emp-1"], { ...(currentView as object), changes: [{ id: "c1", kind: "setup", subject: "x", subjectId: null, reason: "x", who: "x", at: new Date().toISOString(), oldValue: null, newValue: null }] });
    queryClient.setQueryData(["/api/payroll/setup"], { ...setup, entities: setup.entities.map((e) => ({ ...e, name: "ZZ Co. renamed" })) });
  });
  await settle();
  await act(async () => { await queryClient.invalidateQueries(); });
  await settle();
  assert.deepEqual(formValues(host), EVERYTHING, `${name}: a changed refetch keeps every applied value`);
  passed += 2;
  await act(async () => root.unmount());
  host.remove();
}

// A needs-review draft that left identity empty: everything is offered except the worker type it
// already holds (monthly) — before this fix that row offered a Use that could only change nothing.
await scenario("a needs-review draft", draftProfile, ["workerType"]);
// No profile yet: the form starts from HR identity (as the draft action does), so those proposals
// are already in the form — the fault behind "Use does nothing" and the blank Department — and pay is offered.
// The branch's food default (60) and the account name (the employee's name) already match theirs too.
await scenario("no profile yet", null, ["workerType", "jobTitle", "department", "joinedOn", "foodAllowancePerDay", "taxId", "ssoNumber", "nationality", "bankDetails.accountName"]);
assert.ok(viewFetches >= 4, "the page did refetch during the run");
passed++;
console.log = quiet;
console.log(`payroll-profile-editor.check: ${passed} checks passed`);
process.exit(0);
