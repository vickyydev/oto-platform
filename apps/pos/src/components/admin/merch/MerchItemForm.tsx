import { useEffect, useState } from 'react';
import type { MerchItem, TaxableCategory, WeekdayWeekendPrice } from '@/types';
import { WeekdayWeekendPriceInput } from '@/components/shared/WeekdayWeekendPriceInput';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { slugId } from '../menu/menuItem';

// Sentinel for "inherit from the 'merch' category rule" — Radix can't use ''.
const USE_DEFAULT = '__default__';

// All sellable taxable categories a merch item can be reassigned to.
const TAX_CAT_OPTIONS: { value: TaxableCategory; label: string }[] = [
  { value: 'merch',    label: 'Retail / merch (default)' },
  { value: 'tickets',  label: 'Tickets' },
  { value: 'fnb',      label: 'F&B' },
  { value: 'bar',      label: 'Bar (alcohol)' },
  { value: 'drop_off', label: 'Drop-off / nanny' },
  { value: 'parties',  label: 'Parties / events' },
  { value: 'addons',   label: 'Add-ons' },
];

interface MerchItemFormProps {
  open: boolean;
  item: MerchItem | null;
  onClose: () => void;
  /**
   * `trackStock` tells the panel whether this merch item should be linked to a
   * unified inventory item (create the link when true, drop it when false).
   */
  onSave: (item: MerchItem, trackStock: boolean) => void;
}

interface FormState {
  name: string;
  category: string;
  sku: string;
  price: WeekdayWeekendPrice;
  cost: string;
  active: boolean;
  trackStock: boolean;
  taxCategoryOverride: string; // TaxableCategory or USE_DEFAULT sentinel
}

interface FormErrors {
  name?: string;
  price?: string;
  cost?: string;
}

const blankState = (): FormState => ({
  name: '',
  category: '',
  sku: '',
  price: { weekday: 0, weekend: 0 },
  cost: '',
  active: true,
  // Physical merch is stock-tracked by default; the admin can opt out.
  trackStock: true,
  taxCategoryOverride: USE_DEFAULT,
});

const fromItem = (m: MerchItem): FormState => ({
  name: m.name,
  category: m.category ?? '',
  sku: m.sku ?? '',
  price: m.price,
  cost: m.cost != null ? String(m.cost) : '',
  active: m.active,
  trackStock: !!m.inventoryItemId,
  taxCategoryOverride: m.taxCategoryOverride ?? USE_DEFAULT,
});

/**
 * Add/edit dialog for a retail/merch item. Handles item metadata only (name,
 * price, cost, SKU, category, active flag, tax override). Stock is managed in
 * the unified Inventory panel — there are no stock fields here.
 */
export function MerchItemForm({ open, item, onClose, onSave }: MerchItemFormProps) {
  const [form, setForm] = useState<FormState>(() => blankState());
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (!open) return;
    setForm(item ? fromItem(item) : blankState());
    setErrors({});
  }, [open, item]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const validate = (): MerchItem | null => {
    const next: FormErrors = {};
    const name = form.name.trim();
    if (!name) next.name = 'Name is required.';

    if (form.price.weekday < 0 || form.price.weekend < 0) {
      next.price = 'Price must be 0 or more.';
    }

    const hasCost = form.cost.trim() !== '';
    const costNum = Number(form.cost);
    if (hasCost && (Number.isNaN(costNum) || costNum < 0)) {
      next.cost = 'Cost must be 0 or more.';
    }

    if (next.name || next.price || next.cost) {
      setErrors(next);
      return null;
    }

    const category = form.category.trim();
    const sku = form.sku.trim();
    return {
      id: item?.id ?? slugId(name),
      name,
      active: form.active,
      price: form.price,
      // Preserve existing inventory link when editing
      ...(item?.inventoryItemId ? { inventoryItemId: item.inventoryItemId } : {}),
      ...(hasCost ? { cost: costNum } : {}),
      ...(sku ? { sku } : {}),
      ...(category ? { category } : {}),
      ...(form.taxCategoryOverride !== USE_DEFAULT
        ? { taxCategoryOverride: form.taxCategoryOverride as TaxableCategory }
        : { taxCategoryOverride: undefined }),
    };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validate();
    if (result) onSave(result, form.trackStock);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? 'Edit merch item' : 'Add merch item'}</DialogTitle>
          <DialogDescription>
            Item metadata only. Manage stock counts in the Inventory panel.
          </DialogDescription>
        </DialogHeader>

        <form id="merch-item-form" onSubmit={handleSubmit} className="flex flex-col gap-5 pt-1">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mi-name">Name *</Label>
            <Input
              id="mi-name"
              placeholder="e.g. Oto T-Shirt"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
          </div>

          {/* Category */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mi-category">Category</Label>
            <Input
              id="mi-category"
              placeholder="e.g. Apparel, Accessories"
              value={form.category}
              onChange={(e) => setField('category', e.target.value)}
            />
          </div>

          {/* SKU */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mi-sku">SKU / Barcode</Label>
            <Input
              id="mi-sku"
              placeholder="e.g. OTO-TS-001"
              value={form.sku}
              onChange={(e) => setField('sku', e.target.value)}
            />
          </div>

          {/* Price + Cost */}
          <div className="grid grid-cols-2 gap-4">
            <WeekdayWeekendPriceInput
              label="Sell price *"
              value={form.price}
              onChange={(next) => setField('price', next)}
              error={errors.price}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mi-cost">Cost (฿)</Label>
              <Input
                id="mi-cost"
                type="number"
                min={0}
                step={1}
                placeholder="120"
                value={form.cost}
                onChange={(e) => setField('cost', e.target.value)}
              />
              {errors.cost && <p className="text-xs text-destructive">{errors.cost}</p>}
            </div>
          </div>

          {/* Tax category override */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mi-tax-cat">Tax category</Label>
            <Select
              value={form.taxCategoryOverride}
              onValueChange={(v) => setField('taxCategoryOverride', v)}
            >
              <SelectTrigger id="mi-tax-cat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={USE_DEFAULT}>
                  Use category default (Retail / merch)
                </SelectItem>
                {TAX_CAT_OPTIONS.filter((o) => o.value !== 'merch').map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    Override → {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-foreground/50">
              Inherits the Retail / merch tax rule unless overridden here.
            </p>
          </div>

          {/* Active */}
          <div className="flex items-center gap-3">
            <input
              id="mi-active"
              type="checkbox"
              checked={form.active}
              onChange={(e) => setField('active', e.target.checked)}
              className="h-4 w-4 rounded border-foreground/30 accent-primary"
            />
            <Label htmlFor="mi-active" className="cursor-pointer">
              Active (visible on the sell surface)
            </Label>
          </div>

          {/* Stock tracking */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-foreground/10 p-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.trackStock}
                onChange={(e) => setField('trackStock', e.target.checked)}
                className="h-4 w-4 rounded border-foreground/30 accent-primary"
              />
              <span className="text-sm font-medium">Track stock for this item</span>
            </label>
            <p className="pl-7 text-xs text-foreground/50">
              {form.trackStock
                ? 'Creates a linked inventory item so the till can prevent overselling. Add size variants and set counts in the Inventory panel.'
                : "Leave off for unlimited / made-to-order items that don\u2019t need stock counts."}
            </p>
          </div>
        </form>

        <DialogFooter className="mt-4">
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="merch-item-form">
            {item ? 'Save changes' : 'Add item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
