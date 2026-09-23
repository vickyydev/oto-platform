import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authThrottle, booking } from '@oto/db';
import { newId } from '@oto/shared';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-335 — what a caller past a rate limit is actually told.
 *
 * `POST /public/bookings` is capped at 20 per minute per address
 * (routes/public.ts). The cap worked; the ANSWER was a 500 INTERNAL.
 * `@fastify/rate-limit` v11 does not SEND what `errorResponseBuilder` returns,
 * it `throw`s it (index.js: `throw params.errorResponseBuilder(req, respCtx)`),
 * and the builder returned the response envelope as a plain object with no
 * `statusCode`. app.ts's error handler recognises an `AppError`, a zod
 * failure, a pg unique violation, then anything carrying `statusCode < 500` —
 * a bare object is none of those, so every refusal past a cap fell through to
 * the 500 branch and was reported to Sentry as a server fault. The headers
 * were correct throughout (`retry-after: 60`, `x-ratelimit-remaining: 0`),
 * which is why the refusal looked healthy from the outside and the body did
 * not.
 *
 * Nothing covered the plugin's refusal: the 429s asserted in security.test.ts,
 * auth.test.ts and auth-enumeration.test.ts all come from the sign-in and code
 * throttles in services/throttle.ts, which raise a real `AppError` and were
 * never affected.
 *
 * The bucket lives in `auth_throttle` keyed `rl:<METHOD>:<url>:<ip>`
 * (plugins/rate-limit.ts `child()`), and `inject` always arrives from
 * 127.0.0.1, so this file spends one bucket per route it touches.
 */

let ctx: TestContext;
beforeAll(async () => {
  // The per-IP default (120/min) would take 121 requests to reach; the booking
  // route sets its own `max: 20` and is unaffected by this. Two is enough to
  // show the generic refusal in the second test.
  ctx = await createTestContext({ env: { RATE_LIMIT_IP_MAX: '2' } });
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** What routes/public.ts declares for the booking route. */
const CAP = 20;
const BOOKINGS_BUCKET = 'rl:POST:/public/bookings:127.0.0.1';

describe('the cap on public bookings answers "wait a minute" (SCRUM-335)', () => {
  it('the 21st booking in a minute is a 429 a parent can act on, and the window then reopens', async () => {
    const catalog = await ctx.app.inject({
      method: 'GET',
      url: '/public/branches/hkt-central/catalog',
    });
    const packages = catalog.json().packages as Array<{ id: string; name: string }>;
    const packageId = packages.find((p) => p.name === 'Full Day Pass')!.id;

    // ONE booking, submitted over and over: the double-tap the cap exists for.
    // The client-minted id makes submits 2..20 replays of the first row
    // (SCRUM-298), so the bucket is spent without writing 20 bookings — and
    // the limiter counts them all the same, because it runs in `onRequest`,
    // before the body is parsed.
    const payload = {
      id: newId(),
      branchCode: 'hkt-central',
      parentName: 'Double Tap',
      tier: 'tourist',
      visitDate: '2026-09-09',
      lines: [{ packageId, kids: 1, adults: 1 }],
    };
    const submit = () => ctx.app.inject({ method: 'POST', url: '/public/bookings', payload });

    for (let n = 1; n <= CAP; n++) {
      expect((await submit()).statusCode, `booking ${n}`).toBe(200);
    }

    const over = await submit();
    expect(over.statusCode).toBe(429);
    const body = over.json();
    expect(body.error.code).toBe('TOO_MANY_REQUESTS');
    // Readable by the person holding the phone rather than by an engineer: it
    // names what was too many, and says that waiting is the fix.
    expect(body.error.message).toMatch(/too many bookings/i);
    expect(body.error.message).toMatch(/wait a minute/i);
    expect(body.error.message).not.toMatch(/internal|error/i);
    // The wait, in the envelope and in the header a browser or a retrying
    // client already knows how to read — the same number both times.
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.error.details.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(over.headers['retry-after']).toBe(String(body.error.details.retryAfterSeconds));

    // Refused, not written: the cap is a door, not a slow lane.
    expect(await ctx.db.select().from(booking).where(eq(booking.id, payload.id))).toHaveLength(1);

    // And the wait is real — when the window ends the next one is taken.
    // `bumpWindow` restarts the count once `locked_until` has passed, so
    // moving it into the past is exactly what sixty seconds do.
    await ctx.db
      .update(authThrottle)
      .set({ lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(authThrottle.key, BOOKINGS_BUCKET));
    const afterWindow = await submit();
    expect(afterWindow.statusCode).toBe(200);

    await ctx.db.delete(authThrottle).where(eq(authThrottle.key, BOOKINGS_BUCKET));
  });

  it('every other capped route gets the same envelope, in the generic wording', async () => {
    // Not the booking route: the fix is in the shared builder, so a route with
    // no wording of its own must come back as a 429 in the envelope too — this
    // is what /auth, /box and /booth get when their per-IP bucket runs out.
    const lookup = () =>
      ctx.app.inject({
        method: 'GET',
        url: '/public/member-tier?phone=0811111111&branch=hkt-central',
      });
    expect((await lookup()).statusCode).toBe(200);
    expect((await lookup()).statusCode).toBe(200);

    const over = await lookup();
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('TOO_MANY_REQUESTS');
    expect(over.json().error.message).toMatch(/^Too many requests\. Try again in \d+s\.$/);
    expect(over.json().error.details.retryAfterSeconds).toBe(
      Number(over.headers['retry-after']),
    );

    await ctx.db.delete(authThrottle);
  });
});
