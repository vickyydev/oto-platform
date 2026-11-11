import { useCallback, useEffect, useRef, useState } from 'react';
import { dictationSupported, microphoneErrorLine, reachedCeiling, recorderMimeType } from '@/lib/dictation';

/**
 * THE BROWSER'S RECORDER, shared (SCRUM-834, SCRUM-835).
 *
 * `useRecorder` records one clip in the browser (`MediaRecorder`, Opus in
 * WebM where the browser offers it) from the press to the stop — or to the
 * ceiling — and hands it over through `onClip`: the composer's dictation
 * posts it to the api for its words, the simulator plays it as a customer's
 * voice note. The microphone is asked for through the browser's own door,
 * which remembers the answer per site, and its tracks are released after
 * every clip so the tab's recording light goes out between clips. The clip
 * lives in memory for that one hand-over; nothing here sends anything.
 */

/** `stopping` is the moment between the stop and the recorder's last chunk, before the clip is handed over. */
export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'stopping';

export interface Recorder {
  /** False where the browser cannot record (no `MediaRecorder`, or no microphone door): offer nothing. */
  supported: boolean;
  phase: RecorderPhase;
  /** Whole seconds recorded so far. */
  seconds: number;
  /** Why the microphone or the recorder refused, in the person's words; cleared by the next press. */
  error: string | null;
  start: () => void;
  stop: () => void;
  dismissError: () => void;
}

export interface RecorderOptions {
  /** The ceiling the clip stops itself at, in seconds. */
  maxSeconds: number;
  /** The finished clip: its bytes under the recorder's type, and its length in whole seconds. */
  onClip: (clip: Blob, mimeType: string, seconds: number) => void;
}

/** How often the clock ticks while recording. */
const TICK_MS = 250;

export function useRecorder({ maxSeconds, onClip }: RecorderOptions): Recorder {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  // The latest hand-over and ceiling, read when the clip lands and as the clock ticks.
  const onClipRef = useRef(onClip);
  const ceilingRef = useRef(maxSeconds);
  useEffect(() => {
    onClipRef.current = onClip;
    ceilingRef.current = maxSeconds;
  }, [onClip, maxSeconds]);

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

  const stop = useCallback(() => {
    const r = recorder.current;
    if (!r || r.state === 'inactive') return;
    recorder.current = null;
    if (ticker.current !== null) {
      clearInterval(ticker.current);
      ticker.current = null;
    }
    setPhase('stopping');
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
    const startedAt = Date.now();
    r.onstop = () => {
      const type = r.mimeType || mimeType || 'audio/webm';
      const clip = new Blob(chunks.current, { type });
      chunks.current = [];
      const length = Math.round((Date.now() - startedAt) / 1000);
      release();
      if (!mounted.current) return;
      setPhase('idle');
      onClipRef.current(clip, type, length);
    };
    recorder.current = r;
    r.start(1000);
    setSeconds(0);
    setPhase('recording');
    ticker.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(elapsed);
      if (reachedCeiling(elapsed, ceilingRef.current)) stop();
    }, TICK_MS);
  }, [release, stop]);

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
