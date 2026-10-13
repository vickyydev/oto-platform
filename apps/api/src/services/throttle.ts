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
 * collide. `mcode:*` rows are not counters: they are the booking site's
 * outstanding saved-children codes, held here with their expiry in
 * `locked_until` (SCRUM-357, `services/member-code.ts`).
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

/** How long a failure count that never reached its lock is kept after its last failure. */
export const THROTTLE_IDLE_RETENTION_HOURS = 24;

/**
 * THE SWEEP (SCRUM-386): delete every bucket that no longer counts.
 *
 *   - `locked_until` in the past — a fixed window that has ended, or a
 *     cooldown that has run out. Both writers already treat such a row as a
 *     fresh start on its next hit (`bumpWindow` and `throttleFail` reset the
 *     count), so deleting it changes no answer;
 *   - no `locked_until` at all — a failure count below its lock — once it has
 *     been quiet for `THROTTLE_IDLE_RETENTION_HOURS`. That forgives a few
 *     mistyped passwords after a day of nothing, and nothing shorter.
 *
 * A live window or a lock still running is never touched. Run by the
 * housekeeping job (`jobs.ts`), so the table is bounded by what has happened
 * recently rather than by everything that ever happened.
 */
export async function purgeExpiredThrottles(
  db: Db,
  idleHours: number = THROTTLE_IDLE_RETENTION_HOURS,
): Promise<number> {
  const deleted = await db
    .delete(authThrottle)
    .where(
      sql`${authThrottle.lockedUntil} <= now()
          or (${authThrottle.lockedUntil} is null and ${authThrottle.updatedAt} < now() - ${`${idleHours} hours`}::interval)`,
    )
    .returning({ key: authThrottle.key });
  return deleted.length;
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
