import { randomInt } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  attendee,
  booking,
  branch,
  branchHoliday,
  branchTaxConfig,
  member,
  paymentAttempt,
  product,
  ticketPackage,
  tier,
  type Db,
} from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate,
  computeTicketCartTotals,
  computeTicketLine,
  getRateModeForDate,
  isIsoDate,
  newId,
  normalizePhone,
  parseDayStart,
  priceCartLine,
  resolveRate,
  type CartAddOn,
  type PricingContext,
  type TaxConfigShape,
  type TaxableCategory,
  type TicketCartLine,
} from '@oto/shared';
import type { Env } from '../env';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { bookingQrOf, holdIsOpen, type BookingRow } from './booking-payment';
import { resolveItemTaxCategories } from './menu';
import { openAttempt } from './payments/attempt';
import {
  gatewayProviderOf,
  hostedAttemptByInvoice,
  mintWebInvoiceNo,
  readBookingReturn,
  requestHostedPayment,
} from './payments/gateway';
import { bookingView, readBookings, type BookingView } from './bookings';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * THE BOOKING SITE'S CHECKOUT (S2-12, SCRUM-209, arrival round 1; plan
 * `docs/progress/plans/arrival/PLAN.md` §2.1).
 *
 * Four steps, and the fourth is the one that matters:
 *
 *   1. `createPublicBooking` — the server's own quote, through the S2-09a
 *      engine (`computeTicketCartTotals`): the package's weekday or weekend
 *      prices by the VISIT date and the branch's holidays, the adult rules,
 *      socks and add-ons from the branch catalogue, the tax and service charge
 *      configuration. The booking is written `pending`, held for
 *      `PAYMENT_PENDING_MIN` (OD-A11, OD-21). The client's figures are never
 *      charged; the figure it displayed is compared, and a disagreement is
 *      refused rather than charged.
 *   2. `openBookingCheckout` — ONE station-less gateway attempt on the `WEB`
 *      invoice segment (OD-A10), under the booking's row lock, then the hosted
 *      page's address from the `QrPayment` seam.
 *   3. `bookingReturnTarget` — the browser comes back. Its `paymentResponse`
 *      is verified and read as a DISPLAY HINT; nothing is written.
 *   4. Paid happens elsewhere, and only there: `settlePaidAttempt` in
 *      `payments/gateway.ts`, on a signed backend notification that a Payment
 *      Inquiry agreed with, or on the inquiry poller's own answer — then
 *      `confirmBookingPaid` marks the booking and signs its QR in that same
 *      transaction.
 *
 * OD-A14 — no saved children on the public site. Nothing here reads a member's
 * children or writes any: a phone links the booking to a member record by id
 * and the attendees are the names typed on this booking, matched at reception.
 */

// --- The quote ------------------------------------------------------------------

export interface BookingLineInput {
  packageId: string;
  kids: number;
  adults: number;
  /** The prototype's separate socks integer on a line (`CartLine.socks`). */
  socks?: number;
  /** Add-ons on the line: a catalogue product id, or one of the prototype's own ids. */
  addOns?: Array<{ id: string; quantity: number }>;
}

/**
 * THE PROTOTYPE'S ADD-ON IDS, AS THE CATALOGUE CODES THEY WERE SEEDED UNDER.
 *
 * The booking site's add-on list is still the prototype's (`catalogStore.ts`
 * `seedAddOns`, ids like `a-socks`), and the platform seeded the same five as
 * products with codes (`packages/db/src/seed/menu.ts`, `AO-*`). A public route
 * must not take a price from its caller, so the id is resolved to the branch's
 * product and priced from there; an id that resolves to nothing is refused.
 * A catalogue product's own uuid is accepted as it stands.
 */
const PROTOTYPE_ADDON_CODES: Record<string, string> = {
  'a-socks': 'AO-SOCKS',
  'a-grip-socks': 'AO-GRIPSOCKS',
  'a-locker': 'AO-LOCKER',
  'a-cup': 'AO-CUP',
  'a-glow': 'AO-GLOW',
};
/** The branch's socks add-on, which prices the line's `socks` integer. */
const SOCKS_CODE = 'AO-SOCKS';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One priced line as the booking stores it — the shape `bookingView` reads back. */
export interface QuotedLine {
  packageId: string;
  name: string;
  kids: number;
  adults: number;
  kidUnitSatang: number;
  adultsFree: number;
  adultUnitSatang: number;
  socks: number;
  socksUnitSatang: number;
  addOns: Array<{ id: string; productId: string; name: string; unitSatang: number; quantity: number }>;
  lineTotalSatang: number;
}

export interface BookingQuote {
  visitDate: string;
  rateMode: 'weekday' | 'weekend';
  rateReason: string;
  holidayName: string | null;
  tier: string;
  lines: QuotedLine[];
  subtotalSatang: number;
  serviceChargeSatang: number;
  taxSatang: number;
  totalSatang: number;
  engineVersion: string;
}

type BranchRow = typeof branch.$inferSelect;
type ProductRow = typeof product.$inferSelect;

/** An add-on product on sale at this branch: operator-wide, or this branch's own. */
async function addOnProducts(
  exec: Exec,
  br: BranchRow,
  ids: string[],
  codes: string[],
): Promise<{ byId: Map<string, ProductRow>; byCode: Map<string, ProductRow> }> {
  const byId = new Map<string, ProductRow>();
  const byCode = new Map<string, ProductRow>();
  const clauses: SQL[] = [];
  if (ids.length > 0) clauses.push(inArray(product.id, ids));
  if (codes.length > 0) clauses.push(inArray(product.code, codes));
  if (clauses.length === 0) return { byId, byCode };
  const rows = await exec
    .select()
    .from(product)
    .where(
      and(
        eq(product.operatorId, br.operatorId),
        eq(product.active, true),
        isNull(product.archivedAt),
        or(...clauses),
      ),
    );
  for (const row of rows) {
    if (row.branchId && row.branchId !== br.id) continue;
    if (row.kind !== 'addon') continue;
    byId.set(row.id, row);
    if (row.code) {
      // A branch's own product wins over an operator-wide one with the same code.
      const held = byCode.get(row.code);
      if (!held || (!held.branchId && row.branchId)) byCode.set(row.code, row);
    }
  }
  return { byId, byCode };
}

// --- What the booking site prices its basket with --------------------------------

/** The prototype id a seeded add-on is known by on the booking site, by catalogue code. */
const PROTOTYPE_ID_BY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(PROTOTYPE_ADDON_CODES).map(([id, code]) => [code, id]),
);

/** One extra as the booking site offers it: the same product, price and taxable area the quote uses. */
export interface PublicAddOn {
  /**
   * What the site sends back on a booking line: the prototype id for one of
   * the five seeded extras (so `a-socks`, which the site's socks rule reads by
   * id, keeps its name), the catalogue product's own id for any other.
   */
  id: string;
  name: string;
  priceSatang: number;
  /** Null when the weekend price is the weekday price. */
  priceWeekendSatang: number | null;
  /** The taxable area the quote resolves for it (item, then category chain); null = the add-ons rule. */
  taxCategory: TaxableCategory | null;
  translations: Record<string, { name: string; description?: string }> | null;
}

/**
 * THE BASKET'S INPUTS, FROM THE PLATFORM (S2-12 gate, finding 4).
 *
 * `createPublicBooking` refuses a total the site showed that is not its own
 * quote (`BOOKING_TOTAL_CHANGED`), and the site's total was built from the
 * prototype's add-on list and tax configuration held in the browser. The two
 * agreed only while the seed copied the prototype's numbers, so the first
 * Console edit of the socks price or the branch's tax would have refused every
 * affected booking. This is what the public catalogue now answers with, read
 * through the SAME rules the quote prices by: the add-ons on sale at this
 * branch (operator-wide or its own, the branch's own winning a shared code),
 * each at its catalogue prices and resolved taxable area, and the branch's
 * tax configuration as it stands.
 */
export async function publicBasketInputs(
  exec: Exec,
  br: BranchRow,
): Promise<{ addOns: PublicAddOn[]; taxConfig: TaxConfigShape | null }> {
  const rows = await exec
    .select()
    .from(product)
    .where(
      and(
        eq(product.operatorId, br.operatorId),
        eq(product.kind, 'addon'),
        eq(product.active, true),
        isNull(product.archivedAt),
        or(isNull(product.branchId), eq(product.branchId, br.id)),
      ),
    )
    .orderBy(asc(product.sortOrder), asc(product.name));
  // A branch's own product wins over an operator-wide one with the same code,
  // exactly as `addOnProducts` resolves a code for the quote.
  const byCode = new Map<string, ProductRow>();
  for (const row of rows) {
    if (!row.code) continue;
    const held = byCode.get(row.code);
    if (!held || (!held.branchId && row.branchId)) byCode.set(row.code, row);
  }
  const offered = rows.filter((row) => !row.code || byCode.get(row.code) === row);
  const areas = await resolveItemTaxCategories(exec, offered);
  const [cfg] = await exec
    .select()
    .from(branchTaxConfig)
    .where(eq(branchTaxConfig.branchId, br.id))
    .limit(1);
  return {
    addOns: offered.map((row) => ({
      id: (row.code && PROTOTYPE_ID_BY_CODE[row.code]) || row.id,
      name: row.name,
      priceSatang: row.priceSatang,
      priceWeekendSatang:
        row.priceWeekendSatang === null || row.priceWeekendSatang === row.priceSatang
          ? null
          : row.priceWeekendSatang,
      taxCategory: areas.get(row.id) ?? row.taxCategoryOverride ?? null,
      translations: (row.translations as PublicAddOn['translations']) ?? null,
    })),
    taxConfig: cfg ? (cfg.config as TaxConfigShape) : null,
  };
}

/**
 * Price a booking the way the till prices a cart — the S2-09a engine, the
 * branch's catalogue and tax configuration — at the VISIT date's rate: a
 * weekend, or a weekday inside a holiday range, is weekend pricing (the
 * prototype rule `getRateModeForDate` carries).
 */
export async function quoteBooking(
  exec: Exec,
  br: BranchRow,
  input: { tier: string; visitDate: string; lines: BookingLineInput[] },
): Promise<BookingQuote> {
  const holidays = await exec
    .select()
    .from(branchHoliday)
    .where(and(eq(branchHoliday.branchId, br.id), isNull(branchHoliday.archivedAt)));
  const rate = getRateModeForDate(
    input.visitDate,
    holidays.map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
  );
  const mode = rate.mode;

  const [cfg] = await exec
    .select()
    .from(branchTaxConfig)
    .where(eq(branchTaxConfig.branchId, br.id))
    .limit(1);
  if (!cfg) throw errors.badRequest('This park has no tax configuration yet, so nothing can be priced online');

  const wanted = input.lines.filter((line) => line.kids > 0 || line.adults > 0);
  if (wanted.length === 0) throw errors.badRequest('Nothing selected');

  const addOnIds = new Set<string>();
  const addOnCodes = new Set<string>([SOCKS_CODE]);
  for (const line of wanted) {
    for (const addOn of line.addOns ?? []) {
      if (UUID.test(addOn.id)) addOnIds.add(addOn.id);
      else if (PROTOTYPE_ADDON_CODES[addOn.id]) addOnCodes.add(PROTOTYPE_ADDON_CODES[addOn.id]!);
    }
  }
  const catalogue = await addOnProducts(exec, br, [...addOnIds], [...addOnCodes]);
  const areas = await resolveItemTaxCategories(exec, [...catalogue.byId.values()]);
  const priceAt = (row: ProductRow): number =>
    resolveRate({ weekday: row.priceSatang, weekend: row.priceWeekendSatang ?? row.priceSatang }, mode);

  const socksProduct = catalogue.byCode.get(SOCKS_CODE) ?? null;
  const ctx: PricingContext = {
    mode,
    socks: {
      addOnId: socksProduct?.id ?? 'socks-not-configured',
      price: socksProduct ? priceAt(socksProduct) : 0,
      label: socksProduct?.name ?? 'Regular Socks',
    },
  };

  const cartLines: TicketCartLine[] = [];
  const quoted: QuotedLine[] = [];
  let index = 0;
  for (const line of wanted) {
    index += 1;
    const [pkg] = await exec
      .select()
      .from(ticketPackage)
      .where(
        and(
          eq(ticketPackage.id, line.packageId),
          eq(ticketPackage.branchId, br.id),
          eq(ticketPackage.active, true),
          isNull(ticketPackage.archivedAt),
        ),
      )
      .limit(1);
    if (!pkg) throw errors.badRequest('A selected ticket is no longer available');
    const prices = pkg.prices as Record<string, { weekday: number; weekend: number }>;
    // The till's rule: a tier the package does not price is refused, never
    // sold at the engine's defensive zero.
    if (!prices[input.tier]) {
      throw errors.badRequest(`"${pkg.name}" has no ${input.tier} price, so it cannot be booked at that rate`);
    }
    const socks = line.socks ?? 0;
    if (socks > 0 && !socksProduct) {
      throw errors.badRequest('Socks are not sold online at this park');
    }
    const addOns: CartAddOn[] = [];
    const quotedAddOns: QuotedLine['addOns'] = [];
    for (const addOn of line.addOns ?? []) {
      if (addOn.quantity <= 0) continue;
      const code = PROTOTYPE_ADDON_CODES[addOn.id];
      const row = UUID.test(addOn.id) ? catalogue.byId.get(addOn.id) : code ? catalogue.byCode.get(code) : undefined;
      if (!row) throw errors.badRequest('A selected extra is no longer available online');
      const unit = priceAt(row);
      const area: TaxableCategory | undefined = areas.get(row.id) ?? row.taxCategoryOverride ?? undefined;
      addOns.push({
        id: row.id,
        name: row.name,
        price: unit,
        quantity: addOn.quantity,
        ...(area ? { taxCategoryOverride: area } : {}),
      });
      quotedAddOns.push({ id: addOn.id, productId: row.id, name: row.name, unitSatang: unit, quantity: addOn.quantity });
    }
    const cartLine: TicketCartLine = {
      id: `booking-line-${index}`,
      packageId: pkg.id,
      package: { prices, adultRules: pkg.adultRules as never },
      tier: input.tier,
      kids: line.kids,
      adults: line.adults,
      socks,
      addOns,
      lineTotal: 0,
    };
    cartLine.lineTotal = priceCartLine(cartLine, ctx);
    cartLines.push(cartLine);
    const breakdown = computeTicketLine(
      { pkg: { prices, adultRules: pkg.adultRules as never }, tier: input.tier, kids: line.kids, adults: line.adults },
      mode,
    );
    quoted.push({
      packageId: pkg.id,
      name: pkg.name,
      kids: line.kids,
      adults: line.adults,
      kidUnitSatang: breakdown.kidUnit,
      adultsFree: breakdown.adults.freeCount,
      adultUnitSatang: breakdown.adults.paidUnit,
      socks,
      socksUnitSatang: ctx.socks.price,
      addOns: quotedAddOns,
      lineTotalSatang: cartLine.lineTotal,
    });
  }

  const totals = computeTicketCartTotals(cartLines, [], [], cfg.config as TaxConfigShape, ctx);
  return {
    visitDate: input.visitDate,
    rateMode: mode,
    rateReason: rate.reason,
    holidayName: rate.overrideName ?? null,
    tier: input.tier,
    lines: quoted,
    subtotalSatang: totals.subtotal,
    serviceChargeSatang: totals.serviceChargeTotal,
    taxSatang: totals.taxTotal,
    totalSatang: totals.total,
    engineVersion: totals.engineVersion,
  };
}

// --- 1 · Create -------------------------------------------------------------------

export interface CreateBookingInput {
  /** The booking's own id, minted by the site (SCRUM-298): a second submit is answered from the row. */
  id?: string;
  branchCode: string;
  phone?: string;
  parentName: string;
  tier: string;
  visitDate?: string;
  lines: BookingLineInput[];
  contactChannel?: 'whatsapp' | 'telegram' | 'line';
  locale?: string;
  clientSnapshot?: unknown;
  /**
   * What the page showed the family as the total. Compared, never charged: a
   * disagreement is refused, so nobody is sent to pay a figure they were not
   * shown.
   */
  displayedTotalSatang?: number;
}

export interface BookingAnswer {
  id: string;
  reference: string;
  visitDate: string;
  rateMode: 'weekday' | 'weekend';
  totalSatang: number;
  lines: Array<Record<string, unknown>>;
  status: string;
  expiresAt: string | null;
}

/**
 * A booking that already exists, answered as the call that wrote it answered
 * it (SCRUM-298) — read back from the row, never re-priced.
 */
export function storedBookingAnswer(row: BookingRow): BookingAnswer {
  const payload = (row.payload ?? {}) as { rateMode?: string; lines?: Array<Record<string, unknown>> };
  return {
    id: row.id,
    reference: row.reference,
    visitDate: row.bookingDate,
    rateMode: payload.rateMode === 'weekend' ? 'weekend' : 'weekday',
    totalSatang: row.totalSatang,
    lines: payload.lines ?? [],
    status: row.status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/**
 * THE BOOKING SITE'S "TODAY" — the branch's TRADING day (S2-12, SCRUM-209 fix
 * round 2).
 *
 * `businessDate` with the branch's own `business_day_start` (05:00 by default),
 * the rule the till's `GET /branches/:id/pricing-mode` and every sale already
 * price by. It was the CALENDAR date here and in the public catalogue, while
 * the booking site read its rate on the trading date; between 00:00 and 05:00
 * the two named different days, so on a Saturday (and a Monday, and either
 * side of a holiday range) every booking made in those hours was refused as
 * `BOOKING_TOTAL_CHANGED`. One definition, used by the public catalogue's
 * `rateMode` and by the quote when no visit date is sent, so the two cannot
 * name different days again.
 */
export function bookingToday(br: Pick<BranchRow, 'timezone' | 'businessDayStart'>, now: Date = new Date()): string {
  return businessDate(now, br.timezone, parseDayStart(br.businessDayStart));
}

export async function loadBranchByCode(exec: Exec, code: string): Promise<BranchRow> {
  const [br] = await exec
    .select()
    .from(branch)
    .where(and(eq(branch.code, code), isNull(branch.archivedAt)))
    .limit(1);
  if (!br) throw errors.notFound('Branch not found');
  return br;
}

/**
 * Write a `pending` booking from the server's own quote. Held for
 * `PAYMENT_PENDING_MIN`; the pending sweeper ends the hold (OD-A11).
 *
 * `replay` is true when the id the site sent already names a booking, which is
 * then answered as it was first answered.
 */
export async function createPublicBooking(
  db: Db,
  env: Env,
  ctx: OpContext,
  input: CreateBookingInput,
): Promise<{ answer: BookingAnswer; replay: boolean }> {
  const br = await loadBranchByCode(db, input.branchCode);

  if (input.id) {
    const [already] = await db
      .select()
      .from(booking)
      .where(and(eq(booking.id, input.id), eq(booking.operatorId, br.operatorId)))
      .limit(1);
    if (already) return { answer: storedBookingAnswer(already), replay: true };
  }

  // Tier must exist for this operator; an unverifiable tier is taken online as
  // a CLAIM and reception re-verifies it at the door (prototype rule).
  const [tierRow] = await db
    .select()
    .from(tier)
    .where(and(eq(tier.operatorId, br.operatorId), eq(tier.code, input.tier)))
    .limit(1);
  if (!tierRow) throw errors.badRequest(`Unknown tier ${input.tier}`);

  // The chosen visit date when the site sends one (the date step on /book);
  // otherwise the branch's trading day, the day the public catalogue answers for.
  const visitDate = input.visitDate ?? bookingToday(br);
  if (!isIsoDate(visitDate)) throw errors.badRequest('visitDate must be yyyy-mm-dd');
  // The site's own rule, enforced where it counts: today's trading day at the
  // earliest, sixty days out at the latest. A past day would mint a booking at
  // a stale rate; a far future one is nothing the park sells (gate finding 4).
  {
    const earliest = bookingToday(br);
    const latest = addDaysToIsoDate(earliest, 60);
    if (visitDate < earliest || visitDate > latest) {
      throw errors.badRequest(`visitDate must be between ${earliest} and ${latest}`);
    }
  }

  const quote = await quoteBooking(db, br, { tier: input.tier, visitDate, lines: input.lines });
  if (
    input.displayedTotalSatang !== undefined &&
    input.displayedTotalSatang !== quote.totalSatang
  ) {
    throw errors.conflict(
      'BOOKING_TOTAL_CHANGED',
      `The price for this booking is ฿${(quote.totalSatang / 100).toFixed(2)}, not the ฿${(input.displayedTotalSatang / 100).toFixed(2)} shown. Online payment covers play tickets, socks and extras; supervised children and event passes are booked at reception.`,
      { displayedTotalSatang: input.displayedTotalSatang, totalSatang: quote.totalSatang },
    );
  }

  const phone = input.phone ? normalizePhone(input.phone) : null;
  let memberId: string | null = null;
  if (phone) {
    const [m] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.operatorId, br.operatorId), eq(member.phone, phone)))
      .limit(1);
    memberId = m?.id ?? null;
  }

  const id = input.id ?? newId();
  const reference = `OTO-${String(randomInt(0, 36 ** 4)).padStart(4, '0')}-${randomInt(1000, 9999)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.PAYMENT_PENDING_MIN * 60_000);
  const packages = [...new Set(quote.lines.map((l) => l.packageId))];
  const kidsCount = quote.lines.reduce((sum, l) => sum + l.kids, 0);
  const adultsCount = quote.lines.reduce((sum, l) => sum + l.adults, 0);
  const storedLines = quote.lines as unknown as Array<Record<string, unknown>>;

  // Booking, attendees and the audit row are one operation: a booking whose
  // attendees are missing is a family turned away at the door.
  return withTx(db, { ...ctx, operatorId: br.operatorId, branchId: br.id }, 'booking.create', async (tx) => {
    /**
     * `onConflictDoNothing` closes what the read above cannot: two submits in
     * flight together both pass it, and the loser waits here on the winner's
     * row. It writes no attendees and no audit entry — the winner wrote both.
     */
    const [inserted] = await tx
      .insert(booking)
      .values({
        id,
        operatorId: br.operatorId,
        branchId: br.id,
        memberId,
        reference,
        bookingDate: visitDate,
        businessDate: visitDate,
        status: 'pending',
        channel: 'web',
        packageId: packages.length === 1 ? packages[0]! : null,
        kidsCount,
        adultsCount,
        totalSatang: quote.totalSatang,
        expiresAt,
        pricingSnapshot: { ...quote, pricedAt: now.toISOString() } as never,
        payload: {
          tier: input.tier,
          rateMode: quote.rateMode,
          parentName: input.parentName,
          phone,
          contactChannel: input.contactChannel ?? 'whatsapp',
          locale: input.locale ?? 'en',
          lines: storedLines,
          clientSnapshot: input.clientSnapshot ?? null,
        },
      })
      .onConflictDoNothing({ target: booking.id })
      .returning();
    if (!inserted) {
      const [already] = await tx
        .select()
        .from(booking)
        .where(and(eq(booking.id, id), eq(booking.operatorId, br.operatorId)))
        .limit(1);
      if (already) return { answer: storedBookingAnswer(already), replay: true };
      // The id belongs to ANOTHER operator's booking. Nothing is written, and
      // the caller is not told whose it is.
      throw errors.badRequest('This booking id is already in use');
    }
    for (const line of quote.lines) {
      for (let i = 0; i < line.kids; i++) {
        await tx.insert(attendee).values({
          id: newId(),
          bookingId: id,
          name: `${input.parentName} — child ${i + 1}`,
          kind: 'child',
          payload: { packageId: line.packageId },
        });
      }
    }
    await audit.record(tx, {
      actorAccountId: null,
      operatorId: br.operatorId,
      branchId: br.id,
      action: 'booking.create',
      entityType: 'booking',
      entityId: id,
      after: {
        reference,
        status: 'pending',
        totalSatang: quote.totalSatang,
        tier: input.tier,
        visitDate,
        rateMode: quote.rateMode,
        kidsCount,
        adultsCount,
        expiresAt: expiresAt.toISOString(),
      },
      requestId: ctx.requestId,
    });
    return { answer: storedBookingAnswer(inserted), replay: false };
  });
}

// --- 2 · Checkout ---------------------------------------------------------------

/** What the booking page offers, as the gateway's channel codes and the ledger's words. */
export const CHECKOUT_METHODS = ['card', 'promptpay'] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];

function channelsFor(env: Env, method: CheckoutMethod): {
  channels: string[];
  kind: 'card' | 'qr';
  methodCode: string;
} {
  return method === 'card'
    ? { channels: ['CC'], kind: 'card', methodCode: 'card' }
    : { channels: [env.PGW_QR_CHANNEL_CODE], kind: 'qr', methodCode: 'promptpay' };
}

/**
 * Where the simulator's page sends the browser when no return URL is
 * configured: the return route, RELATIVE to the page's own path
 * (`[/api]/webhooks/2c2p/hosted/:id`), so it resolves on the api's origin and
 * through the booking site's `/api` rewrite alike.
 */
export const SIMULATOR_RETURN_PATH = '../../../public/bookings/return';

export interface CheckoutAnswer {
  bookingId: string;
  attemptId: string;
  /** The hosted page. A path starting `/` is the api's own (the simulator's page). */
  redirectUrl: string;
  expiresAt: string;
  provider: '2c2p' | 'simulator';
}

/**
 * Open the booking's ONE payment: an attempt on the `WEB` segment, then the
 * hosted page. A second call finds the attempt and answers with the same page.
 */
export async function openBookingCheckout(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  ctx: OpContext,
  input: { bookingId: string; method: CheckoutMethod; locale?: string },
): Promise<CheckoutAnswer> {
  const provider = gatewayProviderOf(env);
  const configuredReturn = env.PGW_FRONTEND_RETURN_URL.trim();
  if (provider === '2c2p' && !configuredReturn) {
    throw errors.conflict(
      'CHECKOUT_NOT_CONFIGURED',
      'Online payment is not set up on this deployment yet (no return address for the payment page).',
    );
  }
  const frontendReturnUrl = configuredReturn || SIMULATOR_RETURN_PATH;
  const { channels, kind, methodCode } = channelsFor(env, input.method);
  const now = new Date();

  // Act 1 — the attempt, committed before the gateway is asked anything.
  const prepared = await withTx(
    db,
    { ...ctx, idempotency: undefined },
    'payment.hosted.open',
    async (tx) => {
      const [row] = await tx
        .select()
        .from(booking)
        .where(eq(booking.id, input.bookingId))
        .for('update')
        .limit(1);
      if (!row || row.archivedAt) throw errors.notFound('Booking not found');
      if (row.paymentAttemptId) {
        const [existing] = await tx
          .select()
          .from(paymentAttempt)
          .where(eq(paymentAttempt.id, row.paymentAttemptId))
          .limit(1);
        if (!existing) throw new Error('the booking names a payment attempt that is not there');
        return { row, attempt: existing, replay: true };
      }
      if (row.status === 'paid' || row.status === 'redeemed') {
        throw errors.conflict('BOOKING_ALREADY_PAID', `Booking ${row.reference} is already paid.`);
      }
      if (!holdIsOpen(row, now)) {
        throw errors.conflict(
          'BOOKING_EXPIRED',
          `Booking ${row.reference} is no longer held for payment. Please make the booking again.`,
          { status: row.status },
        );
      }
      if (row.totalSatang <= 0) throw errors.badRequest('This booking has nothing to pay');

      const [br] = await tx.select().from(branch).where(eq(branch.id, row.branchId)).limit(1);
      if (!br) throw errors.notFound('Branch not found');
      // The day it is PAID, not the visit day (OD-A10).
      const paidDay = businessDate(now, br.timezone, parseDayStart(br.businessDayStart));
      const invoiceNo = await mintWebInvoiceNo(tx, { businessDate: paidDay, prefix: env.PGW_INVOICE_PREFIX });
      const opened = await openAttempt(tx, {
        operatorId: row.operatorId,
        branchId: row.branchId,
        saleId: null,
        stationId: null,
        businessDate: paidDay,
        method: kind,
        methodCode,
        provider,
        status: 'created',
        amountSatang: row.totalSatang,
        invoiceNo,
        payload: { bookingId: row.id, reference: row.reference, channel: 'web', paymentChannels: channels },
      });
      await tx
        .update(booking)
        .set({ paymentAttemptId: opened.id, updatedAt: now })
        .where(eq(booking.id, row.id));
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: row.operatorId,
        branchId: row.branchId,
        action: 'payment.hosted.open',
        entityType: 'payment_attempt',
        entityId: opened.id,
        requestId: ctx.requestId,
        after: {
          bookingId: row.id,
          reference: row.reference,
          invoiceNo,
          amountSatang: row.totalSatang,
          method: kind,
          provider,
        },
      });
      return { row, attempt: opened, replay: false };
    },
  );

  const { row, attempt } = prepared;
  if (prepared.replay) {
    if (row.status === 'paid' || row.status === 'redeemed') {
      throw errors.conflict('BOOKING_ALREADY_PAID', `Booking ${row.reference} is already paid.`);
    }
    // The booking's one payment ended without money, or its hold ran out: the
    // family books again rather than reopening a payment that is over.
    if (row.status !== 'pending' || ['declined', 'cancelled', 'not_found'].includes(attempt.status)) {
      throw errors.conflict(
        'BOOKING_PAYMENT_CLOSED',
        `The payment for booking ${row.reference} did not go through. Please make the booking again.`,
        { status: row.status },
      );
    }
    const url = (attempt.payload as { webPaymentUrl?: unknown } | null)?.webPaymentUrl;
    if (typeof url !== 'string' || !url) {
      throw errors.conflict('PAYMENT_OPENING', 'The payment page is still opening. Try again in a moment.');
    }
    return {
      bookingId: row.id,
      attemptId: attempt.id,
      redirectUrl: url,
      expiresAt: (attempt.expiresAt ?? row.expiresAt ?? now).toISOString(),
      provider: attempt.provider === '2c2p' ? '2c2p' : 'simulator',
    };
  }

  // Acts 2 and 3 — the page, held no longer than the booking is.
  const remainingMin = Math.max(1, Math.ceil(((row.expiresAt?.getTime() ?? now.getTime()) - now.getTime()) / 60_000));
  const opened = await requestHostedPayment(db, env, log, { ...ctx, idempotency: undefined }, {
    attempt,
    description: `OTO Park booking ${row.reference}`,
    channels,
    frontendReturnUrl,
    locale: input.locale,
    expiryMinutes: remainingMin,
  });
  return {
    bookingId: row.id,
    attemptId: attempt.id,
    redirectUrl: opened.webPaymentUrl,
    expiresAt: opened.expiresAt.toISOString(),
    provider,
  };
}

// --- 3 · The browser's return, and the page that waits ----------------------------

/**
 * Where to send a browser that came back from the hosted page. READ ONLY: the
 * hint picks the words on the waiting page and the booking it waits on, and
 * nothing else. A forged or missing `paymentResponse` is answered exactly like
 * an honest "unknown" — the page then waits on the booking the browser itself
 * remembers, and the booking's state is whatever the gateway made it.
 */
export async function bookingReturnTarget(
  db: Db,
  env: Env,
  paymentResponse: string | undefined,
): Promise<{ bookingId: string | null; display: 'completed' | 'failed' | 'unknown' }> {
  const hint = paymentResponse ? readBookingReturn(env, paymentResponse) : null;
  if (!hint?.invoiceNo) return { bookingId: null, display: 'unknown' };
  const attempt = await hostedAttemptByInvoice(db, hint.invoiceNo);
  const bookingId = (attempt?.payload as { bookingId?: unknown } | null)?.bookingId;
  return { bookingId: typeof bookingId === 'string' ? bookingId : null, display: hint.display };
}

export interface PublicBookingStatus {
  id: string;
  reference: string;
  status: string;
  visitDate: string;
  totalSatang: number;
  rateMode: 'weekday' | 'weekend';
  kidsCount: number;
  adultsCount: number;
  paidAt: string | null;
  expiresAt: string | null;
  /**
   * The signed QR while — and only while — the booking is paid and not yet
   * redeemed. The confirmation page can be reopened from its return link for
   * as long as the family needs to show it at reception; once reception has
   * redeemed it, it has done its job and the open route stops handing it out.
   */
  qr: string | null;
}

/**
 * What the booking site's waiting page polls — and what its confirmation
 * reads again when the family reopens it from the return link. No name, no
 * phone, no child: a booking id is all it takes to ask, so all it answers is
 * the booking's own state and, while it is paid and unredeemed, the QR that
 * was made for it.
 */
export async function publicBookingStatus(exec: Exec, bookingId: string): Promise<PublicBookingStatus> {
  const [row] = await exec
    .select()
    .from(booking)
    .where(and(eq(booking.id, bookingId), isNull(booking.archivedAt)))
    .limit(1);
  if (!row) throw errors.notFound('Booking not found');
  const payload = (row.payload ?? {}) as { rateMode?: string };
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    visitDate: row.bookingDate,
    totalSatang: row.totalSatang,
    rateMode: payload.rateMode === 'weekend' ? 'weekend' : 'weekday',
    kidsCount: row.kidsCount,
    adultsCount: row.adultsCount,
    paidAt: row.paidAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    qr: row.status === 'paid' ? bookingQrOf(row) : null,
  };
}

// --- The Console's bookings list ------------------------------------------------------

export interface BookingLedgerRow extends BookingView {
  channel: string;
  kidsCount: number;
  adultsCount: number;
  paidAt: string | null;
  expiresAt: string | null;
  qrIssued: boolean;
  /** Written as paid by the prototype's simulated flow, with no payment behind it. */
  legacy: boolean;
  payment: {
    attemptId: string;
    invoiceNo: string | null;
    status: string;
    method: string;
    provider: string;
    businessDate: string;
    paidAt: string | null;
  } | null;
}

export const BOOKING_LEDGER_MAX = 100;

/**
 * Every booking at one branch — any status, newest first, optionally one
 * status and a visit-date range — with the payment behind each.
 */
export async function bookingLedger(
  exec: Exec,
  args: {
    operatorId: string;
    branchId: string;
    status?: string;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  },
): Promise<{ total: number; rows: BookingLedgerRow[] }> {
  const where: SQL[] = [eq(booking.operatorId, args.operatorId), eq(booking.branchId, args.branchId)];
  if (args.status) where.push(eq(booking.status, args.status));
  if (args.from) where.push(gte(booking.bookingDate, args.from));
  if (args.to) where.push(lte(booking.bookingDate, args.to));
  const [{ total } = { total: 0 }] = await exec
    .select({ total: count() })
    .from(booking)
    .where(and(...where));
  const rows = await exec
    .select({ row: booking, attempt: paymentAttempt })
    .from(booking)
    .leftJoin(paymentAttempt, eq(paymentAttempt.id, booking.paymentAttemptId))
    .where(and(...where))
    .orderBy(desc(booking.createdAt))
    .limit(Math.min(args.limit, BOOKING_LEDGER_MAX))
    .offset(args.offset);
  const read = await readBookings(
    exec,
    rows.map((r) => r.row),
  );
  return {
    total: Number(total),
    rows: rows.map(({ row, attempt }) => ({
      ...bookingView(row, read),
      channel: row.channel,
      kidsCount: row.kidsCount,
      adultsCount: row.adultsCount,
      paidAt: row.paidAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      qrIssued: Boolean(row.qrSignature),
      legacy: Boolean((row.pricingSnapshot as { legacy?: unknown } | null)?.legacy),
      payment: attempt
        ? {
            attemptId: attempt.id,
            invoiceNo: attempt.invoiceNo,
            status: attempt.status,
            method: attempt.method,
            provider: attempt.provider,
            businessDate: attempt.businessDate,
            paidAt: attempt.paidAt?.toISOString() ?? null,
          }
        : null,
    })),
  };
}
