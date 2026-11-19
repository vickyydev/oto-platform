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
//   2. Switched to "Casual day rate", the rate is asked for: no invite until a
//      whole number is typed; then the POST carries the casual day rate.
//   3. A single shift already on this shift is listed with how it is paid; a
//      payroll role's view shows what it is worth. "Change pay" switches it to
//      a casual day rate (PATCH with the rate) and back to the old contract.
//   4. Somebody who already has a single shift that day cannot be picked again.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/single-shift-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

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
let former: { id: string; name: string; lastWorkingDay: string | null }[] = [];
let shifts: Shift[] = [];
let writes: Array<{ method: string; path: string; body: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON body read field by field

const label = (way: string, rate: number | null) => (way === "casual_day_rate" ? `Casual day rate ฿${rate!.toLocaleString("en-US")} a day` : "On the old contract");
const shift = (id: string, employeeId: string, name: string, way: string, rate: number | null, pay?: { amount: number | null; formula: string }): Shift => ({
  id, assignmentId: `a-${id}`, employeeId, employeeName: name, shiftRowId: ROW, shiftDate: DAY, payWay: way, casualDayRate: rate,
  payLabel: label(way, rate), ...(pay ? { pay } : {}), invitedBy: "ZZ TEST manager", invitedAt: "2026-11-19T03:00:00.000Z",
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
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01" }, { id: PIM, name: "ZZ Pim", lastWorkingDay: null }];
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
  "a casual day rate asks for the rate, whole baht, before the invite goes; then sends it": async () => {
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01" }];
    shifts = [];
    await mount();
    await click(required(`button-single-shift-${NOK}`));
    await click(required("single-shift-invite-casual"));
    assert.equal(checked("single-shift-invite-casual"), true);
    required("single-shift-invite-rate");
    assert.equal((required("button-single-shift-invite") as HTMLButtonElement).disabled, true, "no rate yet");
    await fill("single-shift-invite-rate", "950.5");
    assert.equal((required("button-single-shift-invite") as HTMLButtonElement).disabled, true, "not whole baht");
    await fill("single-shift-invite-rate", "1200");
    await click(required("button-single-shift-invite"));
    assert.deepEqual(writes.map((w) => [w.method, w.body.payWay, w.body.casualDayRate]), [["POST", "casual_day_rate", 1200]]);
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "Casual day rate ฿1,200 a day");
  },
  "a shift already made shows its pay and, for a payroll role, its figure; Change pay switches both ways": async () => {
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01" }];
    shifts = [shift("s-1", NOK, "ZZ Nok", "old_contract", null, { amount: 500, formula: "Monthly salary ฿15,000 ÷ 30 × 1 shift" })];
    await mount();
    assert.ok(doc.body.textContent!.includes("Single shift · former employee"));
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "On the old contract");
    assert.equal(required(`single-shift-amount-${NOK}`).textContent, "฿500 for the shift (Monthly salary ฿15,000 ÷ 30 × 1 shift)");
    await click(button("Change pay"));
    await click(required(`single-shift-change-${NOK}-casual`));
    await fill(`single-shift-change-${NOK}-rate`, "1100");
    await click(button("Save pay"));
    assert.deepEqual(writes.at(-1), { method: "PATCH", path: "/api/schedule/single-shift/invitations/s-1", body: { payWay: "casual_day_rate", casualDayRate: 1100 } });
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "Casual day rate ฿1,100 a day");
    await click(button("Change pay"));
    assert.equal(checked(`single-shift-change-${NOK}-casual`), true, "opens on the way it is paid now");
    await click(required(`single-shift-change-${NOK}-old-contract`));
    await click(button("Save pay"));
    assert.deepEqual(writes.at(-1)!.body, { payWay: "old_contract", casualDayRate: null });
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "On the old contract");
  },
  "a manager's view shows the way and no figure; somebody already on a single shift that day cannot be picked again": async () => {
    former = [{ id: NOK, name: "ZZ Nok", lastWorkingDay: "2026-11-01" }, { id: PIM, name: "ZZ Pim", lastWorkingDay: null }];
    shifts = [shift("s-1", NOK, "ZZ Nok", "casual_day_rate", 900)];
    await mount();
    assert.equal(required(`single-shift-pay-${NOK}`).textContent, "Casual day rate ฿900 a day");
    assert.equal(byTestId(`single-shift-amount-${NOK}`), null);
    assert.equal((required(`button-single-shift-${NOK}`) as HTMLButtonElement).disabled, true);
    assert.equal((required(`button-single-shift-${PIM}`) as HTMLButtonElement).disabled, false);
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
