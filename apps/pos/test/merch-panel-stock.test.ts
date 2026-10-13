import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SellableStock } from '@oto/shared';
import { loadSellableStock, merchItemsWithStock } from '@/api/stock';
import { getMerchItems, upsertMerchItem, wwp } from '@/store/catalogStore';
import { isLowStock, isOutOfStock } from '@/lib/merch';

/**
 * SCRUM-379 — the back office's Merch panel reads the stock the shop grid
 * reads (`merchItemsWithStock`, `api/stock.ts`), so its badge and its
 * "Needs restocking" notice can show. The store's raw rows carry no stock.
 */

const BRANCH = '0192f000-0000-7000-8000-00000000b379';
const CAP = '0192f000-0000-7000-8000-0000000379a1';
const MUG = '0192f000-0000-7000-8000-0000000379a2';
const BAG = '0192f000-0000-7000-8000-0000000379a3';
const PLAIN = '0192f000-0000-7000-8000-0000000379a4';

const size = (available: number, status: 'ok' | 'low' | 'out') => ({
  variantId: null,
  label: null,
  stockItemId: '0192f000-0000-7000-8000-0000000379d1',
  available,
  atSellPoint: 0,
  lowStockThreshold: 5,
  status,
});

const answer: SellableStock = {
  branchId: BRANCH,
  sellPointId: '0192f000-0000-7000-8000-0000000379c1',
  products: [
    { productId: CAP, name: 'Cap', sizes: [size(2, 'low')] },
    { productId: MUG, name: 'Mug', sizes: [size(0, 'out')] },
    { productId: BAG, name: 'Bag', sizes: [size(40, 'ok')] },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Merch panel’s stock', () => {
  it('flags a low and an out item with the platform’s figures, and leaves an untracked one alone', async () => {
    for (const [id, name, active] of [
      [CAP, 'Cap', true],
      [MUG, 'Mug', true],
      [BAG, 'Bag', false],
      [PLAIN, 'Plain', true],
    ] as const) {
      upsertMerchItem({ id, name, price: wwp(100), active, ...(id === PLAIN ? {} : { inventoryItemId: id }) });
    }
    // The store's rows carry no stock for a platform product: the panel used to read these.
    const rawCap = getMerchItems().find((m) => m.id === CAP)!;
    expect(rawCap.stock).toBeUndefined();
    expect(isLowStock(rawCap) || isOutOfStock(rawCap)).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 })));
    expect(await loadSellableStock(BRANCH)).toBe(true);

    const shown = new Map(merchItemsWithStock().map((m) => [m.id, m]));
    expect(shown.get(CAP)).toMatchObject({ stock: 2, lowStockThreshold: 5 });
    expect(isLowStock(shown.get(CAP)!)).toBe(true);
    expect(isOutOfStock(shown.get(MUG)!)).toBe(true);
    // Retired rows are still listed, with their count.
    expect(shown.get(BAG)).toMatchObject({ stock: 40, active: false });
    expect(shown.get(PLAIN)!.stock).toBeUndefined();

    // The notice lists exactly the low and the out ones.
    const restock = [...shown.values()].filter((m) => isLowStock(m) || isOutOfStock(m)).map((m) => m.id);
    expect(restock).toContain(CAP);
    expect(restock).toContain(MUG);
    expect(restock).not.toContain(BAG);
    expect(restock).not.toContain(PLAIN);

    // The figures are read, never written into the store.
    expect(getMerchItems().find((m) => m.id === CAP)!.stock).toBeUndefined();
  });
});
