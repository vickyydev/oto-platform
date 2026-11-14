import { describe, expect, it } from 'vitest';
import { beoQuantityOf, stepBeoQuantity } from '../../oto-app/shared/beoQuantity';
import { parkDayOf } from '../../oto-app/shared/beoDate';
import { beoExtraChargeOf, beoExtrasTotalOf, type BeoExtraLine } from '../../oto-app/shared/beoExtras';

/**
 * Adversarial pins for the approved 983/968 reliability scope. Runtime UI,
 * public-submit, PDF and Thai cases live in the corresponding whole app files.
 * Owner-held text-price, holiday/catalogue access and menu-copy policies stay unchanged.
 */
describe('SCRUM-983/968: published counts and truthful price bounds', () => {
  it.each([
    [2, 2], ['2', 2], [null, 1], ['', 1], [undefined, 1], [0, 1], ['0', 1],
    ['02', 1], [' 2 ', 1], [2.5, 1], ['2.5', 1], [999999, 999999], ['999999', 999999],
    [1000000, 1], ['1000000', 1], [Number.NaN, 1],
  ])('HIGH fixed: count %s uses the immutable publication range (%s)', (input, output) => {
    expect(beoQuantityOf(input)).toBe(output);
  });

  it('HIGH fixed: both steps read stored text numerically and stay inside the publication range', () => {
    expect(stepBeoQuantity('2', 1)).toBe(3);
    expect(stepBeoQuantity('2', -1)).toBe(1);
    expect(stepBeoQuantity(null, -1)).toBe(1);
    expect(stepBeoQuantity(999999, 1)).toBe(999999);
  });

  it('HIGH fixed: a persisted moment uses the park day, retaining the requested date format', () => {
    const at = '2099-11-12T19:28:45.000Z';
    expect(parkDayOf(at, undefined, 'en-GB')).toBe('13/11/2099');
    expect(parkDayOf(at, 'Europe/London', 'en-GB')).toBe('12/11/2099');
    expect(parkDayOf(at, 'not/a-zone', 'en-GB')).toBe('13/11/2099');
    expect(parkDayOf(at, undefined, 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })).toBe('13 Nov 2099');
    expect(parkDayOf('not a moment')).toBe('');
  });

  const ctx = { partyDate: '2026-12-02', till: { known: true, byCode: new Map([['CF-24', { priceSatang: 40000, priceWeekendSatang: 45000 }]]) } };
  const line = (over: Partial<BeoExtraLine> = {}): BeoExtraLine => ({ itemName: 'ZZ TEST review dish', quantity: 2, ...over });

  it.each(['food', 'bar'] as const)('HIGH fixed: an absent %s picker code is unknown and prevents a complete sum', (area) => {
    const missing = beoExtraChargeOf(line({ productCode: 'CF-MISSING' }), area, ctx);
    expect(missing).toEqual({ kind: 'unknown' });
    expect(beoExtrasTotalOf([missing, beoExtraChargeOf(line({ price: 100 }), area, ctx)])).toBeNull();
  });

  it('control: entered numeric prices, known weekday/weekend rates and typed zero-price lines keep their rules', () => {
    expect(beoExtraChargeOf(line({ price: 120, productCode: 'CF-24' }), 'food', ctx)).toMatchObject({ from: 'entered', unitSatang: 12000, totalSatang: 24000 });
    expect(beoExtraChargeOf(line({ productCode: 'CF-24' }), 'food', ctx)).toMatchObject({ from: 'till', unitSatang: 40000 });
    expect(beoExtraChargeOf(line({ productCode: 'CF-24' }), 'food', { ...ctx, partyDate: '2026-12-05' })).toMatchObject({ from: 'till', unitSatang: 45000 });
    expect(beoExtraChargeOf(line(), 'food', ctx)).toEqual({ kind: 'not_charged', why: 'no_price' });
  });

  it('control: no text-price normalization or new PARTY bar charge is introduced', () => {
    const held = line({ price: '120' as unknown as number, productCode: 'CF-24' });
    expect(beoExtraChargeOf(held, 'food', ctx)).toMatchObject({ from: 'till', unitSatang: 40000 });
    expect(held.price).toBe('120');
    expect(beoExtraChargeOf(line({ productCode: 'PARTY-12345678', price: 999 }), 'bar', ctx)).toEqual({ kind: 'not_charged', why: 'party_item_on_bar' });
  });
});
