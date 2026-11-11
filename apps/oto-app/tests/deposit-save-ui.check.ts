// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the real BEO editor under jsdom
// with React, react-query and Radix as the app builds them.
//
// SCRUM-840 — a Save never lowers or clears a deposit it did not deliberately
// change; the BEO form's half (the routes' is tests/deposit-save.check.ts). The
// stand-in server keeps the rule's first line as the real one does: a Save
// whose `expectedDeposit` is not the stored deposit keeps the stored one and
// answers `depositSave`.
//
//   1. the BEO open with no deposit, the family pays ฿3,000 through the chat,
//      Save: the form sends the deposit it was opened with and says its own
//      was not changed (nobody typed in the field); the answer's plain words are
//      shown — "The deposit changed while this BEO was open (now ฿3,000). Your
//      other changes were saved." — and the Deposit field reads 3,000;
//   2. a figure typed on a fresh form travels with Save, beside the deposit
//      the form was opened with, and is saved with the usual words;
//   3. a stale form that also typed a figure: the Save carries it, the server
//      keeps the paid deposit, the words say so and the field takes the paid
//      figure (the typed one is gone, in plain sight);
//   4. the window comes back: the deposit is read again on its own, the field
//      takes it and the form says so — with Billing closed; the next Save is
//      judged by the deposit just read;
//   5. the till's figures, read while the BEO is open, show another deposit
//      than the form's: the deposit is read again the same way;
//   6. a deposit typed in the field and not saved yet is NOT read as a move:
//      the till still shows the saved figure, and the field keeps what was
//      typed.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/deposit-save-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { quoteAnswer } from "./fixtures/till-billing";

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
      export { toast } from './client/src/hooks/use-toast';
      export { BeoEventEditor } from './client/src/components/beo/beo-event-editor';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/deposit-save-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/deposit-save-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, Toaster, toast, BeoEventEditor } = compiled.exports;

// ─── The server, as the editor sees it ───────────────────────────────────────

type Deposit = { amountThb: number; date: string | null };
type Asked = { method: string; path: string; body: Record<string, unknown> };
const PARK = "33333333-3333-4333-8333-333333333333";
const DAY = "2099-03-02";
const NONE: Deposit = { amountThb: 0, date: null };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const same = (a: Deposit, b: Deposit) => a.amountThb === b.amountThb && (a.date ?? null) === (b.date ?? null);
const baht = (n: number) => `฿${n.toLocaleString("en-GB")}`;

/** A party as the stand-in server stores it: its one deposit, Party Details' other keys, and what the till last read. */
type Party = { title: string; deposit: Deposit; details: Record<string, unknown>; tillDepositThb: number | null };
const parties = new Map<string, Party>();
const partyOf = (id: string) => parties.get(id)!;
let made = 0;
const party = (deposit: Deposit, o: { till?: boolean } = {}) => {
  made += 1;
  const id = `11111111-1111-4111-8111-${String(840_000_000_000 + made)}`;
  parties.set(id, { title: `ZZ TEST 840 party ${made}`, deposit, details: { packageName: "ZZ TEST", packageBasePrice: 0, items: [], notes: "" }, tillDepositThb: o.till ? deposit.amountThb : null });
  return id;
};
/** The family pays through the chat: the platform's fact moves the stored deposit; no screen is told. */
const familyPays = (id: string, amountThb: number, date = DAY) => {
  const p = partyOf(id);
  p.deposit = { amountThb: p.deposit.amountThb + amountThb, date };
};
const beoOf = (id: string) => {
  const p = partyOf(id);
  return {
    id,
    title: p.title,
    eventDate: "2099-03-14",
    startTime: "14:00",
    endTime: "17:00",
    numChildren: 12,
    numAdults: 4,
    childName: "",
    bookingName: "",
    activities: "",
    decoration: "",
    specialRequests: "",
    locationText: "",
    kidTurningAge: 6,
    eventType: "birthday",
    branchId: PARK,
    inboxConversationId: null,
    kitchenPlan: null,
    setupPlan: null,
    barPlan: null,
    partyHost: null,
    beoTasks: [],
    timeline: [],
    prepaymentAmount: p.deposit.amountThb || null,
    prepaymentDate: p.deposit.date,
    partyDetails: { ...p.details, prepaymentReceived: p.deposit.amountThb, ...(p.deposit.date ? { depositDate: p.deposit.date } : {}) },
    oneDeposit: p.deposit,
  };
};

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the editor asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json(beoOf(beo[1]!));
  if (beo && method === "PUT") {
    // The rule's first line, as server/lib/depositSaveGuard.ts keeps it.
    const p = partyOf(beo[1]!);
    const expected = body.expectedDeposit as Deposit | undefined;
    const { prepaymentReceived, depositDate, ...details } = (body.partyDetails ?? {}) as Record<string, unknown>;
    p.details = details;
    const named = body.depositChanged !== false && (prepaymentReceived !== undefined || depositDate !== undefined);
    if (expected && !same(expected, p.deposit)) {
      return json({
        id: beo[1],
        oneDeposit: p.deposit,
        depositSave: { kept: true, reason: "moved", ...p.deposit, message: `The deposit changed while this BEO was open (now ${baht(p.deposit.amountThb)}). Your other changes were saved.` },
      });
    }
    if (named) p.deposit = Number(prepaymentReceived) > 0 ? { amountThb: Number(prepaymentReceived), date: typeof depositDate === "string" && depositDate ? depositDate : null } : NONE;
    return json({ id: beo[1], oneDeposit: p.deposit });
  }
  const till = /^\/api\/events\/([^/]+)\/beo\/till-billing$/.exec(url.pathname);
  if (till) {
    const p = partyOf(till[1]!);
    if (p.tillDepositThb === null) return json({ status: "not_reachable", message: "The till did not answer." });
    const answer = quoteAnswer(till[1]!);
    answer.quote.depositSatang = p.tillDepositThb * 100;
    answer.quote.balanceSatang = answer.quote.totalSatang - answer.quote.depositSatang;
    return json({ status: "ok", billing: answer, readAt: "2099-03-02T08:00:00.000Z" });
  }
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: [] });
  if (url.pathname === "/api/user") return json(USER);
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  if (/package-snapshot$/.test(url.pathname)) return json(null);
  return json([]);
};
const USER = { id: "44444444-4444-4444-8444-444444444444", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const auth = { user: USER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the screen shows ${id}`); return el; };
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
  await settle();
  await act(async () => { input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  await settle();
};
const text = (id: string) => byTestId(id)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
const says = (words: string) => (doc.body.textContent ?? "").replace(/\s+/g, " ").includes(words);
const saves = (eventId: string) => asked.filter((a) => a.method === "PUT" && a.path === `/api/events/${eventId}/beo`);
const reads = (eventId: string) => asked.filter((a) => a.method === "GET" && a.path === `/api/events/${eventId}/beo`);
const partyDetailsOf = (save: Asked) => save.body.partyDetails as Record<string, unknown>;
/** The Deposit field of Party Details, as the person reads it: its digits (the separator is the machine's). */
const depositField = () => (text("input-prepayment") ?? "").replace(/[^0-9]/g, "");

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const open = async (eventId: string) => {
  queryClient.clear();
  // The words of the party before are taken down: each check reads its own.
  await act(async () => { toast({ title: "ZZ TEST" }).dismiss(); });
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(React.Fragment, null,
            React.createElement(BeoEventEditor, { key: eventId, eventId, autoFill: null, onClose: () => undefined }),
            React.createElement(Toaster)))),
    );
  });
  await settle(12);
  assert.ok(byTestId("accordion-event-info"), `the BEO ${eventId} is open`);
  await click("accordion-party-details");
  assert.ok(byTestId("input-prepayment"), "Party Details shows the Deposit field");
  assert.equal(byTestId("section-billing"), null, "the Billing section stays closed throughout");
  asked.length = 0;
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const MOVED_3000 = "The deposit changed while this BEO was open (now ฿3,000). Your other changes were saved.";

await check("the BEO open with no deposit, the family pays ฿3,000, Save: no deposit of the form's own is sent, the words are shown and the field reads 3,000", async () => {
  const id = party(NONE);
  await open(id);
  assert.equal(depositField(), "0", "no deposit when the BEO was opened");
  familyPays(id, 3000);
  await click("button-save-beo");
  assert.equal(saves(id).length, 1, "one Save");
  const sent = saves(id)[0]!;
  assert.deepEqual(sent.body.expectedDeposit, NONE, "the Save says which deposit the form was opened with");
  assert.equal(sent.body.depositChanged, false, "nobody typed in the Deposit field: the Save says the deposit was not changed");
  assert.equal(partyDetailsOf(sent).packageName, "ZZ TEST", "Party Details' other fields travel as before");
  assert.deepEqual(partyOf(id).deposit, { amountThb: 3000, date: DAY }, "the paid deposit stands");
  assert.ok(says(MOVED_3000), "the plain words are shown");
  assert.ok(says("BEO saved. The deposit was not changed"));
  assert.ok(!says("BEO data saved successfully"), "the usual words are not shown beside them");
  assert.equal(depositField(), "3000", "the Deposit field reads the paid deposit");
});

await check("a figure typed on a fresh form travels with Save, beside the deposit the form was opened with, and is saved", async () => {
  const id = party({ amountThb: 3000, date: DAY });
  await open(id);
  assert.equal(depositField(), "3000");
  await typeInto("input-prepayment", "4000");
  await click("button-save-beo");
  const sent = saves(id)[0]!;
  assert.deepEqual(sent.body.expectedDeposit, { amountThb: 3000, date: DAY });
  assert.equal(sent.body.depositChanged, true);
  assert.equal(partyDetailsOf(sent).prepaymentReceived, 4000);
  assert.equal(partyDetailsOf(sent).depositDate, DAY);
  assert.deepEqual(partyOf(id).deposit, { amountThb: 4000, date: DAY });
  assert.ok(says("BEO data saved successfully"));
  assert.equal(depositField(), "4000");
  // Saved again untouched: the form was read again, and names no deposit.
  asked.length = 0;
  await click("button-save-beo");
  const again = saves(id)[0]!;
  assert.deepEqual(again.body.expectedDeposit, { amountThb: 4000, date: DAY });
  assert.equal(again.body.depositChanged, false);
});

await check("a stale form that also typed a figure: the server keeps the paid deposit, the words say so and the field takes the paid figure", async () => {
  const id = party({ amountThb: 4000, date: DAY });
  await open(id);
  familyPays(id, 3000, "2099-03-03");
  await typeInto("input-prepayment", "500");
  assert.equal(depositField(), "500");
  await click("button-save-beo");
  const sent = saves(id)[0]!;
  assert.deepEqual(sent.body.expectedDeposit, { amountThb: 4000, date: DAY });
  assert.equal(sent.body.depositChanged, true);
  assert.equal(partyDetailsOf(sent).prepaymentReceived, 500, "the typed figure travels: the server decides");
  assert.deepEqual(partyOf(id).deposit, { amountThb: 7000, date: "2099-03-03" }, "the paid deposit stands");
  assert.ok(says("The deposit changed while this BEO was open (now ฿7,000). Your other changes were saved."));
  assert.equal(depositField(), "7000");
});

await check("the window comes back: the deposit is read again on its own, Billing closed; the field takes it, the form says so, the next Save is judged by it", async () => {
  const id = party({ amountThb: 7000, date: DAY });
  await open(id);
  familyPays(id, 2000, "2099-03-04");
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
  await settle(10);
  assert.ok(reads(id).length >= 1, "the BEO's deposit was read again");
  assert.equal(saves(id).length, 0, "nothing was saved by reading");
  assert.equal(depositField(), "9000");
  assert.ok(says("The deposit changed while this BEO was open (now ฿9,000)."));
  assert.ok(!says("Your other changes were saved."), "nothing was saved, so nothing says so");
  // The window comes back again with nothing moved: nothing is said twice.
  const said = (doc.body.textContent ?? "").split("The deposit changed while this BEO was open").length;
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
  await settle(10);
  assert.equal((doc.body.textContent ?? "").split("The deposit changed while this BEO was open").length, said);
  await click("button-save-beo");
  const sent = saves(id)[0]!;
  assert.deepEqual(sent.body.expectedDeposit, { amountThb: 9000, date: "2099-03-04" });
  assert.equal(sent.body.depositChanged, false, "the field holds the stored deposit: the Save changes none");
  assert.deepEqual(partyOf(id).deposit, { amountThb: 9000, date: "2099-03-04" });
  assert.ok(says("BEO data saved successfully"));
});

await check("the till's figures show another deposit than the form's while the BEO is open: the deposit is read again", async () => {
  const id = party({ amountThb: 3000, date: DAY }, { till: true });
  await open(id);
  assert.equal(reads(id).length, 0, "the till and the form agree: nothing is read again");
  familyPays(id, 3000, "2099-03-05");
  partyOf(id).tillDepositThb = 6000;
  // The till's minute read, brought forward.
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ["/api/events", id, "beo", "till-billing"], exact: true }); });
  await settle(10);
  assert.ok(reads(id).length >= 1, "the BEO's deposit was read again");
  assert.equal(depositField(), "6000");
  assert.ok(says("The deposit changed while this BEO was open (now ฿6,000)."));
});

await check("a deposit typed and not saved yet is not read as a move: the field keeps what was typed", async () => {
  const id = party({ amountThb: 3000, date: DAY }, { till: true });
  await open(id);
  await typeInto("input-prepayment", "3500");
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
  await settle(10);
  assert.equal(depositField(), "3500", "the typed figure stays");
  assert.ok(!says("The deposit changed while this BEO was open"));
  await click("button-save-beo");
  assert.equal(saves(id)[0]!.body.depositChanged, true);
  assert.equal(partyDetailsOf(saves(id)[0]!).prepaymentReceived, 3500);
  assert.deepEqual(partyOf(id).deposit, { amountThb: 3500, date: DAY });
});

await act(async () => { root.unmount(); });
console.log(`deposit-save-ui.check: ${checks} checks passed`);
process.exit(checks === 6 ? 0 : 1);
