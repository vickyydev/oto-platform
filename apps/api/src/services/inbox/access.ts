import { and, eq, sql, type SQL } from 'drizzle-orm';
import { schema as s } from '@oto/db';
import { errors } from '../../lib/errors';
import type { Exec } from '../tx';

type Person = { accountId: string; operatorId: string };

/** Actual current management grant, never the role's name or operator-wide reading. */
export function inboxAdministratorSql(person: Person): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${s.roleAssignment} ia
    join ${s.rolePermission} ip on ip.role_id = ia.role_id
    where ia.account_id = ${person.accountId} and ip.permission = 'admin:operator:all'
      and ia.scope_type = 'operator' and (ia.scope_id is null or ia.scope_id = ${person.operatorId}::uuid))`;
}

/** Fresh database intersection; assignment and operator-wide reading cannot bypass it. */
export function inboxPolicyAllowsSql(person: Person,
  category: SQL = sql`${s.conversation.category}`,
  channel: SQL = sql`${s.conversation.channelAccountId}`,
): SQL<boolean> {
  return sql<boolean>`(${inboxAdministratorSql(person)} or not exists (
    select 1 from ${s.accountInboxAccess} ap
    where ap.operator_id = ${person.operatorId}::uuid and ap.account_id = ${person.accountId}::uuid
      and ((ap.allowed_categories is not null and not (${category} = any(ap.allowed_categories)))
        or (ap.restrict_channels and not exists (select 1 from ${s.accountInboxChannelAccess} ac
          where ac.operator_id = ap.operator_id and ac.account_id = ap.account_id and ac.channel_account_id = ${channel})))
  ))`;
}

/** Channel names/options obey channel limits; an empty category allowlist exposes no channels. */
export function inboxChannelAllowsSql(person: Person, channel: SQL = sql`${s.channelAccount.id}`): SQL<boolean> {
  return sql<boolean>`(${inboxAdministratorSql(person)} or not exists (
    select 1 from ${s.accountInboxAccess} ap
    where ap.operator_id = ${person.operatorId}::uuid and ap.account_id = ${person.accountId}::uuid
      and ((ap.allowed_categories is not null and cardinality(ap.allowed_categories) = 0)
        or (ap.restrict_channels and not exists (select 1 from ${s.accountInboxChannelAccess} ac
          where ac.operator_id = ap.operator_id and ac.account_id = ap.account_id and ac.channel_account_id = ${channel})))
  ))`;
}

export async function assertInboxPolicy(db: Exec, person: Person, category: string, channelAccountId: string): Promise<void> {
  const answer = await db.execute<{ allowed: boolean }>(sql`select ${inboxPolicyAllowsSql(person, sql`${category}`, sql`${channelAccountId}::uuid`)} as allowed`);
  if (!answer.rows[0]?.allowed) throw errors.notFound('Inbox item not found');
}
/** Proposed examples still linked to a person obey that thread's restrictions. */
export function inboxSourceAllowsSql(person: Person, sourceConversationId: SQL): SQL<boolean> {
  return sql<boolean>`(${sourceConversationId} is null or exists (select 1 from ${s.conversation}
    where ${s.conversation.operatorId} = ${person.operatorId}::uuid and ${s.conversation.id} = ${sourceConversationId}
      and ${s.conversation.archivedAt} is null and ${inboxPolicyAllowsSql(person)}))`;
}

/** Metadata for the current viewer's filters, read again with every list refresh. */
export async function inboxVisibilityLimits(db: Exec, person: Person) {
  const admin = await db.execute<{ administrator: boolean }>(sql`select ${inboxAdministratorSql(person)} as administrator`);
  const [policy] = await db.select().from(s.accountInboxAccess)
    .where(and(eq(s.accountInboxAccess.operatorId, person.operatorId), eq(s.accountInboxAccess.accountId, person.accountId))).limit(1);
  if (admin.rows[0]?.administrator || !policy) return { categories: null, channelAccountIds: null, version: policy?.version ?? 0 };
  const channels = policy.restrictChannels ? await db.select({ id: s.accountInboxChannelAccess.channelAccountId }).from(s.accountInboxChannelAccess)
    .where(and(eq(s.accountInboxChannelAccess.operatorId, person.operatorId), eq(s.accountInboxChannelAccess.accountId, person.accountId))) : [];
  return { categories: policy.allowedCategories?.slice().sort() ?? null, channelAccountIds: policy.restrictChannels ? channels.map(row => row.id).sort() : null, version: policy.version };
}
