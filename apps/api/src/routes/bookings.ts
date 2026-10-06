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
  loadBookingByQr,
  loadBookingForOperator,
  memberIdForPhone,
  normalizeReference,
  readBookings,
  stationAtBranch,
  viewBookings,
} from '../services/bookings';
import { BOOKING_LEDGER_MAX, bookingLedger } from '../services/booking-checkout';
import { redeemBookingAtCounter } from '../services/booking-redemption';
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
 * **Guarded by its own pair of permissions** (SCRUM-306). Reading a booking
 * takes `pos:booking:read` and claiming one takes `pos:booking:redeem`. Until
 * this ticket both were borrowed — reading as `pos:visit:read`, redeeming as
 * `pos:voucher:redeem` — because a permission minted on the day its route is
 * written is grantable to nobody until the roles are synced, and a counter
 * refused at both parks is worse than a borrowed name. The pair is in
 * `packages/shared/src/permissions.ts` and in the `reception` and
 * `branch_manager` bundles, which staging's pre-deploy sync applies, so the
 * borrowing is over: an operator can now say who may look an arrival up and
 * who may let a family through the gate without that also deciding what they
 * do with a voucher or a visit.
 *
 * Read-only `staff` hold neither, so the waiting list is no longer on every
 * counter session the way `pos:visit:read` put it: it names and numbers every
 * family arriving today.
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
    await req.requirePermission('pos:booking:read', { branchId: br.id });
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
      config: { permission: 'pos:booking:read', target: { branchId: 'query.branchId' } },
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
   * THE CONSOLE'S BOOKINGS LIST (S2-12, SCRUM-209 round 1).
   *
   * Every booking at one branch whatever its state — waiting for payment,
   * paid, redeemed, expired, failed — newest first, with the payment behind
   * each: the `WEB` invoice, the attempt's status and the day the money was
   * taken. The counter's waiting list above answers "who is arriving"; this
   * answers "what happened to the money", which is the back office's question.
   *
   * Same permission as the counter's read, at the same branch: it names the
   * same families.
   */
  app.get(
    '/ledger',
    {
      config: { permission: 'pos:booking:read', target: { branchId: 'query.branchId' } },
      schema: {
        description: "One branch's bookings in every state, with the payment behind each — the Console's bookings list",
        querystring: z.object({
          branchId: z.string().uuid().optional(),
          status: z.enum(BOOKING_STATUSES).optional(),
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          limit: z.coerce.number().int().min(1).max(BOOKING_LEDGER_MAX).default(50),
          offset: z.coerce.number().int().min(0).max(100_000).default(0),
        }),
      },
    },
    async (req) => {
      const { auth, branch: br } = await actingBranch(req, req.query.branchId);
      return bookingLedger(app.db, {
        operatorId: auth.operatorId,
        branchId: br.id,
        status: req.query.status,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
        offset: req.query.offset,
      });
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
   *
   * `stationTrading`, on this read and the two below (SCRUM-477): with the
   * station forced offline the platform refuses the lookup as it refuses
   * `/members/lookup`, so the till's lane arbiter moves the lookup to the box
   * and the booking is read from the box's copy — the copy Confirm & Issue
   * then redeems. Before this the lookup rode the platform while only Confirm
   * went to the box, and a QR typed at an offline till was never checked on
   * the box at all.
   */
  app.get(
    '/by-reference/:reference',
    {
      config: {
        permission: 'pos:booking:read',
        target: { branchId: 'query.branchId' },
        stationTrading: true,
      },
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
   * One booking, by a whole booking QR the till read itself (S2-12 round 3 fix).
   *
   * A scanner plugged into the till, or the redeem dialog's typed field, has
   * no key and cannot check a QR's signature; before this route it parsed the
   * id out of the code's shape and opened the dialog on it, so a tampered QR
   * opened it too. The till now sends the code it read, and nothing opens
   * unless the platform matches the signature against the one it stored when
   * the booking was paid. The permission is required at the booking's own
   * branch, exactly as the id read below.
   */
  app.get(
    '/by-qr',
    {
      config: { permission: 'pos:booking:read', stationTrading: true },
      schema: {
        description: 'One booking by the whole signed QR the till scanned — refused unless the signature is the one the park issued',
        querystring: z.object({ code: z.string().min(1).max(128) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const found = await loadBookingByQr(app.db, auth.operatorId, req.query.code);
      await req.requirePermission('pos:booking:read', { branchId: found.branchId });
      return bookingView(found, await readBookings(app.db, [found]));
    },
  );

  /**
   * One booking, by the id its signed QR carries (S2-12 round 3).
   *
   * The box checks a scanned booking QR's signature and hands the till the
   * booking id (`bookingQrHandler` in `@oto/box-agent`); the till opens the
   * redeem flow on it through this read. Same permission as the reference
   * lookup, required at the booking's own branch — so the other park's till
   * cannot read it by id any more than by reference.
   */
  app.get(
    '/:id',
    {
      config: { permission: 'pos:booking:read', stationTrading: true },
      schema: {
        description: 'One booking by its id — the id a scanned booking QR names',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const found = await loadBookingForOperator(app.db, auth.operatorId, req.params.id);
      if (!found) throw errors.notFound('Booking not found');
      await req.requirePermission('pos:booking:read', { branchId: found.branchId });
      return bookingView(found, await readBookings(app.db, [found]));
    },
  );

  /**
   * REDEEM AN ONLINE BOOKING AT THE COUNTER — S2-12 (SCRUM-209 round 3).
   *
   * One transaction (`services/booking-redemption.ts`): claim the booking —
   * the row lock, paid only, the unique redemption row — then commit and close
   * a sale from the lines the family PAID for, with the booking on it and the
   * paid-online tender, then mint the bands and queue the paper through the
   * path every walk-in sale takes. The answer carries the booking, the sale,
   * the bands and the print jobs, so the till shows and prints exactly what a
   * walk-in sale shows and prints.
   *
   * A second redemption is refused by name — when, where and by whom the first
   * happened — and writes nothing: no sale, no band. A genuine RETRY carries
   * the same `Idempotency-Key` and is answered from the stored response.
   *
   * The branch is not in the path, so ownership is established the way
   * `fleet.ts` and `ops.ts` establish theirs: load the row inside the caller's
   * operator, then require the permission at the branch that comes back. A
   * redemption needs a till — the sale is numbered and printed at one — so a
   * session standing at none, and naming none, is refused (after the booking's
   * own refusals, and with nothing written).
   */
  app.post(
    '/:id/redeem',
    {
      config: { permission: 'pos:booking:redeem', stationTrading: true },
      schema: {
        description: 'Redeem an online booking at the counter — once: the sale, its bands and its print jobs',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          /** The station the till is holding; the session's own is the fallback. */
          stationId: z.string().uuid().optional(),
          /** The visit reception confirmed, whose children the kids' bands name. */
          visitId: z.string().uuid().optional(),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const found = await loadBookingForOperator(app.db, auth.operatorId, req.params.id);
      if (!found) throw errors.notFound('Booking not found');
      // A booking belongs to the park it was booked at. The other park's
      // counter is refused here, before the row is locked or anything written.
      await req.requirePermission('pos:booking:redeem', { branchId: found.branchId });

      const claimed = req.body.stationId ?? auth.stationId;
      let stationId: string | null = null;
      if (claimed) {
        stationId = await stationAtBranch(app.db, found.branchId, claimed);
        if (!stationId) throw errors.badRequest('That station is not at this booking’s branch');
      }

      return withTx(app.db, opCtx(req), 'booking.redeem', async (tx) => {
        const done = await redeemBookingAtCounter(tx, {
          bookingId: found.id,
          operatorId: auth.operatorId,
          actorAccountId: auth.accountId,
          stationId,
          visitId: req.body.visitId ?? null,
          requestId: req.id,
          assertBranchAllowed: async (branchId) => {
            await req.requirePermission('pos:booking:redeem', { branchId });
          },
        });
        // Read back inside the transaction that wrote it, so the answer carries
        // the redemption row — and its bands — this claim just made.
        return {
          booking: bookingView(done.booking, await readBookings(tx, [done.booking])),
          sale: done.sale,
          attempt: done.attempt,
          bands: done.bands,
          printing: done.printing,
          // S2-14a — the credit the booking's tickets earned, as a walk-in's answer carries it.
          grants: done.grants,
        };
      });
    },
  );
}
