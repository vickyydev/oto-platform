import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Archive,
  BookOpen,
  CheckCircle2,
  Loader2,
  MessageSquareQuote,
  Pencil,
  Plus,
  Radio,
  ShieldCheck,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
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
import { ASSISTANT_HELP, AssistantFirstPage, AssistantHeader, StatusBadge, countWords, intentTitle, kbLanguageName, quoteFor } from '@/components/assistant-parts';
import { Dialog } from '@/components/Dialog';
import {
  ControlRow,
  EmptyNote,
  Field,
  FormRefusal,
  InlineError,
  InlineNote,
  LoadingNote,
  PAGE_COLUMN,
  PageHeader,
  SECTION_CARD,
  SEGMENT_BAND,
  SectionCard,
  SettingsRow,
  ViewSwitch,
  type MetaPart,
  type RowAction,
} from '@/components/settings-parts';
import { BADGE, BTN_MAIN, BTN_QUIET, CHECK_BOX, CHECK_LINE, CHECK_LINES, HINT, INPUT, SEGMENT, SEGMENT_OFF, SEGMENT_ON, TONE } from '@/components/ui';
import { RulesPanel } from '@/components/RulesPanel';
import { TeachPanel } from '@/components/TeachPanel';
import {
  AI_MODE_OPTIONS,
  EXAMPLE_CUSTOMER_MAX,
  EXAMPLE_REPLY_MAX,
  INTENTS,
  KB_BODY_MAX,
  KB_KEY_MAX,
  KB_LANGUAGES,
  KB_QUESTION_MAX,
  KB_TOPICS,
  VERDICT_LABEL,
  VERDICT_OPTIONS,
  aiModeOption,
  canApproveExample,
  exampleDraftProblem,
  exampleIntent,
  exampleLanguage,
  kbDraftProblem,
  kbGroups,
  modeChangeNeedsConfirm,
  topicLabel,
} from '@/lib/assistant';
import { CHANNEL_LABEL, branchLabel, branchOptions, langLabel } from '@/lib/view';

export { ASSISTANT_HELP };

// The house controls (SCRUM-1016, components/ui.ts): the page looks part of the Inbox, and does what it did.
// A one-line box and a select share one height (the scale's field); a box of
// several lines takes the padding of its lines (SCRUM-1044, as the template editor).
const FIELD = INPUT;
const AREA = `${INPUT} resize-y py-2 leading-relaxed`;

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
const toneOf = (text: string) => (text === NOT_ON_YOUR_ACCESS ? 'ask' : 'danger');

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
 * The Assistant's pages (plan §C.2, §E; R7): beside the template settings, for
 * the people who run the assistant —
 *  - Numbers (inbox:ai:manage): each number's mode, off / shadow / live;
 *  - Knowledge (inbox:kb:manage): the facts it speaks from, by topic and
 *    language, drafted, approved, archived;
 *  - Examples: the corrections staff proposed, edited and approved only with
 *    the approver's "contains no personal data" tick;
 *  - Rules and Teach (SCRUM-696).
 * The section lives in the URL (`?settings=assistant&section=…`, UI round
 * 2026-10-22, F2); null is the default, the first the viewer may see. Since
 * SCRUM-1044 the settings frame (SettingsFrame) holds the way back and the
 * choice of section, and each page starts with its own header (its main
 * action, New entry or New rule, on the right of its title).
 *
 * Teach is a chat (SETTINGS.md): it fills the page area, its thread scrolling
 * and its message box held at the foot, as the Inbox's chat does; the frame
 * gives it the whole area (`fills`).
 *
 * `shown` false (another settings page is open, Templates) renders only the
 * Teach chat, hidden: it stays mounted while any settings page shows, so a
 * look elsewhere keeps the conversation with the curator.
 */
export function AssistantSettings({
  me,
  tab,
  onTab,
  shown = true,
}: {
  me: InboxMe;
  tab: AssistantTab | null;
  onTab: (t: AssistantTab) => void;
  shown?: boolean;
}) {
  const caps = assistantCapabilities(me);
  const sections = assistantSections(caps);
  const section: AssistantTab = tab !== null && sections.some(([s]) => s === tab) ? tab : (sections[0]?.[0] ?? 'knowledge');
  const label = sections.find(([s]) => s === section)?.[1];
  const on = (s: AssistantTab) => shown && section === s;
  const teaching = on('teach') && caps.kb;

  return (
    <AssistantFirstPage.Provider value={sections[0]?.[0] ?? null}>
      <div className={!shown ? 'contents' : teaching ? 'flex min-w-0 flex-1 flex-col' : 'flex min-w-0 flex-col gap-5'}>
        {shown && !label && <PageHeader title="Assistant" help="You do not manage the assistant." />}
        {on('numbers') && caps.ai && <ChannelModes me={me} />}
        {on('knowledge') && caps.kb && <KnowledgeBase me={me} />}
        {on('examples') && caps.kb && <ExamplesQueue me={me} />}
        {on('rules') && caps.kb && <RulesPanel me={me} />}
        {teaching && (
          <div className={`${PAGE_COLUMN} pt-4 md:pt-6`}>
            <AssistantHeader section="teach" title="Teach" />
          </div>
        )}
        {/* The teach chat stays mounted, hidden, while another page shows, so a
            card's "Open in Rules" and the way back keep the conversation. */}
        {caps.kb && (
          <div className={teaching ? 'flex min-w-0 flex-1 flex-col' : 'hidden'} data-teach-chat>
            <TeachPanel me={me} active={on('teach')} onTab={onTab} />
          </div>
        )}
      </div>
    </AssistantFirstPage.Provider>
  );
}

// --- Numbers: the per-number switch --------------------------------------------------------

/** Numbers' first words, in the assistant's mint: what Live means, and the safe way there. */
export const NUMBERS_NOTE_LEAD = 'Live means customers hear it.';

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
    <>
      <AssistantHeader section="numbers" title="Numbers" />
      <InlineNote tone="assistant" live={false}>
        <span className="font-semibold">{NUMBERS_NOTE_LEAD}</span> Run a number in Shadow first: the assistant records what
        it would have said, and nobody sees it.
      </InlineNote>

      {error && <InlineError text={error} tone={toneOf(error)} />}
      {!error && accounts === null && <LoadingNote label="Reading the channel numbers" />}
      {accounts?.length === 0 && <EmptyNote icon={Radio} title="No channel numbers yet." />}
      {accounts && accounts.length > 0 && (
        <SectionCard title="Channel numbers" aside={accounts.length}>
          <ul>
            {accounts.map((a) => (
              <ControlRow
                key={a.id}
                title={a.displayName}
                meta={[{ text: CHANNEL_LABEL[a.channel] }, { text: a.branchId ? branchLabel(a.branchId, me.teams) : 'Both parks' }]}
                help={
                  busyId === a.id ? (
                    <span role="status" className="inline-flex items-center gap-1.5 text-ink-muted">
                      <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" />
                      Saving…
                    </span>
                  ) : undefined
                }
                control={
                  <div role="radiogroup" aria-label={`Assistant mode for ${a.displayName}`} className={`${SEGMENT_BAND} max-md:w-full sm:max-w-md`}>
                    {AI_MODE_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={a.aiMode === o.value}
                        disabled={busyId !== null}
                        onClick={() => choose(a, o.value)}
                        className={`${SEGMENT} justify-center rounded-[10px] max-md:flex-1 ${
                          a.aiMode === o.value ? (o.value === 'live' ? 'bg-teal text-mint shadow-sm' : SEGMENT_ON) : SEGMENT_OFF
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                }
              >
                {rowError?.id === a.id && (
                  <div>
                    <InlineError text={rowError.text} tone={toneOf(rowError.text)} />
                  </div>
                )}
              </ControlRow>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* Off, Shadow and Live, explained once, under the numbers: side by side where the page area is 640 px
          wide or more (a desktop, a tablet on its side), one under another below (a phone, a tablet held upright),
          so no explanation is squeezed into a column of a few words. Each is named as a plain term: the switch,
          not a colour here, says which one a number is in. */}
      <SectionCard title="What each mode does">
        <dl className="grid grid-cols-1 @min-[40rem]/settings:grid-cols-3">
          {AI_MODE_OPTIONS.map((o) => (
            <div
              key={o.value}
              className="flex min-w-0 flex-col items-start gap-1 border-b border-line-soft px-pane py-row last:border-b-0 @min-[40rem]/settings:border-b-0 @min-[40rem]/settings:border-r @min-[40rem]/settings:last:border-r-0"
            >
              <dt className="text-ui font-bold text-ink">{o.label}</dt>
              <dd className="text-note leading-relaxed text-ink-soft">{o.description}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        icon={Radio}
        tone="assistant"
        title="Put the assistant live on this number?"
        subtitle={confirm ? `${confirm.account.displayName} · ${CHANNEL_LABEL[confirm.account.channel]}` : undefined}
        footer={
          <>
            <button type="button" onClick={() => setConfirm(null)} disabled={busyId !== null} className={BTN_QUIET}>
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
        <p className="text-ui leading-relaxed text-ink-soft">{aiModeOption('live').description}</p>
        <p className="mt-2 text-note text-ink-muted">You can switch it back to Shadow or Off at any time.</p>
      </Dialog>
    </>
  );
}

// --- The knowledge base -------------------------------------------------------------------

/** What the knowledge page is for, word for word as it has said it. */
export const KNOWLEDGE_NOTE =
  'Only approved entries reach the assistant. Opening hours, addresses and ticket prices come from the platform itself; write notes beside them here, never the numbers. Editing an approved entry replaces it at once; the previous words stay in the archive.';

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
    <>
      <AssistantHeader
        section="knowledge"
        title="Knowledge"
        actions={
          <button type="button" onClick={() => setEditing('new')} className={BTN_MAIN}>
            <Plus aria-hidden className="h-4 w-4" />
            New entry
          </button>
        }
      />
      <InlineNote tone="assistant" live={false}>
        {KNOWLEDGE_NOTE}
      </InlineNote>

      <div className="-my-1 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-y border-line py-1">
        <p className="text-note text-ink-muted" aria-live="polite">
          {entries === null || entries.length === 0
            ? ' '
            : countWords(entries.length, 'entry', 'entries', entries.filter((e) => e.status === 'archived').length)}
        </p>
        <label className={CHECK_LINE}>
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className={CHECK_BOX} />
          Show archived
        </label>
      </div>

      {error && <InlineError text={error} tone={toneOf(error)} />}
      {!error && entries === null && <LoadingNote label="Reading the knowledge base" />}
      {entries?.length === 0 && (
        <EmptyNote icon={BookOpen} title="No entries yet." line="New entry adds the first fact; it reaches the assistant once approved." />
      )}

      {kbGroups(entries ?? []).map((g) => (
        <SectionCard key={g.topic} title={topicLabel(g.topic)} aside={g.entries.length}>
          <ul>
            {g.entries.map((e) => (
              <KbRow
                key={e.id}
                me={me}
                entry={e}
                onEdit={() => setEditing(e)}
                onAct={(what) => {
                  setActError(null);
                  setActing({ entry: e, what });
                }}
              />
            ))}
          </ul>
        </SectionCard>
      ))}

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
    </>
  );
}

/**
 * One entry: the customer's question as the main text, the answer under it
 * with its line breaks (four lines, then the editor has the rest), its status
 * as the one badge, the language, the park and the key as quiet meta. Edit,
 * Approve (a draft) and Archive for a person who manages it, none once
 * archived — as the card offered them.
 */
export function KbRow({
  me,
  entry: e,
  onEdit,
  onAct,
}: {
  me: InboxMe;
  entry: KbEntry;
  onEdit: () => void;
  onAct: (what: 'approve' | 'archive') => void;
}) {
  const meta: MetaPart[] = [
    { text: kbLanguageName(e.language) },
    { text: e.branchId ? branchLabel(e.branchId, me.teams) : 'Both parks' },
    { text: e.key, tone: 'code' },
    ...(e.needsTranslation ? [{ text: 'English source, to translate', tone: 'ask' as const }] : []),
  ];
  const actions: RowAction[] =
    e.status !== 'archived' && e.canManage
      ? [
          { label: 'Edit', icon: Pencil, onSelect: onEdit },
          ...(e.status === 'draft' ? [{ label: 'Approve', icon: CheckCircle2, onSelect: () => onAct('approve') }] : []),
          { label: 'Archive', icon: Archive, onSelect: () => onAct('archive') },
        ]
      : [];
  return (
    <SettingsRow
      title={e.question}
      name={`${quoteFor(e.question)}, ${kbLanguageName(e.language)}`}
      preview={e.body}
      previewLines={4}
      keepBreaks
      badge={<StatusBadge status={e.status} />}
      meta={meta}
      actions={actions}
    />
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
          <button type="button" onClick={onClose} disabled={busy} className={BTN_QUIET}>
            Cancel
          </button>
          <button type="submit" form={formId} disabled={busy || problem !== null} className={BTN_MAIN}>
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Save
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormRefusal text={error} tone={error ? toneOf(error) : 'danger'} />
        <Field label={`The question, as a customer would ask it · ${question.length}/${KB_QUESTION_MAX}`} wide>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={KB_QUESTION_MAX} className={FIELD} />
        </Field>
        <Field label={`The answer · ${body.length}/${KB_BODY_MAX}`} wide>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={KB_BODY_MAX} className={AREA} />
        </Field>
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
          <select value={language} onChange={(e) => setLanguage(exampleLanguage(e.target.value))} className={FIELD}>
            {KB_LANGUAGES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Park">
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={FIELD}>
            <option value="">Both parks</option>
            {branchOptions(me.teams).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <label className={`${CHECK_LINES} md:col-span-2`}>
          <input
            type="checkbox"
            checked={needsTranslation}
            onChange={(e) => setNeedsTranslation(e.target.checked)}
            className={`${CHECK_BOX} mt-0.5`}
          />
          <span>English source, to translate (the assistant uses the English entry until this one is translated)</span>
        </label>
        {problem && (key || question || body) && <p className={`${HINT} md:col-span-2`}>{problem}</p>}
      </form>
    </Dialog>
  );
}

// --- The examples queue (§E) --------------------------------------------------------------

const EXAMPLE_TABS: [ExampleStatus, string][] = [
  ['proposed', 'To review'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
];

/** What the examples page is for, word for word as it has said it. */
export const EXAMPLES_NOTE =
  'Corrections staff proposed from the conversations. An approved example is what the assistant answers from next; approve only once it holds no names, numbers or children’s details.';

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

  const shownLabel = EXAMPLE_TABS.find(([s]) => s === status)?.[1] ?? '';
  return (
    <>
      <AssistantHeader section="examples" title="Examples" />
      <InlineNote tone="assistant" live={false}>
        {EXAMPLES_NOTE}
      </InlineNote>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ViewSwitch label="Examples to show" options={EXAMPLE_TABS} value={status} onChange={setStatus} />
        <p className="text-note text-ink-muted" aria-live="polite">
          {examples && examples.length > 0 ? countWords(examples.length, 'example', 'examples') : ' '}
        </p>
      </div>

      {error && <InlineError text={error} tone={toneOf(error)} />}
      {!error && examples === null && <LoadingNote label="Reading the examples" />}
      {examples?.length === 0 && (
        <EmptyNote
          icon={MessageSquareQuote}
          title="Nothing here."
          line={status === 'proposed' ? 'A correction made with “Correct the assistant” in a conversation arrives here to review.' : undefined}
        />
      )}
      {examples && examples.length > 0 && (
        <ul aria-label={shownLabel} className={SECTION_CARD}>
          {examples.map((x) => (
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
      )}

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
    </>
  );
}

/**
 * One example in the queue, as a row: the topic of the question as the main
 * text, the customer's words under it, the good reply in the assistant's
 * mint, then the verdict as the one badge with the language and who proposed
 * it. Review while proposed; Withdraw once approved (test night U2 — an
 * approved example could not be pulled back on screen).
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
  const actions: RowAction[] = [
    ...(x.status === 'proposed' ? [{ label: 'Review', icon: Pencil, onSelect: onReview }] : []),
    ...(x.status === 'approved' ? [{ label: 'Withdraw', icon: Undo2, onSelect: onWithdraw }] : []),
  ];
  return (
    <SettingsRow
      title={intentTitle(x.intent)}
      name={quoteFor(x.customerText)}
      preview={x.customerText}
      previewLines={3}
      keepBreaks
      detail={
        x.goodReply ? (
          <p className="mt-1.5 max-w-prose rounded-[14px] rounded-tl-md bg-mint px-3 py-2 text-ui leading-relaxed text-teal">
            {/* Cut on its own span, so a cut line never shows through the padding. */}
            <span className="line-clamp-3 whitespace-pre-line break-words">{x.goodReply}</span>
          </p>
        ) : undefined
      }
      badge={<span className={`${BADGE} ${TONE.assistant}`}>{VERDICT_LABEL[x.verdict]}</span>}
      meta={[{ text: kbLanguageName(x.language) }, ...(proposer ? [{ text: `by ${proposer}` }] : [])]}
      actions={actions}
    />
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
      subtitle={example ? `${intentTitle(example.intent)} · ${langLabel(example.language)}` : undefined}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={BTN_QUIET}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={BTN_MAIN}>
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Yes, withdraw
          </button>
        </>
      }
    >
      <p className="text-ui leading-relaxed text-ink">{WITHDRAW_EXAMPLE_LINE}</p>
      <p className="mt-2 text-note text-ink-muted">It moves to Rejected and stays there; propose a new one to replace it.</p>
      {example && (
        <p className="mt-3 line-clamp-4 whitespace-pre-line break-words rounded-xl border border-line bg-card px-3 py-2 text-ui text-ink md:bg-ground">
          {example.customerText}
        </p>
      )}
      {error && (
        <div className="mt-3">
          <InlineError text={error} />
        </div>
      )}
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
            className={BTN_QUIET}
          >
            Save
          </button>
          <button type="button" onClick={() => void run('approve')} disabled={!approvable} className={BTN_MAIN}>
            {busy === 'approve' && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Approve
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormRefusal text={error} tone={error ? toneOf(error) : 'danger'} />
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
            className={AREA}
          />
        </Field>
        <Field label={`The good reply${verdict === 'should_answer' ? '' : ' (optional)'} · ${goodReply.length}/${EXAMPLE_REPLY_MAX}`} wide>
          <textarea value={goodReply} onChange={(e) => setGoodReply(e.target.value)} rows={4} maxLength={EXAMPLE_REPLY_MAX} className={AREA} />
        </Field>
        <Field label="Topic of the question">
          <select value={intent} onChange={(e) => setIntent(exampleIntent(e.target.value))} className={FIELD}>
            {INTENTS.map((i) => (
              <option key={i} value={i}>
                {intentTitle(i)}
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
        {problem && <p className={`${HINT} md:col-span-2`}>{problem}</p>}
        <label className="hit flex min-h-ctl cursor-pointer items-start gap-2.5 rounded-xl bg-ask px-3 py-2.5 text-ui leading-relaxed text-ask-ink ring-1 ring-ask-line md:col-span-2">
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
    </Dialog>
  );
}
