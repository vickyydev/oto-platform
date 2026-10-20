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
import { Composer, type InsertedTemplate } from '@/components/Composer';
import { CorrectAssistant, type CorrectionTarget } from '@/components/CorrectAssistant';
import { PrimaryMoveConfirm, type PendingPrimaryMove } from '@/components/confirms';
import { MessageBubble } from '@/components/MessageBubble';
import { SlotPicker } from '@/components/SlotPicker';
import { PendingControl } from '@/components/writes';
import {
  CHANNEL_LABEL,
  EVENT_ORDERS_REASON,
  WRITES_PENDING_REASON,
  assigneeChip,
  branchLabel,
  branchSelectOptions,
  canHandle,
  contactName,
  initialsOf,
  langLabel,
  moveOptions,
  moveValue,
  primaryOf,
  slotOptions,
  supportsOf,
  teamDestLabel,
  timeline,
  tintFor,
  withdrawnNotes,
  writeMode,
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
  onBack,
  onLoadOlder,
  onOpenDetails,
  onOpenTemplates,
  onAskHandle,
  onChanged,
}: {
  row: ConversationRow;
  thread: Thread;
  me: InboxMe;
  now: Date;
  inserted: InsertedTemplate | null;
  onBack: () => void;
  onLoadOlder: () => void;
  onOpenDetails: () => void;
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
  const [pendingPrimary, setPendingPrimary] = useState<(PendingPrimaryMove & { option: SlotOption }) | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<CorrectionTarget | null>(null);

  // A refusal belongs to the conversation it was said about.
  useEffect(() => {
    setError(null);
    setPendingPrimary(null);
    setCorrecting(null);
  }, [conv.id]);

  // SCRUM-590 A3: the assistant's pause on this thread (§A.3 kill switch 3),
  // for whoever acts on it; and "Correct the assistant" for anyone who may write.
  const aiPaused = detail?.aiPaused ?? false;
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
          question: err.message,
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
  const branchValue = conv.branchId ?? '';

  return (
    <>
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the conversations"
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="relative">
          <Avatar initials={initialsOf(name)} tint={tintFor(conv.contact.id)} size={40} />
          <ChannelDot channel={conv.channel} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[14px] font-semibold text-slate-900">{name}</div>
            <span className="text-[11px] text-slate-400">·</span>
            <span className="shrink-0 text-[11px] text-slate-500">{CHANNEL_LABEL[conv.channel]}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-slate-500">
            <span className="truncate">{conv.contact.handle}</span>
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
                    if (opt && opt.value !== currentMove) {
                      void run('move', () => inboxApi.move(conv.id, opt.dest), 'The conversation could not be moved.');
                    }
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
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </header>

      {/* Assignment strip */}
      <div className="border-b border-slate-200 bg-white/70 px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Primary</span>
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
            <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
              Unassigned
            </span>
          )}
          {me.capabilities.assign &&
            supports.length < 2 &&
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
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500"
              >
                <Plus className="h-3 w-3" />
                Add support
              </PendingControl>
            ))}
          {supports.length > 0 && (
            <>
              <span className="mx-1 h-4 w-px bg-slate-200" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Support</span>
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
                className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200"
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
                  className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-60"
                >
                  {busy === 'divert' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Repeat className="h-3 w-3" />}
                  Divert
                </button>
              )
            ))}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {mayPauseAi && (
              <button
                type="button"
                disabled={busy !== null}
                aria-pressed={aiPaused}
                onClick={() =>
                  void run(
                    'ai',
                    () => (aiPaused ? assistantApi.resume(conv.id) : assistantApi.pause(conv.id)),
                    aiPaused ? 'The assistant could not be resumed here.' : 'The assistant could not be paused here.',
                  )
                }
                title={
                  aiPaused
                    ? 'The assistant stays quiet on this conversation. Resume to let it answer again.'
                    : 'Stop the assistant answering on this conversation. Lines not yet sent are withdrawn.'
                }
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 disabled:opacity-60 ${
                  aiPaused
                    ? 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100'
                    : 'bg-indigo-50 text-indigo-700 ring-indigo-200 hover:bg-indigo-100'
                }`}
              >
                {busy === 'ai' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : aiPaused ? (
                  <PlayCircle className="h-3 w-3" />
                ) : (
                  <PauseCircle className="h-3 w-3" />
                )}
                {aiPaused ? 'AI paused · Resume' : 'AI on · Pause'}
              </button>
            )}
            {me.capabilities.assign && live ? (
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <MapPin className="h-3 w-3" />
                <span className="relative">
                  <select
                    value={branchValue}
                    disabled={busy !== null}
                    onChange={(e) => {
                      const next = e.target.value || null;
                      if (next !== conv.branchId) {
                        void run('branch', () => inboxApi.setBranch(conv.id, next), 'The branch could not be changed.');
                      }
                    }}
                    aria-label="Branch"
                    className="appearance-none rounded-md border border-slate-200 bg-white py-0.5 pl-2 pr-6 text-[11px] capitalize text-slate-700 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
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
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white py-0.5 pl-2 pr-2 text-[11px] text-slate-700"
              >
                <MapPin className="h-3 w-3 text-slate-500" />
                {branchLabel(conv.branchId, me.teams)}
              </PendingControl>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                <MapPin className="h-3 w-3" />
                {branchLabel(conv.branchId, me.teams)}
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
          <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-1.5 text-[12px] text-rose-700 ring-1 ring-rose-200">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
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
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-50/40 px-4 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          {thread.olderCursor !== null && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={onLoadOlder}
                disabled={thread.loadingOlder}
                className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
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
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 ring-1 ring-rose-200">
              {thread.error}
            </div>
          )}
          {items.map((it) =>
            it.kind === 'pill' ? (
              <div key={it.id} className="my-1 flex flex-col items-center gap-0.5">
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-200/70 px-2.5 py-1 text-center text-[11px] font-medium text-slate-600">
                  <Bot className="h-3 w-3 shrink-0" />
                  <span className="min-w-0">{it.text}</span>
                </span>
                {it.event === 'ai_silent' && mayCorrect && (
                  <button
                    type="button"
                    onClick={() => setCorrecting({ at: it.at })}
                    className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-indigo-500 hover:bg-indigo-50 hover:text-indigo-700"
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
                onCorrect={mayCorrect ? () => setCorrecting({ messageId: it.message.id }) : undefined}
              />
            ),
          )}
          {conv.status === 'handled' && (
            <div className="mt-2 flex justify-center">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-medium text-emerald-700">
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
          intent={conv.intent}
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
    </>
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
    <div className="border-t border-slate-200 bg-white px-4 py-3">
      {!conv.canReply ? (
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-500">
          Notices from the till — this thread cannot take a reply.
        </div>
      ) : conv.status === 'handled' ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-500">
          <span>Handled — composer disabled</span>
          {me.capabilities.reopen && (
            <PendingControl reason={WRITES_PENDING_REASON} label="Reopen" className="text-[12px] font-medium text-slate-700">
              Reopen
            </PendingControl>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <button
            type="button"
            onClick={onOpenTemplates}
            aria-label="Templates"
            title="Templates"
            className="text-slate-400 hover:text-slate-600"
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
