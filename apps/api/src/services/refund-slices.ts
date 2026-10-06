import { asc, eq, inArray } from 'drizzle-orm';
import { account, employee, refund } from '@oto/db';
import type { RefundAllocationEntry, RefundLineEntry } from '@oto/shared';
import { audit } from './audit';
import type { Exec, Tx } from './tx';

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

/** Names for a set of accounts, the way a History row names its seller. */
export async function accountNames(db: Exec, ids: readonly string[]): Promise<(id: string) => string | null> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return () => null;
  const rows = await db
    .select({ id: account.id, name: employee.name, nickname: employee.nickname, phone: account.phone })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(inArray(account.id, unique));
  const names = new Map(rows.map((r) => [r.id, r.nickname ?? r.name ?? r.phone ?? null]));
  return (id) => names.get(id) ?? null;
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
