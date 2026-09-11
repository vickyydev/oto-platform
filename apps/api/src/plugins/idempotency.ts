import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { idempotencyKey } from '@oto/db';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Idempotency middleware (SCRUM-15, CLAUDE.md §3 Safeguards).
 * Every mutating route accepts an `Idempotency-Key` header:
 *   - first sighting → the response (status + body) is stored under
 *     (account, key) with the request hash;
 *   - same key + same request hash → the stored response is replayed;
 *   - same key + different request hash → 409 IDEMPOTENCY_MISMATCH.
 * Combined with DB unique constraints on business keys (member/account phone).
 */
export const idempotencyPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('preHandler', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) return;
    if (!req.auth) return; // unauthenticated mutations (sign-in etc.) are not stored

    const requestHash = createHash('sha256')
      .update(req.method)
      .update('\n')
      .update(req.url)
      .update('\n')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');

    const rows = await app.db
      .select()
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.accountId, req.auth.accountId), eq(idempotencyKey.key, key)))
      .limit(1);
    const existing = rows[0];

    if (existing && existing.expiresAt > new Date()) {
      if (existing.requestHash !== requestHash) {
        return reply.status(409).send({
          error: {
            code: 'IDEMPOTENCY_MISMATCH',
            message: 'Idempotency-Key was already used with a different request',
          },
        });
      }
      if (existing.statusCode !== null) {
        return reply.status(existing.statusCode).send(existing.responseBody);
      }
      // In-flight duplicate: no stored response yet — treat as conflict.
      return reply
        .status(409)
        .send({ error: { code: 'IDEMPOTENCY_IN_FLIGHT', message: 'Original request still processing' } });
    }

    const expiresAt = new Date(Date.now() + app.env.IDEMPOTENCY_TTL_HOURS * 3600_000);
    await app.db
      .insert(idempotencyKey)
      .values({ key, accountId: req.auth.accountId, requestHash, expiresAt })
      .onConflictDoUpdate({
        target: [idempotencyKey.accountId, idempotencyKey.key],
        set: { requestHash, statusCode: null, responseBody: null, expiresAt },
      });

    req.idempotency = { key, accountId: req.auth.accountId };
  });

  app.addHook('onSend', async (req, _reply, payload) => {
    if (!req.idempotency) return payload;
    const { key, accountId } = req.idempotency;
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
      .set({ statusCode: _reply.statusCode, responseBody: body })
      .where(and(eq(idempotencyKey.accountId, accountId), eq(idempotencyKey.key, key)));
    return payload;
  });
});

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { key: string; accountId: string };
  }
}
