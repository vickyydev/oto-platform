import type { ReactNode } from 'react';
import { CONTROL } from '@/components/Filters';
import { cn } from '@/lib/utils';

/**
 * The console's first real forms — station setup, device details, pairing.
 *
 * They wear the filter controls' clothes on purpose: same rounded field, same
 * ring, same small uppercase label, so a page that reads a list and a page
 * that edits one do not look like two products. Native controls throughout,
 * for the reason Filters.tsx gives — a keyboard, a screen reader and a phone
 * all already know how to drive a <select>.
 */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  /** One line under the control saying what a reader cannot guess from its name. */
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex flex-col gap-1 min-w-0', className)}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">
        {label}
      </span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  maxLength,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
      className={cn(CONTROL, 'disabled:opacity-60', className)}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  min,
  disabled,
}: {
  /** Null is "not set", which is a different answer from zero everywhere it is used here. */
  value: number | null;
  onChange: (next: number | null) => void;
  placeholder?: string;
  min?: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      value={value === null ? '' : String(value)}
      placeholder={placeholder}
      min={min}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value.trim();
        onChange(raw === '' ? null : Number(raw));
      }}
      className={cn(CONTROL, 'tabular-nums disabled:opacity-60')}
    />
  );
}

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Option[];
  /** The empty first entry. Absent means the field has no empty state. */
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(CONTROL, 'disabled:opacity-60')}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A choice between a handful of named alternatives, all of them visible at once. */
export function ChoiceRow({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Option[];
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-full border px-3 h-8 text-xs font-semibold transition-colors hover-elevate active-elevate-2 disabled:opacity-50',
            value === o.value
              ? 'bg-primary text-primary-foreground border-primary-border'
              : 'text-foreground/70 [border-color:var(--button-outline)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A tick with its name and, where it earns one, a line of consequence beneath. */
export function CheckRow({
  checked,
  onChange,
  label,
  detail,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  detail?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-[hsl(var(--primary))]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium break-words">{label}</span>
        {detail && <span className="block text-xs text-muted-foreground break-words">{detail}</span>}
      </span>
    </label>
  );
}

/** A heading inside a drawer's form, with the reason for the step under it. */
export function Step({
  n,
  title,
  detail,
  children,
}: {
  /** The order matters here — box, then devices, then who may use it. */
  n: number;
  title: string;
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground/5 text-[11px] font-bold tabular-nums text-foreground/60">
          {n}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold">{title}</h3>
          {detail && <p className="mt-0.5 text-xs text-muted-foreground break-words">{detail}</p>}
        </div>
      </div>
      <div className="pl-9 flex flex-col gap-3">{children}</div>
    </section>
  );
}
