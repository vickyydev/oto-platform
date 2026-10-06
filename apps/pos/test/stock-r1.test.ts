import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SellableStock } from '@oto/shared';
import { inventoryFor, loadSellableStock, withPlatformStock } from '@/api/stock';
import {
  apiProductToAddOn,
  apiProductToMerchItem,
  catalogueSizesOf,
  isSocksAddOnId,
  mapMenu,
  merchItemToApiBody,
  type ApiProduct,
} from '@/api/menu';

/**
 * S2-14b round 1 — the till's selling seams read the platform's stock
 * (`api/stock.ts`), and the catalogue carries the stock link both ways
 * (`api/menu.ts`). Pure: `fetch` is stubbed with the platform's answer.
 *
 *   - before the platform answers, the ported inventory is still the answer
 *     (a deployment with no stock route);
 *   - a tracked product reads its sizes with what the BRANCH holds (the guard's
 *     number), an untracked platform product reads nothing;
 *   - a shop item's tile is out only when every size is;
 *   - a product the platform tracks carries its own id as `inventoryItemId`,
 *     and a form sends the links only to take tracking away.
 */

const BRANCH = '0192f000-0000-7000-8000-00000000b001';
const SOCKS = '0192f000-0000-7000-8000-0000000000a1';
const CAP = '0192f000-0000-7000-8000-0000000000a2';
const PLAIN = '0192f000-0000-7000-8000-0000000000a3';

const answer: SellableStock = {
  branchId: BRANCH,
  sellPointId: '0192f000-0000-7000-8000-00000000c001',
  products: [
    {
      productId: SOCKS,
      name: 'Grip Socks',
      sizes: [
        { variantId: 's', label: 'S', stockItemId: '0192f000-0000-7000-8000-0000000000d1', available: 3, atSellPoint: 1, lowStockThreshold: 8, status: 'low' },
        { variantId: 'm', label: 'M', stockItemId: '0192f000-0000-7000-8000-0000000000d2', available: 0, atSellPoint: 0, lowStockThreshold: 8, status: 'out' },
      ],
    },
    {
      productId: CAP,
      name: 'Oto Cap',
      sizes: [
        { variantId: null, label: null, stockItemId: '0192f000-0000-7000-8000-0000000000d3', available: 25, atSellPoint: 7, lowStockThreshold: 6, status: 'ok' },
      ],
    },
  ],
};

const product = (over: Partial<ApiProduct>): ApiProduct => ({
  id: CAP,
  kind: 'merch',
  code: null,
  categoryId: null,
  name: 'Oto Cap',
  description: null,
  priceSatang: 25_000,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the platform’s stock, as the selling screens read it', () => {
  it('reads the ported inventory until the platform has answered', () => {
    // `inv-mr-cap` is the prototype's own cap (`catalogStore.ts:579`).
    expect(inventoryFor('inv-mr-cap')?.variants[0]?.stock).toBe(25);
  });

  it('reads each size with what the branch holds once the platform answers', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await loadSellableStock(BRANCH)).toBe(true);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(`/api/branches/${BRANCH}/stock/sellable`);

    const socks = inventoryFor(SOCKS)!;
    expect(socks.variants.map((v) => [v.id, v.label, v.stock, v.lowStockThreshold])).toEqual([
      ['s', 'S', 3, 8],
      ['m', 'M', 0, 8],
    ]);
    // One size reads as the prototype's default variant, so the screens'
    // single-variant paths keep working.
    expect(inventoryFor(CAP)!.variants).toEqual([{ id: 'default', label: 'Default', stock: 25, lowStockThreshold: 6 }]);
    // A platform product nobody tracks has nothing to read.
    expect(inventoryFor(PLAIN)).toBeUndefined();
  });

  it('a shop tile is out only when every size is', () => {
    const socks = withPlatformStock({ ...apiProductToMerchItem(product({ id: SOCKS, name: 'Grip Socks', stockLinks: [{ variantId: 's', stockItemId: 'x' }] })) });
    expect(socks.stock).toBe(3);
    const cap = withPlatformStock(apiProductToMerchItem(product({ stockLinks: [{ variantId: null, stockItemId: 'y' }] })));
    expect(cap).toMatchObject({ stock: 25, lowStockThreshold: 6 });
    const plain = withPlatformStock(apiProductToMerchItem(product({ id: PLAIN })));
    expect(plain.stock).toBeUndefined();
  });
});

describe('the stock link, both ways', () => {
  it('receives: a tracked product carries its own id as inventoryItemId; an untracked one carries none', () => {
    expect(apiProductToMerchItem(product({ stockLinks: [{ variantId: null, stockItemId: 'y' }] })).inventoryItemId).toBe(CAP);
    expect(apiProductToAddOn(product({ kind: 'addon', stockLinks: [] })).inventoryItemId).toBeUndefined();
    // An api older than the links: the marker alone still says tracked.
    expect(apiProductToMerchItem(product({ stockItemId: 'y' })).inventoryItemId).toBe(CAP);
  });

  it('sends: nothing while tracked, and the empty list when Track stock is turned off', () => {
    mapMenu({
      categories: [],
      modifierGroups: [],
      products: [product({ stockLinks: [{ variantId: null, stockItemId: 'y' }] })],
    });
    const tracked = apiProductToMerchItem(product({ stockLinks: [{ variantId: null, stockItemId: 'y' }] }));
    expect(merchItemToApiBody(tracked)).not.toHaveProperty('stockLinks');
    const switchedOff = { ...tracked, inventoryItemId: undefined };
    expect(merchItemToApiBody(switchedOff).stockLinks).toEqual([]);
  });
});

describe('fix round — the socks and the F&B sizes (gate R1, R2)', () => {
  const SLUSHIE = '0192f000-0000-7000-8000-0000000000a4';
  const REGULAR_SOCKS = '0192f000-0000-7000-8000-0000000000a5';

  it('knows the branch’s Regular Socks by the prototype id or the product it was seeded as', () => {
    mapMenu({
      categories: [],
      modifierGroups: [],
      products: [product({ id: REGULAR_SOCKS, kind: 'addon', code: 'AO-SOCKS', name: 'Regular Socks' }), product({})],
    });
    expect(isSocksAddOnId('a-socks')).toBe(true);
    expect(isSocksAddOnId(REGULAR_SOCKS)).toBe(true);
    expect(isSocksAddOnId(CAP)).toBe(false);
  });

  it('offers an item’s catalogue sizes, uncounted, when the till has no counts for them', () => {
    const sizes = [
      { id: 'red', label: 'Red' },
      { id: 'blue', label: 'Blue' },
    ];
    mapMenu({
      categories: [],
      modifierGroups: [],
      products: [
        product({ id: SLUSHIE, kind: 'menu', name: 'Slushie', variants: sizes }),
        product({ id: PLAIN, kind: 'menu', name: 'Water', variants: [{ id: 'one', label: 'One' }] }),
      ],
    });
    expect(catalogueSizesOf(SLUSHIE)).toEqual(sizes);
    // One size is no question to ask.
    expect(catalogueSizesOf(PLAIN)).toEqual([]);
    expect(catalogueSizesOf('unknown')).toEqual([]);
  });
});
