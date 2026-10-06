import type { ElementType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The sheet every redesigned page is laid on (SCRUM-474): twelve columns with a
 * 20 px gutter, the artboards' `grid-template-columns: repeat(12, …); gap: 20px`.
 *
 * The columns answer to the width of the PAGE, not of the window — container
 * queries against the content column the console layout marks `@container` —
 * because a 1280 px window with the sidebar open leaves the page 1016 px and a
 * 1024 px one leaves it 760. Below 42rem of page everything is one column;
 * from there to 56rem it is six, where a quarter-width tile takes half; and
 * from 56rem up it is the twelve the artboards were drawn on.
 */
export function PageGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-5 @2xl:grid-cols-6 @4xl:grid-cols-12 items-stretch',
        className,
      )}
    >
      {children}
    </div>
  );
}

export type Span = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12;

/**
 * Written out literally so the build sees every class. At six columns a
 * quarter or a third takes half the row; anything wider takes the whole row.
 */
const SPAN: Record<Span, string> = {
  3: '@2xl:col-span-3 @4xl:col-span-3',
  4: '@2xl:col-span-3 @4xl:col-span-4',
  5: '@2xl:col-span-6 @4xl:col-span-5',
  6: '@2xl:col-span-6 @4xl:col-span-6',
  7: '@2xl:col-span-6 @4xl:col-span-7',
  8: '@2xl:col-span-6 @4xl:col-span-8',
  9: '@2xl:col-span-6 @4xl:col-span-9',
  12: '@2xl:col-span-6 @4xl:col-span-12',
};

export function spanClass(span: Span | undefined): string {
  return span ? SPAN[span] : '@2xl:col-span-6 @4xl:col-span-12';
}

/** A column of stacked cards inside the grid — the artboards' right-hand rails. */
export function Rail({
  span,
  children,
  className,
}: {
  span: Span;
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('min-w-0 flex flex-col gap-5', spanClass(span), className)}>{children}</div>;
}

/**
 * The card: card-white, one hairline, the uniform 20 px radius and 22–24 px of
 * padding. A `<section>` with an `<h2>`, because that is how a reader — and the
 * end-to-end set — finds "the Boxes panel" on a page.
 */
export function CardShell({
  title,
  icon: Icon,
  badge,
  note,
  actions,
  footer,
  children,
  span,
  className,
  bodyClassName,
  as: As = 'section',
  id,
}: {
  title?: string;
  icon?: LucideIcon;
  /** Beside the title: a count, a state. */
  badge?: ReactNode;
  /** The small grey line after the title: what the card covers. */
  note?: ReactNode;
  /** Controls aligned right on the title row. */
  actions?: ReactNode;
  /** The ruled foot, pinned to the bottom when the card is stretched. */
  footer?: ReactNode;
  children?: ReactNode;
  span?: Span;
  className?: string;
  bodyClassName?: string;
  as?: ElementType;
  id?: string;
}) {
  const hasHead = Boolean(title || actions || badge);
  return (
    <As
      id={id}
      className={cn(
        // A container of its own, so what is inside it lays itself out by the
        // card's width rather than the page's: a seven-column card and a
        // full-width one hold the same rows differently.
        '@container min-w-0 rounded-[20px] border border-card-border bg-card p-5 @4xl:p-6 flex flex-col gap-3',
        spanClass(span),
        className,
      )}
    >
      {hasHead && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-[240px] flex-wrap items-center gap-x-2.5 gap-y-1">
            {Icon && <Icon className="w-[18px] h-[18px] shrink-0 text-primary" aria-hidden="true" />}
            {title && <h2 className="m-0 text-[16.5px] font-bold leading-snug">{title}</h2>}
            {badge}
            {note && <span className="text-[12.5px] text-muted-foreground min-w-0">{note}</span>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children !== undefined && <div className={cn('flex min-w-0 flex-col gap-3', bodyClassName)}>{children}</div>}
      {footer && <CardFoot>{footer}</CardFoot>}
    </As>
  );
}

/** The ruled line at the bottom of a card, and whatever sits on it. */
export function CardFoot({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-card-border pt-3 text-[12.5px] text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A group of equal cards that are each a thing — boxes, stations, parks. A
 * `<section>` with its heading and controls on a plain row, and the cards on
 * the page's own grid below it, which is how the Devices artboard draws them.
 */
export function CardGroup({
  title,
  icon: Icon,
  note,
  actions,
  children,
  className,
}: {
  title: string;
  icon?: LucideIcon;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('min-w-0 flex flex-col gap-3', spanClass(12), className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1">
        <div className="flex min-w-0 flex-1 basis-[240px] flex-wrap items-center gap-x-2.5 gap-y-1">
          {Icon && <Icon className="w-[18px] h-[18px] shrink-0 text-primary" aria-hidden="true" />}
          <h2 className="m-0 text-[16.5px] font-bold">{title}</h2>
          {note && <span className="text-[12.5px] text-muted-foreground min-w-0">{note}</span>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** The dashed slot: where the next one goes, said as an action. */
export function DashedSlot({
  title,
  detail,
  action,
  icon: Icon,
  className,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-[20px] border-[1.5px] border-dashed border-foreground/20 p-[22px] flex flex-col items-center justify-center gap-2.5 text-center',
        className,
      )}
    >
      {Icon && (
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="w-[18px] h-[18px]" aria-hidden="true" />
        </span>
      )}
      <p className="text-sm font-bold text-muted-foreground">{title}</p>
      {detail && <p className="max-w-[260px] text-[12.5px] leading-normal text-muted-foreground/80">{detail}</p>}
      {action}
    </div>
  );
}

/**
 * Rows on a card, every other one on a faint wash — the artboards' tables.
 * The wash is the foreground at 2.5%, so it darkens on cream and lightens on
 * the dark theme's slate without a colour of its own.
 */
export function StripedList({
  children,
  className,
  as: As = 'ul',
  label,
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
  label?: string;
}) {
  return (
    <As
      aria-label={label}
      className={cn(
        'flex min-w-0 flex-col [&>*]:rounded-[12px] [&>*:nth-child(odd)]:bg-foreground/[0.025]',
        className,
      )}
    >
      {children}
    </As>
  );
}

/** A label on the left, its value on the right: the cards' fact lines. */
export function FactLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-3 py-2 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-semibold break-words text-right">{children}</dd>
    </div>
  );
}

export function FactList({ children }: { children: ReactNode }) {
  return (
    <dl className="flex min-w-0 flex-col [&>*]:rounded-[12px] [&>*:nth-child(odd)]:bg-foreground/[0.025]">
      {children}
    </dl>
  );
}

/** The quiet sentence at the foot of a rail card. */
export function RailNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-xs leading-normal text-muted-foreground/80', className)}>{children}</p>;
}

/** A small-capitals label over a stack — the rails' "SEARCH", "OPEN RIGHT NOW". */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80',
        className,
      )}
    >
      {children}
    </span>
  );
}
