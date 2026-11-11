// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the BEO editor's real Kitchen
// Plan under jsdom with React, react-query and Radix as the app builds them.
//
// SCRUM-829 — the kids' menu is the main selection; the adults mirror it, the
// form's half (the server's is tests/kitchen-adults.check.ts):
//
//   1. the Adults Menu tab opens pre-filled with the kids' chosen items — the
//      same lines, read-only, under "Same as the kids' menu" — with no option
//      list of its own, no "+ EXTRA" and no "New item"; the "Different for
//      adults" switch is off; the tab counts the kids' lines;
//   2. the switch on: the adults' list is an editable copy of the kids'
//      (the same names and counts, its own line ids), with "+ EXTRA" and
//      "New item"; one line changed for the adults leaves the kids' line as it
//      was; Save sends the adults' own list with adultsDiffer: true;
//   3. the switch off again (confirmed) drops the adults' changes: the mirror
//      is back, and Save sends adults: [] with adultsDiffer: false;
//   4. a BEO saved before with two different lists opens with the switch on
//      and its adults' list as saved; one whose adults' list equals the kids'
//      opens with the switch off; one with no adults' list opens off;
//   5. the kids' tab keeps its own editing: a line added to the kids' list
//      shows in the adults' mirror at once;
//   6. AI Fill from a pasted message, Load into Editor: an answer whose
//      adults' list only names the kids' dishes again (the model's "adults
//      eat the same as the kids" in their headcount, as the staging proof
//      saw) loads as one list with the switch off; an adults' dish of their
//      own loads as their list with the switch on; "the same" loaded over
//      it turns the switch off again.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/kitchen-adults-ui.check.ts
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
const compiled = new Module(APP + "tests/kitchen-adults-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/kitchen-adults-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, BeoEventEditor } = compiled.exports;

// ─── The server, as the editor sees it ───────────────────────────────────────

type Line = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; productCode?: string };
const line = (id: string, itemName: string, quantity = 1, over: Partial<Line> = {}): Line => ({ id, itemName, quantity, notes: "", included: true, price: 0, ...over });
const KIDS: Line[] = [line("k1", "Chicken nuggets", 8), line("k2", "French fries", 2, { notes: "no salt" }), line("k3", "ZZ unicorn cake", 1, { productCode: "PARTY-ZZ829A" })];

type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
let menus: Record<string, unknown> = { kids: KIDS, adults: [], kidsFoodTime: "14:00", adultsFoodTime: "" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const EVENTS = new Map<string, Record<string, unknown>>();
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
  kitchenPlan: { foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null, menus: EVENTS.get(eventId) ?? menus, serviceSchedule: [] },
  setupPlan: null,
  barPlan: null,
  partyDetails: null,
  partyHost: null,
  timeline: [],
  beoTasks: [],
});
/** What POST /api/ai/parse-beo answers (the server's read, folded or not): set per case. */
let parseAnswer: Record<string, unknown> = {};
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the editor asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  if (url.pathname === "/api/ai/parse-beo" && method === "POST") return json(parseAnswer);
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json(beoOf(beo[1]!));
  if (beo && method === "PUT") return json({ ok: true });
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: [] });
  if (url.pathname === "/api/user") return json(USER);
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  return json([]);
};
const USER = { id: "44444444-4444-4444-8444-444444444444", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const auth = { user: USER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the editor shows ${id}`); return el; };
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
  // React's onBlur listens to focusout.
  await act(async () => { input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  await settle();
};
const text = (id: string) => required(id).textContent?.trim() ?? "";
const mirrorRows = () =>
  [...doc.querySelectorAll('[data-testid^="adults-mirror-item-"]')].map((el) =>
    [...el.querySelectorAll("span")].map((span) => span.textContent?.trim()).filter(Boolean).join(" "),
  );
const adultsRows = () => [...doc.querySelectorAll('[data-testid^="input-menu-name-adults-"]')].map((el) => el.textContent?.trim());
const kidsRows = () => [...doc.querySelectorAll('[data-testid^="input-menu-name-kids-"]')].map((el) => el.textContent?.trim());
const switchOn = () => required("switch-adults-differ").getAttribute("aria-checked") === "true" || required("switch-adults-differ").getAttribute("data-state") === "checked";

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
let mounted = "";
const open = async (eventId: string) => {
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
  await click("button-menu-tab-adults");
};
const savedMenus = async () => {
  const before = asked.length;
  await click("button-save-beo");
  const put = asked.slice(before).find((a) => a.method === "PUT" && a.path === `/api/events/${mounted}/beo`);
  assert.ok(put, "Save sent the BEO");
  return (put.body.kitchenPlan as { menus: Record<string, unknown> }).menus;
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
const E4 = "44444444-4444-4444-8444-444444444829";

await check("the adults' tab opens pre-filled with the kids' items, read-only, with no option list and nothing to add; the switch is off", async () => {
  await open(E1);
  assert.equal(switchOn(), false);
  assert.equal(text("text-adults-same-as-kids"), "Same as the kids' menu");
  assert.deepEqual(mirrorRows(), ["8 Chicken nuggets", "2 French fries no salt", "1 ZZ unicorn cake PARTY-ZZ829A"], "the kids' lines, counts, notes and codes");
  assert.equal(byTestId("button-add-menu-extra-adults"), null, "no + EXTRA");
  assert.equal(byTestId("button-add-party-menu-item-adults"), null, "no New item");
  assert.equal(byTestId("button-add-first-menu-adults"), null, "nothing to type");
  assert.equal(doc.querySelectorAll('[data-testid^="input-menu-name-adults-"]').length, 0, "no editable adults' line");
  assert.equal(doc.querySelectorAll('[data-testid^="set-menu-choice-group-"]').length, 0, "no option list");
  assert.match(text("button-menu-tab-adults"), /Adults Menu \(3\)/, "the tab counts the kids' lines");
  const saved = await savedMenus();
  assert.deepEqual(saved.adults, [], "nothing saved for the adults: their list is the kids'");
  assert.equal(saved.adultsDiffer, false);
  assert.equal((saved.kids as Line[]).length, 3);
});

await check("the switch on: an editable copy of the kids' list; one line changed for the adults only; Save sends the adults' own list", async () => {
  await click("switch-adults-differ");
  assert.equal(switchOn(), true);
  assert.equal(byTestId("text-adults-same-as-kids"), null);
  assert.deepEqual(adultsRows(), ["Chicken nuggets", "French fries", "ZZ unicorn cake"], "the copy");
  assert.ok(byTestId("button-add-menu-extra-adults"), "+ EXTRA is offered");
  assert.ok(byTestId("button-add-party-menu-item-adults"), "New item is offered");
  assert.equal(text("text-menu-qty-adults-0"), "8");
  await typeInto("input-menu-name-adults-0", "Pasta");
  await click("button-qty-minus-adults-0");
  assert.deepEqual(adultsRows(), ["Pasta", "French fries", "ZZ unicorn cake"]);
  assert.equal(text("text-menu-qty-adults-0"), "7");
  await click("button-menu-tab-kids");
  assert.deepEqual(kidsRows(), ["Chicken nuggets", "French fries", "ZZ unicorn cake"], "the kids' line is as it was");
  assert.equal(text("text-menu-qty-kids-0"), "8");
  await click("button-menu-tab-adults");
  const saved = await savedMenus();
  assert.equal(saved.adultsDiffer, true);
  const adults = saved.adults as Line[];
  assert.deepEqual(adults.map((l) => [l.itemName, l.quantity, l.notes, l.productCode ?? null]), [["Pasta", 7, "", null], ["French fries", 2, "no salt", null], ["ZZ unicorn cake", 1, "", "PARTY-ZZ829A"]]);
  assert.ok(adults.every((l, i) => l.id !== KIDS[i]!.id), "the adults' lines have ids of their own");
  assert.deepEqual((saved.kids as Line[]).map((l) => [l.itemName, l.quantity]), [["Chicken nuggets", 8], ["French fries", 2], ["ZZ unicorn cake", 1]]);
});

await check("the switch off again asks, then drops the adults' changes: the mirror is back and Save sends none", async () => {
  const before = confirmed;
  await click("switch-adults-differ");
  assert.equal(confirmed, before + 1, "asked once, since the adults' list differed");
  assert.equal(switchOn(), false);
  assert.deepEqual(mirrorRows(), ["8 Chicken nuggets", "2 French fries no salt", "1 ZZ unicorn cake PARTY-ZZ829A"]);
  const saved = await savedMenus();
  assert.deepEqual(saved.adults, []);
  assert.equal(saved.adultsDiffer, false);
});

await check("a line added to the kids' list shows in the adults' mirror at once", async () => {
  await click("button-menu-tab-kids");
  await click("button-add-menu-extra-kids");
  await typeInto("input-menu-name-kids-3", "Fruit skewers");
  await click("button-menu-tab-adults");
  assert.deepEqual(mirrorRows(), ["8 Chicken nuggets", "2 French fries no salt", "1 ZZ unicorn cake PARTY-ZZ829A", "1 Fruit skewers"]);
  assert.match(text("button-menu-tab-adults"), /Adults Menu \(4\)/);
});

await check("a BEO saved before with two different lists opens with the switch on and its adults' list as saved", async () => {
  EVENTS.set(E2, { kids: KIDS, adults: [line("a1", "Steak", 4), line("a2", "French fries", 2, { notes: "no salt" })], kidsFoodTime: "", adultsFoodTime: "" });
  await open(E2);
  assert.equal(switchOn(), true);
  assert.deepEqual(adultsRows(), ["Steak", "French fries"], "as saved, not a copy of the kids'");
  assert.match(text("button-menu-tab-adults"), /Adults Menu \(2\)/);
  const saved = await savedMenus();
  assert.equal(saved.adultsDiffer, true);
  assert.deepEqual((saved.adults as Line[]).map((l) => l.itemName), ["Steak", "French fries"]);
});

await check("a BEO saved before whose adults' list equals the kids' opens with the switch off, and so does one with no adults' list", async () => {
  EVENTS.set(E3, { kids: KIDS, adults: KIDS.map((l) => ({ ...l, id: `copy_${l.id}` })), kidsFoodTime: "", adultsFoodTime: "" });
  await open(E3);
  assert.equal(switchOn(), false);
  assert.deepEqual(mirrorRows(), ["8 Chicken nuggets", "2 French fries no salt", "1 ZZ unicorn cake PARTY-ZZ829A"]);
  assert.deepEqual((await savedMenus()).adults, [], "the duplicate list is not saved again");
  EVENTS.set(E4, { kids: KIDS, kidsFoodTime: "", adultsFoodTime: "" });
  await open(E4);
  assert.equal(switchOn(), false);
  assert.deepEqual(mirrorRows().length, 3);
  // One saved with the switch on and nothing changed yet opens on: what was saved stands.
  EVENTS.set(E1, { kids: KIDS, adults: KIDS.map((l) => ({ ...l, id: `copy_${l.id}` })), adultsDiffer: true, kidsFoodTime: "", adultsFoodTime: "" });
  queryClient.clear();
  await open(E1);
  assert.equal(switchOn(), true);
  assert.deepEqual(adultsRows(), ["Chicken nuggets", "French fries", "ZZ unicorn cake"]);
});

await check("AI Fill from a pasted message: an adults' list that only repeats the kids' dishes loads as the kids' menu, the switch off; their own dish loads with it on", async () => {
  const E5 = "55555555-5555-4555-8555-555555555829";
  EVENTS.set(E5, { kids: [], adults: [], kidsFoodTime: "", adultsFoodTime: "" });
  await open(E5);
  assert.equal(switchOn(), false);
  const NO_TEAM = { partyHost: null, entertainmentHost: null, setupResponsible: null };
  const answerLine = (itemName: string, quantity: number, notes = "") => ({ itemName, quantity, notes, included: true, price: 0 });
  const KIDS_ANSWER = [answerLine("Nuggets", 10), answerLine("Juice", 10)];
  const pasteAndLoad = async (message: string) => {
    await click("button-ai-fill-beo");
    const area = required("textarea-ai-fill-beo") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, message);
      area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await settle();
    await click("button-ai-parse-beo");
    await settle(10);
    const asked829 = asked.filter((a) => a.method === "POST" && a.path === "/api/ai/parse-beo").at(-1);
    assert.equal(asked829?.body.text, message, "the pasted message is what the server read");
    await click("button-ai-fill-confirm");
    await settle(10);
    assert.equal(byTestId("button-ai-fill-confirm"), null, "Load into Editor closed the dialog");
    await click("button-menu-tab-adults");
  };

  // The staging proof's answer, unfolded (an older server, or whatever reaches the client): the
  // kids' dishes again for the adults, in their headcount, noted. Load into Editor folds it.
  parseAnswer = {
    summary: "ZZ 829 the same",
    kitchenPlan: {
      kidsMenu: KIDS_ANSWER,
      adultsMenu: [answerLine("Nuggets", 4, "Adults eat the same as the kids"), answerLine("Juice", 4, "Adults eat the same as the kids")],
    },
    proposals: NO_TEAM,
  };
  await pasteAndLoad("Confirmed: nuggets and juice for the kids, and the adults will eat the same.");
  assert.equal(switchOn(), false, "the adults eat the kids' menu");
  assert.equal(text("text-adults-same-as-kids"), "Same as the kids' menu");
  assert.deepEqual(mirrorRows(), ["10 Nuggets", "10 Juice"], "the kids' lines, in the kids' count");
  assert.equal(doc.querySelectorAll('[data-testid^="input-menu-name-adults-"]').length, 0, "no adults' line of their own");
  let saved = await savedMenus();
  assert.deepEqual(saved.adults, []);
  assert.equal(saved.adultsDiffer, false);
  assert.deepEqual((saved.kids as Line[]).map((l) => [l.itemName, l.quantity]), [["Nuggets", 10], ["Juice", 10]]);

  // "Pasta for the adults": their own list, the switch on.
  parseAnswer = { summary: "ZZ 829 pasta", kitchenPlan: { kidsMenu: KIDS_ANSWER, adultsMenu: [answerLine("Pasta", 4)] }, proposals: NO_TEAM };
  await pasteAndLoad("Confirmed: nuggets and juice for the kids, pasta for the adults.");
  assert.equal(switchOn(), true, "the message said the adults eat something different");
  assert.deepEqual(adultsRows(), ["Pasta"]);
  assert.equal(text("text-menu-qty-adults-0"), "4");
  saved = await savedMenus();
  assert.equal(saved.adultsDiffer, true);
  assert.deepEqual((saved.adults as Line[]).map((l) => [l.itemName, l.quantity]), [["Pasta", 4]]);

  // "The same" loaded over the adults' own list: the message's food is everybody's, the switch off again.
  parseAnswer = { summary: "ZZ 829 the same again", kitchenPlan: { kidsMenu: KIDS_ANSWER }, proposals: NO_TEAM };
  await pasteAndLoad("Confirmed: nuggets and juice for the kids, and the adults will eat the same.");
  assert.equal(switchOn(), false);
  assert.deepEqual(mirrorRows(), ["10 Nuggets", "10 Juice"]);
  saved = await savedMenus();
  assert.deepEqual(saved.adults, []);
  assert.equal(saved.adultsDiffer, false);
});

await act(async () => { root.unmount(); });
console.log(`kitchen-adults-ui.check: ${checks} checks passed`);
process.exit(checks === 7 ? 0 : 1);
