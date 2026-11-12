import { describe, expect, it } from 'vitest';
import {
  cartUnits,
  earningPersonsOf,
  grantLinesOfLedger,
  ledgerUnitKindOf,
  type GrantLedgerRow,
} from '@oto/shared';
import { engineCartLine, pricingContext } from '@/lib/cartWire';
import { buildCreditGrants, buildPersonGrants } from '@/lib/sale';
import type { CartLine, CustomerTier, TicketCreditRule, TicketType } from '@/types';

/**
 * SCRUM-883 — THE CUSTOMER SIDE SHOWS ONLY THE CREDIT THE PLATFORM GRANTED.
 *
 * Found on staging on 12 November: a Thai sale of the 1 Hour Play package
 * with one child and one adult, whose adult the Thai rate's free items let in
 * for nothing. The platform granted no credit (lines kids 1×42000 +
 * adults_free 1×0, grants []), while the till's own list — built from the
 * adult rule alone — counted that adult as paying ฿350 and earning ฿350, and
 * the customer's thank-you screen showed "Credit ฿350" with a QR.
 *
 * The platform derives a sale's grants from its ledger: the engine's units
 * (`cartUnits`), each named by `ledgerUnitKindOf` with the row's quantity and
 * unit (`apps/api/src/services/sale.ts`, `buildPricedLines`), read back by
 * `grantLinesOfLedger` and paid by `earningPersonsOf`
 * (`apps/api/src/services/wallet.ts`, `grantSaleCredit`). `platformCredit`
 * below is that recipe, written out here on its own so the till's list is held
 * against the platform's and not against itself.
 */

const TIERS: CustomerTier[] = ['tourist', 'expat', 'thai'];

/** The staging package's shape: ฿420 a child, the Thai adult ฿350 and free by the rate's free items. */
function pkg(over: Partial<TicketType> = {}): TicketType {
  return {
    id: '0190a0a0-0000-7000-8000-000000000883',
    name: '1 Hour Play',
    durationLabel: '1 Hour',
    hours: 1,
    prices: {
      tourist: { weekday: 420, weekend: 420 },
      expat: { weekday: 420, weekend: 420 },
      thai: { weekday: 420, weekend: 420 },
    },
    creditRule: { appliesTo: 'adults', basis: 'full_price' },
    gateAccess: true,
    ...over,
  };
}

const staging = pkg({
  adultRules: {
    tourist: { kind: 'set_price', price: { weekday: 350, weekend: 350 } },
    expat: { kind: 'set_price', price: { weekday: 350, weekend: 350 } },
    thai: { kind: 'set_price', price: { weekday: 350, weekend: 350 } },
  },
  freebies: [{ id: 'fb-1', kind: 'adult', quantity: 1, tiers: ['thai'] }],
});

let seq = 0;
function line(ticketType: TicketType, tier: CustomerTier, kids: number, adults: number, over: Partial<CartLine> = {}): CartLine {
  seq += 1;
  return {
    id: `line-${seq}`,
    ticketType,
    tier,
    kids,
    adults,
    socks: 0,
    addOns: [],
    lineTotal: 0,
    ...over,
  };
}

/** What the platform grants for these lines: its ledger rows, read back by the shared grant law. */
function platformCredit(lines: CartLine[]): number[] {
  const play = lines.filter((l) => !l.dropOff);
  const engine = play.map(engineCartLine);
  const rows: GrantLedgerRow[] = cartUnits(engine, pricingContext()).map((unit, index) => ({
    cartLineId: unit.lineId,
    kind: ledgerUnitKindOf(unit),
    ticketPackageId: unit.packageId,
    quantity: unit.row?.quantity ?? 1,
    unitSatang: unit.row?.unitPrice ?? unit.base,
    lineNo: index + 1,
  }));
  const packages = new Map(
    play.map((l) => [l.ticketType.id, { creditRule: l.ticketType.creditRule ?? null, gateAccess: l.ticketType.gateAccess ?? false }]),
  );
  const gifts = new Set(play.filter((l) => l.voucherGift).map((l) => l.id));
  return earningPersonsOf(grantLinesOfLedger(rows, packages, new Set(), gifts)).map((p) => p.creditSatang / 100);
}

/** What the till's own list says the family earns. */
function tillCredit(lines: CartLine[]): number[] {
  return buildCreditGrants(lines)
    .filter((g) => g.type === 'fnb_credit')
    .map((g) => g.valueTHB ?? 0);
}

describe('the staging case: the Thai rate frees the adult', () => {
  it('a Thai child and adult earn no credit, as the platform granted none', () => {
    const thai = [line(staging, 'thai', 1, 1)];
    expect(platformCredit(thai)).toEqual([]);
    expect(tillCredit(thai)).toEqual([]);
    // The adult still gets a band: one person, earning nothing.
    expect(buildPersonGrants(thai)).toEqual([
      { role: 'adult', gateAccess: true, creditTHB: 0 },
      { role: 'kid', gateAccess: false, creditTHB: 0 },
    ]);
  });

  it('a Tourist child and adult: the paying adult earns ฿350 on both', () => {
    const tourist = [line(staging, 'tourist', 1, 1)];
    expect(platformCredit(tourist)).toEqual([350]);
    expect(tillCredit(tourist)).toEqual([350]);
  });

  it('a Thai child with two adults: the second adult pays and earns, the first is free', () => {
    const thai = [line(staging, 'thai', 1, 2)];
    expect(platformCredit(thai)).toEqual([350]);
    expect(tillCredit(thai)).toEqual([350]);
    expect(buildPersonGrants(thai).map((p) => p.creditTHB)).toEqual([350, 0, 0]);
  });
});

/** Every credit rule the catalogue's types allow, and a ticket with none. */
const RULES: (TicketCreditRule | undefined)[] = [
  undefined,
  { appliesTo: 'none', basis: 'full_price' },
  { appliesTo: 'adults', basis: 'full_price' },
  { appliesTo: 'adults', basis: 'fixed', value: 100 },
  { appliesTo: 'adults', basis: 'percent', value: 50 },
  { appliesTo: 'kids', basis: 'full_price' },
  { appliesTo: 'kids', basis: 'fixed', value: 75 },
  { appliesTo: 'kids', basis: 'percent', value: 10 },
  { appliesTo: 'both', basis: 'full_price' },
  { appliesTo: 'both', basis: 'fixed', value: 120 },
  { appliesTo: 'both', basis: 'percent', value: 120 },
];

type AdultCase = 'paying' | 'free by the rate’s free items' | 'free by the adult rule' | 'at a set price' | 'no adult';
const ADULT_CASES: AdultCase[] = ['paying', 'free by the rate’s free items', 'free by the adult rule', 'at a set price', 'no adult'];

function packageFor(tier: CustomerTier, adult: AdultCase, creditRule: TicketCreditRule | undefined): TicketType {
  const setPrice = { kind: 'set_price' as const, price: { weekday: 350, weekend: 350 } };
  const base = pkg({ creditRule });
  switch (adult) {
    case 'paying':
      return { ...base, adultRules: { [tier]: { kind: 'same_as_kid' } } };
    case 'free by the rate’s free items':
      return { ...base, adultRules: { [tier]: setPrice }, freebies: [{ id: 'fb', kind: 'adult', quantity: 1, tiers: [tier] }] };
    case 'free by the adult rule':
      return { ...base, adultRules: { [tier]: { kind: 'free_adults', freeAdults: 1, overflow: 'same_as_kid' } } };
    case 'at a set price':
    case 'no adult':
      return { ...base, adultRules: { [tier]: setPrice } };
  }
}

describe('the till’s list is the platform’s, rule for rule', () => {
  for (const tier of TIERS) {
    for (const adult of ADULT_CASES) {
      for (const rule of RULES) {
        const name = rule ? `${rule.appliesTo}/${rule.basis}${rule.value === undefined ? '' : ` ${rule.value}`}` : 'no rule';
        it(`${tier}, adult ${adult}, ${name}`, () => {
          const lines = [line(packageFor(tier, adult, rule), tier, 2, adult === 'no adult' ? 0 : 1)];
          expect(tillCredit(lines)).toEqual(platformCredit(lines));
        });
      }
    }
  }

  it('a free adult under a full-price rule earns nothing; under a fixed rule earns the rule’s value', () => {
    const freed = (rule: TicketCreditRule) =>
      [line(packageFor('thai', 'free by the rate’s free items', rule), 'thai', 1, 1)];
    expect(tillCredit(freed({ appliesTo: 'adults', basis: 'full_price' }))).toEqual([]);
    expect(tillCredit(freed({ appliesTo: 'adults', basis: 'fixed', value: 100 }))).toEqual([100]);
    expect(platformCredit(freed({ appliesTo: 'adults', basis: 'fixed', value: 100 }))).toEqual([100]);
  });

  it('a child the rate’s free items let in earns nothing, as the platform reads its ledger', () => {
    const secondFree = pkg({
      creditRule: { appliesTo: 'kids', basis: 'fixed', value: 75 },
      freebies: [{ id: 'fb-c', kind: 'child', quantity: 1, tiers: ['thai'] }],
    });
    const lines = [line(secondFree, 'thai', 2, 0)];
    expect(platformCredit(lines)).toEqual([75]);
    expect(tillCredit(lines)).toEqual([75]);
    // Both children still get a band.
    expect(buildPersonGrants(lines).map((p) => p.role)).toEqual(['kid', 'kid']);
  });

  it('several lines, a drop-off and a promo line among them, in the platform’s person order', () => {
    const lines = [
      line(staging, 'tourist', 1, 1),
      line(staging, 'thai', 1, 2),
      line(staging, 'tourist', 1, 1, { dropOff: { service: 'dropoff', serviceFeeTHB: 0 } as unknown as CartLine['dropOff'] }),
    ];
    expect(tillCredit(lines)).toEqual([350, 350]);
    expect(platformCredit(lines)).toEqual([350, 350]);
  });
});
