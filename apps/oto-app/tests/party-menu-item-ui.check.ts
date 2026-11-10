// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the BEO's real "New item"
// dialog under jsdom with React and Radix as the app builds them.
//
// SCRUM-828 — a new menu item added from the BEO's food lines, the form's half
// (the server's is tests/party-menu-item.check.ts):
//
//   1. nothing is asked of the server until the form reads: a name, and a price
//      or the "free / included / alternate item" tick (never both), in words;
//   2. Add asks once, with the press's action id, the food list, the name,
//      the station and the price in baht (null when ticked), and the line the
//      server wrote — with the till's code — is what the BEO gets;
//   3. a refusal (the till did not answer, the key was refused) is said on the
//      form, the dialog stays open and no line is handed over; the retry is the
//      same press (the same action id), so it can never make a second item;
//   4. the BEO editor offers it on both food lists, and keeps a line's code
//      through a reload and a Save.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/party-menu-item-ui.check.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// The dialog, compiled as Vite builds it.
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
      export { PartyMenuItemDialog, partyMenuItemBodyOf, priceOfField } from './client/src/components/beo/beo-party-menu-item';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/party-menu-item-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/party-menu-item-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, PartyMenuItemDialog, partyMenuItemBodyOf, priceOfField } = compiled.exports;

// ─── The server, as this dialog sees it ──────────────────────────────────────

const EVENT = "11111111-1111-4111-8111-111111111111";
type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
let answer: (body: Record<string, unknown>) => Response = (body) =>
  json({
    line: { id: `party_${body.actionId}`, itemName: body.name, quantity: 1, notes: "", included: body.free, price: body.free ? 0 : body.price, productCode: "PARTY-ZZ828A01" },
    productId: "22222222-2222-4222-8222-222222222222",
    productCode: "PARTY-ZZ828A01",
    replayed: false,
  });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the dialog asks only its own server");
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method: init?.method ?? "GET", path: url.pathname, body });
  return answer(body);
};

// ─── Rendering ───────────────────────────────────────────────────────────────

let created: unknown[] = [];
let closed = 0;
const settle = async (rounds = 4) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the dialog shows ${id}`); return el; };
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
const fill = async (id: string, value: string) => {
  const input = required(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
};
const errorText = () => byTestId("text-party-menu-item-error")?.textContent ?? null;

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
let open = false;
let menu: "kids" | "adults" = "kids";
const render = async () => {
  await act(async () => {
    root.render(React.createElement(PartyMenuItemDialog, {
      eventId: EVENT,
      menu,
      open,
      onClose: () => { closed += 1; open = false; },
      onCreated: (line: unknown) => { created.push(line); },
    }));
  });
  await settle();
};
/** As the editor does: whatever closed the dialog renders it closed, then a list's "New item" opens it. */
const openDialog = async (list: "kids" | "adults") => {
  open = false;
  await render();
  menu = list; open = true; created = []; closed = 0;
  await render();
};

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

// ─── The form's own reading ──────────────────────────────────────────────────

await check("the price field reads baht, commas and all; empty or not a number is no price", () => {
  assert.equal(priceOfField("450"), 450);
  assert.equal(priceOfField(" 1,250.50 "), 1250.5);
  assert.equal(priceOfField(""), null);
  assert.equal(priceOfField("abc"), null);
  assert.deepEqual(
    partyMenuItemBodyOf({ actionId: EVENT, menu: "adults", name: "  ZZ TEST cake ", station: "bar", price: "99", free: true }),
    { actionId: EVENT, menu: "adults", name: "ZZ TEST cake", station: "bar", price: null, free: true },
    "a ticked item sends no price whatever the field held",
  );
});

await check("nothing is asked until the form reads: a name, then a price or the tick", async () => {
  await openDialog("kids");
  assert.ok(required("dialog-party-menu-item"));
  await click("button-party-menu-item-create");
  assert.equal(errorText(), "Give the item a name.");
  await fill("input-party-menu-item-name", "ZZ TEST unicorn cake");
  await click("button-party-menu-item-create");
  assert.equal(errorText(), "Give the item a price, or tick free / included / alternate item.");
  await fill("input-party-menu-item-price", "0");
  await click("button-party-menu-item-create");
  assert.equal(errorText(), "Give the item a price, or tick free / included / alternate item.");
  assert.equal(asked.length, 0, "the server was never asked");
  assert.equal(created.length, 0);
});

await check("ticked free at the bar: one ask with the press, the list, the name, the station and no price; the server's line is handed over", async () => {
  await click("checkbox-party-menu-item-free");
  assert.equal((required("input-party-menu-item-price") as HTMLInputElement).disabled, true, "a ticked item takes no price");
  await click("button-party-menu-item-bar");
  await click("button-party-menu-item-create");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.method, "POST");
  assert.equal(asked[0]!.path, `/api/events/${EVENT}/beo/party-menu-items`);
  const sent = asked[0]!.body;
  assert.match(String(sent.actionId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual({ ...sent, actionId: "" }, { actionId: "", menu: "kids", name: "ZZ TEST unicorn cake", station: "bar", price: null, free: true });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    id: `party_${sent.actionId}`, itemName: "ZZ TEST unicorn cake", quantity: 1, notes: "", included: true, price: 0, productCode: "PARTY-ZZ828A01",
  });
  assert.equal(closed, 1, "the dialog closes once the line is in");
});

await check("a refusal is said on the form; the dialog stays open, no line is handed over, and the retry is the same press", async () => {
  await openDialog("adults");
  assert.equal(errorText(), null, "a fresh form");
  assert.equal((required("input-party-menu-item-name") as HTMLInputElement).value, "", "a fresh form");
  await fill("input-party-menu-item-name", "ZZ TEST mango pudding");
  await fill("input-party-menu-item-price", "450.50");
  const refusal = "The till did not answer, so the item was not added. Press Add again: the same press never makes a second item.";
  const succeed = answer;
  answer = () => json({ code: "PLATFORM_UNREACHABLE", message: refusal }, 502);
  const before = asked.length;
  await click("button-party-menu-item-create");
  assert.equal(asked.length, before + 1);
  const press = asked.at(-1)!.body;
  assert.deepEqual({ ...press, actionId: "" }, { actionId: "", menu: "adults", name: "ZZ TEST mango pudding", station: "kitchen", price: 450.5, free: false });
  assert.equal(errorText(), refusal);
  assert.ok(byTestId("dialog-party-menu-item"), "the dialog stays open");
  assert.equal(created.length, 0, "no line without its code");
  assert.equal(closed, 0);

  answer = () => json({ code: "OTOAPP_PROVISION_UNAUTHORIZED", message: "The till does not accept this app's provisioning key, so the item was not added." }, 503);
  await click("button-party-menu-item-create");
  assert.match(errorText() ?? "", /provisioning key/);
  assert.equal(created.length, 0);

  answer = succeed;
  await click("button-party-menu-item-create");
  const retry = asked.at(-1)!.body;
  assert.equal(retry.actionId, press.actionId, "the retry is the same press");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    id: `party_${press.actionId}`, itemName: "ZZ TEST mango pudding", quantity: 1, notes: "", included: false, price: 450.5, productCode: "PARTY-ZZ828A01",
  });
  assert.equal(closed, 1);
});

await check("opened again, it is a new press", async () => {
  const last = asked.at(-1)!.body.actionId;
  await openDialog("kids");
  await fill("input-party-menu-item-name", "ZZ TEST rainbow jelly");
  await click("checkbox-party-menu-item-free");
  await click("button-party-menu-item-create");
  assert.notEqual(asked.at(-1)!.body.actionId, last);
});

await check("the BEO editor offers it on both food lists, never read-only, and keeps a line's code through a reload and a Save", () => {
  const editor = readFileSync(APP + "client/src/components/beo/beo-event-editor.tsx", "utf8");
  assert.match(editor, /data-testid="button-add-party-menu-item-kids"/);
  assert.match(editor, /data-testid="button-add-party-menu-item-adults"/);
  assert.equal((editor.match(/\{!readOnly && \(\s*<div className="flex gap-2 pt-1">\s*<button[^>]*?\s*type="button"[\s\S]*?onClick=\{\(\) => setNewItemMenu\("(kids|adults)"\)\}/g) ?? []).length, 2);
  assert.match(editor, /<PartyMenuItemDialog[\s\S]*?onCreated=\{\(line\) => addPartyMenuLine\(newItemMenu \?\? "kids", line\)\}/);
  // A reload maps the line's code back on; the Save sends the lists as they are.
  assert.match(editor, /typeof m\.productCode === "string" && m\.productCode\.trim\(\) \? \{ productCode: m\.productCode\.trim\(\) \} : \{\}/);
  assert.match(editor, /menus: \{ kids: kidsMenu, adults: adultsMenu, kidsFoodTime, adultsFoodTime \}/);
});

await act(async () => { root.unmount(); });
console.log(`party-menu-item-ui.check: ${checks} checks passed`);
process.exit(checks === 6 ? 0 : 1);
