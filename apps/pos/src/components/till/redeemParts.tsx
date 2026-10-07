import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, type LucideIcon } from 'lucide-react';

/**
 * THE PIECES OF THE REDEEM DIALOG THE KIOSK REUSES (S2-20 K2).
 *
 * `RedeemBookingModal` is the approved design for redeeming a booking made
 * online; the self-service kiosk is the same redemption on a second surface
 * (PROJECT_CONTEXT §7.6, "one implementation, two surfaces"), so its screens
 * are built from the dialog's own parts rather than a look-alike: the round
 * outcome head of the issued and already-redeemed panels, the guest-count
 * rows of the summary card, the amber drop-off note and the band-code line.
 *
 * `size="dialog"` is the dialog exactly as it was — the same elements and the
 * same classes, moved here unchanged. `size="kiosk"` is the same shape at the
 * scale of a guest-facing touch screen, in the customer display's type sizes.
 */

export type RedeemPartSize = 'dialog' | 'kiosk';
export type RedeemTone = 'ok' | 'warn';

const HEAD = {
  dialog: {
    wrap: 'flex flex-col items-center text-center gap-3 py-4',
    circle: {
      ok: 'w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center',
      warn: 'w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center',
    },
    icon: { ok: 'w-8 h-8 text-primary', warn: 'w-8 h-8 text-amber-500' },
    title: 'font-semibold text-lg',
    reference: 'font-mono text-muted-foreground mt-0.5',
  },
  kiosk: {
    wrap: 'flex flex-col items-center text-center gap-6 py-6',
    circle: {
      ok: 'w-28 h-28 rounded-full bg-primary/15 flex items-center justify-center',
      warn: 'w-28 h-28 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center',
    },
    icon: { ok: 'w-14 h-14 text-primary', warn: 'w-14 h-14 text-amber-500' },
    title: 'text-5xl font-black tracking-tight',
    reference: 'font-mono text-2xl text-foreground/50 mt-3',
  },
} as const;

/** The round head of a redemption's ending: an icon in a circle, a title, the booking's reference. */
export function RedeemOutcomeHeader({
  tone,
  title,
  reference,
  icon,
  size = 'dialog',
  children,
}: {
  tone: RedeemTone;
  title: ReactNode;
  reference?: string | null;
  /** The dialog's own icons unless a screen needs another. */
  icon?: LucideIcon;
  size?: RedeemPartSize;
  /** Lines under the reference (the dialog's receipt number). */
  children?: ReactNode;
}) {
  const s = HEAD[size];
  const Icon = icon ?? (tone === 'ok' ? CheckCircle2 : AlertTriangle);
  return (
    <div className={s.wrap}>
      <div className={s.circle[tone]}>
        <Icon className={s.icon[tone]} />
      </div>
      <div>
        <p className={s.title}>{title}</p>
        {reference ? <p className={s.reference}>{reference}</p> : null}
        {children}
      </div>
    </div>
  );
}

const ROW = {
  dialog: { row: 'flex items-center gap-2 text-muted-foreground', wide: 'col-span-2', icon: 'w-4 h-4 shrink-0' },
  kiosk: { row: 'flex items-center gap-3 text-foreground/70 text-2xl', wide: 'col-span-2', icon: 'w-7 h-7 shrink-0' },
} as const;

/** One row of the summary card's guest counts: an icon and a sentence. */
export function RedeemCountRow({
  icon: Icon,
  wide = false,
  size = 'dialog',
  children,
}: {
  icon: LucideIcon;
  /** Spans both columns, as the drop-off and event-pass rows do. */
  wide?: boolean;
  size?: RedeemPartSize;
  children: ReactNode;
}) {
  const s = ROW[size];
  return (
    <div className={wide ? `${s.row} ${s.wide}` : s.row}>
      <Icon className={s.icon} />
      <span>{children}</span>
    </div>
  );
}

const CALLOUT = {
  dialog: {
    amber:
      'flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2',
    violet:
      'flex items-start gap-2 text-xs text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 rounded-lg px-3 py-2',
    icon: 'w-3.5 h-3.5 mt-0.5 shrink-0',
  },
  kiosk: {
    amber:
      'flex items-start gap-3 text-xl text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-2xl px-6 py-4 text-left',
    violet:
      'flex items-start gap-3 text-xl text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 rounded-2xl px-6 py-4 text-left',
    icon: 'w-7 h-7 mt-0.5 shrink-0',
  },
} as const;

/** The dialog's coloured notes: amber for drop-off children, violet for event passes. */
export function RedeemCallout({
  tone,
  icon: Icon,
  size = 'dialog',
  children,
}: {
  tone: 'amber' | 'violet';
  icon: LucideIcon;
  size?: RedeemPartSize;
  children: ReactNode;
}) {
  const s = CALLOUT[size];
  return (
    <div className={s[tone]}>
      <Icon className={s.icon} />
      <span>{children}</span>
    </div>
  );
}

const CODES = {
  dialog: {
    wrap: 'flex flex-wrap gap-x-3 gap-y-0.5',
    code: 'font-mono font-semibold text-foreground',
    label: 'text-muted-foreground',
  },
  kiosk: {
    wrap: 'flex flex-wrap justify-center gap-x-5 gap-y-1 text-xl',
    code: 'font-mono font-semibold text-foreground',
    label: 'text-foreground/50',
  },
} as const;

/** The short codes printed under each band's QR, for reading aloud should one not print. */
export function RedeemBandCodes({
  bands,
  noCode,
  size = 'dialog',
}: {
  bands: ReadonlyArray<{ key: string; shortCode: string | null; label?: string | null }>;
  /** What a band with no short code reads as. */
  noCode: string;
  size?: RedeemPartSize;
}) {
  const s = CODES[size];
  return (
    <div className={s.wrap} data-testid="band-codes">
      {bands.map((band) => (
        <span key={band.key} className="whitespace-nowrap">
          <span className={s.code}>{band.shortCode ?? noCode}</span>
          {band.label && <span className={s.label}> {band.label}</span>}
        </span>
      ))}
    </div>
  );
}
