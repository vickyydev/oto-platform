import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, FileText, Loader2, Paperclip, Send, Smile, X, type LucideIcon } from 'lucide-react';
import { newId } from '@oto/shared/ids';
import { renderTemplate, templateVariables } from '@oto/shared/inbox-reply';
import { ApiError } from '@/api/client';
import { inboxApi, type ConversationRow, type InboxMe, type QualifyingTemplate, type ReplyRefusalDetails } from '@/api/inbox';
import { TranslationNote } from '@/components/atoms';
import { PendingControl } from '@/components/writes';
import { COMPOSER_EXTRAS_REASON, langLabel, needsTranslation, offeredTemplates } from '@/lib/view';

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
      <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-950/60 px-3 py-2 text-[12.5px] text-slate-500 dark:text-slate-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Notices from the till — this thread cannot take a reply.
        </div>
      </div>
    );
  }

  if (conv.status === 'handled') {
    return (
      <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 dark:bg-slate-950/60 px-3 py-2 text-[12.5px] text-slate-500 dark:text-slate-400">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Handled — composer disabled
          </span>
          {me.capabilities.reopen ? (
            <button
              type="button"
              onClick={onReopen}
              disabled={reopening}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-slate-700 dark:text-slate-200 hover:underline disabled:opacity-60"
            >
              {reopening && <Loader2 className="h-3 w-3 animate-spin" />}
              Reopen
            </button>
          ) : (
            // Reopening is a manager's (the rails' rights); the screen said nothing (test night U7).
            <span className="text-[12px] text-slate-500 dark:text-slate-400">{MANAGER_REOPENS}</span>
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
    <li key={t.id} className="flex min-w-0 items-start gap-2 rounded-md bg-white/70 dark:bg-slate-900/60 px-2 py-1.5 ring-1 ring-amber-100 dark:ring-amber-500/25">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
          {t.key.replace(/[_.]/g, ' ')} · {langLabel(t.language)}
          {needsTranslation(t) && <TranslationNote />}
        </span>
        <span className="block truncate text-[12px] text-slate-700 dark:text-slate-200">{t.body}</span>
      </span>
      <button
        type="button"
        onClick={() => pickTemplate({ id: t.id, key: t.key, language: t.language, body: t.body, needsTranslation: needsTranslation(t) })}
        className="shrink-0 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
      >
        Insert
      </button>
    </li>
  );

  return (
    <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
      {refused && (
        <div
          role="alert"
          className={`mb-2 rounded-lg px-3 py-2 text-[12.5px] ring-1 ${
            refused.details?.window ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-200 ring-amber-200 dark:ring-amber-500/30' : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-500/30'
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{refused.message}</span>
            <button type="button" onClick={() => setRefused(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {(offered.own.length > 0 || offered.others.length > 0) && (
            <div className="mt-2 max-h-56 overflow-y-auto overflow-x-hidden">
              {offered.own.length > 0 ? (
                <ul className="space-y-1.5">{offered.own.map(offer)}</ul>
              ) : (
                <p className="text-[12px]">
                  No template in {langLabel(conv.language)} qualifies yet; the other languages are below.
                </p>
              )}
              {offered.others.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] font-medium text-amber-800 dark:text-amber-200">
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
        <div className="mb-2 rounded-xl border border-violet-200 dark:border-violet-500/40 bg-violet-50/60 dark:bg-violet-500/10 px-3 py-2">
          <div className="flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-700 dark:text-violet-300">
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
              className="shrink-0 text-violet-500 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-1 whitespace-pre-line break-words text-[12.5px] text-slate-700 dark:text-slate-200">
            {renderTemplate(template.body, Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))).text}
          </p>
          {variables.length > 0 && (
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {variables.map((v) => (
                <label key={v} className="flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="shrink-0 font-mono">{v}</span>
                  <input
                    value={values[v] ?? ''}
                    onChange={(e) => {
                      touch();
                      setValues((o) => ({ ...o, [v]: e.target.value }));
                    }}
                    className="min-w-0 flex-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[12px] text-slate-800 dark:text-slate-200 focus:border-slate-300 dark:focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:focus:ring-slate-600"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <form onSubmit={(e) => void send(e)} className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-3 py-2">
        <ComposerExtra icon={Smile} label="Emoji" />
        <ComposerExtra icon={Paperclip} label="Attach a file" />
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
          value={template ? '' : text}
          disabled={template !== null}
          onChange={(e) => {
            touch();
            setText(e.target.value);
          }}
          aria-label="Reply"
          placeholder={template ? 'Sending the template above' : `Reply as ${me.name ?? 'you'}…`}
          className="min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-slate-400 focus:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      </form>
    </div>
  );
}

/** The prototype's emoji and attachment buttons: there, but the reply route takes words and templates only. */
function ComposerExtra({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <PendingControl reason={COMPOSER_EXTRAS_REASON} label={label} className="text-slate-400">
      <Icon className="h-4 w-4" />
    </PendingControl>
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
