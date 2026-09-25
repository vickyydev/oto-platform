import { useEffect, useState } from 'react';
import { PAYMENT_ATTEMPT_TAKEN_STATUSES, PAYMENT_ATTEMPT_TERMINAL_STATUSES } from '@oto/shared';
import {
  getSale,
  baht,
  type ApiSaleDetail,
  type BadgeStatus,
  type HistoryTxn,
  type PaymentAttemptView,
} from '@/api/history';
import { salesApi } from '@/api/sales';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import { useOperator } from '@/auth/OperatorContext';
import { getTicketTypes } from '@/store/catalogStore';
import { tierLabel } from '@/lib/membership';
import { RECENT_SALE_MS } from '@/lib/tillVoucher';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from './StatusBadge';
import { LEDGER_ONLY_NOTICE } from './ledgerNotice';
import {
  AlertTriangle,
  ArrowLeft,
  Baby,
  Ban,
  Banknote,
  CreditCard,
  Ticket,
  GlassWater,
  QrCode,
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
 * HOW THE MONEY WAS TAKEN — S2-10a. Until this ticket `GET /sales/:id` answered
 * with the sale, its lines and its discounts and no tender at all, so this view
 * said so rather than inventing a payment row. It now answers `attempts`, and
 * the card below shows them: every one, in the order they were taken, the
 * failed ones included. A guest disputing a charge and a manager counting a
 * drawer are both asking about attempts rather than about the total, and a
 * screen that showed only the tender that worked is the one that cannot answer
 * either of them.
 *
 * The actions that would CHANGE a recorded sale — reprint, add time, refund —
 * are still disabled with the ticket that brings them.
 *
 * ONE ACTION WORKS: VOID, for an unpaid sale that took no money (audit C1, the
 * owner's answer to Q3: any cashier with the till's void permission, giving a
 * reason). It sits where Refund sits, because an unpaid sale has nothing to
 * refund and a void is what undoes it. A sale rung up and then left — the till
 * locked or reloaded mid-payment — otherwise stays `tendering` for ever and
 * keeps any Lucky Wheel voucher on it from being used.
 */
/** "less than a minute", "1 minute", "12 minutes". */
function minutesAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * THE VOID OF AN UNPAID SALE — the refund dialog's clothes (`RefundModal`), with
 * the one thing a void needs: a reason, which the platform requires and the
 * voids report shows. A sale rung up less than `RECENT_SALE_MS` ago says it may
 * still be being paid for at its till. The platform decides: money taken, a
 * tender in progress or a sale closed since are refused in its words, here.
 */
function VoidSaleDialog({
  open,
  onOpenChange,
  txn,
  stationName,
  operatorName,
  fmt,
  onVoided,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  txn: HistoryTxn;
  stationName: string | null;
  operatorName: string;
  fmt: (iso: string) => string;
  onVoided: (voided: { reason: string }) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A clean slate each time it opens.
  useEffect(() => {
    if (open) {
      setReason('');
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const sale = txn.ledger;
  const age = Date.now() - new Date(sale.occurredAt).getTime();
  const recent = !Number.isNaN(age) && age < RECENT_SALE_MS;
  const trimmed = reason.trim();

  const confirm = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await salesApi.voidSale(sale.id, trimmed);
      onVoided({ reason: answer.void.reason ?? trimmed });
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof NetworkError
          ? 'No connection to the platform, so the sale was not voided.'
          : err instanceof Error
            ? err.message
            : 'The sale could not be voided.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="w-5 h-5 text-rose-400" />
            Void unpaid sale
          </DialogTitle>
          <DialogDescription>
            By {operatorName} · it can never be paid afterwards · logged for the voids report.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="rounded-lg bg-muted p-4 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Amount due</span>
              <span className="text-2xl font-black tabular-nums">฿{baht(sale.totals.grossSatang)}</span>
            </div>
            <div className="text-sm text-muted-foreground">
              Rung up {fmt(sale.occurredAt)}
              {stationName ? ` at ${stationName}` : ''} · no money taken
            </div>
          </div>

          {recent && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                Rung up {minutesAgo(Math.max(0, age))} ago. If it is being paid for
                {stationName ? ` at ${stationName}` : ' at its till'} right now, finish it there
                instead of voiding it here.
              </span>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              Reason <span className="text-destructive">*</span>
            </p>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this sale being voided?"
              maxLength={120}
              rows={2}
              aria-label="Reason for the void"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button
            className="w-full h-14 text-lg bg-rose-500 hover:bg-rose-600 text-white"
            disabled={!trimmed || busy}
            onClick={() => void confirm()}
          >
            {busy ? 'Voiding…' : trimmed ? 'Void this sale' : 'Give a reason to void'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
/**
 * WHAT EACH TENDER IS CALLED ON A SCREEN A PERSON READS.
 *
 * The ledger's own six words (`PAYMENT_METHODS` in `@oto/shared`) are what the
 * money is filed under; these are what the counter calls them. `transfer` is
 * named here because the column allows it, not because anything writes one
 * yet.
 */
const METHOD_LABEL: Record<PaymentAttemptView['method'], string> = {
  cash: 'Cash',
  card: 'Card',
  qr: 'QR',
  wallet: 'Wallet',
  voucher: 'Voucher',
  transfer: 'Transfer',
};

/**
 * The ten states an attempt can be in, in the words staff use for them.
 *
 * Only `approved` is money in the till. Everything else is said plainly rather
 * than dressed up: "waiting" on a screen where a guest is standing is worth
 * more than a green tick that turns out to have been a guess.
 */
const STATUS_LABEL: Record<PaymentAttemptView['status'], { label: string; tone: string }> = {
  approved: { label: 'Approved', tone: 'text-emerald-400' },
  awaiting_settlement: { label: 'Taken, not settled', tone: 'text-amber-400' },
  declined: { label: 'Declined', tone: 'text-rose-400' },
  cancelled: { label: 'Cancelled', tone: 'text-muted-foreground' },
  not_found: { label: 'Not on the terminal', tone: 'text-rose-400' },
  created: { label: 'Not sent', tone: 'text-muted-foreground' },
  sent_to_terminal: { label: 'Waiting', tone: 'text-amber-400' },
  inquiring: { label: 'Checking', tone: 'text-amber-400' },
  unknown: { label: 'No answer', tone: 'text-rose-400' },
  awaiting_staff_confirmation: { label: 'Needs confirming', tone: 'text-amber-400' },
};

/**
 * One tender: what kind, how much, and whether the money is ours.
 *
 * The second line carries only what that particular instrument actually
 * produced — change on cash, the last four and the approval code on a card,
 * the gateway's reference on a QR — so the row is short on the tenders that
 * have nothing to say and complete on the ones that do. No PAN and no part of
 * one beyond the four digits the ledger is allowed to hold.
 */
function PaymentRow({
  attempt,
  fmt,
}: {
  attempt: PaymentAttemptView;
  fmt: (iso: string) => string;
}) {
  const status = STATUS_LABEL[attempt.status];
  const Icon =
    attempt.method === 'cash' ? Banknote : attempt.method === 'qr' ? QrCode : CreditCard;
  const detail = [
    attempt.changeSatang !== null && attempt.changeSatang > 0
      ? `฿${baht(attempt.tenderedSatang ?? 0)} given, ฿${baht(attempt.changeSatang)} change`
      : null,
    attempt.last4 ? `•••• ${attempt.last4}` : null,
    attempt.approvalCode ? `Approval ${attempt.approvalCode}` : null,
    attempt.terminalRef ?? attempt.tranRef ?? attempt.invoiceNo,
    attempt.offline ? 'Taken offline' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex items-start justify-between gap-3">
      <span className="flex items-start gap-2 min-w-0">
        <Icon className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block font-semibold">
            {METHOD_LABEL[attempt.method]}
            <span className={`font-normal text-sm ${status.tone}`}> · {status.label}</span>
          </span>
          <span className="block text-xs text-muted-foreground">
            {attempt.paidAt ? fmt(attempt.paidAt) : fmt(attempt.createdAt)}
            {detail.length > 0 ? ` · ${detail.join(' · ')}` : ''}
          </span>
        </span>
      </span>
      <span className="tabular-nums shrink-0 font-semibold">฿{baht(attempt.amountSatang)}</span>
    </div>
  );
}

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
  const { operator, can } = useOperator();
  const [detail, setDetail] = useState<ApiSaleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The void this screen just made, with the reason it was given. */
  const [voided, setVoided] = useState<{ reason: string } | null>(null);
  const [showVoid, setShowVoid] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setVoided(null);
    setShowVoid(false);
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

  const attempts = detail?.attempts ?? [];
  /**
   * Where the sale stands NOW: the detail is read when it opens, so a sale paid
   * or voided at a till since the list loaded says so here; a void made on this
   * screen says so at once.
   */
  const status = voided ? 'voided' : (detail?.sale.status ?? sale.status);
  const badge: BadgeStatus =
    status === 'voided'
      ? 'voided'
      : status === 'tendering'
        ? 'unpaid'
        : txn.badge === 'unpaid'
          ? 'paid'
          : txn.badge;
  /**
   * AN UNPAID SALE THAT TOOK NO MONEY — the one kind History may void: rung up,
   * still `tendering`, no tender that took money and none still in progress. Read
   * from the detail's own attempts, so nothing is offered before they are known;
   * the platform checks the same again when the void is sent.
   */
  const tookNoMoney =
    detail !== null &&
    status === 'tendering' &&
    !attempts.some((a) => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status)) &&
    attempts.every((a) => PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(a.status));
  const mayVoid = can('pos:sale:void');
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
        <StatusBadge status={badge} />
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
                {badge === 'unpaid' ? 'Amount due' : badge === 'voided' ? 'Total (voided)' : 'Total paid'}
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

          {/* S2-10a — the tenders, under the money they settled.
              ONE INSERTION COVERS BOTH LAYOUTS: `columns` and `stacked` differ
              in which element owns the scrollbar, not in what hangs off this
              column, so the card follows the totals on the counter and on the
              handheld alike. */}
          {attempts.length > 0 && (
            <Card className="p-6 shrink-0 bg-card/50 space-y-3">
              <div className="text-base font-semibold text-muted-foreground">
                {attempts.length === 1 ? 'Payment' : 'Payments'}
              </div>
              <div className="space-y-3">
                {attempts.map((attempt) => (
                  <PaymentRow key={attempt.id} attempt={attempt} fmt={fmt} />
                ))}
              </div>
            </Card>
          )}

          {/* Actions — every one of these changes a recorded sale. Reprint, Add
              time and Refund cannot yet, so they say so instead of pretending;
              an unpaid sale that took no money can be voided, in Refund's place. */}
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
            {tookNoMoney ? (
              <>
                <Button
                  className="w-full h-14 text-lg gap-2 bg-rose-500 hover:bg-rose-600 text-white"
                  disabled={!mayVoid}
                  onClick={() => setShowVoid(true)}
                  data-testid="void-sale"
                >
                  <Ban className="w-5 h-5" />
                  Void unpaid sale
                </Button>
                {!mayVoid && (
                  <p className="text-sm text-muted-foreground">
                    Voiding a sale needs the till&apos;s void permission.
                  </p>
                )}
              </>
            ) : (
              <Button
                className="w-full h-14 text-lg gap-2 bg-rose-500 hover:bg-rose-600 text-white"
                disabled
              >
                <Undo2 className="w-5 h-5" />
                Refund
              </Button>
            )}
            {voided && (
              <div
                className="rounded-lg border p-3 text-sm text-muted-foreground flex items-start gap-2"
                data-testid="sale-voided"
              >
                <Ban className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Voided by {operator?.name ?? 'you'} — {voided.reason}. It can never be paid, and a
                  voucher it held is free again.
                </span>
              </div>
            )}
            <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground flex items-start gap-2">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{LEDGER_ONLY_NOTICE}</span>
            </div>
          </div>
        </div>
      </div>

      <VoidSaleDialog
        open={showVoid}
        onOpenChange={setShowVoid}
        txn={txn}
        stationName={sale.stationName}
        operatorName={operator?.name ?? 'this account'}
        fmt={fmt}
        onVoided={setVoided}
      />
    </div>
  );
}
