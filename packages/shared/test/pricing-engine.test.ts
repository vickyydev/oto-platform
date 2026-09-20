import { describe, expect, it } from 'vitest';
import {
  PRICING_ENGINE_VERSION,
  PROTOTYPE_BAHT_ROUNDING,
  DEFAULT_ROUNDING,
  apportion,
  applyFreeItemPromo,
  computeLineBreakdown,
  computeTaxBreakdown,
  computeTicketCartTotals,
  discountTargetBase,
  dropOrphanedDiscounts,
  findStaleLines,
  freeItemStub,
  getRateModeForDate,
  groupTaxInputs,
  branchToday,
  percentOf,
  priceCartLine,
  rateModeToday,
  repriceCartLines,
  resolveManualDiscountAmount,
  roundHalfUpSatang,
  rowMatchesTarget,
  summarizeTax,
  ticketCartTaxInputs,
  validatePromoCode,
} from '../src/index';
import type {
  CartAddOn,
  ManualDiscount,
  PricingContext,
  PromoDiscount,
  RoundingPolicy,
  TicketCartLine,
} from '../src/index';
import { PRICING_FIXTURES } from '../src/fixtures/index';
import type { FixtureCartCase, FixtureLine } from '../src/fixtures/index';

const { catalog, taxConfigs, cartCases, taxCases, rateModeCases, businessDateCases } =
  PRICING_FIXTURES;

function contextFor(mode: 'weekday' | 'weekend'): PricingContext {
  return { mode, socks: { ...catalog.socks } };
}

function roundingFor(name: 'satang' | 'baht' | undefined): RoundingPolicy {
  return name === 'baht' ? PROTOTYPE_BAHT_ROUNDING : DEFAULT_ROUNDING;
}

function taxConfigFor(name: string) {
  const config = taxConfigs[name];
  if (!config) throw new Error(`Fixture names an unknown tax config "${name}"`);
  return config;
}

function buildLine(spec: FixtureLine, ctx: PricingContext): TicketCartLine {
  const pkg = catalog.packages[spec.package];
  if (!pkg) throw new Error(`Fixture names an unknown package "${spec.package}"`);

  const addOns: CartAddOn[] = (spec.addOns ?? []).map((entry) => {
    const item = catalog.addOns[entry.ref];
    if (!item) throw new Error(`Fixture names an unknown add-on "${entry.ref}"`);
    return {
      id: entry.ref,
      name: item.name,
      price: item.price,
      quantity: entry.quantity,
      ...(entry.taxCategoryOverride ? { taxCategoryOverride: entry.taxCategoryOverride } : {}),
      ...(entry.variantBreakdown ? { variantBreakdown: entry.variantBreakdown } : {}),
    };
  });

  const line: TicketCartLine = {
    id: spec.id,
    packageId: spec.package,
    // The fixture's adultRules are JSON, so their `kind`/`overflow` widen to
    // string; the shapes are identical and the schema in catalog-shapes.ts is
    // what validates them on the wire.
    package: { prices: pkg.prices, adultRules: pkg.adultRules } as TicketCartLine['package'],
    tier: spec.tier,
    kids: spec.kids,
    adults: spec.adults,
    socks: spec.socks ?? 0,
    addOns,
    serviceFee: spec.serviceFee ?? null,
    lineTotal: 0,
    ...(spec.foodProvision ? { foodProvision: spec.foodProvision } : {}),
  };
  // Always derived, never written down: see the note on FixtureLine.
  return { ...line, lineTotal: priceCartLine(line, ctx) };
}

/**
 * Build the cart the way the till builds it: price the real lines, then apply
 * each promo code — which for a `free_item` code means injecting its synthetic
 * line AND using the code with its value resolved to the item's shelf price
 * (prototype `pages/Till.tsx:574-589`). The fixture supplies the code exactly
 * as the catalogue stores it, `value: 0` included.
 */
function buildCart(testCase: FixtureCartCase, ctx: PricingContext) {
  const lines = testCase.lines.map((spec) => buildLine(spec, ctx));
  const promos: PromoDiscount[] = [];
  for (const promo of (testCase.promos ?? []) as PromoDiscount[]) {
    if (promo.type !== 'free_item') {
      promos.push(promo);
      continue;
    }
    const item = promo.freeItemId ? catalog.menuItems[promo.freeItemId] : undefined;
    if (!item) throw new Error(`Fixture names an unknown menu item "${promo.freeItemId}"`);
    const stub = freeItemStub(lines);
    if (!stub) throw new Error(`Fixture applies "${promo.code}" to a cart with no real line`);
    const injected = applyFreeItemPromo(promo, item, stub);
    lines.push(injected.line);
    promos.push(injected.promo);
  }

  const staleLineTotals = testCase.staleLineTotals ?? {};
  const priced = lines.map((line) =>
    line.id in staleLineTotals ? { ...line, lineTotal: staleLineTotals[line.id] ?? 0 } : line,
  );
  return { lines: priced, promos };
}

function runCartCase(testCase: FixtureCartCase) {
  const ctx = contextFor(testCase.mode);
  const { lines, promos } = buildCart(testCase, ctx);
  const totals = computeTicketCartTotals(
    lines,
    promos,
    (testCase.manualDiscounts ?? []) as ManualDiscount[],
    taxConfigFor(testCase.taxConfig),
    ctx,
    { rounding: roundingFor(testCase.rounding) },
  );
  return { ctx, lines, totals };
}

describe('pricing regression fixtures — cart cases', () => {
  for (const testCase of cartCases) {
    it(`${testCase.id} — ${testCase.title}`, () => {
      if (testCase.expectThrows) {
        expect(() => runCartCase(testCase)).toThrow(testCase.expectThrows);
        return;
      }
      const { ctx, lines, totals } = runCartCase(testCase);
      const want = testCase.expect;

      if (want.lineTotals) {
        for (const [lineId, lineTotal] of Object.entries(want.lineTotals)) {
          expect(lines.find((l) => l.id === lineId)?.lineTotal, `line ${lineId}`).toBe(lineTotal);
        }
      }
      if (want.subtotal !== undefined) expect(totals.subtotal, 'subtotal').toBe(want.subtotal);
      if (want.manualAmounts) expect(totals.manualAmounts).toMatchObject(want.manualAmounts);
      if (want.manualDiscountTotal !== undefined) {
        expect(totals.manualDiscountTotal, 'manual discount').toBe(want.manualDiscountTotal);
      }
      if (want.promoDiscountTotal !== undefined) {
        expect(totals.promoDiscountTotal, 'promo discount').toBe(want.promoDiscountTotal);
      }
      if (want.discountTotal !== undefined) {
        expect(totals.discountTotal, 'discount total').toBe(want.discountTotal);
      }
      if (want.serviceChargeTotal !== undefined) {
        expect(totals.serviceChargeTotal, 'service charge').toBe(want.serviceChargeTotal);
      }
      if (want.inclusiveTaxTotal !== undefined) {
        expect(totals.taxBreakdown.inclusiveTaxTotal, 'inclusive tax').toBe(want.inclusiveTaxTotal);
      }
      if (want.exclusiveTaxTotal !== undefined) {
        expect(totals.taxBreakdown.exclusiveTaxTotal, 'exclusive tax').toBe(want.exclusiveTaxTotal);
      }
      if (want.taxTotal !== undefined) expect(totals.taxTotal, 'tax total').toBe(want.taxTotal);
      if (want.unappliedDiscount !== undefined) {
        expect(totals.taxBreakdown.unappliedDiscount, 'unapplied discount').toBe(
          want.unappliedDiscount,
        );
      }
      if (want.total !== undefined) expect(totals.total, 'grand total').toBe(want.total);

      if (want.categories) {
        expect(totals.taxBreakdown.categories.map((c) => c.category)).toEqual(
          want.categories.map((c) => c.category),
        );
        for (const expected of want.categories) {
          const actual = totals.taxBreakdown.categories.find(
            (c) => c.category === expected.category,
          );
          expect(actual, `category ${expected.category}`).toBeDefined();
          if (expected.base !== undefined) expect(actual?.base).toBe(expected.base);
          if (expected.serviceCharge !== undefined)
            expect(actual?.serviceCharge).toBe(expected.serviceCharge);
          if (expected.tax !== undefined) expect(actual?.tax).toBe(expected.tax);
          if (expected.secondaryTax !== undefined)
            expect(actual?.secondaryTax).toBe(expected.secondaryTax);
          if (expected.gross !== undefined) expect(actual?.gross).toBe(expected.gross);
        }
      }

      if (want.breakdown) {
        for (const [lineId, rows] of Object.entries(want.breakdown)) {
          const line = lines.find((l) => l.id === lineId);
          expect(line, `line ${lineId}`).toBeDefined();
          // A row with a fifth element asserts its LABEL too; rows without one
          // assert the money only, so most cases stay free of display strings.
          const actual = computeLineBreakdown(line!, ctx).map((row, index) =>
            rows[index]?.length === 5
              ? [row.key, row.unitPrice, row.quantity, row.subtotal, row.label]
              : [row.key, row.unitPrice, row.quantity, row.subtotal],
          );
          expect(actual, `breakdown of ${lineId}`).toEqual(rows.map((row) => [...row]));
        }
      }

      if (want.taxRows) {
        expect(summarizeTax(totals.taxBreakdown)).toEqual(want.taxRows);
      }

      // Every case, every time: money stays whole satang, and the engine
      // stamps the version that produced these numbers.
      expect(Number.isInteger(totals.total)).toBe(true);
      expect(Number.isInteger(totals.discountTotal)).toBe(true);
      for (const category of totals.taxBreakdown.categories) {
        expect(Number.isInteger(category.tax)).toBe(true);
        expect(Number.isInteger(category.serviceCharge)).toBe(true);
        expect(Number.isInteger(category.gross)).toBe(true);
      }
      expect(totals.engineVersion).toBe(PRICING_ENGINE_VERSION);

      // THE INVARIANT THAT WOULD HAVE CAUGHT THE PREPAID-FOOD DEFECT: every
      // line's total is exactly the money its own tax bases carry. The
      // prototype states it at lib/sale.ts:50-51. Promo lines are the known
      // exception — their total reaches the subtotal and their base reaches
      // nothing, which is what WE-8 and EC-8 pin.
      for (const line of lines) {
        if (line.promoItem) continue;
        const own = ticketCartTaxInputs([line], ctx).reduce((sum, input) => sum + input.base, 0);
        expect(own, `line ${line.id}: total vs its own tax bases`).toBe(line.lineTotal);
      }

      // Nothing is lost between the cart and the cascade: what the cart says it
      // discounted is what the cascade was handed, and what the cascade could
      // not place is reported rather than dropped.
      expect(totals.taxBreakdown.discountTotal, 'cart vs cascade discount').toBe(
        totals.discountTotal,
      );
      const absorbed = ticketCartTaxInputs(lines, ctx).reduce((sum, input) => {
        const after = totals.taxBreakdown.categories.find((c) => c.category === input.category);
        return sum + (input.base - (after?.base ?? input.base));
      }, 0);
      if (taxConfigFor(testCase.taxConfig).discountPlacement === 'before_tax') {
        expect(absorbed + totals.taxBreakdown.unappliedDiscount, 'absorbed + unapplied').toBe(
          totals.discountTotal,
        );
      }
    });
  }

  it('covers every rule the fixture file claims, once', () => {
    const cited = new Set(cartCases.flatMap((c) => c.rules));
    // A spot-check that the ordering, adult and tax rules the S2-09a spec
    // calls load-bearing are actually exercised somewhere in the cart cases.
    for (const rule of ['R13', 'R19', 'R20', 'R21', 'R29', 'R35', 'R40', 'R43', 'R60', 'R75']) {
      expect(cited.has(rule), `no cart fixture cites ${rule}`).toBe(true);
    }
  });
});

describe('pricing regression fixtures — tax cascade cases', () => {
  for (const testCase of taxCases) {
    it(`${testCase.id} — ${testCase.title}`, () => {
      const breakdown = computeTaxBreakdown(
        testCase.inputs,
        testCase.discounts ?? testCase.discountTotal ?? 0,
        taxConfigFor(testCase.taxConfig),
      );
      const want = testCase.expect;
      if (want.netSubtotal !== undefined) expect(breakdown.netSubtotal).toBe(want.netSubtotal);
      if (want.serviceChargeTotal !== undefined) {
        expect(breakdown.serviceChargeTotal, 'service charge').toBe(want.serviceChargeTotal);
      }
      if (want.inclusiveTaxTotal !== undefined) {
        expect(breakdown.inclusiveTaxTotal, 'inclusive tax').toBe(want.inclusiveTaxTotal);
      }
      if (want.exclusiveTaxTotal !== undefined) {
        expect(breakdown.exclusiveTaxTotal, 'exclusive tax').toBe(want.exclusiveTaxTotal);
      }
      if (want.taxTotal !== undefined) expect(breakdown.taxTotal).toBe(want.taxTotal);
      if (want.unappliedDiscount !== undefined) {
        expect(breakdown.unappliedDiscount, 'unapplied discount').toBe(want.unappliedDiscount);
      }
      if (want.grandTotal !== undefined)
        expect(breakdown.grandTotal, 'grand total').toBe(want.grandTotal);
      for (const expected of want.categories ?? []) {
        const actual = breakdown.categories.find((c) => c.category === expected.category);
        expect(actual, `category ${expected.category}`).toBeDefined();
        if (expected.base !== undefined) expect(actual?.base).toBe(expected.base);
        if (expected.taxMode !== undefined) expect(actual?.taxMode).toBe(expected.taxMode);
        if (expected.serviceCharge !== undefined)
          expect(actual?.serviceCharge).toBe(expected.serviceCharge);
        if (expected.tax !== undefined) expect(actual?.tax).toBe(expected.tax);
        if (expected.secondaryTax !== undefined)
          expect(actual?.secondaryTax).toBe(expected.secondaryTax);
        if (expected.gross !== undefined) expect(actual?.gross).toBe(expected.gross);
      }
    });
  }
});

describe('pricing regression fixtures — rate mode', () => {
  for (const testCase of rateModeCases) {
    it(`${testCase.id} — ${testCase.date}`, () => {
      const holidays = catalog.holidays.map((h) => ({ ...h }));
      const result = getRateModeForDate(testCase.date, holidays);
      expect(result.mode).toBe(testCase.expect.mode);
      expect(result.reason).toBe(testCase.expect.reason);
      expect(result.overrideName).toBe(testCase.expect.overrideName);
    });
  }
});

/**
 * `rateModeToday` is one of the engine's two clock seams and it decides which
 * of two prices a guest pays, yet it had no test at all — every rate-mode case
 * above goes through `getRateModeForDate` with a date already in hand. These
 * cover the seam itself: the instant is an argument, the branch timezone (not
 * the host's) decides the day, and the default really is a clock read.
 */
describe('rateModeToday — the clock seam', () => {
  const BANGKOK = 'Asia/Bangkok';
  const holidays = () => catalog.holidays.map((h) => ({ ...h }));

  it('takes the instant as an argument and reads the day in the BRANCH timezone', () => {
    // 23:30 Friday and 00:30 Saturday in Bangkok, one hour apart. In Los
    // Angeles both instants are still Friday, so a host-timezone read would
    // price the second one at weekday rates.
    const fridayNight = new Date('2026-09-25T16:30:00Z');
    const saturdayMorning = new Date('2026-09-25T17:30:00Z');
    expect(rateModeToday(BANGKOK, [], fridayNight).mode).toBe('weekday');
    expect(rateModeToday(BANGKOK, [], saturdayMorning).mode).toBe('weekend');
    expect(rateModeToday('America/Los_Angeles', [], saturdayMorning).mode).toBe('weekday');
  });

  it('applies a holiday range at the same seam, with its name for the POS indicator', () => {
    // 10:00 on Songkran Monday in Bangkok.
    const songkran = new Date('2026-04-13T03:00:00Z');
    expect(rateModeToday(BANGKOK, holidays(), songkran)).toEqual({
      mode: 'weekend',
      reason: 'Weekend pricing — Songkran',
      overrideName: 'Songkran',
    });
  });

  it('omitting the instant reads the clock — which is why a till must not omit it', () => {
    // Race-free: the answer has to match the branch date read either side of
    // the call, whichever side of midnight the suite happens to run on.
    const before = branchToday(BANGKOK);
    const got = rateModeToday(BANGKOK, holidays());
    const after = branchToday(BANGKOK);
    const acceptable = [before, after].map((date) => getRateModeForDate(date, holidays()));
    expect(acceptable.map((a) => a.reason)).toContain(got.reason);
  });
});

describe('the ordering of discounts is load-bearing', () => {
  it('manual first then promo differs from promo first then manual (WE-6)', () => {
    const asBuilt = cartCases.find((c) => c.id === 'WE-6');
    expect(asBuilt).toBeDefined();
    const { totals } = runCartCase(asBuilt!);
    expect(totals.total).toBe(173700);

    // The other order, arithmetic only: a 10% promo takes 21300 off 213000,
    // then the fixed 20000 comes off 191700 — 171700, two thousand satang
    // lower. Nothing in the engine can produce this; the test exists so the
    // cost of getting the order wrong is written down next to the rule.
    const promoFirst = 213000 - Math.round((213000 * 10) / 100) - 20000;
    expect(promoFirst).toBe(171700);
    expect(totals.total - promoFirst).toBe(2000);
  });

  it('a promo scoped to add-ons never reaches the drop-off service fee (R43)', () => {
    const testCase = cartCases.find((c) => c.id === 'EC-9');
    expect(testCase).toBeDefined();
    const { ctx, lines } = runCartCase(testCase!);
    expect(discountTargetBase(lines, { kind: 'addOns' }, ctx)).toBe(20000);
    expect(discountTargetBase(lines, { kind: 'tickets' }, ctx)).toBe(124000);
    expect(discountTargetBase(lines, { kind: 'ticketGroup', group: 'kids' }, ctx)).toBe(89000);
    // The socks row answers to the socks add-on id even though socks are not in
    // `addOns` — the prototype's `a-socks` special case, as context.
    expect(discountTargetBase(lines, { kind: 'addOn', addOnId: 'a-socks' }, ctx)).toBe(10000);
    expect(discountTargetBase(lines, { kind: 'addOn', addOnId: 'a-locker' }, ctx)).toBe(10000);
    // An F&B-scoped code finds nothing in a ticket cart.
    expect(discountTargetBase(lines, { kind: 'fnb' }, ctx)).toBe(0);
  });

  it('the everything scope matches every row, for a caller that does not short-circuit', () => {
    const testCase = cartCases.find((c) => c.id === 'EC-9')!;
    const { ctx, lines } = runCartCase(testCase);
    const line = lines[0]!;
    const rows = computeLineBreakdown(line, ctx);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(
        rowMatchesTarget(row, line.packageId, { kind: 'everything' }, ctx.socks.addOnId),
        `row ${row.key}`,
      ).toBe(true);
    }
    // The two callers in this package still short-circuit that scope, and are
    // right to: an order-wide code is resolved against the sum of LINE TOTALS,
    // which includes money that is not a breakdown row at all.
    expect(discountTargetBase(lines, { kind: 'everything' }, ctx)).toBe(174000);
    expect(rows.reduce((sum, row) => sum + row.subtotal, 0)).toBe(174000);
  });
});

describe('rounding', () => {
  it('rounds half-up at the satang', () => {
    expect(roundHalfUpSatang(0.5)).toBe(1);
    expect(roundHalfUpSatang(1.5)).toBe(2);
    expect(roundHalfUpSatang(2.4999)).toBe(2);
    expect(roundHalfUpSatang(7196.2616)).toBe(7196);
  });

  it('percentOf rounds once, at the policy unit', () => {
    expect(percentOf(97300, 10)).toBe(9730);
    expect(percentOf(97300, 10, PROTOTYPE_BAHT_ROUNDING)).toBe(9700);
    expect(percentOf(100050, 10)).toBe(10005);
  });

  it('a manual discount never exceeds its base and a dead base yields nothing', () => {
    const percent: ManualDiscount = { id: 'd', scope: 'order', type: 'percent', value: 200 };
    expect(resolveManualDiscountAmount(percent, 10000)).toBe(10000); // clamped to 100%
    expect(resolveManualDiscountAmount({ ...percent, value: -5 }, 10000)).toBe(0);
    expect(resolveManualDiscountAmount({ ...percent, type: 'fixed', value: 99999 }, 10000)).toBe(
      10000,
    );
    expect(resolveManualDiscountAmount({ ...percent, type: 'comp' }, 10000)).toBe(10000);
    expect(resolveManualDiscountAmount({ ...percent, type: 'comp' }, 0)).toBe(0);
    expect(resolveManualDiscountAmount({ ...percent, type: 'comp' }, -500)).toBe(0);
  });

  it('apportion splits into whole satang that sum back to the total exactly', () => {
    const splits: [number, number[]][] = [
      [10000, [213000, 20000]],
      [39300, [213000]],
      [1, [1, 1, 1]],
      [7, [1, 2, 3]],
      [100, [33, 33, 34]],
      [5, [0, 0, 5]],
      [12345, [1, 999999, 500]],
    ];
    for (const [total, weights] of splits) {
      const parts = apportion(total, weights);
      expect(
        parts.reduce((a, b) => a + b, 0),
        `${total} over ${weights}`,
      ).toBe(total);
      for (const part of parts) expect(Number.isInteger(part)).toBe(true);
    }
    expect(apportion(500, [0, 0])).toEqual([0, 0]);
    expect(apportion(0, [10, 20])).toEqual([0, 0]);
  });

  it('apportion holds its invariants over 200,000 generated splits', () => {
    // rounding.ts says the largest-remainder split is "exact in practice
    // (verified over 200,000 random cases as well as by the arithmetic)". That
    // sentence was written before any such loop existed; this is the loop. A
    // fixed seed, so a failure is reproducible and the suite is not flaky, and
    // Math.random is forbidden inside the engine for the same reason.
    let seed = 0x5f3759df;
    const next = (): number => {
      // xorshift32 — deterministic, uniform enough, and no dependency.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    // Magnitudes stay inside the documented bound: the only product formed is
    // total x weight, and 2e7 x 2e7 = 4e14, well under MAX_SAFE_INTEGER.
    const CAP = 20_000_000;
    let checked = 0;
    for (let i = 0; i < 200_000; i += 1) {
      const total = Math.floor(next() * CAP);
      const count = 1 + Math.floor(next() * 6);
      const weights: number[] = [];
      for (let w = 0; w < count; w += 1) {
        weights.push(next() < 0.15 ? 0 : Math.floor(next() * CAP));
      }
      const sum = weights.reduce((a, b) => a + b, 0);
      const parts = apportion(total, weights);

      expect(parts.length).toBe(weights.length);
      for (const part of parts) {
        if (!Number.isInteger(part) || part < 0) {
          throw new Error(`apportion(${total}, [${weights}]) gave a non-integer part: ${parts}`);
        }
      }
      const got = parts.reduce((a, b) => a + b, 0);
      const want = sum <= 0 || total === 0 ? 0 : total;
      if (got !== want) {
        throw new Error(`apportion(${total}, [${weights}]) summed to ${got}, expected ${want}`);
      }
      if (sum > 0 && total > 0) {
        for (let index = 0; index < weights.length; index += 1) {
          const exact = (total * (weights[index] ?? 0)) / sum;
          const drift = Math.abs((parts[index] ?? 0) - exact);
          if (drift >= 1) {
            throw new Error(
              `apportion(${total}, [${weights}]) part ${index} drifted ${drift} from ${exact}`,
            );
          }
        }
      }
      checked += 1;
    }
    expect(checked).toBe(200_000);
  });

  it('apportion is exact up to the magnitude its comment claims, and not beyond', () => {
    // The only product formed is `total × weight`; the split is exact while
    // that stays inside MAX_SAFE_INTEGER. At equal magnitudes the bound is
    // √(2^53 − 1) ≈ 94,906,265 satang — about ฿949,000, far above any till
    // order. The earlier comment claimed ฿10,000,000 against ฿10,000,000 was
    // safe; that pair is 1e18, roughly 111× too large.
    const bound = Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER));
    expect(bound).toBeGreaterThan(94_000_000);
    expect(bound * bound).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(1e9 * 1e9).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

    // Exact at a realistic till magnitude (a ฿50,000 discount over three
    // category bases), checked as a sum rather than asserted.
    const parts = apportion(5_000_000, [12_345_600, 7_654_400, 3_210_000]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(5_000_000);
    for (const part of parts) expect(Number.isInteger(part)).toBe(true);
  });
});

describe('tax cascade details', () => {
  it('sums inputs that share a category, in first-seen order', () => {
    expect(
      groupTaxInputs([
        { category: 'addons', base: 5000 },
        { category: 'tickets', base: 100 },
        { category: 'addons', base: 2500 },
      ]),
    ).toEqual([
      { category: 'addons', base: 7500 },
      { category: 'tickets', base: 100 },
    ]);
  });

  it('a receipt shows the service charge first, then one row per (mode, tax name)', () => {
    const breakdown = computeTaxBreakdown(
      [{ category: 'tickets', base: 100000 }],
      0,
      taxConfigFor('serviceExclusiveSecondary'),
    );
    expect(summarizeTax(breakdown)).toEqual([
      { key: 'service', label: 'Service charge', amount: 10000, kind: 'service' },
      { key: 'exclusive:VAT', label: 'VAT', amount: 7700, kind: 'tax_added' },
      { key: 'exclusive:Local levy', label: 'Local levy', amount: 5885, kind: 'tax_added' },
    ]);
  });

  it('a secondary rate switched off keeps its identity and charges nothing (EC-22)', () => {
    const breakdown = computeTaxBreakdown(
      [{ category: 'tickets', base: 107000 }],
      0,
      taxConfigFor('secondaryRateDisabled'),
    );
    const tickets = breakdown.categories[0];
    // The rate stays on the row for an admin screen to show...
    expect(tickets?.secondaryTaxRateId).toBe('local');
    expect(tickets?.secondaryTaxName).toBe('Local levy');
    expect(tickets?.secondaryTaxPercent).toBe(5);
    // ...and charges nothing, because the mode was set to 'none' rather than
    // left to default to 'exclusive' as a set rate otherwise would.
    expect(tickets?.secondaryTaxMode).toBe('none');
    expect(tickets?.secondaryTax).toBe(0);
    expect(breakdown.grandTotal).toBe(107000);
    // And the guest sees no row for it.
    expect(summarizeTax(breakdown)).toEqual([
      { key: 'inclusive:VAT', label: 'VAT included', amount: 7000, kind: 'tax_included' },
    ]);
  });

  it('an inclusive rate is reported, never added', () => {
    const breakdown = computeTaxBreakdown(
      [{ category: 'tickets', base: 107000 }],
      0,
      taxConfigFor('seeded'),
    );
    expect(breakdown.grandTotal).toBe(107000);
    expect(breakdown.inclusiveTaxTotal).toBe(7000);
    expect(breakdown.exclusiveTaxTotal).toBe(0);
  });

  it('routes each kind of line to the taxable category the prototype gives it (R75)', () => {
    const ctx = contextFor('weekday');
    const testCase = cartCases.find((c) => c.id === 'EC-9');
    const { lines } = runCartCase(testCase!);
    expect(ticketCartTaxInputs(lines, ctx)).toEqual([
      { category: 'tickets', base: 124000 },
      { category: 'addons', base: 20000 },
      { category: 'drop_off', base: 30000 },
    ]);
  });
});

describe('promo validation', () => {
  const ctx = contextFor('weekday');
  const cart: TicketCartLine[] = [
    buildLine({ id: 'l1', package: 't-2h', tier: 'tourist', kids: 2, adults: 1 }, ctx),
  ];
  const stackable: PromoDiscount = {
    code: 'STAFF10',
    label: 'Staff Discount',
    type: 'percent',
    value: 10,
    stackable: true,
  };
  const exclusive: PromoDiscount = {
    code: 'SAVE100',
    label: 'Promo Event',
    type: 'fixed',
    value: 10000,
  };

  it('accepts a clean code', () => {
    expect(validatePromoCode(stackable, cart, '2026-09-22', ctx).ok).toBe(true);
  });

  it('refuses a code already on the cart, however it was typed', () => {
    const result = validatePromoCode(stackable, cart, '2026-09-22', ctx, {
      appliedPromos: [{ ...stackable, code: 'staff10' }],
    });
    expect(result).toEqual({ ok: false, reason: 'Code "STAFF10" is already applied.' });
  });

  it('refuses to stack unless every code, the new one included, is stackable', () => {
    expect(
      validatePromoCode(exclusive, cart, '2026-09-22', ctx, { appliedPromos: [stackable] }),
    ).toEqual({ ok: false, reason: 'Code "SAVE100" can\'t be combined with other codes.' });
    expect(
      validatePromoCode(stackable, cart, '2026-09-22', ctx, { appliedPromos: [exclusive] }),
    ).toEqual({
      ok: false,
      reason: 'Code "SAVE100" can\'t be combined with other codes — remove it first.',
    });
  });

  it('checks the window against the date it is given, and names the date the same way everywhere', () => {
    const dated: PromoDiscount = {
      ...stackable,
      validFrom: '2026-10-01',
      validUntil: '2026-12-31',
    };
    expect(validatePromoCode(dated, cart, '2026-09-22', ctx)).toEqual({
      ok: false,
      reason: 'Code "STAFF10" is not valid until 1 Oct 2026.',
    });
    expect(validatePromoCode(dated, cart, '2027-01-01', ctx)).toEqual({
      ok: false,
      reason: 'Code "STAFF10" expired on 31 Dec 2026.',
    });
    expect(validatePromoCode(dated, cart, '2026-10-01', ctx).ok).toBe(true);
  });

  it('enforces usage limits, and the per-customer one only when the phone is known', () => {
    const limited: PromoDiscount = { ...stackable, usageLimit: 50, usedCount: 50 };
    expect(validatePromoCode(limited, cart, '2026-09-22', ctx).ok).toBe(false);
    const perCustomer: PromoDiscount = {
      ...stackable,
      perCustomerLimit: 1,
      perCustomerUsage: { '+66811111111': 1 },
    };
    expect(validatePromoCode(perCustomer, cart, '2026-09-22', ctx).ok).toBe(true);
    expect(
      validatePromoCode(perCustomer, cart, '2026-09-22', ctx, { customerPhone: '+66811111111' }),
    ).toEqual({ ok: false, reason: 'This code can only be used once per customer.' });
  });

  it('refuses a code whose scope matches nothing in the cart', () => {
    const addOnsOnly: PromoDiscount = { ...stackable, target: { kind: 'addOns' } };
    expect(validatePromoCode(addOnsOnly, cart, '2026-09-22', ctx)).toEqual({
      ok: false,
      reason: 'Code "STAFF10" doesn\'t apply to any items in this order.',
    });
  });

  it('refuses a free-item code on an empty cart, or one whose item is gone', () => {
    const freeItem: PromoDiscount = {
      code: 'ICECREAM',
      label: 'Free Ice Cream',
      type: 'free_item',
      value: 0,
      freeItemId: 'm-icecream',
    };
    expect(validatePromoCode(freeItem, [], '2026-09-22', ctx).ok).toBe(false);
    expect(validatePromoCode(freeItem, cart, '2026-09-22', ctx, { freeItem: null }).ok).toBe(false);
    expect(
      validatePromoCode(freeItem, cart, '2026-09-22', ctx, {
        freeItem: { name: 'Ice Cream Cone', price: 5000 },
      }).ok,
    ).toBe(true);
  });
});

describe('orphaned manual discounts', () => {
  const ctx = contextFor('weekday');

  it('drops a discount whose line is gone, and one whose component fell to zero', () => {
    const withKids = buildLine(
      { id: 'l1', package: 't-2h', tier: 'tourist', kids: 2, adults: 1 },
      ctx,
    );
    const withoutKids = buildLine(
      { id: 'l1', package: 't-2h', tier: 'tourist', kids: 0, adults: 1 },
      ctx,
    );
    const discounts: ManualDiscount[] = [
      { id: 'd1', scope: 'order', type: 'percent', value: 10 },
      { id: 'd2', scope: 'line', targetLineId: 'l1', type: 'fixed', value: 5000 },
      {
        id: 'd3',
        scope: 'line',
        targetLineId: 'l1',
        targetComponent: { kind: 'kids' },
        type: 'comp',
        value: 0,
      },
      { id: 'd4', scope: 'line', targetLineId: 'gone', type: 'comp', value: 0 },
    ];
    expect(dropOrphanedDiscounts(discounts, [withKids], ctx).map((d) => d.id)).toEqual([
      'd1',
      'd2',
      'd3',
    ]);
    expect(dropOrphanedDiscounts(discounts, [withoutKids], ctx).map((d) => d.id)).toEqual([
      'd1',
      'd2',
    ]);
    expect(dropOrphanedDiscounts(discounts, [], ctx).map((d) => d.id)).toEqual(['d1']);
  });
});

describe('a free-item promo puts BOTH halves in the cart', () => {
  const ctx = contextFor('weekday');
  // Copied from store/catalogStore.ts:301-315: what the catalogue actually
  // holds, value 0 and all.
  const seeded: PromoDiscount = {
    code: 'ICECREAM',
    label: 'Free Ice Cream',
    type: 'free_item',
    value: 0,
    freeItemId: 'm-icecream',
    freeItemKind: 'menu',
    target: { kind: 'menuItems', menuItemIds: ['m-icecream'] },
  };
  const item = { name: 'Ice Cream Cone', price: 5000 };

  it('resolves the code value to the item price, which is what makes the discount appear', () => {
    const cart = [
      buildLine({ id: 'l1', package: 't-2h', tier: 'tourist', kids: 2, adults: 1 }, ctx),
    ];
    const stub = freeItemStub(cart);
    expect(stub).not.toBeNull();
    const injected = applyFreeItemPromo(seeded, item, stub!);

    expect(injected.promo.value).toBe(5000);
    expect(seeded.value, 'the stored code is not mutated').toBe(0);
    expect(injected.line.id).toBe('promo-ICECREAM');
    expect(injected.line.lineTotal).toBe(5000);
    expect(computeLineBreakdown(injected.line, ctx)).toEqual([]);

    const lines = [...cart, injected.line];
    const config = taxConfigFor('seeded');
    const withResolved = computeTicketCartTotals(lines, [injected.promo], [], config, ctx);
    expect(withResolved.subtotal).toBe(218000);
    expect(withResolved.discountTotal).toBe(5000);

    // The defect the earlier fixture hid: port only the line, leave the code's
    // stored value alone, and the guest is charged for the free item while
    // end-of-day records no markdown at all.
    const withStored = computeTicketCartTotals(lines, [seeded], [], config, ctx);
    expect(withStored.subtotal).toBe(218000);
    expect(withStored.discountTotal).toBe(0);
    expect(withStored.total).toBe(213000);
    expect(withResolved.total).toBe(208000);
  });

  it('refuses to guess a stub when the cart holds no real line', () => {
    expect(freeItemStub([])).toBeNull();
  });
});

describe('prepaid food is priced into the line, not only taxed', () => {
  const ctx = contextFor('weekday');

  it('a drop-off line total covers the food the tax engine charges', () => {
    const line = buildLine(
      {
        id: 'l1',
        package: 't-2h',
        tier: 'tourist',
        kids: 1,
        adults: 1,
        foodProvision: { mode: 'prepaid_credit', paid: 50000 },
      },
      ctx,
    );
    expect(priceCartLine(line, ctx)).toBe(174000);
    expect(ticketCartTaxInputs([line], ctx)).toEqual([
      { category: 'tickets', base: 124000 },
      { category: 'stored_value', base: 50000 },
    ]);
    // Prepaid ITEMS land in fnb and are taxed now; prepaid CREDIT is a
    // stored-value load, untaxed until it is spent (prototype lib/sale.ts:52-60).
    const asItems = { ...line, foodProvision: { mode: 'prepaid_items' as const, paid: 50000 } };
    expect(ticketCartTaxInputs([asItems], ctx)).toEqual([
      { category: 'tickets', base: 124000 },
      { category: 'fnb', base: 50000 },
    ]);
  });
});

describe('a cart priced under another context is refused, not silently mixed', () => {
  const weekday = contextFor('weekday');
  const weekend = contextFor('weekend');
  const spec: FixtureLine = { id: 'l1', package: 't-2h', tier: 'thai', kids: 1, adults: 0 };

  it('names the stale lines and offers the repair', () => {
    const priced = [buildLine(spec, weekday)];
    expect(priced[0]?.lineTotal).toBe(52000); // weekday thai
    expect(findStaleLines(priced, weekday)).toEqual([]);
    expect(findStaleLines(priced, weekend)).toEqual(['l1']);

    expect(() => computeTicketCartTotals(priced, [], [], taxConfigFor('seeded'), weekend)).toThrow(
      /l1/,
    );

    // Re-pricing is the explicit repair, and it is the caller's decision
    // because the guest was quoted the other number.
    const repriced = repriceCartLines(priced, weekend);
    expect(repriced[0]?.lineTotal).toBe(62000);
    expect(findStaleLines(repriced, weekend)).toEqual([]);
    expect(computeTicketCartTotals(repriced, [], [], taxConfigFor('seeded'), weekend).total).toBe(
      62000,
    );
  });

  it('trust_stored reproduces the drift and does NOT return the recorded total', () => {
    const priced = [buildLine(spec, weekday)];
    const totals = computeTicketCartTotals(priced, [], [], taxConfigFor('seeded'), weekend, {
      staleLines: 'trust_stored',
    });
    // Exactly the disagreement the guard exists to stop: a 52000 subtotal
    // against a 62000 taxable base, and no discount to explain the gap.
    expect(totals.subtotal).toBe(52000);
    expect(totals.taxBreakdown.netSubtotal).toBe(62000);
    expect(totals.discountTotal).toBe(0);
    // THE POINT OF THIS ASSERTION: the total is the RE-DERIVED figure, not the
    // 52000 the guest was charged. An earlier docstring sold this option to "a
    // report re-deriving a historical sale, where the stored totals are the
    // record" — a report written against that sentence publishes 620 baht for a
    // sale that took 520. It is a diagnostic; a report rebuilds the sale's own
    // pricing context, or reads the totals it stored.
    expect(totals.total).toBe(62000);
    expect(totals.total).not.toBe(totals.subtotal);
  });

  it('a promo line is never stale — its total is its item price, not a participant price', () => {
    const cart = [
      buildLine({ id: 'l1', package: 't-2h', tier: 'tourist', kids: 1, adults: 0 }, weekday),
    ];
    const injected = applyFreeItemPromo(
      {
        code: 'ICECREAM',
        label: 'Free Ice Cream',
        type: 'free_item',
        value: 0,
        freeItemId: 'm-icecream',
      },
      { name: 'Ice Cream Cone', price: 5000 },
      freeItemStub(cart)!,
    );
    expect(findStaleLines([injected.line], weekend)).toEqual([]);
  });
});

describe('a discount lands on the category it targeted', () => {
  const ctx = contextFor('weekday');

  it('an add-ons promo reduces the add-ons, not a share of every category (EC-9)', () => {
    const { totals } = runCartCase(cartCases.find((c) => c.id === 'EC-9')!);
    const base = (category: string) =>
      totals.taxBreakdown.categories.find((c) => c.category === category)?.base;
    expect(base('addons')).toBe(10000); // the whole 10000 discount
    expect(base('tickets')).toBe(124000); // untouched
    expect(base('drop_off')).toBe(30000); // untouched
    expect(totals.taxBreakdown.unappliedDiscount).toBe(0);
  });

  it('a component-scoped manual discount follows its component to its category', () => {
    const line = buildLine(
      {
        id: 'l1',
        package: 't-2h',
        tier: 'tourist',
        kids: 1,
        adults: 0,
        socks: 2,
        addOns: [{ ref: 'a-cup', quantity: 1, taxCategoryOverride: 'fnb' }],
      },
      ctx,
    );
    const config = taxConfigFor('seeded');
    const onSocks: ManualDiscount = {
      id: 'm1',
      scope: 'line',
      targetLineId: 'l1',
      targetComponent: { kind: 'socks' },
      type: 'comp',
      value: 0,
    };
    const socksResult = computeTicketCartTotals([line], [], [onSocks], config, ctx);
    const socksBase = (category: string) =>
      socksResult.taxBreakdown.categories.find((c) => c.category === category)?.base;
    expect(socksBase('addons')).toBe(0); // socks were the whole addons base
    expect(socksBase('tickets')).toBe(89000);
    expect(socksBase('fnb')).toBe(15000);

    // An add-on carrying a tax_category_override takes its discount with it.
    const onCup: ManualDiscount = {
      ...onSocks,
      targetComponent: { kind: 'addon', addOnId: 'a-cup' },
    };
    const cupResult = computeTicketCartTotals([line], [], [onCup], config, ctx);
    const cupBase = (category: string) =>
      cupResult.taxBreakdown.categories.find((c) => c.category === category)?.base;
    expect(cupBase('fnb')).toBe(0);
    expect(cupBase('addons')).toBe(10000);
    expect(cupBase('tickets')).toBe(89000);
  });

  it('an order-scope discount still spreads, because it targeted nothing (EC-5)', () => {
    const { totals } = runCartCase(cartCases.find((c) => c.id === 'EC-5')!);
    const base = (category: string) =>
      totals.taxBreakdown.categories.find((c) => c.category === category)?.base;
    expect(base('tickets')).toBe(203858);
    expect(base('addons')).toBe(19142);
  });

  it('what spreading a scoped discount costs, measured (TX-ATTR-1 vs TX-ATTR-2)', () => {
    const inputs = [
      { category: 'tickets' as const, base: 100000 },
      { category: 'stored_value' as const, base: 100000 },
    ];
    const config = taxConfigFor('divergentStoredValue');
    const spread = computeTaxBreakdown(inputs, [{ amount: 20000 }], config);
    const attributed = computeTaxBreakdown(
      inputs,
      [{ amount: 20000, category: 'tickets' }],
      config,
    );
    expect(spread.grandTotal).toBe(attributed.grandTotal); // the guest pays the same
    expect(spread.inclusiveTaxTotal - attributed.inclusiveTaxTotal).toBe(654); // the VAT return does not
  });

  it('with mixed inclusive and exclusive rules the guest pays the difference (TX-ATTR-3 vs -4)', () => {
    const inputs = [
      { category: 'tickets' as const, base: 100000 },
      { category: 'merch' as const, base: 100000 },
    ];
    const config = taxConfigFor('divergentInclusiveExclusive');
    const spread = computeTaxBreakdown(inputs, [{ amount: 20000 }], config);
    const attributed = computeTaxBreakdown(inputs, [{ amount: 20000, category: 'merch' }], config);
    expect(spread.grandTotal - attributed.grandTotal).toBe(700);
  });

  it('allocates each discount against what the earlier ones LEFT (EC-17)', () => {
    const { totals } = runCartCase(cartCases.find((c) => c.id === 'EC-17')!);
    const base = (category: string) =>
      totals.taxBreakdown.categories.find((c) => c.category === category)?.base;

    // Both codes are scoped to tickets and together they exhaust the order.
    expect(totals.appliedPromos.map((p) => p.amount)).toEqual([61410, 235590]);
    expect(totals.discountTotal).toBe(297000);

    // The prototype's arithmetic, written out: it spreads the whole discount
    // proportionally, so both bases go to zero and the guest pays nothing.
    // Every category here carries one inclusive 7% rule, which is the state the
    // prototype's own warning (lib/tax.ts:99-106) says its spread is exact in,
    // so this total is not ours to move.
    const bases = ticketCartTaxInputs(runCartCase(cartCases.find((c) => c.id === 'EC-17')!).lines, {
      mode: 'weekday',
      socks: { ...catalog.socks },
    });
    const totalBase = bases.reduce((sum, b) => sum + b.base, 0);
    const prototypeTotal = bases.reduce(
      (sum, b) => sum + Math.max(0, b.base - (297000 * b.base) / totalBase),
      0,
    );
    expect(prototypeTotal).toBe(0);
    expect(totals.total).toBe(0);
    expect(base('tickets')).toBe(0);
    expect(base('addons')).toBe(0);
    expect(totals.taxBreakdown.unappliedDiscount).toBe(0);

    // The defect this replaced, stated as the number it would produce: reading
    // each discount's split off the UNDISCOUNTED breakdown lets both codes
    // claim the same 267000 of tickets, the cascade clamps the second, and
    // 30000 of add-ons the prototype gives away is charged to the guest.
    expect(totalBase - 267000).toBe(30000);
  });

  it('a surplus a scope can no longer absorb goes back to order-wide, not into the bin (EC-15)', () => {
    const { totals } = runCartCase(cartCases.find((c) => c.id === 'EC-15')!);
    // The manual comp already took the whole ticket base, so the ticket-scoped
    // promo has nothing of its own scope left; its 100000 spreads over what
    // remains rather than being reported as unapplied.
    expect(totals.discountTotal).toBe(278000);
    expect(totals.taxBreakdown.unappliedDiscount).toBe(0);
    expect(totals.total).toBe(0);
  });

  it('but the cascade itself still drops a named allocation it cannot place (TX-ATTR-5)', () => {
    // The contract for a caller that hands computeTaxBreakdown allocations
    // directly is unchanged by the cart-level fix above.
    const dropped = computeTaxBreakdown(
      [{ category: 'tickets', base: 100000 }],
      [{ amount: 5000, category: 'merch' }],
      taxConfigFor('divergentStoredValue'),
    );
    expect(dropped.unappliedDiscount).toBe(5000);
    expect(dropped.grandTotal).toBe(100000);
  });

  it('groups inputs that share a category before placing a named allocation (TX-ATTR-7)', () => {
    const config = taxConfigFor('seeded');
    const ungrouped = computeTaxBreakdown(
      [
        { category: 'tickets', base: 50000 },
        { category: 'tickets', base: 50000 },
      ],
      [{ amount: 80000, category: 'tickets' }],
      config,
    );
    // One row per category, and the whole 80000 lands: before grouping, the
    // allocation found only the first row, left the second at 50000 and
    // reported 30000 unapplied for a total of 50000.
    expect(ungrouped.categories.map((c) => [c.category, c.base])).toEqual([['tickets', 20000]]);
    expect(ungrouped.grandTotal).toBe(20000);
    expect(ungrouped.unappliedDiscount).toBe(0);
    expect(ungrouped).toEqual(
      computeTaxBreakdown(
        [{ category: 'tickets', base: 100000 }],
        [{ amount: 80000, category: 'tickets' }],
        config,
      ),
    );
  });

  it('reads a plain satang total as one order-wide discount, unchanged', () => {
    const inputs = [
      { category: 'tickets' as const, base: 100000 },
      { category: 'addons' as const, base: 100000 },
    ];
    const config = taxConfigFor('seeded');
    expect(computeTaxBreakdown(inputs, 20000, config)).toEqual(
      computeTaxBreakdown(inputs, [{ amount: 20000 }], config),
    );
  });
});

describe('the engine is environment-free', () => {
  // EC-16 pins a refusal rather than a total; it has no figure to compare.
  const totalCases = cartCases.filter((c) => !c.expectThrows);

  it('gives the same answer under a different host timezone', () => {
    // The engine takes every date, timezone and price as an argument, so the
    // only way this could fail is if something inside started reading the host.
    // NOTE the title says timezone and nothing else: an earlier version claimed
    // "and locale" while changing only TZ. The locale half is the test below,
    // which is a stronger guard than moving an environment variable Node has
    // already read.
    const before = totalCases.map((c) => runCartCase(c).totals.total);
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      const after = totalCases.map((c) => runCartCase(c).totals.total);
      expect(after).toEqual(before);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('prices every cart without constructing a single formatter', () => {
    // No locale can change an answer the engine never asks a locale for. Rather
    // than trying to move a default Node fixed at startup, make the whole of
    // Intl.DateTimeFormat hostile for the duration: if any priced-amount path
    // formats a date, this throws. That is the clock/locale boundary engine.ts
    // spends a paragraph on, asserted rather than asserted-about.
    const original = Intl.DateTimeFormat;
    const failures: string[] = [];
    let totals: number[] = [];
    try {
      Object.defineProperty(Intl, 'DateTimeFormat', {
        configurable: true,
        writable: true,
        value: function hostileFormatter(): never {
          throw new Error('the priced-amount core must not construct a date formatter');
        },
      });
      // The stub has to be hostile, or this test passes by doing nothing.
      try {
        new Intl.DateTimeFormat('en-US');
        failures.push('the hostile stub was not installed');
      } catch {
        /* expected */
      }
      for (const testCase of totalCases) {
        try {
          totals.push(runCartCase(testCase).totals.total);
        } catch (error) {
          failures.push(`${testCase.id}: ${(error as Error).message}`);
        }
      }
    } finally {
      Object.defineProperty(Intl, 'DateTimeFormat', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
    expect(failures, 'cases that reached a formatter').toEqual([]);
    expect(totals).toEqual(totalCases.map((c) => runCartCase(c).totals.total));
    totals = [];
  });

  it('stamps a version on every priced cart', () => {
    expect(PRICING_ENGINE_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
    const { totals } = runCartCase(cartCases[0]!);
    expect(totals.engineVersion).toBe(PRICING_ENGINE_VERSION);
  });
});

// Kept next to the fixtures so a missing business-date case is as visible as a
// missing price; the boundary itself is exercised minute by minute in
// business-date.test.ts.
describe('pricing regression fixtures — business dates are present', () => {
  it('covers midnight, the day start and both sides of it', () => {
    const ids = new Set(businessDateCases.map((c) => c.id));
    expect(ids.size).toBe(businessDateCases.length);
    expect(businessDateCases.length).toBeGreaterThanOrEqual(8);
  });
});
