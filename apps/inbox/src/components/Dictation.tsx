import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Mic, Square, X } from 'lucide-react';
import { inboxApi } from '@/api/inbox';
import {
  DICTATION_MAX_SECONDS,
  DICTATION_PRIVACY_LINE,
  DICTATION_TOOLTIP,
  DICTATION_TRANSCRIBING,
  clockOf,
  dictationErrorLine,
  dictationSupported,
  microphoneErrorLine,
  reachedCeiling,
  recorderMimeType,
  type DictationPhase,
} from '@/lib/dictation';

/**
 * THE COMPOSER'S MICROPHONE (SCRUM-834; owner, 11 Nov 2026: "both a and then b").
 *
 * `useDictation` records a clip in the browser (`MediaRecorder`, Opus in WebM
 * where the browser offers it) from the press to the stop — or to the
 * ceiling — and posts it to the api, which answers the words; `onWords`
 * places them in the composer. The clip lives in memory for that one call;
 * nothing is sent to the customer by any of this. The microphone is asked for
 * through the browser's own door, which remembers the answer per site, and
 * its tracks are released after every clip so the tab's recording light goes
 * out between dictations.
 *
 * `DictateButton` is the one control in the composer's row, in its three
 * states; `DictationLine` is the line under it — the red dot and the clock
 * with the privacy words while recording, "Transcribing…" after, or the
 * refusal in the composer's own words.
 */

export interface Dictation {
  /** False where the browser cannot record: the button is not shown. */
  supported: boolean;
  phase: DictationPhase;
  /** Whole seconds recorded so far. */
  seconds: number;
  error: string | null;
  start: () => void;
  stop: () => void;
  dismissError: () => void;
}

/** How often the clock ticks while recording. */
const TICK_MS = 250;

export function useDictation(conversationId: string, onWords: (words: string) => void): Dictation {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  // The latest callback and conversation, read when the words land.
  const onWordsRef = useRef(onWords);
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    onWordsRef.current = onWords;
    conversationRef.current = conversationId;
  }, [onWords, conversationId]);

  const release = useCallback(() => {
    if (ticker.current !== null) {
      clearInterval(ticker.current);
      ticker.current = null;
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const r = recorder.current;
      recorder.current = null;
      if (r && r.state !== 'inactive') {
        try {
          r.stop();
        } catch {
          // A recorder already gone has nothing to stop.
        }
      }
      release();
    };
  }, [release]);

  const send = useCallback(async (clip: Blob) => {
    try {
      const { text } = await inboxApi.dictate(conversationRef.current, clip);
      if (!mounted.current) return;
      if (text.trim()) onWordsRef.current(text.trim());
    } catch (err) {
      if (mounted.current) setError(dictationErrorLine(err));
    } finally {
      if (mounted.current) setPhase('idle');
    }
  }, []);

  const stop = useCallback(() => {
    const r = recorder.current;
    if (!r || r.state === 'inactive') return;
    recorder.current = null;
    if (ticker.current !== null) {
      clearInterval(ticker.current);
      ticker.current = null;
    }
    setPhase('transcribing');
    try {
      r.stop();
    } catch {
      release();
      setError('The recording could not be stopped.');
      setPhase('idle');
    }
  }, [release]);

  const start = useCallback(async () => {
    if (recorder.current) return;
    setError(null);
    setPhase('starting');
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (!mounted.current) return;
      setError(microphoneErrorLine(err));
      setPhase('idle');
      return;
    }
    if (!mounted.current) {
      mic.getTracks().forEach((track) => track.stop());
      return;
    }
    stream.current = mic;
    const mimeType = recorderMimeType(MediaRecorder.isTypeSupported);
    let r: MediaRecorder;
    try {
      r = mimeType ? new MediaRecorder(mic, { mimeType }) : new MediaRecorder(mic);
    } catch {
      release();
      setError('The recording could not be started.');
      setPhase('idle');
      return;
    }
    chunks.current = [];
    r.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) chunks.current.push(event.data);
    };
    r.onerror = () => {
      recorder.current = null;
      release();
      if (!mounted.current) return;
      setError('The recording stopped unexpectedly.');
      setPhase('idle');
    };
    r.onstop = () => {
      const type = r.mimeType || mimeType || 'audio/webm';
      const clip = new Blob(chunks.current, { type });
      chunks.current = [];
      release();
      if (!mounted.current) return;
      void send(clip);
    };
    recorder.current = r;
    const startedAt = Date.now();
    r.start(1000);
    setSeconds(0);
    setPhase('recording');
    ticker.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(elapsed);
      if (reachedCeiling(elapsed)) stop();
    }, TICK_MS);
  }, [release, send, stop]);

  return {
    supported: dictationSupported(),
    phase,
    seconds,
    error,
    start: () => void start(),
    stop,
    dismissError: () => setError(null),
  };
}

/** The microphone in the composer's row: press to record, press again to stop, a spinner while transcribing. */
export function DictateButton({ dictation, disabled }: { dictation: Dictation; disabled: boolean }) {
  if (!dictation.supported) return null;
  if (dictation.phase === 'recording') {
    return (
      <button
        type="button"
        onClick={dictation.stop}
        aria-label="Stop dictating"
        title="Stop dictating"
        data-testid="dictation-stop"
        className="text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
      >
        <Square className="h-4 w-4" />
      </button>
    );
  }
  const busy = dictation.phase !== 'idle';
  return (
    <button
      type="button"
      onClick={dictation.start}
      disabled={disabled || busy}
      aria-label={busy ? DICTATION_TRANSCRIBING : 'Dictate a reply'}
      title={DICTATION_TOOLTIP}
      data-testid="dictation-start"
      className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
    </button>
  );
}

/** The line under the composer: the red dot and the clock while recording, the wait, or the refusal. */
export function DictationLine({ dictation }: { dictation: Dictation }) {
  if (dictation.phase === 'recording') {
    return (
      <p
        role="status"
        data-testid="dictation-line"
        className="mt-1.5 flex items-center gap-2 px-1 text-[11.5px] text-slate-500 dark:text-slate-400"
      >
        <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-500" />
        <span className="shrink-0 font-medium tabular-nums text-rose-600 dark:text-rose-400">
          Recording · {clockOf(dictation.seconds)} / {clockOf(DICTATION_MAX_SECONDS)}
        </span>
        <span className="min-w-0 truncate">— {DICTATION_PRIVACY_LINE}</span>
      </p>
    );
  }
  if (dictation.phase === 'starting' || dictation.phase === 'transcribing') {
    return (
      <p role="status" data-testid="dictation-line" className="mt-1.5 flex items-center gap-2 px-1 text-[11.5px] text-slate-500 dark:text-slate-400">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        {dictation.phase === 'starting' ? 'Opening the microphone…' : DICTATION_TRANSCRIBING}
      </p>
    );
  }
  if (dictation.error) {
    return (
      <p
        role="alert"
        data-testid="dictation-line"
        className="mt-1.5 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-1.5 text-[12px] text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30"
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{dictation.error}</span>
        <button type="button" onClick={dictation.dismissError} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </p>
    );
  }
  return null;
}
