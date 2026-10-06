import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { bahtFromSatang, satangFromBaht, type DropOffPricingConfig } from '@oto/shared';
import type { DropOffPricing, WeekdayWeekendPrice } from '@/types';
import { MarketsTiersSection } from '../markets-tiers/MarketsTiersSection';
import { PricingOverridesSection } from '../pricing-overrides/PricingOverridesSection';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { getActiveBranch } from '@/store/catalogStore';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { boardApi, checkinApi, TILL_NOT_LINKED } from '@/api/checkin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WeekdayWeekendPriceInput } from '@/components/shared/WeekdayWeekendPriceInput';
import { cn } from '@/lib/utils';
import { AdminNoticeBanner } from '../NotSavedNotice';

const pairToBaht = (p: { weekday: number; weekend: number }): WeekdayWeekendPrice => ({
  weekday: bahtFromSatang(p.weekday),
  weekend: bahtFromSatang(p.weekend),
});
const pairToSatang = (p: WeekdayWeekendPrice): { weekday: number; weekend: number } => ({
  weekday: satangFromBaht(p.weekday),
  weekend: satangFromBaht(p.weekend),
});

/** The park's platform pricing (satang) as the panel and the till's store hold it (baht). */
function pricingFromConfig(c: DropOffPricingConfig): DropOffPricing {
  return {
    oneTimeFeeTHB: pairToBaht(c.oneTimeFee),
    nannyHourlyRateTHB: pairToBaht(c.nannyHourly),
    extraHourTHB: pairToBaht(c.extraHour),
    fullDayHours: c.fullDayHours,
    nannyRatioSoftMax: c.nannyRatioSoftMax,
    prepaidFoodRefundPolicy: c.prepaidFoodUnused,
  };
}

// The plain-number drop-off/nanny values, in the order they appear in the form.
const FIELDS: {
  key: keyof Pick<DropOffPricing, 'fullDayHours' | 'nannyRatioSoftMax'>;
  label: string;
  unit: string;
  hint: string;
  min: number;
  step: string;
}[] = [
  {
    key: 'fullDayHours',
    label: 'Full-day hours',
    unit: 'hours',
    hint: 'Hours used to compute a full-day nanny cost.',
    min: 0,
    step: '1',
  },
  {
    key: 'nannyRatioSoftMax',
    label: 'Nanny ratio soft cap',
    unit: 'children',
    hint: 'Gentle "covering N children" warning threshold — never enforced.',
    min: 1,
    step: '1',
  },
];

// The weekday/weekend price fields, each edited with a paired input.
const PRICE_FIELDS: {
  key: keyof Pick<DropOffPricing, 'oneTimeFeeTHB' | 'nannyHourlyRateTHB' | 'extraHourTHB'>;
  label: string;
  hint: string;
}[] = [
  {
    key: 'oneTimeFeeTHB',
    label: 'One-time drop-off fee',
    hint: 'Flat fee charged once for a drop-off (non-nanny) check-in.',
  },
  {
    key: 'nannyHourlyRateTHB',
    label: 'Nanny hourly rate',
    hint: 'Billed per supervised hour; shared across siblings on one nanny.',
  },
  {
    key: 'extraHourTHB',
    label: 'Extra hour (overstay) rate',
    hint: 'Charged per hour a child stays past their booked play time.',
  },
];

type NumericKey = typeof FIELDS[number]['key'];
type NumericValues = Record<NumericKey, string>;
type NumericErrors = Partial<Record<NumericKey, string>>;
type PriceKey = typeof PRICE_FIELDS[number]['key'];
type PriceValues = Record<PriceKey, WeekdayWeekendPrice>;

const toNumericForm = (p: DropOffPricing): NumericValues => ({
  fullDayHours: String(p.fullDayHours),
  nannyRatioSoftMax: String(p.nannyRatioSoftMax),
});

const toPriceForm = (p: DropOffPricing): PriceValues => ({
  oneTimeFeeTHB: p.oneTimeFeeTHB,
  nannyHourlyRateTHB: p.nannyHourlyRateTHB,
  extraHourTHB: p.extraHourTHB,
});

/**
 * Admin editing screen for drop-off & nanny pricing. Opens on the park's
 * platform config and saves to it (S2-13 round 2 — audited there), then writes
 * the same values through `updateDropOffPricing` so the till in this tab
 * prices with them at once.
 */
export function DropOffPricingPanel() {
  const { dropOffPricing, mutators } = useCatalogStore();
  const platformId = apiBranchIdForSlug(getActiveBranch().id);
  const [saveError, setSaveError] = useState<string | null>(platformId ? null : TILL_NOT_LINKED);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!platformId) {
      setSaveError(TILL_NOT_LINKED);
      return;
    }
    let live = true;
    checkinApi
      .config(platformId)
      .then((c) => {
        if (live) mutators.updateDropOffPricing(pricingFromConfig(c.pricing));
      })
      .catch((err: unknown) => live && setSaveError(err instanceof Error ? err.message : 'Could not load the pricing.'));
    return () => {
      live = false;
    };
  }, [platformId, mutators]);

  const [values, setValues] = useState<NumericValues>(() => toNumericForm(dropOffPricing));
  const [prices, setPrices] = useState<PriceValues>(() => toPriceForm(dropOffPricing));
  const [errors, setErrors] = useState<NumericErrors>({});
  const [refundPolicy, setRefundPolicy] = useState<DropOffPricing['prepaidFoodRefundPolicy']>(
    dropOffPricing.prepaidFoodRefundPolicy,
  );
  const [saved, setSaved] = useState(false);

  // Re-seed from the store whenever its values change (e.g. another surface
  // edits them). The form is otherwise the local source of truth while editing.
  useEffect(() => {
    setValues(toNumericForm(dropOffPricing));
    setPrices(toPriceForm(dropOffPricing));
    setRefundPolicy(dropOffPricing.prepaidFoodRefundPolicy);
    setErrors({});
  }, [dropOffPricing]);

  const dirty = useMemo(
    () =>
      FIELDS.some((f) => values[f.key] !== String(dropOffPricing[f.key])) ||
      PRICE_FIELDS.some(
        (f) =>
          prices[f.key].weekday !== dropOffPricing[f.key].weekday ||
          prices[f.key].weekend !== dropOffPricing[f.key].weekend
      ) ||
      refundPolicy !== dropOffPricing.prepaidFoodRefundPolicy,
    [values, prices, refundPolicy, dropOffPricing]
  );

  const setField = (key: NumericKey, raw: string) => {
    setValues((v) => ({ ...v, [key]: raw }));
    setSaved(false);
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const setPriceField = (key: PriceKey, next: WeekdayWeekendPrice) => {
    setPrices((p) => ({ ...p, [key]: next }));
    setSaved(false);
  };

  const validate = (): NumericErrors => {
    const next: NumericErrors = {};
    for (const f of FIELDS) {
      const raw = values[f.key].trim();
      const num = Number(raw);
      if (raw === '' || Number.isNaN(num)) {
        next[f.key] = 'Enter a valid number.';
      } else if (num < f.min) {
        next[f.key] =
          f.min === 0 ? 'Must be 0 or more.' : `Must be ${f.min} or more.`;
      }
    }
    return next;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors = validate();
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setSaved(false);
      return;
    }
    if (!platformId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const after = await boardApi.savePricing(platformId, {
        oneTimeFee: pairToSatang(prices.oneTimeFeeTHB),
        nannyHourly: pairToSatang(prices.nannyHourlyRateTHB),
        extraHour: pairToSatang(prices.extraHourTHB),
        fullDayHours: Number(values.fullDayHours),
        nannyRatioSoftMax: Number(values.nannyRatioSoftMax),
        prepaidFoodUnused: refundPolicy,
      });
      mutators.updateDropOffPricing(pricingFromConfig(after.pricing));
      setErrors({});
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save.');
      setSaved(false);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setValues(toNumericForm(dropOffPricing));
    setPrices(toPriceForm(dropOffPricing));
    setRefundPolicy(dropOffPricing.prepaidFoodRefundPolicy);
    setErrors({});
    setSaved(false);
  };

  const policyBtn = (val: DropOffPricing['prepaidFoodRefundPolicy']) =>
    cn(
      'flex-1 rounded-xl border px-4 py-3 text-sm font-semibold transition-all',
      refundPolicy === val
        ? 'border-primary bg-primary/15 text-primary ring-1 ring-primary'
        : 'border-foreground/10 bg-foreground/5 text-foreground/50 hover:border-foreground/20 hover:text-foreground/80',
    );

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
        {/* Numeric pricing fields */}
        <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
          <h2 className="text-base font-bold">Drop-off &amp; nanny pricing</h2>
          <p className="mt-1 text-sm text-foreground/50">
            These values feed the POS when pricing a drop-off or nanny check-in.
          </p>

          {/* Scoped to this card on purpose. The holiday ranges further down
              this same screen DO save, so a banner at the top of the panel
              would tar them with this one. */}
          {saveError && (
            <div className="mt-4">
              <AdminNoticeBanner>{saveError}</AdminNoticeBanner>
            </div>
          )}

          <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {PRICE_FIELDS.map((f) => (
              <WeekdayWeekendPriceInput
                key={f.key}
                label={f.label}
                hint={f.hint}
                value={prices[f.key]}
                onChange={(next) => setPriceField(f.key, next)}
              />
            ))}
            {FIELDS.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label htmlFor={`dop-${f.key}`}>{f.label}</Label>
                <div className="relative">
                  <Input
                    id={`dop-${f.key}`}
                    type="number"
                    inputMode="numeric"
                    min={f.min}
                    step={f.step}
                    value={values[f.key]}
                    onChange={(e) => setField(f.key, e.target.value)}
                    aria-invalid={errors[f.key] ? true : undefined}
                    className="pr-20"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-foreground/40">
                    {f.unit}
                  </span>
                </div>
                {errors[f.key] ? (
                  <p className="text-xs text-destructive">{errors[f.key]}</p>
                ) : (
                  <p className="text-xs text-foreground/40">{f.hint}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Prepaid food refund / forfeit policy */}
        <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
          <h2 className="text-base font-bold">Prepaid food policy</h2>
          <p className="mt-1 text-sm text-foreground/50">
            When a drop-off child leaves without spending all of their prepaid F&amp;B balance
            or using all pre-selected items, what should happen to the unused amount?
            This policy is enforced at pickup (future feature); set it here now.
          </p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              className={policyBtn('refund')}
              onClick={() => { setRefundPolicy('refund'); setSaved(false); }}
            >
              Refund unused amount
            </button>
            <button
              type="button"
              className={policyBtn('forfeit')}
              onClick={() => { setRefundPolicy('forfeit'); setSaved(false); }}
            >
              Forfeit unused amount
            </button>
          </div>
          <p className="mt-2 text-xs text-foreground/40">
            {refundPolicy === 'refund'
              ? 'Any unspent credit or uncollected items will be refunded to the parent at checkout.'
              : 'Unspent credit and uncollected items are not refunded — consider informing parents at booking.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!dirty || saving || !platformId}>
            <Check className="w-4 h-4" />
            Save changes
          </Button>
          {dirty && (
            <Button type="button" variant="outline" onClick={handleReset}>
              Discard
            </Button>
          )}
          {saved && !dirty && (
            <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
              <Check className="w-4 h-4" />
              Saved — live in the till.
            </span>
          )}
        </div>
      </form>

      <MarketsTiersSection />

      <PricingOverridesSection />
    </div>
  );
}
