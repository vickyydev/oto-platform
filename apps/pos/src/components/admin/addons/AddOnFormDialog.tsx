import { useEffect, useState } from 'react';
import type { AddOn, TaxableCategory, WeekdayWeekendPrice } from '@/types';
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

// Sentinel for "inherit from the 'addons' category rule" — Radix can't use ''.
const USE_DEFAULT = '__default__';

// All sellable taxable categories an add-on can be reassigned to.
const TAX_CAT_OPTIONS: { value: TaxableCategory; label: string }[] = [
  { value: 'addons',   label: 'Add-ons (default)' },
  { value: 'tickets',  label: 'Tickets' },
  { value: 'fnb',      label: 'F&B' },
  { value: 'bar',      label: 'Bar (alcohol)' },
  { value: 'drop_off', label: 'Drop-off / nanny' },
  { value: 'parties',  label: 'Parties / events' },
  { value: 'merch',    label: 'Retail / merch' },
];

interface AddOnFormDialogProps {
  open: boolean;
  /** The add-on being edited, or null when creating a new one. */
  addOn: AddOn | null;
  onOpenChange: (open: boolean) => void;
  /**
   * `trackStock` tells the panel whether this add-on should be linked to a
   * unified inventory item (create the link when true, drop it when false).
   */
  onSave: (addOn: AddOn, trackStock: boolean) => void;
}

interface FormErrors {
  name?: string;
  price?: string;
}

/**
 * Create/Edit form for a single add-on (name + price ฿). Used in both modes:
 * pre-filled when `addOn` is provided, blank when it's null.
 */
export function AddOnFormDialog({
  open,
  addOn,
  onOpenChange,
  onSave,
}: AddOnFormDialogProps) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState<WeekdayWeekendPrice>({ weekday: 0, weekend: 0 });
  const [trackStock, setTrackStock] = useState(false);
  const [taxCategoryOverride, setTaxCategoryOverride] = useState<string>(USE_DEFAULT);
  const [errors, setErrors] = useState<FormErrors>({});

  // Reset the fields whenever the dialog opens (for add) or the target changes.
  useEffect(() => {
    if (open) {
      setName(addOn?.name ?? '');
      setPrice(addOn?.price ?? { weekday: 0, weekend: 0 });
      // Reflect the current link state when editing; new add-ons default to
      // non-stocked (lockers, digital extras, etc. shouldn't be forced stocked).
      setTrackStock(!!addOn?.inventoryItemId);
      setTaxCategoryOverride(addOn?.taxCategoryOverride ?? USE_DEFAULT);
      setErrors({});
    }
  }, [open, addOn]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const nextErrors: FormErrors = {};

    if (!trimmedName) nextErrors.name = 'Name is required.';
    if (price.weekday < 0 || price.weekend < 0) {
      nextErrors.price = 'Price must be 0 or more.';
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    onSave(
      {
        // Spread the existing addOn first so optional fields (inventoryItemId, etc.)
        // are preserved on edit; then override only the fields this form controls.
        ...(addOn ?? {}),
        id: addOn?.id ?? crypto.randomUUID(),
        name: trimmedName,
        price,
        ...(taxCategoryOverride !== USE_DEFAULT
          ? { taxCategoryOverride: taxCategoryOverride as TaxableCategory }
          : { taxCategoryOverride: undefined }),
      },
      trackStock,
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{addOn ? 'Edit add-on' : 'Add add-on'}</DialogTitle>
          <DialogDescription>
            {addOn
              ? 'Update the name or price for this extra.'
              : 'Create a new extra (socks, locker, cup…) for the till.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="addon-name">Name</Label>
            <Input
              id="addon-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Grip Socks"
              autoFocus
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          <WeekdayWeekendPriceInput
            label="Price"
            value={price}
            onChange={setPrice}
            error={errors.price}
          />

          {/* Tax category override */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="addon-tax-cat">Tax category</Label>
            <Select
              value={taxCategoryOverride}
              onValueChange={setTaxCategoryOverride}
            >
              <SelectTrigger id="addon-tax-cat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={USE_DEFAULT}>
                  Use category default (Add-ons)
                </SelectItem>
                {TAX_CAT_OPTIONS.filter((o) => o.value !== 'addons').map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    Override → {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-foreground/50">
              Inherits the Add-ons tax rule unless overridden here.
            </p>
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg border border-foreground/10 p-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={trackStock}
                onChange={(e) => setTrackStock(e.target.checked)}
                className="h-4 w-4 rounded border-foreground/30 accent-primary"
              />
              <span className="text-sm font-medium">Track stock for this add-on</span>
            </label>
            <p className="pl-7 text-xs text-foreground/50">
              {trackStock
                ? 'Creates a linked inventory item so the till can prevent overselling. Add size variants (S / M / L) and set counts in the Inventory panel.'
                : 'Leave off for unlimited extras like lockers or digital items.'}
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">{addOn ? 'Save changes' : 'Add add-on'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
