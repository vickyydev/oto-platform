import { useEffect, useState } from 'react';
import { FileText, Filter, Info, Loader2 } from 'lucide-react';
import { ApiError } from '@/api/client';
import { inboxApi, type ConversationDetail, type ConversationRow, type InboxMe, type Template } from '@/api/inbox';
import { Dialog } from '@/components/Dialog';
import { FilterFields } from '@/components/Rail';
import { PendingControl } from '@/components/writes';
import type { Filters } from '@/lib/query';
import {
  CATEGORY_LABEL,
  CHANNEL_LABEL,
  STATUS_LABEL,
  WRITES_PENDING_REASON,
  bubbleTime,
  branchLabel,
  contactName,
  langLabel,
  writeMode,
} from '@/lib/view';

/**
 * The chat header's "more" menu (:1911), as a read: who this is and where the
 * conversation stands. The linked member shows by name and child count only —
 * allergy text stays on the till (plan §3.3).
 */
export function DetailsDialog({
  open,
  onClose,
  row,
  detail,
  me,
  now,
}: {
  open: boolean;
  onClose: () => void;
  row: ConversationRow;
  detail: ConversationDetail | null;
  me: InboxMe;
  now: Date;
}) {
  const d = detail?.id === row.id ? detail : null;
  const when = (iso: string | null | undefined) => (iso ? bubbleTime(iso, now) : '—');
  const lines: [string, string][] = [
    ['Contact', contactName(row.contact)],
    ['Handle', row.contact.handle],
    ['Phone', row.contact.phone ?? '—'],
    ['Channel', CHANNEL_LABEL[row.channel]],
    ['Language', langLabel(row.language)],
    ['Category', CATEGORY_LABEL[row.category]],
    ['Intent', row.intent ?? '—'],
    ['Team', d?.teamName ?? '—'],
    ['Branch', branchLabel(row.branchId, me.teams)],
    ['Status', STATUS_LABEL[row.status]],
    ['Member', d?.member ? `${d.member.name} · ${d.member.childCount} child${d.member.childCount === 1 ? '' : 'ren'}` : 'Not linked'],
    ['Started', when(row.createdAt)],
    ['First reply', when(d?.firstResponseAt)],
    ['Handled', row.status === 'handled' ? when(row.handledAt) : '—'],
    ['Reopened', when(d?.reopenedAt)],
  ];
  return (
    <Dialog open={open} onClose={onClose} icon={Info} title="Conversation details" subtitle={contactName(row.contact)}>
      <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
        {lines.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">{k}</dt>
            <dd className="min-w-0 break-words text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

/**
 * The composer's templates (plan §3.3 `GET /inbox/templates`): the welcome
 * line, the handover lines and the out-of-hours reply, in the conversation's
 * language. "Insert" hands one to the composer (I3b), which fills its
 * `{{name}}` values and sends it as a template — the server decides whether
 * it may go.
 */
export function TemplatesDialog({
  open,
  onClose,
  language,
  me,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  language: string | null;
  me: InboxMe;
  /** Absent: the open conversation cannot take a reply, so there is nothing to insert into. */
  onInsert?: (t: Template) => void;
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTemplates(null);
    setError(null);
    inboxApi
      .templates(language ?? undefined)
      .then((r) => !cancelled && setTemplates(r.templates))
      .catch((err: unknown) => !cancelled && setError(err instanceof ApiError ? err.message : 'The templates could not be read.'));
    return () => {
      cancelled = true;
    };
  }, [open, language]);

  const pending = writeMode(me) === 'disabled';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={FileText}
      iconTint="bg-violet-50 text-violet-600"
      title="Templates"
      subtitle={language ? `In ${langLabel(language)}, the conversation’s language` : 'Every language'}
      wide
    >
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 ring-1 ring-rose-200">{error}</p>}
      {!error && templates === null && (
        <div className="flex justify-center py-6 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {templates?.length === 0 && <p className="text-[12.5px] text-slate-500">No templates in this language yet.</p>}
      <ul className="space-y-2">
        {templates?.map((t) => (
          <li key={t.id} className="rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                {t.key.replace(/[_.]/g, ' ')}
              </span>
              <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-600">{langLabel(t.language)}</span>
              {t.needsTranslation && (
                <span className="rounded-full bg-amber-50 px-1.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                  English source, to translate
                </span>
              )}
              {pending ? (
                <span className="ml-auto">
                  <PendingControl
                    reason={WRITES_PENDING_REASON}
                    label="Insert into the reply"
                    className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600"
                  >
                    Insert
                  </PendingControl>
                </span>
              ) : (
                onInsert && (
                  <button
                    type="button"
                    onClick={() => onInsert(t)}
                    aria-label={`Insert ${t.key.replace(/[_.]/g, ' ')} into the reply`}
                    className="ml-auto rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  >
                    Insert
                  </button>
                )
              )}
            </div>
            <p className="mt-1.5 whitespace-pre-line break-words text-[12.5px] text-slate-700">{t.body}</p>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** The rail's filters, at phone width where the rail is hidden. */
export function FiltersDialog({
  open,
  onClose,
  me,
  filters,
  onChange,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  me: InboxMe;
  filters: Filters;
  onChange: (next: Partial<Filters>) => void;
  onClear: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={Filter}
      title="Filters"
      footer={
        <>
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800"
          >
            Show conversations
          </button>
        </>
      }
    >
      <FilterFields me={me} filters={filters} onChange={onChange} />
    </Dialog>
  );
}
