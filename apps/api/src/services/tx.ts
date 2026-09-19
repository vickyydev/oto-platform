import type { Db } from '@oto/db';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
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
}

/**
 * `opName` is the audit action vocabulary — `member.create`,
 * `role_assignment.delete` — so one name ties the log line, the span and the
 * audit row together.
 */
export async function withTx<T>(
  db: Db,
  ctx: OpContext,
  opName: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await db.transaction(async (tx) => fn(tx));
    ctx.log?.debug({ op: opName, ms: Date.now() - started, reqId: ctx.requestId }, 'op ok');
    return result;
  } catch (err) {
    const ms = Date.now() - started;
    ctx.log?.warn({ op: opName, ms, reqId: ctx.requestId }, 'op failed');
    // After the rollback, on the pool rather than the dead transaction.
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
