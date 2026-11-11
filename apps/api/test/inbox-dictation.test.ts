import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { DICTATION_RATE, INBOX_DICTATION_ACTION } from '../src/services/inbox/dictation';
import { FakeTranscriber, TRANSCRIBABLE_AUDIO_CONTENT_TYPES, TRANSCRIPTION_LANGUAGE_HINTS } from '../src/services/inbox/transcription';
import { RECEPTION, SECOND_OPERATOR_ADMIN, signInAs, teardownAll } from './helpers';
import { ON_DEFAULT_QUEUE, aiWorld, customer, nextPhone, simAccount, staff, teamOf, type AiWorld } from './inbox-ai-support';
import { NO_LEAKS, sentinelLeaks } from './inbox-sentinel';

/**
 * SCRUM-834 part (b) — a reply dictated into the composer: the recording is
 * posted to `POST /inbox/conversations/{id}/dictation` and the words come
 * back for the composer; no message is written, the audio is kept nowhere,
 * and the record is ids, length and language only. Every provider is the
 * fake (`FakeTranscriber`): no key is ever spent.
 *
 *   - the words and the language back, in Thai, Russian and English, through
 *     the same hints and limits as a customer's voice note;
 *   - the ceiling (a clip longer than TRANSCRIPTION_MAX_SECONDS) and the byte
 *     limit are refused with their own code, and never sent;
 *   - a format no provider takes, a provider that heard nothing, a provider
 *     that did not answer: each its own code;
 *   - the provider off answers DICTATION_NOT_AVAILABLE;
 *   - a video container is refused at the door: the parsers take audio only;
 *   - GET /inbox/me says whether dictation is offered here and the ceiling;
 *   - twenty a minute per caller, the next 429, another caller unaffected;
 *   - the check is the reply's: no inbox grant 403, read without reply 403,
 *     another team 404, another operator 404, no session 401;
 *   - no message row is written, the audit row carries no words, and the
 *     sentinel surfaces nowhere but the answer.
 *
 * FICTIONAL TEST DATA: every recording is synthetic bytes and every
 * transcript is made-up "ZZ TEST" words.
 */

/** A string no real message holds, with no digit: it must surface nowhere but the answer. */
const WORDS_SENTINEL = 'ZQXDICTATIONSENTINELQZX';
const VOICE_TYPE = 'audio/webm;codecs=opus';

let w: AiWorld;
let conv: string;
let agentId: string;
const cookies: Record<string, string> = {};

// --- Synthetic recordings (as in inbox-transcription.test.ts) ---------------------------------

function oggPage(granule: bigint, payload: Buffer, seq: number, headerType = 0): Buffer {
  const header = Buffer.alloc(28);
  header.write('OggS', 0, 'latin1');
  header[5] = headerType;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(0x0834, 14);
  header.writeUInt32LE(seq, 18);
  header[26] = 1;
  header[27] = Math.min(255, payload.length);
  return Buffer.concat([header, payload]);
}

/** An Ogg Opus clip `seconds` long. */
function opusClip(seconds: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48_000, 12);
  return Buffer.concat([oggPage(0n, head, 0, 2), oggPage(BigInt(Math.round(seconds * 48_000) + 312), Buffer.alloc(200, 0x5a), 1, 4)]);
}

/** A short clip of no particular format: estimated from its size (a few seconds at a voice rate). */
const webmClip = (bytes = 24_000): Buffer => Buffer.alloc(bytes, 0x5a);

function fake(): FakeTranscriber {
  const adapter = new FakeTranscriber();
  w.ctx.app.inboxTranscription.adapter = adapter;
  w.ctx.app.inboxTranscription.provider = 'fake';
  return adapter;
}

function providerOff(): void {
  w.ctx.app.inboxTranscription.adapter = null;
  w.ctx.app.inboxTranscription.provider = 'off';
}

interface Answer {
  status: number;
  body: { text?: string; language?: string | null; error?: { code: string; message: string; details?: Record<string, unknown> } };
}

async function dictate(cookie: string | null, payload: Buffer, contentType: string | null = VOICE_TYPE, id = conv): Promise<Answer> {
  const res = await w.ctx.app.inject({
    method: 'POST',
    url: `/inbox/conversations/${id}/dictation`,
    headers: { ...(cookie ? { cookie } : {}), ...(contentType ? { 'content-type': contentType } : {}) },
    payload,
  });
  return { status: res.statusCode, body: (res.body ? res.json() : {}) as Answer['body'] };
}

async function messagesOf(conversationId: string) {
  return w.ctx.db.select({ id: s.message.id }).from(s.message).where(eq(s.message.conversationId, conversationId));
}

async function dictationAudits(conversationId: string) {
  return w.ctx.db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.action, INBOX_DICTATION_ACTION), eq(s.auditLog.entityId, conversationId)))
    .orderBy(s.auditLog.createdAt);
}

beforeAll(async () => {
  w = await aiWorld();
  const account = await simAccount(w, { branchId: w.central, aiMode: 'off' });
  conv = (await customer(w, account, nextPhone(), 'ZZ TEST hello, is the park open today?', ON_DEFAULT_QUEUE)).id;

  // The Reception · Central desk's agent: reads and replies in the team, as the reply test's does.
  const reception = await teamOf(w, 'reception', w.central);
  [agentId, cookies.agent!] = await staff(w, '+66810008341', 'ZZ TEST Dictating Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: reception.departmentId!,
  });
  // Marketing's agent: replies, but in another team.
  const marketing = await teamOf(w, 'marketing');
  [, cookies.otherTeam!] = await staff(w, '+66810008342', 'ZZ TEST Marketing Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: marketing.departmentId!,
  });
  // A reader who may not reply: a role of read alone, at Central's desk.
  const readerRole = newId();
  await w.ctx.db.insert(s.role).values({ id: readerRole, operatorId: w.oto, name: 'inbox_dictation_reader_test', description: 'read only' });
  for (const permission of ['app:inbox:access', 'inbox:conversation:read']) {
    await w.ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: readerRole, permission });
  }
  [, cookies.reader!] = await staff(w, '+66810008343', 'ZZ TEST Reader', 'inbox_dictation_reader_test', {
    scopeType: 'department',
    scopeId: reception.departmentId!,
  });
  cookies.counter = await signInAs(w.ctx.app, RECEPTION.phone, RECEPTION.password);
  cookies.secondAdmin = await signInAs(w.ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

describe('the dictation route (SCRUM-834)', () => {
  it('is registered as an inbox route: dynamic permission, no replay of its answer, nothing public', async () => {
    const route = w.ctx.app.routeRegistry.find((r) => r.method === 'POST' && r.url === '/inbox/conversations/:id/dictation');
    expect(route).toBeDefined();
    expect(route!.config.dynamicPermission).toBe(true);
    expect(route!.config.secretResponse).toBe(true);
    expect(route!.config.public).not.toBe(true);
    expect(route!.config.credential).toBeUndefined();
    // Twenty a minute per caller, said as the route's own code (the test at the end spends it).
    expect((route!.config as { rateLimit?: unknown }).rateLimit).toMatchObject({ max: 20, timeWindow: 60_000 });
    expect((await dictate(null, webmClip())).status).toBe(401);
  });

  it('answers the words and the language heard, through the voice-note hints, and writes no message', async () => {
    const adapter = fake().next(
      { ok: true, text: ` ZZ TEST  สวัสดีค่ะ ${WORDS_SENTINEL} `, language: 'thai', durationSeconds: 4 },
      { ok: true, text: 'ZZ TEST Привет, парк открыт', language: null, durationSeconds: null },
      { ok: true, text: 'ZZ TEST yes, we open at ten', language: 'english', durationSeconds: 2.5 },
    );
    const before = (await messagesOf(conv)).length;

    const thai = await dictate(cookies.agent!, webmClip());
    expect(thai.status, JSON.stringify(thai.body)).toBe(200);
    expect(thai.body).toEqual({ text: `ZZ TEST สวัสดีค่ะ ${WORDS_SENTINEL}`, language: 'th' });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.contentType).toBe(VOICE_TYPE);
    expect(adapter.requests[0]!.languageHints).toEqual([...TRANSCRIPTION_LANGUAGE_HINTS]);
    expect(adapter.requests[0]!.bytes.length).toBe(24_000);

    // Russian read from the script when the provider names no language; English as the provider names it.
    const russian = await dictate(cookies.agent!, webmClip());
    expect(russian.body).toEqual({ text: 'ZZ TEST Привет, парк открыт', language: 'ru' });
    const english = await dictate(cookies.agent!, webmClip());
    expect(english.body).toEqual({ text: 'ZZ TEST yes, we open at ten', language: 'en' });

    // No message, no draft: the thread is as it was.
    expect((await messagesOf(conv)).length).toBe(before);

    // The audit row: ids, the outcome, the length, the bytes, the language — never the words.
    const audits = await dictationAudits(conv);
    expect(audits.length).toBeGreaterThanOrEqual(3);
    const first = audits[0]!;
    expect(first.actorAccountId).toBe(agentId);
    expect(first.operatorId).toBe(w.oto);
    expect(first.branchId).toBe(w.central);
    expect(first.entityType).toBe('inbox.conversation');
    expect(first.after).toMatchObject({
      conversationId: conv,
      outcome: 'ok',
      model: 'fake-transcriber',
      durationSeconds: 4,
      language: 'th',
      bytes: 24_000,
      contentType: 'audio/webm',
    });
    expect(JSON.stringify(first.after)).not.toContain('ZZ TEST');
    expect(first.requestId).toBeTruthy();

    // The provider call is an ops run, as a voice note's is, marked as a dictation; no words there either.
    const runs = await w.ctx.db
      .select()
      .from(s.opsRun)
      .where(and(eq(s.opsRun.name, 'adapter:inbox.transcription'), eq(s.opsRun.requestId, first.requestId!)));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.detail).toMatchObject({ source: 'dictation', conversationId: conv, outcome: 'ok', language: 'th' });

    // Nowhere but the answer: not the audit log, the events, the ops rows or a log line.
    expect(await sentinelLeaks(w.ctx.db, WORDS_SENTINEL, w.logLines)).toEqual(NO_LEAKS);
  });

  it('refuses a clip over the ceiling with DICTATION_TOO_LONG, never sending it', async () => {
    const adapter = fake();
    const { maxSeconds, maxBytes } = w.ctx.app.inboxTranscription;
    const res = await dictate(cookies.agent!, opusClip(maxSeconds + 1), 'audio/ogg; codecs=opus');
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({
      code: 'DICTATION_TOO_LONG',
      details: { maxSeconds, maxBytes, durationSeconds: maxSeconds + 1 },
    });
    expect(res.body.error!.message).toMatch(/at most 3 minutes/);
    expect(adapter.requests).toHaveLength(0);
    const audits = await dictationAudits(conv);
    expect(audits.at(-1)!.after).toMatchObject({ outcome: 'TOO_LONG', durationSeconds: maxSeconds + 1 });
    // At the ceiling exactly, it is sent.
    adapter.next({ ok: true, text: 'ZZ TEST at the ceiling', language: 'en', durationSeconds: maxSeconds });
    expect((await dictate(cookies.agent!, opusClip(maxSeconds), 'audio/ogg; codecs=opus')).status).toBe(200);
    expect(adapter.requests).toHaveLength(1);
  });

  it('refuses a clip over the byte limit with DICTATION_TOO_LONG, before the handler', async () => {
    const adapter = fake();
    const { maxSeconds, maxBytes } = w.ctx.app.inboxTranscription;
    expect(maxBytes).toBe(25 * 1024 * 1024);
    const res = await dictate(cookies.agent!, Buffer.alloc(maxBytes + 1, 0x5a), 'audio/webm');
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'DICTATION_TOO_LONG', details: { maxSeconds, maxBytes, durationSeconds: null } });
    expect(adapter.requests).toHaveLength(0);
  });

  it('refuses a format no provider takes, a video container, a parsed non-audio body, and an empty body', async () => {
    const adapter = fake();
    const amr = await dictate(cookies.agent!, webmClip(), 'audio/amr');
    expect(amr.status).toBe(415);
    expect(amr.body.error!.code).toBe('DICTATION_UNSUPPORTED_FORMAT');
    // The provider takes a video container; a dictation is a microphone's recording, so the door does not.
    expect(TRANSCRIBABLE_AUDIO_CONTENT_TYPES.every((type) => type.startsWith('audio/'))).toBe(true);
    expect(TRANSCRIBABLE_AUDIO_CONTENT_TYPES).toEqual(expect.arrayContaining(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/flac']));
    for (const video of ['video/mp4', 'video/webm']) {
      const res = await dictate(cookies.agent!, webmClip(), video);
      expect(res.status, video).toBe(415);
      expect(res.body.error!.code).toBe('DICTATION_UNSUPPORTED_FORMAT');
    }
    const json = await dictate(cookies.agent!, Buffer.from('{"text":"ZZ TEST typed"}'), 'application/json');
    expect(json.status).toBe(415);
    expect(json.body.error!.code).toBe('DICTATION_UNSUPPORTED_FORMAT');
    const empty = await dictate(cookies.agent!, Buffer.alloc(0), 'audio/webm');
    expect(empty.status).toBe(400);
    expect(adapter.requests).toHaveLength(0);
  });

  it('a provider that heard nothing, and one that did not answer, each answer their own code', async () => {
    const adapter = fake().next(
      { ok: true, text: '   ', language: null, durationSeconds: 1 },
      { ok: false, reason: 'PROVIDER_TIMEOUT', retryable: true, status: null },
      { ok: false, reason: 'PROVIDER_REFUSED', retryable: false, status: 400 },
    );
    const nothing = await dictate(cookies.agent!, webmClip());
    expect(nothing.status).toBe(422);
    expect(nothing.body.error!.code).toBe('DICTATION_NOTHING_HEARD');
    const timeout = await dictate(cookies.agent!, webmClip());
    expect(timeout.status).toBe(502);
    expect(timeout.body.error).toMatchObject({ code: 'DICTATION_FAILED', details: { reason: 'PROVIDER_TIMEOUT', retryable: true } });
    expect(timeout.body.error!.message).toMatch(/Try again/);
    const refused = await dictate(cookies.agent!, webmClip());
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatchObject({ code: 'DICTATION_FAILED', details: { reason: 'PROVIDER_REFUSED', retryable: false } });
    expect(adapter.requests).toHaveLength(3);
    const audits = await dictationAudits(conv);
    expect(audits.slice(-3).map((a) => (a.after as { outcome: string }).outcome)).toEqual(['EMPTY', 'PROVIDER_TIMEOUT', 'PROVIDER_REFUSED']);
  });

  it('with no provider configured answers DICTATION_NOT_AVAILABLE', async () => {
    providerOff();
    const res = await dictate(cookies.agent!, webmClip());
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('DICTATION_NOT_AVAILABLE');
    expect(res.body.error!.message).toMatch(/not available/);
    expect((await dictationAudits(conv)).at(-1)!.after).toMatchObject({ outcome: 'NOT_CONFIGURED', model: null });
  });

  it('GET /inbox/me says whether dictation is offered here and the ceiling, as the provider stands', async () => {
    const dictationOf = async () => {
      const res = await w.ctx.app.inject({ method: 'GET', url: '/inbox/me', headers: { cookie: cookies.agent! } });
      expect(res.statusCode).toBe(200);
      return (res.json() as { dictation?: { available: boolean; maxSeconds: number } }).dictation;
    };
    const { maxSeconds } = w.ctx.app.inboxTranscription;
    expect(maxSeconds).toBe(180);
    fake();
    expect(await dictationOf()).toEqual({ available: true, maxSeconds });
    providerOff();
    expect(await dictationOf()).toEqual({ available: false, maxSeconds });
  });

  it('is the reply’s check: no inbox grant 403; read without reply 403; another team 404; another operator 404', async () => {
    const adapter = fake().always({ ok: true, text: 'ZZ TEST never', language: 'en', durationSeconds: 1 });
    const before = (await dictationAudits(conv)).length;
    expect((await dictate(cookies.counter!, webmClip())).status).toBe(403);
    const reader = await dictate(cookies.reader!, webmClip());
    expect(reader.status).toBe(403);
    expect(reader.body.error!.message).toMatch(/inbox:conversation:reply/);
    expect((await dictate(cookies.otherTeam!, webmClip())).status).toBe(404);
    expect((await dictate(cookies.secondAdmin!, webmClip())).status).toBe(404);
    expect((await dictate(cookies.agent!, webmClip(), VOICE_TYPE, newId())).status).toBe(404);
    expect(adapter.requests).toHaveLength(0);
    expect((await dictationAudits(conv)).length).toBe(before);
  });

  it('takes twenty a minute from one caller: the next is 429 DICTATION_RATE_LIMITED, before the handler; another caller dictates on', async () => {
    const adapter = fake().always({ ok: true, text: 'ZZ TEST counted', language: 'en', durationSeconds: 1 });
    // A fresh agent at the same desk, so the count starts at nothing.
    const reception = await teamOf(w, 'reception', w.central);
    const [, cookie] = await staff(w, '+66810008344', 'ZZ TEST Counted Agent', 'inbox_agent', {
      scopeType: 'department',
      scopeId: reception.departmentId!,
    });
    const before = (await dictationAudits(conv)).length;
    for (let n = 1; n <= DICTATION_RATE.max; n += 1) {
      expect((await dictate(cookie, webmClip())).status, `dictation ${n}`).toBe(200);
    }
    const res = await w.ctx.app.inject({
      method: 'POST',
      url: `/inbox/conversations/${conv}/dictation`,
      headers: { cookie, 'content-type': VOICE_TYPE },
      payload: webmClip(),
    });
    expect(res.statusCode).toBe(429);
    const body = res.json() as { error: { code: string; message: string; details?: { retryAfterSeconds?: number } } };
    expect(body.error.code).toBe('DICTATION_RATE_LIMITED');
    expect(body.error.message).toMatch(/Too many dictations in a minute/);
    expect(body.error.details?.retryAfterSeconds).toBeGreaterThan(0);
    expect(String(res.headers['retry-after'])).toBe(String(body.error.details!.retryAfterSeconds));
    expect(String(res.headers['x-ratelimit-limit'])).toBe(String(DICTATION_RATE.max));
    // Refused before the handler: no provider call, no audit row for it.
    expect(adapter.requests).toHaveLength(DICTATION_RATE.max);
    expect((await dictationAudits(conv)).length).toBe(before + DICTATION_RATE.max);
    // The bucket is the caller's own: the desk's other agent dictates on.
    expect((await dictate(cookies.agent!, webmClip())).status).toBe(200);
  });
});
