import { createHash } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { idempotencyKey, type Db } from '@oto/db';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Idempotency (SCRUM-15, hardened in S2-01b).
 *
 * A till on a flaky mall connection retries. Without this, a retry is a
 * second sale. Every mutating route accepts an `Idempotency-Key`:
 *   - the key is CLAIMED atomically — `insert … on conflict do nothing
 *     returning` — so two racing retries cannot both decide they are first.
 *     Sprint 1 read the row and then wrote it, which is exactly the race;
 *   - same key, same request → the stored response is replayed verbatim;
 *   - same key, different request → 409 `IDEMPOTENCY_MISMATCH`;
 *   - same key while the original is still running → 409
 *     `IDEMPOTENCY_IN_FLIGHT` with `Retry-After`, and the client polls the
 *     same key rather than sending the work again;
 *   - a 5xx RELEASES the claim, so a genuine retry runs instead of replaying
 *     a failure for the next day.
 *
 * Where the handler runs inside `withTx`, the response is stored in that
 * same transaction (see services/tx.ts), so "the work happened" and "this is
 * what we answered" commit together.
 */

export interface IdempotencyClaim {
  key: string;
  accountId: string;
  /** Set once the response has been stored inside the business transaction. */
  stored?: boolean;
}

/** Delete keys whose window has passed. Called by the housekeeping job. */
export async function purgeExpiredIdempotencyKeys(db: Db): Promise<number> {
  const gone = await db
    .delete(idempotencyKey)
    .where(lte(idempotencyKey.expiresAt, new Date()))
    .returning({ key: idempotencyKey.key });
  return gone.length;
}

export const idempotencyPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('preHandler', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) return;
    // The principal owning the key. Today that is always an account; a box
    // or station credential becomes a principal of its own in S2-05.
    if (!req.auth) return;
    const accountId = req.auth.accountId;

    const requestHash = createHash('sha256')
      .update(req.method)
      .update('\n')
      .update(req.url)
      .update('\n')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');

    const expiresAt = new Date(Date.now() + app.env.IDEMPOTENCY_TTL_HOURS * 3600_000);

    // One statement decides the winner.
    const claimed = await app.db
      .insert(idempotencyKey)
      .values({ key, accountId, requestHash, expiresAt })
      .onConflictDoNothing()
      .returning({ key: idempotencyKey.key });

    if (claimed.length === 0) {
      const [existing] = await app.db
        .select()
        .from(idempotencyKey)
        .where(and(eq(idempotencyKey.accountId, accountId), eq(idempotencyKey.key, key)))
        .limit(1);

      if (existing && existing.expiresAt <= new Date()) {
        // The old window has passed: take the key over, still atomically.
        const takenOver = await app.db
          .update(idempotencyKey)
          .set({ requestHash, statusCode: null, responseBody: null, expiresAt, createdAt: sql`now()` })
          .where(
            and(
              eq(idempotencyKey.accountId, accountId),
              eq(idempotencyKey.key, key),
              lte(idempotencyKey.expiresAt, new Date()),
            ),
          )
          .returning({ key: idempotencyKey.key });
        if (takenOver.length > 0) {
          req.idempotency = { key, accountId };
          return;
        }
      }

      if (!existing) return; // vanished between the two statements: let it run

      if (existing.requestHash !== requestHash) {
        return reply.status(409).send({
          error: {
            code: 'IDEMPOTENCY_MISMATCH',
            message: 'Idempotency-Key was already used with a different request',
          },
        });
      }
      if (existing.statusCode !== null) {
        reply.header('x-oto-replay', 'true');
        return reply.status(existing.statusCode).send(existing.responseBody);
      }
      // Still running. Say so, and say when to ask again.
      reply.header('retry-after', '1');
      return reply.status(409).send({
        error: {
          code: 'IDEMPOTENCY_IN_FLIGHT',
          message: 'The original request is still processing — retry the same key shortly',
        },
      });
    }

    req.idempotency = { key, accountId };
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const claim = req.idempotency;
    if (!claim) return payload;

    // A server fault is never an answer worth replaying for a day: release
    // the key so the next attempt does the work.
    if (reply.statusCode >= 500) {
      await app.db
        .delete(idempotencyKey)
        .where(
          and(eq(idempotencyKey.accountId, claim.accountId), eq(idempotencyKey.key, claim.key)),
        );
      return payload;
    }

    // Already written inside the business transaction — leave it alone.
    if (claim.stored) return payload;

    let body: unknown = null;
    if (typeof payload === 'string' && payload.length > 0) {
      try {
        body = JSON.parse(payload);
      } catch {
        body = payload;
      }
    }
    await app.db
      .update(idempotencyKey)
      .set({ statusCode: reply.statusCode, responseBody: body })
      .where(and(eq(idempotencyKey.accountId, claim.accountId), eq(idempotencyKey.key, claim.key)));
    return payload;
  });
});

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: IdempotencyClaim;
  }
}
