import { hash, verify } from '@node-rs/argon2';
import { createHash, randomInt } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  account,
  branch,
  session as sessionTable,
  verificationCode,
  type Db,
} from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import type { SmsSender } from './sms';
import { hashToken, newSessionToken } from '../plugins/session';

// --- Sign-in throttling (SCRUM-19): failures per phone and per IP ----------
// In-memory by design — resets on restart, which only relaxes the limit.
interface Bucket {
  failures: number;
  lockedUntil: number;
}
const buckets = new Map<string, Bucket>();

export function throttleCheck(keys: string[], maxFailures: number, cooldownSeconds: number): void {
  const now = Date.now();
  for (const key of keys) {
    const b = buckets.get(key);
    if (b && b.lockedUntil > now) {
      throw errors.tooMany(
        `Too many failed sign-in attempts. Try again in ${Math.ceil((b.lockedUntil - now) / 1000)}s.`,
      );
    }
    void maxFailures;
    void cooldownSeconds;
  }
}

export function throttleFail(keys: string[], maxFailures: number, cooldownSeconds: number): void {
  const now = Date.now();
  for (const key of keys) {
    const b = buckets.get(key) ?? { failures: 0, lockedUntil: 0 };
    b.failures += 1;
    if (b.failures >= maxFailures) {
      b.lockedUntil = now + cooldownSeconds * 1000;
      b.failures = 0;
    }
    buckets.set(key, b);
  }
}

export function throttleClear(keys: string[]): void {
  for (const key of keys) buckets.delete(key);
}

/** Test hook: wipe throttle state between cases. */
export function _resetThrottle(): void {
  buckets.clear();
}

// --- Verification codes (SCRUM-20/23) --------------------------------------

const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');

export async function issueCode(
  db: Db,
  sms: SmsSender,
  accountId: string,
  phone: string,
  purpose: 'setup' | 'password_reset',
  requestId?: string,
): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.insert(verificationCode).values({
    id: newId(),
    accountId,
    purpose,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  void requestId;
  await sms.send(
    phone,
    purpose === 'setup'
      ? `Your OTO account setup code is ${code}`
      : `Your OTO password reset code is ${code}`,
  );
}

/** Verify + consume a single-use, time-limited code. Throws when invalid. */
export async function consumeCode(
  db: Db,
  accountId: string,
  purpose: 'setup' | 'password_reset',
  code: string,
): Promise<void> {
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
  if (!row) throw errors.badRequest('Invalid code');
  if (row.expiresAt < new Date()) throw errors.badRequest('Code expired — request a new one');
  await db
    .update(verificationCode)
    .set({ consumedAt: new Date() })
    .where(eq(verificationCode.id, row.id));
}

// --- Accounts & sessions ----------------------------------------------------

export async function findAccountByPhone(db: Db, rawPhone: string) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw errors.badRequest('Invalid phone number');
  const rows = await db.select().from(account).where(eq(account.phone, phone)).limit(1);
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
  },
): Promise<SignInResult> {
  const { phone, account: acc } = await findAccountByPhone(db, opts.phone);
  // Per-phone at the configured limit; per-IP at 4× so one shared reception
  // IP isn't locked out by a single guessed phone (many tills share an IP).
  throttleCheck([`phone:${phone}`], opts.maxFailures, opts.cooldownSeconds);
  throttleCheck([`ip:${opts.ip}`], opts.maxFailures * 4, opts.cooldownSeconds);

  const fail = (): never => {
    throttleFail([`phone:${phone}`], opts.maxFailures, opts.cooldownSeconds);
    throttleFail([`ip:${opts.ip}`], opts.maxFailures * 4, opts.cooldownSeconds);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Phone or password is incorrect');
  };

  if (!acc) fail();
  // Status checks come BEFORE the password check so invited/inactive accounts
  // get their clear message (SCRUM-19) rather than a generic 401.
  if (acc!.status === 'invited') {
    throw new AppError(403, 'SETUP_REQUIRED', 'Finish your account setup before signing in');
  }
  if (acc!.status === 'inactive') {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated — contact a manager');
  }
  if (!acc!.passwordHash || !(await verify(acc!.passwordHash, opts.password))) fail();

  throttleClear([`phone:${phone}`, `ip:${opts.ip}`]);

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

export async function signOut(db: Db, sessionId: string, actorAccountId: string, requestId?: string): Promise<void> {
  await db.delete(sessionTable).where(eq(sessionTable.id, sessionId));
  await audit.record(db, {
    actorAccountId,
    action: 'auth.sign_out',
    entityType: 'session',
    entityId: sessionId,
    requestId,
  });
}

export async function invalidateAllSessions(db: Db, accountId: string): Promise<void> {
  await db.delete(sessionTable).where(eq(sessionTable.accountId, accountId));
}

export async function setPassword(db: Db, accountId: string, password: string): Promise<void> {
  if (password.length < 8) throw errors.badRequest('Password must be at least 8 characters');
  await db
    .update(account)
    .set({ passwordHash: await hash(password), mustChangePassword: false })
    .where(eq(account.id, accountId));
}
