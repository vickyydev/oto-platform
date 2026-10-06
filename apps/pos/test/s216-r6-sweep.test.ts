import { describe, expect, it } from 'vitest';
import { apiDiscountToDiscount, type ApiDiscount } from '@/api/menu';
import { promoUsageSummaryOf } from '@/lib/reporting';
import type { Discount } from '@/types';

/**
 * S2-15b round 6 closing sweep — the Wallet & Promo panel's promo-code card no
 * longer reads this browser's mock sales. Its "Used" column is the platform's
 * count of the finalised sales that carried each code (`GET /menu/discounts`
 * `usedCount`, the count the limit is held to), and its "Discount value
 * (range)" the platform's promo rows for the range
 * (`GET /analytics/reports/discounts/transactions`), summed per code by the
 * prototype's own rule.
 */

const platformCode = (over: Partial<ApiDiscount>): ApiDiscount => ({
  id: '0192f000-0000-7000-8000-00000000d001',
  branchId: null,
  code: 'SUMMER10',
  label: 'Summer 10%',
  kind: 'percent',
  valueBp: 1_000,
  valueSatang: null,
  freeProductId: null,
  target: null,
  validFrom: null,
  validUntil: null,
  usageLimit: 50,
  perCustomerLimit: null,
  stackable: false,
  active: true,
  archivedAt: null,
  ...over,
});

describe('the promo code card reads the platform', () => {
  it('a platform code carries its uses into the catalog; an older platform’s, none', () => {
    expect(apiDiscountToDiscount(platformCode({ usedCount: 7 }))).toMatchObject({ code: 'SUMMER10', usedCount: 7, usageLimit: 50 });
    expect(apiDiscountToDiscount(platformCode({}))).not.toHaveProperty('usedCount');
  });

  it('sums the range’s promo rows per code, however the code was cased, beside each code’s uses and limit', () => {
    const codes: Discount[] = [
      apiDiscountToDiscount(platformCode({ usedCount: 7 })),
      apiDiscountToDiscount(platformCode({ id: '0192f000-0000-7000-8000-00000000d002', code: 'KIDSFREE', label: 'Kid free', usageLimit: null, usedCount: 3 })),
      // Never used and no limit: not a row, as in the prototype.
      apiDiscountToDiscount(platformCode({ id: '0192f000-0000-7000-8000-00000000d003', code: 'IDLE', usageLimit: null, usedCount: 0 })),
    ];
    const rows = promoUsageSummaryOf(codes, [
      { code: 'SUMMER10', amountSatang: 12_000 },
      { code: 'summer10', amountSatang: 8_500 },
      { code: 'KIDSFREE', amountSatang: 69_000 },
      // A voucher's row (shown by its last four) matches no catalog code.
      { code: '••••7Q2X', amountSatang: 30_000 },
    ]);
    expect(rows).toEqual([
      { code: 'SUMMER10', label: 'Summer 10%', type: 'percent', usedCount: 7, usageLimit: 50, active: true, totalDiscountValueSatang: 20_500 },
      { code: 'KIDSFREE', label: 'Kid free', type: 'percent', usedCount: 3, usageLimit: undefined, active: true, totalDiscountValueSatang: 69_000 },
    ]);
  });
});
