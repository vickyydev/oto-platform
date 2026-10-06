import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { vouchersApi, type VoucherView } from '@/api/vouchers';
import { voucherPromotionsApi } from '@/api/voucherPromotions';
import { adminPanelsById, visibleNavFor } from '@/components/admin/adminSections';
import { voucherIsGift, voucherSourceLabel } from '@/components/till/RedeemVoucher';
import type { HeldVoucher } from '@/lib/tillVoucher';

/**
 * S2-14a round 5 — the till's and the back office's half of promotional
 * vouchers. Nothing here decides a rule: the tests pin that the till carries
 * the platform's answers to the right routes and treats a wallet-credit
 * voucher as the sale on its own the platform rings it up as.
 */

const view = (effect: VoucherView['effect'], source = 'booth'): VoucherView => ({
  id: 'v-1',
  code: 'CPABCDEFGHJ',
  source,
  state: 'held_here',
  prize: { nameEn: 'Prize', nameTh: null },
  definitionCode: 'def',
  kind: 'discount',
  effect,
  summary: '',
  issuedAt: new Date().toISOString(),
  issuedBooth: null,
  issuedBranch: { id: 'b', name: 'Branch' },
  expiresAt: null,
  legacyFormat: false,
  hold: null,
  redeemableOffline: false,
  issuedBy: null,
});

const held = (effect: VoucherView['effect']): HeldVoucher => ({ code: 'CPABCDEFGHJ', saleId: 's-1', view: view(effect) }) as HeldVoucher;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a wallet-credit voucher is a sale on its own, like a hand-over prize', () => {
  it('rings up with nothing else on the cart; a discount voucher does not', () => {
    expect(voucherIsGift(held({ type: 'wallet_credit', valueSatang: 10_000 }))).toBe(true);
    expect(voucherIsGift(held({ type: 'hand_over' }))).toBe(true);
    expect(voucherIsGift(held({ type: 'amount_off', appliesTo: 'category', valueSatang: 5_000, label: 'Drinks' }))).toBe(false);
    expect(voucherIsGift(null)).toBe(false);
  });

  it('the card names where the paper came from', () => {
    expect(voucherSourceLabel('booth')).toBe('Lucky Wheel voucher');
    expect(voucherSourceLabel('campaign')).toBe('Campaign voucher');
    expect(voucherSourceLabel('manual')).toBe('Till voucher');
  });
});

describe('the routes the till and the back office call', () => {
  it('issue, credit and its print, the issuable list', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({} as never);
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    await vouchersApi.issuable();
    await vouchersApi.issue('d-1', null, 'key-1');
    await vouchersApi.issue('d-1', 'm-1', 'key-2');
    await vouchersApi.credit('v-1');
    await vouchersApi.printCredit('v-1');
    expect(get.mock.calls.map((c) => c[0])).toEqual(['/vouchers/issuable', '/vouchers/v-1/credit']);
    expect(post.mock.calls[0]).toEqual(['/vouchers/issue', { definitionId: 'd-1' }, { idempotencyKey: 'key-1' }]);
    expect(post.mock.calls[1]).toEqual(['/vouchers/issue', { definitionId: 'd-1', memberId: 'm-1' }, { idempotencyKey: 'key-2' }]);
    expect(post.mock.calls[2]![0]).toBe('/vouchers/v-1/credit/print');
  });

  it('the foregone-revenue line, the rules and the campaign', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({} as never);
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    await voucherPromotionsApi.report({ branchApiId: 'b-1', from: '2026-10-01', to: '2026-10-31' });
    await voucherPromotionsApi.report({ from: '2026-10-01', to: '2026-10-31' });
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      '/vouchers/promotions/report?from=2026-10-01&to=2026-10-31&branchId=b-1',
      '/vouchers/promotions/report?from=2026-10-01&to=2026-10-31',
    ]);
    await voucherPromotionsApi.saveRules('d-1', { usageLimit: 10, target: { kind: 'merch' } });
    expect(patch.mock.calls[0]![0]).toBe('/voucher-definitions/d-1');
    expect(patch.mock.calls[0]![1]).toEqual({ usageLimit: 10, target: { kind: 'merch' } });
    await voucherPromotionsApi.mintCampaign({ definitionId: 'd-1', branchId: 'b-1', name: 'Oct', quantity: 50 }, 'k');
    expect(post.mock.calls[0]).toEqual(['/voucher-campaigns', { definitionId: 'd-1', branchId: 'b-1', name: 'Oct', quantity: 50 }, { idempotencyKey: 'k' }]);
    expect(voucherPromotionsApi.codesHref('c-1')).toBe('/api/voucher-campaigns/c-1/codes');
  });
});

describe('the Voucher Promotions panel is offered to the booth admin’s read', () => {
  it('asks admin:booth:read, the permission its routes declare', () => {
    expect(adminPanelsById['voucher-promotions']?.permission).toBe('admin:booth:read');
    const offered = (perms: string[]) =>
      visibleNavFor((p) => perms.includes(p))
        .flatMap((entry) => (entry.kind === 'group' ? entry.panels : [entry.panel]))
        .map((p) => p.id);
    expect(offered(['admin:booth:read'])).toContain('voucher-promotions');
    expect(offered(['pos:sale:create'])).not.toContain('voucher-promotions');
  });
});
