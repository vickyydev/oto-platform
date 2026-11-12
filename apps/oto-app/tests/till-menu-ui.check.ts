// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the BEO editor's real Kitchen
// and Bar Plan, and Settings > Set menu templates, under jsdom with React,
// react-query, Radix and cmdk as the app builds them.
//
// SCRUM-905 — the till's menu inside the BEO, the screens' half (the
// server's is tests/till-menu.check.ts):
//
//   1. nothing is asked of the till until the kitchen or bar plan opens; then
//      the party's park's menu, once;
//   2. a kitchen line whose code the till's menu no longer has says "No
//      longer on the till"; a hand-typed line and a live code say nothing;
//   3. the search beside a kids' line finds a pizza by part of its name;
//      picking it writes the till's name and code onto the line, an EXTRA
//      takes the till's price, and Save sends them; "+ EXTRA", "+ NEW ITEM
//      (not in the menu)" and free typing stay; "Not from the till" drops the
//      code and keeps the name;
//   4. the bar plan: the same search (drinks first), the code written and kept
//      through Save, a dead code marked;
//   5. a till that does not answer: the search says so and no line is marked;
//      a read-only BEO offers no search and still marks a dead code;
//   5b. a set menu the parent chose: a dish the template resolved offers no
//      search (its code is the template's), in the kids' list and in the
//      adults' copy; a line added on the set menu block and an EXTRA do, and
//      Save leaves the parent's choice as it was;
//   6. Settings > Set menu templates: a dead code marked in the list and in
//      the form; the search beside a Code box writes the till's code, fills an
//      empty name with the till's and never renames one; Save sends the codes.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/till-menu-ui.check.ts
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
win.confirm = () => true;
g.confirm = win.confirm;
const doc = dom.window.document;

// The editor and the settings card, compiled as Vite builds them, with the react-query and auth they run on.
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
      export { BeoEventEditor } from './client/src/components/beo/beo-event-editor';
      export { SetMenuTemplatesSettings } from './client/src/components/beo/set-menu-templates-settings';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/till-menu-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/till-menu-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, BeoEventEditor, SetMenuTemplatesSettings } = compiled.exports;

// ─── The server, as the screens see it ───────────────────────────────────────

const PARK = "33333333-3333-4333-8333-333333333905";
const item = (code: string, name: string, category: string, station: "kitchen" | "bar", priceSatang: number, beoOnly = false) => ({
  code, name, category, parentCategory: station === "kitchen" ? "Food" : "Drinks", station, priceSatang, priceWeekendSatang: priceSatang, beoOnly,
});
const TILL = [
  item("CF-24", "Margherita", "Pizza", "kitchen", 29_000),
  item("CF-25", "Hawaiian", "Pizza", "kitchen", 31_000),
  item("CF-12", "French fries", "Sides", "kitchen", 12_000),
  item("CF-66-1", "Kids juice Apple", "Juice", "bar", 9_050),
  item("CF-66-4", "Cranberry mors", "Juice", "bar", 9_050),
  item("PARTY-ZZ905A01", "ZZ TEST unicorn cake", "Party menu", "kitchen", 0, true),
];
type Reading = { parks: Array<Record<string, unknown>> };
const okReading = (parkId: string): Reading => ({
  parks: [{ parkId, parkName: "ZZ TEST Floresta", status: "ok", message: null, items: TILL, readAt: "2026-11-12T07:00:00.000Z" }],
});
let tillAnswer: (parkId: string | null) => Reading = (parkId) => okReading(parkId ?? PARK);

type Line = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; groupId?: string; productCode?: string };
const line = (id: string, itemName: string, over: Partial<Line> = {}): Line => ({ id, itemName, quantity: 1, notes: "", included: false, price: 0, ...over });

type Asked = { method: string; path: string; search: string; body: Record<string, unknown> };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const BEOS = new Map<string, { kids: Line[]; bar: Line[]; setMenuTemplateId?: string }>();
/** A parent's submitted set menu choices, per party. */
const SELECTIONS = new Map<string, Record<string, unknown>>();
const beoOf = (eventId: string) => {
  const held: { kids: Line[]; bar: Line[]; setMenuTemplateId?: string } = BEOS.get(eventId) ?? { kids: [], bar: [] };
  return {
    id: eventId, title: "ZZ TEST BEO 905", eventDate: "2099-03-14", startTime: "13:00", endTime: "16:00", numChildren: 10, numAdults: 4,
    childName: "Mali", bookingName: "Nok", branchId: PARK, locationText: "Party room 1",
    kitchenPlan: { foodRequired: true, cakeMode: "NONE", setMenuEnabled: !!held.setMenuTemplateId, setMenuTemplateId: held.setMenuTemplateId ?? null, menus: { kids: held.kids, adults: [], kidsFoodTime: "14:00", adultsFoodTime: "" }, serviceSchedule: [] },
    setupPlan: null, barPlan: { serviceTime: "14:00", items: held.bar }, partyDetails: null, partyHost: null, timeline: [], beoTasks: [],
  };
};
type Template = { id: string; name: string; isActive: boolean; items: Array<Record<string, unknown>>; createdAt: string; updatedAt: string };
let templates: Template[] = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the screens ask only their own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, search: url.search, body });
  if (url.pathname === "/api/beo/till-menu" && method === "GET") return json(tillAnswer(url.searchParams.get("parkId")));
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json(beoOf(beo[1]!));
  if (beo && method === "PUT") return json({ ok: true });
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: [] });
  if (url.pathname === "/api/user") return json(USER);
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  if (url.pathname === "/api/beo/set-menu-templates" && method === "GET") return json(templates);
  const selection = /^\/api\/beo\/set-menu-selections\/([^/]+)$/.exec(url.pathname);
  if (selection && method === "GET") return SELECTIONS.has(selection[1]!) ? json(SELECTIONS.get(selection[1]!)) : json({ error: "Not found" }, 404);
  if (/^\/api\/beo\/set-menu-templates\/[^/]+$/.test(url.pathname) && method === "PUT") return json({ ok: true });
  return json([]);
};
const USER = { id: "44444444-4444-4444-8444-444444444905", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const auth = { user: USER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the screen shows ${id}`); return el; };
/**
 * The screen does not show `id`. A node is never handed to `assert` as the
 * value it judges: a failed assertion keeps that value, and Node reads it deep
 * (a message it writes itself, 1000 levels with getters; the fatal-error
 * printer, 5). A jsdom node reaches React's fiber tree, the query client and
 * the window, so one failed `assert.equal(node, null)` here grew the process
 * past 40 GB on 12 November instead of saying what failed.
 */
const absent = (id: string, why = "not on the screen") => assert.ok(byTestId(id) === null, `${why}: ${id} is on the screen`);
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
const setValue = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
};
const typeInto = async (id: string, value: string) => {
  // EditableText: a click opens the input under the same test id; a blur commits it.
  await click(id);
  const input = required(id) as HTMLInputElement;
  assert.equal(input.tagName, "INPUT", `${id} opens for typing`);
  await setValue(input, value);
  await act(async () => { input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  await settle();
};
const text = (id: string) => required(id).textContent?.trim() ?? "";
/** The till's menu as the open search lists it: each option's code. */
const options = (testId: string) =>
  [...doc.querySelectorAll(`[data-testid^="${testId}-option-"]`)].map((el) => el.getAttribute("data-testid")!.slice(`${testId}-option-`.length));
/** Opens a line's search, types into it and picks the option with the code; answers what the search listed. */
const pick = async (testId: string, search: string, code: string) => {
  await click(testId);
  const input = required(`${testId}-search`) as HTMLInputElement;
  await setValue(input, search);
  const listed = options(testId);
  assert.ok(listed.includes(code), `${search} finds ${code}: ${listed.join(", ")}`);
  await click(`${testId}-option-${code}`);
  absent(`${testId}-search`, "the search closes once an item is picked");
  return listed;
};
const tillAsks = () => asked.filter((a) => a.path === "/api/beo/till-menu");

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
let mounted = "";
const openBeo = async (eventId: string, readOnly = false) => {
  mounted = eventId;
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(BeoEventEditor, { key: `${eventId}-${readOnly}`, eventId, readOnly, onClose: () => undefined }))),
    );
  });
  await settle(10);
  assert.ok(byTestId("accordion-kitchen-plan"), `the BEO ${eventId} is open`);
};
const saved = async () => {
  const before = asked.length;
  await click("button-save-beo");
  const put = asked.slice(before).find((a) => a.method === "PUT" && a.path === `/api/events/${mounted}/beo`);
  assert.ok(put, "Save sent the BEO");
  return put.body as { kitchenPlan: { menus: { kids: Line[] } }; barPlan: { items: Line[] } };
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
  } catch (err) {
    // Said in words and ended here: a failure never reaches Node's fatal-error
    // printer, which reads whatever the error holds 5 levels deep (see `absent`).
    const words = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`  FAIL  ${title}\n${words.slice(0, 4000)}`);
    process.exit(1);
  }
  checks += 1;
  console.log(`  ok  ${title}`);
};

const E1 = "11111111-1111-4111-8111-111111111905";
const E2 = "22222222-2222-4222-8222-222222222905";
BEOS.set(E1, {
  kids: [line("k1", "pizza", { quantity: 6 }), line("k2", "Old nuggets", { productCode: "CF-99" }), line("k3", "ZZ TEST unicorn cake", { productCode: "PARTY-ZZ905A01", included: true })],
  bar: [line("b1", "juice", { quantity: 10 }), line("b2", "Old soda", { productCode: "CF-77" })],
});

await check("nothing is asked of the till until the kitchen or bar plan opens; then the party's park's menu, once", async () => {
  await openBeo(E1);
  assert.equal(tillAsks().length, 0, "a closed kitchen plan asks nothing");
  await click("accordion-kitchen-plan");
  assert.equal(tillAsks().length, 1);
  assert.equal(tillAsks()[0]!.search, `?parkId=${PARK}`, "the party's park");
  await click("accordion-bar-plan");
  assert.equal(tillAsks().length, 1, "the bar plan reads the same answer");
});

await check("a kitchen line whose code the till no longer has says so; a hand-typed line and a live code say nothing", () => {
  assert.equal(text("text-menu-code-dead-kids-1"), "No longer on the till");
  absent("text-menu-code-dead-kids-0", "a hand-typed line is not marked");
  absent("text-menu-code-dead-kids-2", "a live code (a BEO-made item) is not marked");
  assert.equal(text("text-menu-code-kids-1"), "CF-99");
  assert.equal(required("text-menu-code-kids-2").getAttribute("title"), "On the till as ZZ TEST unicorn cake (made for a party)");
});

await check("the search finds a pizza by part of its name; picking it writes the till's name, code and price onto the EXTRA; Save sends them", async () => {
  await click("button-till-menu-kids-0");
  const all = options("button-till-menu-kids-0");
  assert.deepEqual(all, ["CF-24", "CF-25", "CF-12", "CF-66-1", "CF-66-4", "PARTY-ZZ905A01"], "the till's food and drink, the BEO-made items last");
  await click("button-till-menu-kids-0");
  assert.deepEqual(await pick("button-till-menu-kids-0", "marg", "CF-24"), ["CF-24"], "part of a name finds the one pizza");
  assert.equal(text("input-menu-name-kids-0"), "Margherita");
  assert.equal(text("text-menu-code-kids-0"), "CF-24");
  assert.equal(text("text-menu-qty-kids-0"), "6", "the count stays");
  const body = await saved();
  assert.deepEqual(body.kitchenPlan.menus.kids[0], { id: "k1", itemName: "Margherita", quantity: 6, notes: "", included: false, price: 290, productCode: "CF-24" });
  assert.deepEqual(body.kitchenPlan.menus.kids[1], { id: "k2", itemName: "Old nuggets", quantity: 1, notes: "", included: false, price: 0, productCode: "CF-99" }, "the dead line as it was");
});

await check("a dead line picked again is live; + EXTRA, + NEW ITEM and free typing stay; Not from the till drops only the code", async () => {
  await pick("button-till-menu-kids-1", "fries", "CF-12");
  absent("text-menu-code-dead-kids-1", "picked again: no longer marked");
  assert.equal(text("input-menu-name-kids-1"), "French fries");
  assert.ok(byTestId("button-add-party-menu-item-kids"), "+ NEW ITEM (not in the menu) stays");
  assert.equal(text("button-add-party-menu-item-kids"), "+ NEW ITEM (not in the menu)");
  await click("button-add-menu-extra-kids");
  await typeInto("input-menu-name-kids-3", "Fish fingers");
  assert.equal(text("input-menu-name-kids-3"), "Fish fingers", "free typing: a dish the till lacks, by its name");
  absent("text-menu-code-kids-3");
  await pick("button-till-menu-kids-3", "haw", "CF-25");
  await click("button-till-menu-kids-3");
  await click("button-till-menu-kids-3-clear");
  assert.equal(text("input-menu-name-kids-3"), "Hawaiian", "the name stays");
  absent("text-menu-code-kids-3", "the code goes");
  const kids = (await saved()).kitchenPlan.menus.kids;
  assert.deepEqual(kids.map((l) => [l.itemName, l.productCode ?? null, l.price]), [
    ["Margherita", "CF-24", 290], ["French fries", "CF-12", 120], ["ZZ TEST unicorn cake", "PARTY-ZZ905A01", 0], ["Hawaiian", null, 310],
  ]);
});

await check("the bar plan: drinks first, the code written on and kept through Save, a dead code marked", async () => {
  assert.equal(text("text-bar-code-dead-1"), "No longer on the till");
  absent("text-bar-code-dead-0");
  await click("button-till-menu-bar-0");
  assert.deepEqual(options("button-till-menu-bar-0").slice(0, 2), ["CF-66-1", "CF-66-4"], "the bar's drinks first");
  await click("button-till-menu-bar-0");
  assert.deepEqual(await pick("button-till-menu-bar-0", "cranberry", "CF-66-4"), ["CF-66-4"]);
  assert.equal(text("bar-item-name-0"), "Cranberry mors");
  assert.equal(text("text-bar-code-0"), "CF-66-4");
  const body = await saved();
  assert.deepEqual(body.barPlan.items[0], { id: "b1", itemName: "Cranberry mors", quantity: 10, notes: "", included: false, price: 90.5, productCode: "CF-66-4" });
  assert.deepEqual(body.barPlan.items[1], { id: "b2", itemName: "Old soda", quantity: 1, notes: "", included: false, price: 0, productCode: "CF-77" }, "a bar line's code kept from the read");
});

await check("a till that does not answer: the search says so and no line is marked; a read-only BEO offers no search and still marks a dead code", async () => {
  queryClient.clear();
  tillAnswer = (parkId) => ({ parks: [{ parkId: parkId ?? PARK, parkName: "ZZ TEST Floresta", status: "not_reachable", message: "The till did not answer, so its menu cannot be offered. Type the item, or try again in a moment.", items: [], readAt: null }] });
  BEOS.set(E2, { kids: [line("k1", "Old nuggets", { productCode: "CF-99" })], bar: [] });
  await openBeo(E2);
  await click("accordion-kitchen-plan");
  absent("text-menu-code-dead-kids-0", "an unknown menu marks nothing");
  await click("button-till-menu-kids-0");
  assert.equal(text("button-till-menu-kids-0-unavailable"), "The till did not answer, so its menu cannot be offered. Type the item, or try again in a moment.");
  absent("button-till-menu-kids-0-search");

  queryClient.clear();
  tillAnswer = (parkId) => okReading(parkId ?? PARK);
  await openBeo(E2, true);
  await click("accordion-kitchen-plan");
  absent("button-till-menu-kids-0", "read-only: no search");
  assert.equal(text("text-menu-code-dead-kids-0"), "No longer on the till");
});

await check("a set menu the parent chose: no search on a dish the template resolved, kids' or adults' copy; an added line and an EXTRA keep theirs", async () => {
  const E3 = "55555555-5555-4555-8555-555555555905";
  queryClient.clear();
  templates = [{
    id: "tpl3", name: "ZZ TEST set 905", isActive: true, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z",
    items: [
      { id: "g1", type: "always_included", label: "Veggie sticks", qty: 10 },
      { id: "g2", type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false },
    ],
  }];
  SELECTIONS.set(E3, {
    id: "sel3", eventId: E3, templateId: "tpl3", token: "zz-905-token", isSubmitted: true, submittedAt: "2026-11-12T06:00:00.000Z",
    selections: [{ groupId: "g2", chosenOptions: ["Margherita"] }],
  });
  BEOS.set(E3, {
    setMenuTemplateId: "tpl3",
    kids: [
      line("set_g1", "Veggie sticks", { quantity: 10, included: true, source: "set_menu", groupId: "g1" }),
      line("set_g2_Margherita", "Margherita", { quantity: 10, notes: "(Pizza)", included: true, source: "set_menu", groupId: "g2" }),
      line("menu_add", "garlic bread", { quantity: 2, included: true, source: "set_menu" }),
      line("x1", "fries", { quantity: 3, source: "additional" }),
    ],
    bar: [],
  });
  await openBeo(E3);
  await click("accordion-kitchen-plan");
  for (const i of [0, 1]) {
    assert.ok(byTestId(`menu-item-kids-${i}`), `the template's dish ${i} is on the screen, editable`);
    absent(`button-till-menu-kids-${i}`, `no search on the template's dish ${i}`);
  }
  assert.ok(byTestId("button-till-menu-kids-2"), "a line added on the set menu block keeps the search");
  assert.ok(byTestId("button-till-menu-kids-3"), "an EXTRA keeps the search");
  await pick("button-till-menu-kids-2", "haw", "CF-25");
  await pick("button-till-menu-kids-3", "fries", "CF-12");
  const kids = (await saved()).kitchenPlan.menus.kids;
  assert.deepEqual(kids.map((l) => [l.itemName, l.notes, l.groupId ?? null, l.productCode ?? null, l.price]), [
    ["Veggie sticks", "", "g1", null, 0],
    ["Margherita", "(Pizza)", "g2", null, 0],
    ["Hawaiian", "", null, "CF-25", 0],
    ["French fries", "", null, "CF-12", 120],
  ], "the parent's choice as it was; the added line part of the package, the EXTRA at the till's price");

  await click("button-menu-tab-adults");
  await click("switch-adults-differ");
  for (const i of [0, 1]) {
    assert.ok(byTestId(`menu-item-adults-${i}`), `the adults' copy of the template's dish ${i} is on the screen`);
    absent(`button-till-menu-adults-${i}`, `no search on the adults' copy of the template's dish ${i}`);
  }
  assert.ok(byTestId("button-till-menu-adults-2"));
  assert.ok(byTestId("button-till-menu-adults-3"));
});

// ─── Settings > Set menu templates ───────────────────────────────────────────

await check("Settings: the till's menu at every park asked once; a dead code marked in the list, an option's by its name", async () => {
  await act(async () => { root.render(React.createElement("div")); });
  queryClient.clear();
  templates = [{
    id: "tpl1", name: "ZZ TEST Floresta set", isActive: true, createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
    items: [
      { id: "i1", type: "always_included", label: "Veggie sticks", productCode: "CF-OLD" },
      { id: "i2", type: "choice_group", label: "Pizza", options: ["Margherita", "Pepperoni"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Pepperoni: "CF-26" } },
      { id: "i3", type: "always_included", label: "", qty: 10 },
    ],
  }];
  const before = tillAsks().length;
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth }, React.createElement(SetMenuTemplatesSettings))),
    );
  });
  await settle(10);
  assert.equal(tillAsks().length, before + 1);
  assert.equal(tillAsks().at(-1)!.search, "", "every park the person may open: a template is the park group's");
  await click("toggle-template-tpl1");
  assert.equal(text("text-set-menu-view-code-dead-i1"), "No longer on the till");
  absent("text-set-menu-view-option-code-dead-i2-0", "a live option code");
  assert.equal(text("text-set-menu-view-option-code-dead-i2-1"), "Pepperoni: No longer on the till");
});

await check("Settings: the search beside a Code box writes the till's code, fills an empty name and never renames one; Save sends the codes", async () => {
  await click("edit-template-tpl1");
  assert.equal(text("text-set-menu-item-code-dead-i1"), "No longer on the till");
  await pick("button-set-menu-item-till-i1", "fries", "CF-12");
  assert.equal((required("input-set-menu-item-code-i1") as HTMLInputElement).value, "CF-12");
  absent("text-set-menu-item-code-dead-i1");
  assert.equal(text("text-set-menu-option-code-dead-i2-1"), "No longer on the till");
  await pick("button-set-menu-option-till-i2-1", "hawai", "CF-25");
  assert.equal((required("input-set-menu-option-code-i2-1") as HTMLInputElement).value, "CF-25");
  await pick("button-set-menu-item-till-i3", "juice", "CF-66-1");
  const before = asked.length;
  await click("button-save-set-menu-template");
  const put = asked.slice(before).find((a) => a.method === "PUT" && a.path === "/api/beo/set-menu-templates/tpl1");
  assert.ok(put, "Save sent the template");
  assert.deepEqual(put.body, {
    name: "ZZ TEST Floresta set",
    items: [
      { id: "i1", type: "always_included", label: "Veggie sticks", productCode: "CF-12" },
      { id: "i2", type: "choice_group", label: "Pizza", options: ["Margherita", "Pepperoni"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Pepperoni: "CF-25" } },
      { id: "i3", type: "always_included", label: "Kids juice Apple", productCode: "CF-66-1", qty: 10 },
    ],
  }, "the template's own words kept; an empty name took the till's");
});

// SCRUM-958 (SCRUM-940 point b, the staging proof): two till items named "Latte", one in the Free
// Drinks Menu at 0 baht: each listed one shows its category beside the name.
await check("two listed items of one name each show their category beside it; a name of its own shows none", async () => {
  queryClient.clear();
  tillAnswer = (parkId) => ({
    parks: [{
      parkId: parkId ?? PARK, parkName: "ZZ TEST Floresta", status: "ok", message: null, readAt: "2026-11-12T07:00:00.000Z",
      items: [...TILL, item("CF-58-4", "Latte", "Coffee", "bar", 14_500), item("CF-FREE-58-4", "Latte", "Free Drinks Menu", "bar", 0)],
    }],
  });
  await openBeo(E1);
  await click("accordion-bar-plan");
  await click("button-till-menu-bar-0");
  await setValue(required("button-till-menu-bar-0-search") as HTMLInputElement, "latte");
  assert.deepEqual(options("button-till-menu-bar-0"), ["CF-58-4", "CF-FREE-58-4"]);
  assert.equal(text("button-till-menu-bar-0-category-CF-58-4"), "· Coffee");
  assert.equal(text("button-till-menu-bar-0-category-CF-FREE-58-4"), "· Free Drinks Menu");
  await setValue(required("button-till-menu-bar-0-search") as HTMLInputElement, "cranberry");
  assert.deepEqual(options("button-till-menu-bar-0"), ["CF-66-4"]);
  absent("button-till-menu-bar-0-category-CF-66-4", "a name listed once");
});

await act(async () => { root.unmount(); });
console.log(`till-menu-ui.check: ${checks} checks passed`);
process.exit(checks === 10 ? 0 : 1);
