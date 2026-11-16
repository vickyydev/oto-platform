import { describe, expect, it } from 'vitest';
import { additionalBillFigures, paymentBillOf } from '../src/services/party-additional-bills';
import type { PartyAdditionalBill } from '@oto/shared';

const bill = (id: string, outstandingSatang: number): PartyAdditionalBill => ({ id, eventId: 'same-party', mainSettlementId: 'original-paid-receipt', state: outstandingSatang ? 'open' : 'paid', totalSatang: 10001, paidSatang: 10001 - outstandingSatang, outstandingSatang, createdAt: '2026-11-16T00:00:00Z', paidAt: null, charges: [], payments: [] });

describe('SCRUM-990 adversarial linked additional bill pins', () => {
  it('HIGH: exact satang figures keep the last satang open, with no old receipt/deposit subtraction', () => {
    expect(additionalBillFigures([{ totalSatang: 10001 }], [{ amountSatang: 10000, takenAt: '2026-11-16T01:00:00Z' }])).toMatchObject({ totalSatang: 10001, paidSatang: 10000, outstandingSatang: 1, state: 'open', paidAt: null });
    expect(additionalBillFigures([{ totalSatang: 10001 }], [{ amountSatang: 10000, takenAt: '2026-11-16T01:00:00Z' }, { amountSatang: 1, takenAt: '2026-11-16T02:00:00Z' }])).toMatchObject({ outstandingSatang: 0, state: 'paid', paidAt: '2026-11-16T02:00:00Z' });
  });
  it('HIGH: an open additional bill requires explicit selection; no fallback to the old tab balance', () => {
    expect(() => paymentBillOf([bill('new', 100)], undefined)).toThrow(/Choose the additional bill/);
  });
  it('HIGH: a foreign bill id and a paid bill cannot be targeted for this party', () => {
    expect(() => paymentBillOf([bill('ours', 100)], 'foreign')).toThrow(/not found for this party/);
    expect(() => paymentBillOf([bill('paid', 0)], 'paid')).toThrow(/already paid/);
  });
  it('keeps older unassigned tab payments available when there is no open new bill', () => {
    expect(paymentBillOf([bill('old-paid', 0)], undefined)).toBeNull();
    expect(paymentBillOf([bill('selected', 1)], 'selected')?.outstandingSatang).toBe(1);
  });
});
