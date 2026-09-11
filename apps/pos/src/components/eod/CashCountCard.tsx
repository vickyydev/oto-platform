import { Card } from '@/components/ui/card';
import { Banknote } from 'lucide-react';
import { AmountInput } from './AmountInput';
import { RECON_TOLERANCE_THB } from '@/lib/endOfDay';
import { cn } from '@/lib/utils';
import { EndOfDay } from '@/types';

/**
 * Cash is reconciled by a physical drawer count for the whole branch: staff enter the
 * counted cash, and the card derives cash income (counted − float) and flags it against
 * the POS's expected cash take. The start-of-day float is NOT typed here — it's carried
 * over from the cash left in the drawer at the previous night's close (read-only).
 */
export function CashCountCard({
  cashCount,
  expectedCashTHB,
  floatSourceLabel,
  readOnly,
  onCounted,
}: {
  cashCount: EndOfDay['cashCount'];
  expectedCashTHB: number;
  /** Provenance of the start-of-day float, e.g. "carried from 2026-06-14 close". */
  floatSourceLabel: string;
  readOnly: boolean;
  onCounted: (v: number | null) => void;
}) {
  const income = cashCount.cashIncomeTHB;
  const diff = income === null ? null : income - expectedCashTHB;
  const flag = diff === null ? 'pending' : Math.abs(diff) <= RECON_TOLERANCE_THB ? 'ok' : 'off';

  return (
    <Card className="p-5 bg-card/50">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-4">
        <Banknote className="w-4 h-4 text-primary" />
        Cash count
        <span className="font-normal">· whole branch drawer</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          Counted cash
          <AmountInput
            ariaLabel="Counted cash"
            value={cashCount.countedTHB}
            disabled={readOnly}
            onChange={onCounted}
          />
        </label>
        <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          Float (start of day)
          <div
            className="h-11 rounded-xl bg-muted/30 border border-border/60 px-4 flex items-center justify-end text-base text-foreground tabular-nums"
            aria-label="Start-of-day float (carried over)"
          >
            ฿{(cashCount.floatTHB ?? 0).toLocaleString()}
          </div>
          <span className="text-xs text-muted-foreground">{floatSourceLabel}</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-xl bg-muted/50 px-4 py-3">
          <div className="text-muted-foreground">Cash income</div>
          <div className="text-lg font-bold tabular-nums">
            {income === null ? '—' : `฿${income.toLocaleString()}`}
          </div>
          <div className="text-xs text-muted-foreground">counted − float</div>
        </div>
        <div className="rounded-xl bg-muted/50 px-4 py-3">
          <div className="text-muted-foreground">Expected cash</div>
          <div className="text-lg font-bold tabular-nums">฿{expectedCashTHB.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground">from POS</div>
        </div>
        <div className="rounded-xl bg-muted/50 px-4 py-3">
          <div className="text-muted-foreground">Difference</div>
          <div
            className={cn(
              'text-lg font-bold tabular-nums',
              flag === 'ok' && 'text-emerald-400',
              flag === 'off' && 'text-rose-400',
              flag === 'pending' && 'text-muted-foreground',
            )}
          >
            {diff === null
              ? '—'
              : `${diff > 0 ? '+' : diff < 0 ? '-' : ''}฿${Math.abs(diff).toLocaleString()}`}
          </div>
          <div className="text-xs text-muted-foreground">
            {flag === 'ok' ? 'balanced' : flag === 'off' ? 'over / short' : 'awaiting count'}
          </div>
        </div>
      </div>
    </Card>
  );
}
