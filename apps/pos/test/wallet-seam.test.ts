import { describe, expect, it } from 'vitest';
import { grantsOf, walletQrFor, type ApiWalletGrant } from '../src/api/wallet';
import { platformPrintOutcome, reportsCreditVoucher } from '../src/lib/salePrinting';
import type { ApiSalePrintJob } from '../src/api/history';

/**
 * S2-14a round 1 — the payment-done screen's seam onto the platform's grants.
 *
 * The "Credit Grants to Print" block lights up when the sale's own paper
 * carries a credit voucher, and each F&B-credit row shows the wallet's ONE QR
 * — the one its voucher printed — paired by person order (plan §6: the
 * prototype seeded the screen's QR from the grant id, a second code for the
 * same wallet).
 */

const grant = (personIndex: number, qrCode: string): ApiWalletGrant => ({
  walletId: `00000000-0000-7000-8000-00000000000${personIndex}`,
  role: personIndex === 0 ? 'adult' : 'kid',
  personIndex,
  creditSatang: 35_000,
  qrCode,
  holderName: 'Walk-in guest',
  gateAccess: personIndex === 0,
  bandShortCode: null,
  expiresAt: null,
});

const job = (over: Partial<ApiSalePrintJob>): ApiSalePrintJob =>
  ({
    id: 'job-1',
    kind: 'credit_voucher',
    role: 'receipt',
    status: 'queued',
    stationId: null,
    deviceId: null,
    deviceLabel: 'Receipt printer',
    subjectType: 'wallet',
    subjectId: 'w-1',
    reprintOf: null,
    reprintReason: null,
    requestedByName: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: null,
    ...over,
  }) as ApiSalePrintJob;

describe('the platform grants on the payment-done screen', () => {
  it('reads the grants off a sale answer, and nothing off one from before wallets', () => {
    expect(grantsOf({ grants: [grant(0, 'QR-A')] })).toHaveLength(1);
    expect(grantsOf({ sale: {} })).toBeNull();
    expect(grantsOf(null)).toBeNull();
  });

  it('pairs the i-th credit row with the i-th earning person’s ONE QR', () => {
    const grants = [grant(1, 'QR-KID'), grant(0, 'QR-ADULT')];
    expect(walletQrFor(grants, 0)).toBe('QR-ADULT');
    expect(walletQrFor(grants, 1)).toBe('QR-KID');
    expect(walletQrFor(grants, 2)).toBeNull();
    expect(walletQrFor(null, 0)).toBeNull();
  });

  it('a queued credit voucher lights the block and is named on the printing toast', () => {
    expect(reportsCreditVoucher([job({})])).toBe(true);
    expect(reportsCreditVoucher([job({ reprintOf: 'job-0' })])).toBe(false);
    expect(platformPrintOutcome([job({}), job({ id: 'job-2' })]).sent).toEqual([
      { label: 'F&B credit voucher ×2', device: 'Receipt printer' },
    ]);
  });
});
