import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Archive, FileText, Loader2, Paperclip, Pencil, Plus, Upload } from 'lucide-react';
import { INBOX_TEMPLATE_APPROVALS, INBOX_TEMPLATE_KEY_NAMES, templateVariables } from '@oto/shared/inbox-reply';
import { ApiError } from '@/api/client';
import { BROCHURE_MAX_BYTES, BROCHURE_TYPES, assistantApi } from '@/api/assistant';
import { inboxApi, type InboxMe, type ManagedTemplate, type TemplateCreate } from '@/api/inbox';
import { Eyebrow } from '@/components/atoms';
import { Refusal } from '@/components/confirms';
import { Dialog } from '@/components/Dialog';
import { CHANNEL_LABEL, LANGUAGE_OPTIONS, branchLabel, branchOptions, langLabel } from '@/lib/view';

type Channel = NonNullable<ManagedTemplate['channel']>;
type Approval = (typeof INBOX_TEMPLATE_APPROVALS)[number];
type Key = (typeof INBOX_TEMPLATE_KEY_NAMES)[number];

const FIELD =
  'w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12.5px] text-slate-800 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200';
const BUTTON =
  'inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-60';

const keyLabel = (key: string) => key.replace(/[_.]/g, ' ');

const APPROVAL_LABEL: Record<Approval, string> = {
  not_required: 'No approval needed',
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
};
const APPROVAL_TINT: Record<Approval, string> = {
  not_required: 'bg-slate-100 text-slate-600 ring-slate-200',
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 ring-rose-200',
};

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
 * The prototype has no settings; this page is in its design language (the
 * header card's eyebrow, the bordered cards, the house Dialog).
 */
export function TemplateSettings({ me }: { me: InboxMe }) {
  const [archived, setArchived] = useState(false);
  const [templates, setTemplates] = useState<ManagedTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ManagedTemplate | 'new' | null>(null);
  const [archiving, setArchiving] = useState<ManagedTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

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

  const archive = async () => {
    if (!archiving) return;
    setBusy(true);
    setArchiveError(null);
    try {
      await inboxApi.archiveTemplate(archiving.id);
      setArchiving(null);
      await load();
    } catch (err) {
      setArchiveError(said(err, 'The template could not be archived.'));
    } finally {
      setBusy(false);
    }
  };

  const byKey = INBOX_TEMPLATE_KEY_NAMES.map((key) => ({
    key,
    rows: (templates ?? []).filter((t) => t.key === key),
  })).filter((g) => g.rows.length > 0);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            <FileText className="h-3.5 w-3.5" />
            Settings · Templates
          </div>
          <p className="mt-1 text-[13px] text-slate-500">
            The standard lines the composer offers, per language, channel and park. Outside a channel’s reply window
            only an approved template can be sent.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[12px] text-slate-600">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Show archived
          </label>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-[12px] font-medium text-white hover:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            New template
          </button>
        </div>
      </div>

      {error && <Refusal text={error} />}
      {!error && templates === null && (
        <div className="flex justify-center py-8 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {templates?.length === 0 && <p className="mt-4 text-[12.5px] text-slate-500">No templates yet.</p>}

      <div className="mt-4 space-y-5">
        {byKey.map((g) => (
          <section key={g.key} className="min-w-0">
            <Eyebrow className="mb-2">{keyLabel(g.key)}</Eyebrow>
            <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {g.rows.map((t) => (
                <li key={t.id} className={`min-w-0 rounded-xl border border-slate-200 p-3 ${t.archivedAt ? 'opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-600">{langLabel(t.language)}</span>
                    <span className="text-[11px] text-slate-500">
                      {t.channel ? CHANNEL_LABEL[t.channel] : 'Every channel'} · {t.branchId ? branchLabel(t.branchId, me.teams) : 'Every park'}
                    </span>
                    <span className={`rounded-full px-1.5 text-[10px] font-medium ring-1 ${APPROVAL_TINT[t.approvalStatus]}`}>
                      {APPROVAL_LABEL[t.approvalStatus]}
                    </span>
                    {!t.active && (
                      <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200">Inactive</span>
                    )}
                    {t.archivedAt && (
                      <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200">Archived</span>
                    )}
                    {t.needsTranslation && (
                      <span className="rounded-full bg-amber-50 px-1.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                        English source, to translate
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 line-clamp-4 whitespace-pre-line break-words text-[12.5px] text-slate-700">{t.body}</p>
                  {t.key === BROCHURE_KEY && <Brochure template={t} onChanged={load} />}
                  {!t.archivedAt && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <button type="button" onClick={() => setEditing(t)} className={BUTTON}>
                        <Pencil className="h-3 w-3" /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setArchiveError(null);
                          setArchiving(t);
                        }}
                        className={BUTTON}
                      >
                        <Archive className="h-3 w-3" /> Archive
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {editing !== null && (
        <TemplateEditor
          me={me}
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      <Dialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        icon={Archive}
        title="Archive this template?"
        subtitle={archiving ? `${keyLabel(archiving.key)} · ${langLabel(archiving.language)}` : undefined}
        footer={
          <>
            <button
              type="button"
              onClick={() => setArchiving(null)}
              disabled={busy}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void archive()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Yes, archive
            </button>
          </>
        }
      >
        <p className="text-[12.5px] text-slate-500">
          It leaves the composer and this list for good. The messages already sent from it keep naming it.
        </p>
        {archiveError && <Refusal text={archiveError} />}
      </Dialog>
    </div>
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
      setError(
        said(err, 'The brochure could not be uploaded.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg bg-violet-50/60 px-2.5 py-1.5 ring-1 ring-violet-100">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-violet-800">
        <Paperclip className="h-3 w-3" />
        <span className="min-w-0 flex-1">
          {count > 0 ? `Birthday brochure attached (${count} file${count === 1 ? '' : 's'})` : 'No birthday brochure yet'}
        </span>
        {!template.archivedAt && (
          <label className={`${BUTTON} cursor-pointer`}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
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
      {error && <Refusal text={error} />}
    </div>
  );
}

/** New or edit, on the house Dialog. */
function TemplateEditor({
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
      iconTint="bg-violet-50 text-violet-600"
      title={template ? 'Edit template' : 'New template'}
      subtitle={template ? `${keyLabel(template.key)} · ${langLabel(template.language)}` : undefined}
      wide
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={busy || !body.trim() || !language.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {!template && (
          <Field label="Template">
            <select value={key} onChange={(e) => setKey(e.target.value as Key)} className={FIELD}>
              {INBOX_TEMPLATE_KEY_NAMES.map((k) => (
                <option key={k} value={k}>
                  {keyLabel(k)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Language">
          <input value={language} onChange={(e) => setLanguage(e.target.value)} list="template-languages" className={FIELD} />
          <datalist id="template-languages">
            {LANGUAGE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </datalist>
        </Field>
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
        <Field label="Provider template name (WhatsApp)">
          <input
            value={providerName}
            onChange={(e) => setProviderName(e.target.value)}
            placeholder="lower_case_name"
            className={FIELD}
          />
        </Field>
        <Field label="Words" wide>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className={`${FIELD} resize-y`} />
          <span className="text-[11px] font-normal text-slate-400">
            {variables.length > 0
              ? `Values asked for when sending: ${variables.join(', ')}`
              : 'Write {{name}} where a value is filled in when sending.'}
          </span>
        </Field>
        <label className="inline-flex items-center gap-1.5 text-[12px] text-slate-600">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Offered in the composer
        </label>
        <label className="inline-flex items-center gap-1.5 text-[12px] text-slate-600">
          <input type="checkbox" checked={needsTranslation} onChange={(e) => setNeedsTranslation(e.target.checked)} />
          English source, to translate
        </label>
      </form>
      {error && <Refusal text={error} />}
    </Dialog>
  );
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-[11px] font-medium text-slate-500 ${wide ? 'sm:col-span-2' : ''}`}>
      {label}
      {children}
    </label>
  );
}
