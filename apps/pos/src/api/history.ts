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
// BANDS, REFUNDS AND REPRINTS — S2-11 (SCRUM-208). A finalised ticket sale now
// carries its bands (by short code — the signed code is a gate credential and
// never leaves the platform in a read), its refunds and its print jobs, all on
// `GET /sales/:id`. A sale is found by a band or a member's phone through
// `GET /sales/lookup`, and History changes a sale through two more routes:
// `POST /sales/:id/refunds` and `POST /sales/:id/reprints`. The list card
// still leaves `wristbandCode` unset: the list answer carries no bands, and a
// sale can hold several. The booking reference is read off the sale's note
// (`bookingReferenceOf`, SCRUM-477): a redemption writes "Online booking
// OTO-XXXX-XXXX" on the sale it files, and no read yet answers the booking
// itself.
import {
  bandShortCode,
  isBandCodeShape,
  normaliseBandCode,
  normalizePhone,
  parseBandShortCode,
  resolveRefundAmount,
  type PaymentAttemptView,
  type PrintKind,
  type RefundAllocationEntry,
  type RefundLineEntry,
  type RefundMode,
  type SaleReprintKind,
} from '@oto/shared';
import { api, idemKey } from './client';
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
  /** The document's own expiry as the check recorded it (`YYYY-MM-DD`), or null when it carries none. */
  evidenceExpiresOn: string | null;
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
  /**
   * THE VOID, AS THE LEDGER RECORDED IT — SCRUM-430: when, by which account,
   * and the reason the platform requires with every void. Optional on the
   * wire because a sale read that does not carry them — none did before
   * SCRUM-430; the void's own answer (`SaleVoidAnswer`) was the one place the
   * reason came back — still has to open in History, where a sale it shows as
   * voided then has no reason to show beside the badge.
   */
  voidedAt?: string | null;
  voidedByAccountId?: string | null;
  /**
   * Who voided it, by name — "Voided by Som, 25 Sept, 14:02", not an account
   * id. Optional for the same reason as the three above: a deployment that
   * answers the void's time and reason but not yet the name still opens in
   * History, and the note there says the time without a name rather than
   * "by undefined". Null beside an account id when nothing names the account.
   */
  voidedByName?: string | null;
  voidReason?: string | null;
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
  productId?: string | null;
  modifiers?: { groupId: string; groupName: string; optionId: string; optionName: string; unitSatang: number }[] | null;
  note?: string | null;
  variant?: { variantId: string; variantLabel: string } | null;
  variantBreakdown?: { variantId: string; variantLabel: string; quantity: number }[] | null;
  prepaid?: { checkinId: string; menuItemId: string; unmatched?: true; settledAtPickup?: true; usedUp?: true } | null;
  holderCheckinId?: string | null;
  supervised?: boolean;
}

export interface ApiSaleDiscount {
  id: string;
  kind: string;
  discountType: string;
  percentBp: number | null;
  amountSatang: number;
  targetLabel: string | null;
  /**
   * The code the discount was given under: a park code whole, a Lucky Wheel
   * voucher's by its last four characters, "…47WP" — no sale answer carries a
   * voucher's whole code (SCRUM-433). Nothing on the till reads it back to use
   * the voucher again: the whole code is kept on the voucher the till holds.
   */
  code: string | null;
  /**
   * What the line says. A voucher's: the type's name and the code's last four,
   * "150 THB Voucher (voucher …47WP)", shown by `DiscountLabel` in
   * components/history/SaleDetail.tsx so the name is what gets cut.
   */
  label: string | null;
  reason: string | null;
  note: string | null;
  appliedByName: string | null;
}

/**
 * WHETHER A DISCOUNT ROW IS A VOUCHER'S — SCRUM-430.
 *
 * The ledger files a voucher under the same `promo` kind as a park's promo
 * code, and no field on the row says which it was. What does is the label the
 * platform writes on a voucher's row and on nothing else: the voucher type's
 * name and the last four characters of the code, "150 THB Voucher (voucher
 * …47WP)" (`voucherLineLabel`, apps/api/src/services/vouchers.ts; before
 * SCRUM-433 the whole code, "(voucher 7K2…)"). Both forms open the same way,
 * and that opening is what is read. A `voucherId` on the row would make this a
 * field read instead of a label read; until the ledger carries one, this is
 * the one signal on the wire.
 */
export function isVoucherDiscount(d: Pick<ApiSaleDiscount, 'kind' | 'label'>): boolean {
  return d.kind === 'promo' && /\(voucher\b/i.test(d.label ?? '');
}

export interface ApiSaleDetail {
  /** A separate paid extension of an existing admission, never a new admission cart. */
  timeExtension?: { id: string; sourceSaleId: string; status: 'pending' | 'applied' | 'voided'; minutesAdded: number; braceletCount: number } | null;
  /** Exact recorded food-order holder, by the non-secret code printed under its QR. */
  correctionBandShortCode?: string | null;
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
  /**
   * S2-11 — WHAT THE REFUNDS LEFT, the prototype's `statusForRefunds`
   * (`mockApi.ts`), derived by the platform from the running total: the
   * ledger status stays `finalised` until the whole sale is refunded.
   *
   * Everything from here down is optional on the wire for the same reason
   * `attempts` is: a deployment older than S2-11 answers without it, and
   * History has to keep opening sales there.
   */
  refundStatus?: RefundStatus;
  /** What may still be refunded, in satang. 0 on a sale that is not finalised. */
  refundableSatang?: number;
  /** Every refund, oldest first — the prototype's "Refund history". */
  refunds?: ApiRefund[];
  /** Every print job, newest first; a reprint names its original in `reprintOf`. */
  printJobs?: ApiSalePrintJob[];
  /** The bands the sale issued, by short code. */
  bands?: ApiSaleBand[];
  /** S2-09b — the code the guest holds for an F&B order. */
  pickupCode?: string | null;
}

/** Where a sale's refunds leave it (`refundStatusOf` in `@oto/shared`). */
export type RefundStatus = 'none' | 'partially_refunded' | 'refunded';

/**
 * ONE REFUND, as the platform recorded it (`RefundView`,
 * apps/api/src/services/refund-slices.ts): its own number from the station's
 * refund series, who pressed it and who approved it, the lines it covered and
 * how the money went back — slice by slice, wallet → same tender → cash.
 */
export interface ApiRefund {
  id: string;
  saleId: string;
  stationId: string;
  /** `T1-R-000003`. */
  number: string;
  amountSatang: number;
  mode: RefundMode | string;
  reason: string;
  note: string | null;
  lines: RefundLineEntry[];
  tenderAllocation: RefundAllocationEntry[];
  approvedBy: { accountId: string; name: string | null };
  createdBy: { accountId: string; name: string | null };
  /** True while a slice still waits on a terminal, the gateway or a wallet. */
  pending: boolean;
  createdAt: string;
}

/** One print job as the sale detail, the finalise answer and a reprint show it. */
export interface ApiSalePrintJob {
  id: string;
  kind: PrintKind;
  role: string | null;
  /** `queued`, `printed`, `failed` or `skipped` (no printer for the role). */
  status: string;
  stationId: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  subjectType: string | null;
  subjectId: string | null;
  /** The ORIGINAL job this is a copy of. Null on a first print. */
  reprintOf: string | null;
  reprintReason: string | null;
  /**
   * SCRUM-208 — who asked for this printout, filled for reprints (the account
   * that pressed Reprint), null otherwise. Read back with the sale, so a
   * reprint's attribution survives a reload rather than living only in the
   * screen state of the till that made it.
   */
  requestedByName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: string;
  finishedAt: string | null;
}

/**
 * One band as a read shows it — its short code (`T1-7KMQ4X`, printed under the
 * QR and on the receipt), never the signed code, which is a gate credential.
 */
export interface ApiSaleBand {
  id: string;
  kind: 'kid' | 'adult';
  status: string;
  shortCode: string | null;
  saleLineId: string | null;
  childId: string | null;
  childName: string | null;
  printedJobId: string | null;
  createdAt: string;
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

/**
 * THE BOOKING A SALE REDEEMED — SCRUM-477.
 *
 * A redemption sale carries its booking on the ledger row (`sale.booking_id`),
 * but neither the list nor the detail read answers it. What both carry is the
 * note the redemption writes on the sale, "Online booking OTO-XXXX-XXXX" —
 * the counter's online path (`services/booking-redemption.ts`) and the box
 * lane's (`sync.ts`) write the same words — and that is read here the way a
 * voucher's label is read above. Until a read carries the booking, this is
 * the one signal on the wire. Null on every other sale.
 */
export function bookingReferenceOf(sale: Pick<ApiSale, 'note'>): string | null {
  const found = /^Online booking (\S+)$/.exec(sale.note ?? '');
  return found ? found[1]! : null;
}

/** The customer line on a redemption sale with no member behind it. */
export const BOOKED_ONLINE_LABEL = 'Booked online';

/** One ledger sale as the History components read it. */
export function toTxn(sale: ApiSaleListItem, branch: { id?: string; name?: string }): HistoryTxn {
  const badge = badgeOf(sale);
  const bookingReference = bookingReferenceOf(sale);
  // A guest who booked online and is no member is not a walk-in (SCRUM-477).
  const guest =
    (sale.member ? sale.member.nickname || sale.member.name || sale.member.phone : null) ??
    (bookingReference ? BOOKED_ONLINE_LABEL : null);
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
    ...(bookingReference ? { bookingReference } : {}),
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
export type HistoryDateFilter = 'today' | 'yesterday' | 'week' | 'all';

/** The phone's date chips span park business dates; This week is seven days. */
export function historyDateRange(today: string, filter: HistoryDateFilter): { from?: string; to?: string } {
  if (filter === 'all') return {};
  const offset = filter === 'yesterday' ? 1 : filter === 'week' ? 6 : 0;
  const start = new Date(`${today}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - offset);
  const from = start.toISOString().slice(0, 10);
  return { from, to: filter === 'yesterday' ? from : today };
}

export async function listSales(
  branchId: string | null,
  opts: { date?: string; from?: string; to?: string; memberId?: string; limit?: number } = {},
): Promise<HistoryTxn[]> {
  const params = new URLSearchParams();
  if (branchId) params.set('branchId', branchId);
  if (opts.date) params.set('businessDate', opts.date);
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
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

// --- S2-11: finding a sale by a band or a phone -----------------------------

/**
 * WHAT THE SEARCH BOX WAS GIVEN — the universal search's one new decision
 * (S2-11). The prototype's box filtered the rows on screen by reference, name,
 * operator and amount (`pages/History.tsx`), and that filter stays. Two things
 * a guest hands over at the desk are not on any row, though: the band on their
 * wrist and their phone. Those are asked of the platform (`lookupSales`), which
 * finds them on any day, not just the one on screen.
 *
 *   band   the whole signed code, as a scanner reads the QR, or the short code
 *          printed under it and on the receipt (`T1-7KMQ4X`, the dash or a
 *          space between the two parts, any case);
 *   phone  nine digits or more that read as a phone in any format — "08…",
 *          "+66 …", "0066…". Fewer digits are an amount or part of a receipt
 *          number, which the on-screen filter already answers;
 *   text   anything else: the on-screen filter alone.
 */
export type HistorySearch =
  | { kind: 'band'; code: string; label: string }
  | { kind: 'phone'; phone: string }
  | { kind: 'text' };

export function parseHistorySearch(raw: string): HistorySearch {
  const text = raw.trim();
  if (!text) return { kind: 'text' };
  if (isBandCodeShape(text)) {
    const code = normaliseBandCode(text);
    return { kind: 'band', code, label: bandShortCode(code) ?? code };
  }
  const short = parseBandShortCode(text);
  if (short) {
    const code = `${short.prefix}-${short.tail}`;
    return { kind: 'band', code, label: code };
  }
  if (/^[+\d][\d\s\-().]*$/.test(text) && text.replace(/\D/g, '').length >= 9) {
    const phone = normalizePhone(text);
    if (phone) return { kind: 'phone', phone };
  }
  return { kind: 'text' };
}

/** What `GET /sales/lookup` matched, beside the sales it found. */
export type SaleLookupMatch =
  | { by: 'band'; bandIds: string[] }
  | { by: 'phone'; phone: string; memberIds: string[] };

export interface SaleLookupResult {
  match: SaleLookupMatch;
  sales: HistoryTxn[];
}

/**
 * The sales a band or a phone leads to, newest first, scoped as the day's list
 * is: this branch when the till names one, otherwise every branch the session
 * reaches. One of the two, never both — the platform refuses either way.
 */
export async function lookupSales(
  branchId: string | null,
  by: { band: string } | { phone: string },
  limit = 50,
): Promise<SaleLookupResult> {
  const params = new URLSearchParams();
  if ('band' in by) params.set('band', by.band);
  else params.set('phone', by.phone);
  if (branchId) params.set('branchId', branchId);
  params.set('limit', String(limit));
  const answer = await api.get<{ match: SaleLookupMatch; sales: ApiSaleListItem[] }>(
    `/sales/lookup?${params.toString()}`,
  );
  return { match: answer.match, sales: answer.sales.map((sale) => toTxn(sale, {})) };
}

/**
 * The rows a search shows: the lookup's finds and the day's own rows that the
 * on-screen filter kept, each sale once, newest first. A band sold yesterday
 * is found by the lookup and not by the filter, and a sale found both ways
 * must not appear twice.
 */
export function mergeLookup(
  local: readonly HistoryTxn[],
  found: readonly HistoryTxn[] | null,
): HistoryTxn[] {
  if (!found || found.length === 0) return [...local];
  const seen = new Set<string>();
  const rows: HistoryTxn[] = [];
  for (const t of [...found, ...local]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    rows.push(t);
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * What a set of sales actually took, in baht, net of refunds: an order rung up
 * and never tendered, or one that was voided, is not spend (the prototype's
 * `totalSpent`, "net of refunds", `mockApi.ts:getTransactionsByMember`).
 */
export function spentOf(txns: readonly HistoryTxn[]): number {
  const satang = txns
    .filter((t) => t.badge !== 'unpaid' && t.badge !== 'voided')
    .reduce((sum, t) => sum + Math.max(0, t.ledger.totals.grossSatang - t.ledger.totals.refundedSatang), 0);
  return baht(satang);
}

// --- S2-11: refunds ------------------------------------------------------------

/**
 * One choice in the Refund dialog's "By item" list (`RefundModal.tsx`).
 *
 * The prototype listed one row per CART line — "2 Hours Play · 3 ppl", "2×
 * Iced Latte" (`TransactionDetail.tsx:150-166`) — and that is the grouping the
 * detail already draws (`cartLineId`). The platform refunds SALE lines, which
 * are the components of a cart line (kids, adults, socks), so a row carries
 * every component still unrefunded and the refund names them all.
 *
 * A line an earlier refund already covered is left out (the platform would
 * refuse it, `REFUND_LINE_ALREADY_REFUNDED`), and so is a row worth nothing: the
 * prototype listed no free promo item, and a ฿0 refund refunds nothing.
 */
export interface RefundItemOption {
  /** The cart line — the row's key. */
  id: string;
  label: string;
  /** The sale lines this row refunds. */
  lineIds: string[];
  amountSatang: number;
}

const ADMISSION_KINDS = new Set(['kids', 'adults_paid', 'adults_free']);

export function refundItemOptions(
  detail: Pick<ApiSaleDetail, 'lines' | 'refunds'>,
  nameOf: (line: ApiSaleLine) => string | null = () => null,
): RefundItemOption[] {
  const refunded = new Set(
    (detail.refunds ?? []).flatMap((r) => r.lines.map((line) => line.saleLineId)),
  );
  const groups = new Map<string, ApiSaleLine[]>();
  for (const line of detail.lines) {
    const group = groups.get(line.cartLineId) ?? [];
    group.push(line);
    groups.set(line.cartLineId, group);
  }
  const options: RefundItemOption[] = [];
  for (const [cartLineId, lines] of groups) {
    const open = lines.filter((line) => !refunded.has(line.id));
    const amountSatang = open.reduce((sum, line) => sum + line.grossSatang, 0);
    if (open.length === 0 || amountSatang <= 0) continue;
    const first = lines[0]!;
    const people = lines
      .filter((line) => ADMISSION_KINDS.has(line.kind))
      .reduce((sum, line) => sum + line.quantity, 0);
    const name = nameOf(first) ?? first.stayDurationLabel ?? first.label;
    const label =
      people > 0
        ? `${name} · ${people} ppl`
        : lines.length === 1
          ? `${first.quantity}× ${first.label}`
          : name;
    options.push({ id: cartLineId, label, lineIds: open.map((line) => line.id), amountSatang });
  }
  return options;
}

/** What a refund may still be for: the detail's figure when it has one, else the totals'. */
export function refundRemainingSatang(
  detail: Pick<ApiSaleDetail, 'refundableSatang'> | null,
  totals: Pick<ApiSaleTotals, 'grossSatang' | 'refundedSatang'>,
): number {
  if (detail?.refundableSatang !== undefined) return Math.max(0, detail.refundableSatang);
  return Math.max(0, totals.grossSatang - totals.refundedSatang);
}

/**
 * THE AMOUNT A REFUND IS FOR — the prototype's clamp (`RefundModal.tsx`
 * `amountTHB = Math.min(rawAmount, maxRefund)`, and again in
 * `mockApi.ts:recordRefund`), in satang, through the same `resolveRefundAmount`
 * the platform applies. `clamped` is what lets the dialog say "capped at"
 * rather than refund a different figure than the one keyed in without a word.
 */
export function refundAmountFor(input: {
  mode: RefundMode;
  remainingSatang: number;
  options: readonly RefundItemOption[];
  selected: readonly string[];
  customSatang: number;
}): { amountSatang: number; requestedSatang: number; clamped: boolean; lineIds: string[] } {
  const picked = input.options.filter((option) => input.selected.includes(option.id));
  const resolved = resolveRefundAmount({
    mode: input.mode,
    remainingSatang: input.remainingSatang,
    itemsSatang: picked.reduce((sum, option) => sum + option.amountSatang, 0),
    customSatang: Math.max(0, Math.round(input.customSatang)),
  });
  return {
    ...resolved,
    lineIds: input.mode === 'items' ? picked.flatMap((option) => option.lineIds) : [],
  };
}

/** What the Refund dialog sends. The platform decides where the money goes. */
export interface SaleRefundBody {
  mode: RefundMode;
  lineIds?: string[];
  amountSatang?: number;
  reason: string;
  note?: string | null;
  actionId: string;
}

export interface SaleRefundAnswer {
  /** True when this press had already been recorded and nothing was written. */
  replay: boolean;
  refund: ApiRefund;
  sale: ApiSale;
  refundStatus: RefundStatus;
  refundableSatang: number;
  requestedSatang: number;
  clamped: boolean;
}

/** A short stable digest of a request body, for an idempotency key. FNV-1a, hex. */
function digest(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Refund a finalised sale (`POST /sales/:id/refunds`). Online only, and only
 * with a manager's approval: an account without `pos:refund:approve` is
 * refused `REFUND_APPROVAL_REQUIRED` in the platform's words.
 *
 * The action id is one per dialog, so a retry of the same press after a lost
 * answer replays the refund it recorded; the idempotency key carries the body,
 * so a corrected amount is a new request rather than a mismatch.
 */
export function refundSale(saleId: string, body: SaleRefundBody): Promise<SaleRefundAnswer> {
  return api.post<SaleRefundAnswer>(`/sales/${encodeURIComponent(saleId)}/refunds`, body, {
    idempotencyKey: `refund:${saleId}:${body.actionId}:${digest(body)}`,
    headers: { 'x-oto-action-id': body.actionId },
  });
}

/** A fresh action id for one Refund dialog, or one Reprint press. */
export const newActionId = (): string => idemKey();

// --- S2-11: reprints ------------------------------------------------------------

/**
 * One row in the Reprint dialog (`ReprintModal.tsx`), ported from
 * `TransactionDetail.tsx:171-197`: the full receipt, each bracelet group and
 * the F&B pick-up ticket. The prototype's credit-grant rows print with S2-14a
 * and are not offered. A shop sale's receipt is the same paper under its own
 * kind (`merch_receipt`).
 */
export interface ReprintOption {
  kind: SaleReprintKind;
  label: string;
  sublabel?: string;
}

export function reprintOptions(
  detail: Pick<ApiSaleDetail, 'lines' | 'bands' | 'printJobs' | 'pickupCode'>,
  kind: TxnKind,
): ReprintOption[] {
  const options: ReprintOption[] = [
    { kind: kind === 'merch' ? 'merch_receipt' : 'receipt', label: 'Full receipt' },
  ];
  const count = (bandKind: 'kid' | 'adult', lineKinds: readonly string[]): number => {
    const bands = (detail.bands ?? []).filter((b) => b.kind === bandKind && b.status !== 'revoked');
    // A sale finalised while the platform had no band key has no bands yet;
    // reprinting them issues them, so the count comes from its lines.
    return bands.length > 0
      ? bands.length
      : detail.lines
          .filter((line) => lineKinds.includes(line.kind))
          .reduce((sum, line) => sum + line.quantity, 0);
  };
  const kids = count('kid', ['kids']);
  const adults = count('adult', ['adults_paid', 'adults_free']);
  if (kids > 0) options.push({ kind: 'kids_bands', label: 'Child bracelet', sublabel: `×${kids}` });
  if (adults > 0) {
    options.push({ kind: 'adult_bands', label: 'Adult bracelet', sublabel: `×${adults}` });
  }
  const hasPrep =
    (detail.printJobs ?? []).some((j) => j.kind === 'kitchen_ticket' || j.kind === 'bar_ticket') ||
    (kind === 'fnb' && detail.lines.some((line) => line.kind === 'fnb_item'));
  if (hasPrep) {
    options.push({
      kind: 'prep',
      label: detail.pickupCode ? `Pickup ticket #${detail.pickupCode}` : 'Pickup ticket',
    });
  }
  return options;
}

export interface SaleReprintAnswer {
  jobs: ApiSalePrintJob[];
  bands: ApiSaleBand[];
  /** "Bar ticket not printed — no bar printer at this station", and the like. */
  notes: string[];
}

/**
 * Print a finalised sale's paper again (`POST /sales/:id/reprints`), at the
 * station this session is at. A band keeps its id and its code; the job it
 * replaces is marked, and the new one names its original in `reprintOf`.
 */
export function reprintSale(
  saleId: string,
  kind: SaleReprintKind,
  actionId: string,
): Promise<SaleReprintAnswer> {
  return api.post<SaleReprintAnswer>(
    `/sales/${encodeURIComponent(saleId)}/reprints`,
    { kind, actionId },
    {
      idempotencyKey: `reprint:${saleId}:${kind}:${actionId}`,
      headers: { 'x-oto-action-id': actionId },
    },
  );
}

// --- S2-11: which band goes on which bracelet row ---------------------------------

/**
 * The bands of a sale filed under the till's own cart lines, so the payment
 * confirmation can put each code beside the bracelet row it belongs to: the
 * band names its sale line, and the sale line names its cart line. The key is
 * `<cartLineId>:<kid|adult>`. A band whose line cannot be placed goes in
 * `unplaced`, and is still shown — a code staff cannot read out is no use.
 */
export function bandsByCartLine(
  bands: readonly ApiSaleBand[],
  lines: readonly Pick<ApiSaleLine, 'id' | 'cartLineId'>[],
): { byRow: Map<string, ApiSaleBand[]>; unplaced: ApiSaleBand[] } {
  const cartOf = new Map(lines.map((line) => [line.id, line.cartLineId]));
  const byRow = new Map<string, ApiSaleBand[]>();
  const unplaced: ApiSaleBand[] = [];
  for (const band of bands) {
    if (band.status === 'revoked') continue;
    const cart = band.saleLineId ? cartOf.get(band.saleLineId) : undefined;
    if (!cart) {
      unplaced.push(band);
      continue;
    }
    const key = `${cart}:${band.kind}`;
    byRow.set(key, [...(byRow.get(key) ?? []), band]);
  }
  return { byRow, unplaced };
}

/** "T1-7KMQ4X · Mali" — a band as staff read it out. */
export function bandLabel(band: Pick<ApiSaleBand, 'shortCode' | 'childName'>): string {
  const code = band.shortCode ?? 'No code';
  return band.childName ? `${code} · ${band.childName}` : code;
}


// Paid play extensions are separate charges: the original receipt stays unchanged.
export type ExtensionSelection =
  | { mode: 'bands'; bandIds: string[] }
  | { mode: 'count'; braceletCount: number };
export interface SaleExtensionOption { id: string; label: string; minutes: number; unitSatang: number }
export interface ExtensionBand { id: string; shortCode: string; kind: string }
export interface SaleExtension {
  id: string;
  chargeSaleId: string;
  optionId: string;
  label: string;
  minutesAdded: number;
  braceletCount: number;
  amountSatang: number;
  selection: ExtensionSelection;
  status: 'pending' | 'applied' | 'voided';
  createdAt: string;
  createdByName: string | null;
  appliedAt: string | null;
  currentBandIds?: string[];
  needsReselection?: boolean;
  /** The configured tender codes that took this charge, oldest first. */
  paymentMethods?: string[];
}
export interface SaleExtensionsRead {
  options: SaleExtensionOption[];
  eligibleBands: ExtensionBand[];
  extensions: SaleExtension[];
}
export interface SaleExtensionBody {
  actionId: string;
  stationId: string;
  optionId: string;
  selection: ExtensionSelection;
}
export const readSaleExtensions = (saleId: string) =>
  api.get<SaleExtensionsRead>(`/sales/${encodeURIComponent(saleId)}/extensions`);
export const createSaleExtension = (saleId: string, body: SaleExtensionBody) =>
  api.post<{ extension: SaleExtension; sale: import('./sales').ApiSale; replay?: boolean }>(
    `/sales/${encodeURIComponent(saleId)}/extensions`, body,
    { idempotencyKey: `extension:${saleId}:${body.actionId}`, headers: { 'x-oto-action-id': body.actionId } },
  );

export const reselectExtensionBands = (saleId: string, extensionId: string, body: { actionId: string; stationId: string; bandIds: string[] }) =>
  api.post<{ replay: boolean }>(`/sales/${encodeURIComponent(saleId)}/extensions/${encodeURIComponent(extensionId)}/bands`, body,
    { idempotencyKey: `extension-reselect:${extensionId}:${body.actionId}`, headers: { 'x-oto-action-id': body.actionId } });
