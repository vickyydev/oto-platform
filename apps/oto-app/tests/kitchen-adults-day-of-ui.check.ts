// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the BEO's day-of view's real
// Kitchen Plan under jsdom with React, react-query and Radix as the app builds
// them.
//
// SCRUM-829 — the kids' menu is the main selection; the adults mirror it, on
// the day-of view (the screen the floor reads on the party day), which reads
// and writes the same two lists as the editor (tests/kitchen-adults-ui.check.ts):
//
//   1. with "Different for adults" off, the Adults Menu tab shows the kids'
//      lines read-only under "Same as the kids' menu", counts the kids' lines,
//      and offers nothing to type: no "Click here to add first item";
//   2. the switch on writes the adults' list at once as a copy of the kids'
//      (ids of its own) with adultsDiffer: true; a line changed there is
//      written as the adults' own, the switch still on;
//   3. the switch off again (confirmed) writes adults: [] and adultsDiffer:
//      false, and the mirror is back;
//   4. a BEO saved before with two different lists opens with the switch on
//      and its adults' list as saved; one whose adults' list equals the
//      kids' opens off and its first write drops the duplicate.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/kitchen-adults-day-of-ui.check.ts
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
// The switch turned off asks before dropping the adults' changes: this check always says yes.
let confirmed = 0;
win.confirm = () => { confirmed += 1; return true; };
g.confirm = win.confirm;
const doc = dom.window.document;

// The day-of view, compiled as Vite builds it, with the react-query and auth it runs on.
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
const compiled = new Module(APP + "tests/kitchen-adults-day-of-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/kitchen-adults-day-of-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, BeoDayOfView } = compiled.exports;

// ─── The server, as the view sees it ─────────────────────────────────────────

type Line = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; productCode?: string };
const line = (id: string, itemName: string, quantity = 1, over: Partial<Line> = {}): Line => ({ id, itemName, quantity, notes: "", included: true, price: 0, ...over });
const KIDS: Line[] = [line("k1", "Chicken nuggets", 8), line("k2", "French fries", 2, { notes: "no salt" }), line("k3", "ZZ unicorn cake", 1, { productCode: "PARTY-ZZ829A" })];

type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const MENUS = new Map<string, Record<string, unknown>>();
const beoOf = (eventId: string) => ({
  id: eventId,
  title: "ZZ TEST 829",
  eventDate: "2099-03-14",
  startTime: "13:00",
  endTime: "16:00",
  numChildren: 10,
  numAdults: 4,
  childName: "Mali",
  bookingName: "Nok",
  branchId: "33333333-3333-4333-8333-333333333333",
  locationText: "Party room 1",
  kitchenPlan: { foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null, menus: MENUS.get(eventId) ?? { kids: KIDS, adults: [] }, serviceSchedule: [] },
  setupPlan: null,
  barPlan: null,
  partyDetails: null,
  partyHost: null,
  timeline: [],
  beoTasks: [],
});
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the view asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json(beoOf(beo[1]!));
  const plan = /^\/api\/events\/([^/]+)\/beo\/kitchen-plan$/.exec(url.pathname);
  if (plan && method === "PUT") {
    // The kitchen plan's own route spreads what the plan holds; the view's next read sees it.
    if (body.menus) MENUS.set(plan[1]!, body.menus as Record<string, unknown>);
    return json({ ok: true });
  }
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: [] });
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
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the view shows ${id}`); return el; };
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
const typeInto = async (id: string, value: string) => {
  // EditableText: a click opens the input under the same test id; a blur commits it.
  await click(id);
  const input = required(id) as HTMLInputElement;
  assert.equal(input.tagName, "INPUT", `${id} opens for typing`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  await settle();
};
const text = (id: string) => required(id).textContent?.trim() ?? "";
const mirrorRows = () =>
  [...doc.querySelectorAll('[data-testid^="adults-mirror-item-"]')].map((el) =>
    [...el.querySelectorAll("span")].map((span) => span.textContent?.trim()).filter(Boolean).join(" "),
  );
const adultsRows = () => [...doc.querySelectorAll('[data-testid^="input-menu-name-adults-"]')].map((el) => el.textContent?.trim());
const switchOn = () => required("switch-adults-differ").getAttribute("aria-checked") === "true" || required("switch-adults-differ").getAttribute("data-state") === "checked";
/** The last kitchen-plan write's menus. */
const lastWrite = (eventId: string) => {
  const put = [...asked].reverse().find((a) => a.method === "PUT" && a.path === `/api/events/${eventId}/beo/kitchen-plan`);
  assert.ok(put, "the view wrote the kitchen plan");
  return put.body.menus as Record<string, unknown>;
};

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const open = async (eventId: string) => {
  queryClient.clear();
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(BeoDayOfView, { key: eventId, eventId, onClose: () => undefined }))),
    );
  });
  await settle(10);
  await click("button-toggle-kitchen-plan");
  await click("button-menu-tab-adults");
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const E1 = "11111111-1111-4111-8111-111111111829";
const E2 = "22222222-2222-4222-8222-222222222829";
const E3 = "33333333-3333-4333-8333-333333333829";

await check("the adults' tab mirrors the kids' lines read-only under 'Same as the kids' menu', counts them, and offers nothing to type", async () => {
  await open(E1);
  assert.equal(switchOn(), false);
  assert.equal(text("text-adults-same-as-kids"), "Same as the kids' menu");
  assert.deepEqual(mirrorRows(), ["8 Chicken nuggets", "2 French fries (no salt)", "1 ZZ unicorn cake"]);
  assert.equal(doc.querySelectorAll('[data-testid="adults-menu-mirror"] [data-testid^="adults-mirror-item-"]').length, 3);
  assert.match(text("button-menu-tab-adults"), /Adults Menu \(3\)/);
  assert.equal(byTestId("button-add-first-menu-adults"), null, "no 'Click here to add first item'");
  assert.equal(byTestId("button-add-menu-extra-adults"), null, "no + EXTRA");
  assert.equal(doc.querySelectorAll('[data-testid^="input-menu-name-adults-"]').length, 0);
  assert.equal(asked.filter((a) => a.method === "PUT").length, 0, "nothing written by looking");
});

await check("the switch on writes the adults' list at once as a copy of the kids'; a line changed there is written as theirs, the switch kept on", async () => {
  await click("switch-adults-differ");
  assert.equal(switchOn(), true);
  assert.equal(byTestId("text-adults-same-as-kids"), null);
  let written = lastWrite(E1);
  assert.equal(written.adultsDiffer, true);
  const copy = written.adults as Line[];
  assert.deepEqual(copy.map((l) => [l.itemName, l.quantity, l.notes, l.productCode ?? null]), [["Chicken nuggets", 8, "", null], ["French fries", 2, "no salt", null], ["ZZ unicorn cake", 1, "", "PARTY-ZZ829A"]]);
  assert.ok(copy.every((l, i) => l.id !== KIDS[i]!.id), "ids of the adults' own");
  assert.deepEqual((written.kids as Line[]).map((l) => l.itemName), ["Chicken nuggets", "French fries", "ZZ unicorn cake"]);
  assert.deepEqual(adultsRows(), ["Chicken nuggets", "French fries", "ZZ unicorn cake"]);
  await typeInto("input-menu-name-adults-0", "Pasta");
  written = lastWrite(E1);
  assert.equal(written.adultsDiffer, true, "the switch stays on with the adults' own line");
  assert.deepEqual((written.adults as Line[]).map((l) => l.itemName), ["Pasta", "French fries", "ZZ unicorn cake"]);
  assert.deepEqual((written.kids as Line[]).map((l) => l.itemName), ["Chicken nuggets", "French fries", "ZZ unicorn cake"], "the kids' line is as it was");
  assert.match(text("button-menu-tab-adults"), /Adults Menu \(3\)/);
});

await check("the switch off again asks, then writes adults: [] with adultsDiffer: false; the mirror is back", async () => {
  const before = confirmed;
  await click("switch-adults-differ");
  assert.equal(confirmed, before + 1, "asked once, since the adults' list differed");
  assert.equal(switchOn(), false);
  const written = lastWrite(E1);
  assert.deepEqual(written.adults, []);
  assert.equal(written.adultsDiffer, false);
  assert.deepEqual(mirrorRows(), ["8 Chicken nuggets", "2 French fries (no salt)", "1 ZZ unicorn cake"]);
});

await check("a BEO saved before with two different lists opens with the switch on and its list as saved; one whose list equals the kids' opens off and its first write drops the duplicate", async () => {
  MENUS.set(E2, { kids: KIDS, adults: [line("a1", "Steak", 4), line("a2", "French fries", 2, { notes: "no salt" })], kidsFoodTime: "", adultsFoodTime: "" });
  await open(E2);
  assert.equal(switchOn(), true);
  assert.deepEqual(adultsRows(), ["Steak", "French fries"], "as saved, not a copy of the kids'");
  assert.match(text("button-menu-tab-adults"), /Adults Menu \(2\)/);
  MENUS.set(E3, { kids: KIDS, adults: KIDS.map((l) => ({ ...l, id: `copy_${l.id}` })), kidsFoodTime: "", adultsFoodTime: "" });
  await open(E3);
  assert.equal(switchOn(), false);
  assert.deepEqual(mirrorRows().length, 3);
  // A kids' food time typed on the day is the first write: it carries the switch and no duplicate list.
  await click("button-menu-tab-kids");
  await typeInto("input-food-service-time-kids", "14:30");
  const written = lastWrite(E3);
  assert.equal(written.kidsFoodTime, "14:30");
  assert.equal(written.adultsDiffer, false);
  assert.deepEqual(written.adults, [], "the duplicate list is not written again");
});

await act(async () => { root.unmount(); });
console.log(`kitchen-adults-day-of-ui.check: ${checks} checks passed`);
process.exit(checks === 4 ? 0 : 1);
