import { useState } from 'react';
import { AlertTriangle, Ban, Bot, Check, CheckCheck, Clock3, ExternalLink, EyeOff, Languages, Loader2, Paperclip, PenLine } from 'lucide-react';
import { ApiError } from '@/api/client';
import { filesApi } from '@/api/files';
import type { InboxMe, Message } from '@/api/inbox';
import { ChipView } from '@/components/atoms';
import { SHADOW_LABEL, bubbleTime, langLabel, personChip, type Attachment } from '@/lib/view';

/** An attachment with no name known: the row carries ids only until the api names its media. */
export const ATTACHMENT_FALLBACK_NAME = 'Attachment';

/**
 * One attachment on a bubble (customer-AI test night, W7: the brochure showed
 * "No text · 1 attachment" with nothing to open). Its name, and a way to
 * open it: the api's own URL when the media entry carries one, else the
 * files api on a press — a read of a thread's media is access-logged, so it
 * is never asked for on render. An image shows under the bubble once opened.
 */
export function AttachmentChip({ attachment: a, muted }: { attachment: Attachment; muted: boolean }) {
  const [opened, setOpened] = useState<{ url: string; contentType: string | null } | null>(
    a.url ? { url: a.url, contentType: a.contentType } : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = a.name ?? ATTACHMENT_FALLBACK_NAME;
  const image = opened !== null && (opened.contentType ?? '').startsWith('image/');

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await filesApi.url(a.fileId);
      setOpened({ url: r.url, contentType: r.contentType });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The file could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1" data-attachment={a.fileId}>
      <div className={`flex min-w-0 items-center gap-1.5 text-[11.5px] ${muted ? 'text-slate-400' : ''}`}>
        <Paperclip className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-medium">{name}</span>
        {opened ? (
          <a
            href={opened.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-white"
          >
            <ExternalLink className="h-3 w-3" /> Open
          </a>
        ) : (
          <button
            type="button"
            onClick={() => void open()}
            disabled={busy}
            aria-label={`Open ${name}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-white disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />} Open
          </button>
        )}
      </div>
      {image && opened && (
        <a href={opened.url} target="_blank" rel="noopener noreferrer">
          <img src={opened.url} alt={name} className="max-h-48 max-w-full rounded-lg ring-1 ring-slate-200" />
        </a>
      )}
      {error && <span className="text-[11px] text-rose-600">{error}</span>}
    </div>
  );
}

/**
 * What the assistant WOULD have said on a number in shadow mode (customer-AI
 * test night, W5: staff saw nothing and could not judge it). Staff-only, never
 * sent: a muted, dashed bubble under the AI chip, labelled so.
 */
export function ShadowBubble({ text, at, now }: { text: string; at: string; now: Date }) {
  return (
    <div className="flex justify-end" data-shadow="true">
      <div className="flex min-w-0 max-w-[80%] flex-col items-end gap-1">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-1.5 py-0.5 text-indigo-600 ring-1 ring-indigo-200">
            <Bot className="h-2.5 w-2.5" /> AI Assistant
          </span>
          <span className="inline-flex items-center gap-1 normal-case tracking-normal text-slate-400">
            <EyeOff className="h-3 w-3" /> {SHADOW_LABEL}
          </span>
        </div>
        <div className="max-w-full whitespace-pre-line break-words rounded-2xl rounded-tr-sm border border-dashed border-indigo-200 bg-indigo-50/40 px-3.5 py-2 text-[13.5px] leading-relaxed text-indigo-900/70">
          {text}
          <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-indigo-300">
            <span>{bubbleTime(at, now)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  attachments = [],
  onCorrect,
}: {
  m: Message;
  me: Pick<InboxMe, 'people'>;
  now: Date;
  /** Set when this AI line was withdrawn: the words under it. */
  withdrawnNote?: string;
  /** The files the message carries, named where the thread knows them (`attachmentsOf`). */
  attachments?: Attachment[];
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
          ) : m.redacted ? (
            <span className="italic opacity-70">Removed at the customer’s request</span>
          ) : attachments.length === 0 ? (
            <span className="italic opacity-70">No text</span>
          ) : null}
          {m.translatedBody && (
            <div className={`mt-1.5 border-t pt-1.5 text-[12.5px] ${isCustomer ? 'border-slate-100' : 'border-white/15'}`}>
              <span className={`mr-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide ${meta}`}>
                <Languages className="h-3 w-3" /> {langLabel(m.translatedTo)}
              </span>
              {m.translatedBody}
            </div>
          )}
          {attachments.map((a) => (
            <AttachmentChip key={a.fileId} attachment={a} muted={withdrawn} />
          ))}
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
