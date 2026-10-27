import { z } from 'zod';
import { IMPERSONATION_TARGET_APPS, SUITE_CONTROL_APPROVAL_STATES } from '@oto/db';
import type { App } from '../app';
import { AppError, errors } from '../lib/errors';
import { SESSION_COOKIE } from '../plugins/session';
import { handoffConfig } from '../services/handoff';
import {
  endImpersonation, impersonationsOf, requestWriteImpersonation, startImpersonation,
} from '../services/impersonation';
import { hasPermission } from '../services/permissions';
import { approveImpersonationApproval } from '../services/suite-control-approvals';
import {
  recordSupportRead, SUPPORT_QUERY_KINDS, SUPPORT_SECTION_APPS, SUPPORT_SECTION_STATUSES, supportLookup,
} from '../services/support-lookup';
import { resolveTraceAnchor, TRACE_KINDS, TRACE_STAGES, TRACE_STEP_STATUSES, traceOf } from '../services/support-trace';
import { opCtx } from '../services/tx';
import { ImpersonationHistoryShape } from './me';
import { idempotencyKeyRequired, requirePlatformHolder } from './suite-control-writes';

/**
 * SCRUM-648 (S2-23 P5-6) — the Console's Support tools: the cross-app lookup,
 * the one-action trace and audited, time-boxed impersonation.
 *
 * The lookup and the trace are READS: operator-wide `console:support:lookup`
 * and `console:support:trace`, each writing one data_access audit row and
 * answering only after it is committed. Impersonation is platform-only
 * (`console:support:impersonate` held platform-wide, re-checked against the
 * system `platform_admin` role in the transaction that opens a window).
 */

const SectionSchema = z.object({
  key: z.string(), app: z.enum(SUPPORT_SECTION_APPS), kind: z.enum(SUPPORT_QUERY_KINDS), label: z.string(),
  status: z.enum(SUPPORT_SECTION_STATUSES), permission: z.string().nullable(), rowCount: z.number().int().nonnegative(),
  masked: z.boolean(), rows: z.array(z.record(z.unknown())), note: z.string().nullable(),
}).strict();
export const SupportLookupSchema = z.object({
  generatedAt: z.string().datetime(), kinds: z.array(z.enum(SUPPORT_QUERY_KINDS)), detected: z.boolean(), masked: z.boolean(),
  sections: z.array(SectionSchema),
}).strict();

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const SupportTraceSchema = z.object({
  generatedAt: z.string().datetime(),
  anchor: z.object({
    kind: z.enum(TRACE_KINDS), id: z.string(), branchId: z.string().uuid().nullable(), saleId: z.string().uuid().nullable(),
    walletId: z.string().uuid().nullable(), receiptNumber: z.string().nullable(), actionIds: z.array(z.string()),
    alsoMatched: z.number().int().nonnegative(),
  }).strict(),
  steps: z.array(z.object({
    stage: z.enum(TRACE_STAGES), label: z.string(), status: z.enum(TRACE_STEP_STATUSES), at: z.string().datetime().nullable(),
    source: z.string().nullable(), recordId: z.string().nullable(), opsRunId: z.string().nullable(), requestId: z.string().nullable(),
    actionId: z.string().nullable(), latencyMs: z.number().nullable(), sincePreviousMs: z.number().nullable(), outOfOrder: z.boolean(),
    detail: z.record(Scalar), traceUrl: z.string().nullable(), note: z.string().nullable(),
  }).strict()),
  gaps: z.array(z.enum(TRACE_STAGES)),
}).strict();

const ApprovalSchema = z.object({
  id: z.string().uuid(), state: z.enum(SUITE_CONTROL_APPROVAL_STATES), payloadSha256: z.string(),
  requesterAccountId: z.string().uuid(), requesterName: z.string().nullable(), approverAccountId: z.string().uuid().nullable(),
  subjectAccountId: z.string().uuid(), subjectName: z.string().nullable(), targetApp: z.enum(IMPERSONATION_TARGET_APPS),
  reason: z.string(), reference: z.string(), mine: z.boolean(), createdAt: z.string().datetime(), requestExpiresAt: z.string().datetime(),
}).strict();
const ApprovalRefSchema = z.object({
  id: z.string().uuid(), state: z.enum(SUITE_CONTROL_APPROVAL_STATES), payloadSha256: z.string(),
  requesterAccountId: z.string().uuid(), approverAccountId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(), requestExpiresAt: z.string().datetime(),
}).strict();
const refOf = (v: { id: string; state: (typeof SUITE_CONTROL_APPROVAL_STATES)[number]; payloadSha256: string; requesterAccountId: string;
  approverAccountId: string | null; createdAt: string; requestExpiresAt: string }) => ({ id: v.id, state: v.state,
  payloadSha256: v.payloadSha256, requesterAccountId: v.requesterAccountId, approverAccountId: v.approverAccountId,
  createdAt: v.createdAt, requestExpiresAt: v.requestExpiresAt });

const TargetApp = z.enum(IMPERSONATION_TARGET_APPS);
const Reason = z.string().trim().min(1).max(1000);
const Reference = z.string().trim().min(1).max(200);

export async function consoleSupportRoutes(app: App): Promise<void> {
  const settings = () => ({
    maxMinutes: app.env.IMPERSONATION_MAX_MIN,
    dualControl: app.env.CONSOLE_DUAL_CONTROL.has('impersonate_write'),
    handoff: () => handoffConfig({ signingKey: app.env.HANDOFF_SIGNING_KEY, appOrigins: app.env.HANDOFF_APP_ORIGINS,
      ttlSeconds: app.env.HANDOFF_TOKEN_TTL_S }),
  });

  app.get('/console/support/lookup', {
    config: { permission: 'console:support:lookup', target: { operator: true } },
    schema: {
      description: 'The cross-app support lookup: one phone, band, receipt number, booking reference, voucher code, account id or action id (`kind` names it; otherwise every kind it could be is searched). Each section is answered by its own app’s route as the caller, so each keeps its own permission, scope and masking: a section the caller may not read says `denied`, one with no safe reader says `not_built`, one whose app failed says `unavailable`. Member and child records are masked unless the caller holds admin:audit:read_sensitive operator-wide. One data_access audit row per lookup, naming the kinds and which sections answered, never a value.',
      querystring: z.object({ q: z.string().trim().min(1).max(200), kind: z.enum(SUPPORT_QUERY_KINDS).optional() }).strict(),
      response: { 200: SupportLookupSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw errors.unauthorized();
    const effective = await req.effectivePermissions();
    const answer = await supportLookup(app, {
      q: req.query.q, kind: req.query.kind, operatorId: auth.operatorId, effective, token, requestId: req.id,
      traceAnchor: async (actionId) => {
        // Asked before the record is looked for: a caller who cannot trace is not told whether it exists.
        if (!hasPermission(effective, 'console:support:trace', { operatorId: auth.operatorId, operatorOnly: true })) {
          return { status: 'denied', rows: [], note: 'Missing permission console:support:trace' };
        }
        const anchor = await resolveTraceAnchor(app.db, auth.operatorId, 'action', actionId);
        if (!anchor) return { status: 'empty', rows: [], note: null };
        return { status: 'found', note: null, rows: [{ kind: 'action', id: actionId, saleId: anchor.saleId,
          receiptNumber: anchor.receiptNumber, href: `/support?${new URLSearchParams({ trace: actionId, kind: 'action' }).toString()}` }] };
      },
    });
    await recordSupportRead(app.db, { ...opCtx(req), requestId: req.id, actorAccountId: auth.accountId }, {
      action: 'console.support.lookup',
      after: { kinds: answer.kinds, detected: answer.detected, masked: answer.masked,
        sections: answer.sections.map(s => ({ key: s.key, app: s.app, kind: s.kind, status: s.status, rows: s.rowCount })) },
    });
    return answer;
  });

  app.get('/console/support/trace', {
    config: { permission: 'console:support:trace', target: { operator: true } },
    schema: {
      description: 'What happened to one action, sale, refund, payment attempt, receipt or wallet: one vertical trace in pipeline order — till intent, box session and lease, device call (projected), outbox event with epoch and sequence, cloud apply or quarantine, audit rows, payment webhook and inquiry, rollup effect — each step with its ops_run, latency and time since the previous step. A stage with no record is returned as a gap with the reasons it can be missing. Accepts exactly the Money oversight links (`/support?trace=<id>&kind=…`). Every read writes a data_access audit row; 404 when nothing in this operator carries the key.',
      querystring: z.object({ id: z.string().trim().min(1).max(128), kind: z.enum(TRACE_KINDS).default('action') }).strict(),
      response: { 200: SupportTraceSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    const anchor = await resolveTraceAnchor(app.db, auth.operatorId, req.query.kind, req.query.id);
    const trace = anchor ? await traceOf(app.db, anchor, { traceUrlTemplate: app.env.TRACE_URL_TEMPLATE }) : null;
    await recordSupportRead(app.db, { ...opCtx(req), requestId: req.id, actorAccountId: auth.accountId }, {
      action: 'console.support.trace', branchId: anchor?.branchId ?? null,
      after: { kind: req.query.kind, found: trace !== null, saleId: anchor?.saleId ?? null, walletId: anchor?.walletId ?? null,
        steps: trace?.steps.filter(s => s.status !== 'gap').length ?? 0, gaps: trace?.gaps ?? [] },
    });
    if (!trace) throw new AppError(404, 'TRACE_NOT_FOUND', 'Nothing in this park group carries that key.');
    return trace;
  });

  app.get('/console/support/impersonations', {
    config: { permission: 'console:support:impersonate', target: { operator: true } },
    schema: {
      description: 'The caller’s view-as windows (open and recent) and the open write-allowed requests awaiting or holding a second approval, with the window length and whether writes need a second administrator.',
      querystring: z.object({}).strict(),
      response: { 200: z.object({
        maxMinutes: z.number().int().positive(), dualControl: z.boolean(), targetApps: z.array(TargetApp),
        windows: z.array(ImpersonationHistoryShape), approvals: z.array(ApprovalSchema),
      }).strict() },
    },
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    const s = settings();
    return { maxMinutes: s.maxMinutes, dualControl: s.dualControl, targetApps: [...IMPERSONATION_TARGET_APPS],
      ...(await impersonationsOf(app.db, req.requireAuth())) };
  });

  app.post('/console/support/impersonations', {
    // `secretResponse`: the answer carries the hand-off into the window, a credential.
    config: { permission: 'console:support:impersonate', target: { operator: true }, platformWide: true, secretResponse: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:support:impersonate'); },
    schema: {
      description: 'Open a view-as window: a new, marked session of the subject for one app, read-only unless `mode` is write_allowed (which needs a reason, a reference and, while CONSOLE_DUAL_CONTROL names impersonate_write, the id and digest of an approved request). Lasts IMPERSONATION_MAX_MIN minutes or until the actor signs out. Refused for a subject holding platform_admin or any Console permission, for oneself and from a window. Answers the launch URL carrying the hand-off in its fragment. Audited, and raises console.impersonation.start.',
      body: z.object({
        subjectAccountId: z.string().uuid(), targetApp: TargetApp, mode: z.enum(['read_only', 'write_allowed']).default('read_only'),
        reason: Reason.optional(), reference: Reference.optional(),
        approval: z.object({ id: z.string().uuid(), expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
      }).strict(),
      response: { 200: z.object({ impersonation: ImpersonationHistoryShape, launchUrl: z.string(), handoffExpiresAt: z.string().datetime() }).strict() },
    },
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    const { idempotency: _none, ...ctx } = opCtx(req);
    return startImpersonation(app.db, ctx, settings(), {
      actor: req.requireAuth(), subjectAccountId: req.body.subjectAccountId, targetApp: req.body.targetApp, mode: req.body.mode,
      reason: req.body.reason ?? null, reference: req.body.reference ?? null, approval: req.body.approval ?? null,
    }, { channels: app.env.ALERT_CHANNELS, flapWindowSeconds: app.env.ALERT_FLAP_WINDOW_S, log: req.log });
  });

  app.post('/console/support/impersonations/approvals', {
    config: { permission: 'console:support:impersonate', target: { operator: true }, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:support:impersonate'); idempotencyKeyRequired(req); },
    schema: {
      description: 'Ask a second platform administrator to approve one write-allowed view-as window: one subject, one app, one reason and one reference, checked now and bound by its digest. A different administrator must approve within ten minutes; only the asker then opens it. Requires Idempotency-Key.',
      body: z.object({ subjectAccountId: z.string().uuid(), targetApp: TargetApp, reason: Reason, reference: Reference }).strict(),
      response: { 200: ApprovalRefSchema },
    },
  }, async req => refOf(await requestWriteImpersonation(app.db, opCtx(req), { actor: req.requireAuth(), ...req.body })));

  app.post('/console/support/impersonations/approvals/:id/approve', {
    config: { permission: 'console:support:impersonate', target: { operator: true }, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:support:impersonate'); idempotencyKeyRequired(req); },
    schema: {
      description: 'Approve another platform administrator’s exact write-allowed view-as request within ten minutes of it. The asker cannot approve their own; an expired request is recorded as expired. Requires Idempotency-Key.',
      params: z.object({ id: z.string().uuid() }).strict(),
      body: z.object({ expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      response: { 200: ApprovalRefSchema },
    },
  }, async req => {
    // The expiry outcome must commit even though this request then fails, so no replay answer is stored for it.
    const { idempotency: _replay, ...ctx } = opCtx(req);
    const view = await approveImpersonationApproval(app.db, ctx, { id: req.params.id, expectedPayloadSha256: req.body.expectedPayloadSha256 });
    if (view.state === 'expired') throw new AppError(409, 'APPROVAL_EXPIRED', 'This request was not approved within ten minutes; ask again.');
    return refOf(view);
  });

  app.post('/console/support/impersonations/:id/end', {
    config: { permission: 'console:support:impersonate', target: { operator: true }, platformWide: true },
    preValidation: async req => { await requirePlatformHolder(req, 'console:support:impersonate'); idempotencyKeyRequired(req); },
    schema: {
      description: 'End a view-as window now: its session is revoked at once in every app it reached. The actor who opened it, or another platform administrator. Requires Idempotency-Key.',
      params: z.object({ id: z.string().uuid() }).strict(), body: z.object({}).strict(),
      response: { 200: z.object({ impersonation: ImpersonationHistoryShape }).strict() },
    },
  }, async req => ({ impersonation: await endImpersonation(app.db, opCtx(req), { id: req.params.id, actor: req.requireAuth() }) }));
}
