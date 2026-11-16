import { sql } from 'drizzle-orm';
import { schema as s } from '@oto/db';

/** SCRUM-992: bounded message/turn facts for each already-visible list row. */
const episodeFloor = sql`greatest(${s.conversation.lastCustomerMessageAt}, ${s.conversation.lastRoutedAt}, ${s.conversation.createdAt})`;
// Same episode/Resume floor and human-action holds as aiEligibility; these are
// display facts only, never authority to schedule or send an assistant turn.
const holdFloor = sql`greatest(${s.conversation.createdAt}, ${s.conversation.reopenedAt},
  coalesce((select max(he.created_at) from ${s.inboxEvent} he
    where he.operator_id = ${s.conversation.operatorId} and he.conversation_id = ${s.conversation.id}
      and he.kind in ('handled', 'ai_resumed')), '-infinity'::timestamptz))`;
export const nextActionColumns = {
  nextActionAiMode: s.channelAccount.aiMode,
  nextActionHeld: sql<boolean>`(${s.conversation.aiPausedAt} is not null or ${s.contact.erasedAt} is not null
    or exists (select 1 from ${s.message} hm where hm.operator_id = ${s.conversation.operatorId}
      and hm.conversation_id = ${s.conversation.id} and hm.author_kind = 'staff' and hm.created_at >= ${holdFloor})
    or exists (select 1 from ${s.assignment} ha where ha.operator_id = ${s.conversation.operatorId}
      and ha.conversation_id = ${s.conversation.id} and ha.assigned_by_kind = 'account' and ha.assigned_at >= ${holdFloor})
    or exists (select 1 from ${s.inboxEvent} he where he.operator_id = ${s.conversation.operatorId}
      and he.conversation_id = ${s.conversation.id} and he.created_at >= ${holdFloor}
      and (he.kind = 'ai_handover' or (he.actor_kind = 'account' and he.kind not in ('handled', 'ai_paused', 'ai_resumed')))))`,
  nextActionOutbound: sql<{ authorKind: string; providerStatus: string | null } | null>`(
    select jsonb_build_object('authorKind', nm.author_kind, 'providerStatus', nm.provider_status)
    from ${s.message} nm
    where nm.operator_id = ${s.conversation.operatorId} and nm.conversation_id = ${s.conversation.id}
      and nm.direction = 'outbound' and nm.created_at >= ${episodeFloor}
    order by nm.created_at desc, nm.id desc limit 1
  )`,
  nextActionPendingAi: sql<boolean>`exists (
    select 1 from ${s.aiTurn} nt join ${s.message} tm
      on tm.operator_id = nt.operator_id and tm.id = nt.trigger_message_id
    where nt.operator_id = ${s.conversation.operatorId} and nt.conversation_id = ${s.conversation.id}
      and nt.state in ('pending', 'deciding') and tm.created_at >= ${episodeFloor}
  )`,
};
