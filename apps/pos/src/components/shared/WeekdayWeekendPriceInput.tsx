import type { WeekdayWeekendPrice } from '@/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface WeekdayWeekendPriceInputProps {
  label: string;
  value: WeekdayWeekendPrice;
  onChange: (next: WeekdayWeekendPrice) => void;
  error?: string;
  /** Optional helper text shown under the pair of inputs. */
  hint?: string;
  /** Reflect the weekday value in the weekend field until the weekend field is touched. */
  disabled?: boolean;
}

/**
 * Paired ฿ weekday/weekend inputs for one price field — the single admin
 * editor widget for every WeekdayWeekendPrice in the catalog (tickets, add-ons,
 * menu items, merch, modifiers, drop-off/nanny fees, event passes, etc).
 */
export function WeekdayWeekendPriceInput({
  label,
  value,
  onChange,
  error,
  hint,
  disabled,
}: WeekdayWeekendPriceInputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Weekday (฿)</span>
          <Input
            type="number"
            min={0}
            disabled={disabled}
            value={value.weekday}
            onChange={(e) => {
              const weekday = Number(e.target.value);
              onChange({ ...value, weekday: Number.isNaN(weekday) ? 0 : weekday });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Weekend / holiday (฿)</span>
          <Input
            type="number"
            min={0}
            disabled={disabled}
            value={value.weekend}
            onChange={(e) => {
              const weekend = Number(e.target.value);
              onChange({ ...value, weekend: Number.isNaN(weekend) ? 0 : weekend });
            }}
          />
        </div>
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-foreground/40">{hint}</p>
      ) : null}
    </div>
  );
}
