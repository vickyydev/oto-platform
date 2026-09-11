import { TxnSummary } from '@/types';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/history/StatusBadge';
import { Ticket, GlassWater, Baby, ShoppingBag, ChevronRight, Clock, User as UserIcon, QrCode, MapPin } from 'lucide-react';

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
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
}: {
  txn: TxnSummary;
  onClick: () => void;
  showType?: boolean;
}) {
  const kind = txn.isDropOff ? 'dropoff' : txn.kind;
  return (
    <button type="button" onClick={onClick} className="w-full text-left">
      <Card className="p-4 flex items-center gap-4 bg-card/50 hover:bg-card transition-colors">
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
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {fmtTime(txn.createdAt)}
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
        <div className="flex items-center gap-3 shrink-0">
          <StatusBadge status={txn.status} />
          <span className="text-lg font-bold tabular-nums w-20 text-right">฿{txn.total}</span>
          <ChevronRight className="w-5 h-5 text-muted-foreground" />
        </div>
      </Card>
    </button>
  );
}
