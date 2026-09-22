import { hash, verify } from '@node-rs/argon2';
import { createHash, randomInt } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  account,
  authThrottle,
  branch,
  employee,
  session as sessionTable,
  verificationCode,
  type Db,
} from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { phoneHash } from '../lib/scrub';
import { anyBranchReach, reachCovers } from './access-control';
import { resolveEffectivePermissions } from './permissions';
import { audit } from './audit';
import type { Exec } from './tx';
import { bumpWindow } from './throttle';
import { revokeStaffTokens } from './staff-token';
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

/**
 * Count a failure against each bucket. Returns the buckets that went from
 * open to locked on THIS call — the transition, not the state, so a lockout
 * is recorded once rather than once per attempt that bounces off it.
 */
export async function throttleFail(
  db: Db,
  keys: string[],
  maxFailures: number,
  cooldownSeconds: number,
): Promise<string[]> {
  const now = new Date();
  const lockedNow: string[] = [];
  for (const key of keys) {
    // One statement, so two racing requests cannot both read "4 failures".
    const [row] = await db
      .insert(authThrottle)
      .values({ key, failures: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: authThrottle.key,
        set: {
          failures: sql`case when ${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} <= now() then 1 else ${authThrottle.failures} + 1 end`,
          lockedUntil: sql`case when (case when ${authThrottle.lockedUntil} is not null and ${authThrottle.lockedUntil} <= now() then 1 else ${authThrottle.failures} + 1 end) >= ${maxFailures} then now() + ${`${cooldownSeconds} seconds`}::interval else ${authThrottle.lockedUntil} end`,
          updatedAt: now,
        },
      })
      .returning({ failures: authThrottle.failures, lockedUntil: authThrottle.lockedUntil });
    // Exactly at the threshold: the counter resets to 1 when a previous
    // cooldown expired, so this is the moment the bucket closed.
    if (row && row.failures === maxFailures && row.lockedUntil && row.lockedUntil > now) {
      lockedNow.push(key);
    }
  }
  return lockedNow;
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

/**
 * A refused sign-in, and the moment a bucket closed behind it (S2-03).
 *
 * Both are written on the pool: there is no transaction to belong to, and the
 * record of an attempt has to outlive the attempt whatever happens to it. The
 * phone is stored as its hash — enough to see that the same number failed
 * five times, useless to anyone reading the table for numbers.
 *
 * The whole thing is swallowed on error, deliberately: a refusal that cannot
 * be written down is still a refusal, and turning a 401 into a 500 would tell
 * the person guessing that they had found something.
 */
async function recordSignInFailure(
  db: Db,
  opts: {
    phone: string;
    reason: string;
    accountId?: string | null;
    operatorId?: string | null;
    requestId?: string;
    lockedBuckets?: string[];
    cooldownSeconds?: number;
  },
): Promise<void> {
  const entry = {
    actorAccountId: opts.accountId ?? null,
    operatorId: opts.operatorId ?? null,
    entityType: 'account',
    // No account means no id; the hash is the only stable handle there is.
    entityId: opts.accountId ?? phoneHash(opts.phone),
    requestId: opts.requestId,
  };
  try {
    await audit.record(db, {
      ...entry,
      action: 'auth.sign_in_failed',
      after: { reason: opts.reason, phoneHash: phoneHash(opts.phone) },
    });
    for (const bucket of opts.lockedBuckets ?? []) {
      await audit.record(db, {
        ...entry,
        action: 'auth.locked_out',
        // The bucket's kind, not its key: the key holds a phone number or an
        // address, and neither belongs in a row an admin console renders.
        after: { bucket: bucket.split(':')[0], cooldownSeconds: opts.cooldownSeconds },
      });
    }
  } catch (err) {
    // Same rule as the denial rows in the error handler. No request logger
    // reaches this far, so it goes out the way the pool's own errors do.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'sign-in failure audit could not be written',
        code: (err as { code?: string }).code,
      }),
    );
  }
}

/** The operator an account belongs to — the audit row's tenancy. */
async function operatorOfAccount(db: Db, accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ operatorId: account.operatorId })
    .from(account)
    .where(eq(account.id, accountId))
    .limit(1);
  return row?.operatorId ?? null;
}

/**
 * WHERE A NEW SESSION IS SEATED (SCRUM-263).
 *
 * Sign-in used to take `select … from branch where operator_id = … limit 1` —
 * no ordering, and no regard for where the account works — so every session in
 * the operator started at whichever branch the database happened to hand back
 * first. With one branch that was right by accident. With two, the manager of
 * Robinson Chalong signed in at Central Floresta, where she holds nothing, and
 * every route that falls back to the session's branch refused her until she
 * switched by hand.
 *
 * The seat is computed from grants, like every other branch question here:
 *
 *   - somebody who reaches the whole operator is seated at its first live
 *     branch, as before — every branch is theirs and one has to be first. The
 *     ordering is new, so that "first" is the same branch on every sign-in
 *     rather than whatever the heap returned this time.
 *   - anyone else is seated at their employee record's branch when they hold
 *     something there, because that is where they turn up for work, and
 *     otherwise at the first live branch their grants do cover.
 *   - an account whose grants reach no live branch is refused, with the reason.
 *     Seating it anyway would be a session that cannot act at the branch it is
 *     sitting at — the lockout above, wearing a 200.
 */
export type Seat =
  /** Sit here. Null only when an operator-wide account's operator has no live branch. */
  | { kind: 'seat'; branchId: string | null }
  /** Grants cover no live branch of this operator. */
  | { kind: 'no_reach' };

export async function seatBranch(
  db: Db,
  acc: { id: string; operatorId: string; employeeId: string | null },
): Promise<Seat> {
  const live = await db
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.operatorId, acc.operatorId), isNull(branch.archivedAt)))
    .orderBy(asc(branch.createdAt), asc(branch.id));

  const reach = anyBranchReach(await resolveEffectivePermissions(db, acc.id), acc.operatorId);
  if (reach.kind === 'operator') return { kind: 'seat', branchId: live[0]?.id ?? null };

  const mine = live.filter((b) => reachCovers(reach, b.id));
  if (mine.length === 0) return { kind: 'no_reach' };

  const [emp] = acc.employeeId
    ? await db
        .select({ branchId: employee.branchId })
        .from(employee)
        .where(eq(employee.id, acc.employeeId))
        .limit(1)
    : [];
  const worksAt = emp?.branchId ?? null;
  const atWork = worksAt !== null && mine.some((b) => b.id === worksAt);
  return { kind: 'seat', branchId: atWork ? worksAt : mine[0]!.id };
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

  const refuse = async (reason: string): Promise<void> => {
    await recordSignInFailure(db, {
      phone,
      reason,
      accountId: acc?.id,
      operatorId: acc?.operatorId,
      requestId: opts.requestId,
    });
  };

  const fail = async (reason: string): Promise<never> => {
    const lockedBuckets = [
      ...(await throttleFail(db, [`phone:${phone}`], opts.maxFailures, opts.cooldownSeconds)),
      ...(await throttleFail(db, [`ip:${opts.ip}`], opts.maxFailures * 4, opts.cooldownSeconds)),
    ];
    await recordSignInFailure(db, {
      phone,
      reason,
      accountId: acc?.id,
      operatorId: acc?.operatorId,
      requestId: opts.requestId,
      lockedBuckets,
      cooldownSeconds: opts.cooldownSeconds,
    });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Phone or password is incorrect');
  };

  if (!acc) await fail('no_account');
  // Status checks come BEFORE the password check so invited/inactive accounts
  // get their clear message (SCRUM-19) rather than a generic 401. They count
  // as a refused sign-in but not as a guess: the password was never tried, so
  // throttling them would lock a colleague out for finishing their setup late.
  if (acc!.status === 'invited') {
    await refuse('setup_required');
    throw new AppError(403, 'SETUP_REQUIRED', 'Finish your account setup before signing in');
  }
  if (acc!.status === 'inactive') {
    await refuse('account_inactive');
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated — contact a manager');
  }
  if (!acc!.passwordHash || !(await verify(acc!.passwordHash, opts.password))) {
    await fail('bad_password');
  }

  await throttleClear(db, [`phone:${phone}`, `ip:${opts.ip}`]);

  const seat = await seatBranch(db, acc!);
  if (seat.kind === 'no_reach') {
    await refuse('no_branch_access');
    throw new AppError(
      403,
      'NO_BRANCH_ACCESS',
      'This account has no access at any branch yet — a manager needs to give it a role at the branch you work at.',
    );
  }

  const token = newSessionToken();
  const sessionId = newId();
  await db.insert(sessionTable).values({
    id: sessionId,
    accountId: acc!.id,
    tokenHash: hashToken(token),
    branchId: seat.branchId,
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
  /**
   * And the shift token minted from it (S2-06).
   *
   * Signing out has to end the offline credential too, or a person who handed
   * the till over would leave behind a token that unlocks it — on a box that
   * may not hear about the sign-out for hours. The jti joins the deny-list
   * every box pulls, and until that pull the token's own expiry is the bound.
   */
  await revokeStaffTokens(db, { sessionId }, 'sign_out', actorAccountId);
  await audit.record(db, {
    actorAccountId,
    // Sprint 1 left this null, so a sign-out was the one access event that
    // fell outside its own tenant's audit read. The operator is a property of
    // the account, not of the request, so it is read back rather than passed.
    operatorId: await operatorOfAccount(db, actorAccountId),
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
  /**
   * Every shift token this account holds goes with them (S2-06).
   *
   * This is the path a password reset and a deactivation take, and it is the
   * one that has to reach a box: ending the cloud sessions of somebody who has
   * been let go, and leaving a token that unlocks a till they can still walk
   * up to, would be the more dangerous half left undone.
   */
  await revokeStaffTokens(db, { accountId }, 'account_revoked');
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
    operatorId: await operatorOfAccount(db, actorAccountId),
    action: 'session.lock',
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
    const lockedBuckets = await throttleFail(db, keys, opts.maxFailures, opts.cooldownSeconds);
    await audit.record(db, {
      actorAccountId: opts.accountId,
      operatorId: acc?.operatorId,
      action: 'session.unlock_failed',
      entityType: 'session',
      entityId: opts.sessionId,
      requestId: opts.requestId,
    });
    for (const bucket of lockedBuckets) {
      await audit.record(db, {
        actorAccountId: opts.accountId,
        operatorId: acc?.operatorId,
        action: 'auth.locked_out',
        entityType: 'session',
        entityId: opts.sessionId,
        after: { bucket: bucket.split(':')[0], cooldownSeconds: opts.cooldownSeconds },
        requestId: opts.requestId,
      });
    }
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
    action: 'session.unlock',
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
