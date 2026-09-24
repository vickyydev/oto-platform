import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import {
  account,
  branch,
  branchHoliday,
  branchTaxConfig,
  employee,
  member,
  modifierGroup,
  modifierOption,
  paymentAttempt,
  product,
  productCategory,
  productModifierGroup,
  receiptSeries,
  sale,
  saleDiscount,
  saleLine,
  saleTierClaim,
  station,
  ticketPackage,
  tier,
  visit,
  type SaleClockTrust,
  type SaleLineKind,
  type SalesChannel,
  type SaleStatus,
  type StationCapability,
  type StationKind,
} from '@oto/db';
import {
  apportion,
  businessDate,
  cartUnits,
  componentKey,
  computeTicketCartTotals,
  getRateModeForDate,
  newId,
  parseDayStart,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  PAYMENT_ATTEMPT_TERMINAL_STATUSES,
  PRICING_ENGINE_VERSION,
  priceCartLine,
  resolveRate,
  SERVICE_FEE_ROW_KEY,
  type CartAddOn,
  type CartPromo,
  type CartUnit,
  type DiscountComponentTarget,
  type ManualDiscount,
  type PrepStation,
  type PricingContext,
  type PromoDiscount,
  type TaxableCategory,
  type TaxConfigShape,
  type TicketCartLine,
  type TicketCartTotals,
  type PaymentAttemptView,
} from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import {
  attemptView,
  attemptsForSale,
  findAttemptByAction,
  openAttempt,
  outstandingAfter,
  settleAttempt,
  tenderMethodOf,
} from './payments/attempt';
import { resolveDrawerKick, type DrawerKick } from './payments/drawer';
import { resolveLineVariant, variantLineLabel } from './product-variants';
import {
  assertModifierSelection,
  effectiveModifierGroups,
  resolveItemPrepStations,
  resolveItemTaxCategories,
  type ModifierGroupWithOptions,
} from './menu';
import { resolveTierClaim, spendTierClaim, type TierClaimRefusal } from './sale-tier';
import type { Exec, Tx } from './tx';
import {
  assertSaleVouchersHeld,
  auditVoidReleases,
  consumeSaleVouchers,
  lockVouchersHeldFor,
  recordVoucherApplied,
  resolveCartVoucher,
  voucherConfiguredValue,
  voucherPricing,
  type CartVoucherClaim,
  type VoucherEffect,
} from './vouchers';

/**
 * S2-09a (SCRUM-203) — the service that prices a cart and writes a sale.
 *
 * WHY IT EXISTS AND WHAT IT REPLACES. Until this file the till could reach
 * "Pay ฿1,440" and nothing happened: `recordSale` in `apps/pos` pushed onto an
 * in-memory array a refresh threw away, and it got its figures from the
 * prototype's own copy of the pricing rules, in baht floats, in the browser.
 * Meanwhile the ported, tested engine in `@oto/shared` — pricing, tax,
 * discounts, promos, rounding, business date, ~1,600 lines under a 1,694-line
 * suite — had exactly ONE caller in the platform, the public booking quote.
 * Two answers to "what does this cost" is one answer too many, so everything
 * here prices through that engine and nothing here re-derives a rule.
 *
 * THE TWO RULES THAT DECIDE WHOSE NUMBER WINS, both enforced below:
 *
 *   1. THE PRICE IS THE PLATFORM'S. Every figure that moves money — the unit
 *      prices, the rate mode, the add-on prices, the tax, the discount amounts
 *      — is resolved here from the catalogue and the branch configuration. The
 *      cart says WHAT was sold (which package, how many kids, which add-ons)
 *      and never what it cost. A caller may send `expectedTotalSatang`, and
 *      the only thing that does is make a disagreement LOUD: the sale is
 *      refused (`SALE_TOTAL_MISMATCH`) rather than either number being taken
 *      on trust.
 *   2. THE TIER IS RESOLVED FROM THE MEMBER. Never from the request body. The
 *      tier picks the price, and it is the one field a visitor would most like
 *      to change; a body-supplied tier is a price list anybody can choose from.
 *      A sale with no member is priced at the operator's default tier.
 */

// --- Inputs -----------------------------------------------------------------

/**
 * An add-on on a cart line.
 *
 * `id` IS RESOLVED AGAINST `pos.product` FIRST, and when it resolves that row
 * is the price — the catalogue's answer beats the till's. When it does not
 * (the add-on catalogue is S2-09b; the prototype's ids are strings like
 * `a-locker`, not platform uuids) the till's snapshot is used, because the
 * alternative is a park that cannot sell socks or a locker until that ticket
 * lands. Every line priced that way carries `payload.priceSource =
 * 'till_snapshot'`, so "which of these figures did the platform stand behind"
 * is answerable from the ledger instead of from memory.
 */
export interface CartAddOnInput {
  id: string;
  name?: string;
  unitSatang?: number;
  quantity: number;
  taxCategoryOverride?: TaxableCategory;
  variantBreakdown?: { variantId: string; variantLabel: string; quantity: number }[];
}

export interface CartLineInput {
  /** The till's own cart line id (UUIDv7), kept on every unit of the line. */
  id: string;
  packageId: string;
  kids: number;
  adults: number;
  socks?: number;
  addOns?: CartAddOnInput[];
  /** Drop-off / nanny fee (S2-13 owns where the number comes from). */
  serviceFee?: { label: string; amountSatang: number } | null;
  foodProvision?: { mode: 'prepaid_items' | 'prepaid_credit'; paidSatang: number } | null;
  promoItem?: { itemId: string; itemKind: 'menu' | 'merch'; name: string; priceSatang: number } | null;
  /**
   * WHAT THE SCREEN SHOWED FOR THIS LINE. Not an instruction to charge it: the
   * platform prices the line from its own catalogue and refuses the sale when
   * the two disagree, so a till holding a package whose price was edited while
   * the cart was open is stopped rather than quietly charging the new number
   * after quoting the old one.
   */
  lineTotalSatang?: number;
}

/**
 * S2-09b (SCRUM-204) — AN F&B OR SHOP LINE ON THE CART.
 *
 * WHAT IT SAYS AND WHAT IT DOES NOT. A product id, how many, which modifier
 * options were chosen, what staff typed on it and — for a merch item that has sizes —
 * which size came off the shelf. NOT a price: the unit price is composed here
 * from `pos.product` and `pos.modifier_option`, the same way the prototype's
 * `computeUnitPrice` composes it in the browser (`lib/fnb.ts:28-42`), and
 * `lineTotalSatang` is reconciled against that rather than charged.
 *
 * IDENTICAL LINES ARE MERGED ON THE TILL, NOT HERE. The prototype merges an
 * item into a twin only when the item, the modifier signature, the note AND the
 * variant all match (`pages/OrderStation.tsx:236-243`), because a differing
 * note has to reach the kitchen as its own line. That is a decision about what
 * the guest asked for, made where the cart is edited; the platform records what
 * it is sent, so two lines arriving with different notes become two rows.
 */
export interface CartItemLineInput {
  /** The till's own order-line id (UUIDv7), kept on the sale line. */
  id: string;
  /** A `pos.product` of kind `menu` or `merch`. */
  productId: string;
  quantity: number;
  /** The prototype's `SelectedModifier[]` — a group, and the options chosen under it. */
  modifiers?: { groupId: string; optionIds: string[] }[];
  /** Free-text per-item note: "no pickles". Follows the item to its prep station. */
  note?: string;
  /**
   * Which size came off the shelf.
   *
   * ON A SHOP LINE the id is checked against the item's own sizes
   * (`product.variants`, S2-09b): a size the item does not have is refused, and
   * so is a line that names none when the item comes in two sizes or more. The
   * label recorded is the catalogue's; `variantLabel` here is only what the
   * screen showed. ON AN F&B LINE it is carried as sent and checked against
   * nothing: the item routes accept sizes on an item of any kind, but only a
   * shop line is read against them, and stock by flavour is S2-14b.
   */
  variant?: { variantId: string; variantLabel: string } | null;
  /** What the screen showed for this line. Reconciled against the platform's price, never charged. */
  lineTotalSatang?: number;
}

export interface ManualDiscountInput {
  id: string;
  scope: 'order' | 'line';
  targetLineId?: string;
  targetComponent?: DiscountComponentTarget;
  targetLabel?: string;
  type: 'percent' | 'fixed' | 'comp';
  /** A percentage for `percent`, SATANG for `fixed`, ignored for `comp`. */
  value: number;
  reason: string;
  note?: string;
}

export interface CartInput {
  branchId?: string;
  memberId?: string | null;
  /**
   * The branch's socks add-on. Socks are a separate integer on a cart line in
   * the prototype rather than an add-on row (`lib/pricing.ts`), so the engine
   * takes them as context. Resolved against `pos.product` when the id is one,
   * and otherwise the till's snapshot, exactly as add-ons are.
   */
  socks?: { addOnId: string; unitSatang?: number; label?: string };
  /**
   * The ticket lines. Optional since S2-09b: an F&B or shop order carries none,
   * and the cart is refused only when it has neither kind of line.
   */
  lines?: CartLineInput[];
  /** S2-09b — the F&B and shop lines on this cart. See `CartItemLineInput`. */
  items?: CartItemLineInput[];
  /**
   * S2-09b — the order's pick-up code, minted by the till.
   *
   * The prototype keys it on a number pad before the payment stage and prints
   * it on the receipt and on both prep tickets
   * (`components/fnb/PickupCodeModal.tsx`, `lib/fnb.ts:buildPrepTickets`), so a
   * guest can be handed the right tray. It is a label, not money: the platform
   * checks its shape, records it, and REQUIRES one before a sale carrying any
   * F&B line can be finalised — see `assertPickupCode`.
   */
  pickupCode?: string;
  manualDiscounts?: ManualDiscountInput[];
  /**
   * Promo codes the till resolved from its own catalogue.
   *
   * THE PLATFORM HAS NO PROMO-CODE TABLE YET — the Discounts and promo codes
   * panel is S2-09b — so there is nothing here to validate a code's limits,
   * its expiry or its very existence against, and the definition arrives with
   * the code. What keeps that from being a discount anybody can write is the
   * same thing that governs a manual one: `pos:sale:discount`, an audited row
   * naming who applied it, and the discounts-given report. It grants no
   * authority a staff member does not already have — there is no manager
   * approval step on discounts anywhere in this system, by design (R-08).
   * When S2-09b lands the catalogue, the definition comes from it and this
   * becomes the code alone.
   */
  promos?: PromoDiscountInput[];
  /**
   * Codes with no definition attached: refused by name, and nothing is taken off.
   *
   * S2-10b — EXCEPT A VOUCHER'S. A booth voucher (or any voucher held at this
   * till) named here is resolved by `resolveCartVoucher` and priced from its
   * definition: the till names the voucher, the platform says what it is
   * worth. This is the list a scanner typing into the promo box already fills,
   * and the one field on the cart body the route passes through for a code
   * the till could not price itself.
   */
  promoCodes?: string[];
  /**
   * S2-10b — the till the cart is being rung up at, as the cart body already
   * carries it. A QUOTE finds a voucher only among those held at this till;
   * a commit uses the station it is written against instead.
   */
  stationId?: string;
  /**
   * SCRUM-343 — WHICH LANE OF THE TILL RANG THIS UP: the ticket counter, the
   * F&B counter or the shop.
   *
   * It is a claim, not an instruction. `resolveSalesChannel` checks it against
   * the station before anything is written — see that function for what the
   * station's own row can and cannot answer — and the checked value is what
   * lands on `pos.sale.sales_channel`. A cart that names none is recorded under
   * the station's own channel, which is what every sale before this ticket got.
   */
  channel?: SalesChannel;
  /** The rate mode the cart was priced under at the till. Compared, never used. */
  pricingMode?: 'weekday' | 'weekend';
  /** The tier the till believed. Compared, never used: see rule 2 at the top. */
  tier?: string;
  /**
   * SCRUM-307 — the action id of the document check reception recorded through
   * `POST /sales/tier-claims`. A pointer to a claim row, never a tier; declared
   * here so the route cannot carry it on a cast alone.
   */
  tierClaimActionId?: string | null;
}

export interface PromoDiscountInput {
  code: string;
  label: string;
  type: 'percent' | 'fixed' | 'free_item';
  /** A percentage for `percent`; satang for `fixed` and `free_item`. */
  value: number;
  freeItemId?: string;
  freeItemKind?: 'menu' | 'merch';
  target?: unknown;
}

export interface CommitSaleInput extends CartInput {
  /** Client-minted UUIDv7. Re-sending it returns the sale that exists. */
  id?: string;
  stationId: string;
  visitId?: string | null;
  note?: string;
  /** `x-oto-action-id` — one tap, however many HTTP attempts it took. */
  actionId?: string | null;
  /**
   * The till's clock when Pay was pressed, ISO 8601. Believed within the same
   * tolerance the sync path applies to a box's clock, and overruled outside it
   * — see `resolveOccurredAt`.
   */
  occurredAt?: string;
  /** What the till last showed the guest. Compared, never trusted. */
  expectedTotalSatang?: number;
  /**
   * Finalise in the same transaction when there is nothing to tender — a ฿0
   * comp, a fully discounted visit. A cart that owes money is committed
   * unfinalised whatever this says, and the answer reports `finalised: false`
   * with what is left to take: see the seam described on `commitSale`.
   */
  finalise?: boolean;
}

export interface ActorContext {
  accountId: string;
  operatorId: string;
  branchId: string | null;
  requestId?: string;
  /**
   * THE SCOPE CHECK ON THE BRANCH THIS CART TURNS OUT TO BE FOR, supplied by
   * the route and run here rather than there.
   *
   * A route guard can only check what is in the request. The branch a sale is
   * written to is not: the cart may name it, may nest it under `cart`, or may
   * name none at all and inherit the station's — and `requirePermission` falls
   * back to the SESSION's branch when the target is empty, so a guard with no
   * target passes whatever branch the cart is actually for. That is how
   * reception scoped to one branch wrote a sale onto another and only found
   * out when reading it back returned 403.
   *
   * So the check runs at the one point the answer is known: after the branch
   * is resolved and before anything is written. Optional only so a caller with
   * no request behind it (a seed, a future box replay) can be written; every
   * route supplies it.
   */
  assertBranchAllowed?: (branchId: string) => Promise<void>;
}

// --- Pricing ----------------------------------------------------------------

/** The branch's answer to "what day is it and what does that cost". */
interface PricingScope {
  branchId: string;
  operatorId: string;
  timezone: string;
  businessDayStart: string;
  businessDate: string;
  pricingMode: 'weekday' | 'weekend';
  pricingModeReason: string;
  holidayId: string | null;
  holidayName: string | null;
  taxConfig: TaxConfigShape;
}

/**
 * Where and when the sale is happening, resolved server-side from the branch's
 * clock — never from the request.
 *
 * `businessDate` is the trading day, not the calendar day: a sale at 00:30
 * belongs to the day that is finishing (`business_day_start`, 05:00 here), and
 * the engine's ruling 3 says the same date also chooses the price. A caller
 * that could pass its own date could choose weekend pricing on a Tuesday, so
 * there is no parameter for it. The station-level "business date override"
 * S2-09a describes for reproducible weekend demos is a separate, staging-only
 * control and is not built; a `branch_holiday` range covering today produces
 * the same weekend prices and is how the tests reach them.
 */
export async function resolvePricingScope(
  db: Exec,
  branchId: string,
  operatorId: string,
  now: Date,
): Promise<PricingScope> {
  const [br] = await db.select().from(branch).where(eq(branch.id, branchId)).limit(1);
  if (!br || br.operatorId !== operatorId) throw errors.notFound('Branch not found');

  const date = businessDate(now, br.timezone, parseDayStart(br.businessDayStart));
  const holidays = await db
    .select()
    .from(branchHoliday)
    .where(and(eq(branchHoliday.branchId, br.id), isNull(branchHoliday.archivedAt)));
  const rate = getRateModeForDate(
    date,
    holidays.map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
  );
  // The range that forced weekend pricing, so the sale can name it years later
  // even if the calendar is edited. Same predicate the engine matched on.
  const holiday = rate.overrideName
    ? (holidays.find(
        (h) => h.name === rate.overrideName && date >= h.startsOn && date <= h.endsOn,
      ) ?? null)
    : null;

  const [cfg] = await db
    .select()
    .from(branchTaxConfig)
    .where(eq(branchTaxConfig.branchId, br.id))
    .limit(1);
  if (!cfg) {
    throw errors.badRequest(
      'This branch has no tax configuration, so nothing can be priced (SCRUM-37)',
    );
  }

  return {
    branchId: br.id,
    operatorId: br.operatorId,
    timezone: br.timezone,
    businessDayStart: br.businessDayStart,
    businessDate: date,
    pricingMode: rate.mode,
    pricingModeReason: rate.reason,
    holidayId: holiday?.id ?? null,
    holidayName: holiday?.name ?? null,
    taxConfig: cfg.config as TaxConfigShape,
  };
}

/**
 * The tier that prices this cart, from the MEMBER — or the operator's default
 * for a walk-in. Never from the request body: see rule 2 at the top.
 */
async function resolveTier(
  db: Exec,
  operatorId: string,
  memberId: string | null | undefined,
): Promise<{ code: string; source: 'member' | 'default' }> {
  if (memberId) {
    const [m] = await db.select().from(member).where(eq(member.id, memberId)).limit(1);
    if (!m || m.operatorId !== operatorId) throw errors.notFound('Member not found');
    return { code: m.tierCode, source: 'member' };
  }
  const [fallback] = await db
    .select()
    .from(tier)
    .where(and(eq(tier.operatorId, operatorId), eq(tier.isDefault, true), isNull(tier.archivedAt)))
    .limit(1);
  // The seed guarantees one default tier per operator; an operator configured
  // without one still has to price a walk-in, and `tourist` is the platform's
  // no-verification baseline (CLAUDE.md §4).
  return { code: fallback?.code ?? 'tourist', source: 'default' };
}

/**
 * What a `pos.sale_line` carries that has no column of its own.
 *
 * `price_source` was the whole of it in S2-09a. S2-09b adds what an F&B or
 * shop line is made of: the options the guest chose and what each one cost,
 * the note that follows the item to its station, the size that came off the
 * shelf, where the prep ticket prints, and the order's pick-up code.
 *
 * EVERY ONE OF THOSE IS FROZEN ON THE LINE rather than left to a join. A
 * modifier option can be renamed, re-priced or withdrawn tomorrow; the receipt
 * this guest was handed cannot change with it, and neither can the record of
 * what the kitchen was asked to make.
 */
export interface SaleLinePayload {
  /** Non-null when this unit's price came from the till rather than the catalogue. */
  priceSource?: 'till_snapshot';
  /** The chosen options, in the order the item asks its groups, with the per-unit delta each added. */
  modifiers?: {
    groupId: string;
    groupName: string;
    optionId: string;
    optionName: string;
    unitSatang: number;
  }[];
  /** The prototype's per-item note (`FnbOrderLine.note`). */
  note?: string;
  /**
   * The size sold. On a shop line, the item's own size — its id and its label
   * as the catalogue names it (`product.variants`); on an F&B line, what the
   * till sent (`FnbOrderLine.variantId` / `variantLabel`).
   */
  variant?: { variantId: string; variantLabel: string };
  /** Where this item's prep ticket prints: override → category → parent → kitchen. */
  prepStation?: PrepStation;
  /** The order's pick-up code, on every F&B line so each prep ticket carries it. */
  pickupCode?: string;
  /**
   * S2-10b — on the free item a voucher put on the bill: which voucher, so the
   * receipt, a refund and a report can say why this line cost nothing.
   */
  voucher?: { id: string; code: string };
}

/** A priced unit, ready to become a `pos.sale_line` row. */
export interface PricedLine {
  lineNo: number;
  cartLineId: string;
  kind: SaleLineKind;
  componentKey: string | null;
  ticketPackageId: string | null;
  productId: string | null;
  label: string;
  /**
   * The reporting bucket this unit's money lands in — what the Sale detail
   * view groups by and what a day's mix is counted from.
   *
   * Taken from the engine's own category for the unit, the areas
   * `TAXABLE_CATEGORIES` names in `@oto/shared`. Not a second list invented
   * here: the tax cascade has already split this cart by area, and a separate
   * hand-made mapping would be a second answer to "what kind of money is
   * this" that could disagree with the one the tax was charged on. S2-09b
   * gives packages and add-ons a catalogue-defined revenue category and
   * sub-category of their own; until then this column carries the engine's and
   * `revenue_sub_category` stays null rather than holding a guess.
   */
  revenueCategory: string;
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
  taxRateId: string | null;
  taxName: string | null;
  grossSatang: number;
  customerTier: string;
  kidCount: number;
  adultCount: number;
  freeAdultCount: number;
  stayHours: number | null;
  stayDurationLabel: string | null;
  /** What this unit carries that has no column. See `SaleLinePayload`. */
  payload: SaleLinePayload | null;
}

export interface PricedCart {
  scope: PricingScope;
  /**
   * The tier that chose the prices, and where it came from: the MEMBER's
   * record, a document check reception recorded for this action (SCRUM-307),
   * or the operator's default. Never the request body — see rule 2 at the top.
   *
   * `claimId` is set only on `claim`, and it is what the commit stamps onto the
   * sale and spends (SCRUM-311).
   */
  tier: { code: string; source: 'member' | 'claim' | 'default'; claimId?: string };
  /** S2-09b — the order's pick-up code as the cart sent it, trimmed. Null when it sent none. */
  pickupCode: string | null;
  /**
   * SCRUM-311 — why a claim the cart NAMED priced nothing. Null on every cart
   * that named none, and on every cart whose claim priced it. Today there is
   * one case: the claim has already paid for a sale. The quote carries it back
   * so the till can say so; the commit refuses on it.
   */
  tierClaimRefusal: TierClaimRefusal | null;
  disagreements: {
    pricingModeSentByTill: string | null;
    tierSentByTill: string | null;
    pricingModeDiffers: boolean;
    tierDiffers: boolean;
  };
  engineVersion: string;
  totals: TicketCartTotals;
  /** What the sale row records, already split the way the ledger stores it. */
  money: {
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
  };
  lines: PricedLine[];
  manualDiscounts: ManualDiscountInput[];
  rejectedPromoCodes: { code: string; reason: string }[];
  /** The engine's own cart lines, kept so the committer prices nothing twice. */
  cartLines: TicketCartLine[];
  /** S2-10b — the voucher this cart carries, as the platform priced it. Null when none. */
  voucher: PricedVoucher | null;
}

/**
 * S2-10b — a held voucher, priced on this cart by the platform.
 *
 * `amountSatang` is what it actually took off (the engine's own figure for its
 * promo); `applicable` is false, with the reason, when the cart has nothing it
 * can come off. A quote carries that answer to the till; a commit refuses it,
 * so a voucher is never used up for nothing.
 */
export interface PricedVoucher {
  voucherId: string;
  code: string;
  definitionCode: string;
  label: string;
  effect: VoucherEffect;
  amountSatang: number;
  applicable: boolean;
  reason: string | null;
  /**
   * The engine input it became — kept for the discount row the commit writes.
   * A free item's and a 1+1's are aimed at one line (`CartPromo.line`).
   */
  promo: CartPromo;
}

/**
 * Where a cart is being priced, for the voucher it may carry — decided by the
 * caller of `priceCart`, never by the body.
 */
export type CartVoucherScope =
  | { mode: 'quote'; stationId: string | null }
  | { mode: 'commit'; saleId: string; stationId: string };

/** Catalogue rows a cart needs, loaded once for the whole cart. */
interface CatalogueLookup {
  packages: Map<string, typeof ticketPackage.$inferSelect>;
  products: Map<string, { row: typeof product.$inferSelect; category: TaxableCategory | null }>;
}

/** Only a uuid can be a `pos.product` id; the prototype's are strings like `a-socks`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadCatalogue(
  db: Exec,
  scope: PricingScope,
  input: CartInput,
): Promise<CatalogueLookup> {
  const packageIds = [...new Set((input.lines ?? []).map((l) => l.packageId))];
  const productIds = [
    ...new Set(
      [
        ...(input.lines ?? []).flatMap((l) => (l.addOns ?? []).map((a) => a.id)),
        ...(input.socks ? [input.socks.addOnId] : []),
        // S2-09b — an F&B or shop line names a `pos.product` and nothing else,
        // so it is loaded here with the add-ons and gets the same tax walk.
        ...(input.items ?? []).map((i) => i.productId),
      ].filter((id) => UUID.test(id)),
    ),
  ];

  const packages = new Map<string, typeof ticketPackage.$inferSelect>();
  if (packageIds.length > 0) {
    const rows = await db
      .select()
      .from(ticketPackage)
      .where(
        and(
          inArray(ticketPackage.id, packageIds),
          eq(ticketPackage.branchId, scope.branchId),
          eq(ticketPackage.active, true),
          isNull(ticketPackage.archivedAt),
        ),
      );
    for (const row of rows) packages.set(row.id, row);
  }

  const products = new Map<string, { row: typeof product.$inferSelect; category: TaxableCategory | null }>();
  if (productIds.length > 0) {
    const rows = await db
      .select()
      .from(product)
      .where(
        and(
          inArray(product.id, productIds),
          eq(product.operatorId, scope.operatorId),
          eq(product.active, true),
          isNull(product.archivedAt),
        ),
      );
    // A product may be operator-wide (branch null) or this branch's; one
    // belonging to another branch is not on sale here.
    const onSale = rows.filter((row) => !row.branchId || row.branchId === scope.branchId);
    /**
     * The taxable area is RESOLVED, not read off a join.
     *
     * `product_category.taxable_category` is null on a sub-category, meaning
     * "inherit the parent's" (migration 0015), so a single leftJoin answers
     * null for every item filed under one — the Iced Latte in Drinks / Coffee
     * among them — and its money would land in the add-ons area rather than in
     * F&B. `resolveItemTaxCategories` walks the item's own override, then its
     * category, then that category's parent: the same three steps
     * `services/tax.ts` and the menu read take.
     */
    const areas = await resolveItemTaxCategories(db, onSale);
    for (const row of onSale) {
      products.set(row.id, { row, category: areas.get(row.id) ?? null });
    }
  }

  return { packages, products };
}

/** What a unit of the engine's decomposition is, as the ledger names it. */
function lineKindOf(unit: CartUnit): SaleLineKind {
  if (unit.promoItem) return 'promo_item';
  const row = unit.row;
  if (!row) return 'food_provision';
  if (row.key === SERVICE_FEE_ROW_KEY) return 'service_fee';
  if (row.kind === 'kids') return 'kids';
  if (row.kind === 'adults') return row.key === 'adults-free' ? 'adults_free' : 'adults_paid';
  if (row.kind === 'socks') return 'socks';
  return 'addon';
}

// --- F&B and shop lines (S2-09b) --------------------------------------------

/**
 * The shape of a pick-up code. The prototype mints it on a number pad capped at
 * six characters (`components/fnb/PickupCodeModal.tsx:63`) and accepts anything
 * non-blank; this accepts that, plus letters and an internal dash, so a branch
 * printing `A-12` is not refused by a rule nobody made.
 */
const PICKUP_CODE = /^[A-Za-z0-9][A-Za-z0-9-]{0,11}$/;

/** The trimmed code, or null when there is none. Throws on a code that is not one. */
function normalisePickupCode(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  if (!PICKUP_CODE.test(trimmed)) {
    throw errors.badRequest(
      'A pick-up code is a short code of letters, digits and dashes — up to twelve characters',
      { pickupCode: trimmed },
    );
  }
  return trimmed;
}

/**
 * The pick-up code recorded on a sale's F&B lines, if one is.
 *
 * It lives on the lines rather than on `pos.sale`, which has no column for it
 * and gets none from this ticket — the F&B lines are also the only rows that
 * need it, since each prep station's ticket is built from the lines routed to
 * it. The first code found answers for the order: they are written together in
 * one transaction, from one string.
 */
function recordedPickupCode(lines: readonly { payload: unknown }[]): string | null {
  for (const line of lines) {
    const code = (line.payload as SaleLinePayload | null)?.pickupCode;
    if (code) return code;
  }
  return null;
}

/** The refusal a sale carrying food gets when nobody keyed a pick-up code. */
function pickupCodeRequired(): never {
  throw errors.conflict(
    'PICKUP_CODE_REQUIRED',
    'This order has food on it, so it needs a pick-up code before it can be paid for',
  );
}

/**
 * The `packageId` an F&B or shop line's cart line carries.
 *
 * It is NOT a package and names no row: an item line has no admission on it, so
 * there is nothing for a `ticketType`-scoped discount to match and a real
 * package id here would make one match something it never sold. `buildPricedLines`
 * looks it up in the loaded packages, finds nothing, and writes
 * `ticket_package_id` null — which is what the ledger should say about a plate
 * of chips.
 */
const ITEM_LINE_PACKAGE_KEY = 'item-line';

/**
 * SCRUM-344 — each item's own menu category and its parent, by product id.
 *
 * What an `fnbCategory`-scoped promo matches on: a code scoped to Drinks has to
 * reach the Iced Latte, which is filed under Coffee, a SUB-category of Drinks.
 * That is the prototype's rule — `menuItemMatchesTarget` answers true for the
 * item's own category or its parent (`apps/pos/src/lib/discountTarget.ts:88-92`)
 * — and two levels is the whole tree (`types.ts:717-729`), so this is two
 * queries and never a loop, the same shape as `resolveItemTaxCategories` and
 * `resolveItemPrepStations` in `services/menu.ts`.
 *
 * It is resolved here rather than read off a join for the reason `loadCatalogue`
 * gives about the taxable area: the answer for an item under a sub-category is
 * not on the item's own row.
 */
async function loadItemCategoryWalk(
  db: Exec,
  rows: readonly (typeof product.$inferSelect)[],
): Promise<Map<string, string[]>> {
  const walk = new Map<string, string[]>();
  const categoryIds = [...new Set(rows.map((r) => r.categoryId).filter((id): id is string => !!id))];
  if (categoryIds.length === 0) return walk;

  const own = await db
    .select({ id: productCategory.id, parentId: productCategory.parentId })
    .from(productCategory)
    .where(inArray(productCategory.id, categoryIds));
  const byId = new Map(own.map((c) => [c.id, c]));
  for (const row of rows) {
    if (!row.categoryId) continue;
    const category = byId.get(row.categoryId);
    if (!category) continue;
    walk.set(row.id, category.parentId ? [category.id, category.parentId] : [category.id]);
  }
  return walk;
}

/** One F&B or shop line, priced and ready to join the cart the engine totals. */
interface ResolvedItemLine {
  cartLineId: string;
  kind: Extract<SaleLineKind, 'fnb_item' | 'merch_item'>;
  productId: string;
  payload: SaleLinePayload;
  cartLine: TicketCartLine;
}

/**
 * Price the cart's F&B and shop lines from the catalogue, and refuse the ones
 * the menu does not allow.
 *
 * THREE RULES, all of them the prototype's:
 *
 *   1. THE UNIT PRICE IS THE ITEM'S PRICE PLUS THE CHOSEN OPTIONS' DELTAS, at
 *      this rate mode — `computeUnitPrice` (`lib/fnb.ts:28-42`), which resolves
 *      the item's weekday/weekend pair and then every selected option's. Both
 *      come from `pos.product` and `pos.modifier_option`. Nothing in the body
 *      contributes a figure.
 *   2. A TIER DOES NOT DISCOUNT FOOD OR MERCHANDISE. The prototype prices a
 *      ticket through `priceForTier` and an F&B or merch line through
 *      `resolveRate(item.price, mode)` with no tier anywhere in the call
 *      (`lib/fnb.ts:33`, `lib/merch.ts:19` — "Merch is flat-priced (no tier, no
 *      modifiers)"). So the expat rate takes nothing off a latte, and the
 *      resolved tier reaches these lines only as the value frozen on the row.
 *   3. THE MODIFIER RULES ARE THE MENU'S, checked rather than trusted — see
 *      `assertModifierSelection`.
 *
 * HOW IT REACHES THE ENGINE. Each item line becomes a cart line carrying one
 * priced quantity of one catalogue item with its own taxable area — which is
 * exactly what `CartAddOn` is — and no participants. That is not a trick to get
 * around the engine: it means the F&B money is decomposed into units, bounded
 * by the discount ledger, run through the same tax cascade and apportioned back
 * the same way admission is, instead of a second set of totals arithmetic
 * living here. `lineKindOf` would call such a unit an `addon`; `buildPricedLines`
 * writes the kind this function resolved, `fnb_item` or `merch_item`.
 *
 * WHAT THE ROW SAYS IT IS, so a promo code can be scoped to it (SCRUM-344).
 * Because an item line reaches the engine as an add-on-shaped row, the discount
 * matcher could not tell a latte from a locker: `rowMatchesTarget` answered
 * `false` for the `fnb`, `fnbCategory`, `menuItems` and `merch` scopes on every
 * row and `true` for `addOns` on any add-on-kind row, so a code scoped to food
 * found no base and a code scoped to add-ons reached the food. Each item row
 * therefore carries `itemKind` — `menu` or `merch`, from `product.kind` — and
 * `categoryIds`, the item's own menu category and its parent, which is the walk
 * an `fnbCategory` scope matches on. The matcher reads both; nothing else does.
 *
 * MODIFIERS DO NOT GET THEIR OWN LEDGER ROWS. The ticket asks for a `modifier`
 * line kind and `pos.sale_line`'s vocabulary has none (`SALE_LINE_KINDS`), and
 * this ticket adds no migration. It is also what the prototype does: an
 * option's delta is inside `FnbOrderLine.lineTotal` and there is no modifier
 * line anywhere in it. So an option's money rides its item's unit price, and
 * every chosen option is itemised on the line's `payload.modifiers` with the
 * delta it added — which is what the receipt and the prep ticket print from.
 */
async function resolveItemLines(
  db: Exec,
  scope: PricingScope,
  ctx: PricingContext,
  input: CartInput,
  catalogue: CatalogueLookup,
  tierCode: string,
): Promise<ResolvedItemLine[]> {
  const itemInputs = input.items ?? [];
  if (itemInputs.length === 0) return [];

  const rows = itemInputs.map((line) => {
    const found = catalogue.products.get(line.productId);
    if (!found) {
      throw errors.badRequest(
        'That item is not on this branch’s menu any more, so it cannot be sold',
        { cartLineId: line.id, productId: line.productId },
      );
    }
    if (found.row.kind === 'addon') {
      throw errors.badRequest(
        `"${found.row.name}" is a ticket add-on: it goes on a ticket line, not on its own`,
        { cartLineId: line.id, productId: line.productId },
      );
    }
    return found.row;
  });

  const productIds = [...new Set(rows.map((r) => r.id))];
  // An item's INLINE groups plus the shared LIBRARY, resolved by the same
  // function the menu screens resolve with (`effectiveModifierGroups`), so the
  // question the till asked and the question the price is composed from are one
  // question.
  const groups = await db
    .select()
    .from(modifierGroup)
    .where(
      and(
        eq(modifierGroup.operatorId, scope.operatorId),
        isNull(modifierGroup.archivedAt),
        or(inArray(modifierGroup.productId, productIds), isNull(modifierGroup.productId)),
      ),
    )
    .orderBy(asc(modifierGroup.sortOrder), asc(modifierGroup.name));
  const links = await db
    .select({
      productId: productModifierGroup.productId,
      modifierGroupId: productModifierGroup.modifierGroupId,
      sortOrder: productModifierGroup.sortOrder,
    })
    .from(productModifierGroup)
    .where(
      and(
        eq(productModifierGroup.operatorId, scope.operatorId),
        inArray(productModifierGroup.productId, productIds),
      ),
    );
  const options = groups.length
    ? await db
        .select()
        .from(modifierOption)
        .where(
          and(
            inArray(
              modifierOption.modifierGroupId,
              groups.map((g) => g.id),
            ),
            isNull(modifierOption.archivedAt),
          ),
        )
        .orderBy(asc(modifierOption.sortOrder), asc(modifierOption.name))
    : [];
  const prepStations = await resolveItemPrepStations(db, rows);
  const categoryWalk = await loadItemCategoryWalk(db, rows);

  const inlineGroups = groups.filter((g) => g.productId !== null);
  const libraryGroups = groups.filter((g) => g.productId === null);
  /** The weekday/weekend pair as the engine resolves every other one. */
  const rate = (weekday: number, weekend: number | null): number =>
    resolveRate({ weekday, weekend: weekend ?? weekday }, ctx.mode);

  const resolved: ResolvedItemLine[] = [];
  itemInputs.forEach((line, index) => {
    const row = rows[index]!;
    const kind = row.kind === 'merch' ? ('merch_item' as const) : ('fnb_item' as const);
    const itemGroups: ModifierGroupWithOptions[] = effectiveModifierGroups(
      row.id,
      inlineGroups,
      links,
      libraryGroups,
    ).map((group) => ({ group, options: options.filter((o) => o.modifierGroupId === group.id) }));
    const chosen = (line.modifiers ?? []).map((m) => ({
      groupId: m.groupId,
      optionIds: m.optionIds,
    }));
    assertModifierSelection(row.name, itemGroups, chosen);
    /**
     * The size, on a shop line (S2-09b): one of the ITEM's sizes, the same way
     * a modifier option has to be one the item offers — and on an item sold in
     * two sizes or more, a required one, the way a required question is
     * (`resolveLineVariant`). Only the id is taken from the till; the label
     * frozen on the line is the catalogue's. No size carries a price of its
     * own, so the unit price below is the item's whichever size it is.
     */
    const variant =
      kind === 'merch_item'
        ? resolveLineVariant(row.name, row.variants, line.variant, {
            cartLineId: line.id,
            productId: row.id,
          })
        : null;

    const chosenByGroup = new Map(chosen.map((c) => [c.groupId, c.optionIds]));
    let unitSatang = rate(row.priceSatang, row.priceWeekendSatang);
    const modifiers: NonNullable<SaleLinePayload['modifiers']> = [];
    // Group order, then the order the options were chosen in — the order the
    // prototype lists them in on the display and the receipt
    // (`describeModifiers`, `breakdownModifiers`).
    for (const { group, options: offered } of itemGroups) {
      for (const optionId of chosenByGroup.get(group.id) ?? []) {
        const option = offered.find((o) => o.id === optionId)!;
        const delta = rate(option.priceSatang, option.priceWeekendSatang);
        unitSatang += delta;
        modifiers.push({
          groupId: group.id,
          groupName: group.name,
          optionId: option.id,
          optionName: option.name,
          unitSatang: delta,
        });
      }
    }

    /**
     * Which taxable area this item's money lands in: the resolved walk from
     * `loadCatalogue` — the item's override, else its category's, else its
     * parent's. Where nothing in the chain answers, a menu item is `fnb` and a
     * shop item is `merch`, which is the prototype's own fallback on each side
     * (`lib/menu.ts:101-110`, `lib/merch.ts:merchTaxInputs`).
     */
    const taxCategory: TaxableCategory =
      catalogue.products.get(row.id)?.category ?? (kind === 'merch_item' ? 'merch' : 'fnb');
    const note = (line.note ?? '').trim();
    const payload: SaleLinePayload = {
      ...(modifiers.length > 0 ? { modifiers } : {}),
      ...(note ? { note } : {}),
      ...(variant
        ? { variant: { variantId: variant.id, variantLabel: variant.label } }
        : kind === 'fnb_item' && line.variant
          ? { variant: line.variant }
          : {}),
      // Merchandise is handed over at the till and prints no prep ticket at all
      // (`types.ts:1213`), so a station on a shop line would be a fact about
      // nothing.
      ...(kind === 'fnb_item' ? { prepStation: prepStations.get(row.id) ?? 'kitchen' } : {}),
    };

    const cartLine: TicketCartLine = {
      id: line.id,
      packageId: ITEM_LINE_PACKAGE_KEY,
      package: { prices: {}, adultRules: null },
      tier: tierCode,
      kids: 0,
      adults: 0,
      socks: 0,
      addOns: [
        {
          id: row.id,
          // The line's label: "Grip Socks — M" when a size was sold, which is
          // what the receipt and the Sale detail read back.
          name: variant ? variantLineLabel(row.name, variant.label) : row.name,
          price: unitSatang,
          quantity: line.quantity,
          taxCategoryOverride: taxCategory,
          // What this row IS, for the promo scopes — see the header.
          itemKind: kind === 'merch_item' ? ('merch' as const) : ('menu' as const),
          categoryIds: categoryWalk.get(row.id) ?? [],
        },
      ],
      lineTotal: 0,
    };
    cartLine.lineTotal = priceCartLine(cartLine, ctx);
    resolved.push({ cartLineId: line.id, kind, productId: row.id, payload, cartLine });
  });

  return resolved;
}

/**
 * Price a cart. Reads the catalogue, the branch's calendar and its tax
 * configuration, then hands the whole thing to `computeTicketCartTotals` — the
 * same function the public booking quote and the regression fixtures run
 * through.
 */
export async function priceCart(
  db: Exec,
  actor: ActorContext,
  input: CartInput,
  now: Date = new Date(),
  voucherScope: CartVoucherScope = { mode: 'quote', stationId: null },
): Promise<PricedCart> {
  const branchId = input.branchId ?? actor.branchId;
  if (!branchId) throw errors.badRequest('No active branch on this session');
  const scope = await resolvePricingScope(db, branchId, actor.operatorId, now);
  // The branch is settled now — including the case where the cart named none
  // and the station's was used — so this is where "may this account sell
  // here" is answerable. Before any row is written, and before a price is
  // quoted for a branch the caller has no business pricing for.
  await actor.assertBranchAllowed?.(scope.branchId);
  /**
   * SCRUM-307 — a walk-in whose document reception has just checked is not a
   * member yet, so there is no record here to read a tier from and the cart
   * would price at the default one. The till therefore records the check
   * through `POST /sales/tier-claims` and the cart names that ACTION ID
   * (`tierClaimActionId`, declared on the cart body in `routes/sales.ts`).
   *
   * That is not rule 2 loosened: what the cart names is a row written on this
   * side under a permission check, carrying the verifier and the branch from
   * the session, and the lookup matches on both — so it answers nothing to a
   * caller naming another session's claim. A body that says `expat` is still
   * ignored, and everything else still resolves from the member or the
   * operator's default.
   *
   * SCRUM-311 — a claim that has already paid for a sale resolves to nothing
   * HERE TOO, so the cart is priced at the default tier and the answer carries
   * the reason. Pricing is not the act that needs refusing; `commitSale`
   * refuses on the same reason before it takes any money for it.
   */
  const claimed = await resolveTierClaim(db, actor, scope.branchId, input, now);
  const resolvedTier: PricedCart['tier'] =
    claimed.claim ?? (await resolveTier(db, actor.operatorId, input.memberId));
  const catalogue = await loadCatalogue(db, scope, input);

  // What the platform stood behind, and what it took on trust. Filled as the
  // cart resolves and written onto the lines that were priced from a snapshot.
  const snapshotPriced = new Set<string>();

  // Socks: the engine wants the branch's socks add-on in context whether or
  // not this cart has any. A catalogue product wins; otherwise the till's
  // snapshot, recorded as one.
  const socksProduct =
    input.socks && UUID.test(input.socks.addOnId)
      ? catalogue.products.get(input.socks.addOnId)
      : undefined;
  if (input.socks && !socksProduct) snapshotPriced.add(input.socks.addOnId);
  const ctx: PricingContext = {
    mode: scope.pricingMode,
    socks: {
      addOnId: socksProduct?.row.id ?? input.socks?.addOnId ?? 'socks-not-configured',
      price: socksProduct?.row.priceSatang ?? input.socks?.unitSatang ?? 0,
      label: socksProduct?.row.name ?? input.socks?.label ?? 'Socks',
    },
  };

  const cartLines: TicketCartLine[] = [];
  for (const line of input.lines ?? []) {
    const pkg = catalogue.packages.get(line.packageId);
    if (!pkg) throw errors.badRequest('A selected ticket is no longer available');
    const prices = pkg.prices as Record<string, { weekday: number; weekend: number }>;
    // A tier the package does not price would resolve to 0 in the engine (the
    // prototype's defensive answer for a picker that only lists priced tiers).
    // A server writing a money row must not admit somebody free because a
    // price is missing, so it refuses instead.
    if (!prices[resolvedTier.code]) {
      throw errors.badRequest(
        `"${pkg.name}" has no ${resolvedTier.code} price, so it cannot be sold at that tier`,
      );
    }
    const socks = line.socks ?? 0;
    if (socks > 0 && !input.socks) {
      throw errors.badRequest('This cart has socks on it but no socks add-on was named');
    }

    const addOns: CartAddOn[] = (line.addOns ?? []).map((addOn) => {
      const found = UUID.test(addOn.id) ? catalogue.products.get(addOn.id) : undefined;
      if (!found) {
        if (addOn.unitSatang === undefined || !addOn.name) {
          throw errors.badRequest(
            `Add-on "${addOn.id}" is not in this branch catalogue and carries no price`,
          );
        }
        snapshotPriced.add(addOn.id);
      }
      /**
       * Which taxable area this add-on's money lands in.
       *
       * `found.category` is the RESOLVED area from `loadCatalogue` — the item's
       * own override, else its category's, else its parent's — so the seeded
       * Ice Cream Cone reports as F&B, and so does the Iced Latte, filed under
       * a Coffee sub-category that inherits its area rather than stating one.
       * The catalogue's answer wins whenever it has one; the till's snapshot is
       * used only for an add-on the catalogue does not price (the prototype's
       * `a-locker`), and an area nothing resolves falls to the engine's own
       * `addons` default.
       */
      const taxArea = found?.category ?? addOn.taxCategoryOverride ?? null;
      return {
        id: found?.row.id ?? addOn.id,
        name: found?.row.name ?? addOn.name ?? 'Add-on',
        price: found?.row.priceSatang ?? addOn.unitSatang ?? 0,
        quantity: addOn.quantity,
        ...(addOn.variantBreakdown ? { variantBreakdown: addOn.variantBreakdown } : {}),
        ...(taxArea ? { taxCategoryOverride: taxArea } : {}),
      };
    });

    if (line.serviceFee || line.foodProvision || line.promoItem) {
      // Drop-off fees, prepaid food and a free-item promo's item have no
      // platform catalogue to be priced from (S2-13 and S2-09b). The engine
      // carries them; the ledger records that the figure was the till's.
      snapshotPriced.add(line.id);
    }

    const cartLine: TicketCartLine = {
      id: line.id,
      packageId: pkg.id,
      package: { prices, adultRules: pkg.adultRules as never },
      tier: resolvedTier.code,
      kids: line.kids,
      adults: line.adults,
      socks,
      addOns,
      ...(line.serviceFee
        ? { serviceFee: { label: line.serviceFee.label, amount: line.serviceFee.amountSatang } }
        : {}),
      ...(line.foodProvision
        ? { foodProvision: { mode: line.foodProvision.mode, paid: line.foodProvision.paidSatang } }
        : {}),
      ...(line.promoItem
        ? {
            promoItem: {
              itemId: line.promoItem.itemId,
              itemKind: line.promoItem.itemKind,
              name: line.promoItem.name,
              price: line.promoItem.priceSatang,
            },
          }
        : {}),
      lineTotal: 0,
    };
    // Priced here, from the catalogue, at this rate mode. Never from the body.
    cartLine.lineTotal = priceCartLine(cartLine, ctx);
    // The till's own figure for the line, reconciled rather than trusted: a
    // disagreement means the till is holding a stale price and the guest was
    // quoted something the platform will not charge.
    //
    // Except when the disagreement IS the answer: a till holding the discounted
    // figure for a claim the platform has just refused (spent, aged out, not
    // this session's) necessarily disagrees with the default it fell back to.
    // Refusing that as a mismatch buried the reason — the till never heard
    // that the document check had been used. The quote carries the refusal
    // and the platform's prices instead; the commit refuses on the claim
    // (SCRUM-311, found by the till slice).
    if (
      line.lineTotalSatang !== undefined &&
      line.lineTotalSatang !== cartLine.lineTotal &&
      claimed.refusal === null
    ) {
      throw errors.conflict(
        'SALE_LINE_PRICE_MISMATCH',
        'The till and the platform priced a line differently — refresh the catalogue and re-price',
        {
          cartLineId: line.id,
          tillLineTotalSatang: line.lineTotalSatang,
          platformLineTotalSatang: cartLine.lineTotal,
        },
      );
    }
    cartLines.push(cartLine);
  }

  /**
   * S2-09b — the F&B and shop lines, priced from the catalogue and appended to
   * the cart the engine totals, so one cascade covers the whole bill.
   */
  const itemLines = await resolveItemLines(db, scope, ctx, input, catalogue, resolvedTier.code);
  for (const item of itemLines) {
    const sent = (input.items ?? []).find((l) => l.id === item.cartLineId)?.lineTotalSatang;
    // The same reconciliation a ticket line gets, and yielding to a refused
    // claim for the same reason: the till's figure is a fact about the till.
    if (sent !== undefined && sent !== item.cartLine.lineTotal && claimed.refusal === null) {
      throw errors.conflict(
        'SALE_LINE_PRICE_MISMATCH',
        'The till and the platform priced a line differently — refresh the catalogue and re-price',
        {
          cartLineId: item.cartLineId,
          tillLineTotalSatang: sent,
          platformLineTotalSatang: item.cartLine.lineTotal,
        },
      );
    }
    cartLines.push(item.cartLine);
  }

  /**
   * S2-10b — THE VOUCHER, priced here from its definition and never from the
   * till. The cart names it by code; `resolveCartVoucher` finds it only among
   * the vouchers held for this cart (see `CartVoucherScope`), refuses a
   * till-described discount under a voucher's code, a second voucher, and a
   * voucher beside any promo code, and resolves what it is worth at this
   * branch. `voucherPricing` turns that into what the engine takes: a promo,
   * and for a free item the line that puts the item on the bill.
   */
  const voucherCart = await resolveCartVoucher(
    db,
    {
      mode: voucherScope.mode,
      operatorId: actor.operatorId,
      branchId: scope.branchId,
      stationId: voucherScope.stationId,
      saleId: voucherScope.mode === 'commit' ? voucherScope.saleId : null,
      now,
    },
    input.promoCodes ?? [],
    input.promos ?? [],
  );
  const voucherClaim: CartVoucherClaim | null = voucherCart.claim;
  const voucherInputs = voucherClaim
    ? voucherPricing(voucherClaim, cartLines, ctx, resolvedTier.code)
    : null;
  /** The voucher's own line, by cart line id, so the ledger row can say what it is. */
  const voucherLines = new Map<string, { id: string; code: string; productId: string }>();
  if (voucherClaim && voucherInputs?.line?.promoItem) {
    cartLines.push(voucherInputs.line);
    voucherLines.set(voucherInputs.line.id, {
      id: voucherClaim.voucherId,
      code: voucherClaim.code,
      productId: voucherInputs.line.promoItem.itemId,
    });
  }

  // The engine keys a line's amount, its component bases and every line-scoped
  // discount by the cart line id, so two lines sharing one would have the
  // second's money read off the first. Refused rather than mispriced.
  const lineIds = cartLines.map((l) => l.id);
  if (new Set(lineIds).size !== lineIds.length) {
    throw errors.badRequest('Two lines on this cart carry the same id, so it cannot be priced');
  }
  if (cartLines.length === 0) throw errors.badRequest('The cart is empty');

  // A code with no definition attached has nothing to validate it against
  // (S2-09b owns the catalogue), so it is refused by name and takes nothing
  // off the bill rather than being guessed at.
  const rejectedPromoCodes = voucherCart.otherCodes.map((code) => ({
    code,
    reason: `Code "${code}" isn't set up at this branch yet.`,
  }));
  const tillPromos: PromoDiscount[] = (input.promos ?? []).map((promo) => ({
    code: promo.code,
    label: promo.label,
    type: promo.type,
    value: promo.value,
    ...(promo.freeItemId ? { freeItemId: promo.freeItemId } : {}),
    ...(promo.freeItemKind ? { freeItemKind: promo.freeItemKind } : {}),
    ...(promo.target ? { target: promo.target as PromoDiscount['target'] } : {}),
  }));
  // A voucher never shares a cart with another promo (`resolveCartVoucher`),
  // so this is one list or the other.
  const promos: CartPromo[] = voucherInputs ? [voucherInputs.promo] : tillPromos;

  const manualDiscounts = input.manualDiscounts ?? [];
  const totals = computeTicketCartTotals(
    cartLines,
    promos,
    manualDiscounts as ManualDiscount[],
    scope.taxConfig,
    ctx,
  );

  const tb = totals.taxBreakdown;
  const grossSatang = tb.grandTotal;
  const serviceChargeSatang = tb.serviceChargeTotal;
  const taxInclusiveSatang = tb.inclusiveTaxTotal;
  const taxExclusiveSatang = tb.exclusiveTaxTotal;
  // The ledger stores the four parts and checks that they add up
  // (`sale_totals_check`), so net is what is left of the gross once service
  // and both kinds of tax are taken out of it.
  const netSatang = grossSatang - serviceChargeSatang - taxInclusiveSatang - taxExclusiveSatang;
  if (netSatang < 0) {
    // Reachable only under `discountPlacement: 'after_tax'` with a discount
    // larger than the money the tax was charged on: the guest pays less than
    // the tax the cascade reported, which the ledger's split cannot represent.
    // The seeded configuration is `before_tax`. Refusing keeps it a decision
    // somebody takes rather than a nonsense row.
    throw errors.badRequest(
      'These totals cannot be recorded: the discount exceeds the taxed amount under this ' +
        "branch's after-tax discount placement",
    );
  }

  let pricedVoucher: PricedVoucher | null = null;
  if (voucherClaim && voucherInputs) {
    const amountSatang =
      totals.appliedPromos.find((applied) => applied.code === voucherClaim.code)?.amount ?? 0;
    const applicable = !(voucherInputs.notApplicable !== null && amountSatang === 0);
    if (!applicable && voucherScope.mode === 'commit') {
      throw errors.conflict('VOUCHER_NOT_APPLICABLE', voucherInputs.notApplicable!, {
        voucherId: voucherClaim.voucherId,
        code: voucherClaim.code,
      });
    }
    pricedVoucher = {
      voucherId: voucherClaim.voucherId,
      code: voucherClaim.code,
      definitionCode: voucherClaim.definitionCode,
      label: voucherClaim.label,
      effect: voucherClaim.effect,
      amountSatang,
      applicable,
      reason: applicable ? null : voucherInputs.notApplicable,
      promo: voucherInputs.promo,
    };
  }

  const pickupCode = normalisePickupCode(input.pickupCode);
  const lines = buildPricedLines(
    cartLines,
    ctx,
    totals,
    resolvedTier.code,
    catalogue,
    snapshotPriced,
    new Map(itemLines.map((item) => [item.cartLineId, item])),
    pickupCode,
    voucherLines,
  );

  return {
    scope,
    tier: resolvedTier,
    pickupCode,
    tierClaimRefusal: claimed.refusal,
    disagreements: {
      // The till says what it believed; the platform says what it charged.
      // Neither is refused — a cart open across 05:00 or across a tier change
      // is ordinary — but the answer carries both so the till can show the
      // mode that was actually used, and a report can find the difference.
      pricingModeSentByTill: input.pricingMode ?? null,
      tierSentByTill: input.tier ?? null,
      pricingModeDiffers: input.pricingMode !== undefined && input.pricingMode !== scope.pricingMode,
      tierDiffers: input.tier !== undefined && input.tier !== resolvedTier.code,
    },
    engineVersion: PRICING_ENGINE_VERSION,
    totals,
    money: {
      subtotalSatang: totals.subtotal,
      manualDiscountSatang: totals.manualDiscountTotal,
      promoDiscountSatang: totals.promoDiscountTotal,
      discountSatang: totals.discountTotal,
      netSatang,
      serviceChargeSatang,
      taxInclusiveSatang,
      taxExclusiveSatang,
      grossSatang,
      unappliedDiscountSatang: tb.unappliedDiscount,
    },
    lines,
    manualDiscounts,
    rejectedPromoCodes,
    cartLines,
    voucher: pricedVoucher,
  };
}

/**
 * One `sale_line` per unit the engine computed, with the category's money
 * split across the units that make it up.
 *
 * WHY A LINE IS A UNIT and not a cart line: one cart line can hold money from
 * three taxable categories at once (tickets, an add-on pointing at F&B, a
 * drop-off fee), so a per-line tax rate is only meaningful on the unit. The
 * units come from the engine's own `cartUnits`, which is what the tax bases and
 * the discount scopes are built from — the ledger therefore stores what was
 * computed rather than a second decomposition of it.
 *
 * THE SPLIT IS AN APPORTIONMENT, and the authoritative per-category figures
 * are the sale's stored `tax_breakdown`. Each category's post-discount base,
 * service charge and tax are divided across its units in proportion to their
 * undiscounted bases, largest remainder, so the parts sum back exactly. A unit
 * worth nothing (the free-adults row) takes nothing.
 */
function buildPricedLines(
  cartLines: readonly TicketCartLine[],
  ctx: PricingContext,
  totals: TicketCartTotals,
  tierCode: string,
  catalogue: CatalogueLookup,
  snapshotPriced: ReadonlySet<string>,
  /** S2-09b — the F&B and shop lines, by cart line id. See `resolveItemLines`. */
  itemLines: ReadonlyMap<string, ResolvedItemLine>,
  pickupCode: string | null,
  /** S2-10b — the free item a voucher put on the bill, by cart line id. */
  voucherLines: ReadonlyMap<string, { id: string; code: string; productId: string }> = new Map(),
): PricedLine[] {
  const units = cartUnits(cartLines, ctx);
  const byCategory = new Map<TaxableCategory, number[]>();
  units.forEach((unit, index) => {
    const list = byCategory.get(unit.category) ?? [];
    list.push(index);
    byCategory.set(unit.category, list);
  });

  // Per-unit money, filled in category by category.
  const discount = new Array<number>(units.length).fill(0);
  const baseAfter = new Array<number>(units.length).fill(0);
  const service = new Array<number>(units.length).fill(0);
  const taxIncl = new Array<number>(units.length).fill(0);
  const taxExcl = new Array<number>(units.length).fill(0);

  /**
   * S2-10b — WHAT A LINE-AIMED PROMO TOOK, ON THE UNIT IT TOOK IT FROM: a
   * voucher's free item on the voucher's own line, a 1+1 on one line's kids.
   * The engine reports it (`AppliedPromo.units`, indexed like `cartUnits` over
   * these same lines and context). Spread by the category rule below instead, a
   * free pizza beside a paid one would put ฿110 off on each — the right total,
   * two wrong receipt lines, and a refund of the paid pizza returning ฿110.
   */
  const pinned = new Array<number>(units.length).fill(0);
  for (const applied of totals.appliedPromos) {
    for (const aimed of applied.units ?? []) {
      if (aimed.index < 0 || aimed.index >= units.length) {
        throw new Error('a line-aimed discount names a unit this cart does not have');
      }
      pinned[aimed.index] = (pinned[aimed.index] ?? 0) + aimed.amount;
    }
  }

  for (const [category, indexes] of byCategory) {
    const weights = indexes.map((i) => units[i]?.base ?? 0);
    const originalBase = weights.reduce((sum, w) => sum + w, 0);
    const row = totals.taxBreakdown.categories.find((c) => c.category === category);
    // A category with no row in the breakdown contributed no base at all.
    const after = row?.base ?? originalBase;
    const inclusive =
      (row?.taxMode === 'inclusive' ? (row?.tax ?? 0) : 0) +
      (row?.secondaryTaxMode === 'inclusive' ? (row?.secondaryTax ?? 0) : 0);
    const exclusive =
      (row?.taxMode === 'exclusive' ? (row?.tax ?? 0) : 0) +
      (row?.secondaryTaxMode === 'exclusive' ? (row?.secondaryTax ?? 0) : 0);

    const categoryDiscount = Math.max(0, originalBase - after);
    const pins = indexes.map((i) => pinned[i] ?? 0);
    const pinnedTotal = pins.reduce((sum, pin) => sum + pin, 0);

    if (pinnedTotal === 0) {
      // Nothing aimed at a line in this category: every figure spread across
      // its units in proportion to their undiscounted bases, as it always was.
      const shares = {
        base: apportion(after, weights),
        discount: apportion(categoryDiscount, weights),
        service: apportion(row?.serviceCharge ?? 0, weights),
        inclusive: apportion(inclusive, weights),
        exclusive: apportion(exclusive, weights),
      };
      indexes.forEach((unitIndex, position) => {
        baseAfter[unitIndex] = shares.base[position] ?? 0;
        discount[unitIndex] = shares.discount[position] ?? 0;
        service[unitIndex] = shares.service[position] ?? 0;
        taxIncl[unitIndex] = shares.inclusive[position] ?? 0;
        taxExcl[unitIndex] = shares.exclusive[position] ?? 0;
      });
      continue;
    }

    // The aimed markdown on its own units — never more than the category's own
    // discount, which is none when discounts are placed after tax ...
    const aimedShares = pinnedTotal <= categoryDiscount ? pins : apportion(categoryDiscount, pins);
    const aimedTotal = aimedShares.reduce((sum, share) => sum + share, 0);
    // ... and the rest of the category's discount over what each unit has left.
    const room = indexes.map((i, position) =>
      Math.max(0, (units[i]?.base ?? 0) - (aimedShares[position] ?? 0)),
    );
    const restShares = apportion(categoryDiscount - aimedTotal, room);
    const discounts = indexes.map(
      (_, position) =>
        (aimedShares[position] ?? 0) + Math.min(restShares[position] ?? 0, room[position] ?? 0),
    );
    const bases = indexes.map((i, position) => (units[i]?.base ?? 0) - (discounts[position] ?? 0));
    // Service charge and tax follow the base each unit is left with: an item
    // handed over for nothing carries none of either.
    const chargeWeights = bases.some((base) => base > 0) ? bases : weights;
    const shares = {
      service: apportion(row?.serviceCharge ?? 0, chargeWeights),
      inclusive: apportion(inclusive, chargeWeights),
      exclusive: apportion(exclusive, chargeWeights),
    };
    indexes.forEach((unitIndex, position) => {
      baseAfter[unitIndex] = bases[position] ?? 0;
      discount[unitIndex] = discounts[position] ?? 0;
      service[unitIndex] = shares.service[position] ?? 0;
      taxIncl[unitIndex] = shares.inclusive[position] ?? 0;
      taxExcl[unitIndex] = shares.exclusive[position] ?? 0;
    });
  }

  const linesById = new Map(cartLines.map((line) => [line.id, line]));
  return units.map((unit, index) => {
    const cartLine = linesById.get(unit.lineId);
    const row = unit.row;
    const categoryRow = totals.taxBreakdown.categories.find((c) => c.category === unit.category);
    const base = baseAfter[index] ?? 0;
    const incl = taxIncl[index] ?? 0;
    const excl = taxExcl[index] ?? 0;
    const serviceCharge = service[index] ?? 0;
    // Inclusive tax is already inside the base; exclusive tax is added to it.
    const net = base - incl;
    // An F&B or shop line reaches the engine as one add-on row on its own cart
    // line, so `lineKindOf` would call it an `addon`. The kind the ledger
    // records is the one `resolveItemLines` resolved from `product.kind`.
    const item = itemLines.get(unit.lineId);
    const kind = item ? item.kind : lineKindOf(unit);
    const voucherLine = unit.promoItem ? voucherLines.get(unit.lineId) : undefined;
    const productId = item
      ? item.productId
      : voucherLine
        ? voucherLine.productId
        : kind === 'socks'
          ? (catalogue.products.get(ctx.socks.addOnId)?.row.id ?? null)
          : kind === 'addon' && row
            ? (catalogue.products.get(row.key)?.row.id ?? null)
            : null;
    const pkg = cartLine ? catalogue.packages.get(cartLine.packageId) : undefined;
    const freeAdults = row?.key === 'adults-free' ? row.quantity : 0;

    return {
      lineNo: index + 1,
      cartLineId: unit.lineId,
      kind,
      componentKey: row
        ? row.key
        : unit.promoItem
          ? `promo-item:${unit.promoItem.itemId}`
          : 'food-provision',
      ticketPackageId: pkg?.id ?? null,
      productId,
      label: row?.label ?? unit.promoItem?.name ?? 'Prepaid food',
      revenueCategory: unit.category,
      taxableCategory: unit.category,
      quantity: row?.quantity ?? 1,
      unitSatang: row?.unitPrice ?? unit.base,
      baseSatang: unit.base,
      discountSatang: discount[index] ?? 0,
      netSatang: net,
      serviceChargeSatang: serviceCharge,
      taxSatang: incl + excl,
      taxMode: categoryRow?.taxMode ?? 'none',
      // Basis points: 7 % is 700. The percent comes from the resolved rate.
      taxRateBp: Math.round((categoryRow?.taxPercent ?? 0) * 100),
      taxRateId: categoryRow?.taxRateId ?? null,
      taxName: categoryRow?.taxName ?? null,
      grossSatang: net + incl + excl + serviceCharge,
      customerTier: tierCode,
      kidCount: cartLine?.kids ?? 0,
      adultCount: cartLine?.adults ?? 0,
      freeAdultCount: freeAdults,
      stayHours: pkg?.hours ?? null,
      stayDurationLabel: pkg?.durationLabel ?? null,
      payload: voucherLine
        ? { voucher: { id: voucherLine.id, code: voucherLine.code } }
        : item
          ? {
              ...item.payload,
              // The pick-up code is the ORDER's, and it is stamped on every F&B
              // line because each prep station's ticket is built from the lines
              // that route to it and has to print the code the guest holds.
              ...(item.kind === 'fnb_item' && pickupCode ? { pickupCode } : {}),
            }
          : (row && snapshotPriced.has(row.key)) ||
              (kind === 'socks' && snapshotPriced.has(ctx.socks.addOnId)) ||
              ((kind === 'service_fee' || kind === 'food_provision' || kind === 'promo_item') &&
                snapshotPriced.has(unit.lineId))
            ? { priceSource: 'till_snapshot' as const }
            : null,
    };
  });
}

// --- Quote ------------------------------------------------------------------

/**
 * What a cart costs, without writing anything — the answer the till shows the
 * guest before anybody presses Pay, computed by the same engine that will
 * write the sale.
 */
export async function quoteSale(
  db: Exec,
  actor: ActorContext,
  input: CartInput,
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  // A quote finds a voucher only among those held at the till the cart names.
  const priced = await priceCart(db, actor, input, now, {
    mode: 'quote',
    stationId: input.stationId ?? null,
  });
  const lineTotals: Record<string, number> = {};
  for (const cartLine of priced.cartLines) lineTotals[cartLine.id] = cartLine.lineTotal;

  const quote = {
    branchId: priced.scope.branchId,
    businessDate: priced.scope.businessDate,
    pricingMode: priced.scope.pricingMode,
    pricingModeReason: priced.scope.pricingModeReason,
    holidayName: priced.scope.holidayName,
    tier: priced.tier.code,
    tierSource: priced.tier.source,
    /**
     * SCRUM-311 — why the claim this cart named priced nothing, when it named
     * one that did not. Null on everything else. The cart is still priced and
     * still quoted; this is what the till shows instead of leaving staff to
     * work out why a checked passport stopped counting.
     */
    tierClaimRefusal: priced.tierClaimRefusal,
    customerTier: priced.tier.code,
    engineVersion: priced.engineVersion,
    totals: priced.money,
    /** Resolved satang per cart line id — what each line came to. */
    lineTotals,
    /** Resolved satang per manual discount id (the prototype's `manualAmounts`). */
    manualAmounts: priced.totals.manualAmounts,
    appliedPromos: priced.totals.appliedPromos.map((promo) => ({
      code: promo.code,
      label: promo.label,
      type: promo.type,
      amountSatang: promo.amount,
      ...(promo.exhaustedReason ? { exhaustedReason: promo.exhaustedReason } : {}),
    })),
    rejectedPromoCodes: priced.rejectedPromoCodes,
    /**
     * S2-10b — the voucher on this cart, as the platform priced it: what it
     * is, what it took off, and — when the cart has nothing it can come off —
     * why not. The till shows this; it never computes it.
     */
    voucher: voucherViewOf(priced.voucher),
    taxBreakdown: priced.totals.taxBreakdown,
    lines: priced.lines,
    disagreements: priced.disagreements,
  };
  // Wrapped AND flat: the till's client reads `quote`, and the flat copy is
  // what the OpenAPI page and a curl from a terminal read. One object, so the
  // two cannot drift.
  return { quote, ...quote };
}

/** A priced voucher as a till reads it — without the engine input behind it. */
function voucherViewOf(priced: PricedVoucher | null): Omit<PricedVoucher, 'promo'> | null {
  if (!priced) return null;
  const { promo: _engineInput, ...view } = priced;
  return view;
}

// --- Writing the sale -------------------------------------------------------

/** The sale as every read of it answers. */
export interface SaleView {
  id: string;
  branchId: string;
  stationId: string;
  boxId: string | null;
  memberId: string | null;
  visitId: string | null;
  businessDate: string;
  occurredAt: string;
  status: SaleStatus;
  /** SCRUM-343 — the lane that rang it up: the ticket counter, F&B or the shop. */
  salesChannel: SalesChannel;
  pricingMode: string;
  pricingModeReason: string;
  customerTier: string;
  engineVersion: string;
  receiptNumber: string | null;
  receiptSeries: string | null;
  receiptSeq: number | null;
  finalisedAt: string | null;
  note: string | null;
  totals: {
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
  };
}

function viewOf(row: typeof sale.$inferSelect): SaleView {
  return {
    id: row.id,
    branchId: row.branchId,
    stationId: row.stationId,
    boxId: row.boxId,
    memberId: row.memberId,
    visitId: row.visitId,
    businessDate: row.businessDate,
    occurredAt: row.occurredAt.toISOString(),
    status: row.status,
    salesChannel: row.salesChannel,
    pricingMode: row.pricingMode,
    pricingModeReason: row.pricingModeReason,
    customerTier: row.customerTier,
    engineVersion: row.engineVersion,
    receiptNumber: row.receiptNumber,
    receiptSeries: row.receiptSeries,
    receiptSeq: row.receiptSeq,
    finalisedAt: row.finalisedAt?.toISOString() ?? null,
    note: row.note,
    totals: {
      subtotalSatang: row.subtotalSatang,
      manualDiscountSatang: row.manualDiscountSatang,
      promoDiscountSatang: row.promoDiscountSatang,
      discountSatang: row.discountSatang,
      netSatang: row.netSatang,
      serviceChargeSatang: row.serviceChargeSatang,
      taxInclusiveSatang: row.taxInclusiveSatang,
      taxExclusiveSatang: row.taxExclusiveSatang,
      grossSatang: row.grossSatang,
      unappliedDiscountSatang: row.unappliedDiscountSatang,
      refundedSatang: row.refundedSatang,
    },
  };
}

/**
 * THE DOCUMENT CHECK A SALE WAS PRICED ON, as a READ of that sale answers it
 * (SCRUM-333).
 *
 * WHY IT IS HERE. SCRUM-311 gave the sale row `tier_claim_id` and made it
 * single-use: a second cart naming a spent claim is refused, and the refusal
 * names the sale that spent it. The other direction was missing — reading the
 * sale back answered its tier and its receipt number and nothing pointing at
 * the check — so "why was this guest charged the expat rate" was answerable
 * only in psql, and the refusal named a receipt whose own read could not
 * corroborate it.
 *
 * WHAT IS NOT HERE, AND CANNOT BE: any part of a document number, last digits
 * included. `pos.sale_tier_claim` records the KIND of document and its expiry
 * and deliberately nothing that identifies it — see that table's comment — so
 * there are no digits on the row to carry up. What the counter gets is what
 * was checked and when it was checked, which is what makes the rate defensible
 * without putting a passport number in a table nothing sweeps.
 *
 * It is narrower than `TierClaimView` in `services/sale-tier.ts` on purpose:
 * that is the till's view of a claim it is about to price a cart with, and it
 * carries the action id and the window. A sale that has already been paid for
 * has no use for either.
 */
export interface SaleTierClaimView {
  id: string;
  /** `evidence_type`: "Passport", "Residence certificate". A kind, never a number. */
  documentKind: string;
  /** The tier the document supported — the one that priced this sale. */
  toTier: string;
  /** The document's own expiry, as the check recorded it (`YYYY-MM-DD`). */
  evidenceExpiresOn: string;
  /** When reception checked it: the claim row's `created_at`. */
  verifiedAt: string;
}

/**
 * A sale as a READ of it answers: the row, plus the one thing only a read
 * joins. The write paths (`commitSale`, `finaliseSale`) answer `SaleView`
 * unchanged — the till already holds the claim it priced with, and a `null`
 * there would be a claim-priced sale saying it had none.
 */
export interface SaleReadView extends SaleView {
  tierClaim: SaleTierClaimView | null;
}

/**
 * The document checks behind a page of sales, by sale id, in one query rather
 * than one per row — the same rule the list's line query follows.
 */
async function tierClaimsOf(
  db: Exec,
  rows: { id: string; tierClaimId: string | null }[],
): Promise<Map<string, SaleTierClaimView>> {
  const claimIds = [
    ...new Set(rows.map((row) => row.tierClaimId).filter((id): id is string => id !== null)),
  ];
  if (claimIds.length === 0) return new Map();
  const claims = await db
    .select({
      id: saleTierClaim.id,
      toTier: saleTierClaim.toTier,
      evidenceType: saleTierClaim.evidenceType,
      evidenceExpiresAt: saleTierClaim.evidenceExpiresAt,
      createdAt: saleTierClaim.createdAt,
    })
    .from(saleTierClaim)
    .where(inArray(saleTierClaim.id, claimIds));
  const byClaimId = new Map(
    claims.map((claim) => [
      claim.id,
      {
        id: claim.id,
        documentKind: claim.evidenceType,
        toTier: claim.toTier,
        evidenceExpiresOn: claim.evidenceExpiresAt,
        verifiedAt: claim.createdAt.toISOString(),
      },
    ]),
  );
  const bySaleId = new Map<string, SaleTierClaimView>();
  for (const row of rows) {
    const claim = row.tierClaimId ? byClaimId.get(row.tierClaimId) : undefined;
    if (claim) bySaleId.set(row.id, claim);
  }
  return bySaleId;
}

/**
 * What a sale still owes: its gross, less every tender that was actually
 * taken. The sum lives in `services/payments/attempt.ts` now, because the EDC,
 * the QR and the offline replay all have to ask the same question and none of
 * them comes through this file to ask it.
 *
 * This is the predicate finalisation turns on, and it is answered from rows
 * rather than from a constant. Before S2-09a it returned the gross
 * unconditionally, so every sale with a price owed its whole price for ever
 * and the only sale that could ever be finalised was a ฿0 comp — the till
 * pressed Pay on a ฿1,440 admission and got a 409 back.
 */
async function outstandingOf(db: Exec, row: typeof sale.$inferSelect): Promise<number> {
  return outstandingAfter(db, row);
}

async function displayNameOf(db: Exec, accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(eq(account.id, accountId))
    .limit(1);
  return row?.nickname ?? row?.name ?? null;
}

/**
 * Allocate the next receipt number for a station, inside the caller's
 * transaction.
 *
 * PER STATION, GAPLESS WITHIN THAT STATION'S SERIES — the numbering decision
 * recorded on `pos.receipt_series`. A branch-wide counter would need a single
 * allocator, and a single allocator stops the second till when the first box
 * does. The row is locked FOR UPDATE so two tills on one station cannot take
 * the same number; `sale_receipt_unique` is the net underneath that.
 */
async function allocateReceipt(
  tx: Tx,
  scope: { operatorId: string; branchId: string; stationId: string; series: string },
): Promise<{ series: string; seq: number; number: string }> {
  const existing = await tx
    .select()
    .from(receiptSeries)
    .where(
      and(
        eq(receiptSeries.stationId, scope.stationId),
        eq(receiptSeries.series, scope.series),
        eq(receiptSeries.kind, 'sale'),
      ),
    )
    .for('update')
    .limit(1);

  let row = existing[0];
  if (!row) {
    const inserted = await tx
      .insert(receiptSeries)
      .values({
        id: newId(),
        operatorId: scope.operatorId,
        branchId: scope.branchId,
        stationId: scope.stationId,
        series: scope.series,
        kind: 'sale',
      })
      .onConflictDoNothing()
      .returning();
    row = inserted[0];
    if (!row) {
      // Another transaction created it between the select and the insert.
      const [again] = await tx
        .select()
        .from(receiptSeries)
        .where(
          and(
            eq(receiptSeries.stationId, scope.stationId),
            eq(receiptSeries.series, scope.series),
            eq(receiptSeries.kind, 'sale'),
          ),
        )
        .for('update')
        .limit(1);
      if (!again) throw errors.conflict('RECEIPT_SERIES_UNAVAILABLE', 'Could not open the receipt series');
      row = again;
    }
  }

  const seq = row.nextSeq;
  await tx
    .update(receiptSeries)
    .set({ nextSeq: seq + 1, lastIssuedAt: new Date() })
    .where(eq(receiptSeries.id, row.id));

  return {
    series: row.series,
    seq,
    number: `${row.series}-${String(seq).padStart(row.seqPadding, '0')}`,
  };
}

/**
 * The tolerance the sync path already applies to a box's clock
 * (`CLOCK_TOLERANCE_MS` in services/sync.ts), applied here to a till's: past
 * it, the clock is called skewed and the platform's own is used instead.
 */
const CLOCK_TOLERANCE_MS = 60_000;

/**
 * When the sale happened, and whether the writing clock could be believed.
 *
 * A till that has been asleep, or a box that came up after a mall power cut
 * with no NTP, will stamp a confident and wrong time. The same rule the sync
 * ledger uses is applied here: inside the tolerance the till's instant is the
 * one recorded; outside it the platform's clock is used and `clock_trust` says
 * `skewed`, so a day's figures that look wrong are explainable from the row.
 * The TRADING DAY is always resolved from the instant this returns, so a wrong
 * till clock cannot move a sale onto another day's takings.
 */
function resolveOccurredAt(
  sent: string | undefined,
  now: Date,
): { occurredAt: Date; clockTrust: SaleClockTrust } {
  if (!sent) return { occurredAt: now, clockTrust: 'trusted' };
  const parsed = new Date(sent);
  if (Number.isNaN(parsed.getTime())) return { occurredAt: now, clockTrust: 'untrusted' };
  if (Math.abs(parsed.getTime() - now.getTime()) > CLOCK_TOLERANCE_MS) {
    return { occurredAt: now, clockTrust: 'skewed' };
  }
  return { occurredAt: parsed, clockTrust: 'trusted' };
}

// --- The sales channel (SCRUM-343) ------------------------------------------

/**
 * WHICH CHANNELS A STATION OF EACH KIND MAY RECORD A SALE UNDER.
 *
 * `pos.sale.sales_channel` answers "where did the guest buy", and until this
 * ticket every sale the api wrote answered `till` — including every F&B and
 * shop order taken through S2-09b's carts, because the cart body declared no
 * channel at all. Reporting by station type (SCRUM-216) reads this column, so a
 * day's food takings would have been filed under the ticket counter.
 *
 * WHAT THE STATION ROW CAN AND CANNOT ANSWER, because this is the part worth
 * knowing before trusting the column:
 *
 *   - `station.kind` is `till | kiosk | gate | display | booth` and has NO
 *     `fnb` or `shop` member. It says what a station IS, and a kiosk's sale is
 *     a kiosk sale and a booth's is a booth sale whatever a cart claims — so
 *     for those kinds the kind is the answer and the claim is refused if it
 *     disagrees. A gate and a display are not registers and may claim nothing.
 *   - A TILL runs all three POS lanes — the Tickets tab, the F&B station and
 *     the shop are three screens of one app on one station — so the KIND
 *     cannot tell a food order from a ticket sale, and the cart is the only
 *     thing that knows which screen took it. This is why the lane is claimed
 *     rather than derived, and why "a till may not say fnb" would refuse every
 *     food order in the park.
 *   - What a till may SELL is `station.capabilities` (`tickets | fnb | dropoff
 *     | parties`, empty = unrestricted), and that is the one thing in the model
 *     that bounds the claim: a till configured for tickets only cannot record
 *     an F&B sale, and is refused by name rather than filed under `fnb`.
 *
 * WHAT IS THEREFORE NOT VALIDATED, said plainly rather than left to be found:
 * the `shop` lane has no capability of its own in `STATION_CAPABILITIES`, so
 * any till may claim it. Adding one is a fleet-model change and belongs with
 * whoever owns that vocabulary, not to a cart body.
 */
const CHANNELS_BY_STATION_KIND: Record<StationKind, readonly SalesChannel[]> = {
  till: ['till', 'fnb', 'shop'],
  kiosk: ['kiosk'],
  booth: ['booth'],
  gate: [],
  display: [],
};

/** The capability a till must hold to record a sale under a lane, where one exists. */
const CAPABILITY_FOR_CHANNEL: Partial<Record<SalesChannel, StationCapability>> = {
  till: 'tickets',
  fnb: 'fnb',
};

/**
 * The channel this sale is recorded under: the cart's claim, checked against
 * the station, or the station's own channel when the cart claims none.
 *
 * Refuses rather than records a mismatch. A channel that was written down and
 * known to be wrong is worse than no channel at all: every report reading the
 * column would have to carry the exception, and nobody reading a takings figure
 * would know to. The claim is the till's own statement about which of its
 * screens took the money, so a claim the station cannot support is a
 * misconfigured or mis-built till, and that is a thing to fix at the counter
 * rather than to file.
 */
export function resolveSalesChannel(
  st: Pick<typeof station.$inferSelect, 'kind' | 'capabilities' | 'name'>,
  claimed: SalesChannel | undefined,
): SalesChannel {
  const allowed = CHANNELS_BY_STATION_KIND[st.kind] ?? [];
  // No claim: the station's own channel, and `till` for a kind that names none
  // — which is exactly what every sale carried before this ticket.
  if (!claimed) return allowed[0] ?? 'till';

  if (!allowed.includes(claimed)) {
    throw errors.conflict(
      'SALE_CHANNEL_MISMATCH',
      `A ${st.kind} station cannot record a sale as "${claimed}"`,
      { stationKind: st.kind, claimedChannel: claimed, allowedChannels: [...allowed] },
    );
  }

  // Within a till, what it is configured to sell. An empty list is the model's
  // own "not restricted", so a station nobody has chosen capabilities for
  // behaves exactly as it did.
  const capabilities = st.capabilities ?? [];
  const needed = CAPABILITY_FOR_CHANNEL[claimed];
  if (needed && capabilities.length > 0 && !capabilities.includes(needed)) {
    throw errors.conflict(
      'SALE_CHANNEL_MISMATCH',
      `"${st.name}" is not set up to sell ${claimed === 'fnb' ? 'food' : 'tickets'}, ` +
        `so a ${claimed} sale cannot be recorded here`,
      { stationKind: st.kind, claimedChannel: claimed, capabilities: [...capabilities] },
    );
  }
  return claimed;
}

/** A unique-violation on a named index, whatever wrapper Drizzle put round it. */
function violates(error: unknown, constraint: string): boolean {
  let err: unknown = error;
  while (err instanceof Error) {
    if (err.message.includes(constraint)) return true;
    err = err.cause;
  }
  return false;
}

export interface CommitResult {
  /** The till's client reads `replay`; `replayed` is the same fact under the name the API used first. */
  replay: boolean;
  replayed: boolean;
  /** Whether this call also closed the sale and numbered its receipt. */
  finalised: boolean;
  /** What is left to tender. Zero on a comp; the gross on everything else. */
  outstandingSatang: number;
  /** S2-09b — the pick-up code recorded on this sale's F&B lines, if it has any. */
  pickupCode: string | null;
  sale: SaleView;
  lines: PricedLine[];
  rejectedPromoCodes: { code: string; reason: string }[];
  /** S2-10b — the voucher this sale was priced with, when it carries one. */
  voucher: Omit<PricedVoucher, 'promo'> | null;
}

/**
 * Commit a cart as a sale: the row, its lines, its discounts and the audit
 * entry, in ONE transaction.
 *
 * PAY COMMITS THE SALE; A TENDER FINALISES IT. Pressing Pay writes this row
 * with no receipt number and the status `tendering` — the money record exists
 * from the moment the cart is left behind, which is the whole point of the
 * ledger, and the receipt number is allocated when the money is actually
 * taken (`finaliseSale`). The two are separate because a receipt number is a
 * document number: once it is spent it is spent, and spending one on a sale
 * that turns out not to be paid leaves a gap somebody has to explain.
 *
 * The one sale with nothing to tender — a ฿0 full comp, a fully discounted
 * visit — is committed and finalised in the same transaction, because there is
 * no second step to wait for. A comp that left no record is the thing this
 * ticket exists to stop.
 *
 * A caller asking to finalise a cart that DOES owe money is not refused: the
 * sale is committed unfinalised and the answer says so — `finalised: false`
 * and `outstandingSatang` — so the till can go on to its cash step instead of
 * losing the sale to a 409 it cannot do anything about.
 *
 * IDEMPOTENT TWICE OVER. The till mints the sale id, so a retry through a
 * dropped connection carries the same one and the existing sale is returned;
 * and `sale_action_unique` refuses a retry that minted a NEW id under the same
 * `x-oto-action-id`, so a client bug cannot turn one press of Pay into two
 * sales.
 */
export async function commitSale(
  tx: Tx,
  actor: ActorContext,
  input: CommitSaleInput,
  now: Date = new Date(),
): Promise<CommitResult> {
  const saleId = input.id ?? newId();

  // Replay by the till-minted id.
  const [already] = await tx.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  if (already) {
    if (already.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
    await actor.assertBranchAllowed?.(already.branchId);
    return {
      replay: true,
      replayed: true,
      finalised: already.status === 'finalised',
      outstandingSatang: await outstandingOf(tx, already),
      pickupCode: recordedPickupCode(
        await tx
          .select({ payload: saleLine.payload })
          .from(saleLine)
          .where(and(eq(saleLine.saleId, already.id), eq(saleLine.kind, 'fnb_item'))),
      ),
      sale: viewOf(already),
      lines: [],
      rejectedPromoCodes: [],
      voucher: null,
    };
  }

  const [st] = await tx.select().from(station).where(eq(station.id, input.stationId)).limit(1);
  if (!st || st.operatorId !== actor.operatorId) throw errors.notFound('Station not found');
  if (st.archivedAt) throw errors.badRequest('That station has been taken off the floor');
  // SCRUM-343 — before anything is priced or written: a till claiming a lane it
  // is not set up for is a misconfigured till, and nothing about it is fixed by
  // writing the sale first.
  const salesChannel = resolveSalesChannel(st, input.channel);

  const clock = resolveOccurredAt(input.occurredAt, now);
  /**
   * S2-10b — a voucher on this cart must be held for THIS sale id at THIS
   * till, and is locked from here to the commit: the hold cannot move between
   * being priced and being recorded.
   */
  const priced = await priceCart(
    tx,
    { ...actor, branchId: input.branchId ?? st.branchId },
    input,
    clock.occurredAt,
    { mode: 'commit', saleId, stationId: st.id },
  );
  if (st.branchId !== priced.scope.branchId) {
    throw errors.badRequest('That station belongs to another branch');
  }

  // The price charged is the price the platform quoted. A till that sends its
  // own total gets a refusal on a disagreement, never a silent acceptance of
  // either number.
  //
  // A refused claim explains the disagreement, and is the answer the till can
  // act on; it is thrown below, after the replay check, so this yields to it.
  if (
    input.expectedTotalSatang !== undefined &&
    input.expectedTotalSatang !== priced.money.grossSatang &&
    !priced.tierClaimRefusal
  ) {
    throw errors.conflict(
      'SALE_TOTAL_MISMATCH',
      'The till and the platform priced this cart differently — nothing was saved',
      { expectedTotalSatang: input.expectedTotalSatang, quotedTotalSatang: priced.money.grossSatang },
    );
  }

  if (input.visitId) {
    const [v] = await tx.select().from(visit).where(eq(visit.id, input.visitId)).limit(1);
    if (!v || v.operatorId !== actor.operatorId) throw errors.notFound('Visit not found');
  }

  // An action id that already produced a sale at this station is one tap, not
  // two: refuse rather than write a second sale under a new id.
  if (input.actionId) {
    const [sameAction] = await tx
      .select({ id: sale.id })
      .from(sale)
      .where(and(eq(sale.stationId, st.id), eq(sale.actionId, input.actionId)))
      .limit(1);
    if (sameAction) {
      throw errors.conflict('SALE_ACTION_REPLAY', 'That sale has already been recorded', {
        saleId: sameAction.id,
      });
    }
  }

  /**
   * SCRUM-311 — the cart named a document check that has already paid for a
   * sale. The quote priced it at the default tier and said so; taking money
   * for it is where that has to stop, because the till may be holding the
   * action id of the last check it made and the guest in front of it is a
   * different person.
   *
   * LAST OF THE REFUSALS, and the order is the point. A cart still holding the
   * first sale's expat figures is refused as the price mismatch it is, inside
   * `priceCart`; a RETRY of that first Pay — the same `x-oto-action-id`, a
   * newly minted sale id — is refused as the replay it is, just above. Both
   * are more specific than this one, and both tell the till something it can
   * act on. What is left here is the case this ticket is about: a second cart,
   * a second guest, one passport.
   */
  if (priced.tierClaimRefusal) {
    const refusal = priced.tierClaimRefusal;
    throw errors.conflict(refusal.code, refusal.message, refusal.details);
  }

  // A station that cannot number a receipt cannot close a sale, so it must
  // not be allowed to open one. This used to be checked only when finalising,
  // and a merge gate drove what that allowed: Pay on a station with no code
  // prefix wrote a ฿1,190 sale as `tendering`, Confirm Payment Received was
  // then refused for the missing prefix, and the till could never close the
  // row — money taken at the counter, and Cancel the only way out. The admin
  // console can create exactly such a station (the prefix is optional on the
  // station write), so this is a configuration a park can reach. Refusing
  // here, before anything is written, is the honest answer: nothing to undo.
  if (!st.codePrefix) {
    throw errors.badRequest(
      'This station has no code prefix, so it cannot number a receipt — set one on the station before selling here',
    );
  }

  // A sale that has just been written has no tenders against it, so what it
  // owes is its gross. `finalise` is honoured when that is nothing and is
  // reported back rather than refused when it is not.
  const owedAtCommit = priced.money.grossSatang;
  const finalising = input.finalise === true && owedAtCommit === 0;
  /**
   * S2-09b — the pick-up code gate, at the one point this path closes a sale.
   *
   * `finaliseSale` holds the same line for every other sale. A fully comped
   * F&B order never goes through it — there is nothing to tender, so it is
   * closed here — and a tray still has to be handed to somebody.
   */
  if (finalising && !priced.pickupCode && priced.lines.some((l) => l.kind === 'fnb_item')) {
    pickupCodeRequired();
  }
  const receipt = finalising
    ? await allocateReceipt(tx, {
        operatorId: actor.operatorId,
        branchId: st.branchId,
        stationId: st.id,
        series: st.codePrefix,
      })
    : null;

  const values: typeof sale.$inferInsert = {
    id: saleId,
    operatorId: actor.operatorId,
    branchId: priced.scope.branchId,
    stationId: st.id,
    boxId: st.boxId,
    businessDate: priced.scope.businessDate,
    businessDayStart: priced.scope.businessDayStart,
    timezone: priced.scope.timezone,
    occurredAt: clock.occurredAt,
    // Written by the api itself. A sale carried up from a box arrives through
    // the sync ledger and sets its own origin.
    origin: 'cloud',
    clockTrust: clock.clockTrust,
    // SCRUM-343 — the lane the cart claimed, checked against the station.
    salesChannel,
    actionId: input.actionId ?? null,
    createdByAccountId: actor.accountId,
    memberId: input.memberId ?? null,
    visitId: input.visitId ?? null,
    pricingMode: priced.scope.pricingMode,
    pricingModeReason: priced.scope.pricingModeReason,
    holidayId: priced.scope.holidayId,
    holidayName: priced.scope.holidayName,
    customerTier: priced.tier.code,
    /** SCRUM-311 — the document check that chose that tier, when one did. */
    tierClaimId: priced.tier.claimId ?? null,
    engineVersion: priced.engineVersion,
    taxConfig: priced.scope.taxConfig,
    taxBreakdown: priced.totals.taxBreakdown,
    ...priced.money,
    status: finalising ? 'finalised' : 'tendering',
    finalisedAt: finalising ? clock.occurredAt : null,
    receiptSeries: receipt?.series ?? null,
    receiptSeq: receipt?.seq ?? null,
    receiptNumber: receipt?.number ?? null,
    note: input.note ?? null,
  };

  try {
    await tx.insert(sale).values(values);
  } catch (error) {
    if (violates(error, 'sale_action_unique')) {
      throw errors.conflict('SALE_ACTION_REPLAY', 'That sale has already been recorded');
    }
    if (violates(error, 'sale_receipt_unique') || violates(error, 'sale_receipt_number_unique')) {
      // Two allocators in one series — a misconfigured or restored box. The
      // sale is refused rather than printed under a number another receipt
      // already carries.
      throw errors.conflict(
        'RECEIPT_NUMBER_TAKEN',
        'That receipt number is already used at this station',
      );
    }
    throw error;
  }

  /**
   * SCRUM-311 — the claim is spent HERE, on this sale, in this transaction.
   *
   * One document check prices one sale: the update is conditional on the claim
   * being unspent, so two carts racing for one claim cannot both commit, and
   * the loser's whole sale rolls back rather than being written at a rate
   * nothing supports. The sale row already names the claim (`tier_claim_id`)
   * — this is the other half of the same fact, and the pair is what makes
   * "which passport priced this sale" answerable from the ledger.
   */
  if (priced.tier.claimId) {
    await spendTierClaim(tx, priced.tier.claimId, saleId, clock.occurredAt);
  }

  for (const line of priced.lines) {
    await tx.insert(saleLine).values({
      id: newId(),
      saleId,
      operatorId: actor.operatorId,
      branchId: priced.scope.branchId,
      businessDate: priced.scope.businessDate,
      lineNo: line.lineNo,
      cartLineId: line.cartLineId,
      kind: line.kind,
      componentKey: line.componentKey,
      ticketPackageId: line.ticketPackageId,
      productId: line.productId,
      label: line.label,
      revenueCategory: line.revenueCategory,
      taxableCategory: line.taxableCategory,
      quantity: line.quantity,
      unitSatang: line.unitSatang,
      baseSatang: line.baseSatang,
      discountSatang: line.discountSatang,
      netSatang: line.netSatang,
      serviceChargeSatang: line.serviceChargeSatang,
      taxSatang: line.taxSatang,
      taxMode: line.taxMode,
      taxRateBp: line.taxRateBp,
      taxRateId: line.taxRateId,
      taxName: line.taxName,
      grossSatang: line.grossSatang,
      customerTier: line.customerTier,
      kidCount: line.kidCount,
      adultCount: line.adultCount,
      freeAdultCount: line.freeAdultCount,
      stayHours: line.stayHours,
      stayDurationLabel: line.stayDurationLabel,
      payload: line.payload,
    });
  }

  const appliedByName = priced.manualDiscounts.length > 0 ? await displayNameOf(tx, actor.accountId) : null;
  let sequence = 0;
  for (const discount of priced.manualDiscounts) {
    sequence += 1;
    await tx.insert(saleDiscount).values({
      id: newId(),
      saleId,
      operatorId: actor.operatorId,
      branchId: priced.scope.branchId,
      businessDate: priced.scope.businessDate,
      sequence,
      kind: 'manual',
      discountType: discount.type,
      percentBp: discount.type === 'percent' ? Math.round(discount.value * 100) : null,
      valueSatang: discount.type === 'fixed' ? discount.value : null,
      amountSatang: priced.totals.manualAmounts[discount.id] ?? 0,
      // The engine does not return the per-discount allocations it computed —
      // they stay inside `computeTicketCartTotals` — so the reproducible record
      // of where each discount landed is the sale's `tax_breakdown` and the
      // per-line split. S2-11 (refunds) is the ticket that needs them per
      // instrument.
      allocations: null,
      scope:
        discount.scope === 'line' ? (discount.targetComponent ? 'component' : 'line') : 'order',
      targetLineId: discount.targetLineId ?? null,
      targetComponent: discount.targetComponent ? componentKey(discount.targetComponent) : null,
      targetLabel: discount.targetLabel ?? null,
      reason: discount.reason,
      note: discount.note ?? null,
      appliedByAccountId: actor.accountId,
      appliedByName,
      appliedAt: now,
    });
  }
  // What each code was configured to be worth, by code, so the row can record
  // the instrument as well as what it took. A voucher's is the platform's own
  // figure — the definition's amount, the free item's shelf price, one kid's
  // price — never anything the till described.
  const voucherPromo = priced.voucher?.promo ?? null;
  /** The line a voucher's markdown was aimed at — the free item's own, or one line's kids. */
  const aimedAt = (code: string) =>
    voucherPromo && code === voucherPromo.code ? (voucherPromo.line ?? null) : null;
  const definitionOf = (code: string): number =>
    voucherPromo && code === voucherPromo.code
      ? voucherPromo.value
      : ((input.promos ?? []).find((promo) => promo.code === code)?.value ?? 0);
  for (const promo of priced.totals.appliedPromos) {
    sequence += 1;
    await tx.insert(saleDiscount).values({
      id: newId(),
      saleId,
      operatorId: actor.operatorId,
      branchId: priced.scope.branchId,
      businessDate: priced.scope.businessDate,
      sequence,
      kind: 'promo',
      discountType: promo.type,
      // `sale_discount_value_check`: a percent code carries its percentage, a
      // fixed or free-item code the satang it was worth. The code's own
      // configured value, not what it happened to take off this cart — that is
      // `amount_satang` below, and the two differ whenever the balance ran out.
      percentBp:
        promo.type === 'percent'
          ? voucherPromo && promo.code === voucherPromo.code
            ? voucherConfiguredValue(voucherPromo)
            : Math.round(definitionOf(promo.code) * 100)
          : null,
      valueSatang: promo.type === 'percent' ? null : definitionOf(promo.code),
      amountSatang: promo.amount,
      allocations: null,
      // A voucher's free item is aimed at the one line it put on the bill, and a
      // 1+1 at the kids of one line: the row says which.
      scope: aimedAt(promo.code)
        ? aimedAt(promo.code)?.component
          ? 'component'
          : 'line'
        : 'order',
      targetLineId: aimedAt(promo.code)?.lineId ?? null,
      targetComponent: aimedAt(promo.code)?.component
        ? componentKey(aimedAt(promo.code)!.component!)
        : null,
      code: promo.code,
      label: promo.label,
      exhaustedReason: promo.exhaustedReason ?? null,
      appliedAt: now,
    });
  }

  /**
   * S2-10b — which voucher this sale was priced with, recorded with the sale:
   * the discount row says how much, this says which voucher, and it is what
   * the payment step reads to know what to use up. A ฿0 sale is closed right
   * here, so its voucher is used up right here.
   */
  if (priced.voucher) {
    const voucherScope = {
      saleId,
      operatorId: actor.operatorId,
      branchId: priced.scope.branchId,
      stationId: st.id,
    };
    await recordVoucherApplied(
      tx,
      voucherScope,
      {
        voucherId: priced.voucher.voucherId,
        code: priced.voucher.code,
        definitionCode: priced.voucher.definitionCode,
        label: priced.voucher.label,
        effect: priced.voucher.effect,
      },
      { accountId: actor.accountId, requestId: actor.requestId },
      priced.voucher.amountSatang,
      clock.occurredAt,
    );
    if (finalising) {
      await consumeSaleVouchers(
        tx,
        voucherScope,
        { accountId: actor.accountId, requestId: actor.requestId },
        clock.occurredAt,
      );
    }
  }

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: priced.scope.branchId,
    action: 'sale.create',
    entityType: 'sale',
    entityId: saleId,
    actionId: input.actionId ?? null,
    requestId: actor.requestId,
    after: {
      stationId: st.id,
      boxId: st.boxId,
      businessDate: priced.scope.businessDate,
      pricingMode: priced.scope.pricingMode,
      customerTier: priced.tier.code,
      grossSatang: priced.money.grossSatang,
      discountSatang: priced.money.discountSatang,
      lineCount: priced.lines.length,
      status: values.status,
    },
  });
  if (finalising) {
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: priced.scope.branchId,
      action: 'sale.finalise',
      entityType: 'sale',
      entityId: saleId,
      actionId: input.actionId ?? null,
      requestId: actor.requestId,
      before: { status: 'tendering' },
      after: {
        status: 'finalised',
        stationId: st.id,
        boxId: st.boxId,
        receiptNumber: receipt?.number ?? null,
        grossSatang: priced.money.grossSatang,
      },
    });
  }

  const [written] = await tx.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  if (!written) throw new Error('the sale was not written');
  return {
    replay: false,
    replayed: false,
    finalised: finalising,
    outstandingSatang: finalising ? 0 : owedAtCommit,
    pickupCode: recordedPickupCode(priced.lines.filter((l) => l.kind === 'fnb_item')),
    sale: viewOf(written),
    lines: priced.lines,
    rejectedPromoCodes: priced.rejectedPromoCodes,
    voucher: voucherViewOf(priced.voucher),
  };
}

/** What the till confirms was taken at the cash step. */
export interface TenderInput {
  /**
   * Cash today, because "Confirm Payment Received" is the only tender the till
   * has. S2-10a brings the EDC and the QR onto this same call; the method is
   * therefore a string the caller names rather than an assumption made here.
   */
  method?: string;
  /** The till's own classification of that token — cash, card, qr. Recorded as sent. */
  kind?: string;
  /** Satang this tender settles. Defaults to everything the sale still owes. */
  amountSatang?: number;
  /** What the guest handed over, when staff typed it. Change is the difference. */
  tenderedSatang?: number;
  /** The change the TILL showed. Compared with the platform's, never used as it. */
  changeSatang?: number;
  /** A slip number, a QR reference — whatever identifies the tender outside the platform. */
  reference?: string;
}

export interface FinaliseSaleInput {
  tender?: TenderInput;
  /** `x-oto-action-id` — one press of Confirm, however many HTTP attempts it took. */
  actionId?: string | null;
  /**
   * S2-09b — the order's pick-up code, when the cart did not already carry one.
   *
   * The prototype keys it in before the payment step, so the ordinary path
   * sends it with the cart and this stays empty. It is accepted here as well
   * because the alternative is a sale committed without one that can never be
   * closed: money taken at the counter and Cancel the only way out, which is
   * the trap the station's code prefix already taught this file.
   */
  pickupCode?: string;
}

/** The change owed back on a cash tender, and a refusal if the cash is short. */
function changeFor(amountSatang: number, tenderedSatang: number | undefined): number {
  if (tenderedSatang === undefined) return 0;
  if (tenderedSatang < amountSatang) {
    throw errors.badRequest(
      'The cash taken is less than the amount being settled, so this would leave negative change',
      { amountSatang, tenderedSatang },
    );
  }
  return tenderedSatang - amountSatang;
}

export interface FinaliseResult {
  /** The till's client reads `replay`; `replayed` is the same fact under the name the API used first. */
  replay: boolean;
  replayed: boolean;
  /** Whether this call closed the sale and numbered its receipt. */
  finalised: boolean;
  /** What is still owed after this tender. Zero on the call that closes the sale. */
  outstandingSatang: number;
  /** The tender this call took, as the Attempts list shows it. Null when there was nothing to take. */
  attempt: PaymentAttemptView | null;
  pickupCode: string | null;
  sale: SaleView;
  /**
   * The drawer the caller should now ask the box to open — resolved inside
   * this transaction, queued outside it, because a box asked to open a drawer
   * for a sale that rolls back is a drawer opened for money nobody took.
   */
  drawerKick: DrawerKick | null;
  /** S2-10b — the vouchers this call used up, by id. Empty unless it closed a sale carrying one. */
  redeemedVoucherIds: string[];
}

/**
 * Take a tender, and close the sale when the tenders cover it: record the
 * payment attempt, allocate the receipt number, persist it, and finalise —
 * ALL IN ONE TRANSACTION.
 *
 * THE ATOMIC ACT IS "the tender and the closing", never one without the other:
 * no payment recorded against a sale that then stayed open, and no receipt
 * numbered for money nobody took. Today the callers are the till's "Confirm
 * Payment Received" and the four counters that share its writer; the EDC (C2),
 * the QR webhook (D) and the offline replay (G) arrive at the same door.
 *
 * A SALE MAY NOW SIT PART-PAID — decision O-5, and the control-flow change of
 * this ticket. Before it, a tender that did not cover the balance was refused
 * and the refusal rolled the attempt back with it, which made a split tender
 * impossible and an asynchronous QR impossible with it: both need an approved
 * attempt on an unfinalised sale. The rule now is the one a till already
 * behaves as though it had — money is recorded when it is taken, and the sale
 * closes the moment what is outstanding reaches zero, whether that is the
 * second tender at the counter or a webhook twenty minutes later. What is NOT
 * relaxed: a tender bigger than the balance is still refused (there is nothing
 * to settle with it and the excess would be change nobody handed over), and
 * cash short of the amount being settled is still refused rather than recorded
 * as negative change.
 *
 * The owner-visible consequence, stated plainly because it is real: a sale can
 * be left open with money against it. That is what `job:payments.pending` and
 * the end of day (S2-15a) are for, and it is strictly better than the sale
 * that vanished with the money uncounted.
 *
 * Re-finalising a finalised sale returns it unchanged rather than taking a
 * second number or a second tender; and a tender replayed under the same
 * `x-oto-action-id` finds the attempt it already wrote instead of taking the
 * money twice.
 */
export async function finaliseSale(
  tx: Tx,
  actor: ActorContext,
  saleId: string,
  input: FinaliseSaleInput = {},
  now: Date = new Date(),
): Promise<FinaliseResult> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).for('update').limit(1);
  if (!row || row.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
  // The sale names the branch; the URL does not. So the scope check that a
  // route guard cannot make is made here, on the row that was found.
  await actor.assertBranchAllowed?.(row.branchId);
  const fnbLines = await tx
    .select({ id: saleLine.id, payload: saleLine.payload })
    .from(saleLine)
    .where(and(eq(saleLine.saleId, saleId), eq(saleLine.kind, 'fnb_item')));
  let pickupCode = recordedPickupCode(fnbLines);
  if (row.status === 'finalised') {
    return {
      replay: true,
      replayed: true,
      finalised: true,
      outstandingSatang: 0,
      // The tender this press took, read back rather than re-derived: a retry
      // of the press that closed the sale gets the same answer as the press.
      attempt: input.actionId
        ? await attemptOfAction(tx, row.operatorId, saleId, input.actionId)
        : null,
      pickupCode,
      sale: viewOf(row),
      // The drawer opened on the first answer. A retry down a dropped
      // connection must not open it again with a queue in front of it.
      drawerKick: null,
      redeemedVoucherIds: [],
    };
  }
  if (row.status === 'voided' || row.status === 'refunded') {
    throw errors.conflict('SALE_CLOSED', `This sale is ${row.status} and cannot be finalised`);
  }

  /**
   * S2-09b — AN ORDER WITH FOOD ON IT IS NOT CLOSED WITHOUT A PICK-UP CODE.
   *
   * The prototype will not let staff reach the payment stage until the code is
   * keyed (`pages/OrderStation.tsx:463-469`), because the code is how the tray
   * gets to the right guest and how the kitchen's ticket is matched to the
   * receipt. A disabled button is that rule on a screen; this is that rule on
   * the ledger.
   *
   * BEFORE THE TENDER, deliberately: a refusal after the money is recorded
   * would leave a paid sale nobody can close. And before the sale's status
   * moves, so writing the code onto the lines is not caught by
   * `pos.sale_line_freeze`.
   */
  if (fnbLines.length > 0 && !pickupCode) {
    pickupCode = normalisePickupCode(input.pickupCode);
    if (!pickupCode) pickupCodeRequired();
    for (const line of fnbLines) {
      await tx
        .update(saleLine)
        .set({ payload: { ...((line.payload as SaleLinePayload | null) ?? {}), pickupCode } })
        .where(eq(saleLine.id, line.id));
    }
  }

  const [st] = await tx.select().from(station).where(eq(station.id, row.stationId)).limit(1);

  let owed = await outstandingOf(tx, row);
  /** S2-10b — the sale's vouchers, as the transaction that moves its money sees them. */
  const voucherScope = {
    saleId,
    operatorId: row.operatorId,
    branchId: row.branchId,
    stationId: row.stationId,
  };
  /** What this call took, for the audit row. Null when there was nothing to take. */
  let taken: { method: string; amountSatang: number; changeSatang: number | null } | null = null;
  /** The attempt this call wrote or found, as every read answers with it. */
  let attempt: PaymentAttemptView | null = null;
  /** True when this press had already been recorded and this call wrote nothing. */
  let replayedTender = false;
  /** Ask the box to open the drawer, once the transaction has committed. */
  let drawerKick: DrawerKick | null = null;
  if (owed > 0) {
    // CALLING THIS ROUTE IS THE CONFIRMATION THAT THE MONEY WAS TAKEN — it is
    // what the till's "Confirm Payment Received" does — so a call that names
    // no tender settles the balance in cash rather than refusing. Staff who
    // typed what the guest handed over get `tendered` and `change` recorded
    // with it; staff who only pressed the button get the amount alone.
    const tender = input.tender ?? {};

    /**
     * PRESSING PAY TWICE, ON A SALE THAT IS STILL OPEN.
     *
     * `status = 'finalised'` above catches the retry of a press that CLOSED
     * the sale, and until this ticket that was every press. It stops being
     * sufficient the moment a sale can sit part-paid: the retry of a press
     * that took half the balance finds a sale still `tendering` and would take
     * half of it again. So the press itself is the key — `x-oto-action-id`,
     * unique per operator on the attempt — and a retry is answered with what
     * the first call recorded. The database index is the net under the race
     * this read cannot see; the read is what turns a 23505 at a counter into
     * an ordinary answer.
     */
    const already = input.actionId
      ? await findAttemptByAction(tx, row.operatorId, input.actionId)
      : null;
    if (already) {
      if (already.saleId !== saleId) {
        throw errors.conflict(
          'ACTION_ID_REUSED',
          'That action id already recorded a tender against another sale',
          { actionId: input.actionId, saleId: already.saleId },
        );
      }
      attempt = attemptView(already);
      replayedTender = true;
    } else {
      /**
       * S2-10b — THE TENDER GUARD, before a satang is recorded: a sale priced
       * with a voucher that is no longer held for it takes no money here (see
       * `assertSaleVouchersHeld`). The card, QR and manual paths run the same
       * check before they write an attempt.
       */
      await assertSaleVouchersHeld(tx, voucherScope, now);
      const amountSatang = tender.amountSatang ?? owed;
      if (amountSatang <= 0) throw errors.badRequest('A tender has to settle something');
      if (amountSatang > owed) {
        throw errors.badRequest('That tender is more than this sale still owes', {
          amountSatang,
          outstandingSatang: owed,
        });
      }
      const methodCode = tender.method ?? 'cash';
      const method = await tenderMethodOf(tx, row.operatorId, methodCode, tender.kind);
      const changeSatang = changeFor(amountSatang, tender.tenderedSatang);
      /**
       * OPENED, THEN SETTLED — the lifecycle every tender shares, run here in
       * one transaction because cash is taken before the call is made.
       *
       * WHOSE, WHERE AND WHEN are copied off the locked sale row rather than
       * re-derived. The trading day especially: the tender belongs to the day
       * the sale it settles belongs to, so a cash-up after midnight counts the
       * late party's money on the day that is finishing (S2-15a groups on
       * exactly these four columns, with no join and no backfill).
       */
      const opened = await openAttempt(tx, {
        operatorId: row.operatorId,
        branchId: row.branchId,
        stationId: row.stationId,
        businessDate: row.businessDate,
        saleId,
        method,
        methodCode,
        amountSatang,
        // What was handed over and what went back are COLUMNS now, not jsonb:
        // the cash-up adds them up. Only the till's own change figure, when it
        // disagrees with the platform's, stays in the payload — that is
        // evidence of a disagreement, not a second figure to count.
        ...(tender.tenderedSatang === undefined
          ? {}
          : { tenderedSatang: tender.tenderedSatang, changeSatang }),
        actionId: input.actionId ?? null,
        payload: {
          ...(tender.kind ? { kind: tender.kind } : {}),
          // A disagreement about arithmetic this simple is worth being able to
          // find later, and it is not worth refusing a sale at the counter over.
          ...(tender.changeSatang !== undefined && tender.changeSatang !== changeSatang
            ? { tillChangeSatang: tender.changeSatang }
            : {}),
          ...(tender.reference ? { reference: tender.reference } : {}),
          takenByAccountId: actor.accountId,
          ...(input.actionId ? { actionId: input.actionId } : {}),
        },
      });
      // Money taken at a counter is paid at the moment it is recorded. The
      // instruments that answer later stamp this when their answer arrives.
      attempt = attemptView(await settleAttempt(tx, opened.id, { paidAt: now }));
      owed -= amountSatang;
      taken = {
        // The TOKEN, as the audit row has always carried it: what staff chose on
        // the screen, not the word the ledger files it under.
        method: methodCode,
        amountSatang,
        changeSatang: tender.tenderedSatang === undefined ? null : changeSatang,
      };
      /**
       * CASH IN THE TILL OPENS THE TILL (O-4). Resolved here, inside the
       * transaction, on the station row it locked the sale against; queued by
       * the caller once this has committed. A card or a QR leaves it shut.
       */
      if (method === 'cash' && st) {
        drawerKick = await resolveDrawerKick(tx, {
          stationRow: st,
          saleId,
          attemptId: opened.id,
          actionId: input.actionId ?? null,
        });
      }
    }
  }

  /**
   * THE SALE MAY SIT PART-PAID (O-5). The money is recorded, the sale stays
   * open, and no receipt number is spent — a document number is spent once and
   * spending it on a sale that is not settled leaves a gap somebody has to
   * explain. The next tender, at this counter or from a webhook, closes it.
   */
  if (owed > 0) {
    if (!replayedTender) {
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        branchId: row.branchId,
        action: 'sale.tender',
        entityType: 'sale',
        entityId: saleId,
        actionId: input.actionId ?? null,
        requestId: actor.requestId,
        before: { status: row.status, outstandingSatang: owed + (taken?.amountSatang ?? 0) },
        after: {
          status: row.status,
          stationId: row.stationId,
          boxId: row.boxId,
          grossSatang: row.grossSatang,
          outstandingSatang: owed,
          tender: taken,
        },
      });
    }
    return {
      replay: replayedTender,
      replayed: replayedTender,
      finalised: false,
      outstandingSatang: owed,
      attempt,
      pickupCode,
      sale: viewOf(row),
      drawerKick,
      redeemedVoucherIds: [],
    };
  }

  /**
   * S2-10b — THE MONEY IS IN, SO THE VOUCHER IS USED UP: in this transaction,
   * before the receipt is numbered, through the one guarded update that makes
   * it single-use. If another sale got there first this throws, and the
   * tender, the receipt number and the close all roll back with it.
   */
  const { consumed } = await consumeSaleVouchers(
    tx,
    voucherScope,
    { accountId: actor.accountId, requestId: actor.requestId },
    now,
  );

  if (!st?.codePrefix) {
    throw errors.badRequest(
      'This station has no code prefix, so it cannot number a receipt — set one on the station',
    );
  }
  const receipt = await allocateReceipt(tx, {
    operatorId: row.operatorId,
    branchId: row.branchId,
    stationId: row.stationId,
    series: st.codePrefix,
  });

  const updated = await tx
    .update(sale)
    .set({
      status: 'finalised',
      finalisedAt: now,
      receiptSeries: receipt.series,
      receiptSeq: receipt.seq,
      receiptNumber: receipt.number,
    })
    .where(eq(sale.id, saleId))
    .returning();
  const after = updated[0];
  if (!after) throw new Error('the sale was not finalised');

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: row.branchId,
    action: 'sale.finalise',
    entityType: 'sale',
    entityId: saleId,
    actionId: input.actionId ?? null,
    requestId: actor.requestId,
    before: { status: row.status },
    after: {
      status: 'finalised',
      stationId: row.stationId,
      boxId: row.boxId,
      receiptNumber: receipt.number,
      grossSatang: row.grossSatang,
      // What closed it, so "who took this money and how" is answerable from
      // the log and not only from the payment row.
      tender: taken,
      ...(pickupCode ? { pickupCode } : {}),
    },
  });

  return {
    replay: replayedTender,
    replayed: replayedTender,
    finalised: true,
    outstandingSatang: 0,
    attempt,
    pickupCode,
    sale: viewOf(after),
    drawerKick,
    redeemedVoucherIds: consumed,
  };
}

// --- Voiding a sale that took no money --------------------------------------

export interface VoidSaleInput {
  /**
   * Why. Required, as a manual discount's reason is: "cancelled" with no reason
   * is what the voids report exists to stop, and `sale_void_check` refuses a
   * void without one.
   */
  reason: string;
}

export interface VoidSaleResult {
  /** True when the sale was already void and this call changed nothing. */
  replay: boolean;
  sale: SaleView;
  void: { voidedAt: string | null; voidedByAccountId: string | null; reason: string | null };
  /** The vouchers this call let go, by id — each free again for another cart. */
  releasedVoucherIds: string[];
}

/**
 * S2-10b — THE TILL'S CANCEL: void a sale that was rung up and took no money.
 *
 * WHAT IT IS FOR. A sale is rung up the moment Pay is pressed, and from then on
 * its voucher is kept for it (`holdStateOf`) and its line cannot simply be
 * taken off (`releaseVoucher`). When the guest walks away, or the card is
 * declined and they leave, this is the way out: the sale is closed as void so
 * it can never be paid, and a voucher it held is free again — released by the
 * trigger in migration 0021 in the same statement, with its ledger row.
 *
 * WHAT IT REFUSES, because each is a different act:
 *   - money taken on the sale (an attempt `approved` or `awaiting_settlement`)
 *     — SALE_HAS_PAYMENT: that is a refund (S2-11), not a void;
 *   - a tender still in flight (created, sent to a terminal, unknown,
 *     inquiring, waiting for a person) — PAYMENT_IN_FLIGHT: it may yet take
 *     the money, so it is finished or cancelled first. Declined, cancelled and
 *     not-found attempts took nothing and do not stand in the way;
 *   - a finalised sale — SALE_FINALISED: a closed sale is refunded;
 *   - a refunded one — SALE_CLOSED.
 *
 * IDEMPOTENT: voiding a void sale answers it as it is (`replay`), and the
 * route's idempotency key replays the first answer. LOCKS the sale first and
 * its vouchers after, the order the payment path takes, so a tender starting
 * at the same moment either finds the sale void or is seen here in flight.
 */
export async function voidSale(
  tx: Tx,
  actor: ActorContext,
  saleId: string,
  input: VoidSaleInput,
  now: Date = new Date(),
): Promise<VoidSaleResult> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).for('update').limit(1);
  if (!row || row.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
  // The sale names the branch; the URL does not — checked on the row, as finalise does.
  await actor.assertBranchAllowed?.(row.branchId);
  const voidOf = (r: typeof sale.$inferSelect): VoidSaleResult['void'] => ({
    voidedAt: r.voidedAt?.toISOString() ?? null,
    voidedByAccountId: r.voidedByAccountId,
    reason: r.voidReason,
  });
  if (row.status === 'voided') {
    return { replay: true, sale: viewOf(row), void: voidOf(row), releasedVoucherIds: [] };
  }
  if (row.status === 'finalised') {
    throw errors.conflict(
      'SALE_FINALISED',
      'This sale is finalised — a closed sale is refunded, not voided',
    );
  }
  if (row.status === 'refunded') {
    throw errors.conflict('SALE_CLOSED', 'This sale is refunded and cannot be voided');
  }

  const attempts = await tx
    .select({
      id: paymentAttempt.id,
      status: paymentAttempt.status,
      amountSatang: paymentAttempt.amountSatang,
    })
    .from(paymentAttempt)
    .where(eq(paymentAttempt.saleId, saleId));
  const taken = attempts.filter((a) => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status));
  if (taken.length > 0) {
    throw errors.conflict(
      'SALE_HAS_PAYMENT',
      'Money has been taken on this sale — it is refunded, not voided',
      {
        attemptIds: taken.map((a) => a.id),
        takenSatang: taken.reduce((sum, a) => sum + a.amountSatang, 0),
      },
    );
  }
  const inFlight = attempts.filter((a) => !PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(a.status));
  if (inFlight.length > 0) {
    throw errors.conflict(
      'PAYMENT_IN_FLIGHT',
      'A payment on this sale is still in progress — finish or cancel it before voiding the sale',
      { attempts: inFlight.map((a) => ({ id: a.id, status: a.status })) },
    );
  }

  const scope = {
    saleId,
    operatorId: row.operatorId,
    branchId: row.branchId,
    stationId: row.stationId,
  };
  const held = await lockVouchersHeldFor(tx, scope);
  const reason = input.reason.trim();
  const [after] = await tx
    .update(sale)
    .set({
      status: 'voided',
      voidedAt: now,
      voidedByAccountId: actor.accountId,
      voidReason: reason,
    })
    .where(eq(sale.id, saleId))
    .returning();
  if (!after) throw new Error('the sale was not voided');
  // The trigger in 0021 has released `held` and written their ledger rows in
  // the statement above; these are the audit rows that name who asked.
  await auditVoidReleases(
    tx,
    scope,
    held,
    { accountId: actor.accountId, requestId: actor.requestId },
    reason,
  );
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: row.branchId,
    action: 'sale.void',
    entityType: 'sale',
    entityId: saleId,
    requestId: actor.requestId,
    before: { status: row.status },
    after: {
      status: 'voided',
      reason,
      stationId: row.stationId,
      grossSatang: row.grossSatang,
      // The tenders that were tried and took nothing, so the void can be read
      // beside them.
      failedAttemptIds: attempts.map((a) => a.id),
      releasedVoucherIds: held.map((v) => v.id),
    },
  });
  return {
    replay: false,
    sale: viewOf(after),
    void: voidOf(after),
    releasedVoucherIds: held.map((v) => v.id),
  };
}

/**
 * The attempt one press wrote against THIS sale, for the answer a retry gets.
 *
 * Scoped to the sale as well as to the press: an action id that recorded money
 * against another sale is a different problem, and this read is not the place
 * to raise it.
 */
async function attemptOfAction(
  db: Exec,
  operatorId: string,
  saleId: string,
  actionId: string,
): Promise<PaymentAttemptView | null> {
  const found = await findAttemptByAction(db, operatorId, actionId);
  return found && found.saleId === saleId ? attemptView(found) : null;
}

// --- Reading ----------------------------------------------------------------

export interface SaleListFilters {
  branchId?: string;
  /**
   * The branches the caller's grants reach (SCRUM-297), for a list asked with
   * no branch named. Narrows the answer the way `branchId` does, and for the
   * same reason — it is just an explicit list rather than one id. Empty is a
   * real answer and the route handles it before calling: the caller holds the
   * permission nowhere.
   */
  branchIds?: string[];
  stationId?: string;
  memberId?: string;
  status?: SaleStatus;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/**
 * A sale as a LIST reads it: the row, plus the three names a person needs to
 * recognise it on a card — who rang it up, which counter, and who it was for.
 *
 * SCRUM-238 — History showed eight invented transactions because the platform's
 * list answered in ids: the till had a `memberId`, an `accountId` and a
 * `stationId` where the card wanted a guest, a cashier and a counter, and no
 * route to turn one into the other for a page of sales at once. Resolving them
 * here is one join each on the query that is already running, instead of the
 * till firing a lookup per row and showing blanks while they land.
 *
 * `lineKinds` and `revenueCategories` are what the card's icon and the page's
 * Tickets / F&B tabs read. A sale row has no "kind" of its own — a cart can
 * carry admission, food and a drop-off fee at once — so the list says what the
 * sale's LINES were and lets the reader's own grouping decide, rather than
 * inventing a single label on this side.
 */
export interface SaleListItem extends SaleReadView {
  soldBy: { accountId: string; name: string | null } | null;
  stationName: string | null;
  member: { id: string; name: string | null; nickname: string; phone: string } | null;
  lineKinds: SaleLineKind[];
  revenueCategories: string[];
}

export async function listSales(
  db: Exec,
  operatorId: string,
  filters: SaleListFilters,
): Promise<{ sales: SaleListItem[] }> {
  const where = [eq(sale.operatorId, operatorId)];
  if (filters.branchId) where.push(eq(sale.branchId, filters.branchId));
  if (filters.branchIds) where.push(inArray(sale.branchId, filters.branchIds));
  if (filters.stationId) where.push(eq(sale.stationId, filters.stationId));
  if (filters.memberId) where.push(eq(sale.memberId, filters.memberId));
  if (filters.status) where.push(eq(sale.status, filters.status));
  if (filters.from) where.push(gte(sale.businessDate, filters.from));
  if (filters.to) where.push(lte(sale.businessDate, filters.to));

  const rows = await db
    .select({
      sale,
      sellerName: employee.name,
      sellerNickname: employee.nickname,
      sellerPhone: account.phone,
      stationName: station.name,
      memberName: member.name,
      memberNickname: member.nickname,
      memberPhone: member.phone,
    })
    .from(sale)
    .leftJoin(account, eq(account.id, sale.createdByAccountId))
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .leftJoin(station, eq(station.id, sale.stationId))
    .leftJoin(member, eq(member.id, sale.memberId))
    .where(and(...where))
    // The day's sales, newest first — the order Today and History read them in.
    .orderBy(desc(sale.businessDate), desc(sale.occurredAt))
    .limit(filters.limit)
    .offset(filters.offset);

  // What each of those sales was made of, in one more query rather than one
  // per row. Only the kinds and the revenue areas: the money per line belongs
  // to the detail read, and a list that carried it would be a receipt.
  const ids = rows.map((row) => row.sale.id);
  const lines = ids.length
    ? await db
        .select({
          saleId: saleLine.saleId,
          kind: saleLine.kind,
          revenueCategory: saleLine.revenueCategory,
        })
        .from(saleLine)
        .where(inArray(saleLine.saleId, ids))
    : [];
  const kindsBySale = new Map<string, Set<SaleLineKind>>();
  const areasBySale = new Map<string, Set<string>>();
  for (const line of lines) {
    const kinds = kindsBySale.get(line.saleId) ?? new Set<SaleLineKind>();
    kinds.add(line.kind);
    kindsBySale.set(line.saleId, kinds);
    if (line.revenueCategory) {
      const areas = areasBySale.get(line.saleId) ?? new Set<string>();
      areas.add(line.revenueCategory);
      areasBySale.set(line.saleId, areas);
    }
  }

  // SCRUM-333 — the document check each of these was priced on, where one was.
  // The History drawer reads the sale it opens out of this list row, so the
  // line naming the check has to be here as well as on the detail.
  const claims = await tierClaimsOf(
    db,
    rows.map((row) => row.sale),
  );

  return {
    sales: rows.map((row) => ({
      ...viewOf(row.sale),
      tierClaim: claims.get(row.sale.id) ?? null,
      soldBy: row.sale.createdByAccountId
        ? {
            accountId: row.sale.createdByAccountId,
            // The nickname is what the park calls them and what the prototype's
            // card shows; the phone is the last resort for an account with no
            // employee record behind it.
            name: row.sellerNickname ?? row.sellerName ?? row.sellerPhone ?? null,
          }
        : null,
      stationName: row.stationName,
      member: row.sale.memberId
        ? {
            id: row.sale.memberId,
            name: row.memberName,
            nickname: row.memberNickname ?? '',
            phone: row.memberPhone ?? '',
          }
        : null,
      lineKinds: [...(kindsBySale.get(row.sale.id) ?? [])],
      revenueCategories: [...(areasBySale.get(row.sale.id) ?? [])],
    })),
  };
}

export async function getSaleDetail(
  db: Exec,
  operatorId: string,
  saleId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  if (!row || row.operatorId !== operatorId) throw errors.notFound('Sale not found');
  const lines = await db
    .select()
    .from(saleLine)
    .where(eq(saleLine.saleId, saleId))
    .orderBy(asc(saleLine.lineNo));
  const discounts = await db
    .select()
    .from(saleDiscount)
    .where(eq(saleDiscount.saleId, saleId))
    .orderBy(asc(saleDiscount.sequence));
  /** SCRUM-333 — the document check that chose this sale's tier, where one did. */
  const claims = await tierClaimsOf(db, [row]);
  /**
   * S2-10a — HOW THE MONEY WAS TAKEN, which this read could not answer before.
   *
   * Every attempt, not only the ones that worked: a declined card followed by
   * cash is the evening as it happened, and a Sale detail showing only the
   * cash is the one that makes a guest's complaint unanswerable. The view is
   * `PaymentAttemptView` — no payload, no QR payload, no tenancy columns.
   */
  const attempts = await attemptsForSale(db, saleId);

  return {
    sale: { ...viewOf(row), tierClaim: claims.get(row.id) ?? null } satisfies SaleReadView,
    /** S2-09b — the code the guest holds, from the F&B lines that carry it. */
    pickupCode: recordedPickupCode(lines.filter((line) => line.kind === 'fnb_item')),
    attempts,
    taxBreakdown: row.taxBreakdown,
    taxConfig: row.taxConfig,
    lines: lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      cartLineId: line.cartLineId,
      kind: line.kind,
      label: line.label,
      componentKey: line.componentKey,
      ticketPackageId: line.ticketPackageId,
      productId: line.productId,
      revenueCategory: line.revenueCategory,
      taxableCategory: line.taxableCategory,
      quantity: line.quantity,
      unitSatang: line.unitSatang,
      baseSatang: line.baseSatang,
      discountSatang: line.discountSatang,
      netSatang: line.netSatang,
      serviceChargeSatang: line.serviceChargeSatang,
      taxSatang: line.taxSatang,
      taxMode: line.taxMode,
      taxRateBp: line.taxRateBp,
      taxName: line.taxName,
      grossSatang: line.grossSatang,
      customerTier: line.customerTier,
      kidCount: line.kidCount,
      adultCount: line.adultCount,
      freeAdultCount: line.freeAdultCount,
      stayHours: line.stayHours,
      stayDurationLabel: line.stayDurationLabel,
      /**
       * S2-09b — what an F&B or shop line is made of: the options chosen, the
       * note that went to the station, the size sold, where it printed. Frozen
       * on the row, so the receipt reprint is the order that was made and not
       * the menu as it stands today.
       */
      modifiers: (line.payload as SaleLinePayload | null)?.modifiers ?? null,
      note: (line.payload as SaleLinePayload | null)?.note ?? null,
      variant: (line.payload as SaleLinePayload | null)?.variant ?? null,
      prepStation: (line.payload as SaleLinePayload | null)?.prepStation ?? null,
    })),
    discounts: discounts.map((d) => ({
      id: d.id,
      sequence: d.sequence,
      kind: d.kind,
      discountType: d.discountType,
      percentBp: d.percentBp,
      valueSatang: d.valueSatang,
      amountSatang: d.amountSatang,
      scope: d.scope,
      targetLineId: d.targetLineId,
      targetComponent: d.targetComponent,
      targetLabel: d.targetLabel,
      code: d.code,
      label: d.label,
      exhaustedReason: d.exhaustedReason,
      reason: d.reason,
      note: d.note,
      appliedByAccountId: d.appliedByAccountId,
      appliedByName: d.appliedByName,
      appliedAt: d.appliedAt?.toISOString() ?? null,
    })),
  };
}
