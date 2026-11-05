import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { priceCartLine } from '@oto/shared';
import { mapMenu, type ApiProduct } from '@/api/menu';
import { buildCartPayload, localQuote, type CartIdentity } from '@/api/sales';
import { OrderSummary } from '@/components/till/OrderSummary';
import { engineCartLine, pricingContext } from '@/lib/cartWire';
import {
  computeLineBreakdown,
  computeLineTotal,
  counterSocksPrice,
  lineExtrasCharge,
  lineFreeNotes,
} from '@/lib/pricing';
import { getActiveBranch, getAddOns, hydrateFromApi } from '@/store/catalogStore';
import type { AddOn, CartLine, SelectedAddOn, TicketType } from '@/types';

// The panel's add-on grid reads live stock, which a static render has no snapshot of.
vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

/**
 * SCRUM-768 follow-up — THE SOCKS COUNTER ON THE ORDER PANEL.
 *
 * On a live catalogue the branch's Regular Socks is a product (code
 * `AO-SOCKS`), and the counter looked its price up under the prototype's fixed
 * `a-socks`, found nothing and charged ฿0; a free Regular Socks Admin saved on
 * a ticket under the product never met the counter either. The counter now
 * reads the socks product: it charges its price, and the bundled units are ฿0
 * on their own "Regular Socks (free)" row. A branch with no socks product
 * charges ฿0 for counter socks and frees none, as before.
 */

// The panel is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const SOCKS_PRODUCT = '0190a0a0-0000-7000-8000-0000000005c5';
const GLOW = '0190a0a0-0000-7000-8000-0000000006c6';

const ticket: TicketType = {
  id: '0190a0a0-0000-7000-8000-00000000c768',
  name: 'ZZ TEST 768 Ticket',
  durationLabel: '2 hours',
  hours: 2,
  prices: {
    tourist: { weekday: 500, weekend: 600 },
    expat: { weekday: 500, weekend: 600 },
  },
  freebies: [{ id: 'fb-socks', kind: 'addon', addOnId: SOCKS_PRODUCT, quantity: 1, tiers: ['tourist'] }],
};

const product = (over: Partial<ApiProduct>): ApiProduct => ({
  id: GLOW,
  kind: 'addon',
  code: 'AO-GLOW',
  categoryId: null,
  name: 'Glow Band',
  description: null,
  priceSatang: 6_000,
  priceWeekendSatang: null,
  costSatang: null,
  prepStationOverride: null,
  taxCategoryOverride: null,
  translations: null,
  sku: null,
  stockItemId: null,
  sortOrder: 0,
  active: true,
  archivedAt: null,
  linkedModifierGroupIds: [],
  ...over,
});

const regularSocks = product({
  id: SOCKS_PRODUCT,
  code: 'AO-SOCKS',
  name: 'Regular Socks',
  priceSatang: 5_000,
  sortOrder: 1,
});

let seeded: AddOn[];

/** The branch's live catalogue, as the till hydrates it from the platform's menu. */
function liveCatalogue(products: ApiProduct[]) {
  const mapped = mapMenu({ categories: [], modifierGroups: [], products });
  hydrateFromApi({ perBranch: { [getActiveBranch().id]: { addOns: mapped.addOns } } });
}

beforeEach(() => {
  seeded = getAddOns();
});

afterEach(() => {
  mapMenu({ categories: [], modifierGroups: [], products: [] });
  hydrateFromApi({ perBranch: { [getActiveBranch().id]: { addOns: seeded } } });
});

function cartLine(over: Partial<CartLine>, mode: 'weekday' | 'weekend' = 'weekday'): CartLine {
  const base = {
    ticketType: ticket,
    tier: 'tourist',
    kids: 1,
    adults: 0,
    socks: 2,
    addOns: [] as SelectedAddOn[],
    ...over,
  };
  return { id: 'line-socks-768', ...base, lineTotal: computeLineTotal(base, mode) } as CartLine;
}

const rows = (line: CartLine, mode: 'weekday' | 'weekend' = 'weekday') =>
  computeLineBreakdown(line, mode).map((r) => [r.key, r.label, r.quantity, r.unitPrice, r.subtotal]);

const identity: CartIdentity = {
  branchId: 'branch-1',
  stationId: 'station-1',
  tier: 'tourist',
  accountId: 'account-1',
  accountName: 'Reception',
};

const noop = () => undefined;
const panel = (line: CartLine) =>
  renderToStaticMarkup(
    createElement(OrderSummary, {
      tier: line.tier,
      lines: [line],
      discounts: [],
      manualDiscounts: [],
      onUpdateLine: noop,
      onRemoveLine: noop,
      onRemoveDiscount: noop,
      onAddManualDiscount: noop,
      onRemoveManualDiscount: noop,
      onPay: noop,
      onCancel: noop,
      canPay: true,
    }),
  );

describe('s768 — the socks counter on a live catalogue with Regular Socks', () => {
  beforeEach(() => liveCatalogue([product({}), regularSocks]));

  it('charges the socks product’s price, and ฿0 only for the unit the ticket bundles free', () => {
    expect(counterSocksPrice('weekday')).toBe(50);
    const line = cartLine({});
    expect(line.lineTotal).toBe(500 + 50);
    expect(rows(line)).toEqual([
      ['kids', 'Kids', 1, 500, 500],
      ['socks', 'Regular Socks', 1, 50, 50],
      ['socks-free', 'Regular Socks (free)', 1, 0, 0],
    ]);
    // Two children bring two free socks: nothing left to charge on the counter.
    expect(computeLineTotal(cartLine({ kids: 2 }), 'weekend')).toBe(2 * 600);
    expect(lineExtrasCharge(line, counterSocksPrice()).socks).toEqual({ amount: 50, free: 1 });
    expect(lineFreeNotes(line).socks).toBe('1 free');
  });

  it('says so on the order panel: ฿50 each, one free', () => {
    const html = panel(cartLine({}));
    expect(html).toContain('Regular Socks');
    expect(html).toContain('฿50 each · 1 free');
    expect(html).toContain(`฿${500 + 50}`);
  });

  it('charges every sock at a tier the free socks were not set for', () => {
    const line = cartLine({ tier: 'expat' });
    expect(line.lineTotal).toBe(500 + 2 * 50);
    expect(rows(line)).toEqual([
      ['kids', 'Kids', 1, 500, 500],
      ['socks', 'Regular Socks', 2, 50, 100],
    ]);
  });

  it('sends the counter socks at the socks price, and its line total is the platform engine’s', () => {
    for (const mode of ['weekday', 'weekend'] as const) {
      const line = cartLine({}, mode);
      const ctx = pricingContext(mode);
      expect(ctx.socks).toEqual({ addOnId: 'a-socks', price: 5_000, label: 'Regular Socks', productId: SOCKS_PRODUCT });
      expect(priceCartLine(engineCartLine(line), ctx)).toBe(Math.round(line.lineTotal * 100));
    }
    const line = cartLine({});
    const payload = buildCartPayload([line], [], [], identity, localQuote([line], [], []).satang!, { mode: 'weekday' });
    expect(payload.socks).toEqual({ addOnId: 'a-socks', unitSatang: 5_000, label: 'Regular Socks' });
    expect(payload.lines[0]!.lineTotalSatang).toBe(55_000);
  });

  it('prices a sale with no socks exactly as before', () => {
    const plain = cartLine({ socks: 0, adults: 2 });
    expect(plain.lineTotal).toBe(500 + 2 * 500);
    expect(rows(plain).map((r) => r[0])).toEqual(['kids', 'adults']);
  });
});

describe('s768 — the socks counter at a branch that sells no socks', () => {
  beforeEach(() => liveCatalogue([product({})]));

  it('charges ฿0 for counter socks and frees none, as before', () => {
    expect(counterSocksPrice('weekday')).toBe(0);
    const line = cartLine({});
    expect(line.lineTotal).toBe(500);
    expect(rows(line)).toEqual([
      ['kids', 'Kids', 1, 500, 500],
      ['socks', 'Regular Socks', 2, 0, 0],
    ]);
    expect(lineFreeNotes(line).socks).toBeUndefined();
    expect(pricingContext('weekday').socks).toEqual({ addOnId: 'a-socks', price: 0, label: 'Regular Socks' });
  });
});
