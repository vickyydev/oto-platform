import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes } from 'react';

// Local form atoms scoped to the Admin Discounts screen. The shared POS atoms
// live in src/components/shared and are intentionally not touched here.

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
        {label}
      </span>
      {children}
      {error ? (
        <span className="text-xs font-medium text-rose-400">{error}</span>
      ) : hint ? (
        <span className="text-xs text-foreground/35">{hint}</span>
      ) : null}
    </label>
  );
}

const fieldBase =
  'h-10 w-full rounded-xl border bg-black/20 px-3 text-sm text-foreground placeholder:text-foreground/30 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50';

export function TextInput({
  invalid,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      className={`${fieldBase} ${
        invalid ? 'border-rose-500/60' : 'border-foreground/10'
      } ${className}`}
    />
  );
}

export function SelectInput({
  invalid,
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      {...props}
      className={`${fieldBase} ${
        invalid ? 'border-rose-500/60' : 'border-foreground/10'
      } ${className}`}
    >
      {children}
    </select>
  );
}
