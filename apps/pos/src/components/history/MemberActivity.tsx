import { MemberActivity as MemberActivityData, TxnSummary } from '@/types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ActivityList } from '@/components/history/ActivityList';
import { ArrowLeft, UserRound, Phone, Receipt, Ticket, MapPin } from 'lucide-react';

/**
 * Phone-lookup result: everything for one member gathered by their phone number —
 * a header (member nickname + phone, linked band count, total spent) and every
 * transaction across their bands as its own card (via the shared ActivityList).
 * When no member matches the phone, shows a dedicated "not found" empty state.
 */
export function MemberActivity({
  activity,
  onOpenTxn,
  onBack,
}: {
  activity: MemberActivityData;
  onOpenTxn: (txn: TxnSummary) => void;
  onBack: () => void;
}) {
  const { member, phone, bandCodes, transactions, totalSpent, orderCount, branchVisits } = activity;

  const back = (
    <div className="shrink-0 mb-4">
      <Button variant="ghost" size="sm" className="gap-2 -ml-2" onClick={onBack}>
        <ArrowLeft className="w-4 h-4" />
        Back to all transactions
      </Button>
    </div>
  );

  if (!member) {
    return (
      <div className="h-full flex flex-col min-h-0 animate-in fade-in duration-300">
        {back}
        <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground gap-3">
          <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
            <Phone className="w-8 h-8" />
          </div>
          <div className="text-lg font-semibold text-foreground">No member found</div>
          <p className="max-w-sm">
            No member matches the phone number{' '}
            <span className="font-mono">{phone || '—'}</span>. Check the number, or this
            customer may not be a member yet.
          </p>
        </div>
      </div>
    );
  }

  const bandLabel =
    bandCodes.length === 0
      ? 'No bands'
      : bandCodes.map((c) => `#${c}`).join(', ');

  return (
    <div className="h-full flex flex-col min-h-0 animate-in fade-in duration-300">
      {back}

      {/* Member header */}
      <Card className="shrink-0 p-5 mb-4 bg-card/50">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="w-14 h-14 rounded-2xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <UserRound className="w-7 h-7" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-2xl font-bold leading-tight truncate">{member.nickname}</div>
            <div className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted-foreground font-mono">
              <Phone className="w-4 h-4" />
              {member.phone}
            </div>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Ticket className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{bandLabel}</span>
            </div>
          </div>
          <div className="rounded-xl bg-muted/50 px-4 py-2 text-right shrink-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
              <Receipt className="w-3 h-3" />
              Total spent (all branches)
            </div>
            <div className="text-xl font-bold tabular-nums">฿{totalSpent}</div>
          </div>
        </div>

        {/* Per-branch visit summary */}
        {branchVisits.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/60 flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              <MapPin className="w-3.5 h-3.5" />
              Branches:
            </span>
            {branchVisits.map((bv) => (
              <span
                key={bv.branchId}
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20 px-2.5 py-0.5 text-xs font-semibold"
              >
                {bv.branchName}
                <span className="ml-0.5 opacity-70">{bv.count}×</span>
              </span>
            ))}
          </div>
        )}
      </Card>

      <ActivityList
        transactions={transactions}
        orderCount={orderCount}
        onOpenTxn={onOpenTxn}
        emptyTitle="No orders for this member"
        emptyBody={
          <>
            <span className="font-semibold text-foreground">{member.nickname}</span> has no
            tickets, F&amp;B, or drop-off charges yet.
          </>
        }
      />
    </div>
  );
}
