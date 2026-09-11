import { WristbandActivity } from '@/types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ActivityList } from '@/components/history/ActivityList';
import { ArrowLeft, UserRound, Wallet, BadgeCheck, Receipt } from 'lucide-react';
import type { TxnSummary } from '@/types';

/**
 * Scan-bracelet result: everything for one client gathered by their wristband —
 * a header (band holder + code, linked member, current F&B credit balance, total
 * spent + order count) and every transaction split out as its own card (via the
 * shared ActivityList). Tapping a card opens TransactionDetail through `onOpenTxn`.
 */
export function ClientActivity({
  code,
  activity,
  onOpenTxn,
  onBack,
}: {
  code: string;
  activity: WristbandActivity;
  onOpenTxn: (txn: TxnSummary) => void;
  onBack: () => void;
}) {
  const { wristband, member, transactions, totalSpent, orderCount } = activity;
  const holderName = wristband?.holderName ?? wristband?.customerNickname ?? 'Unknown band';

  return (
    <div className="h-full flex flex-col min-h-0 animate-in fade-in duration-300">
      {/* Back to the full transaction list */}
      <div className="shrink-0 mb-4">
        <Button variant="ghost" size="sm" className="gap-2 -ml-2" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
          Back to all transactions
        </Button>
      </div>

      {/* Client header */}
      <Card className="shrink-0 p-5 mb-4 bg-card/50">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="w-14 h-14 rounded-2xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <UserRound className="w-7 h-7" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-2xl font-bold leading-tight truncate">{holderName}</div>
            <div className="text-sm text-muted-foreground font-mono mt-0.5">#{code}</div>
            {member && (
              <div className="mt-1 inline-flex items-center gap-1 text-sm text-emerald-400">
                <BadgeCheck className="w-4 h-4" />
                Member · {member.nickname} · {member.phone}
              </div>
            )}
          </div>
          <div className="flex items-stretch gap-3 shrink-0">
            <div className="rounded-xl bg-muted/50 px-4 py-2 text-right">
              <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                <Wallet className="w-3 h-3" />
                Credit
              </div>
              <div className="text-xl font-bold tabular-nums text-primary">
                ฿{wristband?.creditBalanceTHB ?? 0}
              </div>
            </div>
            <div className="rounded-xl bg-muted/50 px-4 py-2 text-right">
              <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                <Receipt className="w-3 h-3" />
                Total spent
              </div>
              <div className="text-xl font-bold tabular-nums">฿{totalSpent}</div>
            </div>
          </div>
        </div>
      </Card>

      <ActivityList
        transactions={transactions}
        orderCount={orderCount}
        onOpenTxn={onOpenTxn}
        emptyTitle="No orders on this bracelet"
        emptyBody={
          <>
            Band <span className="font-mono">#{code}</span> has no tickets, F&amp;B, or drop-off
            charges yet.
          </>
        }
      />
    </div>
  );
}
