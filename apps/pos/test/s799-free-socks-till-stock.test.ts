import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SellableStock } from '@oto/shared';
import { mapMenu, type ApiProduct } from '@/api/menu';
import { loadSellableStock } from '@/api/stock';
import { AddOnsGrid, addOnStockView } from '@/components/till/AddOnsGrid';
import { cartStockShortfalls } from '@/lib/stockPrecheck';
import { getActiveBranch, getAddOns, hydrateFromApi } from '@/store/catalogStore';
import type { AddOn, SelectedAddOn } from '@/types';
import { renderHook } from './support/hooks';

vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
// The grid re-draws on the platform's counts through a store subscription the
// hook harness has no renderer for; the counts themselves are the real read.
vi.mock('@/api/stock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/stock')>()),
  useSellableStockVersion: () => 0,
}));

/**
 * SCRUM-799 — FREE SOCKS TAKE STOCK FROM THE REGULAR SOCKS SHELF, ON THE TILL.
 *
 * The platform sells the 0-baht Free Socks add-on from the Regular Socks
 * shelf (`stockShareItemId` on the menu read). The till's own early checks
 * read the same shelf: the Free Socks tile caps and greys from the Regular
 * Socks count, and the pre-checkout guard adds a free pair to the socks
 * counter and to Regular Socks add-ons on one shelf, naming the shortage for
 * the item that owns it — before the platform's commit would refuse it.
 */

const BRANCH = '0192f000-0000-7000-8000-00000000b799';
const REGULAR = '0192f000-0000-7000-8000-0000000007a1';
const FREE = '0192f000-0000-7000-8000-0000000007a2';
const GLOW = '0192f000-0000-7000-8000-0000000007a3';
const SHELF = '0192f000-0000-7000-8000-0000000007d1';

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
  stockLinks: [],
  stockShareItemId: null,
  ...over,
});

const regularSocks = product({
  id: REGULAR,
  code: 'AO-SOCKS',
  name: 'Regular Socks',
  priceSatang: 6_000,
  stockItemId: SHELF,
  stockLinks: [{ variantId: null, stockItemId: SHELF }],
  sortOrder: 1,
});

const freeSocks = product({
  id: FREE,
  code: 'CF-AO-FREE-SOCKS',
  name: 'Free Socks',
  priceSatang: 0,
  // The platform's pointer: the product's own stock_item_id aimed at the
  // Regular Socks shelf, and no stock links of its own.
  stockItemId: SHELF,
  stockShareItemId: SHELF,
  sortOrder: 2,
});

const sellable = (available: number): SellableStock => ({
  branchId: BRANCH,
  sellPointId: '0192f000-0000-7000-8000-00000000c799',
  products: [
    {
      productId: REGULAR,
      name: 'Regular Socks',
      sizes: [
        {
          variantId: null,
          label: null,
          stockItemId: SHELF,
          available,
          atSellPoint: available,
          lowStockThreshold: null,
          status: available > 0 ? 'ok' : 'out',
        },
      ],
    },
  ],
});

let seeded: AddOn[];
const mounted: Array<{ unmount: () => void }> = [];

/** The branch's live catalogue and its platform counts, as the till loads them. */
async function liveTill(available: number, products: ApiProduct[] = [regularSocks, freeSocks]) {
  const mapped = mapMenu({ categories: [], modifierGroups: [], products });
  hydrateFromApi({ perBranch: { [getActiveBranch().id]: { addOns: mapped.addOns } } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sellable(available)), { status: 200 })));
  expect(await loadSellableStock(BRANCH)).toBe(true);
  return mapped;
}

type NodeProps = { children?: React.ReactNode; value?: number; max?: number; ariaLabel?: string; onChange?: (next: number) => void };
function nodes(node: React.ReactNode): React.ReactElement<NodeProps>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement<NodeProps>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
const textOf = (node: React.ReactNode): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : React.isValidElement<NodeProps>(node)
        ? textOf(node.props.children)
        : '';

function grid(selected: SelectedAddOn[] = []) {
  const onSetQuantity = vi.fn();
  const rendered = renderHook(() => AddOnsGrid({ selected, onSetQuantity, onSetVariants: vi.fn() }));
  mounted.push(rendered);
  const tile = (id: string) => nodes(rendered.result.current).find((n) => n.key === id)!;
  return {
    onSetQuantity,
    text: (id: string) => textOf(tile(id)),
    stepper: (name: string) => nodes(tile(name === 'Free Socks' ? FREE : REGULAR)).find((n) => n.props.ariaLabel === name)!,
  };
}

const free = (quantity: number, variantId = 'default'): SelectedAddOn => ({ id: FREE, name: 'Free Socks', price: 0, quantity, variantId });
const regular = (quantity: number, variantId = 'default'): SelectedAddOn => ({ id: REGULAR, name: 'Regular Socks', price: 60, quantity, variantId });

beforeEach(() => {
  vi.stubGlobal('React', React);
  seeded = getAddOns();
});

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  mapMenu({ categories: [], modifierGroups: [], products: [] });
  hydrateFromApi({ perBranch: { [getActiveBranch().id]: { addOns: seeded } } });
});

describe('SCRUM-799: the till reads Free Socks on the Regular Socks shelf', () => {
  it('maps the share onto the owner’s stock key, and leaves an item with no share uncounted', async () => {
    const mapped = await liveTill(5, [regularSocks, freeSocks, product({})]);
    const byId = new Map(mapped.addOns.map((a) => [a.id, a]));
    expect(byId.get(REGULAR)?.inventoryItemId).toBe(REGULAR);
    expect(byId.get(FREE)?.inventoryItemId).toBe(REGULAR);
    expect(byId.get(GLOW)?.inventoryItemId).toBeUndefined();
    // A share whose shelf no item on this read owns stays uncounted here; the
    // platform's commit still holds the line.
    const orphan = mapMenu({ categories: [], modifierGroups: [], products: [freeSocks] });
    expect(orphan.addOns[0]?.inventoryItemId).toBeUndefined();
  });

  it('counter 1 plus Free Socks 1 with one pair left is refused at the till, named for Regular Socks', async () => {
    await liveTill(1);
    expect(cartStockShortfalls([{ socks: 1, addOns: [free(1)] }], getAddOns())).toEqual(['Regular Socks (need 2, have 1)']);
    // A free pair alone, and the counter alone, fit.
    expect(cartStockShortfalls([{ socks: 0, addOns: [free(1)] }], getAddOns())).toEqual([]);
    expect(cartStockShortfalls([{ socks: 1, addOns: [] }], getAddOns())).toEqual([]);
    // Across lines, with a paid Regular Socks too: one shelf.
    expect(
      cartStockShortfalls(
        [
          { socks: 0, addOns: [free(1)] },
          { socks: 0, addOns: [regular(1)] },
        ],
        getAddOns(),
      ),
    ).toEqual(['Regular Socks (need 2, have 1)']);
    // Free Socks on their own, over the shelf: still the owner's name.
    expect(cartStockShortfalls([{ socks: 0, addOns: [free(2)] }], getAddOns())).toEqual(['Regular Socks (need 2, have 1)']);
  });

  it('the Free Socks tile caps at the Regular Socks count and hands the size on', async () => {
    await liveTill(1);
    expect(addOnStockView({ id: FREE, inventoryItemId: REGULAR })).toMatchObject({ counted: true });
    const g = grid();
    g.stepper('Free Socks').props.onChange!(1);
    expect(g.onSetQuantity).toHaveBeenLastCalledWith(FREE, 1, 'default');
    g.onSetQuantity.mockClear();
    g.stepper('Free Socks').props.onChange!(2);
    expect(g.onSetQuantity).not.toHaveBeenCalled();
    expect(g.text(FREE)).not.toContain('Out of stock');
  });

  it('the Free Socks tile reads Out of stock at 0, as Regular Socks does', async () => {
    await liveTill(0);
    const g = grid();
    expect(g.text(FREE)).toContain('Out of stock');
    expect(g.stepper('Free Socks').props.max).toBe(0);
    expect(g.text(REGULAR)).toContain('Out of stock');
    expect(cartStockShortfalls([{ socks: 0, addOns: [free(1)] }], getAddOns())).toEqual(['Regular Socks (need 1, have 0)']);
  });
});
