import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WALLET_TENDER_CODE } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { scanWallet, walletEntriesOf, walletKeyOf, wristbandOfWallet, type ApiWalletRead } from '@/api/wallet';
import { fnbPaymentResult, walletBalanceAfter } from '@/components/fnb/FnbPayment';
import { refundSliceWords, restorableCreditSatang, tenderLabel } from '@/components/history/SaleDetail';
import { MerchCustomerDisplay } from '@/components/merch/MerchCustomerDisplay';
import type { PaymentSettlement } from '@/lib/usePaymentStage';
import type { Wristband } from '@/types';

/**
 * S2-14a round 2 — the till's credit surfaces on the platform's figures (plan
 * §2.3-2.4, §6): the scanned tab is the platform wallet, the receipt and the
 * History detail read the credit the platform took, the refund dialog offers
 * only what can still go back, and the shop display stops subtracting credit
 * the station is not taking (the prototype bug, fixed rather than ported).
 */
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: null, can: () => false }),
}));
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
}));

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.restoreAllMocks();
});

const read: ApiWalletRead = {
  wallet: {
    id: '01990000-0000-7000-8000-000000000001',
    branchId: '01990000-0000-7000-8000-0000000000b1',
    memberId: null,
    holderName: 'Walk-in guest',
    status: 'active',
    balanceSatang: 12_550,
    keys: [
      { kind: 'band', display: 'T1-7KMQ4X' },
      { kind: 'voucher_qr', display: 'QR-ABCDEFGHJKMNPQRSTVWX' },
    ],
    createdAt: '2026-10-01T03:00:00.000Z',
  },
  ledger: [
    { id: 'e1', kind: 'grant', source: 'ticket_sale', amountSatang: 35_000, balanceAfterSatang: 35_000, saleId: 's1', refundId: null, branchId: 'b', stationId: null, offline: false, businessDate: '2026-10-01', actorName: 'Som', expiresAt: '2026-10-01T22:00:00.000Z', at: '2026-10-01T03:00:00.000Z' },
    { id: 'e2', kind: 'spend', source: 'fnb_order', amountSatang: -22_450, balanceAfterSatang: 12_550, saleId: 's2', refundId: null, branchId: 'b', stationId: null, offline: false, businessDate: '2026-10-01', actorName: null, expiresAt: null, at: '2026-10-01T04:00:00.000Z' },
  ],
};

describe('the scanned tab is the platform wallet', () => {
  it('builds the tab from the wallet: its balance, its ledger, and the key the press spends', () => {
    const wb = wristbandOfWallet(read, ' T1-7KMQ4X ');
    expect(wb).toMatchObject({ id: read.wallet.id, code: 'T1-7KMQ4X', qrCode: 'QR-ABCDEFGHJKMNPQRSTVWX', creditBalanceTHB: 125.5, customerNickname: 'Walk-in guest' });
    expect(walletKeyOf(wb)).toBe('T1-7KMQ4X');
    expect(wb.ledger).toEqual([
      { kind: 'grant', amountTHB: 350, source: 'ticket_sale', at: '2026-10-01T03:00:00.000Z', by: 'Som', expiresAt: '2026-10-01T22:00:00.000Z' },
      { kind: 'spend', amountTHB: -224.5, source: 'fnb_order', at: '2026-10-01T04:00:00.000Z' },
    ]);
    // An expired wallet offers no credit the platform will refuse.
    expect(wristbandOfWallet({ ...read, wallet: { ...read.wallet, status: 'expired' } }, 'x').creditBalanceTHB).toBe(0);
    expect(walletEntriesOf([{ ...read.ledger[0]!, kind: 'reactivate' }])[0]!.kind).toBe('grant');
  });

  it('a key no wallet carries is null; a lookup that could not be made is thrown, never read as no credit', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce(read);
    await expect(scanWallet('QR-ABCDEFGHJKMNPQRSTVWX')).resolves.toMatchObject({ creditBalanceTHB: 125.5 });
    vi.spyOn(api, 'get').mockRejectedValueOnce(new ApiError(404, 'WALLET_NOT_FOUND', 'No wallet'));
    await expect(scanWallet('1001')).resolves.toBeNull();
    vi.spyOn(api, 'get').mockRejectedValueOnce(new NetworkError('offline'));
    await expect(scanWallet('1001')).rejects.toBeInstanceOf(NetworkError);
    await expect(scanWallet('   ')).resolves.toBeNull();
  });
});

describe('the order record and the confirmation read the platform’s credit', () => {
  const settlements: PaymentSettlement[] = [
    { attemptId: 'a1', method: WALLET_TENDER_CODE, kind: 'other', amountSatang: 20_000, tenderedSatang: 20_000, changeSatang: 0, walletBalanceAfterSatang: 0 },
    { attemptId: 'a2', method: 'park-cash', kind: 'cash', amountSatang: 34_000, tenderedSatang: 40_000, changeSatang: 6_000 },
  ];
  it('credit is its own figure — never cash, card or QR', () => {
    expect(fnbPaymentResult(settlements)).toMatchObject({ creditUsed: 200, cash: 340, card: 0, promptpay: 0 });
    expect(walletBalanceAfter(settlements)).toBe(0);
    expect(walletBalanceAfter(settlements.slice(1))).toBeNull();
  });
});

describe('History and the refund dialog', () => {
  it('names the stored-value tender "Credit" and its refund slice as back on the wallet', () => {
    expect(tenderLabel({ method: 'wallet' }, { note: null })).toBe('Credit');
    expect(refundSliceWords({ method: 'wallet', route: 'wallet', status: 'done', detail: null }).text).toBe('Credit — back on the wallet');
    expect(refundSliceWords({ method: 'wallet', route: 'wallet', status: 'done', detail: 'Put back on the wallet it was spent from' }).text).toBe(
      'Credit — Put back on the wallet it was spent from',
    );
  });

  it('offers only the credit not yet restored', () => {
    const attempts = [
      { method: 'wallet' as const, status: 'approved' as const, amountSatang: 5_000 },
      { method: 'cash' as const, status: 'approved' as const, amountSatang: 4_000 },
      { method: 'wallet' as const, status: 'declined' as const, amountSatang: 9_000 },
    ];
    expect(restorableCreditSatang(attempts, [])).toBe(5_000);
    expect(restorableCreditSatang(attempts, [{ tenderAllocation: [{ route: 'wallet', status: 'done', amountSatang: 3_000 }, { route: 'cash', status: 'done', amountSatang: 1_000 }] }])).toBe(2_000);
    expect(restorableCreditSatang(attempts, [{ tenderAllocation: [{ route: 'wallet', status: 'done', amountSatang: 5_000 }] }])).toBe(0);
  });
});

describe('the shop display shows only the credit the station takes (plan §6)', () => {
  const wristband = { id: 'w', code: 'T1-7KMQ4X', customerNickname: 'Guest', creditBalanceTHB: 500, gateAccess: false } as Wristband;
  const render = (creditSatang: number) =>
    renderToStaticMarkup(
      React.createElement(MerchCustomerDisplay, {
        stage: 'payment',
        wristband,
        lines: [],
        manualDiscounts: [],
        total: 120,
        taxBreakdown: { netSubtotal: 0, discountTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, grandTotal: 120, serviceChargeTotal: 0, categories: [] } as never,
        promptpayAmount: null,
        completedOrder: null,
        newBalance: null,
        creditSatang,
      }),
    );

  it('a band with ฿500 and no credit taken: the whole ฿120 is to pay, nothing "from your credit"', () => {
    const html = render(0);
    expect(html).not.toContain('merch.payment.fromCredit');
    expect(html).toContain('merch.payment.toPay');
    expect(html).toContain('฿120');
  });

  it('credit really taken: from your credit, and what is left to pay', () => {
    const html = render(5_000);
    expect(html).toContain('merch.payment.fromCredit');
    expect(html).toContain('merch.payment.leftToPay');
    expect(html).toContain('฿50');
    expect(html).toContain('฿70');
  });
});
