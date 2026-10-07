import { z } from 'zod';
import {
  EventDayAnswerSchema,
  EventDetailAnswerSchema,
  EventPassesAnswerSchema,
  EventRosterAnswerSchema,
  EventsDateQuerySchema,
  EventsDayQuerySchema,
} from '@oto/shared';
import type { App } from '../app';
import { eventById, eventPassesFor, eventRoster, eventsForDay } from '../services/events';

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

export async function eventRoutes(app: App): Promise<void> {
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
