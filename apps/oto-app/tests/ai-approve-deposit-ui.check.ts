// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the real AI Fill review under
// jsdom with React, react-query and Radix as the app builds them.
//
// SCRUM-843 — the AI Fill's "Approve and create" follows the Save's deposit
// rule; the review's half (the routes' is tests/ai-approve-deposit.check.ts).
// The stand-in server keeps the rule as the real one does: an approval whose
// `expectedDeposit` is not the stored deposit keeps the stored one, and one
// that names none does not lower it; either answers `notWritten.deposit`.
//
//   1. the review read with no deposit, the family pays ฿3,000 through the
//      chat, Approve and create: the review sends the deposit it was read with
//      beside the chat's figure, and its result says, in plain words, "Not
//      written: the deposit — it changed while this review was open (now
//      ฿3,000)." — the deposit is not among what it says was saved, and the
//      form wears no mark for it;
//   2. a fresh review approving a deliberate higher figure: sent with the
//      deposit the review was read with, written, and said as saved;
//   3. a review from a server before the rule carries no deposit and sends
//      none; the server's words for a lowering it kept are shown;
//   4. a timeline step with no place AND a deposit that was kept: both said.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/ai-approve-deposit-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import type { BeoAiApproveBody, BeoAiReview } from "../shared/beoAiFill";
import { depositNotApprovedWords, type OneDeposit } from "../shared/partyDeposit";

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

// The review, compiled as Vite builds it, with the react-query and the toaster it runs on.
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
      export { Toaster } from './client/src/components/ui/toaster';
      export { toast } from './client/src/hooks/use-toast';
      export { BeoAiReviewDialog } from './client/src/components/beo/beo-ai-review';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/ai-approve-deposit-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/ai-approve-deposit-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, Toaster, toast, BeoAiReviewDialog } = compiled.exports;

// ─── The review, and the server as it sees it ─────────────────────────────────

const DAY = "2099-03-02";
const NONE: OneDeposit = { amountThb: 0, date: null };
const SHOW = "d4d4d4d4-0000-4000-8000-000000000843";
const team = { source: "team" as const, at: "2099-03-01T08:00:00.000Z", line: 1 };

/** What a pasted message proposed: 9 children, a timed step, and a deposit the chat says was received. */
const review = (deposit: { amount: number; date: string | null }, oneDeposit?: OneDeposit): BeoAiReview => ({
  origin: "pasted",
  proposal: {
    package: null,
    addOns: [],
    setMenu: null,
    menuLines: [],
    entertainment: [],
    otherLines: [],
    event: { numChildren: { value: 9, from: team } },
    cake: null,
    deposit: { amount: deposit.amount, paid: true, date: deposit.date, from: team },
    details: {
      title: null,
      bookingName: null,
      locationText: null,
      requests: [],
      setup: { readyBy: null, responsible: null, tasks: [] },
      pos: { name: null, notes: null, items: [] },
      timeline: [{ time: "16:00", label: "Cake", from: team }],
    },
  },
  catalogue: {
    packages: [],
    setMenus: [],
    entertainment: [{ id: SHOW, name: "ZZ TEST show", category: null, durationMinutes: 30, price: 100_000, unit: null, priceIsFrom: false }],
    food: [],
  },
  finalMessage: null,
  ruling: team,
  transcript: { lines: 1, cut: false },
  replaces: [],
  parentSelection: null,
  ...(oneDeposit ? { oneDeposit } : {}),
});

type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const same = (a: OneDeposit, b: OneDeposit) => a.amountThb === b.amountThb && (a.date ?? null) === (b.date ?? null);
/** The party's one deposit, per event, as the stand-in server stores it; and the events with no start time yet. */
const stored = new Map<string, OneDeposit>();
const noStart = new Set<string>();
let made = 0;
const party = (deposit: OneDeposit) => {
  const id = `00000000-0000-4000-8000-${String(++made).padStart(12, "0")}`;
  stored.set(id, deposit);
  return id;
};

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  const approve = /^\/api\/events\/([^/]+)\/beo\/ai-fill\/approve$/.exec(url.pathname);
  if (approve && method === "POST") {
    const id = approve[1]!;
    const sent = body as unknown as BeoAiApproveBody;
    const was = stored.get(id)!;
    const notWritten: Record<string, unknown> = {};
    if (noStart.has(id) && sent.details?.timeline?.length) {
      notWritten.timeline = { reason: "no_start_time", message: "the party has no start time yet", steps: sent.details.timeline };
    }
    const written: Record<string, unknown> = { event: true };
    if (sent.deposit?.paid) {
      const said = { amountThb: sent.deposit.amount, date: sent.deposit.date };
      const reason = sent.expectedDeposit && !same(sent.expectedDeposit, was) ? "moved" : !sent.expectedDeposit && said.amountThb < was.amountThb ? "unconfirmed" : null;
      if (reason) notWritten.deposit = { reason, message: depositNotApprovedWords(reason, was.amountThb), ...was };
      else {
        stored.set(id, said);
        written.deposit = true;
      }
    }
    return json({ written, ...(Object.keys(notWritten).length > 0 ? { notWritten } : {}) });
  }
  return json([]);
};

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the screen shows ${id}`); return el; };
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
const setValue = async (id: string, value: string) => {
  const el = required(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
};
const page = () => (doc.body.textContent ?? "").replace(/\s+/g, " ");
const says = (words: string) => page().includes(words);

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
/** The marks the form is handed after an approval: the sources of what was written, by field. */
let marks: Record<string, string> | null = null;
const open = async (eventId: string, proposed: BeoAiReview) => {
  queryClient.clear();
  // The words of the party before are taken down: each check reads its own.
  await act(async () => { toast({ title: "ZZ TEST" }).dismiss(); });
  marks = null;
  asked.length = 0;
  const show = (pending: unknown) =>
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(React.Fragment, null,
          React.createElement(BeoAiReviewDialog, {
            key: eventId,
            eventId,
            pending,
            bookedDate: "2099-03-14",
            onClose: () => undefined,
            onFallback: () => undefined,
            onApproved: (m: Record<string, string>) => {
              marks = m;
              show(null);
            },
          }),
          React.createElement(Toaster))),
    );
  await act(async () => { show({ review: proposed, fill: {}, source: null }); });
  await settle(8);
  assert.ok(byTestId("button-ai-review-approve"), "the review is open");
};
const approval = (eventId: string) => {
  const posts = asked.filter((a) => a.method === "POST" && a.path === `/api/events/${eventId}/beo/ai-fill/approve`);
  assert.equal(posts.length, 1, "one approval");
  return posts[0]!.body as unknown as BeoAiApproveBody;
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const NOT_WRITTEN_3000 = "Not written: the deposit — it changed while this review was open (now ฿3,000).";
// SCRUM-927 (the owner's rule of 12 November): the result names only the sections the server
// says it wrote; this stub server writes the event, and the deposit when it is not kept.
const SAVED_WITHOUT = "Saved: the event's details (name, counts, times).";
const SAVED_WITH = "Saved: the event's details (name, counts, times) and the deposit.";

await check("the review read with no deposit, the family pays ฿3,000, Approve and create: the deposit it was read with is sent, and the result says the deposit was not written", async () => {
  const id = party(NONE);
  await open(id, review({ amount: 1000, date: "2099-03-01" }, NONE));
  // The family pays through the chat while the review is open.
  stored.set(id, { amountThb: 3000, date: DAY });
  await click("button-ai-review-approve");
  await settle(10);
  const sent = approval(id);
  assert.deepEqual(sent.expectedDeposit, NONE, "the approval says which deposit the review was read with");
  assert.deepEqual(sent.deposit, { amount: 1000, paid: true, date: "2099-03-01" }, "beside the chat's figure, as the reviewer left it");
  assert.equal(sent.event.numChildren, 9, "and everything else of the review");
  assert.deepEqual(stored.get(id), { amountThb: 3000, date: DAY }, "the paid deposit stands");
  assert.ok(says("BEO created from the pasted message"));
  assert.ok(says(NOT_WRITTEN_3000), `the plain words are shown: ${page().slice(-400)}`);
  assert.ok(says(`${SAVED_WITHOUT} ${NOT_WRITTEN_3000}`), "the deposit is not among what was saved");
  assert.ok(!says(SAVED_WITH));
  assert.ok(marks, "the review closed and handed the form its marks");
  assert.ok(!Object.keys(marks!).some((k) => /deposit|prepayment/i.test(k)), `no mark for a deposit that was not written: ${JSON.stringify(marks)}`);
  assert.equal(byTestId("button-ai-review-approve"), null, "nothing stays open");
});

await check("a fresh review approving a deliberate higher figure: sent with the deposit the review was read with, written, and said as saved", async () => {
  const id = party({ amountThb: 3000, date: DAY });
  await open(id, review({ amount: 3000, date: DAY }, { amountThb: 3000, date: DAY }));
  await setValue("input-ai-review-deposit", "5000");
  await click("button-ai-review-approve");
  await settle(10);
  const sent = approval(id);
  assert.deepEqual(sent.expectedDeposit, { amountThb: 3000, date: DAY });
  assert.deepEqual(sent.deposit, { amount: 5000, paid: true, date: DAY });
  assert.deepEqual(stored.get(id), { amountThb: 5000, date: DAY });
  assert.ok(says(SAVED_WITH), "the usual words: what was written");
  assert.ok(!says("Not written"));
  assert.ok(Object.keys(marks ?? {}).length > 0);
});

await check("a review from a server before the rule sends no deposit of its own reading; the server's words for a lowering it kept are shown", async () => {
  const id = party({ amountThb: 3000, date: DAY });
  await open(id, review({ amount: 1000, date: "2099-03-01" }));
  await click("button-ai-review-approve");
  await settle(10);
  const sent = approval(id);
  assert.ok(!("expectedDeposit" in sent), "nothing to send back");
  assert.deepEqual(stored.get(id), { amountThb: 3000, date: DAY }, "not lowered");
  assert.ok(says("Not written: the deposit — it was not lowered (it stays ฿3,000): this page is out of date. Reload it, then run AI Fill again."), page().slice(-400));
  assert.ok(!says(SAVED_WITH));
});

await check("a timeline step with no place and a deposit that was kept: both are said", async () => {
  const id = party(NONE);
  noStart.add(id);
  await open(id, review({ amount: 1000, date: "2099-03-01" }, NONE));
  stored.set(id, { amountThb: 3000, date: DAY });
  await click("button-ai-review-approve");
  await settle(10);
  approval(id);
  assert.ok(
    says(`${SAVED_WITHOUT} Not written: the timeline's step (16:00 Cake) — the party has no start time yet. Set the start time, then add them to the Timeline. ${NOT_WRITTEN_3000}`),
    page().slice(-600),
  );
});

await act(async () => { root.unmount(); });
console.log(`ai-approve-deposit-ui.check: ${checks} checks passed`);
process.exit(checks === 4 ? 0 : 1);
