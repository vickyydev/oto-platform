import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  channelAccount,
  contact,
  conversation,
  inboxEvent,
  member,
  message,
  team,
  type InboxChannel,
} from '@oto/db';
import { ConsoleChannel, type ConsoleSender } from '@oto/messaging';
import { newId } from '@oto/shared';
import { pgErrorOf } from '../../lib/scrub';
import { audit } from '../audit';
import { recordRun } from '../ops';
import type { Tx } from '../tx';

/**
 * THE CHECK-IN FEED (S2-19, SCRUM-582 — Inbox round I2c; plan
 * `docs/progress/plans/inbox-build/PLAN.md` §2.4).
 *
 * The check-in connection check and the booking confirmation go out through
 * the console SMS sender — a log line, delivered nowhere. This file writes the
 * SAME text, after the send succeeded, as an outbound `system` message in the
 * guardian's Inbox thread, so the park sees what it told the family where the
 * family's conversation lives:
 *
 *   1. the `console` channel account for the notice's channel, found by the
 *      `ConsoleChannel` identity (`console:<channel>`, the one platform-sync
 *      lays) — a branch's own account first, else the operator-wide one,
 *      created operator-wide if the operator has none;
 *   2. the contact, by (operator, channel, E.164 phone), soft-linked to the
 *      operator's live `crm.member` with that phone;
 *   3. the one thread per contact per channel account — opened on the
 *      branch's reception team, category `general` (the account's default),
 *      read-only because a console account can never reply (owner note 5);
 *   4. the message, with a synthetic provider id
 *      `<source>:<sourceId>:<sentAt>`, so a replay of the same send is one row;
 *   5. a `notice_mirrored` event and an audit row — neither ever carries the
 *      body or the phone.
 *
 * NEVER IN THE WAY OF A CHECK-IN. Everything above runs in a SAVEPOINT inside
 * the caller's transaction. A failure rolls back the mirror alone — no half
 * thread, no orphan contact — is recorded as a failed `ops_run`
 * (`inbox:notice_mirror`), and the caller carries on: a family is never held
 * at the counter because the Inbox could not write. This function does not
 * throw.
 *
 * Routing proper (rules, a primary, the backup) is the router's (I2d); a
 * mirrored thread starts on its branch's reception team, which is where the
 * plan's `general` rule for that branch sends it.
 */

export const NOTICE_MIRROR_RUN = 'inbox:notice_mirror';

/** The channels a notice can name; the ones platform-sync lays a console account for. */
const NOTICE_CHANNELS = ['whatsapp', 'line', 'telegram'] as const satisfies readonly InboxChannel[];
type NoticeChannel = (typeof NOTICE_CHANNELS)[number];

const CHANNEL_LABEL: Record<NoticeChannel, string> = { whatsapp: 'WhatsApp', line: 'LINE', telegram: 'Telegram' };

const E164 = /^\+[1-9][0-9]{6,14}$/;
const PREVIEW_MAX = 140;

export interface NoticeMirrorInput {
  operatorId: string;
  branchId: string;
  /** The registration's (or booking's) `contactChannel`. */
  channel: string;
  /** E.164. */
  phone: string;
  displayName: string | null;
  /** Exactly the text the sender was given. */
  body: string;
  source: 'checkin.contact' | 'booking.confirmation';
  /** The registration id or the booking id. */
  sourceId: string;
  sentAt: Date;
  /** The sender the notice just went through; the console channel wraps it. */
  sender: ConsoleSender;
  actorAccountId?: string | null;
  requestId?: string | null;
  actionId?: string | null;
}

export type NoticeMirrorOutcome =
  | { mirrored: true; conversationId: string; messageId: string; contactId: string }
  | { mirrored: false; reason: 'unsupported_channel' | 'no_phone' | 'channel_closed' | 'already_mirrored' | 'failed' };

/** Mirror one notice into the Inbox. Never throws: a failure is the mirror's alone. */
export async function mirrorNotice(tx: Tx, input: NoticeMirrorInput): Promise<NoticeMirrorOutcome> {
  if (!(NOTICE_CHANNELS as readonly string[]).includes(input.channel)) {
    return { mirrored: false, reason: 'unsupported_channel' };
  }
  if (!E164.test(input.phone)) return { mirrored: false, reason: 'no_phone' };
  const startedAt = new Date();
  try {
    return await tx.transaction((sp) => writeMirror(sp, input, input.channel as NoticeChannel));
  } catch (err) {
    // The savepoint is rolled back; the caller's transaction is intact. The
    // record of the failure gets a savepoint of its own, so that even it
    // failing cannot reach the check-in. The pg error is passed bare —
    // drizzle's wrapper carries the query parameters, the body among them.
    await tx
      .transaction((sp) =>
        recordRun(sp, {
          kind: 'integration',
          name: NOTICE_MIRROR_RUN,
          outcome: 'failed',
          startedAt,
          error: pgErrorOf(err) ?? new Error(err instanceof Error ? err.name : 'MirrorFailed'),
          detail: { source: input.source, sourceId: input.sourceId, channel: input.channel },
          requestId: input.requestId ?? null,
          actionId: input.actionId ?? null,
          operatorId: input.operatorId,
          branchId: input.branchId,
        }),
      )
      .catch(() => undefined);
    return { mirrored: false, reason: 'failed' };
  }
}

async function writeMirror(sp: Tx, input: NoticeMirrorInput, channel: NoticeChannel): Promise<NoticeMirrorOutcome> {
  const notices = new ConsoleChannel({ sender: input.sender, channel });
  const account = await consoleAccount(sp, input, notices);
  if (!account) return { mirrored: false, reason: 'channel_closed' };

  const memberId = await memberByPhone(sp, input.operatorId, input.phone);
  const { id: contactId, created: contactCreated } = await upsertContact(sp, input, channel, memberId);
  const { id: conversationId, created: conversationCreated } = await upsertConversation(
    sp,
    input,
    account,
    contactId,
    memberId,
  );

  const messageId = newId();
  const [written] = await sp
    .insert(message)
    .values({
      id: messageId,
      operatorId: input.operatorId,
      conversationId,
      channelAccountId: account.id,
      direction: 'outbound',
      authorKind: 'system',
      body: input.body,
      externalMessageId: `${input.source}:${input.sourceId}:${input.sentAt.toISOString()}`,
      providerStatus: 'sent',
      sentAt: input.sentAt,
      source: input.source,
      sourceId: input.sourceId,
      createdAt: input.sentAt,
    })
    .onConflictDoNothing({
      target: [message.channelAccountId, message.externalMessageId],
      where: isNotNull(message.externalMessageId),
    })
    .returning({ id: message.id });
  if (!written) return { mirrored: false, reason: 'already_mirrored' };

  await sp
    .update(conversation)
    .set({
      lastMessageAt: sql`greatest(${conversation.lastMessageAt}, ${input.sentAt.toISOString()}::timestamptz)`,
      lastMessagePreview: input.body.slice(0, PREVIEW_MAX),
      memberId: sql`coalesce(${conversation.memberId}, ${memberId}::uuid)`,
      updatedAt: new Date(),
    })
    .where(and(eq(conversation.operatorId, input.operatorId), eq(conversation.id, conversationId)));

  const byAccount = Boolean(input.actorAccountId);
  // Ids, the source and the account only: never the body, never the phone.
  await sp.insert(inboxEvent).values({
    id: newId(),
    operatorId: input.operatorId,
    conversationId,
    kind: 'notice_mirrored',
    actorKind: byAccount ? 'account' : 'system',
    actorAccountId: byAccount ? input.actorAccountId! : null,
    payload: { messageId, source: input.source, sourceId: input.sourceId, channelAccountId: account.id },
  });
  await audit.record(sp, {
    actorAccountId: input.actorAccountId ?? null,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'inbox.notice_mirror',
    entityType: 'inbox_message',
    entityId: messageId,
    requestId: input.requestId ?? null,
    actionId: input.actionId ?? null,
    after: {
      conversationId,
      contactId,
      channelAccountId: account.id,
      source: input.source,
      sourceId: input.sourceId,
      contactCreated,
      conversationCreated,
      memberLinked: memberId !== null,
    },
  });
  return { mirrored: true, conversationId, messageId, contactId };
}

interface ConsoleAccount {
  id: string;
  defaultCategory: typeof channelAccount.$inferSelect.defaultCategory;
}

/**
 * The console account the notice is written on. An account the operator
 * archived or paused means "no notices in the Inbox" and is respected: only an
 * operator with none at all gets one laid, as platform-sync would lay it.
 */
async function consoleAccount(sp: Tx, input: NoticeMirrorInput, ch: ConsoleChannel): Promise<ConsoleAccount | null> {
  const where = and(
    eq(channelAccount.operatorId, input.operatorId),
    eq(channelAccount.provider, 'console'),
    eq(channelAccount.externalId, ch.identity.externalId),
    or(isNull(channelAccount.branchId), eq(channelAccount.branchId, input.branchId)),
  );
  const rows = await sp
    .select({
      id: channelAccount.id,
      defaultCategory: channelAccount.defaultCategory,
      status: channelAccount.status,
      archivedAt: channelAccount.archivedAt,
      branchId: channelAccount.branchId,
    })
    .from(channelAccount)
    .where(where)
    // The branch's own account before the operator-wide one; live before archived.
    .orderBy(sql`${channelAccount.archivedAt} is null desc`, sql`${channelAccount.branchId} is null`)
    .limit(1);
  const found = rows[0];
  if (found) {
    return found.archivedAt === null && found.status === 'active'
      ? { id: found.id, defaultCategory: found.defaultCategory }
      : null;
  }
  const id = newId();
  const [made] = await sp
    .insert(channelAccount)
    .values({
      id,
      operatorId: input.operatorId,
      branchId: null,
      channel: ch.identity.channel,
      provider: 'console',
      externalId: ch.identity.externalId,
      displayName: `Check-in notices (${CHANNEL_LABEL[ch.identity.channel as NoticeChannel]})`,
      defaultCategory: 'general',
      canReply: ch.capabilities.reply,
      status: 'active',
    })
    .onConflictDoNothing()
    .returning({ id: channelAccount.id, defaultCategory: channelAccount.defaultCategory });
  if (made) return made;
  const [raced] = await sp
    .select({ id: channelAccount.id, defaultCategory: channelAccount.defaultCategory })
    .from(channelAccount)
    .where(and(where, isNull(channelAccount.archivedAt), eq(channelAccount.status, 'active')))
    .limit(1);
  return raced ?? null;
}

/** The soft link: the operator's live member with this E.164 phone. */
async function memberByPhone(sp: Tx, operatorId: string, phone: string): Promise<string | null> {
  const [m] = await sp
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.operatorId, operatorId), eq(member.phone, phone), isNull(member.archivedAt)))
    .limit(1);
  return m?.id ?? null;
}

/** On a console channel the guardian's handle is their phone. */
async function upsertContact(
  sp: Tx,
  input: NoticeMirrorInput,
  channel: NoticeChannel,
  memberId: string | null,
): Promise<{ id: string; created: boolean }> {
  const [made] = await sp
    .insert(contact)
    .values({
      id: newId(),
      operatorId: input.operatorId,
      channel,
      externalHandle: input.phone,
      displayName: input.displayName?.trim() || null,
      phone: input.phone,
      memberId,
      firstSeenAt: input.sentAt,
    })
    .onConflictDoNothing({ target: [contact.operatorId, contact.channel, contact.externalHandle] })
    .returning({ id: contact.id });
  if (made) return { id: made.id, created: true };
  const [found] = await sp
    .select({ id: contact.id, memberId: contact.memberId, displayName: contact.displayName, erasedAt: contact.erasedAt })
    .from(contact)
    .where(
      and(
        eq(contact.operatorId, input.operatorId),
        eq(contact.channel, channel),
        eq(contact.externalHandle, input.phone),
      ),
    )
    .limit(1);
  if (!found) throw new Error('the contact vanished between its insert and its read');
  // Fill what is missing, never overwrite: staff may have corrected the name.
  // An erased contact keeps its handle hashed, so it never matches here.
  if (found.erasedAt === null && ((memberId && !found.memberId) || (!found.displayName && input.displayName?.trim()))) {
    await sp
      .update(contact)
      .set({
        memberId: found.memberId ?? memberId,
        displayName: found.displayName ?? (input.displayName?.trim() || null),
        updatedAt: new Date(),
      })
      .where(eq(contact.id, found.id));
  }
  return { id: found.id, created: false };
}

async function upsertConversation(
  sp: Tx,
  input: NoticeMirrorInput,
  account: ConsoleAccount,
  contactId: string,
  memberId: string | null,
): Promise<{ id: string; created: boolean }> {
  const thread = and(
    eq(conversation.operatorId, input.operatorId),
    eq(conversation.contactId, contactId),
    eq(conversation.channelAccountId, account.id),
  );
  const [existing] = await sp.select({ id: conversation.id }).from(conversation).where(thread).limit(1);
  if (existing) return { id: existing.id, created: false };

  const [reception] = await sp
    .select({ id: team.id })
    .from(team)
    .where(and(eq(team.operatorId, input.operatorId), eq(team.key, 'reception'), eq(team.branchId, input.branchId)))
    .orderBy(desc(team.createdAt))
    .limit(1);
  const [made] = await sp
    .insert(conversation)
    .values({
      id: newId(),
      operatorId: input.operatorId,
      contactId,
      channelAccountId: account.id,
      teamId: reception?.id ?? null,
      branchId: input.branchId,
      category: account.defaultCategory,
      status: 'active',
      memberId,
      bookingRef: input.source === 'booking.confirmation' ? input.sourceId : null,
      createdAt: input.sentAt,
    })
    .onConflictDoNothing({ target: [conversation.operatorId, conversation.contactId, conversation.channelAccountId] })
    .returning({ id: conversation.id });
  if (made) return { id: made.id, created: true };
  const [raced] = await sp.select({ id: conversation.id }).from(conversation).where(thread).limit(1);
  if (!raced) throw new Error('the conversation vanished between its insert and its read');
  return { id: raced.id, created: false };
}
