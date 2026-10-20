import { and, eq, inArray, sql } from 'drizzle-orm';
import { aiTurn, conversation, inboxEvent, message } from '@oto/db';
import { newId } from '@oto/shared';
import { audit } from '../audit';
import type { Exec, Tx } from '../tx';
import type { InboxAiSchedule } from './ai-runtime';

/**
 * THE ASSISTANT'S TURNS ON A THREAD (SCRUM-590, round A2 lane a; plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §A.1, §A.3, §D.1).
 *
 *   - ELIGIBILITY (§A.3): one reading, used by the ingest when it writes a
 *     turn and again by the engine when it commits one. A person always
 *     outranks the assistant: within one EPISODE (from the thread's creation
 *     or its last reopen) the assistant is eligible only while no person has
 *     spoken or acted, it has not already handed over, the thread is active
 *     and not paused for it, and the contact is not erased.
 *   - SCHEDULING (§A.1, rails change R2): the ingest writes the turn in the
 *     delivery's transaction under the thread lock. One `pending` turn per
 *     thread (`ai_turn_pending_unique`): a further bubble moves its trigger to
 *     the newest message and its `due_at` to
 *     `min(first_seen + DEBOUNCE_MAX, now + DEBOUNCE)`.
 *   - CANCELLATION (§A.3, rails change R5): `cancelAiForThread`, called inside
 *     the transaction of every person's action on the thread. Its pending and
 *     deciding turns become `cancelled` (a deciding turn's commit then finds
 *     it so and writes nothing), and every queued, unsent AI line becomes
 *     `withdrawn` with an `ai_withdrawn` pill.
 *
 * NO TEXT (§D.1): a turn row, its audit rows and its events hold ids, enums,
 * counts and single words. The database refuses anything else on the turn.
 */

type ConversationRow = typeof conversation.$inferSelect;

/** Why a turn is not (or no longer) the assistant's to take. One word each, for `ai_turn.reason`. */
export type IneligibleReason = 'HANDLED' | 'PAUSED' | 'ERASED' | 'STAFF_ACTED' | 'HANDED_OVER';

export type Eligibility = { ok: true; episodeStart: Date } | { ok: false; reason: IneligibleReason; episodeStart: Date };

/** The episode began when the thread did, or at its last reopen (§A.3). */
export function episodeStartOf(conv: Pick<ConversationRow, 'createdAt' | 'reopenedAt'>): Date {
  return conv.reopenedAt && conv.reopenedAt.getTime() > conv.createdAt.getTime() ? conv.reopenedAt : conv.createdAt;
}

/**
 * §A.3, read inside the caller's transaction. A person "acted" when, since the
 * episode began, there is a staff message, an assignment a person made, or
 * any timeline event a person is the actor of (release, Divert, move, branch,
 * handled, reopen) — the last catches every action of `actions.ts` whatever
 * its assignment rows say.
 */
export async function aiEligibility(tx: Exec, conv: ConversationRow): Promise<Eligibility> {
  const episodeStart = episodeStartOf(conv);
  const no = (reason: IneligibleReason): Eligibility => ({ ok: false, reason, episodeStart });
  if (conv.status !== 'active') return no('HANDLED');
  if (conv.aiPausedAt !== null) return no('PAUSED');
  // The episode's floor for "a person acted": its start, or the last time the
  // thread was handled if that is later. A provider's timestamp is whole
  // seconds, so an automatic reopen can carry a time BEFORE the handled pill
  // a person wrote a moment earlier; everything up to that pill is the
  // previous episode's.
  const [floor] = (
    await tx.execute<{ since: string }>(sql`
      select greatest(${episodeStart.toISOString()}::timestamptz,
                      coalesce((select max(e.created_at) from inbox.event e
                                 where e.operator_id = ${conv.operatorId} and e.conversation_id = ${conv.id}
                                   and e.kind = 'handled'), '-infinity'::timestamptz))::text as since`)
  ).rows;
  const since = floor!.since;
  const [facts] = (
    await tx.execute<{ erased: boolean; staff: boolean; assigned: boolean; acted: boolean; handed: boolean }>(sql`
      select
        exists (select 1 from inbox.contact k
                 where k.operator_id = ${conv.operatorId} and k.id = ${conv.contactId} and k.erased_at is not null) as erased,
        exists (select 1 from inbox.message m
                 where m.operator_id = ${conv.operatorId} and m.conversation_id = ${conv.id}
                   and m.author_kind = 'staff' and m.created_at >= ${since}::timestamptz) as staff,
        exists (select 1 from inbox.assignment a
                 where a.operator_id = ${conv.operatorId} and a.conversation_id = ${conv.id}
                   and a.assigned_by_kind = 'account' and a.assigned_at >= ${since}::timestamptz) as assigned,
        exists (select 1 from inbox.event e
                 where e.operator_id = ${conv.operatorId} and e.conversation_id = ${conv.id}
                   and e.actor_kind = 'account' and e.kind <> 'handled'
                   and e.created_at >= ${since}::timestamptz) as acted,
        exists (select 1 from inbox.event e
                 where e.operator_id = ${conv.operatorId} and e.conversation_id = ${conv.id}
                   and e.kind = 'ai_handover' and e.created_at >= ${since}::timestamptz) as handed
    `)
  ).rows;
  if (facts?.erased) return no('ERASED');
  if (facts?.staff || facts?.assigned || facts?.acted) return no('STAFF_ACTED');
  if (facts?.handed) return no('HANDED_OVER');
  return { ok: true, episodeStart };
}

export interface ScheduleInput {
  operatorId: string;
  branchId: string | null;
  conversation: ConversationRow;
  triggerMessageId: string;
  /** The new message's own time: the trigger only ever moves forward. */
  triggerAt: Date;
  now: Date;
  requestId: string | null;
}

export interface Scheduled {
  turnId: string;
  dueAt: Date;
  /** False when an existing pending turn was extended (the debounce). */
  created: boolean;
}

/**
 * §A.1 step 7a: write or extend the thread's one pending turn. The caller has
 * checked the switch, the account's mode, its hours and eligibility, and
 * holds the thread `FOR UPDATE`. One statement either way, so two deliveries
 * of the same burst can never make two turns.
 */
export async function scheduleAiTurn(tx: Tx, schedule: InboxAiSchedule, input: ScheduleInput): Promise<Scheduled> {
  const now = input.now;
  const due = new Date(now.getTime() + schedule.debounceMs);
  const id = newId();
  const [row] = await tx
    .insert(aiTurn)
    .values({
      id,
      operatorId: input.operatorId,
      conversationId: input.conversation.id,
      triggerMessageId: input.triggerMessageId,
      state: 'pending',
      dueAt: due,
      firstSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: aiTurn.conversationId,
      targetWhere: sql`state = 'pending'`,
      set: {
        // A late-arriving OLDER bubble never becomes the trigger.
        triggerMessageId: sql`case
          when coalesce((select m.created_at from inbox.message m where m.id = ${aiTurn.triggerMessageId}), '-infinity'::timestamptz)
               <= ${input.triggerAt.toISOString()}::timestamptz
          then excluded.trigger_message_id else ${aiTurn.triggerMessageId} end`,
        dueAt: sql`least(${aiTurn.firstSeenAt} + ${`${schedule.debounceMaxMs} milliseconds`}::interval, excluded.due_at)`,
        updatedAt: now,
      },
    })
    .returning({ id: aiTurn.id, dueAt: aiTurn.dueAt, triggerMessageId: aiTurn.triggerMessageId });
  const created = row!.id === id;
  await audit.record(tx, {
    actorAccountId: null,
    action: 'inbox.ai.turn.schedule',
    entityType: 'inbox.ai_turn',
    entityId: row!.id,
    operatorId: input.operatorId,
    branchId: input.branchId,
    requestId: input.requestId,
    after: {
      turnId: row!.id,
      conversationId: input.conversation.id,
      triggerMessageId: row!.triggerMessageId,
      dueAt: row!.dueAt.toISOString(),
      extended: !created,
    },
  });
  return { turnId: row!.id, dueAt: row!.dueAt, created };
}

/** Why a person's action cancelled the assistant's work (§D.2 `inbox.ai.turn.cancel`). */
export type AiCancelReason = 'STAFF_REPLY' | 'ASSIGNED' | 'HANDLED' | 'REOPENED' | 'ERASED' | 'PAUSED';

export interface CancelOutcome {
  turnsCancelled: string[];
  messagesWithdrawn: string[];
}

/**
 * §A.3: every pending or deciding turn of the thread becomes `cancelled`, and
 * every queued, unsent AI line `withdrawn`. Inside the caller's transaction;
 * the thread is locked here too (a no-op when the caller already holds it),
 * so it is safe from a path that does not lock the thread itself (the PDPA
 * erasure locks contacts). Answers what it changed; writes nothing when there
 * was nothing to change.
 */
export async function cancelAiForThread(
  tx: Tx,
  operatorId: string,
  conversationId: string,
  reason: AiCancelReason,
  actorAccountId: string | null,
  ctx: { requestId?: string | null; now?: Date } = {},
): Promise<CancelOutcome> {
  const now = ctx.now ?? new Date();
  const [conv] = await tx
    .select({ id: conversation.id, branchId: conversation.branchId })
    .from(conversation)
    .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, conversationId)))
    .limit(1)
    .for('update');
  if (!conv) return { turnsCancelled: [], messagesWithdrawn: [] };

  const turns = await tx
    .update(aiTurn)
    .set({ state: 'cancelled', reason, leaseUntil: null, updatedAt: now })
    .where(
      and(
        eq(aiTurn.operatorId, operatorId),
        eq(aiTurn.conversationId, conversationId),
        inArray(aiTurn.state, ['pending', 'deciding']),
      ),
    )
    .returning({ id: aiTurn.id });
  for (const t of turns) {
    await audit.record(tx, {
      actorAccountId,
      action: 'inbox.ai.turn.cancel',
      entityType: 'inbox.ai_turn',
      entityId: t.id,
      operatorId,
      branchId: conv.branchId,
      requestId: ctx.requestId ?? null,
      after: { turnId: t.id, conversationId, reason, actorAccountId },
    });
  }

  const withdrawn = await tx
    .update(message)
    .set({ providerStatus: 'withdrawn', nextAttemptAt: null, updatedAt: now })
    .where(
      and(
        eq(message.operatorId, operatorId),
        eq(message.conversationId, conversationId),
        eq(message.direction, 'outbound'),
        eq(message.authorKind, 'ai'),
        eq(message.providerStatus, 'queued'),
      ),
    )
    .returning({ id: message.id });
  if (withdrawn.length > 0) {
    await tx.insert(inboxEvent).values(
      withdrawn.map((m) => ({
        id: newId(),
        operatorId,
        conversationId,
        kind: 'ai_withdrawn' as const,
        // The send path's withdrawal writes the same pill (`send.ts`
        // withdrawOvertaken): the platform's, ids and the reason word. Who
        // acted is on the audit row and on the action's own pill.
        actorKind: 'system' as const,
        payload: { messageId: m.id, reason },
        createdAt: now,
      })),
    );
    for (const m of withdrawn) {
      await audit.record(tx, {
        actorAccountId,
        action: 'inbox.ai.message.withdraw',
        entityType: 'inbox.message',
        entityId: m.id,
        operatorId,
        branchId: conv.branchId,
        requestId: ctx.requestId ?? null,
        before: { providerStatus: 'queued' },
        after: { messageId: m.id, conversationId, reason },
      });
    }
  }
  return { turnsCancelled: turns.map((t) => t.id), messagesWithdrawn: withdrawn.map((m) => m.id) };
}

/** The AI lines whose typing time is over (§B.6): `job:inbox.ai` sends these as they fall due. */
export async function dueAiMessageIds(db: Exec, now: Date, limit = 50): Promise<string[]> {
  const rows = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.authorKind, 'ai'),
        eq(message.direction, 'outbound'),
        eq(message.providerStatus, 'queued'),
        sql`${message.redactedAt} is null`,
        sql`${message.nextAttemptAt} is not null and ${message.nextAttemptAt} <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(message.nextAttemptAt, message.createdAt)
    .limit(limit);
  return rows.map((r) => r.id);
}
