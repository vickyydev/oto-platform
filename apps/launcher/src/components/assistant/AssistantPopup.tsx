import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Bot, Loader2, Send, X } from 'lucide-react';
import { INTERNAL_ASSISTANT_LABEL } from '@oto/assistant/internal-lines';
import { Button } from '@/components/ui/button';
import { QUESTION_MAX, type AskPhase } from '@/assistant/ask';
import { SHEET_MAX_WIDTH_PX, emptyThreadLine, threadOf } from '@/assistant/shell';
import { cn } from '@/lib/utils';
import type { SuiteApp } from '@/suite/apps';
import type { LinkOpeners } from './AskAnswer';
import { AskThread } from './AskThread';
import type { AskThreadState } from './useAskThread';

/** The one-line subtitle under the name, as the panel had it. */
export const ASSISTANT_SUBTITLE = 'Answers from what your own access can see, with a link to the screen.';

/**
 * The popup's frame: on a desktop a card above the floating button, about
 * 400px wide and min(70vh, 640px) tall; at phone width (`sheet:`, ≤480px,
 * index.css) a sheet the full height of the screen. The edges respect the
 * phone's safe area.
 */
export const POPUP_FRAME = cn(
  'fixed z-50 flex flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xl',
  'right-[calc(1rem_+_env(safe-area-inset-right))] bottom-[calc(4.75rem_+_env(safe-area-inset-bottom))]',
  'w-[min(400px,calc(100vw_-_2rem))] h-[min(70vh,640px)]',
  'sheet:inset-0 sheet:w-auto sheet:h-auto sheet:rounded-none sheet:border-0',
);

/**
 * On a phone the keyboard shrinks the visual viewport, not the layout one, so
 * a sheet pinned to the bottom of the layout viewport ends up under the
 * keys. While the visual viewport is shorter than the window at phone width,
 * the sheet is sized to it instead, which keeps the composer above the keyboard.
 */
function useKeyboardFit(): { top: number; height: number } | null {
  const [fit, setFit] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const read = () => {
      const phone = window.innerWidth <= SHEET_MAX_WIDTH_PX;
      const shorter = window.innerHeight - vv.height > 100;
      setFit(phone && shorter ? { top: vv.offsetTop, height: vv.height } : null);
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
    };
  }, []);
  return fit;
}

export interface AssistantPopupProps {
  thread: AskThreadState;
  draft: string;
  onDraft: (value: string) => void;
  onClose: () => void;
  tiles: SuiteApp[];
  openers: LinkOpeners;
  timezone?: string | null;
}

/**
 * The chat popup (SCRUM-591, the chat-popup round): a dialog with the
 * assistant's name, the conversation and the composer. Esc closes it (the
 * dock listens on the document); a click outside does not. Focus moves to
 * the composer when it opens.
 */
export function AssistantPopup({ thread, draft, onDraft, onClose, tiles, openers, timezone }: AssistantPopupProps) {
  const { phase, sentAt, mine, mineBusy, mineError, busy, send, feedbackFor, loadMine } = thread;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fit = useKeyboardFit();
  const trimmed = draft.trim();

  // The history, once, the first time the popup opens in this session.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current || mine) return;
    loaded.current = true;
    void loadMine(null);
  }, [mine, loadMine]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !trimmed) return;
    // The question moves into its bubble at once. On any failure it comes back
    // here, so "Ask" again resends the same id (the state machine's rule).
    onDraft('');
    const end = await send(trimmed);
    if (end.kind === 'unreachable' || end.kind === 'rejected' || end.kind === 'refused-access') {
      onDraft(end.question);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const label = (p: AskPhase) => (p.kind === 'still-answering' ? 'Still answering…' : busy ? 'Answering…' : 'Ask');

  return (
    <section
      role="dialog"
      aria-label={INTERNAL_ASSISTANT_LABEL.en}
      className={POPUP_FRAME}
      style={fit ? { top: fit.top, height: fit.height, bottom: 'auto' } : undefined}
    >
      <header className="flex items-start gap-3 border-b bg-card/30 px-4 py-3 shrink-0">
        <span className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Bot className="w-5 h-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold tracking-tight leading-tight">{INTERNAL_ASSISTANT_LABEL.en}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{ASSISTANT_SUBTITLE}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 -mr-2 -mt-1 shrink-0"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="w-4 h-4" />
        </Button>
      </header>

      <AskThread
        items={threadOf(mine?.asks ?? [], phase, sentAt)}
        cursor={mine?.cursor ?? null}
        loading={mineBusy}
        error={mineError}
        onOlder={() => loadMine(mine?.cursor ?? null)}
        tiles={tiles}
        openers={openers}
        feedbackFor={feedbackFor}
        timezone={timezone}
        emptyLine={emptyThreadLine(tiles)}
      />

      <form
        onSubmit={(e) => void submit(e)}
        className="shrink-0 flex flex-col gap-2 border-t bg-card/30 px-3 pt-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]"
      >
        <label htmlFor="assistant-question" className="sr-only">
          Your question
        </label>
        <textarea
          ref={textareaRef}
          id="assistant-question"
          value={draft}
          onChange={(e) => onDraft(e.target.value.slice(0, QUESTION_MAX))}
          onKeyDown={onKeyDown}
          maxLength={QUESTION_MAX}
          rows={2}
          disabled={busy}
          placeholder="Ask a question"
          className="w-full min-w-0 resize-none rounded-2xl border border-input bg-background px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-70"
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-foreground/45">
            {draft.length} / {QUESTION_MAX}
          </span>
          <Button type="submit" size="sm" disabled={busy || !trimmed} className="ml-auto gap-2">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {label(phase)}
          </Button>
        </div>
      </form>
    </section>
  );
}
