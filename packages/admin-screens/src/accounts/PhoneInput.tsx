import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { filterCountries, type CountryOption } from '../data/countries';
import { parseInternationalPhone, composePhone, storedPhoneHint } from '../lib/phone-utils';

interface PhoneInputProps {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
}

// The staff-mode country picker and field retain the POS control's presentation.
// Country picker — a button that toggles a searchable dropdown
// ---------------------------------------------------------------------------
function CountryPicker({
  selected,
  onSelect,
  kiosk,
}: {
  selected: CountryOption;
  onSelect: (c: CountryOption) => void;
  kiosk: boolean;
}) {
  const searchPlaceholder = 'Search country or code\u2026';
  const noResultsLabel = 'No results';
  const selectCountryLabel = 'Select country code';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filtered = filterCountries(query);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (c: CountryOption) => {
    onSelect(c);
    setOpen(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1.5 rounded-lg border bg-background transition-colors hover:bg-muted shrink-0',
          kiosk ? 'h-16 px-4 text-xl gap-2 rounded-2xl' : 'h-10 px-3 text-sm',
        )}
        aria-label={selectCountryLabel}
      >
        <span className={kiosk ? 'text-2xl' : 'text-lg'}>{selected.flag}</span>
        <span className="font-semibold tabular-nums">+{selected.dialCode}</span>
        <ChevronDown className={cn('text-muted-foreground', kiosk ? 'w-5 h-5' : 'w-4 h-4')} />
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 rounded-xl border bg-popover shadow-xl overflow-hidden flex flex-col',
            kiosk ? 'w-80 max-h-96' : 'w-72 max-h-72',
          )}
          style={{ top: '100%', left: 0 }}
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">{noResultsLabel}</p>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.iso2}
                  type="button"
                  onClick={() => handleSelect(c)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors hover:bg-muted',
                    c.iso2 === selected.iso2 && 'bg-primary/10 text-primary font-semibold',
                  )}
                >
                  <span className="text-lg shrink-0">{c.flag}</span>
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-muted-foreground tabular-nums shrink-0">
                    +{c.dialCode}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function PhoneInput({
  value,
  onChange,
  label,
  className,
  inputClassName,
  disabled = false,
}: PhoneInputProps) {
  const resolvedLabel = label !== undefined ? label : 'Phone Number';
  const nationalNumberPlaceholder = 'national number';
  const storedAsLabel = 'Stored as:';
  const parsed = parseInternationalPhone(value);
  const nationalNumber = parsed.nationalNumber;

  // Track the picked country in local state so selecting a country persists
  // even before any digits are typed (composePhone returns "" for an empty
  // number, which would otherwise reset the picker back to the default).
  const [country, setCountry] = useState<CountryOption>(parsed.country);

  // Sync when an external value carries a resolvable country code.
  useEffect(() => {
    if (value) setCountry(parseInternationalPhone(value).country);
  }, [value]);

  const handleCountryChange = (c: CountryOption) => {
    setCountry(c);
    onChange(composePhone(c, nationalNumber));
  };

  const handleNationalNumberChange = (digits: string) => {
    const clean = digits.replace(/\D/g, '');
    onChange(composePhone(country, clean));
  };

  // Staff / keyboard mode: country picker + text input side by side
  return (
    <div className={cn('space-y-1', className)}>
      {resolvedLabel && (
        <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {resolvedLabel}
        </label>
      )}
      <div className="flex items-center gap-2">
        <CountryPicker selected={country} onSelect={handleCountryChange} kiosk={false} />
        <input
          type="tel"
          aria-label={resolvedLabel || 'Phone'}
          inputMode="numeric"
          value={nationalNumber}
          onChange={(e) => handleNationalNumberChange(e.target.value)}
          disabled={disabled}
          placeholder={country.dialCode === '66' ? '818953926' : nationalNumberPlaceholder}
          className={cn(
            'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
            'placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            inputClassName,
          )}
        />
      </div>
      {value && (
        <p className="text-xs text-muted-foreground">
          {storedAsLabel} <span className="font-mono">{storedPhoneHint(value)}</span>
        </p>
      )}
    </div>
  );
}
