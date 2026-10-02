import { describe, expect, it } from 'vitest';
import {
  PAID_ONLINE_TENDER_CODE,
  PAYMENT_METHOD_KINDS,
  PAYMENT_METHODS,
  WALLET_TENDER_CODE,
  WALLET_TENDER_METHOD,
  WalletTenderInstructionSchema,
  countsAsTillTakings,
  isStoredValueTender,
} from '../src/payments';
import { allocateRefund, type RefundableTender } from '../src/refund';

/**
 * S2-14a round 2 (plan §2.3, §6) — the stored-value tender in the shared
 * vocabulary: it rides the landed `wallet` method word, never widens the
 * configurable KIND list, never reads as till takings, and is never confused
 * with the terminal's Alipay/WeChat "wallet".
 */
describe('the stored-value tender', () => {
  it('rides the method word S2-10a already landed; the configurable kinds do not grow', () => {
    expect(PAYMENT_METHODS).toContain(WALLET_TENDER_METHOD);
    expect(WALLET_TENDER_METHOD).toBe('wallet');
    expect(WALLET_TENDER_CODE).toBe('wallet_credit');
    expect([...PAYMENT_METHOD_KINDS]).toEqual(['cash', 'card', 'qr', 'other']);
  });

  it('countsAsTillTakings (S2-15a, the one drawer gate): cash at a station only', () => {
    const at = 'station-1';
    const table: [{ method: string; methodCode: string | null; stationId: string | null }, boolean][] = [
      [{ method: 'cash', methodCode: 'cash', stationId: at }, true],
      // Card, QR and a terminal e-wallet (Alipay) are reconciled per terminal
      // and as QR on the End of Day — never counted out of a cash drawer.
      [{ method: 'card', methodCode: 'card', stationId: at }, false],
      [{ method: 'qr', methodCode: 'promptpay', stationId: at }, false],
      [{ method: 'qr', methodCode: 'alipay', stationId: at }, false],
      [{ method: 'transfer', methodCode: PAID_ONLINE_TENDER_CODE, stationId: at }, false],
      [{ method: 'wallet', methodCode: WALLET_TENDER_CODE, stationId: at }, false],
      // A booking-site attempt has no station: never till money.
      [{ method: 'cash', methodCode: 'cash', stationId: null }, false],
    ];
    for (const [attempt, expected] of table) {
      expect(countsAsTillTakings(attempt), JSON.stringify(attempt)).toBe(expected);
    }
    expect(countsAsTillTakings({ methodCode: PAID_ONLINE_TENDER_CODE, stationId: at })).toBe(false);
  });

  it('tells stored value from a terminal e-wallet by method and code', () => {
    expect(isStoredValueTender({ method: 'wallet', methodCode: WALLET_TENDER_CODE })).toBe(true);
    expect(isStoredValueTender({ method: 'qr', methodCode: 'promptpay' })).toBe(false);
  });

  it('the instruction says use-credit or an exact amount, never neither', () => {
    expect(WalletTenderInstructionSchema.safeParse({ key: 'QR-ABC', useCredit: true }).success).toBe(true);
    expect(WalletTenderInstructionSchema.safeParse({ key: 'QR-ABC', amountSatang: 5000 }).success).toBe(true);
    expect(WalletTenderInstructionSchema.safeParse({ key: 'QR-ABC' }).success).toBe(false);
    expect(WalletTenderInstructionSchema.safeParse({ key: ' ', useCredit: true }).success).toBe(false);
  });

  it('a refund allocates the wallet slice first, and a terminal wallet tender is not a wallet slice', () => {
    const tenders: RefundableTender[] = [
      { attemptId: 'cash', method: 'cash', methodCode: 'cash', provider: 'manual', channel: 'cash', amountSatang: 3000, refundedSatang: 0, paidAt: '2026-10-01T05:00:02Z' },
      { attemptId: 'credit', method: 'wallet', methodCode: WALLET_TENDER_CODE, provider: 'manual', channel: 'wallet', amountSatang: 5000, refundedSatang: 0, paidAt: '2026-10-01T05:00:01Z' },
      { attemptId: 'alipay', method: 'qr', methodCode: 'promptpay', provider: 'ghl', channel: 'terminal', terminalTender: 'wallet', amountSatang: 2000, refundedSatang: 0, paidAt: '2026-10-01T05:00:03Z' },
    ];
    const slices = allocateRefund(6000, tenders);
    expect(slices[0]).toMatchObject({ attemptId: 'credit', route: 'wallet', amountSatang: 5000 });
    expect(slices[1]).toMatchObject({ attemptId: 'alipay', route: 'cash', amountSatang: 1000 });
  });
});
