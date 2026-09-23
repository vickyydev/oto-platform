import { readFileSync } from 'node:fs';
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
 * The first describe block is what keeps it in that form: revert it to the
 * number and five of its six cases fail, every one of them returning the socket
 * address.
 *
 * WHAT THE DEPLOYMENT DOES NOW. The count answered the forgery but not the
 * question "who is the caller" — measured, it reached Cloudflare's edge and
 * stopped (SCRUM-353) — so the deployments name their proxies by address in
 * `TRUST_PROXY_ADDRS` instead, and the count is the fallback behind it. The
 * second describe block covers that (SCRUM-367).
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
 * The count render.yaml still sets for `oto-api-staging`, now as the FALLBACK
 * behind the address list below (SCRUM-367). ONE hop: `req.ip` is the last
 * `X-Forwarded-For` entry — the address written by the proxy on the other end
 * of the socket, which is the one part of the header no caller can reach.
 *
 * ONE IS THE FAIL-CLOSED CHOICE, AND IT IS NOT ENOUGH. Measured on staging at
 * deploy 2845135, the first on which the count took effect at all: one trusted
 * hop reaches CLOUDFLARE'S EDGE and stops there. Forged entries stayed ignored
 * and the POS site's `/api/*` rewrite added no hop, but the caller was never
 * reached — one machine's requests spread over four edge counters, and
 * everyone behind one edge shares that edge's allowance. Raising the count is
 * not the answer, because a count cannot check that hop 1 really is
 * Cloudflare: 2 would trust the same position on a request that bypassed
 * Cloudflare, buying a fresh rate-limit bucket and a fresh run of password
 * guesses on demand. The hops are named by address instead — the second
 * describe block below.
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
  return filedUnder(loadEnv({ NODE_ENV: 'test', TRUST_PROXY: String(hops) }), chain, socketAddress);
}

/**
 * The same question of an api configured with an address LIST (SCRUM-367).
 *
 * The count is handed over as well, and deliberately: it is the value the
 * deployment carries, so every case below would file the request under the
 * last header entry if the list were being ignored. That is the difference the
 * list has to make, and it is what the first plant on this file removes.
 */
async function addressFiledUnderList(
  trusted: string,
  chain: string | null,
  socketAddress = '10.201.0.9',
): Promise<string> {
  return filedUnder(
    loadEnv({
      NODE_ENV: 'test',
      TRUST_PROXY: String(DEPLOYED_HOPS),
      TRUST_PROXY_ADDRS: trusted,
    }),
    chain,
    socketAddress,
  );
}

async function filedUnder(
  env: ReturnType<typeof loadEnv>,
  chain: string | null,
  socketAddress: string,
): Promise<string> {
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
 * not a claim about the deployment's own chain — the measured one is in the
 * second block below; it is a chain long enough to show what each count
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

/**
 * SCRUM-367 — the same question, answered by ADDRESS instead of by count.
 *
 * `TRUST_PROXY_ADDRS` lists the proxies that are ours. proxy-addr walks
 * `X-Forwarded-For` from the right and steps over every entry whose address is
 * on the list, so `req.ip` is the first entry no listed proxy wrote. Two
 * things follow, and they are what the cases below hold: a chain through as
 * many listed proxies as the deployment has still reaches the caller, and an
 * entry a caller wrote can never become `req.ip`, because the address in it is
 * not ours — including on a request that reached the api without passing
 * through those proxies at all, which is the case a raised hop count gets
 * wrong.
 */

/**
 * The chain the deployment actually produces, from SCRUM-353's measurement on
 * 23 Sep 2026. The socket is Render's internal balancer; the last header entry
 * is the Cloudflare edge that answered the caller — `104.22.66.228` is one of
 * the four that turned up in the buckets that day, and it falls in
 * `104.16.0.0/13`; the caller's own address is one entry further left.
 */
const CF_EDGE = '104.22.66.228';
/**
 * The measuring machine was on IPv6 (`2405:9800:…`, AIS Thailand), and its
 * address keyed nothing. Not in any Cloudflare range — `2405:8100::/32` and
 * `2405:b500::/32` are the two that start `2405:`, and this is neither.
 */
const IPV6_CALLER = '2405:9800:b060::1';

/**
 * The list render.yaml sets on the api service, read out of the blueprint
 * rather than copied here. These cases are then about the value the deployment
 * actually receives: an edit that drops a hop from it fails here rather than on
 * the running service, and the parse below is the same one that runs at boot.
 */
function deployedTrustedProxies(): string {
  const blueprint = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');
  const lines = blueprint.split('\n').map((line) => line.trimEnd());
  const values = lines.flatMap((line, i) => {
    if (line.trim() !== '- key: TRUST_PROXY_ADDRS') return [];
    const value = lines.slice(i + 1).find((next) => next.trim().startsWith('value:'));
    return value ? [value.trim().slice('value:'.length).trim().replace(/^'|'$/g, '')] : [];
  });
  expect(values, 'exactly one TRUST_PROXY_ADDRS entry in render.yaml').toHaveLength(1);
  return values[0]!;
}

const TRUSTED = deployedTrustedProxies();

describe('TRUST_PROXY_ADDRS names the hops, so the caller keys the bucket (SCRUM-367)', () => {
  it('reaches past Cloudflare to the caller the edge saw', async () => {
    // The whole point: the deployed chain, keyed under the visitor rather than
    // under whichever edge answered them.
    expect(await addressFiledUnderList(TRUSTED, `${CALLER}, ${CF_EDGE}`)).toBe(CALLER);
  });

  it('still ignores an entry the caller wrote in front of that', async () => {
    // Reaching further must not reach as far as the forgery. The list stops at
    // the first entry no listed proxy wrote, and that entry is the caller — the
    // invented one in front of them is never read.
    const filed = await addressFiledUnderList(TRUSTED, `${SPOOF}, ${CALLER}, ${CF_EDGE}`);
    expect(filed).toBe(CALLER);
    expect(filed).not.toBe(SPOOF);
  });

  it('files a request that bypassed Cloudflare under the address the balancer recorded', async () => {
    // The case a hop count cannot get right. Here the chain is one entry short
    // — the caller reached Render without passing through Cloudflare, so the
    // only appended entry is the balancer's — and the caller has written an
    // address of their own in front of it. A count of 2 would file this under
    // the forgery; the list files it under the address the balancer recorded,
    // because the forgery's address is not one of ours.
    const filed = await addressFiledUnderList(TRUSTED, `${SPOOF}, ${CALLER}`);
    expect(filed).toBe(CALLER);
    expect(filed).not.toBe(SPOOF);
  });

  it('reaches an IPv6 caller the same way', async () => {
    // The address the measurement expected to see and never did.
    expect(await addressFiledUnderList(TRUSTED, `${IPV6_CALLER}, ${CF_EDGE}`)).toBe(IPV6_CALLER);
  });

  it('leaves the count in charge when no list is set', async () => {
    // The fallback still works, and this is also the defect the list closes:
    // at the deployed count and with no list, the same chain keys the edge.
    expect(await addressFiledUnder(DEPLOYED_HOPS, `${CALLER}, ${CF_EDGE}`)).toBe(CF_EDGE);
  });

  it('carries the hops the measurement saw', () => {
    const entries = TRUSTED.split(',').map((entry) => entry.trim());
    // Render's internal network: the peer on the socket, without which the
    // header is not read at all.
    expect(entries).toContain('10.0.0.0/8');
    // The two Cloudflare ranges the staging buckets were keyed on.
    expect(entries).toContain('104.16.0.0/13');
    expect(entries).toContain('172.64.0.0/13');
    // Published IPv6 as well: an IPv6 edge that is not listed would put the
    // deployment straight back where it started.
    expect(entries.some((entry) => entry.includes(':'))).toBe(true);
  });

  it('refuses the boot on a malformed block, naming the variable', () => {
    // proxy-addr would refuse it too, when the Fastify instance is built, but
    // as a bare TypeError with nothing pointing at the variable — the check in
    // env.ts is what names TRUST_PROXY_ADDRS and the entry in the deploy log.
    expect(() => loadEnv({ NODE_ENV: 'test', TRUST_PROXY_ADDRS: '10.0.0.0/8,104.16.0.0/64' })).toThrow(
      /TRUST_PROXY_ADDRS/,
    );
    expect(() => loadEnv({ NODE_ENV: 'test', TRUST_PROXY_ADDRS: '10.0.0.0/8,cloudflare' })).toThrow(
      /TRUST_PROXY_ADDRS/,
    );
    // And the value the deployment is given is not one of those.
    expect(() => loadEnv({ NODE_ENV: 'test', TRUST_PROXY_ADDRS: TRUSTED })).not.toThrow();
  });
});
