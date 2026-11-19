import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, CheckCircle2, ListChecks, Loader2, Pencil, Plus } from 'lucide-react';
import { newId } from '@oto/shared/ids';
import { ApiError } from '@/api/client';
import { NOT_ON_YOUR_ACCESS, assistantApi, notOnAccess, type AiRule, type RuleCondition, type RuleStatus } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import { RuleConfirm } from '@/components/AssistantConfirms';
import { AssistantHeader, StatusBadge, countWords, intentTitle } from '@/components/assistant-parts';
import { Dialog } from '@/components/Dialog';
import {
  EmptyNote,
  Field,
  FormRefusal,
  InlineError,
  InlineNote,
  LoadingNote,
  MetaLine,
  SECTION_CARD,
  SettingsRow,
  ViewSwitch,
  type RowAction,
} from '@/components/settings-parts';
import { BTN_MAIN, BTN_QUIET, CHECK_BOX, CHECK_LINE, HINT, INPUT } from '@/components/ui';
import {
  INTENTS,
  RULE_CONDITION_LABEL,
  RULE_CONDITION_OPTIONS,
  RULE_INSTRUCTION_MAX,
  RULE_INTENT_ANY,
  RULE_QUESTION_MAX,
  askFirstIgnored,
  ruleAskFirst,
  ruleDraftProblem,
} from '@/lib/assistant';
import { branchLabel, branchOptions } from '@/lib/view';

// The house controls (SCRUM-1016, components/ui.ts): the page looks part of the Inbox, and does what it did.
// A one-line box and a select share one height; a box of several lines takes the padding of its lines.
const FIELD = INPUT;
const AREA = `${INPUT} resize-y py-2 leading-relaxed`;

/** "Not on your access" politely; every other refusal is the server's own sentence. */
function said(err: unknown, fallback: string): string {
  if (notOnAccess(err)) return NOT_ON_YOUR_ACCESS;
  return err instanceof ApiError ? err.message : fallback;
}
const toneOf = (text: string) => (text === NOT_ON_YOUR_ACCESS ? 'ask' : 'danger');

const RULE_TABS: [RuleStatus, string][] = [
  ['draft', 'Drafts'],
  ['approved', 'Approved'],
  ['archived', 'Archived'],
];

/** What the editor says under the intent picker for a kind of message the assistant never asks first on. */
export const ASK_FIRST_IGNORED_LINE =
  'The assistant never asks first on this kind of message (a complaint, a refund, a request for a person, an upset or unclear message, a child in our care, the birthday flow, a greeting, a thank-you, a bot question or spam). The instruction is still followed; the question is not asked.';

/** What the rules page is for, word for word as it has said it. */
export const RULES_NOTE =
  'How the assistant handles a kind of message: an instruction it follows and, if you want, one question it asks first. Only approved rules reach the assistant. A rule adds to its own rules and never overrides them: it cannot grant a price, a discount, a refund, a date or a booking.';

/**
 * The behaviour rules (SCRUM-696): how the assistant handles a kind of
 * message — an instruction it follows and, optionally, one question it asks
 * first. Taught in the Teach chat or written here; drafted, approved,
 * archived, as the knowledge base is. Editing an approved rule replaces it at
 * once and keeps the old words under Archived.
 *
 * Since SCRUM-1044 a page of the settings frame: its header with New rule,
 * what a rule may do in the assistant's mint, Drafts, Approved and Archived
 * as one switch, and a calm row per rule (SETTINGS.md, Rules).
 */
export function RulesPanel({ me }: { me: InboxMe }) {
  const [status, setStatus] = useState<RuleStatus>('draft');
  const [rules, setRules] = useState<AiRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AiRule | 'new' | null>(null);
  const [acting, setActing] = useState<{ rule: AiRule; what: 'approve' | 'archive' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRules((await assistantApi.rules(status)).rules);
      setError(null);
    } catch (err) {
      setError(said(err, 'The rules could not be read.'));
    }
  }, [status]);
  useEffect(() => {
    setRules(null);
    void load();
  }, [load]);

  const act = async () => {
    if (!acting) return;
    setBusy(true);
    setActError(null);
    try {
      if (acting.what === 'approve') await assistantApi.approveRule(acting.rule.id);
      else await assistantApi.archiveRule(acting.rule.id);
      setActing(null);
      await load();
    } catch (err) {
      setActError(said(err, acting.what === 'approve' ? 'The rule could not be approved.' : 'The rule could not be archived.'));
    } finally {
      setBusy(false);
    }
  };

  const shownLabel = RULE_TABS.find(([s]) => s === status)?.[1] ?? '';
  return (
    <>
      <AssistantHeader
        title="Rules"
        actions={
          <button type="button" onClick={() => setEditing('new')} className={BTN_MAIN}>
            <Plus aria-hidden className="h-4 w-4" />
            New rule
          </button>
        }
      />
      <InlineNote tone="assistant" live={false}>
        {RULES_NOTE}
      </InlineNote>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ViewSwitch label="Rules to show" options={RULE_TABS} value={status} onChange={setStatus} />
        <p className="text-note text-ink-muted" aria-live="polite">
          {rules && rules.length > 0 ? countWords(rules.length, 'rule', 'rules') : ' '}
        </p>
      </div>

      {error && <InlineError text={error} tone={toneOf(error)} />}
      {!error && rules === null && <LoadingNote label="Reading the rules" />}
      {rules?.length === 0 && (
        <EmptyNote
          icon={ListChecks}
          title="Nothing here."
          line={status === 'draft' ? 'New rule, or a rule taught in Teach, starts here as a draft.' : undefined}
        />
      )}
      {rules && rules.length > 0 && (
        <ul aria-label={shownLabel} className={SECTION_CARD}>
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              me={me}
              rule={r}
              onEdit={() => setEditing(r)}
              onAct={(what) => {
                setActError(null);
                setActing({ rule: r, what });
              }}
            />
          ))}
        </ul>
      )}

      {editing !== null && (
        <RuleEditor
          me={me}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      <RuleConfirm me={me} acting={acting} busy={busy} error={actError} onCancel={() => setActing(null)} onConfirm={() => void act()} />
    </>
  );
}

/**
 * One rule: the kind of message as the main text, the instruction whole with
 * its line breaks, the ask-first question in the assistant's mint, the words
 * it was taught from; its status as the one badge and its park as meta.
 * Approve (a draft), Edit and Archive for a person who manages it, none once
 * archived — as the card offered them.
 */
export function RuleRow({
  me,
  rule: r,
  onEdit,
  onAct,
}: {
  me: InboxMe;
  rule: AiRule;
  onEdit: () => void;
  onAct: (what: 'approve' | 'archive') => void;
}) {
  const actions: RowAction[] =
    r.status !== 'archived' && r.canManage
      ? [
          ...(r.status === 'draft' ? [{ label: 'Approve', icon: CheckCircle2, onSelect: () => onAct('approve') }] : []),
          { label: 'Edit', icon: Pencil, onSelect: onEdit },
          { label: 'Archive', icon: Archive, onSelect: () => onAct('archive') },
        ]
      : [];
  const park = r.branchId ? branchLabel(r.branchId, me.teams) : 'Both parks';
  return (
    <SettingsRow
      title={intentTitle(r.intent)}
      name={`${intentTitle(r.intent)}, ${park}`}
      preview={r.instruction}
      previewLines="all"
      keepBreaks
      detail={
        <>
          {r.askFirst && (
            <div className="mt-1.5 max-w-prose break-words rounded-xl bg-mint-soft px-3 py-2 text-teal ring-1 ring-mint-line">
              <p className="text-note">
                <span className="font-semibold">Ask first</span> · {RULE_CONDITION_LABEL[r.askFirst.condition]}
              </p>
              <p className="mt-0.5 text-ui leading-relaxed">{r.askFirst.question.en}</p>
            </div>
          )}
          {r.taughtFrom && (
            <p className="mt-1 line-clamp-3 max-w-prose break-words text-note italic text-ink-muted">Taught from: “{r.taughtFrom}”</p>
          )}
        </>
      }
      badge={<StatusBadge status={r.status} />}
      meta={<MetaLine parts={[{ text: park }]} />}
      actions={actions}
    />
  );
}

/**
 * Write or change one rule, in the house Dialog. A new rule is a draft; a
 * draft is changed in place; an approved rule is replaced at once by the
 * saved words (the api's revise, as the knowledge base's edit). The server's
 * refusal of what a rule says (a number, a link, a date, a grant, a question
 * that would not pass) shows at the top of the form, word for word.
 */
export function RuleEditor({
  me,
  rule,
  onClose,
  onSaved,
}: {
  me: InboxMe;
  rule: AiRule | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [intent, setIntent] = useState(rule?.intent ?? '');
  const [branchId, setBranchId] = useState(rule?.branchId ?? '');
  const [instruction, setInstruction] = useState(rule?.instruction ?? '');
  const [askFirst, setAskFirst] = useState(Boolean(rule?.askFirst));
  const [condition, setCondition] = useState<RuleCondition>(rule?.askFirst?.condition ?? 'branch_unknown');
  const [questionEn, setQuestionEn] = useState(rule?.askFirst?.question.en ?? '');
  const [questionTh, setQuestionTh] = useState(rule?.askFirst?.question.th ?? '');
  const [questionRu, setQuestionRu] = useState(rule?.askFirst?.question.ru ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = { intent, instruction, askFirst, condition, questionEn, questionTh, questionRu };
  const problem = ruleDraftProblem(draft);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const fields = { branchId: branchId || null, intent, instruction: instruction.trim(), askFirst: ruleAskFirst(draft) };
      if (rule) await assistantApi.updateRule(rule.id, fields);
      else await assistantApi.createRule({ id: newId(), ...fields });
      await onSaved();
    } catch (err) {
      setError(said(err, 'The rule could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const formId = 'rule-editor';
  return (
    <Dialog
      open
      onClose={onClose}
      icon={ListChecks}
      tone="assistant"
      title={rule ? 'Edit rule' : 'New rule'}
      subtitle={
        rule?.status === 'approved'
          ? 'Saving replaces the approved rule at once; the old words stay under Archived.'
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
        <Field label="Kind of message">
          <select value={intent} onChange={(e) => setIntent(e.target.value)} className={FIELD}>
            {intent === '' && <option value="">Choose…</option>}
            <option value={RULE_INTENT_ANY}>{intentTitle(RULE_INTENT_ANY)}</option>
            {INTENTS.map((i) => (
              <option key={i} value={i}>
                {intentTitle(i)}
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
        {askFirstIgnored(intent) && (
          <div className="min-w-0 md:col-span-2">
            <InlineNote tone="ask">{ASK_FIRST_IGNORED_LINE}</InlineNote>
          </div>
        )}
        <Field label={`What the assistant should do · ${[...instruction].length}/${RULE_INSTRUCTION_MAX}`} wide>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={4}
            maxLength={RULE_INSTRUCTION_MAX}
            placeholder="If someone says they lost something, first ask which park they visited."
            className={AREA}
          />
        </Field>
        <label className={`${CHECK_LINE} md:col-span-2`}>
          <input type="checkbox" checked={askFirst} onChange={(e) => setAskFirst(e.target.checked)} className={CHECK_BOX} />
          Ask one question first, before anything else
        </label>
        {askFirst && (
          <>
            <Field label="When" wide>
              <select value={condition} onChange={(e) => setCondition(e.target.value as RuleCondition)} className={FIELD}>
                {RULE_CONDITION_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`The question, in English · ${[...questionEn].length}/${RULE_QUESTION_MAX}`} wide>
              <input value={questionEn} onChange={(e) => setQuestionEn(e.target.value)} maxLength={RULE_QUESTION_MAX} className={FIELD} />
            </Field>
            <Field label="In Thai (optional)">
              <input value={questionTh} onChange={(e) => setQuestionTh(e.target.value)} maxLength={RULE_QUESTION_MAX} className={FIELD} />
            </Field>
            <Field label="In Russian (optional)">
              <input value={questionRu} onChange={(e) => setQuestionRu(e.target.value)} maxLength={RULE_QUESTION_MAX} className={FIELD} />
            </Field>
          </>
        )}
        {problem && (intent || instruction) && <p className={`${HINT} md:col-span-2`}>{problem}</p>}
      </form>
    </Dialog>
  );
}
