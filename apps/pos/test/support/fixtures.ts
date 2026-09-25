import type { ApiSale, CartQuote } from '@/api/sales';

/**
 * Answers the platform gives, built the way the till reads them. Types only
 * are imported, so a test that replaces `@/api/sales` can still use these.
 */

/** A sale as the platform answers it: rung up and unpaid (`tendering`), ฿540. */
export function apiSale(overrides: Partial<ApiSale> = {}): ApiSale {
  return {
    id: 'sale-1',
    status: 'tendering',
    businessDate: '2026-09-25',
    occurredAt: '2026-09-25T04:10:00.000Z',
    stationId: 'station-1',
    pricingMode: 'weekday',
    customerTier: 'tourist',
    totals: {
      subtotalSatang: 54_000,
      manualDiscountSatang: 0,
      promoDiscountSatang: 0,
      discountSatang: 0,
      netSatang: 54_000,
      serviceChargeSatang: 0,
      taxInclusiveSatang: 3_533,
      taxExclusiveSatang: 0,
      grossSatang: 54_000,
      unappliedDiscountSatang: 0,
    },
    engineVersion: 'test',
    ...overrides,
  };
}

/**
 * A cart's price as every screen reads it — in baht, `total` being what the
 * guest is shown. The platform's unless `overrides` say otherwise.
 */
export function cartQuote(total: number, overrides: Partial<CartQuote> = {}): CartQuote {
  return {
    totals: {
      subtotal: total,
      discountAmount: 0,
      scannedDiscounts: [],
      manualDiscountAmount: 0,
      manualAmounts: {},
      serviceChargeTotal: 0,
      taxTotal: 0,
      taxBreakdown: {
        netSubtotal: total,
        discountTotal: 0,
        serviceChargeTotal: 0,
        exclusiveTaxTotal: 0,
        inclusiveTaxTotal: 0,
        taxTotal: 0,
        categories: [],
        grandTotal: total,
      },
      total,
    },
    satang: null,
    source: 'platform',
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    engineVersion: 'test',
    ...overrides,
  };
}

/** Let every promise the code under test is waiting on run to its next await. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}
