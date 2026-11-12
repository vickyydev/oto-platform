// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the real BEO editor under jsdom
// with React, react-query and Radix as the app builds them, and drives Create
// BEO's AI Fill through its review.
//
// SCRUM-827 — the BEO opens fully pre-filled from the conversation in one
// pass, every field marked with its source (the form's half; the server's and
// the proposal's are tests/beo-catalogue-fill.check.ts and tests/ai-fill.check.ts):
//
//   1. Create BEO (the editor opened with the inbox fill): the review opens
//      with EVERY section proposed and marked — the title the park's default,
//      the child, the decoration wish and the special request the family's,
//      the counts, times, setup plan, POS box and timed step the team's, the
//      party host the message named, ticked to assign;
//   2. a value the form holds ("Games" under Activities) stays, the chat's is
//      offered beside it and taken with one press (nothing typed is overwritten);
//   3. ONE press — Approve and create — sends everything in one body with its
//      sources; no second preview opens;
//   4. the form reads the BEO back: the sections the chat filled are open and
//      wear "from the chat", each field its own mark; an edit turns the mark
//      into "changed here"; Save sends the form once, the fields in it;
//   5. a message pasted into AI Fill opens the same review and approves the
//      same way; a park with no catalogue keeps the preview of before as its
//      one and only step;
//   6. an empty BEO's sections say plain words, never a placeholder;
//   7. Fetch from chat after the approval: a field re-filled from a newer line
//      wears THAT line's mark (not the mark of before), and the fill's own
//      title — the model's guess — is never offered (SCRUM-827 review);
//   8. text typed before AI Fill, not yet saved, survives the approval: the
//      review keeps it, the one Save writes it as it stands, the read-back
//      shows it (SCRUM-827 review);
//   9. the Start Time, End Time, Cake and Setup Who marks: an edit turns each
//      into "changed here", as the text fields' do (SCRUM-827 review; the Date
//      edits the same way, but this fixture's chat date is the booked one, so
//      it wears no mark to pin);
//  10. SCRUM-903: only the family has written and the park's catalogue is
//      empty: the review says nothing is confirmed by the team yet and that
//      every item is a line to keep or leave out, shows the chat's words under
//      each value with whose line and when (Book Date's reason line), offers
//      no Load into Editor (no ruling message to load), keeps Approve and
//      create shut until each line is decided, writes nothing before it, and
//      the approval names the conversation and carries none of the words.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-prefill-ui.check.ts
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import type { BeoAiApproveBody, BeoAiReview } from "../shared/beoAiFill";

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
const compiled = new Module(APP + "tests/beo-prefill-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/beo-prefill-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, queryClient, AuthContext, BeoEventEditor } = compiled.exports;

// ─── The chat, as the server reads it ─────────────────────────────────────────

const E_INBOX = "11111111-1111-4111-8111-111111111827";
const E_BARE = "22222222-2222-4222-8222-222222222827";
const E_PLAIN = "33333333-3333-4333-8333-333333333827";
const E_EMPTY = "44444444-4444-4444-8444-444444444827";
const E_TYPED = "55555555-5555-4555-8555-555555555827";
const E_NORULING = "66666666-6666-4666-8666-666666666903";
const CONV = "cccccccc-cccc-4ccc-8ccc-cccccccc0827";
const MSG = "dddddddd-dddd-4ddd-8ddd-dddddddd0827";
const PARK = "33333333-3333-4333-8333-333333333333";
const PKG = "aaaaaaaa-0000-4000-8000-00000000000a";
const MENU = "bbbbbbbb-0000-4000-8000-00000000000b";
const MAGICIAN = "d4d4d4d4-0000-4000-8000-000000000004";
const NOK = "eeeeeeee-0000-4000-8000-00000000000e";
const at = (line: number) => `2026-11-02T0${line}:00:00.000Z`;
const family = (line: number) => ({ source: "family" as const, at: at(line), line });
const team = (line: number) => ({ source: "team" as const, at: at(line), line });
const RULING = "Confirmed: Emma's party on 21 November, 14:00 to 17:00, 12 kids, the Floresta package, the magician, setup by Ying by 13:30, cake at 16:00. Deposit 5,000 received. PREFILL-827";

/** What the fill proposes from the three lines: the family asks (1), the team confirms (2), the family adds adults (3). */
const review = (origin: "inbox" | "pasted"): BeoAiReview => ({
  origin,
  proposal: {
    package: { templateId: PKG, said: "the Floresta package", chatPrice: null, from: team(2) },
    addOns: [],
    setMenu: { templateId: MENU, from: team(2), choices: [] },
    menuLines: [],
    entertainment: [{ templateId: MAGICIAN, name: "ZZ TEST Magician", said: "the magician", quantity: 1, chatPrice: null, notInCatalogue: false, from: team(2) }],
    otherLines: [],
    event: {
      childName: { value: "Emma", from: family(1) },
      numChildren: { value: 12, from: team(2) },
      numAdults: { value: 6, from: family(3) },
      startTime: { value: "14:00", from: team(2) },
      endTime: { value: "17:00", from: team(2) },
    },
    cake: { mode: "INTERNAL", notes: "unicorn cake", time: "16:00", from: family(1) },
    deposit: { amount: 5000, paid: true, date: "2026-11-02", from: team(2) },
    details: {
      title: { value: "Emma's 6th Birthday", from: { source: "default", at: null, line: null } },
      bookingName: { value: "Olga", from: team(2) },
      locationText: { value: "Jungle Room", from: team(2) },
      requests: [
        { kind: "decoration", text: "unicorn theme", from: family(1) },
        { kind: "special_request", text: "No nuts please", from: family(1) },
        { kind: "activity", text: "treasure hunt", from: team(2) },
      ],
      setup: { readyBy: { value: "13:30", from: team(2) }, responsible: { value: "Ying", from: team(2) }, tasks: [{ itemLabel: "Balloon arch", notes: null, from: team(2) }] },
      pos: { name: { value: "Floresta", from: team(2) }, notes: null, items: [] },
      timeline: [{ time: "16:00", label: "Cake", from: team(2) }],
    },
  },
  catalogue: {
    packages: [{ id: PKG, name: "ZZ TEST Floresta", kidsIncluded: 10, adultsIncluded: 4, hours: 3, priceWeekday: 1_690_000, priceWeekend: 2_090_000, basePrice: 1_690_000, setMenuTemplateId: MENU, lines: [] }],
    setMenus: [{ id: MENU, name: "ZZ TEST Kids set", items: [] }],
    entertainment: [{ id: MAGICIAN, name: "ZZ TEST Magician", category: null, durationMinutes: 30, price: 350_000, unit: null, priceIsFrom: false }],
    food: [],
  },
  finalMessage: origin === "inbox" ? RULING : null,
  ruling: team(origin === "inbox" ? 2 : 1),
  transcript: { lines: origin === "inbox" ? 3 : 1, cut: false },
  replaces: [],
  parentSelection: null,
});
/** SCRUM-903: only the family has written; no message of the team's; the park's catalogue empty. */
const NO_RULING_LINE_1 = "Hi! Mia's party on Saturday 21 November at 15:00, pizza for the kids, no nuts please. NORULING-903";
const words = (line: number, quote: string) => ({ ...family(line), quote });
const NO_RULING_REVIEW: BeoAiReview = {
  origin: "inbox",
  proposal: {
    package: null,
    addOns: [],
    setMenu: null,
    menuLines: [{ menu: "kids", itemName: "pizza", quantity: 1, productCode: null, matchedName: null, notInMenu: true, chatPrice: null, from: words(1, "pizza") }],
    entertainment: [{ templateId: null, name: "a magic show", said: "a magic show", quantity: 1, chatPrice: null, notInCatalogue: true, from: words(2, "a magic show") }],
    otherLines: [],
    event: { startTime: { value: "15:00", from: words(1, NO_RULING_LINE_1) } },
    cake: null,
    deposit: null,
    details: {
      title: null,
      bookingName: null,
      locationText: null,
      requests: [{ kind: "special_request", text: "no nuts please", from: words(1, "no nuts please") }],
      setup: { readyBy: null, responsible: null, tasks: [] },
      pos: { name: null, notes: null, items: [] },
      timeline: [],
    },
  },
  catalogue: { packages: [], setMenus: [], entertainment: [], food: [] },
  finalMessage: null,
  ruling: null,
  conversationId: CONV,
  timeZone: "Asia/Bangkok",
  transcript: { lines: 2, cut: false },
  replaces: [],
  parentSelection: null,
};
const FILL = {
  summary: "ZZ 827",
  event: { title: "Model's own title", childName: "Emma", numChildren: 12, startTime: "14:00", endTime: "17:00", eventDate: "2099-11-21", eventDateText: "21 November", bookingName: "Olga", locationText: "Jungle Room", activities: "treasure hunt" },
  setupPlan: { readyBy: "13:30", responsible: "Ying", simplifiedTasks: [{ itemLabel: "Balloon arch" }] },
  partyDetails: { packageName: "Floresta", prepaymentReceived: 5000, depositDate: "2026-11-02" },
  timeline: [{ time: "16:00", label: "Cake" }],
  proposals: {
    partyHost: { asked: "Nok", match: { kind: "employee", id: NOK, label: "Nok (ZZ TEST Siriporn)" }, why: null },
    entertainmentHost: null,
    setupResponsible: { asked: "Ying", match: null, why: "no_match" },
  },
};

// ─── The server, as the editor sees it ───────────────────────────────────────

type Asked = { method: string; path: string; body: Record<string, unknown> };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Timeline = Array<{ id: string; label: string; offsetFromStartMinutes: number; assignedToType: string; isSystemGenerated: boolean; sortOrder: number }>;
/** The BEO as the server holds it, per event; the approval writes into it the way server/lib/beoAiApprove.ts does. */
const beos = new Map<string, Record<string, unknown>>();
const timelines = new Map<string, Timeline>();
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
beos.set(E_INBOX, freshBeo(E_INBOX, "Emma's 6th Birthday", { inboxConversationId: CONV, activities: "Games" }));
beos.set(E_BARE, freshBeo(E_BARE, "ZZ TEST bare", { inboxConversationId: CONV }));
beos.set(E_PLAIN, freshBeo(E_PLAIN, "ZZ TEST plain"));
beos.set(E_EMPTY, freshBeo(E_EMPTY, "ZZ TEST empty"));
beos.set(E_TYPED, freshBeo(E_TYPED, "ZZ TEST typed"));
beos.set(E_NORULING, freshBeo(E_NORULING, "ZZ TEST no ruling", { inboxConversationId: CONV }));
for (const id of [E_INBOX, E_BARE, E_PLAIN, E_EMPTY, E_TYPED, E_NORULING]) timelines.set(id, []);
let approvals = 0;

/** The approval, as the server writes it: the event's fields, the setup plan, the POS box, the chat's step, the host, and the auto steps. */
function applyApproval(eventId: string, body: BeoAiApproveBody) {
  const beo = beos.get(eventId)!;
  const d = body.details ?? {};
  for (const key of ["title", "bookingName", "locationText", "activities", "decoration", "specialRequests"] as const) if (d[key] !== undefined) beo[key] = d[key];
  for (const key of ["childName", "numChildren", "numAdults", "startTime", "endTime"] as const) if (body.event[key] !== undefined) beo[key] = body.event[key];
  if (body.event.internalStaffNotes) beo.internalStaffNotes = body.event.internalStaffNotes;
  if (d.setupReadyBy !== undefined || d.setupResponsible !== undefined || d.setupTasks) {
    beo.setupPlan = {
      setupRequired: true,
      setupNotes: null,
      setupTasks: {
        readyBy: d.setupReadyBy ?? "",
        responsible: d.setupResponsible ?? "",
        responsibleId: null,
        responsibleType: null,
        simplifiedTasks: (d.setupTasks ?? []).map((t, i) => ({ id: `task_${i}`, itemLabel: t.itemLabel, notes: t.notes ?? "" })),
      },
    };
  }
  if (body.package || body.setMenu || body.cake) {
    beo.kitchenPlan = {
      foodRequired: true,
      cakeMode: body.cake?.mode ?? "NONE",
      cakeNotes: body.cake?.notes ?? null,
      cakeTime: body.cake?.time ?? null,
      setMenuEnabled: !!body.setMenu,
      setMenuTemplateId: body.setMenu?.templateId ?? null,
      menus: { kids: [], adults: [], adultsDiffer: false, kidsFoodTime: "", adultsFoodTime: "" },
      serviceSchedule: [],
    };
  }
  if (d.posName !== undefined || d.posNotes !== undefined || body.deposit) {
    beo.partyDetails = { packageName: d.posName ?? "", notes: d.posNotes ?? "", items: [], prepaymentReceived: body.deposit?.amount ?? 0, depositDate: body.deposit?.date ?? "" };
  }
  if (d.team?.partyHost) beo.partyHost = { eventId, assignedEmployeeId: d.team.partyHost.id, assignmentMode: "INDIVIDUAL", assignedEmployeeName: "Nok" };
  const timeline = timelines.get(eventId)!;
  const start = 14 * 60;
  for (const step of d.timeline ?? []) {
    const [h, m] = step.time.split(":").map(Number);
    timeline.push({ id: `step_${timeline.length}`, label: step.label, offsetFromStartMinutes: h! * 60 + m! - start, assignedToType: "PARTY_HOST", isSystemGenerated: false, sortOrder: timeline.length + 1 });
  }
  // The BEO generates its own steps from itself (guests arrive, the cake) after the approval.
  timeline.push({ id: "auto_guests", label: "Guests arrive", offsetFromStartMinutes: 0, assignedToType: "PARTY_HOST", isSystemGenerated: true, sortOrder: 0 });
}

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  assert.equal(url.origin, "http://localhost", "the editor asks only its own server");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  asked.push({ method, path: url.pathname, body });
  const beo = /^\/api\/events\/([^/]+)\/beo$/.exec(url.pathname);
  if (beo && method === "GET") return json({ ...beos.get(beo[1]!)!, timeline: timelines.get(beo[1]!) ?? [] });
  if (beo && method === "PUT") return json({ ok: true });
  const timeline = /^\/api\/events\/([^/]+)\/beo\/timeline$/.exec(url.pathname);
  if (timeline && method === "GET") return json(timelines.get(timeline[1]!) ?? []);
  if (timeline && method === "POST") return json({ id: `posted_${asked.length}`, ...body }, 201);
  const fill = /^\/api\/events\/([^/]+)\/beo\/ai-fill\/inbox$/.exec(url.pathname);
  if (fill && method === "POST") {
    const source = { conversationId: CONV, messageId: MSG, body: RULING, authorName: "ZZ TEST Manager", sentAt: at(2), createdAt: at(2), fillsFinalMessage: true };
    const chat = { newestMessageId: "line-3", lines: 3 };
    // SCRUM-903: no message of the team's yet: no source, nothing of the form's own read, the review alone.
    if (fill[1] === E_NORULING) {
      return json({ source: null, chat: { newestMessageId: "line-2", lines: 2 }, fill: { proposals: { partyHost: null, entertainmentHost: null, setupResponsible: null } }, review: NO_RULING_REVIEW });
    }
    // The bare event's park has no catalogue: the free-text fill alone, the preview of before.
    if (fill[1] === E_BARE) return json({ source, chat, fill: { ...FILL, event: { ...FILL.event, internalStaffNotes: RULING } } });
    // Fetch from chat (SCRUM-826): the chat moved — the team's line 4 says 8 adults.
    if (body.purpose === "fetch") {
      const moved = review("inbox");
      moved.proposal.event.numAdults = { value: 8, from: team(4) };
      moved.transcript = { lines: 4, cut: false };
      return json({ source, chat: { newestMessageId: "line-4", lines: 4 }, fill: { ...FILL, event: { ...FILL.event, numAdults: 8 } }, review: moved });
    }
    return json({ source, chat, fill: { ...FILL, event: { ...FILL.event, internalStaffNotes: RULING } }, review: review("inbox") });
  }
  const approve = /^\/api\/events\/([^/]+)\/beo\/ai-fill\/approve$/.exec(url.pathname);
  if (approve && method === "POST") {
    approvals += 1;
    applyApproval(approve[1]!, body as unknown as BeoAiApproveBody);
    return json({ written: { event: true } });
  }
  if (url.pathname === "/api/ai/parse-beo" && method === "POST") {
    const text = String(body.text ?? "");
    // A paste on a park with a catalogue opens the review; one that says "no catalogue" the preview of before.
    if (text.includes("NO-CATALOGUE")) return json({ ...FILL, proposals: FILL.proposals });
    return json({ ...FILL, proposals: FILL.proposals, review: review("pasted") });
  }
  if (/\/beo\/till-billing$/.test(url.pathname)) return json({ status: "not_reachable", message: "The till did not answer." });
  if (url.pathname === "/api/beo/party-hosts") return json({ source: "employee", items: [{ id: NOK, fullName: "ZZ TEST Siriporn", nickname: "Nok" }] });
  if (url.pathname === "/api/user") return json(USER);
  if (/\/beo\/billing$/.test(url.pathname)) return json(null);
  if (/package-snapshot$/.test(url.pathname)) return json(null);
  return json([]);
};
const USER = { id: "44444444-4444-4444-8444-444444444444", role: "manager", fullName: "ZZ TEST manager", tenantId: "t", isActive: true, hasAllBranchesAccess: true, allowedBranchIds: [] };
const auth = { user: USER, isLoading: false, error: null, loginMutation: {}, logoutMutation: {}, registerMutation: {} };

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const byTestId = (id: string, within: ParentNode = doc) => within.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string, within: ParentNode = doc) => { const el = byTestId(id, within); assert.ok(el, `the screen shows ${id}`); return el; };
const click = async (id: string, within: ParentNode = doc) => { await act(async () => { required(id, within).click(); }); await settle(); };
const setValue = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
};
const typeInto = async (id: string, value: string) => {
  // EditableText: a click opens the input under the same test id; a blur commits it.
  await click(id);
  const input = required(id) as HTMLInputElement;
  assert.ok(input.tagName === "INPUT" || input.tagName === "TEXTAREA", `${id} opens for typing`);
  await setValue(input, value);
  await act(async () => { input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  await settle();
};
const text = (id: string, within: ParentNode = doc) => byTestId(id, within)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
const inputValue = (id: string, within: ParentNode = doc) => (required(id, within) as HTMLInputElement).value;
/** The marks on a review row (the row renders them after its input; the "chat says" line below is not the row's). */
const rowMark = (inputId: string) => {
  const row = required(inputId).parentElement!;
  return [...row.querySelectorAll('[data-testid="ai-review-source"]')].map((m) => m.getAttribute("data-source"));
};
/** The mark inside an editor label: the label is the mark's parent. */
const labelMark = (inputId: string) => {
  const input = required(inputId);
  const block = input.parentElement!;
  return byTestId("ai-review-source", block)?.textContent?.trim() ?? null;
};

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const open = async (eventId: string, autoFill: "inbox" | null = null) => {
  queryClient.clear();
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(BeoEventEditor, { key: `${eventId}-${autoFill ?? "plain"}`, eventId, autoFill, onClose: () => undefined }))),
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

await check("Create BEO: the review opens with every section proposed and marked — the park's default, the family's lines, the team's", async () => {
  asked.length = 0;
  await open(E_INBOX, "inbox");
  assert.equal(asked.filter((a) => a.path.endsWith("/beo/ai-fill/inbox")).length, 1, "the fill ran once");
  assert.ok(required("button-ai-review-approve"), "the review in edit mode");
  assert.equal(byTestId("button-ai-fill-confirm"), null, "not the preview of before");
  // Event Info: the title the park's default (the BEO's own name, as the app names a party), the child the family's, the counts the team's and the family's.
  assert.equal(inputValue("input-ai-review-title"), "Emma's 6th Birthday");
  assert.deepEqual(rowMark("input-ai-review-title"), ["default"]);
  assert.equal(inputValue("input-ai-review-childName"), "Emma");
  assert.deepEqual(rowMark("input-ai-review-childName"), ["family"]);
  assert.equal(inputValue("input-ai-review-numChildren"), "12");
  assert.deepEqual(rowMark("input-ai-review-numChildren"), ["team"]);
  assert.equal(inputValue("input-ai-review-numAdults"), "6");
  assert.deepEqual(rowMark("input-ai-review-numAdults"), ["family"]);
  assert.equal(inputValue("input-ai-review-bookingName"), "Olga");
  assert.equal(inputValue("input-ai-review-locationText"), "Jungle Room");
  assert.deepEqual(rowMark("input-ai-review-locationText"), ["team"]);
  assert.equal(inputValue("input-ai-review-specialRequests"), "No nuts please");
  assert.deepEqual(rowMark("input-ai-review-specialRequests"), ["family"]);
  assert.equal(inputValue("input-ai-review-decoration"), "unicorn theme");
  assert.deepEqual(rowMark("input-ai-review-decoration"), ["family"]);
  // The team: the host the message named, to tick; the setup's who matched nobody, said so.
  assert.ok(required("checkbox-ai-review-team-partyHost"));
  assert.match(text("ai-review-team-partyHost")!, /Nok \(ZZ TEST Siriporn\)\s*— the message says "Nok"\. Tick to assign\./);
  assert.match(text("ai-review-team-setupResponsible")!, /"Ying" matches nobody at this park/);
  // The package and the entertainment, the setup plan, the POS box, the kitchen's cake, the chat's step, the deposit.
  assert.equal((required("select-ai-review-package") as HTMLSelectElement).value, PKG);
  assert.equal((required("select-ai-review-entertainment") as HTMLSelectElement).value, MAGICIAN);
  assert.equal(inputValue("input-ai-review-setupReadyBy"), "13:30");
  assert.deepEqual(rowMark("input-ai-review-setupReadyBy"), ["team"]);
  assert.equal(inputValue("input-ai-review-setupResponsible"), "Ying");
  assert.equal([...doc.querySelectorAll('[data-testid="ai-review-setup-task"] input')].map((i) => (i as HTMLInputElement).value)[0], "Balloon arch");
  assert.equal(inputValue("input-ai-review-posName"), "Floresta");
  assert.equal((required("select-ai-review-cake") as HTMLSelectElement).value, "INTERNAL");
  const step = required("ai-review-timeline-step");
  assert.deepEqual([...step.querySelectorAll("input")].map((i) => i.value), ["16:00", "Cake"]);
  assert.equal(byTestId("ai-review-source", step)?.getAttribute("data-source"), "team");
  assert.match(text("text-ai-review-timeline-auto")!, /The park's own steps .* are added from the BEO when you approve\.\s*from a template/);
  assert.equal(inputValue("input-ai-review-deposit"), "5000");
  assert.match(text("text-ai-review-writes")!, /everything above, in one go\. Nothing opens after it/);
});

await check("a value the form holds stays; the chat's is offered beside it and taken with one press", async () => {
  assert.equal(inputValue("input-ai-review-activities"), "Games", "what the form holds, not overwritten");
  assert.deepEqual(rowMark("input-ai-review-activities"), [], "nobody's line");
  assert.match(text("text-ai-review-chat-says-activities")!, /The chat says "treasure hunt"\s*from the team\s*Use the chat's/);
  await click("button-ai-review-use-chat-activities");
  assert.equal(inputValue("input-ai-review-activities"), "treasure hunt");
  assert.deepEqual(rowMark("input-ai-review-activities"), ["team"]);
  assert.equal(byTestId("text-ai-review-chat-says-activities"), null, "taken: nothing more to offer");
  // The host ticked to assign.
  await click("checkbox-ai-review-team-partyHost");
  assert.equal((required("checkbox-ai-review-team-partyHost") as HTMLInputElement).checked, true);
});

let approvedBody: BeoAiApproveBody | null = null;
await check("ONE press writes everything, with its sources; no second preview opens", async () => {
  asked.length = 0;
  await click("button-ai-review-approve");
  await settle(10);
  const posts = asked.filter((a) => a.method === "POST" && a.path.endsWith("/beo/ai-fill/approve"));
  assert.equal(posts.length, 1, "one approval");
  assert.equal(approvals, 1);
  approvedBody = posts[0]!.body as unknown as BeoAiApproveBody;
  const d = approvedBody.details!;
  assert.equal(d.title, undefined, "the BEO's own name already is the park's default: not written back over itself");
  assert.equal(d.bookingName, "Olga");
  assert.equal(d.locationText, "Jungle Room");
  assert.equal(d.specialRequests, "No nuts please");
  assert.equal(d.decoration, "unicorn theme");
  assert.equal(d.activities, "treasure hunt");
  assert.equal(d.setupReadyBy, "13:30");
  assert.equal(d.setupResponsible, "Ying");
  assert.deepEqual(d.setupTasks, [{ itemLabel: "Balloon arch", notes: null }]);
  assert.equal(d.posName, "Floresta");
  assert.deepEqual(d.timeline, [{ time: "16:00", label: "Cake" }]);
  assert.deepEqual(d.team, { partyHost: { kind: "employee", id: NOK, label: "Nok (ZZ TEST Siriporn)" } });
  assert.equal(approvedBody.event.childName, "Emma");
  assert.equal(approvedBody.event.numAdults, 6);
  assert.equal(approvedBody.package?.templateId, PKG);
  const source = (field: string) => approvedBody!.sources.find((s) => s.field === field)?.source;
  assert.equal(source("title"), "default");
  assert.equal(source("childName"), "family");
  assert.equal(source("numAdults"), "family");
  assert.equal(source("specialRequests"), "family");
  assert.equal(source("activities"), "team");
  assert.equal(source("setupReadyBy"), "team");
  assert.equal(source("timeline:0"), "team");
  assert.equal(source("team:partyHost"), "team");
  assert.equal(source("package"), "team");
  assert.equal(asked.filter((a) => a.method === "POST" && a.path.endsWith("/beo/timeline")).length, 0, "the timeline's lines are the approval's, not posted one by one");
  // Nothing opens after it.
  assert.equal(byTestId("button-ai-review-approve"), null, "the review closed");
  assert.equal(byTestId("button-ai-fill-confirm"), null, "no preview of before");
  assert.equal(byTestId("text-ai-fill-after-approval"), null);
  assert.ok(!doc.body.textContent?.includes("Review & Confirm"), "no second dialog");
});

await check("the form reads the BEO back: the chat's sections open and marked, each field its own mark; an edit says changed here", async () => {
  for (const section of ["event-info", "party-host", "birthday-package", "party-details", "setup-plan", "kitchen-plan", "timeline"]) {
    assert.equal(text(`ai-from-chat-${section}`), "from the chat", `${section} wears the chip`);
  }
  // The sections the chat filled are open, their fields filled.
  assert.equal(text("textarea-special-requests"), "No nuts please");
  assert.equal(text("input-event-decoration"), "unicorn theme");
  assert.equal(text("input-event-activities"), "treasure hunt");
  assert.equal(text("input-child-name"), "Emma");
  assert.equal(text("input-num-adults"), "6");
  assert.equal(text("input-location-text"), "Jungle Room");
  assert.equal(text("input-package-name"), "Floresta");
  assert.ok(byTestId("button-ready-by-edit"), "the setup's ready-by is set");
  assert.equal(text("input-setup-responsible"), "Ying");
  assert.equal(text("input-setup-item-0"), "Balloon arch");
  assert.deepEqual([...doc.querySelectorAll('[data-testid^="input-timeline-label-"]')].map((el) => el.textContent?.trim()), ["Guests arrive", "Cake"], "the BEO's own step and the chat's");
  // Each field its own mark.
  assert.equal(labelMark("input-event-title"), "the park's default");
  assert.equal(labelMark("textarea-special-requests"), "from the family");
  assert.equal(labelMark("input-event-decoration"), "from the family");
  assert.equal(labelMark("input-event-activities"), "from the team");
  assert.equal(labelMark("input-child-name"), "from the family");
  assert.equal(labelMark("input-num-adults"), "from the family");
  assert.equal(labelMark("input-num-children"), "from the team");
  assert.equal(labelMark("input-location-text"), "from the team");
  assert.equal(labelMark("input-package-name"), "from the team");
  assert.equal(labelMark("input-prepayment"), "from the team");
  // An edit: the mark says changed here.
  await typeInto("input-event-activities", "Games and a show");
  assert.equal(labelMark("input-event-activities"), "changed here");
  assert.equal(labelMark("input-event-decoration"), "from the family", "the others keep theirs");
});

await check("Save sends the form once, the chat's fields in it", async () => {
  asked.length = 0;
  await click("button-save-beo");
  const puts = asked.filter((a) => a.method === "PUT" && a.path === `/api/events/${E_INBOX}/beo`);
  assert.equal(puts.length, 1, "one Save");
  const sent = puts[0]!.body as { event: Record<string, unknown>; setupPlan: Record<string, unknown>; partyDetails: Record<string, unknown> };
  assert.equal(sent.event.specialRequests, "No nuts please");
  assert.equal(sent.event.decoration, "unicorn theme");
  assert.equal(sent.event.activities, "Games and a show");
  assert.equal(sent.event.childName, "Emma");
  assert.equal(sent.setupPlan.readyBy, "13:30");
  assert.equal(sent.setupPlan.responsible, "Ying");
  assert.equal(sent.partyDetails.packageName, "Floresta");
});

await check("Fetch from chat after the approval: a field re-filled from a newer team line wears that line's mark; the model's title is never offered", async () => {
  // The form holds 6 adults, the family's; the chat moved and the team's line 4 says 8.
  assert.equal(labelMark("input-num-adults"), "from the family");
  await click("button-fetch-from-chat");
  await click("button-fetch-read");
  await settle(8);
  assert.equal(byTestId("fetch-change-title"), null, "the fill's title is the model's own guess, and the park's default is the BEO's name already: nothing offered");
  const adults = required("fetch-change-numAdults");
  assert.equal(text("text-fetch-was", adults), "6");
  assert.equal(text("text-fetch-now", adults), "8");
  assert.equal(text("ai-review-source", adults), "from the team");
  await click("button-fetch-accept", adults);
  await click("button-fetch-apply");
  await settle(4);
  assert.equal(text("input-num-adults"), "8");
  assert.equal(labelMark("input-num-adults"), "from the team", "the mark says where the value now came from");
  assert.equal(labelMark("input-num-children"), "from the team", "the others keep theirs");
  assert.equal(labelMark("input-event-decoration"), "from the family");
  assert.equal(text("ai-from-chat-event-info"), "from the chat");
});

await check("a pasted message opens the same review and approves the same way; without a catalogue the preview of before is the only step", async () => {
  await open(E_PLAIN);
  await click("button-ai-fill-beo");
  await setValue(required("textarea-ai-fill-beo") as HTMLTextAreaElement, RULING);
  asked.length = 0;
  await click("button-ai-parse-beo");
  await settle(8);
  assert.equal(asked.filter((a) => a.path === "/api/ai/parse-beo").length, 1);
  assert.ok(required("button-ai-review-approve"), "the same review");
  assert.ok(byTestId("text-ai-review-pasted"), "read as the team's confirmation");
  assert.equal(inputValue("input-ai-review-title"), "ZZ TEST plain", "the BEO's own name stays; the park's default is offered");
  // The park's default is named as such — never called the chat's words.
  assert.match(text("text-ai-review-chat-says-title")!, /The park's default is "Emma's 6th Birthday"\s*the park's default\s*Use the park's default/);
  assert.ok(!text("text-ai-review-chat-says-title")!.includes("The chat says"));
  assert.equal(inputValue("input-ai-review-specialRequests"), "No nuts please");
  await click("button-ai-review-approve");
  await settle(10);
  assert.equal(asked.filter((a) => a.method === "POST" && a.path === `/api/events/${E_PLAIN}/beo/ai-fill/approve`).length, 1);
  assert.equal(byTestId("button-ai-review-approve"), null);
  assert.equal(byTestId("button-ai-fill-confirm"), null, "no second preview");
  assert.equal(text("ai-from-chat-event-info"), "from the chat");
  assert.equal(labelMark("textarea-special-requests"), "from the family");
  // No catalogue: the free-text preview, loaded into the editor as before — one step, not two.
  await open(E_BARE, "inbox");
  assert.equal(byTestId("button-ai-review-approve"), null, "no review without a catalogue");
  assert.ok(required("button-ai-fill-confirm"), "the preview of before");
  assert.ok(byTestId("ai-fill-inbox-source"), "with the message it read");
  await click("button-ai-fill-confirm");
  await settle(6);
  assert.equal(byTestId("button-ai-fill-confirm"), null, "loaded, closed");
  assert.equal(text("input-child-name"), "Emma");
});

await check("text typed before AI Fill survives the approval: the review keeps it, the one Save writes it, the read-back shows it", async () => {
  await open(E_TYPED);
  await typeInto("textarea-special-requests", "ZZ typed: a quiet corner, please");
  assert.equal(text("textarea-special-requests"), "ZZ typed: a quiet corner, please");
  await click("button-ai-fill-beo");
  await setValue(required("textarea-ai-fill-beo") as HTMLTextAreaElement, RULING);
  asked.length = 0;
  await click("button-ai-parse-beo");
  await settle(8);
  assert.equal(inputValue("input-ai-review-specialRequests"), "ZZ typed: a quiet corner, please", "the typed text stays; the chat's is offered beside it");
  assert.match(text("text-ai-review-chat-says-specialRequests")!, /The chat says "No nuts please"\s*from the family\s*Use the chat's/);
  await click("button-ai-review-approve");
  await settle(10);
  const post = asked.find((a) => a.method === "POST" && a.path === `/api/events/${E_TYPED}/beo/ai-fill/approve`);
  assert.ok(post, "one approval");
  const body = post!.body as unknown as BeoAiApproveBody;
  assert.equal(body.details?.specialRequests, "ZZ typed: a quiet corner, please", "typed and not yet saved: written by the one Save, as it stands");
  assert.equal(body.details?.title, undefined, "the BEO's saved name is not written back over itself");
  assert.ok(!body.sources.some((s) => s.field === "specialRequests"), "typed text is nobody's line");
  assert.equal(byTestId("button-ai-review-approve"), null);
  assert.equal(text("textarea-special-requests"), "ZZ typed: a quiet corner, please", "the read-back after the approval shows the typed text, not the empty saved one");
  assert.equal(labelMark("textarea-special-requests"), null, "no mark: nobody's line");
});

await check("a time, the cake or the setup's who edited after the approval says changed here", async () => {
  // E_TYPED, approved from the pasted message in the check before: the times the team's, the cake
  // the family's, the setup's who the team's. These inputs sit beside their label, not under it.
  const markAbove = (id: string, levels: number) => {
    let block: HTMLElement = required(id);
    for (let i = 0; i < levels; i += 1) block = block.parentElement!;
    return byTestId("ai-review-source", block)?.textContent?.trim() ?? null;
  };
  assert.equal(markAbove("button-start-time-edit", 2), "from the team");
  assert.equal(markAbove("button-end-time-edit", 2), "from the team");
  assert.equal(markAbove("button-cake-external", 2), "from the family");
  assert.equal(markAbove("button-clear-responsible", 2), "from the team");
  // The start time, set again: changed here; the end time keeps its mark.
  await click("button-start-time-edit");
  await setValue(required("input-start-time") as HTMLInputElement, "14:30");
  await click("button-confirm-start-time");
  assert.equal(byTestId("button-confirm-start-time"), null, "the picker closed");
  assert.equal(markAbove("button-start-time-edit", 2), "changed here");
  assert.equal(markAbove("button-end-time-edit", 2), "from the team", "the end time keeps its mark");
  // The end time, cleared: changed here.
  await click("button-end-time-clear");
  assert.equal(markAbove("button-end-time", 2), "changed here");
  // The cake, made the family's own: changed here.
  await click("button-cake-external");
  assert.equal(markAbove("button-cake-external", 2), "changed here");
  // The setup's who, cleared: changed here (the search opens in its place).
  await click("button-clear-responsible");
  assert.equal(markAbove("input-setup-responsible-search", 3), "changed here");
  assert.equal(labelMark("input-event-decoration"), "from the family", "the others keep theirs");
});

await check("an empty BEO's sections say plain words, never a placeholder", async () => {
  await open(E_EMPTY);
  for (const section of ["party-host", "party-details", "setup-plan", "timeline"]) await click(`accordion-${section}`);
  assert.equal(text("text-no-entertainment-acts"), "No entertainment acts yet. Add one and give it a time to put it on the Timeline.");
  assert.equal(text("button-add-first-package-item"), "No line items yet. Click to add the first.");
  assert.equal(text("button-add-first-setup-task"), "No setup tasks yet. Click to add the first.");
  assert.equal(text("button-add-first-timeline-item"), "No timeline steps yet. Click to add the first.");
  const page = doc.body.textContent ?? "";
  assert.ok(!/lorem/i.test(page), "no lorem");
  assert.ok(!page.includes("Click here to add first"), "the old words are gone");
  assert.equal(doc.querySelectorAll('[data-testid^="ai-from-chat-"]').length, 0, "a BEO nobody filled from the chat wears no chip");
});

await check("SCRUM-903: no team confirmation and an empty catalogue — the review says so, shows the chat's words under each value, offers no Load into Editor, and writes only on Approve and create", async () => {
  asked.length = 0;
  const before = approvals;
  await open(E_NORULING, "inbox");
  assert.ok(required("button-ai-review-approve"), "the review in edit mode");
  assert.match(text("text-ai-review-no-ruling")!, /^Nothing is confirmed by the team yet/);
  assert.match(text("text-ai-review-no-catalogue")!, /catalogue is empty: every package, dish and show the chat names is a line to keep or leave out/);
  assert.equal(byTestId("button-ai-review-fallback"), null, "no ruling message: no free-text fill to load");
  assert.equal(byTestId("text-ai-review-final-message"), null, "Final Message to Parent stays empty");
  // Book Date's reason line under each value: the chat's words, whose line, when on the park's clock.
  const says = [...doc.querySelectorAll('[data-testid="text-ai-review-chat-says"]')].map((el) => el.textContent!.replace(/\s+/g, " ").trim());
  for (const line of [
    `The chat says “${NO_RULING_LINE_1}”from the family· Mon 2 Nov 08:00`,
    "The chat says “no nuts please”from the family· Mon 2 Nov 08:00",
    "The chat says “pizza”from the family· Mon 2 Nov 08:00",
    "The chat says “a magic show”from the family· Mon 2 Nov 09:00",
  ]) {
    assert.ok(says.includes(line), `"${line}" is under its value: ${JSON.stringify(says)}`);
  }
  const start = required("input-ai-review-startTime").parentElement!.parentElement!;
  assert.match(text("text-ai-review-chat-says", start)!, /15:00, pizza for the kids/, "the start time's reason is under the start time");
  // The lines the catalogue lacks keep Approve and create shut until each is decided; nothing is sent before it.
  assert.equal((required("button-ai-review-approve") as HTMLButtonElement).disabled, true);
  assert.match(text("text-ai-review-undecided")!, /Decide the 2 lines/);
  for (const keep of [...doc.querySelectorAll('[data-testid="button-ai-review-keep"]')]) {
    await act(async () => { (keep as HTMLButtonElement).click(); });
  }
  await settle();
  assert.equal(approvals, before, "nothing written before Approve and create");
  assert.equal(asked.filter((a) => a.path.endsWith("/beo/ai-fill/approve")).length, 0);
  await click("button-ai-review-approve");
  assert.equal(approvals, before + 1, "one press, one write");
  const body = asked.find((a) => a.path.endsWith("/beo/ai-fill/approve"))!.body as unknown as BeoAiApproveBody;
  assert.equal(body.conversationId, CONV, "the approval names the conversation that was read");
  assert.equal(body.messageId, null);
  assert.equal(body.event.internalStaffNotes, undefined, "Final Message to Parent is not written");
  assert.equal(body.event.startTime, "15:00");
  assert.deepEqual(body.menuLines.map((l) => [l.itemName, l.productCode]), [["pizza", null]]);
  assert.deepEqual(body.entertainment.map((e) => [e.templateId, e.name]), [[null, "a magic show"]]);
  assert.ok(body.sources.length > 0 && body.sources.every((src) => src.source === "family" || src.source === "staff"), JSON.stringify(body.sources));
  assert.ok(!JSON.stringify(body).includes("quote") && !JSON.stringify(body).includes("NORULING-903"), "the chat's words never ride the approval");
});

await act(async () => { root.unmount(); });
console.log(`beo-prefill-ui.check: ${checks} checks passed`);
process.exit(checks === 11 ? 0 : 1);
