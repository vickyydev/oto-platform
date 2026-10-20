import { ASSISTANT_TOOLS } from '@oto/shared';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../../plugins/session';

/**
 * THE ONE SANCTIONED IN-PROCESS REQUEST (SCRUM-591, round I2; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §B.2, R4).
 *
 * The internal assistant reads the platform AS THE PERSON WHO ASKED: each
 * tool call is the screen's own GET route, run through the whole Fastify
 * lifecycle with the asker's own `oto_session` cookie and nothing else. So
 * the session is re-resolved from its token on every call (a sign-out, an
 * expiry, a deactivated account or an archived park refuse the next call),
 * the route's declared guard runs, the handler's own permission check runs,
 * and the service's record fences run — exactly what a screen gets. No
 * credential of the assistant's own exists: nothing is minted, stored or
 * elevated.
 *
 * Calling the services directly with the asker's `AuthContext` was rejected
 * (§B.2): it skips the declared guard and every check written in a handler,
 * which is exactly how an assistant would come to see what a screen cannot.
 *
 * THE RULES OF THIS FILE, each pinned by `assistant-engine.test.ts`:
 *   - It is the only production file that calls `app.inject` (the census).
 *   - GET only. A route template that is not `GET /…` is refused when the
 *     registry is built (`assertGetRoute`), and the method below is a literal.
 *   - The URL comes from a tool adapter, built from arguments validated by the
 *     tool's own schema, and it must match one of that tool's declared route
 *     templates (`matchesRoute`) — the model never supplies a URL, a method,
 *     a header or a host.
 *   - The request carries the asker's session cookie and a request id
 *     (`<ask request id>.t<seq>`, so the tool call's log line and any denial
 *     audit row correlate with the ask) — no other header, no other cookie.
 *   - The token lives in the caller's local variable for one ask. It is never
 *     logged, stored or returned, and nothing here reads a response header.
 *   - A call is held to the ask's remaining wall time (`timeoutMs`): a route
 *     that stalls past it is a `PlatformCallTimeout`, which the engine records
 *     and the loop closes as WALL_TIME. The in-process GET finishing later is
 *     harmless: nothing reads its answer.
 */

/** A route template as the registry names it: `GET /members/lookup`. */
export type GetRouteTemplate = `GET /${string}`;

export interface PlatformResponse {
  status: number;
  /** The parsed JSON body, or null when it was not JSON. */
  body: unknown;
  /** Size of the response body in bytes. */
  bytes: number;
}

export interface PlatformCall {
  /** The asker's own session token, from the ask request's cookie. */
  token: string;
  /** The ask request's id; the tool call's id is this plus `.t<seq>`. */
  requestId: string;
  seq: number;
  /** A tool that reads two routes (`me.whoami`) calls the second as part 1: `.t<seq>b`. */
  part?: number;
  /** Built by the adapter from validated input. */
  url: string;
  /** The tool's declared route templates: the URL must be one of them. */
  routes: readonly GetRouteTemplate[];
  /**
   * The ask's remaining wall time: the route must answer within it or the
   * call is a `PlatformCallTimeout`. Absent, the call waits for the route.
   */
  timeoutMs?: number;
}

/** The route did not answer within the ask's remaining wall time. Carries no body. */
export class PlatformCallTimeout extends Error {
  constructor() {
    super('a tool route did not answer within the ask’s wall time');
    this.name = 'PlatformCallTimeout';
  }
}

/** Refuses, at registry build, a route that is not a GET. */
export function assertGetRoute(tool: string, route: string): asserts route is GetRouteTemplate {
  if (!/^GET \/[A-Za-z0-9_:./-]*$/.test(route)) {
    throw new TypeError(`assistant tool ${tool}: ${route} is not a GET route template — Phase 3 has no write tools`);
  }
}

/** Every registry route as path segments: the sibling rule in `matchesRoute` reads them. */
const REGISTRY_PATHS: readonly (readonly string[])[] = ASSISTANT_TOOLS.flatMap((t) =>
  t.routes.map((r) => r.slice('GET '.length).split('/')),
);

/**
 * The literal segments any registry route has at position `i` under the same
 * prefix as `parts`: what a `:param` there may not equal. `/members/lookup`
 * is the register's own route, never "the member whose id is lookup".
 */
function literalSiblings(parts: readonly string[], i: number): Set<string> {
  const out = new Set<string>();
  for (const other of REGISTRY_PATHS) {
    if (other.length <= i) continue;
    if (!parts.slice(0, i).every((p, j) => p === other[j])) continue;
    const seg = other[i]!;
    if (!seg.startsWith(':')) out.add(seg);
  }
  return out;
}

/**
 * Whether a URL's path is an instance of a route template: a `:param` is one
 * plain path segment — no percent-encoding (an encoded slash is still a
 * slash to a decoder downstream), no dot segments, and not a literal segment
 * a sibling registry route has at that position.
 */
export function matchesRoute(url: string, route: GetRouteTemplate): boolean {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const template = route.slice('GET '.length);
  const parts = template.split('/');
  const segments = path.split('/');
  if (parts.length !== segments.length) return false;
  return parts.every((p, i) => {
    const seg = segments[i]!;
    if (p.startsWith(':')) {
      return (
        /^[A-Za-z0-9._~-]+$/.test(seg) && seg !== '.' && !seg.includes('..') && !literalSiblings(parts, i).has(seg)
      );
    }
    return p === seg;
  });
}

/**
 * The ask's request id with a suffix, within the 64 characters of
 * `[A-Za-z0-9._-]` the api (and the OTO App, which adopts an inbound id) accept.
 */
export function suffixedRequestId(requestId: string, suffix: string): string {
  const base = requestId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64 - suffix.length);
  return `${base}${suffix}`;
}

/** The x-request-id of a tool call: `<ask request id>.t<seq>`, a part letter after a second route. */
export function toolRequestId(requestId: string, seq: number, part = 0): string {
  return suffixedRequestId(requestId, `.t${seq}${part > 0 ? String.fromCharCode(97 + Math.min(part, 25)) : ''}`);
}

/** `promise`, or a `PlatformCallTimeout` after `ms`. The late settlement of `promise` is observed and dropped. */
async function withinWallTime<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PlatformCallTimeout()), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One GET, in process, as the asker. Throws (a programming error, which the
 * loop closes as TOOL_ERROR) when the URL is not one of the tool's routes;
 * throws `PlatformCallTimeout` when the route outlasts `timeoutMs`.
 */
export async function callPlatform(app: FastifyInstance, call: PlatformCall): Promise<PlatformResponse> {
  if (!call.url.startsWith('/') || call.url.startsWith('//') || call.url.includes('://')) {
    throw new TypeError('assistant tool call: the URL is not a path on this api');
  }
  if (!call.routes.some((r) => matchesRoute(call.url, r))) {
    throw new TypeError('assistant tool call: the URL is not one of the tool’s declared routes');
  }
  const injected = Promise.resolve(
    app.inject({
      method: 'GET',
      url: call.url,
      cookies: { [SESSION_COOKIE]: call.token },
      headers: { 'x-request-id': toolRequestId(call.requestId, call.seq, call.part ?? 0) },
    }),
  );
  const res = call.timeoutMs === undefined ? await injected : await withinWallTime(injected, call.timeoutMs);
  let body: unknown = null;
  try {
    body = res.body ? (JSON.parse(res.body) as unknown) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, bytes: Buffer.byteLength(res.body ?? '', 'utf8') };
}
