import { useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Bot,
  Check,
  CheckCheck,
  Clock3,
  ExternalLink,
  EyeOff,
  Languages,
  Loader2,
  Mic,
  Paperclip,
  PenLine,
  type LucideIcon,
} from 'lucide-react';
import { ApiError } from '@/api/client';
import { filesApi } from '@/api/files';
import type { InboxMe, Message } from '@/api/inbox';
import {
  SHADOW_LABEL,
  bubbleTime,
  langLabel,
  personChip,
  voiceTranscriptOf,
  type Attachment,
  type VoiceTranscriptView,
} from '@/lib/view';

/** An attachment with no name known: the row carries ids only until the api names its media. */
export const ATTACHMENT_FALLBACK_NAME = 'Attachment';
/** A message's audio, named (SCRUM-824). */
export const VOICE_NOTE_NAME = 'Voice note';

/** A file's Open control: a card-coloured pill, 44 px tall on a phone (SCRUM-1016). */
const OPEN_FILE =
  'inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg bg-card px-2 text-[12px] font-semibold text-ink ring-1 ring-line hover:bg-wash md:min-h-0 md:py-0.5';

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
  // SCRUM-824: a voice note plays where it is, once opened.
  const audio = opened !== null && (opened.contentType ?? '').startsWith('audio/');

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
      <div className={`flex min-w-0 items-center gap-1.5 text-[12.5px] ${muted ? 'text-ink-muted' : ''}`}>
        <Paperclip aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{name}</span>
        {opened ? (
          <a href={opened.url} target="_blank" rel="noopener noreferrer" className={OPEN_FILE}>
            <ExternalLink aria-hidden className="h-3 w-3" /> Open
          </a>
        ) : (
          <button
            type="button"
            onClick={() => void open()}
            disabled={busy}
            aria-label={`Open ${name}`}
            className={`${OPEN_FILE} disabled:opacity-60`}
          >
            {busy ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <ExternalLink aria-hidden className="h-3 w-3" />} Open
          </button>
        )}
      </div>
      {image && opened && (
        <a href={opened.url} target="_blank" rel="noopener noreferrer">
          <img src={opened.url} alt={name} className="max-h-48 max-w-full rounded-lg ring-1 ring-line" />
        </a>
      )}
      {audio && opened && <audio controls preload="none" src={opened.url} className="h-8 w-full max-w-[260px]" />}
      {error && <span className="rounded-md bg-danger px-1.5 py-0.5 text-[11.5px] text-danger-ink">{error}</span>}
    </div>
  );
}

/**
 * The words under a customer's voice note (SCRUM-824): the transcript with a
 * small "transcribed · Thai" label; "Transcribing…" while it is pending; why
 * not when it could not be read, was too long, or no provider is configured.
 */
export function VoiceTranscript({ view }: { view: VoiceTranscriptView }) {
  const muted = 'text-[12px] italic text-ink-muted';
  return (
    <div data-testid="voice-transcript" data-state={view.state} className="mt-1.5 border-t border-line-soft pt-1.5">
      {view.state === 'done' ? (
        <>
          <span className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            <Mic aria-hidden className="h-3.5 w-3.5" /> {view.label}
          </span>
          <span className="text-[14px]">{view.text}</span>
        </>
      ) : view.state === 'pending' ? (
        <span className={`inline-flex items-center gap-1 ${muted}`}>
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> {view.label}
        </span>
      ) : (
        <span className={`inline-flex items-center gap-1 ${muted}`}>
          <Mic aria-hidden className="h-3.5 w-3.5" /> {view.label}
        </span>
      )}
    </div>
  );
}

/** The column a line stands in: most of a phone's width, less on a desktop (Chat.dc.html, Desktop.dc.html). */
const COLUMN = 'flex min-w-0 max-w-[80%] flex-col gap-1 lg:max-w-[62%]';
/** A bubble: 18 px round, the corner by its author smaller (6 px), 14.5 px words. */
const BUBBLE = 'max-w-full whitespace-pre-line break-words rounded-[18px] px-3.5 py-2.5 text-[14.5px] leading-[1.4]';

/** "Assistant" over the assistant's lines, in its teal (Chat.dc.html). */
function AssistantLabel() {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-bold text-teal">
      <Bot aria-hidden className="h-3.5 w-3.5" /> Assistant
    </span>
  );
}

/**
 * What the assistant WOULD have said on a number in shadow mode (customer-AI
 * test night, W5: staff saw nothing and could not judge it). Staff-only, never
 * sent: a dashed bubble on the card under the "Assistant" label, said so.
 */
export function ShadowBubble({ text, at, now, label = SHADOW_LABEL }: { text: string; at: string; now: Date; label?: string }) {
  return (
    <div className="flex justify-end" data-shadow="true">
      <div className={`${COLUMN} items-end`}>
        <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 px-1">
          <AssistantLabel />
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-muted">
            <EyeOff aria-hidden className="h-3.5 w-3.5" /> {label}
          </span>
        </span>
        <div className={`${BUBBLE} rounded-tr-md border border-dashed border-mint-edge bg-card text-ink-soft`}>{text}</div>
        <span className="px-1 text-[11.5px] text-ink-muted">{bubbleTime(at, now)}</span>
      </div>
    </div>
  );
}

/** A line's delivery (:2097), over the provider's status: a mark and its word, after the time. */
const DELIVERY: Partial<Record<NonNullable<Message['providerStatus']>, { icon: LucideIcon; word: string; tint?: string }>> = {
  read: { icon: CheckCheck, word: 'Read', tint: 'text-teal' },
  delivered: { icon: CheckCheck, word: 'Delivered' },
  sent: { icon: Check, word: 'Sent' },
  queued: { icon: Clock3, word: 'Sending' },
  failed: { icon: AlertTriangle, word: 'Not delivered', tint: 'text-danger-ink' },
  withdrawn: { icon: Ban, word: 'Not sent' },
};

function Delivery({ status }: { status: Message['providerStatus'] }) {
  const d = status ? DELIVERY[status] : undefined;
  if (!d) return null;
  const Icon = d.icon;
  return (
    <span className={`inline-flex items-center gap-1 ${d.tint ?? ''}`}>
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {d.word}
    </span>
  );
}

/**
 * `MessageBubble` (WhatsAppDemo.tsx :2064-2103), in the OTO look (SCRUM-1016,
 * Chat.dc.html): the customer on the card on the left; staff in the brown ink
 * on the right under their name; the assistant in mint and teal under
 * "Assistant". A platform-written line (a check-in notice from the till, the
 * out-of-hours reply) sits on the right on the band under "Sent
 * automatically" — the prototype has no such author. The time and the
 * delivery word sit under the bubble.
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
  const isStaff = !isCustomer && !isAi && !isSystem;
  const withdrawn = m.providerStatus === 'withdrawn' || withdrawnNote !== undefined;
  // SCRUM-824: a customer's voice note shows its words under the audio.
  const voice = isCustomer ? voiceTranscriptOf(m) : null;

  const bubble = isCustomer
    ? 'rounded-tl-md bg-card text-ink ring-1 ring-line'
    : withdrawn
      ? 'rounded-tr-md border border-dashed border-field bg-ground text-ink-muted'
      : isAi
        ? 'rounded-tr-md bg-mint text-teal'
        : isSystem
          ? 'rounded-tr-md bg-band text-ink'
          : 'rounded-tr-md bg-staff text-on-staff';
  // The translation's rule and its language mark, on the bubble's own ground.
  const rule = isCustomer || withdrawn ? 'border-line-soft' : isAi ? 'border-mint-edge' : isSystem ? 'border-line' : 'border-on-staff/25';
  const mark = withdrawn ? 'text-ink-muted' : isStaff ? 'text-on-staff' : isAi ? 'text-teal' : 'text-ink-muted';

  return (
    <div className={`flex ${isCustomer ? 'justify-start' : 'justify-end'}`} data-withdrawn={withdrawn ? 'true' : undefined}>
      <div className={`${COLUMN} ${isCustomer ? 'items-start' : 'items-end'}`}>
        {isAi ? (
          <span className="px-1">
            <AssistantLabel />
          </span>
        ) : isSystem ? (
          <span className="px-1 text-[11.5px] font-bold text-ink-soft">Sent automatically</span>
        ) : isStaff ? (
          <span className="px-1 text-[11.5px] font-bold text-ink-soft">
            {personChip(m.id, m.authorAccountId, m.authorName, me).name}
          </span>
        ) : null}
        <div className={`${BUBBLE} ${bubble}`}>
          {m.body !== null ? (
            withdrawn ? <s className="decoration-ink-muted">{m.body}</s> : m.body
          ) : m.redacted ? (
            <span className="italic opacity-80">Removed at the customer’s request</span>
          ) : attachments.length === 0 && !voice ? (
            <span className="italic opacity-80">No text</span>
          ) : null}
          {m.translatedBody && (
            <div className={`mt-1.5 border-t pt-1.5 text-[13.5px] ${rule}`}>
              <span className={`mr-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide ${mark}`}>
                <Languages aria-hidden className="h-3.5 w-3.5" /> {langLabel(m.translatedTo)}
              </span>
              {m.translatedBody}
            </div>
          )}
          {attachments.map((a) => (
            <AttachmentChip
              key={a.fileId}
              attachment={a.fileId === m.audioFileId && a.name === null ? { ...a, name: VOICE_NOTE_NAME } : a}
              muted={withdrawn}
            />
          ))}
          {voice && <VoiceTranscript view={voice} />}
        </div>
        <span className={`flex flex-wrap items-center gap-x-2 px-1 text-[11.5px] text-ink-muted ${isCustomer ? '' : 'justify-end'}`}>
          {isAi && onCorrect && (
            <button
              type="button"
              onClick={onCorrect}
              className="inline-flex min-h-11 items-center gap-1 font-semibold text-teal underline underline-offset-2 hover:no-underline md:min-h-0 md:py-1"
            >
              <PenLine aria-hidden className="h-3.5 w-3.5" />
              Correct the assistant
            </button>
          )}
          <span>{bubbleTime(m.sentAt ?? m.createdAt, now)}</span>
          {m.direction === 'outbound' && <Delivery status={m.providerStatus} />}
        </span>
        {withdrawn && (
          <span className="inline-flex items-center gap-1 px-1 text-[12px] font-medium text-ink-muted">
            <Ban aria-hidden className="h-3.5 w-3.5" />
            {withdrawnNote ?? 'Not sent: a person replied'}
          </span>
        )}
      </div>
    </div>
  );
}
