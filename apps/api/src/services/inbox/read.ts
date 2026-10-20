import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Db } from '@oto/db';
import {
  INBOX_DAY_TIMEZONE,
  isUnanswered,
  isoDateInTz,
  newId,
  tabsForRoles,
  type InboxConversationDetail,
  type InboxConversationList,
  type InboxConversationListQuery,
  type InboxConversationRow,
  type InboxDashboard,
  type InboxMe,
  type InboxMessage,
  type InboxTab,
  type InboxViewRole,
} from '@oto/shared';
import { errors } from '../../lib/errors';
import { audit } from '../audit';
import type { EffectivePermission } from '../permissions';
import type { Tx } from '../tx';
import { divertTarget } from './actions';
import {
  INBOX_READ,
  activeAssignmentsOf,
  heldByViewerSql,
  holdsAnywhere,
  loadVisibleConversation,
  visibleConversationsSql,
  type InboxViewer,
} from './read-visibility';

/**
 * THE INBOX'S READS (S2-19 I2b, SCRUM-581; plan §3.3, the [A] rows).
 *
 * The conversation list with its tabs and filters, one conversation's header
 * and timeline, its messages a page at a time, the dashboard counts, the
 * viewer's own identity and tabs, the composer's templates, and the read
 * marker with its sampled audit. Every one of them reads through
 * `visibleConversationsSql` — visibility is decided here against the
 * database, never by a client filtering what it was sent.
 *
 * The tab, unanswered, branch and search rules are `@oto/shared`'s
 * (`inTab`, `isUnanswered`, `matchesBranchFilter`, `matchesSearch`), stated a
 * second time below as SQL because a list is paged in the database; the read
 * test runs both over the same rows and requires the same answer.
 */

// --- Rules as SQL ------------------------------------------------------------------

/** `isUnanswered` over the columns: active, and a customer message or a routing after the last staff message. */
export const unansweredSql: SQL = sql`(${s.conversation.status} = 'active' and (
  (${s.conversation.lastCustomerMessageAt} is not null and (${s.conversation.lastStaffMessageAt} is null or ${s.conversation.lastCustomerMessageAt} > ${s.conversation.lastStaffMessageAt}))
  or (${s.conversation.lastRoutedAt} is not null and (${s.conversation.lastStaffMessageAt} is null or ${s.conversation.lastRoutedAt} > ${s.conversation.lastStaffMessageAt}))
))`;

/** `inTab`, as coded (the owner-note in `@oto/shared/inbox`): Team includes the viewer's own. */
function inTabSql(tab: InboxTab, viewer: InboxViewer): SQL {
  switch (tab) {
    case 'mine':
      return and(ne(s.conversation.status, 'handled'), heldByViewerSql(viewer))!;
    case 'team':
      return ne(s.conversation.status, 'handled');
    case 'handled':
      return eq(s.conversation.status, 'handled');
  }
}

/** The start of a Bangkok day as an instant, from its `YYYY-MM-DD`. */
const dayStartSql = (isoDay: string): SQL =>
  sql`((${isoDay})::date::timestamp at time zone ${INBOX_DAY_TIMEZONE})`;

/** The Bangkok day `now` falls in. */
export const inboxToday = (now: Date): string => isoDateInTz(now, INBOX_DAY_TIMEZONE);

/** The list's order: newest activity first, a thread with no message by its start. */
const sortKeySql = sql`coalesce(${s.conversation.lastMessageAt}, ${s.conversation.createdAt})`;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** A LIKE pattern that matches `q` literally. */
const likeLiteral = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// --- Cursor ---------------------------------------------------------------------------

interface ListCursor {
  t: string;
  id: string;
}

function encodeCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): ListCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ListCursor>;
    if (typeof parsed.t === 'string' && typeof parsed.id === 'string' && !Number.isNaN(Date.parse(parsed.t))) {
      if (/^[0-9a-f-]{36}$/i.test(parsed.id)) return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through to the refusal
  }
  throw errors.badRequest('That list cursor is not one this api gave out.');
}

// --- Names ------------------------------------------------------------------------------

/** Account id → the person's name (their employee record), for chips and authors. */
async function accountNames(db: Db | Tx, operatorId: string, ids: Iterable<string>): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: s.account.id, name: s.employee.name })
    .from(s.account)
    .leftJoin(s.employee, eq(s.employee.id, s.account.employeeId))
    .where(and(eq(s.account.operatorId, operatorId), inArray(s.account.id, unique)));
  return new Map(rows.map((r) => [r.id, r.name ?? null]));
}

// --- The list -------------------------------------------------------------------------

const rowColumns = {
  id: s.conversation.id,
  channelAccountId: s.conversation.channelAccountId,
  channel: s.channelAccount.channel,
  canReply: s.channelAccount.canReply,
  contactId: s.contact.id,
  contactChannel: s.contact.channel,
  contactHandle: s.contact.externalHandle,
  contactName: s.contact.displayName,
  contactPhone: s.contact.phone,
  contactLanguage: s.contact.language,
  contactErasedAt: s.contact.erasedAt,
  category: s.conversation.category,
  intent: s.conversation.intent,
  language: s.conversation.language,
  branchId: s.conversation.branchId,
  teamId: s.conversation.teamId,
  status: s.conversation.status,
  handledAt: s.conversation.handledAt,
  handledByKind: s.conversation.handledByKind,
  lastMessageAt: s.conversation.lastMessageAt,
  lastMessagePreview: s.conversation.lastMessagePreview,
  lastCustomerMessageAt: s.conversation.lastCustomerMessageAt,
  lastStaffMessageAt: s.conversation.lastStaffMessageAt,
  lastRoutedAt: s.conversation.lastRoutedAt,
  createdAt: s.conversation.createdAt,
  firstResponseAt: s.conversation.firstResponseAt,
  reopenedAt: s.conversation.reopenedAt,
  memberId: s.conversation.memberId,
};

type RawRow = Awaited<ReturnType<typeof selectRows>>[number];

/** Customer messages after the viewer's last read one; all of them before any read. */
function unreadSql(viewer: InboxViewer): SQL<number> {
  return sql<number>`(
    select count(*)::int from ${s.message} um
    where um.operator_id = ${s.conversation.operatorId}
      and um.conversation_id = ${s.conversation.id}
      and um.direction = 'inbound'
      and um.created_at > coalesce((
        select lm.created_at from ${s.participant} p
        join ${s.message} lm on lm.operator_id = p.operator_id and lm.id = p.last_read_message_id
        where p.operator_id = ${s.conversation.operatorId}
          and p.conversation_id = ${s.conversation.id}
          and p.account_id = ${viewer.accountId}
      ), '-infinity'::timestamptz)
  )`;
}

function selectRows(db: Db | Tx, viewer: InboxViewer) {
  return db
    .select({
      ...rowColumns,
      unread: unreadSql(viewer),
      mine: sql<boolean>`${heldByViewerSql(viewer)}`,
    })
    .from(s.conversation)
    .innerJoin(
      s.contact,
      and(eq(s.contact.operatorId, s.conversation.operatorId), eq(s.contact.id, s.conversation.contactId)),
    )
    .innerJoin(
      s.channelAccount,
      and(
        eq(s.channelAccount.operatorId, s.conversation.operatorId),
        eq(s.channelAccount.id, s.conversation.channelAccountId),
      ),
    );
}

async function assignmentsFor(
  db: Db | Tx,
  operatorId: string,
  conversationIds: string[],
): Promise<Map<string, InboxConversationRow['assignments']>> {
  const out = new Map<string, InboxConversationRow['assignments']>();
  if (conversationIds.length === 0) return out;
  const rows = await db
    .select({
      id: s.assignment.id,
      conversationId: s.assignment.conversationId,
      slot: s.assignment.slot,
      slotIndex: s.assignment.slotIndex,
      assigneeKind: s.assignment.assigneeKind,
      accountId: s.assignment.accountId,
      teamId: s.assignment.teamId,
      teamName: s.team.name,
      reason: s.assignment.reason,
      assignedAt: s.assignment.assignedAt,
    })
    .from(s.assignment)
    .leftJoin(s.team, and(eq(s.team.operatorId, s.assignment.operatorId), eq(s.team.id, s.assignment.teamId)))
    .where(and(eq(s.assignment.operatorId, operatorId), activeAssignmentsOf(conversationIds)))
    .orderBy(asc(s.assignment.slotIndex));
  const names = await accountNames(
    db,
    operatorId,
    rows.flatMap((r) => (r.accountId ? [r.accountId] : [])),
  );
  for (const r of rows) {
    const list = out.get(r.conversationId) ?? [];
    list.push({
      assignmentId: r.id,
      slot: r.slot,
      slotIndex: r.slotIndex,
      assigneeKind: r.assigneeKind,
      accountId: r.accountId,
      teamId: r.teamId,
      name: r.accountId ? (names.get(r.accountId) ?? null) : (r.teamName ?? null),
      reason: r.reason,
      assignedAt: r.assignedAt.toISOString(),
    });
    out.set(r.conversationId, list);
  }
  return out;
}

function toRow(r: RawRow, assignments: InboxConversationRow['assignments']): InboxConversationRow {
  return {
    id: r.id,
    channel: r.channel,
    channelAccountId: r.channelAccountId,
    canReply: r.canReply,
    contact: {
      id: r.contactId,
      channel: r.contactChannel,
      handle: r.contactHandle,
      displayName: r.contactName,
      phone: r.contactPhone,
      language: r.contactLanguage,
      erased: r.contactErasedAt !== null,
    },
    category: r.category,
    intent: r.intent,
    language: r.language,
    branchId: r.branchId,
    teamId: r.teamId,
    status: r.status,
    handledAt: iso(r.handledAt),
    handledByKind: r.handledByKind,
    lastMessageAt: iso(r.lastMessageAt),
    lastMessagePreview: r.lastMessagePreview,
    unanswered: isUnanswered(r),
    unread: Number(r.unread),
    mine: Boolean(r.mine),
    assignments,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Every filter of the list except the tab, as SQL (`WhatsAppDemo.tsx` :1065-1085). */
function filterSql(q: InboxConversationListQuery): SQL[] {
  const where: SQL[] = [];
  if (q.category) where.push(eq(s.conversation.category, q.category));
  // `matchesBranchFilter`: the branch's own, and the operator-wide ones (:1066).
  if (q.branchId) {
    where.push(sql`(${s.conversation.branchId} = ${q.branchId} or ${s.conversation.branchId} is null)`);
  }
  if (q.status) where.push(eq(s.conversation.status, q.status));
  if (q.language) where.push(eq(s.conversation.language, q.language));
  if (q.unanswered === 'true') where.push(unansweredSql);
  if (q.handledFrom) where.push(gte(s.conversation.handledAt, new Date(q.handledFrom)));
  if (q.handledTo) where.push(lte(s.conversation.handledAt, new Date(q.handledTo)));
  // The prototype applies "resolved by" in the archive only (:1071-1072).
  if (q.resolvedBy && q.tab === 'handled') {
    where.push(
      q.resolvedBy === 'ai'
        ? eq(s.conversation.handledByKind, 'ai')
        : sql`${s.conversation.handledByKind} is distinct from 'ai'`,
    );
  }
  // `matchesSearch`: customer, intent and last message (:1079-1085).
  const needle = q.q?.trim();
  if (needle) {
    const pattern = likeLiteral(needle);
    where.push(sql`(
      coalesce(${s.contact.displayName}, '') ilike ${pattern}
      or coalesce(${s.conversation.intent}, '') ilike ${pattern}
      or coalesce(${s.conversation.lastMessagePreview}, '') ilike ${pattern}
    )`);
  }
  return where;
}

/** The viewer's tabs, counted over everything they can see before any filter (:1088-1097). */
async function tabCountsOf(db: Db, viewer: InboxViewer, tabs: InboxTab[]): Promise<InboxConversationList['tabCounts']> {
  if (tabs.length === 0) return {};
  const [row] = await db
    .select({
      mine: sql<number>`count(*) filter (where ${inTabSql('mine', viewer)})::int`,
      team: sql<number>`count(*) filter (where ${inTabSql('team', viewer)})::int`,
      handled: sql<number>`count(*) filter (where ${inTabSql('handled', viewer)})::int`,
    })
    .from(s.conversation)
    .where(visibleConversationsSql(viewer));
  const counts: InboxConversationList['tabCounts'] = {};
  for (const t of tabs) counts[t] = Number(row?.[t] ?? 0);
  return counts;
}

export async function listConversations(
  db: Db,
  viewer: InboxViewer,
  tabs: InboxTab[],
  q: InboxConversationListQuery,
): Promise<InboxConversationList> {
  const where: SQL[] = [visibleConversationsSql(viewer), ...filterSql(q)];
  if (q.tab) where.push(inTabSql(q.tab, viewer));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    where.push(sql`(${sortKeySql}, ${s.conversation.id}) < (${new Date(c.t)}::timestamptz, ${c.id}::uuid)`);
  }
  const rows = (await selectRows(db, viewer)
    .where(and(...where))
    .orderBy(desc(sortKeySql), desc(s.conversation.id))
    .limit(q.limit + 1));
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > q.limit && last
      ? encodeCursor({ t: (last.lastMessageAt ?? last.createdAt).toISOString(), id: last.id })
      : null;
  const assignments = await assignmentsFor(
    db,
    viewer.operatorId,
    page.map((r) => r.id),
  );
  return {
    conversations: page.map((r) => toRow(r, assignments.get(r.id) ?? [])),
    nextCursor,
    tabCounts: await tabCountsOf(db, viewer, tabs),
  };
}

// --- One conversation ----------------------------------------------------------------

export async function conversationDetail(
  db: Db,
  viewer: InboxViewer,
  conversationId: string,
): Promise<InboxConversationDetail> {
  const conv = await loadVisibleConversation(db, viewer, conversationId);
  const [raw] = (await selectRows(db, viewer)
    .where(and(eq(s.conversation.operatorId, viewer.operatorId), eq(s.conversation.id, conv.id)))
    .limit(1));
  if (!raw) throw errors.notFound('Conversation not found');
  const assignments = (await assignmentsFor(db, viewer.operatorId, [conv.id])).get(conv.id) ?? [];

  let teamName: string | null = null;
  if (conv.teamId) {
    const [t] = await db
      .select({ name: s.team.name })
      .from(s.team)
      .where(and(eq(s.team.operatorId, viewer.operatorId), eq(s.team.id, conv.teamId)))
      .limit(1);
    teamName = t?.name ?? null;
  }

  // The member link is soft: read inside the operator, and only the name and
  // how many children — no allergy or medical text here; the POS owns that.
  let member: InboxConversationDetail['member'] = null;
  if (conv.memberId) {
    const [m] = await db
      .select({
        id: s.member.id,
        name: sql<string>`coalesce(${s.member.name}, ${s.member.nickname})`,
        childCount: sql<number>`(select count(*)::int from ${s.child} where ${s.child.memberId} = ${s.member.id} and ${s.child.archivedAt} is null)`,
      })
      .from(s.member)
      .where(and(eq(s.member.operatorId, viewer.operatorId), eq(s.member.id, conv.memberId)))
      .limit(1);
    if (m) member = { id: m.id, name: m.name, childCount: Number(m.childCount) };
  }

  const eventRows = await db
    .select({
      id: s.inboxEvent.id,
      kind: s.inboxEvent.kind,
      actorKind: s.inboxEvent.actorKind,
      actorAccountId: s.inboxEvent.actorAccountId,
      payload: s.inboxEvent.payload,
      createdAt: s.inboxEvent.createdAt,
    })
    .from(s.inboxEvent)
    .where(and(eq(s.inboxEvent.operatorId, viewer.operatorId), eq(s.inboxEvent.conversationId, conv.id)))
    .orderBy(asc(s.inboxEvent.createdAt), asc(s.inboxEvent.id));
  const actorNames = await accountNames(
    db,
    viewer.operatorId,
    eventRows.flatMap((e) => (e.actorAccountId ? [e.actorAccountId] : [])),
  );

  // Divert's counterpart, read exactly as the action reads it (`divertTarget`).
  const primaryAccountId = assignments.find((a) => a.slot === 'primary')?.accountId ?? null;
  const { target: divertAccountId } = await divertTarget(db, viewer.operatorId, conv, primaryAccountId);
  const divertTo = divertAccountId
    ? { accountId: divertAccountId, name: (await accountNames(db, viewer.operatorId, [divertAccountId])).get(divertAccountId) ?? null }
    : null;

  return {
    ...toRow(raw, assignments),
    teamName,
    firstResponseAt: iso(raw.firstResponseAt),
    reopenedAt: iso(raw.reopenedAt),
    member,
    events: eventRows.map((e) => ({
      id: e.id,
      kind: e.kind,
      actorKind: e.actorKind,
      actorAccountId: e.actorAccountId,
      actorName: e.actorAccountId ? (actorNames.get(e.actorAccountId) ?? null) : null,
      payload: (e.payload ?? {}) as Record<string, unknown>,
      createdAt: e.createdAt.toISOString(),
    })),
    divertTo,
  };
}

// --- Messages ----------------------------------------------------------------------------

export async function conversationMessages(
  db: Db,
  viewer: InboxViewer,
  conversationId: string,
  page: { before?: string; limit: number },
): Promise<{ messages: InboxMessage[]; olderCursor: string | null }> {
  const conv = await loadVisibleConversation(db, viewer, conversationId);
  const where: SQL[] = [eq(s.message.operatorId, viewer.operatorId), eq(s.message.conversationId, conv.id)];
  if (page.before) {
    const [anchor] = await db
      .select({ id: s.message.id, createdAt: s.message.createdAt })
      .from(s.message)
      .where(and(...where, eq(s.message.id, page.before)))
      .limit(1);
    if (!anchor) throw errors.badRequest('That message is not in this conversation.');
    where.push(sql`(${s.message.createdAt}, ${s.message.id}) < (${anchor.createdAt}::timestamptz, ${anchor.id}::uuid)`);
  }
  const rows = await db
    .select()
    .from(s.message)
    .where(and(...where))
    .orderBy(desc(s.message.createdAt), desc(s.message.id))
    .limit(page.limit + 1);
  const pageRows = rows.slice(0, page.limit).reverse();
  const names = await accountNames(
    db,
    viewer.operatorId,
    pageRows.flatMap((m) => (m.authorAccountId ? [m.authorAccountId] : [])),
  );
  return {
    messages: pageRows.map((m) => ({
      id: m.id,
      direction: m.direction,
      authorKind: m.authorKind,
      authorAccountId: m.authorAccountId,
      authorName: m.authorAccountId ? (names.get(m.authorAccountId) ?? null) : null,
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
    })),
    olderCursor: rows.length > page.limit ? (pageRows[0]?.id ?? null) : null,
  };
}

// --- The read marker, and its sampled audit -------------------------------------------

export const INBOX_READ_AUDIT_ACTION = 'inbox.conversation.read';

export interface MarkReadInput {
  conversationId: string;
  messageId?: string;
  requestId: string;
  now: Date;
}

/**
 * Advance the viewer's read marker (`participant.last_read_message_id`), and
 * write the day's read audit (plan §3.6): ONE `inbox.conversation.read` row per
 * account, conversation and Bangkok day — "reads are audited, sampled"
 * (`SPRINT_2_PLAN.md` S2-19). The row names the conversation's category, team
 * and branch — the access — and never a message body.
 *
 * The participant row is locked first, so two reads at once by one person are
 * decided one after the other and the day still gets one row. The marker only
 * moves forward: reading an older message does not unread the newer ones.
 */
export async function markConversationRead(
  tx: Tx,
  viewer: InboxViewer,
  input: MarkReadInput,
): Promise<{ conversationId: string; lastReadMessageId: string | null; lastReadAt: string | null; audited: boolean }> {
  const conv = await loadVisibleConversation(tx, viewer, input.conversationId);
  const inThread = and(eq(s.message.operatorId, viewer.operatorId), eq(s.message.conversationId, conv.id));

  const [target] = input.messageId
    ? await tx
        .select({ id: s.message.id, createdAt: s.message.createdAt })
        .from(s.message)
        .where(and(inThread, eq(s.message.id, input.messageId)))
        .limit(1)
    : await tx
        .select({ id: s.message.id, createdAt: s.message.createdAt })
        .from(s.message)
        .where(inThread)
        .orderBy(desc(s.message.createdAt), desc(s.message.id))
        .limit(1);
  if (input.messageId && !target) throw errors.badRequest('That message is not in this conversation.');

  await tx
    .insert(s.participant)
    .values({
      id: newId(),
      operatorId: viewer.operatorId,
      conversationId: conv.id,
      accountId: viewer.accountId,
      firstSeenAt: input.now,
    })
    .onConflictDoNothing({ target: [s.participant.conversationId, s.participant.accountId] });
  const [held] = await tx
    .select({
      id: s.participant.id,
      lastReadMessageId: s.participant.lastReadMessageId,
      lastReadAt: s.participant.lastReadAt,
      lastReadCreatedAt: sql<Date | null>`(select lm.created_at from ${s.message} lm where lm.operator_id = ${s.participant.operatorId} and lm.id = ${s.participant.lastReadMessageId})`,
    })
    .from(s.participant)
    .where(
      and(
        eq(s.participant.operatorId, viewer.operatorId),
        eq(s.participant.conversationId, conv.id),
        eq(s.participant.accountId, viewer.accountId),
      ),
    )
    .for('update');
  if (!held) throw errors.notFound('Conversation not found');

  const heldAt = held.lastReadCreatedAt === null ? null : new Date(held.lastReadCreatedAt);
  const advance =
    target !== undefined &&
    (heldAt === null ||
      target.createdAt.getTime() > heldAt.getTime() ||
      (target.createdAt.getTime() === heldAt.getTime() && target.id > (held.lastReadMessageId ?? '')));
  let lastReadMessageId = held.lastReadMessageId;
  let lastReadAt = held.lastReadAt;
  if (advance) {
    lastReadMessageId = target.id;
    lastReadAt = input.now;
    await tx
      .update(s.participant)
      .set({ lastReadMessageId, lastReadAt, updatedAt: input.now })
      .where(eq(s.participant.id, held.id));
  }

  const [already] = await tx
    .select({ id: s.auditLog.id })
    .from(s.auditLog)
    .where(
      and(
        eq(s.auditLog.action, INBOX_READ_AUDIT_ACTION),
        eq(s.auditLog.entityType, 'inbox.conversation'),
        eq(s.auditLog.entityId, conv.id),
        eq(s.auditLog.actorAccountId, viewer.accountId),
        gte(s.auditLog.createdAt, sql`${dayStartSql(inboxToday(input.now))}`),
      ),
    )
    .limit(1);
  const audited = !already;
  if (audited) {
    await audit.record(tx, {
      actorAccountId: viewer.accountId,
      operatorId: viewer.operatorId,
      branchId: conv.branchId,
      action: INBOX_READ_AUDIT_ACTION,
      entityType: 'inbox.conversation',
      entityId: conv.id,
      after: { category: conv.category, teamId: conv.teamId, branchId: conv.branchId, status: conv.status },
      requestId: input.requestId,
    });
  }
  return { conversationId: conv.id, lastReadMessageId, lastReadAt: iso(lastReadAt), audited };
}

// --- The dashboard -----------------------------------------------------------------------

/**
 * The metric cards (plan §3.3), all within what the viewer can see. "Needs
 * manager" and "unassigned" are gone under the IT Brief; the BEO card waits on
 * owner Q23. The average response is computed (the prototype's is a constant
 * per role, :1110-1116): first staff response less the conversation's start,
 * opening hours ignored (owner Q25).
 */
export async function inboxDashboard(db: Db, viewer: InboxViewer, now: Date): Promise<InboxDashboard> {
  const day = inboxToday(now);
  const start = dayStartSql(day);
  const [row] = await db
    .select({
      newToday: sql<number>`count(*) filter (where ${s.conversation.createdAt} >= ${start})::int`,
      unanswered: sql<number>`count(*) filter (where ${unansweredSql})::int`,
      handledToday: sql<number>`count(*) filter (where ${s.conversation.status} = 'handled' and ${s.conversation.handledAt} >= ${start})::int`,
      active: sql<number>`count(*) filter (where ${s.conversation.status} = 'active')::int`,
      averageFirstResponseSeconds: sql<
        number | null
      >`avg(extract(epoch from (${s.conversation.firstResponseAt} - ${s.conversation.createdAt}))) filter (where ${s.conversation.firstResponseAt} is not null)`,
      birthdays: sql<number>`count(*) filter (where ${s.conversation.category} = 'birthdays')::int`,
      general: sql<number>`count(*) filter (where ${s.conversation.category} = 'general')::int`,
      marketing: sql<number>`count(*) filter (where ${s.conversation.category} = 'marketing')::int`,
    })
    .from(s.conversation)
    .where(visibleConversationsSql(viewer));
  const avg = row?.averageFirstResponseSeconds;
  return {
    newToday: Number(row?.newToday ?? 0),
    unanswered: Number(row?.unanswered ?? 0),
    handledToday: Number(row?.handledToday ?? 0),
    active: Number(row?.active ?? 0),
    averageFirstResponseSeconds: avg === null || avg === undefined ? null : Math.max(0, Math.round(Number(avg))),
    byCategory: {
      birthdays: Number(row?.birthdays ?? 0),
      general: Number(row?.general ?? 0),
      marketing: Number(row?.marketing ?? 0),
    },
    day,
  };
}

// --- The viewer --------------------------------------------------------------------------

const VIEW_OF_TEAM: Record<'birthdays' | 'reception' | 'marketing', InboxViewRole> = {
  birthdays: 'events',
  reception: 'reception',
  marketing: 'marketing',
};

/**
 * The prototype views a viewer stands in, from their grants. Operator-wide
 * reading is the owner's view. Otherwise each team they are in is that team's
 * view; a reader in no team at all (a manual-only person, a branch-scoped
 * manager) is `staff`, which `tabsForRole` treats as its default arm.
 */
export function viewRolesOf(
  viewer: InboxViewer,
  teams: Array<{ key: 'birthdays' | 'reception' | 'marketing'; departmentId: string | null }>,
  readsAnywhere: boolean,
): InboxViewRole[] {
  if (viewer.scope.operatorWide) return ['owner'];
  const views = new Set<InboxViewRole>();
  for (const t of teams) {
    if (t.departmentId !== null && viewer.scope.departmentIds.includes(t.departmentId)) {
      views.add(VIEW_OF_TEAM[t.key]);
    }
  }
  if (views.size === 0 && readsAnywhere) views.add('staff');
  return [...views];
}

export async function operatorTeams(db: Db, operatorId: string) {
  return db
    .select({
      id: s.team.id,
      key: s.team.key,
      name: s.team.name,
      colour: s.team.colour,
      branchId: s.team.branchId,
      departmentId: s.team.departmentId,
      sortOrder: s.team.sortOrder,
    })
    .from(s.team)
    .where(eq(s.team.operatorId, operatorId))
    .orderBy(asc(s.team.sortOrder), asc(s.team.name));
}

/** The viewer's tabs, as `GET /inbox/me` gives them and the list counts them. */
export async function viewerTabs(db: Db, viewer: InboxViewer, effective: EffectivePermission[]): Promise<InboxTab[]> {
  const teams = await operatorTeams(db, viewer.operatorId);
  return tabsForRoles(viewRolesOf(viewer, teams, holdsAnywhere(effective, INBOX_READ, viewer.operatorId)));
}

export async function inboxMe(
  db: Db,
  viewer: InboxViewer,
  effective: EffectivePermission[],
  opts: { simulatorEnabled: boolean } = { simulatorEnabled: false },
): Promise<InboxMe> {
  const teams = await operatorTeams(db, viewer.operatorId);
  const roles = viewRolesOf(viewer, teams, holdsAnywhere(effective, INBOX_READ, viewer.operatorId));

  // Who can hold a slot: every active account of the operator that reads the
  // Inbox somewhere — the teams' people by their department grants, the
  // operator-wide readers, and the manual-only people, who read only what
  // they are put on.
  const grants = await db
    .select({
      accountId: s.roleAssignment.accountId,
      scopeType: s.roleAssignment.scopeType,
      scopeId: s.roleAssignment.scopeId,
    })
    .from(s.roleAssignment)
    .innerJoin(s.rolePermission, eq(s.rolePermission.roleId, s.roleAssignment.roleId))
    .innerJoin(s.account, eq(s.account.id, s.roleAssignment.accountId))
    .where(
      and(
        eq(s.rolePermission.permission, INBOX_READ),
        eq(s.account.operatorId, viewer.operatorId),
        eq(s.account.status, 'active'),
      ),
    );
  const people = new Map<string, { teamIds: Set<string>; operatorWide: boolean }>();
  for (const g of grants) {
    if (g.scopeType === 'operator' && g.scopeId !== null && g.scopeId !== viewer.operatorId) continue;
    const p = people.get(g.accountId) ?? { teamIds: new Set<string>(), operatorWide: false };
    if (g.scopeType === 'operator') p.operatorWide = true;
    if (g.scopeType === 'department') {
      for (const t of teams) if (t.departmentId === g.scopeId) p.teamIds.add(t.id);
    }
    people.set(g.accountId, p);
  }
  const names = await accountNames(db, viewer.operatorId, [viewer.accountId, ...people.keys()]);
  const reception = teams.find((t) => t.key === 'reception');

  // The simulator panel: the deployment runs the simulator AND the viewer may
  // drive it — the same two checks the `/inbox/simulator/*` routes make.
  const simulator =
    opts.simulatorEnabled && holdsAnywhere(effective, 'inbox:channel:manage', viewer.operatorId)
      ? {
          channelAccounts: await db
            .select({
              id: s.channelAccount.id,
              channel: s.channelAccount.channel,
              displayName: s.channelAccount.displayName,
              branchId: s.channelAccount.branchId,
            })
            .from(s.channelAccount)
            .where(
              and(
                eq(s.channelAccount.operatorId, viewer.operatorId),
                eq(s.channelAccount.provider, 'simulator'),
                isNull(s.channelAccount.archivedAt),
              ),
            )
            .orderBy(asc(s.channelAccount.displayName), asc(s.channelAccount.id)),
        }
      : null;

  return {
    accountId: viewer.accountId,
    name: names.get(viewer.accountId) ?? null,
    roles,
    tabs: tabsForRoles(roles),
    teams: teams.map((t) => ({
      id: t.id,
      kind: t.key,
      name: t.name,
      colour: t.colour,
      branchId: t.branchId,
      member: t.departmentId !== null && viewer.scope.departmentIds.includes(t.departmentId),
    })),
    people: [...people]
      .map(([accountId, p]) => ({
        accountId,
        name: names.get(accountId) ?? null,
        teamIds: [...p.teamIds],
        operatorWide: p.operatorWide,
      }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.accountId.localeCompare(b.accountId)),
    defaultReceptionBranchId: reception?.branchId ?? null,
    capabilities: {
      // The write switch (plan "How Cut A is marked"): on since I2f (SCRUM-585)
      // landed the reply, the templates and the send job — for every channel
      // but the check-in notices (`canReply` on each conversation says which).
      writes: true,
      dashboard: holdsAnywhere(effective, 'inbox:dashboard:read', viewer.operatorId),
      assign: holdsAnywhere(effective, 'inbox:conversation:assign', viewer.operatorId),
      move: holdsAnywhere(effective, 'inbox:conversation:move', viewer.operatorId),
      reopen: holdsAnywhere(effective, 'inbox:conversation:reopen', viewer.operatorId),
      templates: holdsAnywhere(effective, 'inbox:template:manage', viewer.operatorId),
    },
    simulator,
  };
}

// --- Templates -----------------------------------------------------------------------------

export async function inboxTemplates(db: Db, operatorId: string, language?: string) {
  const rows = await db
    .select()
    .from(s.template)
    .where(
      and(
        eq(s.template.operatorId, operatorId),
        eq(s.template.active, true),
        isNull(s.template.archivedAt),
        language ? eq(s.template.language, language) : undefined,
      ),
    )
    .orderBy(asc(s.template.key), asc(s.template.language), asc(s.template.id));
  return {
    templates: rows.map((t) => ({
      id: t.id,
      key: t.key,
      language: t.language,
      channel: t.channel,
      branchId: t.branchId,
      body: t.body,
      attachmentFileIds: t.attachmentFileIds,
      approvalStatus: t.approvalStatus,
      needsTranslation: t.needsTranslation,
    })),
  };
}
