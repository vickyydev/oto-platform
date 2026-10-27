import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { channelAccount, contact, conversation, fileObject, inboxEvent, message, template, type Db } from '@oto/db';
import { insideFreeTextWindow, type OutboundContent, type SendResult } from '@oto/messaging';
import { newId, templateParameters } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { audit } from '../audit';
import type { FileStorage } from '../files';
import { recordRun } from '../ops';
import { outboundMessagingPaused } from '../suite-flags';
import { withTx } from '../tx';
import type { InboxChannels } from './channels';

/**
 * THE INBOX SEND PATH AND ITS JOB (S2-19 I2f, SCRUM-585; plan
 * `docs/progress/plans/inbox-build/PLAN.md` §3.5).
 *
 * Every outbound channel message — a staff reply, the out-of-hours line the
 * ingest queues — is written `queued` first and leaves through ONE function,
 * `sendQueuedMessage`. It is called twice over:
 *
 *   - at once, after the transaction that queued the message commits (the
 *     reply route, the ingest's out-of-hours reply), so a reply on a healthy
 *     channel is sent while the person who wrote it is still looking; and
 *   - by `job:inbox.send` on the api's job runner (`services/jobs.ts` — a
 *     timer, an advisory-locked tick and an `ops_last` row, not pg-boss: the
 *     plan's "pg-boss runner" is the runner this api actually has), which is
 *     the SWEEPER: every queued message whose next attempt is due is tried
 *     again. A message queued while no post-commit send could run (the demo
 *     seed, a crash between the commit and the send) is picked up here.
 *
 * THE RESEND RULE. Only a `queued` row is ever sent. A row the provider
 * accepted is `sent` and is never sent again, whatever happens after: the
 * WhatsApp Cloud API has no idempotency key — `biz_opaque_callback_data` is
 * echoed on status callbacks, nothing more — so a second POST is a second
 * message on the customer's phone. A retry happens only where the channel
 * answered with a refusal that proves it did not accept (`RATE_LIMITED`,
 * `UNREACHABLE`: `retryable` on the `SendResult`).
 *
 * THE CLAIM. Before the provider is called the row is claimed in one
 * statement: its attempt count goes up and `next_attempt_at` moves a lease
 * (five minutes) ahead, only if it is still queued and due. Two senders — the
 * post-commit call and a job tick, or two api instances — cannot both claim
 * it, and the provider call runs with no transaction open. A sender that dies
 * after claiming leaves the row queued with its lease running; when the lease
 * runs out the sweeper sends it — the plan's "re-enqueues anything queued for
 * more than five minutes". That one window (the provider accepted, the
 * process died before the answer was written) is the only way a message can
 * go twice, and it is the window every at-least-once sender has.
 *
 * WHAT A REFUSAL DOES:
 *   retryable, attempts left   stays `queued`; `error` holds the word;
 *                              `next_attempt_at` backs off (30 s doubling,
 *                              at most 30 min); tried again by the sweeper
 *   anything else, or the      `failed`, with the word in `error`, and a
 *   last attempt               `send_failed` event on the thread's timeline
 *                              naming the word and the ids — never the words
 * Each attempt is an audit row and an `ops_run` (`adapter:inbox.send`), ids,
 * counts and the refusal word only — a failed one reaches the Console's
 * Failures page through the ops machinery.
 *
 * MEDIA (SCRUM-590 rails change R4, plan `docs/progress/plans/inbox-ai-build/
 * PLAN.md` §C.5). A queued row whose `media_file_ids` holds a file goes as the
 * contract's `media` content: the object's link is a presigned GET minted
 * INSIDE the attempt, after the claim, valid `OUTBOUND_MEDIA_LINK_S` — long
 * enough for the provider to fetch it after it accepted — and a retry re-mints
 * it, so no attempt hands over a link minted for an earlier one. The row's
 * `body` is the caption. One file per message (a WhatsApp media message is
 * one object); only an inbox-owned file (`owner_entity_type` `inbox.*`: a
 * message's own media, a template's brochure) of the row's operator is ever
 * sent, so no other file of the platform can reach a customer through here.
 * A media row is free-form: inside the free-text window it goes; outside it
 * the channel refuses `TEMPLATE_REQUIRED`, like any free text.
 *
 * A PERSON OUTRANKS THE AI (§A.3). The claim refuses an AI-authored row
 * (`author_kind 'ai'`) once a staff message exists in its thread after it.
 * Such a row, when due, is marked `withdrawn` — never sent, final — with an
 * `ai_withdrawn` event on the timeline and an `inbox.ai.message.withdraw`
 * audit row, ids and the reason word only. A row under a live lease is not
 * withdrawn here: its provider call may be in flight, and if the provider
 * accepts it the row is `sent` whatever a withdrawal wrote meanwhile — the
 * thread says what the customer actually received.
 *
 * PAUSED (SCRUM-643, the Console's "pause outbound messaging" kill switch).
 * While the switch resolves on for the message's park group or park, nothing
 * is claimed and no channel is called: the row stays `queued` with its
 * attempts untouched — a pause is not a failure and must not spend the retry
 * budget — and its next attempt moves one sweep interval on, so the paused
 * rows rotate behind everyone else's. When the switch is cleared or reverts
 * at its expiry, the next sweep sends them as normal.
 */

export const INBOX_SEND_JOB = 'job:inbox.send';
/** How often the sweeper looks for due messages. */
export const INBOX_SEND_INTERVAL_S = 30;
/** How long a claim holds a row before the sweeper may take it again. */
export const SEND_LEASE_MS = 5 * 60_000;
/** Attempts before a retryable refusal is given up on and the message marked failed. */
export const SEND_MAX_ATTEMPTS = 6;
/** Messages one sweep sends at most; the rest wait for the next tick. */
const SWEEP_BATCH = 50;
/**
 * How long an outbound media link is valid (plan §C.5: raised from the files
 * api's five minutes for a provider fetch). Minted per attempt.
 */
export const OUTBOUND_MEDIA_LINK_S = 15 * 60;
/** Why the send path withdrew an AI line: a person wrote in the thread after it. */
export const AI_WITHDRAW_REASON = 'STAFF_REPLY';

/** The wait after the n-th failed attempt: 30 s, 1 min, 2 min, … at most 30 min. */
export function sendBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

export interface SendDeps {
  channels: InboxChannels;
  /** Where outbound media live (`app.fileStorage`); without it a media row is refused (retryable), nothing else. */
  storage?: FileStorage | null;
  log?: FastifyBaseLogger;
  now?: () => Date;
}

export interface SendCtx {
  requestId?: string | null;
  actorAccountId?: string | null;
}

export type SendOutcome =
  | { messageId: string; outcome: 'sent'; attempt: number; externalMessageId: string }
  | { messageId: string; outcome: 'retry'; attempt: number; refusal: string; nextAttemptAt: Date }
  | { messageId: string; outcome: 'failed'; attempt: number; refusal: string }
  /** An AI line a person overtook (§A.3): marked `withdrawn`, never sent. */
  | { messageId: string; outcome: 'withdrawn' }
  /** Not queued, not due, or claimed by another sender. Nothing was sent. */
  | { messageId: string; outcome: 'skipped' }
  /** SCRUM-643: outbound messaging is paused here. Still queued, nothing sent, no attempt spent. */
  | { messageId: string; outcome: 'paused' };

/**
 * Refusal words the api adds to the channel's five, for a send it never
 * handed to a channel. `MEDIA_UNAVAILABLE`: the file cannot be linked (no
 * storage, or storage not answering — retried; no such inbox file, or more
 * than one — not); `MEDIA_UNSUPPORTED`: the channel sends no media.
 */
type LocalRefusal =
  | 'CHANNEL_NOT_CONNECTED'
  | 'CHANNEL_CANNOT_REPLY'
  | 'CONTACT_ERASED'
  | 'MEDIA_UNAVAILABLE'
  | 'MEDIA_UNSUPPORTED';
interface LocalResult {
  ok: false;
  refusal: LocalRefusal;
  retryable: boolean;
  providerCode: null;
  detail: string;
}

const local = (refusal: LocalRefusal, retryable: boolean, detail: string): LocalResult => ({
  ok: false,
  refusal,
  retryable,
  providerCode: null,
  detail,
});

/**
 * The outer row of an UPDATE on `inbox.message`, by its table name: the
 * subquery below aliases its own scan, so these references cannot bind to it.
 */
const OUTER = sql.raw('"message"');

/** §A.3: a staff message exists in the row's thread, written after it. */
const STAFF_SPOKE_AFTER = sql`exists (
  select 1 from ${message} as later
   where later.operator_id = ${OUTER}.operator_id
     and later.conversation_id = ${OUTER}.conversation_id
     and later.author_kind = 'staff'
     and later.created_at > ${OUTER}.created_at)`;

/** The claim's AI predicate: anything but an AI line, or an AI line no person has overtaken. */
const NOT_OVERTAKEN = sql`(${OUTER}.author_kind <> 'ai' or not ${STAFF_SPOKE_AFTER})`;

/** What a WhatsApp-shaped channel calls a file of this content type. */
export function outboundMediaType(contentType: string): 'image' | 'video' | 'audio' | 'document' {
  const top = contentType.split('/', 1)[0]!.toLowerCase();
  return top === 'image' || top === 'video' || top === 'audio' ? top : 'document';
}

/** The object key's last segment: the document's file name on the customer's phone. */
function filenameOf(objectKey: string): string | undefined {
  return objectKey.split('/').pop() || undefined;
}

/**
 * Send one queued message, if it is still queued and due. NEVER THROWS for a
 * channel's reason: the outcome is a value, and so is every refusal.
 */
export async function sendQueuedMessage(
  db: Db,
  deps: SendDeps,
  messageId: string,
  ctx: SendCtx = {},
): Promise<SendOutcome> {
  const now = deps.now ?? (() => new Date());
  const startedAt = new Date();
  const at = now();

  // THE PAUSE, before any claim: where the switch is on, no channel is called.
  if (await pausedHere(db, messageId, at)) {
    await db.update(message)
      .set({ nextAttemptAt: new Date(at.getTime() + INBOX_SEND_INTERVAL_S * 1000), updatedAt: at })
      .where(and(eq(message.id, messageId), eq(message.providerStatus, 'queued'),
        or(isNull(message.nextAttemptAt), lte(message.nextAttemptAt, at))));
    return { messageId, outcome: 'paused' };
  }

  // THE CLAIM: queued, outbound, not redacted, and due — or nothing.
  const [claimed] = await db
    .update(message)
    .set({
      sendAttempts: sql`${message.sendAttempts} + 1`,
      nextAttemptAt: new Date(at.getTime() + SEND_LEASE_MS),
      updatedAt: at,
    })
    .where(
      and(
        eq(message.id, messageId),
        eq(message.direction, 'outbound'),
        eq(message.providerStatus, 'queued'),
        isNull(message.redactedAt),
        or(isNull(message.nextAttemptAt), lte(message.nextAttemptAt, at)),
        NOT_OVERTAKEN,
      ),
    )
    .returning();
  if (!claimed) {
    return (await withdrawOvertaken(db, deps, messageId, at, ctx))
      ? { messageId, outcome: 'withdrawn' }
      : { messageId, outcome: 'skipped' };
  }
  const attempt = claimed.sendAttempts;

  const [row] = await db
    .select({
      conversation,
      handle: contact.externalHandle,
      phone: contact.phone,
      erasedAt: contact.erasedAt,
      account: channelAccount,
      templateKey: template.key,
      templateBody: template.body,
      providerTemplateName: template.providerTemplateName,
      approvalStatus: template.approvalStatus,
    })
    .from(conversation)
    .innerJoin(contact, and(eq(contact.operatorId, conversation.operatorId), eq(contact.id, conversation.contactId)))
    .innerJoin(
      channelAccount,
      and(eq(channelAccount.operatorId, claimed.operatorId), eq(channelAccount.id, claimed.channelAccountId)),
    )
    .leftJoin(template, and(eq(template.operatorId, claimed.operatorId), eq(template.id, claimed.templateId ?? sql`null`)))
    .where(and(eq(conversation.operatorId, claimed.operatorId), eq(conversation.id, claimed.conversationId)))
    .limit(1);

  let result: SendResult | LocalResult;
  if (!row) {
    result = local('CHANNEL_NOT_CONNECTED', false, 'no channel account');
  } else if (row.erasedAt) {
    result = local('CONTACT_ERASED', false, 'the contact was erased');
  } else if (row.account.archivedAt || !row.account.canReply) {
    result = local('CHANNEL_CANNOT_REPLY', false, 'the account cannot reply');
  } else {
    const found = deps.channels.forAccount({
      id: row.account.id,
      provider: row.account.provider,
      channel: row.account.channel,
      externalId: row.account.externalId,
      displayName: row.account.displayName,
      credentialRef: row.account.credentialRef,
    });
    if (!found.ok) {
      // Configuration can come back (the simulator switched on, a credential
      // set): retried, and given up on with the rest.
      result = { ok: false, refusal: 'CHANNEL_NOT_CONNECTED', retryable: true, providerCode: null, detail: found.reason };
    } else if (!found.channel.capabilities.reply) {
      result = local('CHANNEL_CANNOT_REPLY', false, 'send-only channel');
    } else if (claimed.mediaFileIds.length > 0 && !found.channel.capabilities.media) {
      result = local('MEDIA_UNSUPPORTED', false, 'the channel sends no media');
    } else {
      const body = claimed.body ?? '';
      const windowHours = found.channel.capabilities.freeTextWindowHours;
      const inWindow =
        windowHours === null || insideFreeTextWindow(row.conversation.lastCustomerMessageAt, at, windowHours);
      let content: OutboundContent | LocalResult;
      if (claimed.mediaFileIds.length > 0) {
        // A row that carries a file is that file, its body the caption; the
        // link is minted now, for this attempt.
        content = await mediaContent(db, deps.storage ?? null, claimed.operatorId, claimed.mediaFileIds, body);
      } else if (claimed.templateId && row.templateKey !== null) {
        const approved = row.approvalStatus === 'approved' && row.providerTemplateName;
        if (approved || !inWindow) {
          // An approved template goes as one, its values as body parameters.
          // Outside the window a template whose channel needs no approval
          // goes as a template too (the simulator honours that); a live
          // channel would refuse an unapproved name, and that refusal is
          // what the thread shows.
          const parameters = row.templateBody ? templateParameters(row.templateBody, body) : null;
          content = {
            kind: 'template',
            name: row.providerTemplateName ?? row.templateKey,
            language: claimed.bodyLanguage ?? 'en',
            ...(parameters && parameters.length > 0 ? { bodyParameters: parameters } : {}),
            renderedText: body,
          };
        } else {
          content = { kind: 'text', text: body };
        }
      } else {
        content = { kind: 'text', text: body };
      }
      if ('ok' in content) {
        result = content;
      } else {
        try {
          result = await found.channel.send({
            clientRef: claimed.id,
            to: { handle: row.handle, phone: row.phone },
            content,
            lastCustomerMessageAt: row.conversation.lastCustomerMessageAt,
          });
        } catch {
          // The contract says refusals are values; a throw is an adapter that
          // failed before it could answer. Kept queued — never marked sent.
          result = { ok: false, refusal: 'UNREACHABLE', retryable: true, providerCode: null, detail: 'the adapter threw' };
        }
      }
    }
  }

  const done = now();
  let outcome: SendOutcome;
  if (result.ok) {
    outcome = { messageId, outcome: 'sent', attempt, externalMessageId: result.externalMessageId };
  } else if (result.retryable && attempt < SEND_MAX_ATTEMPTS) {
    outcome = {
      messageId,
      outcome: 'retry',
      attempt,
      refusal: result.refusal,
      nextAttemptAt: new Date(done.getTime() + sendBackoffMs(attempt)),
    };
  } else {
    outcome = { messageId, outcome: 'failed', attempt, refusal: result.refusal };
  }

  const branchId = row?.conversation.branchId ?? row?.account.branchId ?? null;
  const operatorId = claimed.operatorId;
  await withTx(
    db,
    {
      requestId: ctx.requestId ?? undefined,
      actorAccountId: ctx.actorAccountId ?? null,
      operatorId,
      branchId,
      ...(deps.log ? { log: deps.log } : {}),
    },
    'inbox.message.send',
    async (tx) => {
      const stillQueued = and(eq(message.id, messageId), eq(message.providerStatus, 'queued'));
      if (outcome.outcome === 'sent') {
        // The provider accepted: the row is sent, even when a withdrawal
        // landed while the call was in flight — the customer has the line and
        // the thread must say so (§A.3's one window, in the plan's Risks).
        await tx
          .update(message)
          .set({
            providerStatus: 'sent',
            externalMessageId: outcome.externalMessageId,
            sentAt: result.ok ? result.acceptedAt : done,
            error: null,
            nextAttemptAt: null,
            updatedAt: done,
          })
          .where(and(eq(message.id, messageId), inArray(message.providerStatus, ['queued', 'withdrawn'])));
      } else if (outcome.outcome === 'retry') {
        await tx
          .update(message)
          .set({ error: outcome.refusal, nextAttemptAt: outcome.nextAttemptAt, updatedAt: done })
          .where(stillQueued);
      } else if (outcome.outcome === 'failed') {
        await tx
          .update(message)
          .set({ providerStatus: 'failed', error: outcome.refusal, nextAttemptAt: null, updatedAt: done })
          .where(stillQueued);
        // The thread's timeline says the reply did not go, and why — in the
        // refusal's word and ids, never the words of the reply.
        await tx.insert(inboxEvent).values({
          id: newId(),
          operatorId,
          conversationId: claimed.conversationId,
          kind: 'send_failed',
          actorKind: 'system',
          payload: {
            messageId,
            refusal: outcome.refusal,
            providerCode: result.ok ? null : result.providerCode,
            attempts: attempt,
            templateKey: row?.templateKey ?? null,
          },
          createdAt: done,
        });
      }
      await audit.record(tx, {
        actorAccountId: ctx.actorAccountId ?? null,
        action: 'inbox.message.send',
        entityType: 'inbox.message',
        entityId: messageId,
        operatorId,
        branchId,
        requestId: ctx.requestId ?? null,
        before: { providerStatus: 'queued', attempt },
        after: {
          messageId,
          conversationId: claimed.conversationId,
          templateKey: row?.templateKey ?? null,
          length: [...(claimed.body ?? '')].length,
          mediaFileIds: claimed.mediaFileIds,
          outcome: outcome.outcome,
          refusal: result.ok ? null : result.refusal,
          attempt,
        },
      });
    },
  );

  await recordRun(db, {
    kind: 'adapter',
    name: 'adapter:inbox.send',
    outcome: result.ok ? 'ok' : 'failed',
    startedAt,
    requestId: ctx.requestId ?? null,
    operatorId,
    branchId,
    // Ids, the attempt and the refusal word. Never a body, never a phone.
    detail: {
      messageId,
      conversationId: claimed.conversationId,
      outcome: outcome.outcome,
      attempt,
      refusal: result.ok ? null : result.refusal,
      providerCode: result.ok ? null : result.providerCode,
    },
    ...(result.ok ? {} : { error: new Error(`inbox send ${result.refusal}`) }),
  });
  return outcome;
}

/** Whether the pause switch is on where this queued outbound message would leave from. */
async function pausedHere(db: Db, messageId: string, at: Date): Promise<boolean> {
  const [row] = await db
    .select({ operatorId: message.operatorId, branchId: conversation.branchId, accountBranchId: channelAccount.branchId })
    .from(message)
    .leftJoin(conversation, and(eq(conversation.operatorId, message.operatorId), eq(conversation.id, message.conversationId)))
    .leftJoin(channelAccount, and(eq(channelAccount.operatorId, message.operatorId), eq(channelAccount.id, message.channelAccountId)))
    .where(and(eq(message.id, messageId), eq(message.direction, 'outbound'), eq(message.providerStatus, 'queued')))
    .limit(1);
  if (!row) return false;
  return outboundMessagingPaused(db, { operatorId: row.operatorId, branchId: row.branchId ?? row.accountBranchId ?? null }, at);
}

/**
 * The contract's `media` content for a row's file: the inbox-owned
 * `file_object` of the row's operator, linked by a presigned GET minted now.
 * Every way it cannot be linked is a refusal value, never a throw.
 */
async function mediaContent(
  db: Db,
  storage: FileStorage | null,
  operatorId: string,
  fileIds: readonly string[],
  caption: string,
): Promise<OutboundContent | LocalResult> {
  if (fileIds.length !== 1) return local('MEDIA_UNAVAILABLE', false, 'one file per media message');
  // Configuration can come back (storage set on the deployment): retried.
  if (!storage) return local('MEDIA_UNAVAILABLE', true, 'no file storage');
  const [file] = await db
    .select({ objectKey: fileObject.objectKey, contentType: fileObject.contentType, owner: fileObject.ownerEntityType })
    .from(fileObject)
    .where(and(eq(fileObject.operatorId, operatorId), eq(fileObject.id, fileIds[0]!)))
    .limit(1);
  if (!file || !file.owner.startsWith('inbox.')) return local('MEDIA_UNAVAILABLE', false, 'no such inbox file');
  let link: string;
  try {
    link = await storage.presignedGet(file.objectKey, OUTBOUND_MEDIA_LINK_S);
  } catch {
    // Storage that cannot answer now may answer on the next attempt.
    return local('MEDIA_UNAVAILABLE', true, 'storage did not sign the link');
  }
  const mediaType = outboundMediaType(file.contentType);
  const filename = mediaType === 'document' ? filenameOf(file.objectKey) : undefined;
  return {
    kind: 'media',
    mediaType,
    link,
    // WhatsApp takes no caption on audio.
    ...(caption && mediaType !== 'audio' ? { caption } : {}),
    ...(filename ? { filename } : {}),
  };
}

/**
 * §A.3 in the send path: a queued AI line whose thread has a staff message
 * after it, and that is due (no live lease, so no provider call of it can be
 * in flight), becomes `withdrawn` — one conditional UPDATE, so two sweepers
 * cannot both withdraw it — with an `ai_withdrawn` event and an audit row,
 * ids and the reason word only. Answers whether this call withdrew it.
 */
async function withdrawOvertaken(
  db: Db,
  deps: SendDeps,
  messageId: string,
  at: Date,
  ctx: SendCtx,
): Promise<boolean> {
  return withTx(
    db,
    {
      requestId: ctx.requestId ?? undefined,
      actorAccountId: ctx.actorAccountId ?? null,
      ...(deps.log ? { log: deps.log } : {}),
    },
    'inbox.ai.message.withdraw',
    async (tx) => {
      const [row] = await tx
        .update(message)
        .set({ providerStatus: 'withdrawn', nextAttemptAt: null, updatedAt: at })
        .where(
          and(
            eq(message.id, messageId),
            eq(message.direction, 'outbound'),
            eq(message.authorKind, 'ai'),
            eq(message.providerStatus, 'queued'),
            or(isNull(message.nextAttemptAt), lte(message.nextAttemptAt, at)),
            STAFF_SPOKE_AFTER,
          ),
        )
        .returning({ operatorId: message.operatorId, conversationId: message.conversationId });
      if (!row) return false;
      await tx.insert(inboxEvent).values({
        id: newId(),
        operatorId: row.operatorId,
        conversationId: row.conversationId,
        kind: 'ai_withdrawn',
        actorKind: 'system',
        payload: { messageId, reason: AI_WITHDRAW_REASON },
        createdAt: at,
      });
      const [conv] = await tx
        .select({ branchId: conversation.branchId })
        .from(conversation)
        .where(and(eq(conversation.operatorId, row.operatorId), eq(conversation.id, row.conversationId)))
        .limit(1);
      await audit.record(tx, {
        actorAccountId: ctx.actorAccountId ?? null,
        action: 'inbox.ai.message.withdraw',
        entityType: 'inbox.message',
        entityId: messageId,
        operatorId: row.operatorId,
        branchId: conv?.branchId ?? null,
        requestId: ctx.requestId ?? null,
        before: { providerStatus: 'queued' },
        after: { messageId, conversationId: row.conversationId, reason: AI_WITHDRAW_REASON },
      });
      return true;
    },
  );
}

/**
 * Send several queued messages after the commit that queued them. A failure
 * to even reach the database is logged and left: the row is still queued and
 * the sweeper has it.
 */
export async function sendAfterCommit(
  db: Db,
  deps: SendDeps,
  messageIds: readonly string[],
  ctx: SendCtx = {},
): Promise<SendOutcome[]> {
  const out: SendOutcome[] = [];
  for (const id of messageIds) {
    try {
      out.push(await sendQueuedMessage(db, deps, id, ctx));
    } catch (err) {
      deps.log?.error({ err, messageId: id }, 'an inbox message could not be sent; the send job retries it');
      out.push({ messageId: id, outcome: 'skipped' });
    }
  }
  return out;
}

export interface SendSweep extends Record<string, unknown> {
  due: number;
  sent: number;
  retried: number;
  failed: number;
  withdrawn: number;
  skipped: number;
  /** SCRUM-643: due rows left queued because outbound messaging is paused where they would leave. */
  paused: number;
}

/**
 * `job:inbox.send` — THE SWEEPER. Every queued outbound message that is due —
 * never tried, its back-off over, or its lease run out — oldest first, at
 * most fifty a tick. A withdrawn row is never queued, so never taken; an AI
 * line a person overtook is withdrawn here rather than sent. Counts only in
 * the run's detail.
 */
export async function runInboxSendJob(db: Db, deps: SendDeps, now: Date): Promise<SendSweep> {
  const due = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.providerStatus, 'queued'),
        eq(message.direction, 'outbound'),
        isNull(message.redactedAt),
        or(isNull(message.nextAttemptAt), lte(message.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(sql`coalesce(${message.nextAttemptAt}, ${message.createdAt})`), asc(message.id))
    .limit(SWEEP_BATCH);
  const summary: SendSweep = { due: due.length, sent: 0, retried: 0, failed: 0, withdrawn: 0, skipped: 0, paused: 0 };
  const outcomes = await sendAfterCommit(db, { ...deps, now: deps.now ?? (() => new Date()) }, due.map((d) => d.id));
  for (const o of outcomes) {
    if (o.outcome === 'sent') summary.sent += 1;
    else if (o.outcome === 'retry') summary.retried += 1;
    else if (o.outcome === 'failed') summary.failed += 1;
    else if (o.outcome === 'withdrawn') summary.withdrawn += 1;
    else if (o.outcome === 'paused') summary.paused += 1;
    else summary.skipped += 1;
  }
  return summary;
}
