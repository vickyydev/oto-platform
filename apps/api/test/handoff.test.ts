import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditLog, handoffToken, idempotencyKey, session as sessionTable } from '@oto/db';
import { newId } from '@oto/shared';
import {
  handoffConfig,
  parseAppOrigins,
  parseHandoffKeys,
  purgeExpiredHandoffTokens,
  signHandoffToken,
  verifyToken,
  HANDOFF_ISSUER,
  type HandoffClaims,
} from '../src/services/handoff';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-02 — the signed hand-off.
 *
 * One platform session opens several apps on several origins. A cookie cannot
 * cross them, so the launcher mints a short-lived signed token aimed at ONE
 * app, the browser carries it there in the fragment, and the app posts it back
 * for a cookie of its own bound to the same session row.
 *
 * Everything below is an attack on that: a second go with the same token, a
 * dead one, one aimed elsewhere, one signed by somebody else, one minted by an
 * account with no business in the app it asks for, and one whose session ended
 * while the browser was in flight.
 */

const KID = 'k1';
const SECRET = 'handoff-test-secret-0123456789abcdef';
const POS_ORIGIN = 'https://pos.test';
const CONSOLE_ORIGIN = 'https://console.test';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      HANDOFF_SIGNING_KEY: `${KID}:${SECRET}`,
      HANDOFF_APP_ORIGINS: `pos=${POS_ORIGIN},console=${CONSOLE_ORIGIN}`,
      // Each app origin must also be allowed to write at all, or the origin
      // check in app.ts refuses the exchange before it reaches the route.
      ALLOWED_ORIGINS: `${POS_ORIGIN},${CONSOLE_ORIGIN}`,
    },
  });
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

interface IssuedBody {
  token: string;
  audience: string;
  origin: string;
  launchUrl: string;
  expiresAt: string;
}

async function mint(cookie: string, app = 'pos'): Promise<IssuedBody> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/auth/handoff',
    headers: { cookie },
    payload: { app },
  });
  if (res.statusCode !== 200) throw new Error(`handoff failed (${res.statusCode}): ${res.body}`);
  return res.json() as IssuedBody;
}

const exchange = (token: string, origin = POS_ORIGIN) =>
  ctx.app.inject({
    method: 'POST',
    url: '/auth/handoff/exchange',
    headers: { origin },
    payload: { token },
  });

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const set = res.headers['set-cookie'];
  const header = Array.isArray(set) ? set[0] : (set as string | undefined);
  if (!header) throw new Error('no session cookie was set');
  return header.split(';')[0]!;
};

const rejectionReason = (res: { json: () => { error: { code: string; details?: { reason?: string } } } }) =>
  res.json().error.details?.reason;

describe('the round trip (S2-02)', () => {
  it('issues a token for one origin and exchanges it for that origin\'s cookie', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);

    expect(issued.audience).toBe('pos');
    expect(issued.origin).toBe(POS_ORIGIN);
    // The fragment is the reason a URL may carry this at all: it is never
    // sent to a server, so the token reaches no log, proxy or Referer.
    expect(issued.launchUrl).toBe(`${POS_ORIGIN}/#handoff=${issued.token}`);
    expect(new Date(issued.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);

    const res = await exchange(issued.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ audience: 'pos', mustChangePassword: false, sessionLocked: false });

    // The cookie it set is a working session for the same account.
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: cookieOf(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().account.phone).toBe(ADMIN.phone);
  });

  it('binds the app to the SAME session, so one sign-out ends them all', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const before = await liveSessions();

    const app = cookieOf(await exchange((await mint(launcher)).token));
    // No second session was created: the exchange bound a cookie to the one
    // that already existed.
    expect(await liveSessions()).toBe(before);

    // Sign out on the app; the launcher's own cookie dies with it.
    const out = await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie: app } });
    expect(out.statusCode).toBe(200);
    const stale = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: launcher } });
    expect(stale.statusCode).toBe(401);
  });
});

async function liveSessions(): Promise<number> {
  const rows = await ctx.db.select().from(sessionTable).where(sql`${sessionTable.revokedAt} is null`);
  return rows.length;
}

describe('a hand-off is good exactly once (S2-02)', () => {
  it('refuses a replay of a token that has already been spent', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);

    expect((await exchange(issued.token)).statusCode).toBe(200);

    const replay = await exchange(issued.token);
    expect(replay.statusCode).toBe(401);
    expect(rejectionReason(replay)).toBe('replayed');
    // What the account page's "recent rejections" reads. The account it
    // claimed to be is in the payload, not in the actor column: an id read
    // off a credential we have just refused is not an authenticated actor.
    const recorded = await lastRejection();
    expect(recorded.after).toMatchObject({ reason: 'replayed', audience: 'pos' });
    expect(recorded.actorAccountId).toBeNull();
  });

  it('serves only one of two exchanges racing the same fragment', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);

    const [a, b] = await Promise.all([exchange(issued.token), exchange(issued.token)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 401]);
    expect(rejectionReason(a.statusCode === 401 ? a : b)).toBe('replayed');
  });
});

describe('a hand-off stops being good (S2-02)', () => {
  it('refuses a token whose own expiry has passed', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);
    const jti = (await rowFor(issued.token)).jti;

    // Same key, same claims, an expiry a minute in the past: what a token
    // left in someone's history looks like by the time it is found.
    const stale = signHandoffToken(
      { kid: KID, secret: SECRET },
      { ...claimsOf(issued.token), exp: Math.floor(Date.now() / 1000) - 60 },
    );
    const res = await exchange(stale);
    expect(res.statusCode).toBe(401);
    expect(rejectionReason(res)).toBe('expired');

    // And it was refused before the claim: the row is untouched, so the real
    // token is still usable.
    const [row] = await ctx.db.select().from(handoffToken).where(eq(handoffToken.jti, jti));
    expect(row!.consumedAt).toBeNull();
  });

  it('refuses a token the database has already aged out, whatever the token says', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);
    await ctx.db
      .update(handoffToken)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(handoffToken.jti, (await rowFor(issued.token)).jti));

    const res = await exchange(issued.token);
    expect(res.statusCode).toBe(401);
    expect(rejectionReason(res)).toBe('expired');
  });

  it('refuses a token whose session was revoked while the browser was in flight', async () => {
    const launcher = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const issued = await mint(launcher);
    await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie: launcher } });

    const res = await exchange(issued.token);
    expect(res.statusCode).toBe(401);
    expect(rejectionReason(res)).toBe('revoked');
    // A hand-off never resurrects a dead session — and it set no cookie.
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('a hand-off belongs to one app (S2-02)', () => {
  it('refuses a token minted for the till when it is presented at the console', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher, 'pos');

    const res = await exchange(issued.token, CONSOLE_ORIGIN);
    expect(res.statusCode).toBe(401);
    expect(rejectionReason(res)).toBe('origin');
    expect(res.headers['set-cookie']).toBeUndefined();

    // Spent even though it was refused: a token that reached the wrong origin
    // must not be worth carrying back to the right one, and the session it
    // was carrying is unopenable from here on.
    const [row] = await ctx.db
      .select()
      .from(handoffToken)
      .where(eq(handoffToken.jti, (await rowFor(issued.token)).jti));
    expect(row!.consumedAt).not.toBeNull();
    expect(row!.sessionSecret).toBeNull();

    const replay = await exchange(issued.token, POS_ORIGIN);
    expect(rejectionReason(replay)).toBe('replayed');
  });

  it('refuses an exchange that names no origin at all', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/handoff/exchange',
      payload: { token: issued.token },
    });
    expect(res.statusCode).toBe(401);
    expect(rejectionReason(res)).toBe('origin');
  });
});

describe('a hand-off must have been minted by us (S2-02)', () => {
  it('refuses a tampered signature', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);
    const [header, payload, signature] = issued.token.split('.') as [string, string, string];
    // Flip a character in the MIDDLE, not at the end. A 32-byte HMAC encodes
    // to 43 base64url characters, and the last one carries only four
    // meaningful bits — two neighbouring values there decode to the very same
    // bytes, so a token "tampered" at the tail verifies perfectly and the
    // test fails at random depending on the signature it happened to get.
    const at = Math.floor(signature.length / 2);
    const flipped = `${signature.slice(0, at)}${signature[at] === 'A' ? 'B' : 'A'}${signature.slice(at + 1)}`;
    // Prove the mutation actually changed the signature before asserting on it.
    expect(Buffer.from(flipped, 'base64url').equals(Buffer.from(signature, 'base64url'))).toBe(
      false,
    );

    const res = await exchange(`${header}.${payload}.${flipped}`);
    expect(res.statusCode).toBe(401);
    expect(rejectionReason(res)).toBe('signature');
  });

  it('refuses a token signed with a key we do not hold', async () => {
    const forged = signHandoffToken(
      { kid: 'evil', secret: 'an-attackers-own-secret-0123456789' },
      {
        jti: newId(),
        sid: newId(),
        sub: newId(),
        aud: 'pos',
        iss: HANDOFF_ISSUER,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
      },
    );
    const res = await exchange(forged);
    expect(res.statusCode).toBe(401);
    expect(rejectionReason(res)).toBe('signature');
  });

  it('refuses an unsigned token however the header asks to be trusted', () => {
    const keys = parseHandoffKeys(`${KID}:${SECRET}`);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'oto-handoff+jws', kid: KID })).toString(
      'base64url',
    );
    const payload = Buffer.from(JSON.stringify({ jti: newId(), aud: 'pos', iss: HANDOFF_ISSUER })).toString(
      'base64url',
    );
    expect(verifyToken(keys, `${header}.${payload}.`)).toBeNull();
  });
});

describe('who may ask for what (S2-02)', () => {
  it('refuses reception a console token, and grants it a till token', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/auth/handoff',
      headers: { cookie },
      payload: { app: 'console' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('FORBIDDEN');

    const allowed = await ctx.app.inject({
      method: 'POST',
      url: '/auth/handoff',
      headers: { cookie },
      payload: { app: 'pos' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('refuses an unsigned caller outright', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/handoff', payload: { app: 'pos' } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an app with no origin configured on this deployment', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/handoff',
      headers: { cookie },
      payload: { app: 'radar' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('HANDOFF_APP_UNKNOWN');
  });
});

describe('the token is written down nowhere (S2-02)', () => {
  it('appears in no audit row, no replay store and no session row', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/handoff',
      // A client that sends one must not have the credential cached for a day.
      headers: { cookie: launcher, 'idempotency-key': 'handoff-key-1' },
      payload: { app: 'pos' },
    });
    expect(res.statusCode).toBe(200);
    const { token } = res.json() as IssuedBody;
    await exchange(token);

    const audits = await ctx.db.select().from(auditLog);
    expect(JSON.stringify(audits)).not.toContain(token);
    // The two outcomes ARE recorded — by jti, which is useless on its own.
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('auth.handoff_issue');
    expect(actions).toContain('auth.handoff_exchange');

    const replayStore = await ctx.db.select().from(idempotencyKey);
    expect(JSON.stringify(replayStore)).not.toContain(token);
    // The claim was released rather than left in flight, so a retry mints a
    // fresh token instead of waiting out a response that will never be stored.
    expect(replayStore.some((r) => r.key === 'handoff-key-1')).toBe(false);

    const sessions = await ctx.db.select().from(sessionTable);
    expect(JSON.stringify(sessions)).not.toContain(token);

    // Nor does the row that tracks it: only the jti, and a sealed session
    // secret that the database alone cannot open — wiped once spent.
    const rows = await ctx.db.select().from(handoffToken);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows.filter((r) => r.consumedAt !== null).every((r) => r.sessionSecret === null)).toBe(true);
  });

  it('reaches no log line', async () => {
    // The api logs one completion line per request with the query string
    // stripped, so the check that matters is that nothing puts the token
    // anywhere near it. Raise the level and watch what is actually written.
    const written: string[] = [];
    const capture = (chunk: unknown): void => {
      if (typeof chunk === 'string') written.push(chunk);
      else if (Buffer.isBuffer(chunk)) written.push(chunk.toString('utf8'));
    };
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'trace';
    const spies = [
      vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, chunk: unknown) => {
        capture(chunk);
        return 0;
      }) as never),
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        capture(chunk);
        return true;
      }) as never),
    ];
    try {
      await ctx.restart();
      const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
      const issued = await mint(launcher);
      await exchange(issued.token);
      await exchange(issued.token); // and the rejection path
      const output = written.join('');
      // Proof the capture worked, so the assertion below cannot pass by
      // watching nothing.
      expect(output).toContain('request completed');
      expect(output).not.toContain(issued.token);
    } finally {
      for (const spy of spies) spy.mockRestore();
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
      await ctx.restart();
    }
  });
});

describe('configuration and housekeeping (S2-02)', () => {
  it('keeps verifying a token minted under the previous key after a rotation', () => {
    const old = { kid: KID, secret: SECRET };
    const token = signHandoffToken(old, {
      jti: newId(),
      sid: newId(),
      sub: newId(),
      aud: 'pos',
      iss: HANDOFF_ISSUER,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    // What a rotation looks like: the new key first, the old one still there
    // for as long as a token minted under it can still be alive.
    const rotated = parseHandoffKeys(`k2:a-brand-new-secret-0123456789abcdef,${KID}:${SECRET}`);
    expect(verifyToken(rotated, token)?.aud).toBe('pos');
    // And once it is dropped, the token stops being anything.
    expect(verifyToken(parseHandoffKeys('k2:a-brand-new-secret-0123456789abcdef'), token)).toBeNull();
  });

  it('refuses configuration that cannot be what it claims', () => {
    expect(() => parseHandoffKeys('k1:tooshort')).toThrow(/at least 32/);
    expect(() => parseHandoffKeys(`k1:${SECRET},k1:${SECRET}`)).toThrow(/share a kid/);
    expect(() => parseAppOrigins('pos=https://a.test/path')).toThrow(/no path/);
    expect(() => parseAppOrigins('wheel=https://a.test')).toThrow(/not one of the suite/);
    // Unset is unavailable, not a key invented at boot that nobody can rotate.
    expect(() => handoffConfig({ signingKey: '', appOrigins: 'pos=https://a.test', ttlSeconds: 60 })).toThrow(
      /HANDOFF_SIGNING_KEY/,
    );
  });

  it('sweeps tokens whose window has passed', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);
    const jti = (await rowFor(issued.token)).jti;
    await ctx.db
      .update(handoffToken)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(handoffToken.jti, jti));

    expect(await purgeExpiredHandoffTokens(ctx.db)).toBeGreaterThan(0);
    const [gone] = await ctx.db.select().from(handoffToken).where(eq(handoffToken.jti, jti));
    expect(gone).toBeUndefined();
  });
});

/** The claims of a token we minted — read, not trusted. */
function claimsOf(token: string): HandoffClaims {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as HandoffClaims;
}

async function rowFor(token: string): Promise<{ jti: string }> {
  return { jti: claimsOf(token).jti };
}

/** The most recent rejection row. */
async function lastRejection(): Promise<{ after: Record<string, unknown>; actorAccountId: string | null }> {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, 'auth.handoff_rejected'))
    .orderBy(sql`${auditLog.createdAt} desc`)
    .limit(1);
  return { after: rows[0]!.after as Record<string, unknown>, actorAccountId: rows[0]!.actorAccountId };
}
