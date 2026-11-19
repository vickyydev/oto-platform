import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  Bot,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  FileText,
  Loader2,
  MoreHorizontal,
  PenLine,
  Plus,
  Repeat,
  RotateCcw,
} from 'lucide-react';
import { INBOX_CATEGORY_KEYS, type InboxCategoryKey } from '@oto/shared/inbox';
import { newId } from '@oto/shared/ids';
import { ApiError } from '@/api/client';
import { assistantApi } from '@/api/assistant';
import {
  inboxApi,
  type Assignee,
  type BookDateProposal,
  type ConversationDetail,
  type ConversationEvent,
  type ConversationRow,
  type InboxMe,
  type Message,
  type Prebooking,
} from '@/api/inbox';
import { openBlankTab, openConversationBeo } from '@/api/otoApp';
import { Avatar, ChannelDot } from '@/components/atoms';
import { BookDateDialog, type BookDateValues } from '@/components/BookDateDialog';
import {
  ACTION_WORD,
  ActionFeedback,
  ActionRow,
  ActionSection,
  ConversationFacts,
  MANAGERS_ADD_SUPPORT,
  NextStepCard,
  PersonRow,
  RowChevron,
  SECONDARY_BUTTON,
  SelectOver,
  actionsSubtitle,
} from '@/components/ChatActions';
import { COMPOSER_BAR, Composer, MANAGER_REOPENS, type InsertedTemplate } from '@/components/Composer';
import { ContactNameDialog } from '@/components/ContactDialogs';
import { CorrectAssistant, type CorrectionTarget } from '@/components/CorrectAssistant';
import {
  PrimaryMoveConfirm,
  START_OVER_LABEL,
  StartOverConfirm,
  TeamMoveConfirm,
  type PendingPrimaryMove,
  type PendingTeamMove,
} from '@/components/confirms';
import { Dialog } from '@/components/Dialog';
import { MessageBubble, ShadowBubble } from '@/components/MessageBubble';
import { OpenQuestionLine } from '@/components/OpenQuestionLine';
import { PendingControl } from '@/components/writes';
import { EDIT_NAME_LABEL } from '@/lib/contacts';
import { mayStartOver, sourceLabel } from '@/lib/inboxes';
import { depositPaidCard, isReadyToBook } from '@/lib/list-state';
import { openQuestionsByMessage } from '@/lib/open-question';
import { PARTY_REMOVED_LABEL, bookDateDraft, eventChipLabel, eventLinkOf, parseBeoFromConversation } from '@/lib/beo';
import {
  AI_ACTION_LABEL,
  AI_ACTION_NAME,
  BOOK_DATE_NOT_YOURS_REASON,
  CATEGORY_DOT,
  CATEGORY_LABEL,
  CATEGORY_SHORT,
  CHANNEL_LABEL,
  STATUS_LABEL,
  SUPPORT_FULL_HINT,
  WRITES_PENDING_REASON,
  aiStateLineFor,
  assigneeChip,
  attachmentNames,
  attachmentsOf,
  branchLabel,
  branchOutcome,
  branchSelectOptions,
  canHandle,
  HELD_IN_GENERAL_LABEL,
  MOVE_VALUE_GENERAL,
  categoryTitle,
  contactName,
  dayOf,
  effectiveBranchId,
  initialsOf,
  mayBookDate,
  moveOptions,
  moveOutcome,
  moveValue,
  primaryOf,
  slotOptions,
  supportCapLabel,
  supportsOf,
  teamDestLabel,
  timeline,
  tintFor,
  withdrawnNotes,
  writeMode,
  type MoveOption,
  type SlotOption,
} from '@/lib/view';

export interface Thread {
  detail: ConversationDetail | null;
  messages: Message[];
  olderCursor: string | null;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

type Busy = 'primary' | 'support' | 'divert' | 'move' | 'branch' | 'reopen' | 'ai' | 'book' | 'beo' | null;

/** The Book Date dialog while it is open: the event's id, minted once, and whether Save then opens the BEO. */
interface Booking {
  conversationId: string;
  eventId: string;
  thenBeo: boolean;
}

// Every category the api names, the playbook's GM queue (SCRUM-220) among them.
const CATEGORY_KEYS: readonly InboxCategoryKey[] = INBOX_CATEGORY_KEYS;
const categoryOf = (v: unknown): InboxCategoryKey | null =>
  CATEGORY_KEYS.includes(v as InboxCategoryKey) ? (v as InboxCategoryKey) : null;

function refusalOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * The chat panel (WhatsAppDemo.tsx `ChatPanel`, :1870-2062), from the api,
 * in the OTO look (SCRUM-1016): a header with the way back, the name, where
 * the chat came from, Mark as handled and one menu; one line for what the
 * assistant is doing, with its Pause or Resume; for a paid deposit the next
 * step; the thread; and the composer fixed at the bottom, always on screen.
 *
 * People and actions (ChatActions.dc.html) holds what the assignment strip
 * and the details dialog held: the primary and the support places with their
 * pickers, "Support 2/2" and Divert; the team, the park and the status, each
 * with its confirmation; the assistant's state; the contact and the member
 * link; rename; Start over on a test line; Book the date and Create BEO. It
 * is a sheet below the desktop panel's width (`detailsOpen`), and the right
 * panel beside the chat on a desktop (Desktop.dc.html); `panelWide` moves
 * that width out when the simulator's side panel takes the room.
 *
 * LIVE since I3b (SCRUM-588), behind the same write switch (`writeMode`).
 * Every refusal is the server's sentence, shown as it was said. While the api
 * says `writes: false` the same controls render disabled with their reason,
 * as in Cut A.
 *
 * Book Date and Create BEO (SCRUM-775, owner decision 4 November: the OTO
 * App's Events module is the one home for birthday orders): Book Date opens
 * a confirm read from the chat and books a TENTATIVE birthday there; the
 * conversation then shows "Event: <date> at <park>", which opens it. Create
 * BEO opens that event's BEO form in the OTO App through the suite hand-off,
 * booking the date first when there is no event yet. For the birthdays team
 * and the managers who assign; anyone else sees both disabled, with why.
 */
export function ChatPanel({
  row,
  thread,
  me,
  now,
  inserted,
  detailsOpen,
  onBack,
  onLoadOlder,
  onOpenDetails,
  onCloseDetails,
  onOpenTemplates,
  onAskHandle,
  onChanged,
  panelWide = false,
}: {
  row: ConversationRow;
  thread: Thread;
  me: InboxMe;
  now: Date;
  inserted: InsertedTemplate | null;
  /** People and actions as a sheet (the menu in the header; it holds the phone's team and status controls, test night U10). */
  detailsOpen: boolean;
  onBack: () => void;
  onLoadOlder: () => void;
  onOpenDetails: () => void;
  onCloseDetails: () => void;
  onOpenTemplates: () => void;
  onAskHandle: () => void;
  /** After a write: re-read the thread, the list and the dashboard. */
  onChanged: () => Promise<void>;
  /** The simulator's side panel is shown: the desktop panel waits for a wider screen (1760 px, not 1280). */
  panelWide?: boolean;
}) {
  const pending = writeMode(me) === 'disabled';
  const live = !pending;
  // The detail is fresher than the list row once it is in; until then the row
  // carries everything the header and the strip need.
  const detail = thread.detail?.id === row.id ? thread.detail : null;
  const conv: ConversationRow = detail ?? row;
  const name = contactName(conv.contact);
  const primary = primaryOf(conv);
  const supports = supportsOf(conv);
  const viewerIsPrimary = primary?.accountId === me.accountId;
  const handleable = canHandle(conv, me);
  const mayAssign = me.capabilities.assign || viewerIsPrimary;
  const reopenable = conv.status === 'handled' && me.capabilities.reopen;
  // Divert: only when the rule's pair has someone to hand it to (the api reads
  // it exactly as the divert route will), and only for the primary or a manager.
  const divertTo = detail?.divertTo ?? null;

  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  /** What an action did, in a line (test night U6, U9): the branch step's host, a move's new seats. */
  const [note, setNote] = useState<string | null>(null);
  const [pendingPrimary, setPendingPrimary] = useState<(PendingPrimaryMove & { option: SlotOption }) | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<(PendingTeamMove & { option: MoveOption }) | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<CorrectionTarget | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  /** SCRUM-860: the header's pencil — the name the inbox shows for this contact. */
  const [editingName, setEditingName] = useState(false);
  /** SCRUM-908: Start over on a conversation of the WhatsApp test line. */
  const [startingOver, setStartingOver] = useState(false);
  const [startOverBusy, setStartOverBusy] = useState(false);
  const [startOverError, setStartOverError] = useState<string | null>(null);

  // A refusal belongs to the conversation it was said about.
  useEffect(() => {
    setError(null);
    setNote(null);
    setPendingPrimary(null);
    setPendingMove(null);
    setCorrecting(null);
    setBooking(null);
    setBookError(null);
    setEditingName(false);
  }, [conv.id]);

  // SCRUM-821: the model reads the whole chat for Book Date. The read starts as
  // soon as a Birthdays & Events conversation opens, and again whenever its
  // newest message changes, so the dialog is complete when it appears rather
  // than three seconds later; one answer per (conversation, newest message).
  // A failure says nothing: the pattern reading stands.
  const newestMessageId = thread.messages.length > 0 ? thread.messages[thread.messages.length - 1]!.id : null;
  const [bookReading, setBookReading] = useState<{ convId: string; newestMessageId: string | null; answer: BookDateProposal | null; reading: boolean } | null>(null);
  useEffect(() => {
    if (conv.category !== 'birthdays' || !live) {
      setBookReading(null);
      return;
    }
    let gone = false;
    setBookReading((s) => (s && s.convId === conv.id && s.newestMessageId === newestMessageId ? s : { convId: conv.id, newestMessageId, answer: null, reading: true }));
    inboxApi.bookDateProposal(conv.id).then(
      (answer) => {
        if (!gone) setBookReading({ convId: conv.id, newestMessageId, answer, reading: false });
      },
      () => {
        if (!gone) setBookReading({ convId: conv.id, newestMessageId, answer: null, reading: false });
      },
    );
    return () => {
      gone = true;
    };
  }, [conv.id, conv.category, live, newestMessageId]);
  const bookProposal = bookReading && bookReading.convId === conv.id ? bookReading : null;

  // SCRUM-590 A3: the assistant's pause on this thread (§A.3 kill switch 3),
  // for whoever acts on it; and "Correct the assistant" for anyone who may write.
  // The line says the thread's state as the api says it (customer-AI test
  // night W4a: `aiState`, read optionally), else the number's mode first
  // (test night U5: "AI on · Pause" showed where the assistant was off):
  // nothing until the detail is in.
  const aiLine = detail ? aiStateLineFor(detail) : null;
  const aiPaused = aiLine?.kind === 'control' ? aiLine.paused : false;
  const mayPauseAi = live && (handleable || me.capabilities.assign);
  const mayCorrect = live;

  const run = async (what: Exclude<Busy, null>, fn: () => Promise<unknown>, fallback: string) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError(refusalOf(err, fallback));
    } finally {
      setBusy(null);
    }
  };

  // SCRUM-908: the test line's Start over — the conversation leaves the inbox,
  // so the panel closes first (it would read a thread that is no longer
  // there) and the list is read again.
  const testLine = (me.testLines ?? []).find((l) => l.id === conv.channelAccountId) ?? null;
  const startOverAllowed = live && mayStartOver(me, conv.channelAccountId);
  const confirmStartOver = async () => {
    setStartOverBusy(true);
    setStartOverError(null);
    try {
      await inboxApi.startOver(conv.id);
      setStartingOver(false);
      onBack();
      await onChanged();
    } catch (err) {
      setStartOverError(refusalOf(err, 'The conversation could not be cleared.'));
    } finally {
      setStartOverBusy(false);
    }
  };

  // The branch step says what it did (test night U9): the host it added on a
  // birthday thread, or why it did not, from the api's answer.
  const setBranch = (next: string | null) =>
    run(
      'branch',
      async () => {
        const r = await inboxApi.setBranch(conv.id, next);
        setNote(next === null ? null : branchOutcome(r, conv.assignments, me));
      },
      'The branch could not be changed.',
    );

  // The team badge asks first (test night U6): a move re-routes the thread and
  // seats people nobody named; the answer says who, afterwards.
  const askMove = (option: MoveOption) => {
    setMoveError(null);
    setPendingMove({ option, toTeamName: option.label, fromTeamName: detail?.teamName ?? teamDestLabel(conv, me) });
  };
  const confirmMove = async () => {
    if (!pendingMove) return;
    setBusy('move');
    setMoveError(null);
    try {
      const r = await inboxApi.move(conv.id, pendingMove.option.dest);
      setPendingMove(null);
      setNote(moveOutcome(r, me));
      await onChanged();
    } catch (err) {
      setMoveError(refusalOf(err, 'The conversation could not be moved.'));
    } finally {
      setBusy(null);
    }
  };

  const pickPrimary = async (option: SlotOption) => {
    setBusy('primary');
    setError(null);
    try {
      await inboxApi.setPrimary(conv.id, option.assignee);
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CATEGORY_MOVE_UNCONFIRMED') {
        // The server's confirmation: its sentence, and the move it means.
        const d = (err.details ?? {}) as Record<string, unknown>;
        setConfirmError(null);
        setPendingPrimary({
          option,
          name: option.label,
          fromCategory: categoryOf(d.fromCategory),
          toCategory: categoryOf(d.toCategory),
          toTeamName: typeof d.toTeamName === 'string' ? d.toTeamName : null,
        });
      } else {
        setError(refusalOf(err, 'The primary owner could not be changed.'));
      }
    } finally {
      setBusy(null);
    }
  };

  const confirmPrimary = async () => {
    if (!pendingPrimary) return;
    setBusy('primary');
    setConfirmError(null);
    try {
      await inboxApi.setPrimary(conv.id, pendingPrimary.option.assignee, true);
      setPendingPrimary(null);
      await onChanged();
    } catch (err) {
      setConfirmError(refusalOf(err, 'The primary owner could not be changed.'));
    } finally {
      setBusy(null);
    }
  };

  // Book Date and Create BEO (SCRUM-775).
  // SCRUM-820: a party deleted or archived in the Events module is no event to
  // open; the thread says so and the date can be booked again.
  const { event, removed: removedEvent } = eventLinkOf<ConversationEvent>(detail?.event);
  const mayBook = live && mayBookDate(me);
  // SCRUM-996: the paid deposit beside Book Date, for a person who may book —
  // the amount and the verified time come from the deposit read Book Date
  // itself uses, which the api refuses to anyone else. The row's label says
  // when to ask; nothing is asked for a chat without a paid deposit.
  const paidSignal = isReadyToBook(conv.depositSignal) ? conv.depositSignal ?? null : null;
  const booked = event !== null;
  const [paidDeposit, setPaidDeposit] = useState<{ convId: string; draft: NonNullable<Prebooking['draft']> } | null>(null);
  useEffect(() => {
    if (!mayBook || !paidSignal || conv.category !== 'birthdays' || booked) {
      setPaidDeposit(null);
      return;
    }
    let gone = false;
    inboxApi.prebooking(conv.id).then(
      (answer) => {
        if (!gone) setPaidDeposit(answer.draft?.state === 'paid' ? { convId: conv.id, draft: answer.draft } : null);
      },
      () => {
        if (!gone) setPaidDeposit(null);
      },
    );
    return () => {
      gone = true;
    };
  }, [conv.id, conv.category, mayBook, paidSignal, booked]);
  const paidCard = paidSignal && paidDeposit?.convId === conv.id ? depositPaidCard(paidDeposit.draft, paidSignal) : null;
  const askBookDate = (thenBeo: boolean) => {
    setBookError(null);
    setBooking({ conversationId: conv.id, eventId: newId(), thenBeo });
  };
  const readDeposit = async () => {
    const answer = await inboxApi.prebooking(conv.id);
    if (answer.draft)
      setBooking((b) => (b?.conversationId === conv.id ? { ...b, eventId: answer.draft!.id } : b));
    return answer;
  };
  const requestDeposit = async (
    values: BookDateValues,
    amountSatang: number,
    requestId: string,
  ) => {
    if (!booking) throw new Error('Open Book Date again.');
    const answer = await inboxApi.requestPrebooking(conv.id, {
      booking: { id: booking.eventId, ...values },
      amountSatang,
      requestId,
    });
    if (answer.draft)
      setBooking((b) => (b?.conversationId === conv.id ? { ...b, eventId: answer.draft!.id } : b));
    return answer;
  };
  // SCRUM-826: the dialog's "Fetch from chat" reads the conversation again, as the api holds it now.
  const fetchBookDate = () => inboxApi.bookDateProposal(conv.id);
  // Book Date and Create BEO say why they are off: writes not switched on here
  // yet (as every other control), or not this person's to press.
  const bookOffReason = live ? BOOK_DATE_NOT_YOURS_REASON : WRITES_PENDING_REASON;
  // SCRUM-660: Create BEO opens the form with its AI Fill run on the
  // conversation's confirmation (`aiFill`); the event chip opens it as it is.
  const openBeo = async (conversationId: string, tab: Window | null = openBlankTab(), aiFill = false) => {
    setBusy('beo');
    setError(null);
    try {
      await openConversationBeo(conversationId, tab, { aiFill });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The BEO could not be opened here.');
      // SCRUM-820: the party was removed in the Events module since the thread was read.
      if (err instanceof ApiError && err.code === 'EVENT_REMOVED') await onChanged();
    } finally {
      setBusy(null);
    }
  };
  const saveBooking = async (values: BookDateValues) => {
    if (!booking) return;
    // The BEO's tab is opened now, while Save is still a press, or the browser refuses it.
    const tab = booking.thenBeo ? openBlankTab() : null;
    setBusy('book');
    setBookError(null);
    try {
      const r = await inboxApi.bookDate(booking.conversationId, { id: booking.eventId, ...values });
      setBooking(null);
      setNote(`${eventChipLabel(eventChipOf(r.event))} · tentative in the Events calendar`);
      await onChanged();
      if (booking.thenBeo) await openBeo(r.conversationId, tab, true);
    } catch (err) {
      tab?.close();
      if (err instanceof ApiError && err.code === 'EVENT_ALREADY_BOOKED') {
        // Somebody booked it first: the conversation's event is the one to use.
        setBooking(null);
        setError(err.message);
        await onChanged();
      } else {
        setBookError(refusalOf(err, 'The date could not be booked.'));
      }
    } finally {
      setBusy(null);
    }
  };
  const eventChipOf = (ev: ConversationEvent) => ({
    date: ev.date,
    branchName: branchOptionLabel(ev.branchId) ?? ev.branchName,
    archived: ev.archived,
    // SCRUM-825: the deposit's state beside the date; an api from before it sends none.
    deposit: ev.deposit ?? null,
  });
  const branchOptionLabel = (branchId: string) => branchSelectOptions(me.teams).find((b) => b.value === branchId)?.label ?? null;
  const bookDraft = useMemo(
    () =>
      bookDateDraft(
        parseBeoFromConversation(conv, thread.messages, dayOf(now)),
        dayOf(now),
        effectiveBranchId(conv, me.teams),
      ),
    // Read when the dialog opens: the conversation and the lines loaded then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [booking?.eventId],
  );

  const items = useMemo(
    () =>
      timeline(thread.messages, thread.detail?.events ?? [], thread.olderCursor === null, {
        me,
        // SCRUM-823: the hand-over pill says who was told, and when the GM was.
        handoverNotices: thread.detail?.handoverNotices ?? [],
      }),
    [thread.messages, thread.detail, thread.olderCursor, me],
  );
  const withdrawn = useMemo(
    () => withdrawnNotes(thread.messages, thread.detail?.events ?? []),
    [thread.messages, thread.detail],
  );
  // The files the thread's events name (the brochure), for the bubbles' attachments.
  const fileNames = useMemo(() => attachmentNames(thread.detail?.events ?? []), [thread.detail]);
  // SCRUM-831: what the assistant asked and how it read each reply, by the line that asked.
  const asked = useMemo(() => openQuestionsByMessage(thread.detail?.openQuestions), [thread.detail]);

  // Open at the newest line, and follow new ones as they arrive — but not when
  // an older page was just put above what the reader is looking at.
  const scroller = useRef<HTMLDivElement>(null);
  const newest = thread.messages[thread.messages.length - 1]?.id;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.id, newest]);

  const moves = moveOptions(me);
  const currentMove = moveValue(conv, me);
  // The park the thread is at, which for a reception thread with no branch of
  // its own is its desk's (test night U9: "All Branches" on a thread pinned to
  // Central Floresta).
  const branchValue = effectiveBranchId(conv, me.teams) ?? '';
  const supportCap = me.capabilities.assign ? supportCapLabel(supports.length) : null;
  const reopen = () => void run('reopen', () => inboxApi.reopen(conv.id), 'The conversation could not be reopened.');
  const toggleAi = () => {
    if (aiLine?.kind !== 'control') return;
    void run(
      'ai',
      () => (aiLine.action === 'resume' ? assistantApi.resume(conv.id) : assistantApi.pause(conv.id)),
      aiLine.action === 'resume' ? 'The assistant could not be resumed here.' : 'The assistant could not be paused here.',
    );
  };
  const aiTitle =
    aiLine?.kind === 'control' && aiLine.action === 'resume'
      ? 'The assistant stays quiet on this conversation. Resume to let it answer again.'
      : 'Stop the assistant answering on this conversation. Lines not yet sent are withdrawn.';
  // The next-step card stands in the chat below the panel's width and in the
  // panel beside it: the same card, one place at each width.
  const panelOn = panelWide ? 'min-[1760px]:flex' : 'xl:flex';
  const panelOff = panelWide ? 'min-[1760px]:hidden' : 'xl:hidden';
  const showCard = conv.category === 'birthdays' && !event && mayBook && paidCard !== null;
  const card = (stacked: boolean, className = '') =>
    paidCard && (
      <NextStepCard
        card={paidCard}
        busy={busy !== null}
        beoBusy={busy === 'beo'}
        onBook={() => askBookDate(false)}
        onBeo={() => askBookDate(true)}
        stacked={stacked}
        className={className}
      />
    );
  const park = effectiveBranchId(conv, me.teams);
  const topicPark = [CATEGORY_SHORT[conv.category], park ? branchLabel(park, me.teams) : null].filter(Boolean).join(' · ');
  const peopleNames = [primary ? `Primary: ${assigneeChip(primary, me).name}` : 'Unassigned', ...supports.map((s) => `Support: ${assigneeChip(s, me).name}`)].join('. ');

  const markHandled = (wide: boolean) =>
    handleable &&
    (pending ? (
      <PendingControl
        reason={WRITES_PENDING_REASON}
        label="Mark as handled"
        className={wide ? `${SECONDARY_BUTTON} h-12 w-full border-ink text-[15px] font-bold` : HEADER_ICON}
      >
        <CheckCircle2 aria-hidden className="h-5 w-5" />
        {wide && 'Mark as handled'}
      </PendingControl>
    ) : (
      <button
        type="button"
        onClick={() => {
          // From the sheet, the sheet steps aside for the confirmation.
          if (wide) onCloseDetails();
          onAskHandle();
        }}
        disabled={busy !== null}
        aria-label={wide ? undefined : 'Mark as handled'}
        title="Mark as handled"
        className={wide ? `${SECONDARY_BUTTON} h-12 w-full border-ink text-[15px] font-bold` : `${HEADER_ICON} md:w-auto md:gap-2 md:rounded-xl md:border md:border-edge md:bg-card md:px-3.5 md:text-[13.5px] md:font-semibold`}
      >
        <CheckCircle2 aria-hidden className="h-[22px] w-[22px] md:h-[18px] md:w-[18px]" />
        <span className={wide ? '' : 'hidden md:inline'}>Mark as handled</span>
      </button>
    ));

  /** People and actions: the sheet's body and the desktop panel's, the same parts. */
  const actions = (where: 'sheet' | 'panel') => (
    <div className="flex flex-col gap-4">
      {where === 'sheet' && (
        <ActionFeedback error={error} note={note} onDismissError={() => setError(null)} onDismissNote={() => setNote(null)} />
      )}
      <ActionSection title="People">
        {primary ? (
          <PersonRow chip={assigneeChip(primary, me)} role="Primary · answers this chat">
            {live && mayAssign ? (
              <PeoplePicker label="Set primary" word="Change" options={slotOptions(conv, me, 'primary')} disabled={busy !== null} onPick={(o) => void pickPrimary(o)} />
            ) : (
              pending &&
              mayAssign && (
                <PendingControl reason={WRITES_PENDING_REASON} label="Change the primary owner" className={ACTION_WORD}>
                  Change
                </PendingControl>
              )
            )}
          </PersonRow>
        ) : live && mayAssign ? (
          <div className="flex min-h-14 items-center px-2">
            <PeoplePicker
              label="Set primary"
              word="Assign primary"
              icon
              options={slotOptions(conv, me, 'primary')}
              disabled={busy !== null}
              onPick={(o) => void pickPrimary(o)}
            />
          </div>
        ) : (
          <div className="flex min-h-14 items-center gap-3 px-3.5">
            <span className="rounded-lg bg-needs px-2 py-1 text-[12.5px] font-semibold text-needs-ink">Unassigned</span>
          </div>
        )}
        {supports.map((s, i) => (
          <PersonRow key={s.assignmentId} chip={assigneeChip(s, me)} role={`Support · ${i + 1} of 2`}>
            {live && me.capabilities.assign && (
              <>
                <PeoplePicker
                  label="Set support"
                  word="Change"
                  options={slotOptions(conv, me, 'support')}
                  disabled={busy !== null}
                  // A different person in this place: release it, then seat them.
                  onPick={(o) =>
                    void run(
                      'support',
                      async () => {
                        await inboxApi.removeSupport(conv.id, s.assignmentId);
                        await inboxApi.addSupport(conv.id, o.assignee.id);
                      },
                      'Support could not be changed.',
                    )
                  }
                />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run('support', () => inboxApi.removeSupport(conv.id, s.assignmentId), 'Support could not be removed.')}
                  aria-label={`Remove support: ${assigneeChip(s, me).name}`}
                  className={ACTION_WORD}
                >
                  Remove
                </button>
              </>
            )}
          </PersonRow>
        ))}
        <PeopleFooter>
          {supportCap && (
            // Both places taken (test night U4): say so where "Add support" sat,
            // with the api's own reason, rather than let the button vanish.
            // Its reason said on the sheet, not only in a tooltip (SCRUM-1016).
            <span className="flex min-h-12 flex-col items-center justify-center px-3 py-1.5 text-center">
              <span className="text-[14px] font-semibold text-ink-muted">{supportCap}</span>
              <span className="text-[12px] text-ink-muted">{SUPPORT_FULL_HINT}</span>
            </span>
          )}
          {me.capabilities.assign &&
            supportCap === null &&
            (live ? (
              <PeoplePicker
                label="Set support"
                word="Add support"
                icon
                options={slotOptions(conv, me, 'support')}
                disabled={busy !== null}
                onPick={(o) => void run('support', () => inboxApi.addSupport(conv.id, o.assignee.id), 'Support could not be added.')}
                className={FOOTER_WORD}
              />
            ) : (
              <PendingControl reason={WRITES_PENDING_REASON} label="Add support" className={FOOTER_WORD}>
                <Plus aria-hidden className="h-4 w-4" />
                Add support
              </PendingControl>
            ))}
          {mayAssign &&
            primary?.assigneeKind === 'account' &&
            (pending ? (
              <PendingControl reason={WRITES_PENDING_REASON} label="Divert to the backup" className={FOOTER_WORD}>
                <Repeat aria-hidden className="h-4 w-4" />
                Divert
              </PendingControl>
            ) : (
              divertTo && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run('divert', () => inboxApi.divert(conv.id), 'The conversation could not be diverted.')}
                  title={`Divert to ${divertTo.name ?? 'the backup'}`}
                  aria-label={`Divert to ${divertTo.name ?? 'the backup'}`}
                  className={FOOTER_WORD}
                >
                  {busy === 'divert' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Repeat aria-hidden className="h-4 w-4" />}
                  Divert to {divertTo.name ?? 'the backup'}
                </button>
              )
            ))}
          {!me.capabilities.assign && (
            <span className="flex min-h-12 items-center px-3.5 text-[13px] text-ink-muted">{MANAGERS_ADD_SUPPORT}</span>
          )}
        </PeopleFooter>
      </ActionSection>

      {/* The team and status controls a phone had in the details (test night U10), for those who hold them. */}
      <div data-phone-actions={live && (me.capabilities.move || handleable || reopenable) ? 'true' : undefined}>
      <ActionSection title="This conversation">
        <ActionRow
          label="Team"
          title={categoryTitle(conv.category, detail?.teamName ?? null)}
          action={
            me.capabilities.move &&
            (pending ? (
              <PendingControl reason={WRITES_PENDING_REASON} label="Move to another team" className={ACTION_WORD}>
                <RowChevron />
              </PendingControl>
            ) : (
              <SelectOver
                label="Move to team"
                value={currentMove}
                disabled={busy !== null}
                onChange={(v) => {
                  const opt = moves.find((m) => m.value === v);
                  if (!opt || opt.value === currentMove) return;
                  // From the sheet, the sheet steps aside for the confirmation (as the details dialog did, U10).
                  if (where === 'sheet') onCloseDetails();
                  askMove(opt);
                }}
                cover
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                options={
                  <>
                    {/* SCRUM-789: held in the General inbox — no team is the current one, every team is offered. */}
                    {currentMove === MOVE_VALUE_GENERAL && (
                      <option value={MOVE_VALUE_GENERAL} disabled>
                        {HELD_IN_GENERAL_LABEL}
                      </option>
                    )}
                    {moves.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </>
                }
              >
                <RowChevron />
              </SelectOver>
            ))
          }
        >
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_DOT[conv.category]}`} />
          <span className="truncate">{me.capabilities.move ? teamDestLabel(conv, me) : CATEGORY_LABEL[conv.category]}</span>
        </ActionRow>
        <ActionRow
          label="Park"
          action={
            me.capabilities.assign && live ? (
              <SelectOver
                label="Conversation branch"
                value={branchValue}
                disabled={busy !== null}
                onChange={(v) => {
                  const next = v || null;
                  if (next !== conv.branchId) void setBranch(next);
                }}
                cover
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                options={branchSelectOptions(me.teams).map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              >
                <RowChevron />
              </SelectOver>
            ) : (
              pending &&
              me.capabilities.assign && (
                <PendingControl reason={WRITES_PENDING_REASON} label="Change the branch" className={ACTION_WORD}>
                  <RowChevron />
                </PendingControl>
              )
            )
          }
        >
          <span className="truncate">{branchLabel(branchValue || null, me.teams)}</span>
        </ActionRow>
        <ActionRow
          label="Status"
          action={
            (handleable || reopenable) &&
            (pending ? (
              <PendingControl
                reason={WRITES_PENDING_REASON}
                label={conv.status === 'handled' ? 'Reopen' : 'Mark as handled'}
                className={ACTION_WORD}
              >
                <RowChevron />
              </PendingControl>
            ) : (
              <SelectOver
                label="Set conversation status"
                value={conv.status === 'handled' ? 'handled' : 'new'}
                disabled={busy !== null}
                onChange={(v) => {
                  if (v === 'handled') {
                    if (where === 'sheet') onCloseDetails();
                    onAskHandle();
                  } else reopen();
                }}
                cover
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                options={
                  <>
                    <option value="new">Active</option>
                    <option value="handled">Handled</option>
                  </>
                }
              >
                <RowChevron />
              </SelectOver>
            ))
          }
        >
          {STATUS_LABEL[conv.status]}
        </ActionRow>
        {mayPauseAi && aiLine && (
          <ActionRow
            label="Assistant"
            action={
              aiLine.kind === 'control' && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={toggleAi}
                  aria-label={AI_ACTION_NAME[aiLine.action]}
                  title={aiTitle}
                  className={ACTION_WORD}
                >
                  {AI_ACTION_LABEL[aiLine.action]}
                </button>
              )
            }
          >
            <span className="truncate">{aiLine.text}</span>
          </ActionRow>
        )}
      </ActionSection>
      </div>

      {conv.category === 'birthdays' && (
        <ActionSection title="Party" card={false}>
          <div className="flex flex-col gap-2">
            {event ? (
              <div className="grid grid-cols-2 gap-2">
                {/* The prototype's booked state (:1986-1996): the date is held, the press is spent. An event archived in the Events module says so; it is restored there. */}
                <button
                  type="button"
                  disabled
                  title={
                    event.archived
                      ? 'The event was archived in the Events calendar. Restore it there to use it again.'
                      : 'Date already blocked in the Events calendar'
                  }
                  className={`${SECONDARY_BUTTON} h-12 cursor-default border-money-line bg-money text-money-ink`}
                >
                  <Calendar aria-hidden className="h-4 w-4" />
                  {event.archived ? 'Event archived' : 'Date Booked'}
                </button>
                <button
                  type="button"
                  onClick={() => void openBeo(conv.id, undefined, true)}
                  disabled={busy !== null}
                  title="Open this event's BEO in the OTO App"
                  className={`${SECONDARY_BUTTON} h-12`}
                >
                  {busy === 'beo' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <FileText aria-hidden className="h-4 w-4" />}
                  Create BEO
                </button>
              </div>
            ) : showCard ? (
              where === 'sheet' && <p className="px-1 text-[13px] text-ink-muted">The deposit is paid: Book the date is at the top of the chat.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {mayBook ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (where === 'sheet') onCloseDetails();
                        askBookDate(false);
                      }}
                      disabled={busy !== null}
                      title="Block this date in the Events calendar"
                      className="inline-flex h-12 items-center justify-center gap-2 rounded-[13px] bg-coral px-3 text-[14.5px] font-bold text-on-coral hover:bg-coral/90 disabled:opacity-60"
                    >
                      <Calendar aria-hidden className="h-4 w-4" />
                      Book the date
                    </button>
                  ) : (
                    <PendingControl
                      reason={bookOffReason}
                      label="Book the date"
                      className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-[13px] bg-coral px-3 text-[14.5px] font-bold text-on-coral"
                    >
                      <Calendar aria-hidden className="h-4 w-4" />
                      Book the date
                    </PendingControl>
                  )}
                  {mayBook ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (where === 'sheet') onCloseDetails();
                        askBookDate(true);
                      }}
                      disabled={busy !== null}
                      title="Book the date, then open its BEO in the OTO App"
                      className={`${SECONDARY_BUTTON} h-12`}
                    >
                      {busy === 'beo' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <FileText aria-hidden className="h-4 w-4" />}
                      Create BEO
                    </button>
                  ) : (
                    <PendingControl reason={bookOffReason} label="Create BEO" className={`${SECONDARY_BUTTON} h-12 w-full`}>
                      <FileText aria-hidden className="h-4 w-4" />
                      Create BEO
                    </PendingControl>
                  )}
                </div>
                {/* Why both are off, said on the page and not only in a tooltip (SCRUM-1016). */}
                {!mayBook && <p className="px-1 text-[12.5px] text-ink-muted" data-testid="book-off-reason">{bookOffReason}</p>}
              </>
            )}
            {event && (
              <button
                type="button"
                onClick={() => void openBeo(conv.id)}
                disabled={busy !== null}
                title={`${event.title} · ${event.archived ? 'Archived' : event.statusName} in the Events calendar. Opens it in the OTO App.`}
                data-testid="event-chip"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-left text-[13.5px] font-semibold text-ink hover:bg-wash disabled:opacity-60"
              >
                <Calendar aria-hidden className="h-4 w-4 shrink-0 text-ink-soft" />
                {eventChipLabel(eventChipOf(event))}
              </button>
            )}
            {removedEvent && (
              // SCRUM-820: said, never pressed — there is no BEO to open.
              <span
                title={`${removedEvent.title} was deleted or archived in the Events calendar. Book the date books it again.`}
                data-testid="event-chip-removed"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-band px-3 py-2 text-[13.5px] font-semibold text-ink-soft"
              >
                <Calendar aria-hidden className="h-4 w-4 shrink-0" />
                {PARTY_REMOVED_LABEL}
              </span>
            )}
          </div>
        </ActionSection>
      )}

      <ActionSection title="Details" card={false}>
        <ConversationFacts row={conv} detail={detail} now={now} />
        {(live && !conv.contact.erased) || startOverAllowed ? (
          <div className="flex flex-wrap gap-2">
            {/* SCRUM-860: the name staff set shows in the chat, the list and the search; an erased contact has no name to edit. */}
            {live && !conv.contact.erased && (
              <button
                type="button"
                onClick={() => {
                  if (where === 'sheet') onCloseDetails();
                  setEditingName(true);
                }}
                aria-label={EDIT_NAME_LABEL}
                className={`${SECONDARY_BUTTON} min-h-11`}
              >
                <PenLine aria-hidden className="h-4 w-4" />
                {EDIT_NAME_LABEL}
              </button>
            )}
            {startOverAllowed && (
              <button
                type="button"
                onClick={() => {
                  if (where === 'sheet') onCloseDetails();
                  setStartOverError(null);
                  setStartingOver(true);
                }}
                aria-label={START_OVER_LABEL}
                title={`${START_OVER_LABEL} — test line`}
                className={`${SECONDARY_BUTTON} min-h-11`}
              >
                <RotateCcw aria-hidden className="h-4 w-4" />
                {START_OVER_LABEL}
              </button>
            )}
          </div>
        ) : null}
      </ActionSection>
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Header (Chat.dc.html): back, the face, the name and where the chat came from, Mark as handled, one menu. */}
        <header className="flex shrink-0 items-center gap-1 border-b border-line bg-card px-1 py-2 md:gap-3 md:px-5 md:py-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to the conversations"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-ink hover:bg-wash md:hidden"
          >
            <ChevronLeft aria-hidden className="h-6 w-6" />
          </button>
          <div className="relative shrink-0">
            <Avatar initials={initialsOf(name)} tint={tintFor(conv.contact.id)} size={40} />
            <ChannelDot channel={conv.channel} />
          </div>
          <div className="min-w-0 flex-1 pl-2 md:pl-0">
            <h2 className="truncate text-[16px] font-bold tracking-[-0.01em] text-ink">{name}</h2>
            <p className="truncate text-[12.5px] text-ink-muted">
              {/* The number it came in on (SCRUM-220 playbook), not the bare channel; its channel in the title. */}
              <span title={CHANNEL_LABEL[conv.channel]}>{sourceLabel(conv.channel, conv.channelAccountName)}</span>
              {topicPark && ` · ${topicPark}`}
            </p>
          </div>
          {busy !== null && busy !== 'divert' && (
            <Loader2 role="status" aria-label="Working" className="h-4 w-4 shrink-0 animate-spin text-ink-muted" />
          )}
          {markHandled(false)}
          <button
            type="button"
            onClick={onOpenDetails}
            aria-label="People and actions"
            title="People and actions"
            className={`${HEADER_ICON} ${panelOff}`}
          >
            <MoreHorizontal aria-hidden className="h-[22px] w-[22px]" />
          </button>
        </header>

        {/* The assistant's line (SCRUM-590 A3, Chat.dc.html): its state, why, and Pause or Resume. */}
        {mayPauseAi && aiLine && (
          <div
            data-ai-state={detail?.aiMode}
            className="flex shrink-0 items-center gap-2 border-b border-mint-line bg-mint-soft py-0.5 pl-4 pr-2 text-teal md:py-1.5 md:pl-5"
          >
            <Bot aria-hidden className="h-[18px] w-[18px] shrink-0" />
            <span className="min-w-0 flex-1 truncate py-2 text-[13px]">
              <strong className="font-bold">{aiLine.text}</strong>
              {aiLine.kind === 'control' && ` · ${aiLine.hint}`}
            </span>
            {aiLine.kind === 'control' && (
              <button
                type="button"
                data-ai-state={detail?.aiMode}
                data-ai-action={aiLine.action}
                disabled={busy !== null}
                aria-pressed={aiPaused}
                aria-label={AI_ACTION_NAME[aiLine.action]}
                onClick={toggleAi}
                title={aiTitle}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-mint-edge bg-card px-3.5 text-[13px] font-semibold text-teal hover:bg-mint disabled:opacity-60 md:h-8"
              >
                {busy === 'ai' && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
                {AI_ACTION_LABEL[aiLine.action]}
              </button>
            )}
            <button
              type="button"
              onClick={onOpenDetails}
              aria-label={peopleNames}
              title={peopleNames}
              className={`flex h-11 shrink-0 items-center px-1 ${panelOff}`}
            >
              {[primary, ...supports].filter((a): a is Assignee => a !== undefined).map((a, i) => {
                const chip = assigneeChip(a, me);
                return (
                  <span
                    key={a.assignmentId}
                    aria-hidden
                    className={`flex h-7 w-7 items-center justify-center rounded-full border-2 border-mint-soft text-[10.5px] font-bold ${chip.tint} ${i > 0 ? '-ml-2' : ''}`}
                  >
                    {chip.initials}
                  </span>
                );
              })}
            </button>
          </div>
        )}

        {showCard && card(false, `mx-4 mt-3 shrink-0 md:mx-5 ${panelOff}`)}

        <ActionFeedback
          error={error}
          note={note}
          onDismissError={() => setError(null)}
          onDismissNote={() => setNote(null)}
          className="mx-4 mt-3 shrink-0 md:mx-5"
        />
        {pending && (
          <p className="mx-4 mt-2 shrink-0 text-[12.5px] text-ink-muted md:mx-5">
            Assigning, moving, handling and replying are {WRITES_PENDING_REASON.toLowerCase()}.
          </p>
        )}

        {/* Timeline: the one part of the chat that scrolls. */}
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-ground px-4 py-3.5 md:px-6 md:py-5">
          <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
            {thread.olderCursor !== null && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={onLoadOlder}
                  disabled={thread.loadingOlder}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-card px-4 text-[12.5px] font-semibold text-ink-soft ring-1 ring-line hover:bg-wash md:min-h-8"
                >
                  {thread.loadingOlder && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
                  Earlier messages
                </button>
              </div>
            )}
            {thread.loading && thread.messages.length === 0 && (
              <div className="flex justify-center py-8 text-ink-muted">
                <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
              </div>
            )}
            {thread.error && (
              <div role="alert" className="rounded-2xl bg-danger px-3.5 py-2 text-[13px] text-danger-ink ring-1 ring-danger-line">
                {thread.error}
              </div>
            )}
            {items.map((it) =>
              it.kind === 'shadow' ? (
                <ShadowBubble key={it.id} text={it.text} at={it.at} now={now} {...(it.label ? { label: it.label } : {})} />
              ) : it.kind === 'group' ? (
                // One moment's pills in one line (customer-AI test night, W7), the pills under it on a press.
                <details key={it.id} className="my-0.5 flex flex-col items-center gap-1" data-pill-group={it.pills.length}>
                  <summary className="mx-auto flex min-h-11 max-w-[90%] cursor-pointer list-none items-center gap-1.5 rounded-full bg-band px-3 text-center text-[12px] text-ink-soft hover:bg-line md:min-h-0 md:py-1.5">
                    <span className="min-w-0">{it.summary}</span>
                    <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  </summary>
                  <div className="mt-1 flex flex-col items-center gap-1">
                    {it.pills.map((p) => (
                      <Pill key={p.id} text={p.text} />
                    ))}
                  </div>
                </details>
              ) : it.kind === 'pill' ? (
                <div key={it.id} className="my-0.5 flex flex-col items-center gap-0.5">
                  <Pill text={it.text} />
                  {/* "AI left this one for the team" keeps its correction in view, never folded into a group. */}
                  {it.event === 'ai_silent' && mayCorrect && (
                    <button
                      type="button"
                      onClick={() => setCorrecting({ at: it.at })}
                      className="inline-flex min-h-11 items-center gap-1 px-2 text-[11.5px] font-semibold text-teal underline underline-offset-2 hover:no-underline md:min-h-0 md:py-1"
                    >
                      <PenLine aria-hidden className="h-3.5 w-3.5" />
                      Correct the assistant
                    </button>
                  )}
                </div>
              ) : (
                <Fragment key={it.message.id}>
                  <MessageBubble
                    m={it.message}
                    me={me}
                    now={now}
                    withdrawnNote={withdrawn.get(it.message.id)}
                    attachments={attachmentsOf(it.message, fileNames)}
                    onCorrect={mayCorrect ? () => setCorrecting({ messageId: it.message.id }) : undefined}
                  />
                  <OpenQuestionLine questions={asked.get(it.message.id) ?? []} />
                </Fragment>
              ),
            )}
            {conv.status === 'handled' && (
              <div className="mt-2 flex justify-center">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-money-badge px-3 py-1.5 text-[12px] font-semibold text-money-ink">
                  <Archive aria-hidden className="h-3.5 w-3.5" /> Conversation closed · Will reopen if customer replies
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Composer: fixed at the bottom of the chat, at every width. */}
        {live ? (
          <Composer
            key={conv.id}
            conv={conv}
            me={me}
            inserted={inserted}
            onOpenTemplates={onOpenTemplates}
            onSent={() => void onChanged()}
            onReopen={reopen}
            reopening={busy === 'reopen'}
          />
        ) : (
          <PendingComposer conv={conv} me={me} onOpenTemplates={onOpenTemplates} />
        )}
      </div>

      {/* The desktop's right panel (Desktop.dc.html): the next step, then People and actions. */}
      <aside
        aria-label="About this conversation"
        data-region="customer-panel"
        className={`hidden w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-ground p-4 ${panelOn}`}
      >
        {showCard && card(true)}
        {actions('panel')}
      </aside>

      <Dialog
        open={detailsOpen}
        onClose={onCloseDetails}
        sheet
        title={name}
        subtitle={actionsSubtitle(conv, detail)}
        closeLabel="Close people and actions"
        footer={handleable ? markHandled(true) : undefined}
      >
        {actions('sheet')}
      </Dialog>

      {correcting && (
        <CorrectAssistant
          target={correcting}
          messages={thread.messages}
          events={thread.detail?.events ?? []}
          intent={conv.intent}
          category={conv.category}
          language={conv.language}
          onClose={() => setCorrecting(null)}
        />
      )}

      <PrimaryMoveConfirm
        pending={pendingPrimary}
        busy={busy === 'primary'}
        error={confirmError}
        onCancel={() => setPendingPrimary(null)}
        onConfirm={() => void confirmPrimary()}
      />
      <TeamMoveConfirm
        pending={pendingMove}
        busy={busy === 'move'}
        error={moveError}
        onCancel={() => setPendingMove(null)}
        onConfirm={() => void confirmMove()}
      />
      {conv.category === 'birthdays' && (
        <BookDateDialog
          open={booking !== null && booking.conversationId === conv.id}
          customer={name}
          initial={bookDraft}
          branches={branchSelectOptions(me.teams).filter((b) => b.value !== '')}
          busy={busy === 'book'}
          error={bookError}
          thenOpensBeo={booking?.thenBeo ?? false}
          onCancel={() => setBooking(null)}
          onSave={(values) => void saveBooking(values)}
          proposal={bookProposal?.answer ?? null}
          reading={bookProposal?.reading ?? false}
          onFetch={fetchBookDate}
          onReadDeposit={readDeposit}
          onRequestDeposit={me.capabilities.assign ? requestDeposit : undefined}
        />
      )}
      <ContactNameDialog open={editingName} onClose={() => setEditingName(false)} row={conv} now={now} onChanged={onChanged} />
      <StartOverConfirm
        open={startingOver}
        busy={startOverBusy}
        error={startOverError}
        lineName={testLine?.displayName ?? sourceLabel(conv.channel, conv.channelAccountName)}
        onCancel={() => {
          if (!startOverBusy) setStartingOver(false);
        }}
        onConfirm={() => void confirmStartOver()}
      />
    </div>
  );
}

/** The header's 44 px icon controls (Chat.dc.html). */
const HEADER_ICON = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-ink hover:bg-wash disabled:opacity-60';
/** A word in the People card's footer (Add support, Divert): the full cell, 48 px. */
const FOOTER_WORD =
  'inline-flex min-h-12 w-full items-center justify-center gap-1.5 px-3 text-[14px] font-semibold text-ink hover:bg-wash disabled:opacity-60';

/** The People card's footer: its cells side by side under a rule, as ChatActions.dc.html draws them. */
function PeopleFooter({ children }: { children: ReactNode }) {
  return (
    <div className="grid auto-cols-fr grid-flow-col border-t border-line-soft empty:hidden [&>*+*]:border-l [&>*+*]:border-line-soft">
      {children}
    </div>
  );
}

/**
 * The primary and support pickers (`SlotPicker`, WhatsAppDemo.tsx :753-824):
 * a word — "Change", "Assign primary", "Add support" — with the native select
 * of the people who may take the place laid over it.
 */
function PeoplePicker({
  label,
  word,
  options,
  onPick,
  disabled,
  icon = false,
  className = ACTION_WORD,
}: {
  label: string;
  word: string;
  options: SlotOption[];
  onPick: (option: SlotOption) => void;
  disabled: boolean;
  icon?: boolean;
  className?: string;
}) {
  return (
    <SelectOver
      label={label}
      value="__placeholder__"
      disabled={disabled}
      onChange={(v) => {
        const picked = options.find((o) => o.value === v);
        if (picked) onPick(picked);
      }}
      className={className}
      options={
        <>
          {/* A hidden anchor, so React always has a matching option for the value. */}
          <option value="__placeholder__" hidden>
            Pick someone…
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </>
      }
    >
      {icon && <Plus aria-hidden className="h-4 w-4" />}
      {word}
    </SelectOver>
  );
}

/** A system event's pill on the band (:2019-2023; Chat.dc.html). */
function Pill({ text }: { text: string }) {
  return (
    <span className="max-w-[90%] rounded-full bg-band px-3 py-1.5 text-center text-[12px] text-ink-soft">{text}</span>
  );
}

/** The composer while the write switch is off (Cut A): every control there, disabled, with its reason. */
function PendingComposer({
  conv,
  me,
  onOpenTemplates,
}: {
  conv: ConversationRow;
  me: InboxMe;
  onOpenTemplates: () => void;
}) {
  return (
    <div className={COMPOSER_BAR}>
      {!conv.canReply ? (
        <div className="flex min-h-11 items-center gap-2 rounded-2xl bg-band px-4 py-2 text-[13.5px] text-ink-soft">
          Notices from the till — this thread cannot take a reply.
        </div>
      ) : conv.status === 'handled' ? (
        <div className="flex min-h-11 items-center justify-between gap-2 rounded-2xl bg-band px-4 py-2 text-[13.5px] text-ink-soft">
          <span>Handled — composer disabled</span>
          {me.capabilities.reopen ? (
            <PendingControl reason={WRITES_PENDING_REASON} label="Reopen" className="min-h-11 px-3 text-[13.5px] font-bold text-ink md:min-h-9">
              Reopen
            </PendingControl>
          ) : (
            <span className="text-[13px]">{MANAGER_REOPENS}</span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onOpenTemplates}
            aria-label="Templates"
            title="Templates"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-wash"
          >
            <FileText aria-hidden className="h-[22px] w-[22px]" />
          </button>
          <input
            disabled
            aria-label="Reply"
            placeholder={`Replying is ${WRITES_PENDING_REASON.toLowerCase()}`}
            className="h-11 min-w-0 flex-1 cursor-not-allowed rounded-[22px] border border-field bg-ground px-4 text-[15px] placeholder:text-ink-muted"
          />
        </div>
      )}
    </div>
  );
}
