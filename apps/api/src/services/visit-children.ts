import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { auditLog, child, member, visit, visitChild } from '@oto/db';
import { errors } from '../lib/errors';
import { audit, type AuditEntry } from './audit';
import type { Tx } from './tx';

/** One confirmation, including when its online answer was lost before box replay. */
export async function addVisitChildren(
  tx: Tx,
  input: {
    operationId?: string;
    visitId: string;
    operatorId: string;
    branchId: string;
    memberId?: string;
    childIds: string[];
    now: Date;
    actor: Pick<AuditEntry, 'actorAccountId' | 'requestId' | 'actionId' | 'sourceEventId'>;
    auditAfter?: Record<string, unknown>;
  },
) {
  const [v] = await tx.select().from(visit)
    .where(and(eq(visit.id, input.visitId), eq(visit.operatorId, input.operatorId), eq(visit.branchId, input.branchId)))
    .for('update').limit(1);
  if (!v || (input.memberId && v.memberId !== input.memberId)) throw errors.notFound('Visit not found');
  if (input.operationId) {
    const [prior] = await tx.select().from(auditLog).where(eq(auditLog.id, input.operationId)).limit(1);
    if (prior) {
      if (prior.operatorId !== input.operatorId || prior.branchId !== input.branchId ||
          prior.action !== 'visit.children_add' || prior.entityType !== 'visit' || prior.entityId !== v.id) {
        throw errors.conflict('ID_IN_USE', 'That action id already names another record');
      }
      return { id: v.id, visitDate: v.visitDate, status: v.status };
    }
  }
  if (v.status === 'closed') throw errors.conflict('VISIT_CLOSED', 'That visit is closed');
  if (!v.memberId) throw errors.badRequest('childIds require a memberId');
  const childIds = [...new Set(input.childIds)];
  const saved = await tx.select({ id: child.id }).from(child)
    .where(and(inArray(child.id, childIds), eq(child.memberId, v.memberId), isNull(child.archivedAt)));
  if (saved.length !== childIds.length) throw errors.badRequest('One or more children do not belong to this member');
  const before = (await tx.select({ childId: visitChild.childId }).from(visitChild)
    .where(eq(visitChild.visitId, v.id))).map((r) => r.childId);
  const added = childIds.filter((id) => !before.includes(id));
  if (added.length) await tx.insert(visitChild)
    .values(added.map((childId) => ({ visitId: v.id, childId, confirmedAt: input.now }))).onConflictDoNothing();
  await tx.update(child).set({ lastConfirmedAt: input.now }).where(inArray(child.id, childIds));
  await tx.update(member).set({ childrenReviewSince: null })
    .where(and(eq(member.id, v.memberId), isNotNull(member.childrenReviewSince)));
  await audit.record(tx, {
    ...input.actor,
    id: input.operationId,
    operatorId: input.operatorId,
    branchId: v.branchId,
    action: 'visit.children_add',
    entityType: 'visit',
    entityId: v.id,
    before: { childIds: before },
    after: { childIds: [...before, ...added], confirmedChildIds: childIds, ...input.auditAfter },
  });
  return { id: v.id, visitDate: v.visitDate, status: v.status };
}
