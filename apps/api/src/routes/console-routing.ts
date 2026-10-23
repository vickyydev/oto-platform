import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCOUNT_STATUSES, INBOX_CATEGORIES, INBOX_TEAM_KEYS, ROUTING_PRIMARY_KINDS } from '@oto/db';
import type { App } from '../app';
import { REPLAY_HEADER, wasReplay } from '../services/client-id';
import {
  archiveManagedRule, authorizeRoutingIntent, createManagedRule, createManagedTeam,
  listManagedRules, listManagedTeams, refuseManagedTeamDelete, requireRoutingReach,
  updateManagedRule, updateManagedTeam, type RoutingActor, type RoutingIntent,
} from '../services/console-routing';
import { opCtx, withTx } from '../services/tx';

const uuid = z.string().uuid();
const signedInteger = z.number().int().min(-2147483648).max(2147483647);
const dateTime = z.string().datetime();
const teamReference = z.object({ id: uuid, key: z.enum(INBOX_TEAM_KEYS), name: z.string(), branchId: uuid.nullable() });
export const ManagedTeamSchema = teamReference.extend({ branchName: z.string().nullable(),
  departmentId: uuid.nullable(), departmentName: z.string().nullable(), colour: z.string(), sortOrder: signedInteger,
  createdAt: dateTime, updatedAt: dateTime });
export const ManagedTeamsSchema = z.object({ teams: z.array(ManagedTeamSchema), operatorWide: z.boolean(),
  branches: z.array(z.object({ id: uuid, name: z.string() })),
  departments: z.array(z.object({ id: uuid, name: z.string(), branchId: uuid.nullable() })),
  accounts: z.array(z.object({ id: uuid, displayName: z.string(), status: z.enum(ACCOUNT_STATUSES) })),
  teamReferences: z.array(teamReference) });
export const ManagedRuleSchema = z.object({ id: uuid, teamId: uuid, teamName: z.string().nullable(),
  category: z.enum(INBOX_CATEGORIES), language: z.string().nullable(), branchId: uuid.nullable(), branchName: z.string().nullable(),
  primaryKind: z.enum(ROUTING_PRIMARY_KINDS), primaryAccountId: uuid.nullable(), primaryAccountName: z.string().nullable(),
  backupAccountId: uuid.nullable(), backupAccountName: z.string().nullable(), autoAddBackup: z.boolean(),
  priority: signedInteger, active: z.boolean(), archivedAt: dateTime.nullable(), createdAt: dateTime, updatedAt: dateTime });
const metadata = { name: z.string().trim().min(1).max(200), colour: z.string().trim().min(1).max(100),
  departmentId: uuid.nullable(), sortOrder: signedInteger };
export const ManagedTeamCreateSchema = z.object({ id: uuid.optional(), key: z.enum(INBOX_TEAM_KEYS), branchId: uuid.nullable(),
  name: metadata.name, colour: metadata.colour, departmentId: metadata.departmentId.optional(), sortOrder: signedInteger.optional() })
  .strict().refine(v => (v.key === 'reception') === (v.branchId !== null), 'Reception requires a park; other teams serve all parks');
export const ManagedTeamPatchSchema = z.object(metadata).partial().strict()
  .refine(v => Object.keys(v).length > 0, 'Choose at least one team field to edit');
const ruleFields = { teamId: uuid, category: z.enum(INBOX_CATEGORIES),
  language: z.string().trim().min(1).max(100).nullable(), branchId: uuid.nullable(),
  primaryKind: z.enum(ROUTING_PRIMARY_KINDS), primaryAccountId: uuid.nullable(), backupAccountId: uuid.nullable(),
  autoAddBackup: z.boolean(), priority: signedInteger, active: z.boolean() };
export const ManagedRuleCreateSchema = z.object({ ...ruleFields, id: uuid.optional(),
  language: ruleFields.language.optional(), branchId: ruleFields.branchId.optional(),
  primaryAccountId: ruleFields.primaryAccountId.optional(), backupAccountId: ruleFields.backupAccountId.optional(),
  autoAddBackup: ruleFields.autoAddBackup.optional(), priority: signedInteger.optional(), active: z.boolean().optional() }).strict();
export const ManagedRulePatchSchema = z.object(ruleFields).partial().strict()
  .refine(v => Object.keys(v).length > 0, 'Choose at least one routing field to edit');
const paramsSchema = z.object({ id: uuid });
const okSchema = z.object({ ok: z.literal(true) });
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });

async function routingActor(req: FastifyRequest): Promise<RoutingActor> {
  const auth = req.requireAuth();
  const actor = { operatorId: auth.operatorId, accountId: auth.accountId, requestId: req.id,
    effective: await req.effectivePermissions() };
  requireRoutingReach(actor);
  return actor;
}

/** Root-mounted by consoleRoutes. Full paths keep the existing source guard scanner exact. */
export async function consoleRoutingRoutes(app: App): Promise<void> {
  const targets = new WeakMap<FastifyRequest, { branchId: string | null }>();
  async function authorizeBeforeReplay(req: FastifyRequest, actor: RoutingActor, intent: RoutingIntent) {
    targets.set(req, await authorizeRoutingIntent(app.db, actor, intent));
  }
  const writeContext = (req: FastifyRequest) => ({ ...opCtx(req), branchId: targets.get(req)?.branchId ?? null });
  app.get('/inbox/teams', {
    config: { dynamicPermission: true },
    schema: { description: 'Manageable teams and minimal routing choices within inbox:routing:manage reach. Global teams appear only as minimal references for park readers. No account phone, email or credential is returned.',
      querystring: z.object({}).strict(), response: { 200: ManagedTeamsSchema } },
    preValidation: async req => { await routingActor(req); },
  }, async req => listManagedTeams(app.db, await routingActor(req)));

  app.post('/inbox/teams', {
    config: { dynamicPermission: true },
    schema: { description: 'Create a fixed-kind team in its owned park or at operator scope. Optional caller id and header idempotency replay the same record. Reception requires a park. Department must be global or in the same park.',
      body: ManagedTeamCreateSchema, response: { 200: z.object({ team: ManagedTeamSchema }) } },
    preValidation: async req => {
      const actor = await routingActor(req), input = ManagedTeamCreateSchema.safeParse(req.body);
      if (input.success) await authorizeBeforeReplay(req, actor, { kind: 'team-create', input: input.data });
    },
  }, async (req, reply) => {
    const actor = await routingActor(req);
    const result = await withTx(app.db, writeContext(req), 'inbox.team.create', tx => createManagedTeam(tx, actor, req.body));
    if (wasReplay(result)) reply.header(REPLAY_HEADER, 'true');
    return result;
  });

  app.patch('/inbox/teams/:id', {
    config: { dynamicPermission: true },
    schema: { description: 'Edit team name, colour, department link and order. Fixed key and park identity remain unchanged. Checks actual row reach before replay and again under transaction lock.',
      params: paramsSchema, body: ManagedTeamPatchSchema, response: { 200: z.object({ team: ManagedTeamSchema }) } },
    preValidation: async req => {
      const actor = await routingActor(req), params = paramsSchema.safeParse(req.params);
      if (params.success) await authorizeBeforeReplay(req, actor, { kind: 'team-write', id: params.data.id });
    },
  }, async req => {
    const actor = await routingActor(req);
    return withTx(app.db, writeContext(req), 'inbox.team.update', tx => updateManagedTeam(tx, actor, req.params.id, req.body));
  });

  app.delete('/inbox/teams/:id', {
    config: { dynamicPermission: true },
    schema: { description: 'Teams cannot be deleted (owner Q10). An owned, authorized target answers the clear audited refusal; absent/foreign or out-of-reach rows remain protected. Edit metadata or archive routing rules instead.',
      params: paramsSchema, response: { 200: okSchema, 409: errorSchema } },
    preValidation: async req => {
      const actor = await routingActor(req), params = paramsSchema.safeParse(req.params);
      if (params.success) await authorizeBeforeReplay(req, actor, { kind: 'team-write', id: params.data.id });
    },
  }, async req => {
    const actor = await routingActor(req);
    return withTx(app.db, writeContext(req), 'inbox.team.delete', tx => refuseManagedTeamDelete(tx, actor, req.params.id));
  });

  app.get('/inbox/routing-rules', {
    config: { dynamicPermission: true },
    schema: { description: 'Rules only within the actual rule and referenced park-team reach; null rule scope requires operator-wide rights. Includes archived history and keeps priority, specificity, oldest and id order. No conversation is rerouted.',
      querystring: z.object({}).strict(), response: { 200: z.object({ rules: z.array(ManagedRuleSchema) }) } },
    preValidation: async req => { await routingActor(req); },
  }, async req => listManagedRules(app.db, await routingActor(req)));

  app.post('/inbox/routing-rules', {
    config: { dynamicPermission: true },
    schema: { description: 'Create a routing rule with signed priority and null language/park wildcards. Explicit owned accounts only; the existing router still determines active-person fallback. Checks concrete rule and team parks, or operator reach for a null rule scope. Optional body id and normal header idempotency are supported.',
      body: ManagedRuleCreateSchema, response: { 200: z.object({ rule: ManagedRuleSchema }) } },
    preValidation: async req => {
      const actor = await routingActor(req), input = ManagedRuleCreateSchema.safeParse(req.body);
      if (input.success) await authorizeBeforeReplay(req, actor, { kind: 'rule-create', input: input.data });
    },
  }, async (req, reply) => {
    const actor = await routingActor(req);
    const result = await withTx(app.db, writeContext(req), 'inbox.routing_rule.create', tx => createManagedRule(tx, actor, req.body));
    if (wasReplay(result)) reply.header(REPLAY_HEADER, 'true');
    return result;
  });

  app.patch('/inbox/routing-rules/:id', {
    config: { dynamicPermission: true },
    schema: { description: 'Edit an unarchived rule, preserving creation time and engine order. Both old and new rule/team scope are checked before idempotency replay and again under lock. Primary/backup references must belong to the operator.',
      params: paramsSchema, body: ManagedRulePatchSchema, response: { 200: z.object({ rule: ManagedRuleSchema }) } },
    preValidation: async req => {
      const actor = await routingActor(req), params = paramsSchema.safeParse(req.params), patch = ManagedRulePatchSchema.safeParse(req.body);
      if (params.success && patch.success) await authorizeBeforeReplay(req, actor, { kind: 'rule-write', id: params.data.id, patch: patch.data });
    },
  }, async req => {
    const actor = await routingActor(req);
    return withTx(app.db, writeContext(req), 'inbox.routing_rule.update', tx => updateManagedRule(tx, actor, req.params.id, req.body));
  });

  app.delete('/inbox/routing-rules/:id', {
    config: { dynamicPermission: true },
    schema: { description: 'Archive a rule in place, setting active false and archivedAt. Repeated archive is harmless; existing conversation ownership, history, fallback, routing and platform-sync behavior remain unchanged.',
      params: paramsSchema, response: { 200: okSchema } },
    preValidation: async req => {
      const actor = await routingActor(req), params = paramsSchema.safeParse(req.params);
      if (params.success) await authorizeBeforeReplay(req, actor, { kind: 'rule-write', id: params.data.id });
    },
  }, async req => {
    const actor = await routingActor(req);
    return withTx(app.db, writeContext(req), 'inbox.routing_rule.archive', tx => archiveManagedRule(tx, actor, req.params.id));
  });
}
