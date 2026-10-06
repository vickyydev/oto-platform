import { describe, expect, it } from 'vitest';
import {
  DisplayFnbCartSchema,
  DisplayMerchCartSchema,
  DisplayPaymentSchema,
  projectDisplayDiagnosticDocument,
  readDisplayFnbCart,
  readDisplayMerchCart,
} from '../src';

/**
 * S2-14a round 2 (gate finding R2-G1) — THE CREDIT CROSSES TO THE SEPARATE
 * DISPLAY as a figure: the payment frame keeps `creditSatang`, a thank-you's
 * settled tenders may carry `credit`, and the sum check holds the four to the
 * total. Nothing of the wallet itself — key, balance, holder — is in the schema.
 */
const payment = {
  saleId: 'sale-1', amountSatang: 4_000, qrPayload: null, qrImageUrl: null, expiresAt: null,
  status: 'idle', offline: false, online: true,
};

describe('the payment frame carries the credit being taken', () => {
  it('keeps creditSatang, and reads without it as before', () => {
    expect(DisplayPaymentSchema.parse({ ...payment, creditSatang: 5_000 }).creditSatang).toBe(5_000);
    expect(DisplayPaymentSchema.parse(payment).creditSatang).toBeUndefined();
    for (const bad of [-1, 1.5, 'five']) expect(DisplayPaymentSchema.safeParse({ ...payment, creditSatang: bad }).success).toBe(false);
    // A wallet is not a figure: anything of it is stripped at the boundary.
    const parsed = DisplayPaymentSchema.parse({ ...payment, creditSatang: 5_000, wallet: { key: 'QR-PRIVATE', balanceSatang: 9 } });
    expect(JSON.stringify(parsed)).not.toContain('QR-PRIVATE');
  });

  it('survives the diagnostic projection the Console reads', () => {
    const projected = projectDisplayDiagnosticDocument({
      stationId: '018f0000-0000-7000-8000-000000000001', boxId: '018f0000-0000-7000-8000-000000000002',
      schemaVersion: 1, sequence: 4, stage: 'payment', language: 'en', takeoverCount: 0, updatedAt: '2026-10-01T12:00:00.000Z',
      cart: { kind: 'fnb', supported: true, lines: [{ id: 'l', name: 'Fries', qty: 1, basePrice: 90, lineTotal: 90, modifiers: [] }],
        orderNote: '', manualDiscounts: [], completion: null },
      totals: { manualAmounts: {}, discountAmount: 0, total: 90, taxBreakdown: { serviceChargeTotal: 0, categories: [] } },
      payment: { ...payment, creditSatang: 5_000 },
    });
    expect(projected?.payment).toMatchObject({ amountSatang: 4_000, creditSatang: 5_000 });
  });
});

describe('a thank-you settled partly or wholly with credit', () => {
  const fnb = { kind: 'fnb', supported: true, lines: [{ id: 'l', name: 'Fries', qty: 1, basePrice: 90, lineTotal: 90, modifiers: [] }],
    orderNote: '', manualDiscounts: [] };
  const merch = { kind: 'merch', supported: true, lines: [{ id: 'l', name: 'Socks', qty: 1, unitPrice: 90, lineTotal: 90 }], manualDiscounts: [] };

  it('F&B: credit counts toward the total, and a figure that does not add up is refused', () => {
    const completion = { saleId: 's', pickupCode: 'A1', total: 90, payment: { cash: 40, card: 0, promptpay: 0, credit: 50 } };
    expect(readDisplayFnbCart({ ...fnb, completion }, 'thankyou')?.completion).toEqual(completion);
    expect(DisplayFnbCartSchema.safeParse({ ...fnb, completion: { ...completion, payment: { cash: 40, card: 0, promptpay: 0 } } }).success).toBe(false);
    expect(DisplayFnbCartSchema.safeParse({ ...fnb, completion: { ...completion, payment: { cash: 0, card: 0, promptpay: 0, credit: 90 } } }).success).toBe(true);
    expect(DisplayFnbCartSchema.safeParse({ ...fnb, completion: { ...completion, payment: { ...completion.payment, credit: 51 } } }).success).toBe(false);
  });

  it('shop: the same', () => {
    const completion = { saleId: 's', total: 90, payment: { cash: 0, card: 0, promptpay: 0, credit: 90 } };
    expect(readDisplayMerchCart({ ...merch, completion }, 'thankyou')?.completion).toEqual(completion);
    expect(DisplayMerchCartSchema.safeParse({ ...merch, completion: { ...completion, payment: { cash: 0, card: 0, promptpay: 0 } } }).success).toBe(false);
    expect(DisplayMerchCartSchema.safeParse({ ...merch, completion: { ...completion, payment: { cash: 10, card: 0, promptpay: 0, credit: 80 } } }).success).toBe(true);
  });
});
