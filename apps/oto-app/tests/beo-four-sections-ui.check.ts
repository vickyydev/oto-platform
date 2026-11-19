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
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-four-sections-ui.check.ts
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { FOUR_SECTIONS_EVENT, fourSectionsBeo, fourSectionsSnapshot } from "./fixtures/beo-four-sections";

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

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the editor asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json(fourSectionsBeo(beo[1]!));
  if (beo && method === "PUT") return json({ id: beo[1], oneDeposit: { amountThb: 3000, date: "2099-05-01" } });
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  if (/\/package-snapshot$/.test(url.pathname)) return json(fourSectionsSnapshot());
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  if (/\/beo\/timeline\/built$/.test(url.pathname)) return json({ steps: [], untimed: [] });
  if (/\/beo\/timeline$/.test(url.pathname)) return json(fourSectionsBeo().timeline);
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: [] });
  if (url.pathname === "/api/user") return json(USER);
  if (/\/set-menu-selections\//.test(url.pathname)) return json(null, 404);
  return json([]);
};
const USER = { id: "44444444-4444-4444-8444-444444444444", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const auth = { user: USER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };

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
const saves = () => asked.filter((a) => a.method === "PUT" && a.path === `/api/events/${FOUR_SECTIONS_EVENT}/beo`);
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
const open = async () => {
  queryClient.clear();
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(React.Fragment, null,
            React.createElement(BeoEventEditor, { key: String(Math.random()), eventId: FOUR_SECTIONS_EVENT, autoFill: null, onClose: () => undefined }),
            React.createElement(Toaster)))),
    );
  });
  await settle(12);
  assert.ok(byTestId("accordion-event-info"), "the BEO is open");
  await openEverySection();
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

await act(async () => { root.unmount(); });
console.log(`beo-four-sections-ui.check: ${checks} checks passed`);
process.exit(checks === 2 ? 0 : 1);
