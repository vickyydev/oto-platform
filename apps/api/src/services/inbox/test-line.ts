import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { schema as s } from '@oto/db';
import { TWILIO_SANDBOX_NUMBER, twilioVariables } from '@oto/messaging';
import {
  newId,
  type InboxStartOver,
  type InboxTestLine,
  type InboxTestLineCreated,
} from '@oto/shared';
import { errors } from '../../lib/errors';
import { audit } from '../audit';
import type { FileStorage } from '../files';
import { hasPermission, type EffectivePermission } from '../permissions';
import type { Exec, Tx } from '../tx';
import { cancelAiForThread } from './ai-turns';
import { twilioWebhookPath, type InboxChannels } from './channels';
import { channelRow } from './ingest';
import { eraseOpenQuestionAnswers } from './open-question';
import {
  eraseExamples,
  needlesOf,
  purgeDeliveriesNaming,
  redactThreadEvents,
  redactThreadMessages,
} from './privacy';
import { loadVisibleConversation, type InboxViewer } from './read-visibility';

/**
 * THE WHATSAPP TEST LINE (SCRUM-908).
 *
 * The owner, 12 November 2026: "connect tom number as customer and use any
 * random sandbox number assuming as Park operator and communicate 1:1 as live
 * using twilio APIs" — "Yes reply itself act like a staff from park assuming
 * live environment. Create a separate inbox of Tom's Number for Testing and
 * show all his messages there. Keep it general however give an option to
 * delete the chat so he can try again with a new message acting as a new
 * customer as its testing purpose assuming live environment".
 *
 * WHAT A TEST LINE IS. A `twilio` channel account: Twilio's WhatsApp sandbox
 * number, whose adapter answers and writes only to the numbers on its
 * allow-list (`INBOX_TWILIO_ALLOWED_NUMBERS_<ref>`, required) and which a
 * production deployment refuses to run. Every `twilio` account is a test line
 * until a live Twilio sender is built; that day this needs a column, not a
 * guess.
 *
 * ITS OWN INBOX, AND THE GENERAL ASSISTANT. Nothing new routes it: the line is
 * operator-wide, its default category is `general`, and its conversations are
 * filed, routed and answered as any number's are — the same knowledge,
 * playbook, operator rules, gates and guards. The assistant answers by
 * itself once a person switches the line to `live` (Assistant settings, as on
 * every number; it starts `off`). The inbox shows the line as a named inbox of
 * its own (`GET /inbox/me` `testLines`: a saved Source chip in the rail).
 *
 * START OVER. A person who holds `inbox:channel:manage` at the line clears
 * one of its conversations, in one transaction:
 *   - the assistant stands down: its pending and deciding turns cancelled,
 *     its queued lines withdrawn (`cancelAiForThread`), and every other
 *     queued line of the thread withdrawn too — nothing of it is sent after;
 *   - the words go, by the PDPA erasure's own steps scoped to this one
 *     thread (`privacy.ts`): every message's text, translation, transcript
 *     and media (inbox-owned files deleted from storage), the answers the
 *     assistant read into its open questions, the unapproved examples copied
 *     from it, the word-bearing keys of its timeline, and the raw deliveries
 *     on this line that name the number or one of its messages;
 *   - the thread leaves the inbox: `archived_at`/`archived_by_account_id` set,
 *     so every inbox read skips it (`visibleConversationsSql`) and the thread
 *     key no longer holds it — the number's next message opens a NEW
 *     conversation, routed and answered as a first contact;
 *   - what the inbox and the assistant remember of the number is reset on its
 *     contact: the shown name, the channel's profile name, a staff-set name
 *     and the language — refilled from the next message, as for a first
 *     contact. The phone and the member link stay: they are the number's,
 *     not a memory;
 *   - a hand-over notice still waiting to go is skipped (`STARTED_OVER`), and
 *     an open one counts as picked up, so the GM is not escalated a cleared
 *     test;
 *   - ONE audit row, `inbox.conversation.start_over`: ids and counts.
 *
 * WHY ARCHIVE AND NOT ERASE. The erasure anonymises the PERSON: every contact
 * with the phone and every thread of theirs on every number — a check-in
 * notice thread included — and leaves the threads in the inbox as "Erased
 * contact". Start over must reach this one test thread and take it out of the
 * inbox. So its words go through the erasure's own steps, and the row is
 * archived, never deleted (no business record is hard-deleted).
 *
 * IDEMPOTENT. A second press on a cleared thread changes nothing and answers
 * `alreadyCleared: true`; the route also takes an `Idempotency-Key`.
 */

export const TEST_LINE_DEFAULT_NAME = 'WhatsApp test line';
export const TEST_LINE_DEFAULT_REF = 'SANDBOX';
const CHANNEL_MANAGE = 'inbox:channel:manage';
/** Why a waiting hand-over notice of a cleared test was not sent. */
export const STARTED_OVER = 'STARTED_OVER';

type AccountRow = typeof s.channelAccount.$inferSelect;

/** A test line: a Twilio channel account (see the header). */
export function isTestLine(account: Pick<AccountRow, 'provider'>): boolean {
  return account.provider === 'twilio';
}

/** `inbox:channel:manage` at the line: operator-wide, or at the line's park. */
export function managesLine(effective: EffectivePermission[], operatorId: string, account: Pick<AccountRow, 'branchId'>): boolean {
  return hasPermission(effective, CHANNEL_MANAGE, { operatorId, ...(account.branchId ? { branchId: account.branchId } : {}) });
}

/** The operator's live test lines, for `GET /inbox/me`. */
export async function testLinesOf(db: Exec, operatorId: string, effective: EffectivePermission[]): Promise<InboxTestLine[]> {
  const rows = await db
    .select()
    .from(s.channelAccount)
    .where(and(eq(s.channelAccount.operatorId, operatorId), eq(s.channelAccount.provider, 'twilio'), isNull(s.channelAccount.archivedAt)))
    .orderBy(asc(s.channelAccount.displayName), asc(s.channelAccount.id));
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    displayName: r.displayName,
    branchId: r.branchId,
    startOver: managesLine(effective, operatorId, r),
  }));
}

export interface TestLineCtx {
  operatorId: string;
  actorAccountId: string;
  requestId: string | null;
  now: Date;
}

/**
 * Set up the test line: the operator's live `twilio` account on Twilio's
 * sandbox number, found or created. Operator-wide (no park: the General
 * assistant asks which park when it matters), default category `general`,
 * the assistant `off` until a person switches it — as every new number. The
 * caller holds `inbox:channel:manage` at operator scope.
 */
export async function setUpTestLine(
  tx: Tx,
  deps: { channels: InboxChannels; publicUrl: string | null },
  ctx: TestLineCtx,
  input: { displayName?: string | undefined; credentialRef?: string | undefined },
): Promise<InboxTestLineCreated> {
  const live = and(
    eq(s.channelAccount.operatorId, ctx.operatorId),
    eq(s.channelAccount.provider, 'twilio'),
    eq(s.channelAccount.externalId, TWILIO_SANDBOX_NUMBER),
    isNull(s.channelAccount.archivedAt),
  );
  let [row] = await tx.select().from(s.channelAccount).where(live).limit(1);
  let created = false;
  if (!row) {
    const [made] = await tx
      .insert(s.channelAccount)
      .values({
        id: newId(),
        operatorId: ctx.operatorId,
        branchId: null,
        channel: 'whatsapp',
        provider: 'twilio',
        externalId: TWILIO_SANDBOX_NUMBER,
        displayName: input.displayName ?? TEST_LINE_DEFAULT_NAME,
        credentialRef: input.credentialRef ?? TEST_LINE_DEFAULT_REF,
        defaultCategory: 'general',
        canReply: true,
        status: 'active',
        aiMode: 'off',
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoNothing()
      .returning();
    row = made ?? (await tx.select().from(s.channelAccount).where(live).limit(1))[0];
    if (!row) throw new Error('the test line vanished between its insert and its read');
    created = Boolean(made);
    if (made) {
      await audit.record(tx, {
        actorAccountId: ctx.actorAccountId,
        action: 'inbox.channel_account.create',
        entityType: 'inbox.channel_account',
        entityId: made.id,
        operatorId: ctx.operatorId,
        branchId: null,
        requestId: ctx.requestId,
        after: {
          provider: made.provider,
          channel: made.channel,
          externalId: made.externalId,
          displayName: made.displayName,
          credentialRef: made.credentialRef,
          defaultCategory: made.defaultCategory,
          aiMode: made.aiMode,
          testLine: true,
        },
      });
    }
  }
  const ref = row.credentialRef ?? TEST_LINE_DEFAULT_REF;
  const path = twilioWebhookPath(row.id);
  const found = deps.channels.forAccount(channelRow(row));
  return {
    channelAccountId: row.id,
    displayName: row.displayName,
    externalId: row.externalId,
    credentialRef: ref,
    created,
    settings: twilioVariables(ref),
    webhookUrl: deps.publicUrl ? `${deps.publicUrl}${path}` : null,
    webhookPath: path,
    connected: found.ok,
    reason: found.ok ? null : found.reason,
    aiMode: row.aiMode,
  };
}

export interface StartOverInput {
  viewer: InboxViewer;
  effective: EffectivePermission[];
  conversationId: string;
  requestId: string | null;
  now: Date;
}

/** Start over on one conversation of a test line. Call inside `withTx`. */
export async function startOver(tx: Tx, storage: FileStorage | null, input: StartOverInput): Promise<InboxStartOver> {
  const { viewer, now } = input;
  const operatorId = viewer.operatorId;
  // The row, cleared or not, inside the caller's operator, locked.
  const [conv] = await tx
    .select()
    .from(s.conversation)
    .where(and(eq(s.conversation.operatorId, operatorId), eq(s.conversation.id, input.conversationId)))
    .limit(1)
    .for('update');
  if (!conv) throw errors.notFound('Conversation not found');
  const [account] = await tx
    .select()
    .from(s.channelAccount)
    .where(and(eq(s.channelAccount.operatorId, operatorId), eq(s.channelAccount.id, conv.channelAccountId)))
    .limit(1);
  if (!account) throw errors.notFound('Conversation not found');

  const zero = {
    conversationId: conv.id,
    contactId: conv.contactId,
    channelAccountId: account.id,
    messages: 0,
    filesDeleted: 0,
    turnsCancelled: 0,
    linesWithdrawn: 0,
    openQuestionAnswers: 0,
    examplesDeleted: 0,
    eventsRedacted: 0,
    webhookPayloadsPurged: 0,
    contactReset: false,
  };
  if (conv.archivedAt) {
    // A repeat: already cleared, by a person who may manage this line.
    if (!managesLine(input.effective, operatorId, account)) throw errors.notFound('Conversation not found');
    return { ...zero, alreadyCleared: true, clearedAt: conv.archivedAt.toISOString() };
  }
  // A live thread: the viewer must see it (404 as if absent), and only a test
  // line's may be cleared (the server's own refusal, whatever a client shows).
  await loadVisibleConversation(tx, viewer, conv.id);
  if (!isTestLine(account)) {
    throw errors.conflict('NOT_A_TEST_LINE', 'Start over clears a conversation of the WhatsApp test line only.');
  }
  if (!managesLine(input.effective, operatorId, account)) {
    throw errors.forbidden(`Missing permission ${CHANNEL_MANAGE} at this test line`);
  }

  const convIds = [conv.id];
  const [person] = await tx
    .select()
    .from(s.contact)
    .where(and(eq(s.contact.operatorId, operatorId), eq(s.contact.id, conv.contactId)))
    .limit(1)
    .for('update');

  // The raw deliveries' needles, read before anything changes.
  const inbound = await tx
    .select({ externalMessageId: s.message.externalMessageId })
    .from(s.message)
    .where(
      and(
        eq(s.message.operatorId, operatorId),
        eq(s.message.conversationId, conv.id),
        eq(s.message.direction, 'inbound'),
        isNotNull(s.message.externalMessageId),
      ),
    );
  const needles = needlesOf([
    person?.externalHandle,
    person?.phone,
    person?.phone?.replace(/^\+/, ''),
    ...inbound.map((m) => m.externalMessageId),
  ]);

  // 1. The assistant stands down, and nothing else of the thread is sent after.
  const cancelled = await cancelAiForThread(tx, operatorId, conv.id, 'ERASED', viewer.accountId, {
    requestId: input.requestId,
    now,
  });
  const withdrawn = await tx
    .update(s.message)
    .set({ providerStatus: 'withdrawn', nextAttemptAt: null, updatedAt: now })
    .where(
      and(
        eq(s.message.operatorId, operatorId),
        eq(s.message.conversationId, conv.id),
        eq(s.message.direction, 'outbound'),
        eq(s.message.providerStatus, 'queued'),
      ),
    )
    .returning({ id: s.message.id });

  // 2. The words, through the erasure's own steps, for this one thread.
  const examplesDeleted = await eraseExamples(tx, operatorId, convIds, now);
  const openQuestionAnswers = await eraseOpenQuestionAnswers(tx, operatorId, convIds, now);
  const redacted = await redactThreadMessages(tx, storage, operatorId, convIds, person ? [person.id] : [], now);
  const eventsRedacted = await redactThreadEvents(tx, operatorId, convIds);
  const webhookPayloadsPurged = await purgeDeliveriesNaming(tx, operatorId, [account.id], needles, now);

  // 3. A hand-over notice of this test is not sent now, nor escalated later.
  await tx
    .update(s.handoverNotification)
    .set({ state: 'skipped', errorCode: STARTED_OVER, updatedAt: now })
    .where(
      and(
        eq(s.handoverNotification.operatorId, operatorId),
        eq(s.handoverNotification.conversationId, conv.id),
        eq(s.handoverNotification.state, 'pending'),
      ),
    );
  await tx
    .update(s.handoverNotification)
    .set({ pickedUpAt: now, updatedAt: now })
    .where(
      and(
        eq(s.handoverNotification.operatorId, operatorId),
        eq(s.handoverNotification.conversationId, conv.id),
        isNull(s.handoverNotification.pickedUpAt),
        isNull(s.handoverNotification.escalatedAt),
      ),
    );

  // 4. The thread leaves the inbox and the thread key.
  await tx
    .update(s.conversation)
    .set({
      archivedAt: now,
      archivedByAccountId: viewer.accountId,
      lastMessagePreview: null,
      aiSummary: null,
      memberId: null,
      updatedAt: now,
    })
    .where(and(eq(s.conversation.operatorId, operatorId), eq(s.conversation.id, conv.id)));

  // 5. What the inbox and the assistant remember of the number.
  let contactReset = false;
  if (person && person.erasedAt === null) {
    await tx
      .update(s.contact)
      .set({ displayName: null, profileName: null, nameSetByAccountId: null, nameSetAt: null, language: null, updatedAt: now })
      .where(and(eq(s.contact.operatorId, operatorId), eq(s.contact.id, person.id)));
    contactReset = true;
  }

  const result: InboxStartOver = {
    ...zero,
    alreadyCleared: false,
    clearedAt: now.toISOString(),
    messages: redacted.messages,
    filesDeleted: redacted.filesDeleted,
    turnsCancelled: cancelled.turnsCancelled.length,
    linesWithdrawn: cancelled.messagesWithdrawn.length + withdrawn.length,
    openQuestionAnswers,
    examplesDeleted,
    eventsRedacted,
    webhookPayloadsPurged,
    contactReset,
  };

  // 6. One audit row: ids and counts, never what was cleared.
  await audit.record(tx, {
    actorAccountId: viewer.accountId,
    action: 'inbox.conversation.start_over',
    entityType: 'inbox.conversation',
    entityId: conv.id,
    operatorId,
    branchId: conv.branchId,
    requestId: input.requestId,
    before: { archived: false, status: conv.status, category: conv.category },
    after: { ...result, withdrawnMessageIds: [...cancelled.messagesWithdrawn, ...withdrawn.map((w) => w.id)] },
  });
  return result;
}
