import { useCallback, useState, type FormEvent } from 'react';
import { Bot, ChevronDown, ChevronUp, Loader2, Send, TriangleAlert } from 'lucide-react';
import { INTERNAL_ASSISTANT_LABEL } from '@oto/assistant/internal-lines';
import type { Permission } from '@oto/shared/permissions';
import { newId } from '@oto/shared/ids';
import { Button } from '@/components/ui/button';
import { assistantApi, type AskView } from '@/api/assistant';
import {
  ASK_PERMISSION,
  QUESTION_MAX,
  giveFeedback,
  idForSend,
  mergeAsks,
  runAsk,
  type AskPhase,
} from '@/assistant/ask';
import type { SuiteApp } from '@/suite/apps';
import { AskAnswer, type LinkOpeners } from './AskAnswer';

/** The calls the panel makes; the api module by default, a fake in a test. */
export interface PanelApi {
  ask: typeof assistantApi.ask;
  one: typeof assistantApi.one;
  mine: typeof assistantApi.mine;
  feedback: typeof assistantApi.feedback;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The internal assistant on the launcher home (SCRUM-591, round I3a; plan
 * §A.2, §D). Labelled as the assistant, plainly: it IS one, and the customer
 * persona's rules do not apply here (§D.2).
 */
export function AssistantPanel({
  tiles,
  openers,
  client = assistantApi,
}: {
  tiles: SuiteApp[];
  openers: LinkOpeners;
  client?: PanelApi;
}) {
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<AskPhase>({ kind: 'idle' });
  const [mine, setMine] = useState<{ asks: AskView[]; cursor: string | null } | null>(null);
  const [mineOpen, setMineOpen] = useState(false);
  const [mineBusy, setMineBusy] = useState(false);
  const [mineError, setMineError] = useState<string | null>(null);

  const busy = phase.kind === 'sending' || phase.kind === 'still-answering';
  const trimmed = question.trim();

  /** One ask changed (an answer arrived, or feedback was given): the panel and the list agree. */
  const put = useCallback((ask: AskView) => {
    setPhase((p) => (p.kind === 'done' && p.ask.id === ask.id ? { ...p, ask } : p));
    setMine((m) => (m ? { ...m, asks: mergeAsks(m.asks, [ask]) } : m));
  }, []);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !trimmed) return;
    const id = idForSend(phase, trimmed, newId);
    const end = await runAsk(id, trimmed, {
      ask: client.ask,
      one: client.one,
      sleep,
      now: () => Date.now(),
      onPhase: setPhase,
    });
    if (end.kind === 'done') {
      // Answered: the box is free for the next question. On any failure the
      // typed question stays, and asking again resends the same id.
      setQuestion('');
      put(end.ask);
    }
  };

  const feedbackFor = (ask: AskView) => async (feedback: 'good' | 'wrong', correction: string) => {
    const next = await giveFeedback(ask, feedback, correction, {
      send: client.feedback,
      mint: () => crypto.randomUUID(),
    });
    put(next);
  };

  const loadMine = async (cursor: string | null) => {
    setMineBusy(true);
    setMineError(null);
    try {
      const page = await client.mine(cursor);
      setMine((m) => ({
        asks: mergeAsks(cursor && m ? m.asks : [], page.asks),
        cursor: page.nextCursor,
      }));
    } catch (err) {
      setMineError(err instanceof Error ? err.message : 'Could not load your questions');
    } finally {
      setMineBusy(false);
    }
  };

  const toggleMine = () => {
    const next = !mineOpen;
    setMineOpen(next);
    if (next) void loadMine(null);
  };

  return (
    <section
      aria-label={INTERNAL_ASSISTANT_LABEL.en}
      className="mt-10 rounded-2xl border bg-card/80 backdrop-blur-sm shadow-sm p-5 sm:p-6 min-w-0"
    >
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Bot className="w-5 h-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight">{INTERNAL_ASSISTANT_LABEL.en}</h2>
          <p className="text-sm text-muted-foreground">
            Answers from what your own access can see, with a link to the screen.
          </p>
        </div>
      </div>

      <form onSubmit={(e) => void send(e)} className="mt-4 flex flex-col gap-2">
        <label htmlFor="assistant-question" className="sr-only">
          Your question
        </label>
        <textarea
          id="assistant-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value.slice(0, QUESTION_MAX))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          }}
          maxLength={QUESTION_MAX}
          rows={3}
          disabled={busy}
          placeholder="Ask a question"
          className="w-full min-w-0 rounded-2xl border border-input bg-background px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-70"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || !trimmed} className="gap-2">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {phase.kind === 'still-answering' ? 'Still answering…' : busy ? 'Answering…' : 'Ask'}
          </Button>
          <span className="text-xs text-foreground/45 ml-auto">
            {question.length} / {QUESTION_MAX}
          </span>
        </div>
      </form>

      <div aria-live="polite" className="mt-4 empty:hidden">
        {phase.kind === 'still-answering' && (
          <p className="text-sm text-foreground/60">Still answering — this page will show it when it is ready.</p>
        )}
        {phase.kind === 'done' && (
          <div className="rounded-xl border bg-background/60 p-4">
            <AskAnswer
              ask={phase.ask}
              replayed={phase.replayed}
              tiles={tiles}
              openers={openers}
              onFeedback={feedbackFor(phase.ask)}
            />
          </div>
        )}
        {(phase.kind === 'unreachable' || phase.kind === 'refused-access' || phase.kind === 'rejected') && (
          <p className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive break-words">
            <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="min-w-0">{phase.kind === 'unreachable' ? phase.line : phase.message}</span>
          </p>
        )}
      </div>

      <div className="mt-6 border-t pt-4">
        <button
          type="button"
          onClick={toggleMine}
          aria-expanded={mineOpen}
          className="flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
        >
          My questions
          {mineOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {mineOpen && (
          <div className="mt-3 flex flex-col gap-3">
            {mineError && <p className="text-sm text-destructive break-words">{mineError}</p>}
            {mine && mine.asks.length === 0 && !mineBusy && (
              <p className="text-sm text-foreground/55">No questions yet.</p>
            )}
            {mine?.asks.map((ask) => (
              <article key={ask.id} className="rounded-xl border bg-background/60 p-4 min-w-0">
                <p className="text-xs text-foreground/45">{new Date(ask.createdAt).toLocaleString()}</p>
                <div className="mt-1">
                  <AskAnswer
                    ask={ask}
                    showQuestion
                    tiles={tiles}
                    openers={openers}
                    onFeedback={feedbackFor(ask)}
                  />
                </div>
              </article>
            ))}
            {mineBusy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            {mine?.cursor && !mineBusy && (
              <Button variant="outline" size="sm" className="self-start" onClick={() => void loadMine(mine?.cursor ?? null)}>
                Show older
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The panel, or nothing at all: without `assistant:ask:use` there is no
 * disabled stub and no line about it (the brief's capability gate).
 */
export function AssistantSection({
  has,
  tiles,
  openers,
  client,
}: {
  has: (permission: Permission) => boolean;
  tiles: SuiteApp[];
  openers: LinkOpeners;
  client?: PanelApi;
}) {
  if (!has(ASK_PERMISSION)) return null;
  return <AssistantPanel tiles={tiles} openers={openers} client={client} />;
}
