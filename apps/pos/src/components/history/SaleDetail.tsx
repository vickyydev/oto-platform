import { useEffect, useState } from 'react';
import { getSale, baht, type ApiSaleDetail, type HistoryTxn } from '@/api/history';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import { getTicketTypes } from '@/store/catalogStore';
import { tierLabel } from '@/lib/membership';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from './StatusBadge';
import { LEDGER_ONLY_NOTICE } from './ledgerNotice';
import {
  ArrowLeft,
  Baby,
  Ticket,
  GlassWater,
  ShoppingBag,
  Undo2,
  User as UserIcon,
  Clock,
  Printer,
  Timer,
  MonitorSmartphone,
  Info,
} from 'lucide-react';

/**
 * ONE SALE OUT OF THE PLATFORM LEDGER — SCRUM-238.
 *
 * The prototype's `TransactionDetail` reads a mock `Sale` and re-derives its
 * totals in the browser (`lib/pricing`, `lib/tax`). A real sale has none of
 * that to re-derive: the platform priced it, charged it and froze what it
 * charged, so this view READS those figures and computes nothing. Same layout,
 * same cards, same order — contents on the left, money on the right — because
 * §7 says the design stays and only the data source changes.
 *
 * WHAT IT CANNOT SHOW, and does not pretend to: `GET /sales/:id` answers with
 * the sale, its lines and its discounts, and no tender — how the money was
 * taken lives on `pos.payment_attempt`, which that read does not join (S2-10a
 * owns its shape). So there is no payment row here rather than a made-up one,
 * and the actions that would change a real sale are disabled with the ticket
 * that brings them.
 */
export function SaleDetail({
  txn,
  timeZone,
  onBack,
  layout = 'columns',
}: {
  txn: HistoryTxn;
  timeZone?: string;
  onBack: () => void;
  /**
   * `columns` is the counter: contents on the left, money on the right, each
   * scrolling in its own pane inside a fixed-height page.
   *
   * `stacked` is the handheld (SCRUM-320). Same cards, same order, one column —
   * but the page scrolls as ONE thing rather than nesting a scroller inside a
   * scroller, which on a 390px screen means a guest's items scrolling under a
   * thumb while the total stays off-screen below. Nothing is hidden and nothing
   * is restyled; only which element owns the scrollbar changes.
   */
  layout?: 'columns' | 'stacked';
}) {
  const stacked = layout === 'stacked';
  const [detail, setDetail] = useState<ApiSaleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    getSale(txn.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof NetworkError) {
          setError('No connection to the platform, so this sale cannot be opened.');
        } else if (isMissingRoute(err)) {
          setError('This deployment cannot read a sale back yet (SCRUM-203).');
        } else {
          setError(err instanceof ApiError ? err.message : 'This sale could not be read.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [txn.id]);

  const sale = txn.ledger;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    });

  const kind = txn.isDropOff ? 'dropoff' : txn.kind;
  const heading =
    kind === 'dropoff'
      ? 'Drop-off charge'
      : kind === 'merch'
        ? 'Retail sale'
        : kind === 'fnb'
          ? 'F&B order'
          : 'Ticket sale';

  // One box per cart line, the way the till rang it up: the platform's lines
  // are the COMPONENTS of that cart line (kids, adults, socks), which is
  // exactly the breakdown the prototype's detail view shows inside each box.
  const groups = new Map<string, ApiSaleDetail['lines']>();
  for (const line of detail?.lines ?? []) {
    const group = groups.get(line.cartLineId) ?? [];
    group.push(line);
    groups.set(line.cartLineId, group);
  }
  const packageName = (packageId: string | null): string | null =>
    packageId ? (getTicketTypes().find((t) => t.id === packageId)?.name ?? null) : null;

  const tierClaim = detail?.sale.tierClaim ?? sale.tierClaim ?? null;
  const totals = sale.totals;
  const taxTotal = totals.taxInclusiveSatang + totals.taxExclusiveSatang;
  const taxName =
    detail?.taxBreakdown?.categories?.find((c) => c.taxName)?.taxName ?? 'VAT';

  const contents = error ? (
    <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
      {error}
    </div>
  ) : !detail ? (
    <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
      Reading this sale…
    </div>
  ) : (
    <div className="space-y-3">
      {[...groups.entries()].map(([cartLineId, lines]) => {
        const first = lines[0]!;
        const name = packageName(first.ticketPackageId) ?? first.stayDurationLabel ?? 'Items';
        const groupTotal = lines.reduce((sum, l) => sum + l.grossSatang, 0);
        return (
          <div key={cartLineId} className="rounded-xl border bg-background/40 p-4">
            <div className="flex items-center justify-between font-bold text-lg">
              <span>
                {name}
                <span className="text-muted-foreground font-normal text-base">
                  {' '}
                  · {tierLabel(first.customerTier)}
                </span>
              </span>
              <span className="tabular-nums">฿{baht(groupTotal)}</span>
            </div>
            <div className="mt-2 space-y-1">
              {lines.map((line) => (
                <div key={line.id} className="flex justify-between text-sm text-muted-foreground">
                  <span>
                    {line.label} {line.quantity}× ฿{baht(line.unitSatang)}
                  </span>
                  <span className="tabular-nums">฿{baht(line.grossSatang)}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between gap-3 mb-4">
        <Button variant="ghost" className="gap-2" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
          Back to history
        </Button>
        <StatusBadge status={txn.badge} />
      </div>

      <div
        className={
          stacked
            ? 'flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 pb-4'
            : 'flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6'
        }
      >
        {/* Left: contents */}
        <Card className={`p-6 flex flex-col bg-card/50 ${stacked ? 'shrink-0' : 'min-h-0'}`}>
          <div className="flex items-start gap-4 mb-5 shrink-0">
            <div className="w-16 h-16 rounded-2xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
              {kind === 'dropoff' ? (
                <Baby className="w-8 h-8" />
              ) : kind === 'merch' ? (
                <ShoppingBag className="w-8 h-8" />
              ) : kind === 'fnb' ? (
                <GlassWater className="w-8 h-8" />
              ) : (
                <Ticket className="w-8 h-8" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-2xl font-black leading-tight tracking-tight">
                {heading} <span className="text-primary">{txn.reference}</span>
              </div>
              <div className="text-lg font-semibold flex items-center gap-2 mt-1.5">
                <UserIcon className="w-5 h-5 text-primary shrink-0" />
                <span className="truncate">{txn.customerLabel ?? 'Walk-in'}</span>
                {sale.member?.phone && (
                  <span className="text-muted-foreground font-normal text-base">
                    · {sale.member.phone}
                  </span>
                )}
              </div>
              <div className="text-sm text-muted-foreground flex items-center gap-1.5 mt-1.5">
                <Clock className="w-4 h-4" />
                {fmt(sale.occurredAt)} · sold by {txn.operatorName}
              </div>
              <div className="text-sm text-muted-foreground flex items-center gap-1.5 mt-1">
                <MonitorSmartphone className="w-4 h-4" />
                {sale.stationName ?? 'Unknown station'} · trading day {sale.businessDate} ·{' '}
                {tierLabel(sale.customerTier)} · {sale.pricingModeReason}
                {/* WHY THIS SALE WAS CHARGED AT THAT TIER, where a document
                    check chose it — SCRUM-333. It sits on the tier's own line
                    because it is the rest of that sentence: "Expat" alone does
                    not say who decided, and the discounted rate is the one
                    figure on this page somebody may have to defend. Absent on
                    the sales priced from a member's record or the default,
                    which is almost all of them. The detail read is preferred
                    over the list row only because it lands second; both carry
                    it, so the line does not appear and then move.

                    A STRING AND NOT A SPAN: this row is a flex container, so
                    an element here would be a second flex item and split the
                    row into two columns. Text stays in the run beside the tier
                    it is explaining. */}
                {tierClaim
                  ? ` · Priced on ${tierClaim.documentKind.toLowerCase()}, checked ${fmt(tierClaim.verifiedAt)}`
                  : ''}
              </div>
            </div>
          </div>

          {stacked ? (
            contents
          ) : (
            <ScrollArea className="flex-1 -mx-2 px-2">{contents}</ScrollArea>
          )}
        </Card>

        {/* Right: money + actions */}
        <div className="flex flex-col min-h-0 gap-4">
          <Card className="p-6 shrink-0 bg-card/50 space-y-3">
            <div className="space-y-1 pb-2 border-b text-sm">
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span className="tabular-nums">฿{baht(totals.subtotalSatang)}</span>
              </div>
              {(detail?.discounts ?? []).map((d) => (
                <div key={d.id} className="flex items-start justify-between text-emerald-400">
                  <span className="min-w-0">
                    <span className="block truncate">
                      {d.label ?? (d.kind === 'promo' ? 'Promo' : 'Discount')}
                      {d.targetLabel ? ` · ${d.targetLabel}` : ''}
                    </span>
                    {(d.reason || d.appliedByName) && (
                      <span className="block text-xs text-muted-foreground">
                        {d.reason ?? ''}
                        {d.note ? ` — ${d.note}` : ''}
                        {d.appliedByName ? ` · by ${d.appliedByName}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums shrink-0">−฿{baht(d.amountSatang)}</span>
                </div>
              ))}
              {totals.serviceChargeSatang > 0 && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Service charge</span>
                  <span className="tabular-nums">฿{baht(totals.serviceChargeSatang)}</span>
                </div>
              )}
              {taxTotal > 0 && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>
                    {taxName}
                    {totals.taxInclusiveSatang > 0 ? ' (included)' : ''}
                  </span>
                  <span className="tabular-nums">฿{baht(taxTotal)}</span>
                </div>
              )}
            </div>
            <div className="flex items-end justify-between gap-3">
              <span className="text-base font-semibold text-muted-foreground">
                {txn.badge === 'unpaid' ? 'Amount due' : 'Total paid'}
              </span>
              <span className="text-4xl font-black tabular-nums leading-none">
                ฿{baht(totals.grossSatang)}
              </span>
            </div>
            {totals.refundedSatang > 0 && (
              <div className="border-t pt-2 flex items-center justify-between text-rose-400 font-semibold">
                <span>Refunded</span>
                <span className="tabular-nums">−฿{baht(totals.refundedSatang)}</span>
              </div>
            )}
            {sale.note && (
              <div className="border-t pt-2 text-sm text-muted-foreground">{sale.note}</div>
            )}
          </Card>

          {/* Actions — every one of these changes a recorded sale, and none of
              them can yet, so they say so instead of pretending. */}
          <div className="shrink-0 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="h-14 text-base gap-2" disabled>
                <Printer className="w-5 h-5" />
                Reprint
              </Button>
              <Button variant="outline" className="h-14 text-base gap-2" disabled>
                <Timer className="w-5 h-5" />
                Add time
              </Button>
            </div>
            <Button
              className="w-full h-14 text-lg gap-2 bg-rose-500 hover:bg-rose-600 text-white"
              disabled
            >
              <Undo2 className="w-5 h-5" />
              Refund
            </Button>
            <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground flex items-start gap-2">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{LEDGER_ONLY_NOTICE}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
