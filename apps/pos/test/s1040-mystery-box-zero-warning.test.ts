import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VoucherView } from '@/api/vouchers';
import { VoucherCard, VoucherFreeItemLine, prizeStockWarning, voucherIsGift } from '@/components/till/RedeemVoucher';
import type { HeldVoucher } from '@/lib/tillVoucher';

/**
 * SCRUM-1040 — MYSTERY BOX AT ZERO, ON THE TILL'S VOUCHER CARD.
 *
 * The Mystery Box is a stock item, and using its voucher takes one off the
 * park's count (`takeStockForPrize` on the platform). The count can be behind
 * the shelf and the family has won the prize, so when the scan answers that
 * the count holds none, the card warns staff in the till's own "Out of stock"
 * words (`MerchGrid`) — and the prize is still rung up and handed over: the
 * card keeps its "Hand over" figure and its ฿0 line, and nothing is blocked.
 */

// The panel is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const view: VoucherView = {
  id: '0190a0a0-0000-7000-8000-000000001040',
  code: 'B1ABCDEFGHJ',
  source: 'booth',
  state: 'held_here',
  prize: { nameEn: 'ZZ TEST Mystery Box', nameTh: null },
  definitionCode: 'zz-test-mystery-box',
  kind: 'manual',
  effect: { type: 'hand_over' },
  summary: 'Ring up to use it, then hand over: ZZ TEST Mystery Box',
  issuedAt: '2026-11-19T05:00:00.000Z',
  issuedBooth: { stationId: '0190a0a0-0000-7000-8000-000000001041', name: 'Booth 1', codePrefix: 'B1' },
  issuedBranch: { id: 'b', name: 'Central Floresta' },
  expiresAt: null,
  legacyFormat: false,
  hold: null,
  redeemableOffline: false,
  staffLabel: null,
  issuedBy: null,
  prizeStock: { name: 'ZZ TEST Mystery Box', available: 0 },
};
const held = (over: Partial<VoucherView> = {}): HeldVoucher => ({
  view: { ...view, ...over },
  code: view.code,
  saleId: '0190a0a0-0000-7000-8000-000000001042',
});

const markup = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const WARNING = 'Out of stock: the count says no ZZ TEST Mystery Box is left. You can still hand it over.';

describe('a hand-over prize the count says is gone', () => {
  it('is said plainly, from the platform’s count', () => {
    expect(prizeStockWarning(view)).toBe(WARNING);
  });

  it('says nothing while the count holds one, for a prize with no stock item, or for any other voucher', () => {
    expect(prizeStockWarning({ ...view, prizeStock: { name: 'ZZ TEST Mystery Box', available: 1 } })).toBeNull();
    expect(prizeStockWarning({ ...view, prizeStock: null })).toBeNull();
    // An api that does not send the field yet reads as "no stock item".
    expect(prizeStockWarning({ effect: view.effect })).toBeNull();
    expect(
      prizeStockWarning({ effect: { type: 'free_item', product: { id: 'p', name: 'Kids Pizza', kind: 'menu', priceSatang: 22_000, weekendPriceSatang: 22_000 } }, prizeStock: { name: 'x', available: 0 } }),
    ).toBeNull();
  });

  it('shows on the card in the till’s out-of-stock line, and the prize is still the cart’s to hand over', () => {
    const card = markup(createElement(VoucherCard, { held: held(), quoted: null }));
    expect(card).toContain('data-testid="voucher-prize-stock"');
    expect(card).toContain(WARNING);
    expect(card).toContain('text-destructive');
    // Not a refusal: the figure is still "Hand over", the slip still rings up on its own at ฿0.
    expect(card).toContain('Hand over');
    expect(voucherIsGift(held())).toBe(true);
    expect(markup(createElement(VoucherFreeItemLine, { held: held() }))).toContain('฿0');
  });

  it('is absent from the card while the count holds one', () => {
    const card = markup(createElement(VoucherCard, { held: held({ prizeStock: { name: 'ZZ TEST Mystery Box', available: 2 } }), quoted: null }));
    expect(card).not.toContain('voucher-prize-stock');
    expect(card).not.toContain('Out of stock');
  });
});
