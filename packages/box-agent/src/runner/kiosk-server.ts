/**
 * The booth box's own web server, for the television plugged into it
 * (SCRUM-223).
 *
 * A Raspberry Pi under a booth television serves two things on one loopback
 * port: the booth page itself (the built `apps/booth`), and the `/booth/*`
 * contract that page calls — which is `createBoothHttp`, the very function the
 * api mounts for the virtual box, so the page in a mall and the page in the
 * staging demo are answered by the same code. Chromium in kiosk mode opens
 * `http://127.0.0.1:8780/` and never learns another address.
 *
 * **Why the page is trusted, and what that rests on.** On staging a screen has
 * to be PAIRED before the api will draw for it, because the api is on the
 * internet. Here the page and the box are the same machine, so there is no
 * pairing: the trust boundary is the Pi itself. That holds only while nothing
 * else can reach this port, which is why:
 *
 *  - it binds to loopback and refuses to be told otherwise (`listen`);
 *  - it refuses any peer that is not loopback, belt and braces for a socket
 *    somebody bound elsewhere;
 *  - it refuses a `Host` that is not this machine by name, which is what stops
 *    a web page elsewhere from reaching it through DNS rebinding;
 *  - a write must be `application/json` from this origin, so another site open
 *    in a browser on the Pi cannot send one without a preflight nobody answers.
 *
 * Three routes of its own sit beside the contract, under `/kiosk/`: the state
 * the page needs before there is a booth to talk to (registered? which booths?),
 * the claim code a person types on first boot, and the booth the picker chose.
 * Plus `/kiosk/health`, which the systemd watchdog timer asks.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import {
  BOOTH_ACTION_HEADER,
  BOOTH_IDEMPOTENCY_HEADER,
  type BoothHttpRequest,
  type BoothHttpResponse,
} from '../booth-http';
import { silentLog, type AgentLog } from '../transport';

/** The port the kiosk opens. `OTO_BOX_PORT` or `--port` moves it. */
export const KIOSK_DEFAULT_PORT = 8780;

/**
 * The `<meta>` the page reads to know it was served by a box (SCRUM-223).
 *
 * The build ships it as `paired`; this server rewrites it to `box` on the way
 * out. That is how the page decides between "claim this box, pick a booth"
 * and "pair this screen", from how it was loaded rather than from a build
 * flag, so one build serves both the Pi and the staging site.
 */
export const KIOSK_HOST_META = 'oto-booth-host';

/** A request body larger than this is not something the booth page sends. */
const MAX_BODY_BYTES = 16 * 1024;

export interface KioskBoothSummary {
  stationId: string;
  name: string;
  codePrefix: string | null;
}

/** `GET /kiosk/state` — what the page needs before it can show a wheel. */
export interface KioskState {
  /** Whether this box holds a credential. False: the page asks for a claim code. */
  registered: boolean;
  /** Whether the box has the cloud right now. */
  online: boolean;
  /** The booth stations on this box, from its config bundle. */
  booths: KioskBoothSummary[];
  /** The one this box runs: the picker's choice, or the only one there is. */
  selectedStationId: string | null;
  agentVersion: string;
}

export type KioskClaimOutcome =
  | { ok: true }
  | { ok: false; reason: 'refused' | 'unreachable' | 'already_registered' | 'invalid' };

export type BoothHandler = (request: BoothHttpRequest) => Promise<BoothHttpResponse>;

export interface KioskServerOptions {
  port: number;
  /** Loopback only. Anything else is refused at `listen`. */
  host?: string;
  /** The built booth page (`apps/booth/dist/public`), or null when it is not installed. */
  pageDir: string | null;
  /** The `/booth/*` contract for the booth this box runs, or null when there is none yet. */
  booth: () => BoothHandler | null;
  state: () => Promise<KioskState>;
  claim: (code: string) => Promise<KioskClaimOutcome>;
  selectBooth: (stationId: string) => Promise<boolean>;
  log?: AgentLog;
}

export interface KioskServer {
  readonly server: Server;
  /** Bind, and resolve with where. */
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
  /** The request handler, for a test that drives it without a socket. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

class RequestProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createKioskServer(options: KioskServerOptions): KioskServer {
  const log = options.log ?? silentLog;
  const host = options.host ?? '127.0.0.1';
  const pageRoot = options.pageDir ? resolve(options.pageDir) : null;

  /** `127.0.0.1:8780`, `localhost:8780`, `[::1]:8780` — this machine, by name. */
  function hostAllowed(value: string | undefined): boolean {
    if (!value) return false;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value.trim().toLowerCase());
    if (!match) return false;
    const name = match[1]!.replace(/^\[|\]$/g, '');
    const port = match[2] === undefined ? 80 : Number(match[2]);
    return LOOPBACK_HOSTS.has(name) && port === boundPort();
  }

  function originAllowed(value: string | undefined): boolean {
    if (value === undefined) return true;
    try {
      const origin = new URL(value);
      return (
        origin.protocol === 'http:' &&
        LOOPBACK_HOSTS.has(origin.hostname.replace(/^\[|\]$/g, '')) &&
        Number(origin.port || 80) === boundPort()
      );
    } catch {
      return false;
    }
  }

  let bound: AddressInfo | null = null;
  function boundPort(): number {
    return bound?.port ?? options.port;
  }

  function send(res: ServerResponse, status: number, body?: unknown): void {
    res.statusCode = status;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (body === undefined) {
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }

  function refuse(res: ServerResponse, status: number, code: string, message: string): void {
    send(res, status, { error: { code, message } });
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const type = String(req.headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(type)) {
      throw new RequestProblem(415, 'json_only', 'Send application/json');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      size += piece.length;
      if (size > MAX_BODY_BYTES) throw new RequestProblem(413, 'too_large', 'That request is too large');
      chunks.push(piece);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text === '') return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RequestProblem(400, 'bad_json', 'That request is not JSON');
    }
  }

  function headerValue(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return typeof value === 'string' ? value : undefined;
  }

  async function serveBooth(
    req: IncomingMessage,
    res: ServerResponse,
    subPath: string,
    method: string,
  ): Promise<void> {
    const handler = options.booth();
    if (!handler) {
      // Registered or not, there is no booth to answer for yet: the page's
      // own "not set up" screen is the right one.
      refuse(res, 409, 'not_configured', 'This box is not running a booth yet');
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readJson(req);
    const answer = await handler({
      method,
      path: subPath === '' ? '/' : subPath,
      body,
      headers: {
        [BOOTH_IDEMPOTENCY_HEADER]: headerValue(req, BOOTH_IDEMPOTENCY_HEADER),
        [BOOTH_ACTION_HEADER]: headerValue(req, BOOTH_ACTION_HEADER),
      },
    });
    send(res, answer.status, answer.body);
  }

  async function serveKiosk(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
    method: string,
  ): Promise<void> {
    if (route === '/kiosk/health') {
      if (method !== 'GET' && method !== 'HEAD') return refuse(res, 405, 'method_not_allowed', 'Use GET');
      return send(res, 200, { ok: true });
    }
    if (route === '/kiosk/state') {
      if (method !== 'GET') return refuse(res, 405, 'method_not_allowed', 'Use GET');
      return send(res, 200, await options.state());
    }
    if (route === '/kiosk/claim') {
      if (method !== 'POST') return refuse(res, 405, 'method_not_allowed', 'Use POST');
      const body = (await readJson(req)) as { code?: unknown } | null;
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      // Shaped like the Console's claim codes; the cloud is what decides.
      if (!/^[A-Za-z0-9-]{6,64}$/.test(code)) return send(res, 200, { ok: false, reason: 'invalid' });
      return send(res, 200, await options.claim(code));
    }
    if (route === '/kiosk/booth') {
      if (method !== 'POST') return refuse(res, 405, 'method_not_allowed', 'Use POST');
      const body = (await readJson(req)) as { stationId?: unknown } | null;
      const stationId = typeof body?.stationId === 'string' ? body.stationId : '';
      if (!(await options.selectBooth(stationId))) {
        return refuse(res, 404, 'no_such_booth', 'That booth is not on this box');
      }
      return send(res, 200, { ok: true });
    }
    return refuse(res, 404, 'not_found', 'No such route on this box');
  }

  async function serveStatic(res: ServerResponse, route: string, method: string): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') return refuse(res, 405, 'method_not_allowed', 'Use GET');
    if (!pageRoot) {
      res.statusCode = 503;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end('The booth page is not installed beside this box agent.');
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(route);
    } catch {
      return refuse(res, 400, 'bad_path', 'That path is not readable');
    }
    if (relative.includes('\0')) return refuse(res, 400, 'bad_path', 'That path is not readable');
    const wanted = relative === '/' ? '/index.html' : relative;
    const file = resolve(pageRoot, `.${wanted}`);
    // Never a file outside the page's own folder, however the path is spelled.
    if (file !== pageRoot && !file.startsWith(pageRoot + sep)) {
      return refuse(res, 404, 'not_found', 'No such file');
    }
    let target = file;
    const found = await stat(file).catch(() => null);
    if (!found || !found.isFile()) {
      // A route the page draws itself is the page; a missing asset is a 404.
      if (extname(wanted) !== '') return refuse(res, 404, 'not_found', 'No such file');
      target = resolve(pageRoot, 'index.html');
    }
    const isIndex = target === resolve(pageRoot, 'index.html');
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch {
      return refuse(res, 404, 'not_found', 'No such file');
    }
    if (isIndex) bytes = Buffer.from(markServedByBox(bytes.toString('utf8')), 'utf8');
    res.statusCode = 200;
    res.setHeader('content-type', CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    // Vite fingerprints everything under /assets/; the page itself must never
    // be cached, or an update would leave the television on the old one.
    res.setHeader(
      'cache-control',
      !isIndex && wanted.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    res.setHeader('content-length', String(bytes.length));
    res.end(method === 'HEAD' ? undefined : bytes);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopbackPeer(req.socket.remoteAddress)) {
        log.warn({ module: 'kiosk' }, 'a request from off the box was refused');
        return refuse(res, 403, 'loopback_only', 'This box answers only itself');
      }
      if (!hostAllowed(headerValue(req, 'host'))) {
        return refuse(res, 403, 'host_not_allowed', 'This box answers only by its own name');
      }
      const method = (req.method ?? 'GET').toUpperCase();
      const url = new URL(req.url ?? '/', 'http://kiosk.invalid');
      const route = url.pathname;
      const writes = method !== 'GET' && method !== 'HEAD';
      if (writes) {
        if (!originAllowed(headerValue(req, 'origin'))) {
          return refuse(res, 403, 'origin_not_allowed', 'This box takes writes from its own page only');
        }
        const site = headerValue(req, 'sec-fetch-site');
        if (site !== undefined && site !== 'same-origin' && site !== 'none') {
          return refuse(res, 403, 'origin_not_allowed', 'This box takes writes from its own page only');
        }
      }
      if (route === '/booth' || route.startsWith('/booth/')) {
        return await serveBooth(req, res, route.slice('/booth'.length), method);
      }
      if (route.startsWith('/kiosk/')) return await serveKiosk(req, res, route, method);
      return await serveStatic(res, route, method);
    } catch (err) {
      if (err instanceof RequestProblem) return refuse(res, err.status, err.code, err.message);
      log.error({ module: 'kiosk', err: String(err) }, 'a kiosk request failed');
      if (!res.headersSent) refuse(res, 500, 'internal', 'The box could not answer that');
      else res.end();
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  // Short: the only caller is a browser on the same machine.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  return {
    server,
    handle,
    listen() {
      if (!LOOPBACK_HOSTS.has(host)) {
        return Promise.reject(
          new Error(`The kiosk server binds to loopback only; ${host} is not loopback`),
        );
      }
      return new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(options.port, host, () => {
          server.off('error', rejectListen);
          bound = server.address() as AddressInfo;
          resolveListen(bound);
        });
      });
    },
    close() {
      return new Promise((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * Tell the page it was served by a box: the build's `paired` marker becomes
 * `box`, and a page built before the marker existed has one added.
 */
export function markServedByBox(html: string): string {
  const marker = new RegExp(`<meta\\s+name="${KIOSK_HOST_META}"\\s+content="[^"]*"\\s*/?>`, 'i');
  const tag = `<meta name="${KIOSK_HOST_META}" content="box" />`;
  if (marker.test(html)) return html.replace(marker, tag);
  return html.replace(/<head>/i, `<head>\n    ${tag}`);
}
