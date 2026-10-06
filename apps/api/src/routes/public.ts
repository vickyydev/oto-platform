import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  branch,
  branchHoliday,
  member,
  ticketPackage,
  tier,
} from '@oto/db';
import {
  TaxConfigSchema,
  TaxableCategorySchema,
  TicketCreditRuleSchema,
  TicketFreebieSchema,
  TierAdultRuleSchema,
  TierPriceRuleSchema,
  TranslationsSchema,
  WWPriceSchema,
  getRateModeForDate,
  isIsoDate,
  normalizePhone,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { ipLimited } from '../plugins/rate-limit';
import {
  CHECKOUT_METHODS,
  bookingReturnTarget,
  bookingToday,
  createPublicBooking,
  openBookingCheckout,
  publicBasketInputs,
  publicBookingStatus,
} from '../services/booking-checkout';
import { opCtx } from '../services/tx';

/**
 * PUBLIC endpoints for the customer self-booking site (/book) — no session.
 * Deliberately minimal surface:
 *   - catalog: active packages (with translations) + tiers + today's rate mode
 *   - member-tier: phone → nickname + tier ONLY (no children / PII — the
 *     prototype's "members are recognised automatically" UX; OD-A14 keeps it
 *     that way: saved children never appear on the open site)
 *   - bookings: creates a PENDING booking + attendees; the TOTAL IS COMPUTED
 *     SERVER-SIDE through the S2-09a engine — the client figure is never
 *     charged (S2-12, `services/booking-checkout.ts`)
 *   - checkout: the booking's one payment, on 2C2P's hosted page (or the
 *     simulator's while no `PGW_*` credentials are set)
 *   - return: where the hosted page sends the browser back. Verified, read as
 *     a display hint, and it WRITES NOTHING — a booking is paid only by the
 *     backend notification plus an inquiry, or by the inquiry poller
 *   - status: what the waiting page polls; the signed QR once paid.
 */
/**
 * ONE PACKAGE, AS THE BOOKING SITE READS IT (SCRUM-252).
 *
 * `packages` was the raw `select()`, so this open URL — addressed by a branch
 * slug anyone can guess — answered with every column of `pos.ticket_package`:
 * `operatorId`, `branchId` and the row's `createdAt`, `updatedAt` and
 * `archivedAt` went to whoever asked.
 *
 * Every field below is one the booking site's own package type declares
 * (`apps/pos/src/api/platform.ts:ApiTicketPackage`); all but `description` and
 * `active` are read by `apps/pos/src/api/mappers.ts:apiPackageToTicketType`
 * when the site hydrates its catalogue, and those two are kept for the reason
 * given at `active` below. `id` is the one internal uuid kept, and it is kept
 * because the site sends it back: `POST /public/bookings` prices each line by
 * `packageId`.
 *
 * The jsonb payloads are spelled out from the same shapes the admin write path
 * validates on the way in (`TicketPackageBodySchema`), so the public contract
 * and the stored shape are one definition rather than two that drift.
 */
const PublicPackageSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  durationLabel: z.string(),
  hours: z.number().int(),
  prices: z.record(z.string(), WWPriceSchema),
  tierPricing: z.record(z.string(), TierPriceRuleSchema).nullable(),
  adultRules: z.record(z.string(), TierAdultRuleSchema).nullable(),
  freebies: z.array(TicketFreebieSchema).nullable(),
  creditRule: TicketCreditRuleSchema.nullable(),
  gateAccess: z.boolean(),
  translations: TranslationsSchema.nullable(),
  /**
   * Always true here — the query filters on it. Kept, as `description` is,
   * because it is part of the package type the booking site declares
   * (`ApiTicketPackage`), and a field that type names but the answer does not
   * carry reads as `undefined` with nothing to warn whoever writes it.
   */
  active: z.boolean(),
});
type PublicPackage = z.infer<typeof PublicPackageSchema>;

/**
 * THE WHOLE ANSWER, AND NOTHING ELSE (SCRUM-252).
 *
 * Declared as the route's response schema rather than written as a `.map()` in
 * the handler, because the serializer parses the answer through it: a column
 * added to `ticket_package` tomorrow is absent from this list and therefore
 * absent from the answer. A projection written by hand does the opposite —
 * `select()` grows, and the hand-written map is the only thing that would have
 * had to notice.
 */
const PublicCatalogSchema = z.object({
  branch: z.object({
    code: z.string(),
    name: z.string(),
    timezone: z.string(),
    businessDayStart: z.string(),
  }),
  tiers: z.array(
    z.object({
      /** The tier CODE: what `prices` is keyed by and what a booking sends back. */
      id: z.string(),
      name: z.string(),
      isDefault: z.boolean(),
      requiresVerification: z.boolean(),
    }),
  ),
  packages: z.array(PublicPackageSchema),
  rateMode: z.object({
    date: z.string(),
    mode: z.enum(['weekday', 'weekend']),
    reason: z.string(),
    overrideName: z.string().optional(),
  }),
  holidays: z.array(
    z.object({ name: z.string(), startsOn: z.string(), endsOn: z.string() }),
  ),
  /**
   * S2-12 — the extras on sale online and the tax configuration, so the total
   * the site shows is built from the numbers the booking is priced with
   * (`publicBasketInputs`). Money in satang, as everywhere on the platform.
   */
  addOns: z.array(
    z.object({
      /** What a booking line sends back: a seeded extra's prototype id, or the product's id. */
      id: z.string(),
      name: z.string(),
      priceSatang: z.number().int(),
      priceWeekendSatang: z.number().int().nullable(),
      taxCategory: TaxableCategorySchema.nullable(),
      translations: TranslationsSchema.nullable(),
    }),
  ),
  taxConfig: TaxConfigSchema.nullable(),
});

export async function publicRoutes(app: App): Promise<void> {
  const loadBranchByCode = async (code: string) => {
    const [br] = await app.db
      .select()
      .from(branch)
      .where(and(eq(branch.code, code), isNull(branch.archivedAt)))
      .limit(1);
    if (!br) throw errors.notFound('Branch not found');
    return br;
  };

  app.get(
    '/public/branches/:code/catalog',
    {
      config: { ...ipLimited, public: true },
      schema: {
        description:
          "Public booking catalog: branch, tiers, active packages, rate mode, the extras on sale online and the tax configuration. `rateMode` is for `date` when one is given (the visit date the booking site's date step chose), otherwise for the branch's trading day (business_day_start in the branch timezone) — the day a booking sent without a visit date is quoted for.",
        params: z.object({ code: z.string() }),
        querystring: z.object({ date: z.string().optional() }),
        response: { 200: PublicCatalogSchema },
      },
    },
    async (req) => {
      const br = await loadBranchByCode(req.params.code);
      /**
       * The TRADING day, not the calendar day (SCRUM-209 fix round 2): the
       * same `bookingToday` the quote falls back to, and the day the till's
       * own pricing-mode route answers for. A sent `date` is honoured, as it
       * is there.
       */
      const date = req.query.date ?? bookingToday(br);
      if (!isIsoDate(date)) throw errors.badRequest('date must be yyyy-mm-dd');
      const [tiers, packages, holidays] = await Promise.all([
        app.db
          .select()
          .from(tier)
          .where(and(eq(tier.operatorId, br.operatorId), isNull(tier.archivedAt)))
          .orderBy(asc(tier.sortOrder)),
        app.db
          .select()
          .from(ticketPackage)
          .where(
            and(
              eq(ticketPackage.branchId, br.id),
              eq(ticketPackage.active, true),
              isNull(ticketPackage.archivedAt),
            ),
          )
          .orderBy(asc(ticketPackage.createdAt)),
        // An archived range no longer prices anything, here or at the till
        // (`resolvePricingScope`) or in the booking quote — one calendar.
        app.db
          .select()
          .from(branchHoliday)
          .where(and(eq(branchHoliday.branchId, br.id), isNull(branchHoliday.archivedAt))),
      ]);
      const basket = await publicBasketInputs(app.db, br);
      const rate = getRateModeForDate(
        date,
        holidays.map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
      );
      return {
        branch: {
          code: br.code,
          name: br.name,
          timezone: br.timezone,
          businessDayStart: br.businessDayStart,
        },
        tiers: tiers.map((t) => ({
          id: t.code,
          name: t.name,
          isDefault: t.isDefault,
          requiresVerification: t.requiresVerification,
        })),
        /**
         * The rows as they were read. Drizzle types a `jsonb` column as
         * `unknown`, so they do not satisfy the schema's own input type; the
         * cast asserts nothing about the values, and `PublicCatalogSchema` is
         * what checks them and what strips every column it does not name.
         */
        packages: packages as PublicPackage[],
        rateMode: { date, ...rate },
        holidays: holidays.map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
        addOns: basket.addOns,
        taxConfig: basket.taxConfig,
      };
    },
  );

  app.get(
    '/public/member-tier',
    {
      config: { ...ipLimited, public: true },
      schema: {
        description: 'Customer self-identification: phone → nickname + verified tier only',
        // `branch` is required (S2-01a): phone is unique PER OPERATOR, so an
        // unscoped lookup on a shared deployment could answer with another
        // tenant's member. The booking site always knows its branch.
        querystring: z.object({ phone: z.string(), branch: z.string() }),
      },
    },
    async (req) => {
      const br = await loadBranchByCode(req.query.branch);
      const phone = normalizePhone(req.query.phone);
      if (!phone) return { found: false as const };
      const [m] = await app.db
        .select({ id: member.id, nickname: member.nickname, tierCode: member.tierCode, preferredChannel: member.preferredChannel })
        .from(member)
        .where(
          and(
            eq(member.operatorId, br.operatorId),
            eq(member.phone, phone),
            isNull(member.archivedAt),
          ),
        )
        .limit(1);
      if (!m) return { found: false as const };
      return {
        found: true as const,
        memberId: m.id,
        nickname: m.nickname,
        tierCode: m.tierCode,
        preferredChannel: m.preferredChannel,
      };
    },
  );

  const BookingLine = z.object({
    packageId: z.string().uuid(),
    kids: z.number().int().min(0).max(20),
    adults: z.number().int().min(0).max(20),
    /** The prototype's separate socks count on a line. Priced from the branch catalogue. */
    socks: z.number().int().min(0).max(50).optional(),
    /** Extras on the line, by id — priced from the branch catalogue, never from here. */
    addOns: z
      .array(z.object({ id: z.string().min(1).max(64), quantity: z.number().int().min(1).max(20) }))
      .max(10)
      .optional(),
  });

  const BookingAnswerSchema = z.object({
    id: z.string().uuid(),
    reference: z.string(),
    visitDate: z.string(),
    rateMode: z.enum(['weekday', 'weekend']),
    totalSatang: z.number().int(),
    lines: z.array(z.record(z.string(), z.unknown())),
    /** `pending` until the gateway confirms the money. */
    status: z.string(),
    /** The end of the hold for payment. */
    expiresAt: z.string().nullable(),
  });

  app.post(
    '/public/bookings',
    {
      // Tighter than the read endpoints: a booking writes rows and costs the
      // park a held slot, so one address gets far fewer of them.
      config: { public: true, rateLimit: { max: 20, timeWindow: 60_000 } },
      schema: {
        description:
          'Create a customer booking, PENDING until paid; total computed server-side through the pricing engine. `id` is the booking id the SITE mints, and sending it again returns the booking that exists rather than making a second one.',
        body: z.object({
          /**
           * The booking's own id, minted by the site before it submits
           * (SCRUM-298). This route is open and the platform's idempotency
           * store is owned by accounts, so a client-minted id is what makes a
           * double-tap on a mall's wifi one booking: the primary key IS the
           * unique constraint.
           */
          id: z.string().uuid().optional(),
          branchCode: z.string(),
          phone: z.string().optional(),
          parentName: z.string().min(1).max(120),
          tier: z.string(),
          visitDate: z.string().optional(),
          lines: z.array(BookingLine).min(1).max(10),
          contactChannel: z.enum(['whatsapp', 'telegram', 'line']).optional(),
          locale: z.string().max(8).optional(),
          /** Client-side extras snapshot (drop-off, passes) — stored, not priced here. */
          clientSnapshot: z.unknown().optional(),
          /** What the page showed as the total, in satang: compared, never charged. */
          displayedTotalSatang: z.number().int().min(0).optional(),
        }),
        response: { 200: BookingAnswerSchema },
      },
    },
    async (req, reply) => {
      const { answer, replay } = await createPublicBooking(app.db, app.env, opCtx(req), req.body);
      if (replay) reply.header('x-oto-replay', 'true');
      return answer;
    },
  );

  /**
   * THE BOOKING'S ONE PAYMENT (S2-12).
   *
   * Opens a station-less gateway attempt on the `WEB` invoice segment under
   * the booking's row lock, and answers with the page the guest pays on. A
   * second call — a double-tap, a back button — finds that attempt and answers
   * with the same page: the row lock and the booking's one attempt link are
   * what stand in for the replay store on this open route.
   *
   * `redirectUrl` starting with `/` is the api's own page (the simulator's);
   * the site reaches it through its `/api` prefix.
   */
  app.post(
    '/public/bookings/:id/checkout',
    {
      config: { public: true, rateLimit: { max: 20, timeWindow: 60_000 } },
      schema: {
        description:
          "Open the booking's payment: a Payment Token restricted to the chosen channel, and the hosted page to send the browser to. Pays nothing — a booking is paid only on the gateway's backend notification confirmed by an inquiry.",
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          method: z.enum(CHECKOUT_METHODS),
          locale: z.string().max(8).optional(),
        }),
        response: {
          200: z.object({
            bookingId: z.string().uuid(),
            attemptId: z.string().uuid(),
            redirectUrl: z.string(),
            expiresAt: z.string(),
            provider: z.enum(['2c2p', 'simulator']),
          }),
        },
      },
    },
    async (req) =>
      openBookingCheckout(app.db, app.env, req.log, opCtx(req), {
        bookingId: req.params.id,
        method: req.body.method,
        locale: req.body.locale,
      }),
  );

  /**
   * What the booking site's "checking your payment" page polls.
   *
   * Addressed by the booking's own id — a v7 uuid the family's browser was
   * handed — and it answers with the booking's state only: no name, no phone,
   * no child. The signed QR is in the answer once the gateway has confirmed
   * the money, and not before.
   */
  app.get(
    '/public/bookings/:id/status',
    {
      config: { ...ipLimited, public: true },
      schema: {
        description: "A booking's payment state for the booking site's waiting page, with its signed QR once paid",
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string().uuid(),
            reference: z.string(),
            status: z.string(),
            visitDate: z.string(),
            totalSatang: z.number().int(),
            rateMode: z.enum(['weekday', 'weekend']),
            kidsCount: z.number().int(),
            adultsCount: z.number().int(),
            paidAt: z.string().nullable(),
            expiresAt: z.string().nullable(),
            qr: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => publicBookingStatus(app.db, req.params.id),
  );

  /**
   * WHERE THE HOSTED PAGE SENDS THE BROWSER BACK (`PAYMENT_GATEWAY.md` §2.8
   * step 5). 2C2P posts a form with one field, `paymentResponse`.
   *
   * THIS ROUTE CHANGES NOTHING, and that is the invariant of the round: the
   * `paymentResponse` is verified and read as a hint for the page's wording,
   * the booking it names is looked up, and the browser is redirected to the
   * booking site's waiting page — which polls the status route until the
   * gateway's own notification (or the poller's inquiry) has made the booking
   * paid. A forged return is answered exactly like an honest "unknown".
   *
   * It is the one open write the Origin check lets through from another site
   * (`crossSiteReturn`): the POST comes from 2C2P's page by design, and a
   * route that writes nothing has nothing to protect from it.
   */
  const returnHandler = async (
    paymentResponse: string | undefined,
    reply: { redirect: (url: string, code?: number) => unknown },
  ) => {
    const target = await bookingReturnTarget(app.db, app.env, paymentResponse);
    const query = new URLSearchParams({ payment: target.display });
    if (target.bookingId) query.set('booking', target.bookingId);
    return reply.redirect(`/book?${query.toString()}`, 303);
  };

  // The hosted page's return is a form POST: read it as one, in this plugin only.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16_384 },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post(
    '/public/bookings/return',
    {
      config: { public: true, crossSiteReturn: true, ...ipLimited },
      schema: {
        description:
          "The hosted payment page's browser return. Verifies the `paymentResponse` and redirects to the booking site's waiting page with a DISPLAY HINT. Changes nothing: a booking is paid only by the gateway's backend notification confirmed by an inquiry.",
        body: z.object({ paymentResponse: z.string().max(8192).optional() }).passthrough(),
      },
    },
    async (req, reply) => returnHandler(req.body.paymentResponse, reply),
  );

  app.get(
    '/public/bookings/return',
    {
      config: { public: true, ...ipLimited },
      schema: {
        description: 'The same return, reached by a GET. Changes nothing.',
        querystring: z.object({ paymentResponse: z.string().max(8192).optional() }).passthrough(),
      },
    },
    async (req, reply) => returnHandler(req.query.paymentResponse, reply),
  );
}
