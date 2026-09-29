import { WristbandActivity } from '@/types';
import type { BadgeStatus } from '@/api/history';
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
 *
 * S2-11 (SCRUM-208): History finds a band's sales on the platform
 * (`GET /sales/lookup?band=`), which knows the sales and their member but not
 * a wallet — wallets arrive with S2-14a. So the platform-backed caller names
 * the holder and the member itself, says what the credit tile cannot show
 * (`creditLabel`), and passes the ledger's badge and the branch's clock, the
 * same overrides `MemberActivity` takes.
 */
export function ClientActivity({
  code,
  activity,
  onOpenTxn,
  onBack,
  holderName: holderOverride,
  memberLine,
  creditLabel,
  spentLabel = 'Total spent',
  badgeFor,
  timeZone,
}: {
  code: string;
  activity: WristbandActivity;
  onOpenTxn: (txn: TxnSummary) => void;
  onBack: () => void;
  /** Who the band was issued to, where the caller knows and there is no wristband record. */
  holderName?: string;
  /** The member the band's sales belong to, where there is no member record to hand. */
  memberLine?: { nickname: string; phone: string } | null;
  /** Shown in the credit tile in place of a balance this source cannot give. */
  creditLabel?: string;
  spentLabel?: string;
  badgeFor?: (txn: TxnSummary) => BadgeStatus | undefined;
  timeZone?: string;
}) {
  const { wristband, member, transactions, totalSpent, orderCount } = activity;
  const holderName =
    holderOverride ?? wristband?.holderName ?? wristband?.customerNickname ?? 'Unknown band';
  const linked = member ? { nickname: member.nickname, phone: member.phone } : (memberLine ?? null);

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
            {linked && (
              <div className="mt-1 inline-flex items-center gap-1 text-sm text-emerald-400">
                <BadgeCheck className="w-4 h-4" />
                Member · {linked.nickname} · {linked.phone}
              </div>
            )}
          </div>
          <div className="flex items-stretch gap-3 shrink-0">
            <div className="rounded-xl bg-muted/50 px-4 py-2 text-right">
              <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                <Wallet className="w-3 h-3" />
                Credit
              </div>
              {creditLabel ? (
                <div className="text-xs text-muted-foreground max-w-[10rem] mt-1">{creditLabel}</div>
              ) : (
                <div className="text-xl font-bold tabular-nums text-primary">
                  ฿{wristband?.creditBalanceTHB ?? 0}
                </div>
              )}
            </div>
            <div className="rounded-xl bg-muted/50 px-4 py-2 text-right">
              <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                <Receipt className="w-3 h-3" />
                {spentLabel}
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
        {...(badgeFor ? { badgeFor } : {})}
        {...(timeZone ? { timeZone } : {})}
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
