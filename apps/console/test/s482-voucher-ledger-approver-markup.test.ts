import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VoucherLedgerRow } from '@/api/vouchers';

vi.mock('@/auth/SessionContext', () => ({
  useSession: () => null,
  displayName: () => 'ZZ Admin',
}));

const { LedgerRow, ledgerIssuedBy } = await import('@/pages/Vouchers');

/**
 * SCRUM-482 — the Console's voucher ledger names the manager who approved a
 * credit voucher on the spot, beside "Issued by": "Som (S-…)", then
 * "Approved by Khun Lek (S-…)". A voucher nobody approved reads as before.
 */

const row = (over: Partial<VoucherLedgerRow> = {}): VoucherLedgerRow => ({
  id: '01964800-0000-7000-8000-000000000482',
  issuedAt: '2026-11-19T04:00:00.000Z',
  businessDate: '2026-11-19',
  type: { id: '01964800-0000-7000-8000-0000000004d1', code: 'zz-credit', nameEn: 'ZZ TEST ฿1 credit', nameTh: null, kind: 'wallet_credit' },
  prize: null,
  value: { kind: 'money', text: '฿1.00 wallet credit', redeemedSatang: null },
  place: { kind: 'counter', stationId: null, name: 'Counter (station not recorded)' },
  staffLabel: null,
  issuedBy: { accountId: '01964800-0000-7000-8000-0000000000a2', name: 'Som (Reception)', code: 'S-SOM2' },
  approvedBy: { accountId: '01964800-0000-7000-8000-0000000000a4', name: 'Khun Lek (Manager)', code: 'S-LEK4' },
  codeLast4: 'AB12',
  source: 'manual',
  status: 'issued',
  printCount: 1,
  expiresAt: null,
  redeemed: null,
  ...over,
});

describe('the ledger names the approver beside the issuer (SCRUM-482)', () => {
  it('a credit voucher approved on the spot: issued by reception, approved by the manager', () => {
    expect(ledgerIssuedBy(row())).toEqual({
      issuedBy: 'Som (Reception) (S-SOM2)',
      approvedBy: 'Approved by Khun Lek (Manager) (S-LEK4)',
    });
    const html = renderToStaticMarkup(createElement(LedgerRow, { row: row(), timezone: 'Asia/Bangkok' }));
    expect(html).toContain('Som (Reception) (S-SOM2)');
    expect(html).toContain('data-testid="ledger-approved-by"');
    expect(html).toContain('Approved by Khun Lek (Manager) (S-LEK4)');
    expect(html.indexOf('Som (Reception)')).toBeLessThan(html.indexOf('Approved by'));
  });

  it('a voucher nobody approved, or an api older than the field, has no approver line', () => {
    const older = row();
    delete older.approvedBy;
    for (const r of [row({ approvedBy: null }), older]) {
      const html = renderToStaticMarkup(createElement(LedgerRow, { row: r, timezone: 'Asia/Bangkok' }));
      expect(html).toContain('Som (Reception) (S-SOM2)');
      expect(html).not.toContain('Approved by');
    }
    expect(ledgerIssuedBy(row({ issuedBy: null, approvedBy: null })).issuedBy).toBe('Unattributed');
  });
});
