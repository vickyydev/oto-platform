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
 * SCRUM-255(c) — AND THE SHAPE, for the credential nobody added above.
 *
 * Eight whole names is a list of the credentials that existed when the list
 * was written. `boxSecret`, `shiftToken`, `sessionToken` — every one of which
 * this codebase already mints under some other name — would have walked past
 * it into the store and sat there for a day, replayable by anyone holding the
 * key. A backstop that only catches what somebody remembered to enumerate is
 * not a backstop.
 *
 * So the rule is now the SUFFIX: a field whose name ends in `secret`, `token`,
 * `password`, `otp` or `key` holds a credential — unless it is named below.
 * The exemption list is not a courtesy: a false positive here drops the
 * response body, gives the key back and logs at ERROR, so every name that
 * matches the shape without being a credential has to be written down or the
 * widening costs a working route its retries. It was built by reading every
 * field name this API puts in a response, and it is a list of what exists
 * rather than of what might.
 *
 * `code` is deliberately NOT a suffix, and this is the interesting exclusion.
 * Every error this API returns is `{ error: { code, message } }`, so matching
 * `code` would make every 4xx look like a credential: the body dropped, the
 * key released, and an ERROR line per refused request. `tierCode`,
 * `branchCode`, `errorCode` and `statusCode` are facts on ordinary responses
 * and would go the same way. The two `*Code` names that ARE credentials —
 * `claimCode`, `pairingCode` — stay in the whole-name list above, and the
 * three routes that mint them now declare `secretResponse` besides.
 */
const SECRET_SUFFIX = /(?:secret|token|password|otp|key)$/;

/**
 * The names in this API's responses that END like a credential and identify
 * something instead. Each is here because it exists, not in case it might.
 *
 * Mostly `*key`: `publicKey`/`syncPublicKey` are published on purpose, and the
 * rest are lookup handles — an alert's dedupe key, a button on the booth, a
 * component of a health report, an object's path in the bucket, a throttle
 * bucket, and the idempotency key itself, which the caller supplied.
 *
 * `previewToken` is the one that is not a key, and it is the reason this list
 * has to be read against the API rather than guessed at. It is the menu
 * import's CONTENT HASH — `v1.<file digest>.<menu digest>`, built in
 * `services/menu-sheet.ts` — and the commit route makes the user hand it back
 * so that "4 changed" is still true when they press the button. It unlocks
 * nothing; it says what was looked at. Matching it would drop the body of
 * `POST /branches/:branchId/menu/import/preview`, a route whose own
 * description is "Writes nothing", and log an ERROR line accusing it of
 * minting a credential — the exact noise SCRUM-327 exists to remove, on a
 * different route. It is dormant only because no caller sends that route an
 * `Idempotency-Key` today, and an import screen adding a retry is the obvious
 * way for it to stop being dormant.
 */
const NAMES_THAT_UNLOCK_NOTHING = new Set([
  'publickey',
  'syncpublickey',
  'alertkey',
  'buttonkey',
  'componentkey',
  'objectkey',
  'attemptkey',
  'idempotencykey',
  'previewtoken',
]);

/** Does this field name hold a credential? Exported so a test can pin it. */
export function isSecretFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_FIELDS.has(lower)) return true;
  if (NAMES_THAT_UNLOCK_NOTHING.has(lower)) return false;
  return SECRET_SUFFIX.test(lower);
}

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
    if (isSecretFieldName(key) && typeof v === 'string' && v.length > 0) return true;
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
    /**
     * The principal owning the key. Today that is always an account; a box
     * or station credential becomes a principal of its own in S2-05. This is
     * NOT what keeps the box surface out of the store — `unstorable` is.
     *
     * **A caller with no session gets no key, and that is a real gap rather
     * than a decision about them (SCRUM-298).** A row here is owned by an
     * account — `core.idempotency_key.account_id` is not null and references
     * `core.account` — so an anonymous caller has nothing to own one with. Two
     * mutating families reach this line, and each is protected somewhere else
     * instead:
     *
     *   - `/auth/*` is self-idempotent by construction. A second identical
     *     sign-in is a second attempt and must count as one; a second
     *     `setup/complete` with the same code must find that code spent. There
     *     is nothing here to replay, and replaying it would be the defect.
     *     `setup/start` and `password-reset/request` send a second SMS on
     *     purpose, and are bounded by `rl:setup:<phone>` / `rl:reset:<phone>`;
     *   - `POST /public/bookings` keys on the booking id the site mints. The
     *     primary key is the constraint, so a double submit is one booking and
     *     the second call is answered with the first one's row.
     *
     * The booth's television surface never gets this far: `/booth/*` declares
     * `credential: 'booth'` and `POST /booth/pair` declares `secretResponse`,
     * so `unstorable` above turns them away first (SCRUM-244). That is the
     * right fence for them and not this one — a press belongs to the box. The
     * television mints a key per press and the box de-duplicates on it,
     * durably, on the machine that drew the prize
     * (`packages/box-agent/src/booth.ts` — the replay map and the per-press
     * counter that refuses `duplicate_press`); a store up here would answer
     * for a draw it did not make.
     *
     * `test/route-write-conformance.test.ts` pins both lists, so a new open
     * mutating route has to say which of these it is.
     */
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
