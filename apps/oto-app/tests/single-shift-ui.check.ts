// seed: none — every HTTP reply is local synthetic data (ZZ TEST people and
// amounts). Not a Playwright file: it renders the real Invite a Former Employee
// dialog of the schedule (client/src/components/scheduling/SingleShiftInviteDialog.tsx)
// under jsdom, with the app's real query client, dialog and radio group.
//
// SCRUM-1038 — the scheduling control and the pay choice:
//
//   1. The dialog lists the branch's former employees; the pay starts "On the
//      old contract"; inviting one sends that shift and day, the old contract
//      and no rate.
//   2. "Casual day rate" is shown, disabled, with its line (the owner's N1 is
//      open): a click leaves the old contract; the POST carries no rate.
//   3. A single shift already on this shift is listed with how it is paid, and
//      no figure. "Change pay" cannot switch it to a casual day rate; one
//      stored on a casual day rate before the hold is switched back to the
//      old contract (PATCH), and nothing else is saved.
//   4. Nobody is locked out by a rule of the dialog's own: somebody already on
//      a single shift that day can be picked (the schedule's checks decide).
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/single-shift-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { NO_PAYROLL_PROFILE_HINT, SINGLE_SHIFT_REFUSALS } from "../shared/singleShift";

const app = fileURLToPath(new URL("../", import.meta.url));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/scheduling", pretendToBeVisual: true });
const g = globalThis as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- jsdom's globals are put on Node's by name
const win = dom.window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- as above
const testTimers = new Set<ReturnType<typeof setTimeout>>();
const nativeSetTimeout = globalThis.setTimeout;
g.setTimeout = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  const timer = nativeSetTimeout(() => { testTimers.delete(timer); callback(...args); }, delay);
  testTimers.add(timer);
  return timer;
};
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history"]) {
  try { g[key] = win[key]; } catch { /* Node exposes a read-only navigator. */ }
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

const built = buildSync({
  absWorkingDir: app, bundle: true, platform: "node", format: "cjs", packages: "external", write: false,
  tsconfig: app + "tests/tsconfig.jsx.json", define: { "import.meta.env": "{}" }, logLevel: "silent",
  stdin: { resolveDir: app, loader: "tsx", contents: `
    export * as React from 'react'; export { act } from 'react';
    export { createRoot } from 'react-dom/client';
    export { QueryClientProvider } from '@tanstack/react-query';
    export { queryClient } from './client/src/lib/queryClient';
    export { SingleShiftInviteDialog } from './client/src/components/scheduling/SingleShiftInviteDialog';
  ` },
});
const require = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(app + "tests/single-shift-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Node's Module internals are untyped
compiled.filename = app + "tests/single-shift-ui.native.cjs";
compiled.paths = require.resolve.paths("react");
compiled._compile(built.outputFiles[0]!.text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, SingleShiftInviteDialog } = compiled.exports;

const BRANCH = "b0000000-0000-4000-8000-000000000001";
const ROW = "r0000000-0000-4000-8000-000000000001";
const DAY = "2026-12-02";
const NOK = "e0000000-0000-4000-8000-00000000000a";
const PIM = "e0000000-0000-4000-8000-00000000000b";
type Shift = Record<string, unknown> & { id: string; employeeId: string; payWay: string; casualDayRate: number | null };
let former: { id: string; name: string; lastWorkingDay: string | null; payrollProfile: boolean }[] = [];
let shifts: Shift[] = [];
let writes: Array<{ method: string; path: string; body: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON body read field by field

const label = (way: string, rate: number | null) => (way === "casual_day_rate" ? `Casual day rate ฿${rate!.toLocaleString("en-US")} a day` : "On the old contract");
const shift = (id: string, employeeId: string, name: string, way: string, rate: number | null): Shift => ({
  id, assignmentId: `a-${id}`, employeeId, employeeName: name, shiftRowId: ROW, shiftDate: DAY, payWay: way, casualDayRate: rate,
  payLabel: label(way, rate), invitedBy: "ZZ TEST manager", invitedAt: "2026-11-19T03:00:00.000Z",
  changedBy: "ZZ TEST manager", changedAt: "2026-11-19T03:00:00.000Z",
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "LOCAL_HTTP_ONLY");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  if (method === "GET" && url.pathname === "/api/schedule/single-shift/former-employees") {
    assert.equal(url.searchParams.get("branchId"), BRANCH);
    return json(former);
  }
  if (method === "GET" && url.pathname === "/api/schedule/single-shift/invitations") {
    assert.deepEqual([url.searchParams.get("branchId"), url.searchParams.get("startDate"), url.searchParams.get("endDate")], [BRANCH, DAY, DAY]);
    return json(shifts);
  }
  if (method === "POST" && url.pathname === "/api/schedule/single-shift/invitations") {
    writes.push({ method, path: url.pathname, body });
    const person = former.find((p) => p.id === body.employeeId)!;
    const made = shift(`s-${shifts.length + 1}`, person.id, person.name, body.payWay, body.casualDayRate);
    shifts = [...shifts, made];
    return json(made, 201);
  }
  if (method === "PATCH" && url.pathname.startsWith("/api/schedule/single-shift/invitations/")) {
    writes.push({ method, path: url.pathname, body });
    const id = url.pathname.split("/").at(-1)!;
    shifts = shifts.map((s) => (s.id === id ? { ...s, payWay: body.payWay, casualDayRate: body.casualDayRate, payLabel: label(body.payWay, body.casualDayRate) } : s));
    return json(shifts.find((s) => s.id === id));
  }
  throw new Error(`UNKNOWN_LOCAL_HTTP ${method} ${url.pathname}`);
};

const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((yes) => setTimeout(yes, 8)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const found = byTestId(id); assert.ok(found, `missing ${id}`); return found!; };
const button = (text: string) => {
  const found = [...doc.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `no button ${text}`);
  return found as HTMLButtonElement;
};
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); await settle(); };
const fill = async (id: string, value: string) => {
  const input = doc.getElementById(id) as HTMLInputElement;
  assert.ok(input, `no input ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
};
const checked = (id: string) => required(id).getAttribute("aria-checked") === "true";

let root: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- React's root, from the compiled module
let host: HTMLDivElement | null = null;
async function mount() {
  writes = [];
  queryClient.clear();
  host = doc.createElement("div");
  doc.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(SingleShiftInviteDialog, {
      open: true, onOpenChange: () => {}, branchId: BRANCH, shiftRowId: ROW, date: DAY,
      weekStartFormatted: "2026-11-30", shiftLabel: "ZZ TEST Morning", shiftTime: "09:00 - 15:00", departmentName: "ZZ TEST Floor",
    }))));
  await settle();
}
async function unmount() {
  if (root) await act(async () => root.unmount());
  root = null;
  host?.remove();
  host = null;
  queryClient.clear();
  await settle(1);
}

const cases: Record<string, () => Promise<void>> = {
  "lists the former employees; the pay starts on the old contract; inviting sends the shift, the day and no rate": async () => {
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01", payrollProfile: true }, { id: PIM, name: "ZZ Pim", lastWorkingDay: null, payrollProfile: true }];
    shifts = [];
    await mount();
    assert.ok(doc.body.textContent!.includes("Invite a Former Employee"));
    assert.ok(required(`button-single-shift-${NOK}`).textContent!.includes("Left after 2026-11-01"));
    assert.equal(checked("single-shift-invite-old-contract"), true);
    assert.equal(byTestId("single-shift-invite-rate"), null, "no rate on the old contract");
    assert.equal((required("button-single-shift-invite") as HTMLButtonElement).disabled, true, "nobody picked yet");
    await click(required(`button-single-shift-${NOK}`));
    await click(required("button-single-shift-invite"));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]!.body, { employeeId: NOK, shiftRowId: ROW, shiftDate: DAY, payWay: "old_contract", casualDayRate: null });
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "On the old contract");
  },
  // The owner's N1 is open: the casual day rate is shown, disabled, with its line, and cannot be chosen.
  "the casual day rate is shown but cannot be chosen, with its line; a click leaves the old contract; the invite goes on the old contract": async () => {
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01", payrollProfile: true }];
    shifts = [];
    await mount();
    const casual = required("single-shift-invite-casual") as HTMLButtonElement;
    assert.equal(casual.disabled, true, "the choice is disabled");
    assert.equal(required("single-shift-invite-casual-held").textContent, SINGLE_SHIFT_REFUSALS.casualHeld);
    await click(required(`button-single-shift-${NOK}`));
    await click(casual);
    assert.equal(checked("single-shift-invite-casual"), false);
    assert.equal(checked("single-shift-invite-old-contract"), true);
    assert.equal(byTestId("single-shift-invite-rate"), null, "no rate asked for");
    await click(required("button-single-shift-invite"));
    assert.deepEqual(writes.map((w) => [w.method, w.body.payWay, w.body.casualDayRate]), [["POST", "old_contract", null]]);
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "On the old contract");
  },
  "a shift already made shows how it is paid and no figure; Change pay cannot switch it to the casual day rate": async () => {
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01", payrollProfile: true }];
    shifts = [shift("s-1", NOK, "ZZ Nok", "old_contract", null)];
    await mount();
    assert.ok(doc.body.textContent!.includes("Single shift · former employee"));
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "On the old contract");
    assert.equal(byTestId(`single-shift-amount-${NOK}`), null);
    assert.doesNotMatch(doc.body.textContent!, /for the shift|÷/);
    await click(button("Change pay"));
    const casual = required(`single-shift-change-${NOK}-casual`) as HTMLButtonElement;
    assert.equal(casual.disabled, true, "the choice is disabled");
    assert.equal(required(`single-shift-change-${NOK}-casual-held`).textContent, SINGLE_SHIFT_REFUSALS.casualHeld);
    await click(casual);
    assert.equal(checked(`single-shift-change-${NOK}-old-contract`), true, "stays on the old contract");
    assert.equal(byTestId(`single-shift-change-${NOK}-rate`), null, "no rate asked for");
    assert.deepEqual(writes, [], "nothing sent");
  },
  "the casual way shows its rate and no figure; somebody already on a single shift that day can still be picked": async () => {
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01", payrollProfile: true }, { id: PIM, name: "ZZ Pim", lastWorkingDay: null, payrollProfile: true }];
    shifts = [shift("s-1", NOK, "ZZ Nok", "casual_day_rate", 900)];
    await mount();
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "Casual day rate ฿900 a day");
    assert.equal(byTestId(`single-shift-amount-${NOK}`), null);
    assert.equal((required(`button-single-shift-${NOK}`) as HTMLButtonElement).disabled, false);
    assert.equal((required(`button-single-shift-${PIM}`) as HTMLButtonElement).disabled, false);
    assert.equal(required(`button-single-shift-${NOK}`).textContent, "ZZ NokLeft after 2026-11-01");
  },
  // SCRUM-1055: a reader below the salary roles gets the casual way in words, the rate withheld by the server.
  "the casual way without its rate, as a manager reads it: the words alone; Change pay opens on it and saves the old contract only": async () => {
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01", payrollProfile: true }];
    shifts = [{ ...shift("s-1", NOK, "ZZ Nok", "casual_day_rate", 900), casualDayRate: null, payLabel: "Casual day rate" }];
    await mount();
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "Casual day rate");
    assert.doesNotMatch(doc.body.textContent!, /฿/);
    await click(button("Change pay"));
    assert.equal(checked(`single-shift-change-${NOK}-casual`), true, "opens on the way it is paid now");
    assert.equal((required(`single-shift-change-${NOK}-rate`) as HTMLInputElement).value, "", "no rate to show");
    assert.equal(button("Save pay").disabled, true, "the casual way is not saved again");
    await click(required(`single-shift-change-${NOK}-old-contract`));
    assert.equal(button("Save pay").disabled, false);
    await click(button("Save pay"));
    assert.deepEqual(writes.at(-1), { method: "PATCH", path: "/api/schedule/single-shift/invitations/s-1", body: { payWay: "old_contract", casualDayRate: null } });
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "On the old contract");
  },
  // SCRUM-1055: payroll pays the old contract from the payroll profile; without one it cannot.
  "a former employee with no payroll profile is marked, and the old contract says payroll cannot pay it yet": async () => {
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01", payrollProfile: false }, { id: PIM, name: "ZZ Pim", lastWorkingDay: null, payrollProfile: true }];
    shifts = [];
    await mount();
    assert.equal(required(`button-single-shift-${NOK}`).textContent, "ZZ NokLeft after 2026-11-01 · no payroll profile");
    assert.equal(required(`button-single-shift-${PIM}`).textContent, "ZZ PimLeft");
    assert.equal(byTestId("single-shift-no-payroll-profile"), null, "nobody picked yet");
    await click(required(`button-single-shift-${NOK}`));
    assert.equal(required("single-shift-no-payroll-profile").textContent, NO_PAYROLL_PROFILE_HINT);
    await click(required("single-shift-invite-casual"));
    assert.equal(required("single-shift-no-payroll-profile").textContent, NO_PAYROLL_PROFILE_HINT, "the casual day rate cannot take it away");
    await click(required(`button-single-shift-${PIM}`));
    assert.equal(byTestId("single-shift-no-payroll-profile"), null, "not for somebody payroll has a profile for");
  },
};

let passed = 0;
for (const [name, runCase] of Object.entries(cases)) {
  try {
    await runCase();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAILED  ${name}\n`, error);
  } finally {
    await unmount();
  }
}
for (const timer of testTimers) clearTimeout(timer);
console.log(`single-shift-ui.check: ${passed} of ${Object.keys(cases).length} checks passed`);
if (passed !== Object.keys(cases).length) process.exitCode = 1;
