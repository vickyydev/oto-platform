// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the real BEO editor under jsdom
// with React, react-query and Radix as the app builds them.
//
// SCRUM-836 — a party has a start time; the BEO form's half (the routes' is
// tests/event-start-time.check.ts):
//
//   1. emptying Start Time (the × beside it) on a BEO that holds one shows a
//      plain line under the field at once — "A party needs a start time", and
//      the time it was — and Save writes NOTHING (it used to drop the emptied
//      time from the save and say "saved", the old time still there);
//   2. the time picker cannot confirm an empty time; a time set again takes
//      the line away and Save sends the form once, the new start in it;
//   3. a BEO from before the rule that holds no start yet (SCRUM-827's
//      `no_start_time` case) shows no line and still saves its other fields,
//      its empty start echoed as it is held, never invented.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/event-start-time-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { PARTY_NEEDS_START_TIME } from "../shared/eventStartTime";

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
const compiled = new Module(APP + "tests/event-start-time-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/event-start-time-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, BeoEventEditor } = compiled.exports;

// ─── The server, as the editor sees it ───────────────────────────────────────

const E_PARTY = "11111111-1111-4111-8111-111111111836";
const E_LEGACY = "22222222-2222-4222-8222-222222222836";
const PARK = "33333333-3333-4333-8333-333333333333";
type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const beos = new Map<string, Record<string, unknown>>();
const freshBeo = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  eventDate: "2099-11-21",
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
  partyDetails: null,
  partyHost: null,
  beoTasks: [],
  ...over,
});
beos.set(E_PARTY, freshBeo(E_PARTY, "ZZ TEST 836 party"));
beos.set(E_LEGACY, freshBeo(E_LEGACY, "ZZ TEST 836 no start yet", { startTime: "", endTime: "" }));

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the editor asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json({ ...beos.get(beo[1]!)!, timeline: [] });
  if (beo && method === "PUT") {
    // The server's write of the event's own fields, as PUT /api/events/:id/beo keeps them.
    Object.assign(beos.get(beo[1]!)!, (body.event ?? {}) as Record<string, unknown>);
    return json({ ok: true });
  }
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
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
const setValue = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
};
const text = (id: string) => byTestId(id)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
const saves = (eventId: string) => asked.filter((a) => a.method === "PUT" && a.path === `/api/events/${eventId}/beo`);

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const open = async (eventId: string) => {
  queryClient.clear();
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(BeoEventEditor, { key: eventId, eventId, autoFill: null, onClose: () => undefined }))),
    );
  });
  await settle(12);
  assert.ok(byTestId("accordion-event-info"), `the BEO ${eventId} is open`);
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

await check("emptying Start Time says so under the field at once, and Save writes nothing", async () => {
  await open(E_PARTY);
  assert.equal(byTestId("text-start-time-needed"), null, "a party with its start shows no line");
  await click("button-start-time-clear");
  assert.equal(text("text-start-time-needed"), `${PARTY_NEEDS_START_TIME}. It was 14:00: nothing is saved until a time is set.`);
  assert.ok(byTestId("button-start-time"), "Set Time is offered in its place");
  asked.length = 0;
  await click("button-save-beo");
  assert.equal(saves(E_PARTY).length, 0, "nothing sent: the form does not pretend to save");
  assert.equal(beos.get(E_PARTY)!.startTime, "14:00", "the party keeps its start");
  assert.ok(byTestId("text-start-time-needed"), "the line stays until a time is set");
});

await check("the picker confirms no empty time; a time set again takes the line away and Save sends it once", async () => {
  await click("button-start-time");
  const input = required("input-start-time") as HTMLInputElement;
  await setValue(input, "");
  assert.equal((required("button-confirm-start-time") as HTMLButtonElement).disabled, true, "an empty time cannot be confirmed");
  await click("button-confirm-start-time");
  assert.ok(byTestId("button-confirm-start-time"), "the picker stays open");
  await setValue(input, "15:30");
  assert.equal((required("button-confirm-start-time") as HTMLButtonElement).disabled, false);
  await click("button-confirm-start-time");
  assert.equal(byTestId("text-start-time-needed"), null, "the line is gone");
  asked.length = 0;
  await click("button-save-beo");
  assert.equal(saves(E_PARTY).length, 1, "one Save");
  assert.equal((saves(E_PARTY)[0]!.body.event as Record<string, unknown>).startTime, "15:30");
  assert.equal(beos.get(E_PARTY)!.startTime, "15:30");
});

await check("a BEO that holds no start yet shows no line and still saves, its empty start echoed and never invented", async () => {
  await open(E_LEGACY);
  assert.equal(byTestId("text-start-time-needed"), null, "nothing was emptied here");
  assert.ok(byTestId("button-start-time"), "Set Time is offered");
  asked.length = 0;
  await click("button-save-beo");
  assert.equal(saves(E_LEGACY).length, 1, "the other fields save");
  const sent = saves(E_LEGACY)[0]!.body.event as Record<string, unknown>;
  assert.ok(sent.startTime === "" || sent.startTime === undefined, "no start is made up");
  assert.equal(beos.get(E_LEGACY)!.startTime, "");
});

await act(async () => { root.unmount(); });
console.log(`event-start-time-ui.check: ${checks} checks passed`);
process.exit(checks === 3 ? 0 : 1);
