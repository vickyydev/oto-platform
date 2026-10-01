import { z } from 'zod';
import { addDaysToIsoDate, wallClockMinutesInTz } from './business-date';
import { isoDateInTz } from './dates';

/**
 * STORED VALUE — S2-14a (plan docs/progress/plans/wallet/PLAN.md §2.1-2.2).
 *
 * The words a wallet, its keys and its ledger may use, and THE GRANT LAW: who
 * on a ticket sale earns F&B/merch credit, and how much. The law is the
 * prototype's, ported rule for rule from `lib/sale.ts:140-224`
 * (`unitCredit`, `creditApplies`, `buildPersonGrants`, `buildCreditGrants`):
 *
 *   - one PERSON at a time, per regular play line: the line's adults first —
 *     the paid ones, then the free ones — then its kids;
 *   - promo lines and drop-off lines are skipped (a drop-off child's food is
 *     their own prepaid wallet, loaded at check-in);
 *   - each person's credit is read from THAT line's package `creditRule`:
 *     `appliesTo` (none | adults | kids | both) chooses who earns, `basis`
 *     how much — `full_price` the price that person's ticket lists,
 *     `fixed` the rule's value, `percent` the value's percent of the list
 *     price — never negative;
 *   - so a free adult earns nothing under `full_price` and the rule's value
 *     under `fixed`;
 *   - one wallet per person who earns more than nothing.
 *
 * Money is satang here, where the prototype counted whole baht; a percent of
 * a price in satang is rounded to the satang.
 *
 * THE LIST PRICE (OD-W2): credit is computed from the unit the ticket lists
 * at the sale's tier and rate mode, before any promo or manual discount — the
 * prototype's unstated behaviour (`buildCreditGrants` is handed the cart
 * lines, never the discounts' effect on them), made explicit.
 */

export const WALLET_KEY_KINDS = ['band', 'voucher_qr', 'child', 'phone'] as const;
export type WalletKeyKind = (typeof WALLET_KEY_KINDS)[number];

export const WALLET_ENTRY_KINDS = ['grant', 'spend', 'refund', 'expire', 'reactivate'] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

export const WALLET_ENTRY_SOURCES = [
  'ticket_sale',
  'prepaid_food',
  'fnb_order',
  'merch_order',
  'refund',
  'expiry',
  'reactivation',
] as const;
export type WalletEntrySource = (typeof WALLET_ENTRY_SOURCES)[number];

export const WALLET_STATUSES = ['active', 'expired'] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

export const WALLET_EXPIRY_POLICIES = ['same_day', 'days_n', 'never'] as const;
export type WalletExpiryPolicy = (typeof WALLET_EXPIRY_POLICIES)[number];

export const WALLET_PREPAID_UNUSED_POLICIES = ['refund', 'forfeit'] as const;
export type WalletPrepaidUnusedPolicy = (typeof WALLET_PREPAID_UNUSED_POLICIES)[number];

/** ฿300 per wallet per day on a box with no internet (OD-14), the seeded `wallet_policy` cap. */
export const DEFAULT_WALLET_OFFLINE_CAP_SATANG = 30_000;

/** The seeded policy for a new branch: same-day expiry, the ฿300 cap, unused prepaid refunded. */
export const DEFAULT_WALLET_POLICY = {
  expiry: 'same_day' as WalletExpiryPolicy,
  expiryDays: null as number | null,
  offlineCapSatang: DEFAULT_WALLET_OFFLINE_CAP_SATANG,
  prepaidUnused: 'refund' as WalletPrepaidUnusedPolicy,
};

// --- The grant law -------------------------------------------------------------

/** A ticket package's give-back rule (`TicketCreditRule` in the prototype's types.ts). */
export interface WalletCreditRule {
  appliesTo: 'none' | 'adults' | 'kids' | 'both';
  basis: 'full_price' | 'fixed' | 'percent';
  /** Whole baht for `fixed` (as the package editor stores it); a percent (0-100) for `percent`. */
  value?: number;
}

/**
 * Read a stored `credit_rule` jsonb into a rule, or null when it is absent or
 * not one. A package written before S2-14a with no rule earns nothing.
 */
export function walletCreditRuleOf(raw: unknown): WalletCreditRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const appliesTo = r.appliesTo;
  const basis = r.basis;
  if (appliesTo !== 'none' && appliesTo !== 'adults' && appliesTo !== 'kids' && appliesTo !== 'both') return null;
  if (basis !== 'full_price' && basis !== 'fixed' && basis !== 'percent') return null;
  const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : undefined;
  return { appliesTo, basis, ...(value === undefined ? {} : { value }) };
}

/**
 * The credit ONE person earns given the list price of their ticket, in
 * satang (prototype `unitCredit`). Never negative.
 *
 * A `fixed` rule's value is WHOLE BAHT, as stored: the package editor writes
 * the figure staff typed (`TicketTypeForm.tsx` → `ticketTypeToApiBody`, which
 * converts the prices to satang and passes the credit rule through untouched)
 * and the row chip reads it back as `฿<value>` (`creditRuleSummary`). So it is
 * the one figure in a package that is not satang, and is converted here.
 */
export function unitCreditSatang(listSatang: number, rule: WalletCreditRule): number {
  switch (rule.basis) {
    case 'full_price':
      return Math.max(0, listSatang);
    case 'fixed':
      return Math.max(0, Math.round((rule.value ?? 0) * 100));
    case 'percent':
      return Math.max(0, Math.round(listSatang * ((rule.value ?? 0) / 100)));
    default:
      return 0;
  }
}

/** Whether a rule pays out to a person of this role (prototype `creditApplies`). */
export function creditApplies(rule: WalletCreditRule | null | undefined, role: 'adult' | 'kid'): boolean {
  if (!rule || rule.appliesTo === 'none') return false;
  if (rule.appliesTo === 'both') return true;
  return role === 'adult' ? rule.appliesTo === 'adults' : rule.appliesTo === 'kids';
}

/** One cart line of a sale, as the grant law reads it. */
export interface GrantLine {
  cartLineId: string;
  /** A free-item promo line or a drop-off / nanny line: skipped entirely. */
  skip: boolean;
  /** Kids on the line, and the list price of one kid's ticket. */
  kids: number;
  kidListSatang: number;
  /** Paid adults and the list price of one; free adults (priced at nothing). */
  paidAdults: number;
  adultListSatang: number;
  freeAdults: number;
  creditRule: WalletCreditRule | null;
  gateAccess: boolean;
}

/** One person on a sale's regular play lines (prototype `PersonGrant`, plus where they sit). */
export interface PersonGrant {
  cartLineId: string;
  role: 'adult' | 'kid';
  /** Their place among the line's adults (paid first) or among its kids. */
  ordinal: number;
  /** The list price the credit was read from: the ticket's unit, 0 for a free adult. */
  listSatang: number;
  /** 0 when this person earns no credit. */
  creditSatang: number;
  /** Adults on a gate-access ticket; kids never. */
  gateAccess: boolean;
}

/**
 * Every person on the sale's regular play lines, in the prototype's order —
 * per line, adults (paid then free) then kids (`buildPersonGrants`).
 */
export function personGrantsOf(lines: readonly GrantLine[]): PersonGrant[] {
  const out: PersonGrant[] = [];
  for (const line of lines) {
    if (line.skip) continue;
    const rule = line.creditRule;
    const adultPrices = [
      ...Array<number>(Math.max(0, line.paidAdults)).fill(line.adultListSatang),
      ...Array<number>(Math.max(0, line.freeAdults)).fill(0),
    ];
    adultPrices.forEach((listSatang, ordinal) => {
      out.push({
        cartLineId: line.cartLineId,
        role: 'adult',
        ordinal,
        listSatang,
        gateAccess: line.gateAccess,
        creditSatang: creditApplies(rule, 'adult') ? unitCreditSatang(listSatang, rule!) : 0,
      });
    });
    for (let ordinal = 0; ordinal < line.kids; ordinal += 1) {
      out.push({
        cartLineId: line.cartLineId,
        role: 'kid',
        ordinal,
        listSatang: line.kidListSatang,
        gateAccess: false,
        creditSatang: creditApplies(rule, 'kid') ? unitCreditSatang(line.kidListSatang, rule!) : 0,
      });
    }
  }
  return out;
}

/** The persons who earn credit — one wallet each (prototype `buildCreditGrants`, the fnb_credit half). */
export function earningPersonsOf(lines: readonly GrantLine[]): PersonGrant[] {
  return personGrantsOf(lines).filter((p) => p.creditSatang > 0);
}

/** One sale-ledger row, as `grantLinesOfLedger` reads it. */
export interface GrantLedgerRow {
  cartLineId: string;
  kind: string;
  ticketPackageId: string | null;
  quantity: number;
  unitSatang: number;
  lineNo: number;
}

/**
 * The cart lines of a FINALISED sale's ledger, for the grant law.
 *
 * A cart line's units share its id (`sale_line.cart_line_id`): `kids`,
 * `adults_paid`, `adults_free` carry the counts and the list unit; a line is
 * skipped when one of its units is a free-item promo (`promo_item`) or a
 * drop-off fee or prepaid food (`service_fee`, `food_provision`), or when the
 * caller knows it is a supervised child's line (`supervisedCartLineIds`).
 * Lines come back in receipt order.
 */
export function grantLinesOfLedger(
  rows: readonly GrantLedgerRow[],
  packages: ReadonlyMap<string, { creditRule: unknown; gateAccess: boolean }>,
  supervisedCartLineIds: ReadonlySet<string> = new Set(),
): GrantLine[] {
  const order: string[] = [];
  const byCart = new Map<string, GrantLedgerRow[]>();
  for (const row of [...rows].sort((a, b) => a.lineNo - b.lineNo)) {
    const group = byCart.get(row.cartLineId);
    if (group) group.push(row);
    else {
      byCart.set(row.cartLineId, [row]);
      order.push(row.cartLineId);
    }
  }
  const out: GrantLine[] = [];
  for (const cartLineId of order) {
    const group = byCart.get(cartLineId)!;
    const packageId = group.find((r) => r.ticketPackageId)?.ticketPackageId ?? null;
    if (!packageId) continue;
    const pkg = packages.get(packageId);
    const kidsRow = group.find((r) => r.kind === 'kids');
    const paidRow = group.find((r) => r.kind === 'adults_paid');
    const freeRow = group.find((r) => r.kind === 'adults_free');
    out.push({
      cartLineId,
      skip:
        supervisedCartLineIds.has(cartLineId) ||
        group.some((r) => r.kind === 'promo_item' || r.kind === 'service_fee' || r.kind === 'food_provision'),
      kids: kidsRow?.quantity ?? 0,
      kidListSatang: kidsRow?.unitSatang ?? 0,
      paidAdults: paidRow?.quantity ?? 0,
      adultListSatang: paidRow?.unitSatang ?? 0,
      freeAdults: freeRow?.quantity ?? 0,
      creditRule: walletCreditRuleOf(pkg?.creditRule),
      gateAccess: pkg?.gateAccess ?? false,
    });
  }
  return out;
}

// --- Keys -------------------------------------------------------------------------

const QR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A fresh voucher QR value: `QR-` and twenty Crockford base-32 characters
 * (100 bits) from the platform's CSPRNG. The voucher is a bearer instrument —
 * whoever holds it can spend the credit — so it is not derived from an id
 * anybody else can read. ONE value per wallet, used everywhere: the printed
 * voucher, the till's confirmation and the customer display's thank-you
 * (the prototype seeded the display from the grant id and printed
 * `QR-<band id>`, two codes for one wallet — plan §6).
 */
export function mintVoucherQr(): string {
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  let out = 'QR-';
  for (const b of bytes) out += QR_ALPHABET[b & 31];
  return out;
}

/** A scanned key as the lookup stores it: trimmed, and a voucher QR upper-cased. */
export function normaliseWalletKeyValue(kind: WalletKeyKind, value: string): string {
  const trimmed = value.trim();
  if (kind === 'voucher_qr' || kind === 'band') return trimmed.toUpperCase();
  return trimmed;
}

// --- Expiry -----------------------------------------------------------------------

/**
 * The instant a business day ENDS at a branch: the next day's start on the
 * branch's wall clock (`branch.business_day_start`, 05:00 by default). A
 * `same_day` grant stops being spendable then. Pure; Asia/Bangkok has no DST,
 * and a zone that has it is resolved by correcting the guess once against the
 * wall clock the instant actually shows.
 */
export function businessDayEndsAt(businessDate: string, timeZone: string, dayStartMinutes: number): Date {
  const next = addDaysToIsoDate(businessDate, 1);
  const [y, m, d] = next.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d, Math.floor(dayStartMinutes / 60), dayStartMinutes % 60);
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const at = new Date(guess);
    const shownDate = isoDateInTz(at, timeZone);
    const [sy, sm, sd] = shownDate.split('-').map(Number) as [number, number, number];
    const shown = Date.UTC(sy, sm - 1, sd) + wallClockMinutesInTz(at, timeZone) * 60_000;
    guess += wanted - shown;
  }
  return new Date(guess);
}

/** When a grant made on `businessDate` expires under a policy, or null for `never`. */
export function grantExpiresAt(
  policy: { expiry: WalletExpiryPolicy; expiryDays: number | null },
  businessDate: string,
  timeZone: string,
  dayStartMinutes: number,
): Date | null {
  if (policy.expiry === 'never') return null;
  const days = policy.expiry === 'days_n' ? Math.max(1, policy.expiryDays ?? 1) : 1;
  return businessDayEndsAt(addDaysToIsoDate(businessDate, days - 1), timeZone, dayStartMinutes);
}

// --- What the API answers ---------------------------------------------------------

/** One wallet a sale granted, as the finalise answer and the sale detail carry it. */
export const WalletGrantViewSchema = z.object({
  walletId: z.string().uuid(),
  role: z.enum(['adult', 'kid']),
  /** The person's place among the sale's earning persons — the till's grant row order. */
  personIndex: z.number().int().min(0),
  creditSatang: z.number().int().positive(),
  /** The ONE QR for this wallet: printed on the voucher, shown on the till and the display. */
  qrCode: z.string(),
  holderName: z.string().nullable(),
  gateAccess: z.boolean(),
  /** The band this wallet is carried on, by its short code, once it is minted. */
  bandShortCode: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type WalletGrantView = z.infer<typeof WalletGrantViewSchema>;

export const WalletEntryViewSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(WALLET_ENTRY_KINDS),
  source: z.enum(WALLET_ENTRY_SOURCES),
  amountSatang: z.number().int(),
  balanceAfterSatang: z.number().int(),
  saleId: z.string().uuid().nullable(),
  refundId: z.string().uuid().nullable(),
  branchId: z.string().uuid().nullable(),
  stationId: z.string().uuid().nullable(),
  offline: z.boolean(),
  businessDate: z.string().nullable(),
  /** Who wrote it, as a display name; null for an entry no person wrote. */
  actorName: z.string().nullable(),
  expiresAt: z.string().nullable(),
  at: z.string(),
});
export type WalletEntryView = z.infer<typeof WalletEntryViewSchema>;

export const WalletViewSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid().nullable(),
  memberId: z.string().uuid().nullable(),
  holderName: z.string().nullable(),
  status: z.enum(WALLET_STATUSES),
  balanceSatang: z.number().int().min(0),
  /** The keys that find it — never a band's signed code, which is a gate credential. */
  keys: z.array(
    z.object({
      kind: z.enum(WALLET_KEY_KINDS),
      /** The voucher QR and the child id as they are; a band by its short code; a phone masked. */
      display: z.string(),
    }),
  ),
  createdAt: z.string(),
});
export type WalletView = z.infer<typeof WalletViewSchema>;

export const WalletLookupQuerySchema = z.object({
  /** What was scanned or typed: a band code (full or short), a voucher QR. */
  key: z.string().trim().min(1).max(200),
});
