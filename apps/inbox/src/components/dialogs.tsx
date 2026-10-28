import { useEffect, useState } from 'react';
import { FileText, Filter, Info, Layers, Loader2 } from 'lucide-react';
import type { InboxStatusKey } from '@oto/shared/inbox';
import { ApiError } from '@/api/client';
import { inboxApi, type ConversationDetail, type ConversationRow, type InboxMe, type Template } from '@/api/inbox';
import { Eyebrow, TranslationNote } from '@/components/atoms';
import { FIELD } from '@/components/CorrectAssistant';
import { Dialog } from '@/components/Dialog';
import { FilterFields, InboxViews } from '@/components/Rail';
import { PendingControl } from '@/components/writes';
import { sourceLabel, type SourceOption } from '@/lib/inboxes';
import type { Filters } from '@/lib/query';
import {
  CATEGORY_LABEL,
  CHANNEL_LABEL,
  STATUS_LABEL,
  WRITES_PENDING_REASON,
  bubbleTime,
  branchLabel,
  contactName,
  effectiveBranchId,
  handleLabel,
  langLabel,
  offeredTemplates,
  supportsOf,
  writeMode,
  type MoveOption,
} from '@/lib/view';

/** What a manager sees in the details (test night U7): the support places are theirs to fill. */
export const MANAGERS_ADD_SUPPORT = 'Managers add support';

/**
 * The header's team badge and status picker, for a phone (test night U10):
 * below `md` the header hides them, and the GM could neither move a thread
 * nor change its status at 390 px. The dialog carries the same two controls,
 * shown only where the header's are not (`md:hidden`).
 */
export interface DetailsActions {
  moves: MoveOption[];
  currentMove: string;
  canMove: boolean;
  onMove: (option: MoveOption) => void;
  status: InboxStatusKey;
  canHandle: boolean;
  canReopen: boolean;
  onHandle: () => void;
  onReopen: () => void;
  busy: boolean;
}

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
  actions,
}: {
  open: boolean;
  onClose: () => void;
  row: ConversationRow;
  detail: ConversationDetail | null;
  me: InboxMe;
  now: Date;
  actions?: DetailsActions;
}) {
  const d = detail?.id === row.id ? detail : null;
  const when = (iso: string | null | undefined) => (iso ? bubbleTime(iso, now) : '—');
  const supportNames = supportsOf(row)
    .map((s) => s.name ?? me.people.find((p) => p.accountId === s.accountId)?.name ?? 'Someone')
    .join(', ');
  const lines: [string, string][] = [
    ['Contact', contactName(row.contact)],
    // A Facebook or Instagram id reads like a phone number (test night U9).
    [handleLabel(row.channel) ?? 'Handle', row.contact.handle],
    ['Phone', row.contact.phone ?? '—'],
    // The number it came in on (SCRUM-220 playbook), the channel on its own line.
    ['Source', sourceLabel(row.channel, row.channelAccountName)],
    ['Channel', CHANNEL_LABEL[row.channel]],
    ['Language', langLabel(row.language)],
    ['Category', CATEGORY_LABEL[row.category]],
    ['Intent', row.intent ?? '—'],
    ['Team', d?.teamName ?? '—'],
    ['Support', `${supportNames || 'Nobody yet'}${me.capabilities.assign ? '' : ` · ${MANAGERS_ADD_SUPPORT}`}`],
    ['Branch', branchLabel(effectiveBranchId(row, me.teams), me.teams)],
    ['Status', STATUS_LABEL[row.status]],
    ['Member', d?.member ? `${d.member.name} · ${d.member.childCount} child${d.member.childCount === 1 ? '' : 'ren'}` : 'Not linked'],
    ['Started', when(row.createdAt)],
    ['First reply', when(d?.firstResponseAt)],
    ['Handled', row.status === 'handled' ? when(row.handledAt) : '—'],
    ['Reopened', when(d?.reopenedAt)],
  ];
  const phoneActions = actions && (actions.canMove || actions.canHandle || actions.canReopen) ? actions : null;
  return (
    <Dialog open={open} onClose={onClose} icon={Info} title="Conversation details" subtitle={contactName(row.contact)}>
      <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
        {lines.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">{k}</dt>
            <dd className="min-w-0 break-words text-slate-800 dark:text-slate-200">{v}</dd>
          </div>
        ))}
      </dl>
      {phoneActions && (
        <div className="mt-4 border-t border-slate-100 dark:border-slate-800 pt-3 md:hidden" data-phone-actions="true">
          <Eyebrow className="mb-2">Actions</Eyebrow>
          <div className="grid grid-cols-1 gap-2">
            {phoneActions.canMove && (
              <label className="flex min-w-0 flex-col gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                Team
                <select
                  aria-label="Move to team"
                  value={phoneActions.currentMove}
                  disabled={phoneActions.busy}
                  onChange={(e) => {
                    const opt = phoneActions.moves.find((m) => m.value === e.target.value);
                    if (opt && opt.value !== phoneActions.currentMove) phoneActions.onMove(opt);
                  }}
                  className={FIELD}
                >
                  {phoneActions.moves.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(phoneActions.canHandle || phoneActions.canReopen) && (
              <label className="flex min-w-0 flex-col gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                Status
                <select
                  aria-label="Set conversation status"
                  value={phoneActions.status === 'handled' ? 'handled' : 'new'}
                  disabled={phoneActions.busy}
                  onChange={(e) => {
                    if (e.target.value === 'handled') phoneActions.onHandle();
                    else phoneActions.onReopen();
                  }}
                  className={FIELD}
                >
                  <option value="new">Active</option>
                  <option value="handled">Handled</option>
                </select>
              </label>
            )}
          </div>
        </div>
      )}
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
      iconTint="bg-violet-50 dark:bg-violet-500/15 text-violet-600 dark:text-violet-400"
      title="Templates"
      subtitle={language ? `In ${langLabel(language)}, the conversation’s language` : 'Every language'}
      wide
    >
      {error && <p className="rounded-lg bg-rose-50 dark:bg-rose-500/15 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300 ring-1 ring-rose-200 dark:ring-rose-500/30">{error}</p>}
      {!error && templates === null && (
        <div className="flex justify-center py-6 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {templates?.length === 0 && <p className="text-[12.5px] text-slate-500 dark:text-slate-400">No templates in this language yet.</p>}
      <ul className="space-y-2">
        {/* `follow_up` first, and a row still in English marked (test night U1). */}
        {offeredTemplates(templates ?? [], null).own.map((t) => (
          <li key={t.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                {t.key.replace(/[_.]/g, ' ')}
              </span>
              <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300">{langLabel(t.language)}</span>
              {t.needsTranslation && <TranslationNote />}
              {pending ? (
                <span className="ml-auto">
                  <PendingControl
                    reason={WRITES_PENDING_REASON}
                    label="Insert into the reply"
                    className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300"
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
                    className="ml-auto rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
                  >
                    Insert
                  </button>
                )
              )}
            </div>
            <p className="mt-1.5 whitespace-pre-line break-words text-[12.5px] text-slate-700 dark:text-slate-200">{t.body}</p>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** The rail's named inboxes and filter chips, at phone width where the rail is hidden. */
export function FiltersDialog({
  open,
  onClose,
  me,
  filters,
  sources = [],
  onChange,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  me: InboxMe;
  filters: Filters;
  sources?: readonly SourceOption[];
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
            className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            Show conversations
          </button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        <Layers className="h-3 w-3" /> Inboxes
      </div>
      <InboxViews me={me} filters={filters} onChange={onChange} />
      <div className="mb-2 mt-3 flex items-center gap-1.5 border-t border-slate-100 dark:border-slate-800 pt-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        <Filter className="h-3 w-3" /> Filters
      </div>
      <FilterFields me={me} filters={filters} onChange={onChange} sources={sources} />
    </Dialog>
  );
}
