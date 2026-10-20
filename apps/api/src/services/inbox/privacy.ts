import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Db } from '@oto/db';
import { INBOX_ERASED_CONTACT_NAME, type InboxEraseContact, type InboxErasureCounts } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit';
import type { FileStorage } from '../files';
import { withTx, type Exec, type Tx } from '../tx';
import { cancelAiForThread } from './ai-turns';

/**
 * THE INBOX'S PDPA PATHS (S2-19 I2g, SCRUM-586; plan
 * `docs/progress/plans/inbox-build/PLAN.md` §3.6, `docs/features/inbox.md`
 * "PDPA").
 *
 * ERASURE anonymises a contact IN PLACE, in one transaction, irreversibly:
 *
 *   - THE PERSON. The named contact and every other live contact of the same
 *     operator with the same E.164 phone (the same person on another channel
 *     — a LINE notice beside a WhatsApp thread). Each: name "Erased contact",
 *     handle `erased:<sha256 of the contact id>` (derived from nothing the
 *     person gave, so it cannot be reversed and never matches a new message),
 *     phone, member link and avatar null, `erased_at` / `erased_by` stamped.
 *   - EVERY MESSAGE in every thread of theirs, whoever wrote it — the
 *     customer's lines, staff replies, the out-of-hours reply and the
 *     MIRRORED check-in and booking notices (`source` `checkin.contact` /
 *     `booking.confirmation`, I2c), which hold the guardian's name and the
 *     children's: body, translation and transcript null, media and voice note
 *     unlinked, `redacted_at` stamped. The row, its direction, its times and
 *     its delivery state stay.
 *   - THE THREADS: the preview, the AI summary and the member link cleared.
 *     Status, team, branch, assignments, intent and the times stay, so the
 *     dashboard's counts still add up and the audit trail still reads.
 *   - THE FILES: an inbox-owned file (`owner_entity_type` `inbox.message` or
 *     `inbox.contact`) is deleted from storage and its `file_object` row
 *     removed; a file the message only pointed at (a template's brochure) is
 *     unlinked and left to its owner.
 *   - THE TIMELINE: an event payload never holds a body, but any key that
 *     could carry words or a name (`REDACTED_KEYS`) is nulled, through the
 *     I1 trigger's one door for this (`oto.inbox_erasure = on`), which lets
 *     `payload` change and nothing else on the row.
 *   - THE RAW DELIVERIES: every `webhook_receipt` on the threads' channel
 *     accounts whose payload names one of the person's handles, their phone's
 *     digits or one of their messages' provider ids has its payload nulled and
 *     `payload_purged_at` stamped. Over-reaching here costs nothing (the
 *     payload is a duplicate); missing one would keep the words.
 *   - THE ASSISTANT (SCRUM-590): every pending or deciding turn on the threads
 *     is cancelled and every unsent AI line withdrawn before the words go.
 *   - ONE AUDIT ROW, `inbox.contact.erase`: ids and counts, nothing erased.
 *
 * Re-erasing finds nothing left to remove, says so (`alreadyErased`), and
 * still writes its audit row.
 *
 * RETENTION is the same removal driven by dates instead of a request, and is
 * OFF: each purge refuses (`state: 'refused'`, naming its variable) until its
 * period is set (owner Q19). The conversation purge reaches a HANDLED thread
 * whose `retain_until` has passed, removes its words and media as above and
 * deletes its timeline events through the trigger's purge door
 * (`oto.inbox_purge = on`); the thread row, its owners and its contact stay.
 *
 * Nothing here logs, audits or records a body, a name, a phone or a handle.
 */

// --- Shared pieces ---------------------------------------------------------------

/**
 * The keys an event payload may never keep through an erasure or a purge.
 * Today no writer puts any of them there (the sentinel check holds that);
 * this is the net for the one that one day does.
 */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'body',
  'text',
  'caption',
  'preview',
  'lastMessagePreview',
  'transcript',
  'translatedBody',
  'summary',
  'displayName',
  'name',
  'contactName',
  'guardianName',
  'childName',
  'phone',
  'handle',
  'externalHandle',
  'from',
  'to',
  'email',
]);

/** A payload with every `REDACTED_KEYS` value nulled, at any depth. */
export function redactPayload(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = redactPayload(v);
      changed ||= r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k) && v !== null) {
        out[k] = null;
        changed = true;
      } else {
        const r = redactPayload(v);
        changed ||= r.changed;
        out[k] = r.value;
      }
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/** The erased handle: from the contact's own id, so nothing the person gave survives in it. */
export function erasedHandleOf(contactId: string): string {
  return `erased:${createHash('sha256').update(contactId).digest('hex')}`;
}

/** The text needles a raw delivery is searched for; short ones would match anything. */
function needlesOf(values: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) if (v && v.length >= 6) out.add(v);
  return [...out];
}

function textArray(values: string[]): SQL {
  return sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

const STORAGE_REFUSED = () =>
  new AppError(503, 'STORAGE_UNAVAILABLE', 'File storage is unavailable — the files could not be removed; nothing was erased');

interface FileOutcome {
  filesDeleted: number;
  filesUnlinked: number;
}

/**
 * Inbox-owned files among `fileIds` deleted (storage object, then row); any
 * other file only counted as unlinked — the caller has already dropped the
 * pointer. The objects go inside the caller's transaction: a storage failure
 * rolls the erasure back whole, and a removal repeated on a retry succeeds.
 */
async function dropFiles(
  tx: Tx,
  storage: FileStorage | null,
  operatorId: string,
  fileIds: string[],
  owners: { messageIds: string[]; contactIds: string[] },
): Promise<FileOutcome> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) return { filesDeleted: 0, filesUnlinked: 0 };
  const rows = await tx
    .select({
      id: s.fileObject.id,
      objectKey: s.fileObject.objectKey,
      ownerEntityType: s.fileObject.ownerEntityType,
      ownerEntityId: s.fileObject.ownerEntityId,
    })
    .from(s.fileObject)
    .where(and(eq(s.fileObject.operatorId, operatorId), inArray(s.fileObject.id, ids)));
  const messageOwners = new Set(owners.messageIds);
  const contactOwners = new Set(owners.contactIds);
  const owned = rows.filter(
    (r) =>
      (r.ownerEntityType === 'inbox.message' && messageOwners.has(r.ownerEntityId)) ||
      (r.ownerEntityType === 'inbox.contact' && contactOwners.has(r.ownerEntityId)),
  );
  if (owned.length > 0) {
    if (!storage) throw STORAGE_REFUSED();
    await tx.delete(s.fileObject).where(inArray(s.fileObject.id, owned.map((r) => r.id)));
    for (const r of owned) {
      try {
        await storage.remove(r.objectKey);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw STORAGE_REFUSED();
      }
    }
  }
  return { filesDeleted: owned.length, filesUnlinked: ids.length - owned.length };
}

interface RedactOutcome extends FileOutcome {
  messages: number;
  noticeMessages: number;
  messageIds: string[];
}

/**
 * Remove the words and the media of every message in these threads, in
 * place. Counts only the rows that still held something.
 */
async function redactThreadMessages(
  tx: Tx,
  storage: FileStorage | null,
  operatorId: string,
  conversationIds: string[],
  contactIds: string[],
  now: Date,
): Promise<RedactOutcome> {
  if (conversationIds.length === 0) {
    return { messages: 0, noticeMessages: 0, filesDeleted: 0, filesUnlinked: 0, messageIds: [] };
  }
  const holding = or(
    isNull(s.message.redactedAt),
    isNotNull(s.message.body),
    isNotNull(s.message.translatedBody),
    isNotNull(s.message.transcript),
    isNotNull(s.message.audioFileId),
    sql`cardinality(${s.message.mediaFileIds}) > 0`,
  );
  const rows = await tx
    .select({
      id: s.message.id,
      source: s.message.source,
      mediaFileIds: s.message.mediaFileIds,
      audioFileId: s.message.audioFileId,
    })
    .from(s.message)
    .where(and(eq(s.message.operatorId, operatorId), inArray(s.message.conversationId, conversationIds), holding))
    .for('update');
  if (rows.length === 0) return { messages: 0, noticeMessages: 0, filesDeleted: 0, filesUnlinked: 0, messageIds: [] };
  const ids = rows.map((r) => r.id);
  await tx
    .update(s.message)
    .set({
      body: null,
      translatedBody: null,
      transcript: null,
      mediaFileIds: sql`'{}'::uuid[]`,
      audioFileId: null,
      redactedAt: sql`coalesce(${s.message.redactedAt}, ${now.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(and(eq(s.message.operatorId, operatorId), inArray(s.message.id, ids)));
  const files = await dropFiles(
    tx,
    storage,
    operatorId,
    rows.flatMap((r) => [...r.mediaFileIds, ...(r.audioFileId ? [r.audioFileId] : [])]),
    { messageIds: ids, contactIds },
  );
  return {
    messages: rows.length,
    noticeMessages: rows.filter((r) => r.source !== 'channel').length,
    messageIds: ids,
    ...files,
  };
}

// --- Erasure ---------------------------------------------------------------------------

interface Subject {
  /** The named contact first. */
  contacts: (typeof s.contact.$inferSelect)[];
  conversations: { id: string; channelAccountId: string }[];
}

/** The person behind a contact, inside one operator: 404 when the id is not the operator's. */
async function subjectOf(db: Exec, operatorId: string, contactId: string, lock: boolean): Promise<Subject> {
  const base = db
    .select()
    .from(s.contact)
    .where(and(eq(s.contact.operatorId, operatorId), eq(s.contact.id, contactId)))
    .limit(1);
  const [named] = lock ? await base.for('update') : await base;
  if (!named) throw errors.notFound('Contact not found');
  let contacts = [named];
  if (named.phone) {
    const samePhone = db
      .select()
      .from(s.contact)
      .where(
        and(
          eq(s.contact.operatorId, operatorId),
          eq(s.contact.phone, named.phone),
          isNull(s.contact.erasedAt),
          sql`${s.contact.id} <> ${named.id}`,
        ),
      )
      .orderBy(s.contact.createdAt);
    contacts = [named, ...(lock ? await samePhone.for('update') : await samePhone)];
  }
  const conversations = await db
    .select({ id: s.conversation.id, channelAccountId: s.conversation.channelAccountId })
    .from(s.conversation)
    .where(and(eq(s.conversation.operatorId, operatorId), inArray(s.conversation.contactId, contacts.map((c) => c.id))))
    .orderBy(s.conversation.createdAt);
  return { contacts, conversations };
}

/**
 * What an erasure of this contact WOULD remove — the 409's answer to an
 * unconfirmed call, so the second confirmation is made knowing the reach.
 * Counts only.
 */
export async function previewErasure(db: Db, operatorId: string, contactId: string): Promise<InboxErasureCounts> {
  const subject = await subjectOf(db, operatorId, contactId, false);
  const convIds = subject.conversations.map((c) => c.id);
  let messages = 0;
  let noticeMessages = 0;
  let files = 0;
  if (convIds.length > 0) {
    const [m] = await db
      .select({
        messages: sql<number>`count(*) filter (where ${s.message.redactedAt} is null or ${s.message.body} is not null)::int`,
        notices: sql<number>`count(*) filter (where (${s.message.redactedAt} is null or ${s.message.body} is not null) and ${s.message.source} <> 'channel')::int`,
        files: sql<number>`coalesce(sum(cardinality(${s.message.mediaFileIds}) + (${s.message.audioFileId} is not null)::int), 0)::int`,
      })
      .from(s.message)
      .where(and(eq(s.message.operatorId, operatorId), inArray(s.message.conversationId, convIds)));
    messages = Number(m?.messages ?? 0);
    noticeMessages = Number(m?.notices ?? 0);
    files = Number(m?.files ?? 0);
  }
  files += subject.contacts.filter((c) => c.avatarFileId).length;
  return {
    contactIds: subject.contacts.map((c) => c.id),
    conversations: convIds.length,
    messages,
    noticeMessages,
    filesDeleted: files,
    filesUnlinked: 0,
    eventsRedacted: 0,
    webhookPayloadsPurged: 0,
  };
}

export interface EraseInput {
  operatorId: string;
  contactId: string;
  actorAccountId: string;
  requestId?: string | null;
  now: Date;
}

/** The erasure itself. Call inside `withTx`; the caller has checked the two confirmations. */
export async function eraseContact(tx: Tx, storage: FileStorage | null, input: EraseInput): Promise<InboxEraseContact> {
  const { operatorId, now } = input;
  const subject = await subjectOf(tx, operatorId, input.contactId, true);
  const contactIds = subject.contacts.map((c) => c.id);
  const convIds = subject.conversations.map((c) => c.id);
  const alreadyErased = subject.contacts.every((c) => c.erasedAt !== null);

  // The raw deliveries' needles, read BEFORE the handles are hashed.
  const inbound =
    convIds.length > 0
      ? await tx
          .select({ externalMessageId: s.message.externalMessageId })
          .from(s.message)
          .where(
            and(
              eq(s.message.operatorId, operatorId),
              inArray(s.message.conversationId, convIds),
              eq(s.message.direction, 'inbound'),
              isNotNull(s.message.externalMessageId),
            ),
          )
      : [];
  const live = subject.contacts.filter((c) => c.erasedAt === null);
  const needles = needlesOf([
    ...live.flatMap((c) => [c.externalHandle, c.phone, c.phone?.replace(/^\+/, '')]),
    ...inbound.map((m) => m.externalMessageId),
  ]);

  // 0. The assistant stands down on every thread of theirs (SCRUM-590 plan
  // §D.5): pending and deciding turns cancelled — a deciding turn's commit
  // then finds it so, and the contact erased, and writes nothing — and its
  // queued lines withdrawn before step 1 removes their words.
  for (const convId of convIds) {
    await cancelAiForThread(tx, operatorId, convId, 'ERASED', input.actorAccountId, {
      requestId: input.requestId ?? null,
      now,
    });
  }

  // 1. The words and the media, every message in every thread of theirs.
  const redacted = await redactThreadMessages(tx, storage, operatorId, convIds, contactIds, now);

  // 2. The threads keep their shape and lose what was copied out of the words.
  if (convIds.length > 0) {
    await tx
      .update(s.conversation)
      .set({ lastMessagePreview: null, aiSummary: null, memberId: null, updatedAt: now })
      .where(and(eq(s.conversation.operatorId, operatorId), inArray(s.conversation.id, convIds)));
  }

  // 3. The timeline: any word- or name-bearing key nulled, through the trigger's erasure door.
  let eventsRedacted = 0;
  if (convIds.length > 0) {
    const events = await tx
      .select({ id: s.inboxEvent.id, payload: s.inboxEvent.payload })
      .from(s.inboxEvent)
      .where(and(eq(s.inboxEvent.operatorId, operatorId), inArray(s.inboxEvent.conversationId, convIds)));
    const changed = events.flatMap((e) => {
      const r = redactPayload(e.payload);
      return r.changed ? [{ id: e.id, payload: r.value }] : [];
    });
    if (changed.length > 0) {
      await tx.execute(sql`select set_config('oto.inbox_erasure', 'on', true)`);
      for (const e of changed) {
        await tx
          .update(s.inboxEvent)
          .set({ payload: e.payload as never })
          .where(and(eq(s.inboxEvent.operatorId, operatorId), eq(s.inboxEvent.id, e.id)));
      }
      await tx.execute(sql`select set_config('oto.inbox_erasure', 'off', true)`);
    }
    eventsRedacted = changed.length;
  }

  // 4. The raw deliveries that carried them.
  let webhookPayloadsPurged = 0;
  const accountIds = [...new Set(subject.conversations.map((c) => c.channelAccountId))];
  if (accountIds.length > 0 && needles.length > 0) {
    const purged = await tx
      .update(s.webhookReceipt)
      .set({ payload: null, payloadPurgedAt: now, updatedAt: now })
      .where(
        and(
          eq(s.webhookReceipt.operatorId, operatorId),
          inArray(s.webhookReceipt.channelAccountId, accountIds),
          isNotNull(s.webhookReceipt.payload),
          sql`exists (select 1 from unnest(${textArray(needles)}) as n(needle)
                      where position(n.needle in ${s.webhookReceipt.payload}::text) > 0)`,
        ),
      )
      .returning({ id: s.webhookReceipt.id });
    webhookPayloadsPurged = purged.length;
  }

  // 5. The person: anonymised in place; the rows stay so the counts still add up.
  const avatars = live.flatMap((c) => (c.avatarFileId ? [c.avatarFileId] : []));
  for (const c of live) {
    await tx
      .update(s.contact)
      .set({
        displayName: INBOX_ERASED_CONTACT_NAME,
        externalHandle: erasedHandleOf(c.id),
        phone: null,
        memberId: null,
        avatarFileId: null,
        erasedAt: now,
        erasedByAccountId: input.actorAccountId,
        updatedAt: now,
      })
      .where(and(eq(s.contact.operatorId, operatorId), eq(s.contact.id, c.id)));
  }
  const avatarFiles = await dropFiles(tx, storage, operatorId, avatars, { messageIds: [], contactIds });

  const named = subject.contacts[0]!;
  const result: InboxEraseContact = {
    contactId: named.id,
    alreadyErased,
    erasedAt: (named.erasedAt ?? now).toISOString(),
    contactIds,
    conversations: convIds.length,
    messages: redacted.messages,
    noticeMessages: redacted.noticeMessages,
    filesDeleted: redacted.filesDeleted + avatarFiles.filesDeleted,
    filesUnlinked: redacted.filesUnlinked + avatarFiles.filesUnlinked,
    eventsRedacted,
    webhookPayloadsPurged,
  };

  // 6. One audit row: ids and counts. Never what was erased.
  await audit.record(tx, {
    actorAccountId: input.actorAccountId,
    action: 'inbox.contact.erase',
    entityType: 'inbox.contact',
    entityId: named.id,
    operatorId,
    branchId: null,
    requestId: input.requestId ?? null,
    before: { erased: alreadyErased, contactIds },
    after: { ...result, conversationIds: convIds },
  });
  return result;
}

// --- Retention (built, OFF until owner Q19 sets the periods) ------------------------------

export interface InboxRetentionConfig {
  conversationDays: number | null;
  mediaDays: number | null;
  webhookPayloadDays: number | null;
}

export function retentionConfigOf(env: {
  INBOX_CONVERSATION_RETENTION_DAYS?: number | undefined;
  INBOX_MEDIA_RETENTION_DAYS?: number | undefined;
  INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS?: number | undefined;
}): InboxRetentionConfig {
  return {
    conversationDays: env.INBOX_CONVERSATION_RETENTION_DAYS ?? null,
    mediaDays: env.INBOX_MEDIA_RETENTION_DAYS ?? null,
    webhookPayloadDays: env.INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS ?? null,
  };
}

/** A purge with no period does not run: it says which variable would switch it on. */
export interface PurgeRefused {
  state: 'refused';
  reason: 'NOT_CONFIGURED';
  variable: string;
}

export interface PurgeRan {
  state: 'ran';
  days: number;
  /** True when the batch was full: the next run carries on. */
  more: boolean;
  [count: string]: unknown;
}

export type PurgeOutcome = PurgeRefused | PurgeRan;

export interface PurgeDeps {
  log?: FastifyBaseLogger;
  storage: FileStorage | null;
  now: Date;
  /** Rows per run; the next tick takes the rest. */
  batch?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_BATCH = 500;

const refused = (variable: string): PurgeRefused => ({ state: 'refused', reason: 'NOT_CONFIGURED', variable });

/** One audit row per operator a purge touched: counts only, actor the system. */
async function auditPurge(
  tx: Tx,
  action: string,
  perOperator: Map<string, Record<string, unknown>>,
): Promise<void> {
  for (const [operatorId, counts] of perOperator) {
    await audit.record(tx, {
      actorAccountId: null,
      action,
      entityType: 'inbox.retention',
      entityId: operatorId,
      operatorId,
      branchId: null,
      after: counts,
    });
  }
}

/**
 * `INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS`: a receipt older than the period
 * keeps its row (the provider id still dedupes a late redelivery) and loses
 * its payload.
 */
export async function purgeWebhookPayloads(db: Db, days: number | null, deps: PurgeDeps): Promise<PurgeOutcome> {
  if (!days) return refused('INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS');
  const cutoff = new Date(deps.now.getTime() - days * DAY_MS);
  const batch = deps.batch ?? DEFAULT_BATCH;
  return withTx(db, { log: deps.log }, 'inbox.retention.webhook_payloads', async (tx) => {
    const due = await tx
      .select({ id: s.webhookReceipt.id })
      .from(s.webhookReceipt)
      .where(and(isNotNull(s.webhookReceipt.payload), lte(s.webhookReceipt.receivedAt, cutoff)))
      .orderBy(s.webhookReceipt.receivedAt)
      .limit(batch)
      .for('update', { skipLocked: true });
    if (due.length === 0) return { state: 'ran', days, more: false, payloadsPurged: 0 };
    const purged = await tx
      .update(s.webhookReceipt)
      .set({ payload: null, payloadPurgedAt: deps.now, updatedAt: deps.now })
      .where(inArray(s.webhookReceipt.id, due.map((r) => r.id)))
      .returning({ operatorId: s.webhookReceipt.operatorId });
    const per = new Map<string, Record<string, unknown>>();
    for (const r of purged) {
      const c = per.get(r.operatorId) ?? { payloadsPurged: 0, days };
      c.payloadsPurged = (c.payloadsPurged as number) + 1;
      per.set(r.operatorId, c);
    }
    await auditPurge(tx, 'inbox.retention.webhook_payloads', per);
    return { state: 'ran', days, more: due.length === batch, payloadsPurged: purged.length };
  });
}

/**
 * `INBOX_CONVERSATION_RETENTION_DAYS`. Two steps:
 *   1. STAMP — every handled thread's `retain_until` becomes its last message
 *      plus the period (only ever moved later, so a thread that came back to
 *      life is not cut short by an old date). An active thread is never
 *      stamped: open conversations are kept.
 *   2. PURGE — a handled thread past its `retain_until` that still holds
 *      anything: its messages' words and media removed in place, its preview
 *      and summary cleared, its timeline events deleted (the trigger's purge
 *      door). The thread row, its owners and its contact stay.
 */
export async function purgeConversations(db: Db, days: number | null, deps: PurgeDeps): Promise<PurgeOutcome> {
  if (!days) return refused('INBOX_CONVERSATION_RETENTION_DAYS');
  const batch = deps.batch ?? DEFAULT_BATCH;
  const period = sql`make_interval(days => ${days}::int)`;
  const keepUntil = sql`coalesce(${s.conversation.lastMessageAt}, ${s.conversation.createdAt}) + ${period}`;
  return withTx(db, { log: deps.log }, 'inbox.retention.conversations', async (tx) => {
    const stamped = await tx
      .update(s.conversation)
      .set({ retainUntil: sql`${keepUntil}`, updatedAt: deps.now })
      .where(
        and(
          eq(s.conversation.status, 'handled'),
          or(isNull(s.conversation.retainUntil), sql`${s.conversation.retainUntil} < ${keepUntil}`),
        ),
      )
      .returning({ id: s.conversation.id });

    const due = await tx
      .select({ id: s.conversation.id, operatorId: s.conversation.operatorId, contactId: s.conversation.contactId })
      .from(s.conversation)
      .where(
        and(
          eq(s.conversation.status, 'handled'),
          lte(s.conversation.retainUntil, deps.now),
          sql`(
            ${s.conversation.lastMessagePreview} is not null
            or ${s.conversation.aiSummary} is not null
            or exists (select 1 from ${s.message} m
                       where m.operator_id = ${s.conversation.operatorId} and m.conversation_id = ${s.conversation.id}
                         and (m.redacted_at is null or m.body is not null or m.audio_file_id is not null
                              or cardinality(m.media_file_ids) > 0))
            or exists (select 1 from ${s.inboxEvent} e
                       where e.operator_id = ${s.conversation.operatorId} and e.conversation_id = ${s.conversation.id})
          )`,
        ),
      )
      .orderBy(s.conversation.retainUntil)
      .limit(batch)
      .for('update', { skipLocked: true });

    const per = new Map<string, Record<string, unknown>>();
    let messages = 0;
    let filesDeleted = 0;
    let eventsDeleted = 0;
    const byOperator = new Map<string, typeof due>();
    for (const c of due) byOperator.set(c.operatorId, [...(byOperator.get(c.operatorId) ?? []), c]);
    if (due.length > 0) await tx.execute(sql`select set_config('oto.inbox_purge', 'on', true)`);
    for (const [operatorId, rows] of byOperator) {
      const ids = rows.map((r) => r.id);
      const r = await redactThreadMessages(tx, deps.storage, operatorId, ids, [], deps.now);
      await tx
        .update(s.conversation)
        .set({ lastMessagePreview: null, aiSummary: null, updatedAt: deps.now })
        .where(and(eq(s.conversation.operatorId, operatorId), inArray(s.conversation.id, ids)));
      const gone = await tx
        .delete(s.inboxEvent)
        .where(and(eq(s.inboxEvent.operatorId, operatorId), inArray(s.inboxEvent.conversationId, ids)))
        .returning({ id: s.inboxEvent.id });
      messages += r.messages;
      filesDeleted += r.filesDeleted;
      eventsDeleted += gone.length;
      per.set(operatorId, {
        days,
        conversations: ids.length,
        conversationIds: ids,
        messages: r.messages,
        filesDeleted: r.filesDeleted,
        filesUnlinked: r.filesUnlinked,
        eventsDeleted: gone.length,
      });
    }
    if (due.length > 0) await tx.execute(sql`select set_config('oto.inbox_purge', 'off', true)`);
    await auditPurge(tx, 'inbox.retention.conversations', per);
    return {
      state: 'ran',
      days,
      more: due.length === batch,
      stamped: stamped.length,
      conversationsPurged: due.length,
      messages,
      filesDeleted,
      eventsDeleted,
    };
  });
}

/** `INBOX_MEDIA_RETENTION_DAYS`: media and voice notes older than the period go; the words stay. */
export async function purgeMedia(db: Db, days: number | null, deps: PurgeDeps): Promise<PurgeOutcome> {
  if (!days) return refused('INBOX_MEDIA_RETENTION_DAYS');
  const cutoff = new Date(deps.now.getTime() - days * DAY_MS);
  const batch = deps.batch ?? DEFAULT_BATCH;
  return withTx(db, { log: deps.log }, 'inbox.retention.media', async (tx) => {
    const due = await tx
      .select({
        id: s.message.id,
        operatorId: s.message.operatorId,
        mediaFileIds: s.message.mediaFileIds,
        audioFileId: s.message.audioFileId,
      })
      .from(s.message)
      .where(
        and(
          lte(s.message.createdAt, cutoff),
          or(isNotNull(s.message.audioFileId), sql`cardinality(${s.message.mediaFileIds}) > 0`),
        ),
      )
      .orderBy(s.message.createdAt)
      .limit(batch)
      .for('update', { skipLocked: true });
    const per = new Map<string, Record<string, unknown>>();
    let filesDeleted = 0;
    let filesUnlinked = 0;
    const byOperator = new Map<string, typeof due>();
    for (const m of due) byOperator.set(m.operatorId, [...(byOperator.get(m.operatorId) ?? []), m]);
    for (const [operatorId, rows] of byOperator) {
      const ids = rows.map((r) => r.id);
      await tx
        .update(s.message)
        .set({ mediaFileIds: sql`'{}'::uuid[]`, audioFileId: null, updatedAt: deps.now })
        .where(and(eq(s.message.operatorId, operatorId), inArray(s.message.id, ids)));
      const f = await dropFiles(
        tx,
        deps.storage,
        operatorId,
        rows.flatMap((r) => [...r.mediaFileIds, ...(r.audioFileId ? [r.audioFileId] : [])]),
        { messageIds: ids, contactIds: [] },
      );
      filesDeleted += f.filesDeleted;
      filesUnlinked += f.filesUnlinked;
      per.set(operatorId, { days, messages: ids.length, messageIds: ids, ...f });
    }
    await auditPurge(tx, 'inbox.retention.media', per);
    return { state: 'ran', days, more: due.length === batch, messages: due.length, filesDeleted, filesUnlinked };
  });
}

export const INBOX_RETENTION_JOB = 'job:inbox.retention';

/**
 * The daily job's body: the three purges in turn, each refusing on its own
 * when its period is unset. The run's `ops_run.detail` is this answer —
 * which purge ran, which refused and why, and counts. With every period unset
 * (the default, owner Q19) every run says `refused` three times and removes
 * nothing.
 */
export async function runInboxRetention(
  db: Db,
  config: InboxRetentionConfig,
  deps: PurgeDeps,
): Promise<Record<string, unknown>> {
  return {
    conversations: await purgeConversations(db, config.conversationDays, deps),
    media: await purgeMedia(db, config.mediaDays, deps),
    webhookPayloads: await purgeWebhookPayloads(db, config.webhookPayloadDays, deps),
  };
}
