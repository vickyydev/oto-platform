import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { MerchItem, MerchVariant, TaxableCategory, WeekdayWeekendPrice } from '@/types';
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

/**
 * One row of the Sizes editor (S2-09b). `id` is the platform's stable size id
 * and is set only on a size that already exists — renaming a size keeps it, so
 * the sales that recorded it still name it. A new row is given one on save.
 * `key` is React's, and nothing else's.
 */
interface SizeRow {
  key: string;
  id?: string;
  label: string;
  barcode: string;
  /** A size's own stock code has no field here; it is carried through untouched. */
  sku?: string;
}

interface FormState {
  name: string;
  category: string;
  sku: string;
  sizes: SizeRow[];
  price: WeekdayWeekendPrice;
  cost: string;
  active: boolean;
  trackStock: boolean;
  taxCategoryOverride: string; // TaxableCategory or USE_DEFAULT sentinel
}

interface FormErrors {
  name?: string;
  sizes?: string;
  price?: string;
  cost?: string;
}

let sizeKeyCounter = 0;
const nextSizeKey = () => `size-row-${++sizeKeyCounter}`;

const blankState = (): FormState => ({
  name: '',
  category: '',
  sku: '',
  sizes: [],
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
  sizes: (m.variants ?? []).map((v) => ({
    key: nextSizeKey(),
    id: v.id,
    label: v.label,
    barcode: v.barcode ?? '',
    ...(v.sku ? { sku: v.sku } : {}),
  })),
  price: m.price,
  cost: m.cost != null ? String(m.cost) : '',
  active: m.active,
  trackStock: !!m.inventoryItemId,
  taxCategoryOverride: m.taxCategoryOverride ?? USE_DEFAULT,
});

/** A barcode the scanner can read: digits, eight to fourteen of them. */
const BARCODE_SHAPE = /^[0-9]{8,14}$/;

/**
 * A size id minted from its label — `M` becomes `m`, `Extra large` becomes
 * `extra-large` — in the shape the platform takes (a–z, 0–9, hyphen, at most
 * 32). A label with no such characters in it (a Thai one, say) falls back to
 * `size-<n>`. Never one already taken on this item.
 */
function mintSizeId(label: string, taken: Set<string>): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const base = slug || 'size';
  let id = slug || `size-${taken.size + 1}`;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * The Sizes editor's rules — the platform's own (`services/product-variants.ts`),
 * asked here first so the admin sees the reason beside the field rather than
 * after a round trip. The platform still asks them all, and the one question
 * only it can answer — is a barcode already on ANOTHER item — comes back from
 * it as the save's toast.
 */
function sizesProblem(sizes: SizeRow[], itemSku: string): string | undefined {
  const labels = new Set<string>();
  const barcodes = new Set<string>();
  for (const size of sizes) {
    const label = size.label.trim();
    if (!label) return 'Every size needs a name, e.g. S, M or L.';
    if (labels.has(label.toLocaleLowerCase())) return `Two sizes are both called "${label}".`;
    labels.add(label.toLocaleLowerCase());
    const barcode = size.barcode.trim();
    if (!barcode) continue;
    if (!BARCODE_SHAPE.test(barcode)) return `The barcode on size "${label}" must be 8 to 14 digits.`;
    if (barcodes.has(barcode)) return `Two sizes carry the barcode ${barcode}.`;
    if (barcode === itemSku) return `${barcode} is already this item's own barcode.`;
    barcodes.add(barcode);
  }
  return undefined;
}

/** The rows as the item's sizes, keeping every existing size's id. */
function sizesToVariants(sizes: SizeRow[]): MerchVariant[] {
  const taken = new Set(sizes.map((s) => s.id).filter((id): id is string => !!id));
  return sizes.map((size) => {
    const label = size.label.trim();
    let id = size.id;
    if (!id) {
      id = mintSizeId(label, taken);
      taken.add(id);
    }
    const barcode = size.barcode.trim();
    return {
      id,
      label,
      ...(size.sku ? { sku: size.sku } : {}),
      ...(barcode ? { barcode } : {}),
    };
  });
}

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

  const addSize = () =>
    setForm((f) => ({ ...f, sizes: [...f.sizes, { key: nextSizeKey(), label: '', barcode: '' }] }));
  const setSize = (key: string, patch: Partial<Pick<SizeRow, 'label' | 'barcode'>>) =>
    setForm((f) => ({
      ...f,
      sizes: f.sizes.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    }));
  const removeSize = (key: string) =>
    setForm((f) => ({ ...f, sizes: f.sizes.filter((s) => s.key !== key) }));

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

    const sku = form.sku.trim();
    next.sizes = sizesProblem(form.sizes, sku);

    if (next.name || next.sizes || next.price || next.cost) {
      setErrors(next);
      return null;
    }

    const category = form.category.trim();
    const variants = sizesToVariants(form.sizes);
    return {
      id: item?.id ?? slugId(name),
      name,
      active: form.active,
      price: form.price,
      // Preserve existing inventory link when editing
      ...(item?.inventoryItemId ? { inventoryItemId: item.inventoryItemId } : {}),
      ...(hasCost ? { cost: costNum } : {}),
      ...(sku ? { sku } : {}),
      // Always set, so an edit that removed the last size saves "no sizes"
      // rather than leaving the old ones on the item.
      variants,
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

          {/* Sizes (S2-09b) */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label>Sizes</Label>
              <Button type="button" variant="outline" size="sm" onClick={addSize}>
                <Plus className="w-3.5 h-3.5" />
                Add size
              </Button>
            </div>
            {form.sizes.length === 0 ? (
              <p className="text-xs text-foreground/50">
                One size. Add sizes (S, M, L…) and the shop asks which one before it adds the item.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {form.sizes.map((size, index) => (
                  <div key={size.key} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2">
                    <Input
                      aria-label={`Size ${index + 1} name`}
                      placeholder="e.g. M"
                      value={size.label}
                      onChange={(e) => setSize(size.key, { label: e.target.value })}
                    />
                    <Input
                      aria-label={`Size ${index + 1} barcode`}
                      placeholder="Barcode (optional)"
                      inputMode="numeric"
                      value={size.barcode}
                      onChange={(e) => setSize(size.key, { barcode: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => removeSize(size.key)}
                      aria-label={`Remove size ${size.label || index + 1}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-foreground/50">
                  Scanning a size&apos;s barcode adds that size without asking.
                </p>
              </div>
            )}
            {errors.sizes && <p className="text-xs text-destructive">{errors.sizes}</p>}
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
