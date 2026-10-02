import { Card } from '@/components/ui/card';
import { Banknote } from 'lucide-react';
import { CASH_DEFAULT_TOLERANCE_SATANG, cashFlagOf, formatTHB } from '@oto/shared';
import { AmountInput } from './AmountInput';
import { cn } from '@/lib/utils';

/**
 * Cash is reconciled by a physical drawer count: staff enter the counted cash, and
 * the card derives cash income (counted − float) and flags it against the POS's
 * expected cash take. The start-of-day float is NOT typed here — it's carried over
 * from the cash left in the drawer at the previous close (read-only).
 *
 * S2-15a round 1 — on the platform the count is ONE DRAWER's (OD-CS1), every
 * figure is satang under the hood and baht on screen, and the expected take is
 * the drawer session's own, read from the ledger: cash taken at this counter,
 * less cash handed back, paid out and dropped, plus top-ups. The tolerance is
 * the branch's (the prototype's ฿1 by default).
 */
export function CashCountCard({
  countedSatang,
  floatSatang,
  expectedCashSatang,
  toleranceSatang = CASH_DEFAULT_TOLERANCE_SATANG,
  floatSourceLabel,
  drawerLabel = 'whole branch drawer',
  readOnly,
  onCounted,
  compact = false,
}: {
  countedSatang: number | null;
  /** The float the drawer started with. */
  floatSatang: number;
  /** What the drawer should have taken in, net: expected cash in the drawer less the float. */
  expectedCashSatang: number;
  toleranceSatang?: number;
  /** Provenance of the start-of-day float, e.g. "carried from 2026-06-14 close". */
  floatSourceLabel: string;
  /** Whose drawer this is, after the "Cash count ·". */
  drawerLabel?: string;
  readOnly: boolean;
  onCounted: (v: number | null) => void;
  /** The portrait phone's tighter layout (MobileEndOfDayTab), same figures. */
  compact?: boolean;
}) {
  const income = countedSatang === null ? null : countedSatang - floatSatang;
  const diff = income === null ? null : income - expectedCashSatang;
  const flag = cashFlagOf(diff, toleranceSatang);
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${formatTHB(Math.abs(v))}`;
  const plain = (v: number) => `${v < 0 ? '-' : ''}${formatTHB(Math.abs(v))}`;

  return (
    <Card className={cn('bg-card/50', compact ? 'p-4' : 'p-5')}>
      <div className={cn('flex items-center gap-2 text-sm font-medium text-muted-foreground', compact ? 'mb-3' : 'mb-4')}>
        <Banknote className="w-4 h-4 text-primary" />
        Cash count
        <span className="font-normal">· {drawerLabel}</span>
      </div>

      <div className={cn('grid grid-cols-2', compact ? 'gap-3' : 'gap-4')}>
        <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          Counted cash
          <AmountInput
            ariaLabel="Counted cash"
            satang
            value={countedSatang}
            disabled={readOnly}
            onChange={onCounted}
          />
        </label>
        <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          {compact ? 'Float (start)' : 'Float (start of day)'}
          <div
            className="h-11 rounded-xl bg-muted/30 border border-border/60 px-4 flex items-center justify-end text-base text-foreground tabular-nums"
            aria-label="Start-of-day float (carried over)"
          >
            {formatTHB(floatSatang)}
          </div>
          <span className="text-xs text-muted-foreground">{floatSourceLabel}</span>
        </div>
      </div>

      <div className={cn('grid grid-cols-3', compact ? 'mt-3 gap-2 text-xs' : 'mt-4 gap-3 text-sm')}>
        <div className={cn('rounded-xl bg-muted/50', compact ? 'px-3 py-2' : 'px-4 py-3')}>
          <div className="text-muted-foreground">{compact ? 'Income' : 'Cash income'}</div>
          <div className={cn('font-bold tabular-nums', compact ? 'text-base' : 'text-lg')}>
            {income === null ? '—' : plain(income)}
          </div>
          <div className={cn('text-muted-foreground', compact ? 'text-[10px]' : 'text-xs')}>counted − float</div>
        </div>
        <div className={cn('rounded-xl bg-muted/50', compact ? 'px-3 py-2' : 'px-4 py-3')}>
          <div className="text-muted-foreground">{compact ? 'Expected' : 'Expected cash'}</div>
          <div className={cn('font-bold tabular-nums', compact ? 'text-base' : 'text-lg')}>
            {plain(expectedCashSatang)}
          </div>
          <div className={cn('text-muted-foreground', compact ? 'text-[10px]' : 'text-xs')}>from POS</div>
        </div>
        <div className={cn('rounded-xl bg-muted/50', compact ? 'px-3 py-2' : 'px-4 py-3')}>
          <div className="text-muted-foreground">{compact ? 'Diff' : 'Difference'}</div>
          <div
            className={cn(
              'font-bold tabular-nums',
              compact ? 'text-base' : 'text-lg',
              flag === 'ok' && 'text-emerald-400',
              flag === 'off' && 'text-rose-400',
              flag === 'pending' && 'text-muted-foreground',
            )}
          >
            {diff === null ? '—' : signed(diff)}
          </div>
          <div className={cn('text-muted-foreground', compact ? 'text-[10px]' : 'text-xs')}>
            {flag === 'ok' ? 'balanced' : flag === 'off' ? (compact ? 'over/short' : 'over / short') : compact ? '—' : 'awaiting count'}
          </div>
        </div>
      </div>
    </Card>
  );
}
