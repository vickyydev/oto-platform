import { useEffect, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Bot,
  Calendar,
  CheckCircle2,
  FileText,
  Loader2,
  MapPin,
  MoreHorizontal,
  Paperclip,
  Plus,
  Repeat,
  Send,
  Smile,
  type LucideIcon,
} from 'lucide-react';
import type { ConversationDetail, ConversationRow, InboxMe, Message } from '@/api/inbox';
import { Avatar, CategoryBadge, ChannelDot, ChipView, StatusBadge } from '@/components/atoms';
import { PendingControl } from '@/components/writes';
import { MessageBubble } from '@/components/MessageBubble';
import {
  CHANNEL_LABEL,
  EVENT_ORDERS_REASON,
  WRITES_PENDING_REASON,
  assigneeChip,
  branchLabel,
  canHandle,
  contactName,
  initialsOf,
  langLabel,
  primaryOf,
  supportsOf,
  teamDestLabel,
  timeline,
  tintFor,
  writeMode,
} from '@/lib/view';

export interface Thread {
  detail: ConversationDetail | null;
  messages: Message[];
  olderCursor: string | null;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

/**
 * The chat panel (WhatsAppDemo.tsx `ChatPanel`, :1870-2062), READING: the
 * header, the assignment strip, the timeline and the composer, from the api.
 *
 * Every write control is here in its place — the slot pickers, "+ Add
 * support", the move badge, the status picker, the branch select, Divert,
 * Mark as Handled, the composer — rendered disabled with its reason while
 * the write switch is off (`writeMode`), and hidden if the api turns writes
 * on before I3b wires them. Book Date and Create BEO are disabled in both
 * cuts: they wait on the event orders (owner Q23).
 */
export function ChatPanel({
  row,
  thread,
  me,
  now,
  onBack,
  onLoadOlder,
  onOpenDetails,
  onOpenTemplates,
}: {
  row: ConversationRow;
  thread: Thread;
  me: InboxMe;
  now: Date;
  onBack: () => void;
  onLoadOlder: () => void;
  onOpenDetails: () => void;
  onOpenTemplates: () => void;
}) {
  const mode = writeMode(me);
  const pending = mode === 'disabled';
  // The detail is fresher than the list row once it is in; until then the row
  // carries everything the header and the strip need.
  const conv: ConversationRow = thread.detail?.id === row.id ? thread.detail : row;
  const name = contactName(conv.contact);
  const primary = primaryOf(conv);
  const supports = supportsOf(conv);
  const viewerIsPrimary = primary?.accountId === me.accountId;
  const handleable = canHandle(conv, me);
  const mayAssign = me.capabilities.assign || viewerIsPrimary;

  const items = useMemo(
    () => timeline(thread.messages, thread.detail?.events ?? [], thread.olderCursor === null, { me }),
    [thread.messages, thread.detail, thread.olderCursor, me],
  );

  // Open at the newest line, and follow new ones as they arrive — but not when
  // an older page was just put above what the reader is looking at.
  const scroller = useRef<HTMLDivElement>(null);
  const newest = thread.messages[thread.messages.length - 1]?.id;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.id, newest]);

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
            picker={
              me.capabilities.move && pending ? (
                <PendingOverlay label="Move to another team" />
              ) : undefined
            }
          />
          <StatusBadge
            status={conv.status}
            picker={
              pending && (handleable || (conv.status === 'handled' && me.capabilities.reopen)) ? (
                <PendingOverlay label={conv.status === 'handled' ? 'Reopen' : 'Mark as handled'} />
              ) : undefined
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
          {primary ? (
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
          {pending && me.capabilities.assign && supports.length < 2 && (
            <PendingControl
              reason={WRITES_PENDING_REASON}
              label="Add support"
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500"
            >
              <Plus className="h-3 w-3" />
              Add support
            </PendingControl>
          )}
          {supports.length > 0 && (
            <>
              <span className="mx-1 h-4 w-px bg-slate-200" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Support</span>
              {supports.map((s) => (
                <ChipView key={s.assignmentId} chip={assigneeChip(s, me)} />
              ))}
            </>
          )}
          {pending && mayAssign && primary?.assigneeKind === 'account' && (
            <PendingControl
              reason={WRITES_PENDING_REASON}
              label="Divert to the backup"
              className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200"
            >
              <Repeat className="h-3 w-3" />
              Divert
            </PendingControl>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {pending && me.capabilities.assign ? (
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
        {pending && handleable && (
          <div className="mt-2">
            <PendingControl
              reason={WRITES_PENDING_REASON}
              label="Mark as Handled"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Mark as Handled
            </PendingControl>
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
              <div key={it.id} className="my-1 flex justify-center">
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-200/70 px-2.5 py-1 text-center text-[11px] font-medium text-slate-600">
                  <Bot className="h-3 w-3 shrink-0" />
                  <span className="min-w-0">{it.text}</span>
                </span>
              </div>
            ) : (
              <MessageBubble key={it.message.id} m={it.message} me={me} now={now} />
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
      {mode === 'disabled' && (
        <div className="border-t border-slate-200 bg-white px-4 py-3">
          {!conv.canReply ? (
            <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-500">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Notices from the till — this thread cannot take a reply.
            </div>
          ) : conv.status === 'handled' ? (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-500">
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Handled — composer disabled
              </span>
              {me.capabilities.reopen && (
                <PendingControl reason={WRITES_PENDING_REASON} label="Reopen" className="text-[12px] font-medium text-slate-700">
                  Reopen
                </PendingControl>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <ComposerIcon icon={Smile} label="Emoji" />
              <ComposerIcon icon={Paperclip} label="Attach a file" />
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
              <PendingControl
                reason={WRITES_PENDING_REASON}
                label="Send"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white"
              >
                <Send className="h-3.5 w-3.5" />
              </PendingControl>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ComposerIcon({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <PendingControl reason={WRITES_PENDING_REASON} label={label} className="text-slate-400">
      <Icon className="h-4 w-4" />
    </PendingControl>
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
