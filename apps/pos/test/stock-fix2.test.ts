import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StockAttentionView } from '@oto/shared';
import { StockOverview, isLowInScope } from '@/components/mobile/stock/StockOverview';
import { StockPurchasing } from '@/components/mobile/stock/StockPurchasing';
import { StockSuggestions } from '@/components/mobile/stock/StockSuggestions';
import type { InventoryItem, StockLocation } from '@/types';

/**
 * THE STOCK FIX ROUND, SECOND PASS — the till's stock screens (gate finding F3):
 *
 *   - the Alerts and Purchase tabs describe the usage rule as the platform
 *     computes it: average DAILY usage over 30 days × (lead time + 1 day),
 *     rounded up — ceil(used × (lead + 1) / 30) — not "30 days × (lead + 1)";
 *   - the Stock tab's "Low" filter judges an item's reorder point by the
 *     platform's figure for today (`reorderPointNow`), as the Alerts rows do,
 *     never the static point alone.
 *
 * Pure: the screens render to markup (no DOM).
 */
// This runner compiles JSX to `React.createElement` (no React plugin, `vitest.config.ts`).
Object.assign(globalThis, { React });

const BRANCH = '0192f000-0000-7000-8000-00000000b001';
const FOH = '0192f000-0000-7000-8000-00000000c001';
const BOH = '0192f000-0000-7000-8000-00000000c002';
const CAP = '0192f000-0000-7000-8000-0000000000a2';
const CAP_ITEM = '0192f000-0000-7000-8000-0000000000d3';
const SOCKS = '0192f000-0000-7000-8000-0000000000a1';
const SOCKS_S = '0192f000-0000-7000-8000-0000000000d1';
const SOCKS_M = '0192f000-0000-7000-8000-0000000000d2';

const markup = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const locations: StockLocation[] = [
  { id: FOH, name: 'FOH', type: 'rotation', sellPoint: true, active: true },
  { id: BOH, name: 'BOH', type: 'back_of_house', active: true },
];

// 12 caps on hand. The static point set in Admin Inventory is 15 — the old
// filter called it low — but the item sells little: the platform's point today is 10.
const cap: InventoryItem = {
  id: CAP,
  name: 'Oto Cap',
  linkedKind: 'merch',
  linkedId: CAP,
  variants: [{ id: CAP_ITEM, label: 'Default', stock: 12, stockByLocation: { [FOH]: 4, [BOH]: 8 } }],
  reorderSettings: { reorderPoint: 15, leadTimeDays: 7, supplierName: 'Bangkok Merch Co.', reorderQty: 24 },
};

// 25 socks over two sizes. Static point 10 — but they sell fast: the platform's point is 30.
const socks: InventoryItem = {
  id: SOCKS,
  name: 'Grip Socks (Merch)',
  linkedKind: 'merch',
  linkedId: SOCKS,
  variants: [
    { id: SOCKS_S, label: 'S', stock: 12, stockByLocation: { [FOH]: 6, [BOH]: 6 } },
    { id: SOCKS_M, label: 'M', stock: 13, stockByLocation: { [FOH]: 7, [BOH]: 6 } },
  ],
  reorderSettings: { reorderPoint: 10, leadTimeDays: 10, supplierName: 'Phuket Socks Ltd.', reorderQty: 48 },
};

describe('F3 — the usage rule is described as the platform computes it', () => {
  const trendRow: StockAttentionView = {
    id: '0192f000-0000-7000-8000-00000000f002',
    kind: 'reorder',
    stockItemId: SOCKS_S,
    rule: '≤ reorder point (30-day usage)',
    quantity: 5,
    summary: "Grip Socks (Merch): 25 on hand, at or below its reorder point of 30 — 82 used in the last 30 days, 10 days' lead time + 1",
    occurrences: 1,
    saleId: null,
    createdAt: '2026-10-02T03:00:00.000Z',
    updatedAt: '2026-10-02T03:00:00.000Z',
    lowStock: {
      groupId: SOCKS,
      total: 25,
      reorderPoint: 30,
      reorderRule: 'trend',
      staticReorderPoint: 10,
      usedInWindow: 82,
      reorder: true,
      belowPar: [],
    },
  };

  it('the Alerts tab: average daily usage × (lead time + 1 day), rounded up', () => {
    const out = markup(
      React.createElement(StockSuggestions, {
        inventory: [socks],
        locations,
        orders: [],
        attention: [trendRow],
        onResolveAttention: () => {},
        onStartTransfer: () => {},
        onReorder: () => {},
      }),
    );
    expect(out).toContain('what it sells on an average day over the last 30 days × (lead time + 1 day), rounded up');
    expect(out).not.toMatch(/its usage: the last 30 days ×/);
  });

  it('the Purchase tab says the same', () => {
    const out = markup(
      React.createElement(StockPurchasing, { branchId: BRANCH, inventory: [socks], orders: [], onGoToReceive: () => {} }),
    );
    expect(out).toContain('what it sells on an average day over the last 30 days × (lead time + 1 day), rounded up');
    expect(out).not.toMatch(/usage over the last 30 days ×/);
  });
});

describe('F3 — the Stock tab’s "Low" filter uses the platform’s reorder point for today', () => {
  it('an item over the platform’s point is not low, even under the static one', () => {
    expect(isLowInScope(cap, 10, 'all')).toBe(false);
  });

  it('an item at or under the platform’s point is low, even over the static one — on its total over every size', () => {
    expect(isLowInScope(socks, 30, 'all')).toBe(true);
    expect(isLowInScope(socks, 25, 'all')).toBe(true);
    expect(isLowInScope(socks, 24, 'all')).toBe(false);
  });

  it('an item with no point is judged by its sizes’ low-stock thresholds alone; a place filter never applies the reorder point', () => {
    expect(isLowInScope(socks, null, 'all')).toBe(false);
    expect(isLowInScope(socks, 30, FOH)).toBe(false);
    const thresholded: InventoryItem = {
      ...cap,
      variants: [{ ...cap.variants[0]!, lowStockThreshold: 5 }],
    };
    expect(isLowInScope(thresholded, null, FOH)).toBe(true);
    // Empty is "Out", its own filter.
    const empty: InventoryItem = { ...cap, variants: [{ ...cap.variants[0]!, stock: 0, stockByLocation: { [FOH]: 0, [BOH]: 0 } }] };
    expect(isLowInScope(empty, 10, 'all')).toBe(false);
  });

  it('the Stock tab still renders with the platform’s points', () => {
    const out = markup(
      React.createElement(StockOverview, {
        inventory: [cap, socks],
        locations,
        reorderPointNow: { [CAP]: 10, [SOCKS]: 30 },
        onStartStockTake: () => {},
      }),
    );
    expect(out).toContain('Oto Cap');
    expect(out).toContain('Grip Socks (Merch)');
  });
});
