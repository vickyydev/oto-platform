import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, FileText, Loader2, Paperclip, Send, Smile, X, type LucideIcon } from 'lucide-react';
import { renderTemplate, templateVariables } from '@oto/shared/inbox-reply';
import { ApiError } from '@/api/client';
import { inboxApi, type ConversationRow, type InboxMe, type ReplyRefusalDetails } from '@/api/inbox';
import { PendingControl } from '@/components/writes';
import { COMPOSER_EXTRAS_REASON, langLabel } from '@/lib/view';

/** A template the composer holds: from the templates dialog, or offered by a refusal. */
export interface ComposerTemplate {
  id: string;
  key: string;
  language: string;
  body: string;
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

const newDraftId = (): string => crypto.randomUUID();

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
      <div className="border-t border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-500">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Notices from the till — this thread cannot take a reply.
        </div>
      </div>
    );
  }

  if (conv.status === 'handled') {
    return (
      <div className="border-t border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-500">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Handled — composer disabled
          </span>
          {me.capabilities.reopen && (
            <button
              type="button"
              onClick={onReopen}
              disabled={reopening}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-slate-700 hover:underline disabled:opacity-60"
            >
              {reopening && <Loader2 className="h-3 w-3 animate-spin" />}
              Reopen
            </button>
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

  const offered = refused?.details?.qualifyingTemplates ?? [];

  return (
    <div className="border-t border-slate-200 bg-white px-4 py-3">
      {refused && (
        <div
          role="alert"
          className={`mb-2 rounded-lg px-3 py-2 text-[12.5px] ring-1 ${
            refused.details?.window ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-rose-50 text-rose-700 ring-rose-200'
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{refused.message}</span>
            <button type="button" onClick={() => setRefused(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {offered.length > 0 && (
            <ul className="mt-2 max-h-48 space-y-1.5 overflow-y-auto overflow-x-hidden">
              {offered.map((t) => (
                <li key={t.id} className="flex min-w-0 items-start gap-2 rounded-md bg-white/70 px-2 py-1.5 ring-1 ring-amber-100">
                  <span className="min-w-0 flex-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      {t.key.replace(/[_.]/g, ' ')} · {langLabel(t.language)}
                    </span>
                    <span className="block truncate text-[12px] text-slate-700">{t.body}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => pickTemplate({ id: t.id, key: t.key, language: t.language, body: t.body })}
                    className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Insert
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {template && (
        <div className="mb-2 rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-violet-600" />
            <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-700">
              Template · {template.key.replace(/[_.]/g, ' ')} · {langLabel(template.language)}
            </span>
            <button
              type="button"
              onClick={() => {
                touch();
                setTemplate(null);
                setValues({});
              }}
              aria-label="Remove the template"
              className="shrink-0 text-violet-500 hover:text-violet-800"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-1 whitespace-pre-line break-words text-[12.5px] text-slate-700">
            {renderTemplate(template.body, Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))).text}
          </p>
          {variables.length > 0 && (
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {variables.map((v) => (
                <label key={v} className="flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500">
                  <span className="shrink-0 font-mono">{v}</span>
                  <input
                    value={values[v] ?? ''}
                    onChange={(e) => {
                      touch();
                      setValues((o) => ({ ...o, [v]: e.target.value }));
                    }}
                    className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[12px] text-slate-800 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <form onSubmit={(e) => void send(e)} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
        <ComposerExtra icon={Smile} label="Emoji" />
        <ComposerExtra icon={Paperclip} label="Attach a file" />
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
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
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
export function composerTemplate(t: { id: string; key: string; language: string; body: string }): ComposerTemplate {
  return { id: t.id, key: t.key, language: t.language, body: t.body };
}
