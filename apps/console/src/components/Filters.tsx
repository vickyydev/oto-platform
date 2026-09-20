import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Filters, in the till's field language (rounded, bordered, --input) at the
 * smaller size a back-office row wants. Native controls throughout: a select
 * that a keyboard, a screen reader and a phone all already know how to drive is
 * worth more here than a prettier one that none of them do.
 */
const CONTROL =
  'h-9 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}>{children}</div>;
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">
        {label}
      </span>
      {children}
    </label>
  );
}

export function TextFilter({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <Labelled label={label}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={CONTROL}
      />
    </Labelled>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

export function SelectFilter({
  label,
  value,
  onChange,
  options,
  anyLabel = 'Any',
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: FilterOption[];
  anyLabel?: string;
}) {
  return (
    <Labelled label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={CONTROL}>
        <option value="">{anyLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Labelled>
  );
}

export function DateTimeFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  /** An ISO instant, or '' for unset. */
  value: string;
  onChange: (nextIso: string) => void;
}) {
  // <input type="datetime-local"> speaks local wall-clock time with no zone, so
  // it is converted at this boundary and nowhere else: what the API stores and
  // compares is always UTC.
  const local = value ? toLocalInput(value) : '';
  return (
    <Labelled label={label}>
      <input
        type="datetime-local"
        value={local}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')}
        className={CONTROL}
      />
    </Labelled>
  );
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The row of quick ranges above the filters — the ones actually used. */
export function PresetRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function PresetButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 h-8 text-xs font-semibold transition-colors hover-elevate active-elevate-2',
        active
          ? 'bg-primary text-primary-foreground border-primary-border'
          : 'text-foreground/70 [border-color:var(--button-outline)]',
      )}
    >
      {children}
    </button>
  );
}
