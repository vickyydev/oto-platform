import { describe, expect, it } from 'vitest';
import {
  cartUnits,
  computeTicketCartTotals,
  priceCartLine,
  type CartPromo,
  type PricingContext,
  type TicketCartLine,
} from '../src/index';
import { PRICING_FIXTURES } from '../src/fixtures/index';

/**
 * S2-10b — a promo aimed at ONE LINE (`CartPromo.line`), and at one component
 * of it.
 *
 * Every other promo scope names a kind of thing and matches every row of that
 * kind on the cart. A voucher's free item is the one item the voucher put on
 * the bill, and a 1+1's free ticket is one kid's ticket: aimed at a kind, their
 * markdown spreads over paid lines of the same product and over the adults of
 * the same package. These pin what aiming changes — the scope, the bound and the
 * per-unit report — and that a promo nobody aimed behaves exactly as before.
 */

const { catalog, taxConfigs } = PRICING_FIXTURES;
const seeded = taxConfigs.seeded!;
const weekday: PricingContext = { mode: 'weekday', socks: { ...catalog.socks } };
const KID = 89000;
const ADULT = 35000;
const PIZZA = 22000;

function ticketLine(id: string, kids: number, adults: number): TicketCartLine {
  const pkg = catalog.packages['t-2h']!;
  const line: TicketCartLine = {
    id,
    packageId: 't-2h',
    package: { prices: pkg.prices, adultRules: pkg.adultRules } as TicketCartLine['package'],
    tier: 'tourist',
    kids,
    adults,
    socks: 0,
    addOns: [],
    serviceFee: null,
    lineTotal: 0,
  };
  return { ...line, lineTotal: priceCartLine(line, weekday) };
}

/** A paid pizza, the way the api puts an F&B item on the cart: one menu row on its own line. */
function paidPizza(id: string): TicketCartLine {
  const line: TicketCartLine = {
    id,
    packageId: 'item-line',
    package: { prices: {}, adultRules: null } as unknown as TicketCartLine['package'],
    tier: 'tourist',
    kids: 0,
    adults: 0,
    socks: 0,
    addOns: [
      {
        id: 'p-pizza',
        name: 'Margherita Pizza',
        price: PIZZA,
        quantity: 1,
        itemKind: 'menu',
        taxCategoryOverride: 'fnb',
      },
    ],
    serviceFee: null,
    lineTotal: 0,
  };
  return { ...line, lineTotal: priceCartLine(line, weekday) };
}

/** The pizza a voucher puts on the bill: a promo-item line at its shelf price. */
function voucherPizza(id: string): TicketCartLine {
  return {
    id,
    packageId: 'voucher-line',
    package: { prices: {}, adultRules: null } as unknown as TicketCartLine['package'],
    tier: 'tourist',
    kids: 0,
    adults: 0,
    socks: 0,
    addOns: [],
    promoItem: { itemId: 'p-pizza', itemKind: 'menu', name: 'Margherita Pizza', price: PIZZA },
    lineTotal: PIZZA,
  };
}

const unitsOf = (lines: TicketCartLine[]) => cartUnits(lines, weekday);

describe('a promo aimed at one line (S2-10b)', () => {
  it('takes its markdown from that line only, and says which unit it came off', () => {
    const lines = [ticketLine('kids-a', 1, 0), voucherPizza('voucher'), paidPizza('paid')];
    const aimed: CartPromo = {
      code: 'B1VOUCHERX',
      label: 'Kids Pizza (voucher)',
      type: 'fixed',
      value: PIZZA,
      line: { lineId: 'voucher' },
    };
    const totals = computeTicketCartTotals(lines, [aimed], [], seeded, weekday);
    const [applied] = totals.appliedPromos;
    expect(applied!.amount).toBe(PIZZA);

    const units = unitsOf(lines);
    const voucherUnit = units.findIndex((u) => u.lineId === 'voucher');
    expect(applied!.units).toEqual([{ index: voucherUnit, amount: PIZZA }]);
    // The paid pizza is untouched: nothing it owns is in the report.
    const paidUnit = units.findIndex((u) => u.lineId === 'paid');
    expect(applied!.units!.some((u) => u.index === paidUnit)).toBe(false);

    // Booked where the item is: F&B gross 440, markdown 220 (ruling 1).
    const fnb = totals.taxBreakdown.categories.find((c) => c.category === 'fnb')!;
    expect(fnb.base).toBe(PIZZA);
    expect(totals.total).toBe(KID + PIZZA);
  });

  it('is bounded by its own line: more value than the line holds takes only the line', () => {
    const lines = [ticketLine('kids-a', 1, 0), voucherPizza('voucher'), paidPizza('paid')];
    const aimed: CartPromo = {
      code: 'B1VOUCHERX',
      label: 'Too generous',
      type: 'fixed',
      value: 3 * PIZZA,
      line: { lineId: 'voucher' },
    };
    const totals = computeTicketCartTotals(lines, [aimed], [], seeded, weekday);
    // Ruling 2 holds for an aimed promo: it takes what its scope has left and
    // no more — not the paid pizza, not the ticket.
    expect(totals.appliedPromos[0]!.amount).toBe(PIZZA);
    expect(totals.total).toBe(KID + PIZZA);
  });

  it('aimed at a component, takes from that component only — one kid, never the adults', () => {
    const lines = [ticketLine('family', 2, 1), ticketLine('other', 1, 0)];
    const oneKid: CartPromo = {
      code: 'B1ONEPLUSONE',
      label: '1+1 Kids Ticket',
      type: 'fixed',
      value: KID,
      line: { lineId: 'family', component: { kind: 'kids' } },
    };
    const totals = computeTicketCartTotals(lines, [oneKid], [], seeded, weekday);
    const [applied] = totals.appliedPromos;
    expect(applied!.amount).toBe(KID);
    const units = unitsOf(lines);
    const familyKids = units.findIndex((u) => u.lineId === 'family' && u.row?.kind === 'kids');
    expect(applied!.units).toEqual([{ index: familyKids, amount: KID }]);
    expect(totals.total).toBe(2 * KID + ADULT + KID - KID);

    // Bounded by the component: three kids' worth takes the two kids on it.
    const greedy = computeTicketCartTotals(
      lines,
      [{ ...oneKid, value: 3 * KID }],
      [],
      seeded,
      weekday,
    );
    expect(greedy.appliedPromos[0]!.amount).toBe(2 * KID);
    expect(greedy.appliedPromos[0]!.units).toEqual([{ index: familyKids, amount: 2 * KID }]);
  });

  it('answers the same total as the scope it replaces, where both can reach the same money', () => {
    // A ticketType promo of one kid's price and the same promo aimed at one
    // line's kids take the same amount and leave the same bill: aiming moves
    // WHERE the markdown sits, never how much it is.
    const lines = [ticketLine('a', 1, 1), ticketLine('b', 1, 0)];
    const byType = computeTicketCartTotals(
      lines,
      [
        {
          code: 'X',
          label: 'x',
          type: 'fixed',
          value: KID,
          target: { kind: 'ticketType', ticketTypeId: 't-2h' },
        },
      ],
      [],
      seeded,
      weekday,
    );
    const byLine = computeTicketCartTotals(
      lines,
      [
        {
          code: 'X',
          label: 'x',
          type: 'fixed',
          value: KID,
          line: { lineId: 'b', component: { kind: 'kids' } },
        },
      ],
      [],
      seeded,
      weekday,
    );
    expect(byLine.total).toBe(byType.total);
    expect(byLine.promoDiscountTotal).toBe(byType.promoDiscountTotal);
    expect(byLine.taxBreakdown.categories).toEqual(byType.taxBreakdown.categories);
    // Only the aimed one reports units: a promo nobody aimed is exactly as it was.
    expect(byType.appliedPromos[0]!.units).toBeUndefined();
    expect(byLine.appliedPromos[0]!.units).toHaveLength(1);
  });

  it('an aimed line that is not on the cart takes nothing, and says why', () => {
    const lines = [ticketLine('a', 1, 0)];
    const totals = computeTicketCartTotals(
      lines,
      [{ code: 'X', label: 'x', type: 'fixed', value: KID, line: { lineId: 'gone' } }],
      [],
      seeded,
      weekday,
    );
    expect(totals.appliedPromos[0]).toMatchObject({ amount: 0, units: [] });
    expect(totals.appliedPromos[0]!.exhaustedReason).toBeTruthy();
    expect(totals.total).toBe(KID);
  });
});
