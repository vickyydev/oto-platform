import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  BridgeUnlockRequestSchema,
  STATION_BRIDGE_BASE,
  STATION_VIEWS,
  StationIntentSchema,
} from '@oto/shared';
import type { BoxAgent } from '../agent';
import type { StationChannelMessage, StationView } from '../contract';
import {
  BridgeError,
  type BridgeCaller,
  type BridgeTillCaller,
  type StationBridge,
} from '../station-bridge';
import { silentLog, type AgentLog } from '../transport';

/**
 * THE STATION BRIDGE ON A RASPBERRY PI (offline plan §2.2, Round 3).
 *
 * The same `/box/v1/station/:stationId/*` contract the api mounts for a
 * virtual box, served by the agent on LOOPBACK and published on the counter's
 * LAN by Caddy with the box's own certificate (`scripts/pi/Caddyfile`). The
 * kiosk server next door stays loopback-only and is not touched: this is a
 * second listener with its own rules.
 *
 *   - **Loopback only.** The one caller that reaches it is Caddy on the same
 *     machine; a request from anywhere else is refused before it is read.
 *   - **Origins.** A till is a web page served from the POS's own origin, so a
 *     request naming any other origin is refused, and the answers carry CORS
 *     for the allowed ones — with the Private Network Access preflight a
 *     browser asks before a public page may call a private address.
 *   - **Credentials.** A box session (`Authorization: Bearer bs_…`) issued at
 *     unlock, or a paired display's credential checked against the hashes in
 *     the box's `station_config` scope. `status` needs neither: it names no
 *     person, and a locked till reads it to decide how to unlock.
 *
 * Every decision is the bridge's (`station-bridge.ts`); this file only turns
 * HTTP into calls on it, as `apps/api/src/routes/station-bridge.ts` does for
 * the api.
 */

/** Where the bridge listens on the box. Caddy's `reverse_proxy` names it. */
export const BRIDGE_DEFAULT_PORT = 8471;

/**
 * The largest body the bridge reads. A cart with fifty lines is a few KB; the
 * largest thing a till sends is a photo taken with the link down (S2-13 round
 * 4, `photo.capture`): at most `OFFLINE_PHOTO_POLICY.maxPhotoBytes` (400 KB)
 * as base64 in a data URL, so a little over 540 KB.
 */
const MAX_BODY_BYTES = 768 * 1024;

/** How long a channel may sit silent before a comment line keeps it open. */
const CHANNEL_KEEPALIVE_MS = 25_000;

export interface BridgeServerOptions {
  /** The agent running now; the runner swaps it when the store comes back. */
  agent: () => BoxAgent | null;
  /** The POS origins a till's page is served from, e.g. `https://oto-pos.onrender.com`. */
  origins: readonly string[];
  port?: number;
  log?: AgentLog;
}

export interface BridgeServer {
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
  /** The handler, for a test that drives it without a socket. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES)
      throw new Refusal(413, 'BODY_TOO_LARGE', 'That request is too large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Refusal(400, 'VALIDATION', 'The body is not JSON');
  }
}

export function createBridgeServer(options: BridgeServerOptions): BridgeServer {
  const log = options.log ?? silentLog;
  const allowed = new Set(options.origins.map((o) => o.trim().replace(/\/$/, '')).filter(Boolean));
  let server: Server | null = null;

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = header(req, 'origin');
    if (!origin) return;
    res.setHeader('access-control-allow-origin', origin.replace(/\/$/, ''));
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      'authorization, content-type, x-oto-action-id, idempotency-key',
    );
    res.setHeader('access-control-max-age', '600');
    // Private Network Access: a page on a public origin asks before it may call
    // a private address, and is answered here rather than blocked.
    if (header(req, 'access-control-request-private-network') === 'true') {
      res.setHeader('access-control-allow-private-network', 'true');
    }
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    const bytes = Buffer.from(JSON.stringify(body));
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('content-length', String(bytes.length));
    res.end(bytes);
  }

  function refuse(res: ServerResponse, err: Refusal | BridgeError): void {
    send(res, err.status, {
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  function bearerOf(req: IncomingMessage): string | null {
    return /^Bearer (\S+)$/i.exec(header(req, 'authorization') ?? '')?.[1] ?? null;
  }

  async function till(
    bridge: StationBridge,
    stationId: string,
    req: IncomingMessage,
  ): Promise<BridgeTillCaller> {
    const caller = await bridge.authenticate(stationId, bearerOf(req));
    if (!caller) {
      throw new Refusal(401, 'BOX_SESSION_REQUIRED', 'Unlock this till on its box first');
    }
    return caller;
  }

  async function display(
    bridge: StationBridge,
    stationId: string,
    req: IncomingMessage,
  ): Promise<BridgeCaller> {
    const caller = await bridge.displayCaller(stationId, bearerOf(req));
    if (!caller)
      throw new Refusal(401, 'DISPLAY_UNPAIRED', 'This screen is not paired to this station');
    return caller;
  }

  function viewOf(url: URL): StationView {
    const view = url.searchParams.get('view') ?? 'staff';
    return (STATION_VIEWS as readonly string[]).includes(view) ? (view as StationView) : 'staff';
  }

  function channel(
    req: IncomingMessage,
    res: ServerResponse,
    attach: (send: (message: StationChannelMessage) => void) => () => void,
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    const write = (message: StationChannelMessage): void => {
      if (!closed) res.write(`event: ${message.kind}\ndata: ${JSON.stringify(message)}\n\n`);
    };
    const keepalive = setInterval(() => {
      if (!closed) res.write(`: ${new Date().toISOString()}\n\n`);
    }, CHANNEL_KEEPALIVE_MS);
    keepalive.unref?.();
    let detach: (() => void) | null = null;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      detach?.();
      res.end();
    };
    res.on('close', finish);
    res.on('error', finish);
    req.on('aborted', finish);
    detach = attach(write);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopback(req.socket.remoteAddress)) {
        throw new Refusal(
          403,
          'LOOPBACK_ONLY',
          'This bridge is published by the box’s own proxy only',
        );
      }
      const origin = header(req, 'origin');
      if (origin && !allowed.has(origin.replace(/\/$/, ''))) {
        throw new Refusal(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
      }
      cors(req, res);
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://bridge.invalid');
      const prefix = `${STATION_BRIDGE_BASE}/`;
      if (!url.pathname.startsWith(prefix)) throw new Refusal(404, 'NOT_FOUND', 'No such route');
      const [stationId, ...restParts] = url.pathname.slice(prefix.length).split('/');
      const rest = restParts.join('/');
      if (!stationId || !/^[0-9a-f-]{36}$/i.test(stationId)) {
        throw new Refusal(404, 'NOT_FOUND', 'No such station');
      }
      const agent = options.agent();
      const bridge = agent?.bridge() ?? null;
      if (!bridge)
        throw new Refusal(503, 'BOX_NOT_READY', 'This box is starting — try again in a moment');
      const actionId = header(req, 'x-oto-action-id') ?? null;
      const route = `${method} ${rest}`;

      switch (route) {
        case 'GET status':
          return send(res, 200, await bridge.status(stationId));
        case 'POST unlock': {
          const body = BridgeUnlockRequestSchema.safeParse(await readBody(req));
          if (!body.success) throw new Refusal(400, 'VALIDATION', 'That unlock could not be read');
          const answer = await bridge.unlock(stationId, body.data);
          return send(res, 200, answer.response);
        }
        case 'POST lock':
          return send(res, 200, { ended: bridge.end(bearerOf(req)) });
        case 'GET session': {
          const caller = await till(bridge, stationId, req);
          const snapshot = await bridge.session(stationId, caller, viewOf(url));
          return send(res, 200, {
            view: snapshot.view,
            document: snapshot.document,
            serverTime: snapshot.serverTime,
          });
        }
        case 'GET channel': {
          const caller = await till(bridge, stationId, req);
          const view = viewOf(url);
          const first = await bridge.session(stationId, caller, view);
          return channel(req, res, (write) => {
            write(first);
            return bridge.subscribe(stationId, caller, view, write);
          });
        }
        case 'POST lease': {
          const caller = await till(bridge, stationId, req);
          const body = (await readBody(req)) as { holder?: unknown };
          if (typeof body.holder !== 'string' || !body.holder || body.holder.length > 64) {
            throw new Refusal(400, 'VALIDATION', 'A lease needs a holder');
          }
          const result = await bridge.claim(stationId, caller, body.holder, actionId);
          return send(res, 200, {
            lease: result.lease,
            takenOver: result.takenOver,
            document: result.document,
          });
        }
        case 'POST lease/renew': {
          const caller = await till(bridge, stationId, req);
          const body = (await readBody(req)) as { leaseId?: unknown };
          if (typeof body.leaseId !== 'string')
            throw new Refusal(400, 'VALIDATION', 'Name the lease');
          const result = await bridge.renew(stationId, caller, body.leaseId);
          return send(res, 200, {
            lease: result.lease,
            takenOver: false,
            document: result.document,
          });
        }
        case 'POST lease/release': {
          const caller = await till(bridge, stationId, req);
          const body = (await readBody(req)) as { leaseId?: unknown };
          if (typeof body.leaseId !== 'string')
            throw new Refusal(400, 'VALIDATION', 'Name the lease');
          const result = await bridge.release(stationId, caller, body.leaseId, actionId);
          return send(res, 200, { released: result.ok && result.released });
        }
        case 'GET members/lookup': {
          const caller = await till(bridge, stationId, req);
          const member = await bridge.lookup(
            stationId,
            caller,
            url.searchParams.get('phone') ?? '',
          );
          return send(res, 200, { member });
        }
        case 'POST intents': {
          const caller = await till(bridge, stationId, req);
          const intent = StationIntentSchema.safeParse(await readBody(req));
          if (!intent.success)
            throw new Refusal(400, 'VALIDATION', 'That intent could not be read');
          const answer = await bridge.intent(stationId, caller, {
            ...intent.data,
            actionId: intent.data.actionId ?? actionId ?? undefined,
          });
          return send(res, 200, answer);
        }
        case 'GET display/session': {
          const caller = await display(bridge, stationId, req);
          const station = bridge.station(stationId);
          const snapshot = await bridge.session(stationId, caller, 'customer');
          return send(res, 200, {
            station: { id: station.id, name: station.name, kind: station.kind },
            device: {
              id: caller.kind === 'display' ? caller.credentialId : '',
              name: 'Customer display',
            },
            document: snapshot.document,
          });
        }
        case 'POST display/intents': {
          const caller = await display(bridge, stationId, req);
          const intent = StationIntentSchema.safeParse(await readBody(req));
          if (!intent.success)
            throw new Refusal(400, 'VALIDATION', 'That intent could not be read');
          const answer = await bridge.intent(stationId, caller, {
            ...intent.data,
            leaseId: undefined,
          });
          return send(res, 200, { document: answer.document });
        }
        default:
          throw new Refusal(404, 'NOT_FOUND', 'No such route');
      }
    } catch (err) {
      if (err instanceof Refusal || err instanceof BridgeError) return refuse(res, err);
      log.error({ module: 'bridge', err: String(err) }, 'a bridge request failed');
      if (!res.headersSent)
        send(res, 500, { error: { code: 'INTERNAL', message: 'The box could not answer that' } });
      else res.end();
    }
  }

  return {
    handle,
    async listen() {
      const port = options.port ?? BRIDGE_DEFAULT_PORT;
      server = createServer((req, res) => {
        void handle(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      log.info({ module: 'bridge', port: bound }, 'the station bridge is listening on loopback');
      return { port: bound };
    },
    async close() {
      const held = server;
      server = null;
      if (!held) return;
      await new Promise<void>((resolve) => held.close(() => resolve()));
    },
  };
}
