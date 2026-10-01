import { describe, expect, it } from 'vitest';
import { CreateReleaseSchema, prepaidReconciliationOf } from '../src/release';

/**
 * S2-13 round 3 — the prototype's `computePrepaidFoodReconciliation`
 * (`lib/dropoff.ts`), ported to satang, and the release wire.
 */

describe('prepaidReconciliationOf', () => {
  it('prepaid credit: what is left, never more than was paid', () => {
    expect(prepaidReconciliationOf({ mode: 'prepaid_credit', paidSatang: 20_050, creditSatang: 20_050 }, 7_525)).toEqual({
      mode: 'prepaid_credit',
      paidSatang: 20_050,
      remainingCreditSatang: 7_525,
      itemBreakdown: [],
      totalRedeemedSatang: 12_525,
      totalUnusedSatang: 7_525,
    });
    // A top-up after check-in does not inflate the refund.
    expect(prepaidReconciliationOf({ mode: 'prepaid_credit', paidSatang: 10_000 }, 15_000).totalUnusedSatang).toBe(10_000);
    expect(prepaidReconciliationOf({ mode: 'prepaid_credit', paidSatang: 10_000 }, -5).totalUnusedSatang).toBe(0);
  });

  it('prepaid items: each unredeemed unit at its price, to the satang', () => {
    const r = prepaidReconciliationOf(
      {
        mode: 'prepaid_items',
        paidSatang: 21_625,
        items: [
          { menuItemName: 'Orange juice', unitSatang: 4_550, qty: 2, redeemedQty: 1 },
          { menuItemName: 'Ham sandwich', unitSatang: 12_525, qty: 1, redeemedQty: 0 },
          { menuItemName: 'Over-redeemed', unitSatang: 1_000, qty: 1, redeemedQty: 3 },
        ],
      },
      0,
    );
    expect(r.itemBreakdown.map((i) => [i.unredeemedQty, i.unredeemedSatang])).toEqual([
      [1, 4_550],
      [1, 12_525],
      [0, 0],
    ]);
    expect(r.totalUnusedSatang).toBe(17_075);
    expect(r.totalRedeemedSatang).toBe(4_550);
  });

  it('no provision is nothing', () => {
    expect(prepaidReconciliationOf(null, 0).totalUnusedSatang).toBe(0);
    expect(prepaidReconciliationOf({ mode: 'none', paidSatang: 0 }, 500).mode).toBe('none');
  });
});

describe('CreateReleaseSchema', () => {
  it('lets a missing photo or name through to the service, which refuses it in the counter’s words', () => {
    expect(CreateReleaseSchema.safeParse({ collector: { kind: 'dropper_off' } }).success).toBe(true);
    expect(CreateReleaseSchema.safeParse({ collector: { kind: 'on_the_spot' } }).success).toBe(true);
  });

  it('has no place for anything but a face: unknown fields are refused', () => {
    expect(
      CreateReleaseSchema.safeParse({ collector: { kind: 'dropper_off' }, idDocumentPhotoFileId: '0190a0a0-0000-7000-8000-000000000001' }).success,
    ).toBe(false);
  });
});
