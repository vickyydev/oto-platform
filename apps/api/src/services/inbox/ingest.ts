import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import {
  assignment,
  branch,
  channelAccount,
  contact,
  conversation,
  inboxEvent,
  member,
  message,
  template,
  webhookReceipt,
  type Db,
  type InboxCategory,
} from '@oto/db';
import {
  ChannelError,
  bodyBytes,
  deliveryIdOf,
  type InboundMessageEvent,
  type InboundStatusEvent,
  type MessagingChannel,
  type OutboundContent,
  type RawWebhook,
} from '@oto/messaging';
import { newId, normalizePhone } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { audit } from '../audit';
import { recordRun } from '../ops';
import { withTx, type Exec, type Tx } from '../tx';
import type { ChannelAccountRow, InboxChannels } from './channels';
import { closedSince, isOpenAt, readOpeningHours } from './hours';
import { routeConversation } from './router';

/**
 * THE INBOX INGEST (S2-19 I2d, SCRUM-583; plan
 * `docs/progress/plans/inbox-build/PLAN.md` §3.4).
 *
 * What a webhook delivery does to the inbox, in one transaction per
 * delivery:
 *
 *   1. VERIFY, then record. `verifyWebhook` decides on the raw bytes before
 *      anything is parsed. A refused delivery becomes a `webhook_receipt`
 *      with `signature_ok = false` and nothing else, and is still answered
 *      200 (as the 2C2P webhook answers).
 *   2. THE RECEIPT, KEYED ON THE DELIVERY. `provider_event_id` is the
 *      delivery's `deliveryId` — the SHA-256 of its bytes, which a provider's
 *      byte-for-byte retry repeats — inserted `ON CONFLICT DO NOTHING`. A
 *      replayed delivery ends here and changes nothing. Keyed on the delivery
 *      rather than on an event because one delivery can carry several
 *      messages and statuses.
 *   3. PARSE into events, and DEDUPE EACH MESSAGE on its own key, the unique
 *      `(channel_account_id, external_message_id)`: a message that arrives
 *      again inside a DIFFERENT delivery (a batch, then a single retry) is
 *      skipped before it touches a contact or a thread.
 *   4. For each new message: the contact (find-or-create on the channel's
 *      handle; WhatsApp's handle is the E.164 phone, and the member register
 *      is linked by it, softly); the thread (one per contact per channel
 *      account); the message; the thread's times and preview.
 *   5. A message on a HANDLED thread REOPENS it (`reopened`, actor the
 *      customer; IT Brief: "returns only when the customer writes again").
 *      Its owners stay as they were.
 *   6. A NEW thread is ROUTED (`router.ts`).
 *   7. OUT OF HOURS: when the channel account has opening hours and the
 *      delivery arrives outside them, the `out_of_hours` template is queued
 *      as the reply, at most once per closed period per thread, and sent
 *      through the channel after the commit. The thread stays active.
 *   8. Status events move an outbound message's `provider_status` forward.
 *   9. `processed_at`, and one audit row for the delivery.
 *
 * NO BODY LEAVES THE MESSAGE TABLE. Audit rows, timeline events and ops rows
 * carry ids, counts, keys and statuses — never a customer's words (the
 * sentinel check in `inbox-ingest.test.ts`). The raw delivery is kept on the
 * receipt (`payload`), which the PDPA erasure and the retention purge reach.
 */

export type IngestOutcome =
  | 'unknown_channel_account'
  | 'channel_not_connected'
  | 'bad_signature'
  | 'malformed'
  | 'duplicate'
  | 'processed'
  | 'failed';

export interface IngestResult {
  outcome: IngestOutcome;
  receiptId: string | null;
  messages: number;
  /** Messages already stored under the same provider id (the per-message dedupe). */
  duplicates: number;
  statuses: number;
  conversationsCreated: number;
  reopened: number;
  /** The out-of-hours replies queued by this delivery (message ids). */
  outOfHours: string[];
  /** The threads this delivery touched, in order. */
  conversationIds: string[];
}

export interface IngestInput {
  /** From the URL: unvalidated until it names a live channel account. */
  channelAccountId: string;
  webhook: RawWebhook;
  requestId?: string | null;
  sourceIp?: string | null;
  /** Who pressed, when a simulator drive route played the delivery. */
  actorAccountId?: string | null;
}

export interface IngestDeps {
  channels: InboxChannels;
  log?: FastifyBaseLogger;
  now?: () => Date;
  /**
   * False when the caller is already inside a transaction it will commit
   * later (the demo seed), so the post-commit send of an out-of-hours reply
   * cannot run yet; the reply then stays `queued` for the send job.
   */
  dispatch?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AccountRow = typeof channelAccount.$inferSelect;

const empty = (outcome: IngestOutcome, receiptId: string | null = null): IngestResult => ({
  outcome,
  receiptId,
  messages: 0,
  duplicates: 0,
  statuses: 0,
  conversationsCreated: 0,
  reopened: 0,
  outOfHours: [],
  conversationIds: [],
});

/** The live channel account a URL names, in whichever operator owns it — the URL is the tenant. */
export async function loadChannelAccount(db: Exec, id: string): Promise<AccountRow | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db
    .select()
    .from(channelAccount)
    .where(and(eq(channelAccount.id, id), isNull(channelAccount.archivedAt)))
    .limit(1);
  return row ?? null;
}

export function channelRow(a: AccountRow): ChannelAccountRow {
  return {
    id: a.id,
    provider: a.provider,
    channel: a.channel,
    externalId: a.externalId,
    displayName: a.displayName,
    credentialRef: a.credentialRef,
  };
}

/** The GET subscription challenge. Answers the challenge text, or null to refuse. */
export async function answerChallenge(
  db: Db,
  channels: InboxChannels,
  channelAccountId: string,
  query: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  const account = await loadChannelAccount(db, channelAccountId);
  if (!account) return null;
  const found = channels.forAccount(channelRow(account));
  if (!found.ok) return null;
  try {
    const verdict = found.channel.verifyWebhook({ method: 'GET', headers: {}, query, rawBody: '' });
    return verdict.kind === 'challenge' && verdict.ok ? verdict.respondWith : null;
  } catch {
    return null;
  }
}

/**
 * One POST delivery, start to finish. NEVER THROWS: every refusal is a value
 * the route answers 200 with, and every failure is recorded (a receipt with
 * its error where there is an account to hang it on, and an `ops_run`).
 */
export async function ingestDelivery(db: Exec, deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const startedAt = new Date();
  const now = deps.now ?? (() => new Date());
  let operatorId: string | null = null;
  let branchId: string | null = null;

  const record = async (result: IngestResult, error?: unknown): Promise<IngestResult> => {
    const refused = result.outcome !== 'processed' && result.outcome !== 'duplicate';
    try {
      await recordRun(db, {
        kind: 'webhook',
        name: 'webhook:inbox.delivery',
        outcome: refused ? 'failed' : 'ok',
        startedAt,
        requestId: input.requestId ?? null,
        operatorId,
        branchId,
        // Ids and counts only. Never a body, never a header value.
        detail: {
          outcome: result.outcome,
          channelAccountId: UUID.test(input.channelAccountId) ? input.channelAccountId : null,
          receiptId: result.receiptId,
          messages: result.messages,
          duplicates: result.duplicates,
          statuses: result.statuses,
          conversationsCreated: result.conversationsCreated,
          reopened: result.reopened,
          outOfHours: result.outOfHours.length,
          sourceIp: input.sourceIp ?? null,
        },
        ...(refused ? { error: error ?? new Error(`inbox webhook ${result.outcome}`) } : {}),
      });
    } catch (err) {
      deps.log?.error({ err }, 'the inbox webhook could not record its own delivery');
    }
    return result;
  };

  try {
    const account = await loadChannelAccount(db, input.channelAccountId);
    if (!account) return await record(empty('unknown_channel_account'));
    operatorId = account.operatorId;
    branchId = account.branchId;

    const found = deps.channels.forAccount(channelRow(account));
    if (!found.ok) return await record(empty('channel_not_connected'));
    const channel = found.channel;

    let verdict;
    try {
      verdict = channel.verifyWebhook(input.webhook);
    } catch (err) {
      // The console: a send-only channel has no webhook to verify.
      if (err instanceof ChannelError && err.code === 'NOT_A_RECEIVING_CHANNEL') {
        return await record(empty('channel_not_connected'));
      }
      throw err;
    }
    const deliveryId = verdict.kind === 'delivery' ? verdict.deliveryId : deliveryIdOf(input.webhook.rawBody);

    if (verdict.kind !== 'delivery' || !verdict.ok) {
      const reason = verdict.kind === 'delivery' && !verdict.ok ? verdict.reason : 'NOT_A_DELIVERY';
      const receiptId = await withTx(
        db,
        { requestId: input.requestId ?? undefined, operatorId, branchId, actorAccountId: input.actorAccountId ?? null, log: deps.log },
        'inbox.webhook.refuse',
        async (tx) => {
          // Keyed apart from a verified delivery of the same bytes, so a
          // forged copy sent first can never shadow the real one; and kept
          // without its payload — unverified words are nobody's record.
          const [made] = await tx
            .insert(webhookReceipt)
            .values({
              id: newId(),
              operatorId: account.operatorId,
              channelAccountId: account.id,
              providerEventId: `refused:${deliveryId}`,
              receivedAt: startedAt,
              signatureOk: false,
              payload: null,
              processedAt: now(),
              error: reason,
            })
            .onConflictDoNothing()
            .returning({ id: webhookReceipt.id });
          if (made) {
            await audit.record(tx, {
              actorAccountId: input.actorAccountId ?? null,
              action: 'inbox.webhook.refuse',
              entityType: 'inbox.webhook_receipt',
              entityId: made.id,
              operatorId: account.operatorId,
              branchId: account.branchId,
              requestId: input.requestId ?? null,
              after: { channelAccountId: account.id, signatureOk: false, reason },
            });
          }
          return made?.id ?? null;
        },
      );
      return await record({ ...empty('bad_signature', receiptId) }, new Error(`inbox webhook ${reason}`));
    }

    let result: IngestResult;
    try {
      result = await withTx(
        db,
        { requestId: input.requestId ?? undefined, operatorId, branchId, actorAccountId: input.actorAccountId ?? null, log: deps.log },
        'inbox.webhook.receive',
        (tx) => receive(tx, { account, channel, deliveryId, input, now: now() }),
      );
    } catch (err) {
      // The work rolled back. The delivery is kept, with its error, so it is
      // on record and can be replayed by hand; a provider retry of the same
      // bytes then meets the receipt and stops (the alert is the ops row).
      let receiptId: string | null = null;
      try {
        const [made] = await db
          .insert(webhookReceipt)
          .values({
            id: newId(),
            operatorId: account.operatorId,
            channelAccountId: account.id,
            providerEventId: deliveryId,
            receivedAt: startedAt,
            signatureOk: true,
            payload: jsonOf(input.webhook.rawBody) as never,
            error: errorCode(err),
          })
          .onConflictDoNothing()
          .returning({ id: webhookReceipt.id });
        receiptId = made?.id ?? null;
      } catch (inner) {
        deps.log?.error({ err: inner }, 'the inbox webhook could not keep a failed delivery');
      }
      return await record(empty('failed', receiptId), err);
    }

    if (deps.dispatch !== false && result.outOfHours.length > 0) {
      await dispatchQueued(db, deps, account, channel, result.outOfHours, input);
    }
    return await record(result);
  } catch (err) {
    deps.log?.error({ err }, 'the inbox webhook failed outside its transaction');
    return await record(empty('failed'), err);
  }
}

interface ReceiveCtx {
  account: AccountRow;
  channel: MessagingChannel;
  deliveryId: string;
  input: IngestInput;
  now: Date;
}

/** Steps 2 to 9, inside the delivery's one transaction. */
async function receive(tx: Tx, c: ReceiveCtx): Promise<IngestResult> {
  const { account } = c;
  const receiptId = newId();
  const [claimed] = await tx
    .insert(webhookReceipt)
    .values({
      id: receiptId,
      operatorId: account.operatorId,
      channelAccountId: account.id,
      providerEventId: c.deliveryId,
      receivedAt: c.now,
      signatureOk: true,
      payload: jsonOf(c.input.webhook.rawBody) as never,
    })
    .onConflictDoNothing()
    .returning({ id: webhookReceipt.id });
  if (!claimed) {
    const [prior] = await tx
      .select({ id: webhookReceipt.id })
      .from(webhookReceipt)
      .where(and(eq(webhookReceipt.channelAccountId, account.id), eq(webhookReceipt.providerEventId, c.deliveryId)))
      .limit(1);
    return empty('duplicate', prior?.id ?? null);
  }

  const result = empty('processed', receiptId);
  let events;
  try {
    events = c.channel.parseWebhook(c.input.webhook);
  } catch (err) {
    const code = err instanceof ChannelError ? err.code : 'MALFORMED_PAYLOAD';
    await tx
      .update(webhookReceipt)
      .set({ processedAt: c.now, error: code, updatedAt: c.now })
      .where(eq(webhookReceipt.id, receiptId));
    await audit.record(tx, {
      actorAccountId: c.input.actorAccountId ?? null,
      action: 'inbox.webhook.receive',
      entityType: 'inbox.webhook_receipt',
      entityId: receiptId,
      operatorId: account.operatorId,
      branchId: account.branchId,
      requestId: c.input.requestId ?? null,
      after: { channelAccountId: account.id, outcome: 'malformed', error: code },
    });
    return { ...result, outcome: 'malformed' };
  }

  let unknown = 0;
  let foreign = 0;
  for (const event of events) {
    if (event.kind !== 'unknown' && event.channelExternalId !== account.externalId) {
      // Addressed to another number: never filed under this one.
      foreign += 1;
      continue;
    }
    if (event.kind === 'message') await receiveMessage(tx, c, event, result);
    else if (event.kind === 'status') result.statuses += await receiveStatus(tx, c, event);
    else unknown += 1;
  }

  await tx
    .update(webhookReceipt)
    .set({ processedAt: c.now, updatedAt: c.now })
    .where(eq(webhookReceipt.id, receiptId));
  await audit.record(tx, {
    actorAccountId: c.input.actorAccountId ?? null,
    action: 'inbox.webhook.receive',
    entityType: 'inbox.webhook_receipt',
    entityId: receiptId,
    operatorId: account.operatorId,
    branchId: account.branchId,
    requestId: c.input.requestId ?? null,
    after: {
      channelAccountId: account.id,
      events: events.length,
      messages: result.messages,
      duplicates: result.duplicates,
      statuses: result.statuses,
      unknown,
      foreign,
      conversationsCreated: result.conversationsCreated,
      reopened: result.reopened,
      outOfHours: result.outOfHours,
      conversationIds: result.conversationIds,
    },
  });
  return result;
}

/** At most 140 characters, on a character boundary. */
function previewOf(text: string | null): string | null {
  if (!text) return null;
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length <= 140 ? chars.join('') : `${chars.slice(0, 139).join('')}…`;
}

/** Never later than now: a provider's clock is not ours to trust into the future. */
function capped(at: Date, now: Date): Date {
  return at.getTime() > now.getTime() ? now : at;
}

async function receiveMessage(
  tx: Tx,
  c: ReceiveCtx,
  event: InboundMessageEvent,
  result: IngestResult,
): Promise<void> {
  const { account } = c;
  const operatorId = account.operatorId;

  // The per-message dedupe, before any other write.
  const [seen] = await tx
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.channelAccountId, account.id), eq(message.externalMessageId, event.externalMessageId)))
    .limit(1);
  if (seen) {
    result.duplicates += 1;
    return;
  }

  const at = capped(event.timestamp, c.now);
  // WhatsApp's handle IS the phone: kept as E.164, the platform's one phone
  // shape, so the check-in notice to the same phone finds the same contact.
  // Elsewhere the handle is the channel's scoped id and there is no phone.
  const phone = account.channel === 'whatsapp' && event.phone ? normalizePhone(event.phone) : null;
  const handle = phone ?? event.handle;
  const hintLanguage = event.hint?.language?.toLowerCase().slice(0, 8) ?? null;

  // The contact.
  const [madeContact] = await tx
    .insert(contact)
    .values({
      id: newId(),
      operatorId,
      channel: account.channel,
      externalHandle: handle,
      displayName: event.displayName,
      phone,
      language: hintLanguage,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .onConflictDoNothing({ target: [contact.operatorId, contact.channel, contact.externalHandle] })
    .returning();
  const person =
    madeContact ??
    (
      await tx
        .select()
        .from(contact)
        .where(
          and(eq(contact.operatorId, operatorId), eq(contact.channel, account.channel), eq(contact.externalHandle, handle)),
        )
        .limit(1)
    )[0]!;
  let memberId = person.memberId;
  if (!memberId && person.phone && !person.erasedAt) {
    const [m] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.operatorId, operatorId), eq(member.phone, person.phone), isNull(member.archivedAt)))
      .limit(1);
    memberId = m?.id ?? null;
  }
  if (!madeContact) {
    await tx
      .update(contact)
      .set({
        lastSeenAt: sql`greatest(${contact.lastSeenAt}, ${at.toISOString()}::timestamptz)`,
        displayName: sql`coalesce(${contact.displayName}, ${event.displayName})`,
        language: sql`coalesce(${contact.language}, ${hintLanguage})`,
        memberId,
        updatedAt: c.now,
      })
      .where(eq(contact.id, person.id));
  } else if (memberId) {
    await tx.update(contact).set({ memberId }).where(eq(contact.id, person.id));
  }

  // The thread: one per contact per channel account.
  const findThread = async () =>
    (
      await tx
        .select()
        .from(conversation)
        .where(
          and(
            eq(conversation.operatorId, operatorId),
            eq(conversation.contactId, person.id),
            eq(conversation.channelAccountId, account.id),
          ),
        )
        .limit(1)
        .for('update')
    )[0];
  let thread = await findThread();
  let created = false;
  if (!thread) {
    const category: InboxCategory = event.hint?.category ?? account.defaultCategory;
    const language = hintLanguage ?? person.language ?? 'en';
    // The CHANNEL ACCOUNT'S branch first (a park's own number belongs to that
    // park); the hint's only for an operator-wide account, and only when the
    // hint names a live branch of THIS operator.
    let branchId = account.branchId;
    if (!branchId && event.hint?.branchId) {
      const [b] = await tx
        .select({ id: branch.id })
        .from(branch)
        .where(and(eq(branch.id, event.hint.branchId), eq(branch.operatorId, operatorId), isNull(branch.archivedAt)))
        .limit(1);
      branchId = b?.id ?? null;
    }
    const [made] = await tx
      .insert(conversation)
      .values({
        id: newId(),
        operatorId,
        contactId: person.id,
        channelAccountId: account.id,
        branchId,
        category,
        intent: event.hint?.intent?.slice(0, 120) ?? null,
        language,
        status: 'active',
        memberId,
        createdAt: at,
      })
      .onConflictDoNothing()
      .returning();
    if (made) {
      thread = made;
      created = true;
    } else {
      thread = (await findThread())!;
    }
  }

  // The message, keyed on the provider's id (the race the pre-check cannot see).
  const messageId = newId();
  const [stored] = await tx
    .insert(message)
    .values({
      id: messageId,
      operatorId,
      conversationId: thread.id,
      channelAccountId: account.id,
      direction: 'inbound',
      authorKind: 'customer',
      body: event.text,
      bodyLanguage: hintLanguage,
      externalMessageId: event.externalMessageId,
      source: 'channel',
      createdAt: at,
    })
    .onConflictDoNothing()
    .returning({ id: message.id });
  if (!stored) {
    result.duplicates += 1;
    return;
  }
  result.messages += 1;
  if (!result.conversationIds.includes(thread.id)) result.conversationIds.push(thread.id);

  // The thread's clock and preview move only forward: a late-arriving older
  // message does not become "the last message".
  const latest = !thread.lastMessageAt || at.getTime() >= thread.lastMessageAt.getTime();
  const reopen = thread.status === 'handled';
  await tx
    .update(conversation)
    .set({
      lastCustomerMessageAt: sql`greatest(${conversation.lastCustomerMessageAt}, ${at.toISOString()}::timestamptz)`,
      lastMessageAt: sql`greatest(${conversation.lastMessageAt}, ${at.toISOString()}::timestamptz)`,
      ...(latest ? { lastMessagePreview: previewOf(event.text) } : {}),
      ...(thread.memberId ? {} : { memberId }),
      ...(reopen
        ? { status: 'active' as const, reopenedAt: at, handledAt: null, handledByKind: null, handledByAccountId: null }
        : {}),
      updatedAt: c.now,
    })
    .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, thread.id)));

  if (reopen) {
    result.reopened += 1;
    await tx.insert(inboxEvent).values({
      id: newId(),
      operatorId,
      conversationId: thread.id,
      kind: 'reopened',
      actorKind: 'customer',
      payload: {
        messageId,
        automatic: true,
        previousHandledAt: thread.handledAt?.toISOString() ?? null,
        previousHandledByKind: thread.handledByKind,
        previousHandledByAccountId: thread.handledByAccountId,
      },
      createdAt: at,
    });
    await audit.record(tx, {
      actorAccountId: null,
      action: 'inbox.conversation.reopen',
      entityType: 'inbox.conversation',
      entityId: thread.id,
      operatorId,
      branchId: thread.branchId,
      requestId: c.input.requestId ?? null,
      before: { status: 'handled', handledAt: thread.handledAt?.toISOString() ?? null, handledByAccountId: thread.handledByAccountId },
      after: { status: 'active', reopenedAt: at.toISOString(), by: 'customer', messageId },
    });
  }

  // A thread nobody has routed yet — a mirrored check-in notice thread is
  // created with its reception team and no owner (I2c) — is routed like a
  // new one the first time a customer message lands in it.
  const unrouted = !created && thread.lastRoutedAt === null && !(await hasPrimary(tx, operatorId, thread.id));
  if (created || unrouted) {
    if (created) result.conversationsCreated += 1;
    const routed = await routeConversation(tx, {
      operatorId,
      conversationId: thread.id,
      category: thread.category,
      language: thread.language ?? 'en',
      branchId: thread.branchId,
      at,
    });
    await audit.record(tx, {
      actorAccountId: null,
      action: created ? 'inbox.conversation.create' : 'inbox.conversation.route',
      entityType: 'inbox.conversation',
      entityId: thread.id,
      operatorId,
      branchId: thread.branchId,
      requestId: c.input.requestId ?? null,
      after: {
        contactId: person.id,
        channelAccountId: account.id,
        category: thread.category,
        language: thread.language,
        branchId: thread.branchId,
        teamId: routed.teamId,
        ruleId: routed.ruleId,
        fallback: routed.fallback,
        assignments: routed.assignments.map((a) => ({
          id: a.id,
          slot: a.slot,
          assigneeKind: a.assigneeKind,
          accountId: a.accountId,
          teamId: a.teamId,
        })),
      },
    });
  }

  const queued = await queueOutOfHours(tx, c, thread.id, person.language ?? hintLanguage ?? thread.language);
  if (queued) result.outOfHours.push(queued);
}

/**
 * Step 7. Queues the reply and answers its id, or null when none is due:
 * the account cannot reply, has no hours, is open now, or this thread
 * already had its reply since the park closed.
 */
async function queueOutOfHours(tx: Tx, c: ReceiveCtx, conversationId: string, language: string | null): Promise<string | null> {
  const { account } = c;
  if (!account.canReply || !c.channel.capabilities.reply) return null;
  const hours = readOpeningHours(account.openingHours);
  if (!hours) return null;
  let timeZone = 'Asia/Bangkok';
  if (account.branchId) {
    const [b] = await tx.select({ tz: branch.timezone }).from(branch).where(eq(branch.id, account.branchId)).limit(1);
    if (b?.tz) timeZone = b.tz;
  }
  if (isOpenAt(hours, timeZone, c.now)) return null;

  const key = account.outOfHoursTemplateKey ?? 'out_of_hours';
  const since = closedSince(hours, timeZone, c.now);
  const sameKey = await tx
    .select({ id: message.id })
    .from(message)
    .innerJoin(template, and(eq(template.operatorId, message.operatorId), eq(template.id, message.templateId)))
    .where(
      and(
        eq(message.operatorId, account.operatorId),
        eq(message.conversationId, conversationId),
        eq(message.direction, 'outbound'),
        eq(template.key, key),
        ...(since ? [gte(message.createdAt, since)] : []),
      ),
    )
    .limit(1);
  if (sameKey.length > 0) return null;

  const lang = (language ?? 'en').toLowerCase();
  const candidates = await tx
    .select()
    .from(template)
    .where(
      and(
        eq(template.operatorId, account.operatorId),
        eq(template.key, key),
        eq(template.active, true),
        isNull(template.archivedAt),
        or(isNull(template.channel), eq(template.channel, account.channel)),
        or(isNull(template.branchId), account.branchId ? eq(template.branchId, account.branchId) : sql`false`),
      ),
    )
    .orderBy(desc(template.updatedAt));
  // The customer's language, then English; the more specific row first.
  const rank = (t: (typeof candidates)[number]) =>
    (t.language === lang ? 0 : t.language === 'en' ? 10 : 100) - (t.channel ? 2 : 0) - (t.branchId ? 1 : 0);
  const chosen = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
  if (!chosen || (chosen.language !== lang && chosen.language !== 'en')) return null;

  const id = newId();
  await tx.insert(message).values({
    id,
    operatorId: account.operatorId,
    conversationId,
    channelAccountId: account.id,
    direction: 'outbound',
    authorKind: 'system',
    body: chosen.body,
    bodyLanguage: chosen.language,
    templateId: chosen.id,
    providerStatus: 'queued',
    source: 'channel',
    createdAt: c.now,
  });
  await tx
    .update(conversation)
    .set({
      lastMessageAt: sql`greatest(${conversation.lastMessageAt}, ${c.now.toISOString()}::timestamptz)`,
      lastMessagePreview: previewOf(chosen.body),
      updatedAt: c.now,
    })
    .where(and(eq(conversation.operatorId, account.operatorId), eq(conversation.id, conversationId)));
  await audit.record(tx, {
    actorAccountId: null,
    action: 'inbox.message.queue',
    entityType: 'inbox.message',
    entityId: id,
    operatorId: account.operatorId,
    branchId: account.branchId,
    requestId: c.input.requestId ?? null,
    after: { messageId: id, conversationId, templateKey: key, language: chosen.language, reason: 'out_of_hours' },
  });
  return id;
}

/** Whether the thread has an active primary owner. */
async function hasPrimary(tx: Exec, operatorId: string, conversationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: assignment.id })
    .from(assignment)
    .where(
      and(
        eq(assignment.operatorId, operatorId),
        eq(assignment.conversationId, conversationId),
        eq(assignment.slot, 'primary'),
        isNull(assignment.releasedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 1 } as const;

/** Step 8. Moves an outbound message's state forward; never back. Answers 1 when a row moved. */
async function receiveStatus(tx: Tx, c: ReceiveCtx, event: InboundStatusEvent): Promise<number> {
  const [row] = await tx
    .select()
    .from(message)
    .where(
      and(
        eq(message.channelAccountId, c.account.id),
        eq(message.externalMessageId, event.externalMessageId),
        eq(message.direction, 'outbound'),
      ),
    )
    .limit(1)
    .for('update');
  if (!row) return 0;
  const at = capped(event.timestamp, c.now);
  const current = row.providerStatus ?? 'queued';
  const forward =
    event.status === 'failed'
      ? current === 'queued' || current === 'sent'
      : STATUS_RANK[event.status] > STATUS_RANK[current] && current !== 'failed';
  const patch: Partial<typeof message.$inferInsert> = {};
  if (forward) patch.providerStatus = event.status;
  if ((event.status === 'delivered' || event.status === 'read') && !row.deliveredAt) patch.deliveredAt = at;
  if (event.status === 'read' && !row.readAt) patch.readAt = at;
  if (event.status === 'sent' && !row.sentAt) patch.sentAt = at;
  if (event.status === 'failed' && forward && event.error) {
    patch.error = `${event.error.refusal}:${event.error.providerCode}`.slice(0, 120);
  }
  if (Object.keys(patch).length === 0) return 0;
  await tx
    .update(message)
    .set({ ...patch, updatedAt: c.now })
    .where(eq(message.id, row.id));
  return 1;
}

/**
 * Send the queued out-of-hours replies through the channel, after the
 * delivery's transaction committed. Each send is its own transaction and
 * audit row; a refusal is recorded on the message (`failed` and the refusal
 * word), never thrown. The id travels as the provider's client reference, so
 * a status callback names our row.
 */
export async function dispatchQueued(
  db: Exec,
  deps: Pick<IngestDeps, 'log' | 'now'>,
  account: AccountRow,
  channel: MessagingChannel,
  messageIds: readonly string[],
  input: Pick<IngestInput, 'requestId' | 'actorAccountId'> = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  for (const id of messageIds) {
    const startedAt = new Date();
    try {
      const [row] = await db
        .select({
          message,
          handle: contact.externalHandle,
          phone: contact.phone,
          lastCustomerMessageAt: conversation.lastCustomerMessageAt,
          templateKey: template.key,
          providerTemplateName: template.providerTemplateName,
          approvalStatus: template.approvalStatus,
        })
        .from(message)
        .innerJoin(conversation, and(eq(conversation.operatorId, message.operatorId), eq(conversation.id, message.conversationId)))
        .innerJoin(contact, and(eq(contact.operatorId, conversation.operatorId), eq(contact.id, conversation.contactId)))
        .leftJoin(template, and(eq(template.operatorId, message.operatorId), eq(template.id, message.templateId)))
        .where(and(eq(message.id, id), eq(message.operatorId, account.operatorId)))
        .limit(1);
      if (!row || row.message.providerStatus !== 'queued') continue;
      const body = row.message.body ?? '';
      // A provider-approved template goes as one; until Meta approves it (or
      // on a channel with no approvals), the reply is plain text, which the
      // customer's message just opened the window for.
      const content: OutboundContent =
        row.providerTemplateName && row.approvalStatus === 'approved'
          ? { kind: 'template', name: row.providerTemplateName, language: row.message.bodyLanguage ?? 'en', renderedText: body }
          : { kind: 'text', text: body };
      const sent = await channel.send({
        clientRef: id,
        to: { handle: row.handle, phone: row.phone },
        content,
        lastCustomerMessageAt: row.lastCustomerMessageAt,
      });
      await withTx(
        db,
        { requestId: input.requestId ?? undefined, operatorId: account.operatorId, branchId: account.branchId, log: deps.log },
        'inbox.message.send',
        async (tx) => {
          await tx
            .update(message)
            .set(
              sent.ok
                ? { providerStatus: 'sent', externalMessageId: sent.externalMessageId, sentAt: sent.acceptedAt, updatedAt: now() }
                : { providerStatus: 'failed', error: sent.refusal, updatedAt: now() },
            )
            .where(and(eq(message.id, id), eq(message.providerStatus, 'queued')));
          await audit.record(tx, {
            actorAccountId: input.actorAccountId ?? null,
            action: 'inbox.message.send',
            entityType: 'inbox.message',
            entityId: id,
            operatorId: account.operatorId,
            branchId: account.branchId,
            requestId: input.requestId ?? null,
            after: {
              messageId: id,
              conversationId: row.message.conversationId,
              templateKey: row.templateKey,
              length: [...body].length,
              outcome: sent.ok ? 'sent' : sent.refusal,
            },
          });
        },
      );
      await recordRun(db, {
        kind: 'adapter',
        name: 'adapter:inbox.send',
        outcome: sent.ok ? 'ok' : 'failed',
        startedAt,
        requestId: input.requestId ?? null,
        operatorId: account.operatorId,
        branchId: account.branchId,
        detail: { messageId: id, outcome: sent.ok ? 'sent' : sent.refusal, providerCode: sent.ok ? null : sent.providerCode },
        ...(sent.ok ? {} : { error: new Error(`inbox send ${sent.refusal}`) }),
      });
    } catch (err) {
      // The message stays `queued`; the send job's sweeper (plan §3.5) is
      // what retries it.
      deps.log?.error({ err, messageId: id }, 'an inbox reply could not be sent');
    }
  }
}

/** The delivery as JSON for the receipt, or null when it is not JSON. */
function jsonOf(raw: string | Uint8Array): unknown {
  try {
    return JSON.parse(bodyBytes(raw).toString('utf8'));
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown };
    if (typeof e.code === 'string') return e.code.slice(0, 80);
    if (typeof e.name === 'string') return e.name.slice(0, 80);
  }
  return 'UNKNOWN';
}
