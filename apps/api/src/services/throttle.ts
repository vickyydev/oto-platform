import { sql } from 'drizzle-orm';
import { authThrottle, type Db } from '@oto/db';
import { errors } from '../lib/errors';

/**
 * Fixed-window counters in Postgres (S2-01a).
 *
 * Every counter that fences the unauthenticated surface — rate limits, wrong
 * code attempts — lands in `auth_throttle` rather than memory, because
 * Render restarts the api on every deploy and a memory counter would hand an
 * attacker a clean slate each time. Keys are namespaced by their caller
 * (`rl:*`, `code:*`, `phone:*`, `ip:*`, `unlock:*`) so the buckets never
 * collide.
 */

export interface Window {
  /** Requests counted in the open window, including this one. */
  current: number;
  /** Milliseconds until the window ends. */
  ttl: number;
}

/** One statement, so racing requests cannot both read the same count. */
export async function bumpWindow(db: Db, key: string, windowMs: number): Promise<Window> {
  const seconds = Math.max(1, Math.ceil(windowMs / 1000));
  const nextWindow = sql`now() + ${`${seconds} seconds`}::interval`;
  const expired = sql`${authThrottle.lockedUntil} is null or ${authThrottle.lockedUntil} <= now()`;
  const [row] = await db
    .insert(authThrottle)
    .values({ key, failures: 1, lockedUntil: nextWindow, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: authThrottle.key,
      set: {
        failures: sql`case when ${expired} then 1 else ${authThrottle.failures} + 1 end`,
        lockedUntil: sql`case when ${expired} then ${nextWindow} else ${authThrottle.lockedUntil} end`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ failures: authThrottle.failures, lockedUntil: authThrottle.lockedUntil });
  const ttl = row?.lockedUntil ? row.lockedUntil.getTime() - Date.now() : windowMs;
  return { current: row?.failures ?? 1, ttl: Math.max(0, ttl) };
}

/**
 * The PRIMARY rate-limit bucket, called from a handler once the phone or
 * account is known — which is why it is not a route-level limit: the key
 * only exists after the body is parsed.
 */
export async function limitPrincipal(
  db: Db,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<void> {
  const { current, ttl } = await bumpWindow(db, `rl:${key}`, windowSeconds * 1000);
  if (current > max) {
    throw errors.tooMany(`Too many requests. Try again in ${Math.ceil(ttl / 1000)}s.`);
  }
}
