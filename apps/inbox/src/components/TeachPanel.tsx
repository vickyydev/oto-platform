import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CheckCircle2, FlaskConical, Loader2, Send } from 'lucide-react';
import { newId } from '@oto/shared/ids';
import { ApiError } from '@/api/client';
import { NOT_ON_YOUR_ACCESS, assistantApi, notOnAccess, type TeachCard, type TeachDryRun } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import type { AssistantTab } from '@/lib/url';
import { Eyebrow } from '@/components/atoms';
import { Refusal } from '@/components/confirms';
import { FIELD } from '@/components/CorrectAssistant';
import { KB_STATUS_LABEL, KB_STATUS_TINT, TEACH_MESSAGE_MAX, TEACH_OUTCOME_LABEL, ruleIntentLabel, teachPayload } from '@/lib/assistant';

// The Assistant page's button styles (AssistantSettings.tsx keeps its own copy).
const BUTTON =
  'inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-60';
const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-60';

/** "Not on your access" politely; every other refusal is the server's own sentence. */
function said(err: unknown, fallback: string): string {
  if (notOnAccess(err)) return NOT_ON_YOUR_ACCESS;
  return err instanceof ApiError ? err.message : fallback;
}

interface Line {
  role: 'user' | 'assistant';
  text: string;
  cards?: TeachCard[];
  dryRun?: TeachDryRun | null;
}

export const TEACH_INTRO =
  'Brief the assistant like a new receptionist: tell it a fact or how to handle a kind of message. It saves a draft for you to approve.';

/**
 * Teach the assistant (SCRUM-696): a chat with the curator, the same
 * assistant that holds the knowledge, on the Assistant page. It answers "what
 * do you say today when…", saves what it is told as a DRAFT fact or rule (a
 * card under its reply, approved here or in its tab) and can dry-run a
 * customer message. Nothing here touches a thread or reaches a customer.
 * The chat lives in this mount only: the last twenty lines travel with each
 * message, under one session id.
 */
export function TeachPanel({ onTab }: { me: InboxMe; onTab: (t: AssistantTab) => void }) {
  const [sessionId] = useState(() => newId());
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set());
  const [approving, setApproving] = useState<string | null>(null);
  const [cardError, setCardError] = useState<{ id: string; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const before = lines;
    const next: Line[] = [...before, { role: 'user', text }];
    setLines(next);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      const reply = await assistantApi.teach({
        sessionId,
        messages: teachPayload(next.map((l) => ({ role: l.role, text: l.text }))),
      });
      setLines([...next, { role: 'assistant', text: reply.reply, cards: reply.cards, dryRun: reply.dryRun }]);
    } catch (err) {
      // The line goes back into the composer (above anything typed meanwhile),
      // so sending again does not repeat it.
      setLines(before);
      setDraft((typed) => (typed.trim() ? `${text}\n\n${typed}` : text));
      setError(said(err, 'The assistant could not be reached. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const approve = async (card: TeachCard) => {
    setApproving(card.id);
    setCardError(null);
    try {
      if (card.kind === 'fact') await assistantApi.approveKb(card.id);
      else await assistantApi.approveRule(card.id);
      setApproved((s) => new Set([...s, card.id]));
    } catch (err) {
      setCardError({ id: card.id, text: said(err, card.kind === 'fact' ? 'The entry could not be approved.' : 'The rule could not be approved.') });
    } finally {
      setApproving(null);
    }
  };

  return (
    <div className="mt-4">
      <p className="text-[12.5px] text-slate-500 dark:text-slate-400">{TEACH_INTRO}</p>

      <div
        ref={scrollRef}
        className="mt-3 max-h-[60vh] min-h-[12rem] space-y-3 overflow-y-auto overflow-x-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 p-3"
      >
        {lines.length === 0 && !busy && (
          <p className="py-6 text-center text-[12.5px] text-slate-400">
            For example: “If someone says they lost something, first ask which park they visited.”
          </p>
        )}
        {lines.map((l, i) =>
          l.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-slate-900 px-3 py-2 text-[13px] text-white dark:bg-slate-100 dark:text-slate-900">
                {l.text}
              </p>
            </div>
          ) : (
            <div key={i} className="flex flex-col items-start gap-1.5">
              <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-slate-100 px-3 py-2 text-[13px] text-slate-800 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700">
                {l.text}
              </p>
              {l.cards?.map((c) => {
                const done = approved.has(c.id);
                return (
                  <div key={c.id} className="w-full max-w-[85%] min-w-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
                        {c.kind === 'fact' ? 'Fact' : 'Rule'}
                      </span>
                      <span className={`rounded-full px-1.5 text-[10px] font-medium ring-1 ${KB_STATUS_TINT[done ? 'approved' : 'draft']}`}>
                        {KB_STATUS_LABEL[done ? 'approved' : 'draft']}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-[12.5px] text-slate-800 dark:text-slate-200">{c.title}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {!done && (
                        <button type="button" onClick={() => void approve(c)} disabled={approving !== null} className={BUTTON}>
                          {approving === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                          Approve
                        </button>
                      )}
                      <button type="button" onClick={() => onTab(c.kind === 'fact' ? 'knowledge' : 'rules')} className={BUTTON}>
                        {c.kind === 'fact' ? 'Open in Knowledge' : 'Open in Rules'}
                      </button>
                    </div>
                    {cardError?.id === c.id && <Refusal text={cardError.text} tone={cardError.text === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}
                  </div>
                );
              })}
              {l.dryRun && <DryRun run={l.dryRun} />}
            </div>
          ),
        )}
        {busy && (
          <div className="flex justify-start">
            <p className="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-slate-100 px-3 py-2 text-[12.5px] text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Thinking…
            </p>
          </div>
        )}
      </div>

      {error && <Refusal text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          maxLength={TEACH_MESSAGE_MAX}
          aria-label="Message to the assistant"
          placeholder="Tell it a fact, a rule, or ask what it says today when…"
          className={`${FIELD} min-w-0 flex-1 resize-y`}
        />
        <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()} className={`${PRIMARY} justify-center`}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-400">Enter sends; Shift+Enter starts a new line.</p>
    </div>
  );
}

/** A dry run: what the assistant would do now with one customer message (decision and checks; no closing line or routing). */
function DryRun({ run }: { run: TeachDryRun }) {
  return (
    <div className="w-full max-w-[85%] min-w-0 rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-white dark:bg-slate-900 p-2.5">
      <Eyebrow className="flex items-center gap-1.5">
        <FlaskConical className="h-3 w-3" />
        Dry run · what the assistant would do now
      </Eyebrow>
      <p className="mt-1.5 break-words text-[12.5px] italic text-slate-600 dark:text-slate-300">“{run.message}”</p>
      <p className="mt-1 text-[12.5px] text-slate-800 dark:text-slate-200">
        <span className="font-semibold">{TEACH_OUTCOME_LABEL[run.outcome]}</span>
        {run.intent && <span className="text-slate-500 dark:text-slate-400"> · {ruleIntentLabel(run.intent)}</span>}
        {run.ruleFired && <span className="text-indigo-700 dark:text-indigo-300"> · A rule fired</span>}
      </p>
      {run.bubbles.map((b, i) => (
        <p key={i} className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-indigo-50/60 dark:bg-indigo-500/10 px-2 py-1 text-[12.5px] text-indigo-900 dark:text-indigo-200">
          {b}
        </p>
      ))}
      <p className="mt-1.5 text-[11px] text-slate-400">Includes your drafts. The closing line and routing are not shown.</p>
    </div>
  );
}
