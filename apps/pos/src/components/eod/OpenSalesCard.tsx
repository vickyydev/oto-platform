import { carriedFromLabel, partPaidCloseRefusal, type EodOpenSales } from '@oto/shared';
import { Card } from '@/components/ui/card';
import { Flag, Hourglass } from 'lucide-react';
import { bahtLabel } from '@/lib/heldSales';

/**
 * SCRUM-774 — UI ADDITION. The day's held and part-paid sales, on the End of
 * Day (the cash-up tab), in the provisional banner's amber: the two counts
 * always, and each sale with what was paid and the balance — a sale still in
 * Held sales from an earlier day with the day it was parked. A part-paid sale
 * refuses Close Day until it is resolved — the sentence that says so, and the
 * way out for where each sale is, is the platform's own
 * (`partPaidCloseRefusal`), shown here before the press and returned by the
 * platform if it is pressed anyway.
 * A held sale with nothing paid does not stand in the way: it is cancelled as
 * not collected at midnight.
 */
export function OpenSalesCard({ openSales }: { openSales: EodOpenSales | undefined }) {
  if (!openSales) return null;
  const refusal = partPaidCloseRefusal(openSales.rows);
  return (
    <Card
      role="status"
      data-testid="eod-open-sales"
      className={
        refusal
          ? 'p-4 border border-amber-500/40 bg-amber-500/10'
          : 'p-4 border border-border bg-card/50'
      }
    >
      <div className="flex items-start gap-3">
        <Hourglass className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="text-sm min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-semibold">Held sales</span>
            <span data-testid="eod-held-count">
              Held: <span className="font-semibold tabular-nums">{openSales.held}</span>
            </span>
            <span data-testid="eod-part-paid-count">
              Partly paid: <span className="font-semibold tabular-nums">{openSales.partPaid}</span>
            </span>
          </div>
          {openSales.rows.length === 0 ? (
            <p className="text-muted-foreground">Nothing is held or partly paid on this day.</p>
          ) : (
            <ul className="text-muted-foreground space-y-0.5">
              {openSales.rows.map((r) => (
                <li key={r.saleId}>
                  <span className="text-foreground font-medium">{r.label}</span>
                  {' · '}
                  {r.kind === 'part_paid'
                    ? `${bahtLabel(r.paidSatang)} paid, balance ${bahtLabel(r.balanceSatang)}`
                    : `${bahtLabel(r.balanceSatang)} to pay, nothing paid`}
                  {' · '}
                  {r.held
                    ? `in Held sales${r.carriedFrom ? ` since ${carriedFromLabel(r.carriedFrom)}` : ''}`
                    : `open on ${r.stationName ?? 'a till'}`}
                  {r.flaggedAt && (
                    <span className="ml-2 inline-flex items-center gap-1 text-rose-600 dark:text-rose-300">
                      <Flag className="w-3 h-3" /> flagged for the manager
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {refusal && (
            <p role="alert" className="font-medium text-amber-700 dark:text-amber-300" data-testid="eod-part-paid-refusal">
              {refusal}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
