import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { account, branch, operator, session as sessionTable, type Db } from '@oto/db';
import type { Permission } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { branchScopeRefusal } from '../services/access-control';
import { hasPermission, resolveEffectivePermissions, type EffectivePermission, type ScopeTarget } from '../services/permissions';

export const SESSION_COOKIE = 'oto_session';

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

export interface AuthContext {
  accountId: string;
  operatorId: string;
  sessionId: string;
  branchId: string | null;
  stationId: string | null;
  status: 'invited' | 'active' | 'inactive';
  mustChangePassword: boolean;
  isPlatformAdmin: boolean;
  /** Set while the POS is locked on inactivity; business routes refuse. */
  lockedAt: Date | null;
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

async function loadAuth(db: Db, token: string): Promise<AuthContext | null> {
  const now = new Date();
  const rows = await db
    .select({
      s: sessionTable,
      a: account,
      operatorArchivedAt: operator.archivedAt,
      // Left-joined: a session may legitimately sit at no branch at all, and
      // null then means "no branch", which is not "an archived branch".
      branchArchivedAt: branch.archivedAt,
    })
    .from(sessionTable)
    .innerJoin(account, eq(sessionTable.accountId, account.id))
    .innerJoin(operator, eq(account.operatorId, operator.id))
    .leftJoin(branch, eq(sessionTable.branchId, branch.id))
    .where(
      and(
        eq(sessionTable.tokenHash, hashToken(token)),
        gt(sessionTable.expiresAt, now),
        isNull(sessionTable.revokedAt), // signed out, or force signed-out
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.a.status !== 'active') return null; // deactivated mid-session → rejected
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
  // Sliding last-seen, throttled to one write a minute. A locked session is
  // not "seen": leaving a locked till open must not keep it alive for ever.
  if (!row.s.lockedAt && now.getTime() - row.s.lastSeenAt.getTime() > 60_000) {
    await db.update(sessionTable).set({ lastSeenAt: now }).where(eq(sessionTable.id, row.s.id));
  }
  return {
    accountId: row.a.id,
    operatorId: row.a.operatorId,
    sessionId: row.s.id,
    branchId: row.s.branchId,
    stationId: row.s.stationId,
    status: row.a.status,
    mustChangePassword: row.a.mustChangePassword,
    isPlatformAdmin: false, // refined lazily by the permission resolver
    lockedAt: row.s.lockedAt,
  };
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

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const token = req.cookies?.[SESSION_COOKIE];
    req.auth = token ? await loadAuth(app.db, token) : null;

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
      const fullTarget: ScopeTarget = {
        operatorId: target.operatorId ?? auth.operatorId,
        branchId: target.branchId ?? auth.branchId ?? undefined,
        departmentId: target.departmentId,
        recordId: target.recordId,
      };
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
  });
});
