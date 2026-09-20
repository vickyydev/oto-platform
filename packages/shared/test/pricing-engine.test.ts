import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PRICING_ENGINE_VERSION,
  PROTOTYPE_BAHT_ROUNDING,
  DEFAULT_ROUNDING,
  addDaysToIsoDate,
  apportion,
  applyFreeItemPromo,
  businessDate,
  computeLineBreakdown,
  computeManualDiscount,
  findDuplicateDiscountId,
  parseDayStart,
  wallClockMinutesInTz,
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
  promoNotApplicableReason,
  promoValidityDate,
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

      if (want.appliedPromos) {
        expect(totals.appliedPromos.map((promo) => promo.code)).toEqual(
          want.appliedPromos.map((promo) => promo.code),
        );
        for (const expected of want.appliedPromos) {
          const actual = totals.appliedPromos.find((promo) => promo.code === expected.code);
          expect(actual?.amount, `amount for ${expected.code}`).toBe(expected.amount);
          // A code that found nothing left in its own scope must SAY so, in the
          // promo vocabulary's own wording — ruling 2's visible half.
          if (expected.exhausted) {
            expect(actual?.exhaustedReason, `exhausted reason for ${expected.code}`).toBe(
              promoNotApplicableReason(expected.code),
            );
          } else {
            expect(actual?.exhaustedReason, `no exhausted reason for ${expected.code}`).toBe(
              undefined,
            );
          }
        }
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
      // prototype states it at lib/sale.ts:50-51. It now holds for EVERY line
      // with no exceptions — a free-item promo line used to be exempt here,
      // because its total reached the subtotal and its base reached nothing,
      // and that exemption was the ruling-1 defect written down as a test
      // (WE-8: the guest paid 208000 instead of 213000). Do not reinstate it.
      for (const line of lines) {
        const own = ticketCartTaxInputs([line], ctx).reduce((sum, input) => sum + input.base, 0);
        expect(own, `line ${line.id}: total vs its own tax bases`).toBe(line.lineTotal);
      }

      // Nothing is lost between the cart and the cascade: every satang the cart
      // says it discounted reaches the cascade, and what the cascade could not
      // place is reported rather than dropped. THE CASCADE IS HANDED THE
      // POSITIVE DISCOUNTS ONLY — a promo stored with a negative value is a
      // surcharge neither engine will charge (EC-23), so it is counted out
      // here rather than papered over with a looser assertion.
      const negativePromos = totals.appliedPromos.filter((promo) => promo.amount < 0);
      const cascadeDiscount =
        totals.manualDiscountTotal +
        totals.appliedPromos.reduce((sum, promo) => sum + Math.max(0, promo.amount), 0);
      expect(totals.taxBreakdown.discountTotal, 'cart vs cascade discount').toBe(cascadeDiscount);
      if (negativePromos.length === 0) {
        // Which, on every ordinary cart, is the whole of the cart's discount.
        expect(cascadeDiscount, 'cart vs cascade discount').toBe(totals.discountTotal);
      }
      const absorbed = ticketCartTaxInputs(lines, ctx).reduce((sum, input) => {
        const after = totals.taxBreakdown.categories.find((c) => c.category === input.category);
        return sum + (input.base - (after?.base ?? input.base));
      }, 0);
      if (taxConfigFor(testCase.taxConfig).discountPlacement === 'before_tax') {
        expect(absorbed + totals.taxBreakdown.unappliedDiscount, 'absorbed + unapplied').toBe(
          cascadeDiscount,
        );
      }

      // Duplicate discount ids are refused, so the per-discount amounts the
      // sale record writes are one per discount. (MD-1 pins the refusal.)
      const discountIds = (testCase.manualDiscounts ?? []).map((discount) => discount.id);
      expect(new Set(discountIds).size, 'distinct manual discount ids').toBe(discountIds.length);
      for (const id of discountIds) {
        expect(totals.manualAmounts[id], `amount for ${id}`).toBeTypeOf('number');
      }
    });
  }

});

/**
 * THE PROVENANCE MECHANISM, made to mean something.
 *
 * The fixture file's second standard is "every expected number can be pointed
 * at a rule", and its `rules` field is how a case points. That field used to
 * name ids (`R1`…`R76`) from an "S2-09a specification" that does not exist in
 * this repository, in a numbering that collided with the ids of the one
 * catalogue that does: WE-1 cited R66, and R-66 is F&B modifier groups; EC-9
 * cited R43, and R-43 is the 2C2P Redirect API. The test that was supposed to
 * guard this checked that ten hard-coded ids appeared somewhere in the union of
 * the arrays — nothing about "every", nothing about "once", and its own comment
 * called itself a spot-check.
 *
 * So the ids now come from `docs/architecture/POS_RULES_RECONCILIATION.md` §2,
 * which is committed and therefore readable here and in CI, and this holds the
 * file to it in both directions. A citation that rots into a number meaning
 * something else fails the suite instead of reading plausibly.
 */
describe('pricing regression fixtures — rule provenance', () => {
  const CATALOGUE = new URL(
    '../../../docs/architecture/POS_RULES_RECONCILIATION.md',
    import.meta.url,
  );

  function catalogueRuleIds(): Set<string> {
    const markdown = readFileSync(CATALOGUE, 'utf8');
    return new Set([...markdown.matchAll(/^- (R-\d{2,3}) /gm)].map((match) => match[1]!));
  }

  const citingCases = [
    ...cartCases.map((c) => ({ id: c.id, rules: c.rules })),
    ...taxCases.map((c) => ({ id: c.id, rules: c.rules })),
    ...rateModeCases.map((c) => ({ id: c.id, rules: c.rules })),
    ...PRICING_FIXTURES.tradingDayCases.map((c) => ({ id: c.id, rules: c.rules })),
  ];

  it('every rule the fixture file claims is a real catalogue rule, and every one is exercised', () => {
    const catalogue = catalogueRuleIds();
    expect(catalogue.size, 'rules parsed out of POS_RULES_RECONCILIATION.md').toBeGreaterThan(100);

    const claimed = new Set(PRICING_FIXTURES.rulesCovered);
    expect(claimed.size, 'rulesCovered has no repeats').toBe(PRICING_FIXTURES.rulesCovered.length);

    // 1. Nothing is claimed that the catalogue does not define.
    const unknown = [...claimed].filter((rule) => !catalogue.has(rule));
    expect(unknown, 'claimed rules that are not in POS_RULES_RECONCILIATION.md').toEqual([]);

    // 2. No case cites outside the claim, and every case cites something.
    const uncited: string[] = [];
    const strays: string[] = [];
    for (const testCase of citingCases) {
      if (testCase.rules.length === 0) uncited.push(testCase.id);
      for (const rule of testCase.rules) {
        if (!claimed.has(rule)) strays.push(`${testCase.id} → ${rule}`);
      }
    }
    expect(uncited, 'cases citing no rule at all').toEqual([]);
    expect(strays, 'cases citing a rule the file does not claim').toEqual([]);

    // 3. Every claim is actually exercised — "covers" has to mean covered.
    const cited = new Set(citingCases.flatMap((c) => c.rules));
    const idle = [...claimed].filter((rule) => !cited.has(rule));
    expect(idle, 'rules claimed but exercised by no case').toEqual([]);
  });

  it('cites the rules that decide what a guest pays', () => {
    // The claim list is only as good as what is on it, so the load-bearing
    // pricing rules are named here too: a future edit cannot quietly drop the
    // adult rule or the discount placement and still pass the check above.
    const claimed = new Set(PRICING_FIXTURES.rulesCovered);
    for (const rule of ['R-10', 'R-19', 'R-21', 'R-28', 'R-29', 'R-31', 'R-33', 'R-34']) {
      expect(claimed.has(rule), `the fixtures no longer claim ${rule}`).toBe(true);
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
    // 23:30 Friday and 05:30 Saturday in Bangkok. In Los Angeles the second
    // instant is still Friday afternoon, so a host-timezone read would price it
    // at weekday rates.
    const fridayNight = new Date('2026-09-25T16:30:00Z');
    const saturdayOpen = new Date('2026-09-25T22:30:00Z');
    expect(rateModeToday(BANGKOK, [], fridayNight).mode).toBe('weekday');
    expect(rateModeToday(BANGKOK, [], saturdayOpen).mode).toBe('weekend');
    expect(rateModeToday('America/Los_Angeles', [], saturdayOpen).mode).toBe('weekday');
  });

  it('prices by the BUSINESS day, so Saturday 00:30 is still Friday (ruling 3)', () => {
    // The change ruling 3 made, at the instant it bites: 00:30 on Saturday, a
    // cart rung up while Friday's session is still being closed. It used to
    // read branchToday and charge the WEEKEND price.
    const afterMidnight = new Date('2026-09-25T17:30:00Z');
    expect(branchToday(BANGKOK, afterMidnight)).toBe('2026-09-26');
    expect(businessDate(afterMidnight, BANGKOK)).toBe('2026-09-25');
    expect(rateModeToday(BANGKOK, [], afterMidnight).mode).toBe('weekday');
    // And the day start is the branch's, not a constant: a branch that closes
    // at midnight gets the calendar day's answer back.
    expect(rateModeToday(BANGKOK, [], afterMidnight, 0).mode).toBe('weekend');
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
    // Race-free: the answer has to match the business date read either side of
    // the call, whichever side of the day start the suite happens to run on.
    const before = businessDate(new Date(), BANGKOK);
    const got = rateModeToday(BANGKOK, holidays());
    const after = businessDate(new Date(), BANGKOK);
    const acceptable = [before, after].map((date) => getRateModeForDate(date, holidays()));
    expect(acceptable.map((a) => a.reason)).toContain(got.reason);
  });
});

/**
 * RULINGS 3 AND 4 AT THE BOUNDARY: one instant at one branch, and everything
 * with a date on it that follows from it. Both rulings are DECISIONS taken on
 * 2026-09-20, not rules found in the repository, and both say the same thing —
 * everything answers to the day printed on your receipt.
 *
 * Each case also carries the UTC date the prototype would have used, so the
 * rule that was replaced stays visible rather than being described.
 */
describe('pricing regression fixtures — the trading day (rulings 3 and 4)', () => {
  const ctx = contextFor('weekday');
  const cart = [buildLine({ id: 'l1', package: 't-2h', tier: 'tourist', kids: 1, adults: 0 }, ctx)];

  for (const testCase of PRICING_FIXTURES.tradingDayCases) {
    it(`${testCase.id} — ${testCase.title}`, () => {
      const instant = new Date(testCase.instant);
      const dayStart = parseDayStart(testCase.dayStart);
      const want = testCase.expect;

      expect(branchToday(testCase.timeZone, instant), 'branch calendar date').toBe(want.branchDate);
      expect(businessDate(instant, testCase.timeZone, dayStart), 'business date').toBe(
        want.businessDate,
      );
      expect(instant.toISOString().slice(0, 10), 'the UTC date the prototype used').toBe(
        want.utcDate,
      );

      // Ruling 3: the rate mode comes from the BUSINESS date.
      const holidays = catalog.holidays.map((h) => ({ ...h }));
      const mode = rateModeToday(testCase.timeZone, holidays, instant, dayStart);
      expect(mode.mode, 'rate mode').toBe(want.mode);
      expect(mode.reason, 'rate mode reason').toBe(want.reason);
      expect(mode, 'and it is exactly the mode for that date').toEqual(
        getRateModeForDate(want.businessDate, holidays),
      );

      // Ruling 4: a code's validity window is compared against the same date.
      if (testCase.promo && want.promoAccepted !== undefined) {
        const promo: PromoDiscount = {
          code: 'WINDOW',
          label: 'Window',
          type: 'percent',
          value: 10,
          ...testCase.promo,
        };
        const today = promoValidityDate(instant, testCase.timeZone, dayStart);
        expect(today, 'promoValidityDate is the business date').toBe(want.businessDate);
        expect(validatePromoCode(promo, cart, today, ctx).ok, 'promo accepted').toBe(
          want.promoAccepted,
        );
        if (want.promoAcceptedUnderUtc !== undefined) {
          // The rule this replaced, run on the same instant, giving the other
          // answer — the two-hour window where the UTC date is a day behind.
          expect(
            validatePromoCode(promo, cart, want.utcDate, ctx).ok,
            'promo under the UTC date',
          ).toBe(want.promoAcceptedUnderUtc);
          expect(want.promoAcceptedUnderUtc).not.toBe(want.promoAccepted);
        }
      }
    });
  }

  it('the cases actually straddle both boundaries they claim to', () => {
    const cases = PRICING_FIXTURES.tradingDayCases;
    // A weekday/weekend change on both sides, after midnight...
    const afterMidnight = cases.filter((c) => c.expect.branchDate !== c.expect.businessDate);
    expect([...new Set(afterMidnight.map((c) => c.expect.mode))].sort()).toEqual([
      'weekday',
      'weekend',
    ]);
    // ...and at least one case where the UTC rule gives the other answer.
    expect(
      cases.some((c) => c.expect.promoAcceptedUnderUtc !== undefined),
      'no case shows the UTC divergence',
    ).toBe(true);
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

  it('a promo scoped to add-ons never reaches the drop-off service fee (R-29, EC-9)', () => {
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
    const percent: ManualDiscount = {
      id: 'd',
      scope: 'order',
      type: 'percent',
      value: 200,
      reason: 'Manager comp',
    };
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

      // Thrown rather than expect()ed, like every other invariant in this
      // loop: 200,000 expect() calls cost more than the arithmetic they guard
      // and pushed this past vitest's default timeout on a CI runner, which
      // made a test written to prove the suite is not flaky the one flaky
      // test in it.
      if (parts.length !== weights.length) {
        throw new Error(`apportion(${total}, [${weights}]) gave ${parts.length} parts`);
      }
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
    // An explicit budget rather than the 5 s default: this is a property test
    // and a CI runner is several times slower than a developer's machine, so
    // the default turns a slow machine into a red build and a blocked deploy.
    // Every service here deploys on `checksPass`.
  }, 30_000);

  it('apportion is exact at the magnitude its comment claims, and the product is not beyond it', () => {
    // The only product formed is `total × weight`; the split is exact while
    // that stays inside MAX_SAFE_INTEGER. At equal magnitudes the bound is
    // √(2^53 − 1) ≈ 94,906,265 satang — about ฿949,000, far above any till
    // order. The earlier comment claimed ฿10,000,000 against ฿10,000,000 was
    // safe; that pair is 1e18, roughly 111× too large.
    //
    // The earlier version of this test never called `apportion` at or past the
    // bound, so it asserted arithmetic about the bound rather than the function
    // at it. This one splits AT the bound and checks the result against the
    // same split computed in BigInt, then shows what actually gives way beyond
    // it: the product, one satang past the limit, is already a different number.
    const bound = Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER));
    expect(bound).toBe(94_906_265);
    expect(bound * bound).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);

    /** The largest-remainder split, in BigInt, with no float anywhere. */
    const exactSplit = (total: number, weights: number[]): number[] => {
      const sum = weights.reduce((a, b) => a + BigInt(b), 0n);
      const floors = weights.map((w) => (BigInt(total) * BigInt(w)) / sum);
      const remainders = weights.map((w, i) => BigInt(total) * BigInt(w) - floors[i]! * sum);
      const out = floors.map(Number);
      let leftover = total - out.reduce((a, b) => a + b, 0);
      [...remainders.keys()]
        .sort((a, b) => (remainders[b]! === remainders[a]! ? a - b : remainders[b]! > remainders[a]! ? 1 : -1))
        .forEach((index) => {
          if (leftover <= 0) return;
          out[index] = out[index]! + 1;
          leftover -= 1;
        });
      return out;
    };

    // At the bound, on the worst shape for it: every weight at the bound too,
    // so every product is the largest one the comment permits.
    const atBound = [bound, bound, bound];
    expect(apportion(bound, atBound)).toEqual(exactSplit(bound, atBound));
    expect(apportion(bound, [bound, 1])).toEqual(exactSplit(bound, [bound, 1]));
    expect(apportion(bound, atBound).reduce((a, b) => a + b, 0)).toBe(bound);

    // And past it the product itself stops being the integer it should be:
    // 94,906,267 × 94,906,269 is 9,007,199,705,687,823 and JavaScript says
    // ...824. That is the thing the bound is a bound on.
    expect(Number.isSafeInteger(bound * bound)).toBe(true);
    expect(Number.isSafeInteger((bound + 1) * (bound + 1))).toBe(false);
    const [a, b] = [94_906_267, 94_906_269];
    expect(String(a * b)).not.toBe(String(BigInt(a) * BigInt(b)));
    expect(1e9 * 1e9).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

    // Exact at a realistic till magnitude (a ฿50,000 discount over three
    // category bases), checked against the BigInt split rather than asserted.
    const weights = [12_345_600, 7_654_400, 3_210_000];
    expect(apportion(5_000_000, weights)).toEqual(exactSplit(5_000_000, weights));
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

  it('routes each kind of line to the taxable category the prototype gives it (R-31)', () => {
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
      { id: 'd1', scope: 'order', type: 'percent', value: 10, reason: 'Staff / family' },
      {
        id: 'd2',
        scope: 'line',
        targetLineId: 'l1',
        type: 'fixed',
        value: 5000,
        reason: 'Service recovery',
      },
      {
        id: 'd3',
        scope: 'line',
        targetLineId: 'l1',
        targetComponent: { kind: 'kids' },
        type: 'comp',
        value: 0,
        reason: 'Manager comp',
      },
      {
        id: 'd4',
        scope: 'line',
        targetLineId: 'gone',
        type: 'comp',
        value: 0,
        reason: 'Manager comp',
      },
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

describe('a repeated discount id is refused, not silently charged to the guest', () => {
  const ctx = contextFor('weekday');
  const cart = () => [
    buildLine(
      {
        id: 'l1',
        package: 't-2h',
        tier: 'tourist',
        kids: 1,
        adults: 0,
        socks: 2,
        addOns: [{ ref: 'a-locker', quantity: 1 }],
      },
      ctx,
    ),
  ];
  const onKids: ManualDiscount = {
    id: 'dup',
    scope: 'line',
    targetLineId: 'l1',
    targetComponent: { kind: 'kids' },
    type: 'fixed',
    value: 30000,
    reason: 'Service recovery',
  };
  const onSocks: ManualDiscount = {
    ...onKids,
    targetComponent: { kind: 'socks' },
    value: 5000,
    reason: 'Damaged item',
  };

  it('names the id, at the function that cannot represent it (MD-1)', () => {
    expect(findDuplicateDiscountId([onKids, onSocks])).toBe('dup');
    expect(findDuplicateDiscountId([onKids, { ...onSocks, id: 'm2' }])).toBeNull();

    // The refusal lives in computeManualDiscount, so every caller inherits it —
    // S2-09b calling it directly for an F&B cart as much as the till.
    expect(() => computeManualDiscount([onKids, onSocks], 109000, { l1: 109000 }, {})).toThrow(
      /"dup" appears more than once/,
    );
    expect(() =>
      computeTicketCartTotals(cart(), [], [onKids, onSocks], taxConfigFor('seeded'), ctx),
    ).toThrow(/appears more than once/);
  });

  it('and the ฿250 that used to go missing, written down next to the rule (MD-2)', () => {
    const { totals } = runCartCase(cartCases.find((c) => c.id === 'MD-2')!);
    expect(totals.subtotal).toBe(109000);
    expect(totals.manualDiscountTotal).toBe(35000);
    expect(totals.total).toBe(74000);
    expect(totals.taxBreakdown.unappliedDiscount).toBe(0);

    // What the same cart produced while both discounts shared an id, as
    // arithmetic: `amounts` is keyed by id, the last write won, and the
    // attribution loop read that one amount once per discount. So the cascade
    // was handed 5000 twice instead of 30000 + 5000, and the guest paid the
    // difference. Nothing in the engine can produce this now; it is here so the
    // cost of the collision is next to the rule that forbids it.
    const lastWriteWins = 5000 + 5000; // the socks amount, placed twice
    expect(totals.manualDiscountTotal - lastWriteWins).toBe(25000);
    expect(109000 - lastWriteWins).toBe(99000); // what the guest was charged
    expect(99000 - totals.total).toBe(25000); // ฿250 of discount, gone
  });
});

describe('a promo stored with a negative value (EC-23)', () => {
  it('is reported by the cart and refused by the cascade, and the guest pays the full price', () => {
    const { totals } = runCartCase(cartCases.find((c) => c.id === 'EC-23')!);
    expect(totals.subtotal).toBe(89000);
    expect(totals.promoDiscountTotal).toBe(-44500);
    expect(totals.discountTotal).toBe(-44500);
    // The cascade sees none of it — the prototype clamps at Math.max(0, …)
    // (lib/tax.ts:91), the port never allocates a non-positive amount.
    expect(totals.taxBreakdown.discountTotal).toBe(0);
    expect(totals.total).toBe(89000);
    expect(totals.taxBreakdown.unappliedDiscount).toBe(0);
  });

  it('and the rounding of a negative is ours, not the prototype’s', () => {
    // rounding.ts grounds half-up on "every amount here is non-negative". A
    // negative promo value is the one input that breaks the premise: the
    // prototype leaves the figure fractional (lib/sale.ts:109), integer satang
    // cannot, and Math.round takes a negative tie toward +∞ — so it rounds
    // toward zero rather than away from it.
    expect(roundHalfUpSatang(-166.5)).toBe(-166);
    expect(roundHalfUpSatang(166.5)).toBe(167);
    // A manual discount cannot reach this path at all: a negative percentage is
    // clamped to zero before any rounding happens.
    expect(
      resolveManualDiscountAmount(
        { id: 'd', scope: 'order', type: 'percent', value: -50, reason: 'Manager comp' },
        33300,
      ),
    ).toBe(0);
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
    // end-of-day records no markdown at all. Since ruling 1 that overcharge is
    // the whole ฿50 and it is VISIBLE — the cone is on the bill at its shelf
    // price with nothing offsetting it, so the cart totals 218000 rather than
    // quietly dropping the cone out of the taxable base and landing on 213000
    // by a route nobody could reconcile.
    const withStored = computeTicketCartTotals(lines, [seeded], [], config, ctx);
    expect(withStored.subtotal).toBe(218000);
    expect(withStored.discountTotal).toBe(0);
    expect(withStored.total).toBe(218000);

    // RULING 1: with the value resolved the guest pays 213000, the tickets are
    // untouched, and the cone is marked down to nothing against F&B. The engine
    // used to charge 208000 here, taking the cone off the TICKETS base as well
    // as off the shelf — the park giving it away twice and booking it once.
    expect(withResolved.total).toBe(213000);
    expect(withStored.total - withResolved.total, 'what the resolved code is worth').toBe(5000);
    const fnb = (totals: typeof withResolved) =>
      totals.taxBreakdown.categories.find((c) => c.category === 'fnb');
    expect(fnb(withResolved)?.base, 'the cone is marked down to nothing').toBe(0);
    expect(
      withResolved.taxBreakdown.netSubtotal,
      'and the ฿50 of F&B gross is still on the books',
    ).toBe(218000);
    expect(
      withResolved.taxBreakdown.categories.find((c) => c.category === 'tickets')?.base,
      'while the tickets are untouched',
    ).toBe(213000);
    expect(withStored.taxBreakdown.netSubtotal).toBe(218000);
    expect(fnb(withStored)?.base, 'the unresolved code marks nothing down').toBe(5000);
  });

  it('a free-item code discounts the line it added and nothing else (ruling 1)', () => {
    // A code the catalogue stored with no target at all. Its scope is still its
    // own synthetic line — `freeItemLineId` ties the two together — so the
    // markdown lands on F&B rather than being apportioned over the tickets.
    const cart = [
      buildLine({ id: 'l1', package: 't-2h', tier: 'tourist', kids: 2, adults: 1 }, ctx),
    ];
    const untargeted: PromoDiscount = {
      code: 'ICECREAM',
      label: 'Free Ice Cream',
      type: 'free_item',
      value: 0,
      freeItemId: 'm-icecream',
      freeItemKind: 'menu',
    };
    const injected = applyFreeItemPromo(untargeted, item, freeItemStub(cart)!);
    const totals = computeTicketCartTotals(
      [...cart, injected.line],
      [injected.promo],
      [],
      taxConfigFor('seeded'),
      ctx,
    );
    expect(totals.total).toBe(213000);
    expect(totals.discountTotal).toBe(5000);
    const base = (category: string) =>
      totals.taxBreakdown.categories.find((c) => c.category === category)?.base;
    expect(base('tickets')).toBe(213000);
    expect(base('fnb')).toBe(0);
  });

  it('a free merch item books against merch, not F&B', () => {
    const cart = [
      buildLine({ id: 'l1', package: 't-2h', tier: 'tourist', kids: 1, adults: 0 }, ctx),
    ];
    const merch: PromoDiscount = {
      ...seeded,
      code: 'FREECAP',
      freeItemId: 'm-cap',
      freeItemKind: 'merch',
      target: { kind: 'merch' },
    };
    const injected = applyFreeItemPromo(merch, { name: 'Cap', price: 30000 }, freeItemStub(cart)!);
    const totals = computeTicketCartTotals(
      [...cart, injected.line],
      [injected.promo],
      [],
      taxConfigFor('seeded'),
      ctx,
    );
    expect(totals.subtotal).toBe(119000);
    expect(totals.discountTotal).toBe(30000);
    expect(totals.total).toBe(89000);
    expect(totals.taxBreakdown.categories.map((c) => [c.category, c.base])).toEqual([
      ['tickets', 89000],
      ['merch', 0],
    ]);
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

  it('and it refuses a drop-off line the prototype deliberately leaves unpriced (S2-13)', () => {
    // The prototype keeps a drop-off line in the cart at lineTotal 0 until
    // staff pick the length (lib/dropoff.ts:52-59, :87, :139-141). This engine
    // cannot tell that from a line priced under another rate mode, so it
    // refuses the cart and names the line. Pinned rather than patched: the fix
    // is S2-13's, because the distinguishing fact is `dropOff.lengthChosen`,
    // which this port has not modelled. See findStaleLines for the two ways out
    // and the one that must not be taken.
    const unpriced = { ...buildLine(spec, weekday), lineTotal: 0 };
    expect(findStaleLines([unpriced], weekday)).toEqual(['l1']);
    expect(() =>
      computeTicketCartTotals([unpriced], [], [], taxConfigFor('seeded'), weekday),
    ).toThrow(/l1/);
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
      reason: 'Damaged item',
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

  it('allocates each discount against what the earlier ones LEFT, and each SPENDS only its own scope (EC-17)', () => {
    const { totals, lines } = runCartCase(cartCases.find((c) => c.id === 'EC-17')!);
    const base = (category: string) =>
      totals.taxBreakdown.categories.find((c) => c.category === category)?.base;

    // THE AMOUNT LINE (ruling 2, a decision): both codes are scoped to tickets,
    // so the second takes 100% of what is left OF THE TICKETS, not of the
    // order. 61410 + 205590 = 267000, exactly the ticket base.
    expect(totals.appliedPromos.map((p) => p.amount)).toEqual([61410, 205590]);
    expect(totals.discountTotal).toBe(267000);

    const bases = ticketCartTaxInputs(lines, { mode: 'weekday', socks: { ...catalog.socks } });
    const totalBase = bases.reduce((sum, b) => sum + b.base, 0);
    expect(totalBase).toBe(297000);
    expect(bases.find((b) => b.category === 'tickets')?.base).toBe(267000);

    // So the add-ons survive, and the guest pays for them. What the engine used
    // to do instead: let the second code take 235590 — the ORDER balance — for
    // 297000 of discount against a 267000 ticket base, which the prototype then
    // spreads over the add-ons and hands the guest a bill of nothing.
    expect(totals.total).toBe(30000);
    expect(base('tickets')).toBe(0);
    expect(base('addons')).toBe(30000);
    expect(totalBase - 267000).toBe(30000);

    // THE ATTRIBUTION LINE, unchanged and still the thing not to touch: every
    // satang of the 267000 is placed on a category. Reading each discount's
    // split off the UNDISCOUNTED breakdown instead would let both codes claim
    // the same 267000, the cascade would clamp the second, and the surplus
    // would be reported as unapplied rather than given.
    expect(totals.taxBreakdown.unappliedDiscount).toBe(0);
    const absorbed = bases.reduce((sum, b) => sum + (b.base - (base(b.category) ?? 0)), 0);
    expect(absorbed).toBe(267000);
  });

  it('a scoped code whose scope is already spent takes nothing, and says so (EC-15)', () => {
    const { totals } = runCartCase(cartCases.find((c) => c.id === 'EC-15')!);
    // The manual comp already took the whole ticket base, so the ticket-scoped
    // promo has nothing of its own scope left. Ruling 2: it takes nothing, the
    // guest pays for the lockers, and the code carries the reason the till
    // shows rather than sitting on the receipt at ฿0 with no explanation.
    expect(totals.manualDiscountTotal).toBe(178000);
    expect(totals.promoDiscountTotal).toBe(0);
    expect(totals.discountTotal).toBe(178000);
    expect(totals.appliedPromos[0]?.exhaustedReason).toBe(promoNotApplicableReason('TICKETS100'));
    expect(totals.taxBreakdown.unappliedDiscount).toBe(0);
    expect(totals.total).toBe(100000);
  });

  it('the ฿1,000 of lockers survives every combination of the two discounts (ruling 2)', () => {
    // The reason the ruling was taken: before it, the comp and the code between
    // them took 278000 off a 278000 cart, and ฿1,000 of lockers neither of them
    // was aimed at walked out free. Now each is bounded by the tickets it
    // targets, so no combination of the two can reach the lockers.
    const source = cartCases.find((c) => c.id === 'EC-15')!;
    const ctx = contextFor('weekday');
    const { lines } = buildCart(source, ctx);
    const config = taxConfigFor('seeded');
    const manual = (source.manualDiscounts ?? []) as ManualDiscount[];
    const promos = (source.promos ?? []) as PromoDiscount[];

    for (const [label, m, p] of [
      ['comp only', manual, [] as PromoDiscount[]],
      ['code only', [] as ManualDiscount[], promos],
      ['both', manual, promos],
    ] as const) {
      const totals = computeTicketCartTotals(lines, p, m, config, ctx);
      expect(totals.subtotal, label).toBe(278000);
      expect(totals.discountTotal, label).toBe(178000);
      expect(totals.total, label).toBe(100000);
    }
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
  it('has a distinct case per id', () => {
    const ids = new Set(businessDateCases.map((c) => c.id));
    expect(ids.size).toBe(businessDateCases.length);
    expect(businessDateCases.length).toBeGreaterThanOrEqual(8);
  });

  it('covers midnight, the day start and both sides of it', () => {
    // The previous body of this name counted the cases and checked their ids
    // were unique, which is the test above. This one reads the instants and
    // proves the three boundary positions are actually present, in the branch
    // timezone each case names — the property the name has always claimed.
    const positions = businessDateCases.map((testCase) => {
      const minutes = wallClockMinutesInTz(new Date(testCase.instant), testCase.timeZone);
      const start = parseDayStart(testCase.dayStart);
      if (minutes === 0) return 'midnight';
      if (minutes === start) return 'exactly the day start';
      return minutes < start ? 'before the day start' : 'after the day start';
    });
    for (const position of [
      'midnight',
      'exactly the day start',
      'before the day start',
      'after the day start',
    ]) {
      expect(positions, `no business-date case sits ${position}`).toContain(position);
    }

    // And each case's expectation is the rule applied to that position: before
    // the day start the business date is the day before the branch date.
    for (const testCase of businessDateCases) {
      const instant = new Date(testCase.instant);
      const minutes = wallClockMinutesInTz(instant, testCase.timeZone);
      const start = parseDayStart(testCase.dayStart);
      expect(businessDate(instant, testCase.timeZone, start), testCase.id).toBe(
        minutes < start
          ? addDaysToIsoDate(testCase.expect.branchDate, -1)
          : testCase.expect.branchDate,
      );
    }
  });
});
