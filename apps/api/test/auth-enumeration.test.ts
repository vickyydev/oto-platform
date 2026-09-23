import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, auditLog, role, roleAssignment } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { _resetThrottle } from '../src/services/auth';
import {
  CENTRAL_BRANCH_CODE,
  branchIdByCode,
  createTestContext,
  lastCode,
  operatorIdByName,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-251 — the sign-in screen is not a staff directory.
 *
 * `POST /auth/sign-in` used to answer three different ways: 403
 * `SETUP_REQUIRED` for an account that had been invited and not yet set up,
 * 403 `ACCOUNT_INACTIVE` for one that had been deactivated, and 401 for
 * everything else. Anybody could hand it a list of Thai mobile numbers and get
 * back which of them work at the park, which start next week and which were
 * let go — no password, and no rate limit either, because those two branches
 * were deliberately not counted as failures.
 *
 * What this file pins is the absence of a difference. The four classes of
 * phone are answered with the same status and the SAME BYTES, and each attempt
 * spends a guess from the same bucket, so there is nothing to sort by and no
 * budget to sort with. `/auth/setup/complete` is the same story with the code
 * in place of the password.
 *
 * The two people who used to be told something are still told it — that is the
 * other half, and the half a fix like this usually breaks. The invited member
 * of staff gets their code on their own phone and finishes setup while the
 * sign-in lock stands; the deactivated one is told by the manager, who can
 * read both the status and the refusals. And the reason stays in the trail on
 * our side, which is what makes "it just says wrong password" diagnosable.
 */

const MAX_FAILURES = 5;
const CODE_ATTEMPTS = 5;

/** The four classes. None of them may be told apart from any other. */
const UNKNOWN = '+66900000301';
const INVITED = '+66900000302';
const DEACTIVATED = '+66900000303';
const ACTIVE = '+66900000304';
/** A second invited account, for the code flow, so the first stays invited. */
const INVITED_FOR_CODES = '+66900000305';

const ACTIVE_PASSWORD = 'active1234pass';
const WRONG_PASSWORD = 'wrong1234pass';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    env: { AUTH_MAX_FAILURES: String(MAX_FAILURES), AUTH_COOLDOWN_SECONDS: '300' },
  });
  const operatorId = await operatorIdByName(ctx.db, 'OTO');
  const branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [reception] = await ctx.db
    .select()
    .from(role)
    .where(eq(role.name, 'reception'))
    .limit(1);

  /**
   * Each account is given a branch-scoped role, including the ones that can
   * never sign in. A refusal that happened to be right for the wrong reason —
   * "no role anywhere" rather than "this status" — would make every assertion
   * below vacuous.
   */
  const make = async (phone: string, status: 'invited' | 'inactive' | 'active', password?: string) => {
    const id = newId();
    await ctx.db.insert(account).values({
      id,
      operatorId,
      phone: normalizePhone(phone)!,
      passwordHash: password ? await hash(password) : null,
      phoneVerifiedAt: status === 'active' ? new Date() : null,
      status,
    });
    await ctx.db.insert(roleAssignment).values({
      id: newId(),
      accountId: id,
      roleId: reception!.id,
      scopeType: 'branch',
      scopeId: branchId,
    });
    return id;
  };

  await make(INVITED, 'invited');
  await make(INVITED_FOR_CODES, 'invited');
  await make(DEACTIVATED, 'inactive', ACTIVE_PASSWORD);
  await make(ACTIVE, 'active', ACTIVE_PASSWORD);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/**
 * Every case starts with empty counters. They are shared — one per phone and
 * one for the address every inject comes from — so a case that inherited the
 * previous one's would be measuring the order the file happens to run in.
 */
beforeEach(async () => {
  await _resetThrottle(ctx.db);
});

const signIn = (phone: string, password = WRONG_PASSWORD) =>
  ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { phone, password } });

describe('sign-in answers every phone the same way (SCRUM-251)', () => {
  it('the four classes are byte-identical on a password that does not verify', async () => {
    const [unknown, invited, deactivated, active] = await Promise.all([
      signIn(UNKNOWN),
      signIn(INVITED),
      signIn(DEACTIVATED),
      signIn(ACTIVE),
    ]);

    for (const [label, res] of [
      ['unknown', unknown],
      ['invited', invited],
      ['deactivated', deactivated],
      ['active', active],
    ] as const) {
      expect(res.statusCode, label).toBe(401);
      expect(res.json().error.code, label).toBe('INVALID_CREDENTIALS');
      // The bytes, not the shape: a difference of one word in the message is
      // the whole vulnerability, and `toMatchObject` would let it through.
      expect(res.body, label).toBe(unknown.body);
      expect(res.headers['content-type'], label).toBe(unknown.headers['content-type']);
    }
  });

  it('a deactivated account is refused even with the right password, and says no more', async () => {
    const res = await signIn(DEACTIVATED, ACTIVE_PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    // Knowing the password of an account that has been switched off must not
    // be a way to confirm that it exists and was switched off.
    expect(res.body).toBe((await signIn(UNKNOWN)).body);
  });

  it('the invited and deactivated phones spend the same guesses as an active one', async () => {
    /** Attempt numbers until the cooldown answers, up to twelve. */
    const lockedAt = async (phone: string): Promise<number | null> => {
      await _resetThrottle(ctx.db);
      for (let n = 1; n <= 12; n++) {
        const res = await signIn(phone);
        if (res.statusCode === 429) {
          expect(res.json().error.code).toBe('TOO_MANY_REQUESTS');
          return n;
        }
        expect(res.statusCode, `attempt ${n} on ${phone}`).toBe(401);
      }
      return null;
    };

    // Twelve attempts each: under the old rule the invited and deactivated
    // phones would have taken all twelve, and a thousand more.
    const active = await lockedAt(ACTIVE);
    expect(active).toBe(MAX_FAILURES + 1);
    expect(await lockedAt(INVITED)).toBe(active);
    expect(await lockedAt(DEACTIVATED)).toBe(active);
  });

  it('the reason is still readable on our side', async () => {
    await signIn(INVITED);
    await signIn(DEACTIVATED);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.sign_in_failed'));
    const reasons = rows.map((r) => (r.after as { reason?: string } | null)?.reason);
    // The answer is one sentence; the trail is not. A manager asking why
    // somebody cannot sign in gets these.
    expect(reasons).toContain('setup_required');
    expect(reasons).toContain('account_inactive');
    // And the phone is never written down in the clear beside them.
    expect(JSON.stringify(rows)).not.toContain(INVITED);
  });
});

describe('the invited member of staff is still let in (SCRUM-251)', () => {
  it('gets a code and finishes setup while the sign-in lock stands', async () => {
    // Five wrong passwords on the sign-in screen, which is what a new starter
    // does before reading the small print. The phone is now in a cooldown.
    for (let n = 1; n <= MAX_FAILURES; n++) {
      expect((await signIn(INVITED_FOR_CODES)).statusCode).toBe(401);
    }
    expect((await signIn(INVITED_FOR_CODES)).statusCode).toBe(429);

    // The setup flow is fenced by its own bucket, so the lock does not close
    // it: the code goes to THEIR phone, which is where learning that the
    // account exists costs nothing.
    const start = await ctx.app.inject({
      method: 'POST',
      url: '/auth/setup/start',
      payload: { phone: INVITED_FOR_CODES },
    });
    expect(start.statusCode).toBe(200);
    const code = lastCode(ctx.smsLog);

    const done = await ctx.app.inject({
      method: 'POST',
      url: '/auth/setup/complete',
      payload: { phone: INVITED_FOR_CODES, code, password: 'firstshift1234' },
    });
    expect(done.statusCode).toBe(200);

    // And the cooldown their own fumbling earned goes with the setup: a code
    // delivered to that phone and spent proves what a sign-in proves.
    const signedIn = await signIn(INVITED_FOR_CODES, 'firstshift1234');
    expect(signedIn.statusCode).toBe(200);

    const [acc] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, normalizePhone(INVITED_FOR_CODES)!))
      .limit(1);
    expect(acc!.status).toBe('active');
  });
});

describe('setup/complete answers every phone the same way (SCRUM-251)', () => {
  /** A phone that has never been an account, and never will be. */
  const STRANGER = '+66900000306';

  const complete = (phone: string, code: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/auth/setup/complete',
      payload: { phone, code, password: 'somepassword1234' },
    });

  it('a known invited phone and an unknown one are identical, guess for guess', async () => {
    // Five wrong codes each, and the two sequences compared in full: the
    // escalation from "Invalid code" to "Too many wrong codes" is itself an
    // observable, so it has to happen at the same guess on both.
    const sequence = async (phone: string): Promise<string[]> => {
      const bodies: string[] = [];
      for (let n = 1; n <= CODE_ATTEMPTS; n++) {
        const res = await complete(phone, String(100000 + n));
        expect(res.statusCode, `${phone} guess ${n}`).toBe(400);
        bodies.push(res.body);
      }
      return bodies;
    };

    const known = await sequence(INVITED);
    const unknown = await sequence(STRANGER);
    expect(unknown).toEqual(known);
    // Not vacuously equal: the last one is the escalation, and it is reached.
    expect(known[CODE_ATTEMPTS - 1]).toContain('Too many wrong codes');
    expect(known[0]).toContain('Invalid code');
  });

  it('an account that is already set up is not a third answer', async () => {
    // "No pending setup for this phone" separated invited staff from everyone
    // else. All three — the invited account this endpoint is for, an account
    // that has already been through it, and a number that has never been an
    // account — get the one answer.
    const invited = await complete(INVITED, '123456');
    const active = await complete(ACTIVE, '123456');
    const stranger = await complete('+66900000307', '123456');
    expect(active.statusCode).toBe(invited.statusCode);
    expect(active.body).toBe(invited.body);
    expect(stranger.body).toBe(invited.body);
  });
});

describe('password-reset/complete answers every phone the same way (SCRUM-251)', () => {
  const complete = (phone: string, code: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/complete',
      payload: { phone, code, password: 'somepassword1234' },
    });

  it('a phone with no account is answered, and counted, as a wrong code', async () => {
    const stranger = '+66900000308';
    const known = await complete(ACTIVE, '123456');
    const unknown = await complete(stranger, '123456');
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);

    // Counted: the guesses on a phone that has no account escalate at the
    // same number as the guesses on one that has. Sequential, because which
    // guess is the fifth is the whole assertion.
    let last = unknown;
    for (let n = 2; n <= CODE_ATTEMPTS; n++) {
      last = await complete(stranger, String(123456 + n));
    }
    expect(last.body).toContain('Too many wrong codes');
  });
});
