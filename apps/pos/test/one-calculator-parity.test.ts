import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ParityCatalogue, ReportingDataset } from './support/parityCases';

/**
 * ONE CALCULATOR — SCRUM-271, plan `docs/progress/plans/offline/PLAN.md`
 * Round 2: "prototype-figure parity per surface".
 *
 * The till used to keep two calculators: the platform's satang engine behind
 * `lib/cartWire.ts`, and the prototype's baht-float one (`lib/tax.ts` with
 * `computeTotals`, `computeFnbTotals`, `computeMerchTotals` and the F&B and shop
 * line prices) that thirty-odd screens and every report read. The older one is
 * deleted. Immediately before it was, every cart below was priced by it and its
 * figures recorded (`fixtures/one-calculator-parity.json`, whose `about` says
 * how); this suite prices the same carts through the one calculator that is
 * left, as each surface now calls it, and holds it to those figures.
 *
 * THE SURFACES, and the function each now reads:
 *   - the ticket till's panel, the customer display, the confirmation, the
 *     phone till, the party ticket tab, the booking page, an event pass, a
 *     drop-off child, a history record — `ticketTotals`;
 *   - the F&B and shop counters, their carts and displays, the party F&B tab —
 *     `fnbLineTotal`, `merchLineTotal`, `itemOrderTotals`;
 *   - every tax row under a subtotal — `taxRowsOf`; the "each" figure on the
 *     F&B display — `perUnitBaht`; Admin → Tax's live example;
 *   - the manager's reports, now summed in satang — `lib/reporting.ts`.
 *
 * WHAT "THE SAME" MEANS, stated per class so nothing is loosened silently:
 *   - EXACT, to the satang, unless the case says otherwise;
 *   - ROUNDING (`differs: 'rounding'`): a staff percent discount the prototype
 *     rounded to the whole baht and the engine to the satang (up to ฿0.50 per
 *     discount), and tax or service the prototype carried as an unrounded float
 *     and the engine rounds per category (under a satang per category);
 *   - THE TWO RULINGS `packages/shared/src/cart-totals.ts` records, which move
 *     a total by more than rounding and are pinned figure for figure, with the
 *     owner's question in `docs/progress/OPEN_QUESTIONS.md`.
 */

const fixture = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'one-calculator-parity.json'), 'utf8'),
);
const catalogue: ParityCatalogue = fixture.catalogue;

const holder = vi.hoisted(() => ({
  catalogue: null as null | ParityCatalogue,
  dataset: null as null | ReportingDataset,
}));
holder.catalogue = catalogue;

// The catalogue the figures were taken against, handed back to the store.
vi.mock('@/store/catalogStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/catalogStore')>();
  const pick =
    <K extends keyof ParityCatalogue>(key: K, fallback: () => ParityCatalogue[K]) =>
    () =>
      holder.catalogue ? holder.catalogue[key] : fallback();
  return {
    ...actual,
    getTicketTypes: pick('ticketTypes', actual.getTicketTypes),
    getAddOns: pick('addOns', actual.getAddOns),
    getMenuItems: pick('menuItems', actual.getMenuItems),
    getMenuCategories: pick('menuCategories', actual.getMenuCategories),
    getModifierGroups: pick('modifierGroups', actual.getModifierGroups),
    getMerchItems: pick('merchItems', actual.getMerchItems),
    getTaxConfig: pick('taxConfig', actual.getTaxConfig),
    getDiscounts: pick('discounts', actual.getDiscounts),
    getPricingOverrides: pick('pricingOverrides', actual.getPricingOverrides),
  };
});

// The month of records the reports read, in place of the mock seed.
vi.mock('@/mockApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/mockApi')>();
  return {
    ...actual,
    getAllSalesForReporting: () => holder.dataset?.sales ?? [],
    getAllFnbOrdersForReporting: () => holder.dataset?.fnbOrders ?? [],
    getAllMerchOrdersForReporting: () => holder.dataset?.merchOrders ?? [],
    getAllEventsForReporting: () => holder.dataset?.events ?? [],
    getMockWristbands: () => holder.dataset?.wristbands ?? [],
    getInventory: () => holder.dataset?.inventory ?? [],
  };
});

const {
  fnbCases,
  fnbLines,
  merchCases,
  merchLines,
  PER_UNIT_CASES,
  previewConfig,
  REPORT_FILTERS,
  reportingDataset,
  taxConfigNamed,
  taxPreviewCases,
  ticketCases,
  withMerchCosts,
  withUsage,
} = await import('./support/parityCases');
const { computeLineTotal } = await import('@/lib/pricing');
const {
  breakdownToBaht,
  engineTaxConfig,
  fnbLineTotal,
  itemOrderTotals,
  merchLineTotal,
  perUnitBaht,
  taxRowsOf,
  ticketTotals,
  toSatang,
} = await import('@/lib/cartWire');
const { computeTaxBreakdown } = await import('@oto/shared');
const { branchTradingDate, setBranchRateMode } = await import('@/lib/pricingMode');
const reporting = await import('@/lib/reporting');

type Mode = 'weekday' | 'weekend';
const setMode = (mode: Mode) =>
  setBranchRateMode({ mode, reason: `${mode} (parity)`, date: branchTradingDate() });

const hooks = {
  ticketLine: (base: Parameters<typeof computeLineTotal>[0], mode: Mode) => {
    setMode(mode);
    return computeLineTotal(base, mode);
  },
  fnbLine: fnbLineTotal,
  merchLine: merchLineTotal,
} as import('./support/parityCases').PricingHooks;

/** What the prototype recorded for one cart, in baht, unrounded. */
interface Recorded {
  lineTotals: Record<string, number>;
  subtotal: number;
  promoDiscount: number;
  manualDiscount: number;
  manualAmounts: Record<string, number>;
  promos: { code: string; amount: number }[];
  serviceCharge: number;
  taxTotal: number;
  total: number;
  categories: { category: string; base: number; tax: number; secondaryTax: number; serviceCharge: number; gross: number }[];
  taxRows: { key: string; label: string; amount: number; shown: number }[];
}

/** The engine's figures for one cart, in satang, as a surface now reads them. */
interface Priced {
  subtotal: number;
  promoDiscount: number;
  manualDiscount: number;
  manualAmounts: Record<string, number>;
  promos: { code: string; amount: number }[];
  serviceCharge: number;
  total: number;
  taxRows: { key: string; label: string; amount: number }[];
}

function pricedOf(totals: ReturnType<typeof ticketTotals> | ReturnType<typeof itemOrderTotals>): Priced {
  return {
    subtotal: totals.satang.subtotal,
    promoDiscount: totals.satang.promoDiscountTotal,
    manualDiscount: totals.satang.manualDiscountTotal,
    manualAmounts: totals.satang.manualAmounts,
    promos: totals.satang.appliedPromos.map((p) => ({ code: p.code, amount: p.amount })),
    serviceCharge: totals.satang.serviceChargeTotal,
    total: totals.satang.total,
    // The rows every screen prints, through the display edge — back to satang
    // to compare: each is a whole number of satang over 100 by construction.
    taxRows: taxRowsOf(totals.taxBreakdown).map((r) => ({ key: r.key, label: r.label, amount: toSatang(r.amount) })),
  };
}

/**
 * How far the engine's figure may sit from the prototype's, and why.
 *
 *   `percentDiscounts` — a staff percent discount the prototype rounded to the
 *   whole baht and the engine to the satang: up to 50 satang each, and it
 *   carries into the total. Only a `rounding` case has any.
 *   `categories` — a service charge or added tax the prototype carried as an
 *   unrounded float into the TOTAL and the engine rounds per category: under a
 *   satang each. Only a `rounding` case has any; every other total is exact.
 *   `taxRowSlack` — a TAX ROW, on every case: the prototype added the
 *   categories' tax as floats and rounded the row once (`roundTHB`); the engine
 *   rounds each category to the satang — the figure the ledger stores, and the
 *   one the till has shown whenever the platform or its engine priced the
 *   cart — and adds those. Summing n rounded figures sits within n − 1 satang
 *   of rounding their sum once (a single category: exactly). That is the whole
 *   of the difference on a cart of tickets and socks: "VAT included ฿172.05"
 *   where the prototype's fallback said ฿172.06.
 */
interface Slack {
  percentDiscounts: number;
  categories: number;
  taxRowSlack: number;
}

/** The prototype's figure and the engine's, compared as the class allows. */
function expectParity(recorded: Recorded, priced: Priced, slack: Slack): void {
  const money = 50 * slack.percentDiscounts;
  const near = (engine: number, prototype: number, allowed: number, what: string) =>
    expect(Math.abs(engine - toSatang(prototype)), `${what}: engine ${engine}, prototype ${toSatang(prototype)}`).toBeLessThanOrEqual(allowed);

  expect(priced.subtotal, 'subtotal').toBe(toSatang(recorded.subtotal));
  near(priced.manualDiscount, recorded.manualDiscount, money, 'staff discounts');
  for (const [id, amount] of Object.entries(recorded.manualAmounts)) {
    near(priced.manualAmounts[id] ?? 0, amount, money, `staff discount ${id}`);
  }
  near(priced.promoDiscount, recorded.promoDiscount, money, 'codes');
  expect(priced.promos.map((p) => p.code)).toEqual(recorded.promos.map((p) => p.code));
  recorded.promos.forEach((p, index) => near(priced.promos[index]?.amount ?? 0, p.amount, money, `code ${p.code}`));
  near(priced.serviceCharge, recorded.serviceCharge, slack.categories, 'service charge');
  near(priced.total, recorded.total, money + slack.categories, 'total');
  expect(priced.taxRows.map((r) => [r.key, r.label])).toEqual(recorded.taxRows.map((r) => [r.key, r.label]));
  recorded.taxRows.forEach((row, index) =>
    // What the screen printed then — `roundTHB` of the float — against the row
    // now. A percent discount that rounded differently moved the base the tax
    // is on, by at most its own 50 satang, so the tax by less than that.
    near(priced.taxRows[index]?.amount ?? 0, row.shown, slack.taxRowSlack + slack.categories + money, `tax row ${row.key}`),
  );
}

/** How loose one case may be: see `Slack`. */
function slackOf(differs: string | undefined, percentDiscounts: number, categories: number): Slack {
  const taxRowSlack = Math.max(0, categories - 1);
  if (differs !== 'rounding') return { percentDiscounts: 0, categories: 0, taxRowSlack };
  return { percentDiscounts, categories, taxRowSlack };
}

describe('ticket carts — the till, the displays, parties, booking, events, drop-off and history', () => {
  const cases = ticketCases(catalogue, hooks);

  it('covers every surface the prototype priced a ticket cart on', () => {
    expect(new Set(cases.map((c) => c.surface))).toEqual(new Set(['ticket', 'event', 'dropoff', 'history']));
    expect(cases.length).toBe(Object.keys(fixture.ticket).length);
  });

  it.each(cases.filter((c) => !c.differs?.startsWith('ruling')).map((c) => [c.id, c] as const))(
    '%s prices as the prototype did',
    (_id, c) => {
      const recorded: Recorded = fixture.ticket[c.id];
      setMode(c.mode);
      expect(Object.fromEntries(c.lines.map((l) => [l.id, l.lineTotal])), 'line totals').toEqual(recorded.lineTotals);
      const totals = ticketTotals(c.lines, c.discounts, c.manual, {
        mode: c.mode,
        config: taxConfigNamed(c.config, catalogue.taxConfig),
      });
      const percents = c.manual.filter((m) => m.type === 'percent').length;
      expectParity(recorded, pricedOf(totals), slackOf(c.differs, percents, recorded.categories.length));
    },
  );

  it('re-derives a cart the engine will not price exactly as the prototype showed it, and says so', () => {
    // A drop-off child with no play length, a sale read on the other rate mode,
    // the seed's drop-off service sale: `ticketTotals` names the lines it
    // re-derived rather than priced, so a screen can tell.
    for (const id of ['D-unpriced', 'H-sold-weekday-read-weekend', 'H-seeded-dropoff-service-sale']) {
      const c = cases.find((x) => x.id === id)!;
      setMode(c.mode);
      const totals = ticketTotals(c.lines, c.discounts, c.manual, { mode: c.mode });
      expect(totals.staleLineIds.length, id).toBeGreaterThan(0);
      expect(totals.satang.total, id).toBe(toSatang(fixture.ticket[id].total));
    }
    // …and a cart it prices names none.
    const priced = cases.find((x) => x.id === 'T-two-lines')!;
    setMode('weekday');
    expect(ticketTotals(priced.lines, [], [], { mode: 'weekday' }).staleLineIds).toEqual([]);
  });

  /**
   * THE TWO RULINGS, pinned figure for figure. Each moves a guest's bill by
   * more than rounding, so neither is a parity failure to be tolerated: each is
   * the engine's recorded rule (`cart-totals.ts`, OPEN_QUESTIONS.md §3c and the
   * SCRUM-271 entry), and the prototype's figure is kept beside it so the
   * difference stays on the page.
   */
  it('ruling 1 — the free item goes on at ฿0: the prototype gave the ฿50 cone away twice', () => {
    const recorded: Recorded = fixture.ticket['T-ruling-1-free-item'];
    const c = cases.find((x) => x.id === 'T-ruling-1-free-item')!;
    setMode('weekday');
    const totals = ticketTotals(c.lines, c.discounts, c.manual, { mode: 'weekday' });
    expect(toSatang(recorded.subtotal)).toBe(218_000);
    expect(totals.satang.subtotal).toBe(218_000);
    expect(toSatang(recorded.promoDiscount)).toBe(5_000);
    expect(totals.satang.promoDiscountTotal).toBe(5_000);
    // The prototype took the cone off the tickets as well as off the shelf.
    expect(toSatang(recorded.total)).toBe(208_000);
    expect(totals.satang.total).toBe(213_000);
    // …and books the markdown against F&B, where the cone was given away.
    expect(totals.satang.taxBreakdown.categories.map((cat) => [cat.category, cat.base])).toEqual([
      ['tickets', 213_000],
      ['fnb', 0],
    ]);
  });

  it('ruling 2 — a scoped code spends only what its scope has left: the prototype let ฿1,000 of lockers go free', () => {
    const comped: Recorded = fixture.ticket['T-ruling-2-comped-kids-then-tickets-code'];
    const c = cases.find((x) => x.id === 'T-ruling-2-comped-kids-then-tickets-code')!;
    setMode('weekday');
    const totals = ticketTotals(c.lines, c.discounts, c.manual, { mode: 'weekday' });
    expect(toSatang(comped.total)).toBe(0);
    expect(totals.satang.total).toBe(100_000);
    expect(totals.satang.appliedPromos[0]).toMatchObject({ code: 'TICKETS100', amount: 0 });
    expect(totals.satang.appliedPromos[0]?.exhaustedReason).toBeTruthy();
  });

  it('ruling 2 — two ticket codes take no more than the tickets: the prototype let ฿300 of socks and lockers go free', () => {
    const stacked: Recorded = fixture.ticket['T-ruling-2-two-tickets-codes'];
    const c = cases.find((x) => x.id === 'T-ruling-2-two-tickets-codes')!;
    setMode('weekday');
    const totals = ticketTotals(c.lines, c.discounts, c.manual, { mode: 'weekday' });
    expect(toSatang(stacked.total)).toBe(0);
    expect(toSatang(stacked.promoDiscount)).toBe(297_000);
    expect(totals.satang.promoDiscountTotal).toBe(267_000);
    expect(totals.satang.total).toBe(30_000);
    expect(totals.satang.appliedPromos.map((p) => [p.code, p.amount])).toEqual([
      ['KIDS23', 61_410],
      ['TICKETSFREE', 205_590],
    ]);
  });
});

describe('F&B orders — the counter, its cart and display, the phone station, the party tab', () => {
  it.each(fnbCases().map((c) => [c.id, c] as const))('%s prices as the prototype did', (_id, c) => {
    const recorded: Recorded = fixture.fnb[c.id];
    setMode(c.mode);
    const lines = fnbLines(catalogue, hooks, c);
    // The row's own price: the shared item engine, where the prototype's
    // `computeLineTotal` (lib/fnb.ts) was.
    expect(Object.fromEntries(lines.map((l) => [l.id, l.lineTotal])), 'line totals').toEqual(recorded.lineTotals);
    const totals = itemOrderTotals(lines, c.manual, {
      promos: c.promos,
      mode: c.mode,
      config: taxConfigNamed(c.config, catalogue.taxConfig),
    });
    const percents = c.manual.filter((m) => m.type === 'percent').length;
    expectParity(recorded, pricedOf(totals), slackOf(c.differs, percents, recorded.categories.length));
  });
});

describe('shop orders — the counter, its cart and displays', () => {
  it.each(merchCases().map((c) => [c.id, c] as const))('%s prices as the prototype did', (_id, c) => {
    const recorded: Recorded = fixture.shop[c.id];
    setMode(c.mode);
    const lines = merchLines(catalogue, hooks, c);
    expect(Object.fromEntries(lines.map((l) => [l.id, l.lineTotal])), 'line totals').toEqual(recorded.lineTotals);
    const totals = itemOrderTotals(lines, c.manual, {
      promos: c.promos,
      mode: c.mode,
      config: taxConfigNamed(c.config, catalogue.taxConfig),
    });
    const percents = c.manual.filter((m) => m.type === 'percent').length;
    expectParity(recorded, pricedOf(totals), slackOf(c.differs, percents, recorded.categories.length));
  });
});

describe('the display edge', () => {
  it("prints Admin → Tax's live example exactly as it did", () => {
    const fmt = (n: number) => `฿${n.toFixed(2)}`;
    for (const c of taxPreviewCases()) {
      // As TaxPanel builds it: a ฿100 base under the draft, through the engine.
      const bd = breakdownToBaht(
        computeTaxBreakdown([{ category: c.category, base: toSatang(100) }], 0, engineTaxConfig(previewConfig(c, catalogue.taxConfig))),
      );
      const cat = bd.categories[0]!;
      expect(
        { serviceCharge: fmt(cat.serviceCharge), tax: fmt(cat.tax), secondaryTax: fmt(cat.secondaryTax), gross: fmt(cat.gross) },
        c.id,
      ).toEqual(fixture.taxPreview[c.id]);
    }
  });

  it('prints the F&B display\'s "each" figure exactly as it did', () => {
    for (const [lineTotal, qty, shown] of fixture.perUnit as [number, number, number][]) {
      expect(perUnitBaht(lineTotal, qty), `${lineTotal} / ${qty}`).toBe(shown);
    }
    expect(fixture.perUnit).toHaveLength(PER_UNIT_CASES.length);
  });
});

describe("the manager's reports — summed in satang, formatted only at the edge", () => {
  setMode('weekday');
  holder.dataset = reportingDataset(catalogue, hooks);
  holder.catalogue = { ...catalogue, merchItems: withMerchCosts(catalogue), discounts: withUsage(catalogue) };
  const f = REPORT_FILTERS;
  const was = fixture.reports;

  /**
   * One report, row for row: the same rows in the same order, each money field
   * the prototype's baht now in satang under its new name. `slack(row)` is the
   * satang a field may differ by — a tax or a spread-out discount the
   * prototype summed as floats and the engine rounds per transaction and
   * category, under one satang each — and 0 for everything summed from stored
   * figures.
   */
  function sameRows<T extends object>(
    name: string,
    now: T[],
    key: (row: Record<string, unknown>) => string,
    fields: [oldField: string, newField: keyof T & string, slack?: (row: T) => number][],
  ) {
    const before = was[name] as Record<string, unknown>[];
    expect(now.map((row) => key(row as Record<string, unknown>)), `${name}: rows`).toEqual(before.map(key));
    now.forEach((row, index) => {
      const old = before[index]!;
      for (const [oldField, newField, slack] of fields) {
        const engine = row[newField] as unknown as number;
        const prototype = toSatang(old[oldField] as number);
        expect(Math.abs(engine - prototype), `${name}[${key(old)}].${newField}: engine ${engine}, prototype ${prototype}`).toBeLessThanOrEqual(
          slack ? slack(row) : 0,
        );
      }
    });
  }

  setMode('weekday');

  it('revenue by category', () => {
    const rows = reporting.salesByCategory(f);
    sameRows('salesByCategory', rows, (r) => String(r.category), [
      ['grossRevenue', 'grossRevenueSatang', (r) => r.count],
      ['taxCollected', 'taxCollectedSatang', (r) => r.count],
      ['serviceCharge', 'serviceChargeSatang'],
    ]);
    rows.forEach((row, index) => expect(row.pctShare).toBeCloseTo(was.salesByCategory[index].pctShare, 3));
  });

  it('payment mix, tiers, items, ticket types, rate modes, events and drop-off', () => {
    sameRows('paymentMix', reporting.paymentMix(f), (r) => String(r.method), [['amount', 'amountSatang']]);
    sameRows('ticketSalesByTier', reporting.ticketSalesByTier(f), (r) => String(r.tier), [
      ['ticketRevenue', 'ticketRevenueSatang', (r) => r.saleCount],
      ['dropOffRevenue', 'dropOffRevenueSatang', (r) => r.saleCount],
    ]);
    sameRows('fnbSalesByItem', reporting.fnbSalesByItem(f), (r) => String(r.itemId), [['revenue', 'revenueSatang']]);
    sameRows('merchSalesByItem', reporting.merchSalesByItem(f), (r) => String(r.itemId), [['revenue', 'revenueSatang']]);
    sameRows('ticketTypeSalesRows', reporting.ticketTypeSalesRows(f), (r) => String(r.ticketTypeId), [
      ['revenue', 'revenueSatang'],
    ]);
    sameRows('ticketWeekdayWeekendSplit', reporting.ticketWeekdayWeekendSplit(f), (r) => String(r.mode), [
      ['revenue', 'revenueSatang', (r) => r.saleCount],
    ]);
    sameRows('eventCampRevenueRows', reporting.eventCampRevenueRows(f), (r) => String(r.eventId), [
      ['estimatedRevenue', 'estimatedRevenueSatang'],
    ]);
    sameRows('dropOffNannyRevenueRows', reporting.dropOffNannyRevenueRows(f), (r) => String(r.service), [
      ['feesTHB', 'feesSatang'],
    ]);
  });

  it('profitability', () => {
    for (const name of ['fnbProfitability', 'merchProfitability'] as const) {
      const rows = reporting[name](f);
      sameRows(name, rows, (r) => String(r.itemId), [
        ['revenue', 'revenueSatang'],
        ['cogs', 'cogsSatang'],
        ['margin', 'marginSatang'],
      ]);
      rows.forEach((row, index) => expect(row.marginPercent).toBeCloseTo(was[name][index].marginPercent, 9));
    }
  });

  it('wallet credit and promo usage', () => {
    const summary = reporting.walletCreditSummary(f);
    const before = was.walletCreditSummary;
    expect([
      summary.grantedSatang,
      summary.spentSatang,
      summary.refundedSatang,
      summary.expiredSatang,
      summary.netOutstandingSatang,
      summary.entryCount,
    ]).toEqual([
      toSatang(before.grantedTHB),
      toSatang(before.spentTHB),
      toSatang(before.refundedTHB),
      toSatang(before.expiredTHB),
      toSatang(before.netOutstandingTHB),
      before.entryCount,
    ]);
    sameRows('walletLedgerRows', reporting.walletLedgerRows(f), (r) => `${r.at}/${r.wristbandCode}/${r.kind}`, [
      ['amountTHB', 'amountSatang'],
    ]);
    sameRows('promoUsageSummary', reporting.promoUsageSummary(f), (r) => String(r.code), [
      ['totalDiscountValueTHB', 'totalDiscountValueSatang'],
    ]);
  });

  it('discount, comp and code impact', () => {
    sameRows(
      'discountAndCompImpact',
      reporting.discountAndCompImpact(f),
      (r) => `${r.source}/${r.transactionId}/${r.type}/${r.reason}`,
      [['amountTHB', 'amountSatang']],
    );
    sameRows('promoDiscountImpact', reporting.promoDiscountImpact(f), (r) => `${r.transactionId}/${r.code}`, [
      ['amountTHB', 'amountSatang'],
    ]);
    sameRows('discountImpactByOperator', reporting.discountImpactByOperator(f), (r) => String(r.appliedBy), [
      ['compTotalTHB', 'compTotalSatang'],
      ['discountTotalTHB', 'discountTotalSatang'],
    ]);
    sameRows('promoDiscountImpactByType', reporting.promoDiscountImpactByType(f), (r) => String(r.type), [
      ['amountTHB', 'amountSatang'],
    ]);
  });

  it('tax receipts and the VAT summary', () => {
    const receipts = reporting.taxReceiptRows(f);
    sameRows('taxReceiptRows', receipts, (r) => `${r.kind}/${r.transactionId}`, [
      ['netSubtotal', 'netSubtotalSatang'],
      ['serviceCharge', 'serviceChargeSatang', (r) => r.categories.length],
      ['taxTotal', 'taxTotalSatang', (r) => r.categories.length],
      ['grandTotal', 'grandTotalSatang', (r) => r.categories.length],
    ]);
    // The label column, text for text.
    expect(receipts.map((r) => r.taxSummaryLabel)).toEqual(was.taxReceiptRows.map((r: { taxSummaryLabel: string }) => r.taxSummaryLabel));

    /** How many transactions touched a category in a period: the most a sum can have rounded. */
    const touching = (category: string, period: string | undefined) =>
      receipts.filter((r) => r.categories.includes(category as never) && (!period || r.createdAt.startsWith(period))).length;
    for (const [name, period] of [
      ['vatSummaryRange', 'range'],
      ['vatSummaryDay', 'day'],
      ['vatSummaryMonth', 'month'],
    ] as const) {
      sameRows(name, reporting.vatSummary(f, period), (r) => `${r.period ?? 'range'}/${r.category}`, [
        ['netBase', 'netBaseSatang', (r) => touching(r.category, r.period)],
        ['serviceCharge', 'serviceChargeSatang', (r) => touching(r.category, r.period)],
        ['exclusiveTax', 'exclusiveTaxSatang', (r) => touching(r.category, r.period)],
        ['inclusiveTax', 'inclusiveTaxSatang', (r) => touching(r.category, r.period)],
        ['gross', 'grossSatang', (r) => touching(r.category, r.period)],
      ]);
    }
  });

  it('accumulates in whole satang, never floats', () => {
    const everyMoneyField = [
      ...reporting.salesByCategory(f).flatMap((r) => [r.grossRevenueSatang, r.taxCollectedSatang, r.serviceChargeSatang]),
      ...reporting.vatSummary(f, 'month').flatMap((r) => [r.netBaseSatang, r.inclusiveTaxSatang, r.exclusiveTaxSatang, r.grossSatang]),
      ...reporting.taxReceiptRows(f).flatMap((r) => [r.netSubtotalSatang, r.taxTotalSatang, r.grandTotalSatang]),
      ...reporting.paymentMix(f).map((r) => r.amountSatang),
      ...reporting.fnbProfitability(f).flatMap((r) => [r.revenueSatang, r.cogsSatang, r.marginSatang]),
    ];
    expect(everyMoneyField.length).toBeGreaterThan(40);
    for (const value of everyMoneyField) expect(Number.isInteger(value), String(value)).toBe(true);
  });
});
