import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, authThrottle, verificationCode } from '@oto/db';
import {
  _resetThrottle,
  consumeCode,
  issueCode,
  mintCode,
  verifyCode,
  type CodePurpose,
} from '../src/services/auth';
import type { CodeVerdict, SmsSender } from '../src/services/sms';
import { RECEPTION, createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-455 — the auth path when the adapter checks codes itself (twilio_verify).
 *
 * With this adapter Twilio generates, sends AND checks the code, so the
 * platform stores no code: the `verification_code` row holds only a marker and
 * exists as the anchor and the single-use lock. These cases drive the auth
 * service against a stub `checksCodes` sender — no network, a verdict the test
 * controls — to prove three things stay true: the local hash comparison is
 * bypassed, a used code cannot be used again, and a wrong code still costs a
 * guess against the same throttle.
 */

let ctx: TestContext;
let accountId: string;
const PHONE = RECEPTION.phone;

/** A twilio_verify-shaped sender whose verdict and calls the test controls. */
interface StubSender extends SmsSender {
  starts: number;
  checks: Array<{ phone: string; code: string }>;
  verdict: CodeVerdict;
}

function stubChecksCodesSender(): StubSender {
  const sender: StubSender = {
    starts: 0,
    checks: [],
    verdict: 'approved',
    // Reaching send() would mean the code path treated this like a message
    // adapter — the whole point is that it does not.
    async send() {
      throw new Error('twilio_verify send() must not be reached on the code path');
    },
    checksCodes: {
      async start() {
        sender.starts += 1;
      },
      async checkCode(phone, code) {
        sender.checks.push({ phone, code });
        return sender.verdict;
      },
    },
  };
  return sender;
}

const isArgon2 = (h: string): boolean => h.startsWith('$argon2');
const isLegacySha256 = (h: string): boolean => /^[0-9a-f]{64}$/.test(h);

async function newestRow(purpose: CodePurpose) {
  const [row] = await ctx.db
    .select()
    .from(verificationCode)
    .where(and(eq(verificationCode.accountId, accountId), eq(verificationCode.purpose, purpose)))
    .orderBy(desc(verificationCode.createdAt), desc(verificationCode.id))
    .limit(1);
  if (!row) throw new Error(`No ${purpose} code row for the account`);
  return row;
}

/** Consume every outstanding code so a test's freshly minted one is the only anchor. */
async function clearCodes(): Promise<void> {
  await ctx.db
    .update(verificationCode)
    .set({ consumedAt: new Date() })
    .where(eq(verificationCode.accountId, accountId));
}

/** How many wrong guesses the code bucket has counted — the throttle side-effect. */
async function guessesCounted(purpose: CodePurpose): Promise<number> {
  const [row] = await ctx.db
    .select({ failures: authThrottle.failures })
    .from(authThrottle)
    .where(eq(authThrottle.key, `code:${accountId}:${purpose}`))
    .limit(1);
  return row?.failures ?? 0;
}

/** A live-shaped anchor pushed past its own `expiresAt`, to prove the gate reads it. */
async function mintExpiredAnchor(purpose: CodePurpose): Promise<void> {
  const sms = stubChecksCodesSender();
  await mintCode(ctx.db, accountId, PHONE, purpose, sms);
  const row = await newestRow(purpose);
  await ctx.db
    .update(verificationCode)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(verificationCode.id, row.id));
}

beforeAll(async () => {
  ctx = await createTestContext();
  const [acc] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, PHONE))
    .limit(1);
  if (!acc) throw new Error('No seeded reception account');
  accountId = acc.id;
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});
beforeEach(async () => {
  await _resetThrottle(ctx.db);
  await clearCodes();
});

describe('SCRUM-455 — the row is an anchor with a marker, not a stored code', () => {
  it('mints a marker row: neither an argon2 hash nor the legacy sha256 shape', async () => {
    const sms = stubChecksCodesSender();
    const pending = await mintCode(ctx.db, accountId, PHONE, 'setup', sms);

    // No local code travels back — Twilio composed and sent it.
    expect(pending.message).toBe('');
    const row = await newestRow('setup');
    expect(isArgon2(row.codeHash)).toBe(false);
    expect(isLegacySha256(row.codeHash)).toBe(false);
    expect(row.codeHash.length).toBeGreaterThan(0);
  });

  it('issueCode starts a Verify challenge and never calls send()', async () => {
    const sms = stubChecksCodesSender();
    await issueCode(ctx.db, sms, accountId, PHONE, 'setup');

    expect(sms.starts).toBe(1);
    // A row is written as the anchor, in the marker format.
    const row = await newestRow('setup');
    expect(isArgon2(row.codeHash)).toBe(false);
    expect(row.consumedAt).toBeNull();
  });
});

describe('SCRUM-455 — the guess goes to Twilio, not to the stored hash', () => {
  it('the local comparison is bypassed: the same marker row refuses locally but Twilio approves', async () => {
    const sms = stubChecksCodesSender();
    await mintCode(ctx.db, accountId, PHONE, 'setup', sms);

    // The marker matches no six-digit code, so the LOCAL path refuses it —
    // proof the row carries no usable code.
    await expect(verifyCode(ctx.db, accountId, 'setup', '123456', 5)).rejects.toThrow(
      /Invalid code/,
    );

    // The SAME row, the SAME typed code, but now with the adapter that checks:
    // Twilio's verdict is consulted, so it is accepted.
    await _resetThrottle(ctx.db);
    sms.verdict = 'approved';
    const verified = await verifyCode(ctx.db, accountId, 'setup', '123456', 5, {
      sms,
      phone: PHONE,
    });
    expect(verified.id).toBe((await newestRow('setup')).id);
    // And the guess reached Twilio with the phone and the typed code.
    expect(sms.checks.at(-1)).toEqual({ phone: PHONE, code: '123456' });
  });

  it('a live anchor whose Verify session is gone (expired) is a counted "Invalid code", not a free "expired"', async () => {
    const sms = stubChecksCodesSender();
    await mintCode(ctx.db, accountId, PHONE, 'setup', sms);
    sms.verdict = 'expired';

    // A 404 from Verify — the session timed out, a start failed, or the code
    // was already approved — is FREE and distinguishable at the provider. With
    // a live anchor it must not become a free, differently-worded answer: it is
    // refused as any wrong-or-gone code is, and the guess is counted.
    await expect(
      verifyCode(ctx.db, accountId, 'setup', '111111', 5, { sms, phone: PHONE }),
    ).rejects.toThrow(/Invalid code/);
    // Twilio was consulted (the anchor was live) but its verdict did not spare
    // the guess: the throttle window advanced.
    expect(sms.checks).toHaveLength(1);
    expect(await guessesCounted('setup')).toBe(1);
  });

  it('no live anchor: "Invalid code", a counted guess, and Twilio is never asked', async () => {
    // An unknown or already-completed account has no outstanding anchor. The
    // guess is refused locally — the same sentence and the same cost as a wrong
    // code — WITHOUT reaching Twilio, so a 404 verdict cannot leak back.
    const sms = stubChecksCodesSender();
    await clearCodes();

    await expect(
      verifyCode(ctx.db, accountId, 'setup', '111111', 5, { sms, phone: PHONE }),
    ).rejects.toThrow(/Invalid code/);
    expect(sms.checks).toHaveLength(0);
    expect(await guessesCounted('setup')).toBe(1);
  });

  it('an expired anchor is refused before Twilio, exactly as no anchor is', async () => {
    // The anchor's OWN expiry is consulted here — a row past `expiresAt` is
    // treated as no anchor, so a code that lingered is never smuggled to Twilio.
    const sms = stubChecksCodesSender();
    sms.verdict = 'approved';
    await mintExpiredAnchor('setup');

    await expect(
      verifyCode(ctx.db, accountId, 'setup', '111111', 5, { sms, phone: PHONE }),
    ).rejects.toThrow(/Invalid code/);
    expect(sms.checks).toHaveLength(0);
  });
});

describe('SCRUM-455/251 — a gone Verify session enumerates nothing: guess for guess', () => {
  /**
   * The regression this closes: with a live anchor but no live Verify session,
   * an invited phone used to get a free, differently-worded "Code expired"
   * while an account with nothing outstanding got a counted "Invalid code" — a
   * directory, and a free one, indefinitely. Both classes must now answer
   * identically, guess for guess, exactly as `/auth/setup/complete` does at the
   * HTTP edge for a known versus an unknown phone (auth-enumeration.test.ts
   * "a known invited phone and an unknown one are identical, guess for guess").
   */
  const ATTEMPTS = 5;

  /** Drive one class of refusal for a full budget and collect each message. */
  const sequence = async (arrange: () => Promise<StubSender>): Promise<string[]> => {
    await _resetThrottle(ctx.db);
    await clearCodes();
    const sms = await arrange();
    const messages: string[] = [];
    for (let n = 1; n <= ATTEMPTS; n++) {
      try {
        await verifyCode(ctx.db, accountId, 'setup', String(100000 + n), ATTEMPTS, {
          sms,
          phone: PHONE,
        });
        throw new Error(`guess ${n} unexpectedly passed`);
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    return messages;
  };

  it('a live anchor whose Verify session is gone answers as an account with nothing outstanding', async () => {
    const goneSession = await sequence(async () => {
      const sms = stubChecksCodesSender();
      await mintCode(ctx.db, accountId, PHONE, 'setup', sms);
      sms.verdict = 'expired'; // Twilio holds no live verification for this phone
      return sms;
    });
    const nothingOutstanding = await sequence(async () => stubChecksCodesSender());

    expect(goneSession).toEqual(nothingOutstanding);
    // Not vacuously equal: the escalation is reached, and at the same guess.
    expect(goneSession[0]).toContain('Invalid code');
    expect(goneSession[ATTEMPTS - 1]).toContain('Too many wrong codes');
  });
});

describe('SCRUM-455 — single use, and the throttle still counts', () => {
  it('an approved code cannot be used a second time once consumed', async () => {
    const sms = stubChecksCodesSender();
    await mintCode(ctx.db, accountId, PHONE, 'setup', sms);
    sms.verdict = 'approved';

    const verified = await verifyCode(ctx.db, accountId, 'setup', '222222', 5, {
      sms,
      phone: PHONE,
    });
    await consumeCode(ctx.db, verified);

    // Even with Twilio still answering approved, the anchor is spent — there is
    // nothing left to consume, so the replay is refused. (Twilio itself would
    // also close an approved verification, answering the second check expired.)
    await _resetThrottle(ctx.db);
    await expect(
      verifyCode(ctx.db, accountId, 'setup', '222222', 5, { sms, phone: PHONE }),
    ).rejects.toThrow(/Invalid code/);
  });

  it('a denied verdict counts a guess and, at the budget, invalidates the anchor', async () => {
    const sms = stubChecksCodesSender();
    await mintCode(ctx.db, accountId, PHONE, 'setup', sms);
    sms.verdict = 'denied';

    // maxAttempts = 3: the message escalates exactly at the threshold, which is
    // the same attempt counting a local wrong code goes through.
    await expect(
      verifyCode(ctx.db, accountId, 'setup', '000000', 3, { sms, phone: PHONE }),
    ).rejects.toThrow(/Invalid code/);
    await expect(
      verifyCode(ctx.db, accountId, 'setup', '000000', 3, { sms, phone: PHONE }),
    ).rejects.toThrow(/Invalid code/);
    await expect(
      verifyCode(ctx.db, accountId, 'setup', '000000', 3, { sms, phone: PHONE }),
    ).rejects.toThrow(/Too many wrong codes/);

    // The budget being gone invalidated every outstanding code, exactly as the
    // local path does — the anchor is now consumed.
    expect((await newestRow('setup')).consumedAt).not.toBeNull();
  });
});
