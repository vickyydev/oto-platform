// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the real BEO editor under jsdom
// with React, react-query and Radix as the app builds them.
//
// SCRUM-1029 — the BEO editor regrouped into four sections stores exactly what
// the editor before it stored. The Save's body for the same party, opened and
// saved untouched, and opened, edited in ten fields and saved, is compared with
// the body the editor before the regrouping sent for the same input, recorded
// on that editor (tests/fixtures/beo-four-sections-save.json; recorded with
// BEO_SECTIONS_RECORD=1 on the commit before the regrouping, never since).
//
// Then the regrouped editor itself:
//   1. Event Info, Food & Drinks, Entertainment & Program and Internal Notes, in
//      that order, then Billing and Parent Experience; four marks above them,
//      each opening its section; Event Info open on start; several open at once;
//   2. every field of the editor before in its new section (FIELD_HOMES);
//   3. Event Info: the package's name and "Included: ..." in the Staff BEO's
//      words, from the same snapshot; the add-ons bought listed with no price;
//   4. the kitchen and bar slips' time in Food & Drinks, written as before;
//   5. "No food for this party": the menus and the cake hidden, never deleted,
//      the kitchen stored as not needed; a party stored so opens ticked;
//   6. SCRUM-1034: the deposit typed by a manager only; anyone else reads it
//      with the reason, and their Save sends it unchanged;
//   7. SCRUM-1050: the Other timed steps badge, "1 step" and "2 steps".
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-four-sections-ui.check.ts
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { FOUR_SECTIONS_EVENT, fourSectionsBeo, fourSectionsSnapshot } from "./fixtures/beo-four-sections";
import { beoPackageIncludedOf } from "../shared/beoPackageLine";

const APP = fileURLToPath(new URL("../", import.meta.url));
const GOLDEN = APP + "tests/fixtures/beo-four-sections-save.json";
const RECORD = process.env.BEO_SECTIONS_RECORD === "1";
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

// The editor, compiled as Vite builds it, with the react-query, the auth and the toaster it runs on.
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
const compiled = new Module(APP + "tests/beo-four-sections-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/beo-four-sections-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, Toaster, BeoEventEditor } = compiled.exports;

// ─── The server, as the editor sees it ───────────────────────────────────────

type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A party other than the fixture's: the fixture with these fields over it. */
const OVER = new Map<string, Record<string, unknown>>();
const beoOf = (id: string) => fourSectionsBeo(id, OVER.get(id) ?? {});

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the editor asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json(beoOf(beo[1]!));
  if (beo && method === "PUT") return json({ id: beo[1], oneDeposit: { amountThb: 3000, date: "2099-05-01" } });
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  const snapshot = /^\/api\/beo\/events\/([^/]+)\/package-snapshot$/.exec(url.pathname);
  if (snapshot && method === "PATCH") return json({ ...fourSectionsSnapshot(snapshot[1]!), ...body });
  if (snapshot) return json(fourSectionsSnapshot(snapshot[1]!));
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  if (/\/beo\/timeline\/built$/.test(url.pathname)) return json({ steps: [], untimed: [] });
  const rows = /^\/api\/events\/([^/]+)\/beo\/timeline$/.exec(url.pathname);
  if (rows) return json(beoOf(rows[1]!).timeline);
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: [] });
  if (url.pathname === "/api/user") return json(MANAGER);
  if (/\/set-menu-selections\//.test(url.pathname)) return json(null, 404);
  return json([]);
};
const MANAGER = { id: "44444444-4444-4444-8444-444444444444", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const authOf = (user: Record<string, unknown>) => ({ user, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} });
let auth = authOf(MANAGER);

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the screen shows ${id}`); return el; };
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
/** EditableText: a click opens the box under the same test id; typing and a blur commit it. */
const typeInto = async (id: string, value: string) => {
  await click(id);
  const box = required(id) as HTMLInputElement | HTMLTextAreaElement;
  assert.ok(box.tagName === "INPUT" || box.tagName === "TEXTAREA", `${id} opens for typing`);
  const proto = box.tagName === "INPUT" ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(box, value);
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
  await act(async () => { box.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  await settle();
};
const saves = (eventId = FOUR_SECTIONS_EVENT) => asked.filter((a) => a.method === "PUT" && a.path === `/api/events/${eventId}/beo`);
const text = (id: string) => byTestId(id)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
const sectionOf = (id: string) => required(id).closest("[data-section]")?.getAttribute("data-section") ?? null;
const isOpen = (section: string) => doc.querySelector(`[data-testid="accordion-${section}"]`)?.getAttribute("data-state") === "open";
/** Every section of the form opened, whatever the form calls them. */
const openEverySection = async () => {
  for (let round = 0; round < 3; round++) {
    const closed = [...doc.querySelectorAll('[data-testid^="accordion-"][data-state="closed"]')] as HTMLElement[];
    if (closed.length === 0) return;
    for (const trigger of closed) await act(async () => { trigger.click(); });
    await settle();
  }
};

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const open = async (eventId = FOUR_SECTIONS_EVENT, o: { everySection?: boolean } = {}) => {
  queryClient.clear();
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(React.Fragment, null,
            React.createElement(BeoEventEditor, { key: String(Math.random()), eventId, autoFill: null, onClose: () => undefined }),
            React.createElement(Toaster)))),
    );
  });
  await settle(12);
  assert.ok(byTestId("accordion-event-info"), "the BEO is open");
  if (o.everySection !== false) await openEverySection();
  asked.length = 0;
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

type Golden = { untouched: Record<string, unknown>; edited: Record<string, unknown> };
const recorded: Partial<Golden> = {};
const golden: Golden | null = RECORD ? null : (JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden);
const asStored = (body: Record<string, unknown>) => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

await check("the party opened and saved untouched: the Save's body is the one the editor before the four sections sent", async () => {
  await open();
  await click("button-save-beo");
  assert.equal(saves().length, 1, "one Save");
  const body = asStored(saves()[0]!.body);
  if (RECORD) recorded.untouched = body;
  else assert.deepEqual(body, golden!.untouched);
  assert.equal(body.depositChanged, false, "nobody typed in the Deposit field");
});

await check("the party edited in ten fields and saved: the Save's body is the one the editor before the four sections sent", async () => {
  await open();
  await typeInto("input-event-title", "ZZ TEST renamed party");
  await typeInto("input-num-adults", "12");
  await typeInto("input-event-decoration", "ZZ TEST unicorns");
  await typeInto("textarea-special-requests", "ZZ TEST no nuts");
  await typeInto("textarea-internal-notes", "ZZ TEST final words");
  await typeInto("input-package-name", "ZZ TEST POS renamed");
  await typeInto("textarea-package-notes", "ZZ TEST POS words");
  await typeInto("input-setup-item-1", "ZZ TEST arch");
  await click("button-qty-plus-kids-1");
  await typeInto("bar-item-qty-1", "4");
  await click("button-save-beo");
  assert.equal(saves().length, 1, "one Save");
  const body = asStored(saves()[0]!.body);
  if (RECORD) recorded.edited = body;
  else assert.deepEqual(body, golden!.edited);
  const event = body.event as Record<string, unknown>;
  assert.equal(event.title, "ZZ TEST renamed party");
  assert.equal(event.numAdults, 12);
});

if (RECORD) {
  writeFileSync(GOLDEN, JSON.stringify(recorded, null, 2) + "\n");
  console.log(`  recorded ${GOLDEN}`);
}

/**
 * SCRUM-1029: where every field of the editor before the regrouping sits now, by its test id: the
 * section ("Event Info: Decoration" now under Food & Drinks' Setup / Table, and so on). Its
 * old section is named beside it. The table in the lane's summary is this one.
 */
const FIELD_HOMES: ReadonlyArray<[string, string, string]> = [
  ["Event Info: Title", "input-event-title", "event-info"],
  ["Event Info: Date", "input-event-date", "event-info"],
  ["Event Info: Start Time", "button-start-time-edit", "event-info"],
  ["Event Info: End Time", "button-end-time-edit", "event-info"],
  ["Event Info: Child / Guest of Honor Name", "input-child-name", "event-info"],
  ["Event Info: Kid Turning Age", "input-kid-turning-age", "event-info"],
  ["Event Info: Location", "input-location-text", "event-info"],
  ["Event Info: Expected Kids", "input-num-children", "event-info"],
  ["Event Info: Expected Adults", "input-num-adults", "event-info"],
  ["Event Info: Parent / Booking Name", "input-booking-name", "event-info"],
  ["Event Info: WhatsApp Number", "input-whatsapp-phone", "event-info"],
  ["Event Info: Activities", "input-event-activities", "entertainment"],
  ["Event Info: Decoration", "input-event-decoration", "food-drinks"],
  ["Event Info: Special Requests", "textarea-special-requests", "internal-notes"],
  ["Event Info: Final Message to Parent", "textarea-internal-notes", "internal-notes"],
  ["Party Host: Assigned Party Host", "part-party-host", "event-info"],
  ["Party Host: Entertainment Host", "part-activities", "entertainment"],
  ["Party Host: Entertainment Acts", "button-add-entertainment-act", "entertainment"],
  ["Birthday Package: the package and what it includes", "beo-package-info", "event-info"],
  ["Birthday Package: Kitchen & bar slips at", "input-package-slips-time", "food-drinks"],
  ["POS: POS Name", "input-package-name", "event-info"],
  ["POS: Line Items", "package-item-row-0", "event-info"],
  ["POS: the till's Total and Outstanding", "party-details-till", "event-info"],
  ["POS: Deposit", "input-prepayment", "event-info"],
  ["POS: Deposit date", "datepicker-deposit-date", "event-info"],
  ["POS: POS Notes", "textarea-package-notes", "internal-notes"],
  ["Setup Plan: Ready by", "button-ready-by-edit", "food-drinks"],
  ["Setup Plan: Who", "input-setup-responsible", "food-drinks"],
  ["Setup Plan: Tasks", "setup-task-row-0", "food-drinks"],
  ["Setup Plan: General Setup Notes", "textarea-setup-notes", "food-drinks"],
  ["Kitchen Plan: Not Needed / Needed", "checkbox-no-food", "food-drinks"],
  ["Kitchen Plan: Kids Menu", "button-menu-tab-kids", "food-drinks"],
  ["Kitchen Plan: Adults Menu", "button-menu-tab-adults", "food-drinks"],
  ["Kitchen Plan: the kids' lines", "menu-item-kids-0", "food-drinks"],
  ["Kitchen Plan: Service time", "button-food-time-edit-kids", "food-drinks"],
  ["Kitchen Plan: Cake", "button-cake-internal", "food-drinks"],
  ["Kitchen Plan: Cake Time", "button-cake-time-edit", "food-drinks"],
  ["Kitchen Plan: Cake notes", "input-cake-notes", "food-drinks"],
  ["Bar Plan: Service Time", "button-bar-time-edit", "food-drinks"],
  ["Bar Plan: the drinks", "bar-item-0", "food-drinks"],
  ["Other timed steps: the typed steps", "timeline-item-0", "entertainment"],
  ["Other timed steps: The timeline as saved", "editor-built-timeline", "entertainment"],
];

if (!RECORD) {
  await check("four sections in the brief's order and words, then Billing and Parent Experience as they were", async () => {
    await open(FOUR_SECTIONS_EVENT, { everySection: false });
    const triggers = [...doc.querySelectorAll('[data-testid^="accordion-"]')].map((el) => el.getAttribute("data-testid"));
    assert.deepEqual(triggers, ["accordion-event-info", "accordion-food-drinks", "accordion-entertainment", "accordion-internal-notes", "accordion-billing", "accordion-parent-experience"]);
    assert.deepEqual(
      ["event-info", "food-drinks", "entertainment", "internal-notes"].map((k) => text(`accordion-${k}`)),
      ["Event Info", "Food & Drinks", "Entertainment & Program", "Internal Notes"],
      "the sections in the brief's words",
    );
    assert.deepEqual(
      ["event-info", "food-drinks", "entertainment", "internal-notes"].map((k) => [text(`section-mark-${k}`), byTestId(`section-mark-${k}`)?.getAttribute("title")]),
      [["Event", "Event Info"], ["Food & Drinks", "Food & Drinks"], ["Entertainment", "Entertainment & Program"], ["Notes", "Internal Notes"]],
      "the four marks above them, in the drawing's tab words",
    );
    assert.equal(isOpen("event-info"), true, "Event Info open as the BEO opens, as before");
    assert.equal(isOpen("food-drinks"), false);
    // A mark pressed opens its section; the others stay as they are.
    await click("section-mark-internal-notes");
    assert.equal(isOpen("internal-notes"), true);
    assert.equal(isOpen("event-info"), true, "several open at once, as before");
    await click("accordion-internal-notes");
    assert.equal(isOpen("internal-notes"), false, "a section still folds");
  });

  await check("every field of the editor before has its home in the four sections", async () => {
    await open();
    for (const [field, id, section] of FIELD_HOMES) assert.equal(sectionOf(id), section, field);
    assert.ok(byTestId("accordion-billing") && byTestId("section-billing"), "the Billing section stays as it is");
    assert.ok(byTestId("accordion-parent-experience"), "Parent Experience stays as it is");
    const order = ["part-setup", "part-food", "part-bar"].map((id) => [...doc.querySelectorAll("[data-testid]")].indexOf(required(id)));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "Food & Drinks: Setup / Table, then the food, then the bar");
  });

  await check("Event Info shows the package's name and what it includes in the print's words; the add-ons bought read-only, no price", async () => {
    await open();
    const pkg = fourSectionsSnapshot();
    assert.equal(text("text-package-name"), "ZZ TEST Weekend Birthday");
    assert.equal(text("text-package-included"), `Included: ${beoPackageIncludedOf(pkg)}`);
    assert.equal(text("text-package-included"), "Included: 10 kids + 4 adults, ZZ TEST play, basic program, cake");
    assert.ok(byTestId("package-addon-si_zz_2"), "the add-on bought");
    assert.equal(byTestId("package-addon-si_zz_3"), null, "an add-on with no quantity was not bought");
    assert.equal(byTestId("package-addon-si_zz_1"), null, "an included item is the package's, not an add-on");
    const box = required("beo-package-info").textContent ?? "";
    assert.ok(!box.includes("฿"), `no price in the package part: ${box}`);
    assert.equal(byTestId("input-qty-si_zz_2"), null, "nothing to price or count here: add-ons are the till's");
    assert.equal(byTestId("package-total-breakdown"), null, "no app-made package total in the editor");
  });

  await check("the slips' time sits in Food & Drinks and writes the same stored field as before", async () => {
    await open();
    const input = required("input-package-slips-time") as HTMLInputElement;
    assert.equal(input.value, "10:45");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "11:15");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    });
    await settle();
    const patch = asked.find((a) => a.method === "PATCH" && a.path === `/api/beo/events/${FOUR_SECTIONS_EVENT}/package-snapshot`);
    assert.deepEqual(patch?.body, { slipsTime: "11:15" }, "the package snapshot's slips time, as the Birthday Package section wrote it");
    assert.equal(saves().length, 0, "written by its own press, not by Save");
  });

  await check("No food for this party: ticked, the menus and the cake are hidden, never deleted; Save stores the kitchen not needed", async () => {
    await open();
    const box = required("checkbox-no-food");
    assert.equal(box.getAttribute("aria-checked"), "false", "the party has food");
    assert.ok(byTestId("menu-item-kids-0") && byTestId("button-cake-internal"));
    await click("checkbox-no-food");
    assert.equal(required("checkbox-no-food").getAttribute("aria-checked"), "true");
    assert.equal(byTestId("menu-item-kids-0"), null, "the menus are hidden");
    assert.equal(byTestId("button-cake-internal"), null, "the cake is hidden");
    assert.ok(text("text-no-food")?.startsWith("The kitchen is not needed for this party."));
    assert.ok(byTestId("bar-item-0"), "the bar stays");
    await click("button-save-beo");
    const kitchen = saves()[0]!.body.kitchenPlan as Record<string, unknown>;
    const before = golden!.untouched.kitchenPlan as Record<string, unknown>;
    assert.equal(kitchen.foodRequired, false, "the stored fact the print reads as Not Needed");
    assert.deepEqual({ ...kitchen, foodRequired: true }, before, "nothing else of the kitchen plan changes: the menus and the cake are kept");
    // Unticked again: everything back as it was.
    await click("checkbox-no-food");
    assert.ok(byTestId("menu-item-kids-0") && byTestId("button-cake-internal"));
  });

  await check("a party stored with the kitchen not needed opens with No food ticked", async () => {
    const id = "11111111-1111-4111-8111-000000010292";
    const stored = fourSectionsBeo(id);
    OVER.set(id, { kitchenPlan: { ...stored.kitchenPlan, foodRequired: false } });
    await open(id);
    assert.equal(required("checkbox-no-food").getAttribute("aria-checked"), "true");
    assert.equal(byTestId("menu-item-kids-0"), null);
  });

  await check("SCRUM-1034: a manager types the deposit; anyone else reads it with the reason, and their Save sends it unchanged", async () => {
    await open();
    assert.ok(byTestId("input-prepayment"), "a manager's field");
    assert.equal(byTestId("text-deposit-managers-only"), null);
    auth = authOf({ ...MANAGER, role: "staff", fullName: "ZZ TEST staff" });
    try {
      await open();
      assert.equal(byTestId("input-prepayment"), null, "no field to type in");
      assert.equal(byTestId("datepicker-deposit-date"), null);
      assert.equal(text("text-prepayment"), "฿3,000");
      assert.equal(text("text-deposit-date"), "1 May 2099");
      assert.equal(text("text-deposit-managers-only"), "Only a manager can type or change the deposit.");
      await click("button-save-beo");
      const body = saves()[0]!.body;
      assert.equal(body.depositChanged, false);
      assert.deepEqual(
        [(body.partyDetails as Record<string, unknown>).prepaymentReceived, (body.partyDetails as Record<string, unknown>).depositDate],
        [3000, "2099-05-01"],
      );
    } finally {
      auth = authOf(MANAGER);
    }
  });

  await check("SCRUM-1050: the Other timed steps badge says 1 step, 2 steps, 0 steps", async () => {
    await open();
    assert.equal(text("badge-other-steps"), "1 step");
    const two = "11111111-1111-4111-8111-000000010293";
    const row = fourSectionsBeo().timeline[0]!;
    OVER.set(two, { timeline: [row, { ...row, id: "88888888-8888-4888-8888-000000000002", label: "ZZ TEST bubbles", offsetFromStartMinutes: 120 }] });
    await open(two);
    assert.equal(text("badge-other-steps"), "2 steps");
    const none = "11111111-1111-4111-8111-000000010294";
    OVER.set(none, { timeline: [] });
    await open(none);
    assert.equal(text("badge-other-steps"), "0 steps");
  });

  // ── SCRUM-1030, SCRUM-1031, SCRUM-1042: the BEO's new fields ──────────────────────────────────
  // The party opened and saved untouched above stores none of them: its Save's body is the one the
  // editor before them sent (the golden), so a party saved before them saves exactly as it did.

  /** Set a plain input's value as a person types it, then leave it. */
  const typeValue = async (id: string, value: string) => {
    const input = required(id) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await settle();
  };
  const choose = async (trigger: string, option: string) => { await click(trigger); await click(option); };
  const order = (...ids: string[]) => ids.map((id) => [...doc.querySelectorAll("[data-testid]")].indexOf(required(id)));

  await check("SCRUM-1031: Event Info, after the package and before POS: the expected extra guests and the socks choice, empty on a party that stores none", async () => {
    await open();
    assert.equal(sectionOf("beo-guests-socks"), "event-info");
    const at = order("part-package", "part-guests-socks", "part-pos");
    assert.deepEqual([...at].sort((a, b) => a - b), at, "the drawing's order: package, extra guests and socks, POS");
    assert.equal(text("beo-expected-extra")?.startsWith("Expected extra (add to POS on arrival)"), true);
    assert.equal((required("input-expected-extra-kids") as HTMLInputElement).value, "");
    assert.equal((required("input-expected-extra-adults") as HTMLInputElement).value, "");
    assert.equal(text("select-socks-arrangement"), "Not set", "left for a manager to decide");
    assert.equal(byTestId("input-socks-note"), null);
    assert.equal(text("text-socks-hint"), "How socks will be charged (not linked to POS)");
    // The brief's three options, in its words, and "Not set".
    await click("select-socks-arrangement");
    assert.deepEqual(
      ["option-socks-not-set", "option-socks-birthday_parent", "option-socks-guests", "option-socks-other"].map(text),
      ["Not set", "Birthday Parent Pays", "Guests Pay Individually", "Other / Custom"],
    );
  });

  await check("SCRUM-1031: a party that stores them opens with them; an untouched Save sends them as stored; a change is saved, the note only with Other / Custom", async () => {
    const id = "11111111-1111-4111-8111-000000010311";
    OVER.set(id, { expectedExtraKids: 1, expectedExtraAdults: 6, socksArrangement: "other", socksNote: "ZZ TEST grandma pays" });
    await open(id);
    assert.equal((required("input-expected-extra-kids") as HTMLInputElement).value, "1");
    assert.equal((required("input-expected-extra-adults") as HTMLInputElement).value, "6");
    assert.equal(text("select-socks-arrangement"), "Other / Custom");
    assert.equal((required("input-socks-note") as HTMLInputElement).value, "ZZ TEST grandma pays");
    await click("button-save-beo");
    const untouched = saves(id)[0]!.body.event as Record<string, unknown>;
    assert.deepEqual(
      [untouched.expectedExtraKids, untouched.expectedExtraAdults, untouched.socksArrangement, untouched.socksNote],
      [1, 6, "other", "ZZ TEST grandma pays"],
    );
    await open(id);
    await typeValue("input-expected-extra-kids", "2");
    await typeValue("input-expected-extra-adults", "");
    await typeValue("input-expected-extra-adults", "1.5");
    await choose("select-socks-arrangement", "option-socks-guests");
    assert.equal(byTestId("input-socks-note"), null, "the note belongs to Other / Custom");
    await click("button-save-beo");
    const changed = saves(id)[0]!.body.event as Record<string, unknown>;
    assert.deepEqual(
      [changed.expectedExtraKids, changed.expectedExtraAdults, changed.socksArrangement, changed.socksNote],
      [2, null, "guests", null],
      "a count emptied is none; a count that is not a whole number is not taken",
    );
    // Other / Custom again brings the note back; Not set clears both.
    await open(id);
    await choose("select-socks-arrangement", "option-socks-guests");
    await choose("select-socks-arrangement", "option-socks-other");
    assert.equal((required("input-socks-note") as HTMLInputElement).value, "ZZ TEST grandma pays");
    await choose("select-socks-arrangement", "option-socks-not-set");
    await click("button-save-beo");
    const cleared = saves(id)[0]!.body.event as Record<string, unknown>;
    assert.deepEqual([cleared.socksArrangement, cleared.socksNote], [null, null]);
    // Nothing of them reaches the party's money: the Save's billing and Party Details are as stored.
    assert.deepEqual(saves(id)[0]!.body.partyDetails, golden!.untouched.partyDetails);
    assert.deepEqual(saves(id)[0]!.body.billing, golden!.untouched.billing);
  });

  await check("SCRUM-1031: only on a party the till settles; a camp shows neither", async () => {
    const id = "11111111-1111-4111-8111-000000010312";
    OVER.set(id, { eventType: "camp" });
    await open(id);
    assert.equal(byTestId("part-guests-socks"), null);
  });

  await check("SCRUM-1030: Kitchen Notes at the top of the food, in Food & Drinks; an untouched Save leaves them to the plan; a change is saved", async () => {
    const id = "11111111-1111-4111-8111-000000010301";
    const stored = fourSectionsBeo(id);
    OVER.set(id, { kitchenPlan: { ...stored.kitchenPlan, kitchenNotes: "ZZ TEST ทำอาหารเด็กก่อน, then the adults" } });
    await open(id);
    assert.equal(sectionOf("textarea-kitchen-notes"), "food-drinks");
    const at = order("checkbox-no-food", "textarea-kitchen-notes", "button-menu-tab-kids");
    assert.deepEqual([...at].sort((a, b) => a - b), at, "under the No food tick, before the menus");
    assert.equal(text("textarea-kitchen-notes"), "ZZ TEST ทำอาหารเด็กก่อน, then the adults");
    await click("button-save-beo");
    assert.equal("kitchenNotes" in (saves(id)[0]!.body.kitchenPlan as Record<string, unknown>), false, "not named: the plan keeps its own (the Day-of view may have changed them)");
    await open(id);
    await typeInto("textarea-kitchen-notes", "ZZ TEST parents order more on arrival");
    await click("button-save-beo");
    assert.equal((saves(id)[0]!.body.kitchenPlan as Record<string, unknown>).kitchenNotes, "ZZ TEST parents order more on arrival");
    // Hidden with No food, never deleted.
    await open(id);
    await click("checkbox-no-food");
    assert.equal(byTestId("textarea-kitchen-notes"), null);
    await click("button-save-beo");
    assert.equal("kitchenNotes" in (saves(id)[0]!.body.kitchenPlan as Record<string, unknown>), false);
  });

  await check("SCRUM-1042: the birthday package's waffles read Adult Waffles in the editor; the Save and every request keep Mini Waffles", async () => {
    const id = "11111111-1111-4111-8111-000000010421";
    const stored = fourSectionsBeo(id);
    const waffles = { id: "set_item_zz_sweets_Mini_Waffles", itemName: "Mini Waffles", quantity: 1, notes: "(Sweets x2)", included: true, price: 0, source: "set_menu", groupId: "item_zz_sweets" };
    const typed = { id: "menu_zz_typed", itemName: "Mini waffles", quantity: 2, notes: "", included: false, price: 0, source: "additional" };
    const menus = { ...stored.kitchenPlan.menus, kids: [...stored.kitchenPlan.menus.kids, waffles, typed], adults: [], adultsDiffer: false };
    OVER.set(id, { kitchenPlan: { ...stored.kitchenPlan, menus } });
    await open(id);
    assert.equal(text("input-menu-name-kids-2"), "Adult Waffles", "the package's item");
    assert.equal(text("input-menu-name-kids-3"), "Mini waffles", "a dish typed by hand keeps its name");
    assert.equal(text("input-menu-name-kids-0"), "ZZ TEST Margherita", "any other set dish keeps its name");
    // The adults eat the kids' menu: their mirror reads the same.
    await click("button-menu-tab-adults");
    assert.ok(text("adults-mirror-item-2")?.includes("Adult Waffles"), text("adults-mirror-item-2") ?? "");
    asked.length = 0;
    await click("button-save-beo");
    const kids = (saves(id)[0]!.body.kitchenPlan as { menus: { kids: Array<Record<string, unknown>> } }).menus.kids;
    assert.deepEqual([kids[2]!.itemName, kids[2]!.groupId, kids[3]!.itemName], ["Mini Waffles", "item_zz_sweets", "Mini waffles"], "the stored names, unchanged");
    assert.equal(asked.some((a) => JSON.stringify(a.body).includes("Adult Waffles")), false, "no request carries the BEO's display name");
  });
}

await act(async () => { root.unmount(); });
console.log(`beo-four-sections-ui.check: ${checks} checks passed`);
process.exit(checks === (RECORD ? 2 : 15) ? 0 : 1);
