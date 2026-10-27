import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  APP_TILE_STATES, FLAG_KINDS, FLAG_SCOPE_TYPES, flagCatalogueEntry, SUITE_APP_KEYS, SUITE_CONTROL_APPROVAL_STATES,
  suiteControlApproval, type FlagScopeType, type FlagValue,
} from '@oto/db';
import type { Permission } from '@oto/shared';
import type { App } from '../app';
import { AppError, errors } from '../lib/errors';
import { ClientIdSchema } from '../services/client-id';
import { buildAlertChannels } from '../services/ops';
import {
  approveSuiteControlApproval, consumeSuiteControlApproval, lockAdministrators, requestSuiteControlApproval,
} from '../services/suite-control-approvals';
import { applyMaintenanceClear, applyMaintenanceSet, launcherAppsOf, recordDeployEvent, registryNameOf } from '../services/suite-controls';
import {
  applyFlagClear, applyFlagSet, endSuiteControlAlert, flagAlertKey, KILL_SWITCH_DEFAULT_TTL_MIN, maintenanceAlertKey,
  previewFlag, raiseSuiteControlAlert, suiteFlagsOf, validateFlagSet,
} from '../services/suite-flags';
import { opCtx, withTx } from '../services/tx';

/**
 * SCRUM-643 (S2-23 release controls, planner ruling Q24): the launcher's own
 * registry read, maintenance, flags and kill switches with their two-admin
 * approval, the blast-radius preview and the deploy-history seam.
 *
 * Every write is platform-only (the permission held at null operator scope,
 * re-checked against the system `platform_admin` role inside the
 * transaction), takes a typed confirmation and a reason, is keyed for
 * replay, and writes its audit row with `target_app`, `reason` and
 * `origin = 'console'` in the same transaction as the change.
 */

const ScopeTypeSchema = z.enum(FLAG_SCOPE_TYPES);
const FlagValueSchema = z.union([z.boolean(), z.string().min(1).max(64)]);
const ConfirmationSchema = z.string().min(1).max(128);
const ReasonSchema = z.string().trim().min(1).max(1000);
const RevisionSchema = z.number().int().min(0).max(2_147_483_647);

export const LauncherAppsSchema = z.object({
  generatedAt: z.string().datetime(),
  apps: z.array(z.object({
    key: z.enum(SUITE_APP_KEYS), sortOrder: z.number().int(), state: z.enum(APP_TILE_STATES),
    maintenance: z.object({ message: z.string(), expiresAt: z.string().datetime() }).strict().nullable(),
  }).strict()),
}).strict();

const RegistryWriteSchema = z.object({
  app: z.object({
    appKey: z.enum(SUITE_APP_KEYS), tileState: z.enum(APP_TILE_STATES), maintenanceMessage: z.string().nullable(),
    maintenanceExpiresAt: z.string().datetime().nullable(),
    maintenanceRestoreState: z.enum(APP_TILE_STATES).nullable(), revision: z.number().int().positive(),
  }).strict(),
}).strict();

const FlagViewSchema = z.object({
  id: z.string().uuid(), flagKey: z.string(), kind: z.enum(FLAG_KINDS), targetApp: z.enum(SUITE_APP_KEYS),
  scopeType: ScopeTypeSchema, scopeId: z.string().uuid().nullable(), operatorId: z.string().uuid().nullable(),
  value: FlagValueSchema, expiresAt: z.string().datetime().nullable(), reason: z.string().nullable(),
  updatedBy: z.string().uuid().nullable(), revision: z.number().int().positive(), updatedAt: z.string().datetime(),
}).strict();

const OperationSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal('kill_switch.set'), flagKey: z.string(), targetApp: z.enum(SUITE_APP_KEYS),
  scopeType: ScopeTypeSchema, scopeId: z.string().uuid().nullable(), operatorId: z.string().uuid().nullable(),
  expectedRevision: z.number().int(), value: z.union([z.boolean(), z.number(), z.string(), z.null()]),
  expiresAt: z.string().datetime(), reason: z.string(),
}).strict();

const ApprovalViewSchema = z.object({
  id: z.string().uuid(), state: z.enum(SUITE_CONTROL_APPROVAL_STATES), payloadSha256: z.string(),
  operatorId: z.string().uuid().nullable(), requesterAccountId: z.string().uuid(), approverAccountId: z.string().uuid().nullable(),
  operation: OperationSchema, createdAt: z.string().datetime(), requestExpiresAt: z.string().datetime(),
}).strict();

export const SuiteFlagsSchema = z.object({
  generatedAt: z.string().datetime(), maxTtlMinutes: z.number().int().positive(),
  defaultTtlMinutes: z.number().int().positive(), killSwitchDualControl: z.boolean(),
  catalogue: z.array(z.object({
    flagKey: z.string(), kind: z.enum(FLAG_KINDS), targetApp: z.enum(SUITE_APP_KEYS), label: z.string(), effect: z.string(),
    valueType: z.enum(['boolean', 'enum']), values: z.array(z.string()).nullable(), defaultValue: FlagValueSchema,
    scopes: z.array(ScopeTypeSchema), supported: z.boolean(),
  }).strict()),
  overrides: z.array(FlagViewSchema.extend({ expired: z.boolean() }).strict()),
  approvals: z.array(z.object({
    id: z.string().uuid(), state: z.enum(SUITE_CONTROL_APPROVAL_STATES), payloadSha256: z.string(),
    requesterAccountId: z.string().uuid(), approverAccountId: z.string().uuid().nullable(),
    operation: z.record(z.unknown()), createdAt: z.string().datetime(), requestExpiresAt: z.string().datetime(),
  }).strict()),
}).strict();

const PreviewSchema = z.object({
  generatedAt: z.string().datetime(), flagKey: z.string(), label: z.string(), effect: z.string(), targetApp: z.enum(SUITE_APP_KEYS),
  scopeType: ScopeTypeSchema, scopeId: z.string().uuid().nullable(), operatorId: z.string().uuid().nullable(), value: FlagValueSchema,
  branches: z.array(z.object({ branchId: z.string().uuid(), name: z.string(), operatorId: z.string().uuid(),
    current: FlagValueSchema, after: FlagValueSchema }).strict()),
  stations: z.array(z.object({ stationId: z.string().uuid(), name: z.string(), branchId: z.string().uuid(),
    current: FlagValueSchema, after: FlagValueSchema }).strict()),
  openSessions: z.number().int().nonnegative(), changes: z.number().int().nonnegative(),
}).strict();

const FlagTargetBody = {
  key: z.string().min(1).max(128), scopeType: ScopeTypeSchema, scopeId: z.string().uuid().nullable(),
  operatorId: z.string().uuid().nullable(),
};
const FlagSetBodySchema = z.object({
  ...FlagTargetBody, value: FlagValueSchema, expiresAt: z.string().datetime().nullable().optional(),
  reason: ReasonSchema, expectedRevision: RevisionSchema, confirmation: ConfirmationSchema,
}).strict();
const ApprovalRefBody = z.object({
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/), confirmation: ConfirmationSchema,
}).strict();

function idempotencyKeyRequired(req: FastifyRequest) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) throw errors.badRequest('An Idempotency-Key is required');
}

/** Platform authority, before the replay store can answer: the permission held platform-wide (null operator scope). */
async function requirePlatformHolder(req: FastifyRequest, permission: Permission) {
  req.requireAuth();
  await req.requirePermission(permission, { operatorOnly: true });
  const held = (await req.effectivePermissions())
    .some(grant => grant.permission === permission && grant.scopeType === 'operator' && grant.scopeId === null);
  if (!held) throw errors.forbidden('Platform administrator only');
}

/** A flag write's permission follows the catalogue: a kill switch needs the kill-switch grant, and so does anything unknown. */
function flagWritePermission(body: unknown): Permission {
  const key = body && typeof body === 'object' ? (body as { key?: unknown }).key : undefined;
  const entry = typeof key === 'string' ? flagCatalogueEntry(key) : undefined;
  return entry?.kind === 'feature' ? 'console:release:flag_manage' : 'console:release:kill_switch';
}

/** The reviewed operation as the API presents it: `flagKey` for the stored `key` (the digest is over the stored form). */
function presented<T extends { operation: { key: string } }>(view: T) {
  const { key, ...operation } = view.operation;
  return { ...view, operation: { ...operation, flagKey: key } };
}

function confirmed(typed: string, expected: string) {
  if (typed !== expected) throw new AppError(400, 'CONFIRMATION_MISMATCH', `Type ${expected} exactly to confirm this change.`);
}

type AlertedFlag = { flagKey: string; scopeType: FlagScopeType; scopeId: string | null; operatorId: string | null; expiresAt: string | null };
const scopeWords = (scopeType: FlagScopeType, scopeId: string | null) => `${scopeType}${scopeId ? ` ${scopeId}` : ''}`;

export async function suiteControlWriteRoutes(app: App): Promise<void> {
  const settings = () => ({ maxTtlMinutes: app.env.KILL_SWITCH_MAX_TTL_MIN });
  const dualControl = () => app.env.CONSOLE_DUAL_CONTROL.has('kill_switch');
  const alertDeps = (req: FastifyRequest) => ({
    channels: buildAlertChannels(app.env.ALERT_CHANNELS, req.log), flapWindowSeconds: app.env.ALERT_FLAP_WINDOW_S, log: req.log,
  });
  /** Alerts follow the commit; one that cannot be raised never undoes the change it describes. */
  const afterCommit = async (req: FastifyRequest, work: () => Promise<void>) => {
    try { await work(); } catch (err) { req.log.error({ err }, 'suite control alert could not be raised'); }
  };
  const alertOn = (req: FastifyRequest, flag: AlertedFlag) => {
    const label = flagCatalogueEntry(flag.flagKey)?.label ?? flag.flagKey;
    return raiseSuiteControlAlert(app.db, alertDeps(req), { key: flagAlertKey(flag.flagKey, flag.scopeType, flag.scopeId), subject: label,
      summary: `${label} is on (${scopeWords(flag.scopeType, flag.scopeId)}) until ${flag.expiresAt}`,
      operatorId: flag.operatorId, branchId: flag.scopeType === 'branch' ? flag.scopeId : null });
  };
  const approvalKey = async (id: string) => {
    const [row] = await app.db.select({ operation: suiteControlApproval.operation }).from(suiteControlApproval)
      .where(eq(suiteControlApproval.id, id));
    if (!row) throw errors.notFound('Approval not found.');
    const key = (row.operation as { key?: unknown }).key;
    return typeof key === 'string' ? key : '';
  };

  app.get('/suite/apps', {
    config: { auth: 'session' },
    schema: {
      description: 'The launcher\'s read of the suite registry: the effective tile state and any maintenance message of each app the signed-in person already holds `app:<key>:access` for. No Console permission is needed and no origin or service detail is returned.',
      querystring: z.object({}).strict(), response: { 200: LauncherAppsSchema },
    },
  }, async (req, reply) => {
    req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    const held = new Set((await req.effectivePermissions()).map(grant => grant.permission));
    return launcherAppsOf(app.db, held);
  });

  app.get('/console/flags', {
    config: { permission: 'console:release:read', target: { operator: true } },
    schema: {
      description: 'The typed flag and kill-switch catalogue (unsupported switches are listed but cannot be set), every stored override with whether it has expired, and the open two-admin approvals. Expired overrides already resolve to the catalogue default.',
      querystring: z.object({}).strict(), response: { 200: SuiteFlagsSchema },
    },
  }, async (_req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return suiteFlagsOf(app.db, { ...settings(), dualControl: dualControl() });
  });

  app.get('/console/flags/preview', {
    config: { permission: 'console:release:read', target: { operator: true } },
    schema: {
      description: 'Blast-radius preview: what setting this switch would change at every live park and station it reaches, computed by the same resolver enforcement uses, and how many staff sessions are open there. Writes nothing.',
      querystring: z.object({
        key: z.string().min(1).max(128), scopeType: ScopeTypeSchema, scopeId: z.string().uuid().optional(),
        operatorId: z.string().uuid().optional(), value: z.string().min(1).max(64),
      }).strict(),
      response: { 200: PreviewSchema },
    },
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    const q = req.query;
    const value = q.value === 'true' ? true : q.value === 'false' ? false : q.value;
    return previewFlag(app.db, { key: q.key, scopeType: q.scopeType, scopeId: q.scopeId ?? null, operatorId: q.operatorId ?? null, value });
  });

  app.put('/console/apps/:key/maintenance', {
    config: { permission: 'console:app_registry:manage', target: { operator: true }, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:app_registry:manage'); idempotencyKeyRequired(req); },
    schema: {
      description: 'Put one app into maintenance (or change its open window): the launcher tile shows the message and new hand-offs into this app are refused with APP_IN_MAINTENANCE. Existing sessions, platform sign-in and other apps are untouched. Platform administrator only; typed confirmation of the app key, a reason, and an expiry within KILL_SWITCH_MAX_TTL_MIN (default 60 minutes). Requires Idempotency-Key.',
      params: z.object({ key: z.enum(SUITE_APP_KEYS) }).strict(),
      body: z.object({
        message: z.string().trim().min(1).max(500), expiresAt: z.string().datetime().nullable().optional(),
        reason: ReasonSchema, expectedRevision: RevisionSchema, confirmation: ConfirmationSchema,
      }).strict(),
      response: { 200: RegistryWriteSchema },
    },
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    confirmed(req.body.confirmation, req.params.key);
    const ctx = opCtx(req);
    const out = await withTx(app.db, ctx, 'app_registry.maintenance_set', async tx => {
      await lockAdministrators(tx, [req.requireAuth().accountId], 'console:app_registry:manage');
      return applyMaintenanceSet(tx, ctx, { app: req.params.key, message: req.body.message,
        expiresAt: req.body.expiresAt ?? null, reason: req.body.reason, expectedRevision: req.body.expectedRevision }, settings());
    });
    await afterCommit(req, async () => {
      const name = await registryNameOf(app.db, req.params.key);
      await raiseSuiteControlAlert(app.db, alertDeps(req), { key: maintenanceAlertKey(req.params.key), subject: `${name} maintenance`,
        summary: `${name} is in maintenance until ${out.app.maintenanceExpiresAt}`, operatorId: null, branchId: null });
    });
    return out;
  });

  app.post('/console/apps/:key/maintenance/clear', {
    config: { permission: 'console:app_registry:manage', target: { operator: true }, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:app_registry:manage'); idempotencyKeyRequired(req); },
    schema: {
      description: 'End an app\'s maintenance now and restore the tile state it replaced. Platform administrator only; typed confirmation of the app key and a reason. Requires Idempotency-Key.',
      params: z.object({ key: z.enum(SUITE_APP_KEYS) }).strict(),
      body: z.object({ reason: ReasonSchema, expectedRevision: RevisionSchema, confirmation: ConfirmationSchema }).strict(),
      response: { 200: RegistryWriteSchema },
    },
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    confirmed(req.body.confirmation, req.params.key);
    const ctx = opCtx(req);
    const out = await withTx(app.db, ctx, 'app_registry.maintenance_clear', async tx => {
      await lockAdministrators(tx, [req.requireAuth().accountId], 'console:app_registry:manage');
      return applyMaintenanceClear(tx, ctx, { app: req.params.key, reason: req.body.reason, expectedRevision: req.body.expectedRevision });
    });
    await afterCommit(req, async () => {
      const name = await registryNameOf(app.db, req.params.key);
      await endSuiteControlAlert(app.db, alertDeps(req), { key: maintenanceAlertKey(req.params.key), subject: `${name} maintenance`,
        summary: `${name} maintenance was ended`, reason: 'cleared', operatorId: null, branchId: null });
    });
    return out;
  });

  app.put('/console/flags', {
    config: { dynamicPermission: true, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, flagWritePermission(req.body)); idempotencyKeyRequired(req); },
    schema: {
      description: 'Set a supported flag at one scope after reviewing its preview. A kill switch carries an expiry (default 60 minutes, at most KILL_SWITCH_MAX_TTL_MIN) and, while CONSOLE_DUAL_CONTROL names kill_switch, is refused here with SECOND_APPROVAL_REQUIRED: request and apply it through /console/flags/approvals. Unknown and unsupported keys are refused. Typed confirmation of the key; requires Idempotency-Key.',
      body: FlagSetBodySchema, response: { 200: z.object({ flag: FlagViewSchema }).strict() },
    },
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    const body = req.body;
    confirmed(body.confirmation, body.key);
    const entry = flagCatalogueEntry(body.key);
    if (entry?.supported && entry.kind === 'kill_switch' && dualControl()) {
      throw new AppError(403, 'SECOND_APPROVAL_REQUIRED', 'A second platform administrator must approve this switch first.');
    }
    const now = new Date();
    const expiresAt = body.expiresAt ?? (entry?.kind === 'kill_switch'
      ? new Date(now.getTime() + KILL_SWITCH_DEFAULT_TTL_MIN * 60_000).toISOString() : null);
    const ctx = opCtx(req);
    // The transaction returns exactly the response, so the replay store keeps the same answer.
    const out = await withTx(app.db, ctx, 'feature_flag.set', async tx => {
      await lockAdministrators(tx, [req.requireAuth().accountId], flagWritePermission(body));
      return { flag: await applyFlagSet(tx, ctx, { key: body.key, scopeType: body.scopeType, scopeId: body.scopeId,
        operatorId: body.operatorId, expectedRevision: body.expectedRevision, value: body.value, expiresAt, reason: body.reason },
      settings(), now) };
    });
    if (entry?.kind === 'kill_switch') await afterCommit(req, () => alertOn(req, out.flag));
    return out;
  });

  app.post('/console/flags/clear', {
    config: { dynamicPermission: true, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, flagWritePermission(req.body)); idempotencyKeyRequired(req); },
    schema: {
      description: 'Return a flag at one scope to normal now; the catalogue default applies at once. Platform administrator only; typed confirmation of the key and a reason. Requires Idempotency-Key.',
      body: z.object({ ...FlagTargetBody, expectedRevision: RevisionSchema, reason: ReasonSchema, confirmation: ConfirmationSchema }).strict(),
      response: { 200: z.object({ flagKey: z.string(), cleared: FlagViewSchema }).strict() },
    },
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    const body = req.body;
    confirmed(body.confirmation, body.key);
    const ctx = opCtx(req);
    const out = await withTx(app.db, ctx, 'feature_flag.clear', async tx => {
      await lockAdministrators(tx, [req.requireAuth().accountId], flagWritePermission(body));
      return applyFlagClear(tx, ctx, { key: body.key, scopeType: body.scopeType, scopeId: body.scopeId,
        operatorId: body.operatorId, expectedRevision: body.expectedRevision, reason: body.reason });
    });
    const label = flagCatalogueEntry(out.flagKey)?.label ?? out.flagKey;
    await afterCommit(req, () => endSuiteControlAlert(app.db, alertDeps(req), {
      key: flagAlertKey(out.flagKey, out.cleared.scopeType, out.cleared.scopeId), subject: label,
      summary: `${label} was turned off (${scopeWords(out.cleared.scopeType, out.cleared.scopeId)})`, reason: 'cleared',
      operatorId: out.cleared.operatorId, branchId: out.cleared.scopeType === 'branch' ? out.cleared.scopeId : null }));
    return out;
  });

  app.post('/console/flags/approvals', {
    config: { permission: 'console:release:kill_switch', target: { operator: true }, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:release:kill_switch'); idempotencyKeyRequired(req); },
    schema: {
      description: 'Ask a second platform administrator to approve one exact kill-switch change. The change is validated now (catalogue, supported, scope lineage, value, expiry) and bound by its digest; a different administrator must approve it within ten minutes, and either of the two then applies it. Typed confirmation of the key; requires Idempotency-Key.',
      body: FlagSetBodySchema, response: { 200: ApprovalViewSchema },
    },
  }, async req => {
    const body = req.body;
    confirmed(body.confirmation, body.key);
    const entry = flagCatalogueEntry(body.key);
    if (entry && entry.kind !== 'kill_switch') {
      throw new AppError(400, 'APPROVAL_NOT_APPLICABLE', 'Only a kill switch is approved by a second administrator.');
    }
    const now = new Date();
    const expiresAt = new Date(body.expiresAt ?? now.getTime() + KILL_SWITCH_DEFAULT_TTL_MIN * 60_000).toISOString();
    const input = { key: body.key, scopeType: body.scopeType, scopeId: body.scopeId, operatorId: body.operatorId,
      expectedRevision: body.expectedRevision, value: body.value, expiresAt, reason: body.reason };
    const checked = await app.db.transaction(tx => validateFlagSet(tx, input, settings(), now));
    return presented(await requestSuiteControlApproval(app.db, opCtx(req), { schemaVersion: 1, action: 'kill_switch.set', key: checked.entry.key,
      targetApp: checked.entry.targetApp, scopeType: body.scopeType, scopeId: body.scopeId, operatorId: body.operatorId,
      expectedRevision: body.expectedRevision, value: body.value, expiresAt, reason: checked.reason }));
  });

  app.post('/console/flags/approvals/:id/approve', {
    config: { permission: 'console:release:kill_switch', target: { operator: true }, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:release:kill_switch'); idempotencyKeyRequired(req); },
    schema: {
      description: 'Approve another platform administrator\'s exact reviewed kill-switch change within ten minutes of its request. The requester cannot approve their own, and an expired request is recorded as expired. Typed confirmation of the key; requires Idempotency-Key.',
      params: z.object({ id: z.string().uuid() }).strict(), body: ApprovalRefBody, response: { 200: ApprovalViewSchema },
    },
  }, async req => {
    confirmed(req.body.confirmation, await approvalKey(req.params.id));
    // The expiry outcome must commit even though this request then fails, so this
    // transaction stores no replay answer of its own; a success is stored as usual.
    const { idempotency: _replay, ...ctx } = opCtx(req);
    const view = await approveSuiteControlApproval(app.db, ctx, { id: req.params.id, expectedPayloadSha256: req.body.expectedPayloadSha256 });
    if (view.state === 'expired') throw new AppError(409, 'APPROVAL_EXPIRED', 'This request was not approved within ten minutes; ask again.');
    return presented(view);
  });

  app.post('/console/flags/approvals/:id/apply', {
    config: { permission: 'console:release:kill_switch', target: { operator: true }, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:release:kill_switch'); idempotencyKeyRequired(req); },
    schema: {
      description: 'Apply an approved kill-switch change, by its requester or its approver, before the ten-minute approval and the switch\'s own expiry pass. Catalogue, lineage, value, revision and maximum expiry are checked again in the transaction that consumes the approval. Requires Idempotency-Key.',
      params: z.object({ id: z.string().uuid() }).strict(), body: ApprovalRefBody,
      response: { 200: z.object({ flag: FlagViewSchema, approval: ApprovalViewSchema }).strict() },
    },
  }, async req => {
    confirmed(req.body.confirmation, await approvalKey(req.params.id));
    const { idempotency: _replay, ...ctx } = opCtx(req);
    const out = await withTx(app.db, ctx, 'feature_flag.set', tx => consumeSuiteControlApproval(tx, ctx,
      { id: req.params.id, expectedPayloadSha256: req.body.expectedPayloadSha256 },
      (etx, op) => applyFlagSet(etx, ctx, { key: op.key, scopeType: op.scopeType, scopeId: op.scopeId, operatorId: op.operatorId,
        expectedRevision: op.expectedRevision, value: op.value as FlagValue, expiresAt: op.expiresAt, reason: op.reason }, settings())));
    const flag = 'result' in out ? out.result : undefined;
    if (!flag) throw new AppError(409, 'APPROVAL_EXPIRED', 'This approval ran out before it was applied; ask again.');
    await afterCommit(req, () => alertOn(req, flag));
    return { flag, approval: presented(out.approval) };
  });

  app.post('/console/deploy-events', {
    config: { permission: 'console:app_registry:manage', target: { operator: true }, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:app_registry:manage'); idempotencyKeyRequired(req); },
    schema: {
      description: 'Record one deployment fact for the release history exactly as supplied, under a caller-minted id (the same event again answers the same; a different event under that id is refused). Starts no deploy and infers nothing: an unknown version, commit, CI result or time stays null. Platform administrator only; requires Idempotency-Key.',
      body: z.object({
        id: ClientIdSchema, app: z.enum(SUITE_APP_KEYS),
        status: z.string().regex(/^[a-z][a-z_]{1,39}$/), version: z.string().trim().min(1).max(64).nullable(),
        commit: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(), ciGreen: z.boolean().nullable(),
        deployedAt: z.string().datetime().nullable(),
      }).strict(),
      response: { 200: z.object({ id: z.string().uuid(), replay: z.boolean() }).strict() },
    },
  }, async req => {
    const ctx = opCtx(req);
    return withTx(app.db, ctx, 'deploy_event.record', async tx => {
      await lockAdministrators(tx, [req.requireAuth().accountId], 'console:app_registry:manage');
      return recordDeployEvent(tx, ctx, req.body);
    });
  });
}
