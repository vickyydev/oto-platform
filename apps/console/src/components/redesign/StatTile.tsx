import type { ReactNode } from 'react';
import { Check, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusMark, type Tone } from '@/components/Status';
import { spanClass, type Span } from './layout';
import { TONE_INK } from './chips';
import { cn } from '@/lib/utils';

/**
 * One reading, large: a label in small capitals, the number, and the line that
 * says what the number means. When the number carries a state its ink comes
 * with its shape, never alone.
 *
 * `inset` is the tile drawn INSIDE a card (the artboards' "Today at the tills"
 * quartet and the rails' totals), a faint wash instead of a card of its own.
 */
export function StatTile({
  label,
  value,
  detail,
  tone,
  span,
  inset = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  span?: Span;
  inset?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'min-w-0 flex flex-col gap-1.5',
        inset
          ? 'rounded-[14px] bg-foreground/[0.025] px-4 py-3.5'
          : 'rounded-[20px] border border-card-border bg-card px-[22px] pt-5 pb-[18px]',
        span && spanClass(span),
        className,
      )}
    >
      <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'inline-flex items-center gap-2 font-extrabold tracking-[-0.02em] tabular-nums',
          inset ? 'text-[26px]' : 'text-[34px]',
          tone && TONE_INK[tone],
        )}
      >
        {tone && <StatusMark tone={tone} className="w-3.5 h-3.5" />}
        {value}
      </span>
      {detail && <span className="text-[12.5px] text-muted-foreground">{detail}</span>}
    </div>
  );
}

/**
 * Nothing to show, said as what happens next — the Health artboard's "Nothing
 * needs you right now". One sentence, one line of why, at most one button.
 *
 * ONLY for a list that was read and came back empty. `good` is an all-clear,
 * and an all-clear is a claim about the park: before the first answer, or
 * after a read that failed, the slot takes `Loading` or `UnreadNote` instead.
 */
export function EmptyNote({
  title,
  detail,
  action,
  good = false,
  icon: Icon,
  className,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  /** The empty list is the good outcome: the green tick on its wash. */
  good?: boolean;
  icon?: LucideIcon;
  className?: string;
}) {
  const Mark = good ? Check : Icon;
  return (
    <div
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-3 px-2 py-6 text-center',
        className,
      )}
    >
      {Mark && (
        <span
          className={cn(
            'flex h-16 w-16 items-center justify-center rounded-full',
            good ? 'bg-status-ok/12 text-status-ok' : 'bg-muted text-muted-foreground',
          )}
          aria-hidden="true"
        >
          <Mark className="w-[30px] h-[30px]" strokeWidth={good ? 2.6 : 2} />
        </span>
      )}
      <p className="text-[15px] font-bold">{title}</p>
      {detail && (
        <p className="max-w-[300px] text-[12.5px] leading-normal text-muted-foreground">{detail}</p>
      )}
      {action}
    </div>
  );
}

/**
 * A read that failed, in the place an `EmptyNote` would otherwise stand — the
 * redesign's `Unreadable` (components/Panel.tsx), and under the same rule: a
 * list that could not be read must never look like an empty one. The warn ink
 * comes with its triangle, never a tick.
 *
 * `message` and `onRetry` are for a slot with nothing else on the page saying
 * what went wrong; where the page's own error note already carries both, the
 * slot names the gap and leaves the button to the note — one button, not two.
 */
export function UnreadNote({
  what,
  message,
  onRetry,
  className,
}: {
  /** The list, as the reader thinks of it: "The failure list". */
  what: string;
  message?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  const reason = message?.trim().replace(/\.+$/, '');
  return (
    <div
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-3 px-2 py-6 text-center',
        className,
      )}
    >
      <span
        className="flex h-16 w-16 items-center justify-center rounded-full bg-status-warn/12 text-status-warn"
        aria-hidden="true"
      >
        <TriangleAlert className="w-[28px] h-[28px]" />
      </span>
      <p className="text-[15px] font-bold">{what} could not be read</p>
      <p className="max-w-[300px] text-[12.5px] leading-normal text-muted-foreground break-words">
        {reason ? `${reason}. ` : ''}That is a request that did not answer, not an all-clear.
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" className="rounded-full px-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
