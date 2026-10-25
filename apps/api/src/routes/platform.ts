import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { WATCHDOG_JOB } from '../services/jobs';
import { isPlatformWide } from '../services/permissions';
import { platformAlertsOf, platformEnvironmentOf, platformJobsOf } from '../services/platform';

const timestamp = z.string().datetime();
const count = z.number().int().nonnegative().safe();
const alertRow = z.object({
  id: z.string().uuid(), key: z.string(), severity: z.enum(['info', 'warning', 'critical']),
  title: z.string(), detail: z.string().nullable(), openedAt: timestamp,
  acknowledgedAt: timestamp.nullable(), resolvedAt: timestamp.nullable(), count,
}).strict();
export const PlatformAlertsSchema = z.object({
  generatedAt: timestamp, alerts: z.array(alertRow), total: count, limit: count, offset: count,
}).strict();
export const PlatformJobsSchema = z.object({
  generatedAt: timestamp,
  jobs: z.array(z.object({
    name: z.string(), status: z.enum(['ok', 'warn', 'down', 'unknown']), lastRunAt: timestamp.nullable(),
    lastOutcome: z.string().nullable(), expectedEverySeconds: count.nullable(), ageSeconds: count.nullable(),
    lastError: z.string().nullable(), waitingOn: z.array(z.string()),
  }).strict()),
}).strict();
export const PlatformEnvironmentSchema = z.object({
  generatedAt: timestamp,
  variables: z.array(z.object({
    name: z.string(), present: z.boolean(), required: z.boolean(), purpose: z.string(), provider: z.string().nullable(),
  }).strict()),
}).strict();

export async function platformRoutes(app: App): Promise<void> {
  const requirePlatform = async (req: FastifyRequest) => {
    const auth = req.requireAuth();
    if (!isPlatformWide(await req.effectivePermissions())) throw errors.forbidden('Platform administrator only');
    return auth;
  };
  app.get('/platform/alerts', {
    config: { permission: 'admin:health:read', target: { operator: true }, platformWide: true },
    schema: {
      description: 'Platform-only alert rows (operator_id IS NULL), with the native summary, subject, severity and occurrence count. ' +
        'Open includes acknowledged unresolved conditions; resolved follows resolvedAt. Ordered by latest detection and stable ID. No alert action is performed.',
      querystring: z.object({
        state: z.enum(['open', 'resolved', 'all']).default('open'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().nonnegative().safe().default(0),
      }).strict(),
      response: { 200: PlatformAlertsSchema },
    },
  }, async (req, reply) => {
    await requirePlatform(req);
    reply.header('cache-control', 'private, no-store');
    return platformAlertsOf(app.db, req.query);
  });
  app.get('/platform/jobs', {
    config: { permission: 'admin:health:read', target: { operator: true }, platformWide: true },
    schema: {
      description: 'The existing persisted job register, including disabled, muted, undeclared, refused and waiting-on states. No runner or job is started.',
      querystring: z.object({}).strict(), response: { 200: PlatformJobsSchema },
    },
  }, async (req, reply) => {
    const auth = await requirePlatform(req);
    reply.header('cache-control', 'private, no-store');
    return platformJobsOf({ db: app.db, operatorId: auth.operatorId, watchdogJob: WATCHDOG_JOB,
      watchdogIntervalSeconds: app.env.WATCHDOG_INTERVAL_S, failureThreshold: app.env.ALERT_FAILURE_THRESHOLD });
  });
  app.get('/platform/environment', {
    config: { permission: 'admin:health:read', target: { operator: true }, platformWide: true },
    schema: {
      description: 'The nineteen native Integrations variable names, presence and requirement metadata. No values, endpoints or provider probes.',
      querystring: z.object({}).strict(), response: { 200: PlatformEnvironmentSchema },
    },
  }, async (req, reply) => {
    await requirePlatform(req);
    reply.header('cache-control', 'private, no-store');
    return platformEnvironmentOf(app.env);
  });
}
