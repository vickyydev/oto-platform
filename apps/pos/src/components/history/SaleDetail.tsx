import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  PAID_ONLINE_TENDER_METHOD,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  PAYMENT_ATTEMPT_TERMINAL_STATUSES,
  SALE_REPRINT_KINDS,
  type RefundAllocationEntry,
  type RefundMode,
  type SaleReprintKind,
} from '@oto/shared';
import {
  getSale,
  baht,
  bandLabel,
  bookingReferenceOf,
  isVoucherDiscount,
  newActionId,
  refundItemOptions,
  refundRemainingSatang,
  refundSale,
  reprintOptions,
  reprintSale,
  type ApiRefund,
  type ApiSale,
  type ApiSaleBand,
  type ApiSaleDetail,
  type ApiSaleDiscount,
  type ApiSalePrintJob,
  type BadgeStatus,
  type HistoryTxn,
  type PaymentAttemptView,
} from '@/api/history';
import { salesApi } from '@/api/sales';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import { useOperator } from '@/auth/OperatorContext';
import { getDiscountReasons, getTicketTypes } from '@/store/catalogStore';
import { tierLabel } from '@/lib/membership';
import { RECENT_SALE_MS } from '@/lib/tillVoucher';
import { dispatchPlatformPrinting } from '@/lib/printRouting';
import { PRINT_KIND_LABEL } from '@/lib/salePrinting';
import {
  clearRefundRequests,
  queueRefundRequest,
  refundRequestsFor,
  type RefundRequestNote,
} from '@/lib/refundRequests';
import { stationLinkApi } from '@/station/link';
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
import { RefundModal, type RefundResult } from './RefundModal';
import { ReprintModal } from './ReprintModal';
import {
  AlertTriangle,
  ArrowLeft,
  Baby,
  Ban,
  Banknote,
  Check,
  CreditCard,
  Ticket,
  GlassWater,
  Plus,
  QrCode,
  ShoppingBag,
  Undo2,
  User as UserIcon,
  Users,
  Clock,
  Printer,
  Timer,
  MonitorSmartphone,
  Info,
  WifiOff,
  Wallet,
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
 * REFUNDS AND REPRINTS — S2-11 (SCRUM-208). A closed sale can be refunded —
 * whole, by item or a custom amount, clamped to what is left, with a reason,
 * and only with a manager's approval (`pos:refund:approve`; without it the
 * platform refuses in its own words, shown in the dialog) — and reprinted: the
 * receipt, each band group, the F&B pick-up ticket (`RefundModal`,
 * `ReprintModal`, ported from the prototype's `TransactionDetail.tsx` and
 * `mockApi.ts:recordRefund` / `recordReprint`). Both are online only. With the
 * station offline the Refund button says so and its dialog notes the request
 * on this till instead (`lib/refundRequests.ts`), for a manager to make once
 * it is back online. The refunds and the reprints are listed under the money,
 * as the prototype listed its own. Add time stays disabled: paid time
 * extensions are deferred.
 *
 * ONE ACTION WORKS: VOID, for an unpaid sale that took no money (audit C1, the
 * owner's answer to Q3: any cashier with the till's void permission, giving a
 * reason). It sits where Refund sits, because an unpaid sale has nothing to
 * refund and a void is what undoes it. A sale rung up and then left — the till
 * locked or reloaded mid-payment — otherwise stays `tendering` for ever and
 * keeps any Lucky Wheel voucher on it from being used.
 *
 * A VOIDED SALE SAYS WHO, WHEN AND WHY (SCRUM-430), whichever screen voided
 * it: this one, with the reason just given; a till's Cancel; the offer on a
 * voucher refusal. They are read off the sale where the ledger's read carries
 * them (`voidedByName`, `voidedAt`, `voidReason` in api/history.ts), and the
 * note says as much of them as the read gave — `voidSentence` below has the
 * three forms. Its last clause, that a voucher the sale held is free again, is
 * said only of a sale that held one. Such a sale has nothing to refund, so it
 * shows no Refund button — not even a greyed one — and the void made here is
 * reported to the page (`onVoided`) so its list is read again and stops
 * saying "Unpaid".
 */
/**
 * THE VOID NOTE'S SENTENCE — SCRUM-430, in its three forms:
 *
 *   Voided by Som — wrong tier. It can never be paid.                      (voided on this screen)
 *   Voided by Som, 25 Sept, 14:02 — wrong tier. It can never be paid.      (read back, voider named)
 *   Voided 25 Sept, 14:02 — wrong tier. It can never be paid.              (read back, no name)
 *
 * The voucher clause — ", and a voucher it held is free again" — is said only
 * of a sale that held one. Said of every void, it sent reception looking for
 * a slip that was never on the sale.
 */
function voidSentence(
  record: { reason: string | null; at: string | null; byName: string | null },
  voucherHeld: boolean,
  fmt: (iso: string) => string,
): string {
  const who = record.byName ? ` by ${record.byName}` : '';
  const when = record.at ? `${who ? ',' : ''} ${fmt(record.at)}` : '';
  const why = record.reason ? ` — ${record.reason}` : '';
  const voucher = voucherHeld ? ', and a voucher it held is free again' : '';
  return `Voided${who}${when}${why}. It can never be paid${voucher}.`;
}

/** Where a voucher line's label turns from the type's name to the code. */
const VOUCHER_PART = ' (voucher ';

/**
 * SCRUM-433 — A VOUCHER LINE KEEPS ITS LAST FOUR IN VIEW.
 *
 * The platform labels a voucher's discount line with the type's name and the
 * last four characters of the code, "Free Bracelet Workshop (voucher …WXYZ)"
 * (`voucherLineLabel` in apps/api/src/services/vouchers.ts), and the four are
 * what match the line to the slip in the guest's hand. The label is one row
 * beside its amount, cut with an ellipsis when it does not fit; at 1600 wide a
 * name that long already fills the row, and a longer one pushed the four off
 * its end. So the label is split where its voucher part starts: the name is
 * what gets cut, and "(voucher …WXYZ)" never is. Null for a label with no
 * voucher part, which keeps the one run it always was.
 */
export function voucherLabelParts(label: string | null): { name: string; tail: string } | null {
  if (!label || !label.endsWith(')')) return null;
  const at = label.lastIndexOf(VOUCHER_PART);
  return at > 0 ? { name: label.slice(0, at), tail: label.slice(at) } : null;
}

/**
 * One discount's words on the money card: its label and, on a discount aimed
 * at a line, what it was aimed at. A voucher's line is split by
 * `voucherLabelParts` — the name truncates, the voucher part after it does not
 * — and reads as one run whenever it fits. Every other line is the single
 * truncating run it always was.
 */
export function DiscountLabel({
  discount: d,
}: {
  discount: Pick<ApiSaleDiscount, 'kind' | 'label' | 'targetLabel'>;
}) {
  const parts = isVoucherDiscount(d) ? voucherLabelParts(d.label) : null;
  if (!parts) {
    return (
      <span className="block truncate">
        {d.label ?? (d.kind === 'promo' ? 'Promo' : 'Discount')}
        {d.targetLabel ? ` · ${d.targetLabel}` : ''}
      </span>
    );
  }
  // `whitespace-pre` keeps the space that opens the voucher part, which a flex
  // item would otherwise drop at its start; a no-break space opens the target.
  return (
    <span className="flex min-w-0">
      <span className="min-w-0 truncate">{parts.name}</span>
      <span className="shrink-0 whitespace-pre">{parts.tail}</span>
      {d.targetLabel ? <span className="min-w-0 truncate">&nbsp;· {d.targetLabel}</span> : null}
    </span>
  );
}

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
  /** The reason the void was given, and the vouchers it let go (none, for most sales). */
  onVoided: (voided: { reason: string; releasedVoucherIds: string[] }) => void;
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
      onVoided({
        reason: answer.void.reason ?? trimmed,
        releasedVoucherIds: answer.releasedVoucherIds,
      });
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
  // S2-14a round 2 — the only writer of a `wallet` attempt is the platform's
  // stored-value tender; the counter calls it credit (the prototype's word).
  wallet: 'Credit',
  voucher: 'Voucher',
  transfer: 'Transfer',
};

/**
 * S2-14a round 2 — WHAT A REFUND CAN STILL PUT BACK ON THE WALLET: the credit
 * this sale's wallet tenders took, less what earlier refunds already restored
 * (the prototype's restorable rule, `TransactionDetail.tsx:134-138`). The
 * platform applies the same cap; this is the figure the Refund dialog shows.
 */
export function restorableCreditSatang(
  attempts: readonly Pick<PaymentAttemptView, 'method' | 'status' | 'amountSatang'>[],
  refunds: readonly { tenderAllocation: readonly Pick<RefundAllocationEntry, 'route' | 'status' | 'amountSatang'>[] }[],
): number {
  const used = attempts
    .filter((a) => a.method === 'wallet' && PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status))
    .reduce((sum, a) => sum + a.amountSatang, 0);
  const restored = refunds
    .flatMap((r) => r.tenderAllocation)
    .filter((slice) => slice.route === 'wallet' && slice.status === 'done')
    .reduce((sum, slice) => sum + slice.amountSatang, 0);
  return Math.max(0, used - restored);
}

/**
 * WHAT ONE TENDER IS CALLED ON THE SALE — SCRUM-477.
 *
 * The money that settles a booking's redemption sale is the money the family
 * paid on the booking site, filed under the paid-online tender as `transfer`
 * (`PAID_ONLINE_TENDER_METHOD`, `@oto/shared`), and the attempt view does not
 * carry the tender's own code. Nothing else writes a transfer today, so on a
 * sale that redeemed a booking (`bookingReferenceOf`) the transfer is that
 * money, and the row says "Paid online" rather than "Transfer". Everywhere
 * else the ledger's word stands.
 */
export function tenderLabel(
  attempt: Pick<PaymentAttemptView, 'method'>,
  sale: Pick<ApiSale, 'note'>,
): string {
  if (attempt.method === PAID_ONLINE_TENDER_METHOD && bookingReferenceOf(sale)) return 'Paid online';
  return METHOD_LABEL[attempt.method];
}

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
  sale,
  fmt,
}: {
  attempt: PaymentAttemptView;
  /** The sale the tender settled: a booking's redemption names its money "Paid online". */
  sale: Pick<ApiSale, 'note'>;
  fmt: (iso: string) => string;
}) {
  const status = STATUS_LABEL[attempt.status];
  const Icon =
    attempt.method === 'cash' ? Banknote : attempt.method === 'qr' ? QrCode : attempt.method === 'wallet' ? Wallet : CreditCard;
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
            {tenderLabel(attempt, sale)}
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

/**
 * HOW ONE SLICE OF A REFUND WENT BACK, in the words the counter uses — S2-11.
 *
 * The platform splits a refund across the tenders that took the money, wallet
 * → same tender → cash (`allocateRefund` in `@oto/shared`), and says where each
 * slice stands. Its own sentence (`detail`) wins where it wrote one — "The
 * terminal refused the void (…) — hand it back in cash" is the thing staff act
 * on; these are the words for a slice that has none yet.
 */
export function refundSliceWords(
  entry: Pick<RefundAllocationEntry, 'method' | 'route' | 'status' | 'detail'>,
): { text: string; tone: string } {
  const method = METHOD_LABEL[entry.method as PaymentAttemptView['method']] ?? entry.method;
  const tone =
    entry.status === 'failed'
      ? 'text-rose-400'
      : entry.status === 'pending'
        ? 'text-amber-400'
        : 'text-muted-foreground';
  if (entry.detail) return { text: `${method} — ${entry.detail}`, tone };
  const words: Record<RefundAllocationEntry['route'], Record<RefundAllocationEntry['status'], string>> = {
    cash: { done: 'hand it back in cash', pending: 'hand it back in cash', failed: 'hand it back in cash' },
    terminal_void: {
      done: 'voided on the terminal',
      pending: 'void sent to the terminal',
      failed: 'the terminal refused the void — hand it back in cash',
    },
    gateway_refund: {
      done: 'refunded through the payment gateway',
      pending: 'refund sent to the payment gateway',
      failed: 'the gateway refused the refund — hand it back in cash',
    },
    wallet: {
      done: 'back on the wallet',
      pending: 'going back on the wallet',
      failed: 'the wallet refused it — hand it back in cash',
    },
    manual: {
      done: 'reverse it on the terminal it was taken on',
      pending: 'reverse it on the terminal it was taken on',
      failed: 'reverse it on the terminal it was taken on',
    },
  };
  return { text: `${method} — ${words[entry.route][entry.status]}`, tone };
}

/** The prototype's "Refund history" card (`TransactionDetail.tsx`), from the platform's refunds. */
function RefundHistory({ refunds, fmt }: { refunds: readonly ApiRefund[]; fmt: (iso: string) => string }) {
  if (refunds.length === 0) return null;
  return (
    <Card className="p-4 shrink-0 bg-card/50" data-testid="refund-history">
      <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
        Refund history
      </div>
      <div className="space-y-2">
        {refunds.map((r) => {
          const by = r.createdBy.name ?? 'Unknown';
          const approver = r.approvedBy.name ?? 'Unknown';
          return (
            <div key={r.id} className="text-sm border-l-2 border-rose-500/40 pl-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-rose-400 tabular-nums">−฿{baht(r.amountSatang)}</span>
                <span className="text-xs text-muted-foreground">{fmt(r.createdAt)}</span>
              </div>
              <div className="text-muted-foreground">
                {r.reason} · {r.number}
              </div>
              {r.note && <div className="text-xs text-muted-foreground italic">“{r.note}”</div>}
              <div className="mt-1 space-y-0.5">
                {r.tenderAllocation.map((slice, i) => {
                  const words = refundSliceWords(slice);
                  return (
                    <div key={i} className={`flex items-start justify-between gap-2 text-xs ${words.tone}`}>
                      <span className="min-w-0">{words.text}</span>
                      <span className="tabular-nums shrink-0">฿{baht(slice.amountSatang)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="text-xs text-muted-foreground">
                by {by}
                {r.approvedBy.accountId === r.createdBy.accountId
                  ? ' · manager approval'
                  : ` · approved by ${approver}`}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * The prototype's "Reprint history" card, from the platform's print jobs: a
 * reprint is a job whose `reprintOf` names the job it copies. What, when,
 * where it went and how it ended; and who asked for it — the platform's own
 * `requestedByName` where the read carries it (SCRUM-208), the name this screen
 * just made a copy under until then, and nothing where neither has one.
 */
function ReprintHistory({
  jobs,
  bands,
  madeBy,
  fmt,
}: {
  jobs: readonly ApiSalePrintJob[];
  bands: readonly ApiSaleBand[];
  madeBy: Readonly<Record<string, string>>;
  fmt: (iso: string) => string;
}) {
  const reprints = jobs.filter((j) => j.reprintOf !== null).reverse();
  if (reprints.length === 0) return null;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const bandOf = new Map(bands.map((b) => [b.id, b]));
  const status = (job: ApiSalePrintJob): { text: string; tone: string } =>
    job.status === 'printed'
      ? { text: 'Printed', tone: 'text-emerald-400' }
      : job.status === 'queued'
        ? { text: 'Queued', tone: 'text-amber-400' }
        : job.status === 'skipped'
          ? { text: 'Not printed — no printer for it here', tone: 'text-muted-foreground' }
          : { text: `Failed${job.errorMessage ? ` — ${job.errorMessage}` : ''}`, tone: 'text-rose-400' };
  return (
    <Card className="p-4 shrink-0 bg-card/50" data-testid="reprint-history">
      <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
        Reprint history
      </div>
      <div className="space-y-2">
        {reprints.map((job) => {
          const original = job.reprintOf ? byId.get(job.reprintOf) : undefined;
          const band = job.subjectType === 'band' && job.subjectId ? bandOf.get(job.subjectId) : undefined;
          const what = `${PRINT_KIND_LABEL[job.kind]}${band ? ` ${bandLabel(band)}` : ''}`;
          const state = status(job);
          // SCRUM-208 — the platform's own attribution first, so "by Som"
          // survives a reload; the name this screen just made a copy under is
          // the fallback until the read carries it, and nothing where neither has one.
          const who = job.requestedByName ?? madeBy[job.id];
          return (
            <div key={job.id} className="text-sm border-l-2 border-primary/40 pl-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium flex items-center gap-1.5 min-w-0">
                  <Printer className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="truncate">{what}</span>
                </span>
                <span className="text-xs text-muted-foreground shrink-0">{fmt(job.queuedAt)}</span>
              </div>
              <div className={`text-xs ${state.tone}`}>
                {state.text}
                {job.deviceLabel ? ` · ${job.deviceLabel}` : ''}
              </div>
              <div className="text-xs text-muted-foreground">
                {original
                  ? `Copy of the ${PRINT_KIND_LABEL[original.kind].toLowerCase()} printed ${fmt(original.queuedAt)}`
                  : 'Copy of an earlier print'}
                {job.reprintReason ? ` · ${job.reprintReason}` : ''}
                {who ? ` · by ${who}` : ''}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Refunds asked for while the station was offline, kept on this till until one is made. */
function RefundRequests({
  requests,
  fmt,
  onClear,
}: {
  requests: readonly RefundRequestNote[];
  fmt: (iso: string) => string;
  onClear: () => void;
}) {
  if (requests.length === 0) return null;
  return (
    <Card className="p-4 shrink-0 bg-card/50 border-amber-500/40" data-testid="refund-requests">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
          Refund requested offline
        </span>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onClear}>
          Clear
        </Button>
      </div>
      <div className="space-y-2">
        {requests.map((r) => (
          <div key={r.id} className="text-sm border-l-2 border-amber-500/40 pl-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold tabular-nums">฿{baht(r.amountSatang)}</span>
              <span className="text-xs text-muted-foreground">{fmt(r.requestedAt)}</span>
            </div>
            <div className="text-muted-foreground">{r.reason}</div>
            {r.note && <div className="text-xs text-muted-foreground italic">“{r.note}”</div>}
            <div className="text-xs text-muted-foreground">noted by {r.requestedBy}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Noted on this till only — nothing has been refunded. Make the refund here once the station is
        back online.
      </p>
    </Card>
  );
}

/** Whether the browser itself knows it has no network. */
const browserOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

export function SaleDetail({
  txn,
  timeZone,
  onBack,
  onVoided,
  onRefunded,
  layout = 'columns',
}: {
  txn: HistoryTxn;
  timeZone?: string;
  onBack: () => void;
  /** A void made on this screen went through: the page's list is stale (SCRUM-430). */
  onVoided?: (saleId: string) => void;
  /**
   * S2-11 — a refund made on this screen went through: the page's list is
   * stale, and this is the sale as the platform now holds it.
   */
  onRefunded?: (saleId: string, sale: ApiSale) => void;
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
  const { operator, can, offlineUnlock } = useOperator();
  const [, setLocation] = useLocation();
  const [detail, setDetail] = useState<ApiSaleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The void this screen just made: the reason it was given, and the vouchers it let go. */
  const [voided, setVoided] = useState<{ reason: string; releasedVoucherIds: string[] } | null>(
    null,
  );
  const [showVoid, setShowVoid] = useState(false);

  // S2-11 — refunds, reprints and the offline note.
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  /** One per dialog: a retry of the same press replays the refund it recorded. */
  const [refundActionId, setRefundActionId] = useState('');
  const [justRefunded, setJustRefunded] = useState<ApiRefund | null>(null);
  const [reprintOpen, setReprintOpen] = useState(false);
  const [reprintBusy, setReprintBusy] = useState(false);
  const [flash, setFlash] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);
  /** Who made each reprint on this screen — the fallback until the read carries `requestedByName` (SCRUM-208). */
  const [madeBy, setMadeBy] = useState<Record<string, string>>({});
  const [requests, setRequests] = useState<RefundRequestNote[]>([]);
  /** The station's box is working without the cloud (`/me/station/link`), or a press found it so. */
  const [stationOffline, setStationOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setVoided(null);
    setShowVoid(false);
    setJustRefunded(null);
    setFlash(null);
    setMadeBy({});
    setRequests(refundRequestsFor(txn.id));
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

  /**
   * Whether the station is offline, asked once when a sale opens: a box taken
   * offline in the Console is a station the platform refuses to change a sale
   * at, and the Refund button says "online only" before anybody presses it. A
   * deployment without the route, or no answer, says nothing — the press finds
   * out, and the dialog turns to the note then.
   */
  useEffect(() => {
    let cancelled = false;
    stationLinkApi
      .read()
      .then((link) => {
        if (!cancelled) setStationOffline(link.offline);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [txn.id]);

  /** Read the sale again after it changed here, without blanking the screen. */
  const refresh = useCallback(() => {
    getSale(txn.id)
      .then(setDetail)
      .catch(() => undefined);
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
   * Where the sale stands NOW: the detail is read when it opens, so a sale paid,
   * voided or refunded at a till since the list loaded says so here; a void or
   * a refund made on this screen says so at once.
   */
  const status = voided ? 'voided' : (detail?.sale.status ?? sale.status);
  /** The money as the platform holds it now — the detail's, once read; a refund here moves it. */
  const totals = detail?.sale.totals ?? sale.totals;
  const badge: BadgeStatus =
    status === 'voided'
      ? 'voided'
      : status === 'tendering'
        ? 'unpaid'
        : totals.refundedSatang > 0
          ? totals.refundedSatang >= totals.grossSatang
            ? 'refunded'
            : 'partially_refunded'
          : 'paid';
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
  /**
   * THE VOID ON THIS SALE, from whichever side knows it (SCRUM-430): the one
   * this screen just made, by this account and with the reason it was given;
   * else the one the ledger's read carries, when it does — a sale voided at
   * its till, from a voucher refusal's offer, or on another screen — with the
   * voider's name where the read gives one.
   */
  const voidRecord = voided
    ? { reason: voided.reason, at: null, byName: operator?.name ?? 'you' }
    : status === 'voided'
      ? {
          reason: detail?.sale.voidReason ?? sale.voidReason ?? null,
          at: detail?.sale.voidedAt ?? sale.voidedAt ?? null,
          byName: detail?.sale.voidedByName ?? sale.voidedByName ?? null,
        }
      : null;
  /**
   * WHETHER THE SALE HELD A VOUCHER, for the one clause of the void note that
   * is about it. The ledger does not flag a voucher's discount row — it is a
   * `promo` row like a park code's — and what tells them apart is the label
   * the platform writes on it (`isVoucherDiscount`, api/history.ts). A void
   * made here also answers with the vouchers it let go, and that is read too,
   * so the clause is right on a deployment whose labels predate the rule.
   */
  const voucherHeld =
    (detail?.discounts ?? []).some(isVoucherDiscount) ||
    (voided !== null && voided.releasedVoucherIds.length > 0);
  const tierClaim = detail?.sale.tierClaim ?? sale.tierClaim ?? null;
  const taxTotal = totals.taxInclusiveSatang + totals.taxExclusiveSatang;
  const taxName =
    detail?.taxBreakdown?.categories?.find((c) => c.taxName)?.taxName ?? 'VAT';

  // --- S2-11: refunds, reprints and the offline note ---------------------------

  /**
   * A CLOSED SALE, the only kind with anything to refund or reprint — the
   * platform refuses both otherwise (`SALE_NOT_FINALISED`). `refunded` is a
   * closed sale refunded in full; it can still be reprinted.
   */
  const closed = detail !== null && (status === 'finalised' || status === 'refunded');
  const remainingSatang = refundRemainingSatang(detail, totals);
  const mayRefund = can('pos:refund:create');
  const mayReprint = can('pos:print:reprint');
  /**
   * OFFLINE, AS FAR AS THIS SCREEN CAN TELL: the browser has no network, the
   * till was unlocked offline, the station's box is working alone, or a press
   * just now got no answer or the platform's offline refusal. Refunds are
   * online only, so offline the dialog notes the request instead.
   */
  const offline = browserOffline() || offlineUnlock !== null || stationOffline;
  const refundOptions = detail
    ? refundItemOptions(detail, (line) => packageName(line.ticketPackageId))
    : [];
  const reprintItems = detail && closed ? reprintOptions(detail, txn.kind) : [];
  /**
   * The hint under the refund amount (`RefundModal`'s `refundMode`). Only said
   * where it is certain: a sale paid in cash alone is handed back in cash. A
   * card or QR payment goes back through the terminal or the gateway only for
   * the whole of it — a part is handed back in cash — so for those the refund's
   * own record says how the money went, rather than a promise made here first.
   */
  const takenMethods = attempts
    .filter((a) => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status))
    .map((a) => a.method);
  const refundHint =
    takenMethods.length > 0 && takenMethods.every((m) => m === 'cash') ? ('manual' as const) : undefined;

  const openRefund = () => {
    setRefundError(null);
    setRefundActionId(newActionId());
    setFlash(null);
    setRefundOpen(true);
  };

  const confirmRefund = async (result: RefundResult) => {
    if (!detail) return;
    const mode: RefundMode =
      result.mode === 'item' ? 'items' : result.mode === 'custom' ? 'custom' : 'whole';
    const amountSatang = result.amountSatang ?? Math.round(result.amountTHB * 100);
    const reason = result.reason.trim();
    if (offline) {
      const kept = queueRefundRequest({
        id: newActionId(),
        saleId: sale.id,
        receiptNumber: sale.receiptNumber,
        mode,
        amountSatang,
        reason,
        note: result.note ?? null,
        requestedBy: operator?.name ?? 'Unknown',
        requestedAt: new Date().toISOString(),
      });
      if (!kept) {
        setRefundError(
          'This till could not keep the note — write the request down and make the refund once the station is back online.',
        );
        return;
      }
      setRequests(refundRequestsFor(sale.id));
      setRefundOpen(false);
      setFlash({ text: 'Refund request noted on this till — nothing has been refunded yet', tone: 'ok' });
      return;
    }
    const lineIds =
      mode === 'items'
        ? refundOptions
            .filter((option) => result.lineIds?.includes(option.id))
            .flatMap((option) => option.lineIds)
        : undefined;
    setRefundBusy(true);
    setRefundError(null);
    try {
      const answer = await refundSale(sale.id, {
        mode,
        ...(lineIds ? { lineIds } : {}),
        ...(mode === 'custom' ? { amountSatang } : {}),
        reason,
        note: result.note ?? null,
        actionId: refundActionId || newActionId(),
      });
      clearRefundRequests(sale.id);
      setRequests([]);
      setJustRefunded(answer.refund);
      setRefundOpen(false);
      refresh();
      onRefunded?.(sale.id, answer.sale);
    } catch (err) {
      if (err instanceof NetworkError || (err instanceof ApiError && err.code === 'STATION_FORCED_OFFLINE')) {
        // Refunds are online only: the dialog turns to the note.
        setStationOffline(true);
        setRefundError(
          err instanceof ApiError
            ? `${err.message} Refunds are online only — you can note the request on this till instead.`
            : 'No connection to the platform, so nothing was refunded. Refunds are online only — you can note the request on this till instead.',
        );
      } else {
        setRefundError(err instanceof Error ? err.message : 'The refund could not be recorded.');
      }
    } finally {
      setRefundBusy(false);
    }
  };

  const confirmReprint = async (labels: string[], ids: string[]) => {
    const kinds = ids.filter((id): id is SaleReprintKind =>
      (SALE_REPRINT_KINDS as readonly string[]).includes(id),
    );
    if (kinds.length === 0) return;
    setReprintBusy(true);
    setFlash(null);
    const jobs: ApiSalePrintJob[] = [];
    const notes: string[] = [];
    const refused: string[] = [];
    for (const reprintKind of kinds) {
      try {
        const answer = await reprintSale(sale.id, reprintKind, newActionId());
        jobs.push(...answer.jobs);
        notes.push(...answer.notes);
      } catch (err) {
        refused.push(
          err instanceof NetworkError
            ? 'No connection to the platform, so nothing was sent to the printer.'
            : err instanceof Error
              ? err.message
              : 'The reprint could not be sent.',
        );
      }
    }
    setReprintBusy(false);
    if (jobs.length > 0 || notes.length > 0) dispatchPlatformPrinting(jobs, notes);
    if (jobs.length > 0 && operator?.name) {
      const name = operator.name;
      setMadeBy((prev) => ({ ...prev, ...Object.fromEntries(jobs.map((j) => [j.id, name])) }));
    }
    const sent = kinds.length - refused.length;
    setFlash(
      refused.length > 0
        ? { text: [...new Set(refused)].join(' '), tone: 'bad' }
        : { text: `Sent ${labels.length} item${labels.length > 1 ? 's' : ''} to the printer`, tone: 'ok' },
    );
    if (sent > 0) refresh();
  };

  const newSale = () =>
    setLocation(txn.kind === 'merch' ? '/merch-station' : txn.kind === 'fnb' ? '/order-station' : '/');

  const bands = (detail?.bands ?? []).filter((b) => b.status !== 'revoked');
  const kidBands = bands.filter((b) => b.kind === 'kid');
  const adultBands = bands.filter((b) => b.kind === 'adult');

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

  /**
   * THE PROTOTYPE'S ISSUED SUMMARY (`TransactionDetail.tsx`, "Bracelets
   * printed"), from the platform's bands — with their short codes, which are
   * what staff read out or type into the search when paper fails. And, for an
   * F&B order, the pick-up ticket's code.
   */
  const issued =
    bands.length > 0 ? (
      <div className="shrink-0 mt-4 rounded-xl border bg-background/40 p-4" data-testid="bracelets-printed">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
          <Users className="w-4 h-4" />
          Bracelets printed
        </div>
        <div className="flex items-end justify-between gap-3">
          <span className="text-4xl font-black tabular-nums leading-none">{bands.length}</span>
          <div className="text-sm text-muted-foreground text-right leading-snug">
            {kidBands.length > 0 && <div>{kidBands.length} child</div>}
            {adultBands.length > 0 && <div>{adultBands.length} adult</div>}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
          {bands.map((b) => (
            <span key={b.id} className="whitespace-nowrap">
              <span className="font-mono font-semibold">{b.shortCode ?? 'No code'}</span>
              {b.childName && <span className="text-muted-foreground"> {b.childName}</span>}
            </span>
          ))}
        </div>
      </div>
    ) : detail?.pickupCode && txn.kind === 'fnb' ? (
      <div className="shrink-0 mt-4 rounded-xl border bg-background/40 p-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          <GlassWater className="w-4 h-4" />
          Pickup ticket
        </div>
        <span className="text-2xl font-black tabular-nums">#{detail.pickupCode}</span>
      </div>
    ) : null;

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

          {issued}
        </Card>

        {/* Right: money + refunds + actions */}
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
                    <DiscountLabel discount={d} />
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
                  <PaymentRow key={attempt.id} attempt={attempt} sale={sale} fmt={fmt} />
                ))}
              </div>
            </Card>
          )}

          {/* S2-11 — the prototype's refund and reprint histories, and the
              refunds asked for while the station was offline. */}
          <RefundRequests
            requests={requests}
            fmt={fmt}
            onClear={() => {
              clearRefundRequests(sale.id);
              setRequests([]);
            }}
          />
          <RefundHistory refunds={detail?.refunds ?? []} fmt={fmt} />
          <ReprintHistory
            jobs={detail?.printJobs ?? []}
            bands={detail?.bands ?? []}
            madeBy={madeBy}
            fmt={fmt}
          />

          {/* Flash confirmation for a reprint or a noted request */}
          {flash && (
            <div
              className={`shrink-0 rounded-lg border p-3 text-sm font-medium flex items-center gap-2 ${
                flash.tone === 'ok'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : 'border-destructive/40 bg-destructive/10 text-destructive'
              }`}
              role={flash.tone === 'bad' ? 'alert' : undefined}
            >
              {flash.tone === 'ok' ? (
                <Check className="w-4 h-4 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0" />
              )}
              {flash.text}
            </div>
          )}

          {/* Actions — every one of these changes a recorded sale. A closed sale
              can be reprinted and refunded (S2-11); Add time stays disabled
              until paid extensions exist; an unpaid sale that took no money can
              be voided, in Refund's place; a voided sale has nothing to refund
              and shows neither (SCRUM-430). */}
          {justRefunded ? (
            <Card className="p-4 bg-card/50 space-y-2" data-testid="refund-recorded">
              <div className="text-sm font-semibold flex items-center gap-2 text-emerald-400">
                <Check className="w-4 h-4" />
                Refund recorded · {justRefunded.number} · −฿{baht(justRefunded.amountSatang)}
              </div>
              {justRefunded.tenderAllocation.map((slice, i) => {
                const words = refundSliceWords(slice);
                return (
                  <div key={i} className={`flex items-start justify-between gap-2 text-sm ${words.tone}`}>
                    <span className="min-w-0">{words.text}</span>
                    <span className="tabular-nums shrink-0">฿{baht(slice.amountSatang)}</span>
                  </div>
                );
              })}
              <Button variant="outline" className="w-full h-12 gap-2" onClick={newSale}>
                <Plus className="w-4 h-4" />
                New sale
              </Button>
              <Button variant="ghost" className="w-full h-12" onClick={onBack}>
                Done
              </Button>
            </Card>
          ) : (
            <div className="shrink-0 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-14 text-base gap-2"
                  disabled={!closed || !mayReprint || reprintBusy || reprintItems.length === 0}
                  title={!mayReprint ? 'Reprinting needs the till’s reprint permission.' : undefined}
                  onClick={() => {
                    setFlash(null);
                    setReprintOpen(true);
                  }}
                  data-testid="reprint-sale"
                >
                  <Printer className="w-5 h-5" />
                  {reprintBusy ? 'Sending…' : 'Reprint'}
                </Button>
                <Button
                  variant="outline"
                  className="h-14 text-base gap-2"
                  disabled
                  title={LEDGER_ONLY_NOTICE}
                >
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
              ) : status === 'voided' ? null : closed && remainingSatang <= 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  Fully refunded — nothing left to refund.
                </div>
              ) : (
                <>
                  <Button
                    className={`w-full h-14 text-lg gap-2 text-white ${
                      offline ? 'bg-amber-600 hover:bg-amber-700' : 'bg-rose-500 hover:bg-rose-600'
                    }`}
                    disabled={!closed || !mayRefund}
                    onClick={openRefund}
                    data-testid="refund-sale"
                  >
                    {offline ? <WifiOff className="w-5 h-5" /> : <Undo2 className="w-5 h-5" />}
                    {!closed
                      ? 'Refund'
                      : offline
                        ? `Refund — online only (฿${baht(remainingSatang)} left)`
                        : `Refund (฿${baht(remainingSatang)} left)`}
                  </Button>
                  {closed && !mayRefund && (
                    <p className="text-sm text-muted-foreground">
                      Refunding a sale needs the till&apos;s refund permission.
                    </p>
                  )}
                </>
              )}
              {voidRecord && (
                <div
                  className="rounded-lg border p-3 text-sm text-muted-foreground flex items-start gap-2"
                  data-testid="sale-voided"
                >
                  <Ban className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{voidSentence(voidRecord, voucherHeld, fmt)}</span>
                </div>
              )}
              <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground flex items-start gap-2">
                <Info className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{LEDGER_ONLY_NOTICE}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <VoidSaleDialog
        open={showVoid}
        onOpenChange={setShowVoid}
        txn={txn}
        stationName={sale.stationName}
        operatorName={operator?.name ?? 'this account'}
        fmt={fmt}
        onVoided={(v) => {
          setVoided(v);
          onVoided?.(sale.id);
        }}
      />

      <RefundModal
        open={refundOpen}
        onOpenChange={setRefundOpen}
        maxRefund={baht(remainingSatang)}
        restorableCredit={baht(restorableCreditSatang(attempts, detail?.refunds ?? []))}
        lines={refundOptions.map((option) => ({
          id: option.id,
          label: option.label,
          amount: baht(option.amountSatang),
        }))}
        reasons={getDiscountReasons()}
        operatorName={operator?.name ?? 'this account'}
        {...(refundHint ? { refundMode: refundHint } : {})}
        onConfirm={(result) => void confirmRefund(result)}
        closeOnConfirm={false}
        busy={refundBusy}
        error={refundError}
        offline={offline}
      />

      <ReprintModal
        open={reprintOpen}
        onOpenChange={setReprintOpen}
        items={reprintItems.map((option) => ({
          id: option.kind,
          label: option.label,
          ...(option.sublabel ? { sublabel: option.sublabel } : {}),
        }))}
        operatorName={operator?.name ?? 'this account'}
        onConfirm={(labels, ids) => void confirmReprint(labels, ids)}
      />
    </div>
  );
}
