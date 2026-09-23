import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authThrottle, session as sessionTable, station } from '@oto/db';
import {
  ADMIN,
  RECEPTION,
  boxBySlot,
  branchIdByCode,
  CENTRAL_BRANCH_CODE,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { _resetThrottle } from '../src/services/auth';
import { hashToken, SESSION_COOKIE } from '../src/plugins/session';

/**
 * SCRUM-376 — WHAT A THROTTLE COUNTS AGAINST.
 *
 * Every bucket on this api was keyed on `req.ip`, which was right for as long
 * as the address named the caller. It stopped naming the caller the day the
 * frontends started reaching the api through their own sites' `/api/*`
 * rewrites, and the measurement of 23 Sep 2026 —
 * `docs/qa/TRUST_PROXY_REWRITE_MEASUREMENT_2026-09-23.md` — says how badly:
 * what arrives at the api is Render's shared REGIONAL proxy fleet, two /24s
 * that Render's own API reports as `"type":"shared"`. The launcher was watched
 * continuing a rate-limit counter the POS had opened seconds earlier, and the
 * entry naming the till is dropped at the rewrite, so no trust list can
 * recover it — and trusting that fleet would let any other tenant in the
 * region forge a caller past every throttle.
 *
 * The live consequence was an outage shape, not a security shape: five
 * mistyped passwords anywhere in the estate locked EVERY till, the Console and
 * the launcher out of signing in for five minutes.
 *
 * So the rule these cases hold is: **a throttle keys on what the request has
 * already PROVED about itself, and the address is the fallback only where
 * nothing is proved yet.** A session proves a station or an account; a box
 * credential that names a box proves which box was attacked; sign-in and
 * pairing prove nothing, so they keep the address on a ceiling sized for an
 * address the whole estate shares.
 *
 * Nothing here is derived from a header a caller wrote. `trust-proxy.test.ts`
 * is the file that holds that line for the address itself, and it is untouched
 * by this — which is the other half of the story.
 */

let ctx: TestContext;

/** The route with the secondary bucket on it and nothing else to set up. */
const LOOKUP = '/public/member-tier?phone=0811111111&branch=hkt-central';
/** plugins/rate-limit.ts `child()` keys the bucket `rl:<METHOD>:<url>:<caller>`. */
const BUCKET = 'rl:GET:/public/member-tier:';
/** `RATE_LIMIT_IP_MAX`'s default: what a fresh bucket starts at. */
const ROUTE_MAX = 120;

/** The per-address sign-in ceiling this file runs with. Ten, to stay quick. */
const MAX_PER_ADDRESS = 10;
const MAX_PER_PHONE = 5;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      AUTH_MAX_FAILURES: String(MAX_PER_PHONE),
      AUTH_MAX_FAILURES_PER_ADDRESS: String(MAX_PER_ADDRESS),
      AUTH_COOLDOWN_SECONDS: '300',
    },
  });
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

beforeEach(async () => {
  await _resetThrottle(ctx.db);
});

/** Every bucket this route has open, keyed by the caller part of the key. */
async function routeBuckets(): Promise<Record<string, number>> {
  const rows = await ctx.db.select().from(authThrottle).where(like(authThrottle.key, `${BUCKET}%`));
  return Object.fromEntries(rows.map((r) => [r.key.slice(BUCKET.length), r.failures]));
}

/** One lookup, and the allowance the answer says is left. */
async function lookup(cookie?: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: LOOKUP,
    ...(cookie ? { headers: { cookie } } : {}),
  });
  expect(res.statusCode).toBe(200);
  return Number(res.headers['x-ratelimit-remaining']);
}

/**
 * Seat a signed-in session at a station.
 *
 * `PUT /me/session/station` is the route that does this for real and it does
 * a great deal besides — reach checks, a lease, a shift token, an audit row —
 * none of which this file is about. What the key reads is one column of one
 * session row, so that column is what is written. The row is found by the
 * hash of the token in the cookie, which is the same handle `loadAuth` uses.
 */
async function seatAt(cookie: string, stationId: string): Promise<void> {
  const token = cookie.slice(`${SESSION_COOKIE}=`.length);
  const updated = await ctx.db
    .update(sessionTable)
    .set({ stationId })
    .where(eq(sessionTable.tokenHash, hashToken(token)))
    .returning({ id: sessionTable.id });
  expect(updated, 'the cookie names exactly one session row').toHaveLength(1);
}

async function stationIdNamed(name: string): Promise<string> {
  const branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const rows = await ctx.db.select().from(station).where(eq(station.name, name));
  const row = rows.find((s) => s.branchId === branchId);
  if (!row) throw new Error(`No seeded station named ${name} at ${CENTRAL_BRANCH_CODE}`);
  return row.id;
}

describe('the route bucket keys on the session, not on the address (SCRUM-376)', () => {
  it('gives two tills behind one address an allowance each', async () => {
    // The estate's actual shape after the rewrite: both sessions arrive from
    // one address — `inject` is always 127.0.0.1 — and they are two different
    // people at two different counters.
    const till1 = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const till2 = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const counter1 = await stationIdNamed('Reception Till 1');
    const counter2 = await stationIdNamed('Counter 2');
    await seatAt(till1, counter1);
    await seatAt(till2, counter2);

    // Two on one till, one on the other. If they shared a bucket the third
    // request would read 117.
    expect(await lookup(till1)).toBe(ROUTE_MAX - 1);
    expect(await lookup(till1)).toBe(ROUTE_MAX - 2);
    expect(await lookup(till2)).toBe(ROUTE_MAX - 1);

    expect(await routeBuckets()).toEqual({
      [`station:${counter1}`]: 2,
      [`station:${counter2}`]: 1,
    });
  });

  it('keys one account at two counters on the counters, not on the account', async () => {
    // The same person, signed in at two tills — one on the ticket counter and
    // one at the bar. Spending a till's allowance must not spend the other's,
    // because what runs out of allowance is a machine and not a person.
    const atCounter1 = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const atCounter2 = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const counter1 = await stationIdNamed('Reception Till 1');
    const counter2 = await stationIdNamed('Counter 2');
    await seatAt(atCounter1, counter1);
    await seatAt(atCounter2, counter2);

    expect(await lookup(atCounter1)).toBe(ROUTE_MAX - 1);
    expect(await lookup(atCounter2)).toBe(ROUTE_MAX - 1);

    const buckets = await routeBuckets();
    expect(buckets).toEqual({ [`station:${counter1}`]: 1, [`station:${counter2}`]: 1 });
    // And on neither of the two things it must not be keyed on.
    expect(Object.keys(buckets).some((k) => k.startsWith('account:'))).toBe(false);
    expect(buckets['127.0.0.1']).toBeUndefined();
  });

  it('falls back to the account for a session that has not picked a station', async () => {
    // The Console and the launcher sign in and never stand at a till, and so
    // does a till before its first shift. The account is the next thing the
    // session proves, and two browsers of one person sharing one allowance is
    // the correct answer there.
    const console1 = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    expect(await lookup(console1)).toBe(ROUTE_MAX - 1);

    const buckets = await routeBuckets();
    const keys = Object.keys(buckets);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^account:/);
  });

  it('keys a caller who has proved nothing on the address, exactly as before', async () => {
    // The booking site, and everything else anonymous. There is nothing else
    // to key on, and `trust-proxy.test.ts` is what holds the address itself
    // honest.
    expect(await lookup()).toBe(ROUTE_MAX - 1);
    expect(await lookup()).toBe(ROUTE_MAX - 2);
    expect(await routeBuckets()).toEqual({ '127.0.0.1': 2 });
  });

  it('does not let a forged header buy a signed-in till a second allowance', async () => {
    // The session is the key, so the header is not read at all — which is the
    // property that makes keying on a credential safe. Three requests, three
    // different invented addresses, one counter going down.
    const till = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const counter1 = await stationIdNamed('Reception Till 1');
    await seatAt(till, counter1);

    for (let n = 1; n <= 3; n++) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: LOOKUP,
        headers: { cookie: till, 'x-forwarded-for': `203.0.113.${n}` },
      });
      expect(res.statusCode, `request ${n}`).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBe(String(ROUTE_MAX - n));
    }
    expect(await routeBuckets()).toEqual({ [`station:${counter1}`]: 3 });
  });
});

describe('a refused box credential counts on the box it named (SCRUM-376)', () => {
  /** What `services/box.ts` allows per box id, and per address, on refusals. */
  const PER_BOX = 30;

  const badSecret = 'f'.repeat(64);
  const config = (boxId: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/box/v1/config',
      headers: { authorization: `Bearer ${boxId}.${badSecret}` },
    });

  it('counts on the box id, and leaves the next box in the park working', async () => {
    const boxA = await boxBySlot(ctx.db, 'virtual-1');
    const boxB = await boxBySlot(ctx.db, 'virtual-2');

    // Spend box A's whole allowance from this address. Each of these NAMES a
    // box — a real id with a secret that is not its — which is the case the
    // ticket is about: the thing being attacked is that box, not the mall.
    for (let n = 1; n <= PER_BOX; n++) {
      expect((await config(boxA.id)).statusCode, `attempt ${n}`).toBe(401);
    }
    const overA = await config(boxA.id);
    expect(overA.statusCode).toBe(429);

    // Same address, same second, different box: untouched. Under the old
    // key — `box-auth:<ip>` — this was the request that found the park's
    // other box locked out by its neighbour.
    expect((await config(boxB.id)).statusCode).toBe(401);

    const rows = await ctx.db.select().from(authThrottle).where(like(authThrottle.key, 'rl:box-%'));
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.failures]));
    expect(byKey[`rl:box-auth:${boxA.id}`]).toBe(PER_BOX + 1);
    expect(byKey[`rl:box-auth:${boxB.id}`]).toBe(1);
    /**
     * The address bucket is still kept, on its own much higher ceiling: it is
     * what catches a caller presenting rubbish that names no box at all.
     *
     * It reads one short of the attempts made, and that is the ordering doing
     * its job rather than an off-by-one: the box's own bucket is spent first,
     * so the attempt that found box A locked was refused before it reached
     * here. Somebody hammering one box id therefore stops spending the park's
     * shared allowance the moment that box closes — which is the whole point
     * of keying on the identity.
     */
    expect(byKey['rl:box-auth-addr:127.0.0.1']).toBe(PER_BOX + 1);
  });

  it('counts a malformed credential on the address, because it named nobody', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/config',
      headers: { authorization: 'Bearer not-a-box-credential' },
    });
    expect(res.statusCode).toBe(401);

    const rows = await ctx.db.select().from(authThrottle).where(like(authThrottle.key, 'rl:box-%'));
    expect(rows.map((r) => r.key)).toEqual(['rl:box-auth-addr:127.0.0.1']);
  });
});

describe('the sign-in throttle keeps the phone tight and lets the address breathe (SCRUM-376)', () => {
  const signIn = (phone: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone, password: 'not-the-password' },
    });

  /** A phone with no account behind it — the refusal path is the same one. */
  const nobody = (n: number) => `+6690001${String(1000 + n).padStart(4, '0')}`;

  it('locks one phone at AUTH_MAX_FAILURES, unchanged', async () => {
    for (let n = 1; n <= MAX_PER_PHONE; n++) {
      expect((await signIn(nobody(1))).statusCode, `attempt ${n}`).toBe(401);
    }
    const locked = await signIn(nobody(1));
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('TOO_MANY_REQUESTS');

    const rows = await ctx.db.select().from(authThrottle).where(like(authThrottle.key, 'phone:%'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lockedUntil).not.toBeNull();
  });

  it('does NOT lock the address at that count — this is the estate-wide outage', async () => {
    // Five different people mistyping their passwords, from the one address
    // every till, the Console and the launcher share. Under the old ceiling
    // (AUTH_MAX_FAILURES x 4 = 20 here, and 20 on the deployment) this was
    // the road to locking the whole estate; what matters is that the count
    // that locks ONE phone can never lock the address.
    for (let n = 1; n <= MAX_PER_PHONE; n++) {
      expect((await signIn(nobody(n))).statusCode, `phone ${n}`).toBe(401);
    }
    // A sixth person, a sixth phone: still answered, still 401.
    expect((await signIn(nobody(6))).statusCode).toBe(401);

    const [addr] = await ctx.db
      .select()
      .from(authThrottle)
      .where(eq(authThrottle.key, 'ip:127.0.0.1'));
    expect(addr!.failures).toBe(MAX_PER_PHONE + 1);
    expect(addr!.lockedUntil).toBeNull();
    // And no phone was locked either: one guess each.
    const phones = await ctx.db.select().from(authThrottle).where(like(authThrottle.key, 'phone:%'));
    expect(phones.every((r) => r.lockedUntil === null)).toBe(true);
  });

  it('still closes the address at AUTH_MAX_FAILURES_PER_ADDRESS', async () => {
    // Raised, not removed. A ceiling on absurdity: nothing aimed at one
    // account can reach it before that account's own bucket has closed twice
    // over.
    for (let n = 1; n <= MAX_PER_ADDRESS; n++) {
      expect((await signIn(nobody(n))).statusCode, `phone ${n}`).toBe(401);
    }
    const locked = await signIn(nobody(MAX_PER_ADDRESS + 1));
    expect(locked.statusCode).toBe(429);

    const [addr] = await ctx.db
      .select()
      .from(authThrottle)
      .where(eq(authThrottle.key, 'ip:127.0.0.1'));
    expect(addr!.lockedUntil).not.toBeNull();
  });
});
