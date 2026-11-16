import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema as s, type Db } from '@oto/db';
import { newId, type InboxAccessChange, type InboxAccessSelection, type InboxAccountAccess } from '@oto/shared';
import { errors } from '../lib/errors';
import { assertAccountInScope, assertDominatesAccount, branchReach, loadTargetAccount } from './access-control';
import { audit } from './audit';
import { hasPermission, resolveEffectivePermissions, type EffectivePermission } from './permissions';
import type { Exec, Tx } from './tx';
import { inboxAdministratorSql } from './inbox/access';

export type InboxAccessActor = { accountId: string; operatorId: string; requestId?: string };
export function normalizeInboxAccess(selection: InboxAccessSelection): InboxAccessSelection {
  return { categories: selection.categories === null ? null : [...new Set(selection.categories)].sort(),
    channelAccountIds: selection.channelAccountIds === null ? null : [...new Set(selection.channelAccountIds.map(id => id.toLowerCase()))].sort() };
}
export const sameInboxAccess = (a: InboxAccessSelection, b: InboxAccessSelection): boolean =>
  JSON.stringify(normalizeInboxAccess(a)) === JSON.stringify(normalizeInboxAccess(b));
const canManage = (effective: EffectivePermission[], operatorId: string) =>
  hasPermission(effective, 'admin:role:assign', { operatorId, operatorOnly: true });

/** Existing account scope/dominance rules, freshly evaluated before any read or write. */
export async function authorizeInboxAccess(db: Exec, actor: InboxAccessActor, accountId: string, write: boolean) {
  const effective = await resolveEffectivePermissions(db as Db, actor.accountId);
  if (write && !canManage(effective, actor.operatorId)) throw errors.forbidden('Operator-wide role assignment permission is required to change Inbox access.');
  await loadTargetAccount(db as Db, actor.operatorId, accountId);
  await assertAccountInScope(db, effective, actor.operatorId, accountId, 'admin:role:read');
  if (write) await assertAccountInScope(db, effective, actor.operatorId, accountId, 'admin:role:assign');
  await assertDominatesAccount(db, effective, actor.operatorId, accountId);
  const result = await db.execute<{ administrator: boolean }>(sql`select ${inboxAdministratorSql({ accountId, operatorId: actor.operatorId })} as administrator`);
  const administrator = Boolean(result.rows[0]?.administrator);
  if (write && administrator) throw errors.forbidden('Operator administrators retain their existing Inbox access.');
  return { effective, administrator };
}

async function policyOf(db: Exec, operatorId: string, accountId: string) {
  const [policy] = await db.select().from(s.accountInboxAccess)
    .where(and(eq(s.accountInboxAccess.operatorId, operatorId), eq(s.accountInboxAccess.accountId, accountId))).limit(1);
  const children = policy?.restrictChannels ? await db.select({ id: s.accountInboxChannelAccess.channelAccountId })
    .from(s.accountInboxChannelAccess).where(and(eq(s.accountInboxChannelAccess.operatorId, operatorId), eq(s.accountInboxChannelAccess.accountId, accountId))) : [];
  return { version: policy?.version ?? 0, ...normalizeInboxAccess({ categories: policy?.allowedCategories ?? null,
    channelAccountIds: policy?.restrictChannels ? children.map(row => row.id) : null }) };
}

export async function readInboxAccountAccess(db: Exec, actor: InboxAccessActor, accountId: string): Promise<InboxAccountAccess> {
  const { effective, administrator } = await authorizeInboxAccess(db, actor, accountId, false);
  const policy = await policyOf(db, actor.operatorId, accountId);
  const reach = branchReach(effective, 'admin:role:read', actor.operatorId);
  const channels = await db.select({ id: s.channelAccount.id, channel: s.channelAccount.channel,
    displayName: s.channelAccount.displayName, branchId: s.channelAccount.branchId }).from(s.channelAccount)
    .where(and(eq(s.channelAccount.operatorId, actor.operatorId), isNull(s.channelAccount.archivedAt),
      reach.kind === 'operator' ? undefined : reach.branchIds.length === 0 ? sql`false`
        : or(isNull(s.channelAccount.branchId), inArray(s.channelAccount.branchId, reach.branchIds))))
    .orderBy(asc(s.channelAccount.displayName), asc(s.channelAccount.id));
  return { accountId, version: policy.version, categories: administrator ? null : policy.categories,
    channelAccountIds: administrator ? null : policy.channelAccountIds,
    administrator, canManage: canManage(effective, actor.operatorId) && !administrator, channels };
}

async function checkedChange(db: Exec, actor: InboxAccessActor, accountId: string, input: InboxAccessChange) {
  await authorizeInboxAccess(db, actor, accountId, true);
  const current = await policyOf(db, actor.operatorId, accountId);
  const after = normalizeInboxAccess(input);
  if (after.channelAccountIds?.length) {
    const channels = await db.select({ id: s.channelAccount.id }).from(s.channelAccount)
      .where(and(eq(s.channelAccount.operatorId, actor.operatorId), isNull(s.channelAccount.archivedAt), inArray(s.channelAccount.id, after.channelAccountIds)));
    if (channels.length !== after.channelAccountIds.length) throw errors.notFound('A selected Inbox channel is unavailable.');
  }
  return { current, after };
}
const stale = () => errors.conflict('INBOX_ACCESS_STALE', 'Inbox access changed after it was read. Refresh and review the current limits before saving.');

export async function previewInboxAccountAccess(db: Exec, actor: InboxAccessActor, accountId: string, input: InboxAccessChange) {
  const { current, after } = await checkedChange(db, actor, accountId, input);
  if (current.version !== input.expectedVersion) throw stale();
  return { accountId, version: current.version, before: { categories: current.categories, channelAccountIds: current.channelAccountIds },
    after, changed: !sameInboxAccess(current, after) };
}

/** Version-CAS owns retries; no stored response may bypass current authorization. */
export async function saveInboxAccountAccess(tx: Tx, actor: InboxAccessActor, accountId: string, input: InboxAccessChange) {
  await authorizeInboxAccess(tx, actor, accountId, true);
  await tx.select({ id: s.account.id }).from(s.account)
    .where(and(eq(s.account.operatorId, actor.operatorId), eq(s.account.id, accountId))).for('update');
  const { current, after } = await checkedChange(tx, actor, accountId, input);
  if (current.version !== input.expectedVersion) {
    // A genuine resend of the immediately preceding same change is harmless;
    // any later or different change must be reviewed, never overwritten.
    if (current.version === input.expectedVersion + 1 && sameInboxAccess(current, after)) return readInboxAccountAccess(tx, actor, accountId);
    throw stale();
  }
  if (sameInboxAccess(current, after)) return readInboxAccountAccess(tx, actor, accountId);
  const version = current.version + 1;
  await tx.insert(s.accountInboxAccess).values({ id: newId(), operatorId: actor.operatorId, accountId,
    allowedCategories: after.categories, restrictChannels: after.channelAccountIds !== null, version, updatedByAccountId: actor.accountId })
    .onConflictDoUpdate({ target: [s.accountInboxAccess.operatorId, s.accountInboxAccess.accountId],
      set: { allowedCategories: after.categories, restrictChannels: after.channelAccountIds !== null, version, updatedByAccountId: actor.accountId, updatedAt: new Date() } });
  await tx.delete(s.accountInboxChannelAccess).where(and(eq(s.accountInboxChannelAccess.operatorId, actor.operatorId), eq(s.accountInboxChannelAccess.accountId, accountId)));
  if (after.channelAccountIds?.length) await tx.insert(s.accountInboxChannelAccess).values(after.channelAccountIds.map(channelAccountId => ({ id: newId(), operatorId: actor.operatorId, accountId, channelAccountId })));
  await audit.record(tx, { actorAccountId: actor.accountId, operatorId: actor.operatorId, requestId: actor.requestId,
    action: 'inbox.account_access.update', entityType: 'core.account', entityId: accountId,
    before: { version: current.version, categories: current.categories, channelAccountIds: current.channelAccountIds }, after: { version, ...after } });
  return readInboxAccountAccess(tx, actor, accountId);
}
