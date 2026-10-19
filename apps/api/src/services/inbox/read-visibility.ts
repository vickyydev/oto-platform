import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Db } from '@oto/db';
import type { InboxViewerScope, Permission } from '@oto/shared';
import type { EffectivePermission } from '../permissions';
import { errors } from '../../lib/errors';
import type { Exec } from '../tx';

/**
 * WHO SEES WHICH CONVERSATION (S2-19 I2b, SCRUM-581; plan §3.2).
 *
 * A conversation is visible to an account when any one of these holds:
 *   (a) it holds `inbox:conversation:read` at operator scope;
 *   (b) it holds it at the scope of the conversation's branch;
 *   (c) it holds it at the scope of the conversation's TEAM DEPARTMENT — the
 *       department-scoped `inbox_agent` grant is what "in the team" means;
 *   (d) it holds an active slot (primary or support) on the conversation —
 *       how the GM and the entertainment coordinator, who are in no team,
 *       see the threads they are on.
 *
 * The rule is enforced HERE, against the database, on every read: the list
 * is the predicate in SQL, a by-id read loads the conversation inside the
 * caller's operator and then asks the same question of that one row. The pure
 * statement of it is `isVisibleTo` in `@oto/shared`, and the read test pins
 * the two together.
 *
 * Entering an inbox route needs the permission held SOMEWHERE in the
 * operator, which the route-level guard cannot express: a department-scoped
 * grant covers no target the plugin could name before the handler runs. So
 * the inbox routes declare `dynamicPermission` and call
 * `requireInboxPermission` first.
 */

export const INBOX_READ: Permission = 'inbox:conversation:read';

/** Does this grant sit inside the caller's operator (or above every operator)? */
function grantInOperator(g: EffectivePermission, operatorId: string): boolean {
  // Branch, department and record grants are the account's own, and an
  // account belongs to one operator: the scope id is that operator's.
  return g.scopeType !== 'operator' || g.scopeId === null || g.scopeId === operatorId;
}

/** The permission held at ANY scope within the operator. */
export function holdsAnywhere(effective: EffectivePermission[], permission: Permission, operatorId: string): boolean {
  return effective.some((g) => g.permission === permission && grantInOperator(g, operatorId));
}

/** What the viewer's read grants say, as `isVisibleTo` takes it. */
export function viewerScopeOf(
  effective: EffectivePermission[],
  accountId: string,
  operatorId: string,
): InboxViewerScope {
  const reads = effective.filter((g) => g.permission === INBOX_READ && grantInOperator(g, operatorId));
  const ids = (type: EffectivePermission['scopeType']) => [
    ...new Set(reads.filter((g) => g.scopeType === type && g.scopeId !== null).map((g) => g.scopeId!)),
  ];
  return {
    accountId,
    operatorWide: reads.some((g) => g.scopeType === 'operator'),
    branchIds: ids('branch'),
    departmentIds: ids('department'),
  };
}

export interface InboxViewer {
  accountId: string;
  operatorId: string;
  scope: InboxViewerScope;
}

/** An active slot held by this account on the conversation row `c` stands for. */
export function heldByViewerSql(viewer: InboxViewer): SQL {
  return sql`exists (
    select 1 from ${s.assignment}
    where ${s.assignment.operatorId} = ${s.conversation.operatorId}
      and ${s.assignment.conversationId} = ${s.conversation.id}
      and ${s.assignment.accountId} = ${viewer.accountId}
      and ${s.assignment.releasedAt} is null
  )`;
}

/**
 * The visibility predicate over `inbox.conversation`, operator fence first.
 * Every list and count in the Inbox's reads is filtered by exactly this.
 */
export function visibleConversationsSql(viewer: InboxViewer): SQL {
  const fence = eq(s.conversation.operatorId, viewer.operatorId);
  if (viewer.scope.operatorWide) return fence;
  const arms: SQL[] = [heldByViewerSql(viewer)];
  if (viewer.scope.branchIds.length > 0) {
    arms.push(inArray(s.conversation.branchId, [...viewer.scope.branchIds]));
  }
  if (viewer.scope.departmentIds.length > 0) {
    arms.push(sql`exists (
      select 1 from ${s.team}
      where ${s.team.operatorId} = ${s.conversation.operatorId}
        and ${s.team.id} = ${s.conversation.teamId}
        and ${inArray(s.team.departmentId, [...viewer.scope.departmentIds])}
    )`);
  }
  return and(fence, or(...arms))!;
}

/**
 * Load one conversation by id for a viewer: inside the caller's operator
 * first, then the visibility rule. A conversation the viewer cannot see
 * answers 404 exactly as one that does not exist, so its existence is not
 * revealed (plan §3.2).
 */
export async function loadVisibleConversation(
  db: Exec,
  viewer: InboxViewer,
  conversationId: string,
): Promise<typeof s.conversation.$inferSelect> {
  const [row] = await (db as Db)
    .select()
    .from(s.conversation)
    .where(and(eq(s.conversation.id, conversationId), visibleConversationsSql(viewer)))
    .limit(1);
  if (!row) throw errors.notFound('Conversation not found');
  return row;
}

/** The active-assignment rows of some conversations, for lists and headers. */
export function activeAssignmentsOf(conversationIds: string[]) {
  return and(inArray(s.assignment.conversationId, conversationIds), isNull(s.assignment.releasedAt));
}
