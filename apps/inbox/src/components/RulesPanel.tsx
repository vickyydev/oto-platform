import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, CheckCircle2, ListChecks, Loader2, Pencil, Plus } from 'lucide-react';
import { newId } from '@oto/shared/ids';
import { ApiError } from '@/api/client';
import { NOT_ON_YOUR_ACCESS, assistantApi, notOnAccess, type AiRule, type RuleCondition, type RuleStatus } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import { RuleConfirm } from '@/components/AssistantConfirms';
import { Refusal } from '@/components/confirms';
import { FIELD, Field } from '@/components/CorrectAssistant';
import { Dialog } from '@/components/Dialog';
import {
  INTENTS,
  KB_STATUS_LABEL,
  KB_STATUS_TINT,
  RULE_CONDITION_LABEL,
  RULE_CONDITION_OPTIONS,
  RULE_INSTRUCTION_MAX,
  RULE_INTENT_ANY,
  RULE_QUESTION_MAX,
  askFirstIgnored,
  ruleAskFirst,
  ruleDraftProblem,
  ruleIntentLabel,
} from '@/lib/assistant';
import { branchLabel, branchOptions } from '@/lib/view';

// The Assistant page's button styles (AssistantSettings.tsx keeps its own copy).
const BUTTON =
  'inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-60';
const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-60';
const CANCEL = 'rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800';

/** "Not on your access" politely; every other refusal is the server's own sentence. */
function said(err: unknown, fallback: string): string {
  if (notOnAccess(err)) return NOT_ON_YOUR_ACCESS;
  return err instanceof ApiError ? err.message : fallback;
}

const RULE_TABS: [RuleStatus, string][] = [
  ['draft', 'Drafts'],
  ['approved', 'Approved'],
  ['archived', 'Archived'],
];

/** What the editor says under the intent picker for a kind of message the assistant never asks first on. */
export const ASK_FIRST_IGNORED_LINE =
  'The assistant never asks first on this kind of message (a complaint, a refund, a request for a person, an upset or unclear message, a child in our care, the birthday flow, a greeting, a thank-you, a bot question or spam). The instruction is still followed; the question is not asked.';

/**
 * The behaviour rules (SCRUM-696): how the assistant handles a kind of
 * message — an instruction it follows and, optionally, one question it asks
 * first. Taught in the Teach chat or written here; drafted, approved,
 * archived, as the knowledge base is. Editing an approved rule replaces it at
 * once and keeps the old words under Archived.
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

  return (
    <div className="mt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-[12.5px] text-slate-500 dark:text-slate-400">
          How the assistant handles a kind of message: an instruction it follows and, if you want, one question it asks
          first. Only approved rules reach the assistant. A rule adds to its own rules and never overrides them: it cannot
          grant a price, a discount, a refund, a date or a booking.
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
            {RULE_TABS.map(([s, label]) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
                className={`rounded-lg px-2.5 py-1 text-[12px] font-medium ${
                  status === s ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm ring-1 ring-slate-200 dark:ring-slate-700' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setEditing('new')} className={PRIMARY}>
            <Plus className="h-3.5 w-3.5" />
            New rule
          </button>
        </div>
      </div>

      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}
      {!error && rules === null && (
        <div className="flex justify-center py-8 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {rules?.length === 0 && <p className="mt-4 text-[12.5px] text-slate-500 dark:text-slate-400">Nothing here.</p>}
      <ul className="mt-4 grid grid-cols-1 gap-2 lg:grid-cols-2">
        {rules?.map((r) => (
          <li key={r.id} className={`min-w-0 rounded-xl border border-slate-200 dark:border-slate-800 p-3 ${r.status === 'archived' ? 'opacity-60' : ''}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] font-semibold text-slate-800 dark:text-slate-100">{ruleIntentLabel(r.intent)}</span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">{r.branchId ? branchLabel(r.branchId, me.teams) : 'Both parks'}</span>
              <span className={`rounded-full px-1.5 text-[10px] font-medium ring-1 ${KB_STATUS_TINT[r.status]}`}>{KB_STATUS_LABEL[r.status]}</span>
            </div>
            <p className="mt-1.5 whitespace-pre-line break-words text-[12.5px] text-slate-700 dark:text-slate-200">{r.instruction}</p>
            {r.askFirst && (
              <p className="mt-1 break-words rounded-lg bg-indigo-50/60 dark:bg-indigo-500/10 px-2 py-1 text-[12.5px] text-indigo-900 dark:text-indigo-200">
                <span className="font-medium">Ask first:</span> {r.askFirst.question.en}
                <span className="text-[11px] text-indigo-700/80 dark:text-indigo-300/80"> · {RULE_CONDITION_LABEL[r.askFirst.condition]}</span>
              </p>
            )}
            {r.taughtFrom && (
              <p className="mt-1 line-clamp-3 break-words text-[11.5px] italic text-slate-500 dark:text-slate-400">Taught from: “{r.taughtFrom}”</p>
            )}
            {r.status !== 'archived' && r.canManage && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {r.status === 'draft' && (
                  <button
                    type="button"
                    onClick={() => {
                      setActError(null);
                      setActing({ rule: r, what: 'approve' });
                    }}
                    className={BUTTON}
                  >
                    <CheckCircle2 className="h-3 w-3" /> Approve
                  </button>
                )}
                <button type="button" onClick={() => setEditing(r)} className={BUTTON}>
                  <Pencil className="h-3 w-3" /> Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActError(null);
                    setActing({ rule: r, what: 'archive' });
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
    </div>
  );
}

/**
 * Write or change one rule, in the house Dialog. A new rule is a draft; a
 * draft is changed in place; an approved rule is replaced at once by the
 * saved words (the api's revise, as the knowledge base's edit).
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
      iconTint="bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
      title={rule ? 'Edit rule' : 'New rule'}
      subtitle={
        rule?.status === 'approved'
          ? 'Saving replaces the approved rule at once; the old words stay under Archived.'
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
        <Field label="Kind of message">
          <select value={intent} onChange={(e) => setIntent(e.target.value)} className={FIELD}>
            {intent === '' && <option value="">Choose…</option>}
            <option value={RULE_INTENT_ANY}>{ruleIntentLabel(RULE_INTENT_ANY)}</option>
            {INTENTS.map((i) => (
              <option key={i} value={i}>
                {ruleIntentLabel(i)}
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
          <p className="text-[11.5px] text-slate-500 dark:text-slate-400 sm:col-span-2">{ASK_FIRST_IGNORED_LINE}</p>
        )}
        <Field label={`What the assistant should do · ${[...instruction].length}/${RULE_INSTRUCTION_MAX}`} wide>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={4}
            maxLength={RULE_INSTRUCTION_MAX}
            placeholder="If someone says they lost something, first ask which park they visited."
            className={`${FIELD} resize-y`}
          />
        </Field>
        <label className="inline-flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300 sm:col-span-2">
          <input type="checkbox" checked={askFirst} onChange={(e) => setAskFirst(e.target.checked)} />
          Ask one question first, before anything else
        </label>
        {askFirst && (
          <>
            <Field label="When">
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
        {problem && (intent || instruction) && <p className="text-[11.5px] text-slate-500 dark:text-slate-400 sm:col-span-2">{problem}</p>}
      </form>
      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}
    </Dialog>
  );
}
