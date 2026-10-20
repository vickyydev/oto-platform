import { AlertTriangle, Ban, Bot, Check, CheckCheck, Clock3, Languages, Paperclip, PenLine } from 'lucide-react';
import type { InboxMe, Message } from '@/api/inbox';
import { ChipView } from '@/components/atoms';
import { bubbleTime, langLabel, personChip } from '@/lib/view';

/**
 * The read ticks (:2097), over the provider's delivery status: one tick sent,
 * two delivered, two in sky once read; a clock while queued, a warning when
 * the channel refused it.
 */
function Ticks({ status }: { status: Message['providerStatus'] }) {
  switch (status) {
    case 'read':
      return <CheckCheck className="h-3 w-3 text-sky-300" aria-label="Read" />;
    case 'delivered':
      return <CheckCheck className="h-3 w-3" aria-label="Delivered" />;
    case 'sent':
      return <Check className="h-3 w-3" aria-label="Sent" />;
    case 'queued':
      return <Clock3 className="h-3 w-3" aria-label="Sending" />;
    case 'failed':
      return <AlertTriangle className="h-3 w-3 text-rose-400" aria-label="Not delivered" />;
    case 'withdrawn':
      return <Ban className="h-3 w-3" aria-label="Not sent" />;
    default:
      return null;
  }
}

/**
 * `MessageBubble` (WhatsAppDemo.tsx :2064-2103): the customer white with a
 * ring on the left; staff dark slate on the right under their name chip; the
 * AI indigo-tinted under an "AI Assistant" chip. A platform-written line (a
 * check-in notice from the till, the out-of-hours reply) sits on the right in
 * slate under an "Automatic" chip — the prototype has no such author.
 *
 * SCRUM-590 A3: an AI line withdrawn before it left (a person acted first,
 * plan §A.3) stays on the timeline greyed and struck through, with the words
 * `withdrawnNote` gives ("Not sent: a person replied") — the customer never
 * saw it. `onCorrect` adds "Correct the assistant" under an AI line (§E).
 */
export function MessageBubble({
  m,
  me,
  now,
  withdrawnNote,
  onCorrect,
}: {
  m: Message;
  me: Pick<InboxMe, 'people'>;
  now: Date;
  /** Set when this AI line was withdrawn: the words under it. */
  withdrawnNote?: string;
  onCorrect?: () => void;
}) {
  const isCustomer = m.authorKind === 'customer';
  const isAi = m.authorKind === 'ai';
  const isSystem = m.authorKind === 'system';
  const withdrawn = m.providerStatus === 'withdrawn' || withdrawnNote !== undefined;

  const bubble = isCustomer
    ? 'rounded-tl-sm bg-white text-slate-800 ring-1 ring-slate-200'
    : withdrawn
      ? 'rounded-tr-sm border border-dashed border-slate-300 bg-slate-50 text-slate-400'
      : isAi
        ? 'rounded-tr-sm bg-indigo-50 text-indigo-900 ring-1 ring-indigo-100'
        : isSystem
          ? 'rounded-tr-sm bg-slate-100 text-slate-700 ring-1 ring-slate-200'
          : 'rounded-tr-sm bg-slate-900 text-white';
  const meta = isCustomer || withdrawn ? 'text-slate-400' : isAi ? 'text-indigo-400' : isSystem ? 'text-slate-400' : 'text-slate-300';

  return (
    <div className={`flex ${isCustomer ? 'justify-start' : 'justify-end'}`} data-withdrawn={withdrawn ? 'true' : undefined}>
      <div className={`flex min-w-0 max-w-[80%] flex-col gap-1 ${isCustomer ? 'items-start' : 'items-end'}`}>
        {!isCustomer && (
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            {isAi ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-1.5 py-0.5 text-indigo-600 ring-1 ring-indigo-200">
                <Bot className="h-2.5 w-2.5" /> AI Assistant
              </span>
            ) : isSystem ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-slate-600 ring-1 ring-slate-200">
                <Bot className="h-2.5 w-2.5" /> Automatic
              </span>
            ) : (
              <ChipView chip={personChip(m.id, m.authorAccountId, m.authorName, me)} />
            )}
          </div>
        )}
        <div
          className={`max-w-full whitespace-pre-line break-words rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed ${withdrawn ? '' : 'shadow-sm '}${bubble}`}
        >
          {m.body !== null ? (
            withdrawn ? <s className="decoration-slate-400">{m.body}</s> : m.body
          ) : (
            <span className="italic opacity-70">{m.redacted ? 'Removed at the customer’s request' : 'No text'}</span>
          )}
          {m.translatedBody && (
            <div className={`mt-1.5 border-t pt-1.5 text-[12.5px] ${isCustomer ? 'border-slate-100' : 'border-white/15'}`}>
              <span className={`mr-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide ${meta}`}>
                <Languages className="h-3 w-3" /> {langLabel(m.translatedTo)}
              </span>
              {m.translatedBody}
            </div>
          )}
          {(m.mediaFileIds.length > 0 || m.audioFileId) && (
            <div className={`mt-1 flex items-center gap-1 text-[11px] ${meta}`}>
              <Paperclip className="h-3 w-3" />
              {m.mediaFileIds.length + (m.audioFileId ? 1 : 0)} attachment
              {m.mediaFileIds.length + (m.audioFileId ? 1 : 0) === 1 ? '' : 's'}
            </div>
          )}
          <div className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${meta}`}>
            <span>{bubbleTime(m.sentAt ?? m.createdAt, now)}</span>
            {m.direction === 'outbound' && <Ticks status={m.providerStatus} />}
          </div>
        </div>
        {withdrawn && (
          <div className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500">
            <Ban className="h-3 w-3" />
            {withdrawnNote ?? 'Not sent: a person replied'}
          </div>
        )}
        {isAi && onCorrect && (
          <button
            type="button"
            onClick={onCorrect}
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-indigo-500 hover:bg-indigo-50 hover:text-indigo-700"
          >
            <PenLine className="h-3 w-3" />
            Correct the assistant
          </button>
        )}
      </div>
    </div>
  );
}
