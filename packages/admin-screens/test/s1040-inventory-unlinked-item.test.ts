import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../../apps/pos/test/support/hooks';
import {
  InventoryItemFormDialogWithPorts,
  NO_LINKED_PRODUCT,
} from '../src/lifted/components/admin/inventory/InventoryItemFormDialog';
import { inventoryItemToStockBody } from '../src/lifted/api/stock';
import type { InventoryItem, MerchItem, StockLocation } from '../src/lifted/model/types';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../apps/pos/test/support/hooks')),
}));

/**
 * SCRUM-1040 — THE MYSTERY BOX IS MADE IN THE CONSOLE AS A STOCK ITEM LINKED TO
 * NO PRODUCT. The inventory form's Product picker offers "— none: counted, never
 * sold —" beside the products; chosen, the item saves with no linked product,
 * which the platform keeps as `productId: null` (counted, never sold at the
 * till). Leaving the picker on "— pick a product —" is still refused.
 *
 * The form's own code is run through the hook harness (no browser): the test
 * reads the elements it returns and presses its controls.
 */

type Props = Parameters<typeof InventoryItemFormDialogWithPorts>[0];
type El = ReactElement<{
  children?: ReactNode;
  id?: string;
  value?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
}>;

function elements(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as El;
  return [element, ...elements(element.props.children)];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return isValidElement(node) ? text((node as El).props.children) : '';
}

const merch: MerchItem = { id: 'zz-cap', name: 'ZZ TEST Cap', active: true, price: { weekday: 250, weekend: 250 } };
const sellPoint: StockLocation = { id: 'loc-foh', name: 'ZZ TEST FOH', type: 'rotation', sellPoint: true, active: true };

let mounted: ReturnType<typeof renderHook<Props, ReactNode>> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function open(item: InventoryItem | null, onSave = vi.fn()) {
  const props: Props = {
    open: true,
    item,
    stockLocations: [sellPoint],
    merchItems: [merch],
    addOns: [],
    menuItems: [],
    onClose: vi.fn(),
    onSave,
    catalogueSizesOf: () => [],
  };
  mounted = renderHook<Props, ReactNode>(InventoryItemFormDialogWithPorts, props);
  return onSave;
}
const tree = () => elements(mounted!.result.current);
const byId = (id: string) => tree().find((e) => e.props.id === id)!;
const productPicker = () => byId('inv-linkedid');
const submit = () => tree().find((e) => e.type === 'form')!.props.onSubmit!({ preventDefault: () => undefined });
const shownErrors = () => tree().filter((e) => e.type === 'p' && /destructive/.test(String((e.props as { className?: string }).className))).map((e) => text(e.props.children));

describe('the inventory form can make a stock item linked to no product', () => {
  it('offers "none: counted, never sold" after "pick a product" and before the products', () => {
    open(null);
    const options = elements(productPicker().props.children).filter((e) => e.type === 'option');
    expect(options.map((o) => [o.props.value, text(o.props.children)])).toEqual([
      ['', '— pick a product —'],
      [NO_LINKED_PRODUCT, '— none: counted, never sold —'],
      ['zz-cap', 'ZZ TEST Cap (zz-cap)'],
    ]);
  });

  it('a new item with "none" chosen saves with no product, and the platform body links none', () => {
    const onSave = open(null);
    byId('inv-name').props.onChange!({ target: { value: 'ZZ TEST Mystery Box' } });
    productPicker().props.onChange!({ target: { value: NO_LINKED_PRODUCT } });
    expect(productPicker().props.value).toBe(NO_LINKED_PRODUCT);
    // The single size needs its label, as for any item.
    tree().find((e) => e.type !== 'option' && (e.props as { placeholder?: string }).placeholder === 'Default')!
      .props.onChange!({ target: { value: 'Default' } });
    submit();
    expect(shownErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as InventoryItem;
    expect(saved).toMatchObject({ name: 'ZZ TEST Mystery Box', linkedId: '' });
    expect(JSON.stringify(saved)).not.toContain(NO_LINKED_PRODUCT);
    const body = inventoryItemToStockBody(saved, { existingSizeIds: new Set(), productSized: false, newItem: true });
    expect(body.productId).toBeNull();
    expect(body.sizes).toEqual([expect.objectContaining({ variantId: null, label: 'Default' })]);
  });

  it('an item already counted with no product opens on "none" and saves as it is', () => {
    const existing: InventoryItem = {
      id: 'group-zz-box',
      name: 'ZZ TEST Mystery Box',
      active: true,
      linkedKind: 'merch',
      linkedId: '',
      variants: [{ id: 'item-zz-box', label: 'Default', stock: 4 }],
      unitCostTHB: 150,
    };
    const onSave = open(existing);
    expect(productPicker().props.value).toBe(NO_LINKED_PRODUCT);
    submit();
    expect(shownErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: 'group-zz-box', linkedId: '', variants: [{ id: 'item-zz-box', label: 'Default' }] });
  });

  it('leaving the picker on "pick a product" is refused, as before', () => {
    const onSave = open(null);
    byId('inv-name').props.onChange!({ target: { value: 'ZZ TEST Something' } });
    submit();
    expect(onSave).not.toHaveBeenCalled();
    expect(shownErrors()).toContain('Linked product is required.');
  });

  it('a product picked saves linked to it, as before', () => {
    const onSave = open(null);
    byId('inv-name').props.onChange!({ target: { value: 'ZZ TEST Cap stock' } });
    productPicker().props.onChange!({ target: { value: 'zz-cap' } });
    tree().find((e) => e.type !== 'option' && (e.props as { placeholder?: string }).placeholder === 'Default')!
      .props.onChange!({ target: { value: 'Default' } });
    submit();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ linkedKind: 'merch', linkedId: 'zz-cap' });
  });
});
