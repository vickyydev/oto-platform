import { hash, verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, auditLog, operator, role, roleAssignment } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { _resetThrottle } from '../src/services/auth';
import {
  CENTRAL_BRANCH_CODE,
  branchIdByCode,
  createTestContext,
  lastCode,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-423 — argon2's `verify`, wrapped so the two constant-cost cases can
 * watch it.
 *
 * The real function runs underneath (`vi.fn(actual.verify)`): every case in
 * this file still does the real work. `vi.mock` is hoisted above the imports,
 * which is what puts the wrapper in front of `services/auth.ts` as well as
 * this file — a spy on the service's private dummy verification would
 * otherwise need a seam cut into it.
 */
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

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
 *
 * SCRUM-325 adds the channel the bytes do not cover: the CLOCK. Identical
 * answers still sorted the same list of numbers if one class of refusal came
 * back measurably sooner, and one did — argon2 ran only for an active account,
 * so every other class was answered without it. The sign-in describe near the
 * end of the file pins that every class now spends that verification.
 * SCRUM-348 adds the unlock screen, which had the same shape. Both cases prove
 * the work directly rather than timing it (SCRUM-423), which is what the
 * wrapped `verify` just below the imports is for.
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
/**
 * A fifth class: an `active` account whose whole tenant has been retired
 * (SCRUM-253). It is the newest refusal that never reaches the password, and
 * therefore the newest one that could have been told apart by a stopwatch.
 */
const ARCHIVED_OPERATOR = '+66900000310';
/**
 * The two locked tills of the unlock case (SCRUM-348). Both are ordinary
 * active accounts and both sign in for real — the second has its password
 * hash taken away afterwards, because a session can only be opened by an
 * account that had one.
 */
const UNLOCK_LIVE = '+66900000311';
const UNLOCK_NO_HASH = '+66900000312';
/**
 * A sixth class of refused sign-in: an `active` account with no password hash
 * at all. Nothing in the code writes that row — an import, a restored dump or
 * a hand-run UPDATE is where it comes from — but `signIn` guards it by name
 * and charges it like the others, and a guard nothing exercises is the one
 * that quietly stops doing so.
 */
const ACTIVE_NO_HASH = '+66900000313';

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
  // Their own accounts rather than ACTIVE's: the unlock case leaves one of
  // them without a password hash, and ACTIVE is what every sign-in case above
  // signs in with.
  await make(UNLOCK_LIVE, 'active', ACTIVE_PASSWORD);
  await make(UNLOCK_NO_HASH, 'active', ACTIVE_PASSWORD);
  // Active, verified, and never given a password: the hashless sign-in class.
  await make(ACTIVE_NO_HASH, 'active');

  /**
   * A retired tenant of its own, rather than archiving a seeded one: OTO is
   * what every other case in this file signs in against, and switching it off
   * would make them all pass for the wrong reason.
   */
  const retiredOperatorId = newId();
  await ctx.db
    .insert(operator)
    .values({ id: retiredOperatorId, name: 'Retired Park', archivedAt: new Date() });
  await ctx.db.insert(account).values({
    id: newId(),
    operatorId: retiredOperatorId,
    phone: normalizePhone(ARCHIVED_OPERATOR)!,
    // Active, verified and with a real password: the ONLY thing standing
    // between it and a session is its operator's `archived_at`.
    passwordHash: await hash(ACTIVE_PASSWORD),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/**
 * Every case starts with empty counters. They are shared — sign-in keys one
 * per phone and one for the address every inject comes from (4 × five
 * failures would close it after four rounds), unlock keys one per session
 * and one per account — so a case that inherited the previous one's would
 * pass or fail on the order the file happens to run in.
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

/** One thing a refusal asked argon2 to do. */
interface Verification {
  /** The encoded hash the typed password was checked against. */
  hashed: string;
  password: string;
  /** Whether the check had finished before the refusal was answered. */
  finishedFirst: boolean;
}

/** One refused request: its answer, and every verification behind it. */
interface Refusal {
  body: string;
  verifications: Verification[];
}

/**
 * The fields of a PHC-encoded hash that decide what a verification costs:
 * the algorithm, its version and its parameters (`argon2id$v=19$m=…,t=…,p=…`).
 * The salt and the hash itself are what differ between two hashes minted the
 * same way, and they cost nothing.
 */
const parameters = (encoded: string): string => encoded.split('$').slice(1, 4).join('$');

/** The password hash an account row holds, or null when it holds none. */
async function storedHash(phone: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ passwordHash: account.passwordHash })
    .from(account)
    .where(eq(account.phone, normalizePhone(phone)!))
    .limit(1);
  return row?.passwordHash ?? null;
}

/**
 * Make one refused request and record every verification it ran (SCRUM-423).
 *
 * A verification the refusal did not wait for would still be counted as work,
 * and would still leave the early answer for a stopwatch to read — which is
 * why each one also records whether it had settled before the response came
 * back. The spy is re-pointed for the one call and restored after it, so the
 * requests that go through here are made one at a time, never in parallel.
 */
async function refused(
  call: () => Promise<{ statusCode: number; body: string }>,
): Promise<Refusal> {
  await _resetThrottle(ctx.db);
  const verifySpy = vi.mocked(verify);
  const real = verifySpy.getMockImplementation()!;
  const verifications: Verification[] = [];
  let answered = false;
  verifySpy.mockImplementation(async (hashed, password, options, abortSignal) => {
    const entry: Verification = {
      hashed: String(hashed),
      password: String(password),
      finishedFirst: false,
    };
    verifications.push(entry);
    try {
      return await real(hashed, password, options, abortSignal);
    } finally {
      entry.finishedFirst = !answered;
    }
  });
  try {
    const res = await call();
    answered = true;
    expect(res.statusCode).toBe(401);
    return { body: res.body, verifications };
  } finally {
    verifySpy.mockImplementation(real);
  }
}

/**
 * SCRUM-325 — the same answer, for the same work.
 *
 * Making the four classes byte-identical closed the channel you can read; it
 * left the one you can time. An active account's password goes through argon2
 * — roughly ten milliseconds of deliberately expensive work — and every other
 * class was refused before reaching it, so a stranger with a list of numbers
 * and a stopwatch sorted them exactly as the old 403s had. The throttle caps
 * each number at five attempts per window, which makes that slow from outside,
 * not impossible: five samples a window against a difference this large is
 * enough, and a list of numbers has no deadline.
 *
 * WHICH HASH EACH CLASS IS CHECKED AGAINST, because that is what the case
 * pins. Only the active account's password is checked against its own stored
 * hash: it is the one refusal where a right password would have opened
 * something. Every other class is decided before the password is looked at and
 * leaves through the service's `fail`, which spends one verification of the
 * typed password against its dummy hash — a hash that is nobody's, minted once
 * at module load with the parameters every stored hash is written with. That
 * includes the two classes that DO hold a stored hash, the deactivated account
 * and the account of a retired operator: nothing is computed about a credential
 * nothing may use, and the dummy costs the same, which is all a stopwatch can
 * see.
 *
 * HOW IT IS PROVED — by the work, not by the clock (SCRUM-423). Until this
 * ticket the case raced the five classes over fifty rounds each and held their
 * medians to half a verification apart and within 1.5× of each other — the
 * bounds that failed the unlock case on a shared CI runner on 25 September
 * with nothing changed in the code. The property is about work, and work can
 * be watched: `verify` is wrapped for this file (see the top), so the case
 * reads what each class asked argon2 to do and asserts it is the same job.
 *
 * There is no timing left, not even a coarse hang-guard. The one deliberately
 * expensive step is counted, and what the paths otherwise do differently is a
 * query — the operator's `archived_at`, which the unknown-phone path has no
 * account to read — that no guard loose enough to sit out a loaded runner
 * could see: a guard that cannot fail for the reason it exists and can fail
 * for noise is exactly what was removed.
 */
describe('a refusal costs the same work whatever it refuses (SCRUM-325)', () => {
  const BASELINE = 'active, wrong password';
  /** Every class of refused sign-in, by its phone. The order is not significant. */
  const CLASSES = [
    [BASELINE, ACTIVE],
    ['unknown phone', UNKNOWN],
    ['invited', INVITED],
    ['deactivated', DEACTIVATED],
    ['archived operator', ARCHIVED_OPERATOR],
    ['active, no password hash', ACTIVE_NO_HASH],
  ] as const;

  it('every class of refused phone is answered by one verification of the typed password', async () => {
    // The classes are what they say, or the assertions below are about
    // nothing: two hold a stored hash and are refused for another reason, two
    // hold none at all.
    for (const [label, phone] of [
      ['deactivated', DEACTIVATED],
      ['archived operator', ARCHIVED_OPERATOR],
    ] as const) {
      expect(await storedHash(phone), label).not.toBeNull();
    }
    for (const [label, phone] of [
      ['invited', INVITED],
      ['active, no password hash', ACTIVE_NO_HASH],
    ] as const) {
      expect(await storedHash(phone), label).toBeNull();
    }

    const refusals = new Map<string, Refusal>();
    // One at a time: `refused` re-points the spy for the length of each call.
    for (const [label, phone] of CLASSES) {
      refusals.set(label, await refused(() => signIn(phone)));
    }
    const baseline = refusals.get(BASELINE)!;

    // Not vacuous: every class is the one 401 with the same bytes, which is
    // what leaves the work as the only thing left to read.
    expect(JSON.parse(baseline.body).error.code).toBe('INVALID_CREDENTIALS');
    for (const [label, refusal] of refusals) {
      expect(refusal.body, label).toBe(baseline.body);
    }

    // One verification each, of the password that was typed, and the answer
    // waited for it on every path.
    for (const [label, refusal] of refusals) {
      expect(refusal.verifications, label).toHaveLength(1);
      expect(refusal.verifications[0]!.password, label).toBe(WRONG_PASSWORD);
      expect(refusal.verifications[0]!.finishedFirst, label).toBe(true);
    }

    // The active account's password was checked against its own stored hash…
    const activeHash = (await storedHash(ACTIVE))!;
    expect(baseline.verifications[0]!.hashed).toBe(activeHash);

    // …and every other class against the dummy: the same one for all of them —
    const dummy = refusals.get('unknown phone')!.verifications[0]!.hashed;
    for (const [label, refusal] of refusals) {
      if (label === BASELINE) continue;
      expect(refusal.verifications[0]!.hashed, label).toBe(dummy);
    }

    // — carrying the same algorithm and the same cost parameters as the real
    // hash, which is what decides what a verification costs —
    expect(parameters(dummy)).toMatch(/^argon2id\$v=19\$m=\d+,t=\d+,p=\d+$/);
    expect(parameters(dummy)).toBe(parameters(activeHash));

    // — a hash that is nobody's, and in particular not the stored hash of the
    // two classes that hold one: those are refused before their password is
    // looked at —
    const holders = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.passwordHash, dummy));
    expect(holders).toEqual([]);
    for (const [label, phone] of [
      ['deactivated', DEACTIVATED],
      ['archived operator', ARCHIVED_OPERATOR],
    ] as const) {
      expect(await storedHash(phone), label).not.toBe(dummy);
    }

    // — and the same one on the next refusal, because it is minted once: a
    // dummy minted per refusal would cost a hash on top of the verify and be
    // slower than what it imitates.
    const again = await refused(() => signIn(UNKNOWN));
    expect(again.verifications).toHaveLength(1);
    expect(again.verifications[0]!.hashed).toBe(dummy);
  });
});

/**
 * SCRUM-348 — and the locked till leaves by the same door.
 *
 * `POST /auth/unlock` verified the password only when there was one to verify
 * — `Boolean(acc?.passwordHash) && await verify(...)` — so a session whose
 * account had no hash was refused without argon2, milliseconds before a wrong
 * password on a normal till. The same shape SCRUM-325 closed on sign-in, in
 * the file it was closed in, one screen along.
 *
 * WHAT IT IS WORTH, honestly: less than the sign-in leak. That one was keyed
 * on a phone number, so a stranger with a list could sort it; this one is
 * keyed on a session id nobody can enumerate, and the only person who can put
 * a request to it is already holding a locked till. It is closed because the
 * equalised door is right there and a refusal that answers early is a fact
 * about the account, whoever can read it.
 *
 * THE CLASS THIS CAN REACH. The service guards two states — no account row and
 * no password hash — with one condition. Only the second is reachable through
 * the route: the session plugin inner-joins `account`, so a session with no
 * account row is answered 401 by `requireAuth` and never arrives. Nothing in
 * the code nulls a hash either, which is why the fixture signs in for real and
 * then takes the hash away: an imported account, a restored dump or a hand-run
 * UPDATE is where that row comes from, and the guard already anticipates it.
 *
 * HOW IT IS PROVED — by the work, not by the clock (SCRUM-423). This case
 * used to race the two refusals over fifty rounds under the bounds the sign-in
 * case then used, and on 25 September it went red on CI at 12.1 ms against
 * 18.0 ms: a 6.0 ms gap on a runner whose whole verification cost 7.6 ms, with
 * nothing changed in the code. Fifty medians of a two-class race on a shared
 * runner measure the runner. The property is about work — the refusal with no
 * hash to check must spend the argon2 verification the ordinary refusal
 * spends — and work can be watched directly: `refused` above reads what each
 * path asked argon2 to do, and the case asserts it is the same job. One
 * verification, of the typed password, against a hash carrying the same
 * algorithm and cost parameters, finished before the answer went out; and on
 * the hashless path against a hash that is nobody's and is the same one every
 * time, because a dummy minted per refusal would cost a hash on top of the
 * verify and be slower than what it imitates. A quiet runner cannot make that
 * pass and a loud one cannot make it fail.
 */
describe('an unlock refusal costs the same work whatever it refuses (SCRUM-348)', () => {
  /** Two locked tills: one whose account has a password, one whose has none. */
  let liveCookie: string;
  let hashlessCookie: string;

  beforeAll(async () => {
    /** Sign in for real, lock the till, and hand back the locked cookie. */
    const lockedSession = async (phone: string): Promise<string> => {
      await _resetThrottle(ctx.db);
      const cookie = await signInAs(ctx.app, phone, ACTIVE_PASSWORD);
      const locked = await ctx.app.inject({ method: 'POST', url: '/auth/lock', headers: { cookie } });
      expect(locked.statusCode, phone).toBe(200);
      return cookie;
    };

    liveCookie = await lockedSession(UNLOCK_LIVE);
    hashlessCookie = await lockedSession(UNLOCK_NO_HASH);
    // After the session exists, because sign-in is what mints it and sign-in
    // needs the hash this takes away.
    await ctx.db
      .update(account)
      .set({ passwordHash: null })
      .where(eq(account.phone, normalizePhone(UNLOCK_NO_HASH)!));
  });

  const unlock = (cookie: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/auth/unlock',
      headers: { cookie },
      payload: { password: WRONG_PASSWORD },
    });

  it('an account with no password is refused by the same argon2 work as a wrong one', async () => {
    const live = await refused(() => unlock(liveCookie));
    const hashless = await refused(() => unlock(hashlessCookie));
    // Not vacuous: both are 401 INVALID_CREDENTIALS with the same body, which
    // is what leaves the work as the only thing left to read.
    expect(hashless.body).toBe(live.body);

    // One verification each, of the password that was typed, and the answer
    // waited for it on both paths.
    expect(live.verifications).toHaveLength(1);
    expect(hashless.verifications).toHaveLength(1);
    for (const v of [live.verifications[0]!, hashless.verifications[0]!]) {
      expect(v.password).toBe(WRONG_PASSWORD);
      expect(v.finishedFirst).toBe(true);
    }

    // The ordinary till checked it against its account's own stored hash.
    const liveHash = (await storedHash(UNLOCK_LIVE))!;
    expect(live.verifications[0]!.hashed).toBe(liveHash);

    // The hashless one checked it against the dummy: the same algorithm and
    // the same cost parameters as the real hash — the PHC prefix names both,
    // and the parameters are what decide what a verification costs —
    const dummy = hashless.verifications[0]!.hashed;
    expect(dummy).not.toBe(liveHash);
    expect(parameters(dummy)).toMatch(/^argon2id\$v=19\$m=\d+,t=\d+,p=\d+$/);
    expect(parameters(dummy)).toBe(parameters(liveHash));

    // — a hash that is nobody's —
    const holders = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.passwordHash, dummy));
    expect(holders).toEqual([]);

    // — and the same one on the next refusal, because it is minted once.
    const again = await refused(() => unlock(hashlessCookie));
    expect(again.verifications).toHaveLength(1);
    expect(again.verifications[0]!.hashed).toBe(dummy);
  });
});
