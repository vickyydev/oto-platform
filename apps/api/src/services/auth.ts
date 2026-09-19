import { hash, verify } from '@node-rs/argon2';
import { createHash, randomInt } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  account,
  authThrottle,
  branch,
  session as sessionTable,
  verificationCode,
  type Db,
} from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import type { Exec } from './tx';
import { bumpWindow } from './throttle';
import type { SmsSender } from './sms';
import { hashToken, newSessionToken } from '../plugins/session';

// --- Failure throttling (SCRUM-19, hardened in S2-01a) ---------------------
// Counters live in Postgres, not memory: a Render restart used to clear every
// cooldown, so an attacker only had to wait for a deploy. Keys are buckets —
// "phone:+66…", "ip:…", "unlock:<sessionId>", "code:<accountId>:<purpose>".

export async function throttleCheck(db: Db, keys: string[]): Promise<void> {
  const now = new Date();
  const rows = await db.select().from(authThrottle).where(inArray(authThrottle.key, keys));
  for (const r of rows) {
    if (r.lockedUntil && r.lockedUntil > now) {
      const seconds = Math.ceil((r.lockedUntil.getTime() - now.getTime()) / 1000);
      throw errors.tooMany(`Too many failed attempts. Try again in ${seconds}s.`);
    }
  }
}

export async function throttleFail(
  db: Db,
  keys: string[],
  maxFailures: number,
  cooldownSeconds: number,
): Promise<void> {
  const now = new Date();
  for (const key of keys) {
    // One statement, so two racing requests cannot both read "4 failures".
    await db
      .insert(authThrottle)
      .values({ key, failures: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: authThrottle.key,
        set: {
          failures: sql`case when ${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} <= now() then 1 else ${authThrottle.failures} + 1 end`,
          lockedUntil: sql`case when (case when ${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} <= now() then 1 else ${authThrottle.failures} + 1 end) >= ${maxFailures} then now() + ${`${cooldownSeconds} seconds`}::interval else ${authThrottle.lockedUntil} end`,
          updatedAt: now,
        },
      });
  }
}

export async function throttleClear(db: Exec, keys: string[]): Promise<void> {
  if (keys.length) await db.delete(authThrottle).where(inArray(authThrottle.key, keys));
}

/** Test hook: wipe throttle state between cases. */
export async function _resetThrottle(db: Db): Promise<void> {
  await db.delete(authThrottle);
}

// --- Verification codes (SCRUM-20/23) --------------------------------------

const CODE_TTL_MS = 10 * 60_000;

const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');

export type CodePurpose = 'setup' | 'password_reset';

/**
 * A code that has been stored but not yet delivered.
 *
 * `message` holds the code in the clear. It travels from `mintCode` to the
 * SMS adapter and nowhere else: never a log line, never a response body,
 * never an audit row, never the stored idempotent response.
 */
export interface PendingCode {
  accountId: string;
  phone: string;
  purpose: CodePurpose;
  message: string;
}

const codeMessage = (purpose: CodePurpose, code: string): string =>
  purpose === 'setup'
    ? `Your OTO account setup code is ${code}`
    : `Your OTO password reset code is ${code}`;

/** What reception is told when the account is there but the code is not. */
const UNDELIVERED: Record<CodePurpose, string> = {
  setup:
    'The account was created, but its setup code could not be sent. Ask them to tap ' +
    '"First shift? Set up account" on the sign-in screen for a new code, or issue a ' +
    'temporary password.',
  password_reset: 'The reset code could not be sent — ask for a new one in a moment.',
};

/**
 * Mint a verification code and store it, WITHOUT sending it.
 *
 * Takes an `Exec` so the row can be written inside the transaction that
 * creates the account: the code is part of that account existing. Delivery is
 * deliberately left to the caller, after the commit. A send is an HTTPS call
 * to Twilio with a ten-second deadline and up to three attempts — about
 * thirty-one seconds in the worst case — while
 * `idle_in_transaction_session_timeout` is thirty. Sending from inside the
 * transaction therefore pinned a pool connection for the length of a
 * third-party call and, past the timeout, lost the whole account to a
 * rollback with the SMS already on its way to the phone.
 */
export async function mintCode(
  db: Exec,
  accountId: string,
  phone: string,
  purpose: CodePurpose,
): Promise<PendingCode> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.insert(verificationCode).values({
    id: newId(),
    accountId,
    purpose,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  // A newly issued code gets a fresh guess budget.
  await throttleClear(db, [`code:${accountId}:${purpose}`]);
  return { accountId, phone, purpose, message: codeMessage(purpose, code) };
}

export interface CodeDelivery {
  /** False when the row is committed but the provider did not take it. */
  codeSent: boolean;
  /** Present only when it did not go out: what happened and what to do. */
  warning?: { code: string; message: string };
}

/**
 * Deliver a code minted inside a transaction that has now committed.
 *
 * A failure here is not a failure of the operation: the account exists and
 * cannot be taken back, so the send is reported rather than thrown. Answering
 * 5xx would both contradict the account's existence and make the retry worse
 * — the idempotency plugin releases the key on a 5xx, so an identical retry
 * would run again, find the phone taken and answer 409 without ever
 * re-sending anything.
 */
export async function deliverCode(
  sms: SmsSender,
  pending: PendingCode,
  log: FastifyBaseLogger,
): Promise<CodeDelivery> {
  try {
    await sms.send(pending.phone, pending.message);
    return { codeSent: true };
  } catch (err) {
    // The adapter has already logged the provider's side against a phone
    // hash; this line names the account, which is what an administrator acts
    // on. `err` itself is never logged: undici hangs the request off it, and
    // the request body is the code.
    log.error(
      { accountId: pending.accountId, reason: err instanceof AppError ? err.code : 'UNKNOWN' },
      'row committed but the verification code could not be delivered',
    );
    return {
      codeSent: false,
      warning: { code: 'SMS_DELIVERY_FAILED', message: UNDELIVERED[pending.purpose] },
    };
  }
}

/**
 * Mint and send in one step, for the two callers that hold no transaction:
 * `/auth/setup/start` and `/auth/password-reset/request`.
 *
 * Those two wait for the provider — up to about thirty-one seconds when
 * Twilio is degraded — and that is deliberate. They hold an HTTP request
 * open, not a transaction and not a pool connection (each statement returns
 * its connection before the send begins), and the person who just pressed
 * "Send code" is entitled to be told the code is not coming rather than left
 * watching a phone that will never buzz.
 */
export async function issueCode(
  db: Exec,
  sms: SmsSender,
  accountId: string,
  phone: string,
  purpose: CodePurpose,
): Promise<void> {
  const pending = await mintCode(db, accountId, phone, purpose);
  await sms.send(pending.phone, pending.message);
}

/**
 * Verify + consume a single-use, time-limited code. Throws when invalid.
 *
 * A six-digit code is one in a million, which a script exhausts in minutes if
 * guesses are free. After `maxAttempts` wrong ones every outstanding code for
 * that account and purpose is invalidated (S2-01a), so the attacker has to go
 * back through the per-phone rate limit to get another.
 */
export async function consumeCode(
  db: Db,
  accountId: string,
  purpose: CodePurpose,
  code: string,
  maxAttempts = 5,
): Promise<void> {
  const attemptKey = `code:${accountId}:${purpose}`;
  const rows = await db
    .select()
    .from(verificationCode)
    .where(
      and(
        eq(verificationCode.accountId, accountId),
        eq(verificationCode.purpose, purpose),
        eq(verificationCode.codeHash, hashCode(code)),
        isNull(verificationCode.consumedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    // The window matches the code's own lifetime: a fresh code starts a
    // fresh budget of guesses, it does not inherit the old one's.
    const { current } = await bumpWindow(db, attemptKey, CODE_TTL_MS);
    if (current >= maxAttempts) {
      await db
        .update(verificationCode)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(verificationCode.accountId, accountId),
            eq(verificationCode.purpose, purpose),
            isNull(verificationCode.consumedAt),
          ),
        );
      throw errors.badRequest('Too many wrong codes — request a new one');
    }
    throw errors.badRequest('Invalid code');
  }
  if (row.expiresAt < new Date()) throw errors.badRequest('Code expired — request a new one');
  await db
    .update(verificationCode)
    .set({ consumedAt: new Date() })
    .where(eq(verificationCode.id, row.id));
  await throttleClear(db, [attemptKey]);
}

// --- Accounts & sessions ----------------------------------------------------

/**
 * Look an account up by phone. `operatorId` scopes the search: phone is
 * unique per operator, not globally, so an unscoped lookup could return
 * another tenant's account (S2-01a). It stays optional because sign-in
 * itself has no operator yet — a single-operator deployment today, and the
 * route that needs scoping passes it.
 */
export async function findAccountByPhone(db: Db, rawPhone: string, operatorId?: string) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw errors.badRequest('Invalid phone number');
  const where = operatorId
    ? and(eq(account.phone, phone), eq(account.operatorId, operatorId))
    : eq(account.phone, phone);
  const rows = await db.select().from(account).where(where).limit(1);
  return { phone, account: rows[0] ?? null };
}

export interface SignInResult {
  token: string;
  accountId: string;
  mustChangePassword: boolean;
}

export async function signIn(
  db: Db,
  opts: {
    phone: string;
    password: string;
    ip: string;
    ttlHours: number;
    maxFailures: number;
    cooldownSeconds: number;
    requestId?: string;
    /** Scopes the phone lookup when the caller knows the tenant. */
    operatorId?: string;
  },
): Promise<SignInResult> {
  const { phone, account: acc } = await findAccountByPhone(db, opts.phone, opts.operatorId);
  // Per-phone at the configured limit; per-IP at 4× so one shared reception
  // IP isn't locked out by a single guessed phone (many tills share an IP).
  await throttleCheck(db, [`phone:${phone}`, `ip:${opts.ip}`]);

  const fail = async (): Promise<never> => {
    await throttleFail(db, [`phone:${phone}`], opts.maxFailures, opts.cooldownSeconds);
    await throttleFail(db, [`ip:${opts.ip}`], opts.maxFailures * 4, opts.cooldownSeconds);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Phone or password is incorrect');
  };

  if (!acc) await fail();
  // Status checks come BEFORE the password check so invited/inactive accounts
  // get their clear message (SCRUM-19) rather than a generic 401.
  if (acc!.status === 'invited') {
    throw new AppError(403, 'SETUP_REQUIRED', 'Finish your account setup before signing in');
  }
  if (acc!.status === 'inactive') {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated — contact a manager');
  }
  if (!acc!.passwordHash || !(await verify(acc!.passwordHash, opts.password))) await fail();

  await throttleClear(db, [`phone:${phone}`, `ip:${opts.ip}`]);

  // Active branch defaults to the operator's first active branch.
  const branches = await db
    .select()
    .from(branch)
    .where(and(eq(branch.operatorId, acc!.operatorId), isNull(branch.archivedAt)))
    .limit(1);

  const token = newSessionToken();
  const sessionId = newId();
  await db.insert(sessionTable).values({
    id: sessionId,
    accountId: acc!.id,
    tokenHash: hashToken(token),
    branchId: branches[0]?.id ?? null,
    expiresAt: new Date(Date.now() + opts.ttlHours * 3600_000),
  });
  await audit.record(db, {
    actorAccountId: acc!.id,
    operatorId: acc!.operatorId,
    action: 'auth.sign_in',
    entityType: 'session',
    entityId: sessionId,
    requestId: opts.requestId,
  });
  return { token, accountId: acc!.id, mustChangePassword: acc!.mustChangePassword };
}

/**
 * End one session. The row is revoked rather than deleted (S2-01a) so that
 * "who ended this session, when and why" survives for audit; `loadAuth`
 * refuses a revoked session exactly as it refuses an expired one.
 */
export async function signOut(db: Db, sessionId: string, actorAccountId: string, requestId?: string): Promise<void> {
  await db
    .update(sessionTable)
    .set({ revokedAt: new Date(), revokedReason: 'sign_out' })
    .where(and(eq(sessionTable.id, sessionId), isNull(sessionTable.revokedAt)));
  await audit.record(db, {
    actorAccountId,
    action: 'auth.sign_out',
    entityType: 'session',
    entityId: sessionId,
    requestId,
  });
}

/** Revoke every live session an account holds. Returns how many were ended. */
export async function invalidateAllSessions(
  db: Exec,
  accountId: string,
  reason = 'invalidated',
): Promise<number> {
  const ended = await db
    .update(sessionTable)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(sessionTable.accountId, accountId), isNull(sessionTable.revokedAt)))
    .returning({ id: sessionTable.id });
  return ended.length;
}

/** Lock a session on POS inactivity: it survives, but may do no business. */
export async function lockSession(
  db: Db,
  sessionId: string,
  actorAccountId: string,
  requestId?: string,
): Promise<void> {
  await db
    .update(sessionTable)
    .set({ lockedAt: new Date() })
    .where(and(eq(sessionTable.id, sessionId), isNull(sessionTable.lockedAt)));
  await audit.record(db, {
    actorAccountId,
    action: 'auth.lock',
    entityType: 'session',
    entityId: sessionId,
    requestId,
  });
}

/**
 * Unlock by re-entering the password on the SAME session. Throttled per
 * session and per account so an unattended locked till cannot be guessed at;
 * a wrong password never reveals whether the session or the account is at
 * fault.
 */
export async function unlockSession(
  db: Db,
  opts: {
    sessionId: string;
    accountId: string;
    password: string;
    ip: string;
    maxFailures: number;
    cooldownSeconds: number;
    requestId?: string;
  },
): Promise<void> {
  const keys = [`unlock:${opts.sessionId}`, `unlock-account:${opts.accountId}`];
  await throttleCheck(db, keys);

  const [acc] = await db.select().from(account).where(eq(account.id, opts.accountId)).limit(1);
  const ok = Boolean(acc?.passwordHash) && (await verify(acc!.passwordHash!, opts.password));
  if (!ok) {
    await throttleFail(db, keys, opts.maxFailures, opts.cooldownSeconds);
    await audit.record(db, {
      actorAccountId: opts.accountId,
      operatorId: acc?.operatorId,
      action: 'auth.unlock_failed',
      entityType: 'session',
      entityId: opts.sessionId,
      requestId: opts.requestId,
    });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
  }

  await throttleClear(db, keys);
  await db
    .update(sessionTable)
    .set({ lockedAt: null, lastSeenAt: new Date() })
    .where(eq(sessionTable.id, opts.sessionId));
  await audit.record(db, {
    actorAccountId: opts.accountId,
    operatorId: acc!.operatorId,
    action: 'auth.unlock',
    entityType: 'session',
    entityId: opts.sessionId,
    requestId: opts.requestId,
  });
}

export async function setPassword(db: Db, accountId: string, password: string): Promise<void> {
  if (password.length < 8) throw errors.badRequest('Password must be at least 8 characters');
  await db
    .update(account)
    .set({ passwordHash: await hash(password), mustChangePassword: false })
    .where(eq(account.id, accountId));
}
