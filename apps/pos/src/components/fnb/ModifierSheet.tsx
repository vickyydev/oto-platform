import { useEffect, useMemo, useState } from 'react';
import { MenuItem, ModifierGroup, SelectedModifier } from '@/types';
import { resolveRateToday } from '@/lib/pricingMode';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { cn } from '@/lib/utils';
import { computeUnitPrice, isGroupSatisfied, areModifiersValid } from '@/lib/fnb';
import { getEffectiveModifierGroups } from '@/lib/menu';
import { Check, AlertCircle, StickyNote } from 'lucide-react';

interface ModifierSheetProps {
  open: boolean;
  item: MenuItem | null;
  mode: 'add' | 'edit';
  initialSelections?: SelectedModifier[];
  initialQty?: number;
  initialNote?: string;
  onClose: () => void;
  onSave: (selections: SelectedModifier[], qty: number, note?: string) => void;
}

function groupHint(group: ModifierGroup): string {
  if (group.selectionType === 'single') {
    return group.required ? 'Choose 1' : 'Optional · choose 1';
  }
  const min = group.required ? (group.min ?? 1) : group.min ?? 0;
  const max = group.max;
  if (max != null && min > 0) return `Choose ${min}–${max}`;
  if (max != null) return `Optional · up to ${max}`;
  if (min > 0) return `Choose at least ${min}`;
  return 'Optional · choose any';
}

export function ModifierSheet({
  open,
  item,
  mode,
  initialSelections,
  initialQty = 1,
  initialNote,
  onClose,
  onSave,
}: ModifierSheetProps) {
  // selections keyed by groupId -> chosen option ids
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    const seed: Record<string, string[]> = {};
    for (const sel of initialSelections ?? []) seed[sel.groupId] = [...sel.optionIds];
    setSelections(seed);
    setQty(Math.max(1, initialQty));
    setNote(initialNote ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  // Inline groups + groups resolved from the shared library (see lib/menu).
  const effectiveGroups = useMemo(
    () => (item ? getEffectiveModifierGroups(item) : []),
    [item]
  );

  const selectedModifiers: SelectedModifier[] = useMemo(() => {
    return effectiveGroups
      .map((g) => ({ groupId: g.id, optionIds: selections[g.id] ?? [] }))
      .filter((s) => s.optionIds.length > 0);
  }, [effectiveGroups, selections]);

  const unitPrice = item ? computeUnitPrice(item, selectedModifiers) : 0;
  const canSave = item ? areModifiersValid(item, selectedModifiers) : false;

  if (!item) return null;
  const groups = effectiveGroups;

  const toggleOption = (group: ModifierGroup, optionId: string) => {
    setSelections((prev) => {
      const current = prev[group.id] ?? [];
      const isSelected = current.includes(optionId);

      if (group.selectionType === 'single') {
        // Tapping the selected option clears it only when the group is optional.
        if (isSelected) return { ...prev, [group.id]: group.required ? current : [] };
        return { ...prev, [group.id]: [optionId] };
      }

      // multi
      if (isSelected) {
        return { ...prev, [group.id]: current.filter((id) => id !== optionId) };
      }
      const max = group.max ?? Infinity;
      if (current.length >= max) return prev; // at max, ignore further adds
      return { ...prev, [group.id]: [...current, optionId] };
    });
  };

  const handleSave = () => {
    if (!canSave) return;
    const trimmed = note.trim();
    onSave(selectedModifiers, qty, trimmed.length > 0 ? trimmed : undefined);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b text-left">
          <DialogTitle className="text-2xl">{item.name}</DialogTitle>
          <DialogDescription>
            Base ฿{resolveRateToday(item.price)} ·{' '}
            {mode === 'edit'
              ? 'Update this item'
              : groups.length > 0
                ? 'Choose options to add'
                : 'Add a note, then add to order'}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[52vh]">
          <div className="px-6 py-4 space-y-6">
            {groups.map((group) => {
              const chosen = selections[group.id] ?? [];
              const satisfied = isGroupSatisfied(group, chosen);
              const showError = group.required && !satisfied;
              return (
                <div key={group.id}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-lg leading-tight">{group.name}</h3>
                      {group.required && (
                        <span className="text-[11px] font-bold uppercase tracking-wide text-primary bg-primary/15 rounded-full px-2 py-0.5">
                          Required
                        </span>
                      )}
                    </div>
                    <span
                      className={cn(
                        'text-xs font-medium',
                        showError ? 'text-amber-500' : 'text-muted-foreground'
                      )}
                    >
                      {groupHint(group)}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {group.options.map((opt) => {
                      const selected = chosen.includes(opt.id);
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => toggleOption(group, opt.id)}
                          className={cn(
                            'w-full flex items-center justify-between gap-3 rounded-xl border px-4 h-14 text-left transition-all active:scale-[0.98]',
                            selected
                              ? 'border-primary bg-primary/10 ring-1 ring-primary'
                              : 'bg-background hover:border-primary/50'
                          )}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span
                              className={cn(
                                'flex items-center justify-center shrink-0 border-2 transition-colors',
                                group.selectionType === 'single'
                                  ? 'w-6 h-6 rounded-full'
                                  : 'w-6 h-6 rounded-md',
                                selected
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-muted-foreground/40'
                              )}
                            >
                              {selected && <Check className="w-4 h-4" strokeWidth={3} />}
                            </span>
                            <span className="font-medium truncate">{opt.name}</span>
                          </div>
                          {resolveRateToday(opt.price) > 0 && (
                            <span className="text-sm font-bold text-primary tabular-nums shrink-0">
                              +฿{resolveRateToday(opt.price)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {showError && (
                    <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-500">
                      <AlertCircle className="w-3.5 h-3.5" />
                      Please make a selection to continue.
                    </div>
                  )}
                </div>
              );
            })}

            <div>
              <div className="flex items-center gap-2 mb-2">
                <StickyNote className="w-4 h-4 text-muted-foreground" />
                <h3 className="font-bold text-lg leading-tight">Note</h3>
                <span className="text-xs font-medium text-muted-foreground">
                  Optional · for the kitchen/bar
                </span>
              </div>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. no pickles, extra crispy"
                rows={2}
                className="resize-none text-base"
              />
            </div>
          </div>
        </ScrollArea>

        <div className="border-t px-6 py-4 flex items-center gap-4">
          <QuantityStepper value={qty} onChange={(q) => setQty(Math.max(1, q))} min={1} ariaLabel={item.name} />
          <Button
            size="lg"
            className="flex-1 h-14 text-lg font-bold"
            disabled={!canSave}
            onClick={handleSave}
          >
            {mode === 'edit' ? 'Save changes' : 'Add to order'} • ฿{unitPrice * qty}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
