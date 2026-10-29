import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CheckCircle2, FlaskConical, Loader2, Send } from 'lucide-react';
import { newId } from '@oto/shared/ids';
import { ApiError } from '@/api/client';
import { NOT_ON_YOUR_ACCESS, assistantApi, notOnAccess, type TeachCard, type TeachDryRun } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import type { AssistantTab } from '@/lib/url';
import { KbConfirm, RuleConfirm } from '@/components/AssistantConfirms';
import { Eyebrow } from '@/components/atoms';
import { Refusal } from '@/components/confirms';
import { FIELD } from '@/components/CorrectAssistant';
import {
  KB_STATUS_LABEL,
  KB_STATUS_TINT,
  RULE_CONDITION_LABEL,
  TEACH_MESSAGE_MAX,
  TEACH_OUTCOME_LABEL,
  ruleIntentLabel,
  ruleQuestions,
  teachDraftContents,
  teachPayload,
  uniqueTeachCards,
  type TeachDraftContent,
} from '@/lib/assistant';
import { branchLabel, langLabel } from '@/lib/view';

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

/** What a card says once its draft has left the drafts list. */
export const TEACH_CARD_GONE = 'No longer a draft: it was approved or archived since.';

/** What a dry run leaves out, said under every one. */
export const TEACH_DRY_RUN_NOTE =
  'Includes your drafts. Not shown: rules for one park only, the closing line and routing, and the customer’s second message. “Stays silent” here may be the hand-over for an unclear message when live.';

const parkOf = (branchId: string | null, me: InboxMe) => (branchId ? branchLabel(branchId, me.teams) : 'Both parks');

/**
 * Teach the assistant (SCRUM-696): a chat with the curator, the same
 * assistant that holds the knowledge, on the Assistant page. It answers "what
 * do you say today when…", saves what it is told as a DRAFT fact or rule (a
 * card under its reply, showing the whole draft, approved here through the
 * same confirmation as its tab) and can dry-run a customer message. Nothing
 * here touches a thread or reaches a customer.
 * The page keeps this mounted while another tab shows (`active` false), so a
 * card's "Open in Rules" keeps the chat; the last twenty lines travel with
 * each message, under one session id. The drafts are read again each time
 * the tab comes back, so an edit or approval made there shows here.
 */
export function TeachPanel({ me, active = true, onTab }: { me: InboxMe; active?: boolean; onTab: (t: AssistantTab) => void }) {
  const [sessionId] = useState(() => newId());
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each card's draft as last read, and the ones approved here (as they were approved).
  const [contents, setContents] = useState<Record<string, TeachDraftContent>>({});
  const [approvedHere, setApprovedHere] = useState<Record<string, TeachDraftContent>>({});
  const [readError, setReadError] = useState<string | null>(null);
  const [acting, setActing] = useState<TeachCard | null>(null);
  const [approving, setApproving] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<Line[]>(lines);
  const readSeq = useRef(0);

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && active) el.scrollTop = el.scrollHeight;
  }, [lines, busy, active]);

  /** Read every card's draft from the drafts lists (the reply names only an id and a title). */
  const readDrafts = useCallback(async (all: readonly Line[]) => {
    const cards = uniqueTeachCards(all.flatMap((l) => l.cards ?? []));
    if (cards.length === 0) return;
    const seq = ++readSeq.current;
    try {
      const [rules, entries] = await Promise.all([
        cards.some((c) => c.kind === 'rule') ? assistantApi.rules('draft').then((r) => r.rules) : null,
        cards.some((c) => c.kind === 'fact') ? assistantApi.kbDrafts().then((r) => r.entries) : null,
      ]);
      if (seq !== readSeq.current) return;
      setContents((was) => ({ ...was, ...teachDraftContents(cards, { rules, entries }) }));
      setReadError(null);
    } catch (err) {
      if (seq !== readSeq.current) return;
      setReadError(said(err, 'The drafts could not be read. Open them in Rules or Knowledge to review them.'));
    }
  }, []);

  // The tab came back: what was approved, edited or archived meanwhile shows on the cards.
  useEffect(() => {
    if (active) void readDrafts(linesRef.current);
  }, [active, readDrafts]);

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
      const after: Line[] = [...next, { role: 'assistant', text: reply.reply, cards: uniqueTeachCards(reply.cards), dryRun: reply.dryRun }];
      setLines(after);
      if (reply.cards.length > 0) void readDrafts(after);
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

  const actingContent = acting ? contents[acting.id] : undefined;
  const approve = async () => {
    if (!acting || !actingContent || actingContent.kind === 'gone') return;
    setApproving(true);
    setActError(null);
    try {
      if (actingContent.kind === 'fact') await assistantApi.approveKb(actingContent.entry.id);
      else await assistantApi.approveRule(actingContent.rule.id);
      setApprovedHere((was) => ({ ...was, [acting.id]: actingContent }));
      setActing(null);
    } catch (err) {
      setActError(said(err, actingContent.kind === 'fact' ? 'The entry could not be approved.' : 'The rule could not be approved.'));
    } finally {
      setApproving(false);
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
              {l.cards?.map((c) => (
                <TeachCardView
                  key={c.id}
                  me={me}
                  card={c}
                  content={approvedHere[c.id] ?? contents[c.id]}
                  approved={c.id in approvedHere}
                  readError={readError}
                  onApprove={() => {
                    setActError(null);
                    setActing(c);
                  }}
                  onOpen={() => onTab(c.kind === 'fact' ? 'knowledge' : 'rules')}
                />
              ))}
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

      <TeachApproveConfirm
        me={me}
        content={acting && active ? actingContent : undefined}
        busy={approving}
        error={actError}
        onCancel={() => setActing(null)}
        onConfirm={() => void approve()}
      />
    </div>
  );
}

/**
 * Approve on a Teach card: the Rules tab's or the Knowledge tab's own
 * confirmation, over the draft the card shows. Closed while nothing is chosen
 * or the draft is no longer one.
 */
export function TeachApproveConfirm({
  me,
  content,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  me: InboxMe;
  content: TeachDraftContent | undefined;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <RuleConfirm
        me={me}
        acting={content?.kind === 'rule' ? { rule: content.rule, what: 'approve' } : null}
        busy={busy}
        error={error}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
      <KbConfirm
        acting={content?.kind === 'fact' ? { entry: content.entry, what: 'approve' } : null}
        busy={busy}
        error={error}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </>
  );
}

/**
 * One draft the chat saved, in full before Approve: a fact's key, language,
 * park, question and whole answer; a rule's kind of message, park,
 * instruction and, when it asks first, the condition and the question in each
 * language. Approve waits until the draft has been read.
 */
export function TeachCardView({
  me,
  card,
  content,
  approved,
  readError,
  onApprove,
  onOpen,
}: {
  me: InboxMe;
  card: TeachCard;
  /** Undefined until the drafts have been read. */
  content: TeachDraftContent | undefined;
  approved: boolean;
  readError: string | null;
  onApprove: () => void;
  onOpen: () => void;
}) {
  const readable = content !== undefined && content.kind !== 'gone';
  const canApprove = !approved && readable && (content.kind === 'fact' ? content.entry.canManage : content.rule.canManage);
  return (
    <div className="w-full max-w-[85%] min-w-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
          {card.kind === 'fact' ? 'Fact' : 'Rule'}
        </span>
        {content?.kind !== 'gone' && (
          <span className={`rounded-full px-1.5 text-[10px] font-medium ring-1 ${KB_STATUS_TINT[approved ? 'approved' : 'draft']}`}>
            {KB_STATUS_LABEL[approved ? 'approved' : 'draft']}
          </span>
        )}
        {content?.kind === 'fact' && (
          <>
            <span className="min-w-0 break-all font-mono text-[11px] text-slate-700 dark:text-slate-200">{content.entry.key}</span>
            <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
              {langLabel(content.entry.language)}
            </span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">{parkOf(content.entry.branchId, me)}</span>
          </>
        )}
        {content?.kind === 'rule' && (
          <>
            <span className="text-[11.5px] font-semibold text-slate-800 dark:text-slate-100">{ruleIntentLabel(content.rule.intent)}</span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">{parkOf(content.rule.branchId, me)}</span>
          </>
        )}
      </div>

      {content?.kind === 'fact' && (
        <>
          <p className="mt-1.5 break-words text-[12.5px] font-medium text-slate-800 dark:text-slate-200">{content.entry.question}</p>
          <p className="mt-1 whitespace-pre-line break-words text-[12.5px] text-slate-600 dark:text-slate-300">{content.entry.body}</p>
        </>
      )}
      {content?.kind === 'rule' && (
        <>
          <p className="mt-1.5 whitespace-pre-line break-words text-[12.5px] text-slate-700 dark:text-slate-200">{content.rule.instruction}</p>
          {content.rule.askFirst ? (
            <div className="mt-1 break-words rounded-lg bg-indigo-50/60 dark:bg-indigo-500/10 px-2 py-1 text-[12.5px] text-indigo-900 dark:text-indigo-200">
              <p>
                <span className="font-medium">Ask first</span>
                <span className="text-[11px] text-indigo-700/80 dark:text-indigo-300/80"> · {RULE_CONDITION_LABEL[content.rule.askFirst.condition]}</span>
              </p>
              {ruleQuestions(content.rule.askFirst).map(([language, question]) => (
                <p key={language} className="mt-0.5">
                  <span className="text-[11px] font-medium text-indigo-700/80 dark:text-indigo-300/80">{language}:</span>{' '}
                  {question ?? <span className="italic text-indigo-700/70 dark:text-indigo-300/70">not written</span>}
                </p>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-[11.5px] text-slate-500 dark:text-slate-400">Asks nothing first.</p>
          )}
        </>
      )}
      {!readable && <p className="mt-1 break-words text-[12.5px] text-slate-800 dark:text-slate-200">{card.title}</p>}
      {content?.kind === 'gone' && <p className="mt-1 text-[11.5px] text-slate-500 dark:text-slate-400">{TEACH_CARD_GONE}</p>}
      {content === undefined && !readError && (
        <p className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-slate-400">
          <Loader2 className="h-3 w-3 animate-spin" /> Reading the whole draft…
        </p>
      )}
      {content === undefined && readError && <Refusal text={readError} tone={readError === NOT_ON_YOUR_ACCESS ? 'amber' : 'rose'} />}

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {canApprove && (
          <button type="button" onClick={onApprove} className={BUTTON}>
            <CheckCircle2 className="h-3 w-3" />
            Approve
          </button>
        )}
        <button type="button" onClick={onOpen} className={BUTTON}>
          {card.kind === 'fact' ? 'Open in Knowledge' : 'Open in Rules'}
        </button>
      </div>
    </div>
  );
}

/** A dry run: what the assistant would do now with one customer message (decision and checks), and what it leaves out. */
export function DryRun({ run }: { run: TeachDryRun }) {
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
      <p className="mt-1.5 text-[11px] text-slate-400">{TEACH_DRY_RUN_NOTE}</p>
    </div>
  );
}
