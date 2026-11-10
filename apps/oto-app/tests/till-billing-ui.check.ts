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
//     no figure of its own;
//   - the billing module's Deposit Paid (the party's one deposit, which the
//     till reads) is sent ONCE: typing 3000 is one write with 3000, never one
//     per keystroke; an emptied field is never sent as 0, so clearing and
//     retyping keeps the deposit's day; the party's writes share one queue.
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
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

await check("From the till, before the party: Expected ฿17,025, Deposit ฿3,000, Outstanding ฿14,025, every line, and the Quote PDF", () => {
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

await check("From the till, after the party: the receipt and its till, the sale's lines, the deposit and the cash, nothing outstanding, no Quote PDF", () => {
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

await check("From the till, without the till or a quote: the reason, and no figure at all", () => {
  const down = render(React.createElement(TillBillingPanel, { eventId: randomUUID(), reading: DOWN }));
  assert.match(textOf(down, "text-till-unavailable")!, /^Till not reachable The till did not answer/);
  assert.ok(!down.includes("฿"), "no number of the app's own");
  const none = render(React.createElement(TillBillingPanel, { eventId: randomUUID(), reading: NO_QUOTE }));
  assert.equal(textOf(none, "text-till-unavailable"), "No quote from the till This party has no package in the OTO App, so it cannot be settled here");
  assert.ok(!none.includes("฿"));
});

await check("the Party Details box: Total and Outstanding from the till, the deposit the BEO's own between them, an unsaved deposit said", () => {
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

await check("the money rows Party Details and the Day-of view share: the same three figures as the Billing section", () => {
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

await check("SCRUM-833 — the Day-of POS section of a ฿16,900 package reads ฿16,900 from the till, never the snapshot's 1,690,000 as baht", () => {
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

await check("the Day-of POS section once settled: the sale's receipt and figures; without the till: 'till not reachable', never a number", () => {
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

// ─── The billing module's deposit, sent once (lib/beo-deposit-buffer.ts) ─────
//
// The module calls onBillingChange on every keystroke of Deposit Paid; the
// Billing section holds the keystrokes and sends ONE write. Driven here with
// timers of the check's own, so "a pause in typing" is a call.

const { DepositBuffer, DEPOSIT_IDLE_MS, beoBillingMutationScope } = await import("../client/src/lib/beo-deposit-buffer");
type Patch = import("../client/src/lib/beo-deposit-buffer").BillingPatch;

function typing(saved: number) {
  const sent: Patch[] = [];
  const armed = new Map<number, () => void>();
  let next = 0;
  let pause = 0;
  const buffer = new DepositBuffer({
    send: (patch) => {
      sent.push(patch);
    },
    saved: () => saved,
    timers: {
      set: (fn, ms) => {
        pause = ms;
        armed.set(++next, fn);
        return next;
      },
      clear: (handle) => {
        armed.delete(handle as number);
      },
    },
  });
  /** The pause in typing runs out. */
  const idle = () => {
    const due = [...armed.values()];
    armed.clear();
    for (const fn of due) fn();
  };
  /** Each keystroke as the field reads it: a figure, or "" for an emptied field. */
  const keys = (...fields: string[]) => {
    for (const field of fields) buffer.type(field.trim() === "" ? null : parseInt(field, 10) || 0);
  };
  return { buffer, sent, idle, keys, armed: () => armed.size, pause: () => pause };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

await check("typing 3000 over a ฿30 deposit sends exactly one write, with 3000, after the pause — none per keystroke", async () => {
  const t = typing(30);
  t.keys("3", "30", "300", "3000");
  assert.deepEqual(t.sent, [], "nothing goes while the figure is being typed");
  assert.equal(t.buffer.shown(), 3000, "the field shows what is typed");
  assert.equal(t.armed(), 1, "one pause pending, re-armed by each keystroke");
  assert.equal(t.pause(), DEPOSIT_IDLE_MS);
  t.idle();
  assert.deepEqual(t.sent, [{ depositPaidAmount: 3000, depositPaid: true }]);
  assert.equal(t.buffer.shown(), 3000, "shown until the server has answered");
  await settle();
  assert.equal(t.buffer.shown(), undefined, "then the saved billing shows");
  t.idle();
  assert.equal(t.sent.length, 1, "nothing more");
});

await check("clearing the field and retyping sends one write with the new figure and never the emptied field's 0, so the deposit keeps its day", () => {
  const t = typing(3000);
  t.keys("300", "30", "3", "", "5", "50", "500", "5000");
  t.buffer.flush();
  assert.deepEqual(t.sent, [{ depositPaidAmount: 5000, depositPaid: true }], "one write, no depositPaidAt named: the server keeps the day");
  assert.ok(!t.sent.some((p) => p.depositPaidAmount === 0), "no 0 ever sent");
});

await check("an emptied field sends nothing — not after a pause, not on blur — and goes back to the saved figure; a deposit is cleared by typing 0", async () => {
  const t = typing(3000);
  t.keys("300", "30", "3", "");
  assert.equal(t.buffer.shown(), 0);
  t.idle();
  assert.deepEqual(t.sent, [], "a pause on an emptied field is a field being retyped");
  assert.equal(t.buffer.shown(), 0, "still being retyped");
  t.buffer.flush();
  assert.deepEqual(t.sent, [], "left empty, nothing is sent");
  assert.equal(t.buffer.shown(), undefined, "the field shows the saved ฿3,000 again");
  t.keys("0");
  t.buffer.flush();
  assert.deepEqual(t.sent, [{ depositPaidAmount: 0, depositPaid: false }], "a typed 0 clears the deposit");
  await settle();
});

await check("Enter or blur sends at once and the pause after sends nothing more; the saved figure retyped sends nothing; the day picked carries a pending figure; a closing section keeps what was typed", () => {
  const enter = typing(30);
  enter.keys("3", "30", "300");
  enter.buffer.flush();
  assert.deepEqual(enter.sent, [{ depositPaidAmount: 300, depositPaid: true }]);
  assert.equal(enter.armed(), 0);
  enter.idle();
  assert.equal(enter.sent.length, 1);

  const same = typing(3000);
  same.keys("300", "3000");
  same.idle();
  assert.deepEqual(same.sent, [], "the figure the field already held");

  const day = typing(0);
  day.keys("2", "20", "200", "2000");
  day.buffer.pass({ depositPaidAt: "2026-11-01T00:00:00.000Z" } as Patch);
  assert.deepEqual(day.sent, [{ depositPaidAmount: 2000, depositPaid: true, depositPaidAt: "2026-11-01T00:00:00.000Z" }], "one write");
  day.buffer.pass({ depositPaidAt: null } as Patch);
  assert.deepEqual(day.sent.at(-1), { depositPaidAt: null }, "the day alone, at once");

  const gone = typing(0);
  gone.keys("1", "15", "150");
  gone.buffer.dispose();
  assert.deepEqual(gone.sent, [{ depositPaidAmount: 150, depositPaid: true }]);
  assert.equal(gone.armed(), 0);
});

await check("the party's billing writes share one queue: one scope per party", () => {
  assert.deepEqual(beoBillingMutationScope("e1"), { id: "beo-billing-e1" });
  assert.notDeepEqual(beoBillingMutationScope("e1"), beoBillingMutationScope("e2"));
});

console.log(`till-billing-ui.check: ${checks} checks passed`);
process.exit(checks === 12 ? 0 : 1);
