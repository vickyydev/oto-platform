import { describe, expect, it } from 'vitest';
import {
  businessDayEndsAt,
  creditApplies,
  earningPersonsOf,
  grantExpiresAt,
  grantLinesOfLedger,
  mintVoucherQr,
  personGrantsOf,
  unitCreditSatang,
  walletCreditRuleOf,
  type GrantLedgerRow,
  type GrantLine,
} from '../src/wallet';

/**
 * S2-14a — THE GRANT LAW, ported from the prototype's `lib/sale.ts:140-224`
 * (`unitCredit`, `creditApplies`, `buildPersonGrants`, `buildCreditGrants`),
 * in satang. Each row of the table is one of the prototype's cases.
 */

const line = (over: Partial<GrantLine>): GrantLine => ({
  cartLineId: 'L1',
  skip: false,
  kids: 0,
  kidListSatang: 0,
  paidAdults: 0,
  adultListSatang: 0,
  freeAdults: 0,
  creditRule: null,
  gateAccess: true,
  ...over,
});

describe('unitCredit — what one person earns from their list price', () => {
  it.each([
    ['full_price pays the list price', { appliesTo: 'both', basis: 'full_price' } as const, 89_000, 89_000],
    ['full_price on a free adult pays nothing', { appliesTo: 'both', basis: 'full_price' } as const, 0, 0],
    ['fixed pays its value (whole baht, as stored) whatever the price', { appliesTo: 'both', basis: 'fixed', value: 100 } as const, 89_000, 10_000],
    ['fixed pays a free adult too', { appliesTo: 'both', basis: 'fixed', value: 100 } as const, 0, 10_000],
    ['percent pays its share of the list price', { appliesTo: 'both', basis: 'percent', value: 50 } as const, 89_000, 44_500],
    ['percent rounds to the satang', { appliesTo: 'both', basis: 'percent', value: 33 } as const, 1_001, 330],
    ['never negative', { appliesTo: 'both', basis: 'full_price' } as const, -5, 0],
  ])('%s', (_name, rule, list, expected) => {
    expect(unitCreditSatang(list, rule)).toBe(expected);
  });

  it('creditApplies follows appliesTo, and no rule earns nothing', () => {
    expect(creditApplies({ appliesTo: 'adults', basis: 'full_price' }, 'adult')).toBe(true);
    expect(creditApplies({ appliesTo: 'adults', basis: 'full_price' }, 'kid')).toBe(false);
    expect(creditApplies({ appliesTo: 'kids', basis: 'full_price' }, 'kid')).toBe(true);
    expect(creditApplies({ appliesTo: 'kids', basis: 'full_price' }, 'adult')).toBe(false);
    expect(creditApplies({ appliesTo: 'both', basis: 'full_price' }, 'adult')).toBe(true);
    expect(creditApplies({ appliesTo: 'none', basis: 'full_price' }, 'adult')).toBe(false);
    expect(creditApplies(null, 'adult')).toBe(false);
  });
});

describe('buildPersonGrants — one person at a time, adults (paid, then free) then kids', () => {
  it('the seeded adults-full-price package: each paid adult earns their price, kids nothing', () => {
    const persons = personGrantsOf([
      line({ kids: 2, kidListSatang: 89_000, paidAdults: 1, adultListSatang: 35_000, creditRule: { appliesTo: 'adults', basis: 'full_price' } }),
    ]);
    expect(persons.map((p) => [p.role, p.ordinal, p.creditSatang])).toEqual([
      ['adult', 0, 35_000],
      ['kid', 0, 0],
      ['kid', 1, 0],
    ]);
    expect(earningPersonsOf([line({ kids: 2, kidListSatang: 89_000, paidAdults: 1, adultListSatang: 35_000, creditRule: { appliesTo: 'adults', basis: 'full_price' } })])).toHaveLength(1);
  });

  it('a free adult earns nothing under full_price, and is ordered after the paid ones', () => {
    const persons = personGrantsOf([
      line({ paidAdults: 1, adultListSatang: 35_000, freeAdults: 1, kids: 1, kidListSatang: 62_000, creditRule: { appliesTo: 'adults', basis: 'full_price' } }),
    ]);
    expect(persons.map((p) => [p.role, p.listSatang, p.creditSatang])).toEqual([
      ['adult', 35_000, 35_000],
      ['adult', 0, 0],
      ['kid', 62_000, 0],
    ]);
  });

  it('Eat & Play (both, full_price): the ฿350 set-price adult earns ฿350 and the ฿1,300 kid earns ฿1,300', () => {
    const persons = earningPersonsOf([
      line({ kids: 1, kidListSatang: 130_000, paidAdults: 1, adultListSatang: 35_000, creditRule: { appliesTo: 'both', basis: 'full_price' } }),
    ]);
    expect(persons.map((p) => [p.role, p.creditSatang, p.gateAccess])).toEqual([
      ['adult', 35_000, true],
      ['kid', 130_000, false],
    ]);
  });

  it('fixed and percent rules, kids-only: per kid', () => {
    expect(
      earningPersonsOf([line({ kids: 2, kidListSatang: 89_000, paidAdults: 1, adultListSatang: 35_000, creditRule: { appliesTo: 'kids', basis: 'fixed', value: 150 } })]).map((p) => p.creditSatang),
    ).toEqual([15_000, 15_000]);
    expect(
      earningPersonsOf([line({ kids: 1, kidListSatang: 89_000, creditRule: { appliesTo: 'kids', basis: 'percent', value: 10 } })]).map((p) => p.creditSatang),
    ).toEqual([8_900]);
  });

  it('promo and drop-off lines are skipped; lines keep cart order', () => {
    const persons = personGrantsOf([
      line({ cartLineId: 'A', paidAdults: 1, adultListSatang: 35_000, creditRule: { appliesTo: 'adults', basis: 'full_price' } }),
      line({ cartLineId: 'DROP', skip: true, kids: 1, kidListSatang: 22_500, creditRule: { appliesTo: 'both', basis: 'full_price' } }),
      line({ cartLineId: 'B', kids: 1, kidListSatang: 130_000, creditRule: { appliesTo: 'both', basis: 'full_price' } }),
    ]);
    expect(persons.map((p) => p.cartLineId)).toEqual(['A', 'B']);
  });

  it('no rule, or appliesTo none, earns nothing', () => {
    expect(earningPersonsOf([line({ paidAdults: 2, adultListSatang: 35_000 })])).toEqual([]);
    expect(earningPersonsOf([line({ paidAdults: 2, adultListSatang: 35_000, creditRule: { appliesTo: 'none', basis: 'full_price' } })])).toEqual([]);
  });
});

describe('grantLinesOfLedger — the frozen sale ledger read back into cart lines', () => {
  const pkgs = new Map([
    ['P2H', { creditRule: { appliesTo: 'adults', basis: 'full_price' }, gateAccess: true }],
    ['PEP', { creditRule: { appliesTo: 'both', basis: 'full_price' }, gateAccess: true }],
  ]);
  const row = (cartLineId: string, lineNo: number, kind: string, quantity: number, unitSatang: number, ticketPackageId: string | null = 'P2H'): GrantLedgerRow => ({
    cartLineId,
    lineNo,
    kind,
    quantity,
    unitSatang,
    ticketPackageId,
  });

  it('reads counts and list units off the kids / adults_paid / adults_free rows, in receipt order', () => {
    const lines = grantLinesOfLedger(
      [
        row('B', 4, 'kids', 1, 130_000, 'PEP'),
        row('A', 1, 'kids', 2, 89_000),
        row('A', 2, 'adults_paid', 1, 35_000),
        row('A', 3, 'adults_free', 1, 0),
        row('B', 5, 'adults_paid', 1, 35_000, 'PEP'),
        row('A', 6, 'socks', 2, 4_000, null),
      ],
      pkgs,
    );
    expect(lines.map((l) => [l.cartLineId, l.kids, l.kidListSatang, l.paidAdults, l.adultListSatang, l.freeAdults, l.skip])).toEqual([
      ['A', 2, 89_000, 1, 35_000, 1, false],
      ['B', 1, 130_000, 1, 35_000, 0, false],
    ]);
    expect(earningPersonsOf(lines).map((p) => [p.cartLineId, p.role, p.creditSatang])).toEqual([
      ['A', 'adult', 35_000],
      ['B', 'adult', 35_000],
      ['B', 'kid', 130_000],
    ]);
  });

  it('a line with a free-item promo, a drop-off fee, prepaid food, or a supervised child is skipped', () => {
    const lines = grantLinesOfLedger(
      [
        row('PROMO', 1, 'promo_item', 1, 9_000),
        row('FEE', 2, 'kids', 1, 89_000, 'PEP'),
        row('FEE', 3, 'service_fee', 1, 22_500, 'PEP'),
        row('FOOD', 4, 'kids', 1, 89_000, 'PEP'),
        row('FOOD', 5, 'food_provision', 1, 20_000, 'PEP'),
        row('STAY', 6, 'kids', 1, 89_000, 'PEP'),
      ],
      pkgs,
      new Set(['STAY']),
    );
    expect(lines.every((l) => l.skip)).toBe(true);
    expect(earningPersonsOf(lines)).toEqual([]);
  });

  it('a stored rule that is not a rule earns nothing', () => {
    expect(walletCreditRuleOf(null)).toBeNull();
    expect(walletCreditRuleOf({ appliesTo: 'everyone', basis: 'full_price' })).toBeNull();
    expect(walletCreditRuleOf({ appliesTo: 'kids', basis: 'fixed', value: 50 })).toEqual({ appliesTo: 'kids', basis: 'fixed', value: 50 });
  });
});

describe('keys and expiry', () => {
  it('a voucher QR is QR- and twenty base-32 characters, fresh every time', () => {
    const a = mintVoucherQr();
    const b = mintVoucherQr();
    expect(a).toMatch(/^QR-[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(a).not.toBe(b);
  });

  it('a Bangkok business day ends at the next 05:00 on its wall clock', () => {
    expect(businessDayEndsAt('2026-10-01', 'Asia/Bangkok', 300).toISOString()).toBe('2026-10-01T22:00:00.000Z');
  });

  it('a DST zone is resolved against the wall clock the instant shows', () => {
    // London springs forward on 2026-03-29 at 01:00 UTC; 05:00 that morning is BST (UTC+1).
    expect(businessDayEndsAt('2026-03-28', 'Europe/London', 300).toISOString()).toBe('2026-03-29T04:00:00.000Z');
  });

  it('same_day expires at the end of the business day; days_n later; never not at all', () => {
    expect(grantExpiresAt({ expiry: 'same_day', expiryDays: null }, '2026-10-01', 'Asia/Bangkok', 300)?.toISOString()).toBe('2026-10-01T22:00:00.000Z');
    expect(grantExpiresAt({ expiry: 'days_n', expiryDays: 3 }, '2026-10-01', 'Asia/Bangkok', 300)?.toISOString()).toBe('2026-10-03T22:00:00.000Z');
    expect(grantExpiresAt({ expiry: 'never', expiryDays: null }, '2026-10-01', 'Asia/Bangkok', 300)).toBeNull();
  });
});
