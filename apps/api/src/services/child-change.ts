import { and, eq } from 'drizzle-orm';
import { auditLog, child } from '@oto/db';
import type { Tx } from './tx';

/**
 * SCRUM-1060 — ONE CHANGE TO A CHILD IS WRITTEN ONCE, WHICHEVER LANE BROUGHT IT.
 *
 * The till sends a change to a saved child to the platform first. When that
 * call reaches nothing at all, the till moves it to the counter box
 * (`viaLane`), which keeps it as a `child.update` fact and syncs it later. If
 * the platform had in fact written the first attempt and only its answer was
 * lost, the box's fact used to be applied as a second change: a second audit
 * row and a second publication to the boxes for one edit.
 *
 * The till now sends the change under one action id on both lanes — online
 * in the body (`actionId`), and as the action id of the box's intent, which
 * the box has always copied onto the fact it keeps (`envelope.actionId`). The
 * action id is the sync ledger's identity for one act, as a sale's is, and
 * the audit row of the change records it. So the second arrival of the same
 * change — the box's fact after the online write, the online write after the
 * box's fact, or the box's fact twice — finds that row and writes nothing.
 *
 * Serialised on the child row, so an online write and the box's fact racing
 * each other cannot both miss the other's row. Scoped to this operator, this
 * child and a `child.update`: an action id names one change to one child, and
 * a change with no action id, or another one, is written as before.
 */
export async function childChangeWritten(
  tx: Tx,
  input: { operatorId: string; childId: string; actionId: string | null | undefined },
): Promise<boolean> {
  if (!input.actionId) return false;
  await tx.select({ id: child.id }).from(child).where(eq(child.id, input.childId)).for('update');
  const [prior] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.operatorId, input.operatorId),
        eq(auditLog.action, 'child.update'),
        eq(auditLog.entityType, 'child'),
        eq(auditLog.entityId, input.childId),
        eq(auditLog.actionId, input.actionId),
      ),
    )
    .limit(1);
  return Boolean(prior);
}
