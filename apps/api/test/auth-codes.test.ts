import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, verificationCode, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import { _resetThrottle, consumeCode, mintCode, verifyCode } from '../src/services/auth';
import {
  RECEPTION,
  createTestContext,
  lastCode,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-347 — what a stored verification code gives away.
 *
 * Setup and password-reset codes were stored as an unsalted `sha256(code)`.
 * Six digits is a million possibilities, so the hash was the code to anyone who
 * could read `core.verification_code` — an export, a backup, a reporting
 * connection. The brute-force cases below are the proof in both directions:
 * the old format gives the code up in well under a second, and the new one does
 * not give it up to the same loop at all.
 */

let ctx: TestContext;
let accountId: string;

const sha256Hex = (code: string): string => createHash('sha256').update(code).digest('hex');

/** The six digits `mintCode` put in the SMS it handed back. */
const codeFromMessage = (message: string): string => {
  const m = message.match(/(\d{6})/);
  if (!m) throw new Error(`No code in message: ${message}`);
  return m[1]!;
};

/** The newest unconsumed row for the account, whatever it holds. */
async function newestRow(db: Db, purpose: 'setup' | 'password_reset') {
  const [row] = await db
    .select()
    .from(verificationCode)
    .where(
      and(eq(verificationCode.accountId, accountId), eq(verificationCode.purpose, purpose)),
    )
    .orderBy(desc(verificationCode.createdAt), desc(verificationCode.id))
    .limit(1);
  if (!row) throw new Error(`No ${purpose} code row for the account`);
  return row;
}

/**
 * Plant a row in the storage format this ticket replaced, as a code minted
 * before the deploy would look.
 */
async function plantLegacyRow(db: Db, code: string, purpose: 'setup' | 'password_reset') {
  const id = newId();
  await db.insert(verificationCode).values({
    id,
    accountId,
    purpose,
    codeHash: sha256Hex(code),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return id;
}

/**
 * The attack: hash every six-digit code and look for the stored one. Returns
 * the code and how long it took, or null when the loop finds nothing.
 */
function bruteForceSha256(storedHash: string): { code: string | null; ms: number } {
  const started = Date.now();
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = String(i).padStart(6, '0');
    if (sha256Hex(candidate) === storedHash) return { code: candidate, ms: Date.now() - started };
  }
  return { code: null, ms: Date.now() - started };
}

beforeAll(async () => {
  ctx = await createTestContext();
  const [acc] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, RECEPTION.phone))
    .limit(1);
  if (!acc) throw new Error('No seeded reception account');
  accountId = acc.id;
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-347 — a stored code is a salted argon2 hash, not sha256', () => {
  it('stores neither the code nor its sha256, and cannot be recomputed from the code alone', async () => {
    const pending = await mintCode(ctx.db, accountId, RECEPTION.phone, 'password_reset');
    const code = codeFromMessage(pending.message);
    const row = await newestRow(ctx.db, 'password_reset');

    expect(row.codeHash).not.toContain(code);
    expect(row.codeHash).not.toBe(sha256Hex(code));
    // Not even the shape of the old storage, so `codeMatches` cannot take the
    // legacy branch for a row written today.
    expect(row.codeHash).not.toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash.startsWith('$argon2id$')).toBe(true);

    /**
     * The salt, stated as the property that matters: knowing the code is not
     * enough to reproduce the stored string, because the salt is random per
     * row. Only `verify` — which reads the salt out of the row — can say yes.
     */
    expect(await hash(code)).not.toBe(row.codeHash);
  });

  it('the code still verifies and a wrong one does not', async () => {
    await _resetThrottle(ctx.db);
    const pending = await mintCode(ctx.db, accountId, RECEPTION.phone, 'password_reset');
    const code = codeFromMessage(pending.message);

    const verified = await verifyCode(ctx.db, accountId, 'password_reset', code);
    expect(verified.id).toBeTruthy();

    const wrong = code === '000000' ? '111111' : '000000';
    await expect(verifyCode(ctx.db, accountId, 'password_reset', wrong)).rejects.toThrow(
      /Invalid code/,
    );
  });

  it('is single-use, and still refuses an expired code as expired', async () => {
    await _resetThrottle(ctx.db);
    const pending = await mintCode(ctx.db, accountId, RECEPTION.phone, 'password_reset');
    const code = codeFromMessage(pending.message);

    const verified = await verifyCode(ctx.db, accountId, 'password_reset', code);
    await consumeCode(ctx.db, verified);
    await expect(verifyCode(ctx.db, accountId, 'password_reset', code)).rejects.toThrow(
      /Invalid code/,
    );

    await _resetThrottle(ctx.db);
    const second = await mintCode(ctx.db, accountId, RECEPTION.phone, 'password_reset');
    const expiring = codeFromMessage(second.message);
    await ctx.db
      .update(verificationCode)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verificationCode.id, (await newestRow(ctx.db, 'password_reset')).id));
    await expect(verifyCode(ctx.db, accountId, 'password_reset', expiring)).rejects.toThrow(
      /expired/i,
    );
  });
});

describe('SCRUM-347 — the defect, and that it is closed', () => {
  it('brute-forces a legacy row back to its code in well under a second', async () => {
    const code = '483920';
    await plantLegacyRow(ctx.db, code, 'setup');
    const stored = (await newestRow(ctx.db, 'setup')).codeHash;

    const { code: recovered, ms } = bruteForceSha256(stored);
    // This is the defect, kept as the "before" proof: the stored hash IS the
    // code to anybody holding an export of the table.
    expect(recovered).toBe(code);
    // Generous against a slow CI runner; it is ~0.4s on a developer laptop and
    // the number that matters is that it is a wait, not a campaign.
    expect(ms).toBeLessThan(5_000);
    console.log(`legacy sha256 row brute-forced in ${ms}ms → ${recovered}`);
  });

  it('the same loop over a row written today recovers nothing', async () => {
    await _resetThrottle(ctx.db);
    const pending = await mintCode(ctx.db, accountId, RECEPTION.phone, 'setup');
    const code = codeFromMessage(pending.message);
    const stored = (await newestRow(ctx.db, 'setup')).codeHash;

    const { code: recovered } = bruteForceSha256(stored);
    expect(recovered).toBeNull();
    // And the code it does hold still works, so the row is not merely opaque.
    expect((await verifyCode(ctx.db, accountId, 'setup', code)).id).toBeTruthy();
  });
});

describe('SCRUM-347 — pending old-style codes survive the deploy', () => {
  it('verifies a legacy 64-hex row through the fallback, and refuses a wrong code against it', async () => {
    await _resetThrottle(ctx.db);
    // Nothing else outstanding, so the row under test is the only candidate.
    await ctx.db
      .update(verificationCode)
      .set({ consumedAt: new Date() })
      .where(eq(verificationCode.accountId, accountId));

    const code = '246813';
    const id = await plantLegacyRow(ctx.db, code, 'password_reset');
    expect((await newestRow(ctx.db, 'password_reset')).codeHash).toMatch(/^[0-9a-f]{64}$/);

    await expect(verifyCode(ctx.db, accountId, 'password_reset', '135792')).rejects.toThrow(
      /Invalid code/,
    );
    const verified = await verifyCode(ctx.db, accountId, 'password_reset', code);
    expect(verified.id).toBe(id);
  });

  it('a code minted now is not stored in the legacy format at all', async () => {
    await _resetThrottle(ctx.db);
    await mintCode(ctx.db, accountId, RECEPTION.phone, 'password_reset');
    const rows = await ctx.db
      .select({ codeHash: verificationCode.codeHash })
      .from(verificationCode)
      .where(eq(verificationCode.accountId, accountId));
    // Every 64-hex row in the table is one this file planted by hand; nothing
    // `mintCode` wrote can take the fallback path.
    const planted = new Set([sha256Hex('483920'), sha256Hex('246813')]);
    const legacy = rows.filter((r) => /^[0-9a-f]{64}$/.test(r.codeHash));
    expect(legacy.every((r) => planted.has(r.codeHash))).toBe(true);
    expect(rows.length).toBeGreaterThan(legacy.length);
  });
});

describe('SCRUM-347 — the flows still run end to end', () => {
  it('password reset: request, complete with the code that was sent, sign in with the new password', async () => {
    await _resetThrottle(ctx.db);
    const request = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      payload: { phone: RECEPTION.phone },
    });
    expect(request.statusCode).toBe(200);

    const code = lastCode(ctx.smsLog);
    const complete = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/complete',
      payload: { phone: RECEPTION.phone, code, password: 'saltedcode123' },
    });
    expect(complete.statusCode).toBe(200);

    expect(await signInAs(ctx.app, RECEPTION.phone, 'saltedcode123')).toBeTruthy();

    // Single use holds through the route as well.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/complete',
      payload: { phone: RECEPTION.phone, code, password: 'hijacked1234' },
    });
    expect(replay.statusCode).toBe(400);
  });
});
