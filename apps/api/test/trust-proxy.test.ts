import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authThrottle } from '@oto/db';
import { buildApp, type App } from '../src/app';
import { loadEnv } from '../src/env';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-353 — which address the api believes a request came from.
 *
 * `req.ip` is the key of the per-IP rate-limit bucket (plugins/rate-limit.ts
 * `keyGenerator`) and of the sign-in throttle (routes/auth.ts passes it to
 * `services/auth.ts`, which counts failures under `ip:<addr>`). Get it wrong
 * in one direction and every caller in the world shares one bucket; get it
 * wrong in the other and any caller mints a fresh bucket by inventing a header.
 * So it is worth a file of its own.
 *
 * WHAT A HOP COUNT MEANS. `X-Forwarded-For` is appended to left to right, so
 * the RIGHTMOST entry is the one the nearest proxy wrote and the LEFTMOST is
 * whatever the original client chose to send — which is to say, a forgery.
 * `TRUST_PROXY` counts hops inward from the socket: 0 trusts nothing and
 * `req.ip` is the peer on the other end of the TCP connection; 1 trusts the
 * socket and so reads the last XFF entry; 2 trusts one entry beyond that. A
 * chain is only as honest as its count is small — every hop trusted past the
 * real ones is an entry the caller could have written themselves.
 *
 * THE DEFECT THIS FILE WAS WRITTEN FOR. Fastify stopped honouring the number
 * form. `fastify@5.12.3` lib/request.js:51-55:
 *
 *     if (typeof tp === 'number') {
 *       // Hop-count-only trust cannot validate the immediate peer. Fail closed
 *       // so direct clients cannot spoof X-Forwarded-* values by supplying
 *       // enough hops.
 *       return function () { return false }
 *     }
 *
 * A number is truthy, so the proxy-aware request is built and `req.ips` exists
 * — but the trust function refuses every hop, and `req.ip` falls back to the
 * socket address. apps/api/src/app.ts handed `env.TRUST_PROXY` to Fastify as a
 * number, so on every deployment the setting did nothing at all. Measured on
 * staging on 23 Sep 2026, before the fix: four requests carrying four DIFFERENT
 * forged `X-Forwarded-For` values walked one counter down 119 → 118 → 117, and
 * requests with no header continued the same trail — the header changed
 * nothing, and the public surface was capped globally rather than per caller.
 *
 * app.ts now hands Fastify the equivalent FUNCTION form, which proxy-addr has
 * always accepted and Fastify's own types declare:
 *
 *     trustProxy:
 *       opts.env.TRUST_PROXY > 0 ? (_addr, hop) => hop < opts.env.TRUST_PROXY : false,
 *
 * These tests are what keeps it in that form: revert it to the number and five
 * of the six below fail, every one of them returning the socket address.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/**
 * The count render.yaml sets for `oto-api-staging`, and the one this file
 * defends. ONE hop: `req.ip` is the last `X-Forwarded-For` entry — the address
 * written by the proxy on the other end of the socket, which is the one part
 * of the header no caller can reach.
 *
 * ONE IS THE FAIL-CLOSED CHOICE, NOT A MEASURED CHAIN DEPTH. The api answers
 * on its own hostname, but not directly: `GET /health` comes back with
 * `server: cloudflare` and a `cf-ray`, so Cloudflare fronts the service and
 * Render's load balancer sits behind it. How many of those proxies append to
 * `X-Forwarded-For` — and whether the POS site's `/api/*` rewrite adds one
 * more — is UNMEASURED. It could not be measured while the count was being
 * ignored altogether, and can only be measured against the deployment once the
 * app.ts line above ships. Until then 1 is the value that cannot be wrong in
 * the dangerous direction: too low aggregates callers who share a proxy into
 * one bucket, while too high files a request under an address the caller wrote
 * themselves, buying a fresh rate-limit bucket and a fresh run of password
 * guesses on every request. If the measurement then shows a real proxy is
 * being missed, the answer is to trust that hop by ADDRESS, never to raise
 * this count.
 */
const DEPLOYED_HOPS = 1;

/** A route with the per-IP bucket on it and nothing else to set up. */
const LOOKUP = '/public/member-tier?phone=0811111111&branch=hkt-central';
/** plugins/rate-limit.ts `child()` keys the bucket `rl:<METHOD>:<url>:<ip>`. */
const BUCKET = 'rl:GET:/public/member-tier:';

/**
 * One request in, through a given chain, at a given hop count — and back the
 * address the api filed it under.
 *
 * The bucket key is the honest observable here: no route echoes `req.ip`, and
 * the bucket is the thing the answer actually decides.
 */
async function addressFiledUnder(
  hops: number,
  chain: string | null,
  socketAddress = '10.201.0.9',
): Promise<string> {
  const env = loadEnv({ NODE_ENV: 'test', TRUST_PROXY: String(hops) });
  const app: App = await buildApp({ env, db: ctx.db, fileStorage: null });
  try {
    await ctx.db.delete(authThrottle);
    const res = await app.inject({
      method: 'GET',
      url: LOOKUP,
      remoteAddress: socketAddress,
      ...(chain ? { headers: { 'x-forwarded-for': chain } } : {}),
    });
    expect(res.statusCode).toBe(200);
    const keys = (await ctx.db.select().from(authThrottle))
      .map((r) => r.key)
      .filter((k) => k.startsWith(BUCKET));
    expect(keys, 'exactly one per-IP bucket for one request').toHaveLength(1);
    return keys[0]!.slice(BUCKET.length);
  } finally {
    await app.close();
    await ctx.db.delete(authThrottle);
  }
}

/**
 * A fixture chain, three entries deep, the way one reads on the wire. It is
 * not a claim about how deep the deployment's chain is — that is unmeasured
 * (see DEPLOYED_HOPS); it is a chain long enough to show what each count
 * reaches.
 *   198.51.100.66  what the client itself put in the header — a forgery
 *   203.0.113.7    the caller, as the front-most proxy actually saw them
 *   192.0.2.9      a proxy in between, as the nearest one saw it
 * and 10.201.0.9, the socket, is the nearest proxy itself. All three are
 * documentation addresses (RFC 5737): nothing here stands for a real network.
 */
const SPOOF = '198.51.100.66';
const CALLER = '203.0.113.7';
const EDGE = '192.0.2.9';
const SOCKET = '10.201.0.9';
const CHAIN = `${SPOOF}, ${CALLER}, ${EDGE}`;

describe('TRUST_PROXY counts hops inward, and a forged entry stays outside them (SCRUM-353)', () => {
  it('trusts nothing at 0: the address is the peer on the socket', async () => {
    expect(await addressFiledUnder(0, CHAIN)).toBe(SOCKET);
  });

  it('trusts the socket at 1: the address is the last entry of the chain', async () => {
    expect(await addressFiledUnder(1, CHAIN)).toBe(EDGE);
  });

  it('reaches the caller at 2, and the forgery in front of them is ignored', async () => {
    const filed = await addressFiledUnder(2, CHAIN);
    expect(filed).toBe(CALLER);
    expect(filed).not.toBe(SPOOF);
  });

  it('counts one hop too many at 3 and files the request under the forgery', async () => {
    // Not an endorsement — the point is that the count is the whole of the
    // defence, so it is the thing to get right and to keep a test on.
    expect(await addressFiledUnder(3, CHAIN)).toBe(SPOOF);
  });

  it('at the deployed count, a caller cannot forge their way out of a bucket', async () => {
    // What one hop defends, whatever the real chain depth turns out to be: the
    // caller writes a header and the proxy on the socket appends the address it
    // saw. The appended entry is the LAST one, so one trusted hop reads it and
    // the invented entry in front of it is out of reach. (Whether that last
    // entry is the visitor themselves or another proxy in between is the
    // unmeasured part — it changes who shares a bucket, never who can forge.)
    const filed = await addressFiledUnder(DEPLOYED_HOPS, `${SPOOF}, ${CALLER}`);
    expect(filed).toBe(CALLER);
    expect(filed).not.toBe(SPOOF);
  });

  it('puts two requests from one caller in one bucket, not one each', async () => {
    // The other half of a working cap: a caller's requests keep counting down
    // the same allowance, so it actually refuses them at the cap. The case
    // above covers the opposite failure — minting a fresh bucket by changing
    // the header — and the two together are what "per caller" means.
    const env = loadEnv({ NODE_ENV: 'test', TRUST_PROXY: String(DEPLOYED_HOPS) });
    const app: App = await buildApp({ env, db: ctx.db, fileStorage: null });
    try {
      await ctx.db.delete(authThrottle);
      for (let n = 0; n < 2; n++) {
        const res = await app.inject({
          method: 'GET',
          url: LOOKUP,
          remoteAddress: SOCKET,
          headers: { 'x-forwarded-for': `${SPOOF}, ${CALLER}` },
        });
        expect(res.statusCode, `request ${n + 1}`).toBe(200);
        // The allowance falls; it does not reset because a header changed.
        expect(res.headers['x-ratelimit-remaining']).toBe(String(120 - (n + 1)));
      }
      const keys = (await ctx.db.select().from(authThrottle))
        .map((r) => r.key)
        .filter((k) => k.startsWith(BUCKET));
      expect(keys).toEqual([`${BUCKET}${CALLER}`]);
    } finally {
      await app.close();
      await ctx.db.delete(authThrottle);
    }
  });
});
