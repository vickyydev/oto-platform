// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the BEO's Billing section (the
// till's panel over the billing module, kept whole) under jsdom with React and
// react-query as the app builds them, and types into Deposit Paid.
//
// SCRUM-822 — the billing module's Deposit Paid is the party's one deposit
// (SCRUM-813), the figure the till reads. The module calls onBillingChange on
// every keystroke; the Billing section holds them and sends ONE write:
//
//   1. typing 3000 sends exactly one PUT, with 3000, after a pause or on blur
//      (never one per keystroke), and the field shows each figure as it is
//      typed, on a party with no billing row too (it used to jump back to 0);
//   2. clearing the field and retyping sends one PUT with the new figure and
//      never the emptied field's 0, so the deposit keeps its day;
//   3. an emptied field left on blur sends nothing and shows the saved figure;
//      Enter sends at once; the day picked goes at once.
//
// SCRUM-839 — the Financial Summary never reads a deposit of its own. On a
// party with NO billing record it reads the event's own deposit (the party's
// one deposit then: what the chat's payment, the Events page or the till
// wrote), with its day; with a record, the record's; none stays 0:
//
//   4. no record + the event's deposit 3000 on 11 Nov: Deposit Paid 3000 and
//      its day, Outstanding less the deposit, and nothing is written by
//      reading; the same figure retyped sends nothing, another goes as one PUT;
//   5. a record present: the record's figure, whatever the event's read said;
//   6. no record and no deposit: 0 and no day;
//   7. a day picked over the event's deposit carries the amount (the record
//      made is a paid one, never a day without a deposit);
//   8. the family pays while the section is open: the editor is told once to
//      read the deposit again; a section opened on a paid request tells it
//      only when the summary does not hold that request's deposit.
//
// The rules themselves are tests/till-billing-ui.check.ts's; the real route's
// half (one queue, the day kept in all three places) is tests/till-billing.check.ts.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/billing-deposit-ui.check.ts
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
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLFormElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history"]) {
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

// The section, compiled as Vite builds it, with the react-query it runs on.
const built = buildSync({
  absWorkingDir: APP,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  write: false,
  tsconfig: APP + "tests/tsconfig.jsx.json",
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
  stdin: {
    resolveDir: APP,
    loader: "tsx",
    contents: `
      export * as React from 'react';
      export { act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
      export { getQueryFn } from './client/src/lib/queryClient';
      export { BeoBillingSection } from './client/src/components/beo/beo-till-billing';
      export { beoBillingMutationScope, DEPOSIT_IDLE_MS, eventDepositOf, summaryBillingOf, patchOverEventDeposit } from './client/src/lib/beo-deposit-buffer';
      export { depositRequestKey } from './client/src/components/beo/beo-till-billing';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/billing-deposit-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/billing-deposit-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClient, QueryClientProvider, useMutation, getQueryFn, BeoBillingSection, beoBillingMutationScope, DEPOSIT_IDLE_MS, eventDepositOf, summaryBillingOf, patchOverEventDeposit, depositRequestKey } = compiled.exports;

// ─── The server, as the section sees it ──────────────────────────────────────

const EVENT = "11111111-1111-4111-8111-111111111822";
type Row = { eventId: string; depositPaid: boolean; depositPaidAmount: number | null; depositPaidAt: string | null };
type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
let row: Row | null = null;
/** SCRUM-839: the event's own Prepayment, as the BEO's read carries it; the chat's request; the invoice rows. */
let eventRead: { prepaymentAmount: number | null; prepaymentDate: string | null } = { prepaymentAmount: null, prepaymentDate: null };
let depositRequest: Record<string, unknown> | null = null;
let lineItems: Record<string, unknown>[] = [];
let moved = 0;
const requestOf = (state: "requested" | "paid") => ({
  id: "req-839", eventId: EVENT, conversationId: "c-1", amountSatang: 300000, currency: "THB", state, paymentLink: "https://pay.example/1",
  linkExpiresAt: null, invoiceNo: "INV-839", requestedAt: "2026-11-11T10:00:00.000Z", remindedAt: null, handedOverAt: null,
  paidAt: state === "paid" ? "2026-11-11T10:42:00.000Z" : null, closedAt: null, closeReason: null,
  depositBeforeSatang: 0, depositAfterSatang: state === "paid" ? 300000 : null,
  writeBack: state === "paid" ? { editId: "e-1", syncState: "synced", syncError: null } : null,
});
/** The billing route as SCRUM-813 has it: a write that names no day keeps the day; a deposit of 0 has none. */
function putBilling(patch: Record<string, unknown>): Row {
  const next: Row = { eventId: EVENT, depositPaid: false, depositPaidAmount: null, depositPaidAt: null, ...(row ?? {}) };
  if ("depositPaidAmount" in patch) {
    const amount = Number(patch.depositPaidAmount) || 0;
    next.depositPaidAmount = amount > 0 ? amount : null;
    next.depositPaid = amount > 0;
    if (amount <= 0) next.depositPaidAt = null;
  }
  if ("depositPaidAt" in patch) next.depositPaidAt = next.depositPaid ? ((patch.depositPaidAt as string | null) ?? null) : null;
  row = next;
  return next;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the section asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  if (method === "PUT" && url.pathname === `/api/events/${EVENT}/beo/billing`) return json(putBilling(body));
  if (url.pathname === `/api/events/${EVENT}/beo/till-billing`) return json({ status: "not_reachable", message: "The till did not answer." });
  if (url.pathname === `/api/events/${EVENT}/beo/deposit-request` && depositRequest) {
    return json({ status: "ok", readAt: new Date().toISOString(), answer: { eventId: EVENT, hasConversation: true, current: depositRequest, history: [depositRequest] } });
  }
  if (url.pathname === `/api/events/${EVENT}/line-items`) return json(lineItems);
  if (url.pathname === "/api/settings/line-item-templates") return json([]);
  return json({ message: "not here" }, 404);
};
const puts = () => asked.filter((a) => a.method === "PUT").map((a) => a.body);

// ─── Rendering: the section as the editor mounts it ──────────────────────────

const client = new QueryClient({ defaultOptions: { queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false, staleTime: Infinity } } });
/** The editor's half: the billing row it holds, and its one write in the party's queue. */
function Editor() {
  const [billing, setBilling] = React.useState(row);
  const mutation = useMutation({
    scope: beoBillingMutationScope(EVENT),
    mutationFn: async (patch: Record<string, unknown>) => (await fetch(`/api/events/${EVENT}/beo/billing`, { method: "PUT", body: JSON.stringify(patch) })).json(),
    onSuccess: (saved: Row) => setBilling(saved),
  });
  return React.createElement(BeoBillingSection, {
    eventId: EVENT,
    billing,
    onBillingChange: (patch: Record<string, unknown>) => mutation.mutateAsync(patch),
    isManager: true,
    // As the editor passes it: the event's own deposit from the BEO's read.
    eventDeposit: eventDepositOf(eventRead),
    onDepositMoved: () => { moved += 1; },
  });
}

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const settle = async (ms = 10, rounds = 4) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const mount = async () => {
  await act(async () => { root.render(null); });
  asked.length = 0;
  moved = 0;
  client.clear();
  await act(async () => { root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Editor))); });
  await settle();
};
const field = () => {
  const el = doc.querySelector('[data-testid="input-deposit-amount"]') as HTMLInputElement | null;
  assert.ok(el, "the billing module shows Deposit Paid");
  return el;
};
/** Keystrokes as the browser sends them: the field's value, then an input event. */
const keys = async (...values: string[]) => {
  for (const value of values) {
    const input = field();
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
};
const blur = async () => { await act(async () => { field().blur(); }); await settle(); };
const enter = async () => {
  await act(async () => { field().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await settle();
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

await check("typing 3000 on a party with no billing row: the field holds each figure, and ONE PUT with 3000 goes after the pause", async () => {
  row = null;
  await mount();
  await keys("3", "30", "300");
  assert.equal(field().value, "300", "the field shows what is typed, not 0");
  await keys("3000");
  assert.equal(field().value, "3000");
  assert.deepEqual(puts(), [], "nothing while typing");
  await settle(DEPOSIT_IDLE_MS + 100, 2);
  assert.deepEqual(puts(), [{ depositPaidAmount: 3000, depositPaid: true }]);
  assert.equal(field().value, "3000");
  await blur();
  assert.equal(puts().length, 1, "the blur after it sends nothing more");
});

await check("clearing the field and retyping: one PUT with the new figure on blur, never a 0, and the deposit keeps its day", async () => {
  row = { eventId: EVENT, depositPaid: true, depositPaidAmount: 3000, depositPaidAt: "2026-11-01T00:00:00.000Z" };
  await mount();
  assert.equal(field().value, "3000");
  await keys("300", "30", "3", "", "5", "50", "500", "5000");
  await blur();
  assert.deepEqual(puts(), [{ depositPaidAmount: 5000, depositPaid: true }]);
  assert.deepEqual(row, { eventId: EVENT, depositPaid: true, depositPaidAmount: 5000, depositPaidAt: "2026-11-01T00:00:00.000Z" });
  assert.equal(field().value, "5000");
});

await check("an emptied field left on blur sends nothing and shows the saved figure; Enter sends at once", async () => {
  row = { eventId: EVENT, depositPaid: true, depositPaidAmount: 3000, depositPaidAt: "2026-11-01T00:00:00.000Z" };
  await mount();
  await keys("300", "30", "3", "");
  await settle(DEPOSIT_IDLE_MS + 100, 2);
  assert.deepEqual(puts(), [], "a pause on an emptied field sends nothing");
  await blur();
  assert.deepEqual(puts(), [], "nor does leaving it");
  assert.equal(field().value, "3000", "the saved deposit is shown again");
  assert.equal(row!.depositPaidAt, "2026-11-01T00:00:00.000Z");
  await keys("2500");
  await enter();
  assert.deepEqual(puts(), [{ depositPaidAmount: 2500, depositPaid: true }]);
  assert.equal(row!.depositPaidAt, "2026-11-01T00:00:00.000Z", "the day kept");
});

// ─── SCRUM-839: the summary's deposit on a party with no billing record ──────

const dayShown = () => (doc.querySelector('[data-testid="datepicker-deposit-paid-at"]') as HTMLElement).textContent ?? "";
const summaryText = () => (doc.querySelector('[data-testid="section-billing"]') as HTMLElement).textContent ?? "";

await check("no billing record + the event's deposit 3000: the summary reads 3,000 and its day, and writes nothing", async () => {
  row = null;
  eventRead = { prepaymentAmount: 3000, prepaymentDate: "2026-11-11" };
  lineItems = [{ id: "li-1", name: "Package", category: "PACKAGE", qty: 1, unitPriceIncVat: 10000, isIncluded: false, isManual: true }];
  await mount();
  assert.equal(field().value, "3000", "Deposit Paid is the event's deposit, not 0");
  assert.match(dayShown(), /November 11th, 2026/, "with the day it was paid");
  assert.match(summaryText(), /PART PAID/, "the summary counts it");
  assert.match(summaryText(), /฿7,000/, "Outstanding is the total less the deposit");
  assert.deepEqual(puts(), [], "reading makes no billing record");
  await keys("300", "3000");
  await blur();
  assert.deepEqual(puts(), [], "the same figure retyped is not a write");
  await keys("4000");
  await blur();
  assert.deepEqual(puts(), [{ depositPaidAmount: 4000, depositPaid: true }], "another figure goes as one write");
  assert.equal(field().value, "4000");
  lineItems = [];
});

await check("a billing record present: the summary reads the record's figure and day", async () => {
  row = { eventId: EVENT, depositPaid: true, depositPaidAmount: 5000, depositPaidAt: "2026-11-01T00:00:00.000Z" };
  eventRead = { prepaymentAmount: 3000, prepaymentDate: "2026-11-11" };
  await mount();
  assert.equal(field().value, "5000");
  assert.match(dayShown(), /November 1st, 2026/);
  row = { eventId: EVENT, depositPaid: false, depositPaidAmount: null, depositPaidAt: null };
  await mount();
  assert.equal(field().value, "0", "a record with no deposit reads 0: the record is the source once there is one");
  assert.deepEqual(puts(), []);
});

await check("no billing record and no deposit: 0 and no day", async () => {
  row = null;
  for (const none of [{ prepaymentAmount: null, prepaymentDate: null }, { prepaymentAmount: 0, prepaymentDate: "2026-11-11" }]) {
    eventRead = none;
    await mount();
    assert.equal(field().value, "0");
    assert.match(dayShown(), /Select date/);
    assert.match(summaryText(), /NOT PAID/);
  }
  assert.equal(summaryBillingOf(null, null), null);
  assert.equal(summaryBillingOf(null, eventDepositOf({ prepaymentAmount: 0, prepaymentDate: "2026-11-11" })), null);
  assert.deepEqual(eventDepositOf({ prepaymentAmount: 3000, prepaymentDate: "not a day" }), { amountThb: 3000, date: null });
  assert.deepEqual(summaryBillingOf(null, { amountThb: 3000, date: null }), { depositPaid: true, depositPaidAmount: 3000, depositPaidAt: null });
});

await check("a day picked over the event's deposit carries the amount; with a record, or an amount named, the patch goes as it is", () => {
  const event = { amountThb: 3000, date: "2026-11-11" };
  const day = { depositPaidAt: "2026-11-12T00:00:00.000Z" };
  assert.deepEqual(patchOverEventDeposit(day, null, event), { depositPaidAmount: 3000, depositPaid: true, ...day });
  assert.deepEqual(patchOverEventDeposit(day, { eventId: EVENT }, event), day);
  assert.deepEqual(patchOverEventDeposit(day, null, null), day);
  assert.deepEqual(patchOverEventDeposit({ depositPaidAmount: 0, depositPaid: false }, null, event), { depositPaidAmount: 0, depositPaid: false });
  assert.deepEqual(patchOverEventDeposit({ depositRequired: true }, null, event), { depositRequired: true });
});

await check("the family pays while the section is open: the editor is told once; opened on a paid request, only when the summary lacks its deposit", async () => {
  row = null;
  eventRead = { prepaymentAmount: null, prepaymentDate: null };
  depositRequest = requestOf("requested");
  await mount();
  assert.equal(moved, 0);
  assert.equal(field().value, "0");
  depositRequest = requestOf("paid");
  await act(async () => { await client.invalidateQueries({ queryKey: depositRequestKey(EVENT) }); });
  await settle();
  assert.equal(moved, 1, "the payment landing tells the editor to read the deposit again");
  await act(async () => { await client.invalidateQueries({ queryKey: depositRequestKey(EVENT) }); });
  await settle();
  assert.equal(moved, 1, "once");
  eventRead = { prepaymentAmount: 3000, prepaymentDate: "2026-11-11" };
  await mount();
  assert.equal(moved, 0, "opened on a paid request: its deposit was read with the BEO");
  assert.equal(field().value, "3000");
  eventRead = { prepaymentAmount: null, prepaymentDate: null };
  await mount();
  assert.equal(moved, 1, "opened on a request paid after the BEO was read: the deposit is read again");
  depositRequest = null;
});

await act(async () => { root.unmount(); });
console.log(`billing-deposit-ui.check: ${checks} checks passed`);
process.exit(checks === 8 ? 0 : 1);
