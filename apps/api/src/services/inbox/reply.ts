import { and, eq, inArray, sql } from 'drizzle-orm';
import { channelAccount, conversation, message, schema as s, template, type Db } from '@oto/db';
import { insideFreeTextWindow } from '@oto/messaging';
import {
  InboxReplyRefusalSchema,
  renderTemplate,
  templateQualifiesOutsideWindow,
  templateVariables,
  type InboxMessage,
  type InboxReplyBody,
  type Permission,
} from '@oto/shared';
import { AppError, errors } from '../../lib/errors';
import { PermissionDeniedError } from '../../plugins/session';
import { audit } from '../audit';
import { claimClientId } from '../client-id';
import type { EffectivePermission } from '../permissions';
import type { Exec, Tx } from '../tx';
import type { InboxChannels } from './channels';
import { loadVisibleConversation, type InboxViewer } from './read-visibility';
import { templatesForThread } from './templates';
import { cancelAiForThread } from './ai-turns';

/**
 * A STAFF REPLY (S2-19 I2f, SCRUM-585; plan §3.3 "POST /inbox/conversations/
 * {id}/messages", `docs/features/inbox.md` "Templates").
 *
 * In one transaction, on a conversation the caller can see AND may reply in:
 *
 *   1. The caller-named id is claimed first: the same id again is the same
 *      message, answered as it stands — even if the thread was handled since.
 *   2. Refusals, each a plain sentence:
 *        CONVERSATION_HANDLED  "Reopen it to reply" — the IT Brief's rule
 *        CHANNEL_CANNOT_REPLY  a check-in notice thread (the console sender)
 *        CHANNEL_NOT_CONNECTED the account's adapter is off on this deployment
 *        TEMPLATE_REQUIRED     free text outside the 24-hour window
 *        TEMPLATE_NOT_APPROVED a template that may not open a closed window
 *      The two template refusals carry the window and the templates that
 *      qualify (`InboxReplyRefusalSchema`), so the composer can offer them.
 *      The window is the CHANNEL's (`freeTextWindowHours`, WhatsApp's 24 h),
 *      measured from `last_customer_message_at` — enforced here, before any
 *      network, and again by the adapter itself.
 *   3. The message is written `queued`, authored by the caller; the thread's
 *      `last_staff_message_at` moves (which is what answers it — `isUnanswered`
 *      reads the timestamps), and `first_response_at` is set if unset.
 *   4. One audit row: ids, the template key, the length — never the words.
 *   5. The customer assistant stands down (SCRUM-590): its pending turn on
 *      the thread is cancelled and its queued lines withdrawn.
 *
 * The send itself happens after the commit (`send.ts`), so the answer is the
 * message as the first attempt left it.
 *
 * There are no staff-only notes: everything written here goes to the customer.
 */

export const INBOX_REPLY: Permission = 'inbox:conversation:reply';

/**
 * The caller as the REPLY permission sees them: the same four arms as
 * reading (`read-visibility.ts`) — operator, branch, the team's department,
 * or a slot on the thread — over the grants that carry
 * `inbox:conversation:reply` instead. A reader who may not reply there is
 * refused 403; one who cannot see the thread at all gets the read side's 404.
 */
export function replyViewerOf(effective: EffectivePermission[], accountId: string, operatorId: string): InboxViewer {
  const grants = effective.filter(
    (g) =>
      g.permission === INBOX_REPLY &&
      (g.scopeType !== 'operator' || g.scopeId === null || g.scopeId === operatorId),
  );
  const ids = (type: EffectivePermission['scopeType']) => [
    ...new Set(grants.filter((g) => g.scopeType === type && g.scopeId !== null).map((g) => g.scopeId!)),
  ];
  return {
    accountId,
    operatorId,
    scope: {
      accountId,
      operatorWide: grants.some((g) => g.scopeType === 'operator'),
      branchIds: ids('branch'),
      departmentIds: ids('department'),
    },
  };
}

export interface ReplyCtx {
  requestId: string;
  now: Date;
}

export interface ReplyResult {
  conversationId: string;
  messageId: string;
  /** The id named a message already written: nothing new was queued, and nothing is sent again. */
  replay: boolean;
  window: { open: boolean; hours: number | null; lastCustomerMessageAt: string | null; closesAt: string | null };
}

function windowOf(lastCustomerMessageAt: Date | null, hours: number | null, now: Date): ReplyResult['window'] {
  return {
    open: hours === null || insideFreeTextWindow(lastCustomerMessageAt, now, hours),
    hours,
    lastCustomerMessageAt: lastCustomerMessageAt?.toISOString() ?? null,
    closesAt:
      hours === null || !lastCustomerMessageAt
        ? null
        : new Date(lastCustomerMessageAt.getTime() + hours * 3_600_000).toISOString(),
  };
}

/** At most 140 characters on a character boundary — the ingest's preview rule. */
function previewOf(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length <= 140 ? chars.join('') : `${chars.slice(0, 139).join('')}…`;
}

export async function replyToConversation(
  tx: Tx,
  deps: { channels: InboxChannels },
  viewers: { read: InboxViewer; reply: InboxViewer },
  conversationId: string,
  input: InboxReplyBody,
  ctx: ReplyCtx,
): Promise<ReplyResult> {
  // Visible to read, or 404; then held at a scope that lets the caller reply.
  const seen = await loadVisibleConversation(tx, viewers.read, conversationId);
  try {
    await loadVisibleConversation(tx, viewers.reply, seen.id);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) throw new PermissionDeniedError(INBOX_REPLY);
    throw err;
  }
  const [conv] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.operatorId, seen.operatorId), eq(conversation.id, seen.id)))
    .limit(1)
    .for('update');
  const [account] = await tx
    .select()
    .from(channelAccount)
    .where(and(eq(channelAccount.operatorId, conv!.operatorId), eq(channelAccount.id, conv!.channelAccountId)))
    .limit(1);

  const claim = await claimClientId(
    input.id,
    async (id) => (await tx.select().from(message).where(eq(message.id, id)).limit(1))[0],
    (row) =>
      row.operatorId === conv!.operatorId &&
      row.conversationId === conv!.id &&
      row.direction === 'outbound' &&
      row.authorAccountId === viewers.read.accountId,
  );

  const found =
    account && !account.archivedAt
      ? deps.channels.forAccount({
          id: account.id,
          provider: account.provider,
          channel: account.channel,
          externalId: account.externalId,
          displayName: account.displayName,
          credentialRef: account.credentialRef,
        })
      : null;
  const hours = found?.ok ? found.channel.capabilities.freeTextWindowHours : null;
  const window = windowOf(conv!.lastCustomerMessageAt, hours, ctx.now);
  if (claim.replay) return { conversationId: conv!.id, messageId: claim.id, replay: true, window };

  if (conv!.status === 'handled') {
    throw errors.conflict('CONVERSATION_HANDLED', 'This conversation is handled. Reopen it to reply.');
  }
  if (!account || account.archivedAt || !account.canReply) {
    throw errors.conflict(
      'CHANNEL_CANNOT_REPLY',
      'This thread is a notice the park sent; it cannot carry a reply. Write to the customer on their own channel.',
    );
  }
  if (!found || !found.ok) {
    throw errors.conflict(
      'CHANNEL_NOT_CONNECTED',
      'This channel is not connected on this deployment, so nothing can be sent on it yet.',
    );
  }
  if (!found.channel.capabilities.reply) {
    throw errors.conflict('CHANNEL_CANNOT_REPLY', 'This channel only sends notices; it cannot carry a reply.');
  }

  const thread = {
    operatorId: conv!.operatorId,
    channel: account.channel,
    branchId: conv!.branchId,
    language: conv!.language,
  };
  /** The refusal that offers the templates which may still be sent. */
  const templateRefusal = async (code: 'TEMPLATE_REQUIRED' | 'TEMPLATE_NOT_APPROVED', sentence: string) => {
    const qualifying = await templatesForThread(tx, thread, { outsideWindow: true });
    const details = InboxReplyRefusalSchema.shape.error.shape.details.parse({
      window,
      qualifyingTemplates: qualifying.map((t) => ({
        id: t.id,
        key: t.key,
        language: t.language,
        channel: t.channel,
        branchId: t.branchId,
        body: t.body,
        approvalStatus: t.approvalStatus,
        needsTranslation: t.needsTranslation,
        variables: templateVariables(t.body),
      })),
    });
    return errors.conflict(code, sentence, details);
  };

  let body: string;
  let templateRow: typeof template.$inferSelect | null = null;
  if (input.templateId) {
    const usable = await templatesForThread(tx, thread, { outsideWindow: false });
    templateRow = usable.find((t) => t.id === input.templateId) ?? null;
    if (!templateRow) {
      throw errors.badRequest('That template is not one this thread can be sent: it is inactive, archived, or for another channel or branch.');
    }
    if (!window.open && !templateQualifiesOutsideWindow(templateRow.approvalStatus)) {
      throw await templateRefusal(
        'TEMPLATE_NOT_APPROVED',
        'The customer last wrote more than 24 hours ago, and this template is not approved for that. Choose an approved one.',
      );
    }
    const rendered = renderTemplate(templateRow.body, input.variables ?? {});
    if (rendered.missing.length > 0) {
      throw errors.badRequest(`Fill in the template's ${rendered.missing.join(', ')} before sending.`, {
        missing: rendered.missing,
      });
    }
    body = rendered.text;
  } else {
    if (!window.open) {
      throw await templateRefusal(
        'TEMPLATE_REQUIRED',
        window.lastCustomerMessageAt
          ? 'The customer last wrote more than 24 hours ago, so only a template can be sent now. Choose one of the templates offered.'
          : 'The customer has not written on this channel yet, so only a template can open the conversation. Choose one of the templates offered.',
      );
    }
    body = input.text!;
  }

  const id = claim.id;
  await tx.insert(message).values({
    id,
    operatorId: conv!.operatorId,
    conversationId: conv!.id,
    channelAccountId: account.id,
    direction: 'outbound',
    authorKind: 'staff',
    authorAccountId: viewers.read.accountId,
    body,
    bodyLanguage: templateRow?.language ?? null,
    templateId: templateRow?.id ?? null,
    providerStatus: 'queued',
    source: 'channel',
    createdAt: ctx.now,
  });
  await tx
    .update(conversation)
    .set({
      lastStaffMessageAt: sql`greatest(${conversation.lastStaffMessageAt}, ${ctx.now.toISOString()}::timestamptz)`,
      lastMessageAt: sql`greatest(${conversation.lastMessageAt}, ${ctx.now.toISOString()}::timestamptz)`,
      lastMessagePreview: previewOf(body),
      firstResponseAt: sql`coalesce(${conversation.firstResponseAt}, ${ctx.now.toISOString()}::timestamptz)`,
      updatedAt: ctx.now,
    })
    .where(and(eq(conversation.operatorId, conv!.operatorId), eq(conversation.id, conv!.id)));
  await audit.record(tx, {
    actorAccountId: viewers.read.accountId,
    action: 'inbox.message.reply',
    entityType: 'inbox.message',
    entityId: id,
    operatorId: conv!.operatorId,
    branchId: conv!.branchId,
    requestId: ctx.requestId,
    after: {
      messageId: id,
      conversationId: conv!.id,
      templateKey: templateRow?.key ?? null,
      templateId: templateRow?.id ?? null,
      length: [...body].length,
      windowOpen: window.open,
    },
  });
  // A person spoke (SCRUM-590 plan §A.3): the assistant's pending turn is
  // cancelled and its unsent lines withdrawn, in this reply's transaction.
  await cancelAiForThread(tx, conv!.operatorId, conv!.id, 'STAFF_REPLY', viewers.read.accountId, {
    requestId: ctx.requestId,
    now: ctx.now,
  });
  return { conversationId: conv!.id, messageId: id, replay: false, window };
}

/** One message as the thread reads it (`InboxMessageSchema`), with the refusal word it carries. */
export async function messageView(db: Exec, operatorId: string, messageId: string): Promise<{ message: InboxMessage; refusal: string | null }> {
  const [m] = await (db as Db)
    .select()
    .from(message)
    .where(and(eq(message.operatorId, operatorId), eq(message.id, messageId)))
    .limit(1);
  if (!m) throw errors.notFound('Message not found');
  const [author] = m.authorAccountId
    ? await (db as Db)
        .select({ name: s.employee.name })
        .from(s.account)
        .leftJoin(s.employee, eq(s.employee.id, s.account.employeeId))
        .where(and(eq(s.account.operatorId, operatorId), inArray(s.account.id, [m.authorAccountId])))
        .limit(1)
    : [];
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    message: {
      id: m.id,
      direction: m.direction,
      authorKind: m.authorKind,
      authorAccountId: m.authorAccountId,
      authorName: author?.name ?? null,
      body: m.body,
      bodyLanguage: m.bodyLanguage,
      translatedBody: m.translatedBody,
      translatedTo: m.translatedTo,
      mediaFileIds: m.mediaFileIds,
      audioFileId: m.audioFileId,
      transcript: m.transcript,
      templateId: m.templateId,
      providerStatus: m.providerStatus,
      source: m.source,
      sentAt: iso(m.sentAt),
      deliveredAt: iso(m.deliveredAt),
      readAt: iso(m.readAt),
      redacted: m.redactedAt !== null,
      createdAt: m.createdAt.toISOString(),
    },
    refusal: m.providerStatus === 'queued' || m.providerStatus === 'failed' ? m.error : null,
  };
}
