import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { account } from '@oto/db';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { clearSessionCookie, setSessionCookie } from '../plugins/session';
import {
  consumeCode,
  findAccountByPhone,
  invalidateAllSessions,
  issueCode,
  setPassword,
  signIn,
  signOut,
} from '../services/auth';
import { audit } from '../services/audit';
import { verify } from '@node-rs/argon2';

const PhoneSchema = z.string().min(6).max(32);

export async function authRoutes(app: App): Promise<void> {
  // SCRUM-19 — sign in by phone + password.
  app.post(
    '/sign-in',
    {
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

  // SCRUM-24 — sign out: delete the server-side session.
  app.post('/sign-out', { schema: { description: 'Sign out' } }, async (req, reply) => {
    const auth = req.auth;
    if (auth) await signOut(app.db, auth.sessionId, auth.accountId, req.id);
    clearSessionCookie(reply, app.env.COOKIE_SECURE);
    return { ok: true };
  });

  // SCRUM-20 — invited account setup: request the verification code…
  app.post(
    '/setup/start',
    { schema: { description: 'Send the setup code to an invited account', body: z.object({ phone: PhoneSchema }) } },
    async (req) => {
      const { account: acc, phone } = await findAccountByPhone(app.db, req.body.phone);
      if (!acc || acc.status !== 'invited') {
        // Do not leak which phones exist — same response either way.
        return { ok: true };
      }
      await issueCode(app.db, app.sms, acc.id, phone, 'setup', req.id);
      return { ok: true };
    },
  );

  // …then verify the code and set the password (both steps complete setup).
  app.post(
    '/setup/complete',
    {
      schema: {
        description: 'Verify phone with the code and set the first password',
        body: z.object({ phone: PhoneSchema, code: z.string().length(6), password: z.string().min(8) }),
      },
    },
    async (req) => {
      const { account: acc } = await findAccountByPhone(app.db, req.body.phone);
      if (!acc || acc.status !== 'invited') throw errors.badRequest('No pending setup for this phone');
      await consumeCode(app.db, acc.id, 'setup', req.body.code);
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
    { schema: { description: 'Send a reset code to a verified phone', body: z.object({ phone: PhoneSchema }) } },
    async (req) => {
      const { account: acc, phone } = await findAccountByPhone(app.db, req.body.phone);
      if (acc && acc.status === 'active' && acc.phoneVerifiedAt) {
        await issueCode(app.db, app.sms, acc.id, phone, 'password_reset', req.id);
      }
      return { ok: true }; // never leak account existence
    },
  );

  app.post(
    '/password-reset/complete',
    {
      schema: {
        description: 'Reset the password with the code; invalidates every session',
        body: z.object({ phone: PhoneSchema, code: z.string().length(6), password: z.string().min(8) }),
      },
    },
    async (req) => {
      const { account: acc } = await findAccountByPhone(app.db, req.body.phone);
      if (!acc) throw errors.badRequest('Invalid code');
      await consumeCode(app.db, acc.id, 'password_reset', req.body.code);
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
