import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ModifierGroup, ModifierOption, WeekdayWeekendPrice } from '@/types';
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
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group';
import { randomId } from '../menu/menuItem';

interface ModifierGroupFormDialogProps {
  open: boolean;
  /** The shared group being edited, or null when creating a new one. */
  group: ModifierGroup | null;
  onOpenChange: (open: boolean) => void;
  onSave: (group: ModifierGroup) => void;
}

interface OptionDraft {
  id: string;
  name: string;
  price: WeekdayWeekendPrice;
  cost: string;
}

interface FormState {
  name: string;
  required: boolean;
  selectionType: 'single' | 'multi';
  min: string;
  max: string;
  options: OptionDraft[];
}

interface FormErrors {
  name?: string;
  range?: string;
  options?: Record<string, string>;
}

const blankState = (): FormState => ({
  name: '',
  required: false,
  selectionType: 'single',
  min: '',
  max: '',
  options: [{ id: randomId('opt'), name: '', price: { weekday: 0, weekend: 0 }, cost: '' }],
});

const fromGroup = (g: ModifierGroup): FormState => ({
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
});

/**
 * Create/Edit form for one shared modifier group (the reusable library). Mirrors
 * the inline group editor inside MenuItemForm, but stands alone so a group can be
 * defined once and linked to many menu items. The id is generated on create and
 * preserved across edits so linked items keep resolving it.
 */
export function ModifierGroupFormDialog({
  open,
  group,
  onOpenChange,
  onSave,
}: ModifierGroupFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => blankState());
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (!open) return;
    setForm(group ? fromGroup(group) : blankState());
    setErrors({});
  }, [open, group]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const addOption = () =>
    setForm((f) => ({
      ...f,
      options: [
        ...f.options,
        { id: randomId('opt'), name: '', price: { weekday: 0, weekend: 0 }, cost: '' },
      ],
    }));

  const updateOption = (optionId: string, patch: Partial<OptionDraft>) =>
    setForm((f) => ({
      ...f,
      options: f.options.map((o) =>
        o.id === optionId ? { ...o, ...patch } : o
      ),
    }));

  const removeOption = (optionId: string) =>
    setForm((f) => ({
      ...f,
      options: f.options.filter((o) => o.id !== optionId),
    }));

  const validate = (): ModifierGroup | null => {
    const next: FormErrors = {};
    const name = form.name.trim();
    if (!name) next.name = 'Group name is required.';

    if (form.options.length === 0) {
      next.options = { __group: 'Add at least one option.' };
    } else {
      const optErrors: Record<string, string> = {};
      for (const o of form.options) {
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
      if (Object.keys(optErrors).length) next.options = optErrors;
    }

    if (form.selectionType === 'multi') {
      const hasMin = form.min.trim() !== '';
      const hasMax = form.max.trim() !== '';
      const minNum = Number(form.min);
      const maxNum = Number(form.max);
      if (hasMin && (Number.isNaN(minNum) || minNum < 0)) {
        next.range = 'Min must be 0 or more.';
      } else if (hasMax && (Number.isNaN(maxNum) || maxNum < 0)) {
        next.range = 'Max must be 0 or more.';
      } else if (hasMin && hasMax && minNum > maxNum) {
        next.range = 'Min cannot exceed max.';
      }
    }

    if (next.name || next.range || next.options) {
      setErrors(next);
      return null;
    }

    const options: ModifierOption[] = form.options.map((o) => ({
      id: o.id,
      name: o.name.trim(),
      price: o.price,
      ...(o.cost.trim() !== '' ? { cost: Number(o.cost) } : {}),
    }));
    const result: ModifierGroup = {
      id: group?.id ?? randomId('grp'),
      name,
      required: form.required,
      selectionType: form.selectionType,
      options,
    };
    if (form.selectionType === 'multi') {
      if (form.min.trim() !== '') result.min = Number(form.min);
      if (form.max.trim() !== '') result.max = Number(form.max);
    }
    return result;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validate();
    if (result) {
      onSave(result);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {group ? 'Edit modifier group' : 'Add modifier group'}
          </DialogTitle>
          <DialogDescription>
            A reusable customization question (e.g. “Spice level”, “Add-ons”) you
            can attach to many menu items from the item editor.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mg-name">Group name</Label>
            <Input
              id="mg-name"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="Question, e.g. Choose your sauce"
              autoFocus
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={form.selectionType}
              onValueChange={(v) =>
                v && setField('selectionType', v as 'single' | 'multi')
              }
            >
              <ToggleGroupItem value="single">Choose one</ToggleGroupItem>
              <ToggleGroupItem value="multi">Choose many</ToggleGroupItem>
            </ToggleGroup>

            <label className="flex items-center gap-2 text-xs text-foreground/60">
              <Switch
                checked={form.required}
                onCheckedChange={(checked) => setField('required', checked)}
              />
              Required
            </label>
          </div>

          {form.selectionType === 'multi' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="mg-min" className="text-xs text-foreground/50">
                    Min
                  </Label>
                  <Input
                    id="mg-min"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step="1"
                    className="w-20"
                    value={form.min}
                    onChange={(e) => setField('min', e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="mg-max" className="text-xs text-foreground/50">
                    Max
                  </Label>
                  <Input
                    id="mg-max"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step="1"
                    className="w-20"
                    value={form.max}
                    onChange={(e) => setField('max', e.target.value)}
                    placeholder="∞"
                  />
                </div>
              </div>
              {errors.range && (
                <p className="text-xs text-destructive">{errors.range}</p>
              )}
            </div>
          )}

          {/* Options */}
          <div className="flex flex-col gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <Label>Options</Label>
            {form.options.map((o) => (
              <div key={o.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={o.name}
                    onChange={(e) =>
                      updateOption(o.id, { name: e.target.value })
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
                        updateOption(o.id, {
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
                        updateOption(o.id, {
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
                        updateOption(o.id, { cost: e.target.value })
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
                    onClick={() => removeOption(o.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {errors.options?.[o.id] && (
                  <p className="text-xs text-destructive">
                    {errors.options[o.id]}
                  </p>
                )}
              </div>
            ))}

            {errors.options?.__group && (
              <p className="text-xs text-destructive">
                {errors.options.__group}
              </p>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={addOption}
            >
              <Plus className="h-4 w-4" />
              Add option
            </Button>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">
              {group ? 'Save changes' : 'Add group'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
