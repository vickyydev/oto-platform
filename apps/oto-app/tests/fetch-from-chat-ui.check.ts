// seed: none — no database and no server: the conversation's reading is a
// local stub. Not a Playwright file: it renders the BEO form's real "Fetch
// from chat" dialog under jsdom with React and Radix as the app builds them,
// and presses its buttons.
//
// SCRUM-826 — "Fetch from chat" on the BEO form, the screen's half (the
// server's and the diff's rules are tests/fetch-from-chat.check.ts):
//
//   1. the press warns first — this may change details typed in this form —
//      and reads nothing until "Read the chat" is pressed;
//   2. then every change is listed: the field, what the form holds → what the
//      chat says, whose line it was; each accepted or declined, accept all and
//      decline all; a row left undecided is neither applied nor remembered;
//   3. Apply puts only the accepted ones in the form (unsaved until Save) and
//      remembers the declined ones BY FIELD (SCRUM-826): on the next fetch of
//      the same chat that field is held back, whatever value the chat reads
//      for it, and said so; once the chat's newest line moves it is offered
//      again; an accepted field is let go of the memory;
//   4. a fetch that finds nothing new says so; a read that fails says why and
//      offers to try again; Cancel applies and remembers nothing;
//   5. what the chat says of the package, set menu, food and entertainment
//      that the BEO lacks is listed to read, with no accept or decline and a
//      line saying where it is chosen; it is never called "the same".
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/fetch-from-chat-ui.check.ts
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
      export { BeoFetchFromChatDialog, FETCH_WARNING } from './client/src/components/beo/beo-fetch-from-chat';
      export { NO_DECLINED } from './client/src/lib/beo-fetch-from-chat';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/fetch-from-chat-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/fetch-from-chat-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, BeoFetchFromChatDialog, FETCH_WARNING, NO_DECLINED } = compiled.exports;

type FetchFormValues = import("../client/src/lib/beo-fetch-from-chat").FetchFormValues;
type DeclinedChanges = import("../client/src/lib/beo-fetch-from-chat").DeclinedChanges;
type FetchAnswer = import("../client/src/lib/beo-fetch-from-chat").FetchAnswer;
type ProposedEntertainment = import("../shared/beoAiFill").BeoAiProposal["entertainment"];

// ─── The chat's reading, as the server answers it ───────────────────────────

const LINE_4 = "44444444-4444-4444-8444-444444444444";
const LINE_5 = "55555555-5555-4555-8555-555555555555";
const MAGICIAN = "d4d4d4d4-0000-4000-8000-000000000004";
const from = (line: number) => ({ source: "team" as const, at: `2026-11-02T0${line}:00:00.000Z`, line });
/** 6 adults and the cake at 16:00, the team's lines 4; the rest as booked; the BEO holds no catalogue section. */
const answerAt = (chatMark: string, adults = 6, cakeTime = "16:00", entertainment: ProposedEntertainment = []): FetchAnswer => ({
  fill: { event: { title: "ZZ TEST Emma 826", numChildren: 12, numAdults: 4, startTime: "14:00", eventDate: "2026-11-21" }, kitchenPlan: { cakeTime: "15:30" } },
  review: {
    origin: "inbox",
    proposal: {
      package: null, addOns: [], setMenu: null, menuLines: [], entertainment, otherLines: [],
      event: { numChildren: { value: 12, from: from(2) }, numAdults: { value: adults, from: from(4) }, startTime: { value: "14:00", from: from(2) } },
      cake: { mode: null, notes: null, time: cakeTime, from: from(4) },
      deposit: null,
    },
    catalogue: { packages: [], setMenus: [], entertainment: [{ id: MAGICIAN, name: "ZZ TEST Magician", category: null, durationMinutes: 30, price: 350000, unit: null, priceIsFrom: false }], food: [] },
    finalMessage: null,
    ruling: from(2),
    transcript: { lines: 4, cut: false },
    replaces: [],
    parentSelection: null,
  },
  chatMark,
  held: { package: null, packageItems: [], setMenuTemplateId: null, menuLines: [], entertainment: [] },
});
/** "please add the magician", the team's line 5: an entertainment line the BEO lacks. */
const WITH_MAGICIAN: ProposedEntertainment = [{ templateId: MAGICIAN, name: "ZZ TEST Magician", said: "the magician", quantity: 1, chatPrice: null, notInCatalogue: false, from: from(5) }];

/** The form as the person left it: 5 adults typed over the booked 4. */
const current: FetchFormValues = {
  title: "ZZ TEST Emma 826", childName: "Emma", bookingName: "ZZ TEST Olga", numChildren: 12, numAdults: 5, startTime: "14:00", endTime: "",
  eventDate: "2026-11-21", locationText: "", specialRequests: "", activities: "", decoration: "", setupReadyBy: "", setupResponsible: "",
  cakeMode: "EXTERNAL", cakeNotes: "", cakeTime: "15:30", prepaymentReceived: 5000, depositDate: "2026-11-02", packageName: "", packageNotes: "",
};
let answer: () => Promise<FetchAnswer> = () => Promise.resolve(answerAt(LINE_4));
let reads = 0;
let declined: DeclinedChanges = NO_DECLINED;
const applied: Array<Partial<FetchFormValues>> = [];
const remembered: DeclinedChanges[] = [];
let closed = 0;
let open = false;

// ─── Rendering ───────────────────────────────────────────────────────────────

const settle = async (rounds = 4) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const byTestId = (id: string, within: ParentNode = doc) => within.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string, within: ParentNode = doc) => { const el = byTestId(id, within); assert.ok(el, `the dialog shows ${id}`); return el; };
const click = async (id: string, within: ParentNode = doc) => { await act(async () => { required(id, within).click(); }); await settle(); };
const text = (id: string, within: ParentNode = doc) => byTestId(id, within)?.textContent?.replace(/\s+/g, " ").trim() ?? null;

const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const render = async () => {
  await act(async () => {
    root.render(React.createElement(BeoFetchFromChatDialog, {
      open,
      onClose: () => { closed += 1; open = false; },
      form: () => ({ ...current }),
      read: () => { reads += 1; return answer(); },
      declined,
      onDeclined: (next: DeclinedChanges) => { declined = next; remembered.push(next); },
      onApply: (patch: Partial<FetchFormValues>) => { applied.push(patch); Object.assign(current, patch); },
    }));
  });
  await settle();
};
/** As the editor does: the header's button opens it afresh. */
const openDialog = async () => {
  open = false;
  await render();
  open = true; closed = 0; reads = 0; applied.length = 0; remembered.length = 0;
  await render();
};
const row = (field: string) => required(`fetch-change-${field}`);

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

await check("the press warns first — it may change typed details — and reads nothing until Read the chat is pressed", async () => {
  await openDialog();
  assert.ok(required("dialog-fetch-from-chat"));
  assert.equal(text("text-fetch-warning"), FETCH_WARNING);
  assert.match(FETCH_WARNING, /may change details typed in this form/);
  assert.match(FETCH_WARNING, /nothing is changed until you accept it/);
  assert.equal(reads, 0, "nothing read yet");
  assert.equal(byTestId("text-fetch-count"), null);
  assert.ok(required("button-fetch-read"));
});

await check("Read the chat: every change listed — the field, the form's value → the chat's, whose line — undecided, and Apply says Done", async () => {
  await click("button-fetch-read");
  assert.equal(reads, 1);
  assert.equal(text("text-fetch-count"), "2 changes from the chat");
  const adults = row("numAdults");
  assert.equal(text("text-fetch-was", adults), "5", "the typed value is shown, not overwritten");
  assert.equal(text("text-fetch-now", adults), "6");
  assert.equal(text("ai-review-source", adults), "from the team");
  assert.equal(adults.getAttribute("data-decision"), "undecided");
  const cake = row("cakeTime");
  assert.equal(text("text-fetch-was", cake), "15:30");
  assert.equal(text("text-fetch-now", cake), "16:00");
  assert.equal(cake.getAttribute("data-decision"), "undecided");
  assert.equal(text("button-fetch-apply"), "Done");
  assert.equal(byTestId("text-fetch-held"), null);
  assert.deepEqual(applied, [], "nothing applied by the read");
});

await check("one accepted, one declined, Apply: only the accepted lands in the form; the declined is remembered on this chat; the dialog closes", async () => {
  await click("button-fetch-accept", row("numAdults"));
  assert.equal(row("numAdults").getAttribute("data-decision"), "accept");
  assert.equal(text("button-fetch-apply"), "Apply 1 accepted");
  await click("button-fetch-decline", row("cakeTime"));
  assert.equal(row("cakeTime").getAttribute("data-decision"), "decline");
  await click("button-fetch-apply");
  assert.deepEqual(applied, [{ numAdults: 6 }]);
  assert.equal(current.numAdults, 6);
  assert.equal(current.cakeTime, "15:30", "the declined change left the form alone");
  assert.deepEqual(remembered, [{ chatMark: LINE_4, fields: ["cakeTime"] }]);
  assert.equal(closed, 1);
  await render();
  assert.equal(byTestId("dialog-fetch-from-chat"), null, "closed");
});

await check("the same chat fetched again: the declined change is held back and said so; nothing else is new", async () => {
  await openDialog();
  await click("button-fetch-read");
  assert.equal(text("text-fetch-same"), "The chat reads the same as the form. 1 change you declined earlier is not offered again until the chat changes.");
  assert.equal(byTestId("text-fetch-count"), null);
  assert.equal(byTestId("button-fetch-apply"), null);
  await click("button-fetch-cancel");
  assert.deepEqual(applied, []);
  assert.deepEqual(remembered, []);
});

await check("the chat's newest line moved: the declined change is offered again; Accept all, Apply lands it", async () => {
  answer = () => Promise.resolve(answerAt(LINE_5));
  await openDialog();
  await click("button-fetch-read");
  assert.equal(text("text-fetch-count"), "1 change from the chat");
  assert.ok(row("cakeTime"));
  assert.equal(byTestId("text-fetch-held"), null);
  await click("button-fetch-accept-all");
  assert.equal(row("cakeTime").getAttribute("data-decision"), "accept");
  assert.equal(text("button-fetch-apply"), "Apply 1 accepted");
  await click("button-fetch-apply");
  assert.deepEqual(applied, [{ cakeTime: "16:00" }]);
  assert.equal(current.cakeTime, "16:00");
  assert.deepEqual(remembered, [{ chatMark: LINE_5, fields: [] }], "nothing declined this time: the memory moves to this chat, holding nothing");
});

await check("a row left undecided is neither applied nor remembered; Decline all remembers every row and applies none; Cancel does neither", async () => {
  answer = () => Promise.resolve(answerAt(LINE_5, 8, "17:00"));
  await openDialog();
  await click("button-fetch-read");
  assert.equal(text("text-fetch-count"), "2 changes from the chat");
  await click("button-fetch-cancel");
  assert.deepEqual(applied, []);
  assert.deepEqual(remembered, []);
  assert.equal(closed, 1);

  await openDialog();
  await click("button-fetch-read");
  await click("button-fetch-accept", row("numAdults"));
  // The cake row is left undecided.
  await click("button-fetch-apply");
  assert.deepEqual(applied, [{ numAdults: 8 }]);
  assert.deepEqual(remembered, [{ chatMark: LINE_5, fields: [] }], "an undecided row is not remembered");
  assert.equal(current.cakeTime, "16:00", "nor applied");

  await openDialog();
  await click("button-fetch-read");
  assert.equal(text("text-fetch-count"), "1 change from the chat", "only the cake is left");
  await click("button-fetch-decline-all");
  assert.equal(row("cakeTime").getAttribute("data-decision"), "decline");
  assert.equal(text("button-fetch-apply"), "Done");
  await click("button-fetch-apply");
  assert.deepEqual(applied, []);
  assert.deepEqual(remembered, [{ chatMark: LINE_5, fields: ["cakeTime"] }]);
});

await check("SCRUM-826: a declined field is held on the same chat whatever value the chat reads for it next", async () => {
  // The cake time declined at 17:00; the same chat now reads 18:00 for it: still held, and said so.
  answer = () => Promise.resolve(answerAt(LINE_5, 8, "18:00"));
  await openDialog();
  await click("button-fetch-read");
  assert.equal(text("text-fetch-same"), "The chat reads the same as the form. 1 change you declined earlier is not offered again until the chat changes.");
  assert.equal(byTestId("fetch-change-cakeTime"), null, "another value for the declined field slips nothing past the decline");
  await click("button-fetch-cancel");
  assert.deepEqual(applied, []);
  assert.deepEqual(remembered, []);
  assert.equal(current.cakeTime, "16:00");
});

await check("a read that fails says why and offers to try again; nothing new at all says so", async () => {
  let calls = 0;
  answer = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error("AI Fill did not run: the inbox did not answer.")) : Promise.resolve(answerAt(LINE_5, 8, "16:00"));
  };
  await openDialog();
  await click("button-fetch-read");
  assert.equal(text("text-fetch-error"), "AI Fill did not run: the inbox did not answer.");
  assert.ok(required("button-fetch-retry"));
  await click("button-fetch-retry");
  assert.equal(text("text-fetch-same"), "The chat reads the same as the form.");
  assert.deepEqual(applied, []);
});

await check("the chat names a magician the BEO lacks: listed to read beside the adults, with no accept or decline, and where it is chosen; alone, it is never called the same", async () => {
  // "6 adults and please add the magician": the adults a change to accept, the magician a catalogue change to read.
  answer = () => Promise.resolve(answerAt(LINE_5, 9, "16:00", WITH_MAGICIAN));
  await openDialog();
  await click("button-fetch-read");
  assert.equal(text("text-fetch-count"), "1 change from the chat");
  assert.ok(row("numAdults"));
  assert.equal(text("text-fetch-catalogue-count"), "1 change to the package, menu or entertainment");
  const magician = required("fetch-catalogue-entertainment");
  assert.equal(text("text-fetch-was", magician), "—");
  assert.equal(text("text-fetch-now", magician), "ZZ TEST Magician");
  assert.equal(text("ai-review-source", magician), "from the team");
  assert.equal(byTestId("button-fetch-accept", magician), null, "nothing to accept: it is read here, chosen in its section");
  assert.equal(byTestId("button-fetch-decline", magician), null);
  assert.match(text("text-fetch-catalogue-line") ?? "", /not applied here/);
  assert.equal(byTestId("text-fetch-same"), null);
  await click("button-fetch-accept-all");
  await click("button-fetch-apply");
  assert.deepEqual(applied, [{ numAdults: 9 }], "Accept all takes the field changes only");
  assert.equal(closed, 1);

  // The chat's only new line is the magician: no field differs, and the dialog says so rather than "reads the same".
  await openDialog();
  await click("button-fetch-read");
  assert.equal(byTestId("text-fetch-count"), null);
  assert.equal(byTestId("text-fetch-same"), null, "a catalogue change is never swallowed as the same");
  assert.equal(text("text-fetch-no-field"), "No detail typed in this form reads differently in the chat.");
  assert.ok(required("fetch-catalogue-entertainment"));
  assert.equal(byTestId("button-fetch-apply"), null);
  await click("button-fetch-cancel");
  assert.deepEqual(applied, []);
  assert.deepEqual(remembered, []);

  // The BEO holds the magician (chosen in its section): nothing listed, and now the chat reads the same.
  const held = answerAt(LINE_5, 9, "16:00", WITH_MAGICIAN);
  held.held = { ...held.held, entertainment: [{ templateId: MAGICIAN, name: "ZZ TEST Magician" }] };
  answer = () => Promise.resolve(held);
  await openDialog();
  await click("button-fetch-read");
  assert.equal(byTestId("fetch-catalogue"), null);
  assert.equal(text("text-fetch-same"), "The chat reads the same as the form.");
  await click("button-fetch-cancel");
});

await check("the editor mounts the dialog with its own form, read, memory and apply, behind a Fetch from chat button shown for a BEO from the inbox", () => {
  const editor = readFileSync(APP + "client/src/components/beo/beo-event-editor.tsx", "utf8");
  assert.match(editor, /data-testid="button-fetch-from-chat"/);
  assert.match(editor, /beoData\.inboxConversationId && \(\s*<Button[\s\S]*?Fetch from chat/);
  assert.match(editor, /<BeoFetchFromChatDialog[\s\S]*?form=\{fetchFormValues\}[\s\S]*?read=\{readChatForFetch\}[\s\S]*?declined=\{fetchDeclined\}[\s\S]*?onDeclined=\{setFetchDeclined\}[\s\S]*?onApply=\{applyFetched\}/);
  assert.match(editor, /purpose: "fetch"/, "the read asks the inbox fill as a fetch");
  assert.match(editor, /readChatForFetch = async[\s\S]*?package-snapshot[\s\S]*?entertainment-selections[\s\S]*?held/, "the catalogue section the BEO holds is read with the chat");
});

await act(async () => { root.unmount(); });
console.log(`fetch-from-chat-ui.check: ${checks} checks passed`);
process.exit(checks === 10 ? 0 : 1);
