import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Mic, Square, X } from 'lucide-react';
import { COMPOSER_ICON } from '@/lib/composer';
import { inboxApi } from '@/api/inbox';
import { useRecorder } from '@/components/Recorder';
import {
  DICTATION_MAX_SECONDS,
  DICTATION_PRIVACY_LINE,
  DICTATION_TOOLTIP,
  DICTATION_TRANSCRIBING,
  clockOf,
  dictationErrorLine,
  type DictationPhase,
} from '@/lib/dictation';

/**
 * THE COMPOSER'S MICROPHONE (SCRUM-834; owner, 11 Nov 2026: "both a and then b").
 *
 * `useDictation` records a clip in the browser through the shared recorder
 * (`useRecorder`: `MediaRecorder`, Opus in WebM where the browser offers it,
 * from the press to the stop or to the ceiling, the microphone released
 * after every clip) and posts it to the api, which answers the words;
 * `onWords` places them in the composer. The clip lives in memory for that
 * one call; nothing is sent to the customer by any of this.
 *
 * `DictateButton` is the one control in the composer's row, in its three
 * states; `DictationLine` is the line under it — the red dot and the clock
 * with the privacy words while recording, "Transcribing…" after, or the
 * refusal in the composer's own words.
 *
 * The deployment has the last word on both (`offer`, from `GET /inbox/me`):
 * the clock's ceiling is its `TRANSCRIPTION_MAX_SECONDS`, and where no
 * transcription provider is on the microphone is not shown at all — every
 * clip would be refused. Either unsaid is read as the default: offered, at
 * the api's default ceiling.
 */

export interface Dictation {
  /** False where the browser cannot record, or the deployment has no provider on: the button is not shown. */
  supported: boolean;
  phase: DictationPhase;
  /** Whole seconds recorded so far. */
  seconds: number;
  /** The ceiling the clip stops at, in seconds: the deployment's, else the api's default. */
  maxSeconds: number;
  error: string | null;
  start: () => void;
  stop: () => void;
  dismissError: () => void;
}

/** What the deployment offers, as `GET /inbox/me` said it; a part unsaid is the default. */
export interface DictationOfferOptions {
  available?: boolean;
  maxSeconds?: number;
}

export function useDictation(conversationId: string, onWords: (words: string) => void, offer: DictationOfferOptions = {}): Dictation {
  const maxSeconds = offer.maxSeconds ?? DICTATION_MAX_SECONDS;
  const available = offer.available ?? true;
  const [transcribing, setTranscribing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const mounted = useRef(true);
  // The latest callback and conversation, read when the words land.
  const onWordsRef = useRef(onWords);
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    onWordsRef.current = onWords;
    conversationRef.current = conversationId;
  }, [onWords, conversationId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = useCallback(async (clip: Blob) => {
    setTranscribing(true);
    try {
      const { text } = await inboxApi.dictate(conversationRef.current, clip);
      if (!mounted.current) return;
      if (text.trim()) onWordsRef.current(text.trim());
    } catch (err) {
      if (mounted.current) setRefusal(dictationErrorLine(err));
    } finally {
      if (mounted.current) setTranscribing(false);
    }
  }, []);
  const onClip = useCallback((clip: Blob) => void send(clip), [send]);
  const recorder = useRecorder({ maxSeconds, onClip });

  // The wait for the recorder's last chunk and the wait for the words read the same from the composer.
  const phase: DictationPhase = transcribing || recorder.phase === 'stopping' ? 'transcribing' : recorder.phase;

  return {
    supported: available && recorder.supported,
    phase,
    seconds: recorder.seconds,
    maxSeconds,
    error: refusal ?? recorder.error,
    start: () => {
      setRefusal(null);
      recorder.start();
    },
    stop: recorder.stop,
    dismissError: () => {
      setRefusal(null);
      recorder.dismissError();
    },
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
        className={`${COMPOSER_ICON} text-danger-ink hover:text-danger-ink`}
      >
        <Square aria-hidden className="h-5 w-5" />
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
      className={COMPOSER_ICON}
    >
      {busy ? <Loader2 aria-hidden className="h-[22px] w-[22px] animate-spin" /> : <Mic aria-hidden className="h-[22px] w-[22px]" />}
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
        className="mt-1.5 flex items-center gap-2 px-2 text-[12px] text-ink-muted"
      >
        <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger-ink" />
        <span className="shrink-0 font-semibold tabular-nums text-danger-ink">
          Recording · {clockOf(dictation.seconds)} / {clockOf(dictation.maxSeconds)}
        </span>
        <span className="min-w-0 truncate">— {DICTATION_PRIVACY_LINE}</span>
      </p>
    );
  }
  if (dictation.phase === 'starting' || dictation.phase === 'transcribing') {
    return (
      <p role="status" data-testid="dictation-line" className="mt-1.5 flex items-center gap-2 px-2 text-[12px] text-ink-muted">
        <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" />
        {dictation.phase === 'starting' ? 'Opening the microphone…' : DICTATION_TRANSCRIBING}
      </p>
    );
  }
  if (dictation.error) {
    return (
      <p
        role="alert"
        data-testid="dictation-line"
        className="mt-1.5 flex items-center gap-2 rounded-2xl bg-danger px-3 py-1 text-[13px] text-danger-ink ring-1 ring-danger-line"
      >
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{dictation.error}</span>
        <button
          type="button"
          onClick={dictation.dismissError}
          aria-label="Dismiss"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full opacity-80 hover:opacity-100 md:h-7 md:w-7"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </p>
    );
  }
  return null;
}
