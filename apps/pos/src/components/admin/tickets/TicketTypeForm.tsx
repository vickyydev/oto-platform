import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  AddOn,
  CustomerTier,
  TicketCreditRule,
  TicketFreebie,
  TicketFreebieKind,
  TicketType,
  TierAdultRule,
  TierPriceMode,
  TierPriceRule,
  WeekdayWeekendPrice,
} from '@/types';
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group';
import { Switch } from '@/components/ui/switch';
import { computeTierPrice } from './ticketPricing';
import { getTiers, getDefaultTier } from '@/store/catalogStore';
import { tierLabel } from '@/lib/membership';

// Config-driven tier helpers (read at call time so edits to the tier list flow
// through). The base price is the default tier; every other tier derives from it.
const defaultTierId = (): string => getDefaultTier().id;
const derivedTierDefs = () => getTiers().filter((t) => !t.isDefault);
const allTierIds = (): string[] => getTiers().map((t) => t.id);

const KIND_OPTIONS: { value: TicketFreebieKind; label: string }[] = [
  { value: 'adult', label: 'Free adult' },
  { value: 'child', label: 'Free child' },
  { value: 'addon', label: 'Free add-on' },
];

const ADULT_KIND_OPTIONS: { value: TierAdultRule['kind']; label: string }[] = [
  { value: 'same_as_kid', label: 'Same as kid price' },
  { value: 'set_price', label: 'Set adult price' },
  { value: 'free_adults', label: 'Free adults, then charge' },
];

const CREDIT_APPLIES_OPTIONS: { value: TicketCreditRule['appliesTo']; label: string }[] = [
  { value: 'none', label: 'No credit' },
  { value: 'adults', label: 'Adults only' },
  { value: 'kids', label: 'Kids only' },
  { value: 'both', label: 'Adults & kids' },
];

const CREDIT_BASIS_OPTIONS: { value: TicketCreditRule['basis']; label: string }[] = [
  { value: 'full_price', label: 'Full price paid' },
  { value: 'fixed', label: 'Fixed ฿' },
  { value: 'percent', label: 'Percent of price paid' },
];

interface TicketTypeFormProps {
  open: boolean;
  /** The ticket being edited, or null when creating a new one. */
  ticket: TicketType | null;
  addOns: AddOn[];
  onClose: () => void;
  onSave: (ticket: TicketType) => void;
}

// A derived tier in the form: `manual` is the absolute weekday/weekend price
// when mode==='manual', otherwise `value` is the discount (% or ฿ off the
// base tier's weekday/weekend prices respectively).
interface TierField {
  mode: TierPriceMode;
  value: string;
  manual: WeekdayWeekendPrice;
}

// A per-tier adult entry rule in the form. `price` doubles as the set_price
// amount and the free_adults overflow price; `freeAdults`/`overflow` only apply
// when kind === 'free_adults'.
interface AdultRuleField {
  kind: TierAdultRule['kind'];
  price: WeekdayWeekendPrice;
  freeAdults: string;
  overflow: 'same_as_kid' | 'set_price';
}

interface CreditField {
  appliesTo: TicketCreditRule['appliesTo'];
  basis: TicketCreditRule['basis'];
  value: string;
}

interface FreebieDraft {
  id: string;
  kind: TicketFreebieKind;
  addOnId: string;
  quantity: string;
  tiers: CustomerTier[];
}

interface FormState {
  name: string;
  durationLabel: string;
  hours: string;
  /** Price for the default (base) tier. */
  base: WeekdayWeekendPrice;
  /** Derived tier fields keyed by tier id (every non-default tier). */
  derived: Record<string, TierField>;
  /** Adult entry rule keyed by tier id (every tier, incl. the base). */
  adult: Record<string, AdultRuleField>;
  credit: CreditField;
  gateAccess: boolean;
  freebies: FreebieDraft[];
}

const zeroPrice = (): WeekdayWeekendPrice => ({ weekday: 0, weekend: 0 });
const blankTier = (): TierField => ({ mode: 'manual', value: '', manual: zeroPrice() });
const blankAdultRule = (): AdultRuleField => ({
  kind: 'same_as_kid',
  price: zeroPrice(),
  freeAdults: '1',
  overflow: 'same_as_kid',
});
const blankCredit = (): CreditField => ({
  appliesTo: 'none',
  basis: 'full_price',
  value: '',
});

const blankState = (): FormState => ({
  name: '',
  durationLabel: '',
  hours: '',
  base: zeroPrice(),
  derived: Object.fromEntries(derivedTierDefs().map((t) => [t.id, blankTier()])),
  adult: Object.fromEntries(allTierIds().map((id) => [id, blankAdultRule()])),
  credit: blankCredit(),
  gateAccess: true,
  freebies: [],
});

const tierFieldFrom = (ticket: TicketType, tierId: string): TierField => {
  const rule = ticket.tierPricing?.[tierId];
  if (rule && rule.mode !== 'manual') {
    return { mode: rule.mode, value: String(rule.value), manual: zeroPrice() };
  }
  const price = ticket.prices[tierId];
  return { mode: 'manual', value: '', manual: price ?? zeroPrice() };
};

const adultRuleFieldFrom = (t: TicketType, tierId: string): AdultRuleField => {
  const rule = t.adultRules?.[tierId];
  if (!rule) return blankAdultRule();
  return {
    kind: rule.kind,
    price: rule.price ?? zeroPrice(),
    freeAdults: rule.freeAdults != null ? String(rule.freeAdults) : '1',
    overflow: rule.overflow ?? 'same_as_kid',
  };
};

const fromTicket = (t: TicketType): FormState => ({
  name: t.name,
  durationLabel: t.durationLabel,
  hours: String(t.hours),
  base: t.prices[defaultTierId()] ?? zeroPrice(),
  derived: Object.fromEntries(
    derivedTierDefs().map((tier) => [tier.id, tierFieldFrom(t, tier.id)])
  ),
  adult: Object.fromEntries(allTierIds().map((id) => [id, adultRuleFieldFrom(t, id)])),
  credit: t.creditRule
    ? {
        appliesTo: t.creditRule.appliesTo,
        basis: t.creditRule.basis,
        value: t.creditRule.value != null ? String(t.creditRule.value) : '',
      }
    : blankCredit(),
  gateAccess: t.gateAccess ?? false,
  freebies: (t.freebies ?? []).map((f) => ({
    id: f.id,
    kind: f.kind,
    addOnId: f.addOnId ?? '',
    quantity: String(f.quantity),
    tiers: f.tiers.length ? f.tiers : allTierIds(),
  })),
});

interface FormErrors {
  name?: string;
  hours?: string;
  base?: string;
  derived?: Record<string, string>;
  adult?: Record<string, string>;
  credit?: string;
  freebies?: Record<string, string>;
}

const slugId = (name: string): string =>
  `t-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}-${Math.random().toString(36).slice(2, 7)}`;

const randomId = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

export function TicketTypeForm({
  open,
  ticket,
  addOns,
  onClose,
  onSave,
}: TicketTypeFormProps) {
  const [form, setForm] = useState<FormState>(blankState);
  const [errors, setErrors] = useState<FormErrors>({});

  const derivedTiers = derivedTierDefs();
  const allTiers = getTiers();
  const baseLabel = tierLabel(defaultTierId());

  // Derive-mode labels reference the base tier so they stay accurate if the
  // owner renames it (with seeds this reads "% off Tourist", as before).
  const MODE_OPTIONS: { value: TierPriceMode; label: string }[] = [
    { value: 'manual', label: 'Set price' },
    { value: 'percent', label: `% off ${baseLabel}` },
    { value: 'amount', label: `฿ off ${baseLabel}` },
  ];

  // Re-seed the form (and clear errors) every time the dialog opens, so a
  // cancel followed by reopening the same ticket always reloads fresh values.
  useEffect(() => {
    if (!open) return;
    setForm(ticket ? fromTicket(ticket) : blankState());
    setErrors({});
  }, [open, ticket]);

  // Live resolved price for a derived tier given the current base + mode/value.
  const resolveTier = (field: TierField): WeekdayWeekendPrice | null => {
    if (field.mode === 'manual') return field.manual;
    const v = Number(field.value);
    if (field.value.trim() === '' || Number.isNaN(v)) return null;
    return {
      weekday: computeTierPrice(Math.max(0, form.base.weekday), { mode: field.mode, value: v }),
      weekend: computeTierPrice(Math.max(0, form.base.weekend), { mode: field.mode, value: v }),
    };
  };

  const setTier = (tierId: string, patch: Partial<TierField>) =>
    setForm((f) => ({
      ...f,
      derived: { ...f.derived, [tierId]: { ...f.derived[tierId], ...patch } },
    }));

  const setAdult = (tierId: string, patch: Partial<AdultRuleField>) =>
    setForm((f) => ({
      ...f,
      adult: {
        ...f.adult,
        [tierId]: { ...(f.adult[tierId] ?? blankAdultRule()), ...patch },
      },
    }));

  const addFreebie = () =>
    setForm((f) => ({
      ...f,
      freebies: [
        ...f.freebies,
        {
          id: randomId('fb'),
          kind: 'addon',
          addOnId: addOns[0]?.id ?? '',
          quantity: '1',
          tiers: allTierIds(),
        },
      ],
    }));

  const updateFreebie = (id: string, patch: Partial<FreebieDraft>) =>
    setForm((f) => ({
      ...f,
      freebies: f.freebies.map((fb) => (fb.id === id ? { ...fb, ...patch } : fb)),
    }));

  const removeFreebie = (id: string) =>
    setForm((f) => ({ ...f, freebies: f.freebies.filter((fb) => fb.id !== id) }));

  const validate = (): TicketType | null => {
    const next: FormErrors = {};
    const name = form.name.trim();
    if (!name) next.name = 'Name is required.';

    const hours = Number(form.hours);
    if (form.hours.trim() === '' || Number.isNaN(hours) || hours < 0) {
      next.hours = 'Hours must be 0 or more.';
    }

    if (form.base.weekday < 0 || form.base.weekend < 0) {
      next.base = 'Enter a base price of 0 or more.';
    }

    const base: WeekdayWeekendPrice = {
      weekday: Math.max(0, form.base.weekday),
      weekend: Math.max(0, form.base.weekend),
    };
    const resolved: Record<string, WeekdayWeekendPrice> = { [defaultTierId()]: base };
    const tierPricing: Record<string, TierPriceRule> = {};
    const derivedErrors: Record<string, string> = {};

    for (const tier of derivedTiers) {
      const field = form.derived[tier.id];
      if (field.mode === 'manual') {
        if (field.manual.weekday < 0 || field.manual.weekend < 0) {
          derivedErrors[tier.id] = 'Enter a price of 0 or more.';
        } else {
          resolved[tier.id] = field.manual;
        }
        continue;
      }
      const v = Number(field.value);
      if (field.value.trim() === '' || Number.isNaN(v) || v < 0) {
        derivedErrors[tier.id] =
          field.mode === 'percent'
            ? 'Enter a percentage of 0 or more.'
            : 'Enter an amount of 0 or more.';
      } else if (field.mode === 'percent' && v > 100) {
        derivedErrors[tier.id] = 'Percentage cannot exceed 100.';
      } else {
        resolved[tier.id] = {
          weekday: computeTierPrice(base.weekday, { mode: field.mode, value: v }),
          weekend: computeTierPrice(base.weekend, { mode: field.mode, value: v }),
        };
        tierPricing[tier.id] = { mode: field.mode, value: v };
      }
    }
    if (Object.keys(derivedErrors).length) next.derived = derivedErrors;

    const freebieErrors: Record<string, string> = {};
    for (const fb of form.freebies) {
      const qty = Number(fb.quantity);
      if (fb.quantity.trim() === '' || Number.isNaN(qty) || qty < 1) {
        freebieErrors[fb.id] = 'Quantity must be 1 or more.';
      } else if (fb.kind === 'addon' && !fb.addOnId) {
        freebieErrors[fb.id] = 'Choose an add-on.';
      } else if (fb.tiers.length === 0) {
        freebieErrors[fb.id] = 'Pick at least one tier.';
      }
    }
    if (Object.keys(freebieErrors).length) next.freebies = freebieErrors;

    // Adult entry rule per tier. same_as_kid is the default and is omitted (a
    // missing rule means "adults pay the kid price"), keeping the data minimal.
    const adultErrors: Record<string, string> = {};
    const adultRules: Record<string, TierAdultRule> = {};
    for (const tierId of allTierIds()) {
      const field = form.adult[tierId] ?? blankAdultRule();
      if (field.kind === 'same_as_kid') continue;
      if (field.kind === 'set_price') {
        if (field.price.weekday < 0 || field.price.weekend < 0) {
          adultErrors[tierId] = 'Enter an adult price of 0 or more.';
        } else {
          adultRules[tierId] = { kind: 'set_price', price: field.price };
        }
      } else {
        const fa = Number(field.freeAdults);
        if (field.freeAdults.trim() === '' || !Number.isInteger(fa) || fa < 0) {
          adultErrors[tierId] = 'Free adults must be a whole number of 0 or more.';
        } else if (field.overflow === 'set_price') {
          if (field.price.weekday < 0 || field.price.weekend < 0) {
            adultErrors[tierId] = 'Enter an overflow price of 0 or more.';
          } else {
            adultRules[tierId] = {
              kind: 'free_adults',
              freeAdults: fa,
              overflow: 'set_price',
              price: field.price,
            };
          }
        } else {
          adultRules[tierId] = {
            kind: 'free_adults',
            freeAdults: fa,
            overflow: 'same_as_kid',
          };
        }
      }
    }
    if (Object.keys(adultErrors).length) next.adult = adultErrors;

    // F&B credit give-back. appliesTo 'none' issues no credit (omit the rule).
    let creditRule: TicketCreditRule | undefined;
    if (form.credit.appliesTo !== 'none') {
      if (form.credit.basis === 'full_price') {
        creditRule = { appliesTo: form.credit.appliesTo, basis: 'full_price' };
      } else {
        const v = Number(form.credit.value);
        if (form.credit.value.trim() === '' || !Number.isFinite(v) || v < 0) {
          next.credit = 'Enter a credit value of 0 or more.';
        } else {
          creditRule = { appliesTo: form.credit.appliesTo, basis: form.credit.basis, value: v };
        }
      }
    }

    if (
      next.name ||
      next.hours ||
      next.base ||
      next.derived ||
      next.adult ||
      next.credit ||
      next.freebies
    ) {
      setErrors(next);
      return null;
    }

    const freebies: TicketFreebie[] = form.freebies.map((fb) => ({
      id: fb.id,
      kind: fb.kind,
      ...(fb.kind === 'addon' ? { addOnId: fb.addOnId } : {}),
      quantity: Number(fb.quantity),
      tiers: fb.tiers,
    }));

    return {
      id: ticket?.id ?? slugId(name),
      name,
      durationLabel: form.durationLabel.trim(),
      hours,
      prices: resolved,
      tierPricing,
      freebies,
      ...(Object.keys(adultRules).length ? { adultRules } : {}),
      ...(creditRule ? { creditRule } : {}),
      gateAccess: form.gateAccess,
    };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validate();
    if (result) onSave(result);
  };

  const derivedNames = derivedTiers.map((t) => tierLabel(t.id)).join(' and ');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {ticket ? 'Edit ticket type' : 'Add ticket type'}
          </DialogTitle>
          <DialogDescription>
            Set the base {baseLabel} price
            {derivedNames ? `; derive ${derivedNames}` : ''}, and bundle any
            free items into the rate.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tt-name">Name</Label>
            <Input
              id="tt-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. 3 Hours Play"
              autoFocus
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tt-duration">Duration label</Label>
              <Input
                id="tt-duration"
                value={form.durationLabel}
                onChange={(e) =>
                  setForm((f) => ({ ...f, durationLabel: e.target.value }))
                }
                placeholder="e.g. 3 Hours"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tt-hours">Hours</Label>
              <Input
                id="tt-hours"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                value={form.hours}
                onChange={(e) =>
                  setForm((f) => ({ ...f, hours: e.target.value }))
                }
                placeholder="0"
              />
              {errors.hours && (
                <p className="text-xs text-destructive">{errors.hours}</p>
              )}
            </div>
          </div>

          {/* Pricing: base tier + derived tiers */}
          <div className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <div>
              <Label>Kids entry (฿)</Label>
              <p className="text-xs text-foreground/40">
                The child play price per tier — set the {baseLabel} base and
                derive the rest.
              </p>
            </div>

            <WeekdayWeekendPriceInput
              label={`${baseLabel} (base)`}
              value={form.base}
              onChange={(next) => setForm((f) => ({ ...f, base: next }))}
              error={errors.base}
            />

            {derivedTiers.map((tier) => {
              const field = form.derived[tier.id];
              if (!field) return null;
              const resolved = resolveTier(field);
              return (
                <div key={tier.id} className="flex flex-col gap-1.5">
                  <Label className="text-xs text-foreground/60">
                    {tierLabel(tier.id)}
                  </Label>
                  <Select
                    value={field.mode}
                    onValueChange={(v) =>
                      setTier(tier.id, { mode: v as TierPriceMode })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODE_OPTIONS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {field.mode === 'manual' ? (
                    <WeekdayWeekendPriceInput
                      label=""
                      value={field.manual}
                      onChange={(next) => setTier(tier.id, { manual: next })}
                      error={errors.derived?.[tier.id]}
                    />
                  ) : (
                    <>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step="1"
                        value={field.value}
                        onChange={(e) =>
                          setTier(tier.id, { value: e.target.value })
                        }
                        placeholder={field.mode === 'percent' ? '%' : '฿'}
                      />
                      <div className="flex items-center justify-between text-xs">
                        {errors.derived?.[tier.id] ? (
                          <span className="text-destructive">
                            {errors.derived[tier.id]}
                          </span>
                        ) : (
                          <span className="text-foreground/40">
                            {`Recalculates from the ${baseLabel} base`}
                          </span>
                        )}
                        {resolved !== null && (
                          <span className="font-semibold tabular-nums text-emerald-700">
                            = ฿{resolved.weekday.toLocaleString()} / ฿
                            {resolved.weekend.toLocaleString()} wknd
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Adult entry rule per tier */}
          <div className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <div>
              <Label>Adult entry</Label>
              <p className="text-xs text-foreground/40">
                How adults are charged on this ticket, per tier. Default: adults
                pay the kid price.
              </p>
            </div>
            {allTiers.map((tier) => {
              const field = form.adult[tier.id] ?? blankAdultRule();
              const err = errors.adult?.[tier.id];
              return (
                <div key={tier.id} className="flex flex-col gap-1.5">
                  <Label className="text-xs text-foreground/60">
                    {tierLabel(tier.id)}
                  </Label>
                  <Select
                    value={field.kind}
                    onValueChange={(v) =>
                      setAdult(tier.id, { kind: v as AdultRuleField['kind'] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ADULT_KIND_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {field.kind === 'set_price' && (
                    <WeekdayWeekendPriceInput
                      label=""
                      value={field.price}
                      onChange={(next) => setAdult(tier.id, { price: next })}
                    />
                  )}
                  {field.kind === 'free_adults' && (
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          step="1"
                          className="w-24 shrink-0"
                          value={field.freeAdults}
                          onChange={(e) =>
                            setAdult(tier.id, { freeAdults: e.target.value })
                          }
                          placeholder="# free"
                          aria-label={`Free adults ${tierLabel(tier.id)}`}
                        />
                        <Select
                          value={field.overflow}
                          onValueChange={(v) =>
                            setAdult(tier.id, {
                              overflow: v as 'same_as_kid' | 'set_price',
                            })
                          }
                        >
                          <SelectTrigger className="flex-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="same_as_kid">
                              then charge kid price
                            </SelectItem>
                            <SelectItem value="set_price">
                              then charge set price
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {field.overflow === 'set_price' && (
                        <WeekdayWeekendPriceInput
                          label=""
                          value={field.price}
                          onChange={(next) => setAdult(tier.id, { price: next })}
                        />
                      )}
                    </div>
                  )}
                  {err && <p className="text-xs text-destructive">{err}</p>}
                </div>
              );
            })}
          </div>

          {/* F&B credit give-back */}
          <div className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <div>
              <Label>Credit give-back</Label>
              <p className="text-xs text-foreground/40">
                Prepaid wallet credit this ticket issues — one balance spendable
                at both the F&amp;B and merch stations.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-foreground/60">Who earns credit</Label>
              <Select
                value={form.credit.appliesTo}
                onValueChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    credit: {
                      ...f.credit,
                      appliesTo: v as CreditField['appliesTo'],
                    },
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_APPLIES_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.credit.appliesTo !== 'none' && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-foreground/60">Amount</Label>
                <div className="flex gap-2">
                  <Select
                    value={form.credit.basis}
                    onValueChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        credit: { ...f.credit, basis: v as CreditField['basis'] },
                      }))
                    }
                  >
                    <SelectTrigger className="w-48 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CREDIT_BASIS_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {form.credit.basis !== 'full_price' && (
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step="1"
                      value={form.credit.value}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          credit: { ...f.credit, value: e.target.value },
                        }))
                      }
                      placeholder={form.credit.basis === 'percent' ? '%' : '฿'}
                      aria-label="Credit value"
                    />
                  )}
                </div>
                {errors.credit && (
                  <p className="text-xs text-destructive">{errors.credit}</p>
                )}
              </div>
            )}
          </div>

          {/* Gate access */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <div>
              <Label>Gate access</Label>
              <p className="text-xs text-foreground/40">
                Adults on this ticket get a wristband that opens the entry gate.
              </p>
            </div>
            <Switch
              checked={form.gateAccess}
              onCheckedChange={(checked) =>
                setForm((f) => ({ ...f, gateAccess: checked }))
              }
              aria-label="Adults open the gate"
            />
          </div>

          {/* Freebies */}
          <div className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Free items in the rate</Label>
                <p className="text-xs text-foreground/40">
                  Bundle a free adult, child or add-on into this ticket.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addFreebie}
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>

            {form.freebies.length === 0 ? (
              <p className="text-xs text-foreground/40">No free items.</p>
            ) : (
              form.freebies.map((fb) => (
                <div
                  key={fb.id}
                  className="flex flex-col gap-2 rounded-xl bg-foreground/[0.02] p-3"
                >
                  <div className="flex gap-2">
                    <Select
                      value={fb.kind}
                      onValueChange={(v) =>
                        updateFreebie(fb.id, { kind: v as TicketFreebieKind })
                      }
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KIND_OPTIONS.map((k) => (
                          <SelectItem key={k.value} value={k.value}>
                            {k.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step="1"
                      className="w-20"
                      value={fb.quantity}
                      onChange={(e) =>
                        updateFreebie(fb.id, { quantity: e.target.value })
                      }
                      aria-label="Quantity"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive shrink-0"
                      aria-label="Remove free item"
                      onClick={() => removeFreebie(fb.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {fb.kind === 'addon' && (
                    <Select
                      value={fb.addOnId}
                      onValueChange={(v) =>
                        updateFreebie(fb.id, { addOnId: v })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose add-on" />
                      </SelectTrigger>
                      <SelectContent>
                        {addOns.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-foreground/50">Applies to:</span>
                    <ToggleGroup
                      type="multiple"
                      variant="outline"
                      size="sm"
                      value={fb.tiers}
                      onValueChange={(vals) =>
                        updateFreebie(fb.id, { tiers: vals as CustomerTier[] })
                      }
                    >
                      {allTiers.map((tier) => (
                        <ToggleGroupItem key={tier.id} value={tier.id}>
                          {tier.name}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>

                  {errors.freebies?.[fb.id] && (
                    <p className="text-xs text-destructive">
                      {errors.freebies[fb.id]}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              {ticket ? 'Save changes' : 'Add ticket type'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
