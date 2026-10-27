import { z } from 'zod';
import { INTEGRATION_EXPIRY_KEYS } from '@oto/db';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { branchReach } from '../services/access-control';
import { listCredentialExpiries, setCredentialExpiry } from '../services/integration-expiry';
import {
  INTEGRATION_TEST_KEYS,
  integrationTestHistory,
  runIntegrationTest,
} from '../services/integration-seams';
import { hasPermission } from '../services/permissions';
import { opCtx, withTx } from '../services/tx';

/**
 * SCRUM-645 (planner ruling Q26) — the Integrations page's two controls, under
 * `/ops` beside the read they extend.
 *
 *   - the credential expiry dates the owner records, read by anybody who reads
 *     Health estate-wide and written under `console:integration:manage` at
 *     operator scope — audited, keyed and replay-safe;
 *   - the test buttons, each a seam with a fake adapter, pressed only where
 *     the deployment says `OPS_TEST_CONTROLS` AND the caller holds
 *     `console:integration:test` at operator scope. No live adapter exists in
 *     this ticket, so nothing pressed here reaches a provider.
 *
 * The existing read doors are unchanged: `GET /ops/integrations` and
 * `GET /ops/health` keep `admin:health:read`.
 */

const ReadAvailability = z.enum(['ok', 'failed', 'denied', 'unknown']);
const ExpiryWindow = z.enum(['not_set', 'ok', '30_days', '7_days', 'expired']);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Not a calendar date');

const CredentialExpiryView = z.object({
  integration: z.enum(INTEGRATION_EXPIRY_KEYS),
  name: z.string(),
  purpose: z.string(),
  expiresOn: z.string().nullable(),
  daysLeft: z.number().int().nullable(),
  window: ExpiryWindow,
  setAt: z.string().nullable(),
});

export const CredentialExpiryListResponse = z.object({
  /** False for a caller whose Health reach is a branch: these dates are the operator's. */
  visible: z.boolean(),
  canManage: z.boolean(),
  availability: ReadAvailability,
  detail: z.string().nullable(),
  credentials: z.array(CredentialExpiryView),
});

const IntegrationTestRow = z.object({
  integration: z.enum(INTEGRATION_TEST_KEYS),
  label: z.string(),
  description: z.string(),
  lastRunAt: z.string().nullable(),
  lastOutcome: z.string().nullable(),
  lastOkAt: z.string().nullable(),
  lastFailedAt: z.string().nullable(),
});

export const IntegrationTestsResponse = z.object({
  /** `OPS_TEST_CONTROLS` on this deployment AND the caller holds the test permission. */
  available: z.boolean(),
  adapter: z.literal('fake'),
  availability: ReadAvailability,
  tests: z.array(IntegrationTestRow),
});

export const IntegrationTestResultResponse = z.object({
  integration: z.enum(INTEGRATION_TEST_KEYS),
  runId: z.string().uuid(),
  outcome: z.enum(['ok', 'failed']),
  adapter: z.literal('fake'),
  steps: z.array(z.object({ step: z.string(), outcome: z.enum(['ok', 'failed']) })),
  message: z.string(),
});

export async function integrationControlRoutes(app: App): Promise<void> {
  app.get(
    '/integrations/credentials',
    {
      config: { permission: 'admin:health:read' },
      schema: {
        description:
          'The credential expiry dates the owner recorded for the integrations with a known lifetime, and how far each is from its 30- and 7-day warnings. Dates only; never a credential',
        querystring: z.object({}).strict(),
        response: { 200: CredentialExpiryListResponse },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const effective = await req.effectivePermissions();
      // Answered rather than refused, like the test-controls list: a park
      // reader's Integrations page simply has no card for the operator's dates.
      if (branchReach(effective, 'admin:health:read', auth.operatorId).kind !== 'operator') {
        return { visible: false, canManage: false, availability: 'unknown' as const, detail: null, credentials: [] };
      }
      const list = await listCredentialExpiries(app.db, auth.operatorId, new Date());
      return {
        visible: true,
        canManage: hasPermission(effective, 'console:integration:manage', { operatorId: auth.operatorId, operatorOnly: true }),
        ...list,
      };
    },
  );

  app.put(
    '/integrations/:key/expiry',
    {
      config: { permission: 'console:integration:manage', target: { operator: true } },
      preValidation: async (req) => {
        req.requireAuth();
        // Before the global idempotency preHandler can replay a stored body.
        await req.requirePermission('console:integration:manage', { operatorOnly: true });
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
          throw errors.badRequest('An Idempotency-Key is required');
        }
      },
      schema: {
        description:
          "Record (or clear, with null) the date an integration's credential expires, as the owner was told it. Requires Idempotency-Key. The watch reads this date only and never asks the provider",
        params: z.object({ key: z.enum(INTEGRATION_EXPIRY_KEYS) }),
        querystring: z.object({}).strict(),
        body: z.object({ expiresOn: isoDate.nullable() }).strict(),
        response: { 200: CredentialExpiryView },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return withTx(app.db, opCtx(req), 'ops.integration_expiry_set', async (tx) => {
        const saved = await setCredentialExpiry(tx, {
          operatorId: auth.operatorId,
          accountId: auth.accountId,
          key: req.params.key,
          expiresOn: req.body.expiresOn,
          now: new Date(),
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: null,
          action: 'ops.integration_expiry_set',
          entityType: 'integration_credential_expiry',
          entityId: saved.id,
          before: { integration: req.params.key, expiresOn: saved.before.expiresOn },
          after: { integration: req.params.key, expiresOn: saved.after.expiresOn },
          requestId: req.id,
        });
        return saved.after;
      });
    },
  );

  app.get(
    '/integrations/tests',
    {
      config: { permission: 'admin:health:read' },
      schema: {
        description:
          'The integration test buttons, whether this caller may press them here, and when each last ran. Every adapter behind them is a local fake',
        querystring: z.object({}).strict(),
        response: { 200: IntegrationTestsResponse },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const effective = await req.effectivePermissions();
      const available =
        app.env.OPS_TEST_CONTROLS &&
        hasPermission(effective, 'console:integration:test', { operatorId: auth.operatorId, operatorOnly: true });
      return { available, ...(await integrationTestHistory(app.db)) };
    },
  );

  app.post(
    '/integrations/:key/test',
    {
      config: { permission: 'console:integration:test', target: { operator: true } },
      preValidation: async (req) => {
        req.requireAuth();
        // The deployment's half of the gate first: on production the button
        // does not exist, whoever presses it.
        if (!app.env.OPS_TEST_CONTROLS) {
          throw errors.forbidden('Integration test controls are off on this deployment');
        }
        await req.requirePermission('console:integration:test', { operatorOnly: true });
      },
      schema: {
        description:
          "Run one integration's harmless round trip through its seam — every adapter is a local fake in this release — and record it as an ops_run of kind integration",
        params: z.object({ key: z.enum(INTEGRATION_TEST_KEYS) }),
        querystring: z.object({}).strict(),
        response: { 200: IntegrationTestResultResponse },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const result = await runIntegrationTest(app.db, req.params.key, {
        operatorId: auth.operatorId,
        accountId: auth.accountId,
        requestId: req.id,
      });
      await withTx(app.db, opCtx(req), 'ops.integration_test', async (tx) => {
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: null,
          action: 'ops.integration_test',
          entityType: 'ops_run',
          entityId: result.runId,
          after: { integration: result.integration, outcome: result.outcome, adapter: result.adapter },
          requestId: req.id,
        });
      });
      return result;
    },
  );
}
