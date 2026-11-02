import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { serveStatic } from './static.js';

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Keep application headers (including repeated Set-Cookie) separate. */
function endToEndHeaders(message: IncomingMessage, omit: string[] = []): string[] {
  const excluded = new Set([...HOP_HEADERS, ...omit,
    ...(message.headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())]);
  const headers: string[] = [];
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    const name = message.rawHeaders[i]!;
    if (!excluded.has(name.toLowerCase())) headers.push(name, message.rawHeaders[i + 1]!);
  }
  return headers;
}

function unavailable(res: ServerResponse): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  // This is an API failure, not a lost internet connection. In lane.ts a
  // 502 remains ApiError; only a real network failure/forced-offline switches.
  res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE',
    message: 'The platform is temporarily unavailable. Please try again.' } }));
}

export interface PosServerOptions {
  root: string;
  apiUpstream: string;
}

/** A static host and byte forwarder. No session, pricing or retry middleware. */
export function createPosServer({ root, apiUpstream }: PosServerOptions): http.Server {
  let upstream: URL;
  try { upstream = new URL(apiUpstream); }
  catch { throw new Error('API_UPSTREAM must be a valid HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password
    || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('API_UPSTREAM must be an HTTP(S) origin without credentials, path or query');
  }
  const transport = upstream.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16, scheduling: 'lifo' });

  const server = http.createServer((req, res) => {
    const target = req.url ?? '/';
    if (!target.startsWith('/') || target.startsWith('//')) {
      res.writeHead(400); res.end(); return;
    }
    const path = target.split('?')[0];
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : '{"ok":true}'); return;
    }
    if (path !== '/api' && !target.startsWith('/api/')) {
      void serveStatic(req, res, root).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'cache-control': 'no-store' });
        res.end();
      });
      return;
    }

    const headers = endToEndHeaders(req, ['host', 'x-forwarded-for']);
    // Host names the upstream just as the old rewrite did. Origin, Cookie and
    // Authorization are untouched. Append the observed peer; never choose the
    // leftmost, caller-supplied address. The API's address allow-list decides trust.
    headers.push('Host', upstream.host, 'X-Forwarded-For',
      [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', '));
    if (!req.headers['x-forwarded-proto']) headers.push('X-Forwarded-Proto', 'http');
    const upstreamPath = target.slice(4);
    let active: http.ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let gone = false;
    let retried = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cancel = (): void => {
      gone = true;
      clearTimeout(timer);
      active?.destroy(); response?.destroy();
    };
    req.once('aborted', cancel);
    req.once('error', cancel);
    res.once('close', () => { if (!res.writableFinished) cancel(); });

    const forward = (retry = false): void => {
      // Writes never inherit an idle connection that the API may be closing.
      // Fresh private-network connections cost about 1 ms in the staging check;
      // safe reads retain the pool and the narrowly bounded stale-GET retry.
      const pooled = ['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
      const outgoing = transport.request(upstream, { agent: pooled ? agent : false, method: req.method, headers,
        path: upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}` });
      active = outgoing;
      let loggedFailure = false;
      const logFailure = (error: NodeJS.ErrnoException): void => {
        if (gone || loggedFailure) return;
        loggedFailure = true;
        // An allow-list, not a serialized request/error: no query, authority,
        // headers, body or free-form error message may enter this line.
        console.error(JSON.stringify({ event: 'pos_upstream_failure', method: req.method ?? 'GET',
          path: upstreamPath.split('?')[0] || '/',
          code: error.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'UPSTREAM_ERROR',
          reusedSocket: outgoing.reusedSocket }));
      };
      // Bound only DNS/connect/agent queue time. Once connected, the API owns
      // completion: a new response deadline could cut off an in-flight sale.
      timer = setTimeout(() => {
        outgoing.destroy(Object.assign(new Error('Upstream connection timeout'), { code: 'ETIMEDOUT' }));
      }, 30_000);
      timer.unref();
      outgoing.once('socket', socket => {
        if (!socket.connecting) clearTimeout(timer);
        else socket.once(upstream.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(timer));
      });
      outgoing.once('response', incoming => {
        clearTimeout(timer);
        response = incoming;
        if (gone) { incoming.destroy(); return; }
        const responseHeaders = endToEndHeaders(incoming);
        if (incoming.headers['content-type']?.startsWith('text/event-stream')) {
          responseHeaders.push('X-Accel-Buffering', 'no');
        }
        res.writeHead(incoming.statusCode ?? 502, responseHeaders);
        res.flushHeaders();
        incoming.once('error', (error: NodeJS.ErrnoException) => { logFailure(error); res.destroy(); });
        incoming.pipe(res); // Backpressure, no body parsing, buffering or compression.
      });
      outgoing.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (gone) return;
        logFailure(error);
        // Only a bodyless GET on a stale kept-alive socket, once, before any
        // response. In particular POST/PATCH/DELETE/PUT are NEVER replayed.
        if (!retried && req.method === 'GET' && outgoing.reusedSocket && error.code === 'ECONNRESET'
          && !response && !req.headers['transfer-encoding']
          && (!req.headers['content-length'] || req.headers['content-length'] === '0')) {
          retried = true; forward(true); return;
        }
        unavailable(res);
      });
      if (retry) outgoing.end();
      else req.pipe(outgoing);
    };
    forward();
  });
  // These timers concern receipt of a request, not the lifetime of its response.
  server.headersTimeout = 60_000;
  server.requestTimeout = 300_000;
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;
  server.once('close', () => agent.destroy());
  return server;
}
