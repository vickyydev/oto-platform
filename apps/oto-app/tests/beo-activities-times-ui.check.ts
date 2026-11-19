// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the real BEO editor under jsdom
// with React, react-query and Radix as the app builds them.
//
// SCRUM-1032 and SCRUM-1033 on the BEO editor itself:
//   1. each activity of Entertainment & Program: its one time box, its people
//      (staff by name, one or several; a role with its number stepped from 1),
//      its note; every change written at once to the activity's own routes, the
//      people one change after the other; an activity of before shows its one
//      person (kept as it was until staff change it) and a member of staff who
//      has left by the name the server gives;
//   2. a dish's and a drink's own serving time and group, set from its row in
//      Food & Drinks, shown on the row and saved with the line; a group's
//      dishes follow its one time; cleared, the line is saved as before;
//   3. a party opened and saved untouched sends its lines' serving keys back
//      as stored, and none on a line of before.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-activities-times-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { FOUR_SECTIONS_EVENT, fourSectionsBeo, fourSectionsSnapshot } from "./fixtures/beo-four-sections";

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
win.confirm = () => true;
g.confirm = win.confirm;
win.open = () => null;
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
      export { Toaster } from './client/src/components/ui/toaster';
      export { BeoEventEditor } from './client/src/components/beo/beo-event-editor';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/beo-activities-times-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/beo-activities-times-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, Toaster, BeoEventEditor } = compiled.exports;

// ─── The server, as the editor sees it ───────────────────────────────────────

const STAFF = [
  { id: "emp-zz-nok", fullName: "ZZ TEST Nok Full", nickname: "ZZ Nok" },
  { id: "emp-zz-ploy", fullName: "ZZ TEST Ploy", nickname: null },
];
const ROLES = [{ id: "role-zz-animator", name: "ZZ Animator" }, { id: "role-zz-host", name: "ZZ Host" }];
const NAMES: Record<string, string> = { "emp-zz-nok": "ZZ Nok", "emp-zz-ploy": "ZZ TEST Ploy", "emp-zz-left": "ZZ Left Staff", "role-zz-animator": "ZZ Animator", "role-zz-host": "ZZ Host" };
type Person = { type: string; id: string; targetId: string; label: string; count: number | null; kept?: boolean };
type Act = { id: string; customName: string | null; startTime: string | null; notes: string | null; people: Person[] };
let acts: Act[] = [];
const freshActs = (): Act[] => [
  // An activity of before: one person by its assignment target, kept as it was.
  { id: "act-zz-old", customName: "ZZ TEST Bubble show", startTime: "12:00", notes: null, people: [{ type: "employee", id: "emp-zz-left", targetId: "target-zz-old", label: "ZZ Left Staff", count: null, kept: true }] },
  { id: "act-zz-new", customName: "ZZ TEST Treasure hunt", startTime: null, notes: null, people: [] },
];

type Asked = { method: string; path: string; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- the bodies are read as sent
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let OVER: Record<string, unknown> = {};
let slowPeople = 0;

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the editor asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json(fourSectionsBeo(beo[1]!, OVER));
  if (beo && method === "PUT") return json({ id: beo[1], oneDeposit: { amountThb: 3000, date: "2099-05-01" } });
  if (/\/beo\/entertainment-items$/.test(url.pathname) && method === "GET") return json(acts);
  const people = /\/beo\/entertainment-items\/([^/]+)\/people$/.exec(url.pathname);
  if (people && method === "PUT") {
    // The first change is slow: the second waits for it (one change after the other).
    if (slowPeople > 0) { slowPeople -= 1; await new Promise((r) => setTimeout(r, 60)); }
    const a = acts.find((x) => x.id === people[1])!;
    a.people = (body.people as Array<{ type: string; id: string; count?: number | null }>).map((p, i) => p.type === "kept"
      ? a.people.find((q) => q.targetId === p.id)!
      : { type: p.type, id: p.id, targetId: `t-${i}`, label: NAMES[p.id] ?? "?", count: p.type === "role" ? p.count ?? null : null });
    return json({ ...a });
  }
  const item = /\/beo\/entertainment-items\/([^/]+)$/.exec(url.pathname);
  if (item && method === "PUT") {
    const a = acts.find((x) => x.id === item[1])!;
    Object.assign(a, body);
    return json({ ...a });
  }
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  const snapshot = /^\/api\/beo\/events\/([^/]+)\/package-snapshot$/.exec(url.pathname);
  if (snapshot) return json(fourSectionsSnapshot(snapshot[1]!));
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  if (/\/beo\/timeline\/built$/.test(url.pathname)) return json({ steps: [], untimed: [] });
  if (/^\/api\/events\/([^/]+)\/beo\/timeline$/.test(url.pathname)) return json([]);
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: STAFF });
  if (url.pathname === "/api/beo/roles") return json(ROLES);
  if (url.pathname === "/api/user") return json(MANAGER);
  if (/\/set-menu-selections\//.test(url.pathname)) return json(null, 404);
  return json([]);
};
const MANAGER = { id: "44444444-4444-4444-8444-444444444444", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const auth = { user: MANAGER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the screen shows ${id}`); return el; };
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
const text = (id: string) => byTestId(id)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
const setValue = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el.tagName === "INPUT" ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
};
/** EditableText: a click opens the box under the same test id; typing and a blur commit it. */
const typeInto = async (id: string, value: string) => {
  await click(id);
  const box = required(id) as HTMLInputElement;
  await setValue(box, value);
  await act(async () => { box.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  await settle();
};
const pick = async (testId: string, option: string) => {
  const search = required(`${testId}-search`) as HTMLInputElement;
  await act(async () => { search.focus(); search.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true })); });
  await settle();
  const choice = required(`${testId}-option-${option}`);
  await act(async () => { choice.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
  await settle(10);
};
const saves = () => asked.filter((a) => a.method === "PUT" && a.path === `/api/events/${FOUR_SECTIONS_EVENT}/beo`);
const peopleSent = (actId: string) => asked.filter((a) => a.method === "PUT" && a.path.endsWith(`/entertainment-items/${actId}/people`)).map((a) => a.body.people);

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const open = async (over: Record<string, unknown> = {}) => {
  OVER = over;
  acts = freshActs();
  queryClient.clear();
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(React.Fragment, null,
            React.createElement(BeoEventEditor, { key: String(Math.random()), eventId: FOUR_SECTIONS_EVENT, autoFill: null, onClose: () => undefined }),
            React.createElement(Toaster)))),
    );
  });
  await settle(12);
  assert.ok(byTestId("accordion-event-info"), "the BEO is open");
  for (let round = 0; round < 3; round++) {
    const closed = [...doc.querySelectorAll('[data-testid^="accordion-"][data-state="closed"]')] as HTMLElement[];
    if (closed.length === 0) break;
    for (const trigger of closed) await act(async () => { trigger.click(); });
    await settle();
  }
  asked.length = 0;
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

// ── 1. Activities ────────────────────────────────────────────────────────────

await check("an activity of before shows its one person by the server's name (a member of staff who has left); one with none, the search box", async () => {
  await open();
  assert.equal(text("entertainment-act-people-0-chip-0"), "ZZ Left Staff");
  assert.equal(byTestId("entertainment-act-people-1-chip-0"), null);
  assert.ok(byTestId("entertainment-act-people-1-search"), "Add staff or a role");
  // One time box, no chip beside it.
  const row = required("entertainment-act-0");
  assert.equal(row.querySelectorAll('input[type="time"]').length, 1);
  assert.equal((required("input-entertainment-act-time-0") as HTMLInputElement).value, "12:00");
});

await check("staff by name, one then several: each change written at once, one after the other, the person of before kept", async () => {
  await open();
  slowPeople = 1;
  await pick("entertainment-act-people-0", "employee-emp-zz-nok");
  await pick("entertainment-act-people-0", "employee-emp-zz-ploy");
  await settle(20);
  assert.deepEqual(peopleSent("act-zz-old"), [
    [{ type: "kept", id: "target-zz-old" }, { type: "employee", id: "emp-zz-nok" }],
    [{ type: "kept", id: "target-zz-old" }, { type: "employee", id: "emp-zz-nok" }, { type: "employee", id: "emp-zz-ploy" }],
  ], "in the order they were made, the later one whole");
  assert.deepEqual(acts[0]!.people.map((p) => p.label), ["ZZ Left Staff", "ZZ Nok", "ZZ TEST Ploy"]);
  assert.deepEqual([0, 1, 2].map((i) => text(`entertainment-act-people-0-chip-${i}`)), ["ZZ Left Staff", "ZZ Nok", "ZZ TEST Ploy"]);
  assert.equal(byTestId("entertainment-act-people-0-option-employee-emp-zz-nok"), null, "a person on the activity is not offered again");
});

await check("a role with its number: picked at 1, stepped to 2; the chip says it; the person of before taken off", async () => {
  await open();
  await pick("entertainment-act-people-1", "role-role-zz-animator");
  assert.deepEqual(peopleSent("act-zz-new").at(-1), [{ type: "role", id: "role-zz-animator", count: 1 }]);
  assert.equal(text("entertainment-act-people-1-count-0"), "1");
  await click("entertainment-act-people-1-more-0");
  assert.deepEqual(peopleSent("act-zz-new").at(-1), [{ type: "role", id: "role-zz-animator", count: 2 }]);
  assert.match(text("entertainment-act-people-1-chip-0") ?? "", /2\s*× ZZ Animator/);
  assert.equal((required("entertainment-act-people-1-less-0") as HTMLButtonElement).disabled, false);
  await click("entertainment-act-people-1-less-0");
  assert.equal((required("entertainment-act-people-1-less-0") as HTMLButtonElement).disabled, true, "never below 1");
  await click("entertainment-act-people-0-remove-0");
  assert.deepEqual(peopleSent("act-zz-old").at(-1), [], "the person of before taken off: the activity names no one");
});

await check("the activity's note and its time are written at once to the activity", async () => {
  await open();
  await typeInto("input-entertainment-act-notes-1", "ZZ TEST bring the treasure map");
  const fields = asked.filter((a) => a.method === "PUT" && a.path.endsWith("/entertainment-items/act-zz-new"));
  assert.deepEqual(fields.at(-1)!.body, { notes: "ZZ TEST bring the treasure map" });
  await setValue(required("input-entertainment-act-time-1") as HTMLInputElement, "13:15");
  assert.deepEqual(asked.filter((a) => a.method === "PUT" && a.path.endsWith("/entertainment-items/act-zz-new")).at(-1)!.body, { startTime: "13:15" });
  assert.equal(saves().length, 0, "nothing waits for the BEO's Save");
});

// ── 2. Serving times ─────────────────────────────────────────────────────────

/** The row's clock: what it says it holds (none: served with the menu). */
const clockOf = (row: string) => required(`button-serving-${row}`).getAttribute("data-serving");
/** The serving panel of a row opened, a time and a group typed, Done pressed. */
const serve = async (row: string, time: string, group = "") => {
  await click(`button-serving-${row}`);
  await setValue(required(`button-serving-${row}-time`) as HTMLInputElement, time);
  await setValue(required(`button-serving-${row}-group`) as HTMLInputElement, group);
  await click(`button-serving-${row}-done`);
};

await check("a dish's own time and a group, set from its row: shown on the row and saved with the line; the other lines as they were", async () => {
  await open();
  await click("button-menu-tab-kids");
  assert.equal(clockOf("kids-1"), null, "no time of its own: a clock only");
  assert.equal(byTestId("text-serving-kids-1"), null, "and nothing under the row");
  await serve("kids-1", "13:00", "ZZ Dessert");
  assert.equal(clockOf("kids-1"), "ZZ Dessert · 13:00");
  assert.equal(text("text-serving-kids-1"), "Served at 13:00 · ZZ Dessert");
  await serve("bar-1", "13:30");
  assert.equal(text("text-serving-bar-1"), "Served at 13:30");
  await click("button-save-beo");
  const body = saves()[0]!.body;
  const kids = body.kitchenPlan.menus.kids as Array<Record<string, unknown>>;
  assert.deepEqual([kids[1]!.serviceTime, kids[1]!.serviceGroup], ["13:00", "ZZ Dessert"]);
  assert.deepEqual(["serviceTime" in kids[0]!, "serviceGroup" in kids[0]!], [false, false], "a dish served with its menu: no key");
  assert.equal(body.kitchenPlan.menus.kidsFoodTime, "11:30", "the menu's own time unchanged");
  const bar = body.barPlan.items as Array<Record<string, unknown>>;
  assert.deepEqual([bar[1]!.serviceTime, "serviceGroup" in bar[1]!, "serviceTime" in bar[0]!], ["13:30", false, false]);
});

await check("a group's dishes share one time: a dish joining the group takes it, a new time moves them all; cleared, served with the menu again", async () => {
  await open({
    kitchenPlan: {
      ...fourSectionsBeo().kitchenPlan,
      menus: {
        ...fourSectionsBeo().kitchenPlan.menus,
        kids: [
          { id: "menu_zz_k1", itemName: "ZZ TEST Margherita", quantity: 3, notes: "", included: true, price: 0, source: "set_menu", groupId: "group_zz_1" },
          { id: "menu_zz_k2", itemName: "ZZ TEST Fries", quantity: 2, notes: "", included: false, price: 80, source: "additional", serviceTime: "13:00", serviceGroup: "ZZ Dessert" },
          { id: "menu_zz_k3", itemName: "ZZ TEST Skewers", quantity: 2, notes: "", included: false, price: 0, source: "additional" },
        ],
      },
    },
  });
  await click("button-menu-tab-kids");
  assert.equal(text("text-serving-kids-1"), "Served at 13:00 · ZZ Dessert", "stored: opens with its time and group");
  await click("button-serving-kids-2");
  assert.match(text("button-serving-kids-2-panel") ?? "", /ZZ Dessert · 13:00/, "the list's groups to pick from");
  await click("button-serving-kids-2-join");
  assert.equal((required("button-serving-kids-2-time") as HTMLInputElement).value, "13:00", "the group's time taken");
  await click("button-serving-kids-2-done");
  assert.equal(clockOf("kids-2"), "ZZ Dessert · 13:00");
  await serve("kids-2", "13:20", "ZZ Dessert");
  assert.equal(text("text-serving-kids-1"), "Served at 13:20 · ZZ Dessert", "the group's other dish moves with it");
  await click("button-serving-kids-1");
  await click("button-serving-kids-1-clear");
  assert.equal(clockOf("kids-1"), null, "cleared: a clock only");
  assert.equal(byTestId("text-serving-kids-1"), null);
  await click("button-save-beo");
  const kids = saves()[0]!.body.kitchenPlan.menus.kids as Array<Record<string, unknown>>;
  assert.deepEqual(kids.map((k) => [k.serviceTime ?? null, k.serviceGroup ?? null]), [[null, null], [null, null], ["13:20", "ZZ Dessert"]]);
});

await check("a party opened and saved untouched sends its lines' serving keys back as stored, and none on a line of before", async () => {
  const stored = fourSectionsBeo();
  await open({
    barPlan: { ...stored.barPlan, items: [stored.barPlan.items[0], { ...stored.barPlan.items[1], serviceTime: "13:30", serviceGroup: "ZZ Coffee" }] },
  });
  await click("button-save-beo");
  const body = saves()[0]!.body;
  assert.deepEqual(body.barPlan.items.map((b: Record<string, unknown>) => [b.id, b.serviceTime ?? null, b.serviceGroup ?? null]), [["bar_zz_1", null, null], ["bar_zz_2", "13:30", "ZZ Coffee"]]);
  assert.ok((body.kitchenPlan.menus.kids as Array<Record<string, unknown>>).every((k) => !("serviceTime" in k) && !("serviceGroup" in k)));
});

console.log(`beo-activities-times-ui.check: ${checks} checks passed`);
await act(async () => { root.unmount(); });
process.exit(checks === 7 ? 0 : 1);
