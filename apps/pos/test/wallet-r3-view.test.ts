import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WalletEntryView, WalletView } from '@oto/shared';
import { api, ApiError } from '@/api/client';
import { getCreditDay, reactivateWallet, walletSpendable, walletSpendableSatang, wristbandOfWallet } from '@/api/wallet';
import { adminPanelsById, panelGroupMap, visibleNavFor } from '@/components/admin/adminSections';
import { withCreditLine } from '@/lib/endOfDay';
import { platformWalletCreditReport } from '@/lib/reporting';
import {
  bahtOf,
  lapsedPartSatang,
  ledgerNewestFirst,
  reactivatableSatang,
  reactivationReasonError,
  walletEntryLabel,
  walletViewStatus,
} from '@/lib/walletView';
import * as catalogStore from '@/store/catalogStore';
import type { Branch, EndOfDay } from '@/types';

/**
 * S2-14a round 3 — the till's half of expiry, the Wallet view and the figures
 * (plan docs/progress/plans/wallet/PLAN.md §2.5):
 *
 *   - the view's words: active / expired / lapsed (expiry passed, job not yet run);
 *   - what a reactivation brings back: exactly the last expiry, only while it is
 *     the latest credit movement on a closed wallet; a blank reason refused;
 *   - a lapsed wallet offers no credit at the counter;
 *   - the Wallets panel is offered to pos:wallet:read, beside the report;
 *   - the Wallet & Promo report reads the platform, in the prototype's shapes;
 *   - the End of day credit line takes the platform's figure on an open day only.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = Date.parse('2026-10-01T10:00:00.000Z');

function view(extra: Partial<WalletView> = {}): WalletView {
  return {
    id: '0192d5a0-0000-7000-8000-000000000001', branchId: null, memberId: null, holderName: 'Walk-in guest',
    status: 'active', balanceSatang: 5_000, keys: [{ kind: 'voucher_qr', display: 'QR-ABCDEFGHJKMNPQRSTVWX' }],
    createdAt: '2026-10-01T03:00:00.000Z', expiresAt: '2026-10-01T22:00:00.000Z', ...extra,
  };
}

let seq = 0;
function entry(kind: WalletEntryView['kind'], amountSatang: number, at: string, extra: Partial<WalletEntryView> = {}): WalletEntryView {
  seq += 1;
  return {
    id: `0192d5a0-0000-7000-8000-${String(seq).padStart(12, '0')}`, kind,
    source: kind === 'grant' ? 'ticket_sale' : kind === 'spend' ? 'fnb_order' : kind === 'expire' ? 'expiry' : kind === 'reactivate' ? 'reactivation' : 'refund',
    amountSatang, balanceAfterSatang: 0, saleId: null, refundId: null, branchId: null, stationId: null, offline: false,
    businessDate: at.slice(0, 10), actorName: null, expiresAt: null, at, ...extra,
  };
}

describe('the Wallet view’s words', () => {
  it('active, expired by the job, and lapsed — past its expiry before the job ran', () => {
    expect(walletViewStatus(view(), NOW)).toBe('active');
    expect(walletViewStatus(view({ status: 'expired' }), NOW)).toBe('expired');
    expect(walletViewStatus(view({ expiresAt: '2026-10-01T09:59:59.000Z' }), NOW)).toBe('lapsed');
    expect(walletViewStatus(view({ expiresAt: null }), NOW)).toBe('active');
  });

  it('lapsed by the platform’s own count: every baht dead by its own date, whatever the newest load says', () => {
    // Loaded again today after yesterday's credit died: the view is active with a lapsed part…
    expect(walletViewStatus(view({ balanceSatang: 30_000, lapsedSatang: 20_000 }), NOW)).toBe('active');
    expect(lapsedPartSatang(view({ balanceSatang: 30_000, lapsedSatang: 20_000 }), NOW)).toBe(20_000);
    // …and lapsed outright when all of it has.
    expect(walletViewStatus(view({ balanceSatang: 30_000, lapsedSatang: 30_000 }), NOW)).toBe('lapsed');
    expect(lapsedPartSatang(view({ balanceSatang: 30_000, lapsedSatang: 30_000 }), NOW)).toBe(0);
    // An answer from before the fix has no count: nothing lapsed.
    expect(lapsedPartSatang(view({ balanceSatang: 30_000 }), NOW)).toBe(0);
    expect(walletViewStatus(view({ balanceSatang: 0, lapsedSatang: 0 }), NOW)).toBe('active');
  });

  it('lists the ledger newest first with the popover’s words', () => {
    const ledger = [entry('grant', 5_000, '2026-09-30T05:00:00.000Z'), entry('spend', -1_200, '2026-09-30T06:00:00.000Z')];
    expect(ledgerNewestFirst(ledger).map((e) => e.kind)).toEqual(['spend', 'grant']);
    expect(walletEntryLabel(ledger[1]!)).toEqual({ kind: 'spend', source: 'fnb order' });
    expect(bahtOf(1_250)).toBe('฿12.5');
    expect(bahtOf(30_000)).toBe('฿300');
  });
});

describe('what a reactivation brings back', () => {
  const grant = entry('grant', 5_000, '2026-09-30T05:00:00.000Z');
  const spend = entry('spend', -1_200, '2026-09-30T06:00:00.000Z');
  const expire = entry('expire', -3_800, '2026-09-30T22:01:00.000Z');

  it('exactly the last expiry, on a closed wallet', () => {
    expect(reactivatableSatang(view({ status: 'expired', balanceSatang: 0 }), [grant, spend, expire])).toBe(3_800);
  });

  it('nothing while the wallet is active, after the credit was brought back, or when it closed at ฿0 with no expiry', () => {
    expect(reactivatableSatang(view(), [grant, spend, expire])).toBeNull();
    const back = entry('reactivate', 3_800, '2026-10-01T03:00:00.000Z');
    expect(reactivatableSatang(view({ status: 'expired' }), [grant, spend, expire, back])).toBeNull();
    expect(reactivatableSatang(view({ status: 'expired' }), [grant, entry('spend', -5_000, '2026-09-30T07:00:00.000Z')])).toBeNull();
  });

  it('a blank reason is refused before any call', () => {
    expect(reactivationReasonError('')).toBe('Type why this credit is coming back.');
    expect(reactivationReasonError('   ')).not.toBeNull();
    expect(reactivationReasonError('Guest came back')).toBeNull();
  });

  it('sends the typed reason with one key per gesture', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ replayed: false, wallet: view(), ledger: [] });
    await reactivateWallet('wallet-1', 'Guest came back', 'key-1');
    expect(post).toHaveBeenCalledWith('/wallets/wallet-1/reactivate', { reason: 'Guest came back' }, { idempotencyKey: 'key-1' });
  });
});

describe('a lapsed wallet offers no credit at the counter', () => {
  it('reads ฿0 on the tab once its expiry has passed, even before the job closes it', () => {
    const lapsed = view({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(walletSpendable(lapsed)).toBe(false);
    expect(wristbandOfWallet({ wallet: lapsed, ledger: [] }, 'QR-ABCDEFGHJKMNPQRSTVWX').creditBalanceTHB).toBe(0);
    const live = view({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(wristbandOfWallet({ wallet: live, ledger: [] }, 'QR-ABCDEFGHJKMNPQRSTVWX').creditBalanceTHB).toBe(50);
  });

  it('offers only the part that has not lapsed on a wallet loaded again today', () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const reloaded = view({ expiresAt: soon, balanceSatang: 30_000, lapsedSatang: 20_000 });
    expect(walletSpendableSatang(reloaded)).toBe(10_000);
    expect(walletSpendable(reloaded)).toBe(true);
    expect(wristbandOfWallet({ wallet: reloaded, ledger: [] }, 'QR-ABCDEFGHJKMNPQRSTVWX').creditBalanceTHB).toBe(100);
    const allDead = view({ expiresAt: soon, balanceSatang: 30_000, lapsedSatang: 30_000 });
    expect(walletSpendableSatang(allDead)).toBe(0);
    expect(walletSpendable(allDead)).toBe(false);
    // Nothing on it: offered as ฿0 (the platform answers WALLET_EMPTY), not read as lapsed.
    expect(walletSpendable(view({ expiresAt: soon, balanceSatang: 0, lapsedSatang: 0 }))).toBe(true);
  });
});

describe('the Wallets panel', () => {
  it('is offered to pos:wallet:read, in the reports group beside the Wallet & Promo report', () => {
    expect(adminPanelsById.wallets).toMatchObject({ id: 'wallets', permission: 'pos:wallet:read' });
    expect(adminPanelsById.wallets!.localOnly).toBeFalsy();
    expect(panelGroupMap.wallets).toBe(panelGroupMap['reports-wallet']);
    // The report now reads the platform, so it no longer says it is local only.
    expect(adminPanelsById['reports-wallet']!.localOnly).toBeFalsy();
    const ids = (can: (p: string) => boolean) =>
      visibleNavFor(can).flatMap((e) => (e.kind === 'group' ? e.panels.map((p) => p.id) : [e.panel.id]));
    expect(ids((p) => p === 'pos:wallet:read')).toContain('wallets');
    expect(ids(() => false)).not.toContain('wallets');
  });
});

describe('the Wallet & Promo report reads the platform', () => {
  const branches = [
    { id: 'hkt', name: 'Central Floresta', apiId: '0192d5a0-0000-7000-8000-0000000000aa' },
    { id: 'local-only', name: 'Pop-up' },
  ] as unknown as Branch[];

  it('maps the platform’s figures and rows into the prototype’s shapes, the branch by its platform id', async () => {
    vi.spyOn(catalogStore, 'getBranches').mockReturnValue(branches);
    const get = vi.spyOn(api, 'get').mockResolvedValue({
      summary: { grantedSatang: 80_000, spentSatang: 29_000, refundedSatang: 3_000, expiredSatang: 88_000, reactivatedSatang: 38_000,
        outstandingSatang: 4_000, ledgerOutstandingSatang: 4_000, entryCount: 12 },
      rows: [{ entryId: 'e', walletId: 'w', keyDisplay: 'T1-7KMQ4X', holderName: null, kind: 'reactivate', source: 'reactivation',
        amountSatang: 38_000, businessDate: '2026-09-29', at: '2026-09-29T05:00:00.000Z', by: 'Khun Lek' }],
    });
    const report = await platformWalletCreditReport({ startDate: '2026-09-28', endDate: '2026-10-01', branchId: 'hkt' });
    expect(get.mock.calls[0]![0]).toBe('/wallets/report?from=2026-09-28&to=2026-10-01&limit=100&branchId=0192d5a0-0000-7000-8000-0000000000aa');
    expect(report.summary).toMatchObject({ grantedSatang: 80_000, spentSatang: 29_000, refundedSatang: 3_000, expiredSatang: 88_000,
      netOutstandingSatang: 4_000, ledgerOutstandingSatang: 4_000, reactivatedSatang: 38_000, entryCount: 12 });
    expect(report.rows[0]).toEqual({ wristbandCode: 'T1-7KMQ4X', customerNickname: 'Guest', kind: 'reactivate', amountSatang: 38_000,
      source: 'reactivation', at: '2026-09-29T05:00:00.000Z', by: 'Khun Lek' });

    await platformWalletCreditReport({ startDate: '2026-09-28', endDate: '2026-10-01', branchId: 'all' });
    expect(get.mock.calls[1]![0]).toBe('/wallets/report?from=2026-09-28&to=2026-10-01&limit=100');
  });

  it('a branch with no platform id has no platform figures — empty, nothing asked', async () => {
    vi.spyOn(catalogStore, 'getBranches').mockReturnValue(branches);
    const get = vi.spyOn(api, 'get');
    const report = await platformWalletCreditReport({ startDate: '2026-09-28', endDate: '2026-10-01', branchId: 'local-only' });
    expect(get).not.toHaveBeenCalled();
    expect(report.summary.entryCount).toBe(0);
  });

  it('a refusal is thrown, never read as zero', async () => {
    vi.spyOn(catalogStore, 'getBranches').mockReturnValue(branches);
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Not allowed'));
    await expect(platformWalletCreditReport({ startDate: '2026-09-28', endDate: '2026-10-01', branchId: 'hkt' })).rejects.toThrow('Not allowed');
  });
});

describe('the End of day credit line', () => {
  function record(status: EndOfDay['status']): EndOfDay {
    return {
      id: 'eod-hkt-2026-10-01', branchId: 'hkt', date: '2026-10-01', status,
      lines: [
        { channel: 'cash', expectedTHB: 1_000, actualTHB: null, differenceTHB: 0 },
        { channel: 'credit', expectedTHB: 0, actualTHB: 50, differenceTHB: 50 },
      ],
      cashCount: { countedTHB: null, floatTHB: 6_000, cashIncomeTHB: null }, floatLeftTHB: 6_000,
      vouchers: { handedOut: null, redeemed: null }, totalExpectedTHB: 1_000, totalActualTHB: 50, totalDifferenceTHB: 50,
    };
  }

  it('an open day takes the platform’s figure and its totals follow; a closed day keeps what was locked', () => {
    const open = withCreditLine(record('open'), 60);
    expect(open.lines.find((l) => l.channel === 'credit')).toMatchObject({ expectedTHB: 60, actualTHB: 50, differenceTHB: -10 });
    expect(open.totalExpectedTHB).toBe(1_060);
    const closed = record('closed');
    expect(withCreditLine(closed, 60)).toBe(closed);
  });

  it('asks the platform for the business date at the branch', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ branchId: 'b', businessDate: '2026-10-01', redeemedSatang: 9_000, restoredSatang: 3_000, netSatang: 6_000 });
    const day = await getCreditDay('b', '2026-10-01');
    expect(get).toHaveBeenCalledWith('/wallets/credit-day?branchId=b&date=2026-10-01');
    expect(day.netSatang).toBe(6_000);
  });
});
