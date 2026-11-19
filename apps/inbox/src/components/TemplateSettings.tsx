import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, FileText, Loader2, Paperclip, Pencil, Plus, Upload } from 'lucide-react';
import { INBOX_TEMPLATE_APPROVALS, INBOX_TEMPLATE_KEY_NAMES, templateVariables } from '@oto/shared/inbox-reply';
import { ApiError } from '@/api/client';
import { BROCHURE_MAX_BYTES, BROCHURE_TYPES, assistantApi } from '@/api/assistant';
import { inboxApi, type InboxMe, type ManagedTemplate, type TemplateCreate } from '@/api/inbox';
import { Dialog } from '@/components/Dialog';
import {
  EmptyNote,
  Field,
  InlineError,
  InlineNote,
  LoadingNote,
  MetaLine,
  PageHeader,
  SectionCard,
  SettingsRow,
  type MetaPart,
  type RowAction,
} from '@/components/settings-parts';
import {
  BADGE,
  BTN_MAIN,
  BTN_QUIET,
  BTN_SMALL,
  CHECK_BOX,
  CHECK_LINE,
  FOCUS_WITHIN,
  INPUT,
  TONE,
} from '@/components/ui';
import { CHANNEL_LABEL, LANGUAGE_OPTIONS, branchLabel, branchOptions, langLabel } from '@/lib/view';

type Channel = NonNullable<ManagedTemplate['channel']>;
type Approval = (typeof INBOX_TEMPLATE_APPROVALS)[number];
type Key = (typeof INBOX_TEMPLATE_KEY_NAMES)[number];

// The house controls (SCRUM-1016, components/ui.ts): the page looks part of the Inbox, and does what it did.
// A one-line box and a select share one height (the scale's field); the words' box takes the padding of its lines.
const FIELD = INPUT;
const AREA = `${INPUT} py-2`;

/** A template's language by name ("English"), any other code as written (`langLabel`). */
export function languageName(code: string): string {
  return LANGUAGE_OPTIONS.find(([v]) => v === code.trim().toLowerCase())?.[1] ?? langLabel(code);
}

/** Words a key spells in lower case that are said in capitals ("Closing GM", as the old eyebrow showed it). */
const KEY_CAPITALS = new Set(['gm', 'beo']);

/** A template key in sentence case, for a title or a choice: `handover_birthday` reads "Handover birthday". */
export function keyTitle(key: string): string {
  const words = key
    .split(/[_.]/)
    .filter(Boolean)
    .map((w) => (KEY_CAPITALS.has(w) ? w.toUpperCase() : w))
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const APPROVAL_LABEL: Record<Approval, string> = {
  not_required: 'No approval needed',
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
};
const APPROVAL_TINT: Record<Approval, string> = {
  not_required: TONE.neutral,
  pending: TONE.ask,
  approved: TONE.money,
  rejected: TONE.danger,
};

/** The page's line under its title, word for word as the page has said it since I3b. */
export const TEMPLATES_HELP =
  'The standard lines the composer offers, per language, channel and park. Outside a channel’s reply window only an approved template can be sent.';
export const TEMPLATE_SAVED = 'Template saved.';
export const TEMPLATE_ARCHIVED = 'Template archived.';

/** How long a "saved" note stays before it steps aside. */
const NOTE_MS = 4000;

function said(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * The template settings page (plan §4.3, I2f's `inbox:template:manage`
 * routes): every template of the operator by key — the welcome line, the
 * handover lines, the out-of-hours reply — each variant in its language, for
 * a channel and a park or for all of them, with Meta's approval status. New,
 * edit, deactivate, archive. The server checks the template's own scope (a
 * park's variant at that park, an every-park one operator-wide) and its
 * refusals show as said.
 *
 * Since SCRUM-1044 it is a page of the settings frame (SettingsFrame): a
 * header with "New template", the count and "Show archived", then one
 * section per key with a calm row per variant (SETTINGS.md, Templates). The
 * reads and writes are the ones it always made.
 */
export function TemplateSettings({ me }: { me: InboxMe }) {
  const [archived, setArchived] = useState(false);
  const [templates, setTemplates] = useState<ManagedTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ManagedTemplate | 'new' | null>(null);
  const [archiving, setArchiving] = useState<ManagedTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await inboxApi.manageTemplates(archived);
      setTemplates(r.templates);
      setError(null);
    } catch (err) {
      setError(said(err, 'The templates could not be read.'));
    }
  }, [archived]);
  useEffect(() => {
    setTemplates(null);
    void load();
  }, [load]);

  // A done note steps aside after a few seconds, or as the next thing starts.
  useEffect(() => {
    if (note === null) return;
    const t = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(t);
  }, [note]);

  const archive = async () => {
    if (!archiving) return;
    setBusy(true);
    setArchiveError(null);
    try {
      await inboxApi.archiveTemplate(archiving.id);
      setArchiving(null);
      setNote(TEMPLATE_ARCHIVED);
      await load();
    } catch (err) {
      setArchiveError(said(err, 'The template could not be archived.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title="Templates"
        help={TEMPLATES_HELP}
        actions={
          <button
            type="button"
            onClick={() => {
              setNote(null);
              setEditing('new');
            }}
            className={BTN_MAIN}
          >
            <Plus aria-hidden className="h-4 w-4" />
            New template
          </button>
        }
      />

      <div className="-my-1 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-y border-line py-1">
        <p className="text-note text-ink-muted" aria-live="polite">
          {templates === null ? ' ' : templateCount(templates)}
        </p>
        <label className={CHECK_LINE}>
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className={CHECK_BOX} />
          Show archived
        </label>
      </div>

      {note && <InlineNote tone="success">{note}</InlineNote>}
      {error && <InlineError text={error} />}
      {!error && templates === null && <LoadingNote label="Reading the templates" />}
      {templates?.length === 0 && (
        <EmptyNote icon={FileText} title="No templates yet." line="New template adds the first line the composer offers." />
      )}

      {templates && templates.length > 0 && (
        <TemplateGroups
          me={me}
          templates={templates}
          onEdit={(t) => {
            setNote(null);
            setEditing(t);
          }}
          onArchive={(t) => {
            setNote(null);
            setArchiveError(null);
            setArchiving(t);
          }}
          onChanged={load}
        />
      )}

      {editing !== null && (
        <TemplateEditor
          me={me}
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setNote(TEMPLATE_SAVED);
            await load();
          }}
        />
      )}

      <ArchiveTemplateConfirm
        template={archiving}
        busy={busy}
        error={archiveError}
        onCancel={() => setArchiving(null)}
        onConfirm={() => void archive()}
      />
    </div>
  );
}

/** "24 templates", "1 template": what the list holds, archived ones included while shown. */
export function templateCount(templates: readonly ManagedTemplate[]): string {
  const archivedCount = templates.filter((t) => t.archivedAt).length;
  const n = templates.length;
  return `${n} template${n === 1 ? '' : 's'}${archivedCount > 0 ? `, ${archivedCount} archived` : ''}`;
}

/** The templates by key, in the shared key order (`INBOX_TEMPLATE_KEY_NAMES`), each key's variants as the api lists them. */
export function templateGroups(templates: readonly ManagedTemplate[]): { key: string; rows: ManagedTemplate[] }[] {
  return INBOX_TEMPLATE_KEY_NAMES.map((key) => ({ key, rows: templates.filter((t) => t.key === key) })).filter(
    (g) => g.rows.length > 0,
  );
}

/** The list: one section per key, a calm row per variant (SETTINGS.md, Templates). */
export function TemplateGroups({
  me,
  templates,
  onEdit,
  onArchive,
  onChanged,
}: {
  me: InboxMe;
  templates: readonly ManagedTemplate[];
  onEdit: (t: ManagedTemplate) => void;
  onArchive: (t: ManagedTemplate) => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {templateGroups(templates).map((g) => (
        <SectionCard key={g.key} title={keyTitle(g.key)} aside={g.rows.length}>
          <ul>
            {g.rows.map((t) => (
              <TemplateRow key={t.id} me={me} t={t} onEdit={() => onEdit(t)} onArchive={() => onArchive(t)} onChanged={onChanged} />
            ))}
          </ul>
        </SectionCard>
      ))}
    </div>
  );
}

/**
 * One variant: its language as the main text, its words as a two-line
 * preview, one badge (Archived, else an approval that is wanted) and the rest
 * as quiet meta — every state the old card's chips said, none lost.
 */
function TemplateRow({
  me,
  t,
  onEdit,
  onArchive,
  onChanged,
}: {
  me: InboxMe;
  t: ManagedTemplate;
  onEdit: () => void;
  onArchive: () => void;
  onChanged: () => Promise<void>;
}) {
  const archived = Boolean(t.archivedAt);
  const approvalBadge = !archived && t.approvalStatus !== 'not_required';
  const badge = archived ? (
    <span className={`${BADGE} ${TONE.neutral}`}>Archived</span>
  ) : approvalBadge ? (
    <span className={`${BADGE} ${APPROVAL_TINT[t.approvalStatus]}`}>{APPROVAL_LABEL[t.approvalStatus]}</span>
  ) : null;
  const meta: MetaPart[] = [
    { text: t.channel ? CHANNEL_LABEL[t.channel] : 'Every channel' },
    { text: t.branchId ? branchLabel(t.branchId, me.teams) : 'Every park' },
    ...(approvalBadge ? [] : [{ text: APPROVAL_LABEL[t.approvalStatus] }]),
    ...(t.active ? [] : [{ text: 'Inactive' }]),
    ...(t.needsTranslation ? [{ text: 'English source, to translate', tone: 'ask' as const }] : []),
  ];
  const name = `${keyTitle(t.key)}, ${languageName(t.language)}`;
  const actions: RowAction[] = archived
    ? []
    : [
        { label: 'Edit', icon: Pencil, onSelect: onEdit },
        { label: 'Archive', icon: Archive, onSelect: onArchive },
      ];
  return (
    <SettingsRow
      title={languageName(t.language)}
      name={name}
      preview={t.body.replace(/\s+/g, ' ').trim() || ' '}
      badge={badge}
      meta={<MetaLine parts={meta} />}
      actions={actions}
    >
      {t.key === BROCHURE_KEY && <Brochure template={t} onChanged={onChanged} />}
    </SettingsRow>
  );
}

/** "Archive this template?": what archiving does, said before the press. */
export function ArchiveTemplateConfirm({
  template,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  template: ManagedTemplate | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={template !== null}
      onClose={onCancel}
      icon={Archive}
      title="Archive this template?"
      subtitle={template ? `${keyTitle(template.key)} · ${languageName(template.language)}` : undefined}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={BTN_QUIET}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={BTN_MAIN}>
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Yes, archive
          </button>
        </>
      }
    >
      <p className="text-ui leading-relaxed text-ink-muted">
        It leaves the composer and this list for good. The messages already sent from it keep naming it.
      </p>
      {error && (
        <div className="mt-3">
          <InlineError text={error} />
        </div>
      )}
    </Dialog>
  );
}

/** The handover line whose row carries the park's birthday brochure (SCRUM-590 §C.5). */
const BROCHURE_KEY = 'handover_birthday';

/**
 * The birthday brochure on a `handover_birthday` row (plan §C.5): the file the
 * assistant sends before the holding line. One per park — a park's own row
 * carries that park's brochure; the every-park row is the fallback. A PDF or a picture.
 */
function Brochure({ template, onChanged }: { template: ManagedTemplate; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = template.attachmentFileIds.length;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!(BROCHURE_TYPES as readonly string[]).includes(file.type)) return setError('The brochure is a PDF or a JPEG, PNG or WebP picture.');
    if (file.size > BROCHURE_MAX_BYTES) return setError('The brochure is at most 10 MB.');
    setBusy(true);
    try {
      await assistantApi.uploadBrochure(template.id, file);
      await onChanged();
    } catch (err) {
      setError(said(err, 'The brochure could not be uploaded.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-wash px-3 py-2">
        <span className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-note text-ink-soft">
          <Paperclip aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            {count > 0 ? `Birthday brochure attached (${count} file${count === 1 ? '' : 's'})` : 'No birthday brochure yet'}
          </span>
        </span>
        {!template.archivedAt && (
          <label className={`${BTN_SMALL} cursor-pointer ${FOCUS_WITHIN}`}>
            {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Upload aria-hidden className="h-3.5 w-3.5" />}
            {count > 0 ? 'Replace brochure' : 'Upload brochure'}
            <input
              type="file"
              accept={BROCHURE_TYPES.join(',')}
              disabled={busy}
              className="sr-only"
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
      {error && <InlineError text={error} />}
    </div>
  );
}

/**
 * New or edit, on the house Dialog: a full-height sheet with its Save fixed
 * at the foot on a phone, a centred card from 768 px. The words come first
 * after the key, with the values they ask for under them; the request is the
 * one it always was (`fields`, in its order).
 */
export function TemplateEditor({
  me,
  template,
  onClose,
  onSaved,
}: {
  me: InboxMe;
  template: ManagedTemplate | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [key, setKey] = useState<Key>((template?.key as Key | undefined) ?? 'welcome');
  const [language, setLanguage] = useState(template?.language ?? 'en');
  const [channel, setChannel] = useState<Channel | ''>(template?.channel ?? '');
  const [branchId, setBranchId] = useState(template?.branchId ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [providerName, setProviderName] = useState(template?.providerTemplateName ?? '');
  const [approval, setApproval] = useState<Approval>(template?.approvalStatus ?? 'not_required');
  const [active, setActive] = useState(template?.active ?? true);
  const [needsTranslation, setNeedsTranslation] = useState(template?.needsTranslation ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const variables = templateVariables(body);
  const fields: Omit<TemplateCreate, 'id' | 'key'> = {
    language: language.trim(),
    channel: channel || null,
    branchId: branchId || null,
    body,
    providerTemplateName: providerName.trim() || null,
    approvalStatus: approval,
    active,
    needsTranslation,
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (template) await inboxApi.updateTemplate(template.id, fields);
      else await inboxApi.createTemplate({ key, ...fields });
      await onSaved();
    } catch (err) {
      setError(said(err, 'The template could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const formId = 'template-editor';
  return (
    <Dialog
      open
      onClose={onClose}
      icon={FileText}
      tone="neutral"
      title={template ? 'Edit template' : 'New template'}
      subtitle={template ? `${keyTitle(template.key)} · ${languageName(template.language)}` : undefined}
      wide
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={BTN_QUIET}>
            Cancel
          </button>
          <button type="submit" form={formId} disabled={busy || !body.trim() || !language.trim()} className={BTN_MAIN}>
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Save
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {!template && (
          <Field label="Template" wide>
            <select value={key} onChange={(e) => setKey(e.target.value as Key)} className={FIELD}>
              {INBOX_TEMPLATE_KEY_NAMES.map((k) => (
                <option key={k} value={k}>
                  {keyTitle(k)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label="Words"
          wide
          help={
            variables.length > 0
              ? `Values asked for when sending: ${variables.join(', ')}`
              : 'Write {{name}} where a value is filled in when sending.'
          }
        >
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} className={`${AREA} resize-y leading-relaxed`} />
        </Field>
        <Field label="Language">
          <input value={language} onChange={(e) => setLanguage(e.target.value)} list="template-languages" className={FIELD} />
        </Field>
        <datalist id="template-languages">
          {LANGUAGE_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </datalist>
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(e.target.value as Channel | '')} className={FIELD}>
            <option value="">Every channel</option>
            {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Park">
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={FIELD}>
            <option value="">Every park</option>
            {branchOptions(me.teams).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Approval">
          <select value={approval} onChange={(e) => setApproval(e.target.value as Approval)} className={FIELD}>
            {INBOX_TEMPLATE_APPROVALS.map((a) => (
              <option key={a} value={a}>
                {APPROVAL_LABEL[a]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Provider template name (WhatsApp)" wide>
          <input value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="lower_case_name" className={FIELD} />
        </Field>
        <div className="flex min-w-0 flex-col md:col-span-2">
          <label className={CHECK_LINE}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className={CHECK_BOX} />
            Offered in the composer
          </label>
          <label className={CHECK_LINE}>
            <input type="checkbox" checked={needsTranslation} onChange={(e) => setNeedsTranslation(e.target.checked)} className={CHECK_BOX} />
            English source, to translate
          </label>
        </div>
      </form>
      {error && (
        <div className="mt-3">
          <InlineError text={error} />
        </div>
      )}
    </Dialog>
  );
}
