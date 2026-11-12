import { z } from 'zod';
import type { RateMode } from './pricing-mode';

/**
 * SCRUM-804 — A PARTY SETTLED AS ONE REAL SALE (birthday plan §4, Lane 2).
 *
 * The OTO App plans the party (its package, counts, add-ons, entertainment, set
 * menu and food times) and publishes the plan in `otoapp_v.event_packages`
 * (SCRUM-803, the contract in the plan's catalog sources). The POS reads that
 * plan and settles the party: one sale for the money, through the sale engine
 * that prices every other sale, so the receipt, the bands, the socks taken off
 * the shelf, the F&B credit and End of Day are those of any sale.
 *
 * The owner's rules (2026-11-09), kept here as the composer reads them:
 *   - the package fee is the package's own price for the party's date, weekday
 *     or weekend (a branch holiday counts as weekend, as it does for tickets);
 *   - children beyond the package's included count pay the package's own
 *     extra-child price for that date; adults beyond the included count pay the
 *     package's own extra-adult price (350 / 500 on the Floresta package) —
 *     never the tier rate, which is for a normal sale without a package;
 *   - the package's socks are free pairs ("all children" is one pair per child),
 *     anything beyond them is sold at the socks product's price;
 *   - an add-on carrying F&B credit grants that credit in full (the reserved
 *     table 5,000, the private zone 3,000);
 *   - the included items print as 0-baht lines;
 *   - the deposit already paid is recorded as a payment, so the receipt reads
 *     the balance.
 *
 * Money is satang throughout. Counts and unit prices are decided here; every
 * total is the engine's (`computeTicketCartTotals`, through the api's
 * `priceCart`), so the till shows the api's figures and computes none.
 */

// --- Constants -----------------------------------------------------------------

/**
 * The tender a party's deposit is recorded under on its settlement sale. Like
 * the paid-online and stored-value tenders (`PAID_ONLINE_TENDER_CODE`,
 * `WALLET_TENDER_CODE`), a constant the PLATFORM writes, never a
 * `pos.payment_method` row: only the settlement writes it, so it is never on a
 * till's method grid, the park's tender list refuses the code, and
 * `tenderMethodOf` refuses it as a tender. The receipt names it from its code
 * ("Deposit paid in advance"); `label` is its readable name elsewhere. The
 * attempt carries no station — the money reached the park outside any counter —
 * so End of Day never counts it as the till's takings and no drawer opens for it.
 */
export const PARTY_DEPOSIT_TENDER = {
  code: 'deposit_paid_in_advance',
  label: 'Deposit (paid in advance)',
  kind: 'other',
} as const;

/** The package fee's component key on the sale ledger (kind `addon`, taxed as tickets). */
export const PARTY_PACKAGE_COMPONENT = 'party_package';
/** Each included item's component key: a 0-baht line under its own label. */
export const PARTY_INCLUDED_COMPONENT = 'party_included';

/** What each line of a settlement is for, on the ledger and in the till's preview. */
export const PARTY_LINE_ROLES = [
  'package',
  'included',
  'guests',
  'extra_children',
  'extra_adults',
  'socks',
  'add_on',
  'entertainment',
] as const;
export type PartyLineRole = (typeof PARTY_LINE_ROLES)[number];

/**
 * What a settlement's sale line carries in `payload.party`: the party, the
 * settlement, what the line is for, and — on the admission lines — `ticket`,
 * which makes the line a ticket line for the bands and the item vouchers as a
 * ticket package's line is. An add-on's F&B credit rides its line, per unit.
 */
export interface PartySaleLineTag {
  eventId: string;
  settlementId: string;
  role: PartyLineRole;
  ticket?: true;
  fnbCreditSatang?: number;
  creditHolder?: string;
}

/** Whether a sale line's payload makes it one of a party's admission lines. */
export function isPartyTicketLine(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const party = (payload as { party?: unknown }).party;
  return !!party && typeof party === 'object' && (party as { ticket?: unknown }).ticket === true;
}

/** The F&B credit one unit of a party add-on line grants, or 0. */
export function partyLineCreditSatang(payload: unknown): number {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 0;
  const party = (payload as { party?: { fnbCreditSatang?: unknown } }).party;
  const credit = party?.fnbCreditSatang;
  return typeof credit === 'number' && Number.isSafeInteger(credit) && credit > 0 ? credit : 0;
}

// --- The plan, as the OTO App publishes it (`otoapp_v.event_packages`) ----------

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Satang = z.number().int().min(0).max(10_000_000_000);
const Count = z.number().int().min(0).max(10_000);

/**
 * SCRUM-906: the largest quantity a kitchen-plan line (food, bar or cake) may
 * hold. It is the bound the OTO App's plan view reads a quantity with
 * (`^[1-9][0-9]{0,5}$`, app migrations 0048 and 0050), so the plan accepts
 * every quantity the view can publish: one typo in a BEO line shows that line
 * with its quantity, and never blanks the party's whole plan.
 */
export const PARTY_PLAN_LINE_QTY_MAX = 999_999;
const LineCount = z.number().int().min(0).max(PARTY_PLAN_LINE_QTY_MAX);

export const PartyPlanPackageSchema = z.object({
  templateId: z.string().nullable(),
  name: z.string(),
  hours: z.number().int().min(0).max(24).nullable(),
  kidsIncluded: Count,
  adultsIncluded: Count,
  /** A count of pairs, or -1 for one pair per child ("socks for all children"). */
  socksIncluded: z.number().int().min(-1).max(10_000),
  priceWeekdaySatang: Satang,
  priceWeekendSatang: Satang,
  /** Null where the package names no price: such a guest is refused, never admitted free. */
  extraChildWeekdaySatang: Satang.nullable(),
  extraChildWeekendSatang: Satang.nullable(),
  extraAdultWeekdaySatang: Satang.nullable(),
  extraAdultWeekendSatang: Satang.nullable(),
  /** The receipt's 0-baht lines: the table, the program, the cake, the water. */
  includedLines: z.array(z.object({ label: z.string() })),
});
export type PartyPlanPackage = z.infer<typeof PartyPlanPackageSchema>;

export const PartyPlanAddOnSchema = z.object({
  /** The plan's own id for the line: its template, or its place where it has none. */
  id: z.string(),
  templateId: z.string().nullable(),
  name: z.string(),
  qty: Count,
  unitPriceSatang: Satang,
  /** F&B credit per unit; 0 when the add-on grants none. */
  fnbCreditSatang: Satang,
  printsVoucher: z.boolean(),
});
export type PartyPlanAddOn = z.infer<typeof PartyPlanAddOnSchema>;

export const PartyPlanEntertainmentSchema = z.object({
  id: z.string(),
  templateId: z.string().nullable(),
  name: z.string(),
  category: z.string().nullable(),
  durationMinutes: z.number().int().min(0).nullable(),
  ageRange: z.string().nullable(),
  maxKids: z.number().int().min(0).nullable(),
  priceSatang: Satang,
  extraChildren: Count,
  extraChildPriceSatang: Satang.nullable(),
});
export type PartyPlanEntertainment = z.infer<typeof PartyPlanEntertainmentSchema>;

/**
 * SCRUM-829: who a line is for when the BEO's adults' menu differs from the
 * kids' — `kids` on a line the adults do not get, `adults` on a line of the
 * adults' own (instead of, beside, or in another count than the kids').
 * Absent on every line of a party whose adults eat the kids' menu, and on
 * every party whose BEO holds one list (the view, app migration 0048).
 */
export const PARTY_MENU_AUDIENCES = ['kids', 'adults'] as const;
export type PartyMenuAudience = (typeof PARTY_MENU_AUDIENCES)[number];

/**
 * SCRUM-906: where a kitchen-plan line came from. `set_menu` — the set menu,
 * or a line the BEO badges SET: part of the package; `extra` — a line the BEO
 * badges EXTRA (or one from before the badge); `party_only` — an item the
 * BEO's "New item" door made for this party alone (a `PARTY-` code,
 * SCRUM-828). Absent on a plan the OTO App published before its whole
 * kitchen plan (app migration 0050).
 */
export const PARTY_MENU_ORIGINS = ['set_menu', 'extra', 'party_only'] as const;
export type PartyMenuOrigin = (typeof PARTY_MENU_ORIGINS)[number];

export const PartyPlanMenuItemSchema = z.object({
  productCode: z.string().nullable(),
  name: z.string(),
  /** Null when the menu prints none, or splits one group's portions over several choices. */
  qty: LineCount.nullable(),
  choiceGroup: z.string().nullable(),
  chosenOption: z.string().nullable(),
  note: z.string().nullable(),
  audience: z.enum(PARTY_MENU_AUDIENCES).optional(),
  /**
   * SCRUM-829: on a kids' line the adults get as the same dish (name, count
   * and code) with another note — the adults' note, "" when theirs was
   * cleared. The dish is one line, charged once; the slip prints the note
   * beside it. Absent otherwise.
   */
  adultsNote: z.string().optional(),
  /** SCRUM-906: the BEO line's own id; absent for a set-menu template line no BEO line answers. */
  lineId: z.string().optional(),
  origin: z.enum(PARTY_MENU_ORIGINS).optional(),
  /** SCRUM-906: the price entered on the BEO line, per unit; absent when none was entered. */
  unitPriceSatang: Satang.optional(),
  /**
   * SCRUM-906: whether a live till product carries the line's code — false
   * for a line typed by hand or one whose code no product carries any more
   * ("not on the till menu"). Set by the api where it read the catalogue.
   */
  onTillMenu: z.boolean().optional(),
});
export type PartyPlanMenuItem = z.infer<typeof PartyPlanMenuItemSchema>;

export const PartyPlanBarItemSchema = z.object({
  productCode: z.string().nullable(),
  name: z.string(),
  qty: LineCount,
  /** SCRUM-906: the bar line's note, its id, its badge, its entered price and whether the till sells it. */
  note: z.string().nullable().optional(),
  lineId: z.string().optional(),
  origin: z.enum(PARTY_MENU_ORIGINS).optional(),
  unitPriceSatang: Satang.optional(),
  onTillMenu: z.boolean().optional(),
});
export type PartyPlanBarItem = z.infer<typeof PartyPlanBarItemSchema>;

export const PartyPlanKitchenSchema = z.object({
  kidsFoodTime: z.string().nullable(),
  adultsFoodTime: z.string().nullable(),
  readyOffsetMinutes: z.number().int().nullable(),
  slipsTime: z.string().nullable(),
  /** SCRUM-906: the bar plan's service time, "HH:MM". */
  barServiceTime: z.string().nullable().optional(),
});

/**
 * SCRUM-906 — the cake as the BEO's cake choice says it (the owner's decision
 * 4): `our` the park's cake ("Our Cake"), `own` the family's ("Own Cake"),
 * its quantity, its time and its notes. Null when the BEO says no cake.
 */
export const PARTY_CAKE_TYPES = ['our', 'own'] as const;
export type PartyCakeType = (typeof PARTY_CAKE_TYPES)[number];
export const PartyPlanCakeSchema = z.object({
  type: z.enum(PARTY_CAKE_TYPES),
  qty: LineCount,
  time: z.string().nullable(),
  note: z.string().nullable(),
});
export type PartyPlanCake = z.infer<typeof PartyPlanCakeSchema>;

/** One party's plan, in the platform's words. Money passes through from the view in satang. */
export const PartyPlanSchema = z.object({
  eventId: z.string(),
  partyDate: IsoDate,
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  package: PartyPlanPackageSchema,
  counts: z.object({ kidsExpected: Count.nullable(), adultsExpected: Count.nullable() }),
  addOns: z.array(PartyPlanAddOnSchema),
  entertainment: z.array(PartyPlanEntertainmentSchema),
  setMenu: z.array(PartyPlanMenuItemSchema),
  barItems: z.array(PartyPlanBarItemSchema),
  kitchen: PartyPlanKitchenSchema.nullable(),
  settlement: z.object({ depositSatang: Satang, posSaleId: z.string().nullable() }),
  /** SCRUM-906: the cake, null when the BEO says none; absent on a plan from before. */
  cake: PartyPlanCakeSchema.nullable().optional(),
});
export type PartyPlan = z.infer<typeof PartyPlanSchema>;

/**
 * SCRUM-906 — A PARTY'S KITCHEN PLAN, with or without a package (the owner's
 * decision 8): what the party page shows and the slips print. For a party
 * with a package it is the plan's own lines; for one without, it is all the
 * OTO App has, and the party cannot be settled until a package is chosen.
 */
export const PartyKitchenPlanSchema = PartyPlanSchema.pick({
  eventId: true,
  partyDate: true,
  startTime: true,
  endTime: true,
  counts: true,
  setMenu: true,
  barItems: true,
  kitchen: true,
  cake: true,
});
export type PartyKitchenPlan = z.infer<typeof PartyKitchenPlanSchema>;

/**
 * Why a party has no plan: none in the OTO App (`no_package`), or the seam view
 * not on this database yet (`seam_missing`) or not readable by this role
 * (`seam_not_granted`). `ready` beside a plan.
 */
export const PARTY_PLAN_STATUSES = ['ready', 'no_package', 'seam_missing', 'seam_not_granted'] as const;
export type PartyPlanStatus = (typeof PARTY_PLAN_STATUSES)[number];

// --- The settlement the POS keeps ------------------------------------------------

/**
 * `open` — the sale is rung up with the deposit on it and the balance still to
 * take; `settled` — paid and closed; `voided` / `refunded` — the sale was
 * undone, and the party may be settled again.
 */
export const PARTY_SETTLEMENT_STATES = ['open', 'settled', 'voided', 'refunded'] as const;
export type PartySettlementState = (typeof PARTY_SETTLEMENT_STATES)[number];

export const PartySettlementViewSchema = z.object({
  id: z.string(),
  saleId: z.string(),
  state: z.enum(PARTY_SETTLEMENT_STATES),
  receiptNumber: z.string().nullable(),
  grossSatang: z.number().int(),
  /** Taken on the sale so far, the deposit included. */
  paidSatang: z.number().int(),
  outstandingSatang: z.number().int(),
  depositSatang: z.number().int(),
  kids: z.number().int(),
  adults: z.number().int(),
  createdAt: z.string(),
  settledAt: z.string().nullable(),
  /** Whether the OTO App holds the sale's id yet; null until the sale is settled. */
  writeBack: z.enum(['synced', 'pending', 'failed']).nullable(),
});
export type PartySettlementView = z.infer<typeof PartySettlementViewSchema>;

/** A settlement that holds the party's package: its sale is open or settled. */
export const partySettlementLive = (s: Pick<PartySettlementView, 'state'> | null | undefined): boolean =>
  !!s && (s.state === 'open' || s.state === 'settled');

// --- The till's request ------------------------------------------------------------

/**
 * `POST /parties/:id/settle/preview` — what a settlement would come to, priced
 * by the engine and written nowhere. `kids` and `adults` are everyone who came;
 * the extras are worked out from the package's included counts.
 */
export const PartySettlePreviewBodySchema = z.object({
  branchId: z.string().uuid(),
  stationId: z.string().uuid().optional(),
  kids: z.number().int().min(1).max(500),
  adults: z.number().int().min(0).max(500),
  socksGiven: z.number().int().min(0).max(1_000),
  /** What the till showed as extras. Compared with the platform's count, never used. */
  extraChildren: z.number().int().min(0).max(500).optional(),
  extraAdults: z.number().int().min(0).max(500).optional(),
  /** The plan's add-ons and entertainment staff kept, by the plan's ids. */
  addOnIds: z.array(z.string().min(1).max(200)).max(100),
  entertainmentIds: z.array(z.string().min(1).max(200)).max(100),
  /** For the record only: the package's prices are the same at every tier. */
  tier: z.string().trim().min(1).max(40).optional(),
});
export type PartySettlePreviewBody = z.infer<typeof PartySettlePreviewBodySchema>;

/** `POST /parties/:id/settle` — the settlement, under ids the till minted. */
export const PartySettleBodySchema = PartySettlePreviewBodySchema.extend({
  stationId: z.string().uuid(),
  /** The settlement's id: the same id again answers what it made. */
  settlementId: z.string().uuid(),
  /** The sale's id. */
  saleId: z.string().uuid(),
  /** The total the till showed from the preview. Compared, never charged. */
  expectedTotalSatang: z.number().int().min(0).optional(),
  actionId: z.string().min(1).max(200).optional(),
});
export type PartySettleBody = z.infer<typeof PartySettleBodySchema>;

// --- The answer ----------------------------------------------------------------------

export const PartySettleLineSchema = z.object({
  role: z.enum(PARTY_LINE_ROLES),
  label: z.string(),
  quantity: z.number().int(),
  unitSatang: z.number().int(),
  totalSatang: z.number().int(),
});
export type PartySettleLine = z.infer<typeof PartySettleLineSchema>;

/** The settlement's figures, every one of them the engine's. */
export const PartySettleQuoteSchema = z.object({
  partyDate: IsoDate,
  rateMode: z.enum(['weekday', 'weekend']),
  packageName: z.string(),
  lines: z.array(PartySettleLineSchema),
  packageSatang: z.number().int(),
  extraChildren: z.number().int(),
  extraChildrenSatang: z.number().int(),
  extraAdults: z.number().int(),
  extraAdultsSatang: z.number().int(),
  freeSocks: z.number().int(),
  paidSocks: z.number().int(),
  socksSatang: z.number().int(),
  addOnsSatang: z.number().int(),
  entertainmentSatang: z.number().int(),
  /** The sale's gross: what the party comes to. */
  totalSatang: z.number().int(),
  /** The F&B credit the add-ons grant when the sale is paid. */
  creditSatang: z.number().int(),
  /** The deposit recorded as paid in advance (never more than the total). */
  depositSatang: z.number().int(),
  /** What is left to take at the till. */
  balanceSatang: z.number().int(),
  /**
   * Walk-up guests the check-in board already put on the party's tab, at the
   * board's walk-up price, and what they came to there. Not on this sale: a
   * party with any is not settled as one sale (`PARTY_WALK_UPS_ON_TAB`) until
   * the owner rules how the two meet, so its balance is taken on the tab.
   */
  walkUps: z.number().int(),
  walkUpsSatang: z.number().int(),
});
export type PartySettleQuote = z.infer<typeof PartySettleQuoteSchema>;

export const PartySettleAnswerSchema = z.object({
  /** The same settlement id was sent before: this is what it made. */
  replayed: z.boolean(),
  quote: PartySettleQuoteSchema,
  settlement: PartySettlementViewSchema,
  sale: z.object({
    id: z.string(),
    status: z.string(),
    receiptNumber: z.string().nullable(),
    grossSatang: z.number().int(),
    outstandingSatang: z.number().int(),
  }),
  /** What closing it did not put on paper, when the deposit covered the whole of it. */
  printingNotes: z.array(z.string()),
});
export type PartySettleAnswer = z.infer<typeof PartySettleAnswerSchema>;

export const PartySettlePreviewAnswerSchema = z.object({ quote: PartySettleQuoteSchema });
export type PartySettlePreviewAnswer = z.infer<typeof PartySettlePreviewAnswerSchema>;

// --- The refusals, by name -------------------------------------------------------------

export const PARTY_SETTLE_REFUSALS = {
  NO_PLAN: { code: 'PARTY_NO_PACKAGE', message: 'This party has no package in the OTO App, so it cannot be settled here' },
  ALREADY: { code: 'PARTY_ALREADY_SETTLED', message: 'This party is already settled — void or refund that sale first' },
  EXTRA_CHILD: {
    code: 'PARTY_EXTRA_CHILD_NOT_PRICED',
    message: 'The package names no price for a child beyond its included count — set it in the OTO App',
  },
  EXTRA_ADULT: {
    code: 'PARTY_EXTRA_ADULT_NOT_PRICED',
    message: 'The package names no price for an adult beyond its included count — set it in the OTO App',
  },
  COUNTS: { code: 'PARTY_COUNTS_DIFFER', message: 'The till and the platform counted the extra guests differently — nothing was saved' },
  UNKNOWN_LINE: { code: 'PARTY_PLAN_LINE_UNKNOWN', message: 'An add-on or entertainment line is no longer in the party plan — reload it' },
  ENTERTAINMENT: {
    code: 'PARTY_ENTERTAINMENT_NOT_PRICED',
    message: 'An entertainment line has extra children but no price for them — set it in the OTO App',
  },
  PAID_ON_TAB: {
    code: 'PARTY_PAID_ON_TAB',
    message:
      "Money for this party's package was already taken on its tab, so settling it would charge it twice — nothing was saved",
  },
  WALK_UPS: {
    code: 'PARTY_WALK_UPS_ON_TAB',
    message:
      "Walk-up guests are already on this party's tab, so it cannot be settled as one sale — take the balance on the tab. Nothing was saved",
  },
} as const;

// --- The composer ------------------------------------------------------------------------

/** A package price pair at a rate mode; null stays null. */
function rateOf(weekday: number | null, weekend: number | null, mode: RateMode): number | null {
  return mode === 'weekend' ? weekend : weekday;
}

/** The pairs of socks the package gives free, as the till prefills "socks given". */
export function partySocksIncludedFor(pkg: Pick<PartyPlanPackage, 'socksIncluded'>, kids: number): number {
  return pkg.socksIncluded === -1 ? Math.max(0, kids) : Math.max(0, pkg.socksIncluded);
}

export interface PartyComposition {
  rateMode: RateMode;
  packageSatang: number;
  includedLabels: string[];
  /** Children within the package (฿0 each) and beyond it. */
  packageKids: number;
  extraChildren: number;
  extraChildUnitSatang: number;
  /** Adults within the package (฿0 each) and beyond it. */
  packageAdults: number;
  extraAdults: number;
  extraAdultUnitSatang: number;
  freeSocks: number;
  paidSocks: number;
  addOns: PartyPlanAddOn[];
  entertainment: PartyPlanEntertainment[];
}

export type PartyCompositionResult =
  | { ok: true; composition: PartyComposition }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

/**
 * What a settlement is made of, counted: who is inside the package and who is
 * an extra, at which of the package's own prices, how many socks are free, and
 * which of the plan's add-ons and entertainment were kept. Never a total: the
 * engine prices the lines this describes.
 */
export function composePartySettlement(
  plan: Pick<PartyPlan, 'package' | 'addOns' | 'entertainment'>,
  input: {
    kids: number;
    adults: number;
    socksGiven: number;
    addOnIds: readonly string[];
    entertainmentIds: readonly string[];
    extraChildren?: number | undefined;
    extraAdults?: number | undefined;
  },
  rateMode: RateMode,
): PartyCompositionResult {
  const pkg = plan.package;
  const kids = Math.max(0, input.kids);
  const adults = Math.max(0, input.adults);
  const packageKids = Math.min(kids, pkg.kidsIncluded);
  const extraChildren = kids - packageKids;
  const packageAdults = Math.min(adults, pkg.adultsIncluded);
  const extraAdults = adults - packageAdults;
  if (
    (input.extraChildren !== undefined && input.extraChildren !== extraChildren) ||
    (input.extraAdults !== undefined && input.extraAdults !== extraAdults)
  ) {
    return {
      ok: false,
      ...PARTY_SETTLE_REFUSALS.COUNTS,
      details: { extraChildren, extraAdults, sentExtraChildren: input.extraChildren, sentExtraAdults: input.extraAdults },
    };
  }
  const extraChildUnit = rateOf(pkg.extraChildWeekdaySatang, pkg.extraChildWeekendSatang, rateMode);
  if (extraChildren > 0 && extraChildUnit === null) {
    return { ok: false, ...PARTY_SETTLE_REFUSALS.EXTRA_CHILD, details: { extraChildren } };
  }
  const extraAdultUnit = rateOf(pkg.extraAdultWeekdaySatang, pkg.extraAdultWeekendSatang, rateMode);
  if (extraAdults > 0 && extraAdultUnit === null) {
    return { ok: false, ...PARTY_SETTLE_REFUSALS.EXTRA_ADULT, details: { extraAdults } };
  }
  const unknownAddOns = input.addOnIds.filter((id) => !plan.addOns.some((a) => a.id === id));
  const unknownShows = input.entertainmentIds.filter((id) => !plan.entertainment.some((e) => e.id === id));
  if (unknownAddOns.length > 0 || unknownShows.length > 0) {
    return { ok: false, ...PARTY_SETTLE_REFUSALS.UNKNOWN_LINE, details: { addOnIds: unknownAddOns, entertainmentIds: unknownShows } };
  }
  const entertainment = plan.entertainment.filter((e) => input.entertainmentIds.includes(e.id));
  const unpriced = entertainment.filter((e) => e.extraChildren > 0 && e.extraChildPriceSatang === null);
  if (unpriced.length > 0) {
    return { ok: false, ...PARTY_SETTLE_REFUSALS.ENTERTAINMENT, details: { entertainmentIds: unpriced.map((e) => e.id) } };
  }
  const socksGiven = Math.max(0, input.socksGiven);
  const freeSocks = Math.min(socksGiven, partySocksIncludedFor(pkg, kids));
  return {
    ok: true,
    composition: {
      rateMode,
      packageSatang: rateMode === 'weekend' ? pkg.priceWeekendSatang : pkg.priceWeekdaySatang,
      includedLabels: pkg.includedLines.map((l) => l.label.trim()).filter((l) => l.length > 0),
      packageKids,
      extraChildren,
      extraChildUnitSatang: extraChildUnit ?? 0,
      packageAdults,
      extraAdults,
      extraAdultUnitSatang: extraAdultUnit ?? 0,
      freeSocks,
      paidSocks: socksGiven - freeSocks,
      addOns: plan.addOns.filter((a) => input.addOnIds.includes(a.id)),
      entertainment,
    },
  };
}

/**
 * Whether a payment attempt is a party's deposit, recorded on its settlement
 * sale as paid in advance. Not money the sale's till took: a void of the sale
 * (left unpaid, or parked and dropped) cancels the record with it, and the
 * deposit stays the OTO App's, held for the next settlement.
 */
export function isPartyDepositAttempt(attempt: { methodCode?: string | null; payload?: unknown }): boolean {
  if (attempt.methodCode !== PARTY_DEPOSIT_TENDER.code) return false;
  const payload = attempt.payload;
  return !!payload && typeof payload === 'object' && (payload as { partyDeposit?: unknown }).partyDeposit === true;
}
