import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  EventAttendeeCreateBodySchema,
  EventAttendeeWriteAnswerSchema,
  EventDayAnswerSchema,
  EventDetailAnswerSchema,
  EventDropInPricingAnswerSchema,
  EventDropInPricingSchema,
  EventPassSellBodySchema,
  EventPassesAnswerSchema,
  EventRosterAnswerSchema,
  EventsDateQuerySchema,
  EventsDayQuerySchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { eventById, eventPassesFor, eventRoster, eventsForDay } from '../services/events';
import {
  addEventAttendee,
  getEventDropInPricing,
  putEventDropInPricing,
  sellEventPass,
} from '../services/event-writes';
import { queueDrawerKick } from '../services/payments/drawer';
import type { ActorContext } from '../services/sale';
import { opCtx } from '../services/tx';

/**
 * S2-20 E1 — THE EVENTS READ SEAM (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md §9 E1, §10).
 *
 * The OTO App's events, camps and parties as the POS reads them: the day's
 * list (the header Events tab and the Check-in board's Events tab), one
 * event, the passes the till sells and one event's roster on a day. Read-only
 * — the writes (attendees, passes, check-ins, the party tab) are E2 to E4.
 *
 * Branch-scoped like every platform route: `pos:event:read` is checked at the
 * branch in the query, and the service loads that branch inside the caller's
 * operator before the OTO App's views are asked, so an id from another park or
 * operator answers nothing it should not. 503 `EVENTS_SEAM_NOT_GRANTED` when
 * the deployment has the seam but this api may not read it — never an empty
 * list that would say "nothing on today".
 */

const EventParams = z.object({ id: z.string().uuid() });

/**
 * The acting account, with the scope check for the branch the write turns out
 * to be for — the same shape the sales routes build, because a pass is a sale
 * and `commitSale` asks it again when the branch is settled.
 */
function actorOf(req: FastifyRequest, permission: Permission): ActorContext {
  const auth = req.requireAuth();
  return {
    accountId: auth.accountId,
    operatorId: auth.operatorId,
    branchId: auth.branchId,
    requestId: req.id,
    assertBranchAllowed: async (branchId: string) => {
      await req.requirePermission(permission, { branchId });
    },
  };
}

/** The press: the body's action id, else the header's. */
function actionIdOf(req: FastifyRequest, bodyActionId: string | undefined): string | undefined {
  const header = req.headers['x-oto-action-id'];
  return bodyActionId ?? (typeof header === 'string' && header.length <= 200 ? header : undefined);
}

export async function eventRoutes(app: App): Promise<void> {
  const deps = (req: FastifyRequest) => ({ db: app.db, directory: app.otoAppDirectory, log: req.log });

  // --- Writes (S2-20 E2) -------------------------------------------------------

  app.post(
    '/:id/attendees',
    {
      config: { permission: 'pos:event:attendee_create', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'Add a child to an event where no money is taken at the door (`addEventAttendee`): a party walk-up, whose ' +
          "party-guest price goes on the party's tab, or a child on a free event. A camp or event that costs money is " +
          'refused 409 EVENT_PASS_NEEDS_PAYMENT with nothing written — it is sold at /passes. A camp walk-up is ' +
          'registered for today, or with `registerProperly` for every remaining camp day; the note is stamped with who ' +
          "added the child. The child is then written to the OTO App under the till's `attendeeId`: the answer says " +
          'whether the app has them (`syncState`). The same attendee id again answers what it made, under x-oto-replay.',
        params: EventParams,
        body: EventAttendeeCreateBodySchema,
        response: { 200: EventAttendeeWriteAnswerSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:event:attendee_create');
      const { answer } = await addEventAttendee(
        deps(req),
        opCtx(req),
        actor,
        req.params.id,
        { ...req.body, actionId: actionIdOf(req, req.body.actionId) },
      );
      if (answer.replayed) reply.header('x-oto-replay', 'true');
      return answer;
    },
  );

  app.post(
    '/:id/passes',
    {
      config: {
        permission: 'pos:event:pass_sell',
        target: { branchId: 'body.branchId' },
        stationTrading: true,
      },
      schema: {
        description:
          "Sell a camp or event pass (`sellEventPass`): an ordinary sale of one child's flat entry, priced from the " +
          "event at the day's rate mode (never tiered), committed and paid with the tender in ONE transaction — so no " +
          'child is added without the money, and no money is taken without the child. A party (its guests ride the ' +
          'tab) and a free event are refused. The sale prints its receipt like any other; the child is then written ' +
          "to the OTO App under the till's `attendeeId` (`syncState`). The same attendee id again answers what it made.",
        params: EventParams,
        body: EventPassSellBodySchema,
        response: { 200: EventAttendeeWriteAnswerSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:event:pass_sell');
      const { answer, drawerKick } = await sellEventPass(
        deps(req),
        opCtx(req),
        actor,
        req.params.id,
        { ...req.body, actionId: actionIdOf(req, req.body.actionId) },
      );
      // Cash in the till opens the till, once the money is committed (S2-10a O-4).
      if (drawerKick) await queueDrawerKick(app.db, opCtx(req), actor, drawerKick);
      if (answer.replayed) reply.header('x-oto-replay', 'true');
      return answer;
    },
  );
  app.get(
    '/',
    {
      config: { permission: 'pos:event:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          "The branch's events on a day — today's business date unless `date` is given: parties, camps and one-off " +
          'events, sorted by start time, a camp on every day of its range. Each carries its registered children with ' +
          "that day's check-in state, their place on the day's roster (in, out, outstanding, not today) and the " +
          'roster counts. Archived events are left out. `type` narrows to one kind.',
        querystring: EventsDayQuerySchema,
        response: { 200: EventDayAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return eventsForDay(app.db, {
        operatorId: auth.operatorId,
        branchId: req.query.branchId,
        date: req.query.date,
        type: req.query.type,
        now: new Date(),
      });
    },
  );

  app.get(
    '/passes',
    {
      config: { permission: 'pos:event:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          'The event passes the till sells on a day: each camp whose range covers the day and each one-off event on ' +
          'the day or later, at its flat weekday/weekend entry price in satang. Never a party (its guests ride the ' +
          'party tab) and never an event the OTO App has no price for. Sorted by date, then start time.',
        querystring: EventsDateQuerySchema,
        response: { 200: EventPassesAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return eventPassesFor(app.db, {
        operatorId: auth.operatorId,
        branchId: req.query.branchId,
        date: req.query.date,
        now: new Date(),
      });
    },
  );

  app.get(
    '/:id',
    {
      config: { permission: 'pos:event:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          "One of the branch's events with every registered child and every day's check-ins; the roster places and " +
          'counts are for `date`, today by default. 404 for an event of another branch or operator.',
        params: EventParams,
        querystring: EventsDateQuerySchema,
        response: { 200: EventDetailAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return eventById(app.db, {
        operatorId: auth.operatorId,
        branchId: req.query.branchId,
        eventId: req.params.id,
        date: req.query.date,
        now: new Date(),
      });
    },
  );

  app.get(
    '/:id/roster',
    {
      config: { permission: 'pos:event:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          "One event's roster on a day, today by default: its children with that day's check-ins, the headline " +
          'counts (arrived, expected, in, outstanding, all) and the ids in each group — checked in, checked out, ' +
          'outstanding and, on a camp, not registered for the day. 404 for an event of another branch or operator.',
        params: EventParams,
        querystring: EventsDateQuerySchema,
        response: { 200: EventRosterAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return eventRoster(app.db, {
        operatorId: auth.operatorId,
        branchId: req.query.branchId,
        eventId: req.params.id,
        date: req.query.date,
        now: new Date(),
      });
    },
  );
}

/**
 * S2-20 E2 — THE BRANCH'S WALK-UP PRICES (Q8), registered under `/branches`:
 * camp day, event day and party guest, each a weekday/weekend pair in satang.
 * Only the party-guest price is read anywhere (a pass is priced from its event);
 * all three are stored and shown on the Admin Events panel.
 */
export async function eventPricingRoutes(app: App): Promise<void> {
  const BranchParams = z.object({ branchId: z.string().uuid() });

  app.get(
    '/:branchId/event-drop-in-pricing',
    {
      // The board reads the party-guest price to say what a walk-up adds to the tab.
      config: { permission: 'pos:event:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "The branch's walk-up prices — camp day, event day and party guest, each weekday/weekend in satang. A " +
          'branch nobody priced answers ฿0 for each with `configured: false`, the prototype\'s own unpriced branch.',
        params: BranchParams,
        response: { 200: EventDropInPricingAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return getEventDropInPricing(app.db, { operatorId: auth.operatorId, branchId: req.params.branchId });
    },
  );

  app.put(
    '/:branchId/event-drop-in-pricing',
    {
      config: { permission: 'admin:event_pricing:manage', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "Set the branch's three walk-up prices (all of them, every time). Audited as `event_pricing.update` with " +
          'the prices before and after.',
        params: BranchParams,
        body: EventDropInPricingSchema,
        response: { 200: EventDropInPricingAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return putEventDropInPricing(app.db, opCtx(req), {
        operatorId: auth.operatorId,
        accountId: auth.accountId,
        branchId: req.params.branchId,
        pricing: req.body,
        requestId: req.id,
      });
    },
  );
}
