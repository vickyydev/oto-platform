import { useState, useId } from 'react';
import { parsePackQuantity } from '@oto/shared';
import { StockUnit } from '@/types';
import { comboSummary } from '@/lib/stockUnits';

/**
 * S2-14b — what an entry comes to, in whole eaches, or NaN when it is refused.
 *
 * The prototype's `parseUnitCombo` ROUNDED ("1.3 dozen" became 16) and floored
 * a negative at 0; the platform stores whole eaches and refuses a part pack
 * that does not land on one (`parsePackQuantity`, `@oto/shared`), so the screen
 * refuses it too, with the reason under the field, and a caller reading
 * `eaches > 0` simply cannot submit it.
 */
export function entryEaches(raw: string, units: readonly StockUnit[]): { eaches: number; reason: string | null } {
  const parsed = parsePackQuantity(raw, units);
  return parsed.ok ? { eaches: parsed.eaches, reason: null } : { eaches: Number.NaN, reason: parsed.reason };
}

interface UnitQuantityInputProps {
  units?: StockUnit[];
  value: string;
  /** `eaches` is NaN while the entry is refused (a part pack, a negative, not a number). */
  onChange: (raw: string, eaches: number) => void;
  placeholder?: string;
  label?: string;
  error?: string;
  disabled?: boolean;
}

/**
 * Touch-friendly quantity entry supporting unit combos.
 * Shows unit chips (Case, Dozen…) to tap and compose a combo qty string;
 * always shows the resolved eaches count below the field.
 */
export function UnitQuantityInput({
  units = [],
  value,
  onChange,
  placeholder,
  label,
  error,
  disabled,
}: UnitQuantityInputProps) {
  const id = useId();
  const [focussed, setFocussed] = useState(false);

  const { eaches, reason } = entryEaches(value, units);
  const showSummary = value.trim() !== '' && eaches > 0;
  const shownError = error ?? reason ?? undefined;

  const appendUnit = (unit: StockUnit) => {
    const current = value.trim();
    const next = current
      ? current.endsWith('+') || current.endsWith('+')
        ? `${current} 1 ${unit.label}`
        : `${current} + 1 ${unit.label}`
      : `1 ${unit.label}`;
    onChange(next, entryEaches(next, units).eaches);
  };

  const handleChange = (raw: string) => {
    onChange(raw, entryEaches(raw, units).eaches);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
      )}

      {/* Unit chip shortcuts */}
      {units.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {units.map((u) => (
            <button
              key={u.id}
              type="button"
              disabled={disabled}
              onClick={() => appendUnit(u)}
              className="px-2.5 py-1 rounded-full border border-foreground/20 text-xs font-medium
                         text-foreground/70 hover:border-primary hover:text-primary transition-colors
                         disabled:opacity-40"
            >
              {u.label} ({u.eaches})
            </button>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange('', 0)}
            className="px-2.5 py-1 rounded-full border border-foreground/10 text-xs text-foreground/40
                       hover:border-destructive hover:text-destructive transition-colors disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      )}

      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        placeholder={placeholder ?? (units.length > 0 ? 'e.g. 1 Case + 3' : 'Qty')}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setFocussed(true)}
        onBlur={() => setFocussed(false)}
        className={`h-11 w-full rounded-lg border bg-background px-3 text-base transition-colors
          ${focussed ? 'border-primary ring-1 ring-primary/20' : 'border-input'}
          ${shownError ? 'border-destructive' : ''}
          disabled:opacity-50`}
      />

      {showSummary && (
        <p className="text-xs text-foreground/50">
          = <strong className="text-foreground">{comboSummary(eaches)}</strong>
        </p>
      )}

      {shownError && <p className="text-xs text-destructive">{shownError}</p>}
    </div>
  );
}
