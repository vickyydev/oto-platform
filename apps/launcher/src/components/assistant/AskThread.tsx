import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AskView } from '@/api/assistant';
import { threadItemKey, type PendingPhase, type ThreadItem } from '@/assistant/shell';
import { formatWhen } from '@/lib/time';
import type { SuiteApp } from '@/suite/apps';
import { AskAnswer, type LinkOpeners } from './AskAnswer';

/** The person's words, on the right, with when they were sent beneath. */
function QuestionBubble({ text, at, timezone }: { text: string; at: string; timezone?: string | null }) {
  return (
    <div className="flex flex-col items-end gap-1 pl-8">
      <p className="max-w-full rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap break-words">
        {text}
      </p>
      <time dateTime={at} className="text-xs text-foreground/45 tabular-nums">
        {formatWhen(at, timezone)}
      </time>
    </div>
  );
}

/** The assistant's side, on the left: the answer, a state line, or a failure. */
function AnswerBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex pr-6">
      <div className="min-w-0 max-w-full flex-1 rounded-2xl rounded-bl-md border bg-background/60 px-4 py-3">
        {children}
      </div>
    </div>
  );
}

/** What the answer bubble shows while there is no ask row: the state lines, as the panel had them. */
function PendingAnswer({ phase }: { phase: PendingPhase }) {
  if (phase.kind === 'sending') {
    return (
      <p className="flex items-center gap-2 text-sm text-foreground/60">
        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
        Answering…
      </p>
    );
  }
  if (phase.kind === 'still-answering') {
    return (
      <p className="flex items-center gap-2 text-sm text-foreground/60">
        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
        Still answering — this page will show it when it is ready.
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2 text-sm text-destructive break-words">
      <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="min-w-0">{phase.kind === 'unreachable' ? phase.line : phase.message}</span>
    </p>
  );
}

/** What changes about the newest item that should bring the thread back to the bottom. */
function newestMark(items: ThreadItem[]): string {
  const last = items[items.length - 1];
  if (!last) return '';
  if (last.kind === 'pending') return `${threadItemKey(last)}:${last.phase.kind}`;
  return `${last.ask.id}:${last.ask.state}:${last.ask.answer ? 1 : 0}`;
}

export interface AskThreadProps {
  items: ThreadItem[];
  /** The list's next page, when there is one. */
  cursor: string | null;
  loading: boolean;
  error: string | null;
  onOlder: () => Promise<void>;
  tiles: SuiteApp[];
  openers: LinkOpeners;
  feedbackFor: (ask: AskView) => (feedback: 'good' | 'wrong', correction: string) => Promise<void>;
  timezone?: string | null;
  /** The one quiet line an empty thread shows. */
  emptyLine: string;
}

/**
 * The conversation (SCRUM-591, the chat-popup round): oldest at the top,
 * newest at the bottom, scrolled to the bottom when it opens and whenever
 * the newest item changes — a question sent, an answer arrived. "Show older"
 * loads the previous page above and keeps what was on screen where it was.
 * A log region, so a reader hears an answer land without losing its place.
 */
export function AskThread({
  items,
  cursor,
  loading,
  error,
  onOlder,
  tiles,
  openers,
  feedbackFor,
  timezone,
  emptyLine,
}: AskThreadProps) {
  const logRef = useRef<HTMLDivElement>(null);
  /**
   * The scroll height and the item count when an older page was asked for:
   * once the page has landed (the count grew), the view is moved down by
   * what was added above it, so what was on screen stays where it was.
   */
  const keep = useRef<{ height: number; count: number } | null>(null);
  const seen = useRef<string | null>(null);
  const mark = newestMark(items);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (keep.current !== null) {
      // Still fetching, nothing added yet: wait for the page.
      if (loading && items.length === keep.current.count) return;
      if (items.length !== keep.current.count) el.scrollTop += el.scrollHeight - keep.current.height;
      keep.current = null;
      seen.current = mark;
      return;
    }
    if (seen.current !== mark) el.scrollTop = el.scrollHeight;
    seen.current = mark;
  });

  const older = async () => {
    const el = logRef.current;
    keep.current = el ? { height: el.scrollHeight, count: items.length } : null;
    try {
      await onOlder();
    } catch {
      keep.current = null;
    }
  };

  const empty = items.length === 0 && !loading && !error;

  return (
    <div
      ref={logRef}
      role="log"
      aria-live="polite"
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4 flex flex-col gap-4"
    >
      {cursor && !loading && (
        <Button variant="outline" size="sm" className="self-center shrink-0" onClick={() => void older()}>
          Show older
        </Button>
      )}
      {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground self-center shrink-0" />}
      {error && <p className="text-sm text-destructive text-center break-words">{error}</p>}
      {empty && <p className="m-auto px-4 text-center text-sm text-foreground/55">{emptyLine}</p>}
      {items.map((item) =>
        item.kind === 'ask' ? (
          <article key={item.ask.id} className="flex flex-col gap-2 min-w-0">
            <QuestionBubble text={item.ask.question} at={item.ask.createdAt} timezone={timezone} />
            <AnswerBubble>
              <AskAnswer ask={item.ask} tiles={tiles} openers={openers} onFeedback={feedbackFor(item.ask)} />
            </AnswerBubble>
          </article>
        ) : (
          <article key={threadItemKey(item)} className="flex flex-col gap-2 min-w-0">
            <QuestionBubble text={item.question} at={item.sentAt} timezone={timezone} />
            <AnswerBubble>
              <PendingAnswer phase={item.phase} />
            </AnswerBubble>
          </article>
        ),
      )}
    </div>
  );
}
