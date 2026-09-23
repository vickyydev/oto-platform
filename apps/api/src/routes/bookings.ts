import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { branch } from '@oto/db';
import { normalizePhone } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import {
  BOOKING_PAGE_DEFAULT,
  BOOKING_PAGE_MAX,
  BOOKING_STATUSES,
  REDEEMABLE_STATUS,
  bookingView,
  findBookings,
  loadBookingForOperator,
  memberIdForPhone,
  normalizeReference,
  readBookings,
  redeemBooking,
  stationAtBranch,
  viewBookings,
} from '../services/bookings';
import { opCtx, withTx } from '../services/tx';

/**
 * SCRUM-234 — the counter's view of an online booking.
 *
 * A booking has been a real row since S2-12 and no counter could see one: the
 * till's redeem screen read `mockApi.getAllBookings`, so a family who paid on
 * the booking site arrived and the till had never heard of them.
 *
 * The three routes are the ones `apps/pos/src/api/bookings.ts` states and
 * `apps/pos/src/dev/driveBookingRedemption.ts` drives the till against: the
 * waiting list, one booking by its reference, and the claim.
 *
 * **Guarded as the visit it is about to become.** These routes mint no new
 * permission. A booking is a branch's own record of people who are coming
 * today, so reading one is guarded by `pos:visit:read` — held by every counter
 * role — and redeeming it by `pos:voucher:redeem`, which reception and
 * managers hold and read-only `staff` do not. That split is the one the act
 * deserves: anybody at the counter may look an arrival up, and letting a
 * family through the gate on a payment taken elsewhere is a selling action.
 *
 * A dedicated `pos:booking:*` pair would read better and is deliberately not
 * added here: `packages/shared/src/permissions.ts` declares the vocabulary
 * ahead of the routes precisely because a permission minted on the day its
 * route is written is grantable to nobody until the next seed, and reception
 * on staging would hold it at neither park. Worth its own ticket, with the
 * seeding that goes with it.
 */
export async function bookingRoutes(app: App): Promise<void> {
  /**
   * The branch this request acts at: the one it names, or the one the session
   * is seated at. Operator-scoped, so a branch id from another tenant is a 404
   * before anything is read (SCRUM-290).
   */
  const loadBranchForOperator = async (operatorId: string, branchId: string) => {
    const [br] = await app.db
      .select()
      .from(branch)
      .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
      .limit(1);
    if (!br) throw errors.notFound('Branch not found');
    return br;
  };

  /**
   * The branch the caller may act at, settled and checked.
   *
   * The guard has already checked whatever `branchId` the request named; this
   * re-states it for the path where it named none and the session's own branch
   * is the answer — the shape `visits.ts` uses, and the reason it uses it.
   */
  const actingBranch = async (req: FastifyRequest, named: string | undefined) => {
    const auth = req.requireAuth();
    const branchId = named ?? auth.branchId;
    if (!branchId) throw errors.badRequest('No active branch on this session');
    const br = await loadBranchForOperator(auth.operatorId, branchId);
    await req.requirePermission('pos:visit:read', { branchId: br.id });
    return { auth, branch: br };
  };

  /**
   * What is waiting at this branch — the list above the search box on the
   * redeem screen, which until this ticket was `mockApi`'s invented one.
   *
   * Newest first, which is the order the prototype's `getAllBookings` used.
   * A no-show stays on it until somebody changes its status: there is no
   * hidden date floor here, because a family who booked for tomorrow and walks
   * in today is a real event and a list that quietly dropped them would send
   * reception back to guessing.
   */
  app.get(
    '/',
    {
      config: { permission: 'pos:visit:read', target: { branchId: 'query.branchId' } },
      schema: {
        description: "One branch's bookings — the redeem screen's waiting list",
        querystring: z.object({
          branchId: z.string().uuid().optional(),
          status: z.enum(BOOKING_STATUSES).default(REDEEMABLE_STATUS),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          /** The number that made the booking, for the family who cannot find the mail. */
          phone: z.string().max(32).optional(),
          limit: z.coerce.number().int().min(1).max(BOOKING_PAGE_MAX).default(BOOKING_PAGE_DEFAULT),
        }),
      },
    },
    async (req) => {
      const { auth, branch: br } = await actingBranch(req, req.query.branchId);

      let phone: string | null = null;
      let memberId: string | null = null;
      if (req.query.phone) {
        phone = normalizePhone(req.query.phone);
        // An unparseable number matches nothing rather than reading as "no
        // filter", which would answer with the branch's whole arrivals list.
        if (!phone) return { bookings: [] };
        memberId = await memberIdForPhone(app.db, auth.operatorId, phone);
      }

      const rows = await findBookings(app.db, {
        operatorId: auth.operatorId,
        branchId: br.id,
        bookingDate: req.query.date,
        statuses: [req.query.status],
        phone: phone ?? undefined,
        memberId,
        limit: req.query.limit,
      });
      return { bookings: await viewBookings(app.db, rows) };
    },
  );

  /**
   * One booking, by the reference printed on the customer's QR.
   *
   * Scoped to one branch for the reason in `services/bookings.ts`: a reference
   * is eight typed characters. The signed booking QR that would carry its own
   * branch is S2-12's (SCRUM-209) and is not built; the reference and the
   * phone are what reception has today.
   *
   * 404 when there is none — the counter tells those apart from an undeployed
   * route by the error code, so this must be our own 404 and not Fastify's.
   */
  app.get(
    '/by-reference/:reference',
    {
      config: { permission: 'pos:visit:read', target: { branchId: 'query.branchId' } },
      schema: {
        description: 'One booking at this branch by its reference',
        params: z.object({ reference: z.string().min(1).max(64) }),
        querystring: z.object({ branchId: z.string().uuid().optional() }),
      },
    },
    async (req) => {
      const { auth, branch: br } = await actingBranch(req, req.query.branchId);
      const [row] = await findBookings(app.db, {
        operatorId: auth.operatorId,
        branchId: br.id,
        reference: normalizeReference(req.params.reference),
        limit: 1,
      });
      if (!row) throw errors.notFound('No booking with that reference at this branch');
      return bookingView(row, await readBookings(app.db, [row]));
    },
  );

  /**
   * Claim the booking for this station, before anything is minted or printed.
   *
   * A second redemption is refused by name — when, where and by whom the first
   * happened — rather than answered with a silent success, because a booking
   * redeemed twice is two families through the gate on one payment and the
   * person at the counter is the only one who can tell which is which.
   *
   * A genuine RETRY is a different thing and is already handled: the till
   * sends the same `Idempotency-Key`, and the plugin replays the stored answer
   * without re-running the work.
   *
   * The branch is not in the path, so ownership is established the way
   * `fleet.ts` and `ops.ts` establish theirs: load the row inside the caller's
   * operator, then require the permission at the branch that comes back.
   */
  app.post(
    '/:id/redeem',
    {
      config: { permission: 'pos:voucher:redeem' },
      schema: {
        description: 'Redeem an online booking at the counter — once',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          /** The station the till is holding; the session's own is the fallback. */
          stationId: z.string().uuid().optional(),
          /**
           * Bands already minted, for a surface that cannot ask first — the
           * offline box. The counter claims before it mints and sends none.
           */
          bandCodes: z.array(z.string().min(1).max(64)).max(40).default([]),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const found = await loadBookingForOperator(app.db, auth.operatorId, req.params.id);
      if (!found) throw errors.notFound('Booking not found');
      // A booking belongs to the park it was booked at. The other park's
      // counter is refused here, before the row is locked or anything written.
      await req.requirePermission('pos:voucher:redeem', { branchId: found.branchId });

      const claimed = req.body.stationId ?? auth.stationId;
      let stationId: string | null = null;
      if (claimed) {
        stationId = await stationAtBranch(app.db, found.branchId, claimed);
        if (!stationId) throw errors.badRequest('That station is not at this booking’s branch');
      }

      return withTx(app.db, opCtx(req), 'booking.redeem', async (tx) => {
        const row = await redeemBooking(tx, {
          bookingId: found.id,
          operatorId: auth.operatorId,
          actorAccountId: auth.accountId,
          stationId,
          bandCodes: req.body.bandCodes,
          requestId: req.id,
        });
        // Read back inside the transaction that wrote it, so the answer carries
        // the redemption row this claim just made (SCRUM-304).
        return { booking: bookingView(row, await readBookings(tx, [row])) };
      });
    },
  );
}
