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
 * The arrival is the same change only when it asks for what that row wrote:
 * every field it sets reads the same in the row's `after` (text compared
 * trimmed, an empty text as no text; the time the box stamps is not part of
 * the change). An action id that already names a different change to this
 * child is `'other'`: the caller refuses it — online `409 ID_IN_USE`, as an id
 * naming another record is everywhere on the platform, and from the box a
 * poison fact in quarantine — so a different change is never answered as if
 * it had been written, and never lost without a trace.
 *
 * Serialised on the child row, so an online write and the box's fact racing
 * each other cannot both miss the other's row. Scoped to this operator, this
 * child and a `child.update`: an action id names one change to one child, and
 * a change with no action id, or another one, is written as before (`'new'`).
 */
export type ChildChangeSeen = 'new' | 'written' | 'other';

/** The stamp the box's fact sets beside the change; not something the change asks for. */
const NOT_THE_CHANGE = new Set(['lastConfirmedAt', 'updatedAt']);

function comparable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? null : text;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Whether the change asks for what an audit row's `after` shows it wrote. */
export function sameChildChange(change: Record<string, unknown>, after: unknown): boolean {
  if (!after || typeof after !== 'object') return false;
  const wrote = after as Record<string, unknown>;
  return Object.entries(change).every(
    ([key, value]) =>
      value === undefined ||
      NOT_THE_CHANGE.has(key) ||
      JSON.stringify(comparable(value)) === JSON.stringify(comparable(wrote[key])),
  );
}

export async function childChangeWritten(
  tx: Tx,
  input: {
    operatorId: string;
    childId: string;
    actionId: string | null | undefined;
    /** The fields this arrival sets, as it would write them. */
    change: Record<string, unknown>;
  },
): Promise<ChildChangeSeen> {
  if (!input.actionId) return 'new';
  await tx.select({ id: child.id }).from(child).where(eq(child.id, input.childId)).for('update');
  const prior = await tx
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.operatorId, input.operatorId),
        eq(auditLog.action, 'child.update'),
        eq(auditLog.entityType, 'child'),
        eq(auditLog.entityId, input.childId),
        eq(auditLog.actionId, input.actionId),
      ),
    );
  if (prior.length === 0) return 'new';
  return prior.some((row) => sameChildChange(input.change, row.after)) ? 'written' : 'other';
}
