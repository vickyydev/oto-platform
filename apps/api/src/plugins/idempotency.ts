import { createHash } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { idempotencyKey, type Db } from '@oto/db';
import type { PermissionConfig } from './permission';

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
 *
 * **What is NOT stored is a property of the route, not of the caller
 * (S2-04 review).** The store keeps a response body verbatim for
 * `IDEMPOTENCY_TTL_HOURS`, replayable by anyone holding the key, so a route
 * that hands out a credential must be incapable of entering it. `!req.auth`
 * below reads like that fence and is not one: it only says the CALLER had no
 * session, and `POST /box/v1/register` — which answers with a box's 256-bit
 * secret — is reachable with a session cookie and a key in the same request.
 * Two route declarations do the fencing instead:
 *
 *   - `secretResponse: true` — the answer IS a credential (a box secret, a
 *     temporary password, a hand-off token);
 *   - `credential: …` — the principal is a machine, and its own replay
 *     protection is the claim code or the command state, not an account's
 *     key. Boxes become principals of their own in S2-05.
 *
 * `carriesSecret` is the backstop under both, for the route that forgets:
 * a body with a credential-shaped field in it is never written, here or in
 * `withTx`.
 */

export interface IdempotencyClaim {
  key: string;
  accountId: string;
  /** Set once the response has been stored inside the business transaction. */
  stored?: boolean;
}

/**
 * Field names whose value is a credential rather than a fact about one.
 *
 * Matched WHOLE and case-insensitively, so `pairingCodeExpiresAt` — an expiry,
 * safe to replay — is not mistaken for `pairingCode`, and the `code` inside our
 * own error envelope is not mistaken for a secret.
 */
const SECRET_FIELDS = new Set([
  'secret',
  'token',
  'password',
  'temporarypassword',
  'claimcode',
  'pairingcode',
  'otp',
  'apikey',
]);

/**
 * Whether a response body carries something nobody should be able to read
 * twice. The declarations above are the rule; this is what catches the route
 * that did not declare one, and it fails closed — the body is dropped and the
 * key released, so a retry does the work instead of being handed the secret.
 */
export function carriesSecret(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => carriesSecret(v, depth + 1));
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELDS.has(key.toLowerCase()) && typeof v === 'string' && v.length > 0) return true;
    if (carriesSecret(v, depth + 1)) return true;
  }
  return false;
}

/** Give the key back, so the next attempt does the work rather than replaying a hole. */
async function release(db: Db, accountId: string, key: string): Promise<void> {
  await db
    .delete(idempotencyKey)
    .where(and(eq(idempotencyKey.accountId, accountId), eq(idempotencyKey.key, key)));
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
    // Before the key is even read: whether this route's answer may be kept is
    // decided by the route, and no header from the caller changes it.
    if (unstorable(req)) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) return;
    // The principal owning the key. Today that is always an account; a box
    // or station credential becomes a principal of its own in S2-05. This is
    // NOT what keeps the box surface out of the store — `unstorable` is.
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
      await release(app.db, claim.accountId, claim.key);
      return payload;
    }

    // Already written inside the business transaction — leave it alone.
    // `withTx` runs the same secret check before it writes, so a body that
    // got that far has already been through it.
    if (claim.stored) return payload;

    let body: unknown = null;
    if (typeof payload === 'string' && payload.length > 0) {
      try {
        body = JSON.parse(payload);
      } catch {
        body = payload;
      }
    }
    if (carriesSecret(body)) {
      /**
       * A route minting a credential without declaring `secretResponse`.
       * Nothing is written and the key is given back — the same treatment a
       * 5xx gets, for the same reason: an answer that must not be replayed is
       * not an answer to keep. The line names the route so it can be declared.
       */
      req.log.error(
        { route: req.routeOptions?.url, method: req.method, reqId: req.id },
        'response carries a credential and was not stored — declare secretResponse on this route',
      );
      await release(app.db, claim.accountId, claim.key);
      return payload;
    }
    await app.db
      .update(idempotencyKey)
      .set({ statusCode: reply.statusCode, responseBody: body })
      .where(and(eq(idempotencyKey.accountId, claim.accountId), eq(idempotencyKey.key, claim.key)));
    return payload;
  });
});

/** A route whose answer must never reach the replay store. */
function unstorable(req: FastifyRequest): boolean {
  const config = req.routeOptions?.config as PermissionConfig | undefined;
  return config?.secretResponse === true || config?.credential !== undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: IdempotencyClaim;
  }
}
