// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the BEO's real Day-of view under
// jsdom with React, react-query and Radix as the app builds them.
//
// SCRUM-1050 — an automatic step of the one timeline can be ticked on the Day-of
// view straight away, without waiting for the BEO's next Save to store its row:
//
//   1. a step the timeline makes that no Save stored yet (the kids' menu's time,
//      set after the last Save) shows its tick; pressed, it asks the server to
//      store its row under the step's own source key, ticked
//      (POST /api/events/:eventId/beo/timeline/steps/:key/complete; the route and
//      the generator's next Save are tests/beo-timeline-rows.check.ts); the view
//      reads the timeline again and shows it ticked;
//   2. a stored step and a typed row tick through their row as before;
//   3. a step with no stored row offers no delete (there is no row to remove).
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-day-of-tick-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const APP = fileURLToPath(new URL("../", import.meta.url));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/studio/events", pretendToBeVisual: true });
/* eslint-disable @typescript-eslint/no-explicit-any -- the jsdom globals and the compiled bundle's exports are read untyped */
const g = globalThis as Record<string, any>;
const win = dom.window as unknown as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLFormElement", "HTMLTextAreaElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history", "localStorage", "sessionStorage"]) {
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

const built = buildSync({
  absWorkingDir: APP,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  write: false,
  tsconfig: APP + "tests/tsconfig.jsx.json",
  define: { "import.meta.env": "{}", "import.meta.env.DEV": "false", "import.meta.env.MODE": '"test"' },
  logLevel: "silent",
  stdin: {
    resolveDir: APP,
    loader: "tsx",
    contents: `
      export * as React from 'react';
      export { act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { QueryClientProvider } from '@tanstack/react-query';
      export { queryClient } from './client/src/lib/queryClient';
      export { AuthContext } from './client/src/hooks/use-auth';
      export { BeoDayOfView } from './client/src/components/beo/beo-day-of-view';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/beo-day-of-tick-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/beo-day-of-tick-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, BeoDayOfView } = compiled.exports;

// ─── The server, as the view sees it ─────────────────────────────────────────

const EVENT = "11111111-1111-4111-8111-000000001050";
type Asked = { method: string; path: string };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Step = { key: string; time: string; minuteOfDay: number; kind: string; label: string; detail: null; person: null; assignedToType: string; generated: boolean; rowId: string | null; isCompleted: boolean };
const step = (key: string, time: string, label: string, o: Partial<Step> = {}): Step => {
  const [h, m] = time.split(":").map(Number);
  return { key, time, minuteOfDay: h! * 60 + m!, kind: "party", label, detail: null, person: null, assignedToType: "PARTY_HOST", generated: true, rowId: null, isCompleted: false, ...o };
};
/** The timeline as the server makes it: the kids' menu's step not stored until it is ticked. */
const steps: Step[] = [
  step("guests_arrive", "13:00", "Guests arrive", { rowId: "row-arrive" }),
  step("kids_food", "13:30", "Kids' menu served", { kind: "food", assignedToType: "KITCHEN_RESPONSIBLE" }),
  step("row:row-typed", "14:00", "ZZ TEST pinata", { kind: "other", generated: false, rowId: "row-typed" }),
];
const beo = {
  id: EVENT, title: "ZZ TEST 1050", eventDate: "2099-03-14", startTime: "13:00", endTime: "16:00", numChildren: 10, numAdults: 4,
  branchId: "33333333-3333-4333-8333-333333333333", eventType: "birthday",
  kitchenPlan: { foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null, menus: { kids: [], adults: [], kidsFoodTime: "13:30" }, serviceSchedule: [] },
  setupPlan: null, barPlan: null, partyDetails: null, partyHost: null, timeline: [], beoTasks: [],
};
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the view asks only its own server");
  const method = init?.method ?? "GET";
  asked.push({ method, path: url.pathname });
  if (url.pathname === `/api/events/${EVENT}/beo` && method === "GET") return json(beo);
  if (url.pathname === `/api/events/${EVENT}/beo/timeline/built`) return json({ steps, untimed: [] });
  const made = new RegExp(`^/api/events/${EVENT}/beo/timeline/steps/([^/]+)/complete$`).exec(url.pathname);
  if (made && method === "POST") {
    const s = steps.find((x) => x.key === decodeURIComponent(made[1]!))!;
    s.rowId = "row-kids";
    s.isCompleted = true;
    return json({ id: "row-kids", sourceKey: s.key, isCompleted: true });
  }
  const stored = new RegExp(`^/api/events/${EVENT}/beo/timeline/([^/]+)/complete$`).exec(url.pathname);
  if (stored && method === "POST") {
    const s = steps.find((x) => x.rowId === stored[1])!;
    s.isCompleted = !s.isCompleted;
    return json({ id: s.rowId, isCompleted: s.isCompleted });
  }
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  if (url.pathname === "/api/user") return json(USER);
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  if (/\/api\/beo\/set-menu-selections\//.test(url.pathname)) return json(null, 404);
  return json([]);
};
const USER = { id: "44444444-4444-4444-8444-444444444444", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const auth = { user: USER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the screen shows ${id}`); return el; };
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(10); };
const ticked = (id: string) => !!required(id).querySelector(".text-green-500");
const posts = () => asked.filter((a) => a.method === "POST").map((a) => a.path);

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
await act(async () => {
  root.render(
    React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(BeoDayOfView, { eventId: EVENT, onClose: () => undefined }))),
  );
});
await settle(14);

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

await check("a step the timeline makes and no Save stored yet shows its tick, with no delete", () => {
  assert.ok(byTestId("timeline-item-1")?.textContent?.includes("Kids' menu served"));
  assert.equal(ticked("button-complete-1"), false);
  assert.equal(byTestId("button-delete-timeline-1"), null, "no stored row to remove");
  assert.ok(byTestId("button-delete-timeline-0"), "a stored step keeps its delete");
});

await check("pressed, its row is stored under the step's own key, ticked, and the view shows it ticked", async () => {
  asked.length = 0;
  await click("button-complete-1");
  assert.deepEqual(posts(), [`/api/events/${EVENT}/beo/timeline/steps/kids_food/complete`]);
  assert.equal(ticked("button-complete-1"), true, "read again: ticked");
  assert.ok(byTestId("button-delete-timeline-1"), "its row exists now");
});

await check("a stored step and a typed row tick through their own row, as before", async () => {
  asked.length = 0;
  await click("button-complete-0");
  await click("button-complete-2");
  assert.deepEqual(posts(), [`/api/events/${EVENT}/beo/timeline/row-arrive/complete`, `/api/events/${EVENT}/beo/timeline/row-typed/complete`]);
  assert.equal(ticked("button-complete-0"), true);
  assert.equal(ticked("button-complete-2"), true);
});

await act(async () => { root.unmount(); });
console.log(`beo-day-of-tick-ui.check: ${checks} checks passed`);
process.exit(checks === 3 ? 0 : 1);
