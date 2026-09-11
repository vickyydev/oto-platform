/**
 * Shared phone input with searchable country picker defaulting to Thailand (+66).
 *
 * Props:
 *   value      — full international number, e.g. "+66818953926" (empty string = none)
 *   onChange   — called with the new full international number
 *   showKeypad — render the on-screen numeric keypad (NumberKeypad) for kiosk/
 *                customer screens; when false a physical-keyboard text input is used
 *   label      — optional label text (default "Phone Number")
 *   className  — extra class on the root div
 *   inputClassName — extra class on the text input (staff mode only)
 *
 * The stored value is always "+{dialCode}{nationalDigits}", e.g. "+66818953926".
 * On-screen keypad: reuses NumberKeypad (kiosk) — no duplication of pad logic.
 */

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { filterCountries, type CountryOption } from '@/data/countries';
import { parseInternationalPhone, composePhone } from '@/lib/phoneUtils';
import { NumberKeypad } from '@/components/till/NumberKeypad';
import type { ContactChannel } from '@/types';
import { CONTACT_CHANNELS, CHANNEL_ICON, CHANNEL_COLOR, CHANNEL_LABEL, normalizeChannel } from '@/lib/contactChannel';
import { useLanguage } from '@/i18n/LanguageContext';

interface PhoneInputProps {
  value: string;
  onChange: (next: string) => void;
  showKeypad?: boolean;
  label?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  /**
   * When both `channel` and `onChannelChange` are supplied, a compact pill
   * selector (WhatsApp / Telegram) is rendered under the phone field. Omitted
   * entirely on surfaces that don't need it (e.g. AttendeeFormFields,
   * History, PartyEditForm) so those stay unchanged.
   */
  channel?: ContactChannel;
  onChannelChange?: (channel: ContactChannel) => void;
  /**
   * Opts this instance into `t()`-driven strings (label default, search
   * placeholder, "No results", etc). This component is shared between
   * staff-only forms (History, PartyEditForm, MemberFormDialog — stay
   * hardcoded English, default false) and customer-facing surfaces
   * (`/book`, CustomerDisplay, ConsentCapture — pass true) since language
   * selection is a single global context, not per-screen.
   */
  translate?: boolean;
}

// ---------------------------------------------------------------------------
// Compact channel selector — a row of pills (one per CONTACT_CHANNELS entry).
// Rendered only when the parent opts in via channel + onChannelChange.
// ---------------------------------------------------------------------------
function ChannelSelector({
  channel,
  onChange,
  kiosk,
}: {
  channel: ContactChannel;
  onChange: (c: ContactChannel) => void;
  kiosk: boolean;
}) {
  const current = normalizeChannel(channel);
  return (
    <div className={cn('flex items-center gap-1.5', kiosk ? 'mt-3' : 'mt-1.5')}>
      {CONTACT_CHANNELS.map((c) => {
        const Icon = CHANNEL_ICON[c];
        const active = current === c;
        const colors = CHANNEL_COLOR[c];
        return (
          <button
            key={c}
            type="button"
            title={CHANNEL_LABEL[c]}
            onClick={() => onChange(c)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border font-semibold transition-colors',
              kiosk ? 'h-10 px-4 text-sm' : 'h-7 px-2.5 text-xs',
              active
                ? `${colors.bg} ${colors.text} ${colors.border}`
                : 'bg-transparent text-muted-foreground border-transparent hover:text-foreground',
            )}
          >
            <Icon className={kiosk ? 'w-4 h-4' : 'w-3 h-3'} />
            {CHANNEL_LABEL[c]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Country picker — a button that toggles a searchable dropdown
// ---------------------------------------------------------------------------
function CountryPicker({
  selected,
  onSelect,
  kiosk,
  translate,
}: {
  selected: CountryOption;
  onSelect: (c: CountryOption) => void;
  kiosk: boolean;
  translate: boolean;
}) {
  const { t } = useLanguage();
  const searchPlaceholder = translate ? t('phoneInput.searchCountry') : 'Search country or code…';
  const noResultsLabel = translate ? t('phoneInput.noResults') : 'No results';
  const selectCountryLabel = translate ? t('phoneInput.selectCountry') : 'Select country code';
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
  showKeypad = false,
  label,
  className,
  inputClassName,
  disabled = false,
  channel,
  onChannelChange,
  translate = false,
}: PhoneInputProps) {
  const { t } = useLanguage();
  const resolvedLabel = label !== undefined ? label : translate ? t('phoneInput.label') : 'Phone Number';
  const nationalNumberPlaceholder = translate ? t('phoneInput.nationalNumberPlaceholder') : 'national number';
  const storedAsLabel = translate ? t('phoneInput.storedAs') : 'Stored as:';
  const showChannelSelector = channel !== undefined && !!onChannelChange;
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

  if (showKeypad) {
    // Kiosk / customer-display mode: styled display + NumberKeypad (reused from till/)
    return (
      <div className={cn('space-y-4', className)}>
        {resolvedLabel && <label className="text-foreground/70 text-lg">{resolvedLabel}</label>}

        <div className="flex items-stretch gap-2">
          <CountryPicker selected={country} onSelect={handleCountryChange} kiosk translate={translate} />

          {/* Number display */}
          <div className="h-16 flex-1 rounded-2xl bg-foreground/5 border border-foreground/10 flex items-center px-5 text-3xl font-bold tracking-wider select-none">
            {nationalNumber ? (
              <span>
                <span className="text-foreground/50">+{country.dialCode} </span>
                {nationalNumber}
              </span>
            ) : (
              <span className="text-foreground/30">
                {country.dialCode === '66' ? '8X XXX XXXX' : nationalNumberPlaceholder}
              </span>
            )}
          </div>
        </div>

        {/* Reuse NumberKeypad from till/ — drives the national-number portion */}
        <NumberKeypad
          value={nationalNumber}
          onChange={handleNationalNumberChange}
          maxLength={15}
        />

        {showChannelSelector && (
          <ChannelSelector channel={channel} onChange={onChannelChange!} kiosk />
        )}
      </div>
    );
  }

  // Staff / keyboard mode: country picker + text input side by side
  return (
    <div className={cn('space-y-1', className)}>
      {resolvedLabel && (
        <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {resolvedLabel}
        </label>
      )}
      <div className="flex items-center gap-2">
        <CountryPicker selected={country} onSelect={handleCountryChange} kiosk={false} translate={translate} />
        <input
          type="tel"
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
      {showChannelSelector && (
        <ChannelSelector channel={channel} onChange={onChannelChange!} kiosk={false} />
      )}
      {value && (
        <p className="text-xs text-muted-foreground">
          {storedAsLabel} <span className="font-mono">{value}</span>
        </p>
      )}
    </div>
  );
}
