import { createHash, randomBytes } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { and, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  account, auditLog, branch, impersonationSession, operator, role, roleAssignment, rolePermission, session as sessionTable, station,
  type ImpersonationMode, type ImpersonationTargetApp,
} from '@oto/db';
import type { Permission } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { branchScopeRefusal } from '../services/access-control';
import { hasPermission, resolveEffectivePermissions, type EffectivePermission, type ScopeTarget } from '../services/permissions';
import type { Exec } from '../services/tx';
import { runWithAuditContext } from '../services/audit-context';
import { audit } from '../services/audit';

export const SESSION_COOKIE = 'oto_session';
const auditRequestScope = Symbol('verifiedAuditRequestScope');
type AuditRequest = FastifyRequest & { [auditRequestScope]?: AsyncResource | null };

/**
 * A refusal for a permission the caller does not hold (S2-03).
 *
 * The status and the code are unchanged — `403 FORBIDDEN`, the same message —
 * because nothing a caller reads should move. The type exists so the error
 * handler can record it as `auth.permission_denied` rather than the generic
 * `access.denied`, without reading a message string to find out what kind of
 * "no" this was. Those two answer different questions: one is a role that
 * needs granting, the other is a request aimed somewhere it does not belong.
 */
export class PermissionDeniedError extends AppError {
  constructor(permission: Permission) {
    super(403, 'FORBIDDEN', `Missing permission ${permission}`);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * SCRUM-648 — the mark on a session minted for an impersonation ("view as")
 * window. The session belongs to the SUBJECT, so everything it reads and
 * may do is the subject's; the mark is what makes every request in it
 * recognisable as somebody else's hands, and what ends it with the window.
 */
export interface ImpersonationMark {
  id: string;
  actorAccountId: string;
  actorSessionId: string;
  subjectAccountId: string;
  targetApp: ImpersonationTargetApp;
  mode: ImpersonationMode;
  expiresAt: Date;
}

export interface AuthContext {
  accountId: string;
  /** Working scope; never a replacement for the real account's home identity. */
  operatorId: string;
  homeOperatorId?: string;
  operatorOverride?: string | null;
  operatorRevision?: number;
  sessionId: string;
  branchId: string | null;
  stationId: string | null;
  status: 'invited' | 'active' | 'inactive';
  mustChangePassword: boolean;
  isPlatformAdmin: boolean;
  /** Set while the POS is locked on inactivity; business routes refuse. */
  lockedAt: Date | null;
  /** SCRUM-648: present only on a session minted for an impersonation window. */
  impersonation?: ImpersonationMark | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** Effective permissions, resolved once per request on first use. */
    effectivePermissions(): Promise<EffectivePermission[]>;
    requireAuth(): AuthContext;
    requirePermission(permission: Permission, target?: Partial<ScopeTarget>): Promise<AuthContext>;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function setSessionCookie(reply: FastifyReply, token: string, ttlHours: number, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: Math.floor(ttlHours * 3600),
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure });
}

async function loadAuth(db: Exec, token: string, signOutCleanupOnly = false): Promise<AuthContext | null> {
  const now = new Date(), tokenHash = hashToken(token);
  const effectiveOperator = alias(operator, 'session_effective_operator');
  const actorSeat = alias(sessionTable, 'impersonation_actor_session');
  const rows = await db
    .select({
      s: sessionTable,
      a: account,
      operatorArchivedAt: operator.archivedAt,
      // Left-joined: a session may legitimately sit at no branch at all, and
      // null then means "no branch", which is not "an archived branch".
      branchArchivedAt: branch.archivedAt,
      branchOperatorId: branch.operatorId,
      effectiveOperatorId: effectiveOperator.id,
      effectiveOperatorArchivedAt: effectiveOperator.archivedAt,
      stationId: station.id,
      stationOperatorId: station.operatorId,
      stationBranchId: station.branchId,
      stationArchivedAt: station.archivedAt,
      // SCRUM-648: the window this session was minted for, and the actor's own seat it hangs from.
      imp: impersonationSession,
      actorRevokedAt: actorSeat.revokedAt,
      actorExpiresAt: actorSeat.expiresAt,
      // These values share the same statement snapshot as the session. A
      // switch or grant revocation cannot splice two different contexts.
      switchGrant: sql<boolean>`exists (
        select 1 from ${roleAssignment}
        inner join ${role} on ${role.id} = ${roleAssignment.roleId}
        inner join ${rolePermission} on ${rolePermission.roleId} = ${role.id}
        where ${roleAssignment.accountId} = ${account.id}
          and ${roleAssignment.scopeType} = 'operator' and ${roleAssignment.scopeId} is null
          and ${roleAssignment.archivedAt} is null and ${rolePermission.permission} = 'platform:operator:switch'
          and (${role.operatorId} is null or ${role.operatorId} = ${account.operatorId})
      )`,
      platformWide: sql<boolean>`exists (
        select 1 from ${roleAssignment}
        inner join ${role} on ${role.id} = ${roleAssignment.roleId}
        inner join ${rolePermission} on ${rolePermission.roleId} = ${role.id}
        where ${roleAssignment.accountId} = ${account.id}
          and ${roleAssignment.scopeType} = 'operator' and ${roleAssignment.scopeId} is null
      )`,
      revision: sql<string>`(select count(*)::text from ${auditLog}
        where ${auditLog.action} = 'session.operator_switch'
          and ${auditLog.entityType} = 'session' and ${auditLog.entityId} = ${sessionTable.id}::text)`,
    })
    .from(sessionTable)
    .innerJoin(account, eq(sessionTable.accountId, account.id))
    .innerJoin(operator, eq(account.operatorId, operator.id))
    .leftJoin(effectiveOperator, eq(effectiveOperator.id, sql<string>`coalesce(${sessionTable.operatorOverride}, ${account.operatorId})`))
    .leftJoin(branch, eq(sessionTable.branchId, branch.id))
    .leftJoin(station, eq(sessionTable.stationId, station.id))
    .leftJoin(impersonationSession, eq(impersonationSession.sessionId, sessionTable.id))
    .leftJoin(actorSeat, eq(actorSeat.id, impersonationSession.actorSessionId))
    .where(eq(sessionTable.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.s.expiresAt <= now || row.s.revokedAt) {
    if (row.s.operatorOverride !== null) {
      // Lazy clearing touches only the presented expired/revoked cookie's
      // retained row. It neither deletes history nor sweeps other sessions.
      await db.update(sessionTable).set({ operatorOverride: null }).where(and(
        eq(sessionTable.id, row.s.id), eq(sessionTable.accountId, row.a.id), eq(sessionTable.tokenHash, tokenHash),
        or(lte(sessionTable.expiresAt, now), isNotNull(sessionTable.revokedAt)),
      ));
    }
    return null;
  }
  if (row.a.status !== 'active') return null; // deactivated mid-session → rejected
  /**
   * SCRUM-648 — an impersonation window ends at its expiry, when it is ended,
   * or when the actor's own session ends, whichever comes first. Any of the
   * three refuses the marked session exactly as an expired one is refused.
   */
  if (row.imp && (row.imp.endedAt !== null || row.imp.expiresAt <= now
    || row.actorRevokedAt !== null || !row.actorExpiresAt || row.actorExpiresAt <= now)) return null;
  /**
   * SCRUM-253 — AND THE TENANT AND THE PARK ARE STILL OPEN.
   *
   * A deactivated account was already refused on the line above, at its next
   * request, which is the behaviour archiving should have had and did not:
   * sign-in was closed to an archived operator (`services/auth.ts`) while
   * every session opened before the archiving went on trading, for as long as
   * its cookie lasted. Retiring a park or an operator has to reach the people
   * standing at the tills, not only the sign-in screen.
   *
   * The branch is the session's SEAT, so this refuses the session rather than
   * the branch: a seat at a closed park is not somewhere to keep working from,
   * and the seat is what every route that falls back to `auth.branchId` reads.
   * Signing in again re-seats them, because `seatBranch` only ever considers
   * live branches — so somebody who still holds a grant at a park that is open
   * gets back in, and somebody who does not is told why.
   */
  if (row.operatorArchivedAt || row.branchArchivedAt) return null;
  const operatorId = row.s.operatorOverride ?? row.a.operatorId;
  if (row.s.operatorOverride !== null) {
    if (!row.effectiveOperatorId || row.effectiveOperatorArchivedAt) return null;
    if (row.s.branchId && row.branchOperatorId !== operatorId) return null;
    if (row.s.stationId && (!row.s.branchId || !row.stationId || row.stationArchivedAt
      || row.stationOperatorId !== operatorId || row.stationBranchId !== row.s.branchId)) return null;
    if (!signOutCleanupOnly) {
      if (row.s.sessionClass !== 'staff') throw errors.forbidden('Operator selection requires a staff session.');
      if (!row.switchGrant) throw errors.forbidden('A live platform-wide operator-switch grant is required.');
    }
  }
  const revision = BigInt(row.revision);
  if (revision < 0n || revision >= BigInt(Number.MAX_SAFE_INTEGER)) {
    throw errors.conflict('OPERATOR_SWITCH_REVISION_EXHAUSTED', 'This session cannot accept another operator selection.');
  }
  // Sliding last-seen, throttled to one write a minute. A locked session is
  // not "seen": leaving a locked till open must not keep it alive for ever.
  if (!row.s.lockedAt && now.getTime() - row.s.lastSeenAt.getTime() > 60_000) {
    await db.update(sessionTable).set({ lastSeenAt: now }).where(and(eq(sessionTable.id, row.s.id),
      eq(sessionTable.tokenHash, tokenHash), isNull(sessionTable.revokedAt), gt(sessionTable.expiresAt, now), isNull(sessionTable.lockedAt)));
  }
  return {
    accountId: row.a.id,
    operatorId,
    homeOperatorId: row.a.operatorId,
    operatorOverride: row.s.operatorOverride,
    operatorRevision: Number(revision),
    sessionId: row.s.id,
    branchId: row.s.branchId,
    stationId: row.s.stationId,
    status: row.a.status,
    mustChangePassword: row.a.mustChangePassword,
    // Same real-account assignment definition as isPlatformWide on the native
    // effective permissions; an override never supplies another actor's roles.
    isPlatformAdmin: row.platformWide,
    lockedAt: row.s.lockedAt,
    impersonation: row.imp ? {
      id: row.imp.id, actorAccountId: row.imp.actorAccountId, actorSessionId: row.imp.actorSessionId,
      subjectAccountId: row.imp.subjectAccountId, targetApp: row.imp.targetApp, mode: row.imp.mode, expiresAt: row.imp.expiresAt,
    } : null,
  };
}

/**
 * SCRUM-648 — what a READ-ONLY impersonation window may still send that is
 * not a read: ending itself and the lock screen's own doors. Everything else
 * that writes is refused before its body is parsed, its key claimed or its
 * handler run.
 */
const IMPERSONATION_READ_ONLY_EXEMPT = new Set(['POST:/auth/sign-out', 'POST:/auth/lock', 'POST:/auth/unlock']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function impersonationRefusal(req: FastifyRequest): AppError | null {
  const mark = req.auth?.impersonation;
  if (!mark || mark.mode !== 'read_only' || READ_METHODS.has(req.method) || req.routeOptions.config?.public) return null;
  const url = (req.routeOptions?.url ?? req.url).replace(/\/$/, '') || '/';
  if (IMPERSONATION_READ_ONLY_EXEMPT.has(`${req.method}:${url}`)) return null;
  return new AppError(403, 'IMPERSONATION_READ_ONLY', 'This is a read-only view-as window: nothing can be changed from it.');
}

/** Shared session resolution always enforces working-context eligibility. */
export async function resolveSessionAuth(exec: Exec, token: string): Promise<AuthContext | null> {
  return loadAuth(exec, token);
}

/**
 * Routes a session may call while it is locked or while the account still
 * owes a password change (S2-01a). Everything else on `requireAuth` is
 * business and is refused, exactly as `requirePermission` refuses it — the
 * Sprint 1 gap was that a temp-password account could reach every
 * requireAuth-only route by simply not calling a permissioned one.
 */
const SESSION_STATE_EXEMPT = new Set([
  'POST:/auth/sign-out',
  'POST:/auth/lock',
  'POST:/auth/unlock',
  /**
   * The offline unlock (S2-06), beside the online one and for the same
   * reason: a locked session is exactly the caller it is for. It proves the
   * password against the box's cached hash rather than against the database,
   * so it is the one door that still opens when the link is down.
   */
  'POST:/auth/unlock-offline',
  /**
   * Presenting a badge or typing a PIN (S2-06), which is a SIGN-IN surface and
   * belongs beside the two unlocks for the same reason: the screen it is for
   * is the locked one. It reads nothing and changes nothing — the value goes
   * to the box's scanning service, which today has no handler registered for a
   * staff badge and answers "not linked yet". The day it does authenticate
   * somebody, being reachable here is exactly what it needs to be.
   */
  'POST:/auth/badge',
  /**
   * The station bridge's unlock (offline plan Round 3, OD-2), for the reason
   * the two unlocks above are here: a locked session is exactly who it is
   * for. Its lock, which only ever takes access away. And its status read,
   * which is how a locked till learns whether to unlock through the platform
   * or through its box; it carries no personal data and changes nothing.
   */
  'POST:/box/v1/station/:stationId/unlock',
  'POST:/box/v1/station/:stationId/lock',
  'GET:/box/v1/station/:stationId/status',
  'POST:/auth/change-password',
  'GET:/me',
  'GET:/me/permissions',
]);

function isExempt(req: FastifyRequest): boolean {
  const url = (req.routeOptions?.url ?? req.url).replace(/\/$/, '') || '/';
  return SESSION_STATE_EXEMPT.has(`${req.method}:${url}`);
}

export const sessionPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('auth', null);
  app.decorateRequest(auditRequestScope, null);

  const initializeRequest = async (req: FastifyRequest) => {
    const token = req.cookies?.[SESSION_COOKIE];
    try {
      req.auth = token ? await resolveSessionAuth(app.db, token) : null;
      const refused = impersonationRefusal(req);
      if (refused) throw refused;
    }
    catch (error) {
      // An invalid working override must not close a public sign-in or
      // readiness door. It supplies no authority to their handlers.
      if (!req.routeOptions.config.public || !(error instanceof AppError)
        || error.statusCode !== 403 || error.code !== 'FORBIDDEN') throw error;
      req.auth = null;
      if (req.method === 'POST' && req.routeOptions.url === '/auth/sign-out') {
        // This private exception exists only to end the exact verified
        // session. The public sign-out handler uses native revocation and
        // home-account audit attribution, never a business permission.
        req.auth = token ? await loadAuth(app.db, token, true) : null;
      }
    }

    let cache: EffectivePermission[] | null = null;
    req.effectivePermissions = async () => {
      if (!req.auth) return [];
      cache ??= await resolveEffectivePermissions(app.db, req.auth.accountId);
      return cache;
    };

    req.requireAuth = () => {
      if (!req.auth) throw errors.unauthorized();
      // A locked session exists but may do no business, and a temp-password
      // account must change it first. Both checks live here rather than only
      // in requirePermission so that requireAuth-only routes are covered too.
      if (!isExempt(req)) {
        if (req.auth.lockedAt) {
          throw new AppError(423, 'SESSION_LOCKED', 'This session is locked — unlock to continue');
        }
        if (req.auth.mustChangePassword) {
          throw new AppError(403, 'MUST_CHANGE_PASSWORD', 'Password change required before continuing');
        }
      }
      return req.auth;
    };

    req.requirePermission = async (permission, target = {}) => {
      const auth = req.requireAuth();
      const effective = await req.effectivePermissions();
      // SCRUM-606 — an operator-wide target names no branch, and must not
      // inherit the session's: that is what let a grant at one park pass.
      const fullTarget: ScopeTarget = target.operatorOnly
        ? { operatorId: target.operatorId ?? auth.operatorId, operatorOnly: true }
        : {
            operatorId: target.operatorId ?? auth.operatorId,
            branchId: target.branchId ?? auth.branchId ?? undefined,
            departmentId: target.departmentId,
            recordId: target.recordId,
          };
      // A platform grant stays a real-account fact, but ordinary business
      // permission checks cannot use it to escape a chosen working operator.
      if (auth.operatorOverride != null && fullTarget.operatorId !== auth.operatorId) {
        throw new PermissionDeniedError(permission);
      }
      if (!hasPermission(effective, permission, fullTarget)) {
        /**
         * SCRUM-300 — "you do not have this" and "not here" are different
         * answers, and every branch-targeted route used to give the first one
         * for both. `branchScopeRefusal` names the branch when the caller holds
         * the permission at another one, and returns null when they hold it
         * nowhere, which is where the plain refusal is the accurate sentence.
         *
         * Asked of the CALLER's operator rather than `fullTarget.operatorId`:
         * a route may target another operator, and a refusal that named that
         * operator's branch would be a worse leak than the message it fixed.
         * Cross-operator ids simply do not resolve, so they fall through to
         * the plain refusal.
         */
        const elsewhere = fullTarget.branchId
          ? await branchScopeRefusal(
              app.db,
              effective,
              permission,
              auth.operatorId,
              fullTarget.branchId,
            )
          : null;
        throw elsewhere ?? new PermissionDeniedError(permission);
      }
      return auth;
    };
  };

  app.addHook('onRequest', (req, _reply, done) => {
    void initializeRequest(req).then(() => {
      runWithAuditContext(req.auth, () => {
        const scope = new AsyncResource('oto-verified-audit-request');
        Object.defineProperty(req, auditRequestScope, { value: scope });
        scope.runInAsyncScope(done, req.raw);
      });
    }, done);
  });

  /**
   * SCRUM-648 — every request in a view-as window is an audit row of its own,
   * reads included and refusals included: the actor really there, the subject
   * whose session it was, the route and the answer. Never the body.
   */
  app.addHook('onSend', async (req, reply, payload) => {
    const mark = req.auth?.impersonation;
    if (!mark) return payload;
    try {
      await audit.record(app.db, {
        actorAccountId: mark.actorAccountId, actorType: 'impersonated', onBehalfOf: mark.subjectAccountId,
        operatorId: req.auth!.operatorId, branchId: req.auth!.branchId, action: 'impersonation.request',
        entityType: 'impersonation_session', entityId: mark.id, requestId: req.id,
        after: { method: req.method, route: req.routeOptions?.url ?? null, status: reply.statusCode, mode: mark.mode },
        targetApp: mark.targetApp, origin: 'impersonation',
      });
    } catch (err) {
      req.log.error({ err }, 'an impersonation request could not be recorded');
    }
    return payload;
  });

  app.addHook('preValidation', (req, _reply, done) => {
    // A parsed body resumes through a raw request event. Re-enter the one
    // captured resource; never read the session again or rebuild its context.
    const scope = (req as AuditRequest)[auditRequestScope];
    if (scope) scope.runInAsyncScope(done, req.raw);
    else runWithAuditContext(null, done);
  });
});
