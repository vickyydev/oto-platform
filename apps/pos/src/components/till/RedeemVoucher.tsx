import { useState } from 'react';
import { boothStaffLabel } from '@oto/shared';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Gift, ShieldX, Ticket, Trash2, X } from 'lucide-react';
import type { VoucherView } from '@/api/vouchers';
import type { QuotedVoucher } from '@/api/sales';
import {
  formatVoucherStamp,
  type HeldVoucher,
  type VoucherRefusal,
} from '@/lib/tillVoucher';

/**
 * S2-10b (SCRUM-207) — THE LUCKY WHEEL VOUCHER IN THE ORDER PANEL.
 *
 * Five pieces, each in the panel's own clothes and nothing new:
 *
 *   - the Redeem voucher entry — the promo code box's row, field and button,
 *     directly under it (`components/till/OrderSummary.tsx`): a code typed
 *     off the slip, the owner's fallback while there is no scanner;
 *   - the voucher card — the applied-code row's emerald, carrying what the
 *     voucher is and what to hand over or take off, in the platform's words,
 *     with where and when it was printed, by whom, and until when it is good;
 *   - the free item's line — the prototype's own free-item row (Gift, ฿0), for
 *     the item a voucher puts on the bill;
 *   - the refusal — the panel's notice box, in the promo box's rose, with the
 *     platform's own sentence (`TillRefusalNotice`, which also says why the
 *     till's Cancel could not void a sale);
 *   - the used note — one emerald line on the confirmation.
 *
 * None of them decides anything. What a voucher is, what it is worth and
 * whether it can be used are the platform's answers (`lib/tillVoucher.ts`).
 */

/** Booth, when printed and until when — as the lookup answered. */
export function voucherProvenance(view: VoucherView): string[] {
  const parts: string[] = [];
  if (view.issuedBooth) parts.push(view.issuedBooth.name);
  parts.push(`printed ${formatVoucherStamp(view.issuedAt, { time: true })}`);
  parts.push(view.expiresAt ? `valid until ${formatVoucherStamp(view.expiresAt)}` : 'never expires');
  return parts;
}

/**
 * Who was signed in at the booth when it printed, named the way the slip's
 * Staff line names them (`boothStaffLabel`: "Nok (S-7KMQ)") so the counter can
 * hold the card against the paper. A spin with nobody signed in still printed
 * — a login problem never stops the wheel — and the card says so rather than
 * leaving the line out.
 */
export function voucherPrintedBy(view: VoucherView): string {
  const who = view.issuedBy ? boothStaffLabel(view.issuedBy.name, view.issuedBy.code) : null;
  return who ? `Printed by ${who}` : 'Printed by: unattributed';
}

/** Whole baht, as the panel prints every other figure. */
const baht = (satang: number): string => `฿${Math.round(satang) / 100}`;

interface RedeemVoucherEntryProps {
  /** Resolves true when the voucher went on the cart — the field is then cleared. */
  onRedeem: (code: string) => Promise<boolean>;
  busy?: boolean;
  disabled?: boolean;
}

/** The typed entry, under the promo code box and built like it. */
export function RedeemVoucherEntry({ onRedeem, busy, disabled }: RedeemVoucherEntryProps) {
  const [input, setInput] = useState('');
  const redeem = () => {
    const code = input.trim();
    if (!code || busy || disabled) return;
    void onRedeem(code).then((held) => {
      if (held) setInput('');
    });
  };
  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') redeem();
        }}
        placeholder="Voucher code…"
        aria-label="Redeem voucher"
        autoComplete="off"
        spellCheck={false}
        className="flex-1 h-9 rounded-xl border border-foreground/10 bg-black/20 px-3 text-sm font-mono uppercase tracking-wide placeholder:normal-case placeholder:tracking-normal text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
        disabled={disabled}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-9 px-3 shrink-0"
        disabled={disabled || busy || !input.trim()}
        onClick={redeem}
      >
        {busy ? 'Checking…' : 'Redeem'}
      </Button>
    </div>
  );
}

interface VoucherCardProps {
  held: HeldVoucher;
  /** The quote's answer for this voucher; null while the platform has not priced it. */
  quoted: QuotedVoucher | null;
  busy?: boolean;
  /** Absent once the sale is rung up: the voucher then goes only with a void. */
  onRemove?: () => void;
  /**
   * Why the platform's figure is not on the card: the platform's own refusal
   * of the quote in its words, or — only when the till is offline or nothing
   * answered — that it could not be asked. A voucher's value is only ever the
   * platform's, so the card never guesses one.
   */
  note?: string | null;
}

/** The held voucher: what it is, what it does to this sale, where it came from. */
export function VoucherCard({ held, quoted, busy, onRemove, note }: VoucherCardProps) {
  const { view } = held;
  const effect = view.effect.type;
  // A free item and a hand-over prize take nothing off the bill; the others do,
  // and the figure is the platform's own for this cart.
  const takesOff =
    effect === 'amount_off' || effect === 'percent_off' || effect === 'free_kids_ticket';
  const figure = !takesOff
    ? effect === 'free_item'
      ? 'Free'
      : 'Hand over'
    : quoted
      ? quoted.applicable
        ? `-${baht(quoted.amountSatang)}`
        : '—'
      : '…';
  return (
    <div className="text-emerald-500 bg-emerald-500/10 p-3 rounded-lg" data-testid="voucher-card">
      <div className="flex justify-between items-start gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <Ticket className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium leading-tight">{view.prize.nameEn}</div>
            <div className="text-sm text-emerald-400 leading-snug">{view.summary}</div>
            <div className="text-xs text-emerald-500/70 font-mono">
              {held.code} · Lucky Wheel voucher
            </div>
            <div className="text-xs text-emerald-500/70 leading-snug">
              {voucherProvenance(view).join(' · ')}
            </div>
            <div className="text-xs text-emerald-500/70 leading-snug" data-testid="voucher-printed-by">
              {voucherPrintedBy(view)}
            </div>
            {quoted && !quoted.applicable && quoted.reason && (
              <div className="text-xs text-amber-400 leading-snug mt-0.5">{quoted.reason}</div>
            )}
            {!quoted && note && (
              <div className="text-xs text-amber-400 leading-snug mt-0.5">{note}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-bold tabular-nums">{figure}</span>
          {onRemove && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-emerald-500 hover:bg-emerald-500/20 hover:text-emerald-600"
              onClick={onRemove}
              disabled={busy}
              aria-label="Remove voucher"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The item a free-item voucher puts on the bill, as a cart line — the
 * prototype's free-item row: the item, the code it came from, ฿0 to pay.
 */
export function VoucherFreeItemLine({ held }: { held: HeldVoucher }) {
  const { effect } = held.view;
  if (effect.type !== 'free_item') return null;
  return (
    <div className="p-3 rounded-xl bg-card border" data-testid="voucher-free-item">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2 min-w-0">
          <Gift className="w-4 h-4 text-emerald-400 shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold text-emerald-300 leading-tight truncate">
              {effect.product.name}
            </div>
            <div className="text-xs text-emerald-400/70 font-mono">{held.code} · Voucher</div>
          </div>
        </div>
        <span className="font-bold text-emerald-300 shrink-0">฿0</span>
      </div>
    </div>
  );
}

/** A voucher that did not go on the cart, and the platform's reason why. */
export function VoucherRefusalCard({
  refusal,
  onDismiss,
}: {
  refusal: VoucherRefusal;
  onDismiss: () => void;
}) {
  return (
    <TillRefusalNotice
      message={refusal.message}
      detail={refusal.voucherCode || null}
      onDismiss={onDismiss}
      testId="voucher-refusal"
    />
  );
}

/**
 * The panel's rose notice: something the platform said no to, in its words.
 * The voucher's refusal, and the till's Cancel refused — a sale that has taken
 * money is refunded, not voided — so the sale stays on screen and says why.
 */
export function TillRefusalNotice({
  message,
  detail,
  onDismiss,
  testId,
}: {
  message: string;
  /** A second line in the code face — the voucher's code, where there is one. */
  detail?: string | null;
  onDismiss: () => void;
  testId: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-300"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <ShieldX className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold text-sm leading-snug">{message}</div>
            {detail && <div className="text-xs font-mono text-rose-300/70">{detail}</div>}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

/** On the confirmation: the voucher the payment used up. */
export function VoucherUsedNote({ held }: { held: HeldVoucher }) {
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full bg-emerald-500/15 px-4 py-1.5 text-sm font-semibold text-emerald-500"
      data-testid="voucher-used"
    >
      <CheckCircle2 className="w-4 h-4 shrink-0" />
      <span>
        Voucher <span className="font-mono">{held.code}</span> used · {held.view.summary}
      </span>
    </div>
  );
}
