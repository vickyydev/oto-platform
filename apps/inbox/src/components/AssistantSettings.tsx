import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, BookOpen, Bot, CheckCircle2, Loader2, Pencil, Plus, Radio, ShieldCheck, Trash2, Undo2, X } from 'lucide-react';
import { newId } from '@oto/shared/ids';
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
import type { AssistantTab } from '@/lib/url';
import { KbConfirm } from '@/components/AssistantConfirms';
import { Eyebrow } from '@/components/atoms';
import { Refusal } from '@/components/confirms';
import { FIELD, Field } from '@/components/CorrectAssistant';
import { Dialog } from '@/components/Dialog';
import {
  BADGE,
  BTN_MAIN,
  BTN_QUIET,
  BTN_SMALL,
  CHECK_BOX,
  CHECK_LINE,
  HINT,
  ITEM_CARD,
  PAGE_CARD,
  PAGE_EYEBROW,
  PAGE_LINE,
  SEGMENT,
  SEGMENT_OFF,
  SEGMENT_ON,
  TONE,
} from '@/components/ui';
import { RulesPanel } from '@/components/RulesPanel';
import { TeachPanel } from '@/components/TeachPanel';
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

// The house controls (SCRUM-1016, components/ui.ts): the page looks part of the Inbox, and does what it did.
const BUTTON = BTN_SMALL;
const PRIMARY = BTN_MAIN;
const CANCEL = BTN_QUIET;

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

/**
 * The page's tabs, by the viewer's rights (owner UI round 2026-10-22, F2):
 * Numbers (inbox:ai:manage), Knowledge, Examples, Rules and Teach
 * (inbox:kb:manage; the last two SCRUM-696). Pure, so the tests read the real
 * thing; the first is the default tab.
 */
export function assistantSections(caps: { ai: boolean; kb: boolean }): [AssistantTab, string][] {
  return [
    ...(caps.ai ? ([['numbers', 'Numbers']] as [AssistantTab, string][]) : []),
    ...(caps.kb
      ? ([
          ['knowledge', 'Knowledge'],
          ['examples', 'Examples'],
          ['rules', 'Rules'],
          ['teach', 'Teach'],
        ] as [AssistantTab, string][])
      : []),
  ];
}

/**
 * The Assistant page (plan §C.2, §E; R7): beside the template settings, for
 * the people who run the assistant —
 *  - Numbers (inbox:ai:manage): each number's mode, off / shadow / live;
 *  - Knowledge (inbox:kb:manage): the facts it speaks from, by topic and
 *    language, drafted, approved, archived;
 *  - Examples: the corrections staff proposed, edited and approved only with
 *    the approver's "contains no personal data" tick.
 * The tab lives in the URL (`?settings=assistant&section=…`, UI round 2026-10-22,
 * F2); null is the default, the first tab the viewer may see.
 * The prototype has no settings; this page is in the template page's design
 * language (the eyebrow header card, bordered cards, the house Dialog).
 */
export function AssistantSettings({
  me,
  tab,
  onBack,
  onTab,
}: {
  me: InboxMe;
  tab: AssistantTab | null;
  onBack: () => void;
  onTab: (t: AssistantTab) => void;
}) {
  const caps = assistantCapabilities(me);
  const sections = assistantSections(caps);
  const section: AssistantTab = tab !== null && sections.some(([s]) => s === tab) ? tab : (sections[0]?.[0] ?? 'knowledge');

  return (
    <div className={`min-w-0 ${PAGE_CARD}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className={PAGE_EYEBROW}>
            <Bot aria-hidden className="h-4 w-4" />
            Settings · Assistant
          </div>
          <p className={PAGE_LINE}>
            The assistant answers simple questions from the approved knowledge base and hands everything else to the team.
            A person replying always takes over.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BackToInbox onBack={onBack} />
          <div role="tablist" aria-label="Assistant settings" className="flex flex-wrap gap-1 rounded-xl bg-band p-1">
            {sections.map(([s, label]) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={section === s}
                onClick={() => onTab(s)}
                className={`${SEGMENT} ${section === s ? SEGMENT_ON : SEGMENT_OFF}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {sections.length === 0 && (
        <p className="mt-4 text-[13.5px] text-ink-muted">You do not manage the assistant.</p>
      )}
      {section === 'numbers' && caps.ai && <ChannelModes me={me} />}
      {section === 'knowledge' && caps.kb && <KnowledgeBase me={me} />}
      {section === 'examples' && caps.kb && <ExamplesQueue me={me} />}
      {section === 'rules' && caps.kb && <RulesPanel me={me} />}
      {/* The teach chat stays mounted, hidden, while another tab shows, so a
          card's "Open in Rules" and the way back keep the conversation. */}
      {caps.kb && (
        <div className={section === 'teach' ? undefined : 'hidden'} data-teach-chat>
          <TeachPanel me={me} active={section === 'teach'} onTab={onTab} />
        </div>
      )}
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
      <div className="rounded-xl bg-mint px-3 py-2 text-[13.5px] text-teal ring-1 ring-mint-edge md:text-[13px]">
        <span className="font-semibold">Live means customers hear it.</span> Run a number in Shadow first: the assistant
        records what it would have said, and nobody sees it.
      </div>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {AI_MODE_OPTIONS.map((o) => (
          <div key={o.value} className={ITEM_CARD}>
            <dt>
              <span className={`${BADGE} ring-1 ${AI_MODE_TINT[o.value]}`}>{o.label}</span>
            </dt>
            <dd className="mt-1.5 text-[12px] text-ink-soft">{o.description}</dd>
          </div>
        ))}
      </dl>

      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'ask' : 'danger'} />}
      {!error && accounts === null && <Spinner />}
      {accounts?.length === 0 && <p className="text-[13.5px] leading-relaxed text-ink-muted md:text-[13px]">No channel numbers yet.</p>}
      <ul className="space-y-2">
        {accounts?.map((a) => (
          <li key={a.id} className={ITEM_CARD}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-ink">{a.displayName}</div>
                <div className="text-[12.5px] text-ink-muted">
                  {CHANNEL_LABEL[a.channel]} · {a.branchId ? branchLabel(a.branchId, me.teams) : 'Both parks'}
                </div>
              </div>
              <div role="radiogroup" aria-label={`Assistant mode for ${a.displayName}`} className="flex shrink-0 gap-1 rounded-xl bg-band p-1">
                {AI_MODE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={a.aiMode === o.value}
                    disabled={busyId !== null}
                    onClick={() => choose(a, o.value)}
                    className={`${SEGMENT} ${
                      a.aiMode === o.value ? (o.value === 'live' ? 'bg-teal text-mint shadow-sm' : SEGMENT_ON) : SEGMENT_OFF
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] text-ink-muted">
              {busyId === a.id && <Loader2 aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
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
        tone="assistant"
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
              className={BTN_MAIN}
            >
              {busyId !== null && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
              Yes, customers hear it
            </button>
          </>
        }
      >
        <p className="text-[12.5px] text-ink-soft">{aiModeOption('live').description}</p>
        <p className="mt-2 text-[12.5px] text-ink-muted">You can switch it back to Shadow or Off at any time.</p>
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
        <p className="min-w-0 text-[12.5px] text-ink-muted">
          Only approved entries reach the assistant. Opening hours, addresses and ticket prices come from the platform
          itself; write notes beside them here, never the numbers. Editing an approved entry replaces it at once; the
          previous words stay in the archive.
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <label className={CHECK_LINE}>
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className={CHECK_BOX} />
            Show archived
          </label>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className={BTN_MAIN}
          >
            <Plus className="h-3.5 w-3.5" />
            New entry
          </button>
        </div>
      </div>

      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'ask' : 'danger'} />}
      {!error && entries === null && <Spinner />}
      {entries?.length === 0 && <p className="mt-4 text-[12.5px] text-ink-muted">No entries yet.</p>}

      <div className="mt-4 space-y-5">
        {kbGroups(entries ?? []).map((g) => (
          <section key={g.topic} className="min-w-0">
            <Eyebrow className="mb-2">{topicLabel(g.topic)}</Eyebrow>
            <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {g.entries.map((e) => (
                <li key={e.id} className={`min-w-0 rounded-xl border border-line p-3 ${e.status === 'archived' ? 'opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 break-all font-mono text-[12px] text-ink">{e.key}</span>
                    <span className={`${BADGE} ${TONE.neutral}`}>{langLabel(e.language)}</span>
                    <span className="text-[12px] text-ink-muted">{e.branchId ? branchLabel(e.branchId, me.teams) : 'Both parks'}</span>
                    <span className={`${BADGE} ring-1 ${KB_STATUS_TINT[e.status]}`}>
                      {KB_STATUS_LABEL[e.status]}
                    </span>
                    {e.needsTranslation && (
                      <span className={`${BADGE} ${TONE.ask}`}>
                        English source, to translate
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 break-words text-[12.5px] font-medium text-ink">{e.question}</p>
                  <p className="mt-1 line-clamp-4 whitespace-pre-line break-words text-[12.5px] text-ink-soft">{e.body}</p>
                  {e.status !== 'archived' && e.canManage && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => setEditing(e)} className={BUTTON}>
                        <Pencil aria-hidden className="h-3.5 w-3.5" /> Edit
                      </button>
                      {e.status === 'draft' && (
                        <button
                          type="button"
                          onClick={() => {
                            setActError(null);
                            setActing({ entry: e, what: 'approve' });
                          }}
                          className={BUTTON}
                        >
                          <CheckCircle2 aria-hidden className="h-3.5 w-3.5" /> Approve
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
                        <Archive aria-hidden className="h-3.5 w-3.5" /> Archive
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

      <KbConfirm acting={acting} busy={busy} error={actError} onCancel={() => setActing(null)} onConfirm={() => void act()} />
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
          id: newId(),
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
      tone="assistant"
      title={entry ? 'Edit entry' : 'New entry'}
      subtitle={
        entry
          ? `${entry.key} · ${langLabel(entry.language)}${
              entry.status === 'approved'
                ? ' · Live: saving replaces it at once; the previous words stay in the archive.'
                : ''
            }`
          : 'Saved as a draft. It reaches the assistant once approved.'
      }
      wide
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button type="submit" form={formId} disabled={busy || problem !== null} className={PRIMARY}>
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
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
        <label className={`${CHECK_LINE} sm:col-span-2`}>
          <input type="checkbox" checked={needsTranslation} onChange={(e) => setNeedsTranslation(e.target.checked)} className={CHECK_BOX} />
          English source, to translate (the assistant uses the English entry until this one is translated)
        </label>
        {problem && (key || question || body) && <p className={`${HINT} sm:col-span-2`}>{problem}</p>}
      </form>
      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'ask' : 'danger'} />}
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
        <p className="min-w-0 text-[13.5px] leading-relaxed text-ink-muted md:text-[13px]">
          Corrections staff proposed from the conversations. An approved example is what the assistant answers from next;
          approve only once it holds no names, numbers or children’s details.
        </p>
        <div className="flex shrink-0 gap-1 rounded-xl bg-band p-1">
          {EXAMPLE_TABS.map(([s, label]) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={`${SEGMENT} ${status === s ? SEGMENT_ON : SEGMENT_OFF}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'ask' : 'danger'} />}
      {!error && examples === null && <Spinner />}
      {examples?.length === 0 && <p className="mt-4 text-[12.5px] text-ink-muted">Nothing here.</p>}
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
    <li className={ITEM_CARD}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${BADGE} ${TONE.neutral}`}>{langLabel(x.language)}</span>
        <span className="text-[12px] text-ink-muted">{intentLabel(x.intent)}</span>
        <span className={`${BADGE} ${TONE.assistant}`}>
          {VERDICT_LABEL[x.verdict]}
        </span>
        {proposer && <span className="text-[12px] text-ink-muted">by {proposer}</span>}
      </div>
      <p className="mt-1.5 line-clamp-3 whitespace-pre-line break-words text-[12.5px] text-ink">{x.customerText}</p>
      {x.goodReply && (
        <p className="mt-1 line-clamp-3 whitespace-pre-line break-words rounded-xl bg-mint px-2.5 py-1.5 text-[13.5px] text-teal md:text-[13px]">
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
      tone="ask"
      title="Withdraw this example?"
      subtitle={example ? `${intentLabel(example.intent)} · ${langLabel(example.language)}` : undefined}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={PRIMARY}>
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Yes, withdraw
          </button>
        </>
      }
    >
      <p className="text-[12.5px] text-ink">{WITHDRAW_EXAMPLE_LINE}</p>
      <p className="mt-2 text-[12.5px] text-ink-muted">It moves to Rejected and stays there; propose a new one to replace it.</p>
      {example && (
        <p className="mt-2 line-clamp-4 whitespace-pre-line break-words rounded-xl border border-line bg-card px-3 py-2 text-[13.5px] text-ink md:bg-ground md:text-[13px]">
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
      tone="assistant"
      title="Review the example"
      subtitle="Edit it until it holds no personal data, then approve it."
      wide
      footer={
        <>
          <button
            type="button"
            onClick={() => void run('reject')}
            disabled={busy !== null}
            className={`${BTN_QUIET} mr-auto text-danger-ink hover:bg-danger`}
          >
            {busy === 'reject' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <X aria-hidden className="h-4 w-4" />}
            Reject
          </button>
          <button
            type="button"
            onClick={() => void run('delete')}
            disabled={busy !== null}
            title="Remove it for good: a proposal may still hold the conversation’s words"
            className={`${BTN_QUIET} text-ink-soft`}
          >
            {busy === 'delete' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Trash2 aria-hidden className="h-4 w-4" />}
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
            {busy === 'approve' && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
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
        {problem && <p className={`${HINT} sm:col-span-2`}>{problem}</p>}
        <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl bg-ask px-3 py-2.5 text-[13.5px] text-ask-ink ring-1 ring-ask-line sm:col-span-2 md:text-[13px]">
          <input
            type="checkbox"
            checked={deidentified}
            onChange={(e) => setDeidentified(e.target.checked)}
            className={`${CHECK_BOX} mt-0.5`}
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
      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'ask' : 'danger'} />}
    </Dialog>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-8 text-ink-muted">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}
