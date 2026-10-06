import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StockAttentionView } from '@oto/shared';
import { fetchPlaceOpenings } from '@/api/stock';
import { StockSuggestions, buildAttentionList } from '@/components/mobile/stock/StockSuggestions';
import { StockTakeReviewBody, reviewRows, type CountRow, type PlaceOpening } from '@/components/mobile/stock/StockTakeFlow';
import type { InventoryItem, PurchaseOrder, StockLocation } from '@/types';

/**
 * THE STOCK WALKTHROUGH FIXES on the till's stock screens (staging walkthrough
 * 2026-10-02):
 *
 *   F2  the count's review asks the platform whether the place has been counted
 *       and, at its opening, says so plainly — never "Large discrepancies … flagged
 *       in the variance log" for a count the platform saves unflagged;
 *   F3  the Alerts screen's cards are exactly the platform's low-stock rows: an
 *       item the platform keeps quiet (an open order covers it) has no card, the
 *       count is the rows', the 30-day usage rule is named, and the stale
 *       "future releases" text is gone from Alerts and Purchase.
 *
 * Pure: the screens render to markup (no DOM), `fetch` is stubbed where a read is needed.
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
const BOTTLE = '0192f000-0000-7000-8000-0000000000a3';
const BOTTLE_ITEM = '0192f000-0000-7000-8000-0000000000d4';

afterEach(() => {
  vi.unstubAllGlobals();
});

const markup = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

// --- F2 ------------------------------------------------------------------------------------

describe('F2 — the count’s review knows a place’s opening before the commit', () => {
  const socks: InventoryItem = {
    id: SOCKS,
    name: 'Grip Socks (Merch)',
    linkedKind: 'merch',
    linkedId: SOCKS,
    variants: [
      { id: SOCKS_S, label: 'S', stock: 0, stockByLocation: { [FOH]: 0, [BOH]: 0 } },
      { id: SOCKS_M, label: 'M', stock: 0, stockByLocation: { [FOH]: 0, [BOH]: 0 } },
    ],
  };
  // Staging's BOH: counted 15 and 25 against an expected 0.
  const counted: CountRow[] = [
    { item: socks, variant: socks.variants[0]!, expectedQty: 0, qtyRaw: '15', eaches: 15 },
    { item: socks, variant: socks.variants[1]!, expectedQty: 0, qtyRaw: '25', eaches: 25 },
  ];
  const review = (placeOpening: PlaceOpening, checking = false) =>
    markup(
      React.createElement(StockTakeReviewBody, {
        locName: 'BOH',
        rows: reviewRows(counted, placeOpening),
        placeOpening,
        checking,
        expandedItems: new Set<string>(),
        onToggleExpand: () => {},
      }),
    );

  it('asks the platform which places have been counted', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ places: [{ locationId: BOH, opened: false, openedAt: null }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await fetchPlaceOpenings(BRANCH)).toEqual([{ locationId: BOH, opened: false, openedAt: null }]);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(`/api/branches/${BRANCH}/stock/openings`);
  });

  it('at the place’s opening nothing is flagged, and the screen says it is the opening — not a variance', () => {
    expect(reviewRows(counted, true).map((r) => r.flagged)).toEqual([false, false]);
    const out = review(true);
    expect(out).toContain('Opening count for BOH');
    expect(out).toContain('BOH has not been counted before, so this count is its opening: stock there is set to what you counted. Nothing is flagged and nothing goes in the variance log.');
    expect(out).toContain('counted 15');
    expect(out).toContain('counted 25');
    expect(out).not.toContain('Large discrepancies');
    expect(out).not.toContain('flagged in the variance log');
    expect(out).not.toContain('flagged</p>');
  });

  it('at a place counted before, the large differences are flagged in the variance log, as before', () => {
    expect(reviewRows(counted, false).map((r) => r.flagged)).toEqual([true, true]);
    const out = review(false);
    expect(out).toContain('2 counted · 2 flagged');
    expect(out).toContain('Large discrepancies — will auto-adjust on commit');
    expect(out).toContain('Stock will be auto-adjusted to the counted value and flagged in the variance log.');
    expect(out).not.toContain('Opening count');
  });

  it('while the platform has not answered, the review never claims a flag it may not record', () => {
    const out = review(null, true);
    expect(out).toContain('Checking whether this is BOH’s first count…');
    expect(out).toContain('unless this is BOH’s first count, which is its opening and flags nothing');
  });
});

// --- F3 ------------------------------------------------------------------------------------

const locations: StockLocation[] = [
  { id: FOH, name: 'FOH', type: 'rotation', sellPoint: true, active: true },
  { id: BOH, name: 'BOH', type: 'back_of_house', active: true },
];

const inventory: InventoryItem[] = [
  {
    id: CAP,
    name: 'Oto Cap',
    linkedKind: 'merch',
    linkedId: CAP,
    variants: [{ id: CAP_ITEM, label: 'Default', stock: 25, stockByLocation: { [FOH]: 3, [BOH]: 22 }, parByLocation: { [FOH]: 10 } }],
    reorderSettings: { reorderPoint: 15, leadTimeDays: 7, supplierName: 'Bangkok Merch Co.', reorderQty: 24 },
  },
  {
    id: SOCKS,
    name: 'Grip Socks (Merch)',
    linkedKind: 'merch',
    linkedId: SOCKS,
    variants: [
      { id: SOCKS_S, label: 'S', stock: 2, stockByLocation: { [FOH]: 2, [BOH]: 0 }, parByLocation: { [FOH]: 10 } },
      { id: SOCKS_M, label: 'M', stock: 3, stockByLocation: { [FOH]: 3, [BOH]: 0 }, parByLocation: { [FOH]: 15 } },
    ],
    reorderSettings: { reorderPoint: 30, leadTimeDays: 10, supplierName: 'Phuket Socks Ltd.', reorderQty: 48 },
  },
  // A fixture not present in this response; the UI renders only returned attention rows.
  {
    id: BOTTLE,
    name: 'Water Bottle',
    linkedKind: 'merch',
    linkedId: BOTTLE,
    variants: [{ id: BOTTLE_ITEM, label: 'Default', stock: 2, stockByLocation: { [FOH]: 2, [BOH]: 0 }, parByLocation: { [FOH]: 6 } }],
    reorderSettings: { reorderPoint: 20, leadTimeDays: 10, supplierName: 'Bottle House TH', reorderQty: 48 },
  },
];

const orders: PurchaseOrder[] = [
  {
    id: 'po-1',
    branchId: BRANCH,
    supplierName: 'Bottle House TH',
    state: 'ordered',
    lines: [{ id: 'pol-1', inventoryItemId: BOTTLE, variantId: BOTTLE_ITEM, itemName: 'Water Bottle', variantLabel: 'Default', orderedQty: 48, receivedQty: 0 }],
    createdAt: '2026-10-02T03:10:21.505Z',
    createdBy: 'Khun Lek (Manager)',
    createdById: '',
    expectedArrivalDate: '2026-10-12',
  },
];

const row = (over: Partial<StockAttentionView>): StockAttentionView => ({
  id: '0192f000-0000-7000-8000-00000000f001',
  kind: 'low_stock',
  stockItemId: CAP_ITEM,
  rule: 'Below par at FOH',
  quantity: 7,
  summary: 'Oto Cap: below par at FOH',
  occurrences: 1,
  saleId: null,
  createdAt: '2026-10-02T03:00:00.000Z',
  updatedAt: '2026-10-02T03:00:00.000Z',
  lowStock: {
    groupId: CAP,
    total: 25,
    reorderPoint: 15,
    reorderRule: 'static',
    staticReorderPoint: 15,
    usedInWindow: null,
    reorder: false,
    belowPar: [{ stockItemId: CAP_ITEM, size: null, locationId: FOH, place: 'FOH', level: 3, par: 10 }],
  },
  ...over,
});

/** The platform's rows: the cap below par at FOH, the socks at their 30-day usage point, and a sale's shortfall. */
const platformRows: StockAttentionView[] = [
  row({}),
  row({
    id: '0192f000-0000-7000-8000-00000000f002',
    kind: 'reorder',
    stockItemId: SOCKS_S,
    rule: '≤ reorder point (30-day usage) · Below par at FOH',
    quantity: 4,
    summary: "Grip Socks (Merch): 5 on hand, at or below its reorder point of 9 — 26 used in the last 30 days, 10 days' lead time + 1",
    lowStock: {
      groupId: SOCKS,
      total: 5,
      reorderPoint: 9,
      reorderRule: 'trend',
      staticReorderPoint: 30,
      usedInWindow: 26,
      reorder: true,
      // A row written before the place's id was recorded: matched by the place's name.
      belowPar: [
        { stockItemId: SOCKS_S, size: 'S', locationId: null, place: 'FOH', level: 2, par: 10 },
        { stockItemId: SOCKS_M, size: 'M', locationId: null, place: 'FOH', level: 3, par: 15 },
      ],
    },
  }),
  row({
    id: '0192f000-0000-7000-8000-00000000f003',
    kind: 'stock_shortfall',
    rule: null,
    summary: 'Sold 1 Mascot Keyring past the record',
    saleId: '0192f000-0000-7000-8000-00000000e001',
    lowStock: null,
  }),
];

describe('F3 — the Alerts screen is the platform’s attention rows', () => {
  it('one card per platform low-stock row, and nothing the device would have added', () => {
    const entries = buildAttentionList(platformRows, inventory, locations, orders);
    // The platform's two low-stock rows, exactly: not the covered Water Bottle.
    expect(entries.map((e) => e.row.id).sort()).toEqual(
      platformRows.filter((r) => r.kind === 'low_stock' || r.kind === 'reorder').map((r) => r.id).sort(),
    );
    expect(entries.some((e) => e.name === 'Water Bottle')).toBe(false);
    const cap = entries.find((e) => e.name === 'Oto Cap')!;
    // The prototype's transfer suggestion, from the shelf that holds some.
    expect(cap.transfer).toMatchObject({ locationId: FOH, sourceLocationId: BOH, shortage: 7, sourceAvailable: 22 });
    const socks = entries.find((e) => e.name === 'Grip Socks (Merch)')!;
    expect(socks).toMatchObject({ trend: true, atReorderPoint: true, reorderPoint: 9, totalStock: 5, reorder: true });
    expect(socks.transfer).toBeUndefined();
    expect(socks.shortfalls.map((s) => [s.sizeLabel, s.locationName, s.currentQty, s.par])).toEqual([
      ['S', 'FOH', 2, 10],
      ['M', 'FOH', 3, 15],
    ]);
  });

  it('keeps the transfer and purchase reminder when the same item has an open order', () => {
    const capOrder: PurchaseOrder = { ...orders[0]!, state: 'to_order', lines: [{ ...orders[0]!.lines[0]!, inventoryItemId: CAP, variantId: CAP_ITEM, itemName: 'Oto Cap' }] };
    const entries = buildAttentionList(platformRows, inventory, locations, [capOrder]);
    const cap = entries.find((entry) => entry.name === 'Oto Cap')!;
    expect(cap.transfer).toMatchObject({ sourceLocationId: BOH, shortage: 7 });
    expect(cap.onOrder).toMatchObject({ state: 'to_order', qty: 48 });
    const out = markup(React.createElement(StockSuggestions, { inventory, locations, orders: [capOrder], attention: platformRows,
      onResolveAttention: () => {}, onStartTransfer: () => {}, onReorder: () => {} }));
    expect(out).toContain('Move 7 from BOH');
    expect(out).toContain('48 on list');
    const socksOrder: PurchaseOrder = { ...capOrder, lines: [{ ...capOrder.lines[0]!, inventoryItemId: SOCKS, variantId: SOCKS_S }] };
    const reminder = markup(React.createElement(StockSuggestions, { inventory, locations, orders: [socksOrder], attention: platformRows,
      onResolveAttention: () => {}, onStartTransfer: () => {}, onReorder: () => {} }));
    expect(reminder).toContain('Already on the purchase list');
  });

  it('with no platform rows there are no cards, whatever the levels on the device say', () => {
    expect(buildAttentionList([], inventory, locations, orders)).toEqual([]);
  });

  it('renders the rows with the rule that fired, the platform’s count, and no "future releases" text', () => {
    const out = markup(
      React.createElement(StockSuggestions, {
        inventory,
        locations,
        orders,
        attention: platformRows,
        onResolveAttention: () => {},
        onStartTransfer: () => {},
        onReorder: () => {},
      }),
    );
    expect(out).toContain('Needs attention · 2');
    expect(out).toContain('total 5 ≤ reorder 9 (30-day usage)');
    expect(out).toContain('Move 7 from BOH');
    expect(out).toContain('Reorder from Phuket Socks Ltd.');
    expect(out).toContain('Sold 1 Mascot Keyring past the record');
    expect(out).not.toContain('Water Bottle');
    expect(out).not.toMatch(/future releases|future backend/i);
  });

  it('the Purchase tab no longer says reordering from usage will come later', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'mobile', 'stock', 'StockPurchasing.tsx'), 'utf8');
    expect(src).not.toMatch(/future backend|future releases|requires server-side consumption history/i);
    const alerts = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'mobile', 'stock', 'StockSuggestions.tsx'), 'utf8');
    expect(alerts).not.toMatch(/from '@\/lib\/inventory'/);
  });
});
