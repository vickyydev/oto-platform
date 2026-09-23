import rateLimit, { type FastifyRateLimitStore } from '@fastify/rate-limit';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { Db } from '@oto/db';
import { AppError } from '../lib/errors';
import { bumpWindow, type Window } from '../services/throttle';

/**
 * Rate limiting on the unauthenticated surface (S2-01a).
 *
 * Two buckets, deliberately:
 *   - PRIMARY, per phone or per account (`limitPrincipal` in the handler) —
 *     the thing an attacker is actually targeting. Tight: 5 in 15 minutes.
 *   - SECONDARY, per IP (this plugin) — generous, because the park's tills,
 *     the office and a mall full of visitors share very few public
 *     addresses. A tight IP bucket here would lock out a whole mall rather
 *     than an attacker.
 *
 * The counters live in Postgres (see services/throttle.ts), so a Render
 * restart does not reset them.
 */

/**
 * What the plugin actually hands `child()`: the merged rate-limit params,
 * with the route it belongs to under `routeInfo`. The published type says
 * `RouteOptions`, which is the shape of that nested field, not of the
 * argument — hence the narrow local view.
 */
type ChildParams = RouteOptions & {
  timeWindow?: number;
  routeInfo?: { method?: string; url?: string };
};

/** @fastify/rate-limit store backed by `auth_throttle`. */
function buildStore(db: Db) {
  return class PgRateLimitStore implements FastifyRateLimitStore {
    private readonly prefix: string;
    private readonly windowMs: number;

    constructor(options: { timeWindow?: number; prefix?: string } = {}) {
      this.windowMs = typeof options.timeWindow === 'number' ? options.timeWindow : 60_000;
      this.prefix = options.prefix ?? 'route';
    }

    // Argument order is the plugin's: (key, callback, timeWindow, max).
    incr(key: string, cb: (err: Error | null, result?: Window) => void, timeWindow: number): void {
      const windowMs = typeof timeWindow === 'number' ? timeWindow : this.windowMs;
      bumpWindow(db, `rl:${this.prefix}:${key}`, windowMs).then(
        (r) => cb(null, r),
        (e: Error) => cb(e),
      );
    }

    /** One bucket per route, so /public traffic cannot exhaust /auth's. */
    child(routeOptions: ChildParams): PgRateLimitStore {
      const info = routeOptions?.routeInfo;
      return new PgRateLimitStore({
        timeWindow: routeOptions?.timeWindow ?? this.windowMs,
        prefix: info?.method && info?.url ? `${info.method}:${info.url}` : this.prefix,
      });
    }
  };
}

/**
 * What the caller was doing too much of, per route.
 *
 * One registration serves /auth, /public, /booth and /box, so the builder
 * below cannot know the noun on its own — and the one refusal a member of the
 * public reads is the booking site's. Everything else is answered by the
 * generic line, which is what an operator, a box or a script gets.
 */
const ROUTE_MESSAGE: Record<string, string> = {
  'POST /public/bookings':
    'Too many bookings from this connection — please wait a minute and try again.',
};

function refusalMessage(req: FastifyRequest, retryAfterSeconds: number): string {
  const url = req.routeOptions?.url ?? req.url;
  return (
    ROUTE_MESSAGE[`${req.method} ${url}`] ??
    `Too many requests. Try again in ${retryAfterSeconds}s.`
  );
}

export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  await app.register(rateLimit, {
    // Only routes that opt in via `config.rateLimit`: signed-in routes are
    // already fenced by the permission guard and the sign-in throttle.
    global: false,
    max: app.env.RATE_LIMIT_IP_MAX,
    timeWindow: app.env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    store: buildStore(app.db),
    // One bucket per caller, and `req.ip` decides who that is: the socket
    // address when no proxy is trusted, otherwise the nearest X-Forwarded-For
    // entry a trusted proxy recorded — which a caller cannot write. Which
    // proxies are trusted is decided in app.ts (TRUST_PROXY_ADDRS by address,
    // the TRUST_PROXY count as the fallback) and proven in trust-proxy.test.ts;
    // this file has no defence of its own against a forged header
    // (SCRUM-353, SCRUM-367).
    keyGenerator: (req) => req.ip,
    /**
     * AN `AppError`, NOT THE ENVELOPE (SCRUM-335).
     *
     * `@fastify/rate-limit` does not send what this returns — it `throw`s it
     * (index.js: `throw params.errorResponseBuilder(req, respCtx)`). Returning
     * the response body meant a plain object with no `statusCode` reached
     * app.ts's error handler, which recognises `AppError`, a zod failure, a pg
     * unique violation and then anything carrying `statusCode < 500` — and
     * matched none of them. Every refusal past a cap was answered 500
     * INTERNAL, reported to Sentry and logged as a request failure: the 21st
     * booking in a minute told a parent on mall wifi the park was broken
     * rather than to wait. The headers were right the whole time
     * (`retry-after`, `x-ratelimit-*` are set by the plugin before it throws),
     * which is why nothing looked wrong from the outside.
     *
     * `ctx.statusCode` is 429 unless the plugin's `ban` option is configured,
     * and it is not.
     */
    errorResponseBuilder: (req, ctx) => {
      // The same number the plugin has already put in the `retry-after`
      // header, computed the same way, so the two can never disagree.
      const retryAfterSeconds = Math.ceil(ctx.ttl / 1000);
      return new AppError(ctx.statusCode, 'TOO_MANY_REQUESTS', refusalMessage(req, retryAfterSeconds), {
        retryAfterSeconds,
      });
    },
  });
});

/** Route option: the secondary per-IP bucket at the configured default. */
export const ipLimited = { rateLimit: {} } as const;
