import { useEffect, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { ApiError } from '@/api/client';
import { inboxApi, type InboxMe, type Template } from '@/api/inbox';
import { TranslationNote } from '@/components/atoms';
import { Dialog } from '@/components/Dialog';
import { FilterFields, HideNoticesSwitch } from '@/components/Rail';
import { PendingControl } from '@/components/writes';
import type { SourceOption } from '@/lib/inboxes';
import type { Filters } from '@/lib/query';
import { WRITES_PENDING_REASON, langLabel, offeredTemplates, writeMode } from '@/lib/view';

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
        <div className="flex justify-center py-6 text-ink-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {templates?.length === 0 && <p className="text-[12.5px] text-ink-muted">No templates in this language yet.</p>}
      <ul className="space-y-2">
        {/* `follow_up` first, and a row still in English marked (test night U1). */}
        {offeredTemplates(templates ?? [], null).own.map((t) => (
          <li key={t.id} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                {t.key.replace(/[_.]/g, ' ')}
              </span>
              <span className="rounded-full bg-band px-1.5 text-[10px] font-semibold text-ink-soft">{langLabel(t.language)}</span>
              {t.needsTranslation && <TranslationNote />}
              {pending ? (
                <span className="ml-auto">
                  <PendingControl
                    reason={WRITES_PENDING_REASON}
                    label="Insert into the reply"
                    className="rounded-md border border-line bg-card px-2 py-0.5 text-[11px] font-medium text-ink-soft"
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
                    className="ml-auto rounded-md border border-line bg-card px-2 py-0.5 text-[11px] font-medium text-ink-soft hover:bg-wash hover:text-ink"
                  >
                    Insert
                  </button>
                )
              )}
            </div>
            <p className="mt-1.5 whitespace-pre-line break-words text-[12.5px] text-ink">{t.body}</p>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/**
 * What the sheet's main button says (SCRUM-1016): the filters apply as they
 * are chosen, so the list behind the sheet is already read again; its count
 * is said only when the read gives it whole — "50+" while a next page waits,
 * and no number at all while the read is out.
 */
export function showConversationsLabel(list: { loading: boolean; count: number; more: boolean }): string {
  if (list.loading) return 'Show conversations';
  return `Show ${list.count}${list.more ? '+' : ''} conversation${list.count === 1 && !list.more ? '' : 's'}`;
}

/**
 * The filters on a phone and a tablet (SCRUM-1016, Filters.dc.html): a
 * sheet with Topic, Park, Channel and Language, each once, and "Hide till
 * notices". The named inboxes it used to list are gone — each was one of
 * these choices. Clear puts every choice here back to all (and hides the
 * notices again); the quick filters, the search and the archive's choices
 * stay as they are.
 */
export function FiltersDialog({
  open,
  onClose,
  me,
  filters,
  sources = [],
  onChange,
  onClear,
  showLabel = 'Show conversations',
}: {
  open: boolean;
  onClose: () => void;
  me: InboxMe;
  filters: Filters;
  sources?: readonly SourceOption[];
  onChange: (next: Partial<Filters>) => void;
  onClear: () => void;
  /** `showConversationsLabel` over the list read behind the sheet. */
  showLabel?: string;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      sheet
      title="Filters"
      closeLabel="Close filters"
      footer={
        <>
          <button
            type="button"
            onClick={onClear}
            className="min-h-12 rounded-xl px-4 text-[15px] font-semibold text-ink hover:bg-wash focus-visible:outline-2 focus-visible:outline-coral"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-12 flex-1 rounded-[14px] bg-coral px-4 text-[15px] font-bold text-on-coral hover:bg-coral/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
          >
            {showLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <FilterFields me={me} filters={filters} onChange={onChange} sources={sources} layout="sheet" />
        <HideNoticesSwitch on={filters.hideNotices} onChange={(hideNotices) => onChange({ hideNotices })} />
      </div>
    </Dialog>
  );
}
