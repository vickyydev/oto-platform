import { randomBytes } from 'node:crypto';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deviceCredential, session, station, stationEvent, verificationCode } from '@oto/db';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  lastCode,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-19 — sign in by phone', () => {
  it('signs in an active account and stores a session row', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: '0900000002', password: RECEPTION.password }, // Thai local format
    });
    expect(res.statusCode).toBe(200);
    const rows = await ctx.db.select().from(session);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses a wrong password with 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: RECEPTION.phone, password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('five failures trigger a cooldown — the next attempt is refused (429)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/sign-in',
        payload: { phone: '+66888888888', password: 'nope' },
      });
      expect(res.statusCode).toBe(401);
    }
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: '+66888888888', password: 'nope' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toMatch(/Try again/);
  });
});

describe('SCRUM-24 — sign out', () => {
  it('deletes the session and rejects the old cookie', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const out = await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});

describe('SCRUM-21 + SCRUM-20 — invite, setup, first sign-in', () => {
  const newPhone = '+66977777777';

  it('admin creates an invited account with a branch-scoped reception role', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const branches = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie } });
    const branchId = branches.json().branches[0].id as string;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { cookie },
      payload: {
        phone: newPhone,
        employeeName: 'New Staffer',
        roles: [{ roleName: 'reception', scopeType: 'branch', scopeId: branchId }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.smsLog.some((m) => m.includes('setup code'))).toBe(true);
  });

  it('invited account cannot sign in before setup', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: newPhone, password: 'whatever123' },
    });
    // SCRUM-251 — refused, and refused in the same words as a wrong password.
    // This used to be 403 `SETUP_REQUIRED`, which told anybody holding a list
    // of numbers which of them belong to staff who have not started yet. What
    // still matters here is unchanged: the account cannot sign in until setup
    // is done. That the answer no longer says WHY is pinned in
    // `auth-enumeration.test.ts`, beside the invited person's own way in.
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('completes setup with the SMS code, then signs in', async () => {
    await ctx.app.inject({ method: 'POST', url: '/auth/setup/start', payload: { phone: newPhone } });
    const code = lastCode(ctx.smsLog);
    const done = await ctx.app.inject({
      method: 'POST',
      url: '/auth/setup/complete',
      payload: { phone: newPhone, code, password: 'brandnew123' },
    });
    expect(done.statusCode).toBe(200);
    const cookie = await signInAs(ctx.app, newPhone, 'brandnew123');
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
  });

  it('a consumed code cannot be reused', async () => {
    const code = lastCode(ctx.smsLog);
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/auth/setup/complete',
      payload: { phone: newPhone, code, password: 'another123' },
    });
    expect(again.statusCode).toBe(400);
  });
});

describe('SCRUM-23 — password recovery', () => {
  it('resets with a code and kills existing sessions', async () => {
    const oldCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      payload: { phone: RECEPTION.phone },
    });
    const code = lastCode(ctx.smsLog);
    const done = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/complete',
      payload: { phone: RECEPTION.phone, code, password: 'resetpass123' },
    });
    expect(done.statusCode).toBe(200);
    // Old session cookie rejected afterwards.
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: oldCookie } });
    expect(me.statusCode).toBe(401);
    // New password works; used code cannot be replayed.
    await signInAs(ctx.app, RECEPTION.phone, 'resetpass123');
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/complete',
      payload: { phone: RECEPTION.phone, code, password: 'hijack1234' },
    });
    expect(replay.statusCode).toBe(400);
  });

  it('expired codes are refused', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      payload: { phone: RECEPTION.phone },
    });
    const code = lastCode(ctx.smsLog);
    await ctx.db
      .update(verificationCode)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verificationCode.purpose, 'password_reset'));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/complete',
      payload: { phone: RECEPTION.phone, code, password: 'whatever123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/expired/i);
  });
});

describe('SCRUM-28 — deactivation and temporary passwords', () => {
  it('temporary password signs in once and forces a change', async () => {
    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const accounts = await ctx.app.inject({ method: 'GET', url: '/accounts?q=New%20Staffer', headers: { cookie: admin } });
    const target = accounts.json().accounts[0];
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${target.id}/temp-password`,
      headers: { cookie: admin },
    });
    const temp = res.json().temporaryPassword as string;
    expect(temp).toBeTruthy();

    const cookie = await signInAs(ctx.app, target.phone, temp);
    // Guarded endpoints are blocked until the password is changed…
    const blocked = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0811111111',
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('MUST_CHANGE_PASSWORD');
    // …changing it unblocks.
    const change = await ctx.app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: temp, password: 'permanent123' },
    });
    expect(change.statusCode).toBe(200);
    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0811111111',
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('a deactivated account cannot sign in and its sessions die', async () => {
    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const accounts = await ctx.app.inject({ method: 'GET', url: '/accounts?q=New%20Staffer', headers: { cookie: admin } });
    const target = accounts.json().accounts[0];
    const live = await signInAs(ctx.app, target.phone, 'permanent123');
    const off = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${target.id}`,
      headers: { cookie: admin },
      payload: { status: 'inactive' },
    });
    expect(off.statusCode).toBe(200);
    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: target.phone, password: 'permanent123' },
    });
    // SCRUM-251 — deactivated, and refused with the right password in hand.
    // This used to be 403 `ACCOUNT_INACTIVE`, which turned the sign-in screen
    // into a way to ask whether somebody still works here. The person who
    // needs to know is told by the manager who switched the account off; the
    // Login Users panel shows the status and the refusals.
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe('INVALID_CREDENTIALS');
    const dead = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: live } });
    expect(dead.statusCode).toBe(401);
  });
});

describe('revoked display protected-call observations (SCRUM-201)', () => {
  let proof: TestContext;
  let managerCookie: string;
  let target: typeof station.$inferSelect;
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const rejectedEvents = (deviceId: string) => proof.db.select().from(stationEvent).where(and(
    eq(stationEvent.source, 'display'), eq(stationEvent.kind, 'error'),
    eq(stationEvent.outcome, 'refused'), eq(stationEvent.errorCode, 'DISPLAY_UNPAIRED'),
    sql`${stationEvent.payload}->>'deviceId' = ${deviceId}`,
  ));
  const pair = async () => {
    const token = randomBytes(32).toString('hex');
    const mint = await proof.app.inject({ method: 'POST', url: '/display/pairing', headers: headers(token), payload: {} });
    expect(mint.statusCode).toBe(200);
    const claim = await proof.app.inject({ method: 'POST', url: `/stations/${target.id}/displays/claim`,
      headers: { cookie: managerCookie }, payload: { pairingCode: mint.json().pairingCode, name: 'Auth proof display' } });
    expect(claim.statusCode).toBe(200);
    return { token, deviceId: claim.json().device.id as string };
  };
  const revoke = async (deviceId: string) => {
    const result = await proof.app.inject({ method: 'POST', url: `/credentials/${deviceId}/revoke`,
      headers: { cookie: managerCookie }, payload: { reason: 'Auth observation proof' } });
    expect(result.statusCode).toBe(200);
  };
  beforeAll(async () => {
    proof = await createTestContext();
    managerCookie = await signInAs(proof.app, ADMIN.phone, ADMIN.password);
    const [row] = await proof.db.select().from(station).where(eq(station.name, 'Reception Till 1')).limit(1);
    target = row!;
  });
  afterEach(async () => {
    await proof.db.update(deviceCredential).set({ revokedAt: new Date(), secretHash: null }).where(and(
      eq(deviceCredential.stationId, target.id), eq(deviceCredential.kind, 'display'),
      isNull(deviceCredential.revokedAt), isNotNull(deviceCredential.pairedAt),
    ));
  });
  afterAll(async () => { await proof.close(); });

  it('records actual protected 401s once under concurrent polling, never the expired pairing answer', async () => {
    const { token, deviceId } = await pair();
    expect((await proof.app.inject({ method: 'GET', url: '/display/session', headers: headers(token) })).statusCode).toBe(200);
    await revoke(deviceId);
    const status = await proof.app.inject({ method: 'GET', url: '/display/pairing', headers: headers(token) });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ status: 'expired' });
    expect((await rejectedEvents(deviceId)).length).toBe(0);
    const responses = await Promise.all([
      proof.app.inject({ method: 'GET', url: '/display/session', headers: headers(token) }),
      proof.app.inject({ method: 'GET', url: '/display/session', headers: headers(token) }),
      proof.app.inject({ method: 'POST', url: '/display/intents', headers: headers(token),
        payload: { type: 'display.set_language', lastSeenSequence: 0, actionId: 'private-action', payload: { language: 'th' } } }),
    ]);
    expect(responses.map(response => response.statusCode)).toEqual([401, 401, 401]);
    expect(responses.every(response => response.json().error.code === 'DISPLAY_UNPAIRED')).toBe(true);
    const events = await rejectedEvents(deviceId);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect({ stationId: event.stationId, boxId: event.boxId, kind: event.kind, source: event.source,
      outcome: event.outcome, errorCode: event.errorCode, payload: event.payload })
      .toEqual({ stationId: target.id, boxId: target.boxId, kind: 'error', source: 'display',
        outcome: 'refused', errorCode: 'DISPLAY_UNPAIRED', payload: { deviceId } });
    expect(['display.session', 'display.intents'].includes(event.intentType!)).toBe(true);
    expect([event.actorAccountId, event.actionId, event.leaseId, event.sequence, event.stage]).toEqual([null, null, null, null, null]);
    expect(event.occurredAt?.getTime()).toBe(event.receivedAt.getTime());
    expect(JSON.stringify(events).includes(token)).toBe(false);
    expect(JSON.stringify(events).includes('private-action')).toBe(false);
    // A later real rejection can refresh the observation after the minute window.
    await proof.db.update(stationEvent).set({ receivedAt: new Date(Date.now() - 61_000) }).where(eq(stationEvent.id, event.id));
    const later = await proof.app.inject({ method: 'POST', url: '/display/intents', headers: headers(token), payload: {} });
    expect(later.statusCode, 'authentication still precedes body validation').toBe(401);
    const refreshed = await rejectedEvents(deviceId);
    expect(refreshed).toHaveLength(2);
    expect(refreshed.filter(row => row.intentType === 'display.intents')).not.toHaveLength(0);
  });

  it('does not attribute unknown, malformed, unpaired or live wrong-scope refusals to a device', async () => {
    const before = await proof.db.select({ id: stationEvent.id }).from(stationEvent)
      .where(eq(stationEvent.errorCode, 'DISPLAY_UNPAIRED'));
    const { token, deviceId } = await pair();
    const unknown = randomBytes(32).toString('hex');
    const pending = randomBytes(32).toString('hex');
    expect((await proof.app.inject({ method: 'POST', url: '/display/pairing', headers: headers(pending), payload: {} })).statusCode).toBe(200);
    for (const requestHeaders of [headers(unknown), headers(pending), headers('not-a-bearer'), { cookie: managerCookie }]) {
      const response = await proof.app.inject({ method: 'GET', url: '/display/session', headers: requestHeaders });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('DISPLAY_UNPAIRED');
    }
    await proof.db.update(deviceCredential).set({ scopes: ['display:read'] }).where(eq(deviceCredential.id, deviceId));
    const scope = await proof.app.inject({ method: 'POST', url: '/display/intents', headers: headers(token), payload: {} });
    expect(scope.statusCode).toBe(401);
    expect((await rejectedEvents(deviceId)).length).toBe(0);
    const all = await proof.db.select({ id: stationEvent.id }).from(stationEvent)
      .where(eq(stationEvent.errorCode, 'DISPLAY_UNPAIRED'));
    expect(all, 'unattributed and live-scope refusals create no observation').toHaveLength(before.length);
  });

  it('does not write observation through a mismatched station operator or park binding', async () => {
    const { token, deviceId } = await pair();
    await revoke(deviceId);
    const [other] = await proof.db.select({ operatorId: station.operatorId, branchId: station.branchId })
      .from(station).where(ne(station.operatorId, target.operatorId)).limit(1);
    expect(Boolean(other)).toBe(true);
    await proof.db.update(deviceCredential).set({ operatorId: other!.operatorId, branchId: other!.branchId })
      .where(eq(deviceCredential.id, deviceId));
    const result = await proof.app.inject({ method: 'GET', url: '/display/session', headers: headers(token) });
    expect(result.statusCode).toBe(401);
    expect(result.json().error.code).toBe('DISPLAY_UNPAIRED');
    expect((await rejectedEvents(deviceId)).length).toBe(0);
  });
});
