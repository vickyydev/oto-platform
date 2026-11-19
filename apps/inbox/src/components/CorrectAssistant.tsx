import { useState, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, Loader2, PenLine } from 'lucide-react';
import { newId } from '@oto/shared/ids';
import type { InboxCategoryKey } from '@oto/shared/inbox';
import { ApiError } from '@/api/client';
import { assistantApi, type ExampleVerdict } from '@/api/assistant';
import type { InboxEvent, Message } from '@/api/inbox';
import { Refusal } from '@/components/confirms';
import { Dialog } from '@/components/Dialog';
import { BTN_MAIN, BTN_QUIET, HINT, INPUT, LABEL } from '@/components/ui';
import {
  EXAMPLE_CUSTOMER_MAX,
  EXAMPLE_REPLY_MAX,
  INTENTS,
  KB_LANGUAGES,
  VERDICT_OPTIONS,
  correctionSource,
  defaultExampleIntent,
  exampleDraftProblem,
  exampleIntentProblem,
  exampleLanguage,
  intentLabel,
  knownIntent,
  turnForCorrection,
} from '@/lib/assistant';

/** The thread's own language as a starting choice, only when it is one the assistant speaks. */
const knownLanguage = (v: string | null): string => (v !== null && KB_LANGUAGES.some(([l]) => l === v) ? v : '');

/** A field of the assistant's forms (SCRUM-1016): the house field, with room for a text area's lines. */
export const FIELD = `${INPUT} py-2`;

/** What the dialog corrects: an AI line (by id), or the silence an `ai_silent` pill marks (by its time). */
export type CorrectionTarget = { messageId: string } | { at: string };

/**
 * "Correct the assistant" (plan §E): the customer's words and the AI's line,
 * pre-filled and editable, and a verdict. Saving PROPOSES an example for
 * marketing to approve on the Assistant page; it does not touch the thread,
 * which is WhatsApp-style and has no staff-only notes. The customer's words
 * are to be edited free of personal data here — the approver confirms it
 * again before approval (§D.5).
 *
 * The prototype has no such control; this is the house Dialog in its
 * language.
 */
export function CorrectAssistant({
  target,
  messages,
  events = [],
  intent,
  category,
  language,
  onClose,
}: {
  target: CorrectionTarget;
  messages: readonly Message[];
  /** The thread's events: the assistant's turns name the lines they wrote (D3). */
  events?: readonly InboxEvent[];
  /** The thread's intent and language, as the classifier left them. */
  intent: string | null;
  /** The thread's category: the topic's starting point when the assistant never classified it (test night U3). */
  category: InboxCategoryKey;
  language: string | null;
  onClose: () => void;
}) {
  const source = correctionSource(messages, target);
  const silent = !('messageId' in target);
  const [customerText, setCustomerText] = useState(source.customerText);
  const [goodReply, setGoodReply] = useState(source.aiText);
  const [verdict, setVerdict] = useState<ExampleVerdict>('should_answer');
  // The topic starts on the corrected MESSAGE's own turn (customer-AI test
  // night D3: starting from the thread saved a parking correction as the
  // thread's later price question), shown, never blank. Only when no turn
  // names the message: blank = the server's default (its turn, else the
  // thread) on a classified thread; on a thread the assistant never
  // classified there is no default, so the category's nearest topic is
  // preselected and a blank is refused here, not after Propose.
  const corrected = 'messageId' in target ? messages.find((m) => m.id === target.messageId) : undefined;
  const turn = turnForCorrection(events, target, (corrected as { aiTurnId?: unknown } | undefined)?.aiTurnId);
  const classified = turn === null && knownIntent(intent) !== null;
  const [exIntent, setExIntent] = useState<string>(turn?.intent ?? defaultExampleIntent(turn ? null : intent, category));
  const [exLanguage, setExLanguage] = useState<string>(knownLanguage(language));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const draft = { customerText, goodReply, verdict };
  const problem = exampleDraftProblem(draft) ?? exampleIntentProblem(exIntent, turn ? null : intent);
  const sourceMessageId = 'messageId' in target ? target.messageId : source.customerMessageId;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !sourceMessageId) return;
    setBusy(true);
    setError(null);
    try {
      await assistantApi.createExample({
        id: newId(),
        messageId: sourceMessageId,
        intent: exIntent || undefined,
        language: exLanguage ? exampleLanguage(exLanguage) : undefined,
        customerText: customerText.trim(),
        goodReply: goodReply.trim() || null,
        verdict,
      });
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError
            ? err.message
            : 'The correction could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const formId = 'correct-assistant';
  return (
    <Dialog
      open
      onClose={onClose}
      icon={saved ? CheckCircle2 : PenLine}
      tone={saved ? 'money' : 'assistant'}
      title={saved ? 'Sent for approval' : 'Correct the assistant'}
      subtitle={
        saved
          ? 'Marketing reviews it on the Assistant page. Nothing changed in this conversation.'
          : 'Proposes an example the assistant learns from once approved. The customer does not see this.'
      }
      wide
      footer={
        saved ? (
          <button
            type="button"
            onClick={onClose}
            className={BTN_MAIN}
          >
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className={BTN_QUIET}
            >
              Cancel
            </button>
            <button
              type="submit"
              form={formId}
              disabled={busy || problem !== null || !sourceMessageId}
              className={BTN_MAIN}
            >
              {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
              Propose example
            </button>
          </>
        )
      }
    >
      {saved ? (
        <p className="text-[14px] text-ink-soft md:text-[13px]">Thank you. Approved examples are what the assistant answers from next.</p>
      ) : (
        <form id={formId} onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="What should it have done?" wide>
            <select value={verdict} onChange={(e) => setVerdict(e.target.value as ExampleVerdict)} className={FIELD}>
              {VERDICT_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`The customer asked (remove names, phone numbers, children’s details) · ${customerText.length}/${EXAMPLE_CUSTOMER_MAX}`} wide>
            <textarea
              value={customerText}
              onChange={(e) => setCustomerText(e.target.value)}
              rows={3}
              maxLength={EXAMPLE_CUSTOMER_MAX}
              className={`${FIELD} resize-y`}
            />
          </Field>
          <Field
            label={`${silent ? 'The reply it should have sent' : 'Its line, corrected'}${verdict === 'should_answer' ? '' : ' (optional)'} · ${goodReply.length}/${EXAMPLE_REPLY_MAX}`}
            wide
          >
            <textarea
              value={goodReply}
              onChange={(e) => setGoodReply(e.target.value)}
              rows={4}
              maxLength={EXAMPLE_REPLY_MAX}
              className={`${FIELD} resize-y`}
            />
          </Field>
          <Field label="Topic of the question">
            <select value={exIntent} onChange={(e) => setExIntent(e.target.value)} className={FIELD}>
              {classified && <option value="">As the assistant classified it</option>}
              {INTENTS.map((i) => (
                <option key={i} value={i}>
                  {intentLabel(i)}
                </option>
              ))}
            </select>
            {turn && (
              <span className={HINT} data-topic-source={turn.intent ? 'turn' : 'turn-unclassified'}>
                {turn.intent ? 'As the assistant classified this message.' : 'The assistant did not classify this message: pick its topic.'}
              </span>
            )}
          </Field>
          <Field label="Language">
            <select value={exLanguage} onChange={(e) => setExLanguage(e.target.value)} className={FIELD}>
              <option value="">As the conversation</option>
              {KB_LANGUAGES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {problem && <p className={`${HINT} sm:col-span-2`}>{problem}</p>}
          {!sourceMessageId && (
            <p className={`${HINT} sm:col-span-2`}>
              The customer’s message is on an earlier page: load the earlier messages first.
            </p>
          )}
        </form>
      )}
      {error && <Refusal text={error} />}
    </Dialog>
  );
}

/** A field with its label over it, the label the field's name (BookDate.dc.html). */
export function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}
