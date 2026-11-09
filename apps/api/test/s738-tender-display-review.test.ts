import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paymentAttempt, sale, station, stationSession } from '@oto/db';
import { newId, projectDisplayDiagnosticDocument } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, type TestContext } from './helpers';

describe('SCRUM-738 separate tender display adversarial review', () => {
  let ctx: TestContext;
  let cookie: string;
  let authorization: string;
  let stationId: string;
  let leaseId: string;
  const payment = { saleId: null, amountSatang: 12000, qrPayload: 'ZZ TEST gateway payload', qrImageUrl: null,
    expiresAt: '2026-11-04T23:00:00.000Z', status: 'pending', offline: false, online: true };
  const frame = (subject = 'event_pass') => ({ stage: 'payment', step: null,
    cart: { kind: 'tender', supported: true, subject, method: 'qr' }, payment, member: null, totals: null, prompt: null });
  const read = () => ctx.app.inject({ method: 'GET', url: `/box/v1/station/${stationId}/display/session`, headers: { authorization } });
  const publish = async (payload: Record<string, unknown>) => {
    const current = await ctx.app.inject({ method: 'GET', url: `/stations/${stationId}/session`, headers: { cookie } });
    expect(current.statusCode).toBe(200);
    return ctx.app.inject({ method: 'POST', url: `/stations/${stationId}/intents`, headers: { cookie }, payload: {
      type: 'session.publish_display', leaseId, lastSeenSequence: current.json().document.sequence, actionId: newId(), payload,
    } });
  };
  beforeAll(async () => {
    ctx = await createTestContext();
    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    stationId = (await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1')))[0]!.id;
    expect((await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId } })).statusCode).toBe(200);
    authorization = `Bearer ${randomBytes(32).toString('hex')}`;
    const requested = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization }, payload: {} });
    expect((await ctx.app.inject({ method: 'POST', url: `/stations/${stationId}/displays/claim`, headers: { cookie: admin },
      payload: { pairingCode: requested.json().pairingCode, name: 'ZZ TEST tender display' } })).statusCode).toBe(200);
    const claim = await ctx.app.inject({ method: 'POST', url: `/stations/${stationId}/lease`, headers: { cookie }, payload: { holder: 'ZZ TEST tender', holderKind: 'till' } });
    expect(claim.statusCode).toBe(200);
    leaseId = claim.json().lease.leaseId;
  });
  afterAll(async () => { await ctx?.close(); });

  it('HIGH: pass and party QR use a finite public tender frame without creating money records', async () => {
    const counts = async () => ({ sales: (await ctx.db.select({ count: sql<number>`count(*)::int` }).from(sale))[0]!.count,
      payments: (await ctx.db.select({ count: sql<number>`count(*)::int` }).from(paymentAttempt))[0]!.count });
    const before = await counts();
    for (const subject of ['event_pass', 'party_balance', 'extra_hour']) {
      const shown = frame(subject);
      const sent = await publish({ ...shown, cart: { ...shown.cart, family: { name: 'PRIVATE' } }, payment: { ...payment, providerCredential: 'PRIVATE' } });
      expect(sent.statusCode).toBe(200);
      const seen = (await read()).json().document;
      expect(seen.cart).toEqual(shown.cart);
      expect(seen.payment).toEqual(payment);
      expect(seen.lease).toBeNull();
      expect(seen.member).toBeNull(); expect(seen.prompt).toBeNull(); expect(seen.totals).toBeNull();
      expect(JSON.stringify(seen)).not.toContain('PRIVATE');
      const diagnostic = projectDisplayDiagnosticDocument(seen);
      expect(diagnostic?.cart).toEqual(shown.cart);
      expect(diagnostic?.payment?.hasQrPayload).toBe(true);
      expect(JSON.stringify(diagnostic)).not.toContain(payment.qrPayload);
    }
    expect(await counts()).toEqual(before);
  });

  it('HIGH: malformed tender frames and old private prompts cannot replace a valid screen', async () => {
    const before = (await read()).json().document;
    for (const changes of [
      { stage: 'input' }, { payment: null }, { payment: { ...payment, amountSatang: -1 } },
      { payment: { ...payment, qrImageUrl: 'javascript:private' } },
      { cart: { ...frame().cart, subject: 'member_account' } }, { cart: { ...frame().cart, method: 'cash' } },
      { cart: { ...frame().cart, supported: false } },
      { member: { id: newId(), nickname: 'PRIVATE', tier: 'tourist' } },
      { prompt: { kind: 'identify', requestId: newId() } },
      { totals: { manualAmounts: {}, discountAmount: 0, total: 120, taxBreakdown: { serviceChargeTotal: 0, categories: [] } } },
    ]) {
      const rejected = await publish({ ...frame(), ...changes });
      // The existing prompt/stage guard rejects an identify prompt before the cart guard runs.
      expect(rejected.statusCode).toBe('prompt' in changes ? 409 : 403);
      expect(rejected.json().error.code).toBe('prompt' in changes ? 'STATION_WRONG_STAGE' : 'STATION_NOT_PERMITTED');
    }
    expect((await read()).json().document.sequence).toBe(before.sequence);
  });

  it('HIGH: the same lease restores the till and sign-out releases it during a tender', async () => {
    expect((await publish(frame())).statusCode).toBe(200);
    const restored = await publish({ stage: 'identify', cart: { supported: true, sale: { tier: 'tourist' } }, payment: null, totals: null, member: null,
      prompt: { kind: 'identify', requestId: newId(), phone: '', nickname: '', contactChannel: 'whatsapp' } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().document.lease.leaseId).toBe(leaseId);
    expect((await read()).json().document.payment).toBeNull();
    expect((await publish(frame('party_balance'))).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie }, payload: { stationLeaseId: leaseId } })).statusCode).toBe(200);
    expect((await ctx.db.select().from(stationSession).where(eq(stationSession.stationId, stationId)))[0]!.leaseId).toBeNull();
  });
});
