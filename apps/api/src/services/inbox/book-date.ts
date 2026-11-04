import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { branch, conversation, inboxEvent, team, type Db } from '@oto/db';
import {
  beoPathOf,
  newId,
  normalizePhone,
  type InboxBookDateBody,
  type InboxBookDateResult,
  type InboxConversationEvent,
  type Permission,
} from '@oto/shared';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit';
import { claimClientId, idInUse, markReplay } from '../client-id';
import { getBranchEvent } from '../otoapp-events';
import {
  DIRECTORY_NOT_CONFIGURED,
  type DirectoryInboxEventAnswer,
  type DirectoryOutcome,
  type OtoAppDirectory,
} from '../otoapp-directory';
import { hasPermission } from '../permissions';
import { PermissionDeniedError } from '../../plugins/session';
import { withTx, type Exec, type OpContext } from '../tx';
import type { ActionCtx } from './actions';
import { loadVisibleConversation } from './read-visibility';

/**
 * BOOK DATE — A BIRTHDAY'S EVENT IN THE EVENTS MODULE (SCRUM-775).
 *
 * Owner decision, 4 November (closes Inbox owner question Q23): the OTO App's
 * Events module is the one home for birthday orders. The prototype's Book Date
 * blocked the date and wrote a pill, "Date blocked in POS by … · awaiting
 * confirmation" (`WhatsAppDemo.tsx` `bookDate`, :1258-1276); here it makes a
 * TENTATIVE birthday event in the Events module, from what a person confirmed
 * out of the chat, and the conversation and the event name each other:
 *
 *   - the conversation keeps the event's id in `event_order_ref` (the soft key
 *     the inbox schema kept for this, owner Q23) and a `date_booked` pill with
 *     what was booked;
 *   - the event keeps the conversation's id (the app's migration 0034) and its
 *     BEO editor says "From the inbox".
 *
 * Create BEO is not a write here: it opens `beoPath` in the OTO App through the
 * suite hand-off, whose own mint is audited (`auth.handoff_issue`).
 *
 * WHO. A person in the birthdays team (a department grant at the team the
 * conversation is with), or anyone holding `inbox:conversation:assign` at the
 * conversation. Only a conversation in Birthdays & Events (`NOT_A_BIRTHDAY`).
 *
 * ONE EVENT PER CONVERSATION, PER PRESS. The body's `id` is the event's own id
 * in the Events module, named by the caller:
 *   - the same id again — a double press, a retry after a lost answer — is a
 *     replay: the app is asked again under that id (where it, too, is a
 *     replay), and the answer is the event as it was booked;
 *   - an id another conversation holds is `ID_IN_USE`;
 *   - a conversation that already has its event refuses a new id
 *     (`EVENT_ALREADY_BOOKED`, with the event's id): Create BEO opens it.
 *
 * ORDER. The app is asked first, outside any transaction here, so no row is
 * held while another service answers; then one transaction locks the
 * conversation, checks again, and writes the link, the pill and the audit row
 * together. If the app does not answer, nothing is written here and the press
 * can simply be made again (`EVENTS_CALENDAR_UNAVAILABLE`). If the commit here
 * fails after the app made the event, the same press again finds it there
 * (a replay) and links it. Two people pressing for one conversation at the
 * same moment with two different ids can leave the second's tentative event in
 * the app unlinked; the second is told `EVENT_ALREADY_BOOKED`.
 */

export interface BookDateDeps {
  db: Db;
  directory: OtoAppDirectory;
  log?: FastifyBaseLogger;
}

export const BOOK_DATE_MESSAGES = {
  notABirthday: 'Book Date is for conversations in Birthdays & Events.',
  alreadyBooked: 'This conversation already has its event in the Events calendar. Create BEO opens it.',
  branchNotFound: 'Branch not found',
  phoneUnreadable: 'That phone number could not be read. Check it, or leave it empty.',
  branchNotMapped: 'This park has no branch in the OTO App yet, so no event was made.',
  unavailable: 'The Events calendar did not answer, so no date was booked. Press Book Date again.',
} as const;

/** The audit action, and the operation name of its transaction. */
export const BOOK_DATE_ACTION = 'inbox.conversation.book_date';

/** May this person book the date here: the birthdays team, or `assign` at the conversation. */
function mayBook(
  ctx: ActionCtx,
  conv: { id: string; branchId: string | null },
  convTeam: { key: string; departmentId: string | null } | null,
): boolean {
  const assign: Permission = 'inbox:conversation:assign';
  if (
    hasPermission(ctx.effective, assign, {
      operatorId: ctx.viewer.operatorId,
      branchId: conv.branchId ?? undefined,
      departmentId: convTeam?.departmentId ?? undefined,
      recordId: conv.id,
    })
  ) {
    return true;
  }
  return (
    convTeam?.key === 'birthdays' &&
    convTeam.departmentId !== null &&
    ctx.viewer.scope.departmentIds.includes(convTeam.departmentId)
  );
}

/** "Mali's 6th Birthday", as the Events module's own form suggests ("e.g., Emma's 5th Birthday"). */
export function eventTitleOf(input: { childName: string | null; childAge: number | null; contactName: string }): string {
  const child = input.childName?.trim();
  if (!child) return `Birthday · ${input.contactName.trim()}`;
  if (input.childAge === null || input.childAge < 1) return `${child}'s Birthday`;
  const n = input.childAge;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${child}'s ${n}${suffix} Birthday`;
}

/** A status value in words, for an event whose status the app changed since: `in_progress` → "In progress". */
const statusWords = (value: string): string => {
  const words = value.replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : value;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/**
 * The conversation's event, as the inbox shows it: the `date_booked` pill's
 * record of what was booked, brought up to date from the Events module where
 * the inbox can read it (the app's published view, fenced by the park); as
 * booked when it cannot. Null when no date is booked.
 */
export async function conversationEventOf(
  db: Exec,
  operatorId: string,
  conv: { id: string; eventOrderRef: string | null },
): Promise<InboxConversationEvent | null> {
  const eventId = conv.eventOrderRef;
  if (!eventId) return null;
  const [pill] = await db
    .select({ actorAccountId: inboxEvent.actorAccountId, payload: inboxEvent.payload, createdAt: inboxEvent.createdAt })
    .from(inboxEvent)
    .where(
      and(
        eq(inboxEvent.operatorId, operatorId),
        eq(inboxEvent.conversationId, conv.id),
        eq(inboxEvent.kind, 'date_booked'),
        sql`${inboxEvent.payload}->>'eventId' = ${eventId}`,
      ),
    )
    .orderBy(desc(inboxEvent.createdAt))
    .limit(1);
  if (!pill) return null;
  const p = (pill.payload ?? {}) as Record<string, unknown>;
  const branchId = str(p.branchId);
  if (!branchId) return null;
  const booked: InboxConversationEvent = {
    id: eventId,
    title: str(p.title) ?? '',
    date: str(p.date) ?? '',
    startTime: str(p.startTime) ?? '',
    branchId,
    branchName: str(p.branchName),
    status: str(p.status) ?? 'tentative',
    statusName: str(p.statusName) ?? 'Tentative',
    kids: int(p.kids),
    adults: int(p.adults),
    bookedAt: pill.createdAt.toISOString(),
    bookedByAccountId: pill.actorAccountId,
    beoPath: beoPathOf(eventId),
  };
  const [park] = await db
    .select({ name: branch.name })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (park) booked.branchName = park.name;
  // The Events module is the master: a date moved or a status confirmed there
  // shows here. Its view is optional (a deployment without the app has none,
  // one without the grant refuses): the booking as made stands in for it.
  const live = await getBranchEvent(db, { branchId, eventId }).catch(() => null);
  if (!live) return booked;
  return {
    ...booked,
    title: live.title,
    date: live.startDate,
    startTime: live.startTime,
    status: live.status,
    statusName: live.status === booked.status ? booked.statusName : statusWords(live.status),
    kids: live.expectedKids,
    adults: live.expectedAdults,
  };
}

function refusalOf(outcome: Extract<DirectoryOutcome<DirectoryInboxEventAnswer>, { ok: false }>, eventId: string): AppError {
  if (outcome.code === 'OTOAPP_BRANCH_NOT_MAPPED') {
    return errors.conflict('EVENT_BRANCH_NOT_MAPPED', BOOK_DATE_MESSAGES.branchNotMapped);
  }
  if (outcome.code === 'OTOAPP_ID_IN_USE') return idInUse(eventId);
  if (outcome.retryable || outcome.code === DIRECTORY_NOT_CONFIGURED) {
    return new AppError(503, 'EVENTS_CALENDAR_UNAVAILABLE', BOOK_DATE_MESSAGES.unavailable);
  }
  return new AppError(502, 'EVENTS_CALENDAR_REFUSED', `The Events calendar did not take the date: ${outcome.message}`, {
    code: outcome.code,
  });
}

/**
 * Book Date on a birthday conversation (the route: `POST
 * /inbox/conversations/{id}/book-date`). See the module comment for the rules.
 * The answer is the route's whole body; a replay is marked (`markReplay`) so
 * the route can say so (`x-oto-replay`) without the mark reaching the wire or
 * the stored answer.
 */
export async function bookConversationDate(
  deps: BookDateDeps,
  ctx: ActionCtx,
  op: OpContext,
  input: InboxBookDateBody & { conversationId: string },
): Promise<InboxBookDateResult> {
  const { db } = deps;
  const { operatorId } = ctx.viewer;
  const conv = await loadVisibleConversation(db, ctx.viewer, input.conversationId);
  const [convTeam] = conv.teamId
    ? await db
        .select({ key: team.key, departmentId: team.departmentId })
        .from(team)
        .where(and(eq(team.operatorId, operatorId), eq(team.id, conv.teamId)))
        .limit(1)
    : [];
  if (!mayBook(ctx, conv, convTeam ?? null)) throw new PermissionDeniedError('inbox:conversation:assign');
  if (conv.category !== 'birthdays') throw errors.conflict('NOT_A_BIRTHDAY', BOOK_DATE_MESSAGES.notABirthday);

  // The id names the event: this conversation's own (a replay), another's (refused), or nobody's yet.
  const claim = await claimClientId(
    input.id.toLowerCase(),
    async (id) =>
      (
        await db
          .select({ id: conversation.id, operatorId: conversation.operatorId })
          .from(conversation)
          .where(eq(conversation.eventOrderRef, id))
          .limit(1)
      )[0],
    (row) => row.id === conv.id && row.operatorId === operatorId,
  );
  const eventId = claim.id;
  if (!claim.replay && conv.eventOrderRef) {
    throw errors.conflict('EVENT_ALREADY_BOOKED', BOOK_DATE_MESSAGES.alreadyBooked, { eventId: conv.eventOrderRef });
  }
  if (claim.replay) {
    const event = await conversationEventOf(db, operatorId, conv);
    if (event) return markReplay({ conversationId: conv.id, event, created: false });
  }

  const [park] = await db
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.id, input.branchId), eq(branch.operatorId, operatorId), isNull(branch.archivedAt)))
    .limit(1);
  if (!park) throw errors.notFound(BOOK_DATE_MESSAGES.branchNotFound);
  let phone: string | null = null;
  if (input.phone) {
    phone = normalizePhone(input.phone);
    if (!phone) throw errors.badRequest(BOOK_DATE_MESSAGES.phoneUnreadable);
  }
  const title = eventTitleOf(input);

  // The Events module first: nothing here is held while it answers.
  const outcome = deps.directory.createInboxEvent
    ? await deps.directory.createInboxEvent({
        id: eventId,
        coreBranchId: park.id,
        inboxConversationId: conv.id,
        title,
        eventDate: input.date,
        startTime: input.startTime,
        numChildren: input.kids,
        numAdults: input.adults,
        childName: input.childName || null,
        kidTurningAge: input.childAge,
        bookingName: input.contactName,
        parentName: input.contactName,
        whatsappPhone: phone,
      })
    : ({
        ok: false,
        status: null,
        code: DIRECTORY_NOT_CONFIGURED,
        message: 'This deployment has no OTO App directory configured',
        retryable: true,
      } as const);
  if (!outcome.ok) {
    const refusal = refusalOf(outcome, eventId);
    // Nothing was written here; the attempt is still on the record.
    await audit.record(db, {
      actorAccountId: ctx.viewer.accountId,
      operatorId,
      branchId: conv.branchId,
      action: `${BOOK_DATE_ACTION}.failed`,
      entityType: 'inbox.conversation',
      entityId: conv.id,
      after: { eventId, branchId: park.id, date: input.date, error: refusal.code, appCode: outcome.code },
      requestId: ctx.requestId,
    });
    deps.log?.warn({ conversationId: conv.id, code: outcome.code, status: outcome.status }, 'book date refused by the Events module');
    throw refusal;
  }
  const made = outcome.body.event;

  return withTx(db, op, BOOK_DATE_ACTION, async (tx) => {
    const [locked] = await tx
      .select({ id: conversation.id, eventOrderRef: conversation.eventOrderRef, branchId: conversation.branchId })
      .from(conversation)
      .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, conv.id)))
      .limit(1)
      .for('update');
    if (!locked) throw errors.notFound('Conversation not found');
    if (locked.eventOrderRef && locked.eventOrderRef !== eventId) {
      throw errors.conflict('EVENT_ALREADY_BOOKED', BOOK_DATE_MESSAGES.alreadyBooked, { eventId: locked.eventOrderRef });
    }
    if (locked.eventOrderRef !== eventId) {
      await tx
        .update(conversation)
        .set({ eventOrderRef: eventId, updatedAt: ctx.now })
        .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, conv.id)));
      const payload = {
        eventId,
        title: made.title,
        date: made.eventDate,
        startTime: made.startTime,
        branchId: park.id,
        branchName: park.name,
        kids: made.numChildren,
        adults: made.numAdults,
        status: made.status,
        statusName: made.statusName,
      };
      await tx.insert(inboxEvent).values({
        id: newId(),
        operatorId,
        conversationId: conv.id,
        kind: 'date_booked',
        actorKind: 'account',
        actorAccountId: ctx.viewer.accountId,
        payload,
        createdAt: ctx.now,
      });
      await audit.record(tx, {
        actorAccountId: ctx.viewer.accountId,
        operatorId,
        branchId: locked.branchId,
        action: BOOK_DATE_ACTION,
        entityType: 'inbox.conversation',
        entityId: conv.id,
        requestId: ctx.requestId,
        before: { eventOrderRef: null },
        after: { eventOrderRef: eventId, ...payload, replayedInApp: outcome.body.replayed },
      });
    }
    const event = await conversationEventOf(tx, operatorId, { id: conv.id, eventOrderRef: eventId });
    if (!event) throw new AppError(500, 'EVENT_NOT_RECORDED', 'The booking was not recorded on the conversation');
    const answer: InboxBookDateResult = { conversationId: conv.id, event, created: locked.eventOrderRef !== eventId };
    return locked.eventOrderRef === eventId ? markReplay(answer) : answer;
  });
}
