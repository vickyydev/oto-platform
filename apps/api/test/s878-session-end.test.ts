import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { session, station } from '@oto/db';
import { sessionEndOf } from '../src/services/account-sessions';
import { RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-878 — A STAFF SESSION THAT ENDS DURING A LONG SHIFT.
 *
 * A staff session ends twelve hours after sign-in, and its cookie is given the
 * same life, so at that moment the browser stops sending it and the platform
 * can no longer tell "ran out" from "never signed in". `GET /me` therefore says
 * in advance when the session ends; the till keeps the moment and, when it is
 * refused at or after it, says the session ended after its hours and keeps the
 * sale on screen for the next sign-in on that till.
 *
 * The session's end is reached here the way the other session tests reach it:
 * the row's end is moved, never real time waited out. How long a session lasts
 * is not changed (the owner's decision).
 */
let ctx: TestContext;
let tillId: string;
beforeAll(async () => {
  ctx = await createTestContext();
  const [till] = await ctx.db.select().from(station).where(eq(station.name, 'Reception Till 1')).limit(1);
  tillId = till!.id;
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const me = (cookie: string) => ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });

async function sessionIdOf(cookie: string): Promise<string> {
  const res = await me(cookie);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().operatorContext.sessionId as string;
}

describe('SCRUM-878 — /me says when this session ends', () => {
  it('answers the end, the seconds left on the platform clock and the session’s whole life in hours', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    const end = res.json().sessionEnd as { at: string; inSeconds: number; afterHours: number };
    const [row] = await ctx.db.select().from(session).where(eq(session.id, res.json().operatorContext.sessionId)).limit(1);
    expect(end.at).toBe(row!.expiresAt.toISOString());
    expect(end.afterHours).toBe(12);
    expect(end.inSeconds).toBeLessThanOrEqual(12 * 3600);
    expect(end.inSeconds).toBeGreaterThan(12 * 3600 - 120);
  });

  it('counts down on the clock it is given and never below zero', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const id = await sessionIdOf(cookie);
    const [row] = await ctx.db.select().from(session).where(eq(session.id, id)).limit(1);
    const ends = row!.expiresAt.getTime();
    expect((await sessionEndOf(ctx.db, id, new Date(ends - 30_000)))?.inSeconds).toBe(30);
    expect((await sessionEndOf(ctx.db, id, new Date(ends + 5_000)))?.inSeconds).toBe(0);
    expect((await sessionEndOf(ctx.db, id, new Date(ends + 5_000)))?.afterHours).toBe(12);
    expect(await sessionEndOf(ctx.db, '00000000-0000-7000-8000-000000000000')).toBeNull();
  });

  it('leaves how long a session lasts as it was: the cookie still lives twelve hours', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: RECEPTION.phone, password: RECEPTION.password },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/Max-Age=43200/);
  });
});

describe('SCRUM-878 — a session past its end, as the till meets it', () => {
  it('locked at the twelve-hour mark: the heartbeat, /me and the unlock with the RIGHT password are all the plain refusal', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const id = await sessionIdOf(cookie);
    await takeStation(ctx.app, cookie, tillId);
    const heartbeat = () =>
      ctx.app.inject({ method: 'POST', url: '/me/station/heartbeat', headers: { cookie }, payload: {} });
    expect((await heartbeat()).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/lock', headers: { cookie } })).statusCode).toBe(200);
    // The heartbeat goes on through the lock, as the till sends it every minute.
    expect((await heartbeat()).statusCode).toBe(200);

    // The twelve-hour mark, reached by moving the row's end (never real time).
    await ctx.db.update(session).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(session.id, id));

    const beat = await heartbeat();
    expect(beat.statusCode).toBe(401);
    expect(beat.json().error.code).toBe('UNAUTHORIZED');
    const who = await me(cookie);
    expect(who.statusCode).toBe(401);
    expect(who.json().error.code).toBe('UNAUTHORIZED');
    // The variant of the defect: the right password typed at the lock screen.
    // It is the "no session" refusal, never INVALID_CREDENTIALS — the till
    // tells the two apart and turns this one into "the session has ended".
    const unlock = await ctx.app.inject({
      method: 'POST',
      url: '/auth/unlock',
      headers: { cookie },
      payload: { password: RECEPTION.password },
    });
    expect(unlock.statusCode).toBe(401);
    expect(unlock.json().error.code).toBe('UNAUTHORIZED');
    expect(unlock.json().error.message).toBe('Not signed in');
  });

  it('a wrong password at a live lock stays INVALID_CREDENTIALS, so the two are never confused', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/lock', headers: { cookie } })).statusCode).toBe(200);
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/auth/unlock',
      headers: { cookie },
      payload: { password: 'ZZ TEST not the password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    const right = await ctx.app.inject({
      method: 'POST',
      url: '/auth/unlock',
      headers: { cookie },
      payload: { password: RECEPTION.password },
    });
    expect(right.statusCode).toBe(200);
  });

  it('the next sign-in after the end is a new session with a full twelve hours of its own', async () => {
    const first = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const firstId = await sessionIdOf(first);
    await ctx.db.update(session).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(session.id, firstId));
    expect((await me(first)).statusCode).toBe(401);
    const second = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const res = await me(second);
    expect(res.statusCode).toBe(200);
    expect(res.json().operatorContext.sessionId).not.toBe(firstId);
    expect(res.json().sessionEnd.inSeconds).toBeGreaterThan(12 * 3600 - 120);
  });
});
