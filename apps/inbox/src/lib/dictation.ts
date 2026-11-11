// DICTATING A REPLY (SCRUM-834), the pure side: what the composer's
// microphone button decides without a DOM, so a test can hold it to the rules
// without a recorder. The recorder itself, the hook and the button are in
// `components/Dictation.tsx`.
//
// A person presses the microphone, speaks the reply, presses stop (or the
// clip reaches the ceiling); the words come back from the api's
// `POST /inbox/conversations/{id}/dictation` (the same provider and limits as
// a customer's voice note, SCRUM-824) and land in the composer at the caret
// — to be read, corrected and sent by the person. NOTHING is sent by the
// dictation itself.
import type { ApiError } from '@/api/client';

/**
 * The ceiling the recorder stops at: `TRANSCRIPTION_MAX_SECONDS`' default on
 * the api. A deployment with a lower ceiling refuses a longer clip with
 * DICTATION_TOO_LONG, whose details carry its own value, and the composer
 * says so.
 */
export const DICTATION_MAX_SECONDS = 180;

/** Under the button while it records: where the audio goes, and what is not sent. */
export const DICTATION_PRIVACY_LINE =
  'The recording goes to the transcription provider and is not kept. Nothing reaches the customer until you press Send.';

/** The button's tooltip, with the same promise. */
export const DICTATION_TOOLTIP = `Dictate a reply — ${DICTATION_PRIVACY_LINE}`;

/** What the composer says while the words are on their way. */
export const DICTATION_TRANSCRIBING = 'Transcribing…';

/**
 * The recording formats the api takes, best first: Opus in WebM (Chrome,
 * Edge, Firefox), then whatever the browser offers of the others (Safari
 * records MP4). The first the browser says it supports is used; none, and the
 * recorder's own default is sent under the type it reports.
 */
export const DICTATION_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'] as const;

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing';

interface RecorderWindow {
  MediaRecorder?: unknown;
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
}

/** The button is shown only where the browser can record: a `MediaRecorder` and a microphone door. */
export function dictationSupported(w: RecorderWindow = globalThis as RecorderWindow): boolean {
  return typeof w.MediaRecorder === 'function' && typeof w.navigator?.mediaDevices?.getUserMedia === 'function';
}

/** The first format the browser says it records, or null to take the recorder's default. */
export function recorderMimeType(isTypeSupported: ((type: string) => boolean) | undefined): string | null {
  if (typeof isTypeSupported !== 'function') return null;
  for (const type of DICTATION_MIME_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // A browser that throws on the question offers nothing by it.
    }
  }
  return null;
}

/** `0:07`, `2:45`: the timer beside the red dot. */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The clip stops itself at the ceiling. */
export function reachedCeiling(seconds: number, maxSeconds = DICTATION_MAX_SECONDS): boolean {
  return seconds >= maxSeconds;
}

/**
 * The words placed into the composer at the caret: a selection is replaced,
 * a space is added on either side where the words would otherwise touch
 * what is there, and the caret ends after them. No caret (nothing focused
 * yet) appends at the end.
 */
export function insertAtCaret(
  text: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  words: string,
): { text: string; caret: number } {
  const spoken = words.trim();
  if (!spoken) return { text, caret: selectionEnd ?? text.length };
  const from = Math.max(0, Math.min(text.length, selectionStart ?? text.length));
  const to = Math.max(from, Math.min(text.length, selectionEnd ?? from));
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const tail = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  const placed = `${lead}${spoken}${tail}`;
  return { text: `${before}${placed}${after}`, caret: before.length + placed.length };
}

/** What the composer says when the microphone could not be opened. */
export function microphoneErrorLine(err: unknown): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name?: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'The microphone is blocked for this site. Allow it in the browser and try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is in use by another app.';
  }
  return 'The recording could not be started.';
}

/** The api's refusal, in the composer's own words; an unknown one as the api said it. */
export function dictationErrorLine(err: unknown): string {
  const api = err as Partial<ApiError> | null;
  switch (api?.code) {
    case 'DICTATION_NOT_AVAILABLE':
      return 'Dictation is not available on this deployment.';
    case 'DICTATION_TOO_LONG': {
      const max = (api.details as { maxSeconds?: unknown } | undefined)?.maxSeconds;
      const limit = typeof max === 'number' && max > 0 ? ` (at most ${clockOf(max)})` : '';
      return `The recording was too long${limit}. Speak the reply in parts.`;
    }
    case 'DICTATION_UNSUPPORTED_FORMAT':
      return 'This browser records in a format the transcription provider does not take.';
    case 'DICTATION_NOTHING_HEARD':
      return 'Nothing was heard. Try again, closer to the microphone.';
    case 'DICTATION_FAILED':
      return 'The transcription did not come back. Try again.';
    case 'FORBIDDEN':
      return 'You cannot reply in this conversation.';
    default:
      return typeof api?.message === 'string' && api.message ? api.message : 'The dictation could not be sent.';
  }
}
