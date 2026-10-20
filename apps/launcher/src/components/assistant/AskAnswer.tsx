import { useId, useState } from 'react';
import { ArrowRight, Check, Loader2, ThumbsDown, ThumbsUp, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AskLink, AskView } from '@/api/assistant';
import { CORRECTION_MAX, canGiveFeedback, isSmallTalk, shownAnswer } from '@/assistant/ask';
import { resolveLink } from '@/assistant/links';
import type { SuiteApp } from '@/suite/apps';

export interface LinkOpeners {
  /** The hand-off with a target path (P1): `openApp(app, path)` in suite/handoff.ts. */
  openApp: (app: SuiteApp, path: string) => Promise<void>;
  /** A page of the launcher itself, by its own router. */
  navigate: (path: string) => void;
}

/** One link: a "Take me there" button, or a plain note when it cannot be opened from here. */
export function AskLinkRow({ link, tiles, openers }: { link: AskLink; tiles: SuiteApp[]; openers: LinkOpeners }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = resolveLink(link, tiles);

  if ('note' in target) {
    return <p className="text-sm text-foreground/55 break-words">{target.note}</p>;
  }

  const go = async () => {
    if (target.kind === 'launcher') {
      openers.navigate(target.path);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await openers.openApp(target.app, target.path);
      // Navigation has begun; the spinner stays until the page goes.
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : `Could not open ${target.app.name}`);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold min-w-0 break-words">{link.shows}</span>
        <Button size="sm" className="gap-1.5" onClick={() => void go()} disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Take me there
          {!busy && <ArrowRight className="w-4 h-4" />}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive break-words">{error}</p>}
    </div>
  );
}

/** Good or wrong, once; "wrong" opens a correction box. */
export function AskFeedback({
  ask,
  onSend,
}: {
  ask: AskView;
  onSend: (feedback: 'good' | 'wrong', correction: string) => Promise<void>;
}) {
  const [writing, setWriting] = useState(false);
  const [correction, setCorrection] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per render, not per ask: the same ask is in the done box and in the list at once.
  const correctionId = useId();

  if (ask.feedback) {
    return (
      <div className="text-sm text-foreground/55">
        <p className="flex items-center gap-1.5">
          <Check className="w-4 h-4" /> You marked this {ask.feedback}.
        </p>
        {ask.correction && <p className="mt-1 whitespace-pre-wrap break-words">{ask.correction}</p>}
      </div>
    );
  }
  if (!canGiveFeedback(ask)) return null;

  const send = async (feedback: 'good' | 'wrong') => {
    setBusy(true);
    setError(null);
    try {
      await onSend(feedback, feedback === 'wrong' ? correction : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!writing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-foreground/55">Was this right?</span>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => void send('good')}>
            <ThumbsUp className="w-4 h-4" /> Good
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => setWriting(true)}>
            <ThumbsDown className="w-4 h-4" /> Wrong
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-semibold text-foreground/60" htmlFor={correctionId}>
            What was wrong? (optional)
          </label>
          <textarea
            id={correctionId}
            value={correction}
            onChange={(e) => setCorrection(e.target.value.slice(0, CORRECTION_MAX))}
            maxLength={CORRECTION_MAX}
            rows={3}
            className="w-full min-w-0 rounded-xl border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void send('wrong')} className="gap-1.5">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Send
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setWriting(false)}>
              Cancel
            </Button>
            <span className="text-xs text-foreground/45 ml-auto">
              {correction.length} / {CORRECTION_MAX}
            </span>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-destructive break-words">{error}</p>}
    </div>
  );
}

/**
 * One ask as the person sees it (plan §D): the answer as plain prose — the
 * api sends no markdown and none is rendered — the refusal lines exactly as
 * the api wrote them, the links, and feedback. An ask still `asking` (one the
 * list caught in flight, or abandoned) shows the in-flight line and nothing
 * to rate. Chit-chat, and the clarification line that asks a follow-up which
 * figure it means (`smallTalk`), is a normal bubble with no feedback row at
 * all: there is nothing in it to mark good or wrong.
 */
export function AskAnswer({
  ask,
  replayed = false,
  showQuestion = false,
  tiles,
  openers,
  onFeedback,
}: {
  ask: AskView;
  replayed?: boolean;
  showQuestion?: boolean;
  tiles: SuiteApp[];
  openers: LinkOpeners;
  onFeedback: (feedback: 'good' | 'wrong', correction: string) => Promise<void>;
}) {
  const answer = shownAnswer(ask);
  const quiet = ask.state === 'failed' || ask.state === 'capped' || ask.state === 'off';
  return (
    <div className="flex flex-col gap-3 min-w-0">
      {showQuestion && <p className="text-sm font-bold whitespace-pre-wrap break-words">{ask.question}</p>}
      {ask.state === 'asking' && (
        <p className="flex items-center gap-2 text-sm text-foreground/60">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          Still answering…
        </p>
      )}
      {answer && (
        <p
          className={
            quiet
              ? 'flex items-start gap-2 text-sm text-foreground/70 whitespace-pre-wrap break-words'
              : 'text-base whitespace-pre-wrap break-words'
          }
        >
          {quiet && <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />}
          <span className="min-w-0">{answer}</span>
        </p>
      )}
      {ask.refusals.length > 0 && (
        <ul className="flex flex-col gap-1">
          {ask.refusals.map((r, i) => (
            <li key={`${r.tool}-${i}`} className="text-sm text-foreground/55 whitespace-pre-wrap break-words">
              {r.line}
            </li>
          ))}
        </ul>
      )}
      {ask.links.length > 0 && (
        <div className="flex flex-col gap-2">
          {ask.links.map((link) => (
            <AskLinkRow key={`${link.key}-${link.path}`} link={link} tiles={tiles} openers={openers} />
          ))}
        </div>
      )}
      {replayed && <p className="text-xs text-foreground/45">Answered when it was first sent.</p>}
      {!isSmallTalk(ask) && <AskFeedback ask={ask} onSend={onFeedback} />}
    </div>
  );
}
