// seed: none — a pure render, no database. Not a Playwright file: it renders
// the BEO's money screens to markup with the till's answers, so it runs with
// the JSX tsconfig.
//
// SCRUM-822 — one place for a party's money: every BEO screen that shows it
// reads the till's figures (shared/tillBilling.ts), and none works one out:
//
//   - the Billing section's "From the till" panel: before the party, Expected
//     total, Deposit paid, Outstanding, the breakdown line by line and the
//     Quote PDF; after it, the sale's receipt, its lines and its payments;
//   - the Party Details box's tiles: Total and Outstanding from the till, the
//     deposit between them the BEO's own (SCRUM-813), a deposit not saved yet
//     said;
//   - the Day-of view's POS section. SCRUM-833 pinned: a party whose package
//     snapshot holds 1,690,000 SATANG showed "฿1,690,000" for a ฿16,900
//     package; it reads ฿16,900 now, from the till, and the snapshot's figure
//     is never shown as baht;
//   - without the till, every one of them says "Till not reachable" and shows
//     no figure of its own.
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/till-billing-ui.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.APP_ENV ??= "dev";

const { TillBillingPanel, PartyDetailsTillTiles, TillMoneyRows } = await import("../client/src/components/beo/beo-till-billing");
const { DayOfPosSection } = await import("../client/src/components/beo/beo-day-of-pos");
const { TillBillingSchema } = await import("../shared/tillBilling");
const { noQuoteAnswer, quoteAnswer, saleAnswer } = await import("./fixtures/till-billing");
type Reading = import("../shared/tillBilling").TillBillingReading;

const ok = (billing: unknown): Reading => ({ status: "ok", billing: TillBillingSchema.parse(billing), readAt: "2026-11-10T08:00:00.000Z" });
const QUOTE = ok(quoteAnswer(randomUUID()));
const SALE = ok(saleAnswer(randomUUID()));
const NO_QUOTE = ok(noQuoteAnswer(randomUUID()));
const DOWN: Reading = { status: "not_reachable", message: "The till did not answer. Press Refresh from the till to ask again." };

/** Markup with React's text separators and HTML entities read back as text. */
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** The text inside the element carrying this test id (tags inside it dropped). */
function textOf(html: string, testId: string): string | null {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at < 0) return null;
  const open = html.lastIndexOf("<", at);
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(open))![1]!;
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = open;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(html.indexOf(">", open) + 1, m.index).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return null;
}

let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

check("From the till, before the party: Expected ฿17,025, Deposit ฿3,000, Outstanding ฿14,025, every line, and the Quote PDF", () => {
  const eventId = randomUUID();
  const html = render(React.createElement(TillBillingPanel, { eventId, reading: QUOTE, onRefresh: () => {} }));
  assert.equal(textOf(html, "text-till-panel-expected"), "฿17,025");
  assert.equal(textOf(html, "text-till-panel-deposit"), "฿3,000");
  assert.equal(textOf(html, "text-till-panel-outstanding"), "฿14,025");
  assert.equal(textOf(html, "badge-till-quote"), "Quote");
  assert.equal(textOf(html, "row-till-line-0"), "ZZ TEST Floresta Birthday ฿16,900");
  assert.equal(textOf(html, "row-till-line-1"), "Kids' table reserved for 3 hours Included");
  assert.equal(textOf(html, "row-till-line-3"), "Children (in the package) × 10 Included");
  assert.equal(textOf(html, "row-till-line-6"), "ZZ TEST bubble tea ฿125");
  assert.ok(html.includes(`href="/api/events/${eventId}/beo/quote.pdf"`), "the Quote PDF opens the till's quote");
  assert.equal(textOf(html, "button-refresh-from-till"), "Refresh from the till");
  assert.ok(!html.includes("1,690,000"));
});

check("From the till, after the party: the receipt and its till, the sale's lines, the deposit and the cash, nothing outstanding, no Quote PDF", () => {
  const html = render(React.createElement(TillBillingPanel, { eventId: randomUUID(), reading: SALE }));
  assert.equal(textOf(html, "badge-till-sale-state"), "Settled");
  assert.equal(textOf(html, "text-till-panel-expected"), "฿17,025");
  assert.equal(textOf(html, "text-till-panel-outstanding"), "฿0");
  assert.match(textOf(html, "text-till-receipt")!, /^Receipt T1-000822 · ZZ TEST Till 1 Settled /);
  assert.equal(textOf(html, "row-till-payment-0"), "Deposit paid in advance ฿3,000");
  assert.equal(textOf(html, "row-till-payment-1"), "Cash ฿14,025");
  assert.equal(textOf(html, "row-till-line-6"), "ZZ TEST bubble tea ฿125");
  assert.equal(textOf(html, "button-quote-pdf"), null);
});

check("From the till, without the till or a quote: the reason, and no figure at all", () => {
  const down = render(React.createElement(TillBillingPanel, { eventId: randomUUID(), reading: DOWN }));
  assert.match(textOf(down, "text-till-unavailable")!, /^Till not reachable The till did not answer/);
  assert.ok(!down.includes("฿"), "no number of the app's own");
  const none = render(React.createElement(TillBillingPanel, { eventId: randomUUID(), reading: NO_QUOTE }));
  assert.equal(textOf(none, "text-till-unavailable"), "No quote from the till This party has no package in the OTO App, so it cannot be settled here");
  assert.ok(!none.includes("฿"));
});

check("the Party Details box: Total and Outstanding from the till, the deposit the BEO's own between them, an unsaved deposit said", () => {
  const deposit = React.createElement("span", { "data-testid": "deposit-slot" }, "3000");
  const html = render(React.createElement(PartyDetailsTillTiles, { reading: QUOTE, deposit }));
  assert.equal(textOf(html, "text-package-total"), "฿17,025");
  assert.equal(textOf(html, "text-outstanding-balance"), "฿14,025");
  assert.equal(textOf(html, "deposit-slot"), "3000");
  assert.equal(textOf(html, "text-deposit-unsaved"), null);
  const unsaved = render(React.createElement(PartyDetailsTillTiles, { reading: QUOTE, deposit, depositUnsaved: true }));
  assert.match(textOf(unsaved, "text-deposit-unsaved")!, /^Save the BEO to send the new deposit to the till/);
  const down = render(React.createElement(PartyDetailsTillTiles, { reading: DOWN, deposit }));
  assert.equal(textOf(down, "text-package-total"), "Till not reachable");
  assert.equal(textOf(down, "text-outstanding-balance"), "Till not reachable");
  assert.ok(!down.includes("฿"));
});

check("the money rows Party Details and the Day-of view share: the same three figures as the Billing section", () => {
  const html = render(React.createElement(TillMoneyRows, { reading: QUOTE }));
  assert.equal(textOf(html, "text-till-expected"), "฿17,025");
  assert.equal(textOf(html, "text-till-deposit"), "฿3,000");
  assert.equal(textOf(html, "text-till-outstanding"), "฿14,025");
  const sale = render(React.createElement(TillMoneyRows, { reading: SALE }));
  assert.equal(textOf(sale, "text-till-expected"), "฿17,025");
  assert.equal(textOf(sale, "text-till-outstanding"), "฿0");
});

/**
 * SCRUM-833's party, as the BEO holds it: the package snapshot's base price in
 * SATANG (1,690,000 for ฿16,900), a billing row with no package price, no
 * invoice rows, Party Details naming the package and its deposit.
 */
const day833 = (reading: Reading | undefined) =>
  render(
    React.createElement(DayOfPosSection, {
      packageName: "ZZ TEST Floresta Birthday",
      partyDetails: {
        packageName: "ZZ TEST Floresta Birthday",
        prepaymentReceived: 3000,
        depositDate: "2026-11-01",
        items: [{ id: "i1", description: "Kids' table", type: "included", price: 0, notes: "" }],
      },
      posOrderRef: null,
      hasPosData: true,
      reading,
      expanded: true,
      onToggle: () => {},
    }),
  );

check("SCRUM-833 — the Day-of POS section of a ฿16,900 package reads ฿16,900 from the till, never the snapshot's 1,690,000 as baht", () => {
  const html = day833(QUOTE);
  assert.equal(textOf(html, "text-pos-price"), "฿17,025", "the header: what the party comes to");
  assert.equal(textOf(html, "text-pos-package-price"), "฿16,900", "the package: its day price");
  assert.equal(textOf(html, "text-till-expected"), "฿17,025");
  assert.equal(textOf(html, "text-till-deposit"), "฿3,000");
  assert.equal(textOf(html, "text-till-outstanding"), "฿14,025");
  assert.match(textOf(html, "text-pos-money")!, /Deposit paid on 2026-11-01$/);
  assert.ok(!html.includes("1,690,000"), "no satang shown as baht");
  assert.ok(!html.includes("฿1,690"), "no satang shown as baht");
});

check("the Day-of POS section once settled: the sale's receipt and figures; without the till: 'till not reachable', never a number", () => {
  const sale = day833(SALE);
  assert.equal(textOf(sale, "text-pos-price"), "฿17,025");
  assert.match(textOf(sale, "list-pos-till-lines")!, /^The till's sale · receipt T1-000822/);
  assert.equal(textOf(sale, "text-till-outstanding"), "฿0");
  const down = day833(DOWN);
  assert.equal(textOf(down, "text-pos-till-unreachable"), "till not reachable");
  assert.match(textOf(down, "text-till-unavailable")!, /^Till not reachable /);
  assert.ok(!down.includes("฿"), "no figure of the app's own, the snapshot's least of all");
  assert.equal(textOf(down, "badge-pos-package"), "ZZ TEST Floresta Birthday", "the package is still named");
  const empty = render(
    React.createElement(DayOfPosSection, {
      packageName: null, partyDetails: null, posOrderRef: null, hasPosData: false, reading: DOWN, expanded: true, onToggle: () => {},
    }),
  );
  assert.equal(empty, "", "nothing for the POS and nothing from the till: no section");
});

console.log(`till-billing-ui.check: ${checks} checks passed`);
process.exit(checks === 7 ? 0 : 1);
