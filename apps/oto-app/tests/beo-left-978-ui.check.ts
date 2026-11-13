// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the app's own screens under
// jsdom with React, react-query and Radix as the app builds them.
//
// SCRUM-978 — the screens' half of the read-fix proof's leftovers (the
// routes' and the PDF's half is tests/beo-left-978.check.ts):
//
//   1. Studio > Events, "Recent Updates": pressing an event's row opens Edit
//      Event with the event's OWN values (its title, child, date, 12 kids and
//      8 adults), never the form's blank defaults (no title, today's date, 10
//      kids and 5 adults) with Update enabled; and no way into the form sets
//      the event being edited without filling the form (read off the page);
//   2. a built app writes nothing of a person to the browser's console: the
//      auth provider, rendered with the build's flags, writes no "[auth-diag]"
//      line and never the person's e-mail address or name; under Vite's
//      development server it writes its lines, still without them;
//   3. a text box given `disabled` (the BEO editor's read-only bar lines and
//      acts) never opens for typing; an enabled one opens as before;
//   4. the "Get Parent Link" dialog and the AI Fill review dialog carry a
//      visually hidden description inside their dialog, as the BEO sheets do.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-left-978-ui.check.ts
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
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLFormElement", "HTMLTextAreaElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history", "localStorage", "sessionStorage"]) {
  try { g[key] = win[key]; } catch { /* a read-only global */ }
}
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[key] = win[key].bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = win.ResizeObserver = ResizeObserverStub;
class IntersectionObserverStub { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
g.IntersectionObserver = win.IntersectionObserver = IntersectionObserverStub;
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

/** Every console line the app writes, as text: the check reads them as strings, never as objects. */
const realLog = console.log;
const written: string[] = [];
const say = (...args: unknown[]) => realLog(...args);
console.log = (...args: unknown[]) => {
  written.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
};

/** The app's modules, compiled as Vite builds them: `dev` true as under Vite's development server, false as a built app. */
function compile(name: string, dev: boolean, contents: string) {
  const built = buildSync({
    absWorkingDir: APP,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    write: false,
    tsconfig: APP + "tests/tsconfig.jsx.json",
    define: { "import.meta.env": dev ? '{"DEV":true,"MODE":"development"}' : '{"DEV":false,"PROD":true,"MODE":"production"}' },
    logLevel: "silent",
    stdin: { resolveDir: APP, loader: "tsx", contents },
  });
  const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
  const mod = new Module(APP + `tests/${name}.native.cjs`) as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
  mod.filename = APP + `tests/${name}.native.cjs`;
  mod.paths = nativeRequire.resolve.paths("react");
  mod._compile(built.outputFiles[0]!.text, mod.filename);
  return mod.exports;
}
const shared = `
  export * as React from 'react';
  export { act } from 'react';
  export { createRoot } from 'react-dom/client';
  export { QueryClientProvider } from '@tanstack/react-query';
  export { queryClient } from './client/src/lib/queryClient';
  export { AuthContext, AuthProvider, useAuth } from './client/src/hooks/use-auth';
`;
const app = compile("beo-left-978-ui", false, `${shared}
  export { BranchProvider } from './client/src/hooks/use-branch-context';
  export { TooltipProvider } from './client/src/components/ui/tooltip';
  export { Toaster } from './client/src/components/ui/toaster';
  export { EditableText } from './client/src/components/ui/editable-text';
  export { default as StudioEventsPage } from './client/src/pages/studio/events';
`);
const devApp = compile("beo-left-978-ui-dev", true, shared);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, BranchProvider, TooltipProvider, Toaster, EditableText, StudioEventsPage } = app;

// ─── The server, as the screens see it ───────────────────────────────────────

const PARK = "33333333-3333-4333-8333-333333333978";
const EVENT_ID = "11111111-1111-4111-8111-111111111978";
const EMAIL = "zz-test-978-manager@example.com";
const FULL_NAME = "ZZ TEST Nine Seven Eight";
const USER = { id: "44444444-4444-4444-8444-444444444978", email: EMAIL, fullName: FULL_NAME, role: "manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [PARK], mustChangePassword: false, phoneVerified: true };
const EVENT = {
  id: EVENT_ID,
  tenantId: "t",
  branchId: PARK,
  eventType: "birthday",
  title: "ZZ Test Lina's 6th Birthday",
  eventDate: "2099-12-05",
  startTime: "14:00",
  endTime: "16:30",
  childName: "ZZ Test Lina",
  bookingName: "ZZ TEST 978 family only",
  parentName: "ZZ TEST 978 parent",
  whatsappPhoneRaw: "+66898700417",
  numChildren: 12,
  numAdults: 8,
  programName: "",
  allergiesNotes: "peanuts",
  cakeNotes: "",
  specialRequests: "",
  totalValue: null,
  prepaymentAmount: 3000,
  prepaymentDate: "2099-11-01",
  prepaymentMethod: null,
  status: "upcoming",
  isArchived: false,
  createdAt: "2099-11-01T00:00:00.000Z",
  updatedAt: "2099-11-13T00:16:43.000Z",
};
type Asked = { method: string; path: string; body: unknown };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the screens ask only their own server");
  const method = init?.method ?? "GET";
  asked.push({ method, path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
  if (url.pathname === "/api/user") return json(USER);
  if (url.pathname === "/api/branches") return json([{ id: PARK, name: "ZZ TEST 978 park", timezone: "Asia/Bangkok", operatorId: null, isActive: true }]);
  if (url.pathname === "/api/admin/events") return json([EVENT]);
  if (url.pathname === "/api/events/activities/recent") {
    return json([{ id: EVENT_ID, title: EVENT.title, eventType: "birthday", eventDate: EVENT.eventDate, status: "upcoming", branchId: PARK, description: "ZZ TEST 978 BEO created", userName: "ZZ TEST", employeeNickname: null, updatedAt: EVENT.updatedAt }]);
  }
  return json([]);
};

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const waitFor = async (what: string, find: () => boolean, rounds = 120) => {
  for (let i = 0; i < rounds; i++) {
    if (find()) return;
    await settle(1);
  }
  assert.fail(`not seen: ${what}`);
};
const valueOf = (id: string) => (byTestId(id) as HTMLInputElement | null)?.value ?? null;
const textOf = (id: string) => byTestId(id)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
const auth = { user: USER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };
const Passthrough = ({ children }: { children: unknown }) => React.createElement("div", null, children);

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  say(`  ok  ${title}`);
};

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);

await check("Recent Updates opens Edit Event with the event's own values, and Update writes them", async () => {
  queryClient.clear();
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(BranchProvider, null,
            React.createElement(TooltipProvider, null,
              React.createElement(StudioEventsPage, { Layout: Passthrough }),
              React.createElement(Toaster))))),
    );
  });
  await waitFor("the Recent Updates row", () => !!byTestId(`events-activity-${EVENT_ID}`));
  await act(async () => { byTestId(`events-activity-${EVENT_ID}`)!.click(); });
  await waitFor("the Edit Event form", () => !!byTestId("input-event-title"));
  assert.equal(doc.querySelector('[role="dialog"] h2')?.textContent?.trim(), "Edit Event");
  assert.deepEqual(
    {
      title: valueOf("input-event-title"),
      child: valueOf("input-child-name"),
      parent: valueOf("input-parent-name"),
      kids: valueOf("input-num-children"),
      adults: valueOf("input-num-adults"),
      date: textOf("input-event-date"),
    },
    { title: EVENT.title, child: EVENT.childName, parent: EVENT.parentName, kids: "12", adults: "8", date: "December 5th, 2099" },
    "the event's own values, never the blank defaults (no title, today, 10 kids, 5 adults)",
  );
  const update = byTestId("button-submit-event") as HTMLButtonElement;
  assert.equal(update.textContent?.trim(), "Update");
  assert.equal(update.disabled, false, "a form filled from its event can be saved");
  asked.length = 0;
  await act(async () => { update.click(); });
  await settle();
  const patch = asked.find((a) => a.method === "PATCH" && a.path === `/api/admin/events/${EVENT_ID}`);
  assert.ok(patch, "Update sends the event's change");
  const sent = patch.body as Record<string, unknown>;
  assert.deepEqual([sent.title, sent.childName, sent.eventDate, sent.numChildren, sent.numAdults], [EVENT.title, EVENT.childName, EVENT.eventDate, 12, 8], "the event's own values travel, not the defaults");
  await act(async () => { root.render(React.createElement("div")); });
});

await check("no way into Edit Event sets the event being edited without filling the form", () => {
  const page = readFileSync(new URL("../client/src/pages/studio/events.tsx", import.meta.url), "utf8");
  const calls = [...page.matchAll(/setEditingEvent\(([^)]*)\)/g)].map((m) => ({ arg: m[1]!.trim(), at: m.index ?? 0 }));
  const opener = page.indexOf("const openEditDialog = async (event: Event) => {");
  const openerEnd = page.indexOf("setLoadingTasks(true);", opener);
  assert.ok(opener > 0 && openerEnd > opener, "openEditDialog is where the form is filled");
  const filling = calls.filter((c) => c.arg !== "null");
  assert.deepEqual(filling.map((c) => c.arg), ["event"], "only openEditDialog names an event to edit");
  assert.ok(filling[0]!.at > opener && filling[0]!.at < openerEnd, "and it fills the form first");
  assert.match(page, /disabled=\{createMutation\.isPending \|\| updateMutation\.isPending \|\| editFormUnfilled\}/, "Update waits for a form filled from its event");
});

await check("a built app writes nothing of the person to the console; development writes its lines without them", async () => {
  for (const [label, bundle, dev] of [["built", app, false], ["development", devApp, true]] as const) {
    written.length = 0;
    bundle.queryClient.clear();
    const box = doc.createElement("div");
    doc.body.appendChild(box);
    const r = bundle.createRoot(box);
    const Probe = () => {
      const { user } = bundle.useAuth();
      return bundle.React.createElement("span", { "data-testid": `probe-${label}` }, user ? `signed in ${user.id}` : "nobody");
    };
    await bundle.act(async () => {
      r.render(bundle.React.createElement(bundle.QueryClientProvider, { client: bundle.queryClient }, bundle.React.createElement(bundle.AuthProvider, null, bundle.React.createElement(Probe))));
    });
    await waitFor(`${label}: the person read`, () => textOf(`probe-${label}`) === `signed in ${USER.id}`);
    const diag = written.filter((line) => line.includes("[auth-diag]"));
    if (dev) assert.ok(diag.length > 0, "development: the diagnostics are written");
    else assert.deepEqual(diag, [], "built: no [auth-diag] line");
    assert.equal(written.some((line) => line.includes(EMAIL)), false, `${label}: no e-mail address`);
    assert.equal(written.some((line) => line.includes(FULL_NAME)), false, `${label}: no name`);
    await bundle.act(async () => { r.unmount(); });
  }
});

await check("a disabled text box never opens for typing; an enabled one does", async () => {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  const changes: string[] = [];
  const render = (disabled: boolean) =>
    act(async () => {
      r.render(React.createElement(EditableText, { value: "Mineral water", onChange: (v: string) => changes.push(v), disabled, "data-testid": "zz-text" }));
    });
  await render(true);
  const shown = box.querySelector('[data-testid="zz-text"]') as HTMLElement;
  assert.equal(shown.getAttribute("aria-disabled"), "true");
  assert.equal(shown.getAttribute("tabindex"), "-1");
  await act(async () => { shown.click(); });
  shown.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(2);
  assert.equal(box.querySelector("input") === null, true, "disabled: no box to type in");
  assert.equal(box.textContent?.trim(), "Mineral water", "its value shown");
  await render(false);
  await act(async () => { (box.querySelector('[data-testid="zz-text"]') as HTMLElement).click(); });
  await settle(2);
  assert.equal((box.querySelector("input") as HTMLInputElement | null)?.value ?? null, "Mineral water", "enabled: it opens as before");
  assert.deepEqual(changes, []);
  await act(async () => { r.unmount(); });
});

await check("the Parent Link and AI Fill review dialogs carry a hidden description inside their dialog", () => {
  const within = (file: string, opens: string, ends: string) => {
    const page = readFileSync(new URL(file, import.meta.url), "utf8");
    const at = page.indexOf(opens);
    assert.ok(at > 0, `${opens} in ${file}`);
    const header = page.slice(at, page.indexOf(ends, at));
    assert.match(header, /<DialogDescription className="sr-only">[^<]+<\/DialogDescription>/, `${file}: a hidden description`);
  };
  within("../client/src/components/beo/beo-event-editor.tsx", "Parent Menu Selection Link", "</DialogHeader>");
  within("../client/src/components/beo/beo-ai-review.tsx", "AI Fill — Review, edit and approve", "</DialogHeader>");
});

await act(async () => { root.unmount(); });
console.log = realLog;
console.log(`beo-left-978-ui.check: ${checks} checks passed`);
process.exit(checks === 5 ? 0 : 1);
