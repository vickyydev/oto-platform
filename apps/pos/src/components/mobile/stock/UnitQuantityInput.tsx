import { useState, useId } from 'react';
import { StockUnit } from '@/types';
import { parseUnitCombo, comboSummary } from '@/lib/stockUnits';

interface UnitQuantityInputProps {
  units?: StockUnit[];
  value: string;
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

  const eaches = parseUnitCombo(value, units);
  const showSummary = value.trim() !== '' && eaches > 0;

  const appendUnit = (unit: StockUnit) => {
    const current = value.trim();
    const next = current
      ? current.endsWith('+') || current.endsWith('+')
        ? `${current} 1 ${unit.label}`
        : `${current} + 1 ${unit.label}`
      : `1 ${unit.label}`;
    onChange(next, parseUnitCombo(next, units));
  };

  const handleChange = (raw: string) => {
    onChange(raw, parseUnitCombo(raw, units));
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
          ${error ? 'border-destructive' : ''}
          disabled:opacity-50`}
      />

      {showSummary && (
        <p className="text-xs text-foreground/50">
          = <strong className="text-foreground">{comboSummary(eaches)}</strong>
        </p>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
