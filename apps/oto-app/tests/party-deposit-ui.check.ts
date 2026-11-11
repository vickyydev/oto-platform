// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the BEO Billing section's
// deposit request panel (SCRUM-825) under jsdom with React and react-query as
// the app builds them, and presses its buttons.
//
// SCRUM-825 — a deposit asked from the family's chat, in the Billing section:
//
//   1. the words for each state the platform answers: nothing asked yet,
//      "Deposit requested · ฿3,000" with Resend and Cancel request while the
//      link can be paid, "Deposit overdue" once a person has the thread,
//      "Deposit paid · ฿3,000" when the money landed, "Link expired" and
//      "Request cancelled" with Request deposit offered again;
//   2. "Request deposit" sends ONE POST with the amount in baht and a press
//      id, after the amount is checked (empty, a fraction, too much: said,
//      nothing sent); Resend and Cancel request send the press to the open
//      request's own path; "Send the menu choice link" posts the press;
//   3. a refusal is said in the server's words; a party with no chat is
//      said, and every press is off; a staff member sees the state, no button;
//   4. the section mounts the panel under "From the till" and above the
//      app's own rows.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/party-deposit-ui.check.ts
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

// The panel, compiled as Vite builds it, with the react-query it runs on.
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
      export { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      export { getQueryFn } from './client/src/lib/queryClient';
      export { BeoBillingSection, DepositRequestPanel } from './client/src/components/beo/beo-till-billing';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/party-deposit-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/party-deposit-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClient, QueryClientProvider, getQueryFn, BeoBillingSection, DepositRequestPanel } = compiled.exports;

// ─── The server, as the panel sees it ────────────────────────────────────────

const EVENT = "11111111-1111-4111-8111-111111111825";
const REQUEST = "22222222-2222-4222-8222-222222222825";
type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
let reading: Record<string, unknown> = { status: "ok", answer: { eventId: EVENT, hasConversation: true, current: null, history: [] }, readAt: "2026-11-11T08:00:00.000Z" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let answerPress: (body: Record<string, unknown>, path: string) => Response = () => json({ request: request("requested"), replayed: false });
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the panel asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  if (method === "GET" && url.pathname === `/api/events/${EVENT}/beo/deposit-request`) return json(reading);
  if (method === "GET" && url.pathname === `/api/events/${EVENT}/beo/till-billing`) return json({ status: "ok", billing: quoteAnswer(EVENT), readAt: "2026-11-11T08:00:00.000Z" });
  if (method === "GET" && url.pathname === `/api/events/${EVENT}/beo/billing`) return json(null);
  if (method === "GET") return json([]);
  return answerPress(body, url.pathname);
};

function request(state: "requested" | "paid" | "expired" | "cancelled", over: Record<string, unknown> = {}) {
  return {
    id: REQUEST,
    eventId: EVENT,
    conversationId: "33333333-3333-4333-8333-333333333825",
    amountSatang: 300_000,
    currency: "THB",
    state,
    paymentLink: state === "requested" ? "https://pay.zz-test.example/hosted/abc" : null,
    linkExpiresAt: "2026-11-14T08:02:00.000Z",
    invoiceNo: "ZZ-WEB-825",
    requestedAt: "2026-11-11T08:02:00.000Z",
    remindedAt: null,
    handedOverAt: null,
    paidAt: state === "paid" ? "2026-11-11T10:00:00.000Z" : null,
    closedAt: state === "expired" || state === "cancelled" ? "2026-11-14T08:03:00.000Z" : null,
    closeReason: state === "expired" ? "gateway_expired" : state === "cancelled" ? "staff" : null,
    depositBeforeSatang: state === "paid" ? 0 : null,
    depositAfterSatang: state === "paid" ? 300_000 : null,
    writeBack: state === "paid" ? { editId: "44444444-4444-4444-8444-444444444825", syncState: "synced", syncError: null } : null,
    requestLineStatus: state === "requested" ? "sent" : null,
    ...over,
  };
}
const ok = (current: Record<string, unknown> | null, hasConversation = true) => ({
  status: "ok",
  answer: { eventId: EVENT, hasConversation, current, history: current ? [current] : [] },
  readAt: "2026-11-11T08:00:00.000Z",
});

// ─── Rendering ───────────────────────────────────────────────────────────────

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const settle = async (ms = 10, rounds = 4) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the panel shows ${id}`); return el; };
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
const fill = async (id: string, value: string) => {
  const input = required(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
};
const mountPanel = async (r: Record<string, unknown> | undefined, isManager = true) => {
  await act(async () => { root.render(null); });
  asked.length = 0;
  await act(async () => {
    root.render(React.createElement(DepositRequestPanel, { eventId: EVENT, reading: r, loading: r === undefined, isManager, onChanged: () => undefined }));
  });
  await settle();
};
const presses = () => asked.filter((a) => a.method === "POST");
const text = (id: string) => byTestId(id)?.textContent?.replace(/\s+/g, " ").trim() ?? null;

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

await check("nothing asked yet: the amount field and Request deposit; the menu link press beside them", async () => {
  await mountPanel(ok(null));
  assert.ok(byTestId("text-deposit-request-none"));
  assert.ok(byTestId("input-deposit-request-amount"));
  assert.ok(byTestId("button-request-deposit"));
  assert.ok(byTestId("button-send-menu-link"));
  assert.equal(byTestId("button-deposit-resend"), null);
  assert.equal(byTestId("button-deposit-cancel"), null);
  assert.equal(byTestId("text-deposit-no-conversation"), null);
});

await check("an open request: 'Deposit requested · ฿3,000', the link's validity, the payment link, Resend and Cancel request, no amount field", async () => {
  await mountPanel(ok(request("requested")));
  assert.match(text("text-deposit-request-headline")!, /^Deposit requested · ฿3,000$/);
  assert.match(text("text-deposit-request-state")!, /The payment link is in the family's chat, valid until 14 Nov/);
  assert.equal((required("link-deposit-payment") as HTMLAnchorElement).getAttribute("href"), "https://pay.zz-test.example/hosted/abc");
  assert.equal(text("badge-deposit-request-open"), "Requested");
  assert.ok(byTestId("button-deposit-resend") && byTestId("button-deposit-cancel"));
  assert.equal(byTestId("input-deposit-request-amount"), null);
  assert.equal(byTestId("button-request-deposit"), null);
});

await check("reminded, then overdue: the words move; paid, expired and cancelled each say so, and Request deposit is offered again", async () => {
  await mountPanel(ok(request("requested", { remindedAt: "2026-11-12T08:02:00.000Z" })));
  assert.match(text("text-deposit-request-state")!, /Reminded once\./);
  await mountPanel(ok(request("requested", { remindedAt: "2026-11-12T08:02:00.000Z", handedOverAt: "2026-11-13T08:02:00.000Z" })));
  assert.equal(text("text-deposit-request-headline"), "Deposit overdue · ฿3,000");
  assert.match(text("text-deposit-request-state")!, /with the birthday manager/);
  assert.equal(text("badge-deposit-request-open"), "Overdue");
  await mountPanel(ok(request("paid")));
  assert.equal(text("text-deposit-request-headline"), "Deposit paid · ฿3,000");
  assert.match(text("text-deposit-request-state")!, /updated here and at the till/);
  assert.equal(text("badge-deposit-request-paid"), "Paid");
  assert.ok(byTestId("button-request-deposit"), "another deposit can be asked after one was paid");
  assert.equal(byTestId("button-deposit-resend"), null);
  await mountPanel(ok(request("paid", { writeBack: { editId: "x", syncState: "pending", syncError: null } })));
  assert.match(text("text-deposit-request-state")!, /on its way to this app/);
  await mountPanel(ok(request("expired")));
  assert.equal(text("text-deposit-request-headline"), "Link expired · ฿3,000");
  assert.match(text("text-deposit-request-state")!, /Press Request deposit to send a fresh one/);
  assert.ok(byTestId("button-request-deposit"));
  await mountPanel(ok(request("cancelled")));
  assert.equal(text("text-deposit-request-headline"), "Request cancelled · ฿3,000");
  assert.ok(byTestId("button-request-deposit"));
  // Where the line stands: on its way, or never sent (Resend still offered); a page the gateway would not open.
  await mountPanel(ok(request("requested", { requestLineStatus: "queued" })));
  assert.match(text("text-deposit-request-state")!, /The payment link is on its way to the family's chat/);
  await mountPanel(ok(request("requested", { requestLineStatus: "failed" })));
  assert.match(text("text-deposit-request-state")!, /The payment link could not be sent to the family's chat/);
  assert.ok(byTestId("button-deposit-resend"));
  await mountPanel(ok(request("cancelled", { closeReason: "gateway_refused" })));
  assert.equal(text("text-deposit-request-headline"), "Request not made · ฿3,000");
  assert.match(text("text-deposit-request-state")!, /The payment page could not be opened/);
  assert.ok(byTestId("button-request-deposit"));
});

await check("Request deposit: the amount is checked first (empty, a fraction, too much: said, nothing sent); then ONE POST with the baht and a press id", async () => {
  await mountPanel(ok(null));
  await click("button-request-deposit");
  assert.equal(text("text-deposit-request-error"), "Type the deposit to ask for, in baht.");
  await fill("input-deposit-request-amount", "300.5");
  await click("button-request-deposit");
  assert.equal(text("text-deposit-request-error"), "The deposit is whole baht.");
  await fill("input-deposit-request-amount", "2000000");
  await click("button-request-deposit");
  assert.match(text("text-deposit-request-error")!, /at most ฿1,000,000/);
  assert.deepEqual(presses(), [], "nothing was sent for an amount that cannot be asked");
  await fill("input-deposit-request-amount", "3000");
  await click("button-request-deposit");
  assert.equal(presses().length, 1);
  const sent = presses()[0]!;
  assert.equal(sent.path, `/api/events/${EVENT}/beo/deposit-request`);
  assert.equal(sent.body.amount, 3000);
  assert.match(String(sent.body.actionId), /^[0-9a-f-]{36}$/);
  assert.equal(text("text-deposit-request-error"), null);
  assert.match(text("text-deposit-request-note")!, /the payment link is in the family's chat/);
});

await check("a refusal is said in the server's words; a 4xx ends the press (the next is a new one), while the till out of reach or a lost connection keeps it for the retry", async () => {
  await mountPanel(ok(null));
  answerPress = () => json({ code: "DEPOSIT_PAGE_NOT_OPENED", message: "The payment page could not be opened, so nothing was sent to the family. Press Request deposit again in a moment." }, 400);
  await fill("input-deposit-request-amount", "3000");
  await click("button-request-deposit");
  assert.match(text("text-deposit-request-error")!, /The payment page could not be opened/);
  const refused = presses()[0]!.body.actionId;
  // This app's server could not reach the till: the press may have landed there.
  answerPress = () => json({ code: "PLATFORM_UNREACHABLE", message: "The till did not answer, so the deposit was not requested. Try again in a moment: the same press never asks twice." }, 502);
  await click("button-request-deposit");
  assert.equal(presses().length, 2);
  const unanswered = presses()[1]!.body.actionId;
  assert.match(String(unanswered), /^[0-9a-f-]{36}$/);
  assert.notEqual(unanswered, refused, "a refused press is over: the platform closed it, so the next press is a new one");
  assert.match(text("text-deposit-request-error")!, /The till did not answer/);
  // The connection drops: no answer at all.
  answerPress = () => {
    throw new TypeError("Failed to fetch");
  };
  await click("button-request-deposit");
  assert.equal(presses().length, 3);
  assert.equal(presses()[2]!.body.actionId, unanswered, "the till out of reach keeps the press");
  assert.ok(text("text-deposit-request-error"));
  answerPress = () => json({ request: request("requested"), replayed: false });
  await click("button-request-deposit");
  assert.equal(presses().length, 4);
  assert.equal(presses()[3]!.body.actionId, unanswered, "after a lost connection the retry is the same press");
  assert.equal(text("text-deposit-request-error"), null);
});

await check("Resend and Cancel request press the open request's own path with a press id; the menu link press its own", async () => {
  await mountPanel(ok(request("requested")));
  answerPress = (_body, path) => json(path.endsWith("/cancel") ? { request: request("cancelled"), replayed: false } : { request: request("requested"), replayed: false });
  await click("button-deposit-resend");
  await click("button-deposit-cancel");
  answerPress = () => json({ conversationId: "c", messageId: "m", language: "en", replayed: false });
  await click("button-send-menu-link");
  assert.deepEqual(presses().map((p) => p.path), [
    `/api/events/${EVENT}/beo/deposit-request/${REQUEST}/resend`,
    `/api/events/${EVENT}/beo/deposit-request/${REQUEST}/cancel`,
    `/api/events/${EVENT}/beo/menu-link`,
  ]);
  for (const p of presses()) {
    assert.match(String(p.body.actionId), /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(p.body), ["actionId"]);
  }
  assert.match(text("text-deposit-request-note")!, /menu choice link is in the family's chat/);
});

await check("a party with no chat: said, and every press is off; a staff member sees the state and no button; no platform, 'Till not reachable'", async () => {
  await mountPanel(ok(null, false));
  assert.match(text("text-deposit-no-conversation")!, /not linked to an inbox chat/);
  assert.equal((required("button-request-deposit") as HTMLButtonElement).disabled, true);
  assert.equal((required("button-send-menu-link") as HTMLButtonElement).disabled, true);
  await mountPanel(ok(request("requested")), false);
  assert.equal(text("text-deposit-request-headline"), "Deposit requested · ฿3,000");
  assert.equal(byTestId("button-deposit-resend"), null);
  assert.equal(byTestId("button-request-deposit"), null);
  assert.equal(byTestId("button-send-menu-link"), null);
  await mountPanel({ status: "not_reachable", message: "The till did not answer." });
  assert.match(text("text-deposit-request-unavailable")!, /Till not reachable/);
  assert.equal(byTestId("button-request-deposit"), null);
  await mountPanel({ status: "not_a_party", message: "ZZ not a party" });
  assert.match(text("text-deposit-request-unavailable")!, /Not settled at the till/);
  await mountPanel(undefined);
  assert.match(byTestId("panel-deposit-request")!.textContent!, /Asking the till/);
});

await check("the Billing section mounts the panel under 'From the till', reading the request's state from its own route", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false, staleTime: Infinity } } });
  reading = ok(request("requested"));
  await act(async () => { root.render(null); });
  asked.length = 0;
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(BeoBillingSection, { eventId: EVENT, billing: null, onBillingChange: () => undefined, isManager: true }),
      ),
    );
  });
  await settle();
  assert.ok(asked.some((a) => a.method === "GET" && a.path === `/api/events/${EVENT}/beo/deposit-request`), "the state is read from the deposit route");
  const section = required("section-billing");
  const order = ["panel-from-the-till", "panel-deposit-request", "text-app-invoice-rows"].map((id) => section.innerHTML.indexOf(`data-testid="${id}"`));
  assert.ok(order[0]! >= 0 && order[0]! < order[1]! && order[1]! < order[2]!, `the panel sits between the till and the app's rows: ${order.join(",")}`);
  assert.equal(text("text-deposit-request-headline"), "Deposit requested · ฿3,000");
});

// SCRUM-841 — the request moved on the platform while the panel showed it open.
for (const what of ["resend", "cancel"] as const) {
  await check(`${what} refused because the party was removed: the panel reads the request again at once and shows it closed, the refusal's words still there`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false, staleTime: Infinity } } });
    reading = ok(request("requested"));
    await act(async () => { root.render(null); });
    asked.length = 0;
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(BeoBillingSection, { eventId: EVENT, billing: null, onBillingChange: () => undefined, isManager: true }),
        ),
      );
    });
    await settle();
    assert.equal(text("badge-deposit-request-open"), "Requested");
    assert.ok(byTestId("button-deposit-resend") && byTestId("button-deposit-cancel") && byTestId("link-deposit-payment"));
    const readsBefore = asked.filter((a) => a.method === "GET" && a.path === `/api/events/${EVENT}/beo/deposit-request`).length;
    // The press closes the request on the platform and is refused by name.
    const refusal = "This party was removed in the Events module, so its deposit request was closed and nothing was sent to the family.";
    answerPress = () => {
      reading = ok(request("cancelled", { closeReason: "party_removed" }));
      return json({ code: "DEPOSIT_PARTY_REMOVED", message: refusal }, 409);
    };
    await click(`button-deposit-${what}`);
    await settle();
    assert.equal(presses().length, 1);
    assert.equal(presses()[0]!.path, `/api/events/${EVENT}/beo/deposit-request/${REQUEST}/${what}`);
    const readsAfter = asked.filter((a) => a.method === "GET" && a.path === `/api/events/${EVENT}/beo/deposit-request`).length;
    assert.ok(readsAfter > readsBefore, "the request is read again after the refusal, without a reload");
    assert.equal(text("text-deposit-request-headline"), "Request closed · ฿3,000");
    assert.match(text("text-deposit-request-state")!, /the payment link was closed/);
    assert.equal(byTestId("badge-deposit-request-open"), null);
    assert.equal(byTestId("button-deposit-resend"), null);
    assert.equal(byTestId("button-deposit-cancel"), null);
    assert.equal(byTestId("link-deposit-payment"), null);
    assert.equal(text("text-deposit-request-error"), refusal, "the refusal's words stay on the panel");
    await act(async () => { root.render(null); });
    client.clear();
  });
}

await check("a press that got no answer (the till out of reach) does not read the request again: nothing is known to have moved", async () => {
  let reads = 0;
  await act(async () => { root.render(null); });
  asked.length = 0;
  await act(async () => {
    root.render(React.createElement(DepositRequestPanel, { eventId: EVENT, reading: ok(request("requested")), isManager: true, onChanged: () => { reads += 1; } }));
  });
  await settle();
  answerPress = () => json({ code: "PLATFORM_UNREACHABLE", message: "The till did not answer." }, 502);
  await click("button-deposit-resend");
  assert.equal(reads, 0);
  answerPress = () => json({ code: "DEPOSIT_PARTY_REMOVED", message: "closed" }, 409);
  await click("button-deposit-resend");
  assert.equal(reads, 1, "a refusal reads it again");
  answerPress = () => json({ request: request("requested"), replayed: false });
});

await act(async () => { root.unmount(); });
console.log(`party-deposit-ui.check: ${checks} checks passed`);
process.exit(checks === 11 ? 0 : 1);
