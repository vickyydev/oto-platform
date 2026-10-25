import { z } from 'zod';
import { ANALYTICS_SOURCES } from '@oto/shared';
import type { App } from '../app';
import { overviewOf } from '../services/console';
import { consoleRoutingRoutes } from './console-routing';
import { consoleStaffRoutes } from './console-staff';

const count = z.number().int().nonnegative();
const figures = z.object({
  revenueSatang: z.number().int(), guests: count, inParkNow: count, bookingsToday: count,
  inboxUnanswered: count, openAlerts: count, boxesOffline: count,
});
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const OverviewSchema = z.object({
  generatedAt: z.string().datetime(),
  branches: z.array(z.object({
    id: z.string().uuid(), name: z.string(), timezone: z.string(), businessDayStart: z.string(), businessDate: isoDate,
  })),
  selectedBranchIds: z.array(z.string().uuid()),
  totals: figures,
  parks: z.array(figures.extend({
    branchId: z.string().uuid(), businessDate: isoDate, analyticsSource: z.enum(ANALYTICS_SOURCES),
    provisional: z.boolean(), lastRolledUpAt: z.string().datetime().nullable(),
    occupancyAsOf: z.string().datetime().nullable(), occupancyStale: z.boolean(),
  })),
});

export async function consoleRoutes(app: App): Promise<void> {
  await app.register(consoleRoutingRoutes);
  await app.register(consoleStaffRoutes);
  app.get('/overview', {
    config: { dynamicPermission: true },
    schema: {
      description:
        'Today at the live parks within console:overview:read reach, independent of the session seat. ' +
        'The optional branchId selects one reachable park. Revenue and guests use each park’s business date, ' +
        'selected analytics source and stored rollup, with its provisional and freshness marks. Bookings count ' +
        'every state for that visit date. Inbox unanswered reuses its existing rule; alerts are unresolved. ' +
        'These park counts exclude branchless Inbox conversations and operator/platform alerts. Offline boxes ' +
        'use their reported offline status at any hour; alerting hours are unchanged. Summary-only authority: ' +
        'linked screens retain their own permissions. Foreign, absent or archived park: 404; own unreachable park: 403.',
      querystring: z.object({ branchId: z.string().uuid().optional() }),
      response: { 200: OverviewSchema },
    },
  }, async (req) => {
    const auth = req.requireAuth();
    return overviewOf(app.db, {
      operatorId: auth.operatorId, effective: await req.effectivePermissions(), branchId: req.query.branchId,
    });
  });
}
