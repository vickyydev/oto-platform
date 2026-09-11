import { useEffect, useMemo, useState } from 'react';
import type { MenuCategoryDef, PrepStation, TaxableCategory } from '@/types';
import { topLevelCategories, subCategoriesOf } from '@/lib/menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  PREP_STATION_LABELS,
  PREP_STATION_OPTIONS,
  TAX_CATEGORY_LABELS,
  TAX_CATEGORY_OPTIONS,
} from './categoryLabels';

// Sentinels for the "(no parent / top-level)" and "inherit from parent" choices
// (Radix Select can't use an empty-string value).
const NO_PARENT = '__none__';
const INHERIT = '__inherit__';

interface CategoryFormDialogProps {
  open: boolean;
  /** The category being edited, or null when creating a new one. */
  category: MenuCategoryDef | null;
  /** The full live category list — used for the parent picker and sort order. */
  categories: MenuCategoryDef[];
  /** Pre-selected parent id when adding a sub-category from a parent's row. */
  defaultParentId?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (category: MenuCategoryDef) => void;
}

interface FormErrors {
  name?: string;
}

/**
 * Create/Edit form for a single F&B menu category. A category is either
 * TOP-LEVEL (no parent) or a SUB-CATEGORY of a top-level category. Top-level
 * categories carry concrete default prep-station + tax values; sub-categories
 * may instead INHERIT the parent's. The id is generated once on create and
 * preserved across edits so existing menu items keep pointing at it.
 */
export function CategoryFormDialog({
  open,
  category,
  categories,
  defaultParentId,
  onOpenChange,
  onSave,
}: CategoryFormDialogProps) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string>(NO_PARENT);
  const [defaultPrepStation, setDefaultPrepStation] = useState<
    PrepStation | typeof INHERIT
  >('kitchen');
  const [defaultTaxCategory, setDefaultTaxCategory] = useState<
    TaxableCategory | typeof INHERIT
  >('fnb');
  const [errors, setErrors] = useState<FormErrors>({});

  // A category that already has sub-categories must stay top-level (we only
  // support two levels — it can't become a grand-child).
  const hasChildren = useMemo(
    () =>
      category ? subCategoriesOf(category.id, categories).length > 0 : false,
    [category, categories]
  );

  // Eligible parents: top-level categories, excluding the one being edited.
  const parentOptions = useMemo(
    () =>
      topLevelCategories(categories).filter((c) => c.id !== category?.id),
    [categories, category]
  );

  const parent =
    parentId === NO_PARENT
      ? undefined
      : categories.find((c) => c.id === parentId);
  const isSub = parentId !== NO_PARENT;

  // Reset the fields whenever the dialog opens (for add) or the target changes.
  useEffect(() => {
    if (!open) return;
    setName(category?.name ?? '');
    setParentId(category?.parentId ?? defaultParentId ?? NO_PARENT);
    setDefaultPrepStation(category?.defaultPrepStation ?? 'kitchen');
    setDefaultTaxCategory(category?.defaultTaxCategory ?? 'fnb');
    setErrors({});
  }, [open, category, defaultParentId]);

  // When toggling to a sub-category with no explicit value yet, default the
  // selects to "inherit"; when toggling back to top-level, give concrete values.
  const handleParentChange = (next: string) => {
    setParentId(next);
    if (next === NO_PARENT) {
      if (defaultPrepStation === INHERIT) setDefaultPrepStation('kitchen');
      if (defaultTaxCategory === INHERIT) setDefaultTaxCategory('fnb');
    } else {
      // New sub-category (no stored override) → default to inheriting.
      if (!category?.defaultPrepStation) setDefaultPrepStation(INHERIT);
      if (!category?.defaultTaxCategory) setDefaultTaxCategory(INHERIT);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const nextErrors: FormErrors = {};

    if (!trimmedName) nextErrors.name = 'Name is required.';

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    const newParentId = isSub ? parentId : undefined;
    const parentChanged = newParentId !== category?.parentId;

    // sortOrder is per-level: keep position on a same-parent edit, otherwise
    // append to the end of the destination level (top-level row or a parent).
    let sortOrder: number;
    if (category && !parentChanged) {
      sortOrder = category.sortOrder;
    } else {
      const siblings = categories.filter(
        (c) => c.parentId === newParentId && c.id !== category?.id
      );
      sortOrder =
        siblings.length > 0
          ? Math.max(...siblings.map((c) => c.sortOrder)) + 1
          : 0;
    }

    onSave({
      id: category?.id ?? crypto.randomUUID(),
      name: trimmedName,
      ...(newParentId ? { parentId: newParentId } : {}),
      ...(defaultPrepStation !== INHERIT
        ? { defaultPrepStation: defaultPrepStation }
        : {}),
      ...(defaultTaxCategory !== INHERIT
        ? { defaultTaxCategory: defaultTaxCategory }
        : {}),
      sortOrder,
    });
    onOpenChange(false);
  };

  const inheritedPrepLabel = parent?.defaultPrepStation
    ? PREP_STATION_LABELS[parent.defaultPrepStation]
    : '—';
  const inheritedTaxLabel = parent?.defaultTaxCategory
    ? TAX_CATEGORY_LABELS[parent.defaultTaxCategory]
    : '—';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {category ? 'Edit category' : 'Add category'}
          </DialogTitle>
          <DialogDescription>
            Categories group F&B items and set the default prep station and tax
            treatment for their items (both overridable per item). A
            sub-category can inherit those defaults from its parent.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Desserts"
              autoFocus
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-parent">Parent category</Label>
            <Select
              value={parentId}
              onValueChange={handleParentChange}
              disabled={hasChildren || parentOptions.length === 0}
            >
              <SelectTrigger id="cat-parent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PARENT}>None (top-level)</SelectItem>
                {parentOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-foreground/40">
              {hasChildren
                ? 'This category has sub-categories, so it must stay top-level.'
                : 'Pick a parent to make this a sub-category, or leave as top-level.'}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-prep">Default prep station</Label>
            <Select
              value={defaultPrepStation}
              onValueChange={(v) =>
                setDefaultPrepStation(v as PrepStation | typeof INHERIT)
              }
            >
              <SelectTrigger id="cat-prep">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {isSub && (
                  <SelectItem value={INHERIT}>
                    Inherit from parent ({inheritedPrepLabel})
                  </SelectItem>
                )}
                {PREP_STATION_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {PREP_STATION_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-foreground/40">
              Where these items' prep tickets print by default.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-tax">Default tax category</Label>
            <Select
              value={defaultTaxCategory}
              onValueChange={(v) =>
                setDefaultTaxCategory(v as TaxableCategory | typeof INHERIT)
              }
            >
              <SelectTrigger id="cat-tax">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {isSub && (
                  <SelectItem value={INHERIT}>
                    Inherit from parent ({inheritedTaxLabel})
                  </SelectItem>
                )}
                {TAX_CATEGORY_OPTIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {TAX_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">
              {category ? 'Save changes' : 'Add category'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
