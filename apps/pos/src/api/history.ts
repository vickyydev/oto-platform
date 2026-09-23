// The Order History page's read of the sale ledger — SCRUM-238.
//
// WHY THIS FILE EXISTS. History rendered eight sample transactions out of
// `mockApi` (#D9N4T7, #A4K2P9, dated 14–15 June) while the platform held the
// park's real sales for the same counter. Everything the page needs is in
// `GET /sales` and `GET /sales/:id`; what was missing was the translation
// between the ledger's vocabulary (satang, uuids, `finalised`, line kinds) and
// the prototype's (`TxnSummary`: baht, a receipt number, one of three badges).
// That translation lives here, in one place, so the components keep rendering
// exactly what they always rendered.
//
// It is deliberately NOT in `api/sales.ts`: that file is the till's write path
// — quote, commit, tender — and this is a read a different screen makes.
//
// WHAT THE LEDGER CANNOT ANSWER YET. There are no wristband codes on a sale or
// its lines (`wristband` is still the Sprint 1 placeholder table; bands are
// minted and printed in S2-11 / SCRUM-208), so `wristbandCode` is left unset
// rather than invented, and the page's "Scan bracelet" path has nothing to read.
// Nor is there a booking reference on a sale: a redemption links the booking to
// the visit, not to the money, so `bookingReference` stays unset too.
import type { PaymentAttemptView } from '@oto/shared';
import { api } from './client';
import type { TxnKind, TxnStatus, TxnSummary } from '@/types';

export type { PaymentAttemptView };

/** The ledger's own words for where a sale has got to. */
export type LedgerStatus = 'tendering' | 'paid' | 'finalised' | 'voided' | 'refunded';

/**
 * What the card's badge shows. The prototype knows three states, all of which
 * assume the money was taken; the ledger has two more — an order rung up and
 * never paid for, and one that was voided — and calling either of those "Paid"
 * would be the same kind of lie as the sample data this ticket removes.
 */
export type BadgeStatus = TxnStatus | 'unpaid' | 'voided';

export interface ApiSaleTotals {
  subtotalSatang: number;
  manualDiscountSatang: number;
  promoDiscountSatang: number;
  discountSatang: number;
  netSatang: number;
  serviceChargeSatang: number;
  taxInclusiveSatang: number;
  taxExclusiveSatang: number;
  grossSatang: number;
  unappliedDiscountSatang: number;
  refundedSatang: number;
}

/**
 * THE DOCUMENT CHECK A SALE WAS PRICED ON — SCRUM-333.
 *
 * Null on almost every sale: it is set only where a visitor who was not yet a
 * member had a passport or a residence certificate checked at the counter, and
 * that check chose the rate (SCRUM-307 / SCRUM-311). There is no document
 * number and no part of one — the platform's claim row records the KIND of
 * document and its expiry and nothing that identifies it — so the drawer names
 * what was checked and when, which is what makes the rate defensible.
 */
export interface ApiSaleTierClaim {
  id: string;
  /** "Passport", "Residence certificate". A kind, never a number. */
  documentKind: string;
  /** The tier the document supported — the one this sale was charged at. */
  toTier: string;
  /** The document's own expiry as the check recorded it (`YYYY-MM-DD`). */
  evidenceExpiresOn: string;
  /** When reception checked it. */
  verifiedAt: string;
}

export interface ApiSale {
  id: string;
  branchId: string;
  stationId: string;
  memberId: string | null;
  visitId: string | null;
  businessDate: string;
  occurredAt: string;
  status: LedgerStatus;
  pricingMode: string;
  pricingModeReason: string;
  customerTier: string;
  /**
   * Optional because a deployment that has not taken SCRUM-333 yet answers
   * without it, and a drawer that read `undefined.documentKind` would take the
   * whole sale down rather than simply not show the line.
   */
  tierClaim?: ApiSaleTierClaim | null;
  receiptNumber: string | null;
  receiptSeries: string | null;
  receiptSeq: number | null;
  finalisedAt: string | null;
  note: string | null;
  totals: ApiSaleTotals;
}

/** A sale as the LIST answers it — the row plus the names a card shows. */
export interface ApiSaleListItem extends ApiSale {
  soldBy: { accountId: string; name: string | null } | null;
  stationName: string | null;
  member: { id: string; name: string | null; nickname: string; phone: string } | null;
  lineKinds: string[];
  revenueCategories: string[];
}

export interface ApiSaleLine {
  id: string;
  lineNo: number;
  /** The till's cart line this unit came from — what the detail groups by. */
  cartLineId: string;
  kind: string;
  componentKey: string | null;
  ticketPackageId: string | null;
  label: string;
  revenueCategory: string | null;
  taxableCategory: string;
  quantity: number;
  unitSatang: number;
  baseSatang: number;
  discountSatang: number;
  netSatang: number;
  serviceChargeSatang: number;
  taxSatang: number;
  taxMode: string;
  taxRateBp: number;
  taxName: string | null;
  grossSatang: number;
  customerTier: string;
  kidCount: number;
  adultCount: number;
  freeAdultCount: number;
  stayHours: number | null;
  stayDurationLabel: string | null;
}

export interface ApiSaleDiscount {
  id: string;
  kind: string;
  discountType: string;
  percentBp: number | null;
  amountSatang: number;
  targetLabel: string | null;
  code: string | null;
  label: string | null;
  reason: string | null;
  note: string | null;
  appliedByName: string | null;
}

export interface ApiSaleDetail {
  sale: ApiSale;
  taxBreakdown: { categories?: { category: string; tax: number; serviceCharge: number; taxName?: string | null }[] } | null;
  lines: ApiSaleLine[];
  discounts: ApiSaleDiscount[];
  /**
   * HOW THE MONEY WAS TAKEN — S2-10a, and the thing this page could not show
   * before.
   *
   * Every attempt against the sale, in the order they were taken, including
   * the ones that failed: a declined card followed by cash is the evening as
   * it happened, and a detail showing only the cash is what makes a guest's
   * complaint unanswerable. The shape is the platform's own
   * (`PaymentAttemptView` in `@oto/shared`) rather than a copy of it here, so
   * a field added to the ledger cannot quietly stop reaching this screen.
   *
   * Optional on the wire: a deployment older than S2-10a answers without it,
   * and History has to keep opening sales on that deployment.
   */
  attempts?: PaymentAttemptView[];
}

/**
 * A ledger sale in the shape every History component already renders, with the
 * platform row kept alongside so the detail view reads the real thing.
 */
export interface HistoryTxn extends TxnSummary {
  ledger: ApiSaleListItem;
  badge: BadgeStatus;
}

/** Satang → baht. The whole ported UI thinks in baht (`api/mappers.ts`). */
export const baht = (satang: number): number => satang / 100;

/**
 * Which of the prototype's three kinds this sale is, read off its LINES.
 *
 * A sale row has no kind of its own, and it should not: one cart can carry
 * admission, an ice cream and a drop-off fee. The lines say what was sold, so
 * the ticket lines win where there are any — that is what the guest came for,
 * and it is how the card's icon and the page's Tickets / F&B tabs read.
 */
export function kindOf(sale: ApiSaleListItem): TxnKind {
  const kinds = new Set(sale.lineKinds);
  const areas = new Set(sale.revenueCategories);
  if (kinds.has('kids') || kinds.has('adults_paid') || kinds.has('adults_free') || areas.has('tickets')) {
    return 'ticket';
  }
  if (areas.has('fnb') || areas.has('bar') || kinds.has('fnb_item')) return 'fnb';
  if (areas.has('merch') || kinds.has('merch_item')) return 'merch';
  // Socks, a locker, a drop-off fee on their own: an admission-desk sale.
  return 'ticket';
}

/** A drop-off / nanny charge — the baby icon and tint on the card. */
export function isDropOff(sale: ApiSaleListItem): boolean {
  return sale.lineKinds.includes('service_fee') || sale.revenueCategories.includes('drop_off');
}

/** What the badge says, refunds included. */
export function badgeOf(sale: ApiSaleListItem): BadgeStatus {
  if (sale.status === 'voided') return 'voided';
  if (sale.status === 'tendering') return 'unpaid';
  const refunded = sale.totals.refundedSatang;
  if (refunded > 0 && refunded >= sale.totals.grossSatang) return 'refunded';
  if (refunded > 0) return 'partially_refunded';
  return 'paid';
}

/**
 * The receipt number is the sale's visible id — never the uuid, which is a
 * database key and means nothing to anybody holding a paper receipt. A sale
 * rung up and not yet paid for has no number, because the number is allocated
 * when the money is taken, so it says that rather than showing something that
 * looks like one.
 */
export function referenceOf(sale: ApiSale): string {
  return sale.receiptNumber ?? 'No receipt number';
}

/** One ledger sale as the History components read it. */
export function toTxn(sale: ApiSaleListItem, branch: { id?: string; name?: string }): HistoryTxn {
  const badge = badgeOf(sale);
  const guest = sale.member ? sale.member.nickname || sale.member.name || sale.member.phone : null;
  return {
    id: sale.id,
    kind: kindOf(sale),
    isDropOff: isDropOff(sale),
    reference: referenceOf(sale),
    createdAt: sale.occurredAt,
    total: baht(sale.totals.grossSatang),
    // `TxnSummary.status` only has words for a sale that was paid for; `badge`
    // above carries the two the ledger adds, and is what the card renders.
    status: badge === 'unpaid' || badge === 'voided' ? 'paid' : badge,
    badge,
    operatorName: sale.soldBy?.name ?? 'Unknown',
    ...(guest ? { customerLabel: guest } : {}),
    ...(branch.id ? { branchId: branch.id } : {}),
    ...(branch.name ? { branchName: branch.name } : {}),
    ledger: sale,
  };
}

/**
 * How many sales one History read asks for.
 *
 * `GET /sales` answers a page, not a day, and this is the page size. It is
 * named rather than written into the query string because the screen has to say
 * which of the two it is showing — see `saleCountLabel`.
 */
export const SALES_PAGE_LIMIT = 200;

/**
 * What the figure under the list means — SCRUM-320.
 *
 * The count is the number of rows THIS READ returned, which is the day's total
 * only while the day fits in one page. A busy Saturday does not: the read asks
 * for the newest 200, the ledger has more, and "200 sales recorded at Central
 * Floresta" then understates the takings of the branch it is standing in. So a
 * full page says it is a page. The handheld reads its figure from here so that
 * it never has to know the limit; `pages/History.tsx` still counts its own rows
 * inline and so still calls a full page a day — one import and two lines, left
 * to whoever next has that file open, and the reason this lives here rather
 * than inside the handheld component.
 */
export function saleCountLabel(shown: number, limit = SALES_PAGE_LIMIT): string {
  if (shown >= limit) return `showing the newest ${limit} sales`;
  return `${shown} ${shown === 1 ? 'sale' : 'sales'}`;
}

/**
 * The branch's sales for one trading day, newest first.
 *
 * The date is the BUSINESS date, not the calendar one: the park's day starts at
 * 05:00, so a sale rung at 03:00 belongs to the day that is finishing, and
 * asking for it by the wall-clock date would answer with somebody else's
 * takings. `businessDateToday` below gets that date from the branch itself.
 *
 * It answers at most `SALES_PAGE_LIMIT` rows; `saleCountLabel` is how a caller
 * tells the reader when that is what they are looking at.
 */
export async function listSales(
  branchId: string | null,
  opts: { date?: string; memberId?: string; limit?: number } = {},
): Promise<HistoryTxn[]> {
  const params = new URLSearchParams();
  if (branchId) params.set('branchId', branchId);
  if (opts.date) params.set('businessDate', opts.date);
  if (opts.memberId) params.set('memberId', opts.memberId);
  params.set('limit', String(opts.limit ?? SALES_PAGE_LIMIT));
  const { sales } = await api.get<{ sales: ApiSaleListItem[] }>(`/sales?${params.toString()}`);
  return sales.map((sale) => toTxn(sale, {}));
}

/** One sale with its lines and discounts — what the detail panel is built from. */
export function getSale(id: string): Promise<ApiSaleDetail> {
  return api.get<ApiSaleDetail>(`/sales/${id}`);
}

/**
 * The trading day the branch is on right now, from the branch's own clock and
 * day boundary. Falls back to the calendar date in the branch timezone when the
 * deployment has no such route, which is right except between midnight and 05:00.
 */
export async function businessDateToday(
  branchId: string,
  timezone: string | undefined,
): Promise<string> {
  try {
    const { date } = await api.get<{ date: string }>(`/branches/${branchId}/pricing-mode`);
    return date;
  } catch {
    return calendarDateIn(timezone);
  }
}

/**
 * yyyy-mm-dd in a given timezone — the browser's own when the branch record
 * carries none, which is what every screen here did before the branch's
 * timezone existed.
 */
export function calendarDateIn(timezone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', {
    ...(timezone ? { timeZone: timezone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
