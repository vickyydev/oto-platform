import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  MenuItem,
  ModifierGroup,
  ModifierOption,
  PrepStation,
  TaxableCategory,
  WeekdayWeekendPrice,
} from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { WeekdayWeekendPriceInput } from '@/components/shared/WeekdayWeekendPriceInput';
import {
  topLevelCategories,
  subCategoriesOf,
  categoryPrepStation,
  categoryTaxCategory,
} from '@/lib/menu';
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
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group';
import { randomId, slugId } from './menuItem';

// Sentinel for the "Use category default" choice in the override selects (Radix
// Select can't use an empty-string value).
const USE_DEFAULT = '__default__';

// Sentinel for the "No sub-category" choice in the two-level category picker
// (the item then sits directly on the top-level category).
const SUB_NONE = '__none__';

// Prep-station override choices. 'none' = doesn't print to a prep station.
const PREP_STATION_OPTIONS: { value: PrepStation; label: string }[] = [
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'bar', label: 'Bar' },
  { value: 'none', label: 'No prep ticket' },
];

// F&B lines are taxed as either general F&B or the alcohol (bar) area.
const TAX_CATEGORY_OPTIONS: { value: TaxableCategory; label: string }[] = [
  { value: 'fnb', label: 'F&B' },
  { value: 'bar', label: 'Bar (alcohol)' },
];

const prepStationLabel = (s: PrepStation): string =>
  PREP_STATION_OPTIONS.find((o) => o.value === s)?.label ?? s;

const taxCategoryLabel = (c: TaxableCategory): string =>
  TAX_CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c;

interface MenuItemFormProps {
  open: boolean;
  /** The menu item being edited, or null when creating a new one. */
  item: MenuItem | null;
  onClose: () => void;
  onSave: (item: MenuItem, trackStock: boolean) => void;
}

interface OptionDraft {
  id: string;
  name: string;
  price: WeekdayWeekendPrice;
  cost: string;
}

interface GroupDraft {
  id: string;
  name: string;
  required: boolean;
  selectionType: 'single' | 'multi';
  min: string;
  max: string;
  options: OptionDraft[];
}

interface FormState {
  name: string;
  category: string;
  // Overrides hold a concrete value or USE_DEFAULT ("inherit from category").
  prepStationOverride: PrepStation | typeof USE_DEFAULT;
  taxCategoryOverride: TaxableCategory | typeof USE_DEFAULT;
  price: WeekdayWeekendPrice;
  cost: string;
  groups: GroupDraft[];
  // Ids of shared library groups attached to this item (in addition to inline).
  linkedGroupIds: string[];
  // Whether this item is stock-tracked (links to an InventoryItem). Variant sizes
  // are managed in the Inventory panel — this toggle just creates/removes the link.
  trackStock: boolean;
}

interface GroupErrors {
  name?: string;
  range?: string;
  options?: Record<string, string>;
}

interface FormErrors {
  name?: string;
  category?: string;
  price?: string;
  cost?: string;
  groups?: Record<string, GroupErrors>;
}

const blankState = (defaultCategory: string): FormState => ({
  name: '',
  category: defaultCategory,
  prepStationOverride: USE_DEFAULT,
  taxCategoryOverride: USE_DEFAULT,
  price: { weekday: 0, weekend: 0 },
  cost: '',
  groups: [],
  linkedGroupIds: [],
  trackStock: false,
});

const fromItem = (m: MenuItem): FormState => ({
  name: m.name,
  category: m.category,
  prepStationOverride: m.prepStationOverride ?? USE_DEFAULT,
  taxCategoryOverride: m.taxCategoryOverride ?? USE_DEFAULT,
  price: m.price,
  cost: m.cost != null ? String(m.cost) : '',
  groups: (m.modifierGroups ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    required: g.required,
    selectionType: g.selectionType,
    min: g.min != null ? String(g.min) : '',
    max: g.max != null ? String(g.max) : '',
    options: g.options.map((o) => ({
      id: o.id,
      name: o.name,
      price: o.price,
      cost: o.cost != null ? String(o.cost) : '',
    })),
  })),
  linkedGroupIds: m.linkedModifierGroupIds ?? [],
  trackStock: !!m.inventoryItemId,
});

export function MenuItemForm({ open, item, onClose, onSave }: MenuItemFormProps) {
  const { menuCategories, modifierGroups } = useCatalogStore();
  const orderedCategories = [...menuCategories].sort(
    (a, b) => a.sortOrder - b.sortOrder
  );
  const fallbackCategory = orderedCategories[0]?.id ?? '';

  const [form, setForm] = useState<FormState>(() => blankState(fallbackCategory));
  const [errors, setErrors] = useState<FormErrors>({});

  // The category def the item currently belongs to (top-level OR sub-category) —
  // drives the "default" labels on the override selects so staff see what they'd
  // inherit (resolved through a sub-category's parent when unset).
  const selectedCategory = orderedCategories.find((c) => c.id === form.category);

  // Two-level picker state, derived from the single stored `form.category` id:
  // the top-level is either the selected category itself (when top-level) or its
  // parent (when the selection is a sub-category).
  const topLevels = topLevelCategories(orderedCategories);
  const selectedTopId = selectedCategory?.parentId ?? selectedCategory?.id ?? '';
  const subOptions = subCategoriesOf(selectedTopId, orderedCategories);
  // The sub-category currently chosen, or SUB_NONE when the item sits directly
  // on the top-level category.
  const selectedSubId = selectedCategory?.parentId ? form.category : SUB_NONE;

  const inheritedPrep = selectedCategory
    ? categoryPrepStation(selectedCategory, orderedCategories)
    : undefined;
  const inheritedTax = selectedCategory
    ? categoryTaxCategory(selectedCategory, orderedCategories)
    : undefined;

  // Pick a top-level: store its id directly (drops any previous sub-category).
  const handleTopLevelChange = (topId: string) => setField('category', topId);
  // Pick a sub-category (or "None" to keep the item on the top-level).
  const handleSubChange = (subId: string) =>
    setField('category', subId === SUB_NONE ? selectedTopId : subId);

  // Re-seed the form (and clear errors) every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setForm(item ? fromItem(item) : blankState(fallbackCategory));
    setErrors({});
    // fallbackCategory only matters on open; categories rarely change mid-dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const addGroup = () =>
    setForm((f) => ({
      ...f,
      groups: [
        ...f.groups,
        {
          id: randomId('grp'),
          name: '',
          required: false,
          selectionType: 'single',
          min: '',
          max: '',
          options: [{ id: randomId('opt'), name: '', price: { weekday: 0, weekend: 0 }, cost: '' }],
        },
      ],
    }));

  const updateGroup = (id: string, patch: Partial<GroupDraft>) =>
    setForm((f) => ({
      ...f,
      groups: f.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    }));

  const removeGroup = (id: string) =>
    setForm((f) => ({ ...f, groups: f.groups.filter((g) => g.id !== id) }));

  const addOption = (groupId: string) =>
    setForm((f) => ({
      ...f,
      groups: f.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              options: [
                ...g.options,
                { id: randomId('opt'), name: '', price: { weekday: 0, weekend: 0 }, cost: '' },
              ],
            }
          : g
      ),
    }));

  const updateOption = (
    groupId: string,
    optionId: string,
    patch: Partial<OptionDraft>
  ) =>
    setForm((f) => ({
      ...f,
      groups: f.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              options: g.options.map((o) =>
                o.id === optionId ? { ...o, ...patch } : o
              ),
            }
          : g
      ),
    }));

  const removeOption = (groupId: string, optionId: string) =>
    setForm((f) => ({
      ...f,
      groups: f.groups.map((g) =>
        g.id === groupId
          ? { ...g, options: g.options.filter((o) => o.id !== optionId) }
          : g
      ),
    }));

  const toggleLinkedGroup = (id: string) =>
    setForm((f) => ({
      ...f,
      linkedGroupIds: f.linkedGroupIds.includes(id)
        ? f.linkedGroupIds.filter((x) => x !== id)
        : [...f.linkedGroupIds, id],
    }));

  const validate = (): MenuItem | null => {
    const next: FormErrors = {};
    const name = form.name.trim();
    if (!name) next.name = 'Name is required.';

    // Guard against an empty/stale category (e.g. all categories deleted, or the
    // item's category removed) — every item must belong to a known category.
    if (!form.category || !orderedCategories.some((c) => c.id === form.category)) {
      next.category =
        orderedCategories.length === 0
          ? 'Create a category first.'
          : 'Select a category.';
    }

    if (form.price.weekday < 0 || form.price.weekend < 0) {
      next.price = 'Price must be 0 or more.';
    }

    const costNum = Number(form.cost);
    const hasCost = form.cost.trim() !== '';
    if (hasCost && (Number.isNaN(costNum) || costNum < 0)) {
      next.cost = 'Cost must be 0 or more.';
    }

    const groupErrors: Record<string, GroupErrors> = {};
    for (const g of form.groups) {
      const ge: GroupErrors = {};
      if (!g.name.trim()) ge.name = 'Group name is required.';

      if (g.options.length === 0) {
        ge.options = { __group: 'Add at least one option.' };
      } else {
        const optErrors: Record<string, string> = {};
        for (const o of g.options) {
          const c = Number(o.cost);
          const optHasCost = o.cost.trim() !== '';
          if (!o.name.trim()) {
            optErrors[o.id] = 'Option name is required.';
          } else if (o.price.weekday < 0 || o.price.weekend < 0) {
            optErrors[o.id] = 'Price must be 0 or more.';
          } else if (optHasCost && (Number.isNaN(c) || c < 0)) {
            optErrors[o.id] = 'Cost must be 0 or more.';
          }
        }
        if (Object.keys(optErrors).length) ge.options = optErrors;
      }

      if (g.selectionType === 'multi') {
        const hasMin = g.min.trim() !== '';
        const hasMax = g.max.trim() !== '';
        const minNum = Number(g.min);
        const maxNum = Number(g.max);
        if (hasMin && (Number.isNaN(minNum) || minNum < 0)) {
          ge.range = 'Min must be 0 or more.';
        } else if (hasMax && (Number.isNaN(maxNum) || maxNum < 0)) {
          ge.range = 'Max must be 0 or more.';
        } else if (hasMin && hasMax && minNum > maxNum) {
          ge.range = 'Min cannot exceed max.';
        }
      }

      if (ge.name || ge.range || ge.options) groupErrors[g.id] = ge;
    }
    if (Object.keys(groupErrors).length) next.groups = groupErrors;

    if (next.name || next.category || next.price || next.cost || next.groups) {
      setErrors(next);
      return null;
    }

    const inlineGroups: ModifierGroup[] = form.groups.map((g) => {
      const options: ModifierOption[] = g.options.map((o) => ({
        id: o.id,
        name: o.name.trim(),
        price: o.price,
        ...(o.cost.trim() !== '' ? { cost: Number(o.cost) } : {}),
      }));
      const group: ModifierGroup = {
        id: g.id,
        name: g.name.trim(),
        required: g.required,
        selectionType: g.selectionType,
        options,
      };
      if (g.selectionType === 'multi') {
        if (g.min.trim() !== '') group.min = Number(g.min);
        if (g.max.trim() !== '') group.max = Number(g.max);
      }
      return group;
    });

    // Only keep linked ids that still resolve to a library group.
    const linkedModifierGroupIds = form.linkedGroupIds.filter((id) =>
      modifierGroups.some((g) => g.id === id)
    );

    return {
      id: item?.id ?? slugId(name),
      name,
      category: form.category,
      price: form.price,
      ...(hasCost ? { cost: costNum } : {}),
      ...(inlineGroups.length ? { modifierGroups: inlineGroups } : {}),
      ...(linkedModifierGroupIds.length ? { linkedModifierGroupIds } : {}),
      ...(form.prepStationOverride !== USE_DEFAULT
        ? { prepStationOverride: form.prepStationOverride }
        : {}),
      ...(form.taxCategoryOverride !== USE_DEFAULT
        ? { taxCategoryOverride: form.taxCategoryOverride }
        : {}),
      // Preserve the existing inventory link so the panel's reconcile (which keys
      // off inventoryItemId) sees the true current state on edit.
      ...(item?.inventoryItemId ? { inventoryItemId: item.inventoryItemId } : {}),
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
          <DialogTitle>{item ? 'Edit menu item' : 'Add menu item'}</DialogTitle>
          <DialogDescription>
            Set the name, category and base price, then add any customization
            questions (modifier groups) the kitchen needs.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mi-name">Name</Label>
            <Input
              id="mi-name"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="e.g. Margherita Pizza"
              autoFocus
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mi-category">Category</Label>
              <Select
                value={selectedTopId}
                onValueChange={handleTopLevelChange}
              >
                <SelectTrigger id="mi-category">
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {topLevels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mi-subcategory">Sub-category</Label>
              <Select
                value={selectedSubId}
                onValueChange={handleSubChange}
                disabled={subOptions.length === 0}
              >
                <SelectTrigger id="mi-subcategory">
                  <SelectValue
                    placeholder={
                      subOptions.length === 0 ? 'None available' : 'None'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SUB_NONE}>None</SelectItem>
                  {subOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {errors.category && (
            <p className="-mt-3 text-xs text-destructive">{errors.category}</p>
          )}

          {/* Routing + tax overrides — default to inheriting from the category. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mi-prep">Prep station</Label>
              <Select
                value={form.prepStationOverride}
                onValueChange={(v) =>
                  setField(
                    'prepStationOverride',
                    v as FormState['prepStationOverride']
                  )
                }
              >
                <SelectTrigger id="mi-prep">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={USE_DEFAULT}>
                    Use category default
                    {inheritedPrep ? ` (${prepStationLabel(inheritedPrep)})` : ''}
                  </SelectItem>
                  {PREP_STATION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mi-tax">Tax category</Label>
              <Select
                value={form.taxCategoryOverride}
                onValueChange={(v) =>
                  setField(
                    'taxCategoryOverride',
                    v as FormState['taxCategoryOverride']
                  )
                }
              >
                <SelectTrigger id="mi-tax">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={USE_DEFAULT}>
                    Use category default
                    {inheritedTax ? ` (${taxCategoryLabel(inheritedTax)})` : ''}
                  </SelectItem>
                  {TAX_CATEGORY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <WeekdayWeekendPriceInput
              label="Base price"
              value={form.price}
              onChange={(next) => setField('price', next)}
              error={errors.price}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mi-cost">Cost (฿)</Label>
              <Input
                id="mi-cost"
                type="number"
                inputMode="numeric"
                min={0}
                step="1"
                value={form.cost}
                onChange={(e) => setField('cost', e.target.value)}
                placeholder="Optional"
              />
              {errors.cost && (
                <p className="text-xs text-destructive">{errors.cost}</p>
              )}
            </div>
          </div>

          {/* Stock tracking — links the item to the unified Inventory system. */}
          <label className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <span className="min-w-0">
              <span className="font-medium text-sm">Track stock</span>
              <p className="text-xs text-foreground/40">
                Decrement on-hand count when sold. Add size/type variants in the
                Inventory panel once tracking is on.
              </p>
            </span>
            <Switch
              checked={form.trackStock}
              onCheckedChange={(v) => setField('trackStock', v)}
              aria-label="Track stock"
            />
          </label>

          {/* Shared modifier groups (the reusable library) */}
          <div className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <div>
              <Label>Shared modifier groups</Label>
              <p className="text-xs text-foreground/40">
                Attach reusable groups managed under Modifiers. Edits there apply
                to every item that links them.
              </p>
            </div>

            {modifierGroups.length === 0 ? (
              <p className="text-xs text-foreground/40">
                No shared groups yet — create some under Modifiers to reuse here.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {modifierGroups.map((g) => {
                  const checked = form.linkedGroupIds.includes(g.id);
                  return (
                    // The back office renders light: a black overlay reads as a
                    // grey block here. This row and the inline group block below
                    // sit ON the card's `bg-foreground/[0.02]`, so they take the
                    // inset weight (`bg-foreground/5`) rather than the row one,
                    // which would vanish into the card (SCRUM-363, after 354).
                    <label
                      key={g.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-foreground/5 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{g.name}</span>
                        <span className="ml-2 text-xs text-foreground/40">
                          {g.options.length} option
                          {g.options.length === 1 ? '' : 's'}
                          {g.required ? ' · required' : ''}
                        </span>
                      </span>
                      <Switch
                        checked={checked}
                        onCheckedChange={() => toggleLinkedGroup(g.id)}
                        aria-label={`Attach ${g.name}`}
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Inline modifier groups (specific to this item) */}
          <div className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Item-specific modifier groups</Label>
                <p className="text-xs text-foreground/40">
                  Customization questions just for this item, like “Choose your
                  sauce”. Leave empty for a simple item.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addGroup}>
                <Plus className="h-4 w-4" />
                Add group
              </Button>
            </div>

            {form.groups.length === 0 ? (
              <p className="text-xs text-foreground/40">
                No modifier groups — this is a simple item.
              </p>
            ) : (
              form.groups.map((g) => {
                const ge = errors.groups?.[g.id];
                return (
                  <div
                    key={g.id}
                    className="flex flex-col gap-3 rounded-xl bg-foreground/5 p-3"
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex flex-1 flex-col gap-1.5">
                        <Input
                          value={g.name}
                          onChange={(e) =>
                            updateGroup(g.id, { name: e.target.value })
                          }
                          placeholder="Question, e.g. Choose your sauce"
                          aria-label="Group name"
                        />
                        {ge?.name && (
                          <p className="text-xs text-destructive">{ge.name}</p>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-destructive"
                        aria-label="Remove group"
                        onClick={() => removeGroup(g.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        value={g.selectionType}
                        onValueChange={(v) =>
                          v &&
                          updateGroup(g.id, {
                            selectionType: v as 'single' | 'multi',
                          })
                        }
                      >
                        <ToggleGroupItem value="single">
                          Choose one
                        </ToggleGroupItem>
                        <ToggleGroupItem value="multi">
                          Choose many
                        </ToggleGroupItem>
                      </ToggleGroup>

                      <label className="flex items-center gap-2 text-xs text-foreground/60">
                        <Switch
                          checked={g.required}
                          onCheckedChange={(checked) =>
                            updateGroup(g.id, { required: checked })
                          }
                        />
                        Required
                      </label>
                    </div>

                    {g.selectionType === 'multi' && (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5">
                            <Label
                              htmlFor={`${g.id}-min`}
                              className="text-xs text-foreground/50"
                            >
                              Min
                            </Label>
                            <Input
                              id={`${g.id}-min`}
                              type="number"
                              inputMode="numeric"
                              min={0}
                              step="1"
                              className="w-20"
                              value={g.min}
                              onChange={(e) =>
                                updateGroup(g.id, { min: e.target.value })
                              }
                              placeholder="0"
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Label
                              htmlFor={`${g.id}-max`}
                              className="text-xs text-foreground/50"
                            >
                              Max
                            </Label>
                            <Input
                              id={`${g.id}-max`}
                              type="number"
                              inputMode="numeric"
                              min={0}
                              step="1"
                              className="w-20"
                              value={g.max}
                              onChange={(e) =>
                                updateGroup(g.id, { max: e.target.value })
                              }
                              placeholder="∞"
                            />
                          </div>
                        </div>
                        {ge?.range && (
                          <p className="text-xs text-destructive">{ge.range}</p>
                        )}
                      </div>
                    )}

                    {/* Options */}
                    <div className="flex flex-col gap-2">
                      {g.options.map((o) => (
                        <div key={o.id} className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <Input
                              value={o.name}
                              onChange={(e) =>
                                updateOption(g.id, o.id, {
                                  name: e.target.value,
                                })
                              }
                              placeholder="Option, e.g. Ketchup"
                              aria-label="Option name"
                              className="flex-1"
                            />
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-foreground/40">+฿wkdy</span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                step="1"
                                className="w-16"
                                value={o.price.weekday}
                                onChange={(e) =>
                                  updateOption(g.id, o.id, {
                                    price: { ...o.price, weekday: Number(e.target.value) || 0 },
                                  })
                                }
                                placeholder="0"
                                aria-label="Option weekday price delta"
                              />
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-foreground/40">+฿wknd</span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                step="1"
                                className="w-16"
                                value={o.price.weekend}
                                onChange={(e) =>
                                  updateOption(g.id, o.id, {
                                    price: { ...o.price, weekend: Number(e.target.value) || 0 },
                                  })
                                }
                                placeholder="0"
                                aria-label="Option weekend price delta"
                              />
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-foreground/40">cost ฿</span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                step="1"
                                className="w-16"
                                value={o.cost}
                                onChange={(e) =>
                                  updateOption(g.id, o.id, {
                                    cost: e.target.value,
                                  })
                                }
                                placeholder="—"
                                aria-label="Option cost"
                              />
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="shrink-0 text-destructive"
                              aria-label="Remove option"
                              onClick={() => removeOption(g.id, o.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          {ge?.options?.[o.id] && (
                            <p className="text-xs text-destructive">
                              {ge.options[o.id]}
                            </p>
                          )}
                        </div>
                      ))}

                      {ge?.options?.__group && (
                        <p className="text-xs text-destructive">
                          {ge.options.__group}
                        </p>
                      )}

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => addOption(g.id)}
                      >
                        <Plus className="h-4 w-4" />
                        Add option
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              {item ? 'Save changes' : 'Add menu item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
