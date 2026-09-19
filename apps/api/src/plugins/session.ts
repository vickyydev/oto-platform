import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { account, session as sessionTable, type Db } from '@oto/db';
import type { Permission } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { hasPermission, resolveEffectivePermissions, type EffectivePermission, type ScopeTarget } from '../services/permissions';

export const SESSION_COOKIE = 'oto_session';

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
    .select({ s: sessionTable, a: account })
    .from(sessionTable)
    .innerJoin(account, eq(sessionTable.accountId, account.id))
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
      return req.auth;
    };

    req.requirePermission = async (permission, target = {}) => {
      const auth = req.requireAuth();
      // A locked session exists but may do no business: the unlock route is
      // the only way back in (it uses requireAuth, not requirePermission).
      if (auth.lockedAt) {
        throw new AppError(423, 'SESSION_LOCKED', 'This session is locked — unlock to continue');
      }
      // A temp-password account must change it before doing anything else.
      if (auth.mustChangePassword) {
        throw new AppError(403, 'MUST_CHANGE_PASSWORD', 'Password change required before continuing');
      }
      const effective = await req.effectivePermissions();
      const fullTarget: ScopeTarget = {
        operatorId: target.operatorId ?? auth.operatorId,
        branchId: target.branchId ?? auth.branchId ?? undefined,
        departmentId: target.departmentId,
        recordId: target.recordId,
      };
      if (!hasPermission(effective, permission, fullTarget)) {
        throw errors.forbidden(`Missing permission ${permission}`);
      }
      return auth;
    };
  });
});
