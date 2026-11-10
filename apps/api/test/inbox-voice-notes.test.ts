import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeBookDateReader } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { ChannelError, type SimulatedInbound } from '@oto/messaging';
import type { FileStorage } from '../src/services/files';
import {
  FakeTranscriber,
  TRANSCRIPTION_PROVIDER_MAX_BYTES,
  type TranscriptionRuntime,
} from '../src/services/inbox/transcription';
import {
  INBOX_TRANSCRIBE_JOB,
  TRANSCRIBE_RETRY_MS,
  TRANSCRIPT_PENDING,
  VOICE_MEDIA_GRACE_MS,
  VOICE_UNREAD,
  VOICE_WAIT_STEP_MS,
  runInboxTranscribeJob,
} from '../src/services/inbox/voice-notes';
import { buildDefaultJobs } from '../src/services/jobs';
import { ADMIN, signInAs, teardownAll } from './helpers';
import {
  aiLines,
  aiWorld,
  call,
  decision,
  eventsOf,
  later,
  nextPhone,
  sim,
  simAccount,
  staff,
  tick,
  turnsOf,
  type AiWorld,
} from './inbox-ai-support';
import { NO_LEAKS, sentinelLeaks } from './inbox-sentinel';

/**
 * SCRUM-824 part (a) — a customer's voice note, transcribed and read like
 * typed text: the flow end to end on a real embedded database, through the
 * real webhook, with every model a fake (`FakeTranscriber`,
 * `FakeAssistantClient`, `FakeBookDateReader`): no key is ever spent.
 *
 *   - the ingest files the note `pending`, its audio is stored, and
 *     `job:inbox.transcribe` writes the words and their language, audited
 *     and run-recorded without the words;
 *   - the assistant's turn WAITS while the note is pending (no model call, no
 *     line), then answers on the transcript as the message's text;
 *   - a provider that keeps failing is asked twice more, then the note is
 *     `failed`, and the assistant hands the thread to a person with the warm
 *     holding line (`VOICE_UNREAD`); a note too long is never sent, likewise;
 *   - no provider: the ingest files the note `off` at once (also when its
 *     audio cannot be fetched), and the assistant leaves it for a person as
 *     before, never waiting; the job's off sweep is only a safety net;
 *   - audio that cannot be stored is settled at once; an erased note is never sent;
 *   - a note the provider stamped minutes ago (a redelivered webhook) is
 *     waited for, and its audio given its grace, from when it reached us;
 *   - Book Date's whole-chat read and the BEO fill's conversation read the
 *     transcript, marked `[voice note] …`;
 *   - the simulator plays an uploaded voice note through the real webhook.
 *
 * FICTIONAL TEST DATA: every recording is synthetic bytes (an Ogg Opus header
 * stating a length, and filler), never a voice, and every transcript is
 * made-up "ZZ TEST" words.
 */

/** A string no real message holds, with no digit: it must surface nowhere but the message table. */
const WORDS_SENTINEL = 'ZQXVOICESENTINELQZX';

let w: AiWorld;
let live: string; // a Central number, the assistant live
let quiet: string; // a Central birthdays number, the assistant off
let gmCookie: string;
let adminCookie: string;

const objects = new Map<string, Buffer>();
/** Object storage in memory that keeps what is put, and gives it back. */
const store: FileStorage = {
  bucket: 'oto-files-test',
  presignedPut: async (objectKey) => `memory://oto-files-test/${objectKey}?put`,
  presignedGet: async (objectKey) => `https://storage.test/oto-files-test/${objectKey}`,
  put: async (objectKey, bytes) => {
    objects.set(objectKey, Buffer.from(bytes));
  },
  remove: async (objectKey) => {
    objects.delete(objectKey);
  },
  get: async (objectKey) => {
    const b = objects.get(objectKey);
    if (!b) throw new Error('no such object');
    return b;
  },
  probe: async () => ({ state: 'ready' }),
};

// --- Synthetic recordings (as in inbox-transcription.test.ts) ---------------------------------

function oggPage(granule: bigint, payload: Buffer, seq: number, headerType = 0): Buffer {
  const header = Buffer.alloc(28);
  header.write('OggS', 0, 'latin1');
  header[5] = headerType;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(0x0824, 14);
  header.writeUInt32LE(seq, 18);
  header[26] = 1;
  header[27] = Math.min(255, payload.length);
  return Buffer.concat([header, payload]);
}

/** An Ogg Opus voice note `seconds` long, with `salt` making each one's bytes its own. */
function opusNote(seconds: number, salt = 0): Uint8Array {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48_000, 12);
  return new Uint8Array(
    Buffer.concat([
      oggPage(0n, head, 0, 2),
      oggPage(BigInt(Math.round(seconds * 48_000) + 312), Buffer.alloc(200, 0x41 + (salt % 20)), 1, 4),
    ]),
  );
}

const VOICE_TYPE = 'audio/ogg; codecs=opus';

function runtimeOf(adapter: FakeTranscriber | null): TranscriptionRuntime {
  return { provider: adapter ? 'fake' : 'off', adapter, maxSeconds: 180, maxBytes: TRANSCRIPTION_PROVIDER_MAX_BYTES };
}

function job(runtime: TranscriptionRuntime, at = new Date()) {
  return runInboxTranscribeJob(w.ctx.db, { runtime, storage: store, log: w.ctx.app.log }, at);
}

/**
 * The api's own transcription runtime (`app.inboxTranscription`), the one the
 * ingest files a voice note `pending` or `off` by: on with a fake adapter (it
 * is never asked: each test hands the job its own), or off as a deployment
 * with no provider. Off under NODE_ENV=test until a suite turns it on.
 */
function provider(on: boolean): void {
  const runtime = w.ctx.app.inboxTranscription;
  runtime.adapter = on ? new FakeTranscriber() : null;
  runtime.provider = on ? 'fake' : 'off';
}

let salt = 0;

/** A customer's voice note posted to the real webhook; the response is awaited by the caller. */
async function playVoice(
  accountId: string,
  bytes: Uint8Array,
  opts: { from?: string; hint?: SimulatedInbound['hint']; at?: Date } = {},
) {
  const channel = await sim(w, accountId);
  const played = channel.inbound({
    from: opts.from ?? nextPhone(),
    name: 'ZZ TEST Voice Guest',
    voice: { bytes, contentType: VOICE_TYPE },
    ...(opts.hint ? { hint: opts.hint } : {}),
    ...(opts.at ? { at: opts.at } : {}),
  });
  const posted = w.ctx.app.inject({
    method: 'POST',
    url: `/webhooks/inbox/${accountId}`,
    headers: played.webhook.headers as Record<string, string>,
    payload: played.webhook.rawBody as string,
  });
  return { externalMessageId: played.externalMessageId, posted };
}

/** The message a played delivery filed, with its thread. */
async function filedAs(accountId: string, externalMessageId: string): Promise<{ conv: string; messageId: string }> {
  const [m] = await w.ctx.db
    .select({ id: s.message.id, conversationId: s.message.conversationId })
    .from(s.message)
    .where(and(eq(s.message.channelAccountId, accountId), eq(s.message.externalMessageId, externalMessageId)))
    .limit(1);
  return { conv: m!.conversationId, messageId: m!.id };
}

/** A customer's voice note through the real webhook; answers its thread and its message. */
async function voiceIn(
  accountId: string,
  bytes: Uint8Array,
  opts: { from?: string; hint?: SimulatedInbound['hint']; at?: Date } = {},
): Promise<{ conv: string; messageId: string }> {
  const { externalMessageId, posted } = await playVoice(accountId, bytes, opts);
  expect((await posted).json().outcome).toBe('processed');
  return filedAs(accountId, externalMessageId);
}

async function note(id: string) {
  const [row] = await w.ctx.db.select().from(s.message).where(eq(s.message.id, id)).limit(1);
  return row!;
}

/** Nothing of an earlier test is left for this one's ticks: no pending turn, no pending note. */
async function drain(): Promise<void> {
  await w.ctx.db
    .update(s.aiTurn)
    .set({ state: 'cancelled', reason: 'TEST_DRAIN', leaseUntil: null })
    .where(sql`state in ('pending','deciding')`);
  await w.ctx.db.update(s.message).set({ transcriptStatus: 'failed', transcriptNextAttemptAt: null }).where(eq(s.message.transcriptStatus, 'pending'));
}

async function closingUnclear() {
  const [row] = await w.ctx.db
    .select()
    .from(s.template)
    .where(and(eq(s.template.operatorId, w.oto), eq(s.template.key, 'closing_unclear'), eq(s.template.language, 'en')))
    .limit(1);
  return row!;
}

beforeAll(async () => {
  w = await aiWorld();
  (w.ctx.app as unknown as { fileStorage: FileStorage | null }).fileStorage = store;
  // A provider configured: the ingest files voice notes pending (a test switches it off where it says so).
  expect(w.ctx.app.inboxTranscription).toMatchObject({ provider: 'off', adapter: null });
  provider(true);
  live = await simAccount(w, { branchId: w.central });
  quiet = await simAccount(w, { branchId: w.central, aiMode: 'off', defaultCategory: 'birthdays' });
  [, gmCookie] = await staff(w, '+66810082401', 'ZZ TEST Voice GM', 'inbox_manager', { scopeType: 'operator', scopeId: w.oto });
  adminCookie = await signInAs(w.ctx.app, ADMIN.phone, ADMIN.password);
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

describe('job:inbox.transcribe: pending → done', () => {
  it('the ingest files the note pending with its audio stored; the job writes its words and language, never into audit, ops or logs', async () => {
    await drain();
    const bytes = opusNote(6, ++salt);
    const { conv, messageId } = await voiceIn(live, bytes);
    const filed = await note(messageId);
    expect(filed).toMatchObject({ transcriptStatus: 'pending', transcript: null, transcriptLanguage: null, transcriptAttempts: 0 });
    expect(filed.audioFileId).not.toBeNull();
    const [file] = await w.ctx.db.select().from(s.fileObject).where(eq(s.fileObject.id, filed.audioFileId!)).limit(1);
    expect(file).toMatchObject({ contentType: VOICE_TYPE, ownerEntityType: 'inbox.message', ownerEntityId: messageId });
    expect(objects.get(file!.objectKey)?.equals(Buffer.from(bytes))).toBe(true);

    const words = `ZZ TEST สวัสดีค่ะ ${WORDS_SENTINEL} อยากจองบัตร`;
    const fake = new FakeTranscriber().next({ ok: true, text: words, language: 'thai', durationSeconds: 6 });
    expect(await job(runtimeOf(fake))).toMatchObject({ due: 1, done: 1, failed: 0, retried: 0 });
    expect(await note(messageId)).toMatchObject({
      transcriptStatus: 'done',
      transcript: words,
      transcriptLanguage: 'th',
      transcriptAttempts: 1,
      transcriptNextAttemptAt: null,
    });
    // What the provider was handed: the stored bytes, their type, the three languages.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.contentType).toBe(VOICE_TYPE);
    expect(fake.requests[0]!.languageHints).toEqual(['th', 'ru', 'en']);
    expect(Buffer.from(fake.requests[0]!.bytes).equals(Buffer.from(bytes))).toBe(true);

    const [row] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.message.transcribe'), eq(s.auditLog.entityId, messageId)))
      .limit(1);
    expect(row!.after).toMatchObject({ messageId, conversationId: conv, transcriptStatus: 'done', language: 'th' });
    const [run] = await w.ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:inbox.transcription'), sql`${s.opsRun.detail}->>'messageId' = ${messageId}`))
      .limit(1);
    expect(run).toMatchObject({ outcome: 'ok' });
    expect(run!.detail).toMatchObject({ outcome: 'ok', language: 'th', durationSeconds: 6, attempt: 1 });
    expect(await sentinelLeaks(w.ctx.db, WORDS_SENTINEL, w.logLines)).toEqual(NO_LEAKS);

    // The thread read carries it for the bubble.
    const page = await call<{ messages: Array<Record<string, unknown>> }>(w, gmCookie, 'GET', `/inbox/conversations/${conv}/messages`);
    expect(page.status).toBe(200);
    expect(page.body.messages.find((m) => m.id === messageId)).toMatchObject({
      transcript: words,
      transcriptStatus: 'done',
      transcriptLanguage: 'th',
      audioFileId: filed.audioFileId,
    });
  });

  it('is registered in the runner, every fifteen seconds', () => {
    const jobs = buildDefaultJobs({ db: w.ctx.db, env: w.ctx.app.env, log: w.ctx.app.log, channels: [] });
    expect(jobs.find((j) => j.name === INBOX_TRANSCRIBE_JOB)).toMatchObject({ intervalSeconds: 15 });
  });
});

describe('the assistant waits for the transcript, then answers on it', () => {
  it('no call and no line while the note is pending; the turn comes back and is decided on "[voice note] …"', async () => {
    await drain();
    const { conv, messageId } = await voiceIn(live, opusNote(5, ++salt));
    expect((await turnsOf(w, conv)).map((t) => t.state)).toEqual(['pending']);

    const calls = w.fake.requests.length;
    const first = later(25_000);
    const sweep = await tick(w, first);
    expect(sweep).toMatchObject({ waiting: 1, answered: 0, silent: 0, handedOver: 0 });
    expect(w.fake.requests.length).toBe(calls);
    const [held] = await turnsOf(w, conv);
    expect(held).toMatchObject({ state: 'pending', reason: TRANSCRIPT_PENDING, attempts: 0, leaseUntil: null });
    expect(held!.dueAt.getTime()).toBe(first.getTime() + VOICE_WAIT_STEP_MS);
    expect(await aiLines(w, conv)).toHaveLength(0);
    expect((await eventsOf(w, conv)).some((e) => e.actorKind === 'ai')).toBe(false);
    const [wait] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.ai.turn.wait'), eq(s.auditLog.entityId, held!.id)))
      .limit(1);
    expect(wait!.after).toMatchObject({ state: 'pending', reason: TRANSCRIPT_PENDING });
    // Before it is due again, nothing is claimed.
    expect((await tick(w, new Date(first.getTime() + 1_000))).due).toBe(0);

    const words = `ZZ TEST hello there ${WORDS_SENTINEL}`;
    expect(await job(runtimeOf(new FakeTranscriber().next({ ok: true, text: words, language: 'english', durationSeconds: 5 })))).toMatchObject({ done: 1 });
    expect((await note(messageId)).transcriptStatus).toBe('done');

    w.fake.push({ kind: 'decision', decision: decision() });
    expect((await tick(w, later(40_000))).answered).toBe(1);
    const prompt = w.fake.requests.at(-1)!.prompt.messages[0].content;
    expect(prompt).toContain(`[voice note] ${words}`);
    expect((await turnsOf(w, conv))[0]).toMatchObject({ state: 'answered', reason: 'OK' });
    expect(await aiLines(w, conv)).toHaveLength(1);
    expect(await sentinelLeaks(w.ctx.db, WORDS_SENTINEL, w.logLines)).toEqual(NO_LEAKS);
  });
});

describe('a note that cannot be read is a person’s', () => {
  it('a provider that keeps failing is asked twice more (15 s, then 60 s), then the note fails and the thread is handed over with the warm line', async () => {
    await drain();
    const { conv, messageId } = await voiceIn(live, opusNote(4, ++salt));
    const fake = new FakeTranscriber({ ok: false, reason: 'PROVIDER_UNAVAILABLE', retryable: true, status: 503 });
    const t1 = new Date();
    expect(await job(runtimeOf(fake), t1)).toMatchObject({ due: 1, retried: 1 });
    let row = await note(messageId);
    expect(row).toMatchObject({ transcriptStatus: 'pending', transcriptAttempts: 1 });
    expect(row.transcriptNextAttemptAt!.getTime()).toBe(t1.getTime() + TRANSCRIBE_RETRY_MS[0]!);
    // Not before it is due.
    expect((await job(runtimeOf(fake), new Date(t1.getTime() + 5_000))).due).toBe(0);
    const t2 = new Date(t1.getTime() + 16_000);
    expect(await job(runtimeOf(fake), t2)).toMatchObject({ due: 1, retried: 1 });
    row = await note(messageId);
    expect(row).toMatchObject({ transcriptStatus: 'pending', transcriptAttempts: 2 });
    expect(row.transcriptNextAttemptAt!.getTime()).toBe(t2.getTime() + TRANSCRIBE_RETRY_MS[1]!);
    expect(await job(runtimeOf(fake), new Date(t2.getTime() + 61_000))).toMatchObject({ due: 1, failed: 1 });
    expect(await note(messageId)).toMatchObject({ transcriptStatus: 'failed', transcriptAttempts: 3, transcript: null, transcriptNextAttemptAt: null });
    expect(fake.requests).toHaveLength(3);
    const runs = await w.ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:inbox.transcription'), sql`${s.opsRun.detail}->>'messageId' = ${messageId}`))
      .orderBy(asc(s.opsRun.startedAt));
    expect(runs.map((r) => [r.outcome, r.errorCode])).toEqual([
      ['failed', 'PROVIDER_UNAVAILABLE'],
      ['failed', 'PROVIDER_UNAVAILABLE'],
      ['failed', 'PROVIDER_UNAVAILABLE'],
    ]);

    const calls = w.fake.requests.length;
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect(w.fake.requests.length).toBe(calls);
    expect((await turnsOf(w, conv))[0]).toMatchObject({ state: 'handed_over', reason: VOICE_UNREAD, action: 'handover' });
    const handover = (await eventsOf(w, conv)).find((e) => e.kind === 'ai_handover');
    expect(handover!.payload).toMatchObject({ reason: VOICE_UNREAD, holdingLine: 'template', closingKey: 'closing_unclear', silent: false });
    const unclear = await closingUnclear();
    expect((await aiLines(w, conv)).map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([{ body: unclear.body, templateId: unclear.id }]);
  });

  it('longer than TRANSCRIPTION_MAX_SECONDS: never sent, "too long", and handed over', async () => {
    await drain();
    const { conv, messageId } = await voiceIn(live, opusNote(400, ++salt));
    const fake = new FakeTranscriber({ ok: true, text: 'unused', language: null, durationSeconds: null });
    expect(await job(runtimeOf(fake))).toMatchObject({ due: 1, tooLong: 1 });
    expect(fake.requests).toHaveLength(0);
    expect(await note(messageId)).toMatchObject({ transcriptStatus: 'too_long', transcript: null });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await turnsOf(w, conv))[0]).toMatchObject({ state: 'handed_over', reason: VOICE_UNREAD });
  });

  it('audio that could not be stored is failed at once, and never claimed', async () => {
    await drain();
    (w.ctx.app as unknown as { fileStorage: FileStorage | null }).fileStorage = null;
    let messageId: string;
    try {
      ({ messageId } = await voiceIn(live, opusNote(3, ++salt)));
    } finally {
      (w.ctx.app as unknown as { fileStorage: FileStorage | null }).fileStorage = store;
    }
    expect(await note(messageId)).toMatchObject({ transcriptStatus: 'failed', audioFileId: null });
    const [row] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.message.transcribe'), eq(s.auditLog.entityId, messageId)))
      .limit(1);
    expect(row!.after).toMatchObject({ transcriptStatus: 'failed', reason: 'STORAGE_NOT_CONFIGURED' });
    const fake = new FakeTranscriber({ ok: true, text: 'unused', language: null, durationSeconds: null });
    expect((await job(runtimeOf(fake))).due).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('an erased note is never sent, nor written', async () => {
    await drain();
    const { messageId } = await voiceIn(live, opusNote(3, ++salt));
    await w.ctx.db.update(s.message).set({ redactedAt: new Date(), body: null, transcript: null }).where(eq(s.message.id, messageId));
    const fake = new FakeTranscriber({ ok: true, text: `ZZ TEST ${WORDS_SENTINEL}`, language: 'en', durationSeconds: 3 });
    expect((await job(runtimeOf(fake))).due).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect((await note(messageId)).transcript).toBeNull();
  });
});

describe('no provider configured: as before', () => {
  /** The turn never waited for a transcript: no hold, no wait audit row. */
  async function neverHeld(conv: string): Promise<void> {
    for (const turn of await turnsOf(w, conv)) {
      expect(turn.reason).not.toBe(TRANSCRIPT_PENDING);
      const waits = await w.ctx.db
        .select()
        .from(s.auditLog)
        .where(and(eq(s.auditLog.action, 'inbox.ai.turn.wait'), eq(s.auditLog.entityId, turn.id)));
      expect(waits).toHaveLength(0);
    }
  }

  it('the ingest files the note "off" at once; the assistant leaves it for a person (NO_TEXT, no model call), never waiting, with no transcribe tick first', async () => {
    await drain();
    provider(false);
    let filed: { conv: string; messageId: string };
    try {
      filed = await voiceIn(live, opusNote(5, ++salt));
    } finally {
      provider(true);
    }
    const { conv, messageId } = filed;
    const row = await note(messageId);
    expect(row).toMatchObject({ transcriptStatus: 'off', transcript: null, transcriptNextAttemptAt: null });
    expect(row.audioFileId).not.toBeNull();
    // The assistant's tick before any transcribe tick: decided at once.
    const calls = w.fake.requests.length;
    expect((await tick(w, later(25_000)))).toMatchObject({ silent: 1, waiting: 0, handedOver: 0 });
    expect(w.fake.requests.length).toBe(calls);
    expect((await turnsOf(w, conv))[0]).toMatchObject({ state: 'silent', reason: 'NO_TEXT' });
    expect(await aiLines(w, conv)).toHaveLength(0);
    await neverHeld(conv);
    // Nothing is left for the job to mark.
    expect(await job(runtimeOf(null))).toMatchObject({ off: 0 });
  });

  it('the audio cannot be fetched: still "off", never "could not be read"; silent with NO_TEXT, no closing line, never held', async () => {
    await drain();
    const channel = await sim(w, live);
    const fetchMedia = channel.fetchMedia;
    channel.fetchMedia = () => Promise.reject(new ChannelError('MEDIA_NOT_FOUND', 'ZZ TEST the provider lost the audio'));
    provider(false);
    let filed: { conv: string; messageId: string };
    try {
      filed = await voiceIn(live, opusNote(4, ++salt));
    } finally {
      provider(true);
      channel.fetchMedia = fetchMedia;
    }
    const { conv, messageId } = filed;
    expect(await note(messageId)).toMatchObject({ transcriptStatus: 'off', audioFileId: null, transcript: null });
    // The media failure is on record; no transcription outcome is written for a note nobody tried to read.
    const [media] = await w.ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:inbox.media'), sql`${s.opsRun.detail}->>'messageId' = ${messageId}`))
      .limit(1);
    expect(media).toMatchObject({ outcome: 'failed' });
    expect(media!.detail).toMatchObject({ kind: 'audio', reason: 'MEDIA_NOT_FOUND' });
    const settled = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.message.transcribe'), eq(s.auditLog.entityId, messageId)));
    expect(settled).toHaveLength(0);

    const calls = w.fake.requests.length;
    expect((await tick(w, later(25_000)))).toMatchObject({ silent: 1, waiting: 0, handedOver: 0 });
    expect(w.fake.requests.length).toBe(calls);
    expect((await turnsOf(w, conv))[0]).toMatchObject({ state: 'silent', reason: 'NO_TEXT' });
    // No closing line to the family, no hand-over.
    expect(await aiLines(w, conv)).toHaveLength(0);
    expect((await eventsOf(w, conv)).some((e) => e.kind === 'ai_handover')).toBe(false);
    await neverHeld(conv);
    // Staff read "not transcribed", not "could not be read".
    const page = await call<{ messages: Array<Record<string, unknown>> }>(w, gmCookie, 'GET', `/inbox/conversations/${conv}/messages`);
    expect(page.body.messages.find((m) => m.id === messageId)).toMatchObject({ transcriptStatus: 'off', audioFileId: null });
  });

  it('the job’s off sweep is the safety net: a note filed pending before the provider was switched off is "off"', async () => {
    await drain();
    const { conv, messageId } = await voiceIn(live, opusNote(5, ++salt));
    expect((await note(messageId)).transcriptStatus).toBe('pending');
    expect(await job(runtimeOf(null))).toMatchObject({ off: 1 });
    expect(await note(messageId)).toMatchObject({ transcriptStatus: 'off', transcript: null });
    const calls = w.fake.requests.length;
    expect((await tick(w, later(25_000))).silent).toBe(1);
    expect(w.fake.requests.length).toBe(calls);
    expect((await turnsOf(w, conv))[0]).toMatchObject({ state: 'silent', reason: 'NO_TEXT' });
  });
});

describe('a redelivered webhook: the waits run from when the note reached us, not the provider’s timestamp', () => {
  it('a note stamped ten minutes ago: its audio keeps its grace while it is fetched, the turn waits, and it is transcribed and answered', async () => {
    await drain();
    // The store holds the audio back until the job has looked once.
    const put = store.put;
    let reached!: () => void;
    const atPut = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    store.put = async (objectKey, bytes, contentType) => {
      reached();
      await gate;
      return put(objectKey, bytes, contentType);
    };
    const stamped = new Date(Date.now() - 10 * 60_000);
    const words = `ZZ TEST late but heard ${WORDS_SENTINEL}`;
    const fake = new FakeTranscriber().next({ ok: true, text: words, language: 'english', durationSeconds: 5 });
    let played: Awaited<ReturnType<typeof playVoice>>;
    try {
      played = await playVoice(live, opusNote(5, ++salt), { at: stamped });
      await atPut;
      // In, and its audio on its way: the message carries the provider's old time,
      // its audio's deadline is two minutes from now.
      const { messageId } = await filedAs(live, played.externalMessageId);
      const waiting = await note(messageId);
      expect(waiting).toMatchObject({ transcriptStatus: 'pending', audioFileId: null });
      expect(waiting.createdAt.getTime()).toBeLessThanOrEqual(Date.now() - 9 * 60_000);
      expect(waiting.transcriptNextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + VOICE_MEDIA_GRACE_MS - 60_000);
      // A transcribe tick now neither gives it up (MEDIA_MISSING) nor claims it.
      expect(await job(runtimeOf(fake))).toMatchObject({ due: 0, givenUp: 0, failed: 0 });
      expect((await note(messageId)).transcriptStatus).toBe('pending');
    } finally {
      release();
      store.put = put;
    }
    expect((await played.posted).json().outcome).toBe('processed');
    const { conv, messageId } = await filedAs(live, played.externalMessageId);
    // Stored: claimable at once.
    const stored = await note(messageId);
    expect(stored).toMatchObject({ transcriptStatus: 'pending', transcriptNextAttemptAt: null });
    expect(stored.audioFileId).not.toBeNull();

    // The turn falls due: it waits for the transcript, not "unread" because the provider's clock is old.
    const calls = w.fake.requests.length;
    expect(await tick(w, later(25_000))).toMatchObject({ waiting: 1, handedOver: 0, silent: 0, answered: 0 });
    expect(w.fake.requests.length).toBe(calls);
    expect((await turnsOf(w, conv))[0]).toMatchObject({ state: 'pending', reason: TRANSCRIPT_PENDING });
    expect(await aiLines(w, conv)).toHaveLength(0);

    expect(await job(runtimeOf(fake))).toMatchObject({ due: 1, done: 1 });
    expect(await note(messageId)).toMatchObject({ transcriptStatus: 'done', transcript: words, transcriptLanguage: 'en' });

    w.fake.push({ kind: 'decision', decision: decision() });
    expect((await tick(w, later(40_000))).answered).toBe(1);
    expect(w.fake.requests.at(-1)!.prompt.messages[0].content).toContain(`[voice note] ${words}`);
    expect((await turnsOf(w, conv))[0]).toMatchObject({ state: 'answered', reason: 'OK' });
    expect(await sentinelLeaks(w.ctx.db, WORDS_SENTINEL, w.logLines)).toEqual(NO_LEAKS);
  });
});

describe('Book Date and the BEO fill read the transcript like typed text', () => {
  it('the whole-chat read and the conversation the BEO fill is handed carry "[voice note] …", and Book Date reads the kids from it', async () => {
    await drain();
    const { conv, messageId } = await voiceIn(quiet, opusNote(8, ++salt), { hint: { category: 'birthdays', language: 'en' } });
    const words = 'ZZ TEST a birthday party on 21 November for 12 kids and 4 adults please';
    expect(await job(runtimeOf(new FakeTranscriber().next({ ok: true, text: words, language: 'english', durationSeconds: 8 })))).toMatchObject({ done: 1 });

    const beo = await call<{ transcript: Array<{ id: string; author: string; text: string }> }>(
      w,
      gmCookie,
      'GET',
      `/inbox/conversations/${conv}/beo-confirmation`,
    );
    expect(beo.status, JSON.stringify(beo.body)).toBe(200);
    expect(beo.body.transcript).toEqual([{ id: messageId, author: 'customer', at: expect.any(String), text: `[voice note] ${words}` }]);

    // The model numbers the chat's lines from 1.
    const reader = new FakeBookDateReader([{ kind: 'reading', reading: { kids: { value: 12, line: 1, said: '12 kids' } } }]);
    w.ctx.app.inboxAi.bookDateReader = reader;
    try {
      const proposal = await call<{ model: string; proposal: { kids: unknown } }>(w, gmCookie, 'GET', `/inbox/conversations/${conv}/book-date-proposal`);
      expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
      expect(proposal.body.model).toBe('ai');
      expect(proposal.body.proposal.kids).toEqual({ value: 12, text: '12 kids', source: 'family', messageId });
      expect(reader.requests[0]!.lines).toEqual([{ by: 'family', at: expect.any(String), text: `[voice note] ${words}` }]);
    } finally {
      w.ctx.app.inboxAi.bookDateReader = null;
    }
  });
});

describe('the simulator plays an uploaded voice note (POST /inbox/simulator/inbound)', () => {
  it('through the real webhook: stored and pending; words or a voice note are required; the size is bounded', async () => {
    await drain();
    const bytes = opusNote(7, ++salt);
    const from = nextPhone();
    const res = await call<{ outcome: string; messages: number; externalMessageId: string }>(w, adminCookie, 'POST', '/inbox/simulator/inbound', {
      channelAccountId: quiet,
      from,
      voice: { contentType: 'audio/ogg', dataBase64: Buffer.from(bytes).toString('base64') },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'processed', messages: 1 });
    const [m] = await w.ctx.db
      .select()
      .from(s.message)
      .where(and(eq(s.message.channelAccountId, quiet), eq(s.message.externalMessageId, res.body.externalMessageId)))
      .limit(1);
    expect(m).toMatchObject({ transcriptStatus: 'pending', body: null });
    expect(m!.audioFileId).not.toBeNull();

    const neither = await call(w, adminCookie, 'POST', '/inbox/simulator/inbound', { channelAccountId: quiet, from });
    expect(neither.status).toBe(400);
    const notAudio = await call(w, adminCookie, 'POST', '/inbox/simulator/inbound', {
      channelAccountId: quiet,
      from,
      voice: { contentType: 'application/pdf', dataBase64: 'AAAA' },
    });
    expect(notAudio.status).toBe(400);
    const tooBig = await call(w, adminCookie, 'POST', '/inbox/simulator/inbound', {
      channelAccountId: quiet,
      from,
      voice: { contentType: 'audio/ogg', dataBase64: Buffer.alloc(1024 * 1024 + 3).toString('base64') },
    });
    expect(tooBig.status).toBe(400);
    await drain();
  });
});
