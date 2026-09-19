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
      config: ipLimited,
      schema: {
        description: 'Public booking catalog: branch, tiers, active packages, rate mode',
        params: z.object({ code: z.string() }),
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
        branch: { code: br.code, name: br.name, timezone: br.timezone },
        tiers: tiers.map((t) => ({
          id: t.code,
          name: t.name,
          isDefault: t.isDefault,
          requiresVerification: t.requiresVerification,
        })),
        packages,
        rateMode: { date: today, ...rate },
        holidays: holidays.map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
      };
    },
  );

  app.get(
    '/public/member-tier',
    {
      config: ipLimited,
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
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
      schema: {
        description: 'Create a customer booking; total computed server-side',
        body: z.object({
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
    async (req) => {
      const br = await loadBranchByCode(req.body.branchCode);

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

      const id = newId();
      const reference = `OTO-${String(randomInt(0, 36 ** 4)).padStart(4, '0')}-${randomInt(1000, 9999)}`;
      await app.db.insert(booking).values({
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
      });
      for (const line of req.body.lines) {
        for (let i = 0; i < line.kids; i++) {
          await app.db.insert(attendee).values({
            id: newId(),
            bookingId: id,
            name: `${req.body.parentName} — child ${i + 1}`,
            kind: 'child',
            payload: { packageId: line.packageId },
          });
        }
      }
      await audit.record(app.db, {
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
    },
  );
}
