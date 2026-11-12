import { TxnSummary } from '@/types';
import type { BadgeStatus } from '@/api/history';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/history/StatusBadge';
import { Ticket, GlassWater, Baby, ShoppingBag, ChevronRight, Clock, User as UserIcon, QrCode, MapPin } from 'lucide-react';
import { bahtText } from '@/lib/bahtText';

/**
 * `timeZone` is the BRANCH's, when the caller knows it (SCRUM-238). A sale is a
 * fact about a counter in Phuket, so "23 Sep, 03:05" has to be the time the park
 * rang it up — not the time on the reader's own laptop, which is what this did
 * when the ledger's UTC instants started arriving.
 */
const fmtTime = (iso: string, timeZone?: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });

const TYPE_LABEL: Record<'ticket' | 'fnb' | 'merch' | 'dropoff', string> = {
  ticket: 'Ticket',
  fnb: 'F&B',
  merch: 'Merch',
  dropoff: 'Drop-off',
};

/**
 * One transaction row, shared by the Order History list and the scan-bracelet
 * client activity view so both stay visually identical. A drop-off/nanny sale
 * (`isDropOff`) gets the baby icon + tint instead of the ticket icon. `showType`
 * surfaces an explicit type label — useful in the client view where order types
 * are interleaved (the main list separates them with tabs, so it stays off there).
 */
export function TransactionCard({
  txn,
  onClick,
  showType = false,
  badge,
  timeZone,
}: {
  /** `balanceDue` (SCRUM-902): a part-paid sale's balance, in baht, shown over its total. */
  txn: TxnSummary & { balanceDue?: number };
  onClick: () => void;
  showType?: boolean;
  /** The ledger's own state where it is wider than `txn.status` (SCRUM-238). */
  badge?: BadgeStatus;
  /** The branch's timezone, so the time reads as the counter's. */
  timeZone?: string;
}) {
  const kind = txn.isDropOff ? 'dropoff' : txn.kind;
  return (
    <button type="button" onClick={onClick} className="w-full text-left">
      <Card className="@container p-4 flex items-center gap-4 bg-card/50 hover:bg-card transition-colors">
        <div
          className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
            kind === 'ticket'
              ? 'bg-primary/15 text-primary'
              : kind === 'dropoff'
                ? 'bg-violet-500/15 text-violet-400'
                : kind === 'merch'
                  ? 'bg-rose-500/15 text-rose-400'
                  : 'bg-sky-500/15 text-sky-400'
          }`}
        >
          {kind === 'ticket' ? (
            <Ticket className="w-6 h-6" />
          ) : kind === 'dropoff' ? (
            <Baby className="w-6 h-6" />
          ) : kind === 'merch' ? (
            <ShoppingBag className="w-6 h-6" />
          ) : (
            <GlassWater className="w-6 h-6" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-bold">
            <span>{txn.reference}</span>
            {showType && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {TYPE_LABEL[kind]}
              </span>
            )}
            {txn.customerLabel && (
              <span className="text-muted-foreground font-normal truncate">
                · {txn.customerLabel}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap mt-0.5">
            <span className="flex items-center gap-1 whitespace-nowrap">
              <Clock className="w-3 h-3" />
              {fmtTime(txn.createdAt, timeZone)}
            </span>
            <span className="flex items-center gap-1">
              <UserIcon className="w-3 h-3" />
              {txn.operatorName}
            </span>
            {txn.branchName && (
              <span className="flex items-center gap-1 text-amber-500 font-medium">
                <MapPin className="w-3 h-3" />
                {txn.branchName}
              </span>
            )}
            {txn.bookingReference && (
              <span className="flex items-center gap-1 text-primary font-medium">
                <QrCode className="w-3 h-3" />
                {txn.bookingReference}
              </span>
            )}
          </div>
        </div>
        {/* SCRUM-917 — on a narrow card (the phone) the badge sits over the
            figure, so the title column keeps room to read; from @md (the
            counter's list) the row is as it always was. */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex flex-col items-end gap-1 @md:flex-row @md:items-center @md:gap-3">
            <StatusBadge status={badge ?? txn.status} />
            {txn.balanceDue !== undefined ? (
              // SCRUM-902 — a part-paid sale names its balance, as its detail
              // does, with the sale's total under it.
              <span className="w-20 text-right" data-testid="card-balance-due">
                <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Balance due</span>
                <span className="block text-lg font-bold tabular-nums">฿{bahtText(txn.balanceDue)}</span>
                <span className="block text-xs text-muted-foreground tabular-nums">of ฿{bahtText(txn.total)}</span>
              </span>
            ) : (
              <span className="text-lg font-bold tabular-nums w-20 text-right">฿{bahtText(txn.total)}</span>
            )}
          </div>
          <ChevronRight className="w-5 h-5 text-muted-foreground" />
        </div>
      </Card>
    </button>
  );
}
