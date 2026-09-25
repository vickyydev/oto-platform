import type {
  CartLine,
  Discount,
  FnbOrderLine,
  ManualDiscount,
  MerchOrderLine,
  SaleQuotedPricing,
  TaxConfig,
} from '@/types';
import { computeTotals } from '@/lib/sale';
import { computeFnbTotals } from '@/lib/fnb';
import { computeMerchTotals } from '@/lib/merch';
import { summarizeTax } from '@/lib/tax';
import {
  computeTicketCartTotals,
  newId,
  type AppliedPromo,
  type TaxBreakdown as EngineTaxBreakdown,
  type TaxableCategory,
  type TicketCartTotals,
} from '@oto/shared';
import {
  engineCart,
  engineManualDiscount,
  enginePromo,
  itemCart,
  type ItemCartLine,
  localIdFor,
  platformId,
  SOCKS_ADDON_ID,
  SOCKS_LABEL,
  toBaht,
  toSatang,
  unpricedDropOffLines,
  type EngineCart,
} from '@/lib/cartWire';
import { todayRateMode, type RateMode } from '@/lib/pricingMode';
import { api, ApiError, idemKey, isMissingRoute } from './client';
import type { VoucherEffect } from './vouchers';
import type { TaxBreakdown as PosTaxBreakdown, CategoryTaxLine as PosCategoryTaxLine } from '@/lib/tax';

/**
 * THE SALES LEDGER, FROM THE TILL'S SIDE — S2-09a (SCRUM-203).
 *
 * Two things are here and they are deliberately in one file, because they are
 * two halves of one contract:
 *
 *   1. WHAT THE TILL SENDS. The cart payload, the quote, and the commit that
 *      writes `pos.sale` / `pos.sale_line` / `pos.sale_discount`.
 *   2. WHAT THE TILL DOES WHEN THE PLATFORM CANNOT ANSWER. The same cart run
 *      through the same engine in the browser, marked as such, so a total on
 *      the screen always says where it came from.
 *
 * A DEPLOYMENT WITHOUT THESE ROUTES still has to sell tickets. Where the
 * platform answers 404 the till prices the cart itself, with the same engine,
 * and says so on the screen — which is why `source` is on every quote and why
 * the confirmation screen states plainly when a sale was not written to the
 * platform. Every place the platform's shape is read is in this file.
 *
 * WHERE PAY ENDS AND THE TENDER BEGINS. `POST /sales` records the sale; it does
 * not close it. A sale with money to collect is written in `tendering` with no
 * receipt number, and the tender that completes — today only the cash step's
 * "Confirm Payment Received" — calls `POST /sales/:id/finalise`, which
 * allocates the number. A ฿0 sale has nothing to tender and so is committed and
 * finalised in one call.
 */

// --- What the till sends ----------------------------------------------------

export interface SaleCartAddOnPayload {
  id: string;
  name: string;
  /**
   * The price this add-on was ADDED AT, in satang. A snapshot, because the
   * prototype snapshots it onto the line (`lib/pricing.ts:198`) and because the
   * platform has no add-on catalogue to re-price it from until S2-09b — which
   * is also why `pos.sale_line.component_key` is text rather than a product id.
   */
  unitSatang: number;
  quantity: number;
  taxCategoryOverride?: TaxableCategory;
  variantBreakdown?: { variantId: string; variantLabel: string; quantity: number }[];
}

export interface SaleCartLinePayload {
  /** The till's own cart line id — `pos.sale_line.cart_line_id`. */
  id: string;
  /** The platform's `ticket_package` id: what the platform prices from. */
  packageId: string;
  /** The package name as the screen showed it, for the frozen line label. */
  packageName: string;
  tier: string;
  kids: number;
  adults: number;
  socks: number;
  addOns: SaleCartAddOnPayload[];
  serviceFee?: { label: string; amountSatang: number } | null;
  foodProvision?: { mode: 'prepaid_items' | 'prepaid_credit'; paidSatang: number } | null;
  promoItem?: {
    itemId: string;
    itemKind: 'menu' | 'merch';
    name: string;
    priceSatang: number;
  } | null;
  /**
   * WHAT THE SCREEN SHOWED FOR THIS LINE. Not an instruction to charge it — the
   * platform prices the line from its own catalogue — but the figure it
   * reconciles against, so a till holding a stale package (a price edited in
   * admin while a cart was open) is refused rather than quietly charging the
   * guest the new number after quoting the old one.
   */
  lineTotalSatang: number;
  /** From the package, frozen onto every unit of the line: "2 Hours". */
  stayHours?: number;
  stayDurationLabel?: string;
}

export interface SaleCartPromoPayload {
  code: string;
  label: string;
  type: 'percent' | 'fixed' | 'free_item';
  /** A percentage for `percent`; satang for `fixed` and `free_item`. */
  value: number;
  freeItemId?: string;
  freeItemKind?: 'menu' | 'merch';
  target?: unknown;
}

export interface SaleCartManualDiscountPayload {
  id: string;
  scope: 'order' | 'line';
  targetLineId?: string;
  targetComponent?: unknown;
  targetLabel?: string;
  type: 'percent' | 'fixed' | 'comp';
  /** A percentage for `percent`; satang for `fixed`; ignored for `comp`. */
  value: number;
  reason: string;
  note?: string;
  /** Who applied it — `pos.sale_discount` requires both on a manual discount. */
  appliedByAccountId: string;
  appliedByName: string;
  appliedAt: string;
}

/**
 * ONE F&B OR SHOP ROW — S2-09b.
 *
 * The ticket cart above says "this package, these participants"; this says
 * "this catalogue row, this many, with these options, this note and this size".
 * The two ride in the same cart body because they are the same sale to the
 * ledger — `pos.sale_line.kind` is `fnb_item` or `merch_item` beside `kids` and
 * `addon`, and the seed has held those two kinds since migration 0014.
 *
 * NOTHING HERE DECIDES A PRICE. The only money on it is `lineTotalSatang`, what
 * the order panel showed, sent for the same reason a ticket line sends its
 * total: so a till holding a menu price that was edited while an order was
 * being taken is REFUSED rather than quietly charging the new figure after
 * quoting the old one. The unit price is composed on the platform from
 * `pos.product` and `pos.modifier_option`, and the option NAMES are frozen onto
 * the sale line from those rows rather than from anything sent here.
 *
 * The shape is `lib/cartWire.ts`'s and is the one the route declares
 * (`CartItemLine` in `apps/api/src/routes/sales.ts`) — restated nowhere, so it
 * cannot drift from the schema it has to satisfy.
 */
export type SaleCartItemPayload = ItemCartLine;

/**
 * ONE CART, as both the quote and the commit carry it.
 *
 * `pricingMode` is the till's snapshot and the platform is free to disagree —
 * the answer carries the mode that was actually used, and the till shows that.
 * It is sent rather than left to the platform because the cart was PRICED under
 * it: a cart opened at 23:58 on a Friday and paid at 00:01 must not silently
 * re-price, and the platform cannot know when the cart was opened unless the
 * till tells it.
 */
export interface SaleCartPayload {
  branchId: string;
  stationId: string;
  /**
   * SCRUM-343 — WHICH LANE OF THIS TILL TOOK THE ORDER: the ticket counter, the
   * F&B station or the shop.
   *
   * It is the one thing about a sale that only this side knows. `station.kind`
   * is `till` for all three — they are three screens of one app on one station
   * — so without this every F&B and shop order since S2-09b was recorded under
   * `sales_channel = 'till'` and a day's food takings were filed under the
   * ticket counter. The platform checks the claim against the station's
   * capabilities and refuses one the station is not set up for, so this is a
   * statement about which screen was open, not a choice of ledger.
   */
  channel: 'till' | 'fnb' | 'shop';
  tier: string;
  /**
   * SCRUM-307 — the action id of a document check recorded through
   * `POST /sales/tier-claims`, when this cart is for a visitor who is not a
   * member yet.
   *
   * It is what makes a discounted walk-in priceable at all: `tier` above is
   * ignored by the platform, and with no member to read a tier from the cart
   * would otherwise be priced at the default rate — which is how every Expat
   * and Thai sale came back as `SALE_LINE_PRICE_MISMATCH`. What this names is
   * a row the platform wrote under a permission check and stamped with the
   * verifier and the branch; naming it is not the same as naming a price.
   */
  tierClaimActionId?: string | null;
  pricingMode: RateMode;
  pricingModeReason: string;
  /** Read live from the catalogue, never snapshotted — the prototype's rule. */
  socks: { addOnId: string; unitSatang: number; label: string };
  lines: SaleCartLinePayload[];
  /**
   * The F&B and shop rows (S2-09b). Empty on a ticket cart, and the ticket
   * `lines` are empty on an order taken at the F&B or shop station — one cart
   * body, two kinds of thing in it, because a sale is a sale to the ledger.
   */
  items?: SaleCartItemPayload[];
  /**
   * THE PICK-UP CODE, asked for before the tender and carried with the order.
   *
   * The prototype asks for it on the way to payment and prints it on the
   * receipt and on both prep tickets (`components/fnb/PickupCodeModal`), so it
   * is part of what the order IS, not a printing detail: it is how the guest
   * and the kitchen find each other. Sent with the cart so the sale the
   * platform writes carries it too.
   */
  pickupCode?: string | null;
  promos: SaleCartPromoPayload[];
  /**
   * S2-10b — THE VOUCHER ON THIS CART, BY ITS CODE, and nothing else rides
   * here. A Lucky Wheel voucher held for this cart is named by its code and
   * the platform prices it from the voucher's definition
   * (`resolveCartVoucher`); the till never describes what it takes off, and a
   * park discount code goes in `promos` with its definition as before.
   * Omitted when the cart carries no voucher.
   */
  promoCodes?: string[];
  manualDiscounts: SaleCartManualDiscountPayload[];
  memberId?: string | null;
  customerPhone?: string | null;
  customerNickname?: string | null;
  /** What the till last showed as the amount due. See `lineTotalSatang`. */
  expectedTotalSatang: number;
}

export interface SaleCommitBody {
  /**
   * THE SALE'S ID, MINTED BY THE TILL (UUIDv7), and the reason pressing Pay
   * twice cannot produce two sales: the primary key makes the second arrival a
   * replay. It is minted once per cart and reused by every attempt at it.
   */
  id: string;
  /**
   * `x-oto-action-id` — the second net. A retry that mints a NEW id but carries
   * the same action is refused by `sale_action_unique (station_id, action_id)`
   * rather than written, so a client bug cannot turn one press into two sales.
   */
  actionId: string;
  cart: SaleCartPayload;
  /**
   * The till's clock when Pay was pressed. Minted ONCE per sale, not per
   * attempt: the idempotency store hashes the whole body, so a retry that
   * re-stamped the clock would carry the same key with a different body and be
   * refused as a mismatch — the one moment a retry has to work.
   */
  occurredAt: string;
  note?: string | null;
  /**
   * WHETHER THIS COMMIT ALSO CLOSES THE SALE.
   *
   * False on every sale that has money to collect: Pay writes the row
   * unfinalised, in `tendering`, with no receipt number, and the tender that
   * completes allocates the number through `/sales/:id/finalise`.
   *
   * True only for a ฿0 sale — a full comp — which has nothing to tender and so
   * nothing to wait for. The platform honours it when the sale owes nothing and
   * records `tendering` when it does; it never takes the till's word for it.
   *
   * S2-10b — THE TICKET AND F&B TILLS SEND FALSE FOR EVERY SALE, ฿0 INCLUDED.
   * Pay opens the payment screen, and a sale closed there is a sale its Cancel
   * can no longer void — with a voucher on it, the family's voucher used up
   * before anybody confirmed anything. Those tills close a ฿0 sale at their
   * confirm press through `/sales/:id/finalise`, which records no tender when
   * nothing is owed.
   */
  finalise: boolean;
}

/**
 * THE MONEY, AS THE TILL SAW IT TAKEN — S2-10a's seam, one tender wide.
 *
 * The prototype's payment screen has one button, "Confirm Payment Received",
 * and no entry for what the visitor handed over. So what this can honestly say
 * today is: the configured tender the operator chose, and that the amount due
 * was taken in full. `tenderedSatang` therefore equals the amount due and
 * `changeSatang` is zero — not because no change was given, but because this
 * screen has never asked. S2-10a adds the cash keypad, the EDC and the QR
 * result, and fills these same fields in from what actually happened.
 */
export interface SaleTenderPayload {
  /** The configured tender token — `cash`, `promptpay`, whatever admin named. */
  method: string;
  /** Which kind of tender that token is, for the attempt's own record. */
  kind: 'cash' | 'card' | 'qr' | 'other';
  /** What the sale asked for: the platform's own gross for this sale. */
  amountSatang: number;
  /** What was handed over. Equal to the amount due until S2-10a asks. */
  tenderedSatang: number;
  /** What was handed back. Zero until there is an entry for what came in. */
  changeSatang: number;
}

/**
 * THE TENDER OF A SALE THAT OWES NOTHING (L38) — what the ticket till sends to
 * close a ฿0 sale, where no method was chosen because none was used. The
 * platform takes no tender and records no payment when nothing is owed
 * (`finaliseSale` in apps/api/src/services/sale.ts), so these fields are never
 * read as a payment; `none` names no configured method, and a ฿0 amount is one
 * the platform refuses to settle anything with should the sale turn out to owe.
 */
export const NO_TENDER: SaleTenderPayload = {
  method: 'none',
  kind: 'other',
  amountSatang: 0,
  tenderedSatang: 0,
  changeSatang: 0,
};

/**
 * The finalise body.
 *
 * The tender rides BOTH nested and flat, for the same reason the commit's cart
 * does (see the route's own note): this half of the seam and the platform's
 * were built in parallel, and a body that satisfies either reading costs
 * nothing and cannot be the thing that refuses a sale at a counter. The api
 * slice owns which one it reads.
 */
export interface SaleFinaliseBody extends SaleTenderPayload {
  actionId: string;
  tender: SaleTenderPayload;
}

// --- What the platform answers ----------------------------------------------

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
}

/**
 * WHY A DOCUMENT CHECK THIS CART NAMED PRICED NOTHING — SCRUM-311.
 *
 * The platform answers this beside an ordinary quote, not as an error: the
 * cart is still priced, at the default rate, and this says what the till was
 * holding that no longer counts. One case produces it today — the claim has
 * already paid for a sale, so a second visitor cannot be rung up on the first
 * one's passport. `apps/api/src/services/sale-tier.ts` owns the vocabulary;
 * every other way a claim can fail is answered with silence and the default
 * tier, because a caller holding an action id that is not theirs is told
 * nothing.
 */
export interface TierClaimRefusal {
  code: 'TIER_CLAIM_SPENT';
  message: string;
  details: { claimId: string; saleId: string };
}

export interface ApiSaleQuote {
  pricingMode: RateMode;
  pricingModeReason: string;
  holidayName?: string | null;
  /** The trading day the platform placed this cart on. */
  businessDate?: string;
  /** The tier the PLATFORM resolved, which is the one that chose the prices. */
  tier?: string;
  /**
   * Where that tier came from: the member's record, the document check the
   * cart named, or the operator's default. `default` beside a refusal is the
   * till's signal that the discounted rate on its screen is no longer real.
   */
  tierSource?: 'member' | 'claim' | 'default';
  /** Set only when the claim this cart NAMED priced nothing. Null otherwise. */
  tierClaimRefusal?: TierClaimRefusal | null;
  totals: ApiSaleTotals;
  /** Resolved satang per line id, in cart order. */
  lineTotals: Record<string, number>;
  /** Resolved satang per manual discount id. */
  manualAmounts: Record<string, number>;
  appliedPromos: {
    code: string;
    label: string;
    type: 'percent' | 'fixed' | 'free_item';
    amountSatang: number;
    exhaustedReason?: string;
  }[];
  /** Codes the platform would not honour, each with the reason it gave. */
  rejectedPromoCodes?: { code: string; reason: string }[];
  /**
   * WHERE THE TILL AND THE PLATFORM SAW THIS CART DIFFERENTLY.
   *
   * Neither is refused — a cart left open across 05:00, or a member whose tier
   * was verified on another till mid-sale, are both ordinary — and the
   * platform's answer is the one charged. But staff are looking at a screen
   * that still shows the tier they picked and the mode the header chip showed,
   * so the difference is put in front of them rather than left in a payload.
   */
  disagreements?: {
    pricingModeSentByTill: string | null;
    tierSentByTill: string | null;
    pricingModeDiffers: boolean;
    tierDiffers: boolean;
  };
  taxBreakdown: EngineTaxBreakdown;
  engineVersion: string;
  /**
   * S2-10b — the voucher on this cart as the platform priced it: what it took
   * off, and — when the cart has nothing it can come off — why not. Null when
   * the cart carries none.
   */
  voucher?: QuotedVoucher | null;
}

/**
 * S2-10b — A HELD VOUCHER, PRICED ON THIS CART BY THE PLATFORM
 * (`PricedVoucher` in apps/api/src/services/sale.ts, less its engine input).
 * The till shows it; it never computes it.
 */
export interface QuotedVoucher {
  voucherId: string;
  code: string;
  definitionCode: string;
  label: string;
  effect: VoucherEffect;
  /** What it actually took off, in satang. */
  amountSatang: number;
  /** False, with the reason, when the cart has nothing it can come off. */
  applicable: boolean;
  reason: string | null;
}

export interface ApiSale {
  id: string;
  status: 'tendering' | 'paid' | 'finalised' | 'voided' | 'refunded';
  businessDate: string;
  occurredAt: string;
  receiptNumber?: string | null;
  receiptSeries?: string | null;
  receiptSeq?: number | null;
  stationId: string;
  boxId?: string | null;
  pricingMode: RateMode;
  customerTier: string;
  totals: ApiSaleTotals;
  engineVersion: string;
}

export interface SaleCommitResult {
  sale: ApiSale;
  /** True when the platform answered from the idempotency store rather than writing. */
  replay: boolean;
  /** S2-10b — the voucher this sale was priced with, when it carries one. */
  voucher?: QuotedVoucher | null;
}

/**
 * The till's Cancel of a sale it rang up (`POST /sales/:id/void`, S2-10b):
 * closed as void so it can never be paid, and any voucher it held let go.
 */
export interface SaleVoidAnswer {
  /** True when the sale was already void and this call changed nothing. */
  replay: boolean;
  sale: ApiSale;
  void: { voidedAt: string | null; voidedByAccountId: string | null; reason: string | null };
  /** The vouchers the void let go, by id — each free again for another cart. */
  releasedVoucherIds: string[];
}

export interface SaleFinaliseResult {
  sale: ApiSale;
  /** True when the sale was already finalised — a retry takes no second number. */
  replay: boolean;
  /** S2-10b — the vouchers this call used up, by id. Empty unless it closed a sale carrying one. */
  redeemedVoucherIds?: string[];
}

// --- The client -------------------------------------------------------------

/**
 * The idempotency key for a sale commit. Derived from the sale id rather than
 * minted per attempt, so every retry of one Pay press carries the same key and
 * the platform replays its own first answer instead of doing the work twice.
 */
export const saleIdempotencyKey = (saleId: string): string => `sale:${saleId}`;

/**
 * The finalise has a key of its own, derived from the same sale id.
 *
 * It has to differ from the commit's or the second call would be answered with
 * the first one's stored body — the sale as it was BEFORE it took its receipt
 * number — and the till would print a receipt with no number on it.
 */
export const saleFinaliseIdempotencyKey = (saleId: string, tender: SaleTenderPayload): string =>
  `sale:${saleId}:finalise:${tenderSignature(tender)}`;

/**
 * The tender is part of the key, so a DIFFERENT closing act gets a fresh one.
 *
 * The idempotency store keeps a refused answer as firmly as an accepted one —
 * only a server fault releases a key — so with the key on the sale id alone, a
 * Confirm that was refused (a partial amount, a station that could not number
 * the receipt) burnt the sale's one finalise key for good: staff switching to
 * another tender were answered IDEMPOTENCY_MISMATCH for ever, the panel called
 * that retryable, and Cancel — which discards the order — was the only way
 * out. A merge gate drove exactly that with money on the counter.
 *
 * With the tender in the key: the same tender retried through a dropped
 * connection is the same key and replays, which is the point; a corrected
 * tender is a new key and a new attempt. What it does NOT do is unstick a
 * refusal that repeating the same tender cannot fix — that is correct, the
 * platform said no to that exact act.
 */
function tenderSignature(tender: SaleTenderPayload): string {
  const s = JSON.stringify([
    tender.method,
    tender.kind,
    tender.amountSatang,
    tender.tenderedSatang,
    tender.changeSatang,
  ]);
  // A short stable digest — the header has a length limit and the values are
  // not secret. FNV-1a over UTF-16 code units, rendered as hex.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** What the till sends when staff confirm a discount-tier document. */
export interface SaleTierClaimBody {
  /** One tap on Confirm, however many HTTP attempts it takes. */
  actionId: string;
  branchId: string;
  toTier: string;
  /** The KIND of document — `Passport`, `School card`. Never its number. */
  evidenceType: string;
  /** The document's expiry, `YYYY-MM-DD`. */
  evidenceExpiresAt: string;
}

/** The claim as the platform answers it. The tier on it is the platform's. */
export interface ApiTierClaim {
  id: string;
  actionId: string;
  branchId: string;
  toTier: string;
  /** When it stops pricing anything. */
  expiresAt: string;
}

export const salesApi = {
  quote: (body: SaleCartPayload) => api.post<{ quote: ApiSaleQuote }>('/sales/quote', body),
  /**
   * SCRUM-307 — record the document staff just checked for a visitor who has
   * given no details yet, so the cart that follows is priced at the rate it
   * supports. The verifier and the branch are stamped from the session on the
   * platform's side; nothing here says who checked it.
   */
  tierClaim: (body: SaleTierClaimBody) =>
    api.post<{ claim: ApiTierClaim }>('/sales/tier-claims', body, {
      idempotencyKey: `tier-claim:${body.actionId}`,
      headers: { 'x-oto-action-id': body.actionId },
    }),
  /**
   * The action id rides in the body AND in `x-oto-action-id`, because the
   * platform reads either and the header is what a proxy, a log line and the
   * box journal can correlate on without parsing a body.
   */
  commit: (body: SaleCommitBody) =>
    api.post<SaleCommitResult>('/sales', body, {
      idempotencyKey: saleIdempotencyKey(body.id),
      headers: { 'x-oto-action-id': body.actionId },
    }),
  finalise: (saleId: string, body: SaleFinaliseBody) =>
    api.post<SaleFinaliseResult>(`/sales/${encodeURIComponent(saleId)}/finalise`, body, {
      idempotencyKey: saleFinaliseIdempotencyKey(saleId, body.tender),
      headers: { 'x-oto-action-id': body.actionId },
    }),
  /**
   * S2-10b — void a sale rung up that took no money. Four callers: the till's
   * Cancel (`cancel` in lib/saleWriter.ts); a corrected order after Pay, which
   * voids without asking the sale THIS screen rang up (`moveTo` in
   * lib/tillVoucher.ts, reason `ORDER_CHANGED_AFTER_PAY`); the offer on a
   * voucher refusal that names an unpaid sale left at this till (`voidRungUp`
   * in lib/tillVoucher.ts); and History's Void. The reason is required: a void
   * with none is what the voids report exists to stop. A fresh key per call,
   * because the platform keeps a refusal under its key as firmly as an answer,
   * and the tender that refused this void may since have failed.
   */
  voidSale: (saleId: string, reason: string) =>
    api.post<SaleVoidAnswer>(
      `/sales/${encodeURIComponent(saleId)}/void`,
      { reason },
      { idempotencyKey: idemKey() },
    ),
  get: (id: string) => api.get<{ sale: ApiSale }>(`/sales/${encodeURIComponent(id)}`),
  list: (params: { branchId?: string; businessDate?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.branchId) query.set('branchId', params.branchId);
    if (params.businessDate) query.set('businessDate', params.businessDate);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return api.get<{ sales: ApiSale[] }>(`/sales${suffix ? `?${suffix}` : ''}`);
  },
};

// --- Building the payload ---------------------------------------------------

export interface CartIdentity {
  branchId: string;
  stationId: string;
  tier: string;
  /** See `SaleCartPayload.tierClaimActionId` — set when a document was checked. */
  tierClaimActionId?: string | null;
  memberId?: string | null;
  customerPhone?: string | null;
  customerNickname?: string | null;
  /** The signed-in account, for the manual-discount rows the ledger requires. */
  accountId: string;
  accountName: string;
}

function promoPayload(promos: EngineCart['promos']): SaleCartPromoPayload[] {
  return promos.map((promo) => ({
    code: promo.code,
    label: promo.label,
    type: promo.type,
    value: promo.value,
    ...(promo.freeItemId ? { freeItemId: promo.freeItemId } : {}),
    ...(promo.freeItemKind ? { freeItemKind: promo.freeItemKind } : {}),
    ...(promo.target ? { target: promo.target } : {}),
  }));
}

/**
 * The cart as the platform receives it.
 *
 * Built from the ENGINE cart rather than from the prototype's cart, so the
 * figures the platform reconciles against are the same integers the local
 * engine priced — a rounding difference between the two representations cannot
 * appear between quoting a guest and charging them.
 */
export function buildCartPayload(
  lines: readonly CartLine[],
  discounts: readonly Discount[],
  manualDiscounts: readonly ManualDiscount[],
  identity: CartIdentity,
  totals: TicketCartTotals,
  options: {
    mode?: RateMode;
    modeReason?: string;
    config?: TaxConfig;
    /** S2-10b — the voucher held for this cart, by its code. See `SaleCartPayload.promoCodes`. */
    promoCodes?: readonly string[];
    /**
     * S2-10b — what the screen showed as the amount due, when that was the
     * platform's figure rather than this till's: a voucher's value is known
     * only to the platform, so a cart carrying one is charged the quoted total.
     */
    expectedTotalSatang?: number;
  } = {},
): SaleCartPayload {
  const rate = todayRateMode();
  const mode = options.mode ?? rate.mode;
  const cart = engineCart(lines, discounts, manualDiscounts, {
    mode,
    ...(options.config ? { config: options.config } : {}),
  });
  const byId = new Map(lines.map((line) => [line.id, line]));

  return {
    branchId: identity.branchId,
    stationId: identity.stationId,
    // The ticket counter. This builder serves the Tickets tab and nothing else;
    // the F&B and shop lanes go through `buildItemCartPayload` (SCRUM-343).
    channel: 'till',
    tier: identity.tier,
    ...(identity.tierClaimActionId ? { tierClaimActionId: identity.tierClaimActionId } : {}),
    pricingMode: mode,
    pricingModeReason: options.modeReason ?? rate.reason,
    socks: {
      addOnId: cart.ctx.socks.addOnId,
      unitSatang: cart.ctx.socks.price,
      label: cart.ctx.socks.label,
    },
    lines: cart.lines.map((line) => {
      const source = byId.get(line.id);
      return {
        // Translated at the wire — see `platformId`. The till keeps its own id.
        id: platformId(line.id),
        packageId: line.packageId,
        packageName: source?.ticketType.name ?? '',
        tier: line.tier,
        kids: line.kids,
        adults: line.adults,
        socks: line.socks,
        addOns: line.addOns.map((addOn) => ({
          id: addOn.id,
          name: addOn.name,
          unitSatang: addOn.price,
          quantity: addOn.quantity,
          ...(addOn.taxCategoryOverride ? { taxCategoryOverride: addOn.taxCategoryOverride } : {}),
          ...(addOn.variantBreakdown ? { variantBreakdown: addOn.variantBreakdown } : {}),
        })),
        serviceFee: line.serviceFee
          ? { label: line.serviceFee.label, amountSatang: line.serviceFee.amount }
          : null,
        foodProvision: line.foodProvision
          ? { mode: line.foodProvision.mode, paidSatang: line.foodProvision.paid }
          : null,
        promoItem: line.promoItem
          ? {
              itemId: line.promoItem.itemId,
              itemKind: line.promoItem.itemKind,
              name: line.promoItem.name,
              priceSatang: line.promoItem.price,
            }
          : null,
        lineTotalSatang: line.lineTotal,
        ...(source ? { stayHours: source.ticketType.hours } : {}),
        ...(source ? { stayDurationLabel: source.ticketType.durationLabel } : {}),
      };
    }),
    promos: promoPayload(cart.promos),
    manualDiscounts: manualDiscounts.map((discount) => {
      const engineValue = cart.manualDiscounts.find((m) => m.id === discount.id)?.value ?? 0;
      return {
        id: platformId(discount.id),
        scope: discount.scope,
        // The same translation, or a line-scoped discount would point at a line
        // id the platform has never seen and be treated as order-wide.
        ...(discount.targetLineId ? { targetLineId: platformId(discount.targetLineId) } : {}),
        ...(discount.targetComponent ? { targetComponent: discount.targetComponent } : {}),
        ...(discount.targetLabel ? { targetLabel: discount.targetLabel } : {}),
        type: discount.type,
        value: engineValue,
        reason: discount.reason,
        ...(discount.note ? { note: discount.note } : {}),
        // The ledger requires an account on every manual discount row. The
        // prototype stamps the operator's NAME and id onto the discount when it
        // is applied; the account id on the session is what the audit row needs,
        // and they are the same person at the same till.
        appliedByAccountId: discount.appliedById || identity.accountId,
        appliedByName: discount.appliedBy || identity.accountName,
        appliedAt: discount.appliedAt,
      };
    }),
    ...(options.promoCodes && options.promoCodes.length > 0
      ? { promoCodes: [...options.promoCodes] }
      : {}),
    memberId: identity.memberId ?? null,
    customerPhone: identity.customerPhone ?? null,
    customerNickname: identity.customerNickname ?? null,
    expectedTotalSatang: options.expectedTotalSatang ?? totals.total,
  };
}

// --- The F&B and shop cart, as the platform receives it (S2-09b) ------------

/**
 * Who an F&B or shop order belongs to, and which counter took it.
 *
 * The same identity a ticket cart carries, plus the two things an order has
 * that a ticket sale does not: the counter it was rung up at, and the pick-up
 * code the guest was given. `tier` rides along unused — an F&B item is priced
 * from the catalogue row and nothing else, with no tier table behind it — and
 * is kept only so one identity type serves both carts.
 *
 * `channel` does two jobs. On this side it is what tells the two stations apart
 * — which totals engine answers when the platform cannot. And since SCRUM-343
 * it is SENT: checked against the station, it becomes
 * `pos.sale.sales_channel`, so the food and shop takings are no longer filed
 * under the ticket counter. See `SaleCartPayload.channel`.
 */
export interface ItemCartIdentity extends CartIdentity {
  channel: 'fnb' | 'shop';
  pickupCode?: string | null;
}

/**
 * The F&B or shop cart as the platform receives it.
 *
 * THE LINES PASSED IN ARE THE ONES ON SCREEN. `lineTotalSatang` on each row and
 * `expectedTotalSatang` on the cart are read straight off them, which is what
 * makes them an honest statement of what the guest was shown: when the platform
 * has quoted the order, the screen is showing the platform's own figures and
 * the two agree by construction; when it could not be asked, the till's figures
 * go up and the platform refuses the commit if it prices the order differently.
 * Either way nothing is charged from a number that was never on a screen.
 *
 * THE PROMO CODES ARE THE STATION'S — SCRUM-344. `promos` was hard-coded to `[]`
 * here, and it had to be: the discount engine's `rowMatchesTarget` answered
 * `false` for the `fnb`, `fnbCategory`, `menuItems` and `merch` scopes on every
 * row and `true` for `addOns` on an item row, so sending a food-scoped code
 * would have taken nothing off and sending an add-on-scoped one would have
 * discounted the food. Both are fixed in the engine, so the codes the station
 * holds now travel with the order and the platform honours the scope.
 *
 * WHAT FOLLOWED FROM THAT, and it is answered — SCRUM-362. `computeFnbTotals`
 * and `computeMerchTotals` took no promo codes, so an order with a code on it
 * that the platform could not be reached for would have shown an undiscounted
 * figure on the screen and then been refused at the commit against it. Both now
 * take the codes and price them through the same engine the platform does
 * (`lib/itemPromo.ts`), and `localItemQuote` passes them on, so the fallback
 * figure and the platform's are the same figure.
 */
export function buildItemCartPayload(
  lines: readonly FnbOrderLine[] | readonly MerchOrderLine[],
  manualDiscounts: readonly ManualDiscount[],
  identity: ItemCartIdentity,
  shownTotal: number,
  options: {
    mode?: RateMode;
    modeReason?: string;
    promos?: readonly Discount[];
    /** S2-10b — the voucher held for this order, by its code. See `SaleCartPayload.promoCodes`. */
    promoCodes?: readonly string[];
  } = {},
): SaleCartPayload {
  const rate = todayRateMode();
  const mode = options.mode ?? rate.mode;
  const items = itemCart(lines);
  return {
    branchId: identity.branchId,
    stationId: identity.stationId,
    // Which counter this is — the F&B station or the shop (SCRUM-343).
    channel: identity.channel,
    tier: identity.tier,
    pricingMode: mode,
    pricingModeReason: options.modeReason ?? rate.reason,
    // No socks on an F&B or shop order; the field is the ticket cart's and the
    // platform reads it only when a line carries socks.
    socks: { addOnId: SOCKS_ADDON_ID, unitSatang: 0, label: SOCKS_LABEL },
    // No ticket lines on an order taken at the F&B or shop counter. The
    // platform's cart accepts either kind and refuses only a cart with neither.
    lines: [],
    items,
    // Omitted rather than sent as null: the route declares it optional, not
    // nullable, and a null would be refused by the schema before anything read it.
    ...(identity.pickupCode ? { pickupCode: identity.pickupCode } : {}),
    // The codes this station holds, in the engine's terms. Empty when it holds
    // none, which is every order today — see the note above.
    promos: promoPayload((options.promos ?? []).map(enginePromo)),
    ...(options.promoCodes && options.promoCodes.length > 0
      ? { promoCodes: [...options.promoCodes] }
      : {}),
    manualDiscounts: manualDiscounts.map((discount) => ({
      id: platformId(discount.id),
      scope: discount.scope,
      ...(discount.targetLineId ? { targetLineId: platformId(discount.targetLineId) } : {}),
      ...(discount.targetComponent ? { targetComponent: discount.targetComponent } : {}),
      ...(discount.targetLabel ? { targetLabel: discount.targetLabel } : {}),
      type: discount.type,
      value: engineManualDiscount(discount).value,
      reason: discount.reason,
      ...(discount.note ? { note: discount.note } : {}),
      appliedByAccountId: discount.appliedById || identity.accountId,
      appliedByName: discount.appliedBy || identity.accountName,
      appliedAt: discount.appliedAt,
    })),
    memberId: identity.memberId ?? null,
    customerPhone: identity.customerPhone ?? null,
    customerNickname: identity.customerNickname ?? null,
    expectedTotalSatang: toSatang(shownTotal),
  };
}

/**
 * THE ORDER'S PRICE, ON THIS DEVICE, when the platform cannot be asked.
 *
 * This is the prototype's own arithmetic (`lib/fnb.ts`, `lib/merch.ts`) and it
 * is labelled as such — `source: 'till'`, `engineVersion: 'prototype'` — for
 * the reason `cartQuote.ts` sets out: a figure on a screen has to say where it
 * came from, and an F&B order has no ticket cart for `@oto/shared` to price.
 * Nothing is SOLD from it silently: the commit carries it as
 * `expectedTotalSatang` and the platform refuses the sale if it disagrees.
 *
 * THE CODES ARE THE EXCEPTION TO "the prototype's own arithmetic" — SCRUM-362.
 * A promo code on the order is priced by `@oto/shared` over the same rows the
 * platform prices it over, inside those two helpers, because a code the till
 * discounted differently would be a commit the platform refuses.
 */
export function localItemQuote(
  kind: 'fnb' | 'shop',
  lines: readonly FnbOrderLine[] | readonly MerchOrderLine[],
  manualDiscounts: readonly ManualDiscount[],
  options: { config?: TaxConfig; reason?: string; promos?: readonly Discount[] } = {},
): CartQuote {
  const rate = todayRateMode();
  const promos = options.promos ?? [];
  const totals =
    kind === 'fnb'
      ? computeFnbTotals(
          [...(lines as readonly FnbOrderLine[])],
          [...manualDiscounts],
          options.config,
          promos,
        )
      : computeMerchTotals(
          [...(lines as readonly MerchOrderLine[])],
          [...manualDiscounts],
          options.config,
          promos,
        );
  return {
    totals: {
      subtotal: totals.subtotal,
      discountAmount: totals.promoDiscountAmount,
      scannedDiscounts: totals.appliedPromos,
      manualDiscountAmount: totals.manualDiscountAmount,
      manualAmounts: totals.manualAmounts,
      serviceChargeTotal: totals.serviceChargeTotal,
      taxTotal: totals.taxTotal,
      taxBreakdown: totals.taxBreakdown,
      total: totals.total,
    },
    satang: null,
    source: 'till',
    pricingMode: rate.mode,
    pricingModeReason: rate.reason,
    engineVersion: 'prototype',
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

/**
 * Why this order has nothing the platform can be asked about. Null when it has.
 *
 * An order made up entirely of prepaid entitlement lines is the case: every row
 * is ฿0 because it was paid for at a booking, the platform has no wallet or
 * entitlement ledger to take it off (S2-14a), and a cart with no rows on it is
 * refused as empty. So the platform is not asked, the order stands on this till
 * and the confirmation says so — rather than reception being shown a refusal
 * they can do nothing about while a guest waits for an ice cream somebody has
 * already paid for.
 */
export function offLedgerOnly(
  lines: readonly FnbOrderLine[] | readonly MerchOrderLine[],
): string | null {
  if (lines.length === 0) return null;
  if (itemCart(lines).length > 0) return null;
  return 'Every item on this order was prepaid at booking, which the ledger cannot record yet (S2-14a).';
}

export interface ItemQuoteArgs {
  kind: 'fnb' | 'shop';
  lines: readonly FnbOrderLine[] | readonly MerchOrderLine[];
  manualDiscounts: readonly ManualDiscount[];
  identity: ItemCartIdentity | null;
  /**
   * SCRUM-344 — the promo codes this station holds. Sent with the order so the
   * quote and the commit describe the same one, and applied by the local
   * fallback too since SCRUM-362, so the figure on the screen is the same
   * figure whichever side priced it.
   */
  promos?: readonly Discount[];
  /** S2-10b — the voucher held for this order, by its code. The platform prices it. */
  promoCodes?: readonly string[];
  config?: TaxConfig;
}

/**
 * The order's price, from the platform where it can be had — the F&B and shop
 * counterpart of `quoteCart`, and it follows the same three rules.
 *
 * The local figure is computed first and always, so the panel is never blank
 * while a round trip is in flight. A platform answer REPLACES it, per line and
 * in total. A refusal is not swallowed: a 4xx means the platform looked at this
 * order and objected — a required modifier nobody chose, a menu price that
 * moved — and the person at the counter must see that rather than be handed the
 * till's own figure as if the platform had agreed.
 */
export async function quoteItemCart(args: ItemQuoteArgs): Promise<CartQuote> {
  const { kind, lines, manualDiscounts, identity } = args;
  const local = localItemQuote(kind, lines, manualDiscounts, {
    ...(args.config ? { config: args.config } : {}),
    ...(args.promos ? { promos: args.promos } : {}),
  });
  if (!identity) return { ...local, reason: 'No station or branch on this device yet.' };
  const offLedger = offLedgerOnly(lines);
  if (offLedger) return { ...local, reason: offLedger };

  const payload = buildItemCartPayload(lines, manualDiscounts, identity, local.totals.total, {
    ...(args.promos ? { promos: args.promos } : {}),
    ...(args.promoCodes ? { promoCodes: args.promoCodes } : {}),
  });
  try {
    const { quote } = await salesApi.quote(payload);
    const notice = platformNoticeOf(quote);
    const localIds = (lines as readonly { id: string }[]).map((line) => line.id);
    const lineTotals: Record<string, number> = {};
    for (const [key, satang] of Object.entries(quote.lineTotals)) {
      lineTotals[localIdFor(localIds, key) ?? key] = toBaht(satang);
    }
    return {
      totals: quoteToTotals(quote, manualDiscounts.map((discount) => discount.id)),
      satang: null,
      source: 'platform',
      pricingMode: quote.pricingMode,
      pricingModeReason: quote.pricingModeReason,
      engineVersion: quote.engineVersion,
      lineTotals,
      ...(notice ? { platformNotice: notice } : {}),
      voucher: quote.voucher ?? null,
    };
  } catch (err) {
    if (isMissingRoute(err)) {
      return { ...local, reason: 'This deployment has no pricing route yet (SCRUM-203).' };
    }
    if (err instanceof ApiError) throw err;
    return {
      ...local,
      reason: 'The platform did not answer; this till priced the order.',
      unanswered: true,
    };
  }
}

// --- Totals, in the shape the prototype's components render -----------------

/** One applied code, as `OrderSummary` and the customer display draw it. */
export interface QuotedPromoLine {
  code: string;
  label: string;
  type: Discount['type'];
  amount: number;
  exhaustedReason?: string;
}

/**
 * EXACTLY THE SHAPE `lib/sale.ts:computeTotals` RETURNS, in baht.
 *
 * That is the point: every component that shows money already destructures
 * this, so the source of the numbers can change without a single one of them
 * being redesigned. What changes is where it comes from — `source` says which.
 */
export interface OrderTotals {
  subtotal: number;
  discountAmount: number;
  scannedDiscounts: QuotedPromoLine[];
  manualDiscountAmount: number;
  manualAmounts: Record<string, number>;
  serviceChargeTotal: number;
  taxTotal: number;
  taxBreakdown: PosTaxBreakdown;
  total: number;
}

function breakdownToBaht(breakdown: EngineTaxBreakdown): PosTaxBreakdown {
  const categories: PosCategoryTaxLine[] = breakdown.categories.map((category) => ({
    category: category.category,
    base: toBaht(category.base),
    taxMode: category.taxMode,
    ...(category.taxRateId ? { taxRateId: category.taxRateId } : {}),
    ...(category.taxName ? { taxName: category.taxName } : {}),
    taxPercent: category.taxPercent,
    serviceCharge: toBaht(category.serviceCharge),
    tax: toBaht(category.tax),
    ...(category.secondaryTaxRateId ? { secondaryTaxRateId: category.secondaryTaxRateId } : {}),
    ...(category.secondaryTaxName ? { secondaryTaxName: category.secondaryTaxName } : {}),
    secondaryTaxMode: category.secondaryTaxMode,
    secondaryTaxPercent: category.secondaryTaxPercent,
    secondaryTax: toBaht(category.secondaryTax),
    gross: toBaht(category.gross),
  }));
  return {
    netSubtotal: toBaht(breakdown.netSubtotal),
    discountTotal: toBaht(breakdown.discountTotal),
    serviceChargeTotal: toBaht(breakdown.serviceChargeTotal),
    exclusiveTaxTotal: toBaht(breakdown.exclusiveTaxTotal),
    inclusiveTaxTotal: toBaht(breakdown.inclusiveTaxTotal),
    taxTotal: toBaht(breakdown.taxTotal),
    categories,
    grandTotal: toBaht(breakdown.grandTotal),
  };
}

function promosToBaht(promos: readonly AppliedPromo[]): QuotedPromoLine[] {
  return promos.map((promo) => ({
    code: promo.code,
    label: promo.label,
    type: promo.type,
    amount: toBaht(promo.amount),
    ...(promo.exhaustedReason ? { exhaustedReason: promo.exhaustedReason } : {}),
  }));
}

function totalsToBaht(totals: TicketCartTotals): OrderTotals {
  const manualAmounts: Record<string, number> = {};
  for (const [id, satang] of Object.entries(totals.manualAmounts)) manualAmounts[id] = toBaht(satang);
  return {
    subtotal: toBaht(totals.subtotal),
    discountAmount: toBaht(totals.promoDiscountTotal),
    scannedDiscounts: promosToBaht(totals.appliedPromos),
    manualDiscountAmount: toBaht(totals.manualDiscountTotal),
    manualAmounts,
    serviceChargeTotal: toBaht(totals.serviceChargeTotal),
    taxTotal: toBaht(totals.taxTotal),
    taxBreakdown: breakdownToBaht(totals.taxBreakdown),
    total: toBaht(totals.total),
  };
}

/**
 * The same, from the platform's answer.
 *
 * `manualIds` are the till's own discount ids: the platform keys its amounts by
 * what it was sent, and the panel looks them up by the id it knows. Without the
 * translation back, every staff discount renders as ฿0 under a correct total —
 * see `localIdFor`.
 */
function quoteToTotals(quote: ApiSaleQuote, manualIds: readonly string[]): OrderTotals {
  const manualAmounts: Record<string, number> = {};
  for (const [key, satang] of Object.entries(quote.manualAmounts)) {
    manualAmounts[localIdFor(manualIds, key) ?? key] = toBaht(satang);
  }
  return {
    subtotal: toBaht(quote.totals.subtotalSatang),
    discountAmount: toBaht(quote.totals.promoDiscountSatang),
    scannedDiscounts: quote.appliedPromos.map((promo) => ({
      code: promo.code,
      label: promo.label,
      type: promo.type,
      amount: toBaht(promo.amountSatang),
      ...(promo.exhaustedReason ? { exhaustedReason: promo.exhaustedReason } : {}),
    })),
    manualDiscountAmount: toBaht(quote.totals.manualDiscountSatang),
    manualAmounts,
    serviceChargeTotal: toBaht(quote.totals.serviceChargeSatang),
    taxTotal: toBaht(quote.totals.taxInclusiveSatang + quote.totals.taxExclusiveSatang),
    taxBreakdown: breakdownToBaht(quote.taxBreakdown),
    total: toBaht(quote.totals.grossSatang),
  };
}

function apiTotals(totals: TicketCartTotals): ApiSaleTotals {
  return {
    subtotalSatang: totals.subtotal,
    manualDiscountSatang: totals.manualDiscountTotal,
    promoDiscountSatang: totals.promoDiscountTotal,
    discountSatang: totals.discountTotal,
    netSatang: totals.taxBreakdown.grandTotal - totals.serviceChargeTotal - totals.taxBreakdown.exclusiveTaxTotal,
    serviceChargeSatang: totals.serviceChargeTotal,
    taxInclusiveSatang: totals.taxBreakdown.inclusiveTaxTotal,
    taxExclusiveSatang: totals.taxBreakdown.exclusiveTaxTotal,
    grossSatang: totals.taxBreakdown.grandTotal,
    unappliedDiscountSatang: totals.taxBreakdown.unappliedDiscount,
  };
}

/**
 * WHERE THE NUMBER ON THE SCREEN CAME FROM.
 *
 *   platform  the platform priced this cart and these are its figures.
 *   till      the platform could not be asked, or has no pricing route on this
 *             deployment, and the till priced it — with the SAME engine
 *             (`@oto/shared`), in the same integer satang, but on this device.
 *
 * The distinction is shown to staff rather than kept in a log, because a till
 * that has quietly stopped agreeing with the platform is the failure this
 * whole ticket exists to make impossible, and nobody standing at a counter can
 * see it otherwise.
 */
export type QuoteSource = 'platform' | 'till';

export interface CartQuote {
  totals: OrderTotals;
  /** The same figures in satang — what a commit reconciles against. */
  satang: TicketCartTotals | null;
  /**
   * WHAT EACH ROW COSTS, in baht, keyed by the till's own cart line id.
   *
   * Set only on an F&B or shop order priced by the platform (S2-09b), where the
   * order panel draws a figure against every row and each one must be the
   * platform's rather than the browser's. A ticket cart's rows are drawn from
   * the cart line's own total and do not need it.
   */
  lineTotals?: Record<string, number>;
  source: QuoteSource;
  pricingMode: RateMode;
  pricingModeReason: string;
  engineVersion: string;
  /** Why the platform was not the source, when it was not. */
  reason?: string;
  /**
   * S2-10b — the platform was asked and nothing answered: no connection. Told
   * apart from a missing route or a device with no station, because it is the
   * one case where a voucher's card says "Vouchers can only be redeemed
   * online" — the platform's refusals are said in its own words
   * (`voucherUnpricedReason` in lib/tillVoucher.ts).
   */
  unanswered?: boolean;
  /**
   * Something the PLATFORM decided differently from the till, in one sentence
   * for the person at the counter: a tier it resolved differently, a rate mode
   * it placed the cart on, a promo code it would not honour. Absent when the
   * platform agreed with everything the till sent.
   */
  platformNotice?: string;
  /**
   * SCRUM-311 — the document check this cart named priced nothing, and why.
   *
   * Carried on the quote rather than folded into `platformNotice` because the
   * till does more than print it: it drops the tier back, restates the lines
   * and forgets the claim, and it needs the machine-readable code to know that
   * is what happened. Absent on a locally-priced quote, which has no claim to
   * refuse.
   */
  tierClaimRefusal?: TierClaimRefusal | null;
  /** Where the platform took the tier it priced at, when the platform priced it. */
  tierSource?: 'member' | 'claim' | 'default';
  /**
   * S2-10b — the voucher on this cart as the platform priced it. Absent on a
   * quote this till made itself: a voucher's value is the platform's alone.
   */
  voucher?: QuotedVoucher | null;
}

/**
 * A SELF-CHECK, BECAUSE `apps/pos` HAS NO TEST RUNNER.
 *
 * The engine is tested to 1,694 lines; the translation from this cart to it
 * (`lib/cartWire.ts`) is checked by the compiler and by somebody driving the
 * till. A wrong conversion there — a price left in baht, an adult rule's nested
 * price missed — would not fail to compile and would not look wrong on screen.
 * It would simply charge the visitor a hundredth or a hundred times the money.
 *
 * So in development the two arithmetics are compared on every quote and any
 * difference is reported, loudly, with both figures.
 *
 * WHERE THEY ARE ALLOWED TO DIFFER, and it is not a short list: rulings 1 and 2
 * in `cart-totals.ts` deliberately move money on carts with stacked or scoped
 * codes, and manual percent discounts round to the satang rather than to the
 * baht. A warning on those would be noise that trains the reader to ignore the
 * ones that matter. The comparison therefore runs only where the two are
 * REQUIRED to agree: at most one promo code, no free-item code, and no percent
 * discount of either kind.
 */
function warnOnDivergence(
  engineTotalSatang: number,
  prototypeTotalBaht: number,
  lines: readonly CartLine[],
  discounts: readonly Discount[],
  manualDiscounts: readonly ManualDiscount[],
): void {
  // `import.meta.env` is Vite's, and it is absent under a plain node runner —
  // where this module is perfectly loadable and where a check of this kind is
  // most likely to be run. Reading it defensively costs nothing and stops a
  // diagnostic from being the thing that throws.
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  if (!env?.DEV) return;
  if (discounts.length > 1) return;
  if (discounts.some((d) => d.type === 'free_item' || d.type === 'percent')) return;
  if (manualDiscounts.some((m) => m.type === 'percent')) return;
  const expected = toSatang(prototypeTotalBaht);
  if (expected === engineTotalSatang) return;
  // eslint-disable-next-line no-console
  console.warn(
    '[S2-09a] The platform engine and the prototype disagree on this cart. ' +
      `Engine ${engineTotalSatang} satang, prototype ${expected} satang. ` +
      'One of them is wrong about what a visitor owes — check apps/pos/src/lib/cartWire.ts.',
    { lines, discounts, manualDiscounts },
  );
}

/**
 * Price a cart on this device, with the platform's own engine.
 *
 * `staleLines: 'throw'` is deliberately left at its default: a cart whose
 * stored line totals were not priced under this rate mode is refused loudly
 * rather than totalled into a receipt that does not add up. The caller catches
 * it and shows the cart as unpriceable, which is recoverable; a receipt that
 * mixes Friday's prices with Saturday's is not.
 */
export function localQuote(
  lines: readonly CartLine[],
  discounts: readonly Discount[],
  manualDiscounts: readonly ManualDiscount[],
  options: { mode?: RateMode; modeReason?: string; config?: TaxConfig; reason?: string } = {},
): CartQuote {
  const rate = todayRateMode();
  const mode = options.mode ?? rate.mode;
  const cart = engineCart(lines, discounts, manualDiscounts, {
    mode,
    ...(options.config ? { config: options.config } : {}),
  });
  const totals = computeTicketCartTotals(
    cart.lines,
    cart.promos,
    cart.manualDiscounts,
    cart.config,
    cart.ctx,
  );
  warnOnDivergence(
    totals.total,
    computeTotals([...lines], [...discounts], [...manualDiscounts], options.config).total,
    lines,
    discounts,
    manualDiscounts,
  );
  return {
    totals: totalsToBaht(totals),
    satang: totals,
    source: 'till',
    pricingMode: mode,
    pricingModeReason: options.modeReason ?? rate.reason,
    engineVersion: totals.engineVersion,
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

/** A cart the engine will not price, and why. Null when it will. */
export function unquotableReason(lines: readonly CartLine[]): string | null {
  const unpriced = unpricedDropOffLines(lines);
  if (unpriced.length > 0) return 'A drop-off child has no play length chosen yet.';
  return null;
}

/**
 * What the platform changed about this cart, in words for the person taking
 * the money. Null when it agreed with everything the till sent.
 *
 * A rejected promo code is first in the list because it is the one a visitor
 * will ask about: without this, a code staff typed and saw accepted simply
 * takes nothing off, and reception has no answer.
 */
function platformNoticeOf(quote: ApiSaleQuote): string | null {
  const parts: string[] = [];
  for (const rejected of quote.rejectedPromoCodes ?? []) {
    parts.push(`${rejected.code} was not applied — ${rejected.reason}`);
  }
  if (quote.disagreements?.tierDiffers) {
    parts.push(`priced at the ${quote.tier ?? 'resolved'} rate, not the one selected here`);
  }
  if (quote.disagreements?.pricingModeDiffers) {
    parts.push(`priced as ${quote.pricingMode} — ${quote.pricingModeReason}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface QuoteCartArgs {
  lines: readonly CartLine[];
  discounts: readonly Discount[];
  manualDiscounts: readonly ManualDiscount[];
  identity: CartIdentity | null;
  mode?: RateMode;
  modeReason?: string;
  config?: TaxConfig;
  /** S2-10b — the voucher held for this cart, by its code. The platform prices it. */
  promoCodes?: readonly string[];
}

/**
 * THE CART'S PRICE, FROM THE PLATFORM WHERE IT CAN BE HAD.
 *
 * The local engine runs first and always, for two reasons that are not
 * interchangeable: it is the answer when the platform has no route or no
 * connection, and it is the figure the commit reconciles against
 * (`expectedTotalSatang`) so the platform can refuse to charge a number the
 * guest was never shown.
 *
 * A platform answer then REPLACES it. A refusal from the platform is NOT
 * swallowed into the local answer — a 4xx means the platform has looked at this
 * cart and objected, and the till must show that rather than quietly charging
 * its own figure. Only "there is no such route here" and "nothing answered"
 * fall back.
 */
/**
 * SCRUM-307 — hand the document check to the platform, and get back the action
 * id the cart carries from here on.
 *
 * Called at the moment staff confirm a passport or a certificate for somebody
 * who has not given their details yet. Everything after it — the quote, the
 * sale — prices from the claim this writes, so it is awaited rather than fired
 * off: a cart quoted before the claim lands is a cart quoted at the tourist
 * rate, which is the disagreement that made these sales impossible to
 * complete. It throws on refusal, because a discounted rate the platform has
 * not recorded is one nobody can charge.
 */
export async function claimVerifiedTier(input: {
  branchId: string;
  tier: string;
  /** The document type as the modal named it. */
  proofType: string;
  /** `YYYY-MM-DD`. */
  expiresAt: string;
}): Promise<string> {
  const actionId = newId();
  await salesApi.tierClaim({
    actionId,
    branchId: input.branchId,
    toTier: input.tier,
    evidenceType: input.proofType,
    evidenceExpiresAt: input.expiresAt,
  });
  return actionId;
}

export async function quoteCart(args: QuoteCartArgs): Promise<CartQuote> {
  const { lines, discounts, manualDiscounts, identity } = args;
  const local = localQuote(lines, discounts, manualDiscounts, {
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.modeReason ? { modeReason: args.modeReason } : {}),
    ...(args.config ? { config: args.config } : {}),
  });
  if (!identity || !local.satang) {
    return { ...local, reason: 'No station or branch on this device yet.' };
  }

  const payload = buildCartPayload(lines, discounts, manualDiscounts, identity, local.satang, {
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.modeReason ? { modeReason: args.modeReason } : {}),
    ...(args.config ? { config: args.config } : {}),
    ...(args.promoCodes ? { promoCodes: args.promoCodes } : {}),
  });

  try {
    const { quote } = await salesApi.quote(payload);
    const notice = platformNoticeOf(quote);
    return {
      totals: quoteToTotals(quote, manualDiscounts.map((discount) => discount.id)),
      satang: local.satang,
      source: 'platform',
      pricingMode: quote.pricingMode,
      pricingModeReason: quote.pricingModeReason,
      engineVersion: quote.engineVersion,
      ...(notice ? { platformNotice: notice } : {}),
      ...(quote.tierClaimRefusal ? { tierClaimRefusal: quote.tierClaimRefusal } : {}),
      ...(quote.tierSource ? { tierSource: quote.tierSource } : {}),
      voucher: quote.voucher ?? null,
    };
  } catch (err) {
    if (isMissingRoute(err)) {
      return { ...local, reason: 'This deployment has no pricing route yet (SCRUM-203).' };
    }
    if (err instanceof ApiError) throw err;
    return {
      ...local,
      reason: 'The platform did not answer; this till priced the cart.',
      unanswered: true,
    };
  }
}

/** A sale the platform could not be asked to write, because the route is not there. */
export class SalesLedgerUnavailable extends Error {
  constructor() {
    super('This deployment has no sales ledger yet (SCRUM-203).');
    this.name = 'SalesLedgerUnavailable';
  }
}

export interface CommitSaleArgs {
  saleId: string;
  actionId: string;
  cart: SaleCartPayload;
  occurredAt: string;
  note?: string | null;
  /** Close it in the same call — a ฿0 sale, where the caller wants that. See `SaleCommitBody.finalise`. */
  finalise: boolean;
}

/**
 * Write the sale — unfinalised unless it owes nothing and the caller asked.
 *
 * Every attempt at one cart calls this with the same `saleId`, `actionId` and
 * `occurredAt`, so the platform answers the first attempt's result rather than
 * writing a second sale — by the idempotency key, by the primary key, and by
 * `sale_action_unique`, in that order of who catches it first.
 *
 * `SalesLedgerUnavailable` is thrown — not swallowed — when the route does not
 * exist, so the caller decides what to tell the person at the counter. It is
 * the one failure that is certainly not a lost sale on the platform's side.
 */
export async function commitSale(args: CommitSaleArgs): Promise<SaleCommitResult> {
  const body: SaleCommitBody = {
    id: args.saleId,
    actionId: args.actionId,
    cart: args.cart,
    occurredAt: args.occurredAt,
    note: args.note ?? null,
    finalise: args.finalise,
  };
  try {
    return await salesApi.commit(body);
  } catch (err) {
    if (isMissingRoute(err)) throw new SalesLedgerUnavailable();
    throw err;
  }
}

/**
 * Close the sale: the tender completed, so the receipt number is allocated.
 *
 * Separate from the commit because they answer to different presses — Pay
 * records what was sold, the tender records that the money arrived — and
 * because a sale that is written but not yet paid for is a state the park
 * genuinely has: a visitor who walks away at the counter leaves a `tendering`
 * row and no receipt, which is the truth about what happened.
 *
 * Retrying is safe: the platform returns a finalised sale unchanged rather
 * than taking a second number from the station's series.
 */
export async function finaliseSale(
  saleId: string,
  actionId: string,
  tender: SaleTenderPayload,
): Promise<SaleFinaliseResult> {
  const body: SaleFinaliseBody = { ...tender, actionId, tender };
  try {
    return await salesApi.finalise(saleId, body);
  } catch (err) {
    if (isMissingRoute(err)) throw new SalesLedgerUnavailable();
    throw err;
  }
}

/** The local engine's figures in the platform's own totals shape, for a sale that was not written. */
export function localSaleTotals(totals: TicketCartTotals): ApiSaleTotals {
  return apiTotals(totals);
}

/**
 * THE FIGURES A FINISHED SALE CARRIES, so that nothing downstream re-totals it.
 *
 * `written` is the row the platform holds. Where there is one, its money is the
 * money: the receipt, the confirmation screen and the history detail then read
 * the same satang the park is audited on rather than a second arithmetic that
 * happens to agree. Where there is none — no ledger on this deployment, no
 * station — the quote that was shown to the visitor stands, and `source` says
 * which of the two this was.
 *
 * The tax ROWS come from the quote either way: the sale row carries the money
 * split four ways, not the per-category breakdown a receipt prints.
 */
export function quotedPricing(quote: CartQuote, written?: ApiSale | null): SaleQuotedPricing {
  const taxRows = summarizeTax(quote.totals.taxBreakdown);
  if (!written) {
    return {
      source: quote.source,
      engineVersion: quote.engineVersion,
      total: quote.totals.total,
      subtotal: quote.totals.subtotal,
      discountAmount: quote.totals.discountAmount,
      manualDiscountAmount: quote.totals.manualDiscountAmount,
      serviceChargeTotal: quote.totals.serviceChargeTotal,
      taxTotal: quote.totals.taxTotal,
      taxRows,
    };
  }
  return {
    source: 'platform',
    engineVersion: written.engineVersion,
    total: toBaht(written.totals.grossSatang),
    subtotal: toBaht(written.totals.subtotalSatang),
    discountAmount: toBaht(written.totals.promoDiscountSatang),
    manualDiscountAmount: toBaht(written.totals.manualDiscountSatang),
    serviceChargeTotal: toBaht(written.totals.serviceChargeSatang),
    taxTotal: toBaht(written.totals.taxInclusiveSatang + written.totals.taxExclusiveSatang),
    taxRows,
  };
}

export { toSatang };
