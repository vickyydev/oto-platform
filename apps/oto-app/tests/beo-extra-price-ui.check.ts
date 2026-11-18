// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the BEO editor's real Kitchen
// and Bar Plan under jsdom with React, react-query and Radix as the app builds
// them.
//
// SCRUM-949 — an EXTRA line of the BEO's kitchen and bar plan shows its price
// and staff can enter it (the rule itself: tests/beo-extra-price.check.ts):
//
//   1. every EXTRA line of the kids' menu and the bar plan shows a price box
//      beside its count, in the style of the cake's Price box; a SET line
//      shows none;
//   2. the box shows a price the line holds ("each - 450 total" since
//      SCRUM-991); an empty box on a coded line shows the till's price as
//      what will be charged ("till price 290"); an empty box on a line with
//      no code says "Price unresolved - not charged";
//   3. staff enter, change and clear it; Save sends it as the line's price
//      for each item (cleared: 0, none); the plan's extras total follows;
//   4. a weekend party: the till's weekend price, said so;
//   5. the adults' own list: the copy of a kids' line is charged once, with
//      the kids' line; a line of their own shows its own;
//   6. a till whose menu cannot be read: a coded line's price is said
//      unresolved (SCRUM-991), and no total (never a wrong figure);
//   7. SCRUM-940 point 2: the first line made from "Nothing on the kids' menu
//      yet" is saved as the EXTRA it shows;
//   8. SCRUM-999: a billed EXTRA keeps its billing marks through a reload and
//      a Save, on the kitchen's lists as on the bar's, so a count raised after
//      the party is settled is still a line the additional bill counts.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-extra-price-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { approvedBeoBillingSources } from "../shared/beoBillingSource";

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

// The editor, compiled as Vite builds it, with the react-query and auth it runs on.
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
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/beo-extra-price-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/beo-extra-price-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, BeoEventEditor } = compiled.exports;

// ─── The server, as the screen sees it ───────────────────────────────────────

const PARK = "33333333-3333-4333-8333-333333333949";
const item = (code: string, name: string, category: string, station: "kitchen" | "bar", priceSatang: number, priceWeekendSatang = priceSatang) => ({
  code, name, category, parentCategory: station === "kitchen" ? "Food" : "Drinks", station, priceSatang, priceWeekendSatang, beoOnly: false,
});
const TILL = [
  item("CF-24", "Margherita", "Pizza", "kitchen", 29_000, 31_000),
  item("CF-12", "French fries", "Sides", "kitchen", 12_000),
  item("CF-66-1", "Kids juice Apple", "Juice", "bar", 9_050),
];
type Reading = { parks: Array<Record<string, unknown>> };
let tillAnswer: (parkId: string | null) => Reading = (parkId) => ({
  parks: [{ parkId: parkId ?? PARK, parkName: "ZZ TEST Floresta", status: "ok", message: null, items: TILL, readAt: "2026-11-12T07:00:00.000Z" }],
});

type Line = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; groupId?: string; productCode?: string; chargeApproved?: boolean; billingSync?: string };
const line = (id: string, itemName: string, over: Partial<Line> = {}): Line => ({ id, itemName, quantity: 1, notes: "", included: false, price: 0, ...over });
type Held = { date: string; kids: Line[]; adults?: Line[]; adultsDiffer?: boolean; bar: Line[] };

type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const BEOS = new Map<string, Held>();
const beoOf = (eventId: string) => {
  const held = BEOS.get(eventId)!;
  return {
    id: eventId, title: "ZZ TEST BEO 949", eventDate: held.date, startTime: "13:00", endTime: "16:00", numChildren: 10, numAdults: 4,
    childName: "Mali", bookingName: "Nok", branchId: PARK, locationText: "Party room 1",
    kitchenPlan: {
      foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null,
      menus: { kids: held.kids, adults: held.adults ?? [], ...(held.adultsDiffer !== undefined ? { adultsDiffer: held.adultsDiffer } : {}), kidsFoodTime: "14:00", adultsFoodTime: "" },
      serviceSchedule: [],
    },
    setupPlan: null, barPlan: { serviceTime: "14:00", items: held.bar }, partyDetails: null, partyHost: null, timeline: [], beoTasks: [],
  };
};
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the screen asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  if (url.pathname === "/api/beo/till-menu" && method === "GET") return json(tillAnswer(url.searchParams.get("parkId")));
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json(beoOf(beo[1]!));
  if (beo && method === "PUT") return json({ ok: true });
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: [] });
  if (url.pathname === "/api/user") return json(USER);
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  if (/^\/api\/beo\/set-menu-selections\/[^/]+$/.test(url.pathname)) return json({ error: "Not found" }, 404);
  return json([]);
};
const USER = { id: "44444444-4444-4444-8444-444444444949", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const auth = { user: USER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the screen shows ${id}`); return el; };
/** The screen does not show `id` (a node is never handed to `assert`: see tests/till-menu-ui.check.ts). */
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

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
let mounted = "";
const openBeo = async (eventId: string) => {
  mounted = eventId;
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(BeoEventEditor, { key: eventId, eventId, onClose: () => undefined }))),
    );
  });
  await settle(10);
  assert.ok(byTestId("accordion-kitchen-plan"), `the BEO ${eventId} is open`);
  await click("accordion-kitchen-plan");
  await click("accordion-bar-plan");
};
const saved = async () => {
  const before = asked.length;
  await click("button-save-beo");
  const put = asked.slice(before).find((a) => a.method === "PUT" && a.path === `/api/events/${mounted}/beo`);
  assert.ok(put, "Save sent the BEO");
  return put.body as { kitchenPlan: { menus: { kids: Line[]; adults: Line[]; adultsDiffer?: boolean } }; barPlan: { items: Line[] } };
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
  } catch (err) {
    const words = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`  FAIL  ${title}\n${words.slice(0, 4000)}`);
    process.exit(1);
  }
  checks += 1;
  console.log(`  ok  ${title}`);
};

const WEEKDAY = "2026-12-02";
const SATURDAY = "2026-12-05";
const E1 = "11111111-1111-4111-8111-111111111949";
const E2 = "22222222-2222-4222-8222-222222222949";
const E3 = "33333333-3333-4333-8333-333333333949";
BEOS.set(E1, {
  date: WEEKDAY,
  kids: [
    line("k1", "Margherita", { quantity: 2, productCode: "CF-24" }),
    line("k2", "Durian pizza"),
    line("k3", "French fries", { quantity: 3, productCode: "CF-12", price: 150 }),
    line("k4", "Hawaiian", { source: "set_menu", price: 0 }),
  ],
  bar: [line("b1", "Kids juice Apple", { quantity: 10, productCode: "CF-66-1" }), line("b2", "Juice jug", { source: "set_menu" })],
});

await check("every EXTRA line shows a price box beside its count; a SET line shows none", async () => {
  await openBeo(E1);
  for (const id of ["kids-0", "kids-1", "kids-2", "bar-0"]) assert.ok(byTestId(`input-menu-price-${id}`), `a price box on ${id}`);
  absent("input-menu-price-kids-3", "a SET line has no price box");
  absent("input-menu-price-bar-1", "a SET drink has no price box");
  // In the cake box's style: a click-to-edit number, "Price ฿" while empty.
  assert.equal(text("input-menu-price-kids-0"), "Price ฿");
  assert.equal(text("input-menu-price-kids-2"), "150");
});

await check("what the till will charge: the till's price for an empty coded box, each for an entered price, not charged with neither; the totals", () => {
  assert.equal(text("text-menu-price-hint-kids-0"), "till price 290");
  // SCRUM-991 (8a09885a2): the hint names an unknown price and says an entered price's line total.
  assert.equal(text("text-menu-price-hint-kids-1"), "Price unresolved - not charged");
  assert.equal(text("text-menu-price-hint-kids-2"), "each - 450 total");
  assert.equal(text("text-menu-price-hint-bar-0"), "till price 90.5");
  // 2 × 290 + 3 × 150; 10 × 90.50.
  assert.equal(text("text-kitchen-extras-total"), "Extras charged at the till: ฿1,030");
  assert.equal(text("text-bar-extras-total"), "Extras charged at the till: ฿905");
});

await check("staff enter, change and clear a price; Save sends it for each item; the totals follow", async () => {
  await typeInto("input-menu-price-kids-0", "300");
  assert.equal(text("text-menu-price-hint-kids-0"), "each - 600 total");
  await typeInto("input-menu-price-kids-2", "");
  assert.equal(text("text-menu-price-hint-kids-2"), "till price 120", "cleared: the till's price again");
  await typeInto("input-menu-price-bar-0", "100");
  assert.equal(text("text-kitchen-extras-total"), "Extras charged at the till: ฿960");
  assert.equal(text("text-bar-extras-total"), "Extras charged at the till: ฿1,000");
  const body = await saved();
  assert.deepEqual(body.kitchenPlan.menus.kids.map((l) => [l.itemName, l.price]), [["Margherita", 300], ["Durian pizza", 0], ["French fries", 0], ["Hawaiian", 0]]);
  assert.deepEqual(body.barPlan.items.map((l) => [l.itemName, l.price]), [["Kids juice Apple", 100], ["Juice jug", 0]]);
});

await check("a weekend party: the till's weekend price, said so; the adults' copy of a kids' line is charged once", async () => {
  BEOS.set(E2, {
    date: SATURDAY,
    kids: [line("k1", "Margherita", { quantity: 2, productCode: "CF-24" })],
    adults: [line("a1", "Margherita", { quantity: 2, productCode: "CF-24" }), line("a2", "Margherita", { quantity: 3, productCode: "CF-24" })],
    adultsDiffer: true,
    bar: [],
  });
  await openBeo(E2);
  assert.equal(text("text-menu-price-hint-kids-0"), "till price 310 (weekend)");
  await click("button-menu-tab-adults");
  assert.equal(text("text-menu-price-hint-adults-0"), "charged once, with the kids' line");
  assert.equal(text("text-menu-price-hint-adults-1"), "till price 310 (weekend)");
  // 2 × 310 for the kids, 3 × 310 for the adults' own.
  assert.equal(text("text-kitchen-extras-total"), "Extras charged at the till: ฿1,550");
  absent("text-bar-extras-total", "no EXTRA drink: no bar total");
});

await check("a till whose menu cannot be read: a coded line's price is said unresolved, never a figure, and no total", async () => {
  queryClient.clear();
  tillAnswer = (parkId) => ({ parks: [{ parkId: parkId ?? PARK, parkName: "ZZ TEST Floresta", status: "not_reachable", message: "The till did not answer.", items: [], readAt: null }] });
  BEOS.set(E3, { date: WEEKDAY, kids: [line("k1", "Margherita", { quantity: 2, productCode: "CF-24" }), line("k2", "Durian pizza"), line("k3", "Chips", { price: 80 })], bar: [] });
  await openBeo(E3);
  // SCRUM-991 (8a09885a2): no till price said while the till's menu is not read; the price is
  // named unresolved where the hint once stayed off the screen.
  assert.equal(text("text-menu-price-hint-kids-0"), "Price unresolved", "no till price said while the till's menu is not read");
  assert.equal(text("text-menu-price-hint-kids-1"), "Price unresolved - not charged");
  assert.equal(text("text-menu-price-hint-kids-2"), "each - 80 total");
  absent("text-kitchen-extras-total", "no total rather than a wrong one");
});

// SCRUM-958 (SCRUM-940 point 2): the first line made from "Nothing on the kids' menu yet" showed the EXTRA
// badge but was saved as included; it is saved as the EXTRA it shows, its price box beside it.
await check("the first line made from Nothing on the kids' menu yet is the EXTRA it shows, and is saved as one", async () => {
  const E4 = "44444444-4444-4444-8444-444444444949";
  BEOS.set(E4, { date: WEEKDAY, kids: [], bar: [] });
  await openBeo(E4);
  await click("button-add-first-menu-kids");
  assert.equal(text("badge-menu-incl-kids-0"), "EXTRA");
  assert.ok(byTestId("input-menu-price-kids-0"), "an EXTRA: its price box");
  await typeInto("input-menu-name-kids-0", "Durian pizza");
  await typeInto("input-menu-price-kids-0", "250");
  const body = await saved();
  assert.deepEqual(body.kitchenPlan.menus.kids.map((l) => [l.itemName, l.included, l.source ?? null, l.price]), [["Durian pizza", false, "additional", 250]]);
});

// SCRUM-999: a kitchen EXTRA billed after the party was settled lost its billing marks when the BEO
// was opened again (the bar's kept theirs), so the next Save stored it unmarked and a count raised
// then was billed for nothing. Each list now opens its lines with their marks, as the bar always did.
await check("a billed EXTRA keeps its billing marks through a reload and a Save, kitchen and bar alike; raised, it is still billed", async () => {
  const E5 = "55555555-5555-4555-8555-555555555949";
  const billed = { chargeApproved: true, billingSync: "synced" };
  BEOS.set(E5, {
    date: WEEKDAY,
    kids: [
      line("k1", "ZZ TEST dish A", { price: 25.03, source: "additional", productCode: "PARTY-ZZ999A", ...billed }),
      // A line saved before its mark existed, or saved without it: opened and saved as it is, never marked.
      line("k2", "ZZ TEST dish B", { price: 10, source: "additional" }),
    ],
    adults: [line("a1", "ZZ TEST adults' own dish", { price: 40, source: "additional", ...billed })],
    adultsDiffer: true,
    bar: [line("b1", "ZZ TEST drink B", { price: 30, productCode: "PARTY-ZZ999B", ...billed })],
  });
  await openBeo(E5);
  await click("button-qty-plus-kids-0");
  await typeInto("bar-item-qty-0", "2");
  const body = await saved();
  const marks = (l: Line) => [l.id, l.quantity, l.chargeApproved ?? null, l.billingSync ?? null];
  assert.deepEqual(body.kitchenPlan.menus.kids.map(marks), [["k1", 2, true, "synced"], ["k2", 1, null, null]], "the kids' list keeps its marks");
  assert.deepEqual(body.kitchenPlan.menus.adults.map(marks), [["a1", 1, true, "synced"]], "the adults' own list keeps its marks");
  assert.deepEqual(body.barPlan.items.map(marks), [["b1", 2, true, "synced"]], "the bar keeps its marks, as it always did");
  // What the additional bill counts once this Save is stored (shared/beoBillingSource.ts): the raised
  // kitchen line and the raised drink, each at its new count, and the adults' own line.
  const counted = approvedBeoBillingSources(body.kitchenPlan.menus, body.barPlan.items).map((l) => [l.id, l.quantity, l.billingArea]);
  assert.deepEqual(counted, [["k1", 2, "food"], ["a1", 1, "food"], ["b1", 2, "bar"]]);
});

await act(async () => { root.unmount(); });
console.log(`beo-extra-price-ui.check: ${checks} checks passed`);
process.exit(checks === 7 ? 0 : 1);
