import { and, asc, eq, isNull } from 'drizzle-orm';
import { box, branch, operator, station } from '@oto/db';
import { AppError, errors } from '../lib/errors';
import type { Tx } from './tx';

/**
 * Creation and retirement take parent locks in the same order: operator,
 * then branch. A foreign-key check alone does not check archivedAt, and a
 * creator waiting for retirement must read the committed state before insert.
 */
export async function lockActiveOrganisation(tx: Tx, operatorId: string, branchId?: string): Promise<void> {
  const [owner] = await tx.select({ archivedAt: operator.archivedAt }).from(operator)
    .where(eq(operator.id, operatorId)).limit(1).for('key share');
  if (!owner || owner.archivedAt) throw new AppError(404, 'OPERATOR_NOT_FOUND', 'No such active operator');
  if (!branchId) return;
  const [park] = await tx.select({ archivedAt: branch.archivedAt }).from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId))).limit(1).for('key share');
  if (!park || park.archivedAt) throw new AppError(404, 'BRANCH_NOT_FOUND', 'No such active branch');
}

export async function lockBranchForArchive(tx: Tx, operatorId: string, branchId: string) {
  await lockActiveOrganisation(tx, operatorId);
  const [park] = await tx.select().from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId))).limit(1).for('update');
  if (!park) throw errors.notFound('Branch not found');
  return park;
}

export async function lockOperatorForArchive(tx: Tx, operatorId: string) {
  const [owner] = await tx.select().from(operator).where(eq(operator.id, operatorId)).limit(1).for('update');
  if (!owner) throw errors.notFound('Operator not found');
  return owner;
}

export async function assertArchiveAllowed(
  tx: Tx,
  target: { operatorId: string; branchId?: string; name: string; confirmName?: string },
): Promise<void> {
  const kind = target.branchId ? 'branch' : 'operator';
  if (target.confirmName !== target.name) {
    throw new AppError(400, 'ARCHIVE_CONFIRMATION_REQUIRED', `Type the exact ${kind} name to archive it.`);
  }
  // Historical fleet stays for sales and audit references; only equipment
  // still in service blocks retirement. Cash has no drawer-session model.
  const boxes = await tx.select({ id: box.id, name: box.name }).from(box).where(and(
    eq(box.operatorId, target.operatorId), isNull(box.archivedAt),
    target.branchId ? eq(box.branchId, target.branchId) : undefined,
  )).orderBy(asc(box.name), asc(box.id));
  const stations = await tx.select({ id: station.id, name: station.name }).from(station).where(and(
    eq(station.operatorId, target.operatorId), isNull(station.archivedAt),
    target.branchId ? eq(station.branchId, target.branchId) : undefined,
  )).orderBy(asc(station.name), asc(station.id));
  if (boxes.length || stations.length) {
    throw errors.conflict(
      target.branchId ? 'BRANCH_HAS_LIVE_FLEET' : 'OPERATOR_HAS_LIVE_FLEET',
      'Archive or move the active boxes and stations first.',
      { boxes, stations },
    );
  }
}
