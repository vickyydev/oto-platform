import { AddOn } from '@/types';
import { resolveRateToday } from '@/lib/pricingMode';
import { resolveName } from '@/i18n/resolveTranslation';
import { useLanguage } from '@/i18n/LanguageContext';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { Check, type LucideIcon } from 'lucide-react';

// A labelled quantity row (kids / adults / socks) used across the booking flow.
export function StepRow({
  icon: Icon,
  label,
  description,
  value,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  description?: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const active = value > 0;
  return (
    <div
      className={`flex items-center gap-4 p-4 rounded-2xl border transition-colors ${
        active ? 'bg-primary/10 border-primary/60' : 'bg-white border-slate-200'
      }`}
    >
      <div
        className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
          active ? 'bg-primary/20 text-primary' : 'bg-white text-slate-500'
        }`}
      >
        <Icon className="w-6 h-6" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-bold leading-tight">{label}</div>
        {description && <div className="text-xs text-slate-500 truncate">{description}</div>}
      </div>
      <QuantityStepper value={value} onChange={onChange} min={0} ariaLabel={label} />
    </div>
  );
}

// The selectable list of add-ons (the "Extras & add-ons" toggles). Shared by the
// normal-ticket config and the drop-off child form so both price extras the same.
export function AddOnToggles({
  addOns,
  selected,
  onToggle,
}: {
  addOns: AddOn[];
  selected: AddOn[];
  onToggle: (addOn: AddOn) => void;
}) {
  const { lang } = useLanguage();
  return (
    <div className="space-y-3">
      {addOns.map((addon) => {
        const isSelected = selected.some((a) => a.id === addon.id);
        return (
          <button
            type="button"
            key={addon.id}
            onClick={() => onToggle(addon)}
            className={`w-full flex items-center justify-between p-4 rounded-2xl border text-left transition-all active:scale-[0.98] ${
              isSelected ? 'bg-primary/15 border-primary' : 'border-slate-200 hover:border-primary/40'
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 ${
                  isSelected ? 'bg-primary border-primary' : 'border-slate-300'
                }`}
              >
                {isSelected && <Check className="w-4 h-4 text-primary-foreground" />}
              </div>
              <span className="font-medium">{resolveName(addon, lang)}</span>
            </div>
            <span className="text-primary font-semibold">+฿{resolveRateToday(addon.price)}</span>
          </button>
        );
      })}
    </div>
  );
}
