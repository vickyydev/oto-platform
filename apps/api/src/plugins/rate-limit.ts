import rateLimit, { type FastifyRateLimitStore } from '@fastify/rate-limit';
import fp from 'fastify-plugin';
import type { FastifyInstance, RouteOptions } from 'fastify';
import type { Db } from '@oto/db';
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

export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  await app.register(rateLimit, {
    // Only routes that opt in via `config.rateLimit`: signed-in routes are
    // already fenced by the permission guard and the sign-in throttle.
    global: false,
    max: app.env.RATE_LIMIT_IP_MAX,
    timeWindow: app.env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    store: buildStore(app.db),
    // req.ip already honours TRUST_PROXY: with it off, a forged
    // X-Forwarded-For cannot move a caller into a fresh bucket.
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx) => ({
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`,
      },
    }),
  });
});

/** Route option: the secondary per-IP bucket at the configured default. */
export const ipLimited = { rateLimit: {} } as const;
