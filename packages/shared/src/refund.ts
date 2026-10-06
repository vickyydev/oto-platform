/**
 * Refunds (S2-11): the rules, as pure functions the API and the till share.
 *
 * Ported from the prototype, `imports/oto-pos/artifacts/oto-till/src/`:
 *
 *   `mockApi.ts:recordRefund`          the clamp to what is left, the status
 *                                      walk, and which lines go back to stock
 *   `mockApi.ts:statusForRefunds`      paid → partially_refunded → refunded
 *   `components/history/RefundModal.tsx`  the three modes (whole / by item /
 *                                      custom ฿) and the required reason
 *   `lib/payments.ts:refundModeForMethod` card and QR go back to source, cash
 *                                      and anything else is handed back
 *
 * What the prototype did NOT have, and the plan adds (S2-11, recorded): the
 * allocation order wallet → same tender → cash, and the routes a tender's
 * adapter can actually take. The prototype's "auto" was a label on the screen;
 * here it is which machine is asked to hand the money back.
 */

import type { Satang } from './money';

export const REFUND_MODES = ['whole', 'items', 'custom'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

/**
 * How one slice of a refund goes back to the guest.
 *
 *   wallet          onto the wallet it was spent from. There are no wallets
 *                   until S2-14a, which applies these; the slice waits.
 *   cash            handed back from the drawer, at once.
 *   terminal_void   the card terminal voids the original transaction. Only a
 *                   WHOLE card tender, and only inside the terminal's void
 *                   window — which only the terminal knows (its clock, its
 *                   settlement), so the answer arrives from the box. Refused
 *                   → the slice falls back to cash.
 *   gateway_refund  `QrPayment.refund` at the payment gateway: a void before
 *                   the acquirer's cut-off, a refund after it.
 *   manual          the original instrument was taken outside the platform (a
 *                   slip typed in from a standalone terminal); staff reverse it
 *                   there. Recorded, not performed.
 */
export const REFUND_ROUTES = ['wallet', 'cash', 'terminal_void', 'gateway_refund', 'manual'] as const;
export type RefundRoute = (typeof REFUND_ROUTES)[number];

/**
 * Where a slice stands.
 *
 *   done     the money is back (cash handed over, void approved, gateway success).
 *   pending  waiting on a terminal's answer, the gateway, or the wallet ticket.
 *   failed   the reversal was refused. `fallback: 'cash'` says what staff do.
 */
export const REFUND_SLICE_STATUSES = ['done', 'pending', 'failed'] as const;
export type RefundSliceStatus = (typeof REFUND_SLICE_STATUSES)[number];

/** One slice of a refund's money, as `pos.refund.tender_allocation` stores it. */
export interface RefundAllocationEntry {
  /** The payment attempt this goes back through; null for a cash remainder with none. */
  attemptId: string | null;
  /** The ledger word for the money: cash, card, qr, wallet, voucher, transfer. */
  method: string;
  /** The park's own token for the tender, as the attempt recorded it. */
  methodCode: string | null;
  provider: string | null;
  route: RefundRoute;
  amountSatang: Satang;
  status: RefundSliceStatus;
  /** When a reversal is refused, what the money does instead. */
  fallback?: 'cash' | null;
  /** The terminal void's action id, so the box's answer finds this slice. */
  actionId?: string | null;
  /** The gateway's process type: `V` void before cut-off, `R` refund after. */
  processType?: 'V' | 'R' | null;
  /** The provider's reference for the reversal, when it gave one. */
  providerRef?: string | null;
  /** The provider's answer code, e.g. `00`, `4121`. Never a card number. */
  respCode?: string | null;
  /** A short sentence for the History detail. */
  detail?: string | null;
  settledAt?: string | null;
}

/** One sale line a refund covers, as `pos.refund.lines` stores it. */
export interface RefundLineEntry {
  saleLineId: string;
  label: string;
  quantity: number;
  grossSatang: Satang;
  /** Whether this refund returns the line's units to stock (applied by S2-14b). */
  restock: boolean;
  /**
   * The line is named only because this full-scope refund returned its units
   * to stock: its money went back on an earlier refund, or on this refund's
   * custom amount. `grossSatang` is 0 on such an entry.
   */
  restockOnly?: boolean;
}

/** A tender that took money on the sale, classified by what can reverse it. */
export interface RefundableTender {
  attemptId: string;
  method: string;
  methodCode: string | null;
  provider: string | null;
  /**
   * Which machinery took it:
   *   cash      the drawer;
   *   wallet    a wallet spend;
   *   terminal  an EDC on the box — `terminalTender` says card, QR or wallet;
   *   gateway   the payment gateway's QR;
   *   manual    anything recorded by hand.
   */
  channel: 'cash' | 'wallet' | 'terminal' | 'gateway' | 'manual';
  terminalTender?: 'card' | 'qr' | 'wallet' | null;
  /** What the attempt took. */
  amountSatang: Satang;
  /** What earlier refunds already sent back through it. */
  refundedSatang: Satang;
  /** Newer attempts are reversed first: the last money in is the first out. */
  paidAt: string | null;
}

/** What is left to refund on a sale. Never negative. */
export function refundableSatang(grossSatang: Satang, refundedSatang: Satang): Satang {
  return Math.max(0, grossSatang - refundedSatang);
}

/**
 * The state a sale's refunds put it in — `statusForRefunds` in the prototype.
 * The ledger keeps `finalised` for a partial refund (see `pos.sale`), so this
 * is the word History shows, derived from the running total.
 */
export function refundStatusOf(
  grossSatang: Satang,
  refundedSatang: Satang,
): 'none' | 'partially_refunded' | 'refunded' {
  if (refundedSatang <= 0) return 'none';
  return refundedSatang >= grossSatang ? 'refunded' : 'partially_refunded';
}

/**
 * How much this refund is for — the prototype's clamp, "never refund more than
 * is left", applied whatever the caller asked for.
 *
 *   whole   everything still refundable;
 *   items   the picked lines' gross, clamped;
 *   custom  the amount typed, clamped.
 *
 * `clamped` is true when the request was cut down, so the answer can say so
 * rather than refund a different figure silently.
 */
export function resolveRefundAmount(input: {
  mode: RefundMode;
  remainingSatang: Satang;
  itemsSatang?: Satang;
  customSatang?: Satang;
}): { amountSatang: Satang; requestedSatang: Satang; clamped: boolean } {
  const requested =
    input.mode === 'whole'
      ? input.remainingSatang
      : input.mode === 'items'
        ? (input.itemsSatang ?? 0)
        : (input.customSatang ?? 0);
  const amount = Math.max(0, Math.min(requested, input.remainingSatang));
  return { amountSatang: amount, requestedSatang: requested, clamped: amount !== requested };
}

function routeFor(tender: RefundableTender, slice: Satang): { route: RefundRoute; status: RefundSliceStatus } {
  switch (tender.channel) {
    case 'wallet':
      return { route: 'wallet', status: 'pending' };
    case 'cash':
      return { route: 'cash', status: 'done' };
    case 'gateway':
      return { route: 'gateway_refund', status: 'pending' };
    case 'terminal': {
      // A void is all-or-nothing on both dialects, and Thai QR on a terminal
      // cannot be voided at all (GHL p.15, Digio `333`). So only a whole card
      // or wallet tender, never refunded before, can go back through the
      // terminal; anything else is handed back in cash.
      const whole = tender.refundedSatang === 0 && slice === tender.amountSatang;
      if (whole && tender.terminalTender !== 'qr') return { route: 'terminal_void', status: 'pending' };
      return { route: 'cash', status: 'done' };
    }
    default:
      return { route: 'manual', status: 'done' };
  }
}

/**
 * Split a refund across the tenders that took the money: wallets first, then
 * the same tenders newest-first, then cash for anything left (a sale whose
 * tenders do not cover its gross — a ฿0 comp's voucher, say).
 *
 * Each tender gives back at most what it took less what earlier refunds sent
 * back through it, so two partial refunds of one sale can never send more
 * through one card than the card paid.
 */
export function allocateRefund(
  amountSatang: Satang,
  tenders: readonly RefundableTender[],
): RefundAllocationEntry[] {
  const entries: RefundAllocationEntry[] = [];
  let left = amountSatang;
  const newestFirst = [...tenders].sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''));
  const ordered = [
    ...newestFirst.filter((t) => t.channel === 'wallet'),
    ...newestFirst.filter((t) => t.channel !== 'wallet'),
  ];
  for (const tender of ordered) {
    if (left <= 0) break;
    const available = Math.max(0, tender.amountSatang - tender.refundedSatang);
    const slice = Math.min(left, available);
    if (slice <= 0) continue;
    const { route, status } = routeFor(tender, slice);
    entries.push({
      attemptId: tender.attemptId,
      method: tender.method,
      methodCode: tender.methodCode,
      provider: tender.provider,
      route,
      amountSatang: slice,
      status,
    });
    left -= slice;
  }
  if (left > 0) {
    entries.push({
      attemptId: null,
      method: 'cash',
      methodCode: null,
      provider: null,
      route: 'cash',
      amountSatang: left,
      status: 'done',
    });
  }
  return entries;
}

/**
 * A refund's scope, as the approved design's RefundModal derives it: `full`
 * whenever the (clamped) amount reaches what is left to refund, in ANY mode —
 * a custom amount or a pick of lines that empties the sale is as full as the
 * whole-sale button.
 */
export function refundScopeOf(amountSatang: Satang, remainingSatang: Satang): 'full' | 'partial' {
  return amountSatang >= remainingSatang ? 'full' : 'partial';
}

/**
 * Which lines this refund returns to stock (`mockApi.ts:recordRefund`):
 *
 *   - a SHOP by-item refund returns exactly the lines it picks, as it is made,
 *     even when it empties the sale;
 *   - any other FULL-scope refund (`refundScopeOf`), the first one, returns
 *     every line — including the lines an earlier partial refund covered
 *     without returning;
 *   - a partial ticket or F&B refund, and a partial custom amount, return
 *     nothing: they do not map back to specific units.
 *
 * Never a line already returned: `alreadyRestocked` holds what earlier refunds
 * put back.
 */
export function restockLineIds(input: {
  saleKind: 'ticket' | 'fnb' | 'merch';
  mode: RefundMode;
  scope: 'full' | 'partial';
  coveredLineIds: readonly string[];
  allLineIds: readonly string[];
  alreadyRestocked: ReadonlySet<string>;
  /** An earlier refund of this sale was already full-scope. */
  earlierFullScope: boolean;
}): string[] {
  const fresh = (ids: readonly string[]) => ids.filter((id) => !input.alreadyRestocked.has(id));
  // A shop by-item pick restocks exactly its picked lines, even when it empties
  // the sale: lines the customer kept never go back on the shelf.
  if (input.saleKind === 'merch' && input.mode === 'items') return fresh(input.coveredLineIds);
  if (input.scope === 'full' && !input.earlierFullScope) return fresh(input.allLineIds);
  return [];
}
