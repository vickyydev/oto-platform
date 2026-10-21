import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  Bot,
  Calendar,
  CheckCircle2,
  ChevronDown,
  FileText,
  Loader2,
  MapPin,
  MoreHorizontal,
  PauseCircle,
  PenLine,
  PlayCircle,
  Plus,
  Repeat,
  X,
} from 'lucide-react';
import type { InboxCategoryKey } from '@oto/shared/inbox';
import { ApiError } from '@/api/client';
import { assistantApi } from '@/api/assistant';
import { inboxApi, type ConversationDetail, type ConversationRow, type InboxMe, type Message } from '@/api/inbox';
import { Avatar, CategoryBadge, ChannelDot, ChipView, StatusBadge } from '@/components/atoms';
import { Composer, MANAGER_REOPENS, type InsertedTemplate } from '@/components/Composer';
import { CorrectAssistant, type CorrectionTarget } from '@/components/CorrectAssistant';
import { PrimaryMoveConfirm, TeamMoveConfirm, type PendingPrimaryMove, type PendingTeamMove } from '@/components/confirms';
import { DetailsDialog, type DetailsActions } from '@/components/dialogs';
import { MessageBubble, ShadowBubble } from '@/components/MessageBubble';
import { SlotPicker } from '@/components/SlotPicker';
import { PendingControl } from '@/components/writes';
import {
  CHANNEL_LABEL,
  EVENT_ORDERS_REASON,
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
  categoryTitle,
  contactName,
  effectiveBranchId,
  handleLabel,
  initialsOf,
  langLabel,
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

type Busy = 'primary' | 'support' | 'divert' | 'move' | 'branch' | 'reopen' | 'ai' | null;

const CATEGORY_KEYS: readonly InboxCategoryKey[] = ['birthdays', 'general', 'marketing'];
const categoryOf = (v: unknown): InboxCategoryKey | null =>
  CATEGORY_KEYS.includes(v as InboxCategoryKey) ? (v as InboxCategoryKey) : null;

function refusalOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * The chat panel (WhatsAppDemo.tsx `ChatPanel`, :1870-2062): the header, the
 * assignment strip, the timeline and the composer, from the api.
 *
 * LIVE since I3b (SCRUM-588), behind the same write switch (`writeMode`):
 * the move-team badge and the status picker in the header; the primary and
 * support slot pickers, Divert and the branch select in the strip; Mark as
 * Handled; the composer. Every refusal is the server's sentence, shown as it
 * was said. While the api says `writes: false` the same controls render
 * disabled with their reason, as in Cut A. Book Date and Create BEO are
 * disabled in both cuts: they wait on the event orders (owner Q23).
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
}: {
  row: ConversationRow;
  thread: Thread;
  me: InboxMe;
  now: Date;
  inserted: InsertedTemplate | null;
  /** The details dialog is the panel's (it carries the phone's team and status controls, test night U10). */
  detailsOpen: boolean;
  onBack: () => void;
  onLoadOlder: () => void;
  onOpenDetails: () => void;
  onCloseDetails: () => void;
  onOpenTemplates: () => void;
  onAskHandle: () => void;
  /** After a write: re-read the thread, the list and the dashboard. */
  onChanged: () => Promise<void>;
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

  // A refusal belongs to the conversation it was said about.
  useEffect(() => {
    setError(null);
    setNote(null);
    setPendingPrimary(null);
    setPendingMove(null);
    setCorrecting(null);
  }, [conv.id]);

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

  const items = useMemo(
    () => timeline(thread.messages, thread.detail?.events ?? [], thread.olderCursor === null, { me }),
    [thread.messages, thread.detail, thread.olderCursor, me],
  );
  const withdrawn = useMemo(
    () => withdrawnNotes(thread.messages, thread.detail?.events ?? []),
    [thread.messages, thread.detail],
  );
  // The files the thread's events name (the brochure), for the bubbles' attachments.
  const fileNames = useMemo(() => attachmentNames(thread.detail?.events ?? []), [thread.detail]);

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
  const idLabel = handleLabel(conv.channel);
  const supportCap = me.capabilities.assign ? supportCapLabel(supports.length) : null;

  // The phone's team and status controls, in the details dialog (test night U10).
  const phoneActions: DetailsActions = {
    moves,
    currentMove,
    canMove: live && me.capabilities.move,
    onMove: (o) => {
      onCloseDetails();
      askMove(o);
    },
    status: conv.status,
    canHandle: live && handleable,
    canReopen: live && reopenable,
    onHandle: () => {
      onCloseDetails();
      onAskHandle();
    },
    onReopen: () => {
      onCloseDetails();
      void run('reopen', () => inboxApi.reopen(conv.id), 'The conversation could not be reopened.');
    },
    busy: busy !== null,
  };

  return (
    <>
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the conversations"
          className="rounded-lg p-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="relative">
          <Avatar initials={initialsOf(name)} tint={tintFor(conv.contact.id)} size={40} />
          <ChannelDot channel={conv.channel} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[14px] font-semibold text-slate-900 dark:text-slate-100">{name}</div>
            <span className="text-[11px] text-slate-400">·</span>
            <span className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">{CHANNEL_LABEL[conv.channel]}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="truncate">{idLabel ? `${idLabel} ${conv.contact.handle}` : conv.contact.handle}</span>
            {conv.intent && (
              <>
                <span>·</span>
                <span className="truncate">{conv.intent}</span>
              </>
            )}
            <span>·</span>
            <span className="uppercase tracking-wide">{langLabel(conv.language)}</span>
          </div>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <CategoryBadge
            category={conv.category}
            label={me.capabilities.move ? teamDestLabel(conv, me) : undefined}
            title={categoryTitle(conv.category, detail?.teamName ?? null)}
            live={live && me.capabilities.move}
            picker={
              !me.capabilities.move ? undefined : pending ? (
                <PendingOverlay label="Move to another team" />
              ) : (
                <select
                  value={currentMove}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const opt = moves.find((m) => m.value === e.target.value);
                    if (opt && opt.value !== currentMove) askMove(opt);
                  }}
                  aria-label="Move to team"
                  className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-wait"
                >
                  {moves.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )
            }
          />
          <StatusBadge
            status={conv.status}
            live={live && (handleable || reopenable)}
            picker={
              !(handleable || reopenable) ? undefined : pending ? (
                <PendingOverlay label={conv.status === 'handled' ? 'Reopen' : 'Mark as handled'} />
              ) : (
                <select
                  value={conv.status === 'handled' ? 'handled' : 'new'}
                  disabled={busy !== null}
                  onChange={(e) => {
                    if (e.target.value === 'handled') onAskHandle();
                    else void run('reopen', () => inboxApi.reopen(conv.id), 'The conversation could not be reopened.');
                  }}
                  aria-label="Set conversation status"
                  className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-wait"
                >
                  <option value="new">Active</option>
                  <option value="handled">Handled</option>
                </select>
              )
            }
          />
        </div>
        <button
          type="button"
          onClick={onOpenDetails}
          aria-label="Conversation details"
          title="Conversation details"
          className="rounded-lg p-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </header>

      {/* Assignment strip */}
      <div className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/60 px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">Primary</span>
          {live && mayAssign ? (
            <SlotPicker
              slotLabel="primary"
              current={primary ? assigneeChip(primary, me) : null}
              options={slotOptions(conv, me, 'primary')}
              onPick={(o) => void pickPrimary(o)}
              emptyLabel="Assign primary"
              disabled={busy !== null}
            />
          ) : primary ? (
            pending && mayAssign ? (
              <PendingControl reason={WRITES_PENDING_REASON} label="Change the primary owner" className="rounded-full">
                <ChipView chip={assigneeChip(primary, me)} />
              </PendingControl>
            ) : (
              <ChipView chip={assigneeChip(primary, me)} />
            )
          ) : (
            <span className="inline-flex items-center rounded-full bg-amber-50 dark:bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 ring-1 ring-amber-200 dark:ring-amber-500/30">
              Unassigned
            </span>
          )}
          {supportCap && (
            // Both places taken (test night U4): say so where "Add support" sat,
            // with the api's own reason, rather than let the button vanish.
            <span
              title={SUPPORT_FULL_HINT}
              aria-label={`${supportCap} — ${SUPPORT_FULL_HINT}`}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400"
            >
              {supportCap}
            </span>
          )}
          {me.capabilities.assign &&
            supportCap === null &&
            (live ? (
              <SlotPicker
                slotLabel="support"
                current={null}
                options={slotOptions(conv, me, 'support')}
                onPick={(o) =>
                  void run('support', () => inboxApi.addSupport(conv.id, o.assignee.id), 'Support could not be added.')
                }
                emptyLabel="Add support"
                disabled={busy !== null}
              />
            ) : (
              <PendingControl
                reason={WRITES_PENDING_REASON}
                label="Add support"
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400"
              >
                <Plus className="h-3 w-3" />
                Add support
              </PendingControl>
            ))}
          {supports.length > 0 && (
            <>
              <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">Support</span>
              {supports.map((s) =>
                live && me.capabilities.assign ? (
                  <SlotPicker
                    key={s.assignmentId}
                    slotLabel="support"
                    current={assigneeChip(s, me)}
                    options={slotOptions(conv, me, 'support')}
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
                    onRemove={() =>
                      void run(
                        'support',
                        () => inboxApi.removeSupport(conv.id, s.assignmentId),
                        'Support could not be removed.',
                      )
                    }
                    emptyLabel="Add support"
                    disabled={busy !== null}
                  />
                ) : (
                  <ChipView key={s.assignmentId} chip={assigneeChip(s, me)} />
                ),
              )}
            </>
          )}
          {mayAssign &&
            primary?.assigneeKind === 'account' &&
            (pending ? (
              <PendingControl
                reason={WRITES_PENDING_REASON}
                label="Divert to the backup"
                className="inline-flex items-center gap-1 rounded-full bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 ring-1 ring-slate-200 dark:ring-slate-700"
              >
                <Repeat className="h-3 w-3" />
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
                  className="inline-flex items-center gap-1 rounded-full bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 ring-1 ring-slate-200 dark:ring-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-60"
                >
                  {busy === 'divert' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Repeat className="h-3 w-3" />}
                  Divert
                </button>
              )
            ))}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {mayPauseAi && aiLine?.kind === 'label' && (
              <span
                data-ai-state={detail?.aiMode}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 ring-1 ring-slate-200 dark:ring-slate-700"
              >
                <Bot className="h-3 w-3" />
                {aiLine.text}
              </span>
            )}
            {mayPauseAi && aiLine?.kind === 'control' && (
              <button
                type="button"
                data-ai-state={detail?.aiMode}
                data-ai-action={aiLine.action}
                disabled={busy !== null}
                aria-pressed={aiPaused}
                onClick={() =>
                  void run(
                    'ai',
                    () => (aiLine.action === 'resume' ? assistantApi.resume(conv.id) : assistantApi.pause(conv.id)),
                    aiLine.action === 'resume' ? 'The assistant could not be resumed here.' : 'The assistant could not be paused here.',
                  )
                }
                title={
                  aiLine.action === 'resume'
                    ? 'The assistant stays quiet on this conversation. Resume to let it answer again.'
                    : 'Stop the assistant answering on this conversation. Lines not yet sent are withdrawn.'
                }
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 disabled:opacity-60 ${
                  aiPaused
                    ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/30 hover:bg-amber-100 dark:hover:bg-amber-500/25'
                    : 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 ring-indigo-200 dark:ring-indigo-500/30 hover:bg-indigo-100 dark:hover:bg-indigo-500/25'
                }`}
              >
                {busy === 'ai' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : aiPaused ? (
                  <PlayCircle className="h-3 w-3" />
                ) : (
                  <PauseCircle className="h-3 w-3" />
                )}
                {aiLine.text}
              </button>
            )}
            {me.capabilities.assign && live ? (
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                <MapPin className="h-3 w-3" />
                <span className="relative">
                  <select
                    value={branchValue}
                    disabled={busy !== null}
                    onChange={(e) => {
                      const next = e.target.value || null;
                      if (next !== conv.branchId) void setBranch(next);
                    }}
                    aria-label="Conversation branch"
                    className="appearance-none rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-0.5 pl-2 pr-6 text-[11px] capitalize text-slate-700 dark:text-slate-200 focus:border-slate-300 dark:focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:focus:ring-slate-600"
                  >
                    {branchSelectOptions(me.teams).map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
                </span>
              </label>
            ) : pending && me.capabilities.assign ? (
              <PendingControl
                reason={WRITES_PENDING_REASON}
                label="Change the branch"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-0.5 pl-2 pr-2 text-[11px] text-slate-700 dark:text-slate-200"
              >
                <MapPin className="h-3 w-3 text-slate-500 dark:text-slate-400" />
                {branchLabel(conv.branchId, me.teams)}
              </PendingControl>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                <MapPin className="h-3 w-3" />
                {branchLabel(branchValue || null, me.teams)}
              </span>
            )}
            {conv.category === 'birthdays' && (
              <>
                <PendingControl
                  reason={EVENT_ORDERS_REASON}
                  label="Book Date"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-2.5 py-1 text-[12px] font-medium text-white ring-1 ring-amber-500"
                >
                  <Calendar className="h-3.5 w-3.5" />
                  Book Date
                </PendingControl>
                <PendingControl
                  reason={EVENT_ORDERS_REASON}
                  label="Create BEO"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1 text-[12px] font-medium text-white ring-1 ring-violet-600"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Create BEO
                </PendingControl>
              </>
            )}
          </span>
        </div>
        {handleable && (
          <div className="mt-2 flex items-center gap-2">
            {pending ? (
              <PendingControl
                reason={WRITES_PENDING_REASON}
                label="Mark as Handled"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Mark as Handled
              </PendingControl>
            ) : (
              <button
                type="button"
                onClick={onAskHandle}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Mark as Handled
              </button>
            )}
            {busy !== null && busy !== 'divert' && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
          </div>
        )}
        {!handleable && busy !== null && busy !== 'divert' && (
          <Loader2 className="mt-1.5 h-3.5 w-3.5 animate-spin text-slate-400" />
        )}
        {error && (
          <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg bg-rose-50 dark:bg-rose-500/15 px-3 py-1.5 text-[12px] text-rose-700 dark:text-rose-300 ring-1 ring-rose-200 dark:ring-rose-500/30">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {note && (
          <div
            role="status"
            className="mt-2 flex items-start gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/15 px-3 py-1.5 text-[12px] text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-200 dark:ring-emerald-500/30"
          >
            <span className="min-w-0 flex-1 break-words">{note}</span>
            <button type="button" onClick={() => setNote(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {pending && (
          <p className="mt-1.5 text-[11px] text-slate-400">
            Assigning, moving, handling and replying are {WRITES_PENDING_REASON.toLowerCase()}.
          </p>
        )}
      </div>

      {/* Timeline */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-50/40 dark:bg-slate-950/40 px-4 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          {thread.olderCursor !== null && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={onLoadOlder}
                disabled={thread.loadingOlder}
                className="inline-flex items-center gap-1.5 rounded-full bg-white dark:bg-slate-900 px-3 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 ring-1 ring-slate-200 dark:ring-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                {thread.loadingOlder && <Loader2 className="h-3 w-3 animate-spin" />}
                Earlier messages
              </button>
            </div>
          )}
          {thread.loading && thread.messages.length === 0 && (
            <div className="flex justify-center py-8 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {thread.error && (
            <div className="rounded-lg bg-rose-50 dark:bg-rose-500/15 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300 ring-1 ring-rose-200 dark:ring-rose-500/30">
              {thread.error}
            </div>
          )}
          {items.map((it) =>
            it.kind === 'shadow' ? (
              <ShadowBubble key={it.id} text={it.text} at={it.at} now={now} />
            ) : it.kind === 'group' ? (
              // One moment's pills in one line (customer-AI test night, W7), the pills under it on a press.
              <details key={it.id} className="my-1 flex flex-col items-center gap-1" data-pill-group={it.pills.length}>
                <summary className="inline-flex max-w-full cursor-pointer list-none items-center gap-1.5 rounded-full bg-slate-200/70 dark:bg-slate-700/70 px-2.5 py-1 text-center text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-300/60 dark:hover:bg-slate-600/60">
                  <Bot className="h-3 w-3 shrink-0" />
                  <span className="min-w-0">{it.summary}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
                </summary>
                <div className="flex flex-col items-center gap-1">
                  {it.pills.map((p) => (
                    <Pill key={p.id} text={p.text} />
                  ))}
                </div>
              </details>
            ) : it.kind === 'pill' ? (
              <div key={it.id} className="my-1 flex flex-col items-center gap-0.5">
                <Pill text={it.text} />
                {it.event === 'ai_silent' && mayCorrect && (
                  <button
                    type="button"
                    onClick={() => setCorrecting({ at: it.at })}
                    className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-indigo-500 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 hover:text-indigo-700 dark:hover:text-indigo-300"
                  >
                    <PenLine className="h-3 w-3" />
                    Correct the assistant
                  </button>
                )}
              </div>
            ) : (
              <MessageBubble
                key={it.message.id}
                m={it.message}
                me={me}
                now={now}
                withdrawnNote={withdrawn.get(it.message.id)}
                attachments={attachmentsOf(it.message, fileNames)}
                onCorrect={mayCorrect ? () => setCorrecting({ messageId: it.message.id }) : undefined}
              />
            ),
          )}
          {conv.status === 'handled' && (
            <div className="mt-2 flex justify-center">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 dark:bg-emerald-500/25 px-3 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                <Archive className="h-3 w-3" /> Conversation closed · Will reopen if customer replies
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      {live ? (
        <Composer
          key={conv.id}
          conv={conv}
          me={me}
          inserted={inserted}
          onOpenTemplates={onOpenTemplates}
          onSent={() => void onChanged()}
          onReopen={() => void run('reopen', () => inboxApi.reopen(conv.id), 'The conversation could not be reopened.')}
          reopening={busy === 'reopen'}
        />
      ) : (
        <PendingComposer conv={conv} me={me} onOpenTemplates={onOpenTemplates} />
      )}

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
      <DetailsDialog
        open={detailsOpen}
        onClose={onCloseDetails}
        row={conv}
        detail={detail}
        me={me}
        now={now}
        actions={phoneActions}
      />
    </>
  );
}

/** A system event's grey pill (:2019-2023). */
function Pill({ text }: { text: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-200/70 dark:bg-slate-700/70 px-2.5 py-1 text-center text-[11px] font-medium text-slate-600 dark:text-slate-300">
      <Bot className="h-3 w-3 shrink-0" />
      <span className="min-w-0">{text}</span>
    </span>
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
    <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
      {!conv.canReply ? (
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-950/60 px-3 py-2 text-[12.5px] text-slate-500 dark:text-slate-400">
          Notices from the till — this thread cannot take a reply.
        </div>
      ) : conv.status === 'handled' ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 dark:bg-slate-950/60 px-3 py-2 text-[12.5px] text-slate-500 dark:text-slate-400">
          <span>Handled — composer disabled</span>
          {me.capabilities.reopen ? (
            <PendingControl reason={WRITES_PENDING_REASON} label="Reopen" className="text-[12px] font-medium text-slate-700 dark:text-slate-200">
              Reopen
            </PendingControl>
          ) : (
            <span className="text-[12px]">{MANAGER_REOPENS}</span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-3 py-2">
          <button
            type="button"
            onClick={onOpenTemplates}
            aria-label="Templates"
            title="Templates"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            <FileText className="h-4 w-4" />
          </button>
          <input
            disabled
            aria-label="Reply"
            placeholder={`Replying is ${WRITES_PENDING_REASON.toLowerCase()}`}
            className="min-w-0 flex-1 cursor-not-allowed bg-transparent text-[13px] placeholder:text-slate-400 focus:outline-none"
          />
        </div>
      )}
    </div>
  );
}

/**
 * The prototype's pickers are a native select laid over the badge (:950-958,
 * :1004-1014). While writes are off the overlay is a disabled control in the
 * same place, so the badge shows its chevron and says why it does not open.
 */
function PendingOverlay({ label }: { label: string }) {
  return (
    <span title={WRITES_PENDING_REASON} className="absolute inset-0">
      <button
        type="button"
        disabled
        aria-label={`${label} — ${WRITES_PENDING_REASON}`}
        className="h-full w-full cursor-not-allowed"
      />
    </span>
  );
}
