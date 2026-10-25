import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { account, auditLog, branch, operator, role, roleAssignment, rolePermission, session, station, type Db } from '@oto/db';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { withTx, type OpContext, type Tx } from './tx';

export interface OperatorSwitchIdentity { accountId: string; sessionId: string }
export interface OperatorSwitchInput extends OperatorSwitchIdentity {
  operatorId: string | null;
  expectedRevision: number;
}
export interface OperatorSwitchResult {
  homeOperatorId: string;
  effectiveOperatorId: string;
  operatorOverride: string | null;
  branchId: string | null;
  stationId: string | null;
  revision: number;
  changed: boolean;
}
export interface OperatorSwitchOptions extends OperatorSwitchResult {
  operators: Array<{ id: string; name: string }>;
}

const ACTION = 'session.operator_switch';
const PERMISSION = 'platform:operator:switch';

async function revisionOf(tx: Tx, sessionId: string): Promise<number> {
  const [row] = await tx.select({ n: sql<string>`count(*)::text` }).from(auditLog).where(and(
    eq(auditLog.action, ACTION), eq(auditLog.entityType, 'session'), eq(auditLog.entityId, sessionId),
  ));
  const count = BigInt(row?.n ?? '0');
  if (count < 0n || count >= BigInt(Number.MAX_SAFE_INTEGER)) {
    throw errors.conflict('OPERATOR_SWITCH_REVISION_EXHAUSTED', 'This session cannot accept another operator selection.');
  }
  return Number(count);
}

/** A null scope and the switch permission must belong to the same live assignment. */
async function requireSwitchGrant(tx: Tx, accountId: string, homeOperatorId: string, lock: boolean): Promise<void> {
  const query = tx.select({ id: roleAssignment.id }).from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(and(eq(roleAssignment.accountId, accountId), eq(roleAssignment.scopeType, 'operator'),
      isNull(roleAssignment.scopeId), isNull(roleAssignment.archivedAt), eq(rolePermission.permission, PERMISSION),
      or(isNull(role.operatorId), eq(role.operatorId, homeOperatorId))))
    .orderBy(asc(roleAssignment.id), asc(rolePermission.id));
  // SHARE, rather than KEY SHARE: revoking a grant may update archived_at.
  const rows = lock ? await query.for('share') : await query;
  if (rows.length === 0) throw errors.forbidden('A live platform-wide operator-switch grant is required.');
}

async function contextOf(tx: Tx, identity: OperatorSwitchIdentity, now: Date | undefined, lock: boolean, auditContext?: OpContext): Promise<{ state: OperatorSwitchResult; expiresAt: Date }> {
  // Match account-management lock order. Session ownership is always checked again in SQL.
  const accountQuery = tx.select().from(account).where(eq(account.id, identity.accountId)).limit(1);
  // Account fields stay stable while audit inserts can still take FK KEY SHARE.
  const [actor] = lock ? await accountQuery.for('no key update') : await accountQuery;
  const sessionQuery = tx.select().from(session).where(and(eq(session.id, identity.sessionId), eq(session.accountId, identity.accountId))).limit(1);
  const [seat] = lock ? await sessionQuery.for('update') : await sessionQuery;
  if (!actor || !seat) throw errors.unauthorized();
  // Ownership is proven before any later refusal. Attribute that refusal to
  // these rows, never to caller-supplied context or an unverified branch.
  if (auditContext) {
    auditContext.actorAccountId = actor.id;
    auditContext.operatorId = actor.operatorId;
    auditContext.branchId = null;
  }
  if (actor.status !== 'active' || seat.revokedAt || seat.expiresAt <= (now ?? new Date())) throw errors.unauthorized();

  const effectiveOperatorId = seat.operatorOverride ?? actor.operatorId;
  const ownersQuery = tx.select({ id: operator.id, archivedAt: operator.archivedAt }).from(operator)
    .where(inArray(operator.id, [...new Set([actor.operatorId, effectiveOperatorId])])).orderBy(asc(operator.id));
  const owners = lock ? await ownersQuery.for('share') : await ownersQuery;
  if (!owners.some(row => row.id === actor.operatorId && !row.archivedAt)
    || !owners.some(row => row.id === effectiveOperatorId && !row.archivedAt)) throw errors.unauthorized();

  if (seat.branchId) {
    const branchQuery = tx.select({ id: branch.id }).from(branch).where(and(eq(branch.id, seat.branchId),
      eq(branch.operatorId, effectiveOperatorId), isNull(branch.archivedAt))).limit(1);
    if ((lock ? await branchQuery.for('share') : await branchQuery).length === 0) throw errors.unauthorized();
  }
  if (seat.stationId) {
    if (!seat.branchId) throw errors.unauthorized();
    const stationQuery = tx.select({ id: station.id }).from(station).where(and(eq(station.id, seat.stationId),
      eq(station.operatorId, effectiveOperatorId), eq(station.branchId, seat.branchId), isNull(station.archivedAt))).limit(1);
    if ((lock ? await stationQuery.for('share') : await stationQuery).length === 0) throw errors.unauthorized();
  }
  if (seat.lockedAt) throw new AppError(423, 'SESSION_LOCKED', 'This session is locked — unlock to continue');
  if (actor.mustChangePassword) throw new AppError(403, 'MUST_CHANGE_PASSWORD', 'Password change required before continuing');
  if (seat.sessionClass !== 'staff') throw errors.forbidden('Operator selection requires a staff session.');
  await requireSwitchGrant(tx, actor.id, actor.operatorId, lock);
  const revision = await revisionOf(tx, seat.id);
  if (seat.expiresAt <= (now ?? new Date())) throw errors.unauthorized();
  return { state: { homeOperatorId: actor.operatorId, effectiveOperatorId, operatorOverride: seat.operatorOverride,
    branchId: seat.branchId, stationId: seat.stationId, revision, changed: false }, expiresAt: seat.expiresAt };
}

/** An unregistered service: options observe one snapshot and never repair or lock a session. */
export async function operatorSwitchOptionsOf(
  db: Db, identity: OperatorSwitchIdentity, now?: Date,
): Promise<OperatorSwitchOptions> {
  return db.transaction(async tx => ({ ...(await contextOf(tx, identity, now, false)).state,
    operators: await tx.select({ id: operator.id, name: operator.name }).from(operator)
      .where(isNull(operator.archivedAt)).orderBy(asc(operator.name), asc(operator.id)),
  }), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Session/audit transaction only; central authentication and cached replay remain separate integration. */
export async function switchSessionOperator(
  db: Db, input: OperatorSwitchInput, ctx: OpContext = {}, now?: Date,
): Promise<OperatorSwitchResult> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw errors.badRequest('A nonnegative session revision is required.');
  if (ctx.idempotency && ctx.idempotency.accountId !== input.accountId) throw errors.forbidden('The request claim belongs to another account.');
  // Never attribute a switch to actor/operator/branch fields supplied by the calling context.
  const verifiedCtx: OpContext = { ...ctx, actorAccountId: null, operatorId: null, branchId: null };
  return withTx(db, verifiedCtx, ACTION, async tx => {
    const { state: before, expiresAt } = await contextOf(tx, input, now, true, verifiedCtx);
    if (before.revision !== input.expectedRevision) throw errors.conflict('OPERATOR_SWITCH_STALE', 'The session context changed. Read it again before selecting an operator.');
    // PostgreSQL stores UUIDs canonically. Accepted upper-case input must
    // describe the same operator in the response, audit and replay check.
    const selectedOperatorId = input.operatorId?.toLowerCase() ?? null;
    const operatorOverride = selectedOperatorId === null || selectedOperatorId === before.homeOperatorId ? null : selectedOperatorId;
    const effectiveOperatorId = operatorOverride ?? before.homeOperatorId;
    const [target] = await tx.select({ archivedAt: operator.archivedAt }).from(operator)
      .where(eq(operator.id, effectiveOperatorId)).limit(1).for('share');
    if (!target || target.archivedAt) throw errors.notFound('Operator not found');
    if (expiresAt <= (now ?? new Date())) throw errors.unauthorized();
    const changed = effectiveOperatorId !== before.effectiveOperatorId;
    const result: OperatorSwitchResult = { homeOperatorId: before.homeOperatorId, effectiveOperatorId, operatorOverride,
      branchId: changed ? null : before.branchId, stationId: changed ? null : before.stationId, revision: before.revision + 1, changed };
    if (changed || operatorOverride !== before.operatorOverride) await tx.update(session).set({ operatorOverride,
      branchId: result.branchId, stationId: result.stationId }).where(and(eq(session.id, input.sessionId), eq(session.accountId, input.accountId)));
    // This changes the home account's session. Its working seat is factual
    // before/after data, not a branch of that home operator's audit scope.
    await audit.record(tx, { actorAccountId: input.accountId, operatorId: before.homeOperatorId, branchId: null,
      action: ACTION, entityType: 'session', entityId: input.sessionId, before, after: result, requestId: ctx.requestId });
    return result;
  });
}
