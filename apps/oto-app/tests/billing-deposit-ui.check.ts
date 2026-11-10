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
      export { beoBillingMutationScope, DEPOSIT_IDLE_MS } from './client/src/lib/beo-deposit-buffer';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/billing-deposit-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/billing-deposit-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClient, QueryClientProvider, useMutation, getQueryFn, BeoBillingSection, beoBillingMutationScope, DEPOSIT_IDLE_MS } = compiled.exports;

// ─── The server, as the section sees it ──────────────────────────────────────

const EVENT = "11111111-1111-4111-8111-111111111822";
type Row = { eventId: string; depositPaid: boolean; depositPaidAmount: number | null; depositPaidAt: string | null };
type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
let row: Row | null = null;
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
  if (url.pathname === `/api/events/${EVENT}/line-items` || url.pathname === "/api/settings/line-item-templates") return json([]);
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
  });
}

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const settle = async (ms = 10, rounds = 4) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const mount = async () => {
  await act(async () => { root.render(null); });
  asked.length = 0;
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

await act(async () => { root.unmount(); });
console.log(`billing-deposit-ui.check: ${checks} checks passed`);
process.exit(checks === 3 ? 0 : 1);
