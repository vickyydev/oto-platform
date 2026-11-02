import http, { type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPosServer } from '../server/server';
import { compressStatic } from '../server/compress';
import { api, ApiError, NetworkError } from '../src/api/client';
import { isBoxLaneTrigger } from '../src/lib/lane';

let root: string;
const servers: Server[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'oto-pos-web-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>ZZ TEST till</title>');
  await writeFile(join(root, 'sw.js'), '/* ZZ TEST worker */');
  await writeFile(join(root, 'assets', 'app-12345678.js'), '/* ZZ TEST asset */'.repeat(200));
  await compressStatic(root);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test listener');
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const upstream = http.createServer(handler);
  const api = await listen(upstream);
  const server = createPosServer({ root, apiUpstream: api });
  const url = await listen(server);
  return { upstream, api, server, url };
}
async function bytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function raw(url: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get(url, { path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('the POS HTTP forwarder (SCRUM-718)', () => {
  it('strips exactly the API prefix and preserves the query bytes', async () => {
    const { url } = await fixture((req, res) => res.end(req.url));
    expect(await (await fetch(`${url}/api/members?q=a%2Bb&second=2`)).text()).toBe('/members?q=a%2Bb&second=2');
    expect(await (await fetch(`${url}/api?x=1`)).text()).toBe('/?x=1');
    expect(await (await fetch(`${url}/api`)).text()).toBe('/');
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('forwards %s bytes and authority/correlation headers exactly once', async method => {
    const calls: { body: Buffer; headers: http.IncomingHttpHeaders }[] = [];
    const { url, api } = await fixture((req, res) => { void bytes(req).then(body => {
      calls.push({ body, headers: req.headers }); res.end('{"ok":true}');
    }); });
    const body = Buffer.from([0, 255, 13, 10, 123, 34, 32, 125]);
    const r = await fetch(`${url}/api/write`, { method, body, headers: {
      origin: 'https://pos.example', cookie: 'session=ZZTEST', authorization: 'Bearer ZZTEST',
      'idempotency-key': 'ZZTEST-key', 'x-oto-action-id': 'ZZTEST-action', accept: 'application/json',
      'content-type': 'application/octet-stream', 'x-forwarded-for': '198.51.100.7, 203.0.113.8',
      'x-forwarded-proto': 'https',
    } });
    expect(r.status).toBe(200); await r.text();
    expect(calls).toHaveLength(1); expect(calls[0]!.body).toEqual(body);
    expect(calls[0]!.headers).toMatchObject({ host: new URL(api).host, origin: 'https://pos.example',
      cookie: 'session=ZZTEST', authorization: 'Bearer ZZTEST', 'idempotency-key': 'ZZTEST-key',
      'x-oto-action-id': 'ZZTEST-action', accept: 'application/json', 'x-forwarded-proto': 'https',
      'x-forwarded-for': '198.51.100.7, 203.0.113.8, 127.0.0.1' });
  });
  it('preserves separate Set-Cookie headers and their host-only attributes', async () => {
    const cookies = ['oto_session=ZZTEST; Path=/; HttpOnly; SameSite=Lax; Secure',
      'second=ZZTEST; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/'];
    const { url } = await fixture((_req, res) => { res.setHeader('Set-Cookie', cookies); res.end('ok'); });
    expect((await raw(url, '/api/auth/sign-in')).headers['set-cookie']).toEqual(cookies);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('never retries %s when a reused upstream connection resets after the write', async method => {
    let calls = 0;
    const { url } = await fixture((req, res) => {
      if (req.url === '/warm') { res.end('warm'); return; }
      void bytes(req).then(() => { calls += 1; req.socket.destroy(); });
    });
    await (await fetch(`${url}/api/warm`)).text();
    const r = await fetch(`${url}/api/sale`, { method, body: 'ZZ TEST sale' });
    expect(r.status).toBe(502); await r.text();
    expect(calls).toBe(1);
  });
  it('retries one bodyless GET on a stale reused socket, keeping warm sockets reusable', async () => {
    let calls = 0; const sockets = new Set();
    const { url } = await fixture((req, res) => {
      sockets.add(req.socket);
      if (req.url === '/warm') { res.end('warm'); return; }
      calls += 1;
      if (calls === 1) req.socket.destroy(); else res.end('recovered');
    });
    await (await fetch(`${url}/api/warm`)).text();
    await (await fetch(`${url}/api/warm`)).text();
    expect(sockets.size).toBe(1);
    expect(await (await fetch(`${url}/api/read`)).text()).toBe('recovered');
    expect(calls).toBe(2); expect(sockets.size).toBe(2);
  });
  it('does not retry a fresh socket failure or loop on the retry', async () => {
    let calls = 0;
    const { url } = await fixture((req, res) => {
      if (req.url === '/warm') { res.end('warm'); return; }
      calls += 1; req.socket.destroy();
    });
    expect((await fetch(`${url}/api/fresh`)).status).toBe(502); expect(calls).toBe(1);
    await (await fetch(`${url}/api/warm`)).text();
    expect((await fetch(`${url}/api/stale`)).status).toBe(502); expect(calls).toBe(3);
  });
  it('passes API refusal bytes/status through, without turning them into a network error', async () => {
    const body = '{"error":{"code":"STATION_FORCED_OFFLINE","message":"offline"}}';
    const { url } = await fixture((_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(body); });
    const r = await fetch(`${url}/api/sales`); expect(r.status).toBe(503); expect(await r.text()).toBe(body);
  });
  it('P0 pin: a connected write may finish after 30 seconds without a new proxy deadline or replay', async () => {
    let calls = 0;
    let received!: (res: ServerResponse) => void;
    const ready = new Promise<ServerResponse>(resolve => { received = resolve; });
    const { url } = await fixture((req, res) => {
      calls += 1;
      req.resume(); req.once('end', () => received(res));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.request(`${url}/api/sales/zz-test/finalise`, { method: 'POST' }, res => {
          let body = ''; res.on('data', chunk => { body += chunk; });
          res.once('end', () => resolve({ status: res.statusCode!, body }));
          res.once('error', reject);
        });
        request.once('error', reject); request.end('{"cash":true}');
      });
      const upstream = await ready;
      await vi.advanceTimersByTimeAsync(31_000);
      if (!upstream.destroyed) upstream.end('accepted once');
      expect(await result).toEqual({ status: 200, body: 'accepted once' });
      expect(calls).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it('returns a 502 API envelope when upstream is down while its own health still works', async () => {
    const upstream = http.createServer(); const api = await listen(upstream);
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    const url = await listen(createPosServer({ root, apiUpstream: api }));
    const r = await fetch(`${url}/api/health`); expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The platform is temporarily unavailable. Please try again.' } });
    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
  });
  it('keeps the real client/lane distinction between a 502 answer and a lost network', async () => {
    const upstream = http.createServer(); const apiOrigin = await listen(upstream);
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    const server = createPosServer({ root, apiUpstream: apiOrigin }); const url = await listen(server);
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (path: string, init: RequestInit) => nativeFetch(url + path, init));
    const answered = await api.get('/health').catch(error => error);
    expect(answered).toBeInstanceOf(ApiError); expect(answered instanceof ApiError ? answered.status : null).toBe(502);
    expect(isBoxLaneTrigger(answered)).toBe(false);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const unreachable = await api.get('/health').catch(error => error);
    expect(unreachable).toBeInstanceOf(NetworkError); expect(isBoxLaneTrigger(unreachable)).toBe(true);
  });
  it('delivers each event immediately with no compression or stream lifetime timer', async () => {
    let send: ServerResponse | undefined;
    const { url, server } = await fixture((_req, res) => {
      send = res; res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
      res.write('data: first\n\n');
    });
    const ac = new AbortController();
    const r = await fetch(`${url}/api/channel`, { signal: ac.signal, headers: { 'accept-encoding': 'gzip, br' } });
    expect(r.headers.get('content-encoding')).toBeNull(); expect(r.headers.get('x-accel-buffering')).toBe('no');
    const reader = r.body!.getReader(); expect(Buffer.from((await reader.read()).value!).toString()).toBe('data: first\n\n');
    await delay(100); send!.write('data: second\n\n');
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('data: second\n\n');
    expect(server.timeout).toBe(0); expect(server.requestTimeout).toBe(300_000);
    ac.abort(); await reader.cancel().catch(() => undefined);
  });
  it('an interrupted upload cancels upstream without crashing the server or replaying bytes', async () => {
    let seen = 0, closed = false, received = 0;
    const { url } = await fixture((req, _res) => {
      seen += 1; req.on('data', chunk => { received += chunk.length; });
      req.on('error', () => undefined); req.on('close', () => { closed = true; });
    });
    const request = http.request(`${url}/api/sale`, { method: 'POST', headers: { 'content-length': 1000 } });
    request.on('error', () => undefined); request.write(Buffer.alloc(100));
    await expect.poll(() => received).toBe(100); request.destroy();
    await expect.poll(() => closed).toBe(true); expect(seen).toBe(1);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
  it('cancels upstream before headers and across 100 stream connects/disconnects without keeping sockets', async () => {
    let active = 0, opened = 0;
    const { url, upstream } = await fixture((req, res) => {
      active += 1; opened += 1; res.on('close', () => { active -= 1; });
      if (req.url === '/silent') return;
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n');
    });
    const silent = http.get(`${url}/api/silent`); silent.on('error', () => undefined);
    await expect.poll(() => opened).toBe(1); silent.destroy(); await expect.poll(() => active).toBe(0);
    for (let round = 0; round < 10; round += 1) {
      await Promise.all(Array.from({ length: 10 }, async () => {
        const ac = new AbortController();
        const r = await fetch(`${url}/api/channel`, { signal: ac.signal });
        const reader = r.body!.getReader(); await reader.read(); ac.abort(); await reader.cancel().catch(() => undefined);
      }));
      await expect.poll(() => active).toBe(0);
    }
    expect(opened).toBe(101);
    await expect.poll(() => new Promise<number>((resolve, reject) => upstream.getConnections((err, n) => err ? reject(err) : resolve(n)))).toBe(0);
  });
});

describe('static POS and installed-app files (SCRUM-718)', () => {
  it('uses the SPA only for navigation paths and never for API or missing assets', async () => {
    const { url } = await fixture((_req, res) => { res.writeHead(404); res.end('API not found'); });
    expect((await raw(url, '/today')).body).toContain('ZZ TEST till');
    expect((await raw(url, '/api/missing')).body).toBe('API not found');
    expect((await raw(url, '/assets/gone-12345678.js')).status).toBe(404);
    expect((await raw(url, '/missing.js')).status).toBe(404);
    expect((await raw(url, '/assets/missing')).status).toBe(404);
  });
  it('never caches index or the service worker, caches hashed assets long, and copies live security headers', async () => {
    const { url } = await fixture((_req, res) => res.end());
    for (const path of ['/', '/today', '/index.html', '/sw.js']) {
      const r = await raw(url, path);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['strict-transport-security']).toBe('max-age=315360000; includeSubdomains; preload');
    }
    expect((await raw(url, '/assets/app-12345678.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await raw(url, '/sw.js')).headers['content-type']).toBe('application/javascript');
  });
  it('serves precompressed static bytes, respects rejected encodings and HEAD', async () => {
    const { url } = await fixture((_req, res) => res.end());
    const plain = await raw(url, '/assets/app-12345678.js');
    for (const encoding of ['br', 'gzip']) {
      const r = await raw(url, '/assets/app-12345678.js', { 'accept-encoding': encoding });
      expect(r.headers['content-encoding']).toBe(encoding);
      expect(Number(r.headers['content-length'])).toBeLessThan(Number(plain.headers['content-length']));
    }
    const rejected = await raw(url, '/sw.js', { 'accept-encoding': 'br;q=0, gzip;q=0' });
    expect(rejected.headers['content-encoding']).toBeUndefined();
    const head = await fetch(`${url}/sw.js`, { method: 'HEAD' });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
  });
  it.each(['/../package.json', '/%2e%2e/package.json', '/assets/%2e%2e/%2e%2e/package.json',
    '/assets%2f..%2f..%2fpackage.json', '/%5c..%5cpackage.json', '/.env', '/%00', '/%ZZ'])('refuses traversal or hidden path %s', async path => {
    const { url } = await fixture((_req, res) => res.end());
    expect((await raw(url, path)).status).toBe(400);
  });
  it('refuses a symlink outside the public root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'oto-pos-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'not public');
      await symlink(outside, join(root, 'linked'), 'junction');
      const { url } = await fixture((_req, res) => res.end());
      const r = await raw(url, '/linked/secret.txt'); expect(r.status).toBe(404); expect(r.body).not.toContain('not public');
    } finally { await rm(join(root, 'linked'), { force: true, recursive: true }); await rm(outside, { recursive: true, force: true }); }
  });
  it('refuses upstream credentials, paths and non-HTTP destinations', () => {
    for (const apiUpstream of ['ftp://example.com', 'http://user:pass@example.com', 'http://example.com/path', 'http://example.com/?query']) {
      expect(() => createPosServer({ root, apiUpstream })).toThrow(/API_UPSTREAM/);
    }
  });
});
