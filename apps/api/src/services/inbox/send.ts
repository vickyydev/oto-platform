import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { channelAccount, contact, conversation, inboxEvent, message, template, type Db } from '@oto/db';
import { insideFreeTextWindow, type OutboundContent, type SendResult } from '@oto/messaging';
import { newId, templateParameters } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { audit } from '../audit';
import { recordRun } from '../ops';
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

/** The wait after the n-th failed attempt: 30 s, 1 min, 2 min, … at most 30 min. */
export function sendBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

export interface SendDeps {
  channels: InboxChannels;
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
  /** Not queued, not due, or claimed by another sender. Nothing was sent. */
  | { messageId: string; outcome: 'skipped' };

/** Refusal words the api adds to the channel's five, for a send it never handed to a channel. */
type LocalRefusal = 'CHANNEL_NOT_CONNECTED' | 'CHANNEL_CANNOT_REPLY' | 'CONTACT_ERASED';

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
      ),
    )
    .returning();
  if (!claimed) return { messageId, outcome: 'skipped' };
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

  let result: SendResult | { ok: false; refusal: LocalRefusal; retryable: boolean; providerCode: null; detail: string };
  if (!row) {
    result = { ok: false, refusal: 'CHANNEL_NOT_CONNECTED', retryable: false, providerCode: null, detail: 'no channel account' };
  } else if (row.erasedAt) {
    result = { ok: false, refusal: 'CONTACT_ERASED', retryable: false, providerCode: null, detail: 'the contact was erased' };
  } else if (row.account.archivedAt || !row.account.canReply) {
    result = { ok: false, refusal: 'CHANNEL_CANNOT_REPLY', retryable: false, providerCode: null, detail: 'the account cannot reply' };
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
      result = { ok: false, refusal: 'CHANNEL_CANNOT_REPLY', retryable: false, providerCode: null, detail: 'send-only channel' };
    } else {
      const body = claimed.body ?? '';
      const windowHours = found.channel.capabilities.freeTextWindowHours;
      const inWindow =
        windowHours === null || insideFreeTextWindow(row.conversation.lastCustomerMessageAt, at, windowHours);
      let content: OutboundContent;
      if (claimed.templateId && row.templateKey !== null) {
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
          .where(stillQueued);
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
  skipped: number;
}

/**
 * `job:inbox.send` — THE SWEEPER. Every queued outbound message that is due —
 * never tried, its back-off over, or its lease run out — oldest first, at
 * most fifty a tick. Counts only in the run's detail.
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
  const summary: SendSweep = { due: due.length, sent: 0, retried: 0, failed: 0, skipped: 0 };
  const outcomes = await sendAfterCommit(db, { ...deps, now: deps.now ?? (() => new Date()) }, due.map((d) => d.id));
  for (const o of outcomes) {
    if (o.outcome === 'sent') summary.sent += 1;
    else if (o.outcome === 'retry') summary.retried += 1;
    else if (o.outcome === 'failed') summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}
