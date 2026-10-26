import { z } from 'zod';
import { ANALYTICS_SOURCES, ANALYTICS_SOURCE_PREFERENCES, AnalyticsSummaryQuerySchema, analyticsSummaryBranchIds } from '@oto/shared';
import type { App } from '../app';
import { consoleAnalyticsOf } from '../services/console-analytics';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ConsoleAnalyticsSchema = z.object({
  generatedAt: z.string().datetime(),
  basis: z.literal('stored-summary-metadata'),
  branches: z.array(z.object({
    branchId: z.string().uuid(), name: z.string(), source: z.enum(ANALYTICS_SOURCES),
    preference: z.enum(ANALYTICS_SOURCE_PREFERENCES), switchedAt: z.string().datetime().nullable(),
    formulaRows: z.array(z.object({
      source: z.enum(ANALYTICS_SOURCES), formulaVersion: z.number().int().positive(),
      dailyRows: count, hourlyRows: count, frozenDailyRows: count, provisionalDailyRows: count,
    }).strict()),
    dirtyDates: z.object({
      total: count,
      byKind: z.object({ sales: count, hourly: count, booth: count, wallet: count }).strict(),
      oldestBusinessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      newestMarkedAt: z.string().datetime().nullable(),
    }).strict(),
  }).strict()),
  omitted: z.array(z.string().uuid()),
}).strict();

export async function consoleAnalyticsRoutes(app: App): Promise<void> {
  app.get('/console/analytics', {
    config: { dynamicPermission: true },
    schema: {
      description: 'Read retained analytics metadata for branches held on both console:analytics:read and analytics:read. Source and Radar preference remain separate; switchedAt is the edit timestamp. Formula counts include all retained daily/hourly rows, not the KPI date range. Queue depth counts rows including claimed rows. Default selection is live readable branches; requested own unreadable branches are omitted, foreign or unknown IDs are 404, and no readable selection is 403. This read never switches sources or runs a job.',
      querystring: z.object({ branches: AnalyticsSummaryQuerySchema.shape.branches }).strict(),
      response: { 200: ConsoleAnalyticsSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();
    reply.header('cache-control', 'private, no-store');
    return consoleAnalyticsOf(app.db, {
      operatorId: auth.operatorId, effective, branchIds: analyticsSummaryBranchIds(req.query.branches),
    });
  });
}
