import { useState } from 'react';
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  GripVertical,
  BadgeCheck,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { countTierUsage } from '@/mockApi';
import type { TierDef } from '@/types';
import { TextInput } from '../discounts/fields';

// Slug a free-text name into a stable token id, kept unique against existing ids.
// Tier ids stay lowercase (they key TicketType.prices).
function makeId(name: string, taken: Set<string>): string {
  let base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = 'tier';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

export function MarketsTiersSection() {
  const { tiers, mutators } = useCatalogStore();

  return (
    <div className="flex flex-col gap-6">
      <TiersEditor tiers={tiers} mutators={mutators} />
    </div>
  );
}

type Mutators = ReturnType<typeof useCatalogStore>['mutators'];

function TiersEditor({
  tiers,
  mutators,
}: {
  tiers: TierDef[];
  mutators: Mutators;
}) {
  const [newName, setNewName] = useState('');
  const sorted = [...tiers].sort((a, b) => a.sortOrder - b.sortOrder);

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    const id = makeId(name, new Set(tiers.map((t) => t.id)));
    const sortOrder = sorted.length ? sorted[sorted.length - 1].sortOrder + 1 : 0;
    mutators.upsertTier({
      id,
      name,
      isDefault: false,
      requiresVerification: true,
      sortOrder,
    });
    setNewName('');
  };

  const patch = (t: TierDef, fields: Partial<TierDef>) =>
    mutators.upsertTier({ ...t, ...fields });

  // Make a tier the single default. The default is the baseline (no proof), so
  // becoming default also clears its verification requirement; the store clears
  // the flag on every other tier.
  const makeDefault = (t: TierDef) =>
    mutators.upsertTier({ ...t, isDefault: true, requiresVerification: false });

  const remove = (t: TierDef) => {
    if (t.isDefault) {
      window.alert(
        `"${t.name}" is the default tier — make another tier the default before deleting it.`,
      );
      return;
    }
    const used = countTierUsage(t.id);
    if (used > 0) {
      window.alert(
        `"${t.name}" is referenced by ${used} price${used === 1 ? '' : 's'}/record${
          used === 1 ? '' : 's'
        }. ` + `Remove those references before deleting this tier.`,
      );
      return;
    }
    mutators.deleteTier(t.id);
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= sorted.length) return;
    const a = sorted[index];
    const b = sorted[target];
    patch(a, { sortOrder: b.sortOrder });
    patch(b, { sortOrder: a.sortOrder });
  };

  return (
    <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <BadgeCheck className="w-4 h-4 text-foreground/50" />
        <h2 className="text-lg font-bold">Customer tiers</h2>
      </div>
      <p className="mt-1 text-sm text-foreground/50">
        Pricing tiers a customer can be priced at. The default tier is the
        baseline anyone gets without proof; other tiers can require verification
        and are priced per ticket type.
      </p>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <TextInput
          value={newName}
          placeholder="New tier (e.g. Student)"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className="flex-1"
        />
        <Button onClick={add} disabled={!newName.trim()} className="shrink-0">
          <Plus className="w-4 h-4" />
          Add
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {sorted.map((t, i) => (
          <div
            key={t.id}
            className="flex flex-wrap items-center gap-2 rounded-2xl border border-foreground/10 bg-black/20 px-3 py-2"
          >
            <GripVertical className="w-4 h-4 shrink-0 text-foreground/25" />
            <TextInput
              value={t.name}
              onChange={(e) => patch(t, { name: e.target.value })}
              className="min-w-[8rem] flex-1"
            />
            <span className="shrink-0 rounded-md bg-foreground/5 px-2 py-1 font-mono text-xs text-foreground/40">
              {t.id}
            </span>
            <Button
              variant={t.isDefault ? 'default' : 'outline'}
              size="sm"
              onClick={() => makeDefault(t)}
              disabled={t.isDefault}
              className="shrink-0"
            >
              <Star className={`w-3.5 h-3.5 ${t.isDefault ? 'fill-current' : ''}`} />
              {t.isDefault ? 'Default' : 'Make default'}
            </Button>
            <Button
              variant={t.requiresVerification ? 'outline' : 'ghost'}
              size="sm"
              onClick={() => patch(t, { requiresVerification: !t.requiresVerification })}
              disabled={t.isDefault}
              className="shrink-0"
              title={
                t.isDefault
                  ? 'The default tier never requires verification.'
                  : undefined
              }
            >
              {t.requiresVerification ? 'Requires proof' : 'No proof'}
            </Button>
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
                disabled={i === sorted.length - 1}
                aria-label="Move down"
              >
                <ChevronDown className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(t)}
                aria-label="Remove tier"
                className="text-rose-300 hover:text-rose-200"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
