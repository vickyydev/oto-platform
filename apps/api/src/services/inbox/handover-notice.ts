import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  branch,
  handoverNotification,
  type BranchNoticeContact,
  type Db,
  type HandoverNoticeChannel,
  type HandoverNoticeKind,
  type InboxCategory,
} from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { audit } from '../audit';
import type { OtoAppDirectory } from '../otoapp-directory';
import type { SmsSender } from '../sms';
import { withTx, type Exec, type Tx } from '../tx';

/**
 * A HAND-OVER TELLS A PERSON (SCRUM-823; owner, 10 Nov 2026).
 *
 * Until now an assistant hand-over was a queue entry and an audit row: nobody
 * was told on a phone or in the app. Now a hand-over to Birthdays & Events —
 * the birthday advice question first among them — tells the birthday manager
 * on duty at the thread's park (every park's, when the thread has none):
 *
 *   1. QUEUED IN THE HAND-OVER'S OWN TRANSACTION (`queueHandoverNotices`, the
 *      engine's commit): one `inbox.handover_notification` row per channel —
 *      `app` for the OTO App's bell (the park's `birthday_manager_contact`
 *      names the app user) and `whatsapp` or `telegram` for the ping to the
 *      manager's phone. A park with nobody named gets one `skipped` row
 *      (`NO_CONTACT`), so the escalation below still runs.
 *   2. SENT AFTER THE COMMIT (`deliverHandoverNotices`, at the end of each
 *      `job:inbox.ai` tick and of each escalation sweep): the bell through the
 *      app's directory door (`POST /api/directory/notifications`, the row's id
 *      as the notification's, so a retry is a replay there), the ping through
 *      the notice sender (`buildNoticeSender`: on staging and production it
 *      LOGS a hashed recipient and the message's digest and sends nothing).
 *   3. ESCALATED ONCE (`runHandoverEscalationJob`, `job:inbox.handover_escalation`,
 *      every minute): a hand-over nobody has picked up fifteen minutes after
 *      it — no staff message, no assignment by a person, not handled by a
 *      person — gets ONE notice to the park's `gm_contact` (the playbook's GM
 *      route), app and phone, and its notices are stamped `escalated_at`. One
 *      that was picked up is stamped `picked_up_at` and never escalates.
 *
 * Nothing here holds a customer's words, name or number: the notice says a
 * family is waiting, at which park, since when, and why (advice asked); the
 * row's `target` is an app user id or a number masked to its last four digits.
 */

export const HANDOVER_ESCALATION_JOB = 'job:inbox.handover_escalation';
export const HANDOVER_ESCALATION_INTERVAL_S = 60;
/** Fifteen minutes with nobody on the thread, then the GM is told (the owner's number). */
export const HANDOVER_ESCALATION_AFTER_MS = 15 * 60_000;

/** The destinations whose hand-over tells a person. Birthdays & Events only, for now. */
export const NOTIFIED_DESTINATIONS: ReadonlySet<InboxCategory> = new Set<InboxCategory>(['birthdays']);

/** How many times a notice is tried before it is recorded failed. */
export const NOTICE_MAX_ATTEMPTS = 3;
/** A claimed notice whose sender died is taken again after this long. */
const NOTICE_LEASE_MS = 2 * 60_000;
const BATCH = 25;

export interface HandoverNoticeDeps {
  /** The OTO App's directory: the bell. A directory without `notify` (or unconfigured) records the bell failed. */
  directory: Pick<OtoAppDirectory, 'configured' | 'notify'>;
  /** The notice sender (`buildNoticeSender`): the ping. Logs, never sends, outside a real adapter. */
  sender: SmsSender;
  log?: FastifyBaseLogger;
}

type NoticeRow = typeof handoverNotification.$inferSelect;
type BranchRow = Pick<typeof branch.$inferSelect, 'id' | 'name' | 'timezone' | 'birthdayManagerContact' | 'gmContact'>;

/** A phone masked to its country prefix and last four digits: `+66******4321`. */
export function maskPhone(e164: string): string {
  if (e164.length <= 7) return '*'.repeat(e164.length);
  return `${e164.slice(0, 3)}${'*'.repeat(e164.length - 7)}${e164.slice(-4)}`;
}

/** A contact as the column holds it, read defensively: any field of the wrong shape reads as absent. */
export function contactOf(raw: unknown): BranchNoticeContact | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const phoneRaw = text(c.phone);
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  const contact: BranchNoticeContact = {
    name: text(c.name),
    appUserId: text(c.appUserId),
    phone,
    channel: c.channel === 'telegram' ? 'telegram' : 'whatsapp',
  };
  return contact.appUserId || contact.phone ? contact : null;
}

const contactFor = (b: BranchRow, kind: HandoverNoticeKind) => contactOf(kind === 'notice' ? b.birthdayManagerContact : b.gmContact);

/**
 * The parks whose contact a hand-over tells: the thread's park, or — with no
 * park on the thread — every live park of the operator, each person once.
 */
async function parksFor(exec: Exec, operatorId: string, branchId: string | null): Promise<BranchRow[]> {
  const cols = {
    id: branch.id,
    name: branch.name,
    timezone: branch.timezone,
    birthdayManagerContact: branch.birthdayManagerContact,
    gmContact: branch.gmContact,
  };
  if (branchId) {
    return exec.select(cols).from(branch).where(and(eq(branch.operatorId, operatorId), eq(branch.id, branchId))).limit(1);
  }
  return exec
    .select(cols)
    .from(branch)
    .where(and(eq(branch.operatorId, operatorId), isNull(branch.archivedAt)))
    .orderBy(asc(branch.createdAt));
}

interface NoticeTarget {
  branchId: string | null;
  channel: HandoverNoticeChannel;
  target: string | null;
  state: 'pending' | 'skipped';
  errorCode: string | null;
}

/** The rows one kind of notice makes for these parks: per park, its person's bell and phone; each person and number once. */
function targetsOf(parks: readonly BranchRow[], kind: HandoverNoticeKind, fallbackBranchId: string | null): NoticeTarget[] {
  const out: NoticeTarget[] = [];
  const seen = new Set<string>();
  for (const park of parks) {
    const c = contactFor(park, kind);
    if (!c) continue;
    if (c.appUserId && !seen.has(`app:${c.appUserId}`)) {
      seen.add(`app:${c.appUserId}`);
      out.push({ branchId: park.id, channel: 'app', target: c.appUserId, state: 'pending', errorCode: null });
    }
    if (c.phone && !seen.has(`phone:${c.phone}`)) {
      seen.add(`phone:${c.phone}`);
      out.push({ branchId: park.id, channel: c.channel, target: maskPhone(c.phone), state: 'pending', errorCode: null });
    }
  }
  // Nobody to tell: one row says so, and keeps the hand-over in the escalation sweep.
  if (out.length === 0) out.push({ branchId: parks.length === 1 ? parks[0]!.id : fallbackBranchId, channel: 'app', target: null, state: 'skipped', errorCode: 'NO_CONTACT' });
  return out;
}

export interface QueueHandoverInput {
  operatorId: string;
  conversationId: string;
  turnId: string;
  /** The thread's park once the hand-over's routing is done; null for none. */
  branchId: string | null;
  /** The category the thread ends in. */
  destination: InboxCategory;
  /** The intent that owned the hand-over. */
  intent: string | null;
  at: Date;
}

/**
 * The engine's hook, inside the hand-over's own transaction: the notices this
 * hand-over owes, written `pending` for the senders. Nothing for a destination
 * that tells nobody. A replayed commit writes nothing twice (the unique key on
 * turn, kind, channel and park). Answers how many rows it wrote.
 */
export async function queueHandoverNotices(tx: Tx, input: QueueHandoverInput): Promise<number> {
  if (!NOTIFIED_DESTINATIONS.has(input.destination)) return 0;
  const parks = await parksFor(tx, input.operatorId, input.branchId);
  const rows = targetsOf(parks, 'notice', input.branchId).map((t) => ({
    id: newId(),
    operatorId: input.operatorId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    branchId: t.branchId,
    destination: input.destination,
    intent: input.intent,
    kind: 'notice' as const,
    channel: t.channel,
    target: t.target,
    state: t.state,
    errorCode: t.errorCode,
    createdAt: input.at,
    updatedAt: input.at,
  }));
  const written = await tx.insert(handoverNotification).values(rows).onConflictDoNothing().returning({ id: handoverNotification.id });
  return written.length;
}

// --- Sending ---------------------------------------------------------------------------------

const clock = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

/** The words of a notice: who is waiting, where, since when, and why. Never the customer's words or name. */
export function noticeWords(
  row: Pick<NoticeRow, 'kind' | 'intent' | 'createdAt'>,
  park: { name: string; timezone: string } | null,
  handedAt: Date,
): { title: string; body: string; ping: string } {
  const where = park ? ` (${park.name})` : '';
  const when = clock(handedAt, park?.timezone ?? 'Asia/Bangkok');
  const why = row.intent === 'birthday_advice' ? ', advice asked' : '';
  if (row.kind === 'escalation') {
    return {
      title: 'Nobody has picked up a birthday conversation',
      body: `A Birthdays & Events conversation was handed to a person at ${when}${where}${why}, and nobody has taken it for 15 minutes. Please open it in the Inbox.`,
      ping: `OTO Inbox: a birthday family has waited 15 minutes for a person${where}, handed over at ${when}${why}. Please open the Inbox.`,
    };
  }
  return {
    title: 'Birthday family waiting in the Inbox',
    body: `A Birthdays & Events conversation was handed to a person at ${when}${where}${why}. Please open it in the Inbox.`,
    ping: `OTO Inbox: a birthday family is waiting for a person${where}, handed over at ${when}${why}. Please open the Inbox.`,
  };
}

/**
 * Claims what is due to send: `pending`, never tried or its lease run out,
 * oldest first. Each claim counts an attempt, so a sender that dies mid-call
 * leaves a row the next sweep takes again, at most `NOTICE_MAX_ATTEMPTS` times.
 */
async function claimDue(db: Db, now: Date): Promise<NoticeRow[]> {
  const leaseOver = new Date(now.getTime() - NOTICE_LEASE_MS);
  const claimed = await db.execute<{ id: string }>(sql`
    update ${handoverNotification} set attempts = attempts + 1, updated_at = ${now}
     where id in (
       select id from ${handoverNotification}
        where state = 'pending' and (attempts = 0 or updated_at <= ${leaseOver})
        order by created_at, id
        limit ${BATCH}
        for update skip locked)
    returning id`);
  const ids = claimed.rows.map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(handoverNotification).where(inArray(handoverNotification.id, ids)).orderBy(asc(handoverNotification.createdAt));
}

type SendResult = { state: 'sent' } | { state: 'skipped' | 'failed'; code: string } | { state: 'retry'; code: string };

async function sendOne(deps: HandoverNoticeDeps, row: NoticeRow, park: BranchRow | null, handedAt: Date): Promise<SendResult> {
  const contact = park ? contactFor(park, row.kind) : null;
  const words = noticeWords(row, park, handedAt);
  if (row.channel === 'app') {
    if (!contact?.appUserId) return { state: 'skipped', code: 'NO_CONTACT' };
    if (!deps.directory.configured || !deps.directory.notify) return { state: 'failed', code: 'OTOAPP_DIRECTORY_NOT_CONFIGURED' };
    const answer = await deps.directory.notify({
      id: row.id,
      recipientUserId: contact.appUserId,
      title: words.title,
      body: words.body,
      referenceType: 'inbox_conversation',
      referenceId: row.conversationId,
    });
    if (answer.ok) return { state: 'sent' };
    return answer.retryable ? { state: 'retry', code: answer.code } : { state: 'failed', code: answer.code };
  }
  if (!contact?.phone) return { state: 'skipped', code: 'NO_CONTACT' };
  try {
    await deps.sender.send(contact.phone, words.ping);
    return { state: 'sent' };
  } catch {
    return { state: 'retry', code: 'SEND_FAILED' };
  }
}

/** One word for the row: the app's own code, cut to the CHECK's shape. */
const codeWord = (code: string) => {
  const word = code.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^[^A-Z]+/, '');
  return (word || 'FAILED').slice(0, 48);
};

export interface DeliverySummary extends Record<string, number> {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  retrying: number;
}

/**
 * Sends every notice that is due, through the bell and the notice sender, and
 * records each outcome. Never throws for a recipient's or a channel's reasons:
 * the row says what happened. Counts only.
 */
export async function deliverHandoverNotices(db: Db, deps: HandoverNoticeDeps, now: Date): Promise<DeliverySummary> {
  const summary: DeliverySummary = { claimed: 0, sent: 0, skipped: 0, failed: 0, retrying: 0 };
  const rows = await claimDue(db, now);
  summary.claimed = rows.length;
  if (rows.length === 0) return summary;
  const parkIds = [...new Set(rows.flatMap((r) => (r.branchId ? [r.branchId] : [])))];
  const parks = new Map(
    (parkIds.length === 0
      ? []
      : await db
          .select({ id: branch.id, name: branch.name, timezone: branch.timezone, birthdayManagerContact: branch.birthdayManagerContact, gmContact: branch.gmContact })
          .from(branch)
          .where(inArray(branch.id, parkIds))
    ).map((b) => [b.id, b]),
  );
  // When the hand-over happened: its first notice, for an escalation as for a notice.
  const turnIds = [...new Set(rows.map((r) => r.turnId))];
  const handed = new Map(
    (
      await db
        .select({ turnId: handoverNotification.turnId, at: sql<Date>`min(${handoverNotification.createdAt})` })
        .from(handoverNotification)
        .where(and(inArray(handoverNotification.turnId, turnIds), eq(handoverNotification.kind, 'notice')))
        .groupBy(handoverNotification.turnId)
    ).map((r) => [r.turnId, new Date(r.at)]),
  );
  for (const row of rows) {
    const park = row.branchId ? (parks.get(row.branchId) ?? null) : null;
    let result: SendResult;
    try {
      result = await sendOne(deps, row, park, handed.get(row.turnId) ?? row.createdAt);
    } catch {
      result = { state: 'retry', code: 'SEND_FAILED' };
    }
    const contact = park ? contactFor(park, row.kind) : null;
    // The number the ping went to now, masked, if the park changed it since the hand-over.
    const target = row.channel !== 'app' && contact?.phone ? maskPhone(contact.phone) : row.target;
    const at = new Date();
    if (result.state === 'sent') {
      summary.sent += 1;
      await db
        .update(handoverNotification)
        .set({ state: 'sent', sentAt: at, errorCode: null, target, updatedAt: at })
        .where(and(eq(handoverNotification.id, row.id), eq(handoverNotification.state, 'pending')));
      continue;
    }
    const giveUp = result.state !== 'retry' || row.attempts >= NOTICE_MAX_ATTEMPTS;
    const state = result.state === 'skipped' ? 'skipped' : giveUp ? 'failed' : 'pending';
    if (state === 'skipped') summary.skipped += 1;
    else if (state === 'failed') summary.failed += 1;
    else summary.retrying += 1;
    await db
      .update(handoverNotification)
      .set({ state, errorCode: codeWord(result.code), target, updatedAt: at })
      .where(and(eq(handoverNotification.id, row.id), eq(handoverNotification.state, 'pending')));
    if (state === 'failed') {
      deps.log?.warn({ noticeId: row.id, channel: row.channel, code: codeWord(result.code) }, 'an inbox hand-over notice could not be sent');
    }
  }
  return summary;
}

// --- The escalation --------------------------------------------------------------------------

/**
 * When a person took the thread after the hand-over, or null: their first
 * reply, an assignment a person made, or the thread marked handled by a
 * person. The assistant's own lines and the router's seating do not count.
 */
export async function pickedUpAt(exec: Exec, operatorId: string, conversationId: string, since: Date): Promise<Date | null> {
  const [row] = (
    await exec.execute<{ picked: Date | string | null }>(sql`
      select least(
        (select min(m.created_at) from inbox.message m
          where m.operator_id = ${operatorId} and m.conversation_id = ${conversationId}
            and m.author_kind = 'staff' and m.created_at >= ${since}),
        (select min(a.assigned_at) from inbox.assignment a
          where a.operator_id = ${operatorId} and a.conversation_id = ${conversationId}
            and a.assigned_by_kind = 'account' and a.assigned_at >= ${since}),
        (select c.handled_at from inbox.conversation c
          where c.operator_id = ${operatorId} and c.id = ${conversationId}
            and c.status = 'handled' and c.handled_by_kind = 'account' and c.handled_at >= ${since})
      ) as picked`)
  ).rows;
  return row?.picked ? new Date(row.picked) : null;
}

export interface EscalationSweep extends Record<string, unknown> {
  delivered: DeliverySummary;
  checked: number;
  pickedUp: number;
  escalated: number;
  escalationsDelivered: DeliverySummary | null;
}

/**
 * `job:inbox.handover_escalation`: what is still to send goes; then every
 * hand-over fifteen minutes old that nobody has picked up is escalated to the
 * GM's contact ONCE, and one that was picked up is stamped and left. The
 * escalation is written under a lock on the hand-over's notices and only when
 * none is stamped yet, so two sweeps never escalate one hand-over twice.
 */
export async function runHandoverEscalationJob(db: Db, deps: HandoverNoticeDeps, now: Date): Promise<EscalationSweep> {
  const sweep: EscalationSweep = {
    delivered: await deliverHandoverNotices(db, deps, now),
    checked: 0,
    pickedUp: 0,
    escalated: 0,
    escalationsDelivered: null,
  };
  const due = new Date(now.getTime() - HANDOVER_ESCALATION_AFTER_MS);
  const open = await db
    .select({
      operatorId: handoverNotification.operatorId,
      turnId: handoverNotification.turnId,
      conversationId: handoverNotification.conversationId,
      handedAt: sql<Date>`min(${handoverNotification.createdAt})`,
    })
    .from(handoverNotification)
    .where(
      and(
        eq(handoverNotification.kind, 'notice'),
        isNull(handoverNotification.escalatedAt),
        isNull(handoverNotification.pickedUpAt),
        lte(handoverNotification.createdAt, due),
      ),
    )
    .groupBy(handoverNotification.operatorId, handoverNotification.turnId, handoverNotification.conversationId)
    .limit(BATCH);
  for (const h of open) {
    sweep.checked += 1;
    const handedAt = new Date(h.handedAt);
    const picked = await pickedUpAt(db, h.operatorId, h.conversationId, handedAt);
    if (picked) {
      sweep.pickedUp += 1;
      await db
        .update(handoverNotification)
        .set({ pickedUpAt: picked, updatedAt: now })
        .where(
          and(
            eq(handoverNotification.operatorId, h.operatorId),
            eq(handoverNotification.turnId, h.turnId),
            eq(handoverNotification.kind, 'notice'),
            isNull(handoverNotification.pickedUpAt),
          ),
        );
      continue;
    }
    if (await escalate(db, h.operatorId, h.turnId, now)) sweep.escalated += 1;
  }
  if (sweep.escalated > 0) sweep.escalationsDelivered = await deliverHandoverNotices(db, deps, now);
  return sweep;
}

/** One hand-over's escalation, once: the GM's notices queued and the hand-over's notices stamped. */
async function escalate(db: Db, operatorId: string, turnId: string, now: Date): Promise<boolean> {
  return withTx(db, { operatorId }, 'inbox.handover.escalate', async (tx) => {
    const notices = await tx
      .select()
      .from(handoverNotification)
      .where(and(eq(handoverNotification.operatorId, operatorId), eq(handoverNotification.turnId, turnId), eq(handoverNotification.kind, 'notice')))
      .orderBy(asc(handoverNotification.createdAt))
      .for('update');
    const first = notices[0];
    if (!first || notices.some((n) => n.escalatedAt !== null || n.pickedUpAt !== null)) return false;
    const parkIds = [...new Set(notices.flatMap((n) => (n.branchId ? [n.branchId] : [])))];
    const parks = parkIds.length === 1 ? await parksFor(tx, operatorId, parkIds[0]!) : await parksFor(tx, operatorId, null);
    const scoped = parkIds.length > 1 ? parks.filter((p) => parkIds.includes(p.id)) : parks;
    const rows = targetsOf(scoped, 'escalation', first.branchId).map((t) => ({
      id: newId(),
      operatorId,
      conversationId: first.conversationId,
      turnId,
      branchId: t.branchId,
      destination: first.destination,
      intent: first.intent,
      kind: 'escalation' as const,
      channel: t.channel,
      target: t.target,
      state: t.state,
      errorCode: t.errorCode,
      createdAt: now,
      updatedAt: now,
    }));
    const written = await tx.insert(handoverNotification).values(rows).onConflictDoNothing().returning({ id: handoverNotification.id });
    await tx
      .update(handoverNotification)
      .set({ escalatedAt: now, updatedAt: now })
      .where(and(eq(handoverNotification.operatorId, operatorId), eq(handoverNotification.turnId, turnId), eq(handoverNotification.kind, 'notice')));
    await audit.record(tx, {
      actorAccountId: null,
      action: 'inbox.handover.escalate',
      entityType: 'inbox.conversation',
      entityId: first.conversationId,
      operatorId,
      branchId: first.branchId,
      requestId: null,
      before: { turnId, notified: notices.map((n) => ({ channel: n.channel, state: n.state })) },
      after: {
        turnId,
        escalatedAt: now.toISOString(),
        escalations: rows.map((r) => ({ channel: r.channel, state: r.state, branchId: r.branchId })),
        written: written.length,
      },
    });
    return true;
  });
}

// --- The thread's pill -----------------------------------------------------------------------

export interface HandoverNoticeView {
  turnId: string;
  destination: InboxCategory;
  /** When the first notice went (the bell or the ping); null when none did. */
  notifiedAt: string | null;
  /** Nobody to tell, or every notice failed. */
  notNotified: boolean;
  escalatedAt: string | null;
  pickedUpAt: string | null;
}

/** The thread's hand-over notices as its pills read them: one entry per hand-over, oldest first. */
export async function handoverNoticesOf(exec: Exec, operatorId: string, conversationId: string): Promise<HandoverNoticeView[]> {
  const rows = await exec
    .select()
    .from(handoverNotification)
    .where(and(eq(handoverNotification.operatorId, operatorId), eq(handoverNotification.conversationId, conversationId)))
    .orderBy(asc(handoverNotification.createdAt), asc(handoverNotification.id));
  const byTurn = new Map<string, NoticeRow[]>();
  for (const r of rows) byTurn.set(r.turnId, [...(byTurn.get(r.turnId) ?? []), r]);
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const earliest = (ds: (Date | null)[]) => ds.filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return [...byTurn.entries()].map(([turnId, set]) => {
    const notices = set.filter((r) => r.kind === 'notice');
    const sent = earliest(notices.filter((r) => r.state === 'sent').map((r) => r.sentAt));
    return {
      turnId,
      destination: set[0]!.destination,
      notifiedAt: iso(sent),
      notNotified: sent === null && notices.every((r) => r.state === 'skipped' || r.state === 'failed'),
      escalatedAt: iso(earliest(notices.map((r) => r.escalatedAt))),
      pickedUpAt: iso(earliest(notices.map((r) => r.pickedUpAt))),
    };
  });
}
