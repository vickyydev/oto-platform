import { asc, eq } from 'drizzle-orm';
import { branch, refund } from '@oto/db';
import type { RefundAllocationEntry, RefundLineEntry } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { accountNames } from './account-names';
import { audit } from './audit';
import { branchBusinessDate, recordRefundOut } from './cash';
import type { Exec, Tx } from './tx';

export { accountNames };

/**
 * S2-11 — the one writer of a refund slice's LATER answer.
 *
 * A refund row is written whole, once, and then only this moves: a slice that
 * went to a card terminal (its void comes back from the box) or to the payment
 * gateway (its answer comes back from `QrPayment.refund`) is stamped here with
 * what happened. Its own module so the terminal's result handler and the refund
 * service can both reach it without importing each other.
 *
 * Locks the refund row, finds the slice, and leaves any slice that is no longer
 * `pending` exactly as it is: the box re-sends an answer whenever an
 * acknowledgement is lost, and a second `approved` must not rewrite the first.
 *
 * S2-15a — THE ONE WRITER OF A LATE CASH FALLBACK. A slice settled `failed`
 * with `fallback: 'cash'` (the terminal refused its void, the gateway refused
 * its refund, or there was no invoice to refund) is money staff hand back from
 * the drawer the refund was made at, so its `refund_out` is written here, in
 * the same transaction, on that drawer's open session. Keyed on the slice's
 * void action id (or its attempt), so a replayed answer writes nothing twice.
 * The answer has already happened and cannot be refused: with no open drawer
 * nothing is written and the slice's `fallback: 'cash'` is what the End of Day
 * picks up (round 2's correction).
 */
export async function settleRefundSlice(
  tx: Tx,
  input: {
    refundId: string;
    /** Which slice: the one with this void action id, or this attempt's gateway slice. */
    match: (entry: RefundAllocationEntry) => boolean;
    update: Partial<RefundAllocationEntry>;
    actorAccountId: string | null;
    requestId?: string;
    action: string;
    log?: FastifyBaseLogger;
  },
): Promise<RefundAllocationEntry | null> {
  const [row] = await tx.select().from(refund).where(eq(refund.id, input.refundId)).for('update').limit(1);
  if (!row) return null;
  const entries = [...(row.tenderAllocation ?? [])];
  const index = entries.findIndex((entry) => entry.status === 'pending' && input.match(entry));
  if (index < 0) return null;
  const before = entries[index]!;
  const after: RefundAllocationEntry = { ...before, ...input.update };
  entries[index] = after;
  await tx
    .update(refund)
    .set({ tenderAllocation: entries, updatedAt: new Date() })
    .where(eq(refund.id, row.id));
  await audit.record(tx, {
    actorAccountId: input.actorAccountId,
    operatorId: row.operatorId,
    branchId: row.branchId,
    action: input.action,
    entityType: 'refund',
    entityId: row.id,
    requestId: input.requestId,
    before: { slice: before },
    after: { slice: after, saleId: row.saleId },
  });

  if (after.status === 'failed' && after.fallback === 'cash' && after.amountSatang > 0) {
    const now = new Date();
    const [br] = await tx.select().from(branch).where(eq(branch.id, row.branchId)).limit(1);
    const written = br
      ? await recordRefundOut(tx, {
          operatorId: row.operatorId,
          branchId: row.branchId,
          stationId: row.stationId,
          refundId: row.id,
          // Handed back in cash: the slice as the drawer sees it.
          slices: [{ ...after, route: 'cash', status: 'done' }],
          keySuffix: `fallback:${after.actionId ?? after.attemptId ?? index}`,
          businessDate: branchBusinessDate(br, now),
          // The box's or the gateway's answer has no actor: the refund's own maker.
          actorAccountId: row.createdByAccountId,
          requestId: input.requestId,
          now,
          strict: false,
        })
      : null;
    if (!written) {
      input.log?.warn(
        { refundId: row.id, stationId: row.stationId, reqId: input.requestId },
        'cash fallback with no open drawer session',
      );
    }
  }
  return after;
}

// --- Reading ------------------------------------------------------------------

/** A refund as the History detail and the refund answer show it. */
export interface RefundView {
  id: string;
  saleId: string;
  stationId: string;
  /** `T1-R-000003` — the refund's own number, from its own series. */
  number: string;
  amountSatang: number;
  mode: string;
  reason: string;
  note: string | null;
  lines: RefundLineEntry[];
  tenderAllocation: RefundAllocationEntry[];
  approvedBy: { accountId: string; name: string | null };
  createdBy: { accountId: string; name: string | null };
  /** True while any slice is still waiting on a terminal, the gateway or a wallet. */
  pending: boolean;
  createdAt: string;
}

export function refundViewOf(
  row: typeof refund.$inferSelect,
  nameOf: (accountId: string) => string | null,
): RefundView {
  const allocation = row.tenderAllocation ?? [];
  return {
    id: row.id,
    saleId: row.saleId,
    stationId: row.stationId,
    number: row.number,
    amountSatang: row.amountSatang,
    mode: row.mode,
    reason: row.reason,
    note: row.note,
    lines: row.lines ?? [],
    tenderAllocation: allocation,
    approvedBy: { accountId: row.approvedByAccountId, name: nameOf(row.approvedByAccountId) },
    createdBy: { accountId: row.createdByAccountId, name: nameOf(row.createdByAccountId) },
    pending: allocation.some((entry) => entry.status === 'pending'),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every refund of a sale, oldest first — the prototype's "Refund history". */
export async function refundsOfSale(db: Exec, saleId: string): Promise<RefundView[]> {
  const rows = await db.select().from(refund).where(eq(refund.saleId, saleId)).orderBy(asc(refund.createdAt));
  const nameOf = await accountNames(
    db,
    rows.flatMap((r) => [r.approvedByAccountId, r.createdByAccountId]),
  );
  return rows.map((row) => refundViewOf(row, nameOf));
}
