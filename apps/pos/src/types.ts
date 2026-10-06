import type { SupportedLang } from '@/i18n/types';

export interface Operator {
  id: string;
  name: string;
  role: 'staff' | 'manager';
  /**
   * Which staff-benefit role template drives this operator's F&B benefit
   * (Task #231). Absent = no benefit QR / no benefit for this operator. This
   * is DECOUPLED from `role` (login/permission level) — an owner can be a
   * 'staff' login role but carry the 'owner' benefit template, and vice versa.
   */
  benefitRole?: BenefitRole;
  /**
   * Per-person override of their role template's benefit profile. Any key
   * present here REPLACES that primitive wholesale (not merged field-by-field)
   * — e.g. setting `credit` here fully overrides the template's `credit`.
   * Absent keys fall through to the template. Absent object = pure template.
   */
  benefitProfileOverride?: BenefitProfile;
  /** Scannable code for this operator's printed benefit QR (Task #231). */
  benefitQrCode?: string;
}

// A price that varies by weekday vs weekend (and holiday overrides, which act
// as weekend). Every ฿ price stored in the catalog uses this shape — see
// lib/pricingMode.ts (getRateModeForDate/resolveRate) for the single resolver
// that turns one of these into a concrete number for a given date.
export interface WeekdayWeekendPrice {
  weekday: number;
  weekend: number;
}

// A named, inclusive date range that bills at weekend rates regardless of the
// actual day of week (e.g. Songkran). Managed in Admin under Pricing & Money →
// Holidays / weekend overrides.
export interface PricingOverride {
  id: string;
  name: string;
  startDate: string; // ISO yyyy-mm-dd, inclusive
  endDate: string; // ISO yyyy-mm-dd, inclusive
}

// Tiers are EDITABLE config (see TierDef and the store's `tiers` collection).
// CustomerTier is a plain string id alias so every existing reference
// (Sale.tier, Booking.tier, Member.tierVerification, TicketType.prices keys, …)
// still compiles while the owner can add/rename/remove tiers at runtime.
// The id is the stable key used in price maps and verification — never rename ids.
export type CustomerTier = string;

// A pricing tier the venue offers (e.g. Tourist, Expat, Thai). `id` is the
// stable key used in TicketType.prices, Sale.tier, verifications, etc.
export interface TierDef {
  id: string;
  name: string;
  isDefault: boolean; // the no-verification baseline (exactly one tier)
  requiresVerification: boolean; // true = needs proof to grant (e.g. expat/thai)
  sortOrder: number;
}

// A verified discounted-tier entitlement. The default tier never needs one.
export interface TierVerification {
  tier: CustomerTier; // the verified rate (expat | thai)
  proofType: string; // e.g. 'Passport', 'Residence certificate', 'School card'
  verifiedBy: string; // operator name (from auth context)
  verifiedById: string;
  verifiedAt: string; // ISO
  expiresAt?: string; // document expiry, YYYY-MM-DD, when one was recorded
  reverifyDue?: boolean; // the recorded expiry has passed: re-check the document; the rate holds
}

// Single source of truth for the messaging channels the POS/parent app can use
// to reach a contact. Absent/legacy data always defaults to WhatsApp — see
// normalizeChannel() in lib/contactChannel.ts.
export type ContactChannel = 'whatsapp' | 'telegram' | 'line';

export interface Member {
  id: string;
  phone: string;
  nickname: string;
  tierVerification?: TierVerification; // verified discounted tier; absent = default (tourist)
  // The channel this member prefers to be messaged on, picked via the channel
  // selector attached to PhoneInput wherever their phone is captured/edited
  // (member edit, till identify, drop-off action panel, self-booking identify).
  // Absent = default to WhatsApp (normalizeChannel()).
  preferredChannel?: ContactChannel;
  // Children saved against this member (keyed by their phone). Captured the first
  // time a child's drop-off/nanny details are entered, then OFFERED to pre-fill on
  // a return visit — never silently applied (the parent re-confirms each one).
  // PRIVACY / BACKEND: prototype data, in-memory only. A real backend MUST add
  // explicit consent records, retention limits and access control before storing
  // any of this against a phone number (see BACKEND_REQUIREMENTS.md).
  savedChildren?: SavedChild[];
}

// One child's reusable details saved against a returning member (phone-keyed).
// Captured on the first drop-off/nanny check-in (everything EXCEPT the photo —
// the photo is always re-taken and never stored). Offered to pre-fill the child
// form on the next visit, where the parent confirms or edits it.
export interface SavedChild {
  id: string;
  childName: string;
  childAge: number;
  // Real date of birth (ISO YYYY-MM-DD) captured via the low-tap picker. When
  // present the age is always derived from it so a saved child's supervision
  // requirement updates automatically over time; `childAge` stays as a snapshot
  // / legacy fallback for records captured before DOB existed.
  dateOfBirth?: string;
  allergiesMedical?: string;
  dietary?: string;
  foodRestrictions?: string;
  notes?: string;
  savedAt: string; // ISO — when first captured
  updatedAt: string; // ISO — last confirmed/edited
  savedBy?: string; // operator name (door) or 'Online booking' — audit stamp
}

// --- Branches (physical locations) ----------------------------------------
// A branch is a physical park location (e.g. HKT Central, HKT Chalong).
// The registry lives in the catalog store (shared config); the active branch
// is held in BranchContext (React memory, resets on reload).
export interface Branch {
  id: string;   // stable slug used as branchId on operational records
  name: string; // display name shown in the switcher
  country?: string;
  /**
   * IANA zone the branch trades in, e.g. `Asia/Bangkok`. Every date the till
   * decides — which day a sale belongs to, whether today is weekend pricing —
   * is resolved against this rather than the browser's clock (SCRUM-229), so
   * a branch created without one is a branch pricing on somebody's laptop.
   * Optional only because the mock rows predate it; the API defaults it.
   */
  timezone?: string;
  active: boolean; // false = retired (hidden from the switcher)
  /** Platform API uuid for this branch (server-backed branches only). */
  apiId?: string;
}

// How a non-base tier (expat/thai) derives its price from the Tourist (base)
// price. `manual` = the number in `prices` was typed directly (backward
// compatible default); `percent` = that many % cheaper than tourist; `amount`
// = that many ฿ cheaper than tourist. Admin stores the rule so changing the
// base auto-recomputes the derived tiers; `prices` always holds the resolved
// concrete numbers the POS reads.
export type TierPriceMode = 'manual' | 'percent' | 'amount';

export interface TierPriceRule {
  mode: TierPriceMode;
  value: number; // percent (0–100) or ฿ off; ignored when mode === 'manual'
}

// A free item bundled into a ticket's rate, e.g. a free adult admission, a
// second child free, or a free add-on (socks). Admin-configured on the ticket
// type; honoring it in the POS sale flow is a separate concern.
export type TicketFreebieKind = 'adult' | 'child' | 'addon';

export interface TicketFreebie {
  id: string;
  kind: TicketFreebieKind;
  addOnId?: string; // when kind === 'addon': which add-on is free
  quantity: number; // how many are included free
  tiers: CustomerTier[]; // which market tiers get this freebie
}

// How adults are charged for a given tier on a ticket type:
//  - same_as_kid: adults pay the same as the kid price for that tier
//  - set_price:   adults pay a fixed `price` for that tier
//  - free_adults: the first `freeAdults` adults enter free, then each additional
//                 ("overflow") adult is charged per `overflow` ('same_as_kid' →
//                 the kid price, 'set_price' → the `price` field)
export interface TierAdultRule {
  kind: 'same_as_kid' | 'set_price' | 'free_adults';
  // set_price: the adult ฿ price. free_adults with overflow 'set_price': the ฿
  // charged per overflow adult. Ignored otherwise.
  price?: WeekdayWeekendPrice;
  // free_adults: how many adults enter free before overflow pricing applies.
  freeAdults?: number;
  // free_adults: how adults beyond `freeAdults` are priced.
  overflow?: 'same_as_kid' | 'set_price';
}

// F&B credit give-back for a ticket type. `appliesTo` selects who earns credit;
// `basis` sets how much per person (full_price = the ฿ that person actually
// paid, fixed = a flat ฿, percent = a % of what they paid). appliesTo 'none'
// (or no rule) issues no credit.
export interface TicketCreditRule {
  appliesTo: 'none' | 'adults' | 'kids' | 'both';
  basis: 'full_price' | 'fixed' | 'percent';
  value?: number; // fixed: ฿ amount; percent: e.g. 100 or 120; ignored for full_price
}

export interface TicketType {
  id: string;
  name: string;
  durationLabel: string;
  hours: number; // play duration in hours; drives nanny supervised-time pricing
  // Concrete per-tier KID prices, keyed by tier id. A tier with no entry here is
  // "not priced" yet (lookups treat it as 0/unset — see priceForTier). Each
  // price carries a weekday and weekend value, resolved by getRateModeForDate.
  prices: Record<string, WeekdayWeekendPrice>;
  // Optional derivation rules for the non-default tiers, keyed by tier id.
  // Absent (or 'manual') = the price in `prices` was entered directly. The
  // default tier is always the base and never carries a rule.
  tierPricing?: Record<string, TierPriceRule>;
  // Optional free items included in the rate, per tier.
  freebies?: TicketFreebie[];
  // Per-tier adult entry rule, keyed by tier id. A tier with no entry defaults
  // to same_as_kid (adults pay the kid price for that tier). This is the ticket's
  // own adult package — there is no separate park-wide adult admission product.
  adultRules?: Record<string, TierAdultRule>;
  // Optional F&B credit give-back for this ticket. Absent = no credit.
  creditRule?: TicketCreditRule;
  // Whether adults entering on this ticket receive a gate-opening wristband.
  // Absent = no gate access.
  gateAccess?: boolean;
  // Optional display-only translations of `name` (never price/rules), keyed
  // by SupportedLang, read by the customer-facing /book & till displays via
  // resolveName(). Absent/missing language falls back to `name`. Admin
  // editing of this map is a follow-on — today only mockApi.ts/catalogStore
  // seeds it directly.
  translations?: Partial<Record<SupportedLang, { name: string; description?: string }>>;
}

export interface AddOn {
  id: string;
  name: string;
  price: WeekdayWeekendPrice;
  // Optional link to an InventoryItem. When set the add-on is stocked; selling
  // it decrements the linked variant. Absent = no stock tracking (backward compat).
  inventoryItemId?: string;
  // Override the default 'addons' taxable category for this specific item.
  // Absent = inherit the 'addons' category rule from the tax config.
  taxCategoryOverride?: TaxableCategory;
  // See TicketType.translations — same display-only seam.
  translations?: Partial<Record<SupportedLang, { name: string; description?: string }>>;
}

// One size/variant slice of a multi-variant add-on placed on a cart line, so
// different kids on the same ticket can take different sizes (e.g. 1×S + 2×M
// grip socks). Each slice decrements its OWN inventory variant.
export interface AddOnVariantQty {
  variantId: string;
  variantLabel: string; // baked in for display (e.g. "S") — no re-lookup needed
  quantity: number;
}

// An add-on placed on a cart line, with how many of it the guest wants. Staff can
// add any quantity (the catalog AddOn is the priced template). `price` is a
// SNAPSHOT — the catalog's weekday/weekend price already resolved to a concrete
// ฿ number via the sale's active rate mode at the moment it was added, so a
// cart never mixes modes mid-sale.
// - variantId is set when a stocked add-on resolves to a single chosen variant.
// - variantBreakdown is set when staff split the add-on across multiple variants
//   (e.g. grip socks S/M/L); `quantity` is then the SUM of the breakdown.
// Both absent means default/single variant.
export type SelectedAddOn = Omit<AddOn, 'price'> & {
  price: number;
  quantity: number;
  variantId?: string;
  variantBreakdown?: AddOnVariantQty[];
};

// What a promo/scanned discount code applies to. Absent on a Discount means the
// whole order (backward compatible with codes that predate scoping). The POS
// computes the discount only against the ฿ that fall within this scope.
export type DiscountTarget =
  | { kind: 'everything' }
  | { kind: 'tickets' }                              // all play-ticket admission
  | { kind: 'ticketGroup'; group: 'kids' | 'adults' } // only kids / only adults
  | { kind: 'ticketType'; ticketTypeId: string }     // one specific ticket length
  | { kind: 'addOns' }                               // all add-ons (socks, lockers…)
  | { kind: 'addOn'; addOnId: string }               // one specific add-on
  | { kind: 'fnb' }                                  // all food & beverage
  | { kind: 'fnbCategory'; category: string }        // a MenuCategoryDef.id (e.g. 'drinks')
  | { kind: 'menuItems'; menuItemIds: string[] }     // one or more specific menu items
  | { kind: 'merch' }                                // all retail / merch items
  | { kind: 'event_pass' };                          // event-day ticket passes

export interface Discount {
  code: string;
  label: string;
  /**
   * 'percent' — value is a percentage off (e.g. 10 = 10%).
   * 'fixed'   — value is a fixed ฿ amount off.
   * 'free_item' — adds the named item (freeItemId) to the order at ฿0.
   *              value is 0; the discount is computed as the item's price in the cart.
   */
  type: 'percent' | 'fixed' | 'free_item';
  value: number;
  /** For free_item: the id of the menu or merch item to give free. */
  freeItemId?: string;
  /** Which catalog freeItemId lives in. Defaults to 'menu'. */
  freeItemKind?: 'menu' | 'merch';
  // What the code applies to. Absent = the whole order.
  target?: DiscountTarget;
  // --- Promo voucher lifecycle fields (all optional, backward-compatible) ---
  /** ISO date (YYYY-MM-DD). Before this date the code is not yet valid. */
  validFrom?: string;
  /** ISO date (YYYY-MM-DD). After this date the code has expired. */
  validUntil?: string;
  /** Maximum total redemptions allowed across all customers. Absent = unlimited. */
  usageLimit?: number;
  /** Running count of times the code has been redeemed (incremented on finalize). */
  usedCount?: number;
  /** Maximum redemptions per customer (matched by phone). Absent = unlimited. */
  perCustomerLimit?: number;
  /** Maps customer phone → redemption count. Populated when perCustomerLimit is set. */
  perCustomerUsage?: Record<string, number>;
  /**
   * Whether this code may be combined with other codes on the same sale.
   * Absent/false = exclusive (cannot stack). To apply more than one code to a
   * cart, EVERY applied code — including the new one — must be stackable.
   */
  stackable?: boolean;
  /** false = code is disabled (rejected at checkout). Absent/true = active. */
  active?: boolean;
}

// --- Tax + service-charge engine ------------------------------------------
// A configurable VAT/tax + service-charge model. The owner's accountant sets
// the rates/sequence as data (never hardcoded); the pricing engine (@oto/shared,
// through lib/cartWire.ts since SCRUM-271) reads this and reports/adds tax +
// service charge per area. Seeded so today's
// displayed totals are unchanged until the config is edited (see catalogStore).
export type TaxMode = 'inclusive' | 'exclusive' | 'none';

// A named tax rate, e.g. VAT 7%. `percent` is a whole number (7 = 7%).
export interface TaxRate {
  id: string;
  name: string;
  percent: number;
  // Optional default mode used only to PRE-FILL an area's tax mode when this rate
  // is first assigned there. The per-area rule (below) is still the source of
  // truth the engine reads — this is a convenience hint, not enforced.
  defaultMode?: TaxMode;
}

// The taxable areas of the business. Each can carry its own tax mode + service
// charge. Till lines split across tickets / addons / drop_off; F&B splits into
// fnb vs bar; parties is the events deposit/balance flow.
export type TaxableCategory =
  | 'tickets'
  | 'fnb'
  | 'bar'
  | 'drop_off'
  | 'parties'
  | 'addons'
  // Retail / merch (flat-priced shop items with stock). Its own taxable area so
  // the owner's accountant can tax merch independently of F&B in Admin.
  | 'merch'
  // Stored-value loads (prepaid F&B credit loaded onto wristband). Never taxed
  // at load — taxed on spend at the F&B station. The tax engine defaults unknown
  // categories to taxMode:'none' so this category generates 0 tax while still
  // contributing its base to the grandTotal (the amount the parent pays now).
  | 'stored_value';

// How one category is taxed + service-charged.
export interface CategoryTaxRule {
  category: TaxableCategory;
  taxRateId?: string; // which TaxRate applies (undefined = none)
  taxMode: TaxMode;
  serviceChargePercent?: number; // service charge for THIS area (e.g. F&B 10); undefined/0 = none
  taxOnServiceCharge?: boolean; // true = tax computed on (base + service charge) — "tax on tax"
  // Optional SECOND tax on this area. Like the primary, it carries its own mode:
  //  - 'exclusive' (default): ADDED on top, computed on (base + service charge +
  //    the primary tax that is part of the price), i.e. "5% on price + VAT".
  //  - 'inclusive': already baked INTO the price, extracted for the receipt only
  //    (does not change what the customer pays), parallel to an inclusive primary.
  // undefined secondaryTaxRateId = no second tax. secondaryTaxMode defaults to
  // 'exclusive' when a second rate is set but no mode is chosen.
  secondaryTaxRateId?: string;
  secondaryTaxMode?: TaxMode;
}

// The whole tax configuration: the rate table, per-category rules, and where
// discounts sit in the sequence relative to tax/service.
export interface TaxConfig {
  rates: TaxRate[];
  categoryRules: CategoryTaxRule[];
  discountPlacement: 'before_tax' | 'after_tax';
}

// --- Print templates -------------------------------------------------------
// What each physical printout looks like. Physical printer ROUTING (which
// device) lives in Station Setup; a template only controls CONTENT/layout.
export type PrintTemplateType =
  | 'receipt'
  | 'kids_wristband'
  | 'adult_wristband'
  | 'kitchen_ticket'
  | 'bar_ticket'
  | 'credit_voucher';

export interface PrintTemplate {
  id: string;
  type: PrintTemplateType;
  name: string;
  showLogo: boolean;
  headerText?: string; // e.g. branch name / tagline
  footerText?: string; // e.g. "Thank you · Tax ID 0105..."
  // Section toggles — which blocks render on this printout. Only the fields
  // relevant to the template's type are surfaced in the editor (see
  // templateFields.ts), but the shape is shared for simplicity.
  fields: {
    itemizedLines?: boolean; // receipt/kitchen/bar: the line items
    taxServiceBreakdown?: boolean; // receipt: subtotal / service / tax / total (tax engine)
    voucherInfo?: boolean; // receipt: vouchers issued / used
    holderName?: boolean; // wristband/ticket: child/guest name
    durationTime?: boolean; // wristband: play length / valid-until
    qr?: boolean; // wristband/booking QR
    allergyLine?: boolean; // kitchen/bar/kids wristband: allergy alert
    orderNotes?: boolean; // kitchen/bar: item + order notes
    orderRefTime?: boolean; // kitchen/bar: order ref + timestamp
    // Bracelet extended fields (kids + adult wristband)
    startEndTime?: boolean; // play window, e.g. "10:00 – 11:00"
    partyName?: boolean; // party guest: the party name
    dietaryRequirement?: boolean; // food restriction note (distinct from allergy alert)
    supervisionBadge?: boolean; // DROP-OFF / NANNY badge for unaccompanied children
    assignedNannyName?: boolean; // nanny children only: the assigned nanny's name
    // Credit voucher fields
    creditVoucherBalance?: boolean; // show the loaded F&B credit balance on the voucher
    creditVoucherQr?: boolean;      // print the scannable QR code on the voucher
  };
}

// --- F&B wallet ledger entry -----------------------------------------------
// Every mutation of the F&B credit wallet (grant / spend / refund / expiry)
// appends one WalletEntry so staff can trace the full history. The wristband's
// `creditBalanceTHB` is ALWAYS the single source-of-truth balance; ledger
// entries are an audit trail only — they never recompute the balance.
export type WalletEntryKind = 'grant' | 'spend' | 'refund' | 'expire';

export interface WalletEntry {
  kind: WalletEntryKind;
  /** Signed amount: positive for grant/refund, negative for spend/expire. */
  amountTHB: number;
  /** Human-readable origin: 'ticket_sale' | 'prepaid_food' | 'fnb_order' | 'refund' | 'expiry'. */
  source: string;
  at: string;        // ISO timestamp of mutation
  by?: string;       // operator name when staff-stamped
  /** ISO timestamp when the credited balance expires (set only on 'grant' entries). */
  expiresAt?: string;
}

// Which part of a ticket line a component-scoped discount targets. Absent on a
// line-scope discount means the whole line (backward compatible). Kids/adults/
// socks are the ticket's people/socks groups; `addon` names a specific add-on.
export type DiscountComponentTarget =
  | { kind: 'kids' }
  | { kind: 'adults' }
  | { kind: 'socks' }
  | { kind: 'addon'; addOnId: string };

// In production these push to the HR Activity Logbook and feed a "discounts given"
// report, attributed to the face-login operator.
export interface ManualDiscount {
  id: string;
  scope: 'order' | 'line';
  targetLineId?: string;               // set when scope === 'line'
  // Set when a single component of the line is targeted (scope === 'line').
  // Absent = the whole line, as before.
  targetComponent?: DiscountComponentTarget;
  targetLabel?: string;                // human label of the targeted item or component (scope === 'line')
  type: 'percent' | 'fixed' | 'comp';  // comp = 100% off the target
  value: number;                       // percent or ฿; ignored for comp
  reason: string;                      // from preset reasons
  note?: string;                       // optional free text
  amountTHB: number;                   // actual ฿ discount resolved (audit)
  appliedBy: string;                   // current operator's name (from auth context)
  appliedById: string;                 // current operator's id
  appliedAt: string;                   // ISO timestamp
}

// --- Staff benefits (Task #231): QR-scan benefit application at F&B ------
// A configurable per-operator benefit, applied ONLY at the F&B order station,
// in a fixed order: comp -> free items (by category) -> credit -> standing %
// discount. Reuses DiscountTarget for category/item scoping — no parallel
// scoping system. Seeded Owner/Manager/Staff role templates are the default;
// an operator's effective profile is its role template with any per-primitive
// override applied (see Operator.benefitProfileOverride).

export type BenefitRole = 'owner' | 'manager' | 'staff';

// A periodic entitlement to N free items (or item-categories) per day/month,
// e.g. "2 free coffees per day". `target` reuses DiscountTarget scoping
// ('fnbCategory' | 'menuItems' | 'fnb' | 'everything') to say WHAT counts;
// non-F&B target kinds simply never match at the F&B station.
export interface FreeItemsBenefit {
  id: string;                    // stable key for usage tracking (e.g. 'coffee')
  label: string;                 // e.g. "Free coffee"
  target: DiscountTarget;
  quotaPerPeriod: number;        // e.g. 2
  period: 'daily' | 'monthly';
}

// A periodic ฿ credit pool spendable against F&B lines. `target` reuses
// DiscountTarget scoping the same way FreeItemsBenefit/PercentDiscountBenefit
// do; absent target = the whole F&B bill (e.g. "฿300/month F&B credit").
export interface CreditBenefit {
  amountTHB: number;
  period: 'daily' | 'monthly';
  target?: DiscountTarget;
}

// A standing (non-expiring) percent discount, optionally scoped; absent
// target = all F&B. Applied last, against whatever remains after comp/free
// items/credit — so it CAN discount the overflow beyond a free-item quota.
export interface PercentDiscountBenefit {
  percent: number;
  target?: DiscountTarget;
}

// One operator's (or one role template's) full benefit configuration. Every
// primitive is optional and independently composable; `comp` short-circuits
// everything else (the whole F&B order is comped).
export interface BenefitProfile {
  comp?: boolean;
  freeItems?: FreeItemsBenefit[];
  credit?: CreditBenefit;
  standingDiscount?: PercentDiscountBenefit;
}

// Editable seed template per benefit role (Owner/Manager/Staff), the starting
// point every operator with that `benefitRole` inherits unless overridden.
export interface RoleBenefitTemplate {
  role: BenefitRole;
  name: string;         // display name, e.g. "Owner"
  profile: BenefitProfile;
}

// Audit trail entry for every benefit application at the F&B till — written
// regardless of whether the order that carried it is later refunded.
export interface BenefitAuditEntry {
  id: string;
  at: string;                    // ISO timestamp
  scannedOperatorId: string;     // whose benefit QR was scanned
  scannedOperatorName: string;
  benefitRole: BenefitRole;
  processedById: string;         // the till operator who processed the order
  processedByName: string;
  isComp: boolean;                // flags owner-style full comps for review
  compedTHB: number;
  freeItemsTHB: number;
  creditTHB: number;
  discountTHB: number;
  totalReliefTHB: number;
  orderId?: string;               // set once the order is finalized
  branchId?: string;
}

// Drop-off service carried by a child cart line. A drop-off line is a single
// child (kids:1, adults:0, socks:0, addOns:[]) PLUS this metadata: the play
// ticket prices the play time, `serviceFeeTHB` adds the drop-off/nanny charge.
// Backed by a registration (checkInId) so the signed consent form is on file —
// on payment the child is checked into the park as part of the same sale.
export interface DropOffLine {
  registrationId: string;
  checkInId: string;
  childName: string;
  childAge: number;
  dateOfBirth?: string; // ISO YYYY-MM-DD when captured via the DOB picker
  allergiesMedical?: string;
  // Captured from the online booking form; carried into the CheckIn registration.
  mayOrderFood?: boolean;
  foodRestrictions?: string;
  // Prepaid food provision captured at door consent. When present, the
  // paidTHB is already included in the CartLine lineTotal (added on top of
  // ticket + service fee); the engine's cartUnits routes it to the correct tax category.
  foodProvision?: ChildFoodProvision;
  // Photo captured during online consent (data URL) — the child together with
  // the parent / guardian; carried into the CheckIn for pickup verification.
  childPhotoUrl?: string;
  service: DropOffServiceType;
  hours: number; // supervised/play hours — always the chosen play ticket's hours
  // Staff must explicitly pick the play-ticket length per child (no auto-default).
  // Until they do, the line is unpriced (serviceFeeTHB/lineTotal 0) and not payable.
  lengthChosen: boolean;
  nannyId?: string;
  nannyName?: string;
  // Customer-chosen nanny billing start time ("HH:MM", e.g. "10:30"). Set when
  // service='nanny' and booked online; empty for drop_off/none. Carried into the
  // CheckIn registration so the in-park board can show when nanny coverage begins.
  // Note: billing starts at this time regardless of actual arrival — late arrival
  // does NOT push the start time back.
  nannyStartTime?: string;
  // This line's contribution to the cart: a plain drop-off's own one-time fee, or
  // — for nanny — the SHARED nanny fee on the group's "owner" line and 0 on the
  // siblings she also covers (the fee is charged once per nanny). 0 until length
  // is chosen. See lib/dropoff.ts normalizeDropOffFees.
  serviceFeeTHB: number;
}

export interface CartLine {
  id: string;
  ticketType: TicketType;
  tier: CustomerTier;
  kids: number;
  adults: number;
  socks: number;
  addOns: SelectedAddOn[];
  lineTotal: number;
  /**
   * Present only on synthetic promo lines injected by a `free_item` promo code.
   * The line carries `lineTotal = priceTHB` (the item's shelf price) while a
   * matching discount of the same amount zeroes it out for the customer, so
   * grandTotal is unchanged but `discountAmount` records the markdown in EOD.
   * `ticketType` is a harmless stub (adults/kids=0 — never priced).
   */
  promoItem?: { itemId: string; itemKind: 'menu' | 'merch'; name: string; priceTHB: number };
  // Present only on drop-off lines (a single child checked in within this sale).
  dropOff?: DropOffLine;
}

/**
 * A credit grant issued at ticket sale time. This is PREPAID STORED VALUE —
 * the guest paid for it; it spends like cash at the appropriate station.
 * It is NOT a promo voucher (see Discount for marketing instruments that
 * reduce a bill).
 *   'fnb_credit'  → universal stored-value credit on wristband.creditBalanceTHB,
 *                   spendable at BOTH the F&B and merch stations (guest's choice).
 *                   (Token name kept for back-compat; it is no longer F&B-only.)
 *   'item'        → a printed item entitlement (e.g. socks to collect at the desk)
 */
export interface CreditGrant {
  id: string;
  type: 'fnb_credit' | 'item';
  label: string;
  valueTHB?: number;
  quantity?: number;
  // For fnb_credit grants: whose credit this is and whether that person opens
  // the entrance gate (adults on a gate-access ticket). Absent on item grants.
  // Drives per-person wristband minting so gate access comes purely from each
  // line's ticket package, not a park-wide config.
  role?: 'adult' | 'kid';
  gateAccess?: boolean;
}

/**
 * WHAT WAS QUOTED FOR THIS SALE, frozen onto it — S2-09a (SCRUM-203).
 *
 * The prototype recomputed a finished sale's money wherever it drew it: the
 * confirmation screen, the receipt lines, the customer display. That was
 * harmless while one arithmetic existed, and stopped being harmless the day the
 * platform's engine priced the cart in satang and the screens went on rounding
 * in baht — a 10% discount on ฿623 came off as ฿62 on the screen and ฿62.30 in
 * the ledger, and the receipt in the visitor's hand disagreed with the row the
 * park is audited on.
 *
 * So the figures are carried, not recomputed. Every screen that shows a
 * finished sale's money reads these, and the one number a person sees is the
 * one the platform charged.
 */
export interface SaleQuotedPricing {
  /** Where the figures came from: the platform's engine, or this till's copy of it. */
  source: 'platform' | 'till';
  engineVersion: string;
  total: number;
  subtotal: number;
  discountAmount: number;
  manualDiscountAmount: number;
  serviceChargeTotal: number;
  taxTotal: number;
  /**
   * The tax and service rows a receipt prints, exactly as `taxRowsOf`
   * (lib/cartWire.ts) returned them for this sale.
   */
  taxRows: {
    key: string;
    label: string;
    amount: number;
    kind: 'service' | 'tax_included' | 'tax_added';
  }[];
}

export interface Sale {
  id: string;
  operatorId: string;
  operatorName: string;
  tier: CustomerTier;
  lines: CartLine[];
  /** Applied promo codes. Multiple only when every code is stackable. */
  discounts?: Discount[];
  manualDiscounts: ManualDiscount[];
  memberId?: string;
  customerPhone?: string;
  customerNickname?: string;
  // The wristband this ticket sale issued/associated, so per-client order history
  // (scan bracelet → activity view) can gather every transaction for a band.
  wristbandCode?: string;
  // A configurable payment-method token (see PaymentMethod). Canonical seed
  // tokens are 'cash' | 'card' | 'promptpay'; admins can add more.
  paymentMethod?: string;
  // Set when this sale originated from redeeming an online booking at reception
  // (the booking's human-friendly reference, e.g. "OTO-XXXX-XXXX"). Lets staff
  // trace a transaction back to its booking in Order History.
  bookingReference?: string;
  /** Physical park location where this sale was recorded. Stamped by recordSale(). */
  branchId?: string;
  total: number;
  /**
   * The quoted figures this sale was charged at. Absent on sales built before
   * S2-09a (the seeded history) and on previews, where the screens fall back to
   * recomputing — see `SaleQuotedPricing`.
   */
  quoted?: SaleQuotedPricing;
  creditGrants: CreditGrant[];
  bracelets: {
    adults: number;
    children: number;
  };
  createdAt: string; // ISO timestamp the sale was finalized
  status: TxnStatus;
  refunds: Refund[];
  reprints?: ReprintEvent[]; // audit log of receipt/bracelet/credit grant reprints
  extensions?: Extension[]; // paid bracelet time-extensions on this booking
}

// An event pass bought online and attached to a booking. The attendee is created
// (registered, NOT checked in) on the event at booking time; this records the
// link so reception can recognise the pass when the booking QR is scanned and
// propose event check-in (no re-payment). The Events module still owns the
// attendee — this is just the POS-side pointer to it.
export interface BookingEventPass {
  eventId: string;
  attendeeId: string;
  eventTitle: string;
  attendeeName: string;
  parentAttending: boolean;
  priceTHB: number;
}

// A customer self-booking made on the public mobile booking engine (route /book).
// Bracelets/credit grants are NOT issued here — issuance happens at check-in when the QR
// is scanned at the park. `willIssue` only describes what the booking will produce.
export interface Booking {
  id: string;
  reference: string; // human-friendly code shown with the QR
  memberId?: string; // if identified
  tier: CustomerTier; // the resolved (verified-or-tourist) rate
  lines: CartLine[]; // reuse the ticket line shape
  promoDiscount?: Discount; // optional scanned-code promo
  total: number;
  // Online booking is card/QR only (never cash); stored as a payment token.
  paymentMethod: string;
  willIssue: { childBracelets: number; adultBracelets: number; creditTotalTHB: number };
  createdAt: string;
  // Redemption state — set when the booking QR is scanned at reception.
  status: 'paid' | 'redeemed';
  redeemedAt?: string;
  issuedWristbandCodes?: string[];
  // Links to the in-memory registration created at booking time for drop-off children.
  // Absent when the booking has no drop-off lines.
  registrationId?: string;
  // Event passes bought in this booking (camp day / event entry). Each created a
  // registered (not-checked-in) attendee on its event; reception proposes event
  // check-in for these when the booking QR is scanned. Absent when none.
  eventPasses?: BookingEventPass[];
  // Confirmations checklist ticked on the /book consent step (config-driven,
  // see SupervisionPolicy.confirmations). Present whenever the booking went
  // through the supervised drop-off/nanny consent step, even when no service
  // fee applies (e.g. an all-9+ unaccompanied group).
  acknowledgedConfirmations?: AcknowledgedConfirmation[];
}

// A prep station an F&B ticket can route to. 'none' = the item/category does
// NOT print a prep ticket at all (e.g. pre-packaged snacks handed over directly).
export type PrepStation = 'kitchen' | 'bar' | 'none';

// An editable F&B menu category. Categories are DATA (staff can add "Salad",
// "Desserts", …) instead of a hardcoded union. Each carries a default prep
// station + tax category, both overridable per menu item. `id` is the stable key
// that menu items reference via `MenuItem.category`.
export interface MenuCategoryDef {
  id: string; // stable key; existing items reference this
  name: string; // display name, e.g. "Salad"
  // undefined = a TOP-LEVEL category; set = a SUB-CATEGORY of that parent's id.
  // Only two levels are supported by the UI (top-level → sub-category); a parent
  // must itself be top-level (no grand-children).
  parentId?: string;
  // Default prep station / tax category for this category's items, each
  // overridable per item. On a SUB-CATEGORY these may be left undefined to
  // INHERIT the parent top-level category's value (resolved via lib/menu.ts).
  // Top-level categories always carry concrete values.
  defaultPrepStation?: PrepStation; // where this category's tickets print by default
  defaultTaxCategory?: TaxableCategory; // tax engine category by default (e.g. 'fnb' | 'bar')
  sortOrder: number; // tab order within its level (top-level row, or within a parent)
  // See TicketType.translations — same display-only seam.
  translations?: Partial<Record<SupportedLang, { name: string; description?: string }>>;
}

export interface ModifierOption {
  id: string;
  name: string;
  price: WeekdayWeekendPrice; // delta added to the item price; 0 = free, >0 = charged
  cost?: number; // optional cost-to-park delta for this option (COGS); omitted = not tracked
}

export interface ModifierGroup {
  id: string;
  name: string; // the question, e.g. "How would you like your steak?"
  required: boolean; // true = mandatory selection, false = optional
  selectionType: 'single' | 'multi'; // single = choose exactly 1; multi = choose many
  min?: number; // optional, for multi (e.g. min 0)
  max?: number; // optional, for multi (e.g. max 3)
  options: ModifierOption[];
}

export interface MenuItem {
  id: string;
  name: string;
  category: string; // a MenuCategoryDef.id (widened from the old fixed union)
  price: WeekdayWeekendPrice;
  cost?: number; // optional cost-to-park (COGS) for the base item; omitted = not tracked
  modifierGroups?: ModifierGroup[]; // omitted/empty = simple item, no selection needed
  // References into the shared `modifierGroups` library (catalog store). These
  // resolve to ModifierGroups that behave exactly like inline ones, but are
  // defined once and reused across items. Inline + linked are additive.
  linkedModifierGroupIds?: string[];
  prepStationOverride?: PrepStation; // overrides the category's defaultPrepStation
  taxCategoryOverride?: TaxableCategory; // overrides the category's defaultTaxCategory
  // Optional link to an InventoryItem. When set the menu item is stock-tracked;
  // selling it decrements the linked variant (size-tracked like socks). Absent =
  // no stock tracking (backward compat — most F&B is made-to-order).
  inventoryItemId?: string;
  // See TicketType.translations — same display-only seam.
  translations?: Partial<Record<SupportedLang, { name: string; description?: string }>>;
}

export interface SelectedModifier {
  groupId: string;
  optionIds: string[]; // one entry for single, one-or-more for multi
}

// --- Inventory (unified physical stock model) ----------------------------
// Canonical record of one tracked physical product variant. Every item has at
// least one variant; single-SKU items use a single 'default' variant.
export const INVENTORY_DEFAULT_VARIANT_ID = 'default';

// A physical storage location within a branch (e.g. bulk store, back-of-house, sell-point).
// 'bulk'         = accounting/bulk storage (large quantities, not directly sold from)
// 'back_of_house'= park back-of-house staging area
// 'rotation'     = front-of-house sell point (sales decrement from here by default)
export type StockLocationType = 'bulk' | 'back_of_house' | 'rotation';

export interface StockLocation {
  id: string;
  name: string;
  type: StockLocationType;
  // When true, sales decrement stock from this location. Exactly one rotation
  // location per branch should be the sell point (the rest are storage).
  sellPoint?: boolean;
  active: boolean;
}

// A named pack/unit size for bulk quantity entry (e.g. "Dozen = 12 eaches", "Case = 24").
// The base unit is always 'each' (implicit). Staff can enter "1 case + 3" at
// transfer/replenish time; the parser converts to total eaches.
export interface StockUnit {
  id: string;       // stable slug, e.g. 'dozen'
  label: string;    // display label, e.g. 'Dozen'
  eaches: number;   // how many base units this pack contains
}

export interface InventoryVariant {
  id: string;
  label: string;   // 'S' | 'M' | 'L' | 'Default' etc.
  /** Optional per-variant SKU / barcode (e.g. OTO-SOCK-M). Distinct from the
   *  item-level SKU which identifies the product line. */
  sku?: string;
  /** Optional reference to the sellable-product side's variant identifier
   *  (e.g. a product option label like "Medium" or a product-variant ID).
   *  Used by managers to document which product variant this inventory variant
   *  maps to; consumed by backend swap seam when products gain formal variants. */
  productVariantRef?: string;
  // Total on-hand eaches. When stockByLocation is present this MUST equal
  // sum(stockByLocation values) — always kept in sync by store mutators.
  stock: number;
  lowStockThreshold?: number;
  // Per-location stock counts (locationId → qty in eaches). When present
  // this is the canonical per-location view; `stock` is the derived total.
  // When absent the item uses simple total-only tracking (legacy / simple items).
  stockByLocation?: Record<string, number>;
  // Minimum desired on-hand per location. When stock at a rotation location
  // drops below its par, a transfer suggestion is generated.
  parByLocation?: Record<string, number>;
}

// Reorder / purchasing settings for an inventory item. Set by a manager in the
// Admin Inventory item form. Used to flag items that need external reordering
// (i.e., when total stock ≤ reorderPoint, distinct from par-based transfer
// suggestions which fire when a LOCATION is below par but total stock is fine).
//
// NOTE (backend flag): true usage-rate prediction (reorder when stock ≤
// usageRate × leadTime) requires server-side consumption history. The prototype
// triggers on the static reorderPoint and displays lead time / expected timing.
export interface ReorderSettings {
  // Trigger "needs reordering" when total on-hand eaches ≤ this value.
  reorderPoint: number;
  // Expected days from placing the order to delivery. Used to compute the
  // expected arrival date (today + leadTimeDays) when marking an order placed.
  leadTimeDays: number;
  // Supplier display name (free text; supplier management is out of scope for POS).
  supplierName: string;
  // Optional contact info: phone, email, LINE ID, etc.
  supplierContact?: string;
  // Default quantity to order, expressed in eaches. If the item has pack units
  // the Admin form lets staff enter it as packs; it is stored here in eaches.
  reorderQty: number;
}

// A logical inventory item that one sellable product (merch or stocked add-on)
// links to. Carrying all variants so per-size stock is tracked independently.
export interface InventoryItem {
  id: string;
  name: string;
  /** Item-level SKU / product code (e.g. OTO-SOCK). Individual variant SKUs live
   *  on InventoryVariant.sku. Optional — leave blank if not tracked by SKU. */
  sku?: string;
  /** Grouping category for display and reporting (free text, e.g. 'Apparel').
   *  Not the same as the taxable area — purely for admin organisation. */
  category?: string;
  /** When false the item is retired: hidden from staff stock ops but kept for
   *  historical reports. Defaults to true when absent. */
  active?: boolean;
  linkedKind: 'merch' | 'addon' | 'menu';
  linkedId: string; // MerchItem.id, AddOn.id or MenuItem.id
  variants: InventoryVariant[]; // always ≥1
  /** Branch that owns this stock pool. Absent = global / not yet scoped. */
  branchId?: string;
  // Optional pack-size definitions beyond the base 'each'. Shared across all
  // variants of this item (e.g. all soda sizes are bought in the same case size).
  // Setup in Admin Inventory; used at transfer/replenish/stock-take entry points.
  units?: StockUnit[];
  // Optional product photo (data URL, uploaded in Admin Inventory). Shown in the
  // Admin inventory list and throughout the stock module (take/receive/transfer).
  photoUrl?: string;
  // When true (and photoUrl is set) the photo also appears on the POS sell
  // surface tile of the linked product. Off by default.
  showPhotoInPos?: boolean;
  // Optional reorder/purchasing settings (manager-only, set in Admin Inventory).
  // When set and total stock ≤ reorderSettings.reorderPoint, the item is flagged
  // for reordering — distinct from par-based transfer suggestions.
  reorderSettings?: ReorderSettings;
  /** Unit cost in ฿ (cost to the venue per each). Used for stock valuation reports
   *  (unitCostTHB × on-hand qty = stock value). Optional: items without a cost show
   *  qty only in the value report with a "no cost set" flag. */
  unitCostTHB?: number;
}

// ── Purchase orders (reorder from external supplier) ────────────────────────

export type PurchaseOrderState =
  | 'to_order'   // created, not yet placed with supplier
  | 'ordered'    // placed with supplier; awaiting delivery
  | 'received';  // fully received (all lines at or above ordered qty)

// One line within a PurchaseOrder: one item+variant combination.
export interface PurchaseOrderLine {
  id: string;
  inventoryItemId: string;
  variantId: string;
  // Snapshot labels so display is stable even if the item is renamed.
  itemName: string;
  variantLabel: string;
  /** Total eaches ordered. Editable while state = 'to_order'. */
  orderedQty: number;
  /** Eaches received so far (accumulated across partial receipts). */
  receivedQty: number;
}

// A purchase order groups lines for a single supplier in a single ordering batch.
// Stamped with branch + operator at creation and at each state transition.
export interface PurchaseOrder {
  id: string;
  branchId: string;
  supplierName: string;
  supplierContact?: string;
  state: PurchaseOrderState;
  lines: PurchaseOrderLine[];
  // ── 'to_order' stamp ──
  createdAt: string;    // ISO
  createdBy: string;    // operator name
  createdById: string;
  // ── 'ordered' stamp ──
  orderedAt?: string;
  orderedBy?: string;
  orderedById?: string;
  /** ISO date (YYYY-MM-DD). Defaults to today + leadTimeDays at mark-ordered time. */
  expectedArrivalDate?: string;
  // ── 'received' stamp (set when all lines are fully received) ──
  receivedAt?: string;
  receivedBy?: string;
  receivedById?: string;
  notes?: string;
}

// A stamped stock log entry (receive / shrinkage / recount). Appended by
// recordInventoryAdjustment in mockApi; sale decrements and refund restores are
// NOT logged here — only deliberate Admin corrections.
export interface RestockLogEntry {
  id: string;
  inventoryItemId: string;
  variantId: string;
  delta: number;
  newStock: number;
  reason: string;
  operator: string;
  operatorId: string;
  at: string; // ISO
  branchId?: string;
  // Optional location this adjustment targeted (absent = total-level adjustment).
  locationId?: string;
}

// A stamped inter-location stock transfer. Moves qty eaches from one location
// to another within the same branch, logged with operator + timestamp.
export interface StockTransfer {
  id: string;
  inventoryItemId: string;
  variantId: string;
  fromLocationId: string;
  toLocationId: string;
  qty: number;         // eaches transferred
  operator: string;
  operatorId: string;
  at: string;          // ISO
  branchId?: string;
}

// Status of a stock-take line. 'pending' = staff counted but not yet committed.
// 'confirmed' = a manager signed off on a flagged discrepancy (or auto-committed
// for small discrepancies). 'adjusted' = stock was corrected to the counted qty.
export type StockTakeStatus = 'pending' | 'confirmed' | 'adjusted';

// One line of a stock take: the expected qty at a location vs what staff counted.
export interface StockTakeRecord {
  id: string;
  inventoryItemId: string;
  variantId: string;
  locationId: string;
  expectedQty: number;
  countedQty: number;
  discrepancy: number;   // countedQty - expectedQty (negative = shortage)
  // True when |discrepancy| exceeds the branch threshold and needs manager sign-off
  // before the stock correction is committed.
  flagged: boolean;
  status: StockTakeStatus;
  countedBy: string;
  countedById: string;
  countedAt: string;     // ISO
  confirmedBy?: string;  // manager name (set on sign-off)
  confirmedById?: string;
  confirmedAt?: string;  // ISO
  branchId?: string;
}

// --- Retail / merch (the shop lane) ---------------------------------------
// A flat-priced retail item. Stock is now tracked in the unified Inventory store
// (via inventoryItemId) rather than directly on this item. The `stock` and
// `lowStockThreshold` fields are RESOLVED from the linked inventory variant by
// the catalog getters (getMerchItems / getActiveMerchItems) and are optional so
// snapshots embedded in historical orders stay valid without inventory data.
export interface MerchItem {
  id: string;
  name: string;
  // When false the item is retired: hidden from the sell surface but kept in the
  // catalog (and in past orders). Toggled in Admin; never deletes history.
  active: boolean;
  price: WeekdayWeekendPrice;
  cost?: number; // optional cost-to-park (COGS); omitted = not tracked
  // Link to the unified InventoryItem. When set, stock is read from the linked
  // inventory variant (the getter resolves it). Absent = no stock tracking.
  inventoryItemId?: string;
  // Resolved from the linked InventoryItem's default variant by the getter.
  // Optional so historical order snapshots (no inventoryItemId) are still valid.
  stock?: number;
  lowStockThreshold?: number;
  // Resolved from the linked InventoryItem by the getter — only present when
  // the inventory item has a photo AND showPhotoInPos is enabled.
  photoUrl?: string;
  sku?: string; // optional barcode / stock-keeping unit
  category?: string; // optional free-text grouping label for the sell grid
  // Override the default 'merch' taxable category for this specific item.
  // Absent = inherit the 'merch' category rule from the tax config.
  taxCategoryOverride?: TaxableCategory;
  // The sizes the platform sells this item in (`pos.product.variants`, S2-09b).
  // Absent or one entry = the item sells as it always has; two or more = the
  // shop grid asks which size before it adds a line.
  variants?: MerchVariant[];
}

// One size of a shop item, as the platform defines it (S2-09b). `id` is what a
// sale line records and never changes when the size is renamed; `label` is what
// the picker, the cart and the receipt say. `barcode` is the code on this
// size's tag — a scan of it adds the item in this size.
export interface MerchVariant {
  id: string;
  label: string;
  sku?: string;
  barcode?: string;
}

// A stamped manual stock adjustment (Admin). Front-end only logs it; a real
// backend would post it to an inventory ledger. Sale decrements / refund
// restores are NOT logged here — only deliberate Admin corrections.
export interface MerchStockAdjustment {
  id: string;
  merchItemId: string;
  delta: number; // +received / -shrinkage; the signed change applied to stock
  newStock: number; // on-hand after the adjustment
  reason: string;
  adjustedBy: string; // operator name (auth context)
  adjustedById: string;
  adjustedAt: string; // ISO
  branchId?: string;
}

export interface Wristband {
  id: string;
  /**
   * The physical wristband code (printed on the band). One of the TWO keys
   * that resolve to this wallet — the other is `qrCode` on the printed voucher.
   * Scanning EITHER key at the F&B station opens the same tab.
   */
  code: string;
  /**
   * QR voucher code — a second lookup key for the SAME wallet as `code`.
   * Assigned when F&B credit is first granted (ticket sale, prepaid food).
   * Absent on bands with no F&B credit. Scanning this QR at the F&B station
   * resolves to the exact same wristband — no separate balance, no double-spend.
   */
  qrCode?: string;
  /**
   * SCRUM-208 — the platform member this band belongs to, where the band was
   * issued to one. Carried so an F&B order taken against the band can name its
   * member to the platform, which then prints the member's children's allergy
   * line on the kitchen/bar ticket (`orderChildren` in the platform's
   * sale-printing). Absent on a walk-in band, which names no member.
   */
  memberId?: string;
  customerNickname: string;
  /**
   * F&B credit wallet — PREPAID STORED VALUE loaded at ticket sale time.
   * The guest paid for this; it spends like cash at BOTH the F&B and merch
   * stations (one universal pool — the guest chooses where to spend it).
   * NOT a promo voucher (see Discount for bill-reduction instruments).
   * SINGLE SOURCE OF TRUTH — `ledger` is the audit trail; this is the balance.
   */
  creditBalanceTHB: number;
  /**
   * Wallet audit ledger — every grant, spend, refund and expiry appended in order.
   * Never used to recompute the balance (creditBalanceTHB is always the source of
   * truth). Absent on bands with no credit history.
   */
  ledger?: WalletEntry[];
  /**
   * Staging F3 — why this counter cannot take the tab's credit right now, in
   * its box's words (the offline cap reached today, the credit expired, a
   * wallet the box holds no copy of). Set only on a tab the box answered while
   * the counter works without the internet; the credit card shows it as it is.
   */
  creditNote?: string;
  // --- Allergy / medical + food consent (drop-off children) ---------------
  // These come from the drop-off web form via the child's CheckIn (the parent
  // declares allergies and whether staff may serve the child food). They are
  // STAFF-ONLY safety info and must NEVER be shown on the customer display.
  holderName?: string; // the child/guest the band belongs to (for kitchen/bar tickets)
  allergiesMedical?: string; // free-text serious allergy / medical alert, e.g. "Peanut allergy"
  foodRestrictions?: string; // dietary restriction note, e.g. "No nuts"
  mayOrderFood?: boolean; // false = parent did NOT authorize food orders for this child
  // Prepaid food provision loaded onto the band at check-in (door flow). When mode
  // is prepaid_credit the credit is in creditBalanceTHB; when prepaid_items the
  // items array carries the entitlements (redeemedQty reconciled at pickup).
  foodProvision?: ChildFoodProvision;
  checkInId?: string; // links back to the originating drop-off CheckIn
  /**
   * SCRUM-494 — the platform's stay (`pos.checkin.id`) the counter's scan
   * resolved this band to. Set only from `GET /wallets/scan`; the F&B order
   * names it as its band holder and its prepaid lines are served from it.
   */
  stayId?: string;
  // --- Gate access + group linkage (entrance gate / occupancy) ------------
  /**
   * Whether this band operates the entrance gate. TRUE for adult bands, FALSE
   * for kids' bands — set once at issuance (simple adult/kid rule, no per-band
   * override). Only the GATE reader consults this; every other scan surface
   * (F&B, credit, orders, allergy) ignores it and works the same for both.
   */
  gateAccess: boolean;
  /**
   * The sale/booking group this band was issued under (e.g. the Sale id). All
   * bands of one purchase share it. Drives the occupancy rule for regular kids:
   * a kid (no gate-out) counts as inside while their group has ≥1 adult inside;
   * when the LAST adult of the group gate-outs, the group's regular kids are
   * departed. Absent on drop-off/nanny bands (their exit is the drop-off
   * check-out, keyed by checkInId — never the group rule).
   */
  groupId?: string;
}

/**
 * One entrance-gate scan by a gate-access (adult) band. Kids' bands never
 * generate gate events — the gate does not operate for them; their presence is
 * derived from their group's adults (regular kids) or their drop-off CheckIn
 * status (drop-off/nanny kids). Occupancy derives each band's in/out state from
 * its LATEST event today, so re-entry is handled naturally and counts can never
 * go negative or strand across days (yesterday's events age out of the window).
 */
export interface GateEvent {
  id: string;
  wristbandId: string;
  code: string; // the band code as scanned (denormalized for display)
  direction: 'in' | 'out';
  at: string; // ISO timestamp
  branchId: string; // gate hardware belongs to a branch
}

export interface FnbOrderLine {
  id: string;
  menuItem: MenuItem;
  qty: number;
  selectedModifiers: SelectedModifier[];
  lineTotal: number; // (base price + sum of selected option price deltas) * qty
  // Free-text per-item note (e.g. "no pickles", "extra crispy"). Follows the
  // item to its prep station (kitchen/bar), the receipt, and the customer display.
  note?: string;
  // Which inventory variant was sold (matches InventoryVariant.id). Set when the
  // menu item is stock-tracked; absent = not tracked or default variant.
  variantId?: string;
  // Human-readable variant label baked in at line-creation (e.g. "Red") so
  // display doesn't need to re-look-up the inventory item.
  variantLabel?: string;
  // True when this line was redeemed from the band's prepaid item entitlement:
  // lineTotal is always ฿0 (already paid at booking), and redeemedQty on the
  // band is incremented at order confirmation. Never drawn from F&B credit balance.
  isPrepaid?: boolean;
  /** SCRUM-494 — the platform stay a prepaid line is served from (`Wristband.stayId`). */
  prepaidStayId?: string;
}

export interface FnbOrder {
  id: string;
  operatorId: string;
  operatorName: string;
  /** Physical park location where this order was recorded. Stamped by recordFnbOrder(). */
  branchId?: string;
  wristband?: Wristband;
  lines: FnbOrderLine[];
  manualDiscounts: ManualDiscount[];
  total: number;
  pickupCode: string;
  // Free-text whole-order note (e.g. "birthday — bring a sparkler"). Shown on the
  // customer display, the receipt, and BOTH prep tickets (kitchen + bar).
  orderNote?: string;
  payment: {
    creditUsed: number; // F&B credit (wristband.creditBalanceTHB) applied to this order
    cash: number;
    card: number;
    promptpay: number;
  };
  createdAt: string; // ISO timestamp the order was finalized
  status: TxnStatus;
  refunds: Refund[];
  reprints?: ReprintEvent[]; // audit log of receipt/pickup-ticket reprints
  // When the band's child was NOT authorized to order food (mayOrderFood:false)
  // but staff chose to serve anyway, the explicit override is stamped here.
  foodConsentOverride?: { byId: string; byName: string; at: string };
  // Set when a staff benefit QR was scanned and applied to this order. The
  // matching BenefitAuditEntry (by id) is the full source of truth; this is
  // a denormalized copy — including the per-primitive breakdown — so the
  // cart/receipt/history can show it without a join.
  staffBenefit?: {
    auditId: string;
    scannedOperatorId: string;
    scannedOperatorName: string;
    isComp: boolean;
    compedTHB: number;
    freeItemsTHB: number;
    creditTHB: number;
    discountTHB: number;
    totalReliefTHB: number;
  };
}

// --- Retail / merch orders (the shop lane) --------------------------------
// A single sold merch line. Mirrors FnbOrderLine but simpler (no modifiers):
// a merch item at its flat price × qty.
export interface MerchOrderLine {
  id: string;
  merchItem: MerchItem;
  qty: number;
  lineTotal: number; // merchItem.price * qty
  // Which size was sold. On a platform item it is the size's id
  // (MerchVariant.id, S2-09b), which the platform checks against the item's
  // own sizes; on the ported catalogue with no platform behind it, it is the
  // inventory variant (InventoryVariant.id). Absent = one size.
  variantId?: string;
  // Human-readable size label (e.g. "S", "M", "L"), which the cart line shows
  // as "Grip Socks (M)". Baked in at line-creation time so the cart needs no
  // re-lookup. It travels to the platform beside the id, and the platform
  // records its own catalogue's label rather than this one.
  variantLabel?: string;
}

// A recorded retail/merch order. Reuses the F&B order's multi-tender payment
// shape (credit + cash/card/promptpay) so history + End-of-Day fold it in with
// the same logic. No pickup code / prep tickets — merch is handed over at the till.
export interface MerchOrder {
  id: string;
  operatorId: string;
  operatorName: string;
  /** Physical park location where this order was recorded. Stamped by recordMerchOrder(). */
  branchId?: string;
  wristband?: Wristband;
  lines: MerchOrderLine[];
  manualDiscounts: ManualDiscount[];
  total: number;
  orderNote?: string;
  payment: {
    creditUsed: number; // wallet credit (wristband.creditBalanceTHB) applied to this order
    cash: number;
    card: number;
    promptpay: number;
  };
  createdAt: string; // ISO timestamp the order was finalized
  status: TxnStatus;
  refunds: Refund[];
  reprints?: ReprintEvent[]; // audit log of receipt reprints
}

// --- Order history + refunds (staff POS) ----------------------------------
export type TxnKind = 'ticket' | 'fnb' | 'merch';

export type TxnStatus = 'paid' | 'partially_refunded' | 'refunded';

// A single recorded refund against a transaction. In production refunds reverse
// the original payment and push to the HR Activity Logbook, feeding a
// discounts+refunds report. Front-end only records them.
export interface Refund {
  id: string;
  transactionId: string;
  kind: TxnKind;
  scope: 'full' | 'partial';
  amountTHB: number;
  creditRestoredTHB: number; // F&B/merch credit returned to wristband on refund
  reason: string;
  note?: string;
  refundedBy: string; // operator name (auth context)
  refundedById: string;
  refundedAt: string; // ISO
  // Merch only: the order-line ids whose units this refund returned to stock.
  // Recorded so a later refund never re-restocks a line already restored.
  restockedLineIds?: string[];
}

// A reprint of one or more artifacts (receipt, a bracelet, a credit grant) against a
// recorded transaction. Front-end only logs them; a real backend re-sends the
// print job to the receipt/bracelet printer and pushes to the HR Activity Logbook.
export interface ReprintEvent {
  id: string;
  transactionId: string;
  kind: TxnKind;
  items: string[]; // human labels of what was reprinted
  reprintedBy: string; // operator name (auth context)
  reprintedById: string;
  reprintedAt: string; // ISO
}

// A paid time-extension applied to ALL bracelets on a ticket booking. Extends the
// play time; charged per bracelet at the chosen duration and paid on the spot.
export interface Extension {
  id: string;
  transactionId: string;
  label: string; // e.g. "+1 hour"
  minutesAdded: number;
  braceletCount: number; // how many bracelets were extended
  amountTHB: number;
  paymentMethod: string;
  extendedBy: string; // operator name (auth context)
  extendedById: string;
  extendedAt: string; // ISO
}

// --- Parties (POS view of an Events-owned party booking) ------------------
// Events remains the system of record for parties. HOWEVER, the till is now
// allowed to EDIT a party in-place (and add tickets / F&B to it) — the booking
// fields below are editable via `updateParty` and stamped with the operator who
// made the change (see lastEditedBy/At). `id` + `branch` stay fixed, and the
// POS-owned ledgers (`partyExtraCharges` / `partyPayments`) are only mutated by
// their own seams. In production an edit here syncs back to the party record.
export type PartyStatus = 'upcoming' | 'in_progress' | 'completed' | 'cancelled';

// A configurable payment-method token (see PaymentMethod). Canonical seed tokens
// are 'cash' | 'card' | 'promptpay'; admins can add more.
export type PartyPaymentMethod = string;

// One bill line on the party package (from Events).
export interface PartyLineItem {
  id: string;
  name: string;
  qty: number;
  price: number; // unit price in ฿
}

// A POS-created extra charge billed to the party tab (open-tab style). `kind`
// records what was added — F&B order vs additional play tickets — so the bill
// and POS activity can label each charge correctly (both share this ledger).
export interface PartyExtraCharge {
  id: string;
  kind: 'fnb' | 'ticket';
  items: { name: string; qty: number; lineTotal: number }[];
  total: number;
  chargedBy: string; // operator name (auth context)
  chargedById: string;
  chargedAt: string; // ISO
}

// A POS-collected payment against the party's outstanding balance.
export interface PartyPayment {
  id: string;
  amount: number;
  method: PartyPaymentMethod;
  takenBy: string; // operator name (auth context)
  takenById: string;
  takenAt: string; // ISO
}

// When an F&B order is charged to a party tab (rather than a walk-in order),
// this rides on the shared order state so BOTH the staff station and the
// customer display can show which party — and which client — is being charged
// for the whole order. parentName/phone come from the party booking and stand
// in for the membership identity (same name + number). Undefined for walk-ins.
export interface ChargeTarget {
  partyId: string;
  partyTitle: string;
  childName?: string;
  parentName: string;
  phone?: string;
}

export interface PartyBooking {
  id: string;
  branchId: string;
  status: PartyStatus;
  // Named guest list (populated for parties that have pre-registered attendees).
  // The Events module owns these; the POS reads them for check-in only.
  attendees?: EventAttendee[];
  // Event Info
  title: string; // e.g. "Sophia's 5th Birthday Party"
  childName: string;
  kidAge?: number;
  kidDob?: string; // ISO YYYY-MM-DD when captured via the DOB picker
  parentName: string;
  whatsapp?: string;
  date: string; // ISO date (yyyy-mm-dd)
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
  location: string; // room / area
  expectedKids: number;
  expectedAdults: number;
  decoration?: string;
  activities?: string;
  finalMessage?: string; // staff-only
  // Host
  partyHost?: string;
  entertainmentHost?: string;
  // POS (the party bill, from Events)
  packageName?: string;
  basePrice: number;
  lineItems: PartyLineItem[];
  deposit: number;
  depositDate?: string;
  posNotes?: string;
  // Kitchen
  kitchen: {
    needed: boolean;
    kidsMenu: string[];
    adultsMenu: string[];
    setMenu?: boolean;
    foodItems: { id: string; name: string; qty: number }[];
    cake: { type: 'none' | 'our' | 'own'; qty?: number; time?: string; note?: string };
    serviceTime?: string;
  };
  // Bar
  bar?: { serviceTime?: string; items?: { id: string; name: string; qty: number }[] };
  // Timeline (run of show)
  timeline: { time: string; label: string; auto?: boolean }[];
  // Parent experience
  rsvp?: {
    attending: number;
    maybe: number;
    declined: number;
    totalKids: number;
    totalAdults: number;
  };
  // --- POS-OWNED transactions against this party (NOT from Events) ---
  partyExtraCharges: PartyExtraCharge[];
  partyPayments: PartyPayment[];
  // --- POS edit audit: stamped by `updateParty` when a party is edited in the
  // till (the till may now edit a party in-place). Absent until first edited. ---
  lastEditedBy?: string; // operator name (auth context)
  lastEditedById?: string;
  lastEditedAt?: string; // ISO
}

// --- Events (unified: party | camp | event) ---------------------------------
// Source of truth: the Events module creates and manages registrations.
// The POS reads events read-only. Party-type events additionally support POS
// billing actions (addPartyExtraCharge, addPartyPayment, updateParty).

export type EventType = 'party' | 'camp' | 'event';

// Per-day check-in record for an event attendee, keyed by ISO date.
// Camps record one entry per attended day; events/parties use the event date.
export interface EventAttendeeCheckin {
  checkedInAt: string; // ISO timestamp
  checkedOutAt?: string; // ISO timestamp
  wristbandCode: string; // kid's issued band code
  parentWristbandCode?: string; // parent band code (when parentAttending)
  operatorName: string;
  operatorId: string;
}

// A single registered attendee on a camp or one-off event.
export interface EventAttendee {
  id: string;
  name: string;
  age?: number;
  dateOfBirth?: string; // ISO YYYY-MM-DD when captured via the DOB picker
  language?: string; // preferred language
  allergyFlag?: boolean; // has allergy/medical note — staff-only safety signal
  allergyDetail?: string; // staff-only full detail
  dietaryFlag?: boolean; // has dietary restriction
  dietaryDetail?: string;
  attendanceDays?: string[]; // ISO dates the child attends (camps: subset of full range)
  parentName: string;
  parentPhone?: string;
  emergencyContact?: string; // "Name — +66 xx xxx xxxx"
  notes?: string; // free-text staff note captured at registration / walk-up add
  // When true a parent wristband is also printed on check-in.
  parentAttending?: boolean;
  // Party-guest RSVP status (party type only).
  rsvpStatus?: 'attending' | 'maybe' | 'declined';
  // Per-day check-in state. Camps key by ISO date; events/parties use event date.
  checkinByDate?: Record<string, EventAttendeeCheckin>;
}

// Unified event record. type === 'party' → all PartyBooking fields are present
// and the POS billing actions apply. type === 'camp' | 'event' → attendees[] is
// populated; billing fields are absent (no POS billing for these types).
export interface OtoEvent {
  id: string;
  branchId: string;
  type: EventType;
  status: PartyStatus;
  title: string;
  date: string; // start date ISO yyyy-mm-dd
  startTime: string;
  endTime: string;
  location: string;
  expectedKids: number;
  expectedAdults: number;
  // Camp: multi-day date range (start === date)
  dateRange?: { start: string; end: string };
  // Camp & event ONLY: flat per-day entry price for an event pass sold at the
  // till. NOT tier-based (a camp/event admission is one flat number, never a
  // membership rate). The Events module owns this value; the POS reads it.
  // Birthday parties never carry it — their guests ride the party tab instead.
  entryPriceTHB?: WeekdayWeekendPrice;
  // Camp & event: registered attendee list
  attendees?: EventAttendee[];
  // Party-only fields (populated when type === 'party')
  childName?: string;
  kidAge?: number;
  kidDob?: string; // ISO YYYY-MM-DD when captured via the DOB picker
  parentName?: string;
  whatsapp?: string;
  decoration?: string;
  activities?: string;
  finalMessage?: string;
  partyHost?: string;
  entertainmentHost?: string;
  packageName?: string;
  basePrice?: number;
  lineItems?: PartyLineItem[];
  deposit?: number;
  depositDate?: string;
  posNotes?: string;
  kitchen?: PartyBooking['kitchen'];
  bar?: PartyBooking['bar'];
  timeline?: PartyBooking['timeline'];
  rsvp?: PartyBooking['rsvp'];
  // POS-owned ledgers (party type only — never set on camp/event)
  partyExtraCharges?: PartyExtraCharge[];
  partyPayments?: PartyPayment[];
  lastEditedBy?: string;
  lastEditedById?: string;
  lastEditedAt?: string;
}

// --- Station / device setup -------------------------------------------------
// Each iPad picks which physical printers/scanner it drives so stations are
// interchangeable. The real hardware is reached via the local print agent.
export type DeviceType =
  | 'receipt_printer'
  | 'bracelet_printer'
  | 'kitchen_printer'
  | 'bar_printer'
  | 'scanner'
  | 'gate';
export type DeviceConnection = 'network' | 'bluetooth';

/**
 * How a device reaches the system, when that is more than the two links the
 * prototype knew. A device plugged into the branch box sits on the end of a
 * USB or serial cable rather than on the LAN or paired to an iPad, so `wired`
 * exists to keep the line under its name honest (S2-04).
 */
export type DeviceLink = DeviceConnection | 'wired';

export interface Device {
  id: string;
  type: DeviceType;
  label: string;
  connection: DeviceConnection;
  address?: string; // IP for network devices; absent for Bluetooth (OS-paired)
  /** Absent = `connection`, which is what every prototype device carries. */
  link?: DeviceLink;
  /** Absent = the address, or the iOS-pairing note, as before. */
  transportNote?: string;
}

// What a station is used for. Absent capabilities = "does everything" (backward compat).
export type StationCapability = 'tickets' | 'fnb' | 'dropoff' | 'parties';

// How scanning is performed on this station.
// Absent scannerMode + scannerId present → device mode (backward compat).
// 'box' is a scanner plugged into the branch box: it serves the till, the
// display, the gate and the kiosk alike, because the box publishes its scans to
// the whole station rather than to one screen (S2-04, R-15).
export type ScannerMode = 'device' | 'camera' | 'box';

// The per-iPad assignment of which devices this station drives.
export interface StationProfile {
  stationId: string;
  stationName: string;
  /** Branch this station belongs to. Absent = legacy / not yet scoped. */
  branchId?: string;
  receiptPrinterId?: string;
  kidsBraceletPrinterId?: string;
  adultBraceletPrinterId?: string;
  kitchenPrinterId?: string; // where F&B food/snack (kitchen) tickets print
  barPrinterId?: string; // where F&B bar/drink (bar) tickets print
  scannerId?: string;
  /** Absent = "does everything" so existing profiles are unchanged. */
  capabilities?: StationCapability[];
  /** Absent + scannerId present = device mode (backward compat). */
  scannerMode?: ScannerMode;
}

// --- Drop-Off check-in -----------------------------------------------------
// Parents who don't enter the park can drop off their children. They submit a
// public Drop-Off web form (built elsewhere); each submission lands here under
// "Registered". Staff message the parent, optionally assign a nanny, check the
// child in (→ In Park, running timer) and later check out (→ Out).
export type CheckInStatus = 'registered' | 'in_park' | 'out';
// 'none' = child is self-sufficient (floor=none); offered in the online supervised-child
// form so a 9+ year-old can proceed without a paid service.
// 'drop_off' = group supervision flat fee. 'nanny' = dedicated hourly nanny.
export type DropOffServiceType = 'none' | 'drop_off' | 'nanny';

// Available nannies come from HR scheduling (who's on shift). Mocked here.
export interface Nanny {
  id: string;
  name: string;
  available: boolean;
}

// One audited field change on a check-in (staff edit). Stamped with the operator.
// In production the change log also pushes to the HR Activity Logbook.
export interface ChangeLogEntry {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  changedById: string;
  changedAt: string; // ISO
}

export interface CheckIn {
  id: string;
  /** Branch where this child was checked in. Stamped at registration time. */
  branchId?: string;
  // Siblings from the SAME parent web-form submission share a registrationId
  // (and the same parent name/phone). The "Check in & pay" flow is scoped to a
  // registration so staff can check in several siblings together in one payment.
  // Only children on the registration can be checked in — none can be added.
  registrationId: string;
  // --- From the parent web form (editable here, every change audited) ---
  childName: string;
  childAge: number;
  dateOfBirth?: string; // ISO YYYY-MM-DD when captured via the DOB picker
  // Sign-up photo: one photo of the child TOGETHER WITH the parent / guardian,
  // used for pickup-safety matching. Placeholder image ok.
  childPhotoUrl?: string;
  /**
   * S2-13 round 2: the platform holds a consent photo for this stay, whether
   * or not its short-lived URL has been fetched into `childPhotoUrl` yet — so
   * the booked check-in does not ask for a photo that is already on file.
   */
  photoOnFile?: boolean;
  parentName: string;
  contactMethod: ContactChannel; // absent-on-legacy-records default = 'whatsapp'
  phone: string; // incl. country code, e.g. +66818953926
  allergiesMedical?: string; // empty if none
  mayOrderFood: boolean;
  foodRestrictions?: string;
  // Prepaid food provision chosen at door consent. When present, `mayOrderFood`
  // is derived from the mode: prepaid_credit | prepaid_items → true; none → false.
  foodProvision?: ChildFoodProvision;
  confirmationsAccepted: boolean;
  // Configurable confirmations checklist ticked at consent time (door or
  // /book). Distinct from `confirmationsAccepted` above (the legacy signed-form
  // flag) — this records WHICH configured items were accepted and when.
  acknowledgedConfirmations?: AcknowledgedConfirmation[];
  // --- Service + lifecycle (POS-owned) ---
  serviceType: DropOffServiceType;
  assignedNannyId?: string;
  assignedNannyName?: string;
  // Customer-chosen nanny billing start time from the online booking ("HH:MM").
  // Only present when serviceType='nanny' and booked via /book. Billing begins at
  // this time; late arrival does NOT push it back. Staff see this on the drop-off board.
  nannyStartTime?: string;
  status: CheckInStatus;
  scheduledFor?: string; // ISO, for the Schedule tab
  registeredAt: string;
  checkedInAt?: string; // set on Enter Park (drives the timer)
  checkedOutAt?: string; // set on Check Out
  bookedDurationMinutes?: number; // paid/booked play time; drives remaining-time overstay logic
  pickupPhotoUrl?: string; // photo of the person collecting the child, captured at Check Out
  // Set when the child is checked in via the merged "Check in & pay" flow: the
  // park ticket + drop-off/nanny service fee taken at check-in. The same sale is
  // also pushed to the transaction-history store (refundable in Order History).
  checkInSale?: {
    /** The recorded Sale's ID — linked after recordSale() so refunds are always deterministic. */
    saleId?: string;
    ticketTypeId: string;
    ticketName: string;
    tier: CustomerTier;
    wristbandCode?: string; // the child's band issued at check-in (links to order history)
    ticketPriceTHB: number;
    serviceType: DropOffServiceType;
    serviceFeeTHB: number;
    durationHours: number;
    totalTHB: number;
    paymentMethod: string;
    paidBy: string;
    paidById: string;
    paidAt: string;
  };
  // Contact-channel connection check — tracks whether the emergency/pickup
  // channel (WhatsApp, Telegram, or LINE — see contactMethod) is verified.
  // Auto-set when a registration with a phone is created (both booking and
  // walk-in paths), regardless of channel. Editing the phone number or the
  // channel re-triggers the check. Field name kept as `waConnection` for
  // backward compatibility; it is channel-agnostic.
  waConnection?: {
    status: WaConnectionStatus;
    sentAt?: string;    // ISO — when the confirmation template was sent
    confirmedAt?: string; // ISO — when the parent tapped "Confirm received"
  };
  // Operator audit (stamped on each POS action; optional so seeds stay light)
  assignedBy?: string;
  arrivedBy?: string;
  checkedInBy?: string;
  checkedOutBy?: string;
  checkedOutById?: string;
  /**
   * Recorded at check-out: who collected the child and how they were verified.
   * Absent on legacy records (before the authorized-pickup feature).
   */
  collectorRecord?: {
    /** 'dropper_off' | guardian.id | 'on_the_spot' */
    pickupId: string;
    name: string;
    relationship?: string;
    isDropperOff: boolean;
    source: AuthorizedPickupSource;
    verifiedBy: string;   // operator name
    verifiedById: string; // operator id
    verifiedAt: string;   // ISO
  };
  // Audited staff edits to the registration details.
  changeLog?: ChangeLogEntry[];
  // Prepaid food reconciliation stamped at check-out (refund or forfeit per policy).
  prepaidFoodSettlement?: {
    policy: 'refund' | 'forfeit';
    unusedTHB: number;
    /** Populated when policy='refund' and a refund was successfully issued in Order History. */
    refundId?: string;
    /**
     * Set when policy='refund' but the originating check-in sale could not be
     * located in Order History (e.g. sale was recorded before a page reload wiped
     * the in-memory ledger). Staff must issue the refund manually.
     */
    settlementError?: 'refund_no_sale';
    settledAt: string; // ISO
    settledBy: string; // operator name
    settledById: string;
  };
}

// An authorized pickup person attached to a registration (booking-level, shared
// across all the booking's children). The signed drop-off consent form lives at
// the booking level, so once a registration has one form, staff can add extra
// guardians (and children) on the spot at check-in.

/** How a Guardian was added to the authorized-pickup list. */
export type GuardianSource = 'in_person' | 'from_chat' | 'on_the_spot';

export interface Guardian {
  id: string;
  registrationId: string;
  name: string;
  phone: string;
  relationship?: string;   // e.g. 'grandmother', 'uncle', 'family friend'
  photoUrl?: string;       // captured or promoted from a chat photo
  source: GuardianSource;  // how they were added (audited)
  addedBy?: string;        // operator name (auth context)
  addedById?: string;      // operator id
  addedAt: string;         // ISO
  updatedBy?: string;      // operator name of last edit
  updatedById?: string;    // operator id of last edit
  updatedAt?: string;      // ISO of last edit
}

/**
 * Unified authorized-pickup view used by the UI. Combines the dropper-off parent
 * (derived from the CheckIn) with any added Guardians so all surfaces see one list.
 */
export type AuthorizedPickupSource = 'dropper_off' | GuardianSource;

export interface AuthorizedPickup {
  /** 'dropper_off' for the parent; guardian.id for added guardians. */
  id: string;
  registrationId: string;
  name: string;
  phone?: string;
  relationship?: string;
  /** Parent: the child+parent sign-up photo; others: their captured/chat photo. */
  photoUrl?: string;
  isDropperOff: boolean;
  source: AuthorizedPickupSource;
  addedBy?: string;
  addedAt: string; // ISO
}

// --- WhatsApp Business messaging -------------------------------------------
// In-app messaging with parents. Staff message from inside the POS via the
// WhatsApp Business integration — never by opening the external WhatsApp app.
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

// Whether the POS has a verified, working WhatsApp channel to this parent.
// Set automatically when a drop-off registration captures a phone number.
//   unverified — no confirmation was attempted (e.g. contact method is not WhatsApp)
//   pending    — confirmation template sent; waiting for the parent to tap "Confirm"
//   confirmed  — parent tapped "Confirm received" (inbound reply received)
//   failed     — message never delivered / parent has no WhatsApp on this number
export type WaConnectionStatus = 'unverified' | 'pending' | 'confirmed' | 'failed';

export interface WaMessage {
  id: string;
  recipientPhone: string;
  direction: 'outbound' | 'inbound';
  body: string;
  /** Inbound photo messages: the image data URL or URL. Present only on photo messages. */
  imageUrl?: string;
  templateId?: string;
  status: MessageStatus; // outbound only
  sentBy?: string; // operator name (auth context) for outbound
  sentById?: string;
  at: string; // ISO
}

export interface WaTemplate {
  id: string;
  name: string;
  category: 'drop_off' | 'party' | 'general';
  body: string; // may contain placeholders e.g. {childName}, {time}, {parentName}
  // Quick-reply buttons (WhatsApp interactive message). In production these
  // require a Meta-approved button template; here they are mocked for the sim.
  buttons?: { id: string; label: string }[];
}

// A unified, list-friendly view of a recorded ticket Sale or F&B order.
export interface TxnSummary {
  id: string;
  kind: TxnKind;
  reference: string;
  createdAt: string; // ISO
  total: number;
  status: TxnStatus;
  operatorName: string;
  customerLabel?: string; // nickname / wristband code if present
  wristbandCode?: string; // the band this txn is linked to (drives per-client history)
  isDropOff?: boolean; // a drop-off/nanny check-in sale (vs a regular ticket sale)
  bookingReference?: string; // present when the sale came from redeeming an online booking
  branchId?: string; // originating branch (populated on cross-branch member profiles)
  branchName?: string; // human-readable branch name for display (populated on cross-branch member profiles)
}

// Everything for one client, gathered by scanning their wristband in History:
// the band (holder + current F&B credit balance), the linked member if any, and
// every recorded transaction for that band split out as its own order.
export interface WristbandActivity {
  wristband: Wristband | null;
  member: Member | null;
  transactions: TxnSummary[]; // newest first
  totalSpent: number; // sum of (net of refunds) across these orders
  orderCount: number;
}

// --- Floor report (today's performance, staff glance) ---------------------
// A tiny, glanceable per-day performance snapshot derived from in-memory
// transactions. NOT a full analytics dashboard. All amounts in ฿, net of refunds.
export type FloorBucketKey = 'tickets' | 'fnb' | 'merch' | 'parties' | 'dropoff';

export interface FloorRevenueBucket {
  key: FloorBucketKey;
  label: string;
  amountTHB: number; // net sales for this category (excludes F&B credit), net of refunds
}

export interface FloorReport {
  date: string; // yyyy-mm-dd the figures cover
  branchId: string;
  netRevenueTHB: number; // sum of the buckets — money taken, excludes F&B credit spend
  creditPaidTHB: number; // amount settled via F&B/merch credit on the day (shown as context)
  txnCount: number; // ticket sales + F&B orders + party payments on the day
  guests: { kids: number; adults: number }; // bracelets issued from ticket sales on the day
  revenueSplit: FloorRevenueBucket[]; // Tickets / F&B / Parties / Drop-off
  partiesToday: number; // parties booked on the selected date + branch
  dropOffInParkNow: number; // drop-off children currently in_park (LIVE — not date-bound)
  ticketMix: { oneHour: number; twoHour: number; fullDay: number }; // guests per ticket duration
}

// Live head-count for the persistent top-bar occupancy chip, driven by the
// entrance gate. Adults are counted by their own gate in/out scans; regular
// kids (issued with a parent group) count as inside while their group has ≥1
// adult inside; drop-off/nanny kids count via their CheckIn status (their exit
// is the drop-off check-out, never the gate). See getLiveOccupancy in mockApi.
export interface LiveOccupancy {
  adults: number; // gate-access bands whose latest gate event today is 'in'
  kids: number; // regular kids w/ a group adult inside + drop-off kids not checked out
  total: number; // adults + kids currently inside
}

// --- End-of-day reconciliation (staff cash-up) ----------------------------
// Matches the POS's recorded revenue (the EXPECTED side, auto-filled) against
// what staff physically count / read from the EDC terminals (the ACTUAL side),
// per payment channel, and flags discrepancies before the day is locked.

// One acquiring/EDC card terminal in the branch, identified by its TID (the same
// identifier printed on the terminal's settlement report staff reconcile against).
export interface EdcTerminal {
  id: string;
  tid: string;
  label: string;
}

// --- Payment methods (configurable tenders) -------------------------------
// Drives which tenders the POS offers and how each behaves. `id` is the stable
// token stored on transactions (canonical seeds: 'cash' | 'card' | 'promptpay').
// `kind` drives behaviour: icon, refund routing (card/qr → auto, else manual)
// and EOD channel mapping. Admin can add / rename / disable / reorder methods.
export type PaymentMethodKind = 'cash' | 'card' | 'qr' | 'other';

export interface PaymentMethod {
  id: string;
  label: string;
  kind: PaymentMethodKind;
  enabled: boolean;
  sortOrder: number;
}

// Walk-up / drop-in day pricing for camps, one-off events and party additions.
// A last-minute attendee added at the door is billed per event type:
//   camp  → campDayTHB taken as a door payment (two-step pay) at check-in
//   event → eventDayTHB taken as a door payment (0 = a free event, no charge)
//   party → partyGuestTHB appended to the party tab (no separate door payment)
// Configurable here so the venue tunes each without code changes (the backend
// swap seam: getEventDropInPricing).
export interface EventDropInPricing {
  campDayTHB: WeekdayWeekendPrice;
  eventDayTHB: WeekdayWeekendPrice;
  partyGuestTHB: WeekdayWeekendPrice;
}

// Drop-off service pricing config (names the shape returned by getDropOffPricing).
// Drop-off is a flat one-time fee; nanny is billed per supervised hour.
export interface DropOffPricing {
  oneTimeFeeTHB: WeekdayWeekendPrice;
  nannyHourlyRateTHB: WeekdayWeekendPrice;
  // Charged per hour a child stays past their booked play time.
  extraHourTHB: WeekdayWeekendPrice;
  fullDayHours: number;
  nannyRatioSoftMax: number;
  // When a child's prepaid F&B provision goes unused (e.g. they leave early):
  // 'refund' = credit is refunded to the parent; 'forfeit' = credit is forfeited.
  // Consumed at pickup/checkout (future prompt); just configurable here.
  prepaidFoodRefundPolicy: 'refund' | 'forfeit';
}

// --- Prepaid child food provision (drop-off / nanny children) --------------
// How the parent pre-authorises and pre-pays for a drop-off child's food while
// in-park. Replaces the old boolean mayOrderFood toggle with a typed selection:
//   none         → child may NOT order food (blocks ordering at the F&B station)
//   prepaid_credit → parent pays a ฿ lump sum loaded onto the band as spendable
//                    F&B credit; NOT taxed at load (taxed at spend, like the
//                    adult F&B credit loaded from the admission price)
//   prepaid_items  → parent pre-selects specific items; taxed now at the F&B
//                    category rate; stored as entitlements on the band with
//                    redeemedQty starting at 0 (reconciled at pickup)
export type ChildFoodProvisionMode = 'none' | 'prepaid_credit' | 'prepaid_items';

export interface PrepaidItem {
  menuItemId: string;
  menuItemName: string;
  unitPriceTHB: number;
  qty: number;
  // Entitlement reconciliation: starts at 0 when the item is selected/loaded onto
  // the band. Incremented at the F&B station as each item is served. Compared to
  // qty at pickup to determine unused entitlements (for the refund/forfeit policy).
  redeemedQty: number;
}

export interface ChildFoodProvision {
  mode: ChildFoodProvisionMode;
  /** prepaid_credit: ฿ amount to load onto the band as spendable F&B credit. */
  creditAmountTHB?: number;
  /** prepaid_items: specific menu items pre-selected and paid at booking. */
  items?: PrepaidItem[];
  /** Resolved total charged for this provision; recorded for reconciliation. */
  paidTHB: number;
}

// --- Child-supervision policy (age → required service) ---------------------
// The owner's configurable rules mapping a child's age to the supervision
// service the park requires of them. Enforced at the door (a later prompt); this
// is the editable data model + resolver foundation.
export type SupervisionRequirement = 'nanny' | 'drop_off' | 'none';

// One age band → one requirement. `maxAge: null` means no upper bound (the
// open-ended top band, e.g. "9+"). Bands should be contiguous and
// non-overlapping so every age resolves to exactly one band.
export interface SupervisionBand {
  id: string;
  label: string; // e.g. "0–4", "5–8", "9+"
  minAge: number;
  maxAge: number | null; // null = no upper bound
  requirement: SupervisionRequirement;
}

// When an older sibling can "cover" a younger one, a staff member may waive the
// younger child's requirement at the door (audited). Offered, never auto-applied.
export interface SiblingWaiver {
  enabled: boolean;
  guardianMinAge: number; // a sibling this age or older can cover (default 9)
  waivableRequirement: SupervisionRequirement; // which requirement may be waived (default 'drop_off')
  staffOnly: boolean; // true = only staff at the door may authorize (never self-booking)
}

// One item in the admin-configurable pre-drop-off confirmations checklist (e.g.
// "I will remain within 15 minutes of the venue"). Order is display order on
// both the door screen and the public /book site. Not required = informational
// only, but still shown so parents see the full list.
export interface ConfirmationItem {
  id: string;
  text: string;
  required: boolean;
  order: number;
}

export interface SupervisionPolicy {
  bands: SupervisionBand[];
  siblingWaiver: SiblingWaiver;
  confirmations: ConfirmationItem[];
}

// One confirmation item the parent ticked at consent time, captured with the
// timestamp of acknowledgement. Distinct from the legacy `confirmationsAccepted`
// boolean (which just marks the WA-style consent form as signed) — this records
// WHICH configurable items were accepted and WHEN, for audit purposes.
export interface AcknowledgedConfirmation {
  text: string;
  acknowledgedAt: string; // ISO
}

// Audit record written when a staff member waives a child's supervision
// requirement at the door because an older sibling covers them. The waiver is
// staff-authorized (never self-service), so every one is stamped with the
// operator who approved it and the covering sibling that justified it.
export interface SupervisionWaiver {
  id: string;
  childName: string;
  childAge: number;
  waivedRequirement: SupervisionRequirement; // what was waived (e.g. 'drop_off')
  coveringSiblingName: string;
  coveringSiblingAge: number;
  waivedBy: string; // operator name (auth context)
  waivedById: string; // operator id
  waivedAt: string; // ISO
}

// One reconciled payment channel. `channel` is a stable key:
//   'cash' | 'promptpay' | 'card:<tid>' | 'ewallet' | 'bank_transfer'
//   | 'party_prepay' | 'credit'
// `differenceTHB` is actual − expected (0 while actual is still un-entered).
export interface ReconLine {
  channel: string;
  expectedTHB: number; // from the POS ledger
  actualTHB: number | null; // staff-entered (counted / read off the terminal)
  differenceTHB: number; // actualTHB - expectedTHB
}

// A whole day's reconciliation for one branch + date. Built open with the
// expected side pre-filled; locked read-only once closed (stamped with operator).
export interface EndOfDay {
  id: string;
  branchId: string;
  date: string; // yyyy-mm-dd the figures cover
  lines: ReconLine[];
  // Cash is reconciled by a physical drawer count: income = counted − float.
  // `floatTHB` (start-of-day float) is NOT entered here — it's carried over from the
  // previous close's `floatLeftTHB` (see below), so the drawer's opening balance is
  // always the cash physically left in it the night before.
  cashCount: { countedTHB: number | null; floatTHB: number | null; cashIncomeTHB: number | null };
  // Cash deliberately left in the drawer at close to seed tomorrow's float. Becomes
  // the NEXT day's `cashCount.floatTHB`. Defaults to the branch standard float.
  floatLeftTHB: number | null;
  vouchers: { handedOut: number | null; redeemed: number | null };
  totalExpectedTHB: number;
  totalActualTHB: number;
  totalDifferenceTHB: number;
  status: 'open' | 'closed';
  closedBy?: string; // operator name (auth context)
  closedById?: string;
  closedAt?: string; // ISO
  notes?: string;
}

// Everything for one member, gathered by phone lookup in History: the member
// (null when no profile matches the phone), every wristband code linked to them,
// and every recorded transaction across those bands + their own ticket sales
// aggregated across ALL branches (members are global — no per-branch scoping).
export interface MemberActivity {
  member: Member | null;
  phone: string; // the looked-up phone (member's own when matched, else the query)
  bandCodes: string[]; // distinct wristband codes linked to this member
  transactions: TxnSummary[]; // newest first; each entry carries branchId/branchName
  totalSpent: number; // sum of (net of refunds) across ALL branches
  orderCount: number;
  branchVisits: { branchId: string; branchName: string; count: number }[]; // per-branch visit summary
}
