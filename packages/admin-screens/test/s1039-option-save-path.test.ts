import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../../apps/pos/test/support/hooks';
import { ModifierGroupFormDialog } from '../src/lifted/components/admin/modifiers/ModifierGroupFormDialog';
import { MenuItemFormWithPorts } from '../src/lifted/components/admin/menu/MenuItemForm';
import { OptionRowFields } from '../src/lifted/components/admin/modifiers/OptionPriceFields';
import { createMenuHelpers } from '../src/lifted/lib/menu';
import type { MenuCategoryDef, MenuItem, ModifierGroup, WeekdayWeekendPrice } from '../src/lifted/model/types';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../apps/pos/test/support/hooks')),
}));

/**
 * SCRUM-1039 — WHAT THE TWO EDITORS SAVE. An option that already holds two
 * different prices (weekday ฿10, weekend ฿25) is opened and saved without its
 * price being touched: both editors hand back the same two prices. A price
 * typed into the one field is saved as both. Each editor's own code runs
 * through the hook harness (no browser); the test reads the elements it
 * returns and presses its controls, and each option row is drawn by calling
 * the row itself.
 */

type El = ReactElement<{
  children?: ReactNode;
  price?: WeekdayWeekendPrice;
  'aria-label'?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void | Promise<void>;
}>;

function elements(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as El;
  return [element, ...elements(element.props.children)];
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const mixed: WeekdayWeekendPrice = { weekday: 10, weekend: 25 };
const options = () => [
  { id: 'opt-zz-ketchup', name: 'ZZ TEST Ketchup', price: { ...mixed }, cost: 4 },
  { id: 'opt-zz-mayo', name: 'ZZ TEST Mayo', price: { weekday: 5, weekend: 5 } },
];
const group = (): ModifierGroup => ({
  id: 'grp-zz-sauce',
  name: 'ZZ TEST Sauce',
  required: false,
  selectionType: 'single',
  options: options(),
});

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

/** The option rows a tree draws, and a way to type into one row's price field. */
function rowsOf(tree: ReactNode) {
  const rows = elements(tree).filter((e) => e.type === OptionRowFields);
  const typePrice = (index: number, value: string) => {
    const row = rows[index]!;
    const drawn = OptionRowFields(row.props as Parameters<typeof OptionRowFields>[0]);
    const field = elements(drawn).find((e) => e.props['aria-label'] === 'Option price delta')!;
    field.props.onChange!({ target: { value } });
  };
  return { prices: rows.map((r) => r.props.price), typePrice };
}
const submit = async (tree: ReactNode) => {
  await elements(tree).find((e) => e.type === 'form')!.props.onSubmit!({ preventDefault: () => undefined });
  await flush();
};

describe('the shared modifier group dialog', () => {
  type Props = Parameters<typeof ModifierGroupFormDialog>[0];
  const mount = (onSave: Props['onSave']) => {
    const rendered = renderHook(ModifierGroupFormDialog, { open: true, group: group(), onOpenChange: vi.fn(), onSave });
    unmount = rendered.unmount;
    return rendered;
  };

  it('saves an option holding two prices with the same two prices when the price is not touched', async () => {
    const onSave = vi.fn();
    const rendered = mount(onSave);
    expect(rowsOf(rendered.result.current).prices).toEqual([mixed, { weekday: 5, weekend: 5 }]);
    await submit(rendered.result.current);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0]![0] as ModifierGroup).options).toEqual([
      { id: 'opt-zz-ketchup', name: 'ZZ TEST Ketchup', price: { weekday: 10, weekend: 25 }, cost: 4 },
      { id: 'opt-zz-mayo', name: 'ZZ TEST Mayo', price: { weekday: 5, weekend: 5 } },
    ]);
  });

  it('saves a typed price as both the weekday and the weekend price, the other option untouched', async () => {
    const onSave = vi.fn();
    const rendered = mount(onSave);
    rowsOf(rendered.result.current).typePrice(0, '35');
    expect(rowsOf(rendered.result.current).prices[0]).toEqual({ weekday: 35, weekend: 35 });
    await submit(rendered.result.current);
    expect((onSave.mock.calls[0]![0] as ModifierGroup).options.map((o) => o.price)).toEqual([
      { weekday: 35, weekend: 35 },
      { weekday: 5, weekend: 5 },
    ]);
  });
});

describe('the menu item form’s own option groups', () => {
  type Props = Parameters<typeof MenuItemFormWithPorts>[0];
  const categories: MenuCategoryDef[] = [
    { id: 'cat-zz-food', name: 'ZZ TEST Food', sortOrder: 0, defaultPrepStation: 'kitchen', defaultTaxCategory: 'fnb' },
  ];
  const menuHelpers = createMenuHelpers({ catalog: { getMenuCategories: () => categories, getModifierGroups: () => [] } });
  const item = (): MenuItem => ({
    id: 'zz-test-fries',
    name: 'ZZ TEST Fries',
    category: 'cat-zz-food',
    price: { weekday: 90, weekend: 110 },
    modifierGroups: [group()],
  });
  const mount = (onSave: Props['onSave']) => {
    const rendered = renderHook(MenuItemFormWithPorts, {
      open: true,
      item: item(),
      onClose: vi.fn(),
      onSave,
      ports: { menuCategories: categories, modifierGroups: [], menuHelpers },
    });
    unmount = rendered.unmount;
    return rendered;
  };

  it('saves an option holding two prices with the same two prices when the price is not touched', async () => {
    const onSave = vi.fn();
    const rendered = mount(onSave);
    expect(rowsOf(rendered.result.current).prices).toEqual([mixed, { weekday: 5, weekend: 5 }]);
    await submit(rendered.result.current);
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as MenuItem;
    expect(saved.price).toEqual({ weekday: 90, weekend: 110 });
    expect(saved.modifierGroups![0]!.options).toEqual([
      { id: 'opt-zz-ketchup', name: 'ZZ TEST Ketchup', price: { weekday: 10, weekend: 25 }, cost: 4 },
      { id: 'opt-zz-mayo', name: 'ZZ TEST Mayo', price: { weekday: 5, weekend: 5 } },
    ]);
  });

  it('saves a typed price as both the weekday and the weekend price, the other option untouched', async () => {
    const onSave = vi.fn();
    const rendered = mount(onSave);
    rowsOf(rendered.result.current).typePrice(0, '35');
    await submit(rendered.result.current);
    expect((onSave.mock.calls[0]![0] as MenuItem).modifierGroups![0]!.options.map((o) => o.price)).toEqual([
      { weekday: 35, weekend: 35 },
      { weekday: 5, weekend: 5 },
    ]);
  });
});
