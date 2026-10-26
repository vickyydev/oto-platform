import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { account, operator, role, roleAssignment, rolePermission, suiteControlApproval,
  FLAG_SCOPE_TYPES, SUITE_APP_KEYS, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import { z } from 'zod';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { withTx, type OpContext, type Tx } from './tx';

const permission = 'console:release:kill_switch';
const requestLifetimeMs = 10 * 60_000;
const operationSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.literal('kill_switch.set'),
  key: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_.-]*$/),
  targetApp: z.enum(SUITE_APP_KEYS),
  scopeType: z.enum(FLAG_SCOPE_TYPES),
  scopeId: z.string().uuid().nullable(),
  operatorId: z.string().uuid().nullable(),
  expectedRevision: z.number().int().min(0).max(2_147_483_647),
  value: z.union([z.boolean(), z.number().finite(), z.string().max(256), z.null()]),
  expiresAt: z.string().datetime(),
  reason: z.string().trim().min(1).max(1000),
}).strict().refine(op => op.scopeType === 'platform'
  ? op.scopeId === null && op.operatorId === null
  : op.scopeId !== null && op.operatorId !== null
    && (op.scopeType !== 'operator' || op.scopeId === op.operatorId));
const referenceSchema = z.object({ id: z.string().uuid(), expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type SuiteControlOperation = z.infer<typeof operationSchema>;
type ApprovalRow = typeof suiteControlApproval.$inferSelect;

function conflict() { return errors.conflict('APPROVAL_CONTEXT_CHANGED', 'The reviewed approval is no longer valid.'); }
function actorOf(ctx: OpContext) {
  const parsed = z.string().uuid().safeParse(ctx.actorAccountId);
  if (!parsed.success) throw errors.forbidden('A current platform administrator is required.');
  return parsed.data;
}
function digest(operation: SuiteControlOperation) {
  // Parsing rebuilds the declared property order, independent of jsonb's key order.
  return createHash('sha256').update(JSON.stringify(operation)).digest('hex');
}
function view(row: ApprovalRow, operation: SuiteControlOperation) {
  return { id: row.id, state: row.state, payloadSha256: row.payloadSha256, operatorId: row.operatorId,
    requesterAccountId: row.requesterAccountId, approverAccountId: row.approverAccountId, operation,
    createdAt: row.createdAt.toISOString(), requestExpiresAt: row.requestExpiresAt.toISOString() };
}
function reviewed(row: ApprovalRow, expectedPayloadSha256?: string) {
  const parsed = operationSchema.safeParse(row.operation);
  if (!parsed.success || row.action !== parsed.data.action || row.operatorId !== parsed.data.operatorId
    || digest(parsed.data) !== row.payloadSha256
    || (expectedPayloadSha256 !== undefined && expectedPayloadSha256 !== row.payloadSha256)) throw conflict();
  return parsed.data;
}
function reference(input: unknown) {
  const parsed = referenceSchema.safeParse(input);
  if (!parsed.success) throw errors.badRequest('An approval id and reviewed payload digest are required.');
  return parsed.data;
}

/** Fresh canonical role checks; supplied effective-permission unions are never authority here. */
async function lockAdministrators(tx: Tx, ids: readonly string[]) {
  const uniqueIds = [...new Set(ids)].sort();
  const accounts = await tx.select({ id: account.id, operatorId: account.operatorId, status: account.status,
    mustChangePassword: account.mustChangePassword }).from(account).where(inArray(account.id, uniqueIds))
    // Keep account flags stable while permitting native grant-removal audits' actor FK checks.
    .orderBy(asc(account.id)).for('no key update');
  if (accounts.length !== uniqueIds.length || accounts.some(a => a.status !== 'active' || a.mustChangePassword))
    throw errors.forbidden('A current platform administrator is required.');
  const owners = [...new Set(accounts.map(a => a.operatorId))].sort();
  const liveOwners = await tx.select({ id: operator.id }).from(operator)
    .where(and(inArray(operator.id, owners), isNull(operator.archivedAt))).orderBy(asc(operator.id)).for('share');
  if (liveOwners.length !== owners.length) throw errors.forbidden('A current platform administrator is required.');
  const grants = await tx.select({ accountId: roleAssignment.accountId }).from(roleAssignment)
    .innerJoin(role, eq(roleAssignment.roleId, role.id))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(and(inArray(roleAssignment.accountId, uniqueIds), isNull(roleAssignment.archivedAt),
      eq(roleAssignment.scopeType, 'operator'), isNull(roleAssignment.scopeId),
      isNull(role.operatorId), eq(role.isSystem, true), eq(role.name, 'platform_admin'),
      eq(rolePermission.permission, permission))).orderBy(asc(roleAssignment.id)).for('share');
  const granted = new Set(grants.map(g => g.accountId));
  if (uniqueIds.some(id => !granted.has(id))) throw errors.forbidden('A current platform administrator is required.');
}

async function lockedApproval(tx: Tx, id: string, ctx: OpContext) {
  const [row] = await tx.select().from(suiteControlApproval).where(eq(suiteControlApproval.id, id)).for('update');
  if (!row) throw errors.notFound('Approval not found.');
  // A private context carries the request's original event owner, not the approver's working operator.
  ctx.operatorId = row.operatorId; ctx.branchId = null;
  return row;
}
async function record(tx: Tx, ctx: OpContext, action: string, row: ApprovalRow, before?: ApprovalRow) {
  const operation = reviewed(row);
  await audit.record(tx, { actorAccountId: ctx.actorAccountId ?? null, operatorId: row.operatorId, branchId: null,
    action: `suite_control.approval_${action}`, entityType: 'suite_control_approval', entityId: row.id,
    before: before ? { state: before.state, payloadSha256: before.payloadSha256 } : undefined,
    after: { state: row.state, payloadSha256: row.payloadSha256, requesterAccountId: row.requesterAccountId,
      approverAccountId: row.approverAccountId, targetApp: operation.targetApp, reason: operation.reason }, requestId: ctx.requestId });
}
async function expire(tx: Tx, ctx: OpContext, row: ApprovalRow, now: Date) {
  if (row.state === 'expired' || row.state === 'consumed' || row.requestExpiresAt.getTime() > now.getTime()) return row;
  const [expired] = await tx.update(suiteControlApproval).set({ state: 'expired', expiredAt: now, updatedAt: now })
    .where(eq(suiteControlApproval.id, row.id)).returning();
  await record(tx, ctx, 'expired', expired!, row);
  return expired!;
}

export async function requestSuiteControlApproval(db: Db, ctx: OpContext, input: unknown) {
  const actor = actorOf(ctx), parsed = operationSchema.safeParse(input);
  if (!parsed.success) throw errors.badRequest('A valid intended control operation is required.');
  const operation = parsed.data;
  const ownerCtx = { ...ctx, operatorId: operation.operatorId, branchId: null };
  return withTx(db, ownerCtx, 'suite_control.approval_request', async tx => {
    await lockAdministrators(tx, [actor]);
    const now = new Date();
    if (Date.parse(operation.expiresAt) <= now.getTime()) throw conflict();
    const [row] = await tx.insert(suiteControlApproval).values({ id: newId(), action: operation.action,
      operation, payloadSha256: digest(operation), operatorId: operation.operatorId,
      requesterAccountId: actor, state: 'pending', createdAt: now, updatedAt: now,
      requestExpiresAt: new Date(now.getTime() + requestLifetimeMs) }).returning();
    await record(tx, ownerCtx, 'requested', row!);
    return view(row!, operation);
  });
}

export async function approveSuiteControlApproval(db: Db, ctx: OpContext, input: unknown) {
  const actor = actorOf(ctx), ref = reference(input), ownerCtx = { ...ctx };
  return withTx(db, ownerCtx, 'suite_control.approval_approve', async tx => {
    const row = await lockedApproval(tx, ref.id, ownerCtx), operation = reviewed(row, ref.expectedPayloadSha256);
    if (actor === row.requesterAccountId) throw errors.forbidden('A different platform administrator must approve.');
    await lockAdministrators(tx, [row.requesterAccountId, actor]);
    const now = new Date(), current = await expire(tx, ownerCtx, row, now);
    if (current.state === 'expired') return view(current, operation);
    if (current.state === 'approved' && current.approverAccountId === actor) return view(current, operation);
    if (current.state !== 'pending' || Date.parse(operation.expiresAt) <= now.getTime()) throw conflict();
    const [approved] = await tx.update(suiteControlApproval).set({ state: 'approved', approverAccountId: actor,
      approvedAt: now, updatedAt: now }).where(eq(suiteControlApproval.id, row.id)).returning();
    await record(tx, ownerCtx, 'approved', approved!, row);
    return view(approved!, operation);
  });
}

/** Expiry only removes authority. A background caller may have no actor; the stored owner survives. */
export async function expireSuiteControlApproval(db: Db, ctx: OpContext, input: { id: string }) {
  const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(input), ownerCtx = { ...ctx };
  if (!parsed.success) throw errors.badRequest('An approval id is required.');
  return withTx(db, ownerCtx, 'suite_control.approval_expire', async tx => {
    const row = await lockedApproval(tx, parsed.data.id, ownerCtx), operation = reviewed(row);
    return view(await expire(tx, ownerCtx, row, new Date()), operation);
  });
}

/** The caller must commit the returned expiry outcome, or atomically commit consumption and its real effect. */
export async function consumeSuiteControlApproval<T>(tx: Tx, ctx: OpContext, input: unknown,
  effect: (tx: Tx, operation: SuiteControlOperation) => Promise<T>) {
  const actor = actorOf(ctx), ref = reference(input), ownerCtx = { ...ctx };
  const row = await lockedApproval(tx, ref.id, ownerCtx), operation = reviewed(row, ref.expectedPayloadSha256);
  if (actor !== row.requesterAccountId && actor !== row.approverAccountId)
    throw errors.forbidden('Only the reviewed administrators may consume this approval.');
  if (row.state === 'consumed') throw conflict();
  await lockAdministrators(tx, [row.requesterAccountId, ...(row.approverAccountId ? [row.approverAccountId] : [])]);
  const now = new Date(), current = await expire(tx, ownerCtx, row, now);
  if (current.state === 'expired') return { approval: view(current, operation) };
  if (current.state !== 'approved' || Date.parse(operation.expiresAt) <= now.getTime()) throw conflict();
  // The real writer must still validate catalogue, lineage, value type, revision and maximum TTL in this tx.
  const result = await effect(tx, operation);
  const settledAt = new Date();
  if (settledAt.getTime() >= row.requestExpiresAt.getTime() || settledAt.getTime() >= Date.parse(operation.expiresAt)) throw conflict();
  const [consumed] = await tx.update(suiteControlApproval).set({ state: 'consumed', consumedAt: settledAt, updatedAt: settledAt })
    .where(eq(suiteControlApproval.id, row.id)).returning();
  await record(tx, ownerCtx, 'consumed', consumed!, row);
  return { approval: view(consumed!, operation), result };
}
