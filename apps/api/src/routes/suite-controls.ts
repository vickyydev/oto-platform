import { z } from 'zod';
import { APP_TILE_STATES, SUITE_APP_KEYS } from '@oto/db';
import type { App } from '../app';
import { suiteAgentVersionsOf, suiteAppsOf, suiteReleasesOf } from '../services/suite-controls';

export const SuiteAppsSchema = z.object({
  generatedAt: z.string().datetime(),
  apps: z.array(z.object({
    id: z.string().uuid(), key: z.enum(SUITE_APP_KEYS), name: z.string(), purpose: z.string(),
    origins: z.record(z.string().url()), schemaName: z.string(), owningService: z.string(),
    healthUrl: z.string().url().nullable(), versionSource: z.string(), requiredPermission: z.string(),
    sortOrder: z.number().int(), storedState: z.enum(APP_TILE_STATES), effectiveState: z.enum(APP_TILE_STATES),
    revision: z.number().int().positive(),
    maintenance: z.object({ message: z.string(), expiresAt: z.string().datetime() }).strict().nullable(),
  }).strict()),
}).strict();

export const SuiteReleasesSchema = z.object({
  generatedAt: z.string().datetime(), total: z.number().int().nonnegative(),
  limit: z.number().int().positive(), offset: z.number().int().nonnegative(),
  deployments: z.array(z.object({
    id: z.string().uuid(), app: z.enum(SUITE_APP_KEYS), appName: z.string(),
    version: z.string().nullable(), commit: z.string().nullable(), actorAccountId: z.string().uuid().nullable(),
    status: z.string(), ciGreen: z.boolean().nullable(), deployedAt: z.string().datetime().nullable(),
    recordedAt: z.string().datetime(),
  }).strict()),
}).strict();

export const SuiteAgentVersionsSchema = z.object({
  generatedAt: z.string().datetime(), operatorId: z.string().uuid(), minimumSupportedVersion: z.string(),
  total: z.number().int().nonnegative(), limit: z.number().int().positive(), offset: z.number().int().nonnegative(),
  agents: z.array(z.object({
    id: z.string().uuid(), name: z.string(), slot: z.string(), branchId: z.string().uuid(), branchName: z.string(),
    agentVersion: z.string().nullable(), lastHeartbeatAt: z.string().datetime().nullable(), belowMinimum: z.boolean().nullable(),
  }).strict()),
}).strict();

export async function suiteControlRoutes(app: App): Promise<void> {
  app.get('/console/apps', {
    config: { permission: 'console:app_registry:read', target: { operator: true } },
    schema: {
      description: 'The current suite registry. Expired maintenance resolves to its saved tile state without a read changing storage. Only public HTTP(S) locations are returned; no provider is contacted.',
      querystring: z.object({}).strict(), response: { 200: SuiteAppsSchema },
    },
  }, async (_req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return suiteAppsOf(app.db);
  });
  app.get('/console/releases', {
    config: { permission: 'console:release:read', target: { operator: true } },
    schema: {
      description: 'Recorded deployment history, newest recorded event first, with nullable unknown version/commit/actor/CI/deployment time. No inferred release or deploy action. Archived apps are excluded.',
      querystring: z.object({
        app: z.enum(SUITE_APP_KEYS).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      }).strict(), response: { 200: SuiteReleasesSchema },
    },
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return suiteReleasesOf(app.db, req.query);
  });
  app.get('/console/releases/agents', {
    config: { permission: 'console:release:read', target: { operator: true } },
    schema: {
      description: 'Current operator box agent versions and the existing fleet minimum. Both box and branch ownership are required; unknown versions remain unknown. No box action or policy change.',
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict(),
      response: { 200: SuiteAgentVersionsSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return suiteAgentVersionsOf(app.db, auth.operatorId, req.query);
  });
}
