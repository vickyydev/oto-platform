import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Bot, CheckCircle2, FlaskConical, GraduationCap, Loader2 } from 'lucide-react';
import { newId } from '@oto/shared/ids';
import { ApiError } from '@/api/client';
import { NOT_ON_YOUR_ACCESS, assistantApi, notOnAccess, type TeachCard, type TeachDryRun } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import type { AssistantTab } from '@/lib/url';
import { KbConfirm, RuleConfirm } from '@/components/AssistantConfirms';
import { StatusBadge, intentTitle } from '@/components/assistant-parts';
import { Eyebrow } from '@/components/atoms';
import { InlineError, PAGE_COLUMN } from '@/components/settings-parts';
import { BADGE, BTN_SMALL, HINT, TONE } from '@/components/ui';
import { COMPOSER_LINE_PX, composerBox, sendsOnKey } from '@/lib/composer';
import {
  RULE_CONDITION_LABEL,
  TEACH_MESSAGE_MAX,
  TEACH_OUTCOME_LABEL,
  ruleQuestions,
  teachDraftContents,
  teachPayload,
  uniqueTeachCards,
  type TeachDraftContent,
} from '@/lib/assistant';
import { branchLabel, langLabel } from '@/lib/view';

/** The assistant's own words on its mint, as its lines are in a chat. */
const ASSISTANT_LINE = 'rounded-xl bg-mint px-3 py-2 text-ui leading-relaxed text-teal';

/**
 * A line of the chat as the Inbox draws one (MessageBubble, SCRUM-1045): a
 * column of at most 34 em and 78 % of the thread, the bubble 18 px round with
 * its author's corner smaller, the body size at a 1.4 leading. The curator
 * is on the left in the assistant's mint under "Assistant"; the person on the
 * right in the staff colour.
 */
const COLUMN = 'flex min-w-0 max-w-[min(78%,34em)] flex-col gap-1';
const BUBBLE = 'max-w-full whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2.5 text-body leading-[1.4]';
/** A card in the thread (a saved draft, a dry run): wider than a line, never wider than the thread. */
const THREAD_CARD = 'w-full min-w-0 max-w-[min(100%,36em)] rounded-2xl border bg-card p-3.5';

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

/** What the chat offers before its first line. */
export const TEACH_EXAMPLE = 'For example: “If someone says they lost something, first ask which park they visited.”';

/** What a card says once its draft has left the drafts list. */
export const TEACH_CARD_GONE = 'No longer a draft: it was approved or archived since.';

/** What a dry run leaves out, said under every one. */
export const TEACH_DRY_RUN_NOTE =
  'Includes your drafts. Not shown: rules for one park only, the closing line and routing, and the customer’s second message. “Stays silent” here may be the hand-over for an unclear message when live.';

/** The message box's own words, the same as before SCRUM-1044. */
export const TEACH_PLACEHOLDER = 'Tell it a fact, a rule, or ask what it says today when…';
export const TEACH_KEYS_HINT = 'Enter sends; Shift+Enter starts a new line.';

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
 *
 * Since SCRUM-1044 it is laid out as the Inbox lays out a chat: the thread
 * fills the page area and scrolls with it, the briefing at its top; the
 * message box sits in a bar held at the foot of the page area, on screen at
 * every width, and grows with its words as the reply box does.
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
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const linesRef = useRef<Line[]>(lines);
  const readSeq = useRef(0);
  const keysId = useId();

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  // The newest line in view: the page area scrolls the thread (the bar stays at its foot).
  useEffect(() => {
    const el = rootRef.current?.closest<HTMLElement>('[data-pane="settings"]');
    if (el && active) el.scrollTop = el.scrollHeight;
  }, [lines, busy, active]);

  // The box is as tall as its words, to the reply box's cap (`composerBox`), measured after every change.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !active) return;
    box.style.height = 'auto';
    const { heightPx, scrolls } = composerBox(box.scrollHeight);
    box.style.height = `${heightPx}px`;
    box.style.overflowY = scrolls ? 'auto' : 'hidden';
  }, [draft, active]);

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
    if (sendsOnKey({ key: e.key, shiftKey: e.shiftKey, composing: e.nativeEvent.isComposing })) {
      e.preventDefault();
      void send();
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send();
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
    <div ref={rootRef} data-teach-thread className="flex min-w-0 flex-1 flex-col">
      {/* The thread: the briefing first (in the middle of the page while nothing is said), then the lines, as the Inbox's timeline. */}
      <div className={`${PAGE_COLUMN} flex flex-1 flex-col gap-2.5 pb-5 pt-4`}>
        <div
          className={`mx-auto flex max-w-md flex-col items-center gap-2 rounded-2xl bg-band px-4 py-3.5 text-center ${
            lines.length === 0 && !busy ? 'my-auto' : ''
          }`}
        >
          <GraduationCap aria-hidden className="h-5 w-5 text-ink-soft" />
          <p className="text-note leading-relaxed text-ink-soft">{TEACH_INTRO}</p>
          {lines.length === 0 && !busy && <p className="text-note italic leading-relaxed text-ink-muted">{TEACH_EXAMPLE}</p>}
        </div>

        {lines.map((l, i) =>
          l.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className={`${COLUMN} items-end`}>
                <p className={`${BUBBLE} rounded-tr-md bg-staff text-on-staff`}>{l.text}</p>
              </div>
            </div>
          ) : (
            <div key={i} className="flex flex-col items-start gap-2">
              <div className={`${COLUMN} items-start`}>
                <CuratorLabel />
                <p className={`${BUBBLE} rounded-tl-md bg-mint text-teal`}>{l.text}</p>
              </div>
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
          <div className={`${COLUMN} items-start`}>
            <CuratorLabel />
            <p className={`${BUBBLE} inline-flex items-center gap-2 rounded-tl-md bg-mint text-teal`}>
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              Thinking…
            </p>
          </div>
        )}
      </div>

      {/* The message box: held at the foot of the page area on every width, as the reply box is in a chat. */}
      <div data-teach-composer className="sticky bottom-0 z-10 shrink-0 border-t border-line bg-card">
        <div className={`${PAGE_COLUMN} pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5`}>
          {error && (
            <div className="mb-2">
              <InlineError text={error} tone={error === NOT_ON_YOUR_ACCESS ? 'ask' : 'danger'} />
            </div>
          )}
          <form onSubmit={onSubmit} className="flex items-end gap-2">
            {/* The pill is the box's frame; a press anywhere on it puts the caret in the box (the Inbox's reply pill). */}
            <label className="relative flex min-w-0 flex-1 cursor-text rounded-[22px] border border-field bg-ground px-4 py-[calc((var(--ui-h-icon)-22px)/2)] focus-within:outline-2 focus-within:outline-coral">
              {/* The placeholder on one line, ending in an ellipsis where the box is narrow; the native one stays for assistive technology. */}
              {draft === '' && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-4 top-1/2 -translate-y-1/2 truncate text-body text-ink-muted"
                  style={{ lineHeight: `${COMPOSER_LINE_PX}px` }}
                >
                  {TEACH_PLACEHOLDER}
                </span>
              )}
              <textarea
                ref={boxRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                maxLength={TEACH_MESSAGE_MAX}
                aria-label="Message to the assistant"
                aria-describedby={keysId}
                placeholder={TEACH_PLACEHOLDER}
                style={{ lineHeight: `${COMPOSER_LINE_PX}px` }}
                className="block w-full min-w-0 resize-none bg-transparent text-body text-ink placeholder:whitespace-nowrap placeholder:text-transparent focus:outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              aria-label="Send"
              className="hit flex h-icon min-w-icon shrink-0 items-center justify-center gap-1.5 rounded-full bg-coral text-ui font-bold text-on-coral hover:bg-coral/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral disabled:cursor-not-allowed disabled:bg-band disabled:text-ink-muted lg:px-4"
            >
              {busy ? <Loader2 aria-hidden className="h-5 w-5 animate-spin" /> : <ArrowUp aria-hidden className="h-5 w-5 lg:hidden" />}
              <span aria-hidden className="hidden lg:inline">
                Send
              </span>
            </button>
          </form>
          <p id={keysId} className={`mt-1.5 px-4 ${HINT}`}>
            {TEACH_KEYS_HINT}
          </p>
        </div>
      </div>

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

/** "Assistant" over the curator's lines, in its teal, as over the assistant's lines in a chat. */
function CuratorLabel() {
  return (
    <span className="inline-flex items-center gap-1 px-1 text-caption font-bold text-teal">
      <Bot aria-hidden className="h-3.5 w-3.5" /> Assistant
    </span>
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
    <div className={`${THREAD_CARD} border-line`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className={`${BADGE} ${TONE.neutral}`}>{card.kind === 'fact' ? 'Fact' : 'Rule'}</span>
        {content?.kind !== 'gone' && <StatusBadge status={approved ? 'approved' : 'draft'} />}
        {content?.kind === 'fact' && (
          <>
            <span className={`${BADGE} ${TONE.neutral}`}>{langLabel(content.entry.language)}</span>
            <span className="min-w-0 break-all font-mono text-meta text-ink-soft">{content.entry.key}</span>
            <span className="text-meta text-ink-muted">· {parkOf(content.entry.branchId, me)}</span>
          </>
        )}
        {content?.kind === 'rule' && (
          <span className="text-meta text-ink-muted">
            <span className="font-semibold text-ink">{intentTitle(content.rule.intent)}</span> · {parkOf(content.rule.branchId, me)}
          </span>
        )}
      </div>

      {content?.kind === 'fact' && (
        <>
          <p className="mt-2 break-words text-ui font-semibold text-ink">{content.entry.question}</p>
          <p className="mt-1 whitespace-pre-line break-words text-ui leading-relaxed text-ink-soft">{content.entry.body}</p>
        </>
      )}
      {content?.kind === 'rule' && (
        <>
          <p className="mt-2 whitespace-pre-line break-words text-ui leading-relaxed text-ink">{content.rule.instruction}</p>
          {content.rule.askFirst ? (
            <div className={`mt-2 break-words ${ASSISTANT_LINE}`}>
              <p>
                <span className="font-semibold">Ask first</span>
                <span className="text-note"> · {RULE_CONDITION_LABEL[content.rule.askFirst.condition]}</span>
              </p>
              {ruleQuestions(content.rule.askFirst).map(([language, question]) => (
                <p key={language} className="mt-0.5">
                  <span className="text-note font-semibold">{language}:</span>{' '}
                  {question ?? <span className="italic">not written</span>}
                </p>
              ))}
            </div>
          ) : (
            <p className={`mt-1.5 ${HINT}`}>Asks nothing first.</p>
          )}
        </>
      )}
      {!readable && <p className="mt-2 break-words text-ui text-ink">{card.title}</p>}
      {content?.kind === 'gone' && <p className={`mt-1.5 ${HINT}`}>{TEACH_CARD_GONE}</p>}
      {content === undefined && !readError && (
        <p className={`mt-1.5 inline-flex items-center gap-1.5 ${HINT}`}>
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> Reading the whole draft…
        </p>
      )}
      {content === undefined && readError && (
        <div className="mt-2">
          <InlineError text={readError} tone={readError === NOT_ON_YOUR_ACCESS ? 'ask' : 'danger'} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canApprove && (
          <button type="button" onClick={onApprove} className={BTN_SMALL}>
            <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
            Approve
          </button>
        )}
        <button type="button" onClick={onOpen} className={BTN_SMALL}>
          {card.kind === 'fact' ? 'Open in Knowledge' : 'Open in Rules'}
        </button>
      </div>
    </div>
  );
}

/** A dry run: what the assistant would do now with one customer message (decision and checks), and what it leaves out. */
export function DryRun({ run }: { run: TeachDryRun }) {
  return (
    <div className={`${THREAD_CARD} border-mint-edge`}>
      <Eyebrow className="flex items-start gap-1.5">
        <FlaskConical aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
        Dry run · what the assistant would do now
      </Eyebrow>
      <p className="mt-2 break-words text-ui italic text-ink-soft">“{run.message}”</p>
      <p className="mt-1 text-ui text-ink">
        <span className="font-semibold">{TEACH_OUTCOME_LABEL[run.outcome]}</span>
        {run.intent && <span className="text-ink-muted"> · {intentTitle(run.intent)}</span>}
        {run.ruleFired && <span className="font-semibold text-teal"> · A rule fired</span>}
      </p>
      {run.bubbles.map((b, i) => (
        <p key={i} className={`mt-1.5 whitespace-pre-wrap break-words ${ASSISTANT_LINE}`}>
          {b}
        </p>
      ))}
      <p className={`mt-2 ${HINT}`}>{TEACH_DRY_RUN_NOTE}</p>
    </div>
  );
}
