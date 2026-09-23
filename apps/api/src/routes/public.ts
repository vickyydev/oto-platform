import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  attendee,
  booking,
  branch,
  branchHoliday,
  member,
  ticketPackage,
  tier,
} from '@oto/db';
import {
  TicketCreditRuleSchema,
  TicketFreebieSchema,
  TierAdultRuleSchema,
  TierPriceRuleSchema,
  TranslationsSchema,
  WWPriceSchema,
  branchToday,
  computeTicketLine,
  getRateModeForDate,
  newId,
  normalizePhone,
  isIsoDate,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { ipLimited } from '../plugins/rate-limit';
import { audit } from '../services/audit';
import { opCtx, withTx } from '../services/tx';

/**
 * PUBLIC endpoints for the customer self-booking site (/book) — no session.
 * Deliberately minimal surface:
 *   - catalog: active packages (with translations) + tiers + today's rate mode
 *   - member-tier: phone → nickname + tier ONLY (no children / PII — the
 *     prototype's "members are recognised automatically" UX)
 *   - bookings: creates a booking + attendees; the TOTAL IS COMPUTED
 *     SERVER-SIDE from the packages via the ported pricing rules — the client
 *     figure is never trusted.
 */
/**
 * A booking that already exists, answered as the call that wrote it answered
 * it (SCRUM-298).
 *
 * Read back from the row rather than recomputed: the reference is random, and
 * re-pricing a booking made last night against tonight's packages would hand
 * the same family a different total for the same submit.
 *
 * Every VALUE is the first answer's; the bytes are not, because `lines` comes
 * back through a `jsonb` column and Postgres orders an object's keys its own
 * way. That is the difference between this and the platform's replay store,
 * which returns a stored body unchanged — and it is a difference no JSON
 * client can see.
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
});

function storedBookingAnswer(row: typeof booking.$inferSelect): {
  id: string;
  reference: string;
  visitDate: string;
  rateMode: 'weekday' | 'weekend';
  totalSatang: number;
  lines: Array<Record<string, unknown>>;
} {
  const payload = (row.payload ?? {}) as {
    rateMode?: string;
    lines?: Array<Record<string, unknown>>;
  };
  return {
    id: row.id,
    reference: row.reference,
    visitDate: row.bookingDate,
    // There are two modes and weekday is the pair's default, so anything but
    // 'weekend' reads as 'weekday' — the same convention the resolver uses.
    rateMode: payload.rateMode === 'weekend' ? 'weekend' : 'weekday',
    totalSatang: row.totalSatang,
    lines: payload.lines ?? [],
  };
}

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
        description: 'Public booking catalog: branch, tiers, active packages, rate mode',
        params: z.object({ code: z.string() }),
        response: { 200: PublicCatalogSchema },
      },
    },
    async (req) => {
      const br = await loadBranchByCode(req.params.code);
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
        app.db.select().from(branchHoliday).where(eq(branchHoliday.branchId, br.id)),
      ]);
      const today = branchToday(br.timezone);
      const rate = getRateModeForDate(
        today,
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
        rateMode: { date: today, ...rate },
        holidays: holidays.map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
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
  });

  app.post(
    '/public/bookings',
    {
      // Tighter than the read endpoints: a booking writes rows and costs the
      // park a held slot, so one address gets far fewer of them.
      config: { public: true, rateLimit: { max: 20, timeWindow: 60_000 } },
      schema: {
        description:
          'Create a customer booking; total computed server-side. `id` is the booking id the SITE mints, and sending it again returns the booking that exists rather than making a second one.',
        body: z.object({
          /**
           * The booking's own id, minted by the site before it submits
           * (SCRUM-298).
           *
           * This route is open, and the platform's idempotency store is not
           * available to it: the store's rows are owned by an account
           * (`core.idempotency_key.account_id`, not null, foreign key), and a
           * customer on the booking page has none — so the plugin returns
           * before the store and the `Idempotency-Key` the site already sends
           * does nothing here. A client-minted id needs no migration and no
           * anonymous principal: the primary key IS the unique constraint, and
           * the check below turns the second submit into the first one's
           * answer. A double-tap on a Thai mall's wifi was two bookings, two
           * references and two held slots for one family.
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
        }),
      },
    },
    async (req, reply) => {
      const br = await loadBranchByCode(req.body.branchCode);

      /**
       * The same submit arriving twice (SCRUM-298).
       *
       * Everything the first call answered is on the row — the reference and
       * the priced lines included, because the total is computed here and
       * stored — so the replay is that answer and not a fresh computation
       * against today's prices.
       */
      if (req.body.id) {
        const [already] = await app.db
          .select()
          .from(booking)
          .where(and(eq(booking.id, req.body.id), eq(booking.operatorId, br.operatorId)))
          .limit(1);
        if (already) {
          reply.header('x-oto-replay', 'true');
          return storedBookingAnswer(already);
        }
      }

      // Tier must exist for this operator; unverifiable tiers are allowed for
      // the ONLINE flow only as a claim — reception re-verifies at the door
      // (prototype rule: verification is a door concern, tourists never need it).
      const [tierRow] = await app.db
        .select()
        .from(tier)
        .where(and(eq(tier.operatorId, br.operatorId), eq(tier.code, req.body.tier)))
        .limit(1);
      if (!tierRow) throw errors.badRequest(`Unknown tier ${req.body.tier}`);

      const visitDate = req.body.visitDate ?? branchToday(br.timezone);
      if (!isIsoDate(visitDate)) throw errors.badRequest('visitDate must be yyyy-mm-dd');
      const holidays = await app.db
        .select()
        .from(branchHoliday)
        .where(eq(branchHoliday.branchId, br.id));
      const rate = getRateModeForDate(
        visitDate,
        holidays.map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
      );

      // Resolve every package and compute the authoritative total.
      let totalSatang = 0;
      const computedLines: Array<Record<string, unknown>> = [];
      for (const line of req.body.lines) {
        if (line.kids === 0 && line.adults === 0) continue;
        const [pkg] = await app.db
          .select()
          .from(ticketPackage)
          .where(
            and(
              eq(ticketPackage.id, line.packageId),
              eq(ticketPackage.branchId, br.id),
              eq(ticketPackage.active, true),
            ),
          )
          .limit(1);
        if (!pkg) throw errors.badRequest('A selected ticket is no longer available');
        const shape = {
          prices: pkg.prices as Record<string, { weekday: number; weekend: number }>,
          adultRules: pkg.adultRules as never,
        };
        const computed = computeTicketLine(
          { pkg: shape, tier: req.body.tier, kids: line.kids, adults: line.adults },
          rate.mode,
        );
        totalSatang += computed.lineTotal;
        computedLines.push({
          packageId: pkg.id,
          name: pkg.name,
          kids: line.kids,
          adults: line.adults,
          kidUnitSatang: computed.kidUnit,
          adultsFree: computed.adults.freeCount,
          adultUnitSatang: computed.adults.paidUnit,
          lineTotalSatang: computed.lineTotal,
        });
      }
      if (computedLines.length === 0) throw errors.badRequest('Nothing selected');

      const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
      let memberId: string | null = null;
      if (phone) {
        const [m] = await app.db
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.operatorId, br.operatorId), eq(member.phone, phone)))
          .limit(1);
        memberId = m?.id ?? null;
      }

      const id = req.body.id ?? newId();
      const reference = `OTO-${String(randomInt(0, 36 ** 4)).padStart(4, '0')}-${randomInt(1000, 9999)}`;
      // Booking, attendees and the audit row are one operation: a booking
      // whose attendees are missing is a family turned away at the door.
      return withTx(app.db, opCtx(req), 'booking.create', async (tx) => {
        /**
         * `onConflictDoNothing` closes what the read above cannot: two submits
         * in flight together both pass that check, and the loser waits here on
         * the winner's row and is handed nothing. It answers with the row that
         * exists and writes no attendees and no audit entry — the winner wrote
         * both.
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
            status: 'paid', // payment recording is M2; the online flow simulates it (prototype behaviour)
            totalSatang,
            payload: {
              tier: req.body.tier,
              rateMode: rate.mode,
              parentName: req.body.parentName,
              phone,
              contactChannel: req.body.contactChannel ?? 'whatsapp',
              locale: req.body.locale ?? 'en',
              lines: computedLines,
              clientSnapshot: req.body.clientSnapshot ?? null,
            },
          })
          .onConflictDoNothing({ target: booking.id })
          .returning({ id: booking.id });
        if (!inserted) {
          const [already] = await tx
            .select()
            .from(booking)
            .where(and(eq(booking.id, id), eq(booking.operatorId, br.operatorId)))
            .limit(1);
          if (already) {
            reply.header('x-oto-replay', 'true');
            return storedBookingAnswer(already);
          }
          // The id is taken by a booking of ANOTHER operator: the site sent an
          // id that is not its own to use. Nothing is written, and it is not
          // told whose it is.
          throw errors.badRequest('This booking id is already in use');
        }
        for (const line of req.body.lines) {
          for (let i = 0; i < line.kids; i++) {
            await tx.insert(attendee).values({
              id: newId(),
              bookingId: id,
              name: `${req.body.parentName} — child ${i + 1}`,
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
          after: { reference, totalSatang, tier: req.body.tier, visitDate },
          requestId: req.id,
        });
        return { id, reference, visitDate, rateMode: rate.mode, totalSatang, lines: computedLines };
      });
    },
  );
}
