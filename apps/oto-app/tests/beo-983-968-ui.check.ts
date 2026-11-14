// seed: none. Every HTTP answer is local synthetic data; no model or staging call.
// SCRUM-983/968 adversarial screen cases: stored text counts in editor/day-of,
// disabled read-only food/bar controls, unknown picker code, and the persisted
// parent-link timestamp shown immediately and after reload on the park day.
// Run the complete file with TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
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
win.confirm = () => true;
g.confirm = win.confirm;
const doc = dom.window.document;

// The editor, compiled as Vite builds it, with the react-query and auth it runs on.
const built = await build({
  plugins: [{ name: "private-day-of-row-for-test", setup(b) { b.onLoad({ filter: /beo-day-of-view\.tsx$/ }, args => ({ contents: readFileSync(args.path, "utf8") + "\nexport { KitchenMenuItemRow };", loader: "tsx" })); } }],
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
      export { Route } from 'wouter';
      export { default as MenuSelectPage, parkDayOf } from './client/src/pages/public/menu-select';
      export { BeoDayOfView, KitchenMenuItemRow } from './client/src/components/beo/beo-day-of-view';
      export { BeoEventEditor } from './client/src/components/beo/beo-event-editor';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/beo-extra-price-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/beo-extra-price-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, BeoEventEditor, BeoDayOfView, KitchenMenuItemRow, MenuSelectPage, Route, parkDayOf } = compiled.exports;

// ─── The server, as the screen sees it ───────────────────────────────────────

const PARK = "33333333-3333-4333-8333-333333333949";
const item = (code: string, name: string, category: string, station: "kitchen" | "bar", priceSatang: number, priceWeekendSatang = priceSatang) => ({
  code, name, category, parentCategory: station === "kitchen" ? "Food" : "Drinks", station, priceSatang, priceWeekendSatang, beoOnly: false,
});
const TILL = [
  item("CF-24", "Margherita", "Pizza", "kitchen", 29_000, 31_000),
  item("CF-12", "French fries", "Sides", "kitchen", 12_000),
  item("CF-66-1", "Kids juice Apple", "Juice", "bar", 9_050),
];
type Reading = { parks: Array<Record<string, unknown>> };
const tillAnswer: (parkId: string | null) => Reading = (parkId) => ({
  parks: [{ parkId: parkId ?? PARK, parkName: "ZZ TEST Floresta", status: "ok", message: null, items: TILL, readAt: "2026-11-12T07:00:00.000Z" }],
});

type Line = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; groupId?: string; productCode?: string };
const line = (id: string, itemName: string, over: Partial<Line> = {}): Line => ({ id, itemName, quantity: 1, notes: "", included: false, price: 0, ...over });
type Held = { date: string; kids: Line[]; adults?: Line[]; adultsDiffer?: boolean; bar: Line[] };

type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const BEOS = new Map<string, Held>();
let publicSubmitted=false;
const persistedAt="2099-11-12T19:28:45.000Z";
const beoOf = (eventId: string) => {
  const held = BEOS.get(eventId)!;
  return {
    id: eventId, title: "ZZ TEST BEO 949", eventDate: held.date, startTime: "13:00", endTime: "16:00", numChildren: 10, numAdults: 4,
    childName: "Mali", bookingName: "Nok", branchId: PARK, locationText: "Party room 1",
    kitchenPlan: {
      foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null,
      menus: { kids: held.kids, adults: held.adults ?? [], ...(held.adultsDiffer !== undefined ? { adultsDiffer: held.adultsDiffer } : {}), kidsFoodTime: "14:00", adultsFoodTime: "" },
      serviceSchedule: [],
    },
    setupPlan: null, barPlan: { serviceTime: "14:00", items: held.bar }, partyDetails: null, partyHost: null, timeline: [], beoTasks: [],
  };
};
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the screen asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  if(url.pathname==="/api/beo/set-menu-selections/public/zz983/submit"&&method==="POST"){publicSubmitted=true;return json({success:true,submittedAt:persistedAt});}
  if(url.pathname==="/api/beo/set-menu-selections/public/zz983")return json({isSubmitted:publicSubmitted,submittedAt:publicSubmitted?persistedAt:null,selections:publicSubmitted?[{groupId:"g1",chosenOptions:["ZZ TEST pizza"]}]:null,parkTimeZone:"Asia/Bangkok",template:{id:"t1",name:"ZZ TEST menu",items:[{id:"g1",type:"choice_group",label:"Pizza",options:["ZZ TEST pizza"],allowMultiple:false}]},event:{title:"ZZ TEST983",childName:"ZZ TEST child",eventDate:"2099-12-01"}});
  if (url.pathname === "/api/beo/till-menu" && method === "GET") return json(tillAnswer(url.searchParams.get("parkId")));
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json(beoOf(beo[1]!));
  if (beo && method === "PUT") return json({ ok: true });
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: [] });
  if (url.pathname === "/api/user") return json(USER);
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  if (/^\/api\/beo\/set-menu-selections\/[^/]+$/.test(url.pathname)) return json({ error: "Not found" }, 404);
  return json([]);
};
const USER = { id: "44444444-4444-4444-8444-444444444949", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const auth = { user: USER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const el = byTestId(id); assert.ok(el, `the screen shows ${id}`); return el; };
/** The screen does not show `id` (a node is never handed to `assert`: see tests/till-menu-ui.check.ts). */
const absent = (id: string, why = "not on the screen") => assert.ok(byTestId(id) === null, `${why}: ${id} is on the screen`);
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
const text = (id: string) => required(id).textContent?.trim() ?? "";

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
let mounted = "";
const openBeo = async (eventId: string, readOnly = false) => {
  mounted = eventId;
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(BeoEventEditor, { key: eventId, eventId, readOnly, onClose: () => undefined }))),
    );
  });
  await settle(10);
  assert.ok(byTestId("accordion-kitchen-plan"), `the BEO ${eventId} is open`);
  await click("accordion-kitchen-plan");
  await click("accordion-bar-plan");
};
const saved = async () => {
  const before = asked.length;
  await click("button-save-beo");
  const put = asked.slice(before).find((a) => a.method === "PUT" && a.path === `/api/events/${mounted}/beo`);
  assert.ok(put, "Save sent the BEO");
  return put.body as { kitchenPlan: { menus: { kids: Line[]; adults: Line[] } }; barPlan: { items: Line[] } };
};

let checks = 0;
const failures: string[] = [];
const check = async (title: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
  } catch (err) {
    const words = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`  FAIL  ${title}\n${words.slice(0, 4000)}`);
    failures.push(title);
    return;
  }
  checks += 1;
  console.log(`  ok  ${title}`);
};

const WEEKDAY = "2026-12-02";

await check("HIGH 983: stored text two steps to three and back; price text and line identity stay unchanged", async () => {
  const id = "11111111-1111-4111-8111-111111111983";
  BEOS.set(id, { date: WEEKDAY, kids: [line("k1", "ZZ TEST noodles", { quantity: "2" as unknown as number, price: "120" as unknown as number, productCode: "CF-24", notes: "no sauce" })], bar: [line("b1", "ZZ TEST juice", { quantity: null as unknown as number })] });
  await openBeo(id);
  assert.equal(text("text-menu-qty-kids-0"), "2");
  await click("button-qty-plus-kids-0");
  assert.equal(text("text-menu-qty-kids-0"), "3");
  await click("button-qty-minus-kids-0");
  const body = await saved();
  assert.deepEqual(body.kitchenPlan.menus.kids.map(l => [l.id,l.itemName,l.quantity,l.price,l.productCode,l.notes]), [["k1","ZZ TEST noodles",2,"120","CF-24","no sauce"]]);
  assert.equal(body.barPlan.items[0].quantity, 1);
});

await check("HIGH 983: read-only food and bar controls cannot change local state by pointer or keyboard", async () => {
  const id = "22222222-2222-4222-8222-222222222983";
  BEOS.set(id, { date: WEEKDAY, kids: [line("k1", "ZZ TEST noodles", { quantity: 2, notes: "no sauce", price: 120 }),line("k2","ZZ TEST rice")], bar: [line("b1","ZZ TEST juice",{price:50})] });
  await openBeo(id,true);
  for(const key of ["button-qty-plus-kids-0","button-qty-minus-kids-0","badge-menu-incl-kids-0","button-remove-menu-item-kids-0","button-add-menu-notes-kids-1"]){
    const control=required(key) as HTMLButtonElement;assert.equal(control.disabled,true,key);await click(key);
  }
  for(const key of ["input-menu-name-kids-0","input-menu-notes-kids-0","input-menu-price-kids-0","input-menu-price-bar-0"]){
    await click(key);await act(async()=>{required(key).dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));});
    assert.notEqual(required(key).tagName,"INPUT",key+" never opens");
  }
  assert.equal(text("text-menu-qty-kids-0"),"2");assert.ok(text("input-menu-name-kids-0").includes("ZZ TEST noodles"));absent("button-save-beo");
  const empty="33333333-3333-4333-8333-333333333983";BEOS.set(empty,{date:WEEKDAY,kids:[],bar:[]});await openBeo(empty,true);
  const add=byTestId("button-add-first-menu-kids");if(add){await click("button-add-first-menu-kids");absent("input-menu-name-kids-0","read-only empty list stays empty");}
});

await check("HIGH 968: a loaded picker missing a coded product cannot claim not charged or a complete sum", async () => {
  const id="44444444-4444-4444-8444-444444444983";
  BEOS.set(id,{date:WEEKDAY,kids:[line("k1","ZZ TEST unavailable dish",{productCode:"CF-MISSING"}),line("k2","ZZ TEST entered price",{price:100})],bar:[]});
  await openBeo(id);absent("text-menu-price-hint-kids-0","no false free-price claim");absent("text-kitchen-extras-total","unknown code prevents a complete sum");assert.equal(text("text-menu-price-hint-kids-1"),"each");
});
await check("HIGH 983: public success shows the persisted server timestamp immediately and after reload on the park day", async()=>{
  queryClient.clear();win.history.replaceState({},"","/menu-select/zz983");
  const render=async()=>{await act(async()=>{root.render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(Route,{path:"/menu-select/:token"},React.createElement(MenuSelectPage))));});await settle(10);};
  await render();const option=doc.querySelector('button[role="radio"]') as HTMLButtonElement;assert.ok(option);await act(async()=>{option.click();});await settle();await click("button-submit-menu-selections");
  const words="Submitted on "+parkDayOf(persistedAt,"Asia/Bangkok");assert.ok(doc.body.textContent?.includes(words),"immediate success uses the returned persisted stamp");
  await act(async()=>{root.render(null);});await render();assert.ok(doc.body.textContent?.includes(words),"cached in-app visit keeps the receipt date");assert.ok(doc.body.textContent?.includes("Pizza: ZZ TEST pizza"),"cached receipt retains the actual server choices");
  await act(async()=>{root.render(null);});queryClient.clear();await render();assert.ok(doc.body.textContent?.includes(words),"reload uses the same persisted stamp");
});

await check("HIGH 983: day-of text two steps to numeric three and writes that count",async()=>{
  const id="55555555-5555-4555-8555-555555555983";BEOS.set(id,{date:WEEKDAY,kids:[line("k1","ZZ TEST noodles",{quantity:"2" as unknown as number,notes:"no sauce"})],bar:[]});queryClient.clear();
  await act(async()=>{root.render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthContext.Provider,{value:auth},React.createElement(BeoDayOfView,{eventId:id,onClose:()=>undefined}))));});await settle(10);await click("button-toggle-kitchen-plan");
  assert.equal(text("text-menu-qty-kids-0"),"2");const before=asked.length;await click("button-qty-plus-kids-0");assert.equal(text("text-menu-qty-kids-0"),"3");
  const put=asked.slice(before).find(x=>x.method==="PUT"&&x.path===`/api/events/${id}/beo/kitchen-plan`);assert.ok(put);assert.equal((put.body as {menus:{kids:Line[]}}).menus.kids[0].quantity,3);
});
await check("MEDIUM review fix: read-only menu tabs still reveal the adults own dish while edits remain blocked",async()=>{
  const id="66666666-6666-4666-8666-666666666983";BEOS.set(id,{date:WEEKDAY,kids:[line("k1","ZZ TEST kids noodles")],adults:[line("a1","ZZ TEST adults salad",{quantity:4,price:180})],adultsDiffer:true,bar:[]});
  await openBeo(id,true);assert.equal((required("button-menu-tab-adults") as HTMLButtonElement).disabled,false);await click("button-menu-tab-adults");
  assert.ok(text("input-menu-name-adults-0").includes("ZZ TEST adults salad"));assert.equal((required("button-qty-plus-adults-0") as HTMLButtonElement).disabled,true);
  await click("input-menu-name-adults-0");assert.notEqual(required("input-menu-name-adults-0").tagName,"INPUT");
  await click("button-menu-tab-kids");assert.ok(text("input-menu-name-kids-0").includes("ZZ TEST kids noodles"));
});

await check("MEDIUM review fix: mixed stored text and number counts infer the same menu in editor and day-of",async()=>{
  const id="77777777-7777-4777-8777-777777777983";BEOS.set(id,{date:WEEKDAY,kids:[line("k1","ZZ TEST same dish",{quantity:"2" as unknown as number,productCode:"CF-24"})],adults:[line("a1","ZZ TEST same dish",{quantity:2,productCode:"CF-24"})],bar:[]});
  await openBeo(id);await click("button-menu-tab-adults");assert.ok(byTestId("adults-menu-mirror"),"legacy equal published counts keep the same inferred menu");
  queryClient.clear();await act(async()=>{root.render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthContext.Provider,{value:auth},React.createElement(BeoDayOfView,{eventId:id,onClose:()=>undefined}))));});await settle(10);await click("button-toggle-kitchen-plan");
  await click("button-menu-tab-adults");assert.ok(byTestId("adults-menu-mirror"),"day-of agrees with editor and PDF counts");
});
await check("945 integration: explicit editor extras carry their source while a held unbadged row stays historical", async()=>{
  const id="88888888-8888-4888-8888-888888888983";
  BEOS.set(id,{date:WEEKDAY,kids:[line("legacy","ZZ TEST held historical"),line("chosen","ZZ TEST selected set",{source:"set_menu"})],bar:[]});
  await openBeo(id);
  await click("badge-menu-incl-kids-1");
  let body=await saved();assert.equal(body.kitchenPlan.menus.kids[0].source,undefined);assert.equal(body.kitchenPlan.menus.kids[1].source,"additional");
  await click("input-menu-name-kids-0");
  await act(async()=>{required("input-menu-name-kids-0").dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));});await settle();
  body=await saved();assert.equal(body.kitchenPlan.menus.kids[0].source,undefined);assert.equal(body.kitchenPlan.menus.kids[1].source,"additional","Enter creates an explicit EXTRA");
  await click("button-add-menu-extra-kids");body=await saved();assert.equal(body.kitchenPlan.menus.kids.at(-1)?.source,"additional");
  const empty="99999999-9999-4999-8999-999999999983";BEOS.set(empty,{date:WEEKDAY,kids:[],bar:[]});await openBeo(empty);
  await click("button-add-first-menu-kids");body=await saved();assert.equal(body.kitchenPlan.menus.kids[0].source,"additional");
});
await check("945 integration: day-of fresh EXTRA saves its tag; private SET toggle callback preserves other held rows",async()=>{
  const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa983";BEOS.set(id,{date:WEEKDAY,kids:[],bar:[]});queryClient.clear();
  await act(async()=>{root.render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthContext.Provider,{value:auth},React.createElement(BeoDayOfView,{eventId:id,onClose:()=>undefined}))));});await settle(10);await click("button-toggle-kitchen-plan");
  const before=asked.length;await click("button-add-first-menu-kids");const put=asked.slice(before).find(x=>x.method==="PUT"&&x.path===`/api/events/${id}/beo/kitchen-plan`);assert.ok(put);assert.equal((put.body as {menus:{kids:Line[]}}).menus.kids[0].source,"additional");
  // The full day-of page filters SET rows out of its extra editor. Mount the actual
  // private row via a test-only export to exercise its explicit badge-off callback.
  const held=line("held","ZZ TEST historical");const chosen=line("set","ZZ TEST set",{source:"set_menu"});let updated:Line[]|undefined;
  await act(async()=>{root.render(React.createElement(KitchenMenuItemRow,{item:chosen,idx:1,menuItems:[held,chosen],menuTab:"kids",onSave:(rows:Line[])=>{updated=rows;}}));});await settle();await click("badge-menu-incl-kids-1");
  assert.ok(updated);assert.equal(updated[0].source,undefined);assert.equal(updated[1].source,"additional");assert.equal(updated[1].id,"set");
});

await act(async()=>{root.unmount();});
console.log(`beo-983-968-ui.check: ${checks} checks passed, ${failures.length} failed`);
process.exit(checks===9&&failures.length===0?0:1);
