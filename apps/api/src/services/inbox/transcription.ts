import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../../env';
import { INBOX_MEDIA_MAX_BYTES } from './media';

/**
 * THE TRANSCRIPTION BOUNDARY (SCRUM-824 part a; owner, 10 Nov 2026: "voice
 * notes transcribed first in Thai, Russian and English").
 *
 * One call, `transcribe(runtime, { bytes, contentType, languageHints })`,
 * answers the words of a customer's voice note with the language they were
 * heard in and the note's length — or a typed failure that says, in one word,
 * why not and whether asking again could help. `job:inbox.transcribe`
 * (`voice-notes.ts`) is its one caller.
 *
 * THE ADAPTERS:
 *   - `off` — the default, and always under `NODE_ENV=test`: there is no
 *     adapter, every note answers `NOT_CONFIGURED`, and the note is shown
 *     "Voice note — not transcribed".
 *   - `openai-compatible` — one HTTP adapter for OpenAI's
 *     `POST /v1/audio/transcriptions` request shape (a multipart form: `file`,
 *     `model`, `response_format`, and `language` when exactly one is hinted).
 *     OpenAI's `whisper-1` and `gpt-4o-transcribe` speak it, and so do the
 *     providers that copied it; `TRANSCRIPTION_API_URL` names the endpoint.
 *   - `fake` — the suites' (`FakeTranscriber`): answers what the test queued
 *     and keeps every request, so no recording ever leaves a test.
 *
 * THE LIMITS, checked before anything is sent: a format no such provider
 * takes (AMR, raw AAC) is `UNSUPPORTED_FORMAT`; more bytes than the inbox
 * stores or the provider accepts, or longer than `TRANSCRIPTION_MAX_SECONDS`
 * (read from the file's own header where it says, estimated from its size
 * where it does not), is `TOO_LONG` and is never sent.
 *
 * THE LANGUAGE is an ISO 639-1 code: the provider's own answer when it gives
 * one (`whisper-1` names it: "thai"), else read from the words' script (Thai,
 * Cyrillic, Latin). Nothing here logs the audio, the words or the key.
 */

/** The languages the park's customers write in, in the owner's order: what every note is hinted with. */
export const TRANSCRIPTION_LANGUAGE_HINTS = ['th', 'ru', 'en'] as const;

/** The most the OpenAI-shaped endpoint takes in one file (25 MB); the inbox stores up to `INBOX_MEDIA_MAX_BYTES`. */
export const TRANSCRIPTION_PROVIDER_MAX_BYTES = 25 * 1024 * 1024;

/** How long one provider call may take before it is abandoned (and retried by the job). */
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/** OpenAI's endpoint, when `TRANSCRIPTION_API_URL` is empty. */
export const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

export interface TranscribeRequest {
  bytes: Uint8Array;
  contentType: string;
  /** ISO 639-1 codes. One is sent as the provider's `language`; several leave it to detect. */
  languageHints: readonly string[];
}

export type TranscriptionFailureReason =
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED_FORMAT'
  | 'TOO_LONG'
  | 'EMPTY'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REFUSED'
  | 'PROVIDER_ERROR'
  | 'MALFORMED_RESPONSE';

/** What an adapter answers: the provider's words, or why not. */
export type AdapterOutcome =
  | { ok: true; text: string; language: string | null; durationSeconds: number | null }
  | { ok: false; reason: TranscriptionFailureReason; retryable: boolean; status: number | null };

export interface TranscriptionAdapter {
  readonly provider: 'openai-compatible' | 'fake';
  readonly model: string;
  transcribe(req: TranscribeRequest): Promise<AdapterOutcome>;
}

export type TranscriptionOutcome =
  | { ok: true; text: string; language: string | null; durationSeconds: number | null; model: string; latencyMs: number }
  | {
      ok: false;
      reason: TranscriptionFailureReason;
      retryable: boolean;
      status: number | null;
      model: string | null;
      latencyMs: number;
      /** The note's length as read or estimated here, when the limits got that far. */
      durationSeconds: number | null;
    };

export interface TranscriptionRuntime {
  /** `off` when no adapter is configured (or under tests, until a suite injects one). */
  provider: 'off' | 'openai-compatible' | 'fake';
  /** Replaced in tests by a `FakeTranscriber`; null when off. */
  adapter: TranscriptionAdapter | null;
  maxSeconds: number;
  maxBytes: number;
}

// --- Formats and lengths ---------------------------------------------------------------------

/** The content types the OpenAI-shaped endpoint takes, by the extension it reads the format from. */
const FORMATS: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'application/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/**
 * The audio content types the OpenAI-shaped endpoint takes: what a route that
 * receives a browser's recording accepts (SCRUM-834). The provider takes a
 * video container too (`video/mp4`, `video/webm`), but a dictation is a
 * microphone's recording and nothing else, so those stay outside the door.
 */
export const TRANSCRIBABLE_AUDIO_CONTENT_TYPES: readonly string[] = Object.keys(FORMATS).filter((type) => type.startsWith('audio/'));

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export function baseContentType(contentType: string): string {
  return contentType.split(';', 1)[0]!.trim().toLowerCase();
}

/** The file extension a provider reads the format from, or null for a format none of them takes (AMR, raw AAC). */
export function transcribableExtension(contentType: string): string | null {
  return FORMATS[baseContentType(contentType)] ?? null;
}

/** The bytes a second of an unknown format is taken to hold: 64 kbit/s, a voice recording's rate. */
const FALLBACK_BYTES_PER_SECOND = 8_000;

function findAscii(b: Uint8Array, word: string, from = 0): number {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).indexOf(word, from, 'latin1');
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** An Ogg stream (WhatsApp's and Telegram's voice notes): the last page's granule over the codec's rate. */
function oggSeconds(b: Uint8Array): number | null {
  if (findAscii(b, 'OggS') !== 0) return null;
  const dv = view(b);
  let rate = 0;
  let preSkip = 0;
  const opus = findAscii(b, 'OpusHead');
  if (opus >= 0 && opus + 12 <= b.length) {
    rate = 48_000; // Opus granules always count 48 kHz samples.
    preSkip = dv.getUint16(opus + 10, true);
  } else {
    const vorbis = findAscii(b, 'vorbis');
    if (vorbis < 1 || b[vorbis - 1] !== 1 || vorbis + 15 > b.length) return null;
    rate = dv.getUint32(vorbis + 11, true);
  }
  if (rate <= 0) return null;
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  // The last page that finished a packet (a granule of -1 finished none).
  let at = buf.lastIndexOf('OggS', b.length - 4, 'latin1');
  while (at >= 0) {
    if (at + 14 <= b.length) {
      const granule = dv.getBigInt64(at + 6, true);
      if (granule >= 0n) return Math.max(0, Number(granule) - preSkip) / rate;
    }
    if (at === 0) break;
    at = buf.lastIndexOf('OggS', at - 1, 'latin1');
  }
  return null;
}

/** An MP4 / M4A (LINE's and iPhone's): the movie header's duration over its timescale. */
function mp4Seconds(b: Uint8Array): number | null {
  const at = findAscii(b, 'mvhd');
  if (at < 4 || at + 32 > b.length) return null;
  const dv = view(b);
  const version = b[at + 4];
  const timescale = version === 1 ? dv.getUint32(at + 24) : dv.getUint32(at + 16);
  const duration = version === 1 ? Number(dv.getBigUint64(at + 28)) : dv.getUint32(at + 20);
  return timescale > 0 ? duration / timescale : null;
}

/** A WAV: the data chunk's size over the format's byte rate. */
function wavSeconds(b: Uint8Array): number | null {
  if (findAscii(b, 'RIFF') !== 0 || findAscii(b, 'WAVE') !== 8) return null;
  const dv = view(b);
  let byteRate = 0;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = Buffer.from(b.buffer, b.byteOffset + at, 4).toString('latin1');
    const size = dv.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 20 <= b.length) byteRate = dv.getUint32(at + 16, true);
    if (id === 'data') return byteRate > 0 ? size / byteRate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

const MP3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** An MP3: its size over the first frame's bit rate (exact for a constant rate, near enough otherwise). */
function mp3Seconds(b: Uint8Array): number | null {
  let at = 0;
  if (findAscii(b, 'ID3') === 0 && b.length >= 10) {
    at = 10 + ((b[6]! & 0x7f) << 21) + ((b[7]! & 0x7f) << 14) + ((b[8]! & 0x7f) << 7) + (b[9]! & 0x7f);
  }
  for (; at + 4 <= b.length; at += 1) {
    if (b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) continue;
    const version = (b[at + 1]! >> 3) & 3;
    const layer = (b[at + 1]! >> 1) & 3;
    const index = b[at + 2]! >> 4;
    if (version === 1 || layer !== 1 || index === 0 || index === 15) continue;
    const kbps = (version === 3 ? MP3_KBPS_V1 : MP3_KBPS_V2)[index]!;
    return ((b.length - at) * 8) / (kbps * 1000);
  }
  return null;
}

/** An EBML variable-length number at `at`: its value (null for the "unknown size" form) and its width. */
function ebmlVint(b: Uint8Array, at: number): { value: number | null; width: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const width = Math.clz32(first) - 23;
  if (at + width > b.length) return null;
  let value = first & (0xff >> width);
  let unknown = value === 0xff >> width;
  for (let i = 1; i < width; i++) {
    const byte = b[at + i] ?? 0;
    unknown = unknown && byte === 0xff;
    value = value * 256 + byte;
  }
  return { value: unknown ? null : value, width };
}

/**
 * A WebM a browser recorded (SCRUM-834's dictation, the simulator's Record):
 * `MediaRecorder` writes no length in the header, so the length is the last
 * cluster's timecode plus its last block's own offset, in the default
 * millisecond scale. Null where no cluster is found.
 */
function webmSeconds(b: Uint8Array): number | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const cluster = buf.lastIndexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
  if (cluster < 0) return null;
  const size = ebmlVint(b, cluster + 4);
  if (!size) return null;
  let at = cluster + 4 + size.width;
  const end = size.value === null ? b.length : Math.min(b.length, at + size.value);
  let timecode: number | null = null;
  let last = 0;
  while (at < end) {
    const idWidth = Math.clz32(b[at] ?? 0) - 23;
    if (idWidth < 1 || idWidth > 4) break;
    const id = b[at];
    const len = ebmlVint(b, at + idWidth);
    if (!len || len.value === null) break;
    const data = at + idWidth + len.width;
    if (idWidth === 1 && id === 0xe7) {
      let v = 0;
      for (let i = 0; i < len.value && data + i < b.length; i++) v = v * 256 + (b[data + i] ?? 0);
      timecode = v;
    } else if (idWidth === 1 && id === 0xa3 && data + 3 <= b.length) {
      // A SimpleBlock: the track number (one byte for a recording's one track), then its offset as an int16.
      last = Math.max(last, view(b).getInt16(data + 1, false));
    }
    at = data + len.value;
  }
  return timecode === null ? null : (timecode + last) / 1000;
}

/**
 * How long a recording is, in seconds: read from its own header (Ogg, MP4,
 * WAV, MP3, a browser's WebM), else estimated from its size at a voice recording's rate.
 */
export function audioSeconds(bytes: Uint8Array, contentType: string): number {
  const ext = transcribableExtension(contentType);
  let read: number | null = null;
  try {
    read =
      ext === 'ogg'
        ? oggSeconds(bytes)
        : ext === 'm4a' || ext === 'mp4'
          ? mp4Seconds(bytes)
          : ext === 'wav'
            ? wavSeconds(bytes)
            : ext === 'mp3'
              ? mp3Seconds(bytes)
              : ext === 'webm'
                ? webmSeconds(bytes)
                : null;
  } catch {
    read = null; // A header that lies about its own length is estimated like any other file.
  }
  return read !== null && Number.isFinite(read) ? read : bytes.length / FALLBACK_BYTES_PER_SECOND;
}

// --- Languages -------------------------------------------------------------------------------

/** Whisper names the language it heard in English ("thai"); the inbox keeps codes. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  thai: 'th',
  russian: 'ru',
  english: 'en',
  ukrainian: 'uk',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  polish: 'pl',
  turkish: 'tr',
  hebrew: 'he',
  arabic: 'ar',
  hindi: 'hi',
  vietnamese: 'vi',
  indonesian: 'id',
  malay: 'ms',
  burmese: 'my',
  lao: 'lo',
  khmer: 'km',
  kazakh: 'kk',
  swedish: 'sv',
};

/** The language a text is written in, by its script: Thai, Cyrillic (read as Russian) or Latin (English). */
export function scriptLanguage(text: string): 'th' | 'ru' | 'en' | null {
  let thai = 0;
  let cyrillic = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x0e00 && c <= 0x0e7f) thai += 1;
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic += 1;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin += 1;
  }
  const most = Math.max(thai, cyrillic, latin);
  if (most === 0) return null;
  return most === thai ? 'th' : most === cyrillic ? 'ru' : 'en';
}

/** The provider's language as an ISO 639-1 code, else the words' script; null when neither says. */
export function transcriptLanguageOf(provider: string | null | undefined, text: string): string | null {
  const word = (provider ?? '').trim().toLowerCase();
  if (/^[a-z]{2}$/.test(word)) return word;
  const named = LANGUAGE_NAMES[word];
  if (named) return named;
  return scriptLanguage(text);
}

// --- The boundary ----------------------------------------------------------------------------

/** The runtime's limits and nothing else: what a note is checked against before it is sent. */
export function limitsOf(env: Pick<Env, 'TRANSCRIPTION_MAX_SECONDS'>): Pick<TranscriptionRuntime, 'maxSeconds' | 'maxBytes'> {
  return { maxSeconds: env.TRANSCRIPTION_MAX_SECONDS, maxBytes: Math.min(INBOX_MEDIA_MAX_BYTES, TRANSCRIPTION_PROVIDER_MAX_BYTES) };
}

/**
 * The note's words, or why not, as the header says. Never throws: an adapter
 * that throws is a `PROVIDER_ERROR` worth one more try.
 */
export async function transcribe(runtime: TranscriptionRuntime, req: TranscribeRequest): Promise<TranscriptionOutcome> {
  const started = Date.now();
  const model = runtime.adapter?.model ?? null;
  const fail = (
    reason: TranscriptionFailureReason,
    retryable: boolean,
    status: number | null = null,
    durationSeconds: number | null = null,
  ): TranscriptionOutcome => ({ ok: false, reason, retryable, status, model, latencyMs: Date.now() - started, durationSeconds });
  if (!runtime.adapter) return fail('NOT_CONFIGURED', false);
  if (!transcribableExtension(req.contentType)) return fail('UNSUPPORTED_FORMAT', false);
  if (req.bytes.length > runtime.maxBytes) return fail('TOO_LONG', false);
  const seconds = Math.round(audioSeconds(req.bytes, req.contentType) * 10) / 10;
  if (seconds > runtime.maxSeconds) return fail('TOO_LONG', false, null, seconds);
  let answer: AdapterOutcome;
  try {
    answer = await runtime.adapter.transcribe(req);
  } catch {
    answer = { ok: false, reason: 'PROVIDER_ERROR', retryable: true, status: null };
  }
  if (!answer.ok) return fail(answer.reason, answer.retryable, answer.status, seconds);
  const text = answer.text.replace(/\s+/g, ' ').trim();
  if (!text) return fail('EMPTY', false, null, seconds);
  return {
    ok: true,
    text,
    language: transcriptLanguageOf(answer.language, text),
    durationSeconds: answer.durationSeconds ?? seconds,
    model: runtime.adapter.model,
    latencyMs: Date.now() - started,
  };
}

// --- The OpenAI-shaped adapter ---------------------------------------------------------------

export interface OpenAiCompatibleOptions {
  /** The transcriptions endpoint, whole. */
  url: string;
  /** **Secret.** The bearer token; read only into the request header. */
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** The HTTP client; tests pass a fake that never leaves the process. */
  fetch?: typeof fetch;
}

/** `whisper-1` answers the language and the length in `verbose_json`; the gpt-4o models only in `json`. */
export function responseFormatOf(model: string): 'verbose_json' | 'json' {
  return /whisper/i.test(model) ? 'verbose_json' : 'json';
}

export class OpenAiCompatibleTranscriber implements TranscriptionAdapter {
  readonly provider = 'openai-compatible' as const;
  readonly model: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(opts: OpenAiCompatibleOptions) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS;
    this.fetcher = opts.fetch ?? fetch;
  }

  /** The request, as the endpoint takes it: a multipart form and the bearer token. */
  requestOf(req: TranscribeRequest): { url: string; init: RequestInit } {
    const contentType = baseContentType(req.contentType);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(req.bytes)], { type: contentType }), `voice-note.${transcribableExtension(contentType) ?? 'bin'}`);
    form.append('model', this.model);
    form.append('response_format', responseFormatOf(this.model));
    if (req.languageHints.length === 1) form.append('language', req.languageHints[0]!);
    return {
      url: this.url,
      init: { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' }, body: form },
    };
  }

  async transcribe(req: TranscribeRequest): Promise<AdapterOutcome> {
    const { url, init } = this.requestOf(req);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetcher(url, { ...init, signal: controller.signal });
    } catch {
      clearTimeout(timer);
      return controller.signal.aborted
        ? { ok: false, reason: 'PROVIDER_TIMEOUT', retryable: true, status: null }
        : { ok: false, reason: 'PROVIDER_ERROR', retryable: true, status: null };
    }
    try {
      if (res.status === 429) return { ok: false, reason: 'PROVIDER_RATE_LIMIT', retryable: true, status: 429 };
      if (res.status === 408 || res.status >= 500) {
        return { ok: false, reason: 'PROVIDER_UNAVAILABLE', retryable: true, status: res.status };
      }
      // A refused key, a refused file, a model that does not exist: asking again changes nothing.
      if (!res.ok) return { ok: false, reason: 'PROVIDER_REFUSED', retryable: false, status: res.status };
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { ok: false, reason: controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'MALFORMED_RESPONSE', retryable: true, status: res.status };
      }
      const b = (body ?? {}) as { text?: unknown; language?: unknown; duration?: unknown };
      if (typeof b.text !== 'string') return { ok: false, reason: 'MALFORMED_RESPONSE', retryable: false, status: res.status };
      return {
        ok: true,
        text: b.text,
        language: typeof b.language === 'string' ? b.language : null,
        durationSeconds: typeof b.duration === 'number' && Number.isFinite(b.duration) ? b.duration : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- The suites' adapter ---------------------------------------------------------------------

/**
 * The suites' transcriber: answers what the test queued, in order, then its
 * `fallback`; keeps every request it was given. Never a network call.
 */
export class FakeTranscriber implements TranscriptionAdapter {
  readonly provider = 'fake' as const;
  readonly model = 'fake-transcriber';
  readonly requests: TranscribeRequest[] = [];
  private readonly queue: Array<AdapterOutcome | ((req: TranscribeRequest) => AdapterOutcome)> = [];

  constructor(private fallback: AdapterOutcome = { ok: false, reason: 'PROVIDER_ERROR', retryable: true, status: null }) {}

  /** Queue the next answers. */
  next(...outcomes: Array<AdapterOutcome | ((req: TranscribeRequest) => AdapterOutcome)>): this {
    this.queue.push(...outcomes);
    return this;
  }

  /** What every request not queued for answers. */
  always(outcome: AdapterOutcome): this {
    this.fallback = outcome;
    return this;
  }

  transcribe(req: TranscribeRequest): Promise<AdapterOutcome> {
    this.requests.push(req);
    const queued = this.queue.shift() ?? this.fallback;
    return Promise.resolve(typeof queued === 'function' ? queued(req) : queued);
  }
}

// --- The runtime -----------------------------------------------------------------------------

/**
 * The runtime the job reads, from the env, once per process. ALWAYS `off`
 * under `NODE_ENV=test`: a suite injects a `FakeTranscriber`, and one that
 * forgets gets "not transcribed", never a real call. The key is read only
 * into the adapter; the boot line names the provider and the model.
 */
export function buildTranscriptionRuntime(env: Env, log?: FastifyBaseLogger): TranscriptionRuntime {
  const limits = limitsOf(env);
  if (env.TRANSCRIPTION_PROVIDER === 'off' || env.NODE_ENV === 'test' || !env.TRANSCRIPTION_API_KEY.trim()) {
    return { provider: 'off', adapter: null, ...limits };
  }
  const adapter = new OpenAiCompatibleTranscriber({
    url: env.TRANSCRIPTION_API_URL || OPENAI_TRANSCRIPTIONS_URL,
    apiKey: env.TRANSCRIPTION_API_KEY,
    model: env.TRANSCRIPTION_MODEL,
  });
  log?.info(
    { provider: adapter.provider, model: adapter.model, maxSeconds: limits.maxSeconds },
    'inbox voice-note transcription enabled',
  );
  return { provider: adapter.provider, adapter, ...limits };
}
