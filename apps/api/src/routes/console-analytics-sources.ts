import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ANALYTICS_SOURCES, ANALYTICS_SOURCE_PREFERENCES, AnalyticsSummaryQuerySchema, BranchSourceBodySchema,
  analyticsSummaryBranchIds, type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import {
  consoleRerunOf, consoleSourcePreviewOf, consoleSourcesOf, consoleSwitchSource, PREVIEW_MAX_DAYS, RERUN_MAX_DAYS,
} from '../services/console-analytics-sources';
import { opCtx } from '../services/tx';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Not a calendar date');
const count = z.number().int().nonnegative();

const ConsoleBranchSourceSchema = z.object({
  branchId: z.string().uuid(), name: z.string(),
  source: z.enum(ANALYTICS_SOURCES), preference: z.enum(ANALYTICS_SOURCE_PREFERENCES),
  lastEditedAt: z.string().datetime().nullable(), lastEditedBy: z.string().uuid().nullable(),
  mayManageSource: z.boolean(), mayRerun: z.boolean(),
}).strict();

export const ConsoleSourcesSchema = z.object({
  generatedAt: z.string().datetime(),
  basis: z.literal('whole-branch-switch'),
  branches: z.array(ConsoleBranchSourceSchema),
  omitted: z.array(z.string().uuid()),
}).strict();

export const ConsoleSourcePreviewSchema = z.object({
  branchId: z.string().uuid(),
  currentSource: z.enum(ANALYTICS_SOURCES), proposedSource: z.enum(ANALYTICS_SOURCES), unchanged: z.boolean(),
  effect: z.literal('whole-branch'),
  from: isoDate, to: isoDate, days: count, servedDays: count, emptyDays: count,
  servesFrozenOnly: z.boolean(),
  firstServedDate: isoDate.nullable(), lastServedDate: isoDate.nullable(),
  newestWrittenAt: z.string().datetime().nullable(),
}).strict();

export const ConsoleRerunSchema = z.object({
  branchId: z.string().uuid(), from: isoDate, to: isoDate, days: count,
  kind: z.literal('sales'), source: z.literal('oto_pos'), reason: z.string(),
}).strict();

/**
 * The permission is checked before the global idempotency preHandler can
 * replay a stored answer, and every write needs its key (the assistant
 * settings pattern).
 */
function keyedWrite(permission: Permission, branchOf: (req: FastifyRequest) => unknown) {
  return async (req: FastifyRequest) => {
    req.requireAuth();
    const branchId = branchOf(req);
    if (typeof branchId === 'string') await req.requirePermission(permission, { branchId });
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) throw errors.badRequest('An Idempotency-Key is required');
  };
}

export async function consoleAnalyticsSourcesRoutes(app: App): Promise<void> {
  app.get('/console/analytics/sources', {
    config: { dynamicPermission: true },
    schema: {
      description: 'Each in-scope park\'s analytics source as the model really is: one serving source for every date (oto_pos, pisell or papaya), Radar\'s independent preference, and lastEditedAt — when the switch was last edited, never an effective business date. Parks come from the Analytics read (console:analytics:read and analytics:read; foreign or unknown 404, none readable 403). mayManageSource and mayRerun report the Console write doors per park. Read-only.',
      querystring: z.object({ branches: AnalyticsSummaryQuerySchema.shape.branches }).strict(),
      response: { 200: ConsoleSourcesSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return consoleSourcesOf(app.db, {
      operatorId: auth.operatorId, effective: await req.effectivePermissions(), branchIds: analyticsSummaryBranchIds(req.query.branches),
    });
  });

  app.get('/console/analytics/sources/preview', {
    config: { dynamicPermission: true },
    schema: {
      description: `Read-only preview of switching one park to a proposed source. The switch is whole-branch: every date in the range is served from the proposed source; servedDays counts its stored days (a legacy source: its frozen days only) and emptyDays the days with no such row, which will show empty. newestWrittenAt is the newest write among the served rows. Never a date splice. Default range: the last 30 days ending on the park's current business date; at most ${PREVIEW_MAX_DAYS} days. Analytics read door at the park; foreign or unknown park 404. No writes, no audit.`,
      querystring: z.object({
        branchId: z.string().uuid(), source: z.enum(ANALYTICS_SOURCES), from: isoDate.optional(), to: isoDate.optional(),
      }).strict(),
      response: { 200: ConsoleSourcePreviewSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return consoleSourcePreviewOf(app.db, {
      operatorId: auth.operatorId, effective: await req.effectivePermissions(),
      branchId: req.query.branchId, source: req.query.source, from: req.query.from, to: req.query.to,
    });
  });

  app.put('/console/analytics/sources/:branchId', {
    config: { permission: 'console:analytics:manage_source', target: { branchId: 'params.branchId' } },
    preValidation: keyedWrite('console:analytics:manage_source', req => (req.params as { branchId?: unknown } | undefined)?.branchId),
    schema: {
      description: 'Switch one park\'s whole-branch serving source and Radar preference through the existing audited switch: serialised per park, audited before and after, and a request for what the park already has changes and records nothing. console:analytics:manage_source at the park; requires Idempotency-Key; foreign park 404. lastEditedAt is the edit time, never an effective date.',
      params: z.object({ branchId: z.string().uuid() }),
      body: BranchSourceBodySchema.strict(),
      response: { 200: ConsoleBranchSourceSchema.extend({ changed: z.boolean() }).strict() },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return consoleSwitchSource(app.db, opCtx(req), {
      operatorId: auth.operatorId, effective: await req.effectivePermissions(), actorAccountId: auth.accountId,
      branchId: req.params.branchId, body: req.body, requestId: req.id,
    });
  });

  app.post('/console/analytics/rerun', {
    config: { permission: 'console:analytics:rerun', target: { branchId: 'body.branchId' } },
    preValidation: keyedWrite('console:analytics:rerun', req => (req.body as { branchId?: unknown } | undefined)?.branchId),
    schema: {
      description: `Queue one park's own POS days, from..to (at most ${RERUN_MAX_DAYS} days, none in the future), for the existing jobs process: marks analytics.dirty_date (kind sales) only, never writes a summary row and never runs the rollup inline. It recomputes our POS figures from our own records and can never regenerate a legacy system's day: a park serving a legacy source is refused (409 ANALYTICS_RERUN_LEGACY_SOURCE), and so is a range holding frozen days of the serving source (409 ANALYTICS_RERUN_FROZEN_DAYS). Audited as analytics.rerun.request. console:analytics:rerun at the park; requires Idempotency-Key; foreign park 404.`,
      body: z.object({ branchId: z.string().uuid(), from: isoDate, to: isoDate }).strict(),
      response: { 200: ConsoleRerunSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return consoleRerunOf(app.db, opCtx(req), {
      operatorId: auth.operatorId, actorAccountId: auth.accountId,
      branchId: req.body.branchId, from: req.body.from, to: req.body.to, requestId: req.id,
    });
  });
}
