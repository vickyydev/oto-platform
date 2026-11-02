import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceCredential, station } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, type TestContext } from './helpers';

describe('SCRUM-710 display channel adversarial review', () => {
  let ctx: TestContext;
  let cookie: string;
  let managerCookie: string;
  let target: string;
  let origin: string;
  let authorization: string;
  let deviceId: string;
  let leaseId: string;
  let sequence: number;
  const url = () => `${origin}/box/v1/station/${target}/display/channel`;
  beforeAll(async () => {
    ctx = await createTestContext();
    managerCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    target = (await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1')))[0]!.id;
    expect((await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId: target } })).statusCode).toBe(200);
    authorization = `Bearer ${randomBytes(32).toString('hex')}`;
    const mint = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization }, payload: {} });
    const paired = await ctx.app.inject({ method: 'POST', url: `/stations/${target}/displays/claim`, headers: { cookie: managerCookie }, payload: { pairingCode: mint.json().pairingCode, name: 'ZZ TEST display channel' } });
    expect(paired.statusCode).toBe(200);
    deviceId = paired.json().device.id;
    const lease = await ctx.app.inject({ method: 'POST', url: `/stations/${target}/lease`, headers: { cookie }, payload: { holder: 'ZZ TEST display channel', holderKind: 'till' } });
    expect(lease.statusCode).toBe(200);
    leaseId = lease.json().lease.leaseId;
    sequence = lease.json().document.sequence;
    origin = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => { await ctx.close(); });

  it('HIGH: unpaired and staff credentials cannot open the display channel; require the paired credential', async () => {
    for (const headers of [{}, { cookie }, { authorization: `Bearer ${'a'.repeat(64)}` }] as Record<string, string>[]) {
      expect((await fetch(url(), { headers })).status).toBe(401);
    }
    expect((await fetch(`${origin}/box/v1/station/${newId()}/display/channel`, { headers: { authorization } })).status).toBe(403);
  });

  it('HIGH: connect and each publish expose exactly display/session, never private fields or the staff lease', async () => {
    const controller = new AbortController();
    const response = await fetch(url(), { headers: { authorization }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let buffer = '';
    const next = async () => {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before snapshot');
        buffer += new TextDecoder().decode(chunk.value);
      }
    };
    try {
      const first = await next();
      const read = await ctx.app.inject({ method: 'GET', url: `/box/v1/station/${target}/display/session`, headers: { authorization } });
      expect(first.document).toEqual(read.json().document);
      const published = await ctx.app.inject({ method: 'POST', url: `/stations/${target}/intents`, headers: { cookie }, payload: {
        type: 'session.publish_display', leaseId, lastSeenSequence: sequence, actionId: newId(),
        payload: { stage: 'identify', step: 1, cart: null, totals: null, payment: null,
          member: { id: newId(), nickname: 'ZZ TEST', tier: 'tourist', notes: 'PRIVATE', allergies: ['PRIVATE'] },
          prompt: { kind: 'identify', requestId: newId(), phone: '', nickname: '', contactChannel: 'whatsapp' } },
      } });
      expect(published.statusCode).toBe(200);
      sequence = published.json().document.sequence;
      const changed = await next();
      const latest = await ctx.app.inject({ method: 'GET', url: `/box/v1/station/${target}/display/session`, headers: { authorization } });
      expect(changed.kind).toBe('snapshot');
      expect(changed.document).toEqual(latest.json().document);
      expect(changed.document.sequence).toBe(sequence);
      expect(changed.document.lease).toBeNull();
      expect(changed.document.step).toBeNull();
      expect(JSON.stringify(changed)).not.toContain('PRIVATE');
      expect(changed.actionId).toBeNull();
      // HIGH: quiet revocation must end an already-open stream, not just refuse reconnect.
      await ctx.db.update(deviceCredential).set({ revokedAt: new Date() }).where(eq(deviceCredential.id, deviceId));
      let ended = false;
      const deadline = setTimeout(() => controller.abort(), 7_000);
      try { while (!ended) ended = (await reader.read()).done; } finally { clearTimeout(deadline); }
      expect(ended).toBe(true);
      expect((await fetch(url(), { headers: { authorization } })).status).toBe(401);
    } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
  });
});
