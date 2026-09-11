import { Plus, Trash2 } from 'lucide-react';
import {
  BenefitProfile,
  FreeItemsBenefit,
  MenuCategoryDef,
} from '@/types';
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
import { topLevelCategories, subCategoriesOf } from '@/lib/menu';

/** Flat, indented list of F&B categories for a target picker. */
function categoryOptions(categories: MenuCategoryDef[]) {
  const opts: { id: string; label: string }[] = [];
  for (const top of topLevelCategories(categories)) {
    opts.push({ id: top.id, label: top.name });
    for (const sub of subCategoriesOf(top.id, categories)) {
      opts.push({ id: sub.id, label: `— ${sub.name}` });
    }
  }
  return opts;
}

let freeItemIdSeq = 0;
const newFreeItemId = () => `benefit-item-${Date.now()}-${freeItemIdSeq++}`;

/**
 * Shared editor for one BenefitProfile — reused by the role-template cards
 * and the per-operator override dialog. Every primitive is optional; the
 * caller decides what "cleared" means (template vs. override).
 */
export function BenefitProfileFields({
  profile,
  categories,
  onChange,
}: {
  profile: BenefitProfile;
  categories: MenuCategoryDef[];
  onChange: (next: BenefitProfile) => void;
}) {
  const catOptions = categoryOptions(categories);

  const addFreeItem = () => {
    const first = catOptions[0];
    const item: FreeItemsBenefit = {
      id: newFreeItemId(),
      label: 'Free item',
      target: first ? { kind: 'fnbCategory', category: first.id } : { kind: 'fnb' },
      quotaPerPeriod: 1,
      period: 'daily',
    };
    onChange({ ...profile, freeItems: [...(profile.freeItems ?? []), item] });
  };

  const updateFreeItem = (id: string, patch: Partial<FreeItemsBenefit>) => {
    onChange({
      ...profile,
      freeItems: (profile.freeItems ?? []).map((f) =>
        f.id === id ? { ...f, ...patch } : f
      ),
    });
  };

  const removeFreeItem = (id: string) => {
    onChange({
      ...profile,
      freeItems: (profile.freeItems ?? []).filter((f) => f.id !== id),
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Comp */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Full comp</div>
          <div className="text-xs text-foreground/50">
            Every F&B order is free. Short-circuits everything else below.
          </div>
        </div>
        <Switch
          checked={!!profile.comp}
          onCheckedChange={(checked) => onChange({ ...profile, comp: checked })}
        />
      </div>

      {!profile.comp && (
        <>
          {/* Free items */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Free items (by category)</Label>
              <Button type="button" variant="outline" size="sm" onClick={addFreeItem}>
                <Plus className="w-4 h-4" />
                Add
              </Button>
            </div>
            {(profile.freeItems ?? []).length === 0 ? (
              <p className="text-xs text-foreground/40">No periodic free items configured.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {(profile.freeItems ?? []).map((f) => (
                  <div
                    key={f.id}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3"
                  >
                    <Input
                      value={f.label}
                      onChange={(e) => updateFreeItem(f.id, { label: e.target.value })}
                      placeholder="Label"
                      className="w-36"
                    />
                    <Select
                      value={f.target.kind === 'fnbCategory' ? f.target.category : 'fnb'}
                      onValueChange={(val) =>
                        updateFreeItem(f.id, {
                          target: val === 'fnb' ? { kind: 'fnb' } : { kind: 'fnbCategory', category: val },
                        })
                      }
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue placeholder="Category" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fnb">All F&amp;B</SelectItem>
                        {catOptions.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={1}
                      value={f.quotaPerPeriod}
                      onChange={(e) =>
                        updateFreeItem(f.id, { quotaPerPeriod: Math.max(1, Number(e.target.value) || 1) })
                      }
                      className="w-20"
                    />
                    <Select
                      value={f.period}
                      onValueChange={(val) => updateFreeItem(f.id, { period: val as 'daily' | 'monthly' })}
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">per day</SelectItem>
                        <SelectItem value="monthly">per month</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="ml-auto"
                      onClick={() => removeFreeItem(f.id)}
                      aria-label={`Remove ${f.label}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Credit */}
          <div className="flex flex-col gap-2 rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Periodic ฿ credit</Label>
              <Switch
                checked={!!profile.credit}
                onCheckedChange={(checked) =>
                  onChange({
                    ...profile,
                    credit: checked ? { amountTHB: 300, period: 'monthly' } : undefined,
                  })
                }
              />
            </div>
            {profile.credit && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-foreground/60">฿</span>
                <Input
                  type="number"
                  min={0}
                  value={profile.credit.amountTHB}
                  onChange={(e) =>
                    onChange({
                      ...profile,
                      credit: { ...profile.credit!, amountTHB: Math.max(0, Number(e.target.value) || 0) },
                    })
                  }
                  className="w-28"
                />
                <Select
                  value={profile.credit.period}
                  onValueChange={(val) =>
                    onChange({ ...profile, credit: { ...profile.credit!, period: val as 'daily' | 'monthly' } })
                  }
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">per day</SelectItem>
                    <SelectItem value="monthly">per month</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={
                    profile.credit.target?.kind === 'fnbCategory'
                      ? profile.credit.target.category
                      : 'fnb'
                  }
                  onValueChange={(val) =>
                    onChange({
                      ...profile,
                      credit: {
                        ...profile.credit!,
                        target: val === 'fnb' ? undefined : { kind: 'fnbCategory', category: val },
                      },
                    })
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fnb">All F&amp;B</SelectItem>
                    {catOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Standing discount */}
          <div className="flex flex-col gap-2 rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Standing % discount</Label>
              <Switch
                checked={!!profile.standingDiscount}
                onCheckedChange={(checked) =>
                  onChange({
                    ...profile,
                    standingDiscount: checked ? { percent: 20 } : undefined,
                  })
                }
              />
            </div>
            {profile.standingDiscount && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={profile.standingDiscount.percent}
                  onChange={(e) =>
                    onChange({
                      ...profile,
                      standingDiscount: {
                        ...profile.standingDiscount!,
                        percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                      },
                    })
                  }
                  className="w-20"
                />
                <span className="text-sm text-foreground/60">% off</span>
                <Select
                  value={
                    profile.standingDiscount.target?.kind === 'fnbCategory'
                      ? profile.standingDiscount.target.category
                      : 'fnb'
                  }
                  onValueChange={(val) =>
                    onChange({
                      ...profile,
                      standingDiscount: {
                        ...profile.standingDiscount!,
                        target: val === 'fnb' ? undefined : { kind: 'fnbCategory', category: val },
                      },
                    })
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fnb">All F&amp;B</SelectItem>
                    {catOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
