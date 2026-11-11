import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  channelAccount,
  conversation,
  inboxEvent,
  message,
  template,
  type Db,
  type InboxEventKind,
  type InboxTemplateKey,
} from '@oto/db';
import { deriveId, formatTHB, renderTemplate } from '@oto/shared';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit';
import type { FileStorage } from '../files';
import type { Tx } from '../tx';
import type { InboxChannels } from './channels';
import { sendAfterCommit } from './send';

/**
 * THE ONE SERVICE BEHIND EVERY PARTY LINE THE ASSISTANT POSTS FROM THE BEO
 * (SCRUM-825): the deposit request with its payment link, the one reminder,
 * the confirmation when the gateway settled it, the holding line when the
 * thread is handed to a person; the parent's set-menu link and the
 * confirmation of their choices.
 *
 * FOUR RULES, each kept here so no caller can get one wrong:
 *
 *   1. NEVER SENT TWICE. Every line's `message.id` is DERIVED by its caller
 *      from what it stands for (the request and its state, the app's
 *      Idempotency-Key), so the same act again finds its row and posts
 *      nothing — a replayed webhook, a retried door, a second job tick.
 *   2. ALWAYS IN THE CUSTOMER'S LANGUAGE. The thread's language picks the
 *      template row (Thai, Russian, else English); a row still waiting for its
 *      translator (`needs_translation`), inactive or archived is passed over
 *      for the next key of the caller's ladder, and English is the floor —
 *      never a line that says something else.
 *   3. THE ASSISTANT'S OWN SEND PATH. The row is an `author_kind 'ai'` line,
 *      `queued`, with its template, exactly as the turn engine writes its
 *      bubbles (`ai-engine.ts` `writeLines`): the send job and the
 *      post-commit send take it from there, the pills and the "1 more" read
 *      it as any assistant line, the thread's preview moves, and the staff
 *      clock does not (an AI line is not an answer).
 *   4. AUDITED, WITHOUT ITS WORDS. Each line is one audit row and, where the
 *      caller asks, one timeline pill — ids, the key, the language and the
 *      length, never the text and never the link.
 *
 * A placeholder the template names and the caller did not fill is refused
 * before anything is written: a family never receives "{{amount}}".
 */

export const PARTY_MESSAGE_LANGUAGES = ['en', 'th', 'ru'] as const;
export type PartyMessageLanguage = (typeof PARTY_MESSAGE_LANGUAGES)[number];

/** The thread's language as a template language: Thai and Russian in their own words, everything else English. */
export function partyMessageLanguageOf(language: string | null | undefined): PartyMessageLanguage {
  const code = (language ?? '').toLowerCase().slice(0, 2);
  return code === 'th' || code === 'ru' ? code : 'en';
}

/** A line's id from what it stands for, in one operator: the same act again is the same line. */
export function partyMessageId(parentId: string, name: string): string {
  return deriveId(parentId, `party-message:${name}`);
}

/** The amount as the till writes money: "฿3,000". */
export const partyAmountWords = (satang: number): string => formatTHB(satang);

const LOCALE: Record<PartyMessageLanguage, string> = { en: 'en-GB', th: 'th-TH', ru: 'ru-RU' };

/**
 * A party's day in words, in the family's language: "Saturday 21 March 2026"
 * (as the app's Quote PDF writes the day, no comma), "วันเสาร์ที่ 21 มีนาคม
 * พ.ศ. 2569", "21 марта 2026 г." (Russian without the weekday, which would
 * need a case the template cannot give it). A date the app stored in another
 * shape is shown as it is.
 */
export function partyDateWords(isoDate: string, language: PartyMessageLanguage): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(at.getTime())) return isoDate;
  const words = new Intl.DateTimeFormat(LOCALE[language], {
    ...(language === 'ru' ? {} : { weekday: 'long' }),
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
  return language === 'en' ? words.replace(',', '') : words;
}

/** An instant in the park's own clock, short: "14 Nov, 15:02" / "14 พ.ย. 15:02" / "14 нояб., 15:02". */
export function partyClockWords(at: Date, timeZone: string, language: PartyMessageLanguage): string {
  return new Intl.DateTimeFormat(LOCALE[language], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timeZone || 'Asia/Bangkok',
  }).format(at);
}

export interface PartyMessageInput {
  /** Derived by the caller (`partyMessageId`): the same act again is this line, answered as it stands. */
  messageId: string;
  conversationId: string;
  key: InboxTemplateKey;
  /** Tried in turn after `key` when it has no usable line in the language: the holding ladder. */
  fallbackKeys?: readonly InboxTemplateKey[];
  variables: Readonly<Record<string, string>>;
  /** The timeline pill beside the line; its payload carries ids and figures, never the text or the link. */
  event?: { kind: InboxEventKind; payload: Record<string, unknown> } | null;
  /** The audit row's action and entity: what the line was posted for. */
  audit: { action: string; entityType: string; entityId: string; detail?: Record<string, unknown> };
  actorAccountId?: string | null;
  requestId?: string | null;
  now: Date;
}

export interface PartyMessagePosted {
  messageId: string;
  conversationId: string;
  branchId: string | null;
  /** The pill written beside the line; null when none was asked for, or on a replay. */
  eventId: string | null;
  language: string;
  templateKey: InboxTemplateKey;
  /** True when this line had been posted before: nothing was written. */
  replayed: boolean;
}

type TemplateRow = typeof template.$inferSelect;

/** The thread, locked: the row every line of it is serialised on. */
export async function lockedConversation(tx: Tx, operatorId: string, conversationId: string) {
  const [conv] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, conversationId)))
    .for('update')
    .limit(1);
  if (!conv) throw errors.notFound('Conversation not found');
  return conv;
}

/**
 * A usable line for the key in the language: live, active, worded in that
 * language (not waiting for its translator), for any channel or this one, any
 * branch or this one — the more specific variant first, as the composer offers
 * them (`templatesForThread`).
 */
async function usableTemplate(
  tx: Tx,
  q: { operatorId: string; key: InboxTemplateKey; language: PartyMessageLanguage; channel: string | null; branchId: string | null },
): Promise<TemplateRow | null> {
  const rows = await tx
    .select()
    .from(template)
    .where(
      and(
        eq(template.operatorId, q.operatorId),
        eq(template.key, q.key),
        eq(template.language, q.language),
        eq(template.active, true),
        eq(template.needsTranslation, false),
        isNull(template.archivedAt),
        q.channel ? or(isNull(template.channel), eq(template.channel, q.channel as NonNullable<TemplateRow['channel']>)) : isNull(template.channel),
        q.branchId ? or(isNull(template.branchId), eq(template.branchId, q.branchId)) : isNull(template.branchId),
      ),
    );
  const rank = (t: TemplateRow) => (t.channel ? 2 : 0) + (t.branchId ? 1 : 0);
  return rows.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))[0] ?? null;
}

const previewOf = (text: string): string => (text.length > 140 ? `${text.slice(0, 137)}…` : text);

/**
 * Post one party line as the assistant, inside the caller's transaction.
 * Answers the line as it stands when its id is already there (a replay).
 */
export async function postPartyMessage(tx: Tx, operatorId: string, input: PartyMessageInput): Promise<PartyMessagePosted> {
  const conv = await lockedConversation(tx, operatorId, input.conversationId);
  const [had] = await tx
    .select({ id: message.id, conversationId: message.conversationId, templateId: message.templateId, bodyLanguage: message.bodyLanguage })
    .from(message)
    .where(and(eq(message.operatorId, operatorId), eq(message.id, input.messageId)))
    .limit(1);
  if (had) {
    if (had.conversationId !== conv.id) {
      throw errors.conflict('PARTY_MESSAGE_ID_IN_USE', 'That party line already belongs to another conversation');
    }
    return {
      messageId: had.id,
      conversationId: conv.id,
      branchId: conv.branchId,
      eventId: null,
      language: had.bodyLanguage ?? 'en',
      templateKey: input.key,
      replayed: true,
    };
  }

  const [account] = await tx
    .select({ channel: channelAccount.channel })
    .from(channelAccount)
    .where(and(eq(channelAccount.operatorId, operatorId), eq(channelAccount.id, conv.channelAccountId)))
    .limit(1);
  const language = partyMessageLanguageOf(conv.language);
  const scope = { operatorId, channel: account?.channel ?? null, branchId: conv.branchId };
  let row: TemplateRow | null = null;
  for (const key of [input.key, ...(input.fallbackKeys ?? [])]) {
    row = await usableTemplate(tx, { ...scope, key, language });
    if (!row && language !== 'en') row = await usableTemplate(tx, { ...scope, key, language: 'en' });
    if (row) break;
  }
  if (!row) {
    throw new AppError(
      409,
      'PARTY_TEMPLATE_MISSING',
      `No usable "${input.key}" message template in ${language} or English — run platform-sync, or restore the template in the Inbox settings`,
      { key: input.key, language },
    );
  }
  const rendered = renderTemplate(row.body, input.variables);
  if (rendered.missing.length > 0) {
    throw new AppError(409, 'PARTY_TEMPLATE_INCOMPLETE', `The "${row.key}" template names ${rendered.missing.join(', ')}, which this line cannot fill`, {
      key: row.key,
      missing: rendered.missing,
    });
  }

  const at = input.now;
  await tx.insert(message).values({
    id: input.messageId,
    operatorId,
    conversationId: conv.id,
    channelAccountId: conv.channelAccountId,
    direction: 'outbound',
    authorKind: 'ai',
    body: rendered.text,
    bodyLanguage: row.language,
    templateId: row.id,
    mediaFileIds: [],
    providerStatus: 'queued',
    source: 'channel',
    nextAttemptAt: at,
    createdAt: at,
    updatedAt: at,
  });
  // An assistant line is not an answer (`shared/inbox.ts` isUnanswered): the
  // staff clock and the first-response time stay where they are.
  await tx
    .update(conversation)
    .set({
      lastMessageAt: sql`greatest(coalesce(${conversation.lastMessageAt}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)`,
      lastMessagePreview: previewOf(rendered.text),
      updatedAt: at,
    })
    .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, conv.id)));

  let eventId: string | null = null;
  if (input.event) {
    eventId = deriveId(input.messageId, `party-message:event:${input.event.kind}`);
    await tx.insert(inboxEvent).values({
      id: eventId,
      operatorId,
      conversationId: conv.id,
      kind: input.event.kind,
      actorKind: 'ai',
      payload: { ...input.event.payload, messageId: input.messageId, templateKey: row.key, language: row.language },
      createdAt: at,
    });
  }
  await audit.record(tx, {
    actorAccountId: input.actorAccountId ?? null,
    operatorId,
    branchId: conv.branchId,
    action: input.audit.action,
    entityType: input.audit.entityType,
    entityId: input.audit.entityId,
    requestId: input.requestId ?? null,
    after: {
      ...input.audit.detail,
      conversationId: conv.id,
      messageId: input.messageId,
      eventId,
      templateKey: row.key,
      language: row.language,
      length: [...rendered.text].length,
    },
  });
  return {
    messageId: input.messageId,
    conversationId: conv.id,
    branchId: conv.branchId,
    eventId,
    language: row.language,
    templateKey: row.key,
    replayed: false,
  };
}

/** The send path's deps, as the routes hold them (`app.inboxChannels`, `app.fileStorage`). */
export interface PartyMessageSender {
  channels: InboxChannels;
  storage: FileStorage | null;
}

/**
 * Send the lines just committed, through the assistant's own send path
 * (`sendAfterCommit`): a healthy channel takes them now; anything else leaves
 * them queued for `job:inbox.send`. Never throws: a line that could not be
 * sent is still in the thread, and the sweeper has it.
 */
export async function sendPartyMessages(
  db: Db,
  sender: PartyMessageSender | null,
  log: FastifyBaseLogger | undefined,
  messageIds: readonly string[],
  ctx: { requestId?: string | null; actorAccountId?: string | null } = {},
): Promise<void> {
  if (!sender || messageIds.length === 0) return;
  try {
    await sendAfterCommit(db, { channels: sender.channels, storage: sender.storage, ...(log ? { log } : {}) }, messageIds, ctx);
  } catch (err) {
    log?.warn({ err, messageIds }, 'a party line could not be sent now; the send job retries it');
  }
}
