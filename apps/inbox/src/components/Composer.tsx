import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AlertTriangle, ArrowUp, FileText, Loader2, X } from 'lucide-react';
import { newId } from '@oto/shared/ids';
import { renderTemplate, templateVariables } from '@oto/shared/inbox-reply';
import { ApiError } from '@/api/client';
import { inboxApi, type ConversationRow, type InboxMe, type QualifyingTemplate, type ReplyRefusalDetails } from '@/api/inbox';
import { TranslationNote } from '@/components/atoms';
import { DictateButton, DictationLine, useDictation } from '@/components/Dictation';
import { COMPOSER_ICON, COMPOSER_LINE_PX, composerBox, sendsOnKey } from '@/lib/composer';
import { dictationAvailable, dictationCeilingOf, insertAtCaret } from '@/lib/dictation';
import { contactName, langLabel, needsTranslation, offeredTemplates } from '@/lib/view';

/** A template the composer holds: from the templates dialog, or offered by a refusal. */
export interface ComposerTemplate {
  id: string;
  key: string;
  language: string;
  body: string;
  /** A RU or TH row still carrying the English source: marked wherever it is shown (test night U1). */
  needsTranslation?: boolean;
}

/** A template handed in from outside (the templates dialog's Insert); the nonce makes a second Insert of the same one count. */
export interface InsertedTemplate {
  nonce: number;
  conversationId: string;
  template: ComposerTemplate;
}

interface Refused {
  code: string;
  message: string;
  details: ReplyRefusalDetails | null;
}

/**
 * The id of a draft, and of the message it becomes: the platform's UUIDv7
 * (`@oto/shared` `newId`), never the browser's random v4. The api orders a
 * thread by time and then by id, and a random id sorted after every id the
 * api had minted — it read as the thread's newest line, and the assistant
 * never saw a customer line after it (customer-AI test night 2026-10-21, CR6).
 */
export const newDraftId = (): string => newId();

/** The composer's footer (Chat.dc.html): the card under a rule, never scrolled away. */
export const COMPOSER_BAR = 'shrink-0 border-t border-line bg-card px-2 pb-3.5 pt-2 md:px-5 md:pb-4 md:pt-3';
/** Why the composer has no box (a till notice, a handled thread): the band's quiet line. */
const COMPOSER_NOTICE = 'flex min-h-11 flex-wrap items-center gap-2 rounded-2xl bg-band px-4 py-2 text-[13.5px] text-ink-soft';
const REOPEN_BUTTON =
  'inline-flex min-h-11 items-center gap-1.5 rounded-full border border-ink bg-card px-4 text-[13.5px] font-bold text-ink hover:bg-wash disabled:opacity-60 md:min-h-9';
const DISMISS = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full opacity-80 hover:opacity-100 md:h-7 md:w-7';

/** The box's prompt names the person the reply goes to (Chat.dc.html), not the one writing it. */
export function replyPlaceholder(conv: Pick<ConversationRow, 'contact'>): string {
  return `Reply to ${contactName(conv.contact)}`;
}

/**
 * The composer (WhatsAppDemo.tsx :2036-2058), live (I3b). Free text, or a
 * template with its `{{name}}` values. The free-text window is NEVER guessed
 * here: the server answers 409 TEMPLATE_REQUIRED or TEMPLATE_NOT_APPROVED
 * outside it, and the composer shows that sentence as it was said and offers
 * the templates the 409 names as qualifying. Every other refusal
 * (CONVERSATION_HANDLED, CHANNEL_CANNOT_REPLY, CHANNEL_NOT_CONNECTED, …) is
 * shown as said, too.
 *
 * Each draft carries one message id: a retry of an unchanged draft is the
 * same message on the server, never a second send; any edit starts a new id.
 *
 * Dictation (SCRUM-834): the microphone in the row records a clip and the
 * words come back into this input at the caret, as if typed — read,
 * corrected and sent by the person; nothing is sent by the dictation.
 *
 * The reply box grows with what it holds (SCRUM-837): one line when empty,
 * up to five, then it scrolls — a long dictated reply is read whole before
 * it is sent. Enter sends, as it did in the one-line box; Shift+Enter makes
 * a new line.
 *
 * In the OTO look (SCRUM-1016, Chat.dc.html) the composer is the chat's
 * footer, never scrolled away: Templates and the microphone as 44 px icons,
 * the box in a cream pill, Send in the coral. The emoji and attach buttons,
 * which did nothing, are gone.
 */
export function Composer({
  conv,
  me,
  inserted,
  onOpenTemplates,
  onSent,
  onReopen,
  reopening,
}: {
  conv: ConversationRow;
  me: InboxMe;
  inserted: InsertedTemplate | null;
  onOpenTemplates: () => void;
  onSent: () => void;
  onReopen: () => void;
  reopening: boolean;
}) {
  const [text, setText] = useState('');
  const [template, setTemplate] = useState<ComposerTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refused | null>(null);
  const draftId = useRef(newDraftId());
  const touch = () => {
    draftId.current = newDraftId();
  };

  // The dictated words land at the caret of the input as it stands (the DOM
  // value is the controlled value), and the caret follows them once rendered.
  // The deployment says whether the microphone is offered and the ceiling
  // (`/inbox/me`): no provider on, no button.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const caretAfter = useRef<number | null>(null);
  const dictation = useDictation(
    conv.id,
    (words) => {
      const input = inputRef.current;
      const placed = insertAtCaret(input?.value ?? '', input?.selectionStart ?? null, input?.selectionEnd ?? null, words);
      caretAfter.current = placed.caret;
      touch();
      setText(placed.text);
    },
    { available: dictationAvailable(me), maxSeconds: dictationCeilingOf(me) },
  );
  useEffect(() => {
    const caret = caretAfter.current;
    const input = inputRef.current;
    if (caret === null || !input) return;
    caretAfter.current = null;
    try {
      input.focus();
      input.setSelectionRange(caret, caret);
      // Words placed at the end of a reply past the box's cap: the end is shown.
      if (caret >= input.value.length) input.scrollTop = input.scrollHeight;
    } catch {
      // A browser that cannot place the caret leaves it where it was.
    }
  }, [text]);

  // The box is as tall as its words, to the cap (`composerBox`); measured
  // after every change of what it holds, and when the window's width moves
  // the wrapping. The box is only on screen for an open thread that replies.
  const shown = template ? '' : text;
  useLayoutEffect(() => {
    const fit = () => {
      const box = inputRef.current;
      if (!box) return;
      box.style.height = 'auto';
      const { heightPx, scrolls } = composerBox(box.scrollHeight);
      box.style.height = `${heightPx}px`;
      box.style.overflowY = scrolls ? 'auto' : 'hidden';
    };
    fit();
    window.addEventListener('resize', fit);
    // The row's width also changes with no window resize (the simulator's side panel shown or hidden).
    const box = inputRef.current;
    let width = box?.clientWidth ?? 0;
    const watcher =
      box && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            // Only a change of width re-measures: the box's own height change must not loop.
            if (box.clientWidth === width) return;
            width = box.clientWidth;
            fit();
          })
        : null;
    if (box && watcher) watcher.observe(box);
    return () => {
      window.removeEventListener('resize', fit);
      watcher?.disconnect();
    };
  }, [shown, conv.status, conv.canReply]);

  const pickTemplate = (t: ComposerTemplate) => {
    touch();
    setTemplate(t);
    setValues({});
    setRefused(null);
  };

  // An Insert from the templates dialog, for this conversation.
  const lastNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!inserted || inserted.conversationId !== conv.id || inserted.nonce === lastNonce.current) return;
    lastNonce.current = inserted.nonce;
    draftId.current = newDraftId();
    setTemplate(inserted.template);
    setValues({});
    setRefused(null);
  }, [inserted, conv.id]);

  if (!conv.canReply) {
    return (
      <div className={COMPOSER_BAR}>
        <div className={COMPOSER_NOTICE}>
          <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
          Notices from the till — this thread cannot take a reply.
        </div>
      </div>
    );
  }

  if (conv.status === 'handled') {
    return (
      <div className={COMPOSER_BAR}>
        <div className={`${COMPOSER_NOTICE} justify-between`}>
          <span className="flex items-center gap-2">
            <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" /> Handled — composer disabled
          </span>
          {me.capabilities.reopen ? (
            <button type="button" onClick={onReopen} disabled={reopening} className={REOPEN_BUTTON}>
              {reopening && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
              Reopen
            </button>
          ) : (
            // Reopening is a manager's (the rails' rights); the screen said nothing (test night U7).
            <span className="text-[13px] text-ink-muted">{MANAGER_REOPENS}</span>
          )}
        </div>
      </div>
    );
  }

  const variables = template ? templateVariables(template.body) : [];
  const missing = variables.filter((v) => !values[v]?.trim());
  const canSend = !busy && (template ? missing.length === 0 : text.trim().length > 0);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setRefused(null);
    try {
      await inboxApi.reply(
        conv.id,
        template
          ? {
              id: draftId.current,
              templateId: template.id,
              variables: variables.length > 0 ? Object.fromEntries(variables.map((v) => [v, values[v]!.trim()])) : undefined,
            }
          : { id: draftId.current, text: text.trim() },
      );
      setText('');
      setTemplate(null);
      setValues({});
      touch();
      onSent();
    } catch (err) {
      setRefused(
        err instanceof ApiError
          ? { code: err.code, message: err.message, details: (err.details as ReplyRefusalDetails | undefined) ?? null }
          : { code: 'UNKNOWN', message: 'The reply could not be sent.', details: null },
      );
    } finally {
      setBusy(false);
    }
  };

  // The templates the 409 names: the conversation's language first, `follow_up`
  // at the top, the other languages folded away (test night U1).
  const offered = offeredTemplates(refused?.details?.qualifyingTemplates ?? [], conv.language);
  const offer = (t: QualifyingTemplate) => (
    <li key={t.id} className="flex min-w-0 items-center gap-2 rounded-xl bg-card px-3 py-2 ring-1 ring-line">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          {t.key.replace(/[_.]/g, ' ')} · {langLabel(t.language)}
          {needsTranslation(t) && <TranslationNote />}
        </span>
        <span className="block truncate text-[13px] text-ink">{t.body}</span>
      </span>
      <button
        type="button"
        onClick={() => pickTemplate({ id: t.id, key: t.key, language: t.language, body: t.body, needsTranslation: needsTranslation(t) })}
        className="min-h-11 shrink-0 rounded-full border border-field bg-card px-4 text-[13px] font-semibold text-ink hover:bg-wash md:min-h-9"
      >
        Insert
      </button>
    </li>
  );

  return (
    <div className={COMPOSER_BAR}>
      {refused && (
        <div
          role="alert"
          className={`mb-2 rounded-2xl px-3 py-2 text-[13px] ring-1 ${
            refused.details?.window ? 'bg-needs text-needs-ink ring-needs-ink/25' : 'bg-danger text-danger-ink ring-danger-line'
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{refused.message}</span>
            <button type="button" onClick={() => setRefused(null)} aria-label="Dismiss" className={DISMISS}>
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
          {(offered.own.length > 0 || offered.others.length > 0) && (
            <div className="mt-2 max-h-[40dvh] overflow-y-auto overflow-x-hidden md:max-h-56">
              {offered.own.length > 0 ? (
                <ul className="space-y-1.5">{offered.own.map(offer)}</ul>
              ) : (
                <p className="text-[13px]">
                  No template in {langLabel(conv.language)} qualifies yet; the other languages are below.
                </p>
              )}
              {offered.others.length > 0 && (
                <details className="mt-2">
                  <summary className="flex min-h-11 cursor-pointer items-center text-[12.5px] font-semibold md:min-h-0 md:py-1">
                    Other languages ({offered.others.length})
                  </summary>
                  <ul className="mt-1.5 space-y-1.5">{offered.others.map(offer)}</ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {template && (
        <div className="mb-2 rounded-2xl border border-line bg-wash px-3 py-2">
          <div className="flex items-center gap-2">
            <FileText aria-hidden className="h-4 w-4 shrink-0 text-ink-soft" />
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-soft">
              <span className="truncate">
                Template · {template.key.replace(/[_.]/g, ' ')} · {langLabel(template.language)}
              </span>
              {template.needsTranslation && <TranslationNote />}
            </span>
            <button
              type="button"
              onClick={() => {
                touch();
                setTemplate(null);
                setValues({});
              }}
              aria-label="Remove the template"
              className={DISMISS}
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-1 whitespace-pre-line break-words text-[13.5px] text-ink">
            {renderTemplate(template.body, Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))).text}
          </p>
          {variables.length > 0 && (
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {variables.map((v) => (
                <label key={v} className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-muted">
                  <span className="shrink-0 font-mono">{v}</span>
                  <input
                    value={values[v] ?? ''}
                    onChange={(e) => {
                      touch();
                      setValues((o) => ({ ...o, [v]: e.target.value }));
                    }}
                    className="min-h-11 min-w-0 flex-1 rounded-xl border border-field bg-card px-3 text-[14px] text-ink focus-visible:outline-2 focus-visible:outline-coral md:min-h-9"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <form onSubmit={(e) => void send(e)} className="flex items-end gap-0.5">
        <button type="button" onClick={onOpenTemplates} aria-label="Templates" title="Templates" className={COMPOSER_ICON}>
          <FileText aria-hidden className="h-[22px] w-[22px]" />
        </button>
        <DictateButton dictation={dictation} disabled={template !== null || busy} />
        {/* The pill is the box's frame: the box has no padding of its own, so its height is its lines (`composerBox`). */}
        <span className="flex min-w-0 flex-1 rounded-[22px] border border-field bg-ground px-4 py-[11px] focus-within:outline-2 focus-within:outline-coral">
          <textarea
            ref={inputRef}
            rows={1}
            value={shown}
            disabled={template !== null}
            onChange={(e) => {
              touch();
              setText(e.target.value);
            }}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (!sendsOnKey({ key: e.key, shiftKey: e.shiftKey, composing: e.nativeEvent.isComposing })) return;
              e.preventDefault();
              void send();
            }}
            style={{ lineHeight: `${COMPOSER_LINE_PX}px` }}
            aria-label="Reply"
            placeholder={template ? 'Sending the template above' : replyPlaceholder(conv)}
            className="block w-full min-w-0 resize-none bg-transparent text-[15px] text-ink placeholder:text-ink-muted focus:outline-none disabled:cursor-not-allowed"
          />
        </span>
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send"
          className="ml-1.5 flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-coral text-[14.5px] font-bold text-on-coral hover:bg-coral/90 disabled:opacity-50 lg:px-[18px]"
        >
          {busy ? <Loader2 aria-hidden className="h-5 w-5 animate-spin" /> : <ArrowUp aria-hidden className="h-5 w-5 lg:hidden" />}
          <span aria-hidden className="hidden lg:inline">
            Send
          </span>
        </button>
      </form>
      <DictationLine dictation={dictation} />
    </div>
  );
}

/** A template from the read list, as the composer holds it. */
export function composerTemplate(t: {
  id: string;
  key: string;
  language: string;
  body: string;
  needsTranslation?: boolean;
}): ComposerTemplate {
  return { id: t.id, key: t.key, language: t.language, body: t.body, needsTranslation: t.needsTranslation === true };
}

/** What a handled thread says to someone without the reopen right (test night U7). */
export const MANAGER_REOPENS = 'A manager can reopen this';
