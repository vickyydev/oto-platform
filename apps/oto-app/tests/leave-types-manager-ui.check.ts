// seed: none — every HTTP reply is local synthetic data (ZZ TEST types). Not a
// Playwright file: it renders the real Leave Types card of the policies page
// (client/src/components/leave/leave-types-manager.tsx) under jsdom, with the
// app's real query client, dialog and switch.
//
// SCRUM-1037 — the "Managers only" setting on the leave types screen:
//
//   1. Each type's row says who it is for beside "Active": "Managers only" or
//      "Staff can see".
//   2. Editing a type shows the setting as it is saved and saves the change:
//      switched on, the PATCH carries managersOnly true; switched off, false;
//      nothing else about the type changes.
//   3. A new type starts seen by staff, as every new type did; switched on
//      before it is made, the POST carries managersOnly true.
//   4. A switched-off type shows "Disabled" and no audience badge beside it
//      (it is offered to nobody); switched on again, its audience is back,
//      and a managers-only type keeps its setting meanwhile.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/leave-types-manager-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const app = fileURLToPath(new URL("../", import.meta.url));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/policies", pretendToBeVisual: true });
const g = globalThis as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- jsdom's globals are put on Node's by name
const win = dom.window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- as above
// Toast and query retention timers run normally; disposed at the end.
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

// The real modules, compiled in memory with only Vite's build-time env defined.
const built = buildSync({
  absWorkingDir: app, bundle: true, platform: "node", format: "cjs", packages: "external", write: false,
  tsconfig: app + "tests/tsconfig.jsx.json", define: { "import.meta.env": "{}" }, logLevel: "silent",
  stdin: { resolveDir: app, loader: "tsx", contents: `
    export * as React from 'react'; export { act } from 'react';
    export { createRoot } from 'react-dom/client';
    export { QueryClientProvider } from '@tanstack/react-query';
    export { queryClient } from './client/src/lib/queryClient';
    export { LeaveTypesManager } from './client/src/components/leave/leave-types-manager';
  ` },
});
const require = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(app + "tests/leave-types-manager-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Node's Module internals are untyped
compiled.filename = app + "tests/leave-types-manager-ui.native.cjs";
compiled.paths = require.resolve.paths("react");
compiled._compile(built.outputFiles[0]!.text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, LeaveTypesManager } = compiled.exports;

type Type = {
  id: string; code: string; name: string; isActive: boolean; managersOnly: boolean; accrualMethod: string;
  annualDays: number; waitingMonths: number; prorateByStartDate: boolean; daysWorkedRequired: number; daysOffEarned: number;
};
const type = (id: string, code: string, name: string, managersOnly: boolean): Type => ({
  id, code, name, isActive: true, managersOnly, accrualMethod: "YEARLY",
  annualDays: 6, waitingMonths: 0, prorateByStartDate: false, daysWorkedRequired: 0, daysOffEarned: 0,
});
const ANNUAL_ID = "11111111-1111-4111-8111-111111111111";
const SICK_ID = "22222222-2222-4222-8222-222222222222";
let types: Type[] = [];
let writes: Array<{ method: string; path: string; body: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON body read field by field

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "LOCAL_HTTP_ONLY");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  if (method === "GET" && url.pathname === "/api/leave-types") return json(types);
  if (method === "PATCH" && url.pathname.startsWith("/api/leave-types/")) {
    writes.push({ method, path: url.pathname, body });
    const id = url.pathname.slice("/api/leave-types/".length);
    types = types.map((t) => (t.id === id ? { ...t, ...body } : t));
    return json(types.find((t) => t.id === id));
  }
  if (method === "POST" && url.pathname === "/api/leave-types") {
    writes.push({ method, path: url.pathname, body });
    const made = { ...type("33333333-3333-4333-8333-333333333333", body.code, body.name, body.managersOnly), ...body };
    types = [...types, made];
    return json(made, 201);
  }
  throw new Error(`UNKNOWN_LOCAL_HTTP ${method} ${url.pathname}`);
};

const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((yes) => setTimeout(yes, 8)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const found = byTestId(id); assert.ok(found, `missing ${id}`); return found!; };
const button = (label: string) => {
  const found = [...doc.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
  assert.ok(found, `no button ${label}`);
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
const switchOn = () => required("switch-leave-type-managers-only").getAttribute("aria-checked") === "true";

let root: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- React's root, from the compiled module
let host: HTMLDivElement | null = null;
async function mount() {
  types = [type(ANNUAL_ID, "ANNUAL", "Annual Leave", false), type(SICK_ID, "SICK", "Sick Leave", true)];
  writes = [];
  queryClient.clear();
  host = doc.createElement("div");
  doc.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(LeaveTypesManager))));
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
  "each row says who the type is for, beside Active: Managers only, or Staff can see": async () => {
    assert.equal(required("leave-type-audience-SICK").textContent, "Managers only");
    assert.equal(required("leave-type-audience-ANNUAL").textContent, "Staff can see");
    // Beside the Active badge, in the same row.
    const sickRow = required("leave-type-SICK");
    assert.ok(sickRow.textContent!.includes("Active"));
    assert.ok(sickRow.contains(required("leave-type-audience-SICK")));
  },
  "editing shows the saved setting and saves it switched on; nothing else about the type changes": async () => {
    await click(button("Edit Annual Leave"));
    assert.ok(doc.body.textContent!.includes("Staff do not see this leave type. A manager records it for them."));
    assert.equal(switchOn(), false);
    await click(required("switch-leave-type-managers-only"));
    assert.equal(switchOn(), true);
    await click(button("Save changes"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.method, "PATCH");
    assert.equal(writes[0]!.path, `/api/leave-types/${ANNUAL_ID}`);
    assert.equal(writes[0]!.body.managersOnly, true);
    assert.deepEqual(
      { ...writes[0]!.body, managersOnly: undefined },
      { code: "ANNUAL", name: "Annual Leave", isActive: true, managersOnly: undefined, accrualMethod: "YEARLY", annualDays: 6, waitingMonths: 0, prorateByStartDate: false, daysWorkedRequired: 0, daysOffEarned: 0 },
    );
    assert.equal(required("leave-type-audience-ANNUAL").textContent, "Managers only");
  },
  "a managers-only type opens switched on and saves switched off": async () => {
    await click(button("Edit Sick Leave"));
    assert.equal(switchOn(), true);
    await click(required("switch-leave-type-managers-only"));
    await click(button("Save changes"));
    assert.deepEqual([writes[0]!.path, writes[0]!.body.managersOnly], [`/api/leave-types/${SICK_ID}`, false]);
    assert.equal(required("leave-type-audience-SICK").textContent, "Staff can see");
  },
  "a switched-off type shows Disabled and no audience; switched on again, its audience is back": async () => {
    await click(button("Disable Annual Leave"));
    assert.deepEqual([writes[0]!.method, writes[0]!.path, writes[0]!.body], ["PATCH", `/api/leave-types/${ANNUAL_ID}`, { isActive: false }]);
    const annualRow = required("leave-type-ANNUAL");
    assert.ok(annualRow.textContent!.includes("Disabled"));
    assert.equal(byTestId("leave-type-audience-ANNUAL"), null);
    assert.ok(!annualRow.textContent!.includes("Staff can see"));
    // The type still switched on is unchanged.
    assert.equal(required("leave-type-audience-SICK").textContent, "Managers only");
    await click(button("Enable Annual Leave"));
    assert.equal(required("leave-type-audience-ANNUAL").textContent, "Staff can see");
  },
  "a switched-off managers-only type shows no audience either; its setting is kept for when it is switched on": async () => {
    await click(button("Disable Sick Leave"));
    assert.ok(required("leave-type-SICK").textContent!.includes("Disabled"));
    assert.equal(byTestId("leave-type-audience-SICK"), null);
    assert.ok(!required("leave-type-SICK").textContent!.includes("Managers only"));
    await click(button("Edit Sick Leave"));
    assert.equal(switchOn(), true);
  },
  "a new type starts seen by staff; switched on before it is made, the POST says managers only": async () => {
    await click(button("Add leave type"));
    assert.equal(switchOn(), false);
    await fill("leave-type-name", "ZZ TEST Exam Leave");
    await click(required("switch-leave-type-managers-only"));
    await click(button("Create leave type"));
    assert.equal(writes.length, 1);
    assert.deepEqual([writes[0]!.method, writes[0]!.body.code, writes[0]!.body.managersOnly], ["POST", "ZZ_TEST_EXAM_LEAVE", true]);
    assert.equal(required("leave-type-audience-ZZ_TEST_EXAM_LEAVE").textContent, "Managers only");
  },
};

let passed = 0;
for (const [name, run] of Object.entries(cases)) {
  try {
    await mount();
    await run();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAILED  ${name}\n`, error);
  } finally {
    await unmount();
  }
}
for (const timer of testTimers) clearTimeout(timer);
console.log(`leave-types-manager-ui.check: ${passed} of ${Object.keys(cases).length} checks passed`);
if (passed !== Object.keys(cases).length) process.exitCode = 1;
