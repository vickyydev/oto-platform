// seed: none — no database and no server: every HTTP answer here is local and
// synthetic. Not a Playwright file: it renders the BEO's Billing section under
// jsdom with React and react-query as the app builds them, and reads the
// editor's and the server's source for the lines that decide what is said.
//
// SCRUM-1001 (the BEO half) — once a party's main bill is settled at the till,
// items added later in the BEO go on additional bills, paid at the till. The
// BEO is seen by staff only, and there the party's money reads honestly:
//
//   - the Billing section says the main bill is settled (its receipt as
//     before) and, apart from it, each additional bill with its amount and
//     whether it is open or paid; its badge never says "Paid" while an
//     additional bill is open: "Additional bill open · ฿7.05 outstanding";
//   - the older Financial Summary card no longer says NOT PAID beside a bill
//     settled at the till: once the till holds the sale, what is paid and
//     what is outstanding are the till's, the same words as the badge; before
//     settlement it reads as it always did;
//   - the Save asks to bill new items only when the Save may bill something
//     new (the main bill settled, an approved priced line above the count the
//     till has billed, or the till unknown), and after it says what happened:
//     "linked to the additional bill" only when the till made a charge, else
//     "nothing new to bill".
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-additional-bill-ui.check.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { quoteAnswer, saleAnswer } from "./fixtures/till-billing";
import * as tillBilling from "../shared/tillBilling";
import * as billingSource from "../shared/beoBillingSource";

const APP = fileURLToPath(new URL("../", import.meta.url));
/* eslint-disable @typescript-eslint/no-explicit-any -- the helpers are read off their modules by name, so a module without them fails here, not at import */
const T = tillBilling as Record<string, any>;
const S = billingSource as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const EVENT = "11111111-1111-4111-8111-111111111001";
const bill = (n: number, state: "open" | "paid", name: string, satang: number) => ({
  id: `6a59ed9d-240d-7000-8000-00000000000${n}`,
  eventId: EVENT,
  mainSettlementId: "0197a000-0000-7000-8000-000000000823",
  state,
  totalSatang: satang,
  paidSatang: state === "paid" ? satang : 0,
  outstandingSatang: state === "paid" ? 0 : satang,
  createdAt: "2026-11-18T10:00:00.000Z",
  paidAt: state === "paid" ? "2026-11-18T10:05:00.000Z" : null,
  charges: [{ id: `c${n}`, items: [{ name, qty: 1, lineTotalSatang: satang }], totalSatang: satang }],
  payments: state === "paid" ? [{ id: `p${n}`, amountSatang: satang, method: "cash", takenAt: "2026-11-18T10:05:00.000Z" }] : [],
});
const ok = (billing: unknown) => ({ status: "ok" as const, billing: tillBilling.TillBillingSchema.parse(billing), readAt: "2026-11-18T10:10:00.000Z" });
const saleWith = (...bills: ReturnType<typeof bill>[]) => ({ ...saleAnswer(EVENT), additionalBills: bills });
const DISH = bill(1, "paid", "ZZ TEST 1001 dish A", 2503);
const DRINK_OPEN = bill(2, "open", "ZZ TEST 1001 drink B", 705);
const DRINK_PAID = bill(2, "paid", "ZZ TEST 1001 drink B", 705);

// ─── What is said of the party's money ──────────────────────────────────────

await check("the badge's words: the main bill owed as before; once paid, an additional bill still open with what is left on it; Paid only when every bill is", () => {
  assert.equal(typeof T.partyBillStateOf, "function", "shared/tillBilling.ts says the party's billing state");
  assert.deepEqual(T.partyBillStateOf(ok(quoteAnswer(EVENT))), { words: "฿14,025 outstanding", paid: false, outstandingSatang: 1_402_500 });
  assert.deepEqual(T.partyBillStateOf(ok(saleWith())), { words: "Paid", paid: true, outstandingSatang: 0 });
  assert.deepEqual(T.partyBillStateOf(ok(saleWith(DISH, DRINK_OPEN))), { words: "Additional bill open · ฿7.05 outstanding", paid: false, outstandingSatang: 705 });
  assert.deepEqual(T.partyBillStateOf(ok(saleWith(bill(1, "open", "ZZ a", 2503), DRINK_OPEN))), { words: "2 additional bills open · ฿32.08 outstanding", paid: false, outstandingSatang: 3208 });
  assert.deepEqual(T.partyBillStateOf(ok(saleWith(DISH, DRINK_PAID))), { words: "Paid", paid: true, outstandingSatang: 0 });
  assert.equal(T.partyBillStateOf({ status: "not_reachable", message: "down" }), null, "no figures, no words");
  assert.deepEqual(T.openAdditionalBillsOf(ok(saleWith(DISH, DRINK_OPEN))), { count: 1, outstandingSatang: 705, words: "Additional bill open" });
  assert.deepEqual(T.openAdditionalBillsOf(ok(saleWith(DISH))), { count: 0, outstandingSatang: 0, words: null });
});

// ─── The Save's question and its answer ─────────────────────────────────────

type Line = { id: string; itemName: string; quantity: number; price: number; included: boolean; chargeApproved?: boolean; source?: string };
const line = (id: string, quantity: number, over: Partial<Line> = {}): Line => ({ id, itemName: `ZZ TEST ${id}`, quantity, price: 25.03, included: false, chargeApproved: true, ...over });
const billedSale = (beoLines: Array<{ lineId: string; billedQuantity: number; paidQuantity: number }> | undefined) =>
  ok({ ...saleWith(DISH), ...(beoLines ? { beoLines } : {}) });

await check("the Save asks first only when it may bill something new at the till", () => {
  assert.equal(typeof S.mayBillAtSave, "function", "shared/beoBillingSource.ts says whether a Save may bill");
  const billed = billedSale([{ lineId: "dish", billedQuantity: 1, paidQuantity: 1 }]);
  assert.equal(S.mayBillAtSave([], billed), false, "no approved line: nothing to ask");
  assert.equal(S.mayBillAtSave([line("dish", 1)], billed), false, "every approved line already billed at its count: nothing new");
  assert.equal(S.mayBillAtSave([line("free", 2, { included: true, price: 0 }), line("noprice", 1, { price: 0 })], billed), false, "an included line, or one with no price, is billed at nothing");
  assert.equal(S.mayBillAtSave([line("set", 3, { source: "set_menu" }), line("plain", 1, { chargeApproved: false })], billed), false, "a set dish, or a line staff did not approve, is never billed at a Save");
  assert.equal(S.mayBillAtSave([line("dish", 2)], billed), true, "a raise above the billed count");
  assert.equal(S.mayBillAtSave([line("dish", 1), line("new", 1)], billed), true, "a new priced line");
  assert.equal(S.mayBillAtSave([line("dish", "2" as unknown as number)], billed), true, "a count stored as text is read as the till reads it");
  assert.equal(S.mayBillAtSave([line("new", 1)], ok(quoteAnswer(EVENT))), false, "before the main bill is settled the till bills nothing at a Save");
  assert.equal(S.mayBillAtSave([line("new", 1)], { status: "not_reachable", message: "down" }), true, "the till unknown: asked, as before");
  assert.equal(S.mayBillAtSave([line("new", 1)], undefined), true, "not read yet: asked, as before");
  assert.equal(S.mayBillAtSave([line("dish", 1)], billedSale(undefined)), true, "a platform from before beoLines: asked, as before");
});

await check("the Save's answer: linked to the additional bill only when the till made a charge; else nothing new to bill", () => {
  assert.equal(typeof S.additionalBillingResultOf, "function", "shared/beoBillingSource.ts words the till's answer");
  assert.equal(S.ADDITIONAL_BILL_LINKED, "New approved items are linked to the party's additional bill; the original paid receipt is unchanged.");
  assert.equal(S.NOTHING_NEW_TO_BILL, "Nothing new to bill; the party's bills are unchanged.");
  assert.deepEqual(S.additionalBillingResultOf({ status: "synced", added: 1, billIds: ["b"] }), { status: "synced", message: S.ADDITIONAL_BILL_LINKED, added: 1 });
  assert.deepEqual(S.additionalBillingResultOf({ status: "synced", added: 0, billIds: [] }), { status: "synced", message: S.NOTHING_NEW_TO_BILL, added: 0 });
  assert.deepEqual(S.additionalBillingResultOf({ status: "plan_only", added: 0, billIds: [] }), { status: "plan_only", message: "Items remain in the plan until the main party is settled." });
  // A platform that does not count what it added: the words it always had.
  assert.deepEqual(S.additionalBillingResultOf({ status: "synced" }), { status: "synced", message: S.ADDITIONAL_BILL_LINKED });
  assert.deepEqual(S.additionalBillingToastOf({ status: "synced", message: S.ADDITIONAL_BILL_LINKED, added: 2 }), { title: "BEO saved", description: S.ADDITIONAL_BILL_LINKED });
  assert.deepEqual(S.additionalBillingToastOf({ status: "synced", message: S.NOTHING_NEW_TO_BILL, added: 0 }), { title: "BEO saved, nothing new to bill" });
  assert.equal(S.additionalBillingToastOf({ status: "plan_only", message: "Items remain in the plan until the main party is settled." }), null, "before settlement: the usual words");
  assert.equal(S.additionalBillingToastOf({ status: "pending", message: "x" }), null, "pending has its own words");
});

await check("the editor and the server use those words: the question behind mayBillAtSave, the answer from the till's count", () => {
  const editor = readFileSync(APP + "client/src/components/beo/beo-event-editor.tsx", "utf8");
  assert.match(editor, /if \(mayBillAtSave\(approved, tillBilling\.data\) && !window\.confirm\(/, "the question is asked only when the Save may bill");
  assert.match(editor, /additionalBillingToastOf\(saved\?\.additionalBilling\) \?\? \{ title: "BEO data saved successfully" \}/, "the answer's words after a Save");
  assert.match(editor, /const partyBill = partyBillStateOf\(tillBilling\.data\);/);
  assert.match(editor, /data-testid="badge-billing-outstanding">\s*\{partyBill\.words\}/, "the Billing badge says the party's state");
  assert.match(editor, /const additionalOpen = openAdditionalBillsOf\(tillBilling\.data\);/);
  assert.doesNotMatch(editor, /outstandingSatang > 0 \? `\$\{bahtOfSatang\(tillFigures\.outstandingSatang\)\} outstanding` : "Paid"/, "the badge no longer says Paid off the main bill alone");
  const server = readFileSync(APP + "server/lib/beoAdditionalBilling.ts", "utf8");
  assert.match(server, /const result = additionalBillingResultOf\(answer\);/, "the server words the till's answer by its count");
  assert.doesNotMatch(server, /answer\.status === "synced" \? "New approved items are linked/, "never linked whatever the till did");
});

// ─── The Billing section, rendered ───────────────────────────────────────────

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
win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
const doc = dom.window.document;

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
      export { BeoBillingSection } from './client/src/components/beo/beo-till-billing';
    `,
  },
});
const nativeRequire = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(APP + "tests/beo-additional-bill-ui.native.cjs") as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Module compiled from source
compiled.filename = APP + "tests/beo-additional-bill-ui.native.cjs";
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClient, QueryClientProvider, getQueryFn, BeoBillingSection } = compiled.exports;

let tillAnswer: unknown = null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
g.fetch = async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  if (url.pathname === `/api/events/${EVENT}/beo/till-billing`) return json(tillAnswer);
  if (url.pathname === `/api/events/${EVENT}/line-items`) return json([]);
  if (url.pathname === "/api/settings/line-item-templates") return json([]);
  return json({ message: "not here" }, 404);
};

const client = new QueryClient({ defaultOptions: { queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false, staleTime: Infinity } } });
const host = doc.createElement("div");
doc.body.appendChild(host);
const root = createRoot(host);
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const mount = async (answer: unknown) => {
  tillAnswer = answer;
  await act(async () => { root.render(null); });
  client.clear();
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(BeoBillingSection, { eventId: EVENT, billing: null, onBillingChange: () => undefined, isManager: true })));
  });
  await settle();
};
const text = (testId: string) => (doc.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
const panel = () => text("panel-from-the-till") ?? "";
const summary = () => ((doc.querySelector('[data-testid="input-deposit-amount"]') as HTMLElement).closest(".border-2") as HTMLElement).textContent ?? "";

await check("settled with one additional bill paid and one open: the main bill settled with its receipt, each additional bill open or paid with its amount, and the summary agrees", async () => {
  await mount(ok(saleWith(DISH, DRINK_OPEN)));
  assert.equal(text("badge-till-sale-state"), "Main bill settled");
  assert.match(panel(), /Main bill\s*฿17,025/, "the main bill's total, called so");
  assert.match(panel(), /Main bill outstanding\s*฿0/, "what is left on the main bill, called so");
  assert.match(text("text-till-receipt")!, /^Receipt T1-000822 · ZZ TEST Till 1\s*Settled /, "the receipt as before");
  const paidBill = text("additional-bill-0")!;
  assert.ok(paidBill.startsWith("Additional bill 1 · Paid"), paidBill);
  assert.ok(paidBill.includes("ZZ TEST 1001 dish A x 1 - ฿25.03") && paidBill.includes("Total ฿25.03 - Paid ฿25.03 - Outstanding ฿0"), paidBill);
  const openBill = text("additional-bill-1")!;
  assert.ok(openBill.startsWith("Additional bill 2 · Open"), openBill);
  assert.ok(openBill.includes("ZZ TEST 1001 drink B x 1 - ฿7.05") && openBill.includes("Total ฿7.05 - Paid ฿0 - Outstanding ฿7.05"), openBill);
  assert.equal(text("additional-bill-state-1"), "Open");
  // The receipt is the main bill's: it comes before the additional bills.
  assert.ok(panel().indexOf("Receipt T1-000822") < panel().indexOf("Additional bill 1"), "the main bill's receipt, then the additional bills");
  assert.equal(text("badge-summary-till"), "Additional bill open · ฿7.05 outstanding", "the summary says what the Billing badge says");
  assert.doesNotMatch(summary(), /NOT PAID|PART PAID|Financial SummaryPAID/, `no paid wording of the app's own: ${summary()}`);
  assert.equal(text("text-summary-outstanding"), "฿7.05", "the summary's outstanding is the till's");
  assert.match(text("text-summary-from-till")!, /^Settled at the till: what is paid and outstanding is the till's, as above\./);
});

await check("every bill paid: Paid in the summary, and the additional bills both read Paid", async () => {
  await mount(ok(saleWith(DISH, DRINK_PAID)));
  assert.equal(text("badge-summary-till"), "Paid");
  assert.equal(text("text-summary-outstanding"), "฿0");
  assert.equal(text("additional-bill-state-0"), "Paid");
  assert.equal(text("additional-bill-state-1"), "Paid");
  assert.doesNotMatch(summary(), /NOT PAID/);
});

await check("settled with no additional bill: the panel reads as before (Settled, Total, Outstanding); the summary says Paid, never NOT PAID", async () => {
  await mount(ok(saleWith()));
  assert.equal(text("badge-till-sale-state"), "Settled");
  assert.match(panel(), /Total\s*฿17,025/);
  assert.doesNotMatch(panel(), /Main bill/);
  assert.equal(text("badge-summary-till"), "Paid");
  assert.doesNotMatch(summary(), /NOT PAID/);
});

await check("before the party is settled: the summary is the app's own invoice rows' as it always was", async () => {
  await mount(ok(quoteAnswer(EVENT)));
  assert.equal(text("badge-summary-till"), null);
  assert.equal(text("text-summary-from-till"), null);
  assert.match(summary(), /NOT PAID/, "no lines and no deposit: NOT PAID, as before");
});

await act(async () => { root.render(null); });
console.log(`beo-additional-bill-ui.check: ${checks} checks passed`);
process.exit(checks === 8 ? 0 : 1);
