import { hash } from '@node-rs/argon2';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, authThrottle, branch, operator, role, roleAssignment } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { isPgError, phoneHash, scrubPgError, scrubUrl, uniqueViolationToAppError } from '../src/lib/scrub';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-01a dev evidence: the four checks the ticket names — privilege
 * dominance, a forged X-Forwarded-For, throttle state surviving a restart,
 * and pg-error redaction.
 */

let ctx: TestContext;
beforeAll(async () => {
  // Two failures instead of five keeps the throttle cases quick; the
  // behaviour under test is the same at any limit.
  ctx = await createTestContext({ env: { AUTH_MAX_FAILURES: '2', AUTH_COOLDOWN_SECONDS: '300' } });
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** An extra account with one role at one scope, password set directly. */
async function makeAccount(opts: {
  phone: string;
  password: string;
  roleName: string;
  scopeType: 'operator' | 'branch';
  scopeId: string | null;
  operatorId?: string;
}): Promise<string> {
  const [op] = await ctx.db.select().from(operator).limit(1);
  const operatorId = opts.operatorId ?? op!.id;
  const [roleRow] = await ctx.db.select().from(role).where(eq(role.name, opts.roleName)).limit(1);
  const id = newId();
  await ctx.db.insert(account).values({
    id,
    operatorId,
    phone: normalizePhone(opts.phone)!,
    passwordHash: await hash(opts.password),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(roleAssignment).values({
    id: newId(),
    accountId: id,
    roleId: roleRow!.id,
    scopeType: opts.scopeType,
    scopeId: opts.scopeId,
  });
  return id;
}

describe('privilege dominance (S2-01a)', () => {
  let managerCookie: string;
  let managerId: string;
  let receptionId: string;
  let adminId: string;

  beforeAll(async () => {
    const [op] = await ctx.db.select().from(operator).limit(1);
    const [br] = await ctx.db.select().from(branch).where(eq(branch.operatorId, op!.id)).limit(1);
    managerId = await makeAccount({
      phone: '+66900000010',
      password: 'manager1234',
      roleName: 'branch_manager',
      scopeType: 'branch',
      scopeId: br!.id,
    });
    const [reception] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, '+66900000002'))
      .limit(1);
    receptionId = reception!.id;
    const [admin] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, '+66900000001'))
      .limit(1);
    adminId = admin!.id;
    managerCookie = await signInAs(ctx.app, '+66900000010', 'manager1234');
  });

  it('refuses a role the caller does not itself hold at a covering scope', async () => {
    const [op] = await ctx.db.select().from(operator).limit(1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${receptionId}/role-assignments`,
      headers: { cookie: managerCookie },
      payload: { roleName: 'platform_admin', scopeType: 'operator', scopeId: op!.id },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ROLE_NOT_DOMINATED');
  });

  it('refuses the platform-wide scope outright to a caller who is not platform-wide', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${receptionId}/role-assignments`,
      headers: { cookie: managerCookie },
      // scopeId null = platform-wide, across every operator. Checked before
      // dominance: a scope you may not touch is refused before its contents
      // are weighed.
      payload: { roleName: 'reception', scopeType: 'operator', scopeId: null },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SCOPE_NOT_OWNED');
  });

  it('refuses a temp password for an account holding roles the caller cannot grant', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${adminId}/temp-password`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ROLE_NOT_DOMINATED');
  });

  it('records each refusal so the Login Users panel can show it', async () => {
    const adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/audit?action=access.denied&limit=10',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries as Array<{
      actorAccountId: string;
      after: { code: string; method: string; url: string };
    }>;
    // The two refusals above, attributed to the manager who was refused.
    const codes = entries.map((e) => e.after.code);
    expect(codes).toContain('ROLE_NOT_DOMINATED');
    expect(entries.every((e) => e.actorAccountId === managerId)).toBe(true);
    // The recorded URL never carries a query string.
    expect(entries.every((e) => !e.after.url.includes('phone='))).toBe(true);
  });

  it('hides an account belonging to another operator behind a 404', async () => {
    const [other] = await ctx.db
      .insert(operator)
      .values({ id: newId(), name: 'Other Operator' })
      .returning();
    const strangerId = await makeAccount({
      phone: '+66900000011',
      password: 'stranger1234',
      roleName: 'reception',
      scopeType: 'operator',
      scopeId: other!.id,
      operatorId: other!.id,
    });
    const adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${strangerId}/permissions`,
      headers: { cookie: adminCookie },
    });
    // 404, not 403: a platform admin of one tenant must not be able to
    // confirm that an id exists in another.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_FOUND');
    expect(managerId).toBeTruthy();
  });
});

describe('forged X-Forwarded-For (S2-01a)', () => {
  it('cannot move a caller into a fresh bucket while TRUST_PROXY is off', async () => {
    // Per-IP allowance is 4x the per-phone limit (2 here) = 8 failures.
    // Each attempt uses a different unknown phone, so only the IP bucket
    // accumulates, and each claims to come from a different client.
    const attempt = (n: number) =>
      ctx.app.inject({
        method: 'POST',
        url: '/auth/sign-in',
        headers: { 'x-forwarded-for': `203.0.113.${n}` },
        payload: { phone: `+6690000${String(2000 + n).padStart(4, '0')}`, password: 'nope12345' },
      });

    for (let n = 1; n <= 8; n++) {
      expect((await attempt(n)).statusCode, `attempt ${n}`).toBe(401);
    }
    const blocked = await attempt(9);
    expect(blocked.statusCode).toBe(429);

    // And the proof of WHY: one bucket keyed by the socket address, no rows
    // for any of the nine forged addresses.
    const rows = await ctx.db.select().from(authThrottle).where(like(authThrottle.key, 'ip:%'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe('ip:127.0.0.1');
    await ctx.db.delete(authThrottle).where(like(authThrottle.key, 'ip:%'));
  });
});

describe('throttle survives a restart (S2-01a)', () => {
  it('keeps the cooldown after the api process is replaced', async () => {
    const phone = '+66900000012';
    await makeAccount({
      phone,
      password: 'restart1234',
      roleName: 'reception',
      scopeType: 'operator',
      scopeId: null,
    });
    const wrong = () =>
      ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { phone, password: 'wrong12345' } });
    expect((await wrong()).statusCode).toBe(401);
    expect((await wrong()).statusCode).toBe(401);
    // Limit reached: the next attempt is refused even with the RIGHT password.
    const locked = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone, password: 'restart1234' },
    });
    expect(locked.statusCode).toBe(429);

    // What Render does on every deploy. In Sprint 1 this cleared the Map and
    // handed the attacker a fresh five guesses.
    await ctx.restart();

    const afterRestart = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone, password: 'restart1234' },
    });
    expect(afterRestart.statusCode).toBe(429);
    expect(afterRestart.json().error.code).toBe('TOO_MANY_REQUESTS');

    await ctx.db.delete(authThrottle);
  });
});

describe('pg-error and URL redaction (S2-01a)', () => {
  // Fixture: what node-postgres raises on `member_phone_unique`. The value
  // lives in `detail` — the field that used to reach the log.
  const pgUniqueViolation = Object.assign(
    new Error('duplicate key value violates unique constraint "member_phone_unique"'),
    {
      code: '23505',
      severity: 'ERROR',
      detail: 'Key (operator_id, phone)=(0199-…, +66811111111) already exists.',
      hint: 'Try +66811111111 instead.',
      where: 'SQL statement "insert into member … +66811111111"',
      schema: 'public',
      table: 'member',
      constraint: 'member_phone_unique',
      routine: '_bt_check_unique',
      parameters: ['+66811111111'],
    },
  );

  it('recognises a pg error and keeps only the structural fields', () => {
    expect(isPgError(pgUniqueViolation)).toBe(true);
    const scrubbed = scrubPgError(pgUniqueViolation);
    expect(scrubbed).toMatchObject({
      pgCode: '23505',
      constraint: 'member_phone_unique',
      table: 'member',
    });
    expect(JSON.stringify(scrubbed)).not.toContain('66811111111');
    for (const dropped of ['detail', 'hint', 'where', 'parameters']) {
      expect(scrubbed).not.toHaveProperty(dropped);
    }
  });

  it('maps a unique violation to a 409 that names the constraint, not the value', () => {
    const mapped = uniqueViolationToAppError(pgUniqueViolation);
    expect(mapped?.statusCode).toBe(409);
    expect(mapped?.code).toBe('MEMBER_PHONE_EXISTS');
    expect(JSON.stringify(mapped?.details)).not.toContain('66811111111');
    expect(uniqueViolationToAppError(new Error('not a pg error'))).toBeNull();
  });

  it('strips the query string from a logged URL and hashes a phone', () => {
    expect(scrubUrl('/members/lookup?phone=%2B66811111111')).toBe('/members/lookup?[redacted]');
    expect(scrubUrl('/members/lookup')).toBe('/members/lookup');
    const hashed = phoneHash('+66811111111');
    expect(hashed).not.toContain('66811111111');
    expect(phoneHash('+66811111111')).toBe(hashed); // stable
  });

  it('returns 409 without the phone when a duplicate member is created', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie },
      payload: { phone: '0811111111', nickname: 'Mali again' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MEMBER_PHONE_EXISTS');
    expect(res.json().error.message).not.toContain('811111111');
  });
});

describe('unauthenticated surface limits (S2-01a)', () => {
  it('rate-limits password-reset requests per phone', async () => {
    const phone = '+66900000013';
    const request = () =>
      ctx.app.inject({ method: 'POST', url: '/auth/password-reset/request', payload: { phone } });
    // RATE_LIMIT_CODE_MAX defaults to 5 in a 15-minute window.
    for (let n = 1; n <= 5; n++) {
      expect((await request()).statusCode, `request ${n}`).toBe(200);
    }
    const blocked = await request();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('TOO_MANY_REQUESTS');
    await ctx.db.delete(authThrottle);
  });

  it('invalidates every outstanding code after too many wrong guesses', async () => {
    const phone = '+66900000014';
    const accountId = await makeAccount({
      phone,
      password: 'codes1234',
      roleName: 'reception',
      scopeType: 'operator',
      scopeId: null,
    });
    await ctx.app.inject({ method: 'POST', url: '/auth/password-reset/request', payload: { phone } });
    const code = ctx.smsLog[ctx.smsLog.length - 1]!.match(/(\d{6})/)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';

    const guess = (c: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/auth/password-reset/complete',
        payload: { phone, code: c, password: 'brandnew1234' },
      });
    for (let n = 1; n <= 4; n++) {
      const res = await guess(wrong);
      expect(res.json().error.message, `guess ${n}`).toBe('Invalid code');
    }
    const fifth = await guess(wrong);
    expect(fifth.json().error.message).toBe('Too many wrong codes — request a new one');

    // The real code is dead too — that is the point of invalidation.
    const withRealCode = await guess(code);
    expect(withRealCode.statusCode).toBe(400);
    expect(accountId).toBeTruthy();
    await ctx.db.delete(authThrottle);
  });

  it('refuses a cross-origin state-changing request', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      headers: { origin: 'https://evil.example' },
      payload: { phone: ADMIN.phone, password: ADMIN.password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('ignores a caller-supplied request id that is not in the allowed shape', async () => {
    const forged = 'not a valid id\nlevel=fatal';
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': forged },
    });
    expect(res.headers['x-request-id']).not.toBe(forged);
    const accepted = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(accepted.headers['x-request-id']).toBe('req-12345678');
  });
});

describe('locked and temp-password sessions (S2-01a)', () => {
  it('refuses requireAuth-only business routes while locked, but allows the way out', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const lock = await ctx.app.inject({ method: 'POST', url: '/auth/lock', headers: { cookie } });
    expect(lock.statusCode).toBe(200);

    // A requireAuth-only route — no permission involved — must still refuse.
    const staged = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/pending-lookup',
      headers: { cookie },
      payload: { phone: '0811111111' },
    });
    expect(staged.statusCode).toBe(423);
    expect(staged.json().error.code).toBe('SESSION_LOCKED');

    // …while the session itself survives and the password unlocks it.
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const unlock = await ctx.app.inject({
      method: 'POST',
      url: '/auth/unlock',
      headers: { cookie },
      payload: { password: ADMIN.password },
    });
    expect(unlock.statusCode).toBe(200);
    const afterUnlock = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/pending-lookup',
      headers: { cookie },
      payload: { phone: '0811111111' },
    });
    expect(afterUnlock.statusCode).toBe(200);
  });

  it('blocks a temp-password account everywhere except the change itself', async () => {
    const phone = '+66900000015';
    const accountId = await makeAccount({
      phone,
      password: 'temp1234abc',
      roleName: 'reception',
      scopeType: 'operator',
      scopeId: null,
    });
    await ctx.db.update(account).set({ mustChangePassword: true }).where(eq(account.id, accountId));
    const cookie = await signInAs(ctx.app, phone, 'temp1234abc');

    const staged = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/pending-lookup',
      headers: { cookie },
      payload: { phone: '0811111111' },
    });
    expect(staged.statusCode).toBe(403);
    expect(staged.json().error.code).toBe('MUST_CHANGE_PASSWORD');

    const changed = await ctx.app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'temp1234abc', password: 'chosen1234abc' },
    });
    expect(changed.statusCode).toBe(200);

    const afterChange = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/pending-lookup',
      headers: { cookie },
      payload: { phone: '0811111111' },
    });
    expect(afterChange.statusCode).toBe(200);
  });

  it('force sign-out revokes every session and the old cookie is refused', async () => {
    const phone = '+66900000016';
    const targetId = await makeAccount({
      phone,
      password: 'evicted1234',
      roleName: 'reception',
      scopeType: 'operator',
      scopeId: null,
    });
    const victimCookie = await signInAs(ctx.app, phone, 'evicted1234');
    const adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${targetId}/sessions`,
      headers: { cookie: adminCookie },
    });
    expect(listed.json().sessions.length).toBeGreaterThan(0);

    const revoked = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${targetId}/sessions/revoke`,
      headers: { cookie: adminCookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().sessionsEnded).toBeGreaterThan(0);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: victimCookie },
    });
    expect(after.statusCode).toBe(401);

    // The row survives for audit rather than being deleted.
    const stillListed = await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${targetId}/sessions`,
      headers: { cookie: adminCookie },
    });
    expect(stillListed.json().sessions.length).toBeGreaterThan(0);
    const [op] = await ctx.db.select().from(operator).limit(1);
    expect(op).toBeTruthy();
    await ctx.db.delete(authThrottle).where(and(like(authThrottle.key, 'ip:%')));
  });
});
