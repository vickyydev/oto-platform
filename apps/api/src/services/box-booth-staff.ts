import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { account, authThrottle, boothStaffAssignment, employee, station, type Db } from '@oto/db';
import {
  BOOTH_STAFF_VERIFY_ERRORS,
  boothStaffCode,
  type BoothStaffVerifyRequest,
  type BoothStaffVerifyResponse,
} from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import { phoneHash } from '../lib/scrub';
import { audit } from './audit';
import { boothBusinessDate, isOnBoothDuty, selfAssignBoothDuty } from './booth-duty';
import { findAccountByPhone, throttleClear, throttleFail } from './auth';
import type { BoxAuth } from './box';
import { hasPermission, resolveEffectivePermissions } from './permissions';

/**
 * A member of staff signs in at a booth with their own phone and password
 * (SCRUM-223).
 *
 * The booth box asks, never the person: the television posts the phone and
 * password to the box on its own loopback, and the box forwards them here
 * under ITS credential. So the caller is always a box, and the answer is about
 * one of that box's own booth stations — never another box's.
 *
 * Four things must all be true, and they are checked in this order so that
 * nothing about an account is told to somebody who does not hold its password:
 *
 *  1. the phone and password are right, for an active account of the box's
 *     operator — every failure here is the same 401, costs the same argon2
 *     verification, and counts against the SAME per-phone bucket the sign-in
 *     screen uses (a password is one secret, whichever door it is typed at),
 *     plus a bucket for the booth itself, which only a sign-in that passes
 *     all four checks empties;
 *  2. the password is not a temporary one waiting to be changed;
 *  3. the account's role carries `booth:staff:sign_in` at this booth's branch;
 *  4. an administrator has put the account on this booth's staff list, OR
 *     the account is on this booth's roster for today (SCRUM-473, D5.2) —
 *     sign-in is the union of the two. Somebody let in by the standing list
 *     who is not on today's roster is a stand-in, and joins the day's roster
 *     as `self_assigned` here, with its own log line, so the label every
 *     voucher prints stays truthful.
 *
 * What comes back is who it is, as the slip prints it: the account id, the
 * nickname or name, and the staff code. The session is the box's to keep — it
 * lasts the booth's session length and survives a restart there.
 */

export interface BoothStaffVerifyOptions {
  /** `AUTH_MAX_FAILURES`: wrong passwords per phone before the cooldown. */
  maxFailures: number;
  /** `AUTH_COOLDOWN_SECONDS`. */
  cooldownSeconds: number;
  requestId?: string;
  log?: FastifyBaseLogger;
}

/**
 * The booth's own bucket admits several people's mistakes before it closes,
 * because a booth is shared; what it stops is one person at a booth working
 * through a list of phone numbers, five guesses at a time.
 */
export const BOOTH_BUCKET_FACTOR = 4;

/**
 * A hash nobody's password matches, minted once with the parameters every
 * stored password hash is written with — so a refusal that never reached a
 * real verification costs what one that did costs (the same reasoning as
 * `equalizeVerifyCost` in `services/auth.ts`, restated here because that one
 * is private to sign-in).
 */
const DUMMY_HASH: Promise<string> = hash(randomBytes(32).toString('base64'));
void DUMMY_HASH.catch(() => {});

async function spendVerification(password: string): Promise<void> {
  try {
    await verify(await DUMMY_HASH, password);
  } catch {
    // The answer was known before the call; only the time mattered.
  }
}

/** The bucket keys, the phone one shared with the sign-in screen. */
function bucketKeys(phone: string | null, stationId: string): { phone: string | null; booth: string } {
  return { phone: phone ? `phone:${phone}` : null, booth: `booth-staff:${stationId}` };
}

/**
 * Refuse while a bucket is closed, and say for how long.
 *
 * The sign-in screen's check throws a sentence; the box needs a number to put
 * a countdown on the television, so this one reads the same rows and answers
 * with `retryAfterS` in the details.
 */
async function refuseWhileLocked(db: Db, keys: string[]): Promise<void> {
  const rows = await db.select().from(authThrottle).where(inArray(authThrottle.key, keys));
  const now = Date.now();
  let until = 0;
  for (const row of rows) {
    const at = row.lockedUntil?.getTime() ?? 0;
    // A bucket's window and its lock share one column; only a count at the
    // ceiling is a lock, which `throttleFail` alone writes into the future.
    if (at > now && row.failures >= 1) until = Math.max(until, at);
  }
  if (until > now) {
    const seconds = Math.ceil((until - now) / 1000);
    throw new AppError(
      429,
      BOOTH_STAFF_VERIFY_ERRORS.locked,
      `Too many wrong attempts. Try again in ${seconds}s.`,
      { retryAfterS: seconds },
    );
  }
}

export async function verifyBoothStaff(
  db: Db,
  auth: BoxAuth,
  input: BoothStaffVerifyRequest,
  opts: BoothStaffVerifyOptions,
): Promise<BoothStaffVerifyResponse> {
  // The booth has to be this box's own. A box asking about another box's
  // booth learns nothing — not even whether it exists.
  const [booth] = await db
    .select({ id: station.id, branchId: station.branchId, name: station.name })
    .from(station)
    .where(
      and(
        eq(station.id, input.stationId),
        eq(station.boxId, auth.boxId),
        eq(station.operatorId, auth.operatorId),
        eq(station.kind, 'booth'),
        isNull(station.archivedAt),
      ),
    )
    .limit(1);
  if (!booth) {
    throw new AppError(404, BOOTH_STAFF_VERIFY_ERRORS.boothNotOnBox, 'That booth is not on this box');
  }

  let phone: string | null = null;
  let acc: typeof account.$inferSelect | null = null;
  try {
    const found = await findAccountByPhone(db, input.phone, auth.operatorId);
    phone = found.phone;
    acc = found.account;
  } catch (err) {
    // A phone that is not a phone is a wrong sign-in like any other, not a
    // 400 that tells the person at the booth which half they got wrong.
    if (!(err instanceof AppError) || err.statusCode !== 400) throw err;
  }
  const keys = bucketKeys(phone, booth.id);
  await refuseWhileLocked(db, [keys.booth, ...(keys.phone ? [keys.phone] : [])]);

  const record = async (action: string, accountId: string | null, after: Record<string, unknown>) => {
    try {
      await audit.record(db, {
        actorAccountId: accountId,
        operatorId: auth.operatorId,
        branchId: booth.branchId,
        action,
        entityType: 'station',
        entityId: booth.id,
        after: { ...after, boxId: auth.boxId },
        requestId: opts.requestId ?? null,
      });
    } catch (err) {
      // A refusal that cannot be written down is still a refusal.
      opts.log?.error({ err: String(err) }, 'booth sign-in audit could not be written');
    }
  };

  let verificationSpent = false;
  const fail = async (reason: string): Promise<never> => {
    if (!verificationSpent) await spendVerification(input.password);
    const locked = [
      ...(keys.phone ? await throttleFail(db, [keys.phone], opts.maxFailures, opts.cooldownSeconds) : []),
      ...(await throttleFail(
        db,
        [keys.booth],
        opts.maxFailures * BOOTH_BUCKET_FACTOR,
        opts.cooldownSeconds,
      )),
    ];
    opts.log?.warn(
      { reason, stationId: booth.id, phoneHash: phone ? phoneHash(phone) : null },
      'booth sign-in refused',
    );
    await record('booth.staff_sign_in_failed', acc?.id ?? null, {
      reason,
      phoneHash: phone ? phoneHash(phone) : null,
      lockedBuckets: locked.map((key) => key.split(':')[0]),
    });
    throw new AppError(401, BOOTH_STAFF_VERIFY_ERRORS.invalid, 'Phone or password is incorrect');
  };

  if (!acc) return fail('no_account');
  if (acc.status !== 'active') return fail(`status_${acc.status}`);
  if (!acc.passwordHash) return fail('no_password');
  verificationSpent = true;
  let matches = false;
  try {
    matches = await verify(acc.passwordHash, input.password);
  } catch {
    matches = false;
  }
  if (!matches) return fail('bad_password');

  /**
   * The password was right, so this phone's guesses are spent no longer — the
   * sign-in screen's rule, and its bucket.
   *
   * NOT the booth's bucket. That one counts every wrong guess typed at this
   * booth, whoever's phone it named, and a right password for one account
   * says nothing about the guesses at the others. Emptied here, it let anybody
   * holding one working account reset it between rounds of guessing at
   * everybody else's. It is emptied below, by a sign-in that gets all the way
   * in: somebody an administrator put on this booth, whose role may sign in
   * here — and whose sign-in is audited under their own name.
   */
  if (keys.phone) await throttleClear(db, [keys.phone]);

  if (acc.mustChangePassword) {
    await record('booth.staff_sign_in_refused', acc.id, { reason: 'must_change_password' });
    throw new AppError(
      403,
      BOOTH_STAFF_VERIFY_ERRORS.mustChangePassword,
      'This is a temporary password: change it on the POS first',
    );
  }

  const permissions = await resolveEffectivePermissions(db, acc.id);
  if (
    !hasPermission(permissions, 'booth:staff:sign_in', {
      operatorId: auth.operatorId,
      branchId: booth.branchId,
      recordId: booth.id,
    })
  ) {
    await record('booth.staff_sign_in_refused', acc.id, { reason: 'no_permission' });
    throw new AppError(
      403,
      BOOTH_STAFF_VERIFY_ERRORS.notAllowed,
      'This account’s role may not sign in at a booth',
    );
  }

  const [assigned] = await db
    .select({ id: boothStaffAssignment.id })
    .from(boothStaffAssignment)
    .where(
      and(eq(boothStaffAssignment.stationId, booth.id), eq(boothStaffAssignment.accountId, acc.id)),
    )
    .limit(1);
  const today = await boothBusinessDate(db, booth.branchId);
  const onDuty = await isOnBoothDuty(db, booth.id, today, acc.id);
  if (!assigned && !onDuty) {
    await record('booth.staff_sign_in_refused', acc.id, { reason: 'not_assigned' });
    throw new AppError(
      403,
      BOOTH_STAFF_VERIFY_ERRORS.notAssigned,
      'This account is not on the staff list of this booth',
    );
  }

  await throttleClear(db, [keys.booth]);

  const [person] = acc.employeeId
    ? await db
        .select({ name: employee.name, nickname: employee.nickname })
        .from(employee)
        .where(eq(employee.id, acc.employeeId))
        .limit(1)
    : [];
  await record('booth.staff_sign_in', acc.id, { method: 'account' });
  const signedInId = acc.id;
  if (!onDuty) {
    // A stand-in (D5.2). Its own small transaction — the roster row and its
    // log line together — and never allowed to fail the sign-in it
    // describes: the spin's arrival adds the same row if this one could not
    // be written.
    try {
      await db.transaction((tx) =>
        selfAssignBoothDuty(tx, {
          stationId: booth.id,
          operatorId: auth.operatorId,
          branchId: booth.branchId,
          businessDate: today,
          accountId: signedInId,
          displayName: person?.nickname ?? person?.name ?? null,
          via: 'sign_in',
          requestId: opts.requestId ?? null,
        }),
      );
    } catch (err) {
      opts.log?.error({ err: String(err) }, 'a stand-in could not be added to the booth roster');
    }
  }
  return {
    accountId: acc.id,
    displayName: person?.nickname ?? person?.name ?? null,
    staffCode: boothStaffCode(acc.id),
  };
}
