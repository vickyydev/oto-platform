import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, paymentAttempt, product, role, roleAssignment, rolePermission, sale, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-739 adversarial review: the shared QR review exposes the existing
 * confirmation route to ordinary sales. Attack its permission, retained hold,
 * audit and exactly-once result through real routes and independent DB reads.
 * The missing UI door is pinned red/green in sale-writer.test.ts; no payment
 * service, terminal protocol or expiry rule changes in this unit.
 */
let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let captureOnlyCookie: string;
let stationId: string;
let accountId: string;
let packageId: string;
let friesId: string;
let socksId: string;

beforeAll(async () => {
  ctx = await createTestContext({ env: {
    PGW_PROVIDER: 'simulator', PGW_MERCHANT_ID: 'ZZTEST739',
    PGW_SECRET_KEY: randomBytes(32).toString('hex'),
    PGW_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
  } });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [home] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  const [counter] = await ctx.db.select().from(station)
    .where(and(eq(station.branchId, home!.id), eq(station.codePrefix, 'T1')));
  stationId = newId();
  await ctx.db.insert(station).values({ ...counter!, id: stationId,
    name: 'ZZ TEST SCRUM-739 review till', codePrefix: 'Z39',
    paymentRouting: { qr: 'gateway', card: 'manual' },
  });
  const selected = await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId } });
  expect(selected.statusCode, selected.body).toBe(200);
  const [pkg] = await ctx.db.select().from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, home!.id), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;
  const menu = await ctx.db.select().from(product).where(eq(product.operatorId, home!.operatorId));
  friesId = menu.find(p => p.code === 'FB-FRIES')!.id;
  socksId = menu.find(p => p.code === 'MR-SOCKS')!.id;

  // A real account with the reception permissions except this one. Reusing
  // the local seeded hash does not publish or persist a new credential.
  const [staff] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  accountId = staff!.id;
  const grants = await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, accountId));
  const permissions = await ctx.db.select().from(rolePermission)
    .where(inArray(rolePermission.roleId, grants.map(g => g.roleId)));
  expect(permissions.some(p => p.permission === 'pos:payment:confirm')).toBe(true);
  const roleId = newId(), limitedId = newId();
  await ctx.db.insert(role).values({ id: roleId, operatorId: home!.operatorId, name: 'ZZ TEST SCRUM-739 capture only' });
  await ctx.db.insert(rolePermission).values([...new Set(permissions.map(p => p.permission))]
    .filter(permission => permission !== 'pos:payment:confirm')
    .map(permission => ({ id: newId(), roleId, permission })));
  const phone = '+66973900001';
  await ctx.db.insert(account).values({ id: limitedId, operatorId: home!.operatorId,
    phone, passwordHash: staff!.passwordHash, status: 'active' });
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: limitedId,
    roleId, scopeType: 'branch', scopeId: home!.id });
  captureOnlyCookie = await signInAs(ctx.app, phone, RECEPTION.password);
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, session = cookie, action = newId()) =>
  ctx.app.inject({ method, url, headers: { cookie: session, 'idempotency-key': action, 'x-oto-action-id': action },
    ...(payload === undefined ? {} : { payload }) });

async function waiting(kind: 'tickets' | 'fnb' | 'shop' = 'tickets') {
  const saleId = newId();
  const cart = kind === 'tickets'
    ? { lines: [{ id: newId(), packageId, kids: 1, adults: 1 }] }
    : { items: [{ id: newId(), productId: kind === 'fnb' ? friesId : socksId, quantity: 1,
      ...(kind === 'shop' ? { variant: { variantId: 'm', variantLabel: 'M' } } : {}) }] };
  const committed = await request('POST', '/sales', { id: saleId, stationId, note: 'ZZ TEST SCRUM-739 review',
    ...(kind === 'fnb' ? { pickupCode: '739' } : {}), ...cart });
  expect(committed.statusCode, committed.body).toBe(200);
  const started = await request('POST', '/payments/attempts', { saleId, tender: 'qr', method: 'promptpay',
    kind: 'qr', requestQrPayload: true, qrDirection: 'show', actionId: newId() });
  expect(started.statusCode, started.body).toBe(200);
  expect(started.json().route).toBe('gateway');
  const attemptId = started.json().attempt.id as string;
  const late = await request('POST', '/webhooks/2c2p/simulator', { attemptId, event: 'late_paid' }, adminCookie);
  expect(late.statusCode, late.body).toBe(200);
  expect(late.json().webhookOutcome).toBe('late_paid');
  const [held] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  expect(held!.status).toBe('tendering');
  expect(held!.receiptNumber).toBeNull();
  const [attempt] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attemptId));
  expect(attempt!.status).toBe('awaiting_staff_confirmation');
  return { saleId, attemptId, amount: held!.grossSatang };
}

describe('SCRUM-739 gateway QR review boundary', () => {
  it.each(['tickets', 'fnb', 'shop'] as const)('HIGH pin: %s keeps the late-payment hold and closes once after one audited answer', async kind => {
    const { saleId, attemptId, amount } = await waiting(kind);
    const cancelled = await request('POST', `/payments/attempts/${attemptId}/cancel`, {});
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json().error.code).toBe('ATTEMPT_NEEDS_A_PERSON');
    const voided = await request('POST', `/sales/${saleId}/void`, { reason: 'ZZ TEST review must stay held' });
    expect(voided.statusCode).toBe(409);
    expect(voided.json().error.code).toBe('PAYMENT_IN_FLIGHT');

    const action = newId(), note = 'ZZ TEST checked bank slip and gateway report';
    const answer = await request('POST', `/payments/attempts/${attemptId}/confirm`, { took: true, note }, cookie, action);
    expect(answer.statusCode, answer.body).toBe(200);
    const replay = await request('POST', `/payments/attempts/${attemptId}/confirm`, { took: true, note }, cookie, action);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(answer.json());
    const closeAction = newId();
    for (let i = 0; i < 2; i++) {
      const closed = await request('POST', `/sales/${saleId}/finalise`,
        { actionId: closeAction, method: 'none', kind: 'other', amountSatang: 0 }, cookie, closeAction);
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json().sale.status).toBe('finalised');
    }
    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ id: attemptId, status: 'approved', amountSatang: amount, staffConfirmedByAccountId: accountId });
    const [closed] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(closed!.status).toBe('finalised');
    expect(closed!.receiptNumber).toBeTruthy();
    const audit = await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.entityId, attemptId), eq(auditLog.action, 'payment.attempt.confirm')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorAccountId).toBe(accountId);
    expect(audit[0]!.after).toMatchObject({ took: true, note, saleId, amountSatang: amount });
  });

  it('HIGH pin: capture permission cannot answer a held QR without pos:payment:confirm', async () => {
    const { saleId, attemptId } = await waiting();
    const route = ctx.app.routeRegistry.find(r => r.method === 'POST' && r.url === '/payments/attempts/:id/confirm');
    expect(route!.config.permission).toBe('pos:payment:confirm');
    const refused = await request('POST', `/payments/attempts/${attemptId}/confirm`,
      { took: true, note: 'ZZ TEST capture-only account' }, captureOnlyCookie);
    expect(refused.statusCode, refused.body).toBe(403);
    const [attempt] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attemptId));
    expect(attempt!.status).toBe('awaiting_staff_confirmation');
    expect(attempt!.staffConfirmedByAccountId).toBeNull();
    const [held] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(held!.receiptNumber).toBeNull();
    expect(await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.entityId, attemptId), eq(auditLog.action, 'payment.attempt.confirm')))).toHaveLength(0);
  });

  it('HIGH pin: No money records the answer but neither a payment nor a completed sale', async () => {
    const { saleId, attemptId, amount } = await waiting('fnb');
    const note = 'ZZ TEST no money in the bank slip or gateway report';
    const answer = await request('POST', `/payments/attempts/${attemptId}/confirm`, { took: false, note });
    expect(answer.statusCode, answer.body).toBe(200);
    const [attempt] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attemptId));
    expect(attempt).toMatchObject({ status: 'declined', paidAt: null, staffConfirmedByAccountId: accountId });
    const read = await request('GET', `/payments/attempts/${attemptId}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().outstandingSatang).toBe(amount);
    const [open] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(open!.receiptNumber).toBeNull();
    expect(open!.finalisedAt).toBeNull();
  });
});
