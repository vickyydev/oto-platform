import { and, eq } from 'drizzle-orm';
import { idempotencyKey, type Db } from '@oto/db';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { carriesSecret, type IdempotencyClaim } from '../plugins/idempotency';
import { audit } from './audit';

/**
 * One business operation, one transaction (S2-01b).
 *
 * Sprint 1 wrote the row and then the audit entry as two separate
 * statements, so a crash between them left a change nobody could account
 * for — and a half-finished multi-table write left the database describing
 * something that never happened. Everything a single operation does now
 * happens inside `withTx`, audit row included: it commits together or not at
 * all.
 *
 * The rule the audit trail depends on:
 *   - the SUCCESS row is written inside the transaction, by the service,
 *     with the `tx` handle — so it cannot survive a rollback;
 *   - the FAILURE row is written after the rollback, on a separate
 *     connection, because by definition it must outlive the transaction that
 *     failed.
 */

/** The transaction handle Drizzle hands a callback. Same surface as `Db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * What a service writes through: the pool, or a transaction on it. Services
 * take this rather than `Db` so the same function works standalone and
 * inside `withTx` — which is what lets one operation stay one transaction.
 */
export type Exec = Db | Tx;

export interface OpContext {
  requestId?: string;
  actorAccountId?: string | null;
  operatorId?: string | null;
  branchId?: string | null;
  /** Request logger, so the operation line carries the request id. */
  log?: FastifyBaseLogger;
  /**
   * The claimed idempotency key, if the caller sent one. The response is
   * stored inside this transaction so "the work happened" and "this is what
   * we answered" commit together — a crash between the two cannot leave a
   * retry re-running work that already succeeded.
   */
  idempotency?: IdempotencyClaim;
}

/** A request's first successful transaction owns its answer, including nested calls. */
const transactionClaims = new WeakSet<IdempotencyClaim>();

/**
 * `opName` is the audit action vocabulary — `member.create`,
 * `role_assignment.delete` — so one name ties the log line, the span and the
 * audit row together.
 */
export async function withTx<T>(
  db: Exec,
  ctx: OpContext,
  opName: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const claim = ctx.idempotency;
  const ownsStoredAnswer = Boolean(claim && !claim.stored && !transactionClaims.has(claim));
  if (claim) transactionClaims.add(claim);
  let storedAnswer = false;
  try {
    const result = await db.transaction(async (tx) => {
      const value = await fn(tx);
      // Only when the operation produced its own response inside the
      // transaction. An operation that reads its response back afterwards
      // (because it needs the committed row) has it stored by the onSend
      // hook instead, and its client-minted id covers the gap between the
      // commit and that write.
      if (claim && ownsStoredAnswer && value !== undefined && !carriesSecret(value)) {
        await tx
          .update(idempotencyKey)
          .set({ statusCode: 200, responseBody: (value ?? null) as never })
          .where(
            and(eq(idempotencyKey.accountId, claim.accountId), eq(idempotencyKey.key, claim.key)),
          );
        storedAnswer = true;
      }
      /**
       * A value carrying a credential is left unstored and `stored` left
       * false, so the onSend hook sees it, says which route it was and gives
       * the key back. The rule belongs on the route — `secretResponse` — and
       * this is only what catches the one that did not say so.
       */
      return value;
    });
    // A failed commit leaves the claim unstored so onSend can release a 5xx.
    if (claim && storedAnswer) claim.stored = true;
    ctx.log?.debug({ op: opName, ms: Date.now() - started, reqId: ctx.requestId }, 'op ok');
    return result;
  } catch (err) {
    // A rolled-back owner has no answer to preserve. A fallback transaction
    // (for example a skipped print) may store the request's successful answer.
    if (claim && ownsStoredAnswer && !claim.stored) transactionClaims.delete(claim);
    const ms = Date.now() - started;
    ctx.log?.warn({ op: opName, ms, reqId: ctx.requestId }, 'op failed');
    // After rollback, use the pool for a standalone operation or the enclosing
    // transaction for a failed savepoint; never the transaction that rolled back.
    try {
      await audit.record(db, {
        actorAccountId: ctx.actorAccountId ?? null,
        operatorId: ctx.operatorId ?? null,
        branchId: ctx.branchId ?? null,
        action: `${opName}.failed`,
        entityType: 'operation',
        entityId: ctx.requestId ?? opName,
        after: { error: errorCode(err) },
        requestId: ctx.requestId,
      });
    } catch (auditErr) {
      // Never let the record of a failure replace the failure itself.
      ctx.log?.error({ err: auditErr, op: opName }, 'failure audit could not be written');
    }
    throw err;
  }
}

/** The operation context every route builds the same way. */
export function opCtx(req: FastifyRequest): OpContext {
  return {
    requestId: req.id,
    actorAccountId: req.auth?.accountId ?? null,
    operatorId: req.auth?.operatorId ?? null,
    branchId: req.auth?.branchId ?? null,
    log: req.log,
    idempotency: req.idempotency,
  };
}

/** A short, non-leaking label for why an operation failed. */
function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown };
    if (typeof e.code === 'string') return e.code;
    if (typeof e.name === 'string') return e.name;
  }
  return 'UNKNOWN';
}
