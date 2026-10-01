import { describe, expect, it } from 'vitest';
import {
  PROMO_VOUCHER_MESSAGES,
  VoucherCampaignBodySchema,
  VoucherPromoRulesSchema,
  VoucherTargetSchema,
  formatVoucherDay,
  voucherWindowOf,
} from '../src/voucher-promo';
import { WALLET_ENTRY_SOURCES } from '../src/wallet';

/**
 * S2-14a round 5 — the words a promotional voucher's rules may use, and the
 * counter's sentences for them.
 */

describe('the window, on a trading day', () => {
  it('is inclusive at both ends and unbounded where a side is absent', () => {
    const w = { validFrom: '2026-11-01', validUntil: '2026-11-30' };
    expect(voucherWindowOf(w, '2026-10-31')).toBe('before');
    expect(voucherWindowOf(w, '2026-11-01')).toBe('inside');
    expect(voucherWindowOf(w, '2026-11-30')).toBe('inside');
    expect(voucherWindowOf(w, '2026-12-01')).toBe('after');
    expect(voucherWindowOf({ validFrom: null, validUntil: null }, '2030-01-01')).toBe('inside');
  });

  it('says it in the counter’s words', () => {
    expect(formatVoucherDay('2026-11-01')).toBe('1 Nov 2026');
    expect(PROMO_VOUCHER_MESSAGES.notYet('2026-11-01')).toBe('This voucher can be used from 1 Nov 2026');
    expect(PROMO_VOUCHER_MESSAGES.ended('2026-11-30')).toBe('This promotion ended on 30 Nov 2026');
    expect(PROMO_VOUCHER_MESSAGES.usedUp(1)).toBe('This promotion is used up — its one redemption has been taken');
    expect(PROMO_VOUCHER_MESSAGES.usedUp(50)).toBe('This promotion is used up — all 50 redemptions have been taken');
    expect(PROMO_VOUCHER_MESSAGES.perCustomer(1)).toBe('This guest has already used this promotion once — the limit per guest');
    expect(PROMO_VOUCHER_MESSAGES.perCustomer(3)).toBe('This guest has already used this promotion 3 times — the limit per guest');
  });
});

describe('the scopes and the bodies', () => {
  it('a target is one of the engine’s scopes a voucher may aim at; a single shop item is not one', () => {
    const id = '0190f0d0-0000-7000-8000-000000000001';
    expect(VoucherTargetSchema.safeParse({ kind: 'fnbCategory', category: id }).success).toBe(true);
    expect(VoucherTargetSchema.safeParse({ kind: 'menuItems', menuItemIds: [id] }).success).toBe(true);
    expect(VoucherTargetSchema.safeParse({ kind: 'menuItems', menuItemIds: [] }).success).toBe(false);
    expect(VoucherTargetSchema.safeParse({ kind: 'everything' }).success).toBe(false);
    expect(VoucherTargetSchema.safeParse({ kind: 'merchItem', id }).success).toBe(false);
  });

  it('limits are positive whole numbers; null clears one', () => {
    expect(VoucherPromoRulesSchema.safeParse({ usageLimit: 1, perCustomerLimit: null }).success).toBe(true);
    expect(VoucherPromoRulesSchema.safeParse({ usageLimit: 0 }).success).toBe(false);
    expect(VoucherPromoRulesSchema.safeParse({ perCustomerLimit: 1.5 }).success).toBe(false);
    expect(VoucherPromoRulesSchema.safeParse({ validFrom: '1 Nov' }).success).toBe(false);
  });

  it('a campaign mints between 1 and 5000 codes under a name', () => {
    const base = { definitionId: '0190f0d0-0000-7000-8000-000000000001', branchId: '0190f0d0-0000-7000-8000-000000000002' };
    expect(VoucherCampaignBodySchema.safeParse({ ...base, name: 'Oct', quantity: 5000 }).success).toBe(true);
    expect(VoucherCampaignBodySchema.safeParse({ ...base, name: 'Oct', quantity: 5001 }).success).toBe(false);
    expect(VoucherCampaignBodySchema.safeParse({ ...base, name: '  ', quantity: 1 }).success).toBe(false);
  });

  it('a wallet entry may come from a promotional voucher', () => {
    expect(WALLET_ENTRY_SOURCES).toContain('promo_voucher');
  });
});
