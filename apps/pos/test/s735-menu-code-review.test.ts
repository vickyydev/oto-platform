import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiProductToMenuItem, type ApiProduct } from '@/api/menu';
import { MenuGrid } from '@/components/fnb/MenuGrid';
import type { MenuItem } from '@/types';
import { renderHook } from './support/hooks';

vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
vi.mock('@/mockApi', () => ({ getMenuCategories: () => [{ id: 'food', name: 'ZZ TEST Food' }] }));
vi.mock('@/api/stock', () => ({ inventoryFor: () => undefined, useSellableStockVersion: () => 0 }));

const product = (id: string, name: string, code: string | null): ApiProduct => ({
  id, name, code, kind: 'menu', categoryId: 'food', description: null,
  priceSatang: 100, priceWeekendSatang: null, costSatang: null,
  prepStationOverride: null, taxCategoryOverride: null, translations: null,
  sku: null, stockItemId: null, sortOrder: 0, active: true, archivedAt: null,
  linkedModifierGroupIds: [],
});
const products = [
  product('numeric', 'ZZ TEST Rice', '00127'),
  product('word', 'ZZ TEST Chicken', 'FB-NUGGETS'),
  product('no-code', 'ZZ TEST Plain soup', null),
];
type NodeProps = { children?: React.ReactNode; item?: MenuItem; placeholder?: string;
  onChange?: (event: { target: { value: string } }) => void; onClick?: () => void; 'aria-label'?: string };
function nodes(node: React.ReactNode): React.ReactElement<NodeProps>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement<NodeProps>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
const mounted: Array<{ unmount: () => void }> = [];
function grid() {
  const items = products.map(p => apiProductToMenuItem(p, []));
  const rendered = renderHook(() => MenuGrid({ items, quantities: {}, onAdd: vi.fn() }));
  mounted.push(rendered);
  return {
    search(value: string) {
      const input = nodes(rendered.result.current).find(node => node.props.placeholder?.startsWith('Search dish'));
      expect(input?.props.onChange).toBeTypeOf('function');
      input!.props.onChange!({ target: { value } });
    },
    clear() {
      const button = nodes(rendered.result.current).find(node => node.props['aria-label'] === 'Clear search');
      expect(button?.props.onClick).toBeTypeOf('function');
      button!.props.onClick!();
    },
    shown: () => nodes(rendered.result.current).flatMap(node => node.props.item ? [node.props.item.id] : []),
  };
}

describe('SCRUM-735: the actual menu adapter and search retain dish codes', () => {
  beforeEach(() => { vi.stubGlobal('React', React); });
  afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

  // P2 FINDING: the API code is discarded before the menu reaches the till.
  // Prescribed fix: retain it as an optional string; do not coerce dish numbers.
  it('retains numeric codes, including leading zeroes, through the menu adapter', () => {
    expect(apiProductToMenuItem(products[0]!, [])).toMatchObject({ code: '00127' });
  });

  // P2 FINDING: the displayed results read only names.
  // Prescribed fix: match the existing code as well, without changing name matching.
  it.each(['00127', '127', ' 00127 '])('finds the numeric-code dish for %j although its name has no number', query => {
    const view = grid(); view.search(query); expect(view.shown()).toEqual(['numeric']);
  });

  it('finds existing word codes case-insensitively without reseeding', () => {
    const view = grid(); view.search(' fb-nuggets '); expect(view.shown()).toEqual(['word']);
  });

  it('keeps case-insensitive name search, including an item with no code', () => {
    const view = grid();
    view.search(' rIcE '); expect(view.shown()).toEqual(['numeric']);
    view.search('plain SOUP'); expect(view.shown()).toEqual(['no-code']);
  });

  it('keeps an unmatched query empty and restores the category when cleared', () => {
    const view = grid();
    view.search('99999'); expect(view.shown()).toEqual([]);
    view.clear(); expect(view.shown()).toEqual(['numeric', 'word', 'no-code']);
    view.search('   '); expect(view.shown()).toEqual(['numeric', 'word', 'no-code']);
  });
});
