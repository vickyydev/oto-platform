import { hash, verify } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, like, lte } from 'drizzle-orm';
import { authThrottle, child, member, type Db } from '@oto/db';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { throttleClear } from './auth';
import type { SmsSender } from './sms';
import { bumpWindow } from './throttle';
import { withTx, type OpContext } from './tx';

/**
 * THE BOOKING SITE'S SAVED CHILDREN, BEHIND A CODE TO THE PHONE (SCRUM-357).
 *
 * The open member lookup (`GET /public/member-tier`) answers a nickname, a tier
 * and a channel for a phone number and nothing else, and it stays that way:
 * a phone number is something a stranger can know. The children saved on a
 * family's record — names, dates of birth, allergies — are shown on the open
 * site only to whoever proves they hold the phone, by typing a six-digit code
 * sent to it (owner default, consistency register #53 / owner confirmations
 * #36: "restore this behind a one-time SMS check").
 *
 * What a passed check hands back is the children's details the booking site's
 * review step pre-fills from, and nothing else: no member id, no phone, no
 * email, no notes, no medical notes, no photo. It grants no session and writes
 * nothing to the member; edits made on the booking stay on that booking.
 *
 * WHERE THE CODE LIVES. `core.verification_code` belongs to staff accounts (an
 * `account_id` it cannot be without), and this round adds no table. The code is
 * therefore held the way the platform already holds short-lived keyed state on
 * the open surface: a row in `core.auth_throttle`, keyed
 * `mcode:<memberId>:<argon2id hash of the code>`, with `locked_until` as its
 * expiry. The hash is the same salted argon2id the staff codes use (SCRUM-347),
 * so the stored key does not give the code away; a row is spent by DELETING it,
 * conditional on it still being there, which is what keeps a code single-use
 * when two requests race. With twilio_verify Twilio owns the code (SCRUM-455)
 * and the row is only the anchor, keyed with `EXTERNAL_MARKER` in place of a
 * hash.
 *
 * Wrong guesses are counted per member in `code:member:<memberId>:saved_children`
 * over the code's own lifetime; at the limit every outstanding code for the
 * member is dropped. A phone with no member behind it is answered with the same
 * words and costs the same guess (`code:phone:<phone>:saved_children`), as the
 * staff code routes do since SCRUM-251.
 */

export const MEMBER_CODE_TTL_MS = 10 * 60_000;

/** How many outstanding codes one guess is checked against (each is an argon2 verify). */
const CANDIDATES = 5;

/** The anchor's key suffix when Twilio Verify owns the code. Never an argon2 hash. */
const EXTERNAL_MARKER = 'twilio_verify';

const codeKeyPrefix = (memberId: string): string => `mcode:${memberId}:`;
const attemptKey = (memberId: string): string => `code:member:${memberId}:saved_children`;
const unknownPhoneKey = (phone: string): string => `code:phone:${phone}:saved_children`;

const codeMessage = (code: string): string =>
  `Your OTO Park code is ${code}. It shows your saved children on the booking site.`;

/** A saved child, as the booking site's review step reads it — and nothing more. */
export interface PublicSavedChild {
  id: string;
  name: string;
  dateOfBirth: string | null;
  ageYears: number | null;
  allergies: string | null;
  foodRestrictions: string | null;
}

async function findMember(db: Db, operatorId: string, phone: string) {
  const [m] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.operatorId, operatorId), eq(member.phone, phone), isNull(member.archivedAt)))
    .limit(1);
  return m ?? null;
}

export interface MemberCodeScope {
  operatorId: string;
  branchId: string;
  /** E.164, already normalised by the caller. */
  phone: string;
}

/**
 * Send a code to a member's phone. Answers nothing about whether the phone is a
 * member's: the route says the same thing either way, and the per-phone rate
 * limit is spent by the caller before this runs.
 */
export async function startMemberCode(
  db: Db,
  sms: SmsSender,
  ctx: OpContext,
  scope: MemberCodeScope,
): Promise<void> {
  const m = await findMember(db, scope.operatorId, scope.phone);
  if (!m) return;
  const external = Boolean(sms.checksCodes);
  const code = external ? '' : String(randomInt(0, 1_000_000)).padStart(6, '0');
  const key = codeKeyPrefix(m.id) + (external ? EXTERNAL_MARKER : await hash(code));
  const expiresAt = new Date(Date.now() + MEMBER_CODE_TTL_MS);

  await withTx(
    db,
    { ...ctx, operatorId: scope.operatorId, branchId: scope.branchId },
    'member.saved_children_code',
    async (tx) => {
      // This member's spent-by-time anchors go, so they never accumulate.
      await tx
        .delete(authThrottle)
        .where(and(like(authThrottle.key, `${codeKeyPrefix(m.id)}%`), lte(authThrottle.lockedUntil, new Date())));
      await tx
        .insert(authThrottle)
        .values({ key, failures: 0, lockedUntil: expiresAt, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: authThrottle.key,
          set: { lockedUntil: expiresAt, updatedAt: new Date() },
        });
      // A new code, a fresh budget of guesses.
      await throttleClear(tx, [attemptKey(m.id)]);
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: scope.operatorId,
        branchId: scope.branchId,
        action: 'member.saved_children_code',
        entityType: 'member',
        entityId: m.id,
        requestId: ctx.requestId,
      });
    },
  );

  // After the commit, never inside it: a send can wait on the provider for
  // half a minute (see `mintCode` in services/auth.ts).
  if (sms.checksCodes) await sms.checksCodes.start(scope.phone);
  else await sms.send(scope.phone, codeMessage(code));
}

async function argonMatches(stored: string, code: string): Promise<boolean> {
  if (stored === EXTERNAL_MARKER) return false;
  try {
    return await verify(stored, code);
  } catch {
    // A key in no known shape matches nothing — never a 500 on an open route.
    return false;
  }
}

/**
 * Check a typed code and, when it is right, spend it and answer the member's
 * saved children. Throws "Invalid code" (or, at the limit, "Too many wrong
 * codes") for a wrong code, an expired one, a spent one, and a phone with no
 * member alike.
 */
export async function verifyMemberCode(
  db: Db,
  sms: SmsSender,
  ctx: OpContext,
  scope: MemberCodeScope & { code: string; maxAttempts: number },
): Promise<PublicSavedChild[]> {
  const m = await findMember(db, scope.operatorId, scope.phone);
  if (!m) {
    const { current } = await bumpWindow(db, unknownPhoneKey(scope.phone), MEMBER_CODE_TTL_MS);
    throw current >= scope.maxAttempts
      ? errors.badRequest('Too many wrong codes — request a new one')
      : errors.badRequest('Invalid code');
  }

  const prefix = codeKeyPrefix(m.id);
  const wrongGuess = async (): Promise<AppError> => {
    const { current } = await bumpWindow(db, attemptKey(m.id), MEMBER_CODE_TTL_MS);
    if (current >= scope.maxAttempts) {
      await db.delete(authThrottle).where(like(authThrottle.key, `${prefix}%`));
      return errors.badRequest('Too many wrong codes — request a new one');
    }
    return errors.badRequest('Invalid code');
  };

  // Live anchors only: one past its expiry is a wrong code like any other.
  const candidates = await db
    .select({ key: authThrottle.key })
    .from(authThrottle)
    .where(and(like(authThrottle.key, `${prefix}%`), gt(authThrottle.lockedUntil, new Date())))
    .orderBy(desc(authThrottle.updatedAt))
    .limit(CANDIDATES);

  let matched: string | null = null;
  if (sms.checksCodes) {
    // The local anchor is consulted BEFORE Twilio, so a phone with no live
    // code costs a guess and asks Twilio nothing (the SCRUM-455 ordering).
    const anchor = candidates.find((c) => c.key === prefix + EXTERNAL_MARKER);
    if (!anchor) throw await wrongGuess();
    const verdict = await sms.checksCodes.checkCode(scope.phone, scope.code);
    if (verdict !== 'approved') throw await wrongGuess();
    matched = anchor.key;
  } else {
    for (const c of candidates) {
      if (await argonMatches(c.key.slice(prefix.length), scope.code)) {
        matched = c.key;
        break;
      }
    }
    if (!matched) throw await wrongGuess();
  }
  const spentKey = matched;

  return withTx(
    db,
    { ...ctx, operatorId: scope.operatorId, branchId: scope.branchId },
    'member.saved_children_read',
    async (tx) => {
      // Spent by the delete that finds it: a second request carrying the same
      // code finds nothing and is refused in the same words as a wrong code.
      const [spent] = await tx
        .delete(authThrottle)
        .where(eq(authThrottle.key, spentKey))
        .returning({ key: authThrottle.key });
      if (!spent) throw errors.badRequest('Invalid code');
      await throttleClear(tx, [attemptKey(m.id)]);
      const rows = await tx
        .select({
          id: child.id,
          name: child.name,
          dateOfBirth: child.dateOfBirth,
          ageYears: child.ageYears,
          allergies: child.allergies,
          foodRestrictions: child.foodRestrictions,
          dietary: child.dietary,
        })
        .from(child)
        .where(and(eq(child.memberId, m.id), isNull(child.archivedAt)))
        .orderBy(asc(child.createdAt), asc(child.id));
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: scope.operatorId,
        branchId: scope.branchId,
        action: 'member.saved_children_read',
        entityType: 'member',
        entityId: m.id,
        after: { childCount: rows.length, via: 'booking_site_code' },
        requestId: ctx.requestId,
      });
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        dateOfBirth: r.dateOfBirth,
        ageYears: r.ageYears,
        allergies: r.allergies,
        // The till's own mapping reads food restrictions, then dietary.
        foodRestrictions: r.foodRestrictions ?? r.dietary,
      }));
    },
  );
}
