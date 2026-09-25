import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { branch, discountDefinition, product, sale, saleDiscount, type Db } from '@oto/db';
import type { CartPromo, DiscountTarget } from '@oto/shared';
import { z } from 'zod';
import { raiseAlert } from './ops';
import type { PromoDiscountInput } from './sale';
import type { Exec, OpContext } from './tx';

/**
 * SCRUM-401 — A PROMO CODE IS WORTH WHAT THE PARK SET IT UP TO BE WORTH.
 *
 * WHAT WAS WRONG. The till sent every code with its own description of it — a
 * type, a value, a scope — and `priceCart` handed that description to the
 * engine as it came. A reception session sending
 * `{ code: 'NOSUCHCODE', type: 'fixed', value: 89000 }` got a free ticket;
 * STAFF10 sent as 100 % was filed under the park's own code; an archived, a
 * switched-off, an expired or another park's code was priced at whatever the
 * till said; a code withdrawn during the day stayed honoured on every till
 * that had not reloaded; and a usage limit was counted in browser memory and
 * enforced nowhere. The definitions have existed since SCRUM-230
 * (`pos.discount_definition`, edited on the Discounts and promo codes panel);
 * nothing on the money path read them.
 *
 * THE RULE NOW. The till names a code. What it is worth is read here, from the
 * operator's live definition of that code, and from nothing the till sent:
 *
 *   - no live definition, or one switched off: refused by name, in the till's
 *     own words for a code it does not hold, "was not found"
 *     (`unknownPromoCode`, SCRUM-441), and nothing comes off;
 *   - a definition for one branch, rung up at another: refused as not set up at
 *     this branch, naming the branch it is for (`notAtThisBranch`);
 *   - outside `valid_from` .. `valid_until` (inclusive) on the SALE'S TRADING
 *     DAY at its branch (`resolvePricingScope`, the date that already chose the
 *     price — never the UTC day): refused, naming the date;
 *   - `usage_limit` reached, counted over the finalised sales that carried the
 *     code: refused as used up. `per_customer_limit` the same, over the sales of
 *     the member the cart names;
 *   - a free-item code with its product nowhere on the cart: refused, naming it;
 *   - a code that is not stackable beside any other, or any code beside one that
 *     is not: the later one refused, naming the one already on the sale. A
 *     voucher is refused beside any code at all before this runs
 *     (`resolveCartVoucher`, VOUCHER_NOT_COMBINABLE) — the voucher's own rule;
 *   - otherwise priced from the definition: a percentage from `value_bp`, an
 *     amount from `value_satang` that the engine caps at what the cart has left
 *     (no change is given), a free item as one unit of its product taken to
 *     nothing. The definition's `target` scopes it exactly as the till's own
 *     engine scopes it (`rowMatchesTarget`); a target the engine cannot read is
 *     refused rather than guessed at.
 *
 * A refusal is a row in `rejectedPromoCodes`, the shape an unknown code has
 * always been refused in: the quote carries it to the till, and the commit
 * writes the sale without that code, so a till still holding the discounted
 * figure is stopped by `SALE_TOTAL_MISMATCH` rather than charged either number.
 *
 * THE QUOTE AND THE COMMIT ASK THE SAME QUESTIONS OF THE SAME ROWS, through this
 * one function, so they price a code identically to the satang. It only reads —
 * `POST /sales/quote` is on the write-nothing list.
 *
 * THE ONE EXCEPTION IS AN OFFLINE SALE, REPLAYED (`as_recorded`). The box took
 * the money with the link down, against the till's copy of the codes; refusing
 * the code now would not give anybody their money back. So the code stands as
 * the till applied it: its value, the scope it applied it to (where the engine
 * can read that scope), and a free item aimed at the line that holds the item
 * the till gave. What the definition would give today is worked out beside it.
 * Every code whose recorded value or scope differs, whose free item is another
 * product, or that the park has no such code for comes back as a
 * `PromoDifference`. The replay writes those on its audit row and the sync push
 * raises them as alerts (`raiseOfflinePromoAlerts`). The sale carries the code
 * like any other, under the park's own spelling of it however the till typed
 * it, so its use counts against the limit.
 */

type DefinitionRow = typeof discountDefinition.$inferSelect;

/** How a cart's codes are priced — see `as_recorded` above. */
export type PromoPricing = 'definition' | 'as_recorded';

/** Where and for whom the codes are being priced. Resolved by the caller, never read off the body. */
export interface PromoScope {
  operatorId: string;
  branchId: string;
  /** The sale's trading day at its branch — what a code's window is judged on. */
  businessDate: string;
  /**
   * The member the cart names. Null for a walk-in, and a walk-in is NOT held to
   * a per-customer limit: there is nobody to count the earlier uses against.
   */
  memberId: string | null;
}

/**
 * A line on this cart that holds one product, for a free-item code to find:
 * the ticket till's own free-item line (its `promoItem`), or an F&B or shop
 * line of that product. `unitSatang` is one of it, as this cart priced it.
 */
export interface FreeItemLine {
  lineId: string;
  productId: string;
  unitSatang: number;
}

/** A code's value in the engine's units: a percentage, or satang. */
export interface PromoValue {
  type: 'percent' | 'fixed' | 'free_item';
  value: number;
  /**
   * The rows it comes off, when that is not the whole order: the definition's
   * `target`, or the scope an offline sale's till applied the code to. A scope
   * the engine cannot read is kept as it was sent. Never set on a free item,
   * whose scope is its own line.
   */
  target?: unknown;
}

/**
 * An offline sale's code, as the till applied it, beside what the park's
 * definition gives the same sale today. `definition` is null when it gives
 * nothing, and `reason` then says why: `unknown code`, the refusal an online
 * sale would have had, or that the free item the till gave is another product.
 */
export interface PromoDifference {
  /** The code as the sale was filed with it: the park's own spelling when it has the code. */
  code: string;
  label: string;
  recorded: PromoValue;
  definition: PromoValue | null;
  reason: string | null;
}

export interface ResolvedCartPromos {
  /** What the engine prices. */
  promos: CartPromo[];
  /** Refused by name; nothing came off for them. Empty when replaying as recorded. */
  rejected: { code: string; reason: string }[];
  /** `as_recorded` only. */
  differences: PromoDifference[];
}

/**
 * The words for a code with no live, switched-on definition behind it —
 * unknown, archived and switched off alike, so a quote cannot be used to learn
 * which of the three a guessed code is.
 *
 * SCRUM-441 — THE TILL'S OWN WORDS, "Code X was not found.", which its copy of
 * the codes says first for a code it does not hold (`handleApplyPromoCode` in
 * apps/pos/src/pages/Till.tsx). The platform said "isn't set up at this branch
 * yet" here, which told a guest the code worked somewhere else when it worked
 * nowhere; that sentence is kept for the one code it is true of, a live code
 * set up for another branch (`notAtThisBranch`).
 */
export function unknownPromoCode(code: string): string {
  return `Code "${code}" was not found.`;
}

/**
 * SCRUM-441 — the words for a live code set up for another branch than the
 * sale's: that it is not set up here, and where it is. `branchName` is null
 * when the branch has no row to name it by.
 */
function notAtThisBranch(code: string, branchName: string | null): string {
  return `Code "${code}" isn't set up at this branch yet — it is only valid at ${branchName ?? 'another branch'}.`;
}

/**
 * Every scope the pricing engine understands (`DiscountTarget` in
 * `@oto/shared`), checked before it is handed over. The till passes a code's
 * stored target to the same engine unchecked; a `menuItems` scope with no ids
 * would throw there, and here it is a refusal instead. The Discounts panel's
 * own `categories` scope (`DiscountTargetSchema`) is not one of them: neither
 * the engine nor the till can apply it, so a code saved with it is refused by
 * name rather than applied to a guess.
 */
const EngineTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('everything') }),
  z.object({ kind: z.literal('tickets') }),
  z.object({ kind: z.literal('ticketGroup'), group: z.enum(['kids', 'adults']) }),
  z.object({ kind: z.literal('ticketType'), ticketTypeId: z.string().min(1) }),
  z.object({ kind: z.literal('addOns') }),
  z.object({ kind: z.literal('addOn'), addOnId: z.string().min(1) }),
  z.object({ kind: z.literal('fnb') }),
  z.object({ kind: z.literal('fnbCategory'), category: z.string().min(1) }),
  z.object({ kind: z.literal('menuItems'), menuItemIds: z.array(z.string()) }),
  z.object({ kind: z.literal('merch') }),
  z.object({ kind: z.literal('event_pass') }),
]);

/**
 * A stored or recorded scope as the engine takes it: `undefined` for the whole
 * order (no scope, or `everything`), `null` for one the engine cannot read.
 * Both sides of an offline comparison are read through this, so they compare
 * alike.
 */
function engineTarget(raw: unknown): DiscountTarget | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  const parsed = EngineTargetSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.kind === 'everything' ? undefined : parsed.data;
}

/** The kind a scope names, for a sentence: `"tickets"`, or a stand-in when it has none. */
function scopeKind(raw: unknown): string {
  const kind =
    raw !== null && typeof raw === 'object' ? (raw as { kind?: unknown }).kind : undefined;
  return typeof kind === 'string' ? kind : 'an unreadable scope';
}

/**
 * Whether the scope an offline sale's till applied a code to is the one the
 * definition gives. A scope the engine cannot read (`null`) is never the same.
 * Both went through `EngineTargetSchema`, so their keys come out in one order;
 * only a list of menu items can be in another order and name the same items.
 */
function sameScope(
  recorded: DiscountTarget | undefined | null,
  now: DiscountTarget | undefined,
): boolean {
  if (recorded === null) return false;
  if (recorded === undefined || now === undefined) return recorded === now;
  const key = (target: DiscountTarget): string =>
    JSON.stringify(
      target.kind === 'menuItems'
        ? { ...target, menuItemIds: [...target.menuItemIds].sort() }
        : target,
    );
  return key(recorded) === key(now);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Oct 2026" from a yyyy-mm-dd — the engine's own format for these refusals (`promo.ts`). */
function formatIsoDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  const name = MONTHS[Number(month) - 1];
  return name && day && year ? `${Number(day)} ${name} ${year}` : iso;
}

/** Whole baht without decimals, satang when there are any: 15000 → "150". */
function baht(satang: number): string {
  return satang % 100 === 0 ? String(satang / 100) : (satang / 100).toFixed(2);
}

/** A code as typed matches a definition however it was cased: definitions are upper case. */
function codeKey(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * How many FINALISED sales carried this definition's code — counted from the
 * sale rows themselves (`pos.sale_discount`, the row a code leaves on every
 * sale it went on), never from a counter somebody has to keep in step.
 *
 *   - Finalised only. A sale still being paid for has not used the code yet,
 *     and a voided one never will.
 *   - Since this definition was created (both clocks the database's). Archiving
 *     a campaign frees its code for a later one (`discount_definition_code_unique`
 *     is partial), and the new campaign starts with none of the old one's uses.
 *   - With a member, only that member's sales: the per-customer count.
 */
async function finalisedUses(
  db: Exec,
  definition: DefinitionRow,
  memberId: string | null,
): Promise<number> {
  const [row] = await db
    .select({ uses: sql<number>`count(distinct ${saleDiscount.saleId})::int` })
    .from(saleDiscount)
    .innerJoin(sale, eq(sale.id, saleDiscount.saleId))
    .where(
      and(
        eq(saleDiscount.operatorId, definition.operatorId),
        eq(saleDiscount.kind, 'promo'),
        eq(saleDiscount.code, definition.code),
        gte(saleDiscount.createdAt, definition.createdAt),
        eq(sale.status, 'finalised'),
        ...(memberId ? [eq(sale.memberId, memberId)] : []),
      ),
    );
  return Number(row?.uses ?? 0);
}

/**
 * What `judge` made of one code. `definition` is the park's row the code
 * matched, whatever the verdict (switched off included), and null when it
 * matched none: an offline sale's code is filed under that row's own spelling
 * (`asRecorded`).
 */
type Verdict =
  | { ok: true; promo: CartPromo; definition: DefinitionRow }
  | { ok: false; reason: string; unknown: boolean; definition: DefinitionRow | null };

/**
 * Judge each code the till sent, in the order it sent them — which is the
 * order the till applied them, and so the order that decides which of two
 * codes that cannot be combined is the one already on the sale.
 *
 * `as_recorded` asks one question more: whether the free item the till gave is
 * the definition's product. On a till's own cart that question is never asked,
 * because what the till says it gave moves nothing there.
 */
async function judge(
  db: Exec,
  scope: PromoScope,
  sent: readonly PromoDiscountInput[],
  freeItemLines: readonly FreeItemLine[],
  pricing: PromoPricing,
): Promise<Verdict[]> {
  const forms = [
    ...new Set(sent.flatMap((entry) => [entry.code.trim(), codeKey(entry.code)])),
  ].filter((form) => form.length > 0);
  const definitions =
    forms.length > 0
      ? await db
          .select()
          .from(discountDefinition)
          .where(
            and(
              eq(discountDefinition.operatorId, scope.operatorId),
              inArray(discountDefinition.code, forms),
              isNull(discountDefinition.archivedAt),
            ),
          )
      : [];
  const definitionOf = (code: string): DefinitionRow | undefined =>
    definitions.find((row) => row.code === code.trim()) ??
    definitions.find((row) => codeKey(row.code) === codeKey(code));

  const otherBranches = [
    ...new Set(
      definitions
        .map((row) => row.branchId)
        .filter((id): id is string => id !== null && id !== scope.branchId),
    ),
  ];
  const branchNames = new Map(
    otherBranches.length > 0
      ? (
          await db
            .select({ id: branch.id, name: branch.name })
            .from(branch)
            .where(inArray(branch.id, otherBranches))
        ).map((row) => [row.id, row.name])
      : [],
  );
  const freeProducts = [
    ...new Set(
      definitions.map((row) => row.freeProductId).filter((id): id is string => id !== null),
    ),
  ];
  const productNames = new Map(
    freeProducts.length > 0
      ? (
          await db
            .select({ id: product.id, name: product.name })
            .from(product)
            .where(inArray(product.id, freeProducts))
        ).map((row) => [row.id, row.name])
      : [],
  );

  const kept: { definition: DefinitionRow; lineId: string | null }[] = [];
  const verdicts: Verdict[] = [];
  for (const entry of sent) {
    const code = entry.code;
    const definition = definitionOf(code);
    const refuse = (reason: string, unknown = false): void => {
      verdicts.push({ ok: false, reason, unknown, definition: definition ?? null });
    };

    if (definition && kept.some((k) => k.definition.id === definition.id)) {
      refuse(`Code "${code}" is already applied.`);
      continue;
    }
    if (!definition || !definition.active) {
      refuse(unknownPromoCode(code), true);
      continue;
    }
    if (definition.branchId && definition.branchId !== scope.branchId) {
      refuse(notAtThisBranch(code, branchNames.get(definition.branchId) ?? null));
      continue;
    }
    if (definition.validFrom && scope.businessDate < definition.validFrom) {
      refuse(`Code "${code}" is not valid until ${formatIsoDate(definition.validFrom)}.`);
      continue;
    }
    if (definition.validUntil && scope.businessDate > definition.validUntil) {
      refuse(`Code "${code}" expired on ${formatIsoDate(definition.validUntil)}.`);
      continue;
    }

    // A free item's scope is its own line, whatever its target says (the
    // engine's ruling 1), so only a percentage or an amount reads the target.
    let target: DiscountTarget | undefined;
    if (definition.kind !== 'free_item') {
      const read = engineTarget(definition.target);
      if (read === null) {
        refuse(
          `Code "${code}" is limited to "${scopeKind(definition.target)}", ` +
            'which this platform cannot price yet.',
        );
        continue;
      }
      target = read;
    }

    if (definition.usageLimit !== null) {
      const uses = await finalisedUses(db, definition, null);
      if (uses >= definition.usageLimit) {
        refuse(
          definition.usageLimit === 1
            ? `Code "${code}" is used up — its one use has been taken.`
            : `Code "${code}" is used up — all ${definition.usageLimit} of its uses have been taken.`,
        );
        continue;
      }
    }
    // A walk-in is not held to a per-customer limit: with no member on the
    // cart there is nothing to count the earlier uses against.
    if (definition.perCustomerLimit !== null && scope.memberId) {
      const uses = await finalisedUses(db, definition, scope.memberId);
      if (uses >= definition.perCustomerLimit) {
        refuse(
          `Code "${code}" can only be used ${
            definition.perCustomerLimit === 1 ? 'once' : `${definition.perCustomerLimit} times`
          } per customer.`,
        );
        continue;
      }
    }

    let line: FreeItemLine | undefined;
    if (definition.kind === 'free_item') {
      const name =
        (definition.freeProductId && productNames.get(definition.freeProductId)) || 'free item';
      // An offline sale's code, as the till applied it: the item it gave is
      // the definition's only when it is the same product.
      if (
        pricing === 'as_recorded' &&
        entry.type === 'free_item' &&
        entry.freeItemId &&
        entry.freeItemId !== definition.freeProductId
      ) {
        refuse(`Code "${code}" gives a free ${name}, not the item the till gave.`);
        continue;
      }
      line = freeItemLines.find(
        (candidate) =>
          candidate.productId === definition.freeProductId &&
          !kept.some((k) => k.lineId === candidate.lineId),
      );
      if (!line) {
        refuse(`Code "${code}" gives a free ${name}, and there is no ${name} on this order.`);
        continue;
      }
    }

    const other =
      kept.length === 0
        ? undefined
        : definition.stackable
          ? kept.find((k) => !k.definition.stackable)
          : kept[0];
    if (other) {
      refuse(`Code "${code}" can't be combined with "${other.definition.code}" on the same sale.`);
      continue;
    }

    kept.push({ definition, lineId: line?.lineId ?? null });
    verdicts.push({ ok: true, promo: promoOf(definition, target, line), definition });
  }
  return verdicts;
}

/**
 * The engine input a definition becomes. The code and the label are the
 * definition's, so the sale records the park's own name for what it gave.
 *
 * A FREE ITEM IS ONE UNIT OF ITS PRODUCT, aimed at the line that holds it
 * (`CartPromo.line`, the aim a voucher's free item already uses). Aimed, because
 * the engine's own free-item scope is the line the till minted as
 * `promo-<CODE>`, and that id reaches the platform as a uuid (`platformId`), so
 * unaimed it found nothing here. One unit, because the code gives one item: the
 * ticket till's free-item line is always one, and taken to nothing; a shop or
 * F&B line of three has one of them taken off.
 */
function promoOf(
  definition: DefinitionRow,
  target: DiscountTarget | undefined,
  line: FreeItemLine | undefined,
): CartPromo {
  const named = { code: definition.code, label: definition.label };
  if (definition.kind === 'free_item' && line) {
    return {
      ...named,
      type: 'free_item',
      value: line.unitSatang,
      freeItemId: line.productId,
      line: { lineId: line.lineId },
    };
  }
  if (definition.kind === 'percent') {
    // Basis points to the engine's percentage: 1000 is 10, 1250 is 12.5.
    return {
      ...named,
      type: 'percent',
      value: (definition.valueBp ?? 0) / 100,
      ...(target ? { target } : {}),
    };
  }
  return {
    ...named,
    type: 'fixed',
    value: definition.valueSatang ?? 0,
    ...(target ? { target } : {}),
  };
}

/**
 * A code exactly as the till applied it — what an offline sale is filed with.
 *
 * UNDER THE PARK'S OWN SPELLING OF THE CODE whenever it matched a definition
 * (`definition`, what `judge` found for it, whatever it made of it). A code
 * matches its definition however it was typed (`codeKey`), but its uses are
 * counted from the sale rows carrying the definition's exact code
 * (`finalisedUses`): filed as the till spelled it, a `staff10` rung up offline
 * at STAFF10's own value was neither flagged nor ever counted against the
 * limit. Only the spelling is the park's; the value, the label and the scope
 * stay the till's.
 *
 * Its scope goes to the engine only where the engine can read it: one it
 * cannot read would throw there (a `menuItems` scope with no ids), and the
 * till's own engine can apply no such code, so it is priced across the order
 * and `differenceOf` flags the scope. A free item is aimed at `line`, the line
 * holding the item the till gave, as a definition's own free item is
 * (`promoOf`); unaimed, the engine looks for a line id no cart reaches the
 * platform with, and takes nothing.
 */
function asRecorded(
  entry: PromoDiscountInput,
  definition: DefinitionRow | null,
  line: FreeItemLine | undefined,
): CartPromo {
  const target = entry.type === 'free_item' ? undefined : engineTarget(entry.target);
  return {
    code: definition?.code ?? entry.code,
    label: entry.label,
    type: entry.type,
    value: entry.value,
    ...(entry.freeItemId ? { freeItemId: entry.freeItemId } : {}),
    ...(entry.freeItemKind ? { freeItemKind: entry.freeItemKind } : {}),
    ...(target ? { target } : {}),
    ...(line ? { line: { lineId: line.lineId } } : {}),
  };
}

/**
 * What an offline sale's code differs by from the park's definition today, if
 * anything — named by the code the sale was filed under (`asRecorded`), so the
 * flag names the code that is on the sale.
 */
function differenceOf(entry: PromoDiscountInput, verdict: Verdict): PromoDifference[] {
  const code = verdict.definition?.code ?? entry.code;
  const recordedScope = entry.type === 'free_item' ? undefined : engineTarget(entry.target);
  const recorded: PromoValue = {
    type: entry.type,
    value: entry.value,
    ...(recordedScope === null
      ? { target: entry.target }
      : recordedScope
        ? { target: recordedScope }
        : {}),
  };
  if (!verdict.ok) {
    return [
      {
        code,
        label: entry.label,
        recorded,
        definition: null,
        reason: verdict.unknown ? 'unknown code' : verdict.reason,
      },
    ];
  }
  const now: PromoValue = {
    type: verdict.promo.type,
    value: verdict.promo.value,
    ...(verdict.promo.target ? { target: verdict.promo.target } : {}),
  };
  if (
    now.type === recorded.type &&
    now.value === recorded.value &&
    sameScope(recordedScope, verdict.promo.target)
  ) {
    return [];
  }
  return [{ code, label: entry.label, recorded, definition: now, reason: null }];
}

/**
 * Price a cart's promo codes. See the top of this file for every rule; this
 * only reads.
 *
 * `freeItemLines` are the cart's lines that hold one product each, in the
 * order a free-item code should look at them.
 */
export async function resolveCartPromos(
  db: Exec,
  scope: PromoScope,
  sent: readonly PromoDiscountInput[],
  freeItemLines: readonly FreeItemLine[],
  pricing: PromoPricing = 'definition',
): Promise<ResolvedCartPromos> {
  if (sent.length === 0) return { promos: [], rejected: [], differences: [] };
  const verdicts = await judge(db, scope, sent, freeItemLines, pricing);

  if (pricing === 'as_recorded') {
    // Each free item the till gave takes the first line holding that product
    // that no code before it has taken.
    const aimed = new Set<string>();
    const promos = sent.map((entry, index) => {
      const line =
        entry.type === 'free_item' && entry.freeItemId
          ? freeItemLines.find(
              (candidate) =>
                candidate.productId === entry.freeItemId && !aimed.has(candidate.lineId),
            )
          : undefined;
      if (line) aimed.add(line.lineId);
      return asRecorded(entry, verdicts[index]!.definition, line);
    });
    return {
      promos,
      rejected: [],
      differences: sent.flatMap((entry, index) => differenceOf(entry, verdicts[index]!)),
    };
  }

  const promos: CartPromo[] = [];
  const rejected: { code: string; reason: string }[] = [];
  sent.forEach((entry, index) => {
    const verdict = verdicts[index]!;
    if (verdict.ok) {
      promos.push(verdict.promo);
    } else if (!rejected.some((r) => r.code === entry.code && r.reason === verdict.reason)) {
      rejected.push({ code: entry.code, reason: verdict.reason });
    }
  });
  return { promos, rejected, differences: [] };
}

// --- The offline flag --------------------------------------------------------

function describeValue(value: PromoValue): string {
  const worth =
    value.type === 'percent'
      ? `${value.value}% off`
      : value.type === 'fixed'
        ? `฿${baht(value.value)} off`
        : `a free item worth ฿${baht(value.value)}`;
  // In the words a scope the platform cannot price is refused in.
  return value.target === undefined ? worth : `${worth} (limited to "${scopeKind(value.target)}")`;
}

/**
 * Raise one alert per code an offline sale was filed with at a value the park's
 * definition does not give today — or under a code the park has not set up.
 *
 * On the POOL, like every alert a sync handler raises (`BatchScope.db`), and
 * after the sale has been written: an alert names a sale that exists. Keyed on
 * the sale and the code, so a push that is retried bumps the same alert rather
 * than opening a second; the replay's own audit row carries the same facts
 * inside the transaction that filed the sale.
 *
 * BEST-EFFORT, one alert at a time. An alert that cannot be written — the pool
 * timing out, say — is logged and the next one is tried; nothing is thrown. A
 * throw here would reach the push loop as a failed apply and quarantine a sale
 * whose money was taken over nothing but its flag, when the code on it is
 * never a reason to refuse it (`payments/offline.ts`, rule 1's note). The sale
 * is filed either way, and its audit row still names every difference.
 */
export async function raiseOfflinePromoAlerts(
  db: Db,
  where: { operatorId: string; branchId: string | null; boxName: string },
  replayed: {
    saleId: string;
    receiptNumber: string | null;
    promoDifferences: readonly PromoDifference[];
  },
  log?: OpContext['log'],
): Promise<void> {
  const saleName = replayed.receiptNumber ?? replayed.saleId;
  for (const difference of replayed.promoDifferences) {
    const asApplied =
      `Offline sale ${saleName} was filed with code ${difference.code} at ` +
      `${describeValue(difference.recorded)}, as the till applied it`;
    const now = difference.definition
      ? `the park's definition gives ${describeValue(difference.definition)} now.`
      : difference.reason === 'unknown code'
        ? 'the park has no such code set up (unknown code).'
        : `the park's definition would not give it today: ${difference.reason}`;
    try {
      await raiseAlert(
        db,
        {
          key: `sale.offline_promo:${replayed.saleId}:${difference.code}`,
          category: 'sale.offline_promo',
          severity: 'warning',
          subject: `Offline sale ${saleName} (${where.boxName})`,
          summary: `${asApplied}; ${now}`,
          detail: {
            saleId: replayed.saleId,
            receiptNumber: replayed.receiptNumber,
            code: difference.code,
            label: difference.label,
            recorded: difference.recorded,
            definition: difference.definition,
            reason: difference.reason,
          },
          operatorId: where.operatorId,
          branchId: where.branchId,
        },
        { flapWindowSeconds: 0 },
      );
    } catch (err) {
      log?.error(
        { err, saleId: replayed.saleId, code: difference.code },
        "an offline sale's promo alert could not be raised; its audit row names the difference",
      );
    }
  }
}
