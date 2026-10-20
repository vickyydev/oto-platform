import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, BookOpen, Bot, CheckCircle2, Loader2, Pencil, Plus, Radio, ShieldCheck, Trash2, Undo2, X } from 'lucide-react';
import { ApiError } from '@/api/client';
import {
  NOT_ON_YOUR_ACCESS,
  assistantApi,
  assistantCapabilities,
  notOnAccess,
  type AiChannelAccount,
  type AiExample,
  type AiMode,
  type ExampleStatus,
  type ExampleVerdict,
  type KbEntry,
  type KbLanguage,
  type KbTopic,
} from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import { Eyebrow } from '@/components/atoms';
import { Refusal } from '@/components/confirms';
import { FIELD, Field } from '@/components/CorrectAssistant';
import { Dialog } from '@/components/Dialog';
import { BackToInbox } from '@/components/TemplateSettings';
import {
  AI_MODE_OPTIONS,
  AI_MODE_TINT,
  EXAMPLE_CUSTOMER_MAX,
  EXAMPLE_REPLY_MAX,
  INTENTS,
  KB_BODY_MAX,
  KB_KEY_MAX,
  KB_LANGUAGES,
  KB_QUESTION_MAX,
  KB_STATUS_LABEL,
  KB_STATUS_TINT,
  KB_TOPICS,
  VERDICT_LABEL,
  VERDICT_OPTIONS,
  aiModeOption,
  canApproveExample,
  exampleDraftProblem,
  exampleIntent,
  exampleLanguage,
  intentLabel,
  kbDraftProblem,
  kbGroups,
  modeChangeNeedsConfirm,
  topicLabel,
} from '@/lib/assistant';
import { CHANNEL_LABEL, branchLabel, branchOptions, langLabel } from '@/lib/view';

const BUTTON =
  'inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-60';
const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 disabled:opacity-60';
const CANCEL = 'rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50';

/**
 * A part of the page the viewer's grant does not reach (a 403: the examples
 * queue needs inbox:kb:manage with operator reach, so a branch-scoped holder
 * sees the tab and is refused there) says so politely. Every other refusal is
 * the server's own sentence.
 */
function said(err: unknown, fallback: string): string {
  if (notOnAccess(err)) return NOT_ON_YOUR_ACCESS;
  return err instanceof ApiError ? err.message : fallback;
}

type Section = 'channels' | 'kb' | 'examples';

/**
 * The Assistant page (plan §C.2, §E; R7): beside the template settings, for
 * the people who run the assistant —
 *  - Channels (inbox:ai:manage): each number's mode, off / shadow / live;
 *  - Knowledge base (inbox:kb:manage): the facts it speaks from, by topic and
 *    language, drafted, approved, archived;
 *  - Examples: the corrections staff proposed, edited and approved only with
 *    the approver's "contains no personal data" tick.
 * The prototype has no settings; this page is in the template page's design
 * language (the eyebrow header card, bordered cards, the house Dialog).
 */
export function AssistantSettings({ me, onBack }: { me: InboxMe; onBack: () => void }) {
  const caps = assistantCapabilities(me);
  const sections: [Section, string][] = [
    ...(caps.ai ? ([['channels', 'Channels']] as [Section, string][]) : []),
    ...(caps.kb ? ([['kb', 'Knowledge base']] as [Section, string][]) : []),
    ...(caps.kb ? ([['examples', 'Examples']] as [Section, string][]) : []),
  ];
  const [section, setSection] = useState<Section>(sections[0]?.[0] ?? 'kb');

  return (
    <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            <Bot className="h-3.5 w-3.5" />
            Settings · Assistant
          </div>
          <p className="mt-1 text-[13px] text-slate-500">
            The assistant answers simple questions from the approved knowledge base and hands everything else to the team.
            A person replying always takes over.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BackToInbox onBack={onBack} />
          <div role="tablist" aria-label="Assistant settings" className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
            {sections.map(([s, label]) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={section === s}
                onClick={() => setSection(s)}
                className={`rounded-lg px-2.5 py-1 text-[12px] font-medium transition ${
                  section === s ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {sections.length === 0 && (
        <p className="mt-4 text-[12.5px] text-slate-500">You do not manage the assistant.</p>
      )}
      {section === 'channels' && caps.ai && <ChannelModes me={me} />}
      {section === 'kb' && caps.kb && <KnowledgeBase me={me} />}
      {section === 'examples' && caps.kb && <ExamplesQueue me={me} />}
    </div>
  );
}

// --- Channels: the per-number switch -------------------------------------------------------

function ChannelModes({ me }: { me: InboxMe }) {
  const [accounts, setAccounts] = useState<AiChannelAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ account: AiChannelAccount; to: AiMode } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts((await assistantApi.channelAccounts()).channelAccounts);
      setError(null);
    } catch (err) {
      setError(said(err, 'The channel numbers could not be read.'));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const apply = async (account: AiChannelAccount, to: AiMode) => {
    setBusyId(account.id);
    setRowError(null);
    try {
      await assistantApi.setAiMode(account.id, to);
      setConfirm(null);
      await load();
    } catch (err) {
      setRowError({ id: account.id, text: said(err, 'The mode could not be changed.') });
      setConfirm(null);
    } finally {
      setBusyId(null);
    }
  };

  const choose = (account: AiChannelAccount, to: AiMode) => {
    if (to === account.aiMode) return;
    if (modeChangeNeedsConfirm(account.aiMode, to)) setConfirm({ account, to });
    else void apply(account, to);
  };

  return (
    <div className="mt-4 space-y-3">
      <div className="rounded-xl bg-indigo-50 px-3 py-2 text-[12.5px] text-indigo-800 ring-1 ring-indigo-100">
        <span className="font-semibold">Live means customers hear it.</span> Run a number in Shadow first: the assistant
        records what it would have said, and nobody sees it.
      </div>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {AI_MODE_OPTIONS.map((o) => (
          <div key={o.value} className="min-w-0 rounded-xl border border-slate-200 p-3">
            <dt>
              <span className={`rounded-full px-1.5 text-[10px] font-semibold ring-1 ${AI_MODE_TINT[o.value]}`}>{o.label}</span>
            </dt>
            <dd className="mt-1.5 text-[12px] text-slate-600">{o.description}</dd>
          </div>
        ))}
      </dl>

      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}
      {!error && accounts === null && <Spinner />}
      {accounts?.length === 0 && <p className="text-[12.5px] text-slate-500">No channel numbers yet.</p>}
      <ul className="space-y-2">
        {accounts?.map((a) => (
          <li key={a.id} className="min-w-0 rounded-xl border border-slate-200 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-slate-900">{a.displayName}</div>
                <div className="text-[11px] text-slate-500">
                  {CHANNEL_LABEL[a.channel]} · {a.branchId ? branchLabel(a.branchId, me.teams) : 'Both parks'}
                </div>
              </div>
              <div role="radiogroup" aria-label={`Assistant mode for ${a.displayName}`} className="flex shrink-0 gap-1 rounded-xl bg-slate-100 p-1">
                {AI_MODE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={a.aiMode === o.value}
                    disabled={busyId !== null}
                    onClick={() => choose(a, o.value)}
                    className={`rounded-lg px-2.5 py-1 text-[12px] font-medium transition disabled:opacity-60 ${
                      a.aiMode === o.value
                        ? o.value === 'live'
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-slate-500">
              {busyId === a.id && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />}
              <span className="min-w-0">{aiModeOption(a.aiMode).description}</span>
            </p>
            {rowError?.id === a.id && <Refusal text={rowError.text} />}
          </li>
        ))}
      </ul>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        icon={Radio}
        iconTint="bg-indigo-50 text-indigo-600"
        title="Put the assistant live on this number?"
        subtitle={confirm ? `${confirm.account.displayName} · ${CHANNEL_LABEL[confirm.account.channel]}` : undefined}
        footer={
          <>
            <button type="button" onClick={() => setConfirm(null)} disabled={busyId !== null} className={CANCEL}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => confirm && void apply(confirm.account, confirm.to)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {busyId !== null && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Yes, customers hear it
            </button>
          </>
        }
      >
        <p className="text-[12.5px] text-slate-600">{aiModeOption('live').description}</p>
        <p className="mt-2 text-[12.5px] text-slate-500">You can switch it back to Shadow or Off at any time.</p>
      </Dialog>
    </div>
  );
}

// --- The knowledge base -------------------------------------------------------------------

function KnowledgeBase({ me }: { me: InboxMe }) {
  const [archived, setArchived] = useState(false);
  const [entries, setEntries] = useState<KbEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<KbEntry | 'new' | null>(null);
  const [acting, setActing] = useState<{ entry: KbEntry; what: 'approve' | 'archive' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries((await assistantApi.kb(archived)).entries);
      setError(null);
    } catch (err) {
      setError(said(err, 'The knowledge base could not be read.'));
    }
  }, [archived]);
  useEffect(() => {
    setEntries(null);
    void load();
  }, [load]);

  const act = async () => {
    if (!acting) return;
    setBusy(true);
    setActError(null);
    try {
      if (acting.what === 'approve') await assistantApi.approveKb(acting.entry.id);
      else await assistantApi.archiveKb(acting.entry.id);
      setActing(null);
      await load();
    } catch (err) {
      setActError(said(err, acting.what === 'approve' ? 'The entry could not be approved.' : 'The entry could not be archived.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-[12.5px] text-slate-500">
          Only approved entries reach the assistant. Opening hours, addresses and ticket prices come from the platform
          itself; write notes beside them here, never the numbers. An approved entry is not edited: archive it and draft
          a new one with the same key.
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
            New entry
          </button>
        </div>
      </div>

      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}
      {!error && entries === null && <Spinner />}
      {entries?.length === 0 && <p className="mt-4 text-[12.5px] text-slate-500">No entries yet.</p>}

      <div className="mt-4 space-y-5">
        {kbGroups(entries ?? []).map((g) => (
          <section key={g.topic} className="min-w-0">
            <Eyebrow className="mb-2">{topicLabel(g.topic)}</Eyebrow>
            <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {g.entries.map((e) => (
                <li key={e.id} className={`min-w-0 rounded-xl border border-slate-200 p-3 ${e.status === 'archived' ? 'opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 break-all font-mono text-[11px] text-slate-700">{e.key}</span>
                    <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-600">{langLabel(e.language)}</span>
                    <span className="text-[11px] text-slate-500">{e.branchId ? branchLabel(e.branchId, me.teams) : 'Both parks'}</span>
                    <span className={`rounded-full px-1.5 text-[10px] font-medium ring-1 ${KB_STATUS_TINT[e.status]}`}>
                      {KB_STATUS_LABEL[e.status]}
                    </span>
                    {e.needsTranslation && (
                      <span className="rounded-full bg-amber-50 px-1.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                        English source, to translate
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 break-words text-[12.5px] font-medium text-slate-800">{e.question}</p>
                  <p className="mt-1 line-clamp-4 whitespace-pre-line break-words text-[12.5px] text-slate-600">{e.body}</p>
                  {e.status !== 'archived' && e.canManage && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {e.status === 'draft' && (
                        <button type="button" onClick={() => setEditing(e)} className={BUTTON}>
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                      )}
                      {e.status === 'draft' && (
                        <button
                          type="button"
                          onClick={() => {
                            setActError(null);
                            setActing({ entry: e, what: 'approve' });
                          }}
                          className={BUTTON}
                        >
                          <CheckCircle2 className="h-3 w-3" /> Approve
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setActError(null);
                          setActing({ entry: e, what: 'archive' });
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
        <KbEditor
          me={me}
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      <Dialog
        open={acting !== null}
        onClose={() => setActing(null)}
        icon={acting?.what === 'approve' ? CheckCircle2 : Archive}
        iconTint={acting?.what === 'approve' ? 'bg-emerald-50 text-emerald-600' : undefined}
        title={acting?.what === 'approve' ? 'Approve this entry?' : 'Archive this entry?'}
        subtitle={acting ? `${acting.entry.key} · ${langLabel(acting.entry.language)}` : undefined}
        footer={
          <>
            <button type="button" onClick={() => setActing(null)} disabled={busy} className={CANCEL}>
              Cancel
            </button>
            <button type="button" onClick={() => void act()} disabled={busy} className={PRIMARY}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {acting?.what === 'approve' ? 'Yes, approve' : 'Yes, archive'}
            </button>
          </>
        }
      >
        <p className="text-[12.5px] text-slate-500">
          {acting?.what === 'approve'
            ? 'The assistant may answer customers from these words from now on, on every number that is live. You are recorded as the approver.'
            : 'The assistant stops using it, and its key is free for a new entry.'}
        </p>
        {acting?.what === 'approve' && (
          <p className="mt-2 whitespace-pre-line break-words rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-700">
            {acting.entry.body}
          </p>
        )}
        {actError && <Refusal text={actError} />}
      </Dialog>
    </div>
  );
}

function KbEditor({
  me,
  entry,
  onClose,
  onSaved,
}: {
  me: InboxMe;
  entry: KbEntry | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [topic, setTopic] = useState<KbTopic>(entry?.topic ?? 'faq');
  const [key, setKey] = useState(entry?.key ?? '');
  const [language, setLanguage] = useState<KbLanguage>(entry?.language ?? 'en');
  const [branchId, setBranchId] = useState(entry?.branchId ?? '');
  const [question, setQuestion] = useState(entry?.question ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [needsTranslation, setNeedsTranslation] = useState(entry?.needsTranslation ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = kbDraftProblem({ topic, key, language, question, body });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      if (entry)
        await assistantApi.updateKb(entry.id, {
          branchId: branchId || null,
          topic,
          key,
          language,
          question: question.trim(),
          body: body.trim(),
          needsTranslation,
        });
      else
        await assistantApi.createKb({
          id: crypto.randomUUID(),
          branchId: branchId || null,
          topic,
          key,
          language,
          question: question.trim(),
          body: body.trim(),
          needsTranslation,
        });
      await onSaved();
    } catch (err) {
      setError(said(err, 'The entry could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const formId = 'kb-editor';
  return (
    <Dialog
      open
      onClose={onClose}
      icon={BookOpen}
      iconTint="bg-indigo-50 text-indigo-600"
      title={entry ? 'Edit entry' : 'New entry'}
      subtitle={
        entry
          ? `${entry.key} · ${langLabel(entry.language)}`
          : 'Saved as a draft. It reaches the assistant once approved.'
      }
      wide
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button type="submit" form={formId} disabled={busy || problem !== null} className={PRIMARY}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Topic">
          <select value={topic} onChange={(e) => setTopic(e.target.value as KbTopic)} className={FIELD}>
            {KB_TOPICS.map((t) => (
              <option key={t} value={t}>
                {topicLabel(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Key · ${key.length}/${KB_KEY_MAX}`}>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
            maxLength={KB_KEY_MAX}
            placeholder="faq.food-outside"
            className={`${FIELD} font-mono`}
          />
        </Field>
        <Field label="Language">
          <select
            value={language}
            onChange={(e) => setLanguage(exampleLanguage(e.target.value))}
            className={FIELD}
          >
            {KB_LANGUAGES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Park">
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className={FIELD}
          >
            <option value="">Both parks</option>
            {branchOptions(me.teams).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`The question, as a customer would ask it · ${question.length}/${KB_QUESTION_MAX}`} wide>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={KB_QUESTION_MAX} className={FIELD} />
        </Field>
        <Field label={`The answer · ${body.length}/${KB_BODY_MAX}`} wide>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={KB_BODY_MAX} className={`${FIELD} resize-y`} />
        </Field>
        <label className="inline-flex items-center gap-1.5 text-[12px] text-slate-600 sm:col-span-2">
          <input type="checkbox" checked={needsTranslation} onChange={(e) => setNeedsTranslation(e.target.checked)} />
          English source, to translate (the assistant uses the English entry until this one is translated)
        </label>
        {problem && (key || question || body) && <p className="text-[11.5px] text-slate-500 sm:col-span-2">{problem}</p>}
      </form>
      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}
    </Dialog>
  );
}

// --- The examples queue (§E) --------------------------------------------------------------

const EXAMPLE_TABS: [ExampleStatus, string][] = [
  ['proposed', 'To review'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
];

function ExamplesQueue({ me }: { me: InboxMe }) {
  const [status, setStatus] = useState<ExampleStatus>('proposed');
  const [examples, setExamples] = useState<AiExample[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AiExample | null>(null);
  const [withdrawing, setWithdrawing] = useState<AiExample | null>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const proposer = (x: AiExample) => me.people.find((p) => p.accountId === x.proposedByAccountId)?.name ?? null;

  const load = useCallback(async () => {
    try {
      setExamples((await assistantApi.examples(status)).examples);
      setError(null);
    } catch (err) {
      setError(said(err, 'The examples could not be read.'));
    }
  }, [status]);
  useEffect(() => {
    setExamples(null);
    void load();
  }, [load]);

  // Withdraw an approved example (test night U2): the api's reject takes it
  // out of the assistant; the screen had no control for it.
  const withdraw = async () => {
    if (!withdrawing) return;
    setBusy(true);
    setWithdrawError(null);
    try {
      await assistantApi.rejectExample(withdrawing.id);
      setWithdrawing(null);
      await load();
    } catch (err) {
      setWithdrawError(said(err, 'The example could not be withdrawn.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-[12.5px] text-slate-500">
          Corrections staff proposed from the conversations. An approved example is what the assistant answers from next;
          approve only once it holds no names, numbers or children’s details.
        </p>
        <div className="flex shrink-0 gap-1 rounded-xl bg-slate-100 p-1">
          {EXAMPLE_TABS.map(([s, label]) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={`rounded-lg px-2.5 py-1 text-[12px] font-medium ${
                status === s ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}
      {!error && examples === null && <Spinner />}
      {examples?.length === 0 && <p className="mt-4 text-[12.5px] text-slate-500">Nothing here.</p>}
      <ul className="mt-4 grid grid-cols-1 gap-2 lg:grid-cols-2">
        {examples?.map((x) => (
          <ExampleCard
            key={x.id}
            example={x}
            proposer={proposer(x)}
            onReview={() => setOpen(x)}
            onWithdraw={() => {
              setWithdrawError(null);
              setWithdrawing(x);
            }}
          />
        ))}
      </ul>

      {open && (
        <ExampleReview
          example={open}
          onClose={() => setOpen(null)}
          onDone={async () => {
            setOpen(null);
            await load();
          }}
        />
      )}

      <WithdrawExampleConfirm
        example={withdrawing}
        busy={busy}
        error={withdrawError}
        onCancel={() => setWithdrawing(null)}
        onConfirm={() => void withdraw()}
      />
    </div>
  );
}

/**
 * One example in the queue: Review while proposed; Withdraw once approved
 * (test night U2 — an approved example could not be pulled back on screen).
 */
export function ExampleCard({
  example: x,
  proposer,
  onReview,
  onWithdraw,
}: {
  example: AiExample;
  proposer: string | null;
  onReview: () => void;
  onWithdraw: () => void;
}) {
  return (
    <li className="min-w-0 rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-600">{langLabel(x.language)}</span>
        <span className="text-[11px] text-slate-500">{intentLabel(x.intent)}</span>
        <span className="rounded-full bg-indigo-50 px-1.5 text-[10px] font-medium text-indigo-700 ring-1 ring-indigo-200">
          {VERDICT_LABEL[x.verdict]}
        </span>
        {proposer && <span className="text-[11px] text-slate-400">by {proposer}</span>}
      </div>
      <p className="mt-1.5 line-clamp-3 whitespace-pre-line break-words text-[12.5px] text-slate-800">{x.customerText}</p>
      {x.goodReply && (
        <p className="mt-1 line-clamp-3 whitespace-pre-line break-words rounded-lg bg-indigo-50/60 px-2 py-1 text-[12.5px] text-indigo-900">
          {x.goodReply}
        </p>
      )}
      {x.status === 'proposed' && (
        <div className="mt-2">
          <button type="button" onClick={onReview} className={BUTTON}>
            <Pencil className="h-3 w-3" /> Review
          </button>
        </div>
      )}
      {x.status === 'approved' && (
        <div className="mt-2">
          <button type="button" onClick={onWithdraw} className={BUTTON}>
            <Undo2 className="h-3 w-3" /> Withdraw
          </button>
        </div>
      )}
    </li>
  );
}

/** What withdrawing means, said before the press. */
export const WITHDRAW_EXAMPLE_LINE = 'The assistant stops using this example on every live number.';

export function WithdrawExampleConfirm({
  example,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  example: AiExample | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={example !== null}
      onClose={onCancel}
      icon={Undo2}
      iconTint="bg-amber-50 text-amber-600"
      title="Withdraw this example?"
      subtitle={example ? `${intentLabel(example.intent)} · ${langLabel(example.language)}` : undefined}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={PRIMARY}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Yes, withdraw
          </button>
        </>
      }
    >
      <p className="text-[12.5px] text-slate-700">{WITHDRAW_EXAMPLE_LINE}</p>
      <p className="mt-2 text-[12.5px] text-slate-500">It moves to Rejected and stays there; propose a new one to replace it.</p>
      {example && (
        <p className="mt-2 line-clamp-4 whitespace-pre-line break-words rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-700">
          {example.customerText}
        </p>
      )}
      {error && <Refusal text={error} />}
    </Dialog>
  );
}

/**
 * Review one proposed example: edit its words, verdict and topic; save; reject;
 * or approve — and Approve stays disabled until the approver ticks "contains
 * no personal data" (`canApproveExample`, §D.5). Edits are saved before the
 * approval, so what is approved is what was on screen.
 */
export function ExampleReview({
  example,
  onClose,
  onDone,
}: {
  example: AiExample;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [customerText, setCustomerText] = useState(example.customerText);
  const [goodReply, setGoodReply] = useState(example.goodReply ?? '');
  const [verdict, setVerdict] = useState<ExampleVerdict>(example.verdict);
  const [intent, setIntent] = useState(exampleIntent(example.intent));
  const [language, setLanguage] = useState<KbLanguage>(example.language);
  const [deidentified, setDeidentified] = useState(false);
  const [busy, setBusy] = useState<'save' | 'approve' | 'reject' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const draft = { customerText, goodReply, verdict };
  const problem = exampleDraftProblem(draft);
  const approvable = canApproveExample({ deidentified, draft, busy: busy !== null });
  const changed =
    customerText !== example.customerText ||
    goodReply !== (example.goodReply ?? '') ||
    verdict !== example.verdict ||
    intent !== example.intent ||
    language !== example.language;

  const run = async (what: 'save' | 'approve' | 'reject' | 'delete') => {
    setBusy(what);
    setError(null);
    try {
      if (what === 'reject') {
        await assistantApi.rejectExample(example.id);
      } else if (what === 'delete') {
        await assistantApi.deleteExample(example.id);
      } else {
        if (changed) {
          await assistantApi.updateExample(example.id, {
            customerText: customerText.trim(),
            goodReply: goodReply.trim() || null,
            verdict,
            intent,
            language,
          });
        }
        if (what === 'approve') await assistantApi.approveExample(example.id);
      }
      await onDone();
    } catch (err) {
      setError(said(err, 'The example could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      icon={ShieldCheck}
      iconTint="bg-indigo-50 text-indigo-600"
      title="Review the example"
      subtitle="Edit it until it holds no personal data, then approve it."
      wide
      footer={
        <>
          <button
            type="button"
            onClick={() => void run('reject')}
            disabled={busy !== null}
            className="mr-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-60"
          >
            {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            Reject
          </button>
          <button
            type="button"
            onClick={() => void run('delete')}
            disabled={busy !== null}
            title="Remove it for good: a proposal may still hold the conversation’s words"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-60"
          >
            {busy === 'delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete
          </button>
          <button
            type="button"
            onClick={() => void run('save')}
            disabled={busy !== null || problem !== null || !changed}
            className={CANCEL}
          >
            Save
          </button>
          <button type="button" onClick={() => void run('approve')} disabled={!approvable} className={PRIMARY}>
            {busy === 'approve' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Approve
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="What should it have done?" wide>
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as ExampleVerdict)} className={FIELD}>
            {VERDICT_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`The customer asked · ${customerText.length}/${EXAMPLE_CUSTOMER_MAX}`} wide>
          <textarea
            value={customerText}
            onChange={(e) => setCustomerText(e.target.value)}
            rows={3}
            maxLength={EXAMPLE_CUSTOMER_MAX}
            className={`${FIELD} resize-y`}
          />
        </Field>
        <Field label={`The good reply${verdict === 'should_answer' ? '' : ' (optional)'} · ${goodReply.length}/${EXAMPLE_REPLY_MAX}`} wide>
          <textarea
            value={goodReply}
            onChange={(e) => setGoodReply(e.target.value)}
            rows={4}
            maxLength={EXAMPLE_REPLY_MAX}
            className={`${FIELD} resize-y`}
          />
        </Field>
        <Field label="Topic of the question">
          <select value={intent} onChange={(e) => setIntent(exampleIntent(e.target.value))} className={FIELD}>
            {INTENTS.map((i) => (
              <option key={i} value={i}>
                {intentLabel(i)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Language">
          <select value={language} onChange={(e) => setLanguage(exampleLanguage(e.target.value))} className={FIELD}>
            {KB_LANGUAGES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {problem && <p className="text-[11.5px] text-slate-500 sm:col-span-2">{problem}</p>}
        <label className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 ring-1 ring-amber-200 sm:col-span-2">
          <input
            type="checkbox"
            checked={deidentified}
            onChange={(e) => setDeidentified(e.target.checked)}
            className="mt-0.5"
            aria-describedby="deidentified-help"
          />
          <span>
            <span className="font-semibold">Contains no personal data.</span>{' '}
            <span id="deidentified-help">
              I checked: no names, phone numbers, handles, children’s details or anything else that points at a person.
              Approval unlinks it from the conversation for good.
            </span>
          </span>
        </label>
      </div>
      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}
    </Dialog>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-8 text-slate-400">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}
