import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BoxAgent } from '../agent';
import { BOX_AGENT_BUILD } from '../build';
import { BridgeError } from '../station-bridge';
import { createBridgeServer } from './bridge-server';

/** Paired-display routes only, behind the kiosk's loopback/Host/Origin guards. */
export function createLocalDisplayHttp(options: {
  agent: () => BoxAgent | null;
  apiBaseUrl: string;
  origins: readonly string[];
  fetch?: typeof fetch;
}) {
  // Reuse the existing credential, redaction, intent and SSE implementation.
  // This handler never listens; the LAN bridge keeps its own POS-only allow-list.
  const bridgeHttp = createBridgeServer({ agent: options.agent, origins: options.origins });
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const refuse = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://display.invalid').pathname;
    if (method === 'GET' && path === '/api/display/version') return send(res, 200, { build: BOX_AGENT_BUILD.id });
    const scoped = /^\/api\/box\/v1\/station\/[0-9a-f-]{36}\/display\/(session|channel|intents)$/.exec(path);
    if (scoped && ((method === 'GET' && scoped[1] !== 'intents') || (method === 'POST' && scoped[1] === 'intents'))) {
      const previous = req.url;
      try { req.url = path.slice(4); return await bridgeHttp.handle(req, res); }
      finally { req.url = previous; }
    }
    const pairing = (path === '/api/display/pairing' && (method === 'GET' || method === 'POST'))
      || (path === '/api/display/pairing/expire' && method === 'POST');
    if (!pairing && !(path === '/api/display/session' && method === 'GET')) return refuse(res, 404, 'NOT_FOUND', 'No such display route');
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!bearer) return refuse(res, 401, 'DISPLAY_UNPAIRED', 'This screen is not paired');
    const agent = options.agent();
    const bridge = agent?.bridge();
    if (!agent || !bridge) return refuse(res, 503, 'BOX_NOT_READY', 'This box is starting. Try again in a moment.');
    try {
      if (method === 'GET') {
        for (const station of agent.config()?.stations ?? []) {
          const caller = await bridge.displayCaller(station.id, bearer);
          if (!caller) continue;
          if (path.endsWith('/pairing')) return send(res, 200, { status: 'paired', station: { id: station.id, name: station.name, kind: station.kind }, device: { id: caller.kind === 'display' ? caller.credentialId : '', name: 'Customer display' } });
          const previous = req.url;
          try { req.url = `/box/v1/station/${station.id}/display/session`; return await bridgeHttp.handle(req, res); }
          finally { req.url = previous; }
        }
        if (!pairing) return refuse(res, 401, 'DISPLAY_UNPAIRED', 'This screen is not paired to this box');
      }
      // Initial pairing/expiry still belongs to the platform. This fixed route
      // forwards only the existing display credential; no staff cookie, box
      // secret, arbitrary destination or automatic write retry is involved.
      if (method === 'POST') {
        if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') return refuse(res, 415, 'JSON_REQUIRED', 'Use JSON');
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          const value = Buffer.from(chunk); bytes += value.length;
          if (bytes > 1024) return refuse(res, 413, 'BODY_TOO_LARGE', 'That request is too large');
          chunks.push(value);
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return refuse(res, 400, 'VALIDATION', 'Pairing takes an empty JSON object');
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, 8_000);
      req.once('aborted', abort); res.once('close', abort);
      try {
        const response = await (options.fetch ?? fetch)(`${options.apiBaseUrl.replace(/\/$/, '')}${path.slice(4)}`, {
          method, redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${bearer}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        const answer = await response.json() as { status?: string; station?: { id?: string } };
        if (response.ok && answer.status === 'paired') {
          const here = agent.config()?.stations.some(s => s.id === answer.station?.id);
          return refuse(res, here ? 503 : 403, here ? 'DISPLAY_CONFIG_PENDING' : 'DISPLAY_WRONG_BOX',
            here ? 'The box is waiting for this display pairing. Try again in a moment.' : 'Pair this screen to a station on this box.');
        }
        return send(res, response.status, answer);
      } finally { clearTimeout(timer); req.off('aborted', abort); res.off('close', abort); }
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof BridgeError) return refuse(res, error.status, error.code, error.message);
      if (error instanceof SyntaxError) return refuse(res, 400, 'VALIDATION', 'That request is not JSON');
      return refuse(res, 503, 'DISPLAY_UNAVAILABLE', 'Pairing needs the internet. An already paired display can work from this box.');
    }
  };
}
