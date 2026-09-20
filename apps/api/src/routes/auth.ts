import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { account } from '@oto/db';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { clearSessionCookie, setSessionCookie, SESSION_COOKIE } from '../plugins/session';
import {
  consumeCode,
  findAccountByPhone,
  invalidateAllSessions,
  issueCode,
  lockSession,
  setPassword,
  signIn,
  signOut,
  unlockSession,
} from '../services/auth';
import {
  appAccessPermission,
  exchangeHandoff,
  handoffConfig,
  HandoffRejected,
  HANDOFF_APPS,
  issueHandoff,
  releaseIdempotencyClaim,
  type HandoffConfig,
} from '../services/handoff';
import { audit } from '../services/audit';
import { opCtx, withTx } from '../services/tx';
import { limitPrincipal } from '../services/throttle';
import { ipLimited } from '../plugins/rate-limit';
import { verify } from '@node-rs/argon2';

const PhoneSchema = z.string().min(6).max(32);

export async function authRoutes(app: App): Promise<void> {
  /**
   * Read per request rather than at registration: an api with no hand-off
   * configured still serves every other route, and answers these two with a
   * 503 that names the variables.
   */
  const handoff = (): HandoffConfig =>
    handoffConfig({
      signingKey: app.env.HANDOFF_SIGNING_KEY,
      appOrigins: app.env.HANDOFF_APP_ORIGINS,
      ttlSeconds: app.env.HANDOFF_TOKEN_TTL_S,
    });

  // SCRUM-19 — sign in by phone + password.
  app.post(
    '/sign-in',
    {
      // Open by definition: this is where a session comes from. Fenced by
      // the Postgres-backed failure throttle rather than by a permission.
      config: { public: true },
      schema: {
        description: 'Sign in with phone + password; sets the session cookie.',
        body: z.object({ phone: PhoneSchema, password: z.string().min(1) }),
      },
    },
    async (req, reply) => {
      const { phone, password } = req.body;
      const result = await signIn(app.db, {
        phone,
        password,
        ip: req.ip,
        ttlHours: app.env.SESSION_TTL_HOURS,
        maxFailures: app.env.AUTH_MAX_FAILURES,
        cooldownSeconds: app.env.AUTH_COOLDOWN_SECONDS,
        requestId: req.id,
      });
      setSessionCookie(reply, result.token, app.env.SESSION_TTL_HOURS, app.env.COOKIE_SECURE);
      return { accountId: result.accountId, mustChangePassword: result.mustChangePassword };
    },
  );

  // SCRUM-24 — sign out. This is the ONLY user action that ends a session
  // (S2-01a): the POS inactivity timer locks instead, so unlocking never
  // needs the network — the rule an offline box depends on later.
  app.post(
    '/sign-out',
    { config: { public: true }, schema: { description: 'Sign out' } },
    async (req, reply) => {
    const auth = req.auth;
    if (auth) await signOut(app.db, auth.sessionId, auth.accountId, req.id);
    clearSessionCookie(reply, app.env.COOKIE_SECURE);
    return { ok: true };
  });

  // S2-01a — lock: the session survives, but may do no business until it is
  // unlocked with the password.
  app.post(
    '/lock',
    { config: { auth: 'session' }, schema: { description: 'Lock this session (inactivity)' } },
    async (req) => {
    const auth = req.requireAuth();
    await lockSession(app.db, auth.sessionId, auth.accountId, req.id);
    return { locked: true };
  });

  // S2-01a — unlock: re-verify the password against the SAME session, under
  // the sign-in throttle so an unattended till cannot be brute-forced.
  app.post(
    '/unlock',
    {
      config: { auth: 'session' },
      schema: {
        description: 'Unlock this session by re-entering the password',
        body: z.object({ password: z.string().min(1) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await unlockSession(app.db, {
        sessionId: auth.sessionId,
        accountId: auth.accountId,
        password: req.body.password,
        ip: req.ip,
        maxFailures: app.env.AUTH_MAX_FAILURES,
        cooldownSeconds: app.env.AUTH_COOLDOWN_SECONDS,
        requestId: req.id,
      });
      return { locked: false };
    },
  );

  /**
   * S2-02 — mint a hand-off for one app.
   *
   * `dynamicPermission`: the permission is the app being asked for, so a
   * reception account cannot mint itself a console token. A locked session or
   * one still owing a password change is refused by `requireAuth` before any
   * of this, which is what stops a locked launcher opening a fresh till.
   */
  app.post(
    '/handoff',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Issue a short-lived signed hand-off token for one app origin',
        body: z.object({ app: z.enum(HANDOFF_APPS) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const audience = req.body.app;
      // Before the configuration is read: what this deployment can and cannot
      // do is not something to tell a caller who may not ask in the first place.
      await req.requirePermission(appAccessPermission(audience));
      const config = handoff();

      // Present by definition — `requireAuth` resolved the session from it.
      const sessionToken = req.cookies[SESSION_COOKIE];
      if (!sessionToken) throw errors.unauthorized();

      // Before `opCtx` reads the claim: this response is a credential and
      // must not be kept in the day-long replay store.
      await releaseIdempotencyClaim(app.db, req);

      const issued = await withTx(app.db, opCtx(req), 'auth.handoff_issue', async (tx) => {
        const out = await issueHandoff(tx, config, {
          sessionId: auth.sessionId,
          accountId: auth.accountId,
          sessionToken,
          audience,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'auth.handoff_issue',
          entityType: 'session',
          entityId: auth.sessionId,
          // The jti, never the token.
          after: { jti: out.jti, audience },
          requestId: req.id,
        });
        return out;
      });

      return {
        token: issued.token,
        audience: issued.audience,
        origin: issued.origin,
        // The fragment is load-bearing: it is never sent to a server, so the
        // token reaches no access log, no proxy and no Referer.
        launchUrl: issued.launchUrl,
        expiresAt: issued.expiresAt.toISOString(),
      };
    },
  );

  /**
   * S2-02 — exchange a hand-off for this origin's own session cookie.
   *
   * Open by necessity: the app's origin has no session yet, which is the
   * whole point. The token is the credential, and it is fenced by its
   * signature, its one-minute life and its single-use jti.
   */
  app.post(
    '/handoff/exchange',
    {
      config: { ...ipLimited, public: true },
      schema: {
        description: 'Exchange a hand-off token for a session cookie on this origin',
        body: z.object({ token: z.string().min(20).max(8192) }),
      },
    },
    async (req, reply) => {
      const config = handoff();
      try {
        const origin = req.headers.origin;
        if (!origin) {
          // A browser always sends `Origin` on a cross-origin write, and the
          // audience check is the only thing tying a token to one app.
          throw new HandoffRejected('origin', 'A hand-off must be exchanged from the app it was issued for');
        }
        const result = await exchangeHandoff(app.db, config, { token: req.body.token, origin });

        // The SAME session row, so signing out anywhere ends every app at
        // once; the cookie is host-only to this origin and never outlives the
        // session behind it.
        const remainingHours = (result.sessionExpiresAt.getTime() - Date.now()) / 3600_000;
        setSessionCookie(reply, result.sessionToken, remainingHours, app.env.COOKIE_SECURE);

        await audit.record(app.db, {
          actorAccountId: result.accountId,
          operatorId: result.operatorId,
          action: 'auth.handoff_exchange',
          entityType: 'session',
          entityId: result.sessionId,
          after: { jti: result.jti, audience: result.audience },
          requestId: req.id,
        });

        return {
          accountId: result.accountId,
          audience: result.audience,
          mustChangePassword: result.mustChangePassword,
          sessionLocked: result.sessionLocked,
        };
      } catch (err) {
        if (err instanceof HandoffRejected) {
          // Written on the pool, after the claim it may have just spent: the
          // record of a refusal has to outlive whatever was refused.
          await audit.record(app.db, {
            // A refused hand-off has no authenticated actor. Whom it CLAIMED
            // to be goes in `after`, never in the column that references a
            // real account: an id read off a credential we have just refused
            // is not an id to trust with a foreign key.
            actorAccountId: null,
            action: 'auth.handoff_rejected',
            entityType: 'handoff',
            // A bad signature leaves nothing to attribute it to but the request.
            entityId: err.context.jti ?? req.id,
            after: {
              reason: err.reason,
              audience: err.context.audience ?? null,
              sessionId: err.context.sessionId ?? null,
              accountId: err.context.accountId ?? null,
            },
            requestId: req.id,
          });
        }
        throw err;
      }
    },
  );

  // SCRUM-20 — invited account setup: request the verification code…
  app.post(
    '/setup/start',
    {
      config: { ...ipLimited, public: true },
      schema: { description: 'Send the setup code to an invited account', body: z.object({ phone: PhoneSchema }) },
    },
    async (req) => {
      const { account: acc, phone } = await findAccountByPhone(app.db, req.body.phone);
      // Counted for every phone, existing or not: an SMS costs money and a
      // differing response would itself tell an attacker which phones exist.
      await limitPrincipal(
        app.db,
        `setup:${phone}`,
        app.env.RATE_LIMIT_CODE_MAX,
        app.env.RATE_LIMIT_CODE_WINDOW_SECONDS,
      );
      if (!acc || acc.status !== 'invited') {
        // Do not leak which phones exist — same response either way.
        return { ok: true };
      }
      // No transaction is open here, so the wait on the provider costs an
      // HTTP request and nothing else — see `issueCode`.
      await issueCode(app.db, app.sms, acc.id, phone, 'setup');
      return { ok: true };
    },
  );

  // …then verify the code and set the password (both steps complete setup).
  app.post(
    '/setup/complete',
    {
      config: { ...ipLimited, public: true },
      schema: {
        description: 'Verify phone with the code and set the first password',
        body: z.object({ phone: PhoneSchema, code: z.string().length(6), password: z.string().min(8) }),
      },
    },
    async (req) => {
      const { account: acc } = await findAccountByPhone(app.db, req.body.phone);
      if (!acc || acc.status !== 'invited') throw errors.badRequest('No pending setup for this phone');
      await consumeCode(app.db, acc.id, 'setup', req.body.code, app.env.CODE_MAX_ATTEMPTS);
      await setPassword(app.db, acc.id, req.body.password);
      await app.db
        .update(account)
        .set({ status: 'active', phoneVerifiedAt: new Date() })
        .where(eq(account.id, acc.id));
      await audit.record(app.db, {
        actorAccountId: acc.id,
        operatorId: acc.operatorId,
        action: 'auth.setup_complete',
        entityType: 'account',
        entityId: acc.id,
        requestId: req.id,
      });
      return { ok: true };
    },
  );

  // SCRUM-23 — password recovery.
  app.post(
    '/password-reset/request',
    {
      config: { ...ipLimited, public: true },
      schema: { description: 'Send a reset code to a verified phone', body: z.object({ phone: PhoneSchema }) },
    },
    async (req) => {
      const { account: acc, phone } = await findAccountByPhone(app.db, req.body.phone);
      await limitPrincipal(
        app.db,
        `reset:${phone}`,
        app.env.RATE_LIMIT_CODE_MAX,
        app.env.RATE_LIMIT_CODE_WINDOW_SECONDS,
      );
      if (acc && acc.status === 'active' && acc.phoneVerifiedAt) {
        await issueCode(app.db, app.sms, acc.id, phone, 'password_reset');
      }
      return { ok: true }; // never leak account existence
    },
  );

  app.post(
    '/password-reset/complete',
    {
      config: { ...ipLimited, public: true },
      schema: {
        description: 'Reset the password with the code; invalidates every session',
        body: z.object({ phone: PhoneSchema, code: z.string().length(6), password: z.string().min(8) }),
      },
    },
    async (req) => {
      const { account: acc } = await findAccountByPhone(app.db, req.body.phone);
      if (!acc) throw errors.badRequest('Invalid code');
      await consumeCode(app.db, acc.id, 'password_reset', req.body.code, app.env.CODE_MAX_ATTEMPTS);
      await setPassword(app.db, acc.id, req.body.password);
      await invalidateAllSessions(app.db, acc.id);
      await audit.record(app.db, {
        actorAccountId: acc.id,
        operatorId: acc.operatorId,
        action: 'auth.password_reset',
        entityType: 'account',
        entityId: acc.id,
        requestId: req.id,
      });
      return { ok: true };
    },
  );

  // Forced change for temporary passwords (SCRUM-28) and voluntary changes.
  app.post(
    '/change-password',
    {
      config: { auth: 'session' },
      schema: {
        description: 'Change the password of the signed-in account',
        body: z.object({ currentPassword: z.string().min(1), password: z.string().min(8) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const rows = await app.db.select().from(account).where(eq(account.id, auth.accountId)).limit(1);
      const acc = rows[0];
      if (!acc?.passwordHash || !(await verify(acc.passwordHash, req.body.currentPassword))) {
        throw errors.badRequest('Current password is incorrect');
      }
      await setPassword(app.db, auth.accountId, req.body.password);
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        action: 'auth.password_change',
        entityType: 'account',
        entityId: auth.accountId,
        requestId: req.id,
      });
      return { ok: true };
    },
  );
}
