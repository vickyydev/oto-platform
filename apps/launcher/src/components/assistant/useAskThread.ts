import { useCallback, useState } from 'react';
import { newId } from '@oto/shared/ids';
import { assistantApi, type AskView } from '@/api/assistant';
import { giveFeedback, idForSend, mergeAsks, runAsk, type AskPhase } from '@/assistant/ask';

/** The calls the popup makes; the api module by default, a fake in a test. */
export interface ThreadApi {
  ask: typeof assistantApi.ask;
  one: typeof assistantApi.one;
  mine: typeof assistantApi.mine;
  feedback: typeof assistantApi.feedback;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The conversation's state (SCRUM-591): the ask in flight, driven by the
 * state machine in `assistant/ask.ts`, and the person's own asks as the api
 * pages them. Held by the dock, which stays mounted across the launcher's
 * pages, so an answer that arrives while the popup is closed is there when
 * it opens again.
 */
export function useAskThread(client: ThreadApi = assistantApi) {
  const [phase, setPhase] = useState<AskPhase>({ kind: 'idle' });
  /** When the question in flight was sent: the pending bubble's time. */
  const [sentAt, setSentAt] = useState('');
  const [mine, setMine] = useState<{ asks: AskView[]; cursor: string | null } | null>(null);
  const [mineBusy, setMineBusy] = useState(false);
  const [mineError, setMineError] = useState<string | null>(null);

  const busy = phase.kind === 'sending' || phase.kind === 'still-answering';

  /** One ask changed (an answer arrived, or feedback was given): the phase and the list agree. */
  const put = useCallback((ask: AskView) => {
    setPhase((p) => (p.kind === 'done' && p.ask.id === ask.id ? { ...p, ask } : p));
    setMine((m) => (m ? { ...m, asks: mergeAsks(m.asks, [ask]) } : m));
  }, []);

  /**
   * Send one question and see it to its end. The id is the caller's: a
   * failed send keeps it with the question, so asking the same words again
   * resends the SAME id (`idForSend`).
   */
  const send = useCallback(
    async (raw: string): Promise<AskPhase> => {
      const question = raw.trim();
      if (busy || !question) return phase;
      const id = idForSend(phase, question, newId);
      setSentAt(new Date().toISOString());
      const end = await runAsk(id, question, {
        ask: client.ask,
        one: client.one,
        sleep,
        now: () => Date.now(),
        onPhase: setPhase,
      });
      if (end.kind === 'done') put(end.ask);
      return end;
    },
    [busy, phase, client, put],
  );

  const feedbackFor = useCallback(
    (ask: AskView) => async (feedback: 'good' | 'wrong', correction: string) => {
      const next = await giveFeedback(ask, feedback, correction, {
        send: client.feedback,
        mint: () => crypto.randomUUID(),
      });
      put(next);
    },
    [client, put],
  );

  const loadMine = useCallback(
    async (cursor: string | null) => {
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
    },
    [client],
  );

  return { phase, sentAt, mine, mineBusy, mineError, busy, send, feedbackFor, loadMine };
}

export type AskThreadState = ReturnType<typeof useAskThread>;
