import { describe, expect, it } from 'vitest';
import type { PackagePricingShape, PricingContext, TicketCartLine } from '../src/pricing';
import { earningPersonsOf, personGrantsOf, type WalletCreditRule } from '../src/wallet';
import { grantLedgerRowsOfCart, grantLinesOfCart } from '../src/wallet-cart';

/**
 * SCRUM-883 — the grant law read from a cart, as the platform reads the
 * ledger that cart writes. The staging package: ฿420 a child, the adult ฿350,
 * and the Thai rate's free items let one adult in free.
 */

const ctx: PricingContext = { mode: 'weekday', socks: { addOnId: 'a-socks', price: 5_000, label: 'Regular Socks' } };
const ww = (satang: number) => ({ weekday: satang, weekend: satang });

const staging: PackagePricingShape = {
  prices: { tourist: ww(42_000), expat: ww(42_000), thai: ww(42_000) },
  adultRules: {
    tourist: { kind: 'set_price', price: ww(35_000) },
    expat: { kind: 'set_price', price: ww(35_000) },
    thai: { kind: 'set_price', price: ww(35_000) },
  },
  freebies: [{ kind: 'adult', quantity: 1, tiers: ['thai'] }],
};

const cartLine = (id: string, pkg: PackagePricingShape, tier: string, kids: number, adults: number): TicketCartLine => ({
  id,
  packageId: 'P1',
  package: pkg,
  tier,
  kids,
  adults,
  socks: 0,
  addOns: [],
  lineTotal: 0,
});

const packages = (creditRule: WalletCreditRule | null) => new Map([['P1', { creditRule, gateAccess: true }]]);
const adultsFull: WalletCreditRule = { appliesTo: 'adults', basis: 'full_price' };

describe('grantLedgerRowsOfCart — the rows the ledger files for a cart', () => {
  it('a Thai child and adult: kids 1×42000 and adults_free 1×0, as staging read back', () => {
    const rows = grantLedgerRowsOfCart([cartLine('L1', staging, 'thai', 1, 1)], ctx);
    expect(rows.map((r) => [r.kind, r.quantity, r.unitSatang])).toEqual([
      ['kids', 1, 42_000],
      ['adults_free', 1, 0],
    ]);
  });
});

describe('grantLinesOfCart — who earns, before the sale closes', () => {
  it('the Thai adult the free items let in earns nothing under a full-price rule', () => {
    const lines = grantLinesOfCart([cartLine('L1', staging, 'thai', 1, 1)], ctx, packages(adultsFull));
    expect(earningPersonsOf(lines)).toEqual([]);
    expect(personGrantsOf(lines).map((p) => [p.role, p.creditSatang])).toEqual([
      ['adult', 0],
      ['kid', 0],
    ]);
  });

  it('the Tourist adult pays ฿350 and earns ฿350', () => {
    const lines = grantLinesOfCart([cartLine('L1', staging, 'tourist', 1, 1)], ctx, packages(adultsFull));
    expect(earningPersonsOf(lines).map((p) => p.creditSatang)).toEqual([35_000]);
  });

  it('a fixed rule pays the free adult its value, a percent rule pays nothing', () => {
    const fixed = grantLinesOfCart([cartLine('L1', staging, 'thai', 1, 1)], ctx, packages({ appliesTo: 'adults', basis: 'fixed', value: 100 }));
    expect(earningPersonsOf(fixed).map((p) => p.creditSatang)).toEqual([10_000]);
    const percent = grantLinesOfCart([cartLine('L1', staging, 'thai', 1, 1)], ctx, packages({ appliesTo: 'adults', basis: 'percent', value: 50 }));
    expect(earningPersonsOf(percent)).toEqual([]);
  });

  it('a supervised line earns nothing, a gift line keeps its child and parent out', () => {
    const tourist = [cartLine('L1', staging, 'tourist', 1, 1)];
    expect(earningPersonsOf(grantLinesOfCart(tourist, ctx, packages(adultsFull), new Set(['L1'])))).toEqual([]);
    expect(earningPersonsOf(grantLinesOfCart(tourist, ctx, packages(adultsFull), new Set(), new Set(['L1'])))).toEqual([]);
  });

  it('a child the free items let in is not among the paid children', () => {
    const secondChildFree: PackagePricingShape = { ...staging, freebies: [{ kind: 'child', quantity: 1, tiers: [] }] };
    const lines = grantLinesOfCart(
      [cartLine('L1', secondChildFree, 'thai', 2, 0)],
      ctx,
      packages({ appliesTo: 'kids', basis: 'fixed', value: 75 }),
    );
    expect(earningPersonsOf(lines).map((p) => p.creditSatang)).toEqual([7_500]);
  });
});
