import { useEffect, useMemo, useState } from 'react';
import { Info, Check, Plus, Trash2, AlertTriangle } from 'lucide-react';
import type { CategoryTaxRule, TaxableCategory, TaxConfig, TaxMode, TaxRate } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { computeTaxBreakdown, roundTHB } from '@/lib/tax';
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

// Human labels for each taxable area. 'stored_value' is intentionally omitted
// from the editor — credit loads are never taxed at load (taxed on spend).
const CATEGORY_LABELS: Partial<Record<TaxableCategory, string>> = {
  tickets:    'Tickets',
  fnb:        'F&B',
  bar:        'Bar (alcohol)',
  drop_off:   'Drop-off / nanny',
  parties:    'Parties / events',
  addons:     'Add-ons',
  merch:      'Retail / merch',
};

const TAX_MODE_OPTIONS: { value: TaxMode; label: string }[] = [
  { value: 'inclusive', label: 'VAT included in price' },
  { value: 'exclusive', label: 'VAT added on top' },
  { value: 'none',      label: 'No tax' },
];

// Compact default-mode options for a rate row. '__no_default__' clears the hint.
const NO_DEFAULT_MODE = '__no_default__';
const RATE_DEFAULT_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: NO_DEFAULT_MODE, label: 'No default' },
  { value: 'inclusive',     label: 'Default: included' },
  { value: 'exclusive',     label: 'Default: added on top' },
];

const EXAMPLE_CATEGORIES: { value: TaxableCategory; label: string }[] = [
  { value: 'fnb',     label: 'F&B' },
  { value: 'bar',     label: 'Bar (alcohol)' },
  { value: 'tickets', label: 'Tickets' },
  { value: 'addons',  label: 'Add-ons' },
  { value: 'merch',   label: 'Retail / merch' },
];

type ServiceDraft = Record<string, string>;

const serviceDraftFrom = (rules: CategoryTaxRule[]): ServiceDraft =>
  Object.fromEntries(
    rules.map((r) => [r.category, String(r.serviceChargePercent ?? 0)])
  );

const NO_RATE = '__none__';

/**
 * Admin editing screen for the tax configuration. Reads the live shared catalog
 * store and writes back through `updateTaxConfig`, so changes flow to the POS tax
 * engine (lib/tax.ts) on the next computation. Every taxable area is editable —
 * including the retail/merch category, which the owner's accountant can tax
 * independently of F&B.
 */
export function TaxPanel() {
  const { taxConfig, mutators } = useCatalogStore();

  const editableRules = useMemo(
    () => taxConfig.categoryRules.filter((r) => r.category !== 'stored_value'),
    [taxConfig]
  );

  // ── draft state ────────────────────────────────────────────────────────────
  const [rates, setRates] = useState<TaxRate[]>(taxConfig.rates);
  const [rules, setRules] = useState<CategoryTaxRule[]>(editableRules);
  const [service, setService] = useState<ServiceDraft>(() => serviceDraftFrom(editableRules));
  const [discountPlacement, setDiscountPlacement] = useState<TaxConfig['discountPlacement']>(
    taxConfig.discountPlacement
  );
  const [saved, setSaved] = useState(false);

  // New-rate form
  const [newRateName, setNewRateName] = useState('');
  const [newRatePercent, setNewRatePercent] = useState('');
  const [newRateError, setNewRateError] = useState('');

  // Delete-rate confirmation (id of the rate being considered for deletion)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Live example
  const [exampleCategory, setExampleCategory] = useState<TaxableCategory>('fnb');

  // Re-seed from the store whenever it changes externally.
  useEffect(() => {
    setRates(taxConfig.rates);
    setRules(editableRules);
    setService(serviceDraftFrom(editableRules));
    setDiscountPlacement(taxConfig.discountPlacement);
    setSaved(false);
  }, [editableRules, taxConfig.rates, taxConfig.discountPlacement]);

  // ── derived: which categories reference a given rate ────────────────────
  const rateUsers = useMemo(() => {
    const map = new Map<string, TaxableCategory[]>();
    for (const r of rules) {
      if (r.taxRateId) {
        const list = map.get(r.taxRateId) ?? [];
        list.push(r.category);
        map.set(r.taxRateId, list);
      }
    }
    return map;
  }, [rules]);

  // ── derived: build the "current draft" config for the live example ───────
  const draftConfig = useMemo((): TaxConfig => {
    const mergedEditable = rules.map((r) => {
      const raw = service[r.category];
      const num = Number(raw);
      const serviceChargePercent = !raw || Number.isNaN(num) || num < 0 ? 0 : num;
      return { ...r, serviceChargePercent };
    });
    const untouched = taxConfig.categoryRules.filter(
      (r) => !mergedEditable.some((m) => m.category === r.category)
    );
    return {
      rates,
      categoryRules: [...mergedEditable, ...untouched],
      discountPlacement,
    };
  }, [rates, rules, service, discountPlacement, taxConfig.categoryRules]);

  // ── live example computation (always from the engine — never re-implemented) ─
  const liveExample = useMemo(() => {
    const EXAMPLE_BASE = 100;
    const bd = computeTaxBreakdown(
      [{ category: exampleCategory, base: EXAMPLE_BASE }],
      0,
      draftConfig
    );
    const cat = bd.categories[0];
    return { bd, cat, base: EXAMPLE_BASE };
  }, [exampleCategory, draftConfig]);

  // ── rule helpers ──────────────────────────────────────────────────────────
  const setRule = (category: TaxableCategory, patch: Partial<CategoryTaxRule>) => {
    setRules((prev) =>
      prev.map((r) => (r.category === category ? { ...r, ...patch } : r))
    );
    setSaved(false);
  };

  const setServiceField = (category: TaxableCategory, raw: string) => {
    setService((prev) => ({ ...prev, [category]: raw }));
    setSaved(false);
  };

  // ── rate helpers ──────────────────────────────────────────────────────────
  const updateRate = (id: string, patch: Partial<TaxRate>) => {
    setRates((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setSaved(false);
  };

  const addRate = () => {
    const name = newRateName.trim();
    const pct = Number(newRatePercent);
    if (!name) { setNewRateError('Enter a rate name.'); return; }
    if (!newRatePercent.trim() || Number.isNaN(pct) || pct < 0) {
      setNewRateError('Enter a valid percent (0 or more).');
      return;
    }
    setRates((prev) => [...prev, { id: crypto.randomUUID(), name, percent: pct }]);
    setNewRateName('');
    setNewRatePercent('');
    setNewRateError('');
    setSaved(false);
  };

  const confirmDeleteRate = (id: string) => {
    const users = rateUsers.get(id) ?? [];
    if (users.length > 0) {
      setPendingDeleteId(id);
    } else {
      doDeleteRate(id);
    }
  };

  const doDeleteRate = (id: string) => {
    setRates((prev) => prev.filter((r) => r.id !== id));
    // Clear the taxRateId on any rule that referenced it.
    setRules((prev) =>
      prev.map((r) => (r.taxRateId === id ? { ...r, taxRateId: undefined } : r))
    );
    setPendingDeleteId(null);
    setSaved(false);
  };

  // ── save ──────────────────────────────────────────────────────────────────
  const handleSave = () => {
    const mergedEditable = rules.map((r) => {
      const raw = service[r.category];
      const num = Number(raw);
      const serviceChargePercent = !raw || Number.isNaN(num) || num < 0 ? 0 : num;
      return { ...r, serviceChargePercent };
    });
    const untouched = taxConfig.categoryRules.filter(
      (r) => !mergedEditable.some((m) => m.category === r.category)
    );
    mutators.updateTaxConfig({
      rates,
      categoryRules: [...mergedEditable, ...untouched],
      discountPlacement,
    });
    setSaved(true);
  };

  return (
    <div className="flex flex-col gap-6">

      {/* ── 1. Global rates ──────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
        <h2 className="text-base font-bold">Global tax rates</h2>
        <p className="mt-1 text-sm text-foreground/50">
          Named rates that per-category rules reference. Each rate has a name (e.g. "VAT") and a
          percent. Deleting a rate that a category still uses will reset that category to "no rate".
        </p>

        <div className="mt-4 flex flex-col gap-3">
          {rates.map((rate) => {
            const users = rateUsers.get(rate.id) ?? [];
            const isPendingDelete = pendingDeleteId === rate.id;
            return (
              <div key={rate.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Rate name"
                    value={rate.name}
                    onChange={(e) => updateRate(rate.id, { name: e.target.value })}
                    className="w-32"
                    placeholder="VAT"
                  />
                  <Input
                    aria-label="Rate percent"
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    value={rate.percent}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isNaN(v) && v >= 0) updateRate(rate.id, { percent: v });
                    }}
                    className="w-24"
                    placeholder="7"
                  />
                  <span className="text-sm text-foreground/50">%</span>
                  <div className="w-44">
                    <Select
                      value={rate.defaultMode ?? NO_DEFAULT_MODE}
                      onValueChange={(v) =>
                        updateRate(rate.id, {
                          defaultMode: v === NO_DEFAULT_MODE ? undefined : (v as TaxMode),
                        })
                      }
                    >
                      <SelectTrigger aria-label="Rate default mode" className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RATE_DEFAULT_MODE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {users.length > 0 && (
                    <span className="text-xs text-foreground/40">
                      used by {users.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}
                    </span>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto text-destructive hover:text-destructive"
                    onClick={() => confirmDeleteRate(rate.id)}
                    aria-label="Delete rate"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                {isPendingDelete && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <div className="flex flex-col gap-2">
                      <p className="text-amber-200">
                        <strong>{rate.name}</strong> is assigned to{' '}
                        {(rateUsers.get(rate.id) ?? [])
                          .map((c) => CATEGORY_LABELS[c] ?? c)
                          .join(', ')}
                        . Those categories will revert to "no tax rate" if deleted.
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" variant="destructive" onClick={() => doDeleteRate(rate.id)}>
                          Delete anyway
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPendingDeleteId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Add new rate */}
          <div className="mt-1 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Input
                aria-label="New rate name"
                value={newRateName}
                onChange={(e) => { setNewRateName(e.target.value); setNewRateError(''); }}
                placeholder="Rate name"
                className="w-32"
              />
              <Input
                aria-label="New rate percent"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={newRatePercent}
                onChange={(e) => { setNewRatePercent(e.target.value); setNewRateError(''); }}
                placeholder="0"
                className="w-24"
              />
              <span className="text-sm text-foreground/50">%</span>
              <Button size="sm" variant="outline" onClick={addRate} className="ml-1">
                <Plus className="h-3.5 w-3.5" />
                Add rate
              </Button>
            </div>
            {newRateError && <p className="text-xs text-destructive">{newRateError}</p>}
          </div>
        </div>
      </div>

      {/* ── 2. Tax per area ───────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
        <h2 className="text-base font-bold">Tax per area</h2>
        <p className="mt-1 text-sm text-foreground/50">
          Set how each part of the business is taxed and service-charged. Retail / merch is its own
          area so it can be taxed independently of F&amp;B.
        </p>

        <div className="mt-5 flex flex-col gap-4">
          {rules.map((r) => (
            <div
              key={r.category}
              className="flex flex-col gap-3 rounded-xl bg-black/20 p-4"
            >
              <span className="font-medium">
                {CATEGORY_LABELS[r.category] ?? r.category}
              </span>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {/* Tax mode */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`tax-mode-${r.category}`} className="text-xs">
                    Tax mode
                  </Label>
                  <Select
                    value={r.taxMode}
                    onValueChange={(v) => {
                      const mode = v as TaxMode;
                      setRule(r.category, {
                        taxMode: mode,
                        taxRateId: mode === 'none' ? undefined : (r.taxRateId ?? rates[0]?.id),
                      });
                    }}
                  >
                    <SelectTrigger id={`tax-mode-${r.category}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TAX_MODE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Rate picker */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`tax-rate-${r.category}`} className="text-xs">
                    Tax rate
                  </Label>
                  <Select
                    value={r.taxRateId ?? NO_RATE}
                    onValueChange={(v) => {
                      if (v === NO_RATE) {
                        setRule(r.category, { taxRateId: undefined });
                        return;
                      }
                      const picked = rates.find((rt) => rt.id === v);
                      // Assigning a rate lifts the area off "No tax" so the rate
                      // actually applies — using the rate's default mode if set.
                      setRule(r.category, {
                        taxRateId: v,
                        taxMode:
                          r.taxMode === 'none'
                            ? (picked?.defaultMode ?? 'inclusive')
                            : r.taxMode,
                      });
                    }}
                  >
                    <SelectTrigger id={`tax-rate-${r.category}`}>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_RATE}>No rate</SelectItem>
                      {rates.map((rate) => (
                        <SelectItem key={rate.id} value={rate.id}>
                          {rate.name} ({rate.percent}%)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Service charge */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`tax-svc-${r.category}`} className="text-xs">
                    Service charge %
                  </Label>
                  <Input
                    id={`tax-svc-${r.category}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step="1"
                    value={service[r.category] ?? '0'}
                    onChange={(e) => setServiceField(r.category, e.target.value)}
                  />
                </div>

                {/* Tax-on-service-charge toggle */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-foreground/70">Tax on service charge</span>
                  <div className="flex items-center gap-2 pt-1">
                    <Switch
                      id={`tax-on-tax-${r.category}`}
                      checked={!!r.taxOnServiceCharge}
                      disabled={r.taxMode === 'none' || !(Number(service[r.category]) > 0)}
                      onCheckedChange={(checked) =>
                        setRule(r.category, { taxOnServiceCharge: checked })
                      }
                    />
                    <Label
                      htmlFor={`tax-on-tax-${r.category}`}
                      className="cursor-pointer text-xs"
                    >
                      {r.taxOnServiceCharge ? 'On (tax on tax)' : 'Off'}
                    </Label>
                  </div>
                </div>
              </div>

              {/* Additional (second) tax — its own included / added-on-top mode */}
              <div className="flex flex-col gap-1.5 border-t border-foreground/10 pt-3">
                <Label className="text-xs">
                  Additional tax
                  <span className="ml-1 font-normal text-foreground/40">
                    — a second tax on this area, included in the price or added on top
                  </span>
                </Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Select
                    value={r.secondaryTaxRateId ?? NO_RATE}
                    onValueChange={(v) => {
                      if (v === NO_RATE) {
                        setRule(r.category, { secondaryTaxRateId: undefined });
                        return;
                      }
                      const picked = rates.find((rt) => rt.id === v);
                      // Seed the second tax's mode from the rate's default the first
                      // time it's assigned; keep an explicit choice if already set.
                      setRule(r.category, {
                        secondaryTaxRateId: v,
                        secondaryTaxMode:
                          r.secondaryTaxMode ?? picked?.defaultMode ?? 'exclusive',
                      });
                    }}
                  >
                    <SelectTrigger id={`tax-secondary-${r.category}`}>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_RATE}>None</SelectItem>
                      {rates
                        .filter((rate) => rate.id !== r.taxRateId)
                        .map((rate) => (
                          <SelectItem key={rate.id} value={rate.id}>
                            {rate.name} ({rate.percent}%)
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={r.secondaryTaxMode ?? 'exclusive'}
                    disabled={!r.secondaryTaxRateId}
                    onValueChange={(v) =>
                      setRule(r.category, { secondaryTaxMode: v as TaxMode })
                    }
                  >
                    <SelectTrigger aria-label="Additional tax mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inclusive">Included in price</SelectItem>
                      <SelectItem value="exclusive">Added on top</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 3. Discount placement ─────────────────────────────────────────── */}
      <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
        <h2 className="text-base font-bold">Discount placement</h2>
        <p className="mt-1 text-sm text-foreground/50">
          Whether manual discounts apply before or after tax is computed.
        </p>
        <div className="mt-3 max-w-xs">
          <Select
            value={discountPlacement}
            onValueChange={(v) => {
              setDiscountPlacement(v as TaxConfig['discountPlacement']);
              setSaved(false);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="before_tax">Before tax</SelectItem>
              <SelectItem value="after_tax">After tax</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── 4. Live example ───────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
        <h2 className="text-base font-bold">Live example</h2>
        <p className="mt-1 text-sm text-foreground/50">
          Computed by the tax engine from the settings above (including unsaved changes). Use this
          to sanity-check a configuration before saving.
        </p>

        <div className="mt-3 flex items-center gap-3">
          <Label className="text-xs shrink-0">Category to preview</Label>
          <div className="w-44">
            <Select
              value={exampleCategory}
              onValueChange={(v) => setExampleCategory(v as TaxableCategory)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXAMPLE_CATEGORIES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-4 rounded-xl bg-black/30 p-4 font-mono text-sm leading-6">
          <ExampleBreakdown
            category={exampleCategory}
            base={liveExample.base}
            cat={liveExample.cat}
            bd={liveExample.bd}
            rates={rates}
          />
        </div>

        <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-300/70">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Tax rules and sequences should be validated with a qualified accountant before going live.
        </p>
      </div>

      {/* ── Save ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={handleSave}>
          <Check className="w-4 h-4" />
          Save changes
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300">
            <Check className="w-4 h-4" />
            Saved — live in the till.
          </span>
        )}
      </div>

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Changes are kept in memory for this prototype and reset on page reload.
      </p>
    </div>
  );
}

// ── Live example breakdown display ─────────────────────────────────────────

import type { CategoryTaxLine, TaxBreakdown } from '@/lib/tax';

interface ExampleBreakdownProps {
  category: TaxableCategory;
  base: number;
  cat: CategoryTaxLine;
  bd: TaxBreakdown;
  rates: TaxRate[];
}

function fmt(n: number) {
  return `฿${roundTHB(n).toFixed(2)}`;
}

function ExampleBreakdown({ category, base, cat, bd, rates }: ExampleBreakdownProps) {
  const label = CATEGORY_LABELS[category] ?? category;
  const rateLabel =
    cat.taxMode === 'none'
      ? 'no tax'
      : cat.taxName
      ? `${cat.taxName} ${cat.taxPercent}% ${cat.taxMode}`
      : 'no rate assigned';

  const rows: { label: string; value: string; dim?: boolean }[] = [
    { label: `${label} base`, value: fmt(base) },
  ];

  if (cat.serviceCharge > 0) {
    rows.push({ label: `+ service charge`, value: fmt(cat.serviceCharge) });
  }

  if (cat.taxMode === 'exclusive' && cat.tax > 0) {
    rows.push({ label: `+ ${rateLabel}`, value: fmt(cat.tax) });
  } else if (cat.taxMode === 'inclusive' && cat.tax > 0) {
    rows.push({ label: `  ${cat.taxName ?? 'Tax'} included (${cat.taxPercent}%)`, value: fmt(cat.tax), dim: true });
  } else if (cat.taxMode === 'none') {
    rows.push({ label: `  (no tax applied)`, value: '—', dim: true });
  }

  if (cat.secondaryTax > 0) {
    const secName = cat.secondaryTaxName ?? 'Tax';
    if (cat.secondaryTaxMode === 'inclusive') {
      rows.push({
        label: `  ${secName} included (${cat.secondaryTaxPercent}%)`,
        value: fmt(cat.secondaryTax),
        dim: true,
      });
    } else {
      rows.push({
        label: `+ ${secName} ${cat.secondaryTaxPercent}% (on top)`,
        value: fmt(cat.secondaryTax),
      });
    }
  }

  rows.push({ label: `= total`, value: fmt(cat.gross) });

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row, i) => (
        <div key={i} className={`flex justify-between gap-4 ${row.dim ? 'text-foreground/40' : ''}`}>
          <span>{row.label}</span>
          <span>{row.value}</span>
        </div>
      ))}
      {cat.taxMode === 'inclusive' && cat.tax > 0 && (
        <div className="mt-1 border-t border-foreground/10 pt-1 text-xs text-foreground/40">
          The included {cat.taxName ?? 'tax'} is reported on the receipt but already inside the price.
        </div>
      )}
    </div>
  );
}
