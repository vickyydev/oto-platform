import { useMemo, useState, type ReactNode } from 'react';
import { TxnSummary } from '@/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TransactionCard } from '@/components/history/TransactionCard';
import { ScanLine } from 'lucide-react';

export type ActivityFilter = 'all' | 'ticket' | 'fnb' | 'dropoff';

const FILTERS: { key: ActivityFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ticket', label: 'Tickets' },
  { key: 'fnb', label: 'F&B' },
  { key: 'dropoff', label: 'Drop-off' },
];

const txnFilterKind = (t: TxnSummary): ActivityFilter =>
  t.isDropOff ? 'dropoff' : t.kind === 'ticket' ? 'ticket' : 'fnb';

/**
 * Shared body for the per-client (scan-bracelet) and per-member (phone lookup)
 * activity views: an order-type filter, the order count, and every transaction
 * as its own card (newest first). Each caller supplies its own header above this
 * and the empty-state copy for when the subject has no orders at all.
 */
export function ActivityList({
  transactions,
  orderCount,
  onOpenTxn,
  emptyTitle,
  emptyBody,
}: {
  transactions: TxnSummary[];
  orderCount: number;
  onOpenTxn: (txn: TxnSummary) => void;
  emptyTitle: string;
  emptyBody: ReactNode;
}) {
  const [filter, setFilter] = useState<ActivityFilter>('all');

  const filtered = useMemo(
    () =>
      filter === 'all'
        ? transactions
        : transactions.filter((t) => txnFilterKind(t) === filter),
    [transactions, filter],
  );

  if (orderCount === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground gap-3">
        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
          <ScanLine className="w-8 h-8" />
        </div>
        <div className="text-lg font-semibold text-foreground">{emptyTitle}</div>
        <p className="max-w-sm">{emptyBody}</p>
      </div>
    );
  }

  return (
    <>
      <div className="shrink-0 mb-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-md px-4 h-9 text-sm font-semibold transition-colors ${
                filter === f.key
                  ? 'bg-background text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-sm text-muted-foreground">
          {orderCount} {orderCount === 1 ? 'order' : 'orders'}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          No orders of this type.
        </div>
      ) : (
        <ScrollArea className="flex-1 -mx-1 px-1">
          <div className="space-y-2">
            {filtered.map((t) => (
              <TransactionCard
                key={`${t.kind}-${t.id}`}
                txn={t}
                showType
                onClick={() => onOpenTxn(t)}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </>
  );
}
