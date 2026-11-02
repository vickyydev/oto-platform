import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceCredential, displayResponseSnapshot, station } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, type TestContext } from './helpers';

/**
 * SCRUM-720 — the Console's record of what a display was last answered: a poll
 * that finds nothing new writes nothing, and a display on the stream keeps the
 * record current without a poll to correct it.
 */
describe('SCRUM-720 the last-answered record', () => {
  let ctx: TestContext;
  let cookie: string;
  let managerCookie: string;
  let target: string;
  let origin: string;
  let authorization: string;
  let deviceId: string;
  let leaseId: string;
  let sequence: number;

  beforeAll(async () => {
    ctx = await createTestContext();
    managerCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    target = (await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1')))[0]!.id;
    expect((await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId: target } })).statusCode).toBe(200);
    authorization = `Bearer ${randomBytes(32).toString('hex')}`;
    const mint = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization }, payload: {} });
    const paired = await ctx.app.inject({ method: 'POST', url: `/stations/${target}/displays/claim`, headers: { cookie: managerCookie }, payload: { pairingCode: mint.json().pairingCode, name: 'ZZ TEST record' } });
    expect(paired.statusCode).toBe(200);
    deviceId = paired.json().device.id;
    const lease = await ctx.app.inject({ method: 'POST', url: `/stations/${target}/lease`, headers: { cookie }, payload: { holder: 'ZZ TEST record', holderKind: 'till' } });
    expect(lease.statusCode).toBe(200);
    leaseId = lease.json().lease.leaseId;
    sequence = lease.json().document.sequence;
    origin = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => { await ctx.close(); });

  const poll = async () => {
    const reply = await ctx.app.inject({ method: 'GET', url: `/box/v1/station/${target}/display/session`, headers: { authorization } });
    expect(reply.statusCode).toBe(200);
    return reply.json().document as { sequence: number };
  };
  const publish = async (stage: string) => {
    const reply = await ctx.app.inject({ method: 'POST', url: `/stations/${target}/intents`, headers: { cookie }, payload: {
      type: 'session.publish_display', leaseId, lastSeenSequence: sequence, actionId: newId(),
      payload: { stage, step: 1, cart: null, totals: null, payment: null, member: null, prompt: null },
    } });
    expect(reply.statusCode).toBe(200);
    sequence = reply.json().document.sequence;
    return sequence;
  };
  /** `xmin` moves with every row version, so it counts writes a timestamp could hide. */
  const version = async () => {
    const { rows } = await ctx.db.execute(sql`select xmin::text as version from ${displayResponseSnapshot} where credential_id = ${deviceId}`);
    return (rows[0] as { version: string } | undefined)?.version;
  };
  const recorded = async () => (await ctx.db.select().from(displayResponseSnapshot).where(eq(displayResponseSnapshot.credentialId, deviceId)))[0];
  const recordedSequence = async () => (await recorded())?.document.sequence;
  const until = async (check: () => Promise<boolean>, within: number) => {
    const deadline = Date.now() + within;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
  };

  it('writes nothing for a poll that finds nothing new', async () => {
    await poll();
    const first = await version();
    const firstRow = await recorded();
    expect(first).toBeDefined();
    for (let count = 0; count < 3; count += 1) await poll();
    expect(await version()).toBe(first);
    expect((await recorded())!.preparedAt).toEqual(firstRow!.preparedAt);
  });

  it('writes once when the sequence moves, and then not again', async () => {
    await poll();
    const before = await version();
    const moved = await publish('welcome');
    expect((await poll()).sequence).toBe(moved);
    const after = await version();
    expect(after).not.toBe(before);
    expect(await recordedSequence()).toBe(moved);
    await poll();
    expect(await version()).toBe(after);
  });

  it('does not treat a lease renewal as news, though it moves the document clock', async () => {
    await poll();
    const before = await version();
    const renew = await ctx.app.inject({ method: 'POST', url: `/stations/${target}/lease/renew`, headers: { cookie }, payload: { leaseId } });
    expect(renew.statusCode).toBe(200);
    await poll();
    expect(await version()).toBe(before);
  });

  it('records a poll again after an intent answer took the record, even at the same sequence', async () => {
    const refused = await ctx.app.inject({ method: 'POST', url: `/box/v1/station/${target}/display/intents`, headers: { authorization },
      payload: { type: 'session.reset', payload: {}, lastSeenSequence: sequence, actionId: newId() } });
    expect(refused.statusCode).toBe(403);
    expect(await recorded()).toMatchObject({ responseKind: 'intent', statusCode: 403 });
    await poll();
    expect(await recorded()).toMatchObject({ responseKind: 'session', statusCode: 200 });
  });

  it('leaves the display touch as it was: every poll still says the display is calling', async () => {
    const seen = async () => (await ctx.db.select({ at: deviceCredential.lastSeenAt }).from(deviceCredential).where(eq(deviceCredential.id, deviceId)))[0]!.at!.getTime();
    await poll();
    const first = await seen();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await poll();
    expect(await seen()).toBeGreaterThan(first);
  });

  const openStream = async () => {
    const controller = new AbortController();
    const response = await fetch(`${origin}/box/v1/station/${target}/display/channel`, { headers: { authorization }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let buffer = '';
    const decoder = new TextDecoder();
    const next = async () => {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6)) as { document: { sequence: number } };
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before a snapshot');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    return { controller, reader, next };
  };

  it('follows what the stream delivered, with no poll to correct it', async () => {
    const stream = await openStream();
    try {
      await stream.next();
      const moved = await publish('order');
      expect((await stream.next()).document.sequence).toBe(moved);
      expect(await until(async () => (await recordedSequence()) === moved, 6_500)).toBe(true);
    } finally { stream.controller.abort(); await stream.reader.cancel().catch(() => undefined); }
  }, 15_000);

  it('writes what was still unwritten when the stream ends', async () => {
    const stream = await openStream();
    await stream.next();
    const first = await publish('welcome');
    expect((await stream.next()).document.sequence).toBe(first);
    const second = await publish('order');
    expect((await stream.next()).document.sequence).toBe(second);
    stream.controller.abort();
    await stream.reader.cancel().catch(() => undefined);
    expect(await until(async () => (await recordedSequence()) === second, 2_000)).toBe(true);
  }, 15_000);

  it('never records for a display revoked while its stream was open', async () => {
    const stream = await openStream();
    await stream.next();
    const moved = await publish('welcome');
    expect((await stream.next()).document.sequence).toBe(moved);
    await ctx.db.update(deviceCredential).set({ revokedAt: new Date() }).where(eq(deviceCredential.id, deviceId));
    const before = await recorded();
    await publish('order');
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect((await recorded())?.document.sequence).toBe(before?.document.sequence);
    stream.controller.abort();
    await stream.reader.cancel().catch(() => undefined);
  }, 15_000);
});
