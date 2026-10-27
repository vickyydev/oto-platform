import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyBaseLogger } from 'fastify';
import {
  account, employee, impersonationSession, role, roleAssignment, session as sessionTable, suiteControlApproval,
  type Db, type ImpersonationEndReason, type ImpersonationMode, type ImpersonationTargetApp,
} from '@oto/db';
import { newId } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { hashToken, newSessionToken, type AuthContext } from '../plugins/session';
import { audit } from './audit';
import { seatBranch } from './auth';
import { issueHandoff, type HandoffConfig } from './handoff';
import { buildAlertChannels, deliverAlert, raiseAlert } from './ops';
import { resolveEffectivePermissions } from './permissions';
import {
  consumeImpersonationApproval, lockAdministrators, requestImpersonationApproval, type ImpersonationWriteOperation,
} from './suite-control-approvals';
import { withTx, type Exec, type OpContext, type Tx } from './tx';

/**
 * SCRUM-648 (S2-23 P5-6) — AUDITED, TIME-BOXED IMPERSONATION ("view as").
 *
 * A support administrator opens one app as one chosen staff account. The
 * window is a NEW session of the subject, minted for the window alone and
 * marked by its `core.impersonation_session` row; it is never the subject's
 * own session and it never touches it. Read-only by default (the session
 * plugin refuses every write before its handler runs); `write_allowed` needs a
 * reason, a reference and — while CONSOLE_DUAL_CONTROL names
 * `impersonate_write` — a second platform administrator's approval, consumed
 * in the same transaction that opens the window.
 *
 * It ends at IMPERSONATION_MAX_MIN, when it is ended, or when the actor's own
 * session ends, whichever is first; the session loader refuses the marked
 * session the moment any of them is true. Refused for a subject holding
 * `platform_admin` or any Console permission, for the actor themselves, and
 * from a session that is itself a window. Every refusal and every start and
 * end is an audit row; every request inside the window is one too
 * (`impersonation.request`, written by the session plugin).
 */

const PERMISSION = 'console:support:impersonate';
const APPROVAL_WINDOW_MS = 10 * 60_000;

export interface ImpersonationSettings {
  maxMinutes: number;
  /** CONSOLE_DUAL_CONTROL names `impersonate_write`. */
  dualControl: boolean;
  handoff: () => HandoffConfig;
}

export interface ImpersonationView {
  id: string;
  actor: { accountId: string; name: string | null };
  subject: { accountId: string; name: string | null };
  targetApp: ImpersonationTargetApp;
  mode: ImpersonationMode;
  reason: string | null;
  reference: string | null;
  approvalId: string | null;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: ImpersonationEndReason | null;
  state: 'active' | 'ended' | 'expired';
}

type Row = typeof impersonationSession.$inferSelect;

function refusal(code: string, message: string, status = 403) {
  return new AppError(status, code, message);
}

/** A refusal is recorded before it is answered, in its own transaction. */
async function refuse(db: Db, ctx: OpContext, input: { subjectAccountId: string; targetApp: string; mode: string }, err: AppError): Promise<never> {
  await withTx(db, ctx, 'console.impersonation.refused', async tx => {
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId ?? null, operatorId: ctx.operatorId ?? null, branchId: null,
      action: 'console.impersonation.refused', entityType: 'account', entityId: input.subjectAccountId,
      after: { code: err.code, targetApp: input.targetApp, mode: input.mode }, requestId: ctx.requestId ?? null,
      targetApp: input.targetApp, origin: 'console',
    });
  });
  throw err;
}

/** Names as the Console shows staff: nickname, else name, of the linked employee. */
async function namesOf(db: Exec, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: account.id, name: employee.name, nickname: employee.nickname }).from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId)).where(inArray(account.id, [...new Set(ids)]));
  return new Map(rows.map(r => [r.id, r.nickname ?? r.name ?? null]));
}

function stateOf(row: Row, sessionRevoked: boolean, now = new Date()): ImpersonationView['state'] {
  if (row.endedAt || sessionRevoked) return 'ended';
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

async function viewsOf(db: Exec, rows: Array<{ imp: Row; revokedAt: Date | null }>): Promise<ImpersonationView[]> {
  const names = await namesOf(db, rows.flatMap(r => [r.imp.actorAccountId, r.imp.subjectAccountId]));
  return rows.map(({ imp, revokedAt }) => ({
    id: imp.id,
    actor: { accountId: imp.actorAccountId, name: names.get(imp.actorAccountId) ?? null },
    subject: { accountId: imp.subjectAccountId, name: names.get(imp.subjectAccountId) ?? null },
    targetApp: imp.targetApp, mode: imp.mode, reason: imp.reason, reference: imp.reference, approvalId: imp.approvalId,
    startedAt: imp.startedAt.toISOString(), expiresAt: imp.expiresAt.toISOString(),
    endedAt: imp.endedAt?.toISOString() ?? null, endReason: imp.endReason ?? null, state: stateOf(imp, revokedAt !== null),
  }));
}

async function windowsWhere(db: Exec, where: ReturnType<typeof and>, limit = 50) {
  const rows = await db.select({ imp: impersonationSession, revokedAt: sessionTable.revokedAt }).from(impersonationSession)
    .innerJoin(sessionTable, eq(sessionTable.id, impersonationSession.sessionId))
    .where(where).orderBy(desc(impersonationSession.startedAt)).limit(limit);
  return viewsOf(db, rows);
}

/**
 * Why this subject may not be viewed as, or null. The subject must be a live
 * account of the actor's working operator who can open the target app, and
 * must hold neither `platform_admin` nor anything of the Console.
 */
export async function subjectRefusal(db: Db, actor: AuthContext, subjectAccountId: string, targetApp: ImpersonationTargetApp): Promise<AppError | null> {
  if (actor.impersonation) return refusal('IMPERSONATION_NESTED', 'A view-as window cannot open another one.');
  if (subjectAccountId === actor.accountId) return refusal('IMPERSONATION_SELF', 'You cannot view the suite as yourself.');
  const [subject] = await db.select({ id: account.id, operatorId: account.operatorId, status: account.status }).from(account)
    .where(eq(account.id, subjectAccountId)).limit(1);
  if (!subject || subject.operatorId !== actor.operatorId) return refusal('NOT_FOUND', 'Account not found', 404);
  if (subject.status !== 'active') return refusal('IMPERSONATION_SUBJECT_INACTIVE', 'Only an active account can be viewed as.', 409);
  const [platform] = await db.select({ id: roleAssignment.id }).from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(and(eq(roleAssignment.accountId, subjectAccountId), isNull(roleAssignment.archivedAt), eq(role.name, 'platform_admin'),
      isNull(role.operatorId), eq(role.isSystem, true))).limit(1);
  const effective = await resolveEffectivePermissions(db, subjectAccountId);
  if (platform || effective.some(g => g.permission.startsWith('console:') || g.permission === 'app:console:access')) {
    return refusal('IMPERSONATION_SUBJECT_PRIVILEGED',
      'This account holds platform or Console authority, so it can never be viewed as.');
  }
  if (!effective.some(g => g.permission === `app:${targetApp}:access`)) {
    return refusal('IMPERSONATION_SUBJECT_NO_APP', 'This account cannot open that app, so there is nothing to view as.', 409);
  }
  return null;
}

export interface StartInput {
  actor: AuthContext;
  subjectAccountId: string;
  targetApp: ImpersonationTargetApp;
  mode: ImpersonationMode;
  reason?: string | null;
  reference?: string | null;
  approval?: { id: string; expectedPayloadSha256: string } | null;
}

export interface StartedImpersonation {
  impersonation: ImpersonationView;
  launchUrl: string;
  handoffExpiresAt: string;
}

export async function startImpersonation(db: Db, ctx: OpContext, settings: ImpersonationSettings, input: StartInput,
  alerts: { channels: string; flapWindowSeconds: number; log: FastifyBaseLogger }): Promise<StartedImpersonation> {
  const facts = { subjectAccountId: input.subjectAccountId, targetApp: input.targetApp, mode: input.mode };
  const refused = await subjectRefusal(db, input.actor, input.subjectAccountId, input.targetApp);
  if (refused) return refuse(db, ctx, facts, refused);
  const reason = input.reason?.trim() || null, reference = input.reference?.trim() || null;
  if (input.mode === 'write_allowed') {
    if (!reason || !reference) {
      return refuse(db, ctx, facts, refusal('IMPERSONATION_REASON_REQUIRED', 'A window that can change things needs a reason and a reference.', 400));
    }
    if (settings.dualControl && !input.approval) {
      return refuse(db, ctx, facts, refusal('SECOND_APPROVAL_REQUIRED', 'A second platform administrator must approve a window that can change things.'));
    }
  } else if (input.approval) {
    throw errors.badRequest('A read-only window needs no approval.');
  }
  const config = settings.handoff();
  const [subject] = await db.select({ id: account.id, operatorId: account.operatorId, employeeId: account.employeeId }).from(account)
    .where(eq(account.id, input.subjectAccountId)).limit(1);
  const seat = await seatBranch(db, subject!);
  if (seat.kind !== 'seat') return refuse(db, ctx, facts, refusal('IMPERSONATION_SUBJECT_NO_SEAT', 'This account has no park to be seated at.', 409));

  const open = async (tx: Tx, approvalId: string | null) => {
    await lockAdministrators(tx, [input.actor.accountId], PERMISSION);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.maxMinutes * 60_000);
    // The window's own session of the subject: the token exists only inside the sealed hand-off.
    const token = newSessionToken(), id = newId();
    await tx.insert(sessionTable).values({ id, accountId: input.subjectAccountId, tokenHash: hashToken(token), branchId: seat.branchId,
      stationId: null, sessionClass: 'staff', expiresAt, lastSeenAt: now, createdAt: now });
    const [row] = await tx.insert(impersonationSession).values({ id: newId(), operatorId: subject!.operatorId,
      actorAccountId: input.actor.accountId, actorSessionId: input.actor.sessionId, subjectAccountId: input.subjectAccountId,
      sessionId: id, targetApp: input.targetApp, mode: input.mode, reason, reference, approvalId,
      startedAt: now, expiresAt, createdAt: now, updatedAt: now }).returning();
    await audit.record(tx, {
      actorAccountId: input.actor.accountId, operatorId: subject!.operatorId, branchId: null,
      action: 'console.impersonation.start', entityType: 'impersonation_session', entityId: row!.id, requestId: ctx.requestId ?? null,
      after: { subjectAccountId: input.subjectAccountId, targetApp: input.targetApp, mode: input.mode, reference, approvalId,
        expiresAt: expiresAt.toISOString(), maxMinutes: settings.maxMinutes },
      targetApp: input.targetApp, reason, origin: 'console', onBehalfOf: input.subjectAccountId,
    });
    const issued = await issueHandoff(tx, config, { sessionId: id, accountId: input.subjectAccountId, sessionToken: token,
      audience: input.targetApp, impersonation: { id: row!.id, actorAccountId: input.actor.accountId } });
    await audit.record(tx, {
      actorAccountId: input.actor.accountId, operatorId: subject!.operatorId, branchId: null, action: 'auth.handoff_issue',
      entityType: 'session', entityId: id, requestId: ctx.requestId ?? null,
      // The jti, never the token.
      after: { jti: issued.jti, audience: input.targetApp, impersonationId: row!.id },
      actorType: 'impersonated', onBehalfOf: input.subjectAccountId, origin: 'console', targetApp: input.targetApp,
    });
    const [view] = await viewsOf(tx, [{ imp: row!, revokedAt: null }]);
    return { impersonation: view!, launchUrl: issued.launchUrl, handoffExpiresAt: issued.expiresAt.toISOString() };
  };

  const started = input.approval
    ? await withTx(db, ctx, 'console.impersonation.start', async tx => {
      const out = await consumeImpersonationApproval(tx, ctx, input.approval, async (etx, op) => {
        if (op.subjectAccountId !== input.subjectAccountId || op.targetApp !== input.targetApp
          || op.reason !== reason || op.reference !== reference) {
          throw errors.conflict('APPROVAL_CONTEXT_CHANGED', 'The approved window is not the one being opened.');
        }
        return open(etx, input.approval!.id);
      });
      const result = 'result' in out ? out.result as StartedImpersonation | undefined : undefined;
      if (!result) throw errors.conflict('APPROVAL_EXPIRED', 'This approval ran out before the window was opened; ask again.');
      return result;
    })
    : await withTx(db, ctx, 'console.impersonation.start', tx => open(tx, null));

  // The alert follows the commit; one that cannot be raised never undoes the window it describes.
  try {
    const key = `console.impersonation.start:${started.impersonation.id}`;
    const subjectLine = `${started.impersonation.actor.name ?? 'An administrator'} is viewing ${started.impersonation.targetApp} as ${started.impersonation.subject.name ?? 'a staff account'}`;
    const summary = `${subjectLine} (${started.impersonation.mode.replace('_', '-')}) until ${started.impersonation.expiresAt}`;
    const raised = await raiseAlert(db, { key, category: 'console.impersonation.start', severity: 'warning', subject: subjectLine, summary,
      operatorId: ctx.operatorId ?? null, branchId: null }, { flapWindowSeconds: alerts.flapWindowSeconds });
    if (raised.outcome === 'opened') {
      await deliverAlert(db, buildAlertChannels(alerts.channels, alerts.log), { alertId: raised.id, key, category: 'console.impersonation.start',
        severity: 'warning', subject: subjectLine, summary, event: 'opened' }, alerts.log);
    }
  } catch (err) {
    alerts.log.error({ err }, 'the impersonation start alert could not be raised');
  }
  return started;
}

/** Ask for a write-allowed window: checked now, approved by a different platform administrator within ten minutes. */
export async function requestWriteImpersonation(db: Db, ctx: OpContext, input: {
  actor: AuthContext; subjectAccountId: string; targetApp: ImpersonationTargetApp; reason: string; reference: string;
}) {
  const facts = { subjectAccountId: input.subjectAccountId, targetApp: input.targetApp, mode: 'write_allowed' };
  const refused = await subjectRefusal(db, input.actor, input.subjectAccountId, input.targetApp);
  if (refused) return refuse(db, ctx, facts, refused);
  const operation: ImpersonationWriteOperation = { schemaVersion: 1, action: 'impersonation.write',
    subjectAccountId: input.subjectAccountId, targetApp: input.targetApp, operatorId: input.actor.operatorId,
    reason: input.reason.trim(), reference: input.reference.trim(),
    expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString() };
  return requestImpersonationApproval(db, ctx, operation);
}

/** End a window now: the actor who opened it, or any platform administrator holding the permission. */
export async function endImpersonation(db: Db, ctx: OpContext, input: { id: string; actor: AuthContext }) {
  return withTx(db, ctx, 'console.impersonation.end', async tx => {
    const [row] = await tx.select().from(impersonationSession).where(eq(impersonationSession.id, input.id)).for('update').limit(1);
    if (!row || row.operatorId !== input.actor.operatorId) throw errors.notFound('Impersonation not found');
    if (row.actorAccountId !== input.actor.accountId) await lockAdministrators(tx, [input.actor.accountId], PERMISSION);
    const ended = await endWindow(tx, row, 'ended', input.actor.accountId, ctx.requestId ?? null);
    const [seat] = await tx.select({ revokedAt: sessionTable.revokedAt }).from(sessionTable).where(eq(sessionTable.id, ended.sessionId));
    return (await viewsOf(tx, [{ imp: ended, revokedAt: seat?.revokedAt ?? null }]))[0]!;
  });
}

/** Close one window and its session, once. An already-closed window is returned as it is. */
async function endWindow(tx: Tx, row: Row, reason: ImpersonationEndReason, actorAccountId: string | null, requestId: string | null) {
  if (row.endedAt) return row;
  const now = new Date();
  const [ended] = await tx.update(impersonationSession).set({ endedAt: now, endReason: reason, updatedAt: now })
    .where(and(eq(impersonationSession.id, row.id), isNull(impersonationSession.endedAt))).returning();
  await tx.update(sessionTable).set({ revokedAt: now, revokedReason: `impersonation_${reason}` })
    .where(and(eq(sessionTable.id, row.sessionId), isNull(sessionTable.revokedAt)));
  await audit.record(tx, {
    actorAccountId, operatorId: row.operatorId, branchId: null, action: 'console.impersonation.end',
    entityType: 'impersonation_session', entityId: row.id, requestId,
    before: { endedAt: null }, after: { endReason: reason, endedAt: now.toISOString(), expired: row.expiresAt.getTime() <= now.getTime() },
    targetApp: row.targetApp, origin: 'console', onBehalfOf: row.subjectAccountId,
    // Signing out inside the window is the window's own request: the actor's hands, on the subject's session.
    actorType: reason === 'subject_signed_out' ? 'impersonated' : null,
  });
  return ended ?? row;
}

/**
 * Sign-out (`services/auth.ts signOut`, in its transaction): the actor's
 * sign-out ends every window opened from that session, and the window's own
 * sign-out ends the window.
 */
export async function endImpersonationsForSession(tx: Tx, sessionId: string, actorAccountId: string, requestId?: string) {
  const now = new Date();
  const open = await tx.select().from(impersonationSession)
    .where(and(isNull(impersonationSession.endedAt), gt(impersonationSession.expiresAt, now),
      or(eq(impersonationSession.actorSessionId, sessionId), eq(impersonationSession.sessionId, sessionId))))
    .for('update');
  for (const row of open) {
    const own = row.sessionId === sessionId;
    await endWindow(tx, row, own ? 'subject_signed_out' : 'actor_signed_out',
      own ? row.actorAccountId : actorAccountId, requestId ?? null);
  }
}

/** The Console card: the caller's open windows and recent ones, and the open write approvals. */
export async function impersonationsOf(db: Db, actor: AuthContext) {
  const now = new Date();
  const windows = await windowsWhere(db, and(eq(impersonationSession.operatorId, actor.operatorId),
    eq(impersonationSession.actorAccountId, actor.accountId)), 20);
  const approvals = await db.select().from(suiteControlApproval).where(and(eq(suiteControlApproval.action, 'impersonation.write'),
    eq(suiteControlApproval.operatorId, actor.operatorId), inArray(suiteControlApproval.state, ['pending', 'approved']),
    gt(suiteControlApproval.requestExpiresAt, now))).orderBy(desc(suiteControlApproval.createdAt)).limit(20);
  const names = await namesOf(db, approvals.flatMap(a => [a.requesterAccountId, ...(a.approverAccountId ? [a.approverAccountId] : []),
    (a.operation as { subjectAccountId: string }).subjectAccountId]));
  return {
    windows,
    approvals: approvals.map(a => {
      const op = a.operation as ImpersonationWriteOperation;
      return { id: a.id, state: a.state, payloadSha256: a.payloadSha256, requesterAccountId: a.requesterAccountId,
        requesterName: names.get(a.requesterAccountId) ?? null, approverAccountId: a.approverAccountId,
        subjectAccountId: op.subjectAccountId, subjectName: names.get(op.subjectAccountId) ?? null, targetApp: op.targetApp,
        reason: op.reason, reference: op.reference, mine: a.requesterAccountId === actor.accountId,
        createdAt: a.createdAt.toISOString(), requestExpiresAt: a.requestExpiresAt.toISOString() };
    }),
  };
}

/** The subject's own history: every window anybody opened as them. */
export async function impersonationsAsSubject(db: Db, subjectAccountId: string) {
  return windowsWhere(db, and(eq(impersonationSession.subjectAccountId, subjectAccountId)), 50);
}

/** What `/me` says about this session: the window it is, or the windows it has open. */
export async function impersonationMarksOf(db: Db, auth: AuthContext) {
  const now = new Date();
  const actorSeat = alias(sessionTable, 'me_impersonation_seat');
  const self = auth.impersonation
    ? (await windowsWhere(db, and(eq(impersonationSession.id, auth.impersonation.id)), 1))[0] ?? null : null;
  const rows = await db.select({ imp: impersonationSession, revokedAt: actorSeat.revokedAt }).from(impersonationSession)
    .innerJoin(actorSeat, eq(actorSeat.id, impersonationSession.sessionId))
    .where(and(eq(impersonationSession.actorSessionId, auth.sessionId), isNull(impersonationSession.endedAt),
      gt(impersonationSession.expiresAt, now), isNull(actorSeat.revokedAt))).orderBy(desc(impersonationSession.startedAt)).limit(5);
  return { impersonation: self, impersonating: await viewsOf(db, rows) };
}
