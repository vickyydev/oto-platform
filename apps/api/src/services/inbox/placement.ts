import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { AI_INTENTS, type AiIntent } from '@oto/assistant';
import { assignment, conversation, schema as s, setting, type InboxCategory } from '@oto/db';
import { isHeldInGeneral } from '@oto/shared';
import { audit } from '../audit';
import type { Exec, Tx } from '../tx';
import { routeConversation, type PlacementReason } from './router';

/**
 * GENERAL QUESTIONS STAY OUT OF THE PARK INBOXES (SCRUM-789; owner, Nov 2026).
 *
 * Until now every `general` conversation was seated on a park's Reception
 * team the moment it opened, so a price or an opening-hours question the
 * assistant answers by itself sat in a park's inbox beside the conversations
 * that really need that park's people. Now:
 *
 *   THE GENERAL INBOX   a `general` conversation the assistant is answering
 *                       is HELD: no team, nobody seated, `last_routed_at`
 *                       set (the decision was made). Its park is still on it
 *                       when the number or the customer says one — prices
 *                       differ by park — but knowing the park does not seat
 *                       it. It shows under All conversations and under the
 *                       General view, and in no park view.
 *
 *   A PARK'S INBOX      the thread is seated on the park's Reception team —
 *                       the routing it would have had on its first message,
 *                       made now, with the usual pills — when it becomes the
 *                       local team's work:
 *                         - its topic is a LOCAL TOPIC (below): a nanny, a
 *                           drop-off, a child in our care, lost property;
 *                         - the assistant hands it to the branch desk (an
 *                           unclear or emotional message, a request the
 *                           knowledge does not cover, a customer asking for a
 *                           person, a withheld reply): something that
 *                           happened on a visit and a booking the staff must
 *                           change arrive this way;
 *                         - a person moves it there by hand, as before.
 *
 *   NEVER STRANDED      a thread is held only while the assistant holds it.
 *                       Where no assistant turn will read the customer's
 *                       newest line (the assistant is off, in shadow, the
 *                       park is closed, the thread is paused, a person acted
 *                       on it) and whenever a turn ends without an answer
 *                       (cancelled, shadowed, silent, a provider failure) the
 *                       thread is seated at its park, as every general
 *                       conversation was before. Spam the assistant tidied
 *                       and a line that needs no reply ("thanks, bye": the
 *                       model's own silence) owe nothing and stay out. A
 *                       thread a person holds a seat on is theirs.
 *
 * Complaints, refunds, birthdays and events keep their own queues (the
 * playbook's destinations); nothing here touches them. Conversations seated
 * before this rule stay where they are: no data is moved, the rule reads new
 * routing decisions only.
 *
 * No schema change: "held" is `category = 'general'` with no team and a
 * routing time, on the columns the conversation already has.
 */

/**
 * The topics that are the park's own work, by the assistant's intent word.
 * The ticket's list: a nanny, a drop-off, a child in our care, lost property.
 * (Something that happened on a visit and a booking the staff must change
 * have no intent of their own: the assistant hands them to the branch desk,
 * which seats them at the park. A complaint and a refund are the GM's.)
 */
export const DEFAULT_LOCAL_TOPICS: readonly AiIntent[] = ['nanny_booking', 'drop_off_service', 'drop_off_care', 'lost_item'];

/**
 * The operator's own list, when it has saved one: a `core.setting` row under
 * this key, `{ "topics": ["lost_item", …] }` — intent words only. A row of
 * another shape, or one naming no known intent, is ignored and the default
 * list stands. Changing it is a data edit, not a release.
 */
export const INBOX_LOCAL_TOPICS_KEY = 'inbox_local_topics';

const KNOWN: ReadonlySet<string> = new Set<string>(AI_INTENTS);

/** A saved list, read defensively; null when it is not one. */
export function readLocalTopics(value: unknown): ReadonlySet<string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const list = (value as { topics?: unknown }).topics;
  if (!Array.isArray(list)) return null;
  const topics = list.filter((x): x is string => typeof x === 'string' && KNOWN.has(x));
  return topics.length > 0 ? new Set(topics) : null;
}

/** The operator's local topics: its saved list, else the default. Read fresh; never cached. */
export async function localTopicsOf(exec: Exec, operatorId: string): Promise<ReadonlySet<string>> {
  const [row] = await exec
    .select({ value: setting.value })
    .from(setting)
    .where(and(eq(setting.operatorId, operatorId), eq(setting.key, INBOX_LOCAL_TOPICS_KEY)))
    .limit(1);
  return (row && readLocalTopics(row.value)) || new Set<string>(DEFAULT_LOCAL_TOPICS);
}

/** What "held in the General inbox" reads of a conversation. */
export interface PoolFacts {
  category: InboxCategory;
  teamId: string | null;
  lastRoutedAt: Date | null;
}

/** Held in the General inbox: general, routed, and on no team (`@oto/shared` `isHeldInGeneral`). */
export function isGeneralPool(c: PoolFacts): boolean {
  return isHeldInGeneral(c);
}

/** `isGeneralPool` over `inbox.conversation`, for the list's filters. */
export const generalPoolSql: SQL = sql`(${s.conversation.category} = 'general' and ${s.conversation.teamId} is null and ${s.conversation.lastRoutedAt} is not null)`;

/**
 * Seats a held thread at its park: the routing a general conversation gets on
 * its first message (the park's rule, else its Reception team, else the first
 * Reception team), made now, with the `routed` and `assigned` pills and an
 * audit row. A thread that is not held (seated meanwhile, another category,
 * handled), or that a person holds a seat on, is left exactly as it is: false.
 */
export async function placeIfPooled(
  tx: Tx,
  ref: { operatorId: string; conversationId: string },
  opts: { at: Date; reason: PlacementReason; requestId?: string | null },
): Promise<boolean> {
  const [conv] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.operatorId, ref.operatorId), eq(conversation.id, ref.conversationId)))
    .limit(1)
    .for('update');
  if (!conv || !isGeneralPool(conv) || conv.status !== 'active') return false;
  // A person seated on it (the GM or a coordinator, who are in no team, took
  // it from the General inbox) owns it and sees it: nothing to seat.
  const [seated] = await tx
    .select({ id: assignment.id })
    .from(assignment)
    .where(and(eq(assignment.operatorId, conv.operatorId), eq(assignment.conversationId, conv.id), isNull(assignment.releasedAt)))
    .limit(1);
  if (seated) return false;
  const routed = await routeConversation(tx, {
    operatorId: conv.operatorId,
    conversationId: conv.id,
    category: conv.category,
    language: conv.language ?? 'en',
    branchId: conv.branchId,
    at: opts.at,
    placed: opts.reason,
  });
  await audit.record(tx, {
    actorAccountId: null,
    action: 'inbox.conversation.route',
    entityType: 'inbox.conversation',
    entityId: conv.id,
    operatorId: conv.operatorId,
    branchId: conv.branchId,
    requestId: opts.requestId ?? null,
    before: { category: conv.category, teamId: null, branchId: conv.branchId, held: 'general' },
    after: {
      category: conv.category,
      branchId: conv.branchId,
      teamId: routed.teamId,
      ruleId: routed.ruleId,
      fallback: routed.fallback,
      placed: opts.reason,
      assignments: routed.assignments.map((a) => ({ id: a.id, slot: a.slot, assigneeKind: a.assigneeKind, accountId: a.accountId, teamId: a.teamId })),
    },
  });
  return true;
}
