import { once } from 'node:events';
import http, { type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authThrottle } from '@oto/db';
import { createPosServer } from '../../pos/server/server';
import { ADMIN, createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-718 adversarial review. P0: trusting a supplied address would allow
 * another password-guessing allowance on every request. Prescribed fix:
 * append the socket peer and leave the API's address trust walk in charge.
 * These pins use the real sign-in handler and persistent throttle database.
 */
let ctx: TestContext, proxy: Server, origin: string;
const CALLER = '203.0.113.18';
const POS_ORIGIN = 'https://zz-test-pos.example';
beforeAll(async () => {
  ctx = await createTestContext({ env: { TRUST_PROXY_ADDRS: '127.0.0.1/32,10.0.0.0/8,173.245.48.0/20',
    AUTH_MAX_FAILURES_PER_ADDRESS: '2', AUTH_COOLDOWN_SECONDS: '300', ALLOWED_ORIGINS: POS_ORIGIN,
    COOKIE_SECURE: 'true' } });
  const api = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  proxy = createPosServer({ root: '.', apiUpstream: api });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('test proxy did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => { await ctx.db.delete(authThrottle); });
afterAll(async () => {
  if (proxy) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
  if (ctx) await ctx.close();
  await teardownAll();
});
async function signIn(forged: string, phone: string) {
  return fetch(`${origin}/api/auth/sign-in`, { method: 'POST', headers: {
    'content-type': 'application/json', origin: POS_ORIGIN,
    // The right side is what the front edge observed, not input from a browser.
    'x-forwarded-for': `${forged}, ${CALLER}, 173.245.48.5`, 'x-forwarded-proto': 'https',
  }, body: JSON.stringify({ phone, password: 'ZZ TEST wrong password' }) });
}

describe('SCRUM-718 real API safety review', () => {
  it('P0 pin: changing forged x-forwarded-for and phone cannot buy another sign-in allowance', async () => {
    expect((await signIn('198.51.100.1', '+66600000718')).status).toBe(401);
    expect((await signIn('198.51.100.2', '+66600000719')).status).toBe(401);
    const refused = await signIn('198.51.100.3', '+66600000720');
    expect(refused.status).toBe(429);
    const buckets = (await ctx.db.select().from(authThrottle)).filter(row => row.key.startsWith('ip:'));
    expect(buckets).toHaveLength(1); expect(buckets[0]!.key).toBe(`ip:${CALLER}`);
    expect(buckets[0]!.failures).toBe(2);
  });
  it('P0 pin: an untrusted direct peer cannot assert an earlier caller address', async () => {
    const response = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${origin}/api/auth/sign-in`, { method: 'POST', localAddress: '127.0.0.2',
        headers: { 'content-type': 'application/json', origin: POS_ORIGIN,
          'x-forwarded-for': '198.51.100.90, 10.0.0.1, 173.245.48.5' },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.end(JSON.stringify({ phone: '+66600000718', password: 'ZZ TEST wrong password' }));
    });
    expect(response).toBe(401);
    const buckets = (await ctx.db.select().from(authThrottle)).filter(row => row.key.startsWith('ip:'));
    expect(buckets.map(row => row.key)).toEqual(['ip:127.0.0.2']);
  });
  it('P0 pin: sign-in keeps the host-only Secure HttpOnly Lax cookie and sign-out invalidates it', async () => {
    const r = await fetch(`${origin}/api/auth/sign-in`, { method: 'POST', headers: {
      'content-type': 'application/json', origin: POS_ORIGIN,
    }, body: JSON.stringify(ADMIN) });
    expect(r.status).toBe(200);
    const headers = r.headers.getSetCookie(); expect(headers).toHaveLength(1);
    const header = headers[0]!;
    expect(header).toContain('HttpOnly'); expect(header).toContain('Secure'); expect(header).toContain('SameSite=Lax');
    expect(header).not.toMatch(/Domain=/i);
    const cookie = header.split(';')[0]!;
    expect((await fetch(`${origin}/api/me`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${origin}/api/auth/sign-out`, { method: 'POST', headers: { cookie, origin: POS_ORIGIN } })).status).toBe(200);
    expect((await fetch(`${origin}/api/me`, { headers: { cookie } })).status).toBe(401);
  });
  it('P0 pin: a foreign Origin remains refused and no CORS is introduced', async () => {
    const r = await fetch(`${origin}/api/auth/sign-in`, { method: 'POST', headers: {
      origin: 'https://foreign.example', 'content-type': 'application/json',
    }, body: JSON.stringify(ADMIN) });
    expect(r.status).toBe(403); expect((await r.json()).error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});
