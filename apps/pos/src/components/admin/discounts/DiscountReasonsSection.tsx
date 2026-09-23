import { useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { NotSavedNotice } from '../NotSavedNotice';
import { TextInput } from './fields';

export function DiscountReasonsSection() {
  const { discountReasons, mutators } = useCatalogStore();
  const [newReason, setNewReason] = useState('');

  const commit = (next: string[]) => mutators.setDiscountReasons(next);

  const add = () => {
    const r = newReason.trim();
    if (!r) return;
    if (discountReasons.some((x) => x.toLowerCase() === r.toLowerCase())) {
      setNewReason('');
      return;
    }
    commit([...discountReasons, r]);
    setNewReason('');
  };

  const rename = (index: number, value: string) => {
    const next = discountReasons.slice();
    next[index] = value;
    commit(next);
  };

  const remove = (index: number) =>
    commit(discountReasons.filter((_, i) => i !== index));

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= discountReasons.length) return;
    const next = discountReasons.slice();
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  return (
    <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
      <div className="mb-5">
        <NotSavedNotice
          mutators={['setDiscountReasons']}
          what="the reason list staff pick from"
        />
      </div>

      <div>
        <h2 className="text-lg font-bold">Manual-discount reasons</h2>
        <p className="text-sm text-foreground/50">
          The reason options staff pick when applying a manual discount in the
          POS. Drag order is the order shown to staff.
        </p>
      </div>

      {/* Add row */}
      <div className="mt-5 flex gap-2">
        <TextInput
          value={newReason}
          placeholder="New reason (e.g. Service recovery)"
          onChange={(e) => setNewReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add} disabled={!newReason.trim()} className="shrink-0">
          <Plus className="w-4 h-4" />
          Add
        </Button>
      </div>

      {/* Reasons list */}
      <div className="mt-4 flex flex-col gap-2">
        {discountReasons.length === 0 && (
          <p className="rounded-2xl border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-foreground/40">
            No reasons yet. Add one above.
          </p>
        )}
        {discountReasons.map((reason, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.02] px-3 py-2"
          >
            <GripVertical className="w-4 h-4 shrink-0 text-foreground/25" />
            <TextInput
              value={reason}
              onChange={(e) => rename(i, e.target.value)}
              className="flex-1"
            />
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label="Move up"
              >
                <ChevronUp className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => move(i, 1)}
                disabled={i === discountReasons.length - 1}
                aria-label="Move down"
              >
                <ChevronDown className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(i)}
                aria-label="Remove reason"
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
