import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { INBOX_MEDIA_MAX_BYTES } from '../src/services/inbox/media';
import {
  FakeTranscriber,
  OPENAI_TRANSCRIPTIONS_URL,
  OpenAiCompatibleTranscriber,
  TRANSCRIPTION_LANGUAGE_HINTS,
  TRANSCRIPTION_PROVIDER_MAX_BYTES,
  audioSeconds,
  buildTranscriptionRuntime,
  scriptLanguage,
  transcribableExtension,
  transcribe,
  transcriptLanguageOf,
  type TranscriptionRuntime,
} from '../src/services/inbox/transcription';
import { VOICE_NOTE_MARK, VOICE_WAIT_MAX_MS, messageText, voiceHold } from '../src/services/inbox/voice-notes';

/**
 * SCRUM-824 part (a) — the transcription boundary, in units: the
 * OpenAI-shaped adapter's request (against a fake HTTP client: nothing leaves
 * the process and no key is real), its answers and refusals, the limits
 * checked before anything is sent, the language a transcript is labelled
 * with, the one reading of a message's words, and the assistant's wait.
 *
 * FICTIONAL TEST DATA: every recording here is synthetic bytes built below —
 * a header that states a length and filler — never a real person's voice, and
 * every transcript is made-up "ZZ TEST" words.
 */

// --- Synthetic recordings ------------------------------------------------------------------

/** One Ogg page: the capture pattern, its granule, and the payload (lacing simplified: the parser reads headers only). */
function oggPage(granule: bigint, payload: Buffer, seq: number, headerType = 0): Buffer {
  const segments = Math.max(1, Math.ceil(payload.length / 255));
  const header = Buffer.alloc(27 + segments);
  header.write('OggS', 0, 'latin1');
  header[5] = headerType;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(0x0824, 14);
  header.writeUInt32LE(seq, 18);
  header[26] = segments;
  for (let i = 0; i < segments; i += 1) header[27 + i] = i === segments - 1 ? payload.length - i * 255 : 255;
  return Buffer.concat([header, payload]);
}

/** An Ogg Opus "voice note" `seconds` long, as WhatsApp and Telegram send one. */
function opusNote(seconds: number): Uint8Array {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10); // pre-skip
  head.writeUInt32LE(48_000, 12);
  const tags = Buffer.from('OpusTags\u0000\u0000\u0000\u0000', 'latin1');
  return new Uint8Array(
    Buffer.concat([
      oggPage(0n, head, 0, 2),
      oggPage(0n, tags, 1),
      oggPage(BigInt(Math.round(seconds * 48_000) + 312), Buffer.alloc(300, 0x5a), 2),
      // A last page that finished no packet (granule -1) is passed over.
      oggPage(-1n, Buffer.alloc(40, 0x5a), 3, 4),
    ]),
  );
}

/** An M4A whose movie header says `seconds` (version 0 mvhd, timescale 1000). */
function m4aNote(seconds: number): Uint8Array {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftypM4A ', 4, 'latin1');
  const mvhd = Buffer.alloc(32);
  mvhd.writeUInt32BE(32, 0);
  mvhd.write('mvhd', 4, 'latin1');
  mvhd.writeUInt32BE(1000, 20); // timescale
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 24); // duration
  const moov = Buffer.alloc(8);
  moov.writeUInt32BE(40, 0);
  moov.write('moov', 4, 'latin1');
  return new Uint8Array(Buffer.concat([ftyp, moov, mvhd, Buffer.alloc(64)]));
}

/** A PCM WAV `seconds` long at 16 kHz mono 16-bit (32 000 bytes a second), its data chunk unfilled past the header. */
function wavNote(seconds: number): Uint8Array {
  const dataSize = seconds * 32_000;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + dataSize, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16_000, 24);
  h.writeUInt32LE(32_000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(dataSize, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.alloc(64)]));
}

/** An MP3 frame header at 64 kbit/s (MPEG-1 Layer III), then `bytes` of frames. */
function mp3Note(bytes: number): Uint8Array {
  const b = Buffer.alloc(bytes, 0);
  b[0] = 0xff;
  b[1] = 0xfb;
  b[2] = 0x50; // bitrate index 5 = 64 kbit/s
  return new Uint8Array(b);
}

function runtimeWith(adapter: FakeTranscriber | null, over: Partial<TranscriptionRuntime> = {}): TranscriptionRuntime {
  return { provider: adapter ? 'fake' : 'off', adapter, maxSeconds: 180, maxBytes: TRANSCRIPTION_PROVIDER_MAX_BYTES, ...over };
}

// --- A fake HTTP client ------------------------------------------------------------------------

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: Response | (() => Promise<Response>) | Error): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer;
  }) as typeof fetch;
  return { fetch: f, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const KEY = 'test-transcription-key-not-real';

describe('the OpenAI-shaped adapter: the request it sends', () => {
  it('posts a multipart form to the endpoint with the bearer key: the file, the model, verbose_json for whisper, no language for three hints', async () => {
    const http = fakeFetch(json({ text: 'ZZ TEST สวัสดีค่ะ', language: 'thai', duration: 4.2 }));
    const adapter = new OpenAiCompatibleTranscriber({ url: OPENAI_TRANSCRIPTIONS_URL, apiKey: KEY, model: 'whisper-1', fetch: http.fetch });
    const bytes = opusNote(4);
    const out = await adapter.transcribe({ bytes, contentType: 'audio/ogg; codecs=opus', languageHints: TRANSCRIPTION_LANGUAGE_HINTS });
    expect(out).toEqual({ ok: true, text: 'ZZ TEST สวัสดีค่ะ', language: 'thai', durationSeconds: 4.2 });

    expect(http.seen).toHaveLength(1);
    const { url, init } = http.seen[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${KEY}`, accept: 'application/json' });
    // No content-type of our own: the form sets its multipart boundary.
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain('content-type');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get('file') as File;
    expect(file.name).toBe('voice-note.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBeNull();
    expect([...form.keys()].sort()).toEqual(['file', 'model', 'response_format']);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks gpt-4o-transcribe for plain json, names an m4a by its extension, and sends `language` when exactly one is hinted', async () => {
    const http = fakeFetch(json({ text: 'ZZ TEST привет' }));
    const adapter = new OpenAiCompatibleTranscriber({ url: 'https://speech.example.test/v1/audio/transcriptions', apiKey: KEY, model: 'gpt-4o-transcribe', fetch: http.fetch });
    const out = await adapter.transcribe({ bytes: m4aNote(3), contentType: 'audio/mp4', languageHints: ['ru'] });
    expect(out).toEqual({ ok: true, text: 'ZZ TEST привет', language: null, durationSeconds: null });
    const form = http.seen[0]!.init.body as FormData;
    expect(http.seen[0]!.url).toBe('https://speech.example.test/v1/audio/transcriptions');
    expect((form.get('file') as File).name).toBe('voice-note.m4a');
    expect(form.get('response_format')).toBe('json');
    expect(form.get('language')).toBe('ru');
  });
});

describe('the OpenAI-shaped adapter: refusals, each one word and whether asking again could help', () => {
  const ask = async (answer: Parameters<typeof fakeFetch>[0], timeoutMs?: number) => {
    const http = fakeFetch(answer);
    const adapter = new OpenAiCompatibleTranscriber({ url: OPENAI_TRANSCRIPTIONS_URL, apiKey: KEY, model: 'whisper-1', fetch: http.fetch, ...(timeoutMs ? { timeoutMs } : {}) });
    return adapter.transcribe({ bytes: opusNote(2), contentType: 'audio/ogg', languageHints: TRANSCRIPTION_LANGUAGE_HINTS });
  };

  it('429 is a rate limit, 5xx and 408 the provider down: retryable', async () => {
    expect(await ask(json({ error: {} }, 429))).toEqual({ ok: false, reason: 'PROVIDER_RATE_LIMIT', retryable: true, status: 429 });
    expect(await ask(json({ error: {} }, 503))).toEqual({ ok: false, reason: 'PROVIDER_UNAVAILABLE', retryable: true, status: 503 });
    expect(await ask(json({ error: {} }, 408))).toEqual({ ok: false, reason: 'PROVIDER_UNAVAILABLE', retryable: true, status: 408 });
  });

  it('a refused key or file (4xx) is final; a network error is worth another try', async () => {
    expect(await ask(json({ error: {} }, 401))).toEqual({ ok: false, reason: 'PROVIDER_REFUSED', retryable: false, status: 401 });
    expect(await ask(json({ error: {} }, 400))).toEqual({ ok: false, reason: 'PROVIDER_REFUSED', retryable: false, status: 400 });
    expect(await ask(new TypeError('fetch failed'))).toEqual({ ok: false, reason: 'PROVIDER_ERROR', retryable: true, status: null });
  });

  it('an answer with no text is malformed; one that never comes is a timeout', async () => {
    expect(await ask(json({ nope: true }))).toEqual({ ok: false, reason: 'MALFORMED_RESPONSE', retryable: false, status: 200 });
    const hang = (): Promise<Response> => new Promise(() => undefined);
    const http = fakeFetch(hang);
    const adapter = new OpenAiCompatibleTranscriber({
      url: OPENAI_TRANSCRIPTIONS_URL,
      apiKey: KEY,
      model: 'whisper-1',
      timeoutMs: 20,
      fetch: ((url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          void http.fetch(url, init);
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })) as unknown as typeof fetch,
    });
    expect(await adapter.transcribe({ bytes: opusNote(2), contentType: 'audio/ogg', languageHints: ['th'] })).toEqual({
      ok: false,
      reason: 'PROVIDER_TIMEOUT',
      retryable: true,
      status: null,
    });
  });
});

describe('the limits, checked before anything is sent', () => {
  it('reads a recording’s length from its own header: Ogg Opus, M4A, WAV, MP3; estimates any other from its size', () => {
    expect(audioSeconds(opusNote(42), 'audio/ogg; codecs=opus')).toBeCloseTo(42, 3);
    expect(audioSeconds(m4aNote(95.5), 'audio/mp4')).toBeCloseTo(95.5, 3);
    expect(audioSeconds(wavNote(12), 'audio/wav')).toBeCloseTo(12, 3);
    expect(audioSeconds(mp3Note(80_000), 'audio/mpeg')).toBeCloseTo(10, 3);
    // A browser's WebM (SCRUM-834): no length in the header; the last cluster's timecode plus its last block's offset.
    const webm = (clusterMs: number, blockMs: number, padding: number) =>
      new Uint8Array([
        0x1a, 0x45, 0xdf, 0xa3, 0x80,
        ...new Array<number>(padding).fill(0x55),
        0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xe7, 0x84, (clusterMs >>> 24) & 0xff, (clusterMs >>> 16) & 0xff, (clusterMs >>> 8) & 0xff, clusterMs & 0xff,
        0xa3, 0x86, 0x81, 0x00, 0x00, 0x80, 0x01, 0x02,
        0xa3, 0x86, 0x81, (blockMs >>> 8) & 0xff, blockMs & 0xff, 0x80, 0x01, 0x02,
      ]);
    expect(audioSeconds(webm(124_000, 980, 2_000_000), 'audio/webm;codecs=opus')).toBeCloseTo(124.98, 2);
    expect(audioSeconds(webm(15_000, 960, 200_000), 'audio/webm')).toBeCloseTo(15.96, 2);
    // No cluster: estimated from the size as before.
    expect(audioSeconds(new Uint8Array(80_000), 'audio/webm')).toBeCloseTo(10, 3);
    // A webm says nothing we read: 64 kbit/s.
    expect(audioSeconds(new Uint8Array(80_000), 'audio/webm')).toBeCloseTo(10, 3);
    // A header that is not what it claims is estimated like any other file.
    expect(audioSeconds(new Uint8Array(16_000), 'audio/ogg')).toBeCloseTo(2, 3);
  });

  it('a format no provider takes is never sent (AMR, raw AAC)', async () => {
    const fake = new FakeTranscriber();
    for (const contentType of ['audio/amr', 'audio/aac', 'application/pdf']) {
      expect(transcribableExtension(contentType)).toBeNull();
      const out = await transcribe(runtimeWith(fake), { bytes: new Uint8Array(100), contentType, languageHints: TRANSCRIPTION_LANGUAGE_HINTS });
      expect(out).toMatchObject({ ok: false, reason: 'UNSUPPORTED_FORMAT', retryable: false });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('longer than TRANSCRIPTION_MAX_SECONDS, or more bytes than the limit, is TOO_LONG and never sent', async () => {
    const fake = new FakeTranscriber({ ok: true, text: 'unused', language: null, durationSeconds: null });
    const long = await transcribe(runtimeWith(fake), { bytes: opusNote(181), contentType: 'audio/ogg', languageHints: TRANSCRIPTION_LANGUAGE_HINTS });
    expect(long).toMatchObject({ ok: false, reason: 'TOO_LONG', retryable: false, durationSeconds: 181 });
    const big = await transcribe(runtimeWith(fake, { maxBytes: 100 }), { bytes: opusNote(5), contentType: 'audio/ogg', languageHints: ['th'] });
    expect(big).toMatchObject({ ok: false, reason: 'TOO_LONG' });
    expect(fake.requests).toHaveLength(0);
    // At the limit is sent.
    const atLimit = await transcribe(runtimeWith(fake), { bytes: opusNote(180), contentType: 'audio/ogg', languageHints: TRANSCRIPTION_LANGUAGE_HINTS });
    expect(atLimit).toMatchObject({ ok: true, text: 'unused' });
    expect(fake.requests).toHaveLength(1);
  });

  it('the byte limit is the smaller of what the inbox stores and what the provider takes', () => {
    const runtime = buildTranscriptionRuntime(loadEnv({ TRANSCRIPTION_MAX_SECONDS: '120' }));
    expect(runtime).toMatchObject({ provider: 'off', adapter: null, maxSeconds: 120 });
    expect(runtime.maxBytes).toBe(Math.min(INBOX_MEDIA_MAX_BYTES, TRANSCRIPTION_PROVIDER_MAX_BYTES));
  });

  it('no adapter is NOT_CONFIGURED; nothing heard is EMPTY; a throwing adapter is a retryable PROVIDER_ERROR', async () => {
    const req = { bytes: opusNote(3), contentType: 'audio/ogg', languageHints: TRANSCRIPTION_LANGUAGE_HINTS };
    expect(await transcribe(runtimeWith(null), req)).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED', retryable: false });
    const silent = new FakeTranscriber().next({ ok: true, text: '  \n ', language: 'en', durationSeconds: 3 });
    expect(await transcribe(runtimeWith(silent), req)).toMatchObject({ ok: false, reason: 'EMPTY', retryable: false });
    const throwing = new FakeTranscriber().next(() => {
      throw new Error('boom');
    });
    expect(await transcribe(runtimeWith(throwing), req)).toMatchObject({ ok: false, reason: 'PROVIDER_ERROR', retryable: true });
  });

  it('a note within the limits comes back trimmed, with its language as a code and its length', async () => {
    const fake = new FakeTranscriber().next({ ok: true, text: '  ZZ TEST   Здравствуйте, 12 детей  ', language: 'russian', durationSeconds: null });
    const out = await transcribe(runtimeWith(fake), { bytes: opusNote(7), contentType: 'audio/ogg', languageHints: TRANSCRIPTION_LANGUAGE_HINTS });
    expect(out).toMatchObject({ ok: true, text: 'ZZ TEST Здравствуйте, 12 детей', language: 'ru', durationSeconds: 7, model: 'fake-transcriber' });
    expect(fake.requests[0]!.languageHints).toEqual(['th', 'ru', 'en']);
  });
});

describe('the language label', () => {
  it('takes the provider’s code or its English name, else the words’ script', () => {
    expect(transcriptLanguageOf('thai', 'whatever')).toBe('th');
    expect(transcriptLanguageOf('Russian', 'whatever')).toBe('ru');
    expect(transcriptLanguageOf('english', '')).toBe('en');
    expect(transcriptLanguageOf('th', '')).toBe('th');
    expect(transcriptLanguageOf('ukrainian', '')).toBe('uk');
    expect(transcriptLanguageOf(null, 'ZZ TEST สวัสดีค่ะ อยากจัดวันเกิด')).toBe('th');
    expect(transcriptLanguageOf(undefined, 'ZZ TEST Здравствуйте, хотим праздник')).toBe('ru');
    expect(transcriptLanguageOf('klingon-ish', 'ZZ TEST hello there')).toBe('en');
    expect(transcriptLanguageOf(null, '12 34 !!')).toBeNull();
    expect(scriptLanguage('')).toBeNull();
  });
});

describe('the one reading of a message’s words (messageText)', () => {
  it('the body as it was; a transcript marked as spoken; both when there are both; null for neither', () => {
    expect(messageText({ body: 'hello', transcript: null })).toBe('hello');
    expect(messageText({ body: 'hello' })).toBe('hello');
    expect(messageText({ body: null, transcript: ' ZZ TEST 12 kids ' })).toBe(`${VOICE_NOTE_MARK} ZZ TEST 12 kids`);
    expect(messageText({ body: '  ', transcript: 'ZZ TEST spoken' })).toBe('[voice note] ZZ TEST spoken');
    expect(messageText({ body: 'see my note', transcript: 'ZZ TEST spoken' })).toBe('see my note\n[voice note] ZZ TEST spoken');
    expect(messageText({ body: null, transcript: '' })).toBeNull();
    expect(messageText({ body: '', transcript: null })).toBeNull();
  });
});

describe('the assistant’s wait (voiceHold)', () => {
  const now = new Date('2026-11-10T08:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  // A turn born long ago: each note's own time is the later one, and decides.
  const longAgo = ago(VOICE_WAIT_MAX_MS * 4);
  it('waits while a note is pending; a note nobody could read is a person’s; off and done are as any line', () => {
    expect(voiceHold([{ at: ago(30_000), voice: 'pending' }], now, longAgo)).toBe('wait');
    expect(voiceHold([{ at: ago(VOICE_WAIT_MAX_MS + 1), voice: 'pending' }], now, longAgo)).toBe('unread');
    expect(voiceHold([{ at: ago(1000), voice: 'failed' }], now, longAgo)).toBe('unread');
    expect(voiceHold([{ at: ago(1000), voice: 'too_long' }], now, longAgo)).toBe('unread');
    expect(voiceHold([{ at: ago(1000), voice: 'off' }], now, longAgo)).toBeNull();
    expect(voiceHold([{ at: ago(1000), voice: 'done' }, { at: ago(500), voice: null }], now, longAgo)).toBeNull();
    // A failed note beside one still pending: wait for the second before handing over.
    expect(voiceHold([{ at: ago(2000), voice: 'failed' }, { at: ago(1000), voice: 'pending' }], now, longAgo)).toBe('wait');
    expect(voiceHold([], now, longAgo)).toBeNull();
  });

  it('counts the wait on our clock: a note the provider stamped ten minutes ago, in a turn born 20 s ago, still waits', () => {
    // A redelivered webhook: the provider's timestamp is old, the turn is new.
    const redelivered = [{ at: ago(10 * 60_000), voice: 'pending' as const }];
    expect(voiceHold(redelivered, now, ago(20_000))).toBe('wait');
    expect(voiceHold(redelivered, now, ago(VOICE_WAIT_MAX_MS - 1))).toBe('wait');
    // Five minutes after the turn was born, it is a person's.
    expect(voiceHold(redelivered, now, ago(VOICE_WAIT_MAX_MS + 1))).toBe('unread');
  });
});

describe('the env: names only, the boot guard, and never a real provider under tests', () => {
  it('blank lines copied from .env.example mean the defaults', () => {
    const env = loadEnv({ TRANSCRIPTION_PROVIDER: '', TRANSCRIPTION_MODEL: '', TRANSCRIPTION_MAX_SECONDS: '', TRANSCRIPTION_API_URL: '' });
    expect(env).toMatchObject({ TRANSCRIPTION_PROVIDER: 'off', TRANSCRIPTION_MODEL: 'whisper-1', TRANSCRIPTION_MAX_SECONDS: 180, TRANSCRIPTION_API_URL: '' });
  });

  it('a provider with no key refuses the boot, naming the variable and never a value', () => {
    expect(() => loadEnv({ TRANSCRIPTION_PROVIDER: 'openai-compatible', TRANSCRIPTION_API_KEY: '' })).toThrow(/TRANSCRIPTION_API_KEY is not set/);
  });

  it('the endpoint is https (or http to this machine), with no credential in it', () => {
    expect(() => loadEnv({ TRANSCRIPTION_API_URL: 'http://speech.example.test/v1/audio/transcriptions' })).toThrow(/https only/);
    expect(() => loadEnv({ TRANSCRIPTION_API_URL: 'https://user:pw@speech.example.test/v1' })).toThrow(/never in the URL/);
    expect(loadEnv({ TRANSCRIPTION_API_URL: 'http://localhost:9999/v1/audio/transcriptions' }).TRANSCRIPTION_API_URL).toBe(
      'http://localhost:9999/v1/audio/transcriptions',
    );
  });

  it('under NODE_ENV=test the runtime is off even with a provider and a key: a suite injects the fake', () => {
    const env = loadEnv({ TRANSCRIPTION_PROVIDER: 'openai-compatible', TRANSCRIPTION_API_KEY: KEY });
    expect(env.TRANSCRIPTION_PROVIDER).toBe('openai-compatible');
    expect(buildTranscriptionRuntime(env)).toMatchObject({ provider: 'off', adapter: null });
  });
});
