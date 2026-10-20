import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  assignment,
  channelAccount,
  contact,
  conversation,
  inboxEvent,
  message,
  participant,
  type Db,
} from '@oto/db';
import {
  seedInboxDemo,
  type DemoContext,
  type DemoConversation,
  type DemoDelivered,
  type DemoDelivery,
  type InboxDemoCounts,
} from '@oto/db/seed';
import type { DeliveryStatus, SimulatorChannel } from '@oto/messaging';
import { newId } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { errors } from '../../lib/errors';
import { audit } from '../audit';
import type { InboxChannels } from './channels';
import type { InboxAiSchedule } from './ai-runtime';
import { channelRow, ingestDelivery, type IngestResult } from './ingest';

/**
 * THE SIMULATOR'S DRIVE (S2-19 I2d, SCRUM-583; plan §2.1, §3.3).
 *
 * The `/inbox/simulator/*` routes, and the demo, play pretend customers
 * through the REAL ingest: the simulator signs a WhatsApp-shaped delivery
 * with `INBOX_SIMULATOR_SECRET`, and `ingestDelivery` verifies, records,
 * dedupes, files and routes it exactly as it would Meta's. Nothing here
 * writes a message or a thread on its own — except the demo's staff side,
 * which stands for replies people already sent (see `simulatorDemoDelivery`).
 *
 * The secret never reaches a browser: a press names an account and some
 * words, and this process signs.
 */

export interface SimulatorDeps {
  db: Db;
  channels: InboxChannels;
  log?: FastifyBaseLogger;
  now?: () => Date;
  /** The assistant's switch and debounce: a played message schedules a turn as a real one does (SCRUM-590). */
  ai?: InboxAiSchedule;
}

export interface DriveCtx {
  operatorId: string;
  actorAccountId: string | null;
  requestId: string | null;
}

type AccountRow = typeof channelAccount.$inferSelect;

/**
 * The simulator account a press names, inside the caller's operator. Another
 * operator's account, or one that is not a simulator, is a 404 — its
 * existence is not the caller's business.
 */
export async function simulatorAccount(
  deps: SimulatorDeps,
  operatorId: string,
  channelAccountId: string,
): Promise<{ account: AccountRow; sim: SimulatorChannel }> {
  if (!deps.channels.simulatorEnabled) {
    throw errors.conflict('CHANNEL_NOT_CONNECTED', 'The inbox simulator is off on this deployment.');
  }
  const [account] = await deps.db
    .select()
    .from(channelAccount)
    .where(
      and(
        eq(channelAccount.id, channelAccountId),
        eq(channelAccount.operatorId, operatorId),
        eq(channelAccount.provider, 'simulator'),
        isNull(channelAccount.archivedAt),
      ),
    )
    .limit(1);
  if (!account) throw errors.notFound('No such simulator channel account');
  const sim = deps.channels.simulatorFor(channelRow(account));
  if (!sim) throw errors.conflict('CHANNEL_NOT_CONNECTED', 'The inbox simulator is off on this deployment.');
  return { account, sim };
}

export interface SimulatedPress {
  /** The pretend sender: digits, country code first (a WhatsApp id). */
  from: string;
  name?: string;
  text: string;
  hint?: { category?: 'birthdays' | 'general' | 'marketing'; intent?: string; language?: string; branchId?: string };
}

export async function simulateInbound(
  deps: SimulatorDeps,
  ctx: DriveCtx,
  channelAccountId: string,
  press: SimulatedPress,
): Promise<{ externalMessageId: string; result: IngestResult }> {
  const { account, sim } = await simulatorAccount(deps, ctx.operatorId, channelAccountId);
  const played = sim.inbound({
    from: press.from,
    ...(press.name ? { name: press.name } : {}),
    text: press.text,
    ...(press.hint ? { hint: press.hint } : {}),
  });
  const result = await ingestDelivery(
    deps.db,
    {
      channels: deps.channels,
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.ai ? { ai: deps.ai } : {}),
    },
    { channelAccountId: account.id, webhook: played.webhook, requestId: ctx.requestId, actorAccountId: ctx.actorAccountId },
  );
  return { externalMessageId: played.externalMessageId, result };
}

/**
 * Push receipts through the webhook: one named status for one outbound
 * message, or (with none named) every delivered/read receipt the
 * simulator's accepted sends scheduled.
 */
export async function simulateStatus(
  deps: SimulatorDeps,
  ctx: DriveCtx,
  channelAccountId: string,
  named: { externalMessageId: string; status: DeliveryStatus } | null,
): Promise<IngestResult[]> {
  const { account, sim } = await simulatorAccount(deps, ctx.operatorId, channelAccountId);
  const webhooks = named ? [sim.statusWebhook(named.externalMessageId, named.status)] : sim.takeScheduled();
  const results: IngestResult[] = [];
  for (const webhook of webhooks) {
    results.push(
      await ingestDelivery(
        deps.db,
        { channels: deps.channels, ...(deps.log ? { log: deps.log } : {}), ...(deps.now ? { now: deps.now } : {}) },
        { channelAccountId: account.id, webhook, requestId: ctx.requestId, actorAccountId: ctx.actorAccountId },
      ),
    );
  }
  return results;
}

/** The demo set, played into the caller's operator. */
export async function playDemoScenario(deps: SimulatorDeps, ctx: DriveCtx): Promise<InboxDemoCounts> {
  if (!deps.channels.simulatorEnabled) {
    throw errors.conflict('CHANNEL_NOT_CONNECTED', 'The inbox simulator is off on this deployment.');
  }
  return seedInboxDemo(deps.db, {
    operatorId: ctx.operatorId,
    deliver: simulatorDemoDelivery(deps.channels, { actorAccountId: ctx.actorAccountId, requestId: ctx.requestId, log: deps.log }),
    ...(deps.now ? { now: deps.now() } : {}),
  });
}

/**
 * The simulator's sender id for a demo handle: the phone's digits on
 * WhatsApp, and for a scoped handle (Instagram, Facebook) a stable 15-digit
 * id derived from it — which is what such ids look like on the wire.
 */
export function simulatedSender(handle: string): string {
  const digits = handle.replace(/^\+/, '');
  if (/^\d{6,15}$/.test(digits)) return digits;
  const hex = createHash('sha256').update(handle).digest('hex');
  return `9${BigInt(`0x${hex.slice(0, 15)}`).toString().padStart(14, '0').slice(-14)}`;
}

const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);

/**
 * ONE DEMO CONVERSATION, PLAYED (`seedInboxDemo`'s `deliver`).
 *
 *  - Its customer lines go through the simulator and the ingest, one signed
 *    delivery each, at the time the fixture says — so the contact, the
 *    thread, the routing (default primary plus the backup as support), and
 *    every receipt are the real path's.
 *  - Its staff and AI lines are history: replies already sent before the
 *    demo starts. They are laid into the thread as sent-and-read outbound
 *    messages, in order between the customer lines, because there is no
 *    "send something last Tuesday" in a real channel.
 *  - A support person the fixture names beyond the rule's backup is added by
 *    the demo GM (`manual`); a fixture marked handled is handled by its
 *    person at the end.
 *
 * Present means delivered: a thread that already exists for the contact on
 * that account is left exactly as it is — a second run plays nothing.
 */
export function simulatorDemoDelivery(
  channels: InboxChannels,
  opts: { actorAccountId?: string | null; requestId?: string | null; log?: FastifyBaseLogger } = {},
): DemoDelivery {
  return async (tx, ctx: DemoContext, conv: DemoConversation, now: Date): Promise<DemoDelivered> => {
    const nothing: DemoDelivered = { created: false, messages: 0, assignments: 0, events: 0 };
    const accountId = ctx.channelAccounts[conv.account].id;
    const [account] = await tx.select().from(channelAccount).where(eq(channelAccount.id, accountId)).limit(1);
    if (!account) throw new Error(`the demo channel account ${conv.account} is missing`);
    const sim = channels.simulatorFor(channelRow(account));
    if (!sim) throw new Error('the inbox simulator is off — set INBOX_SIMULATOR=on and INBOX_SIMULATOR_SECRET');

    const from = simulatedSender(conv.contact.handle);
    const handle = account.channel === 'whatsapp' ? `+${from}` : from;
    const [existing] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .innerJoin(contact, and(eq(contact.operatorId, conversation.operatorId), eq(contact.id, conversation.contactId)))
      .where(
        and(
          eq(conversation.operatorId, ctx.operatorId),
          eq(conversation.channelAccountId, account.id),
          eq(contact.channel, account.channel),
          eq(contact.externalHandle, handle),
        ),
      )
      .limit(1);
    if (existing) return nothing;

    const branchId = conv.hint.branch ? (ctx.branches[conv.hint.branch] ?? undefined) : undefined;
    const at = conv.messages.map((m) => minutesBefore(now, m.minutesAgo));
    let conversationId: string | null = null;
    const messageIds: string[] = [];
    let firstStaffAt: Date | null = null;

    for (const [i, m] of conv.messages.entries()) {
      if (m.from === 'customer') {
        const played = sim.inbound({
          from,
          name: conv.contact.displayName,
          text: m.text,
          hint: {
            category: conv.hint.category,
            intent: conv.hint.intent,
            language: conv.hint.language,
            ...(branchId ? { branchId } : {}),
          },
          at: at[i]!,
        });
        const result = await ingestDelivery(
          tx,
          { channels, dispatch: false, now: () => now, ...(opts.log ? { log: opts.log } : {}) },
          {
            channelAccountId: account.id,
            webhook: played.webhook,
            requestId: opts.requestId ?? null,
            actorAccountId: opts.actorAccountId ?? null,
          },
        );
        if (result.outcome !== 'processed' || result.messages !== 1) {
          throw new Error(`the demo line ${conv.key}#${i} was not ingested (${result.outcome})`);
        }
        conversationId = result.conversationIds[0]!;
        const [row] = await tx
          .select({ id: message.id })
          .from(message)
          .where(and(eq(message.channelAccountId, account.id), eq(message.externalMessageId, played.externalMessageId)))
          .limit(1);
        messageIds.push(row!.id);
        continue;
      }
      if (!conversationId) throw new Error(`the demo conversation ${conv.key} must open with the customer`);
      // History: a reply already sent and read.
      const id = newId();
      messageIds.push(id);
      await tx.insert(message).values({
        id,
        operatorId: ctx.operatorId,
        conversationId,
        channelAccountId: account.id,
        direction: 'outbound',
        authorKind: m.from === 'ai' ? 'ai' : 'staff',
        authorAccountId: m.from === 'staff' ? ctx.staff[m.staff!] : null,
        body: m.text,
        bodyLanguage: conv.hint.language,
        externalMessageId: `${conv.key}:out:${i}`,
        providerStatus: 'read',
        sentAt: at[i]!,
        deliveredAt: at[i]!,
        readAt: new Date(at[i]!.getTime() + 60_000),
        source: 'channel',
        createdAt: at[i]!,
      });
      const iso = at[i]!.toISOString();
      if (m.from === 'staff' && !firstStaffAt) firstStaffAt = at[i]!;
      await tx
        .update(conversation)
        .set({
          lastMessageAt: sql`greatest(${conversation.lastMessageAt}, ${iso}::timestamptz)`,
          lastMessagePreview: m.text.slice(0, 140),
          // AI lines are not an answer (`WhatsAppDemo.tsx` isUnanswered): only staff count.
          ...(m.from === 'staff'
            ? {
                lastStaffMessageAt: sql`greatest(${conversation.lastStaffMessageAt}, ${iso}::timestamptz)`,
                firstResponseAt: sql`coalesce(${conversation.firstResponseAt}, ${iso}::timestamptz)`,
              }
            : {}),
        })
        .where(and(eq(conversation.operatorId, ctx.operatorId), eq(conversation.id, conversationId)));
    }
    if (!conversationId) throw new Error(`the demo conversation ${conv.key} has no customer line`);
    const startedAt = at[0]!;
    const lastAt = at[at.length - 1]!;

    // Support the fixture names beyond what routing added: the demo GM added them.
    const active = await tx
      .select({ accountId: assignment.accountId, slotIndex: assignment.slotIndex })
      .from(assignment)
      .where(and(eq(assignment.conversationId, conversationId), isNull(assignment.releasedAt)));
    const held = new Set(active.map((a) => a.accountId));
    const taken = new Set(active.map((a) => a.slotIndex));
    let added = 0;
    for (const key of conv.support) {
      const accountIdOf = ctx.staff[key];
      if (held.has(accountIdOf)) continue;
      const slotIndex = [1, 2].find((n) => !taken.has(n));
      if (slotIndex === undefined) break;
      taken.add(slotIndex);
      const assignmentId = newId();
      const addedAt = new Date(startedAt.getTime() + 10 * 60_000);
      await tx.insert(assignment).values({
        id: assignmentId,
        operatorId: ctx.operatorId,
        conversationId,
        slot: 'support',
        slotIndex,
        assigneeKind: 'account',
        accountId: accountIdOf,
        assignedByKind: 'account',
        assignedByAccountId: ctx.staff.gm,
        reason: 'manual',
        assignedAt: addedAt,
      });
      await tx.insert(inboxEvent).values({
        id: newId(),
        operatorId: ctx.operatorId,
        conversationId,
        kind: 'assigned',
        actorKind: 'account',
        actorAccountId: ctx.staff.gm,
        payload: { assignmentId, slot: 'support', assigneeKind: 'account', accountId: accountIdOf, reason: 'manual' },
        createdAt: addedAt,
      });
      added += 1;
    }
    if (conv.handledBy !== undefined) {
      const handledAt = new Date(lastAt.getTime() + 5 * 60_000);
      const by = ctx.staff[conv.handledBy];
      await tx
        .update(conversation)
        .set({ status: 'handled', handledAt, handledByKind: 'account', handledByAccountId: by })
        .where(and(eq(conversation.operatorId, ctx.operatorId), eq(conversation.id, conversationId)));
      await tx.insert(inboxEvent).values({
        id: newId(),
        operatorId: ctx.operatorId,
        conversationId,
        kind: 'handled',
        actorKind: 'account',
        actorAccountId: by,
        payload: {},
        createdAt: handledAt,
      });
    }

    // The staff who wrote have read the thread up to their own last line.
    const readers = new Map<string, { messageId: string; at: Date }>();
    conv.messages.forEach((m, i) => {
      if (m.from === 'staff') readers.set(ctx.staff[m.staff!], { messageId: messageIds[i]!, at: at[i]! });
    });
    if (readers.size > 0) {
      await tx.insert(participant).values(
        [...readers].map(([readerId, r]) => ({
          id: newId(),
          operatorId: ctx.operatorId,
          conversationId: conversationId!,
          accountId: readerId,
          firstSeenAt: startedAt,
          lastReadMessageId: r.messageId,
          lastReadAt: r.at,
        })),
      );
    }

    const [owners] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(assignment)
      .where(and(eq(assignment.conversationId, conversationId), isNull(assignment.releasedAt)));
    const [pills] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(inboxEvent)
      .where(eq(inboxEvent.conversationId, conversationId));
    await audit.record(tx, {
      actorAccountId: opts.actorAccountId ?? null,
      action: 'inbox.demo.play',
      entityType: 'inbox.conversation',
      entityId: conversationId,
      operatorId: ctx.operatorId,
      branchId: account.branchId,
      requestId: opts.requestId ?? null,
      after: {
        fixture: conv.key,
        channelAccountId: account.id,
        messages: conv.messages.length,
        supportAddedByHand: added,
        handled: conv.handledBy !== undefined,
      },
    });
    return { created: true, messages: conv.messages.length, assignments: owners!.n, events: pills!.n };
  };
}

