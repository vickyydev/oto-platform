import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { StatusMark, type Tone } from '@/components/Status';
import { cn } from '@/lib/utils';

/**
 * The console's chip vocabulary (SCRUM-474), one implementation for every
 * redesigned page.
 *
 * Every chip that carries a status ink carries its SHAPE too — the dot, the
 * triangle, the barred octagon or the hollow ring from `StatusMark` — so the
 * state survives a colour-blind reader and a bad projector, exactly as the
 * `Status.tsx` discipline asks. Chips with no state (a kind, a branch, a code)
 * take the neutral or the mint wash and no shape, and never a status ink.
 */

/** Literal class names per tone, so Tailwind sees every one of them. */
export const TONE_INK: Record<Tone, string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  down: 'text-status-down',
  idle: 'text-status-idle',
};

export const TONE_TINT: Record<Tone, string> = {
  ok: 'bg-status-ok/12',
  warn: 'bg-status-warn/15',
  down: 'bg-status-down/12',
  idle: 'bg-status-idle/12',
};

export const TONE_EDGE: Record<Tone, string> = {
  ok: 'border-status-ok/30',
  warn: 'border-status-warn/30',
  down: 'border-status-down/35',
  idle: 'border-status-idle/30',
};

/**
 * A state with its name, on a wash of its own ink: the ledger's "Printed", a
 * card's "Configured", the Failures heading's "2 groups".
 */
export function StatusChip({
  tone,
  children,
  className,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-[11px] py-1 text-xs font-bold whitespace-nowrap',
        TONE_TINT[tone],
        TONE_INK[tone],
        className,
      )}
    >
      <StatusMark tone={tone} className="w-2.5 h-2.5" />
      {children}
    </span>
  );
}

/**
 * The command bar's chip: card-white with a hairline, the state's ink on the
 * words when it has one ("All services reporting"), plain when it is a fact
 * ("checked 30 s ago").
 */
export function BarChip({
  tone,
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-[7px] rounded-full border border-border bg-card px-3.5 py-2 text-[13px] font-semibold',
        tone ? TONE_INK[tone] : 'text-muted-foreground',
        className,
      )}
    >
      {tone && <StatusMark tone={tone} className="w-2.5 h-2.5" />}
      {children}
    </span>
  );
}

/** The quieter chip beside a page title: what the page is, or a count. */
export function TitleChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-border bg-card px-3 py-[5px] text-[12.5px] font-semibold text-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A label with no state: a kind, a role, a branch. `mint` is the secondary
 * wash the artboards give a box or a linked thing; `muted` is everything else.
 */
export function Tag({
  children,
  variant = 'muted',
  upper = false,
  className,
}: {
  children: ReactNode;
  variant?: 'muted' | 'mint';
  /** The device cards' kind label, set in small capitals. */
  upper?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold whitespace-nowrap',
        variant === 'mint' ? 'bg-secondary text-secondary-foreground' : 'bg-muted text-muted-foreground',
        upper && 'text-[11px] font-bold uppercase tracking-[0.05em] py-1',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** An identifier the platform speaks: an action name, a fingerprint, a reason code. */
export function CodeTag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block max-w-full rounded-[7px] bg-secondary px-[9px] py-[3px] font-mono text-[11.5px] text-secondary-foreground break-all',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A toggle in a row of presets: the dark pill when chosen, card-white when
 * not. A real button with `aria-pressed`, so a keyboard and a screen reader
 * both know which one is on.
 */
export function FilterChip({
  active,
  children,
  className,
  ...rest
}: {
  active: boolean;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-[7px] text-[12.5px] whitespace-nowrap transition-colors disabled:opacity-50',
        active
          ? 'border-foreground bg-foreground text-background font-bold'
          : 'border-border bg-card text-muted-foreground font-semibold hover:text-foreground',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A count on a nav entry or a card heading, in the ink of what it counts. */
export function CountBadge({
  tone,
  count,
  label,
  className,
}: {
  tone: Tone;
  count: number | string;
  /** Read out instead of the bare number. */
  label: string;
  className?: string;
}) {
  return (
    <span
      title={label}
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-full px-1.5 text-[11px] font-bold tabular-nums',
        TONE_TINT[tone],
        TONE_INK[tone],
        className,
      )}
    >
      <StatusMark tone={tone} className="w-2 h-2" />
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * A native select dressed as a chip, for a filter that lives on a card's title
 * row or in the command bar. Native on purpose — a keyboard, a screen reader
 * and a phone already know how to drive it — and labelled, visibly or not, so
 * it is found by its name.
 */
export function SelectChip({
  label,
  value,
  onChange,
  options,
  anyLabel,
  showLabel = false,
  className,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  /** The "no filter" choice, when there is one. */
  anyLabel?: string;
  /** Print the label before the control rather than only announcing it. */
  showLabel?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn('inline-flex min-w-0 max-w-full items-center gap-2', className)}>
      <span
        className={cn(
          showLabel
            ? 'text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80'
            : 'sr-only',
        )}
      >
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 min-w-0 max-w-full rounded-full border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      >
        {anyLabel !== undefined && <option value="">{anyLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
