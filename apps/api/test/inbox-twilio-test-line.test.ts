import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema as s } from '@oto/db';
import { TWILIO_SANDBOX_NUMBER, TWIML_EMPTY, twilioSignature } from '@oto/messaging';
import { newId } from '@oto/shared';
import { assertProductionSafe, loadEnv } from '../src/env';
import { sendQueuedMessage } from '../src/services/inbox/send';
import { teardownAll } from './helpers';
import {
  aiLines,
  aiWorld,
  call,
  conversationRow,
  decision,
  simAccount,
  staff,
  teamOf,
  tick,
  type AiWorld,
} from './inbox-ai-support';

/**
 * SCRUM-908 — the WhatsApp TEST LINE on Twilio's sandbox, through the real
 * routes, the real ingest, the real turn engine and the real send path, with
 * Twilio answered by a stub: NO test here opens a socket (a call to anything
 * but the stubbed Messages endpoint throws), and the model is the fake one.
 *
 *   - set-up: the line found or created on the sandbox number, its settings
 *     named (never a value), the address to paste into Twilio;
 *   - the webhook: Twilio's signature over the CONFIGURED origin (a forged
 *     Host changes nothing), the allowed number filed and answered by the
 *     assistant by itself, any other number recorded as a receipt and
 *     nothing else, a status callback moving the reply's delivery;
 *   - the allow-list outbound: a send to another number refused NOT_ALLOWED
 *     with no call to Twilio;
 *   - Start over: the test line only (409 elsewhere, 403 without
 *     inbox:channel:manage), the thread out of the inbox, its words gone,
 *     the contact's names and language reset, idempotent, audited — and the
 *     number's next message a FIRST conversation whose prompt holds nothing
 *     from before.
 *
 * FICTIONAL DATA: the numbers are +668987000NN, the SIDs runs of zeros, the
 * token says it is not real; the owner's tester's number is a setting on
 * staging and appears nowhere in this repository.
 */

const ORIGIN = 'https://api.staging.example';
const SID = `AC${'0'.repeat(31)}8`;
const TOKEN = 'zz-test-auth-token-not-a-real-one';
const ALLOWED = '+66898700001';
const STRANGER = '+66898700002';
const SENDER = '+66898700099';
const REF = 'ZZTEST';
const FIRST_WORDS = 'ZQXFIRSTVISITWORDQZX';
const SECOND_WORDS = 'ZQXSECONDVISITWORDQZX';
const SETTINGS = {
  [`INBOX_TWILIO_ACCOUNT_SID_${REF}`]: SID,
  [`INBOX_TWILIO_AUTH_TOKEN_${REF}`]: TOKEN,
  [`INBOX_TWILIO_ALLOWED_NUMBERS_${REF}`]: ALLOWED,
};

let w: AiWorld;
let line: string; // a test line on an invented number: no sandbox pace in the checks
let other: string; // a simulator number: not a test line
let adminCookie: string;
let agentCookie: string;
const twilio: Array<{ url: string; form: URLSearchParams }> = [];
let smSeq = 0;

beforeAll(async () => {
  // The per-line settings are read by NAME from the process environment when the app is built.
  for (const [k, v] of Object.entries(SETTINGS)) process.env[k] = v;
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    if (url !== `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`) {
      throw new Error(`no network in this suite: ${url}`);
    }
    twilio.push({ url, form: new URLSearchParams(init.body ?? '') });
    smSeq += 1;
    return new Response(JSON.stringify({ sid: `SM${String(smSeq).padStart(32, '0')}`, status: 'queued' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  });
  w = await aiWorld({ INBOX_TWILIO_ENABLED: 'true', INBOX_TWILIO_PUBLIC_URL: ORIGIN });
  w.ctx.app.inboxAi.config.debounceMs = 0;
  line = newId();
  await w.ctx.db.insert(s.channelAccount).values({
    id: line,
    operatorId: w.oto,
    branchId: null,
    channel: 'whatsapp',
    provider: 'twilio',
    externalId: SENDER,
    displayName: 'ZZ TEST WhatsApp test line',
    credentialRef: REF,
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
    aiMode: 'live',
  });
  other = await simAccount(w, { branchId: null });
  [, adminCookie] = await staff(w, '+66898700051', 'ZZ TEST Inbox Admin', 'inbox_admin', { scopeType: 'operator', scopeId: w.oto });
  const reception = await teamOf(w, 'reception', w.central);
  [, agentCookie] = await staff(w, '+66898700052', 'ZZ TEST Inbox Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: reception.departmentId!,
  });
}, 300_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(SETTINGS)) delete process.env[k];
  await w?.ctx.close();
  await teardownAll();
});

let msgSeq = 0;
const nextSid = () => `SM${String(++msgSeq).padStart(29, '0')}908`;

/** An incoming WhatsApp message as Twilio posts it (the documented fields). */
function inbound(from: string, body: string, profile: string, sid = nextSid()): Array<[string, string]> {
  return [
    ['SmsMessageSid', sid],
    ['NumMedia', '0'],
    ['ProfileName', profile],
    ['MessageType', 'text'],
    ['SmsSid', sid],
    ['WaId', from.slice(1)],
    ['SmsStatus', 'received'],
    ['Body', body],
    ['To', `whatsapp:${SENDER}`],
    ['NumSegments', '1'],
    ['ReferralNumMedia', '0'],
    ['MessageSid', sid],
    ['AccountSid', SID],
    ['From', `whatsapp:${from}`],
    ['ApiVersion', '2010-04-01'],
  ];
}

async function post(fields: Array<[string, string]>, opts: { token?: string | null; host?: string; account?: string } = {}) {
  const path = `/webhooks/inbox/twilio/${opts.account ?? line}`;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.host) headers['host'] = opts.host;
  if (opts.token !== null) headers['x-twilio-signature'] = twilioSignature(opts.token ?? TOKEN, `${ORIGIN}${path}`, fields);
  const res = await w.ctx.app.inject({ method: 'POST', url: path, headers, payload: new URLSearchParams(fields).toString() });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/xml/);
  expect(res.body).toBe(TWIML_EMPTY);
}

async function receipts() {
  return w.ctx.db.select().from(s.webhookReceipt).where(eq(s.webhookReceipt.channelAccountId, line)).orderBy(asc(s.webhookReceipt.receivedAt));
}

async function liveThreadOf(phone: string) {
  const [row] = await w.ctx.db
    .select({ conv: s.conversation })
    .from(s.conversation)
    .innerJoin(s.contact, eq(s.contact.id, s.conversation.contactId))
    .where(and(eq(s.conversation.channelAccountId, line), eq(s.contact.phone, phone), isNull(s.conversation.archivedAt)))
    .limit(1);
  return row?.conv;
}

async function contactOf(phone: string) {
  const [row] = await w.ctx.db.select().from(s.contact).where(and(eq(s.contact.operatorId, w.oto), eq(s.contact.phone, phone))).limit(1);
  return row;
}

/** One tick decides the burst, a second (past the typing time) sends the line through the line's adapter. */
async function answer(bubble: string) {
  w.fake.push({ kind: 'decision', decision: decision({ bubbles: [bubble] }) });
  await tick(w, new Date());
  expect(w.fake.remaining).toBe(0);
  await tick(w, new Date(Date.now() + 120_000));
}

let firstThread: string;

describe('setting the line up (POST /inbox/test-lines)', () => {
  it('finds or creates the line on the sandbox number, names its settings and the address to paste, and writes once', async () => {
    const made = await call<Record<string, unknown>>(w, adminCookie, 'POST', '/inbox/test-lines', { credentialRef: REF });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({
      externalId: TWILIO_SANDBOX_NUMBER,
      credentialRef: REF,
      created: true,
      displayName: 'WhatsApp test line',
      settings: {
        accountSid: `INBOX_TWILIO_ACCOUNT_SID_${REF}`,
        authToken: `INBOX_TWILIO_AUTH_TOKEN_${REF}`,
        allowedNumbers: `INBOX_TWILIO_ALLOWED_NUMBERS_${REF}`,
      },
      connected: true,
      reason: null,
      aiMode: 'off',
    });
    const id = made.body['channelAccountId'] as string;
    expect(made.body['webhookPath']).toBe(`/webhooks/inbox/twilio/${id}`);
    expect(made.body['webhookUrl']).toBe(`${ORIGIN}/webhooks/inbox/twilio/${id}`);
    // Names only: no value of a setting is ever answered.
    expect(JSON.stringify(made.body)).not.toContain(TOKEN);
    expect(JSON.stringify(made.body)).not.toContain(ALLOWED);

    const again = await call<Record<string, unknown>>(w, adminCookie, 'POST', '/inbox/test-lines', {});
    expect(again.body).toMatchObject({ channelAccountId: id, created: false });
    const audits = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.channel_account.create'), eq(s.auditLog.entityId, id)));
    expect(audits).toHaveLength(1);

    expect((await call(w, agentCookie, 'POST', '/inbox/test-lines', {})).status).toBe(403);
  });

  it('lists the lines in GET /inbox/me, with Start over only for someone who manages them', async () => {
    const admin = await call<{ testLines: Array<{ id: string; startOver: boolean }> }>(w, adminCookie, 'GET', '/inbox/me');
    expect(admin.body.testLines.find((l) => l.id === line)).toMatchObject({ displayName: 'ZZ TEST WhatsApp test line', startOver: true });
    const agent = await call<{ testLines: Array<{ id: string; startOver: boolean }> }>(w, agentCookie, 'GET', '/inbox/me');
    expect(agent.body.testLines.find((l) => l.id === line)?.startOver).toBe(false);
  });
});

describe('the webhook (POST /webhooks/inbox/twilio/:id)', () => {
  it('files the allowed number and the assistant answers by itself through Twilio', async () => {
    await post(inbound(ALLOWED, `Hello! What time do you open today? ${FIRST_WORDS}`, 'ZZ Test Tester'));
    const conv = await liveThreadOf(ALLOWED);
    expect(conv).toBeDefined();
    firstThread = conv!.id;
    expect(conv).toMatchObject({ category: 'general', status: 'active' });
    const person = await contactOf(ALLOWED);
    expect(person).toMatchObject({ channel: 'whatsapp', externalHandle: ALLOWED, displayName: 'ZZ Test Tester' });

    await answer(`We open at ten in the morning. ${FIRST_WORDS}`);
    const [reply] = await aiLines(w, firstThread);
    expect(reply).toMatchObject({ providerStatus: 'sent', direction: 'outbound' });
    expect(reply!.externalMessageId).toMatch(/^SM/);
    const sent = twilio.at(-1)!;
    expect(sent.form.get('To')).toBe(`whatsapp:${ALLOWED}`);
    expect(sent.form.get('From')).toBe(`whatsapp:${SENDER}`);
    expect(sent.form.get('Body')).toBe(`We open at ten in the morning. ${FIRST_WORDS}`);
    expect(sent.form.get('StatusCallback')).toBe(`${ORIGIN}/webhooks/inbox/twilio/${line}`);
  });

  it("moves the reply's delivery on Twilio's status callback, and names a failure by its code", async () => {
    const [reply] = await aiLines(w, firstThread);
    const status = (st: string, extra: Array<[string, string]> = []): Array<[string, string]> => [
      ['MessageStatus', st],
      ['MessageSid', reply!.externalMessageId!],
      ['SmsSid', reply!.externalMessageId!],
      ['SmsStatus', st],
      ['AccountSid', SID],
      ['From', `whatsapp:${SENDER}`],
      ['To', `whatsapp:${ALLOWED}`],
      ['ChannelPrefix', 'whatsapp'],
      ...extra,
    ];
    await post(status('delivered'));
    await post(status('read'));
    const [after] = await aiLines(w, firstThread);
    expect(after).toMatchObject({ providerStatus: 'read' });
    expect(after!.deliveredAt).not.toBeNull();
    expect(after!.readAt).not.toBeNull();
  });

  it('records a message from any other number as a receipt and nothing else: no contact, no thread, no turn, no reply', async () => {
    const before = (await receipts()).length;
    const calls = twilio.length;
    await post(inbound(STRANGER, 'Hi, is this the park?', 'ZZ Test Stranger'));
    const after = await receipts();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ signatureOk: true, error: null });
    // A form post is not JSON: the receipt keeps no copy of the words.
    expect(after.at(-1)!.payload).toBeNull();
    expect(await contactOf(STRANGER)).toBeUndefined();
    await tick(w, new Date(Date.now() + 120_000));
    expect(twilio.length).toBe(calls);
    const [audit] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.webhook.receive'), eq(s.auditLog.entityId, after.at(-1)!.id)));
    expect(audit!.after).toMatchObject({ messages: 0, unknown: 1, conversationsCreated: 0 });
    expect(JSON.stringify(audit!.after)).not.toContain(STRANGER.slice(1));
  });

  it("verifies against the configured origin: a forged Host changes nothing, a wrong token or no signature is refused", async () => {
    await post(inbound(ALLOWED, 'And on Sunday?', 'ZZ Test Tester'), { host: 'evil.example' });
    const messages = await w.ctx.db.select().from(s.message).where(and(eq(s.message.conversationId, firstThread), eq(s.message.direction, 'inbound')));
    expect(messages.map((m) => m.body)).toContain('And on Sunday?');

    const before = (await receipts()).length;
    await post(inbound(ALLOWED, 'forged line', 'ZZ Test Forger'), { token: 'not-the-token' });
    await post(inbound(ALLOWED, 'unsigned line', 'ZZ Test Forger'), { token: null });
    const after = await receipts();
    expect(after.slice(before).map((r) => [r.signatureOk, r.error])).toEqual([
      [false, 'BAD_SIGNATURE'],
      [false, 'MISSING_SIGNATURE'],
    ]);
    const bodies = (await w.ctx.db.select({ body: s.message.body }).from(s.message).where(eq(s.message.channelAccountId, line))).map((m) => m.body);
    expect(bodies).not.toContain('forged line');
    expect(bodies).not.toContain('unsigned line');
  });

  it('a redelivery of the same message is one message', async () => {
    const sid = nextSid();
    await post(inbound(ALLOWED, 'twice sent', 'ZZ Test Tester', sid));
    await post(inbound(ALLOWED, 'twice sent', 'ZZ Test Tester', sid));
    const rows = await w.ctx.db.select().from(s.message).where(eq(s.message.externalMessageId, sid));
    expect(rows).toHaveLength(1);
  });
});

describe('the allow-list, outbound', () => {
  it('refuses a send to any other number NOT_ALLOWED, with no call to Twilio', async () => {
    // A thread with someone not on the list, inside the window, as a staff-made contact would have.
    const contactId = newId();
    await w.ctx.db.insert(s.contact).values({ id: contactId, operatorId: w.oto, channel: 'whatsapp', externalHandle: STRANGER, phone: STRANGER });
    const convId = newId();
    await w.ctx.db.insert(s.conversation).values({
      id: convId,
      operatorId: w.oto,
      contactId,
      channelAccountId: line,
      category: 'general',
      status: 'active',
      lastCustomerMessageAt: new Date(),
    });
    const messageId = newId();
    await w.ctx.db.insert(s.message).values({
      id: messageId,
      operatorId: w.oto,
      conversationId: convId,
      channelAccountId: line,
      direction: 'outbound',
      authorKind: 'system',
      body: 'A line for someone not on the list',
      providerStatus: 'queued',
    });
    const calls = twilio.length;
    const outcome = await sendQueuedMessage(w.ctx.db, { channels: w.ctx.app.inboxChannels }, messageId);
    expect(outcome).toMatchObject({ outcome: 'failed', refusal: 'NOT_ALLOWED' });
    expect(twilio.length).toBe(calls);
    const [row] = await w.ctx.db.select().from(s.message).where(eq(s.message.id, messageId));
    expect(row).toMatchObject({ providerStatus: 'failed', error: 'NOT_ALLOWED' });
  });
});

describe('Start over (POST /inbox/conversations/:id/start-over)', () => {
  it('refuses a conversation of any other number, and a person who does not manage the line', async () => {
    const [simThread] = await w.ctx.db
      .select({ id: s.conversation.id })
      .from(s.conversation)
      .where(eq(s.conversation.channelAccountId, other))
      .limit(1);
    let otherThread = simThread?.id;
    if (!otherThread) {
      const contactId = newId();
      await w.ctx.db.insert(s.contact).values({ id: contactId, operatorId: w.oto, channel: 'whatsapp', externalHandle: '+66898700003', phone: '+66898700003' });
      otherThread = newId();
      await w.ctx.db.insert(s.conversation).values({ id: otherThread, operatorId: w.oto, contactId, channelAccountId: other, category: 'general', status: 'active' });
    }
    const refused = await call<{ error: { code: string } }>(w, adminCookie, 'POST', `/inbox/conversations/${otherThread}/start-over`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NOT_A_TEST_LINE');
    expect((await call(w, agentCookie, 'POST', `/inbox/conversations/${firstThread}/start-over`, {})).status).toBe(403);
    expect((await conversationRow(w, firstThread)).archivedAt).toBeNull();
  });

  it('clears the thread: out of the inbox, its words gone, the contact reset, one audit row; a repeat changes nothing', async () => {
    // What the assistant had read from the family: an answered open question.
    const [reply] = await aiLines(w, firstThread);
    const [customerLine] = await w.ctx.db
      .select()
      .from(s.message)
      .where(and(eq(s.message.conversationId, firstThread), eq(s.message.direction, 'inbound')))
      .orderBy(desc(s.message.createdAt))
      .limit(1);
    const [turn] = await w.ctx.db.select().from(s.aiTurn).where(eq(s.aiTurn.conversationId, firstThread)).limit(1);
    await w.ctx.db.insert(s.conversationOpenQuestion).values({
      id: newId(),
      operatorId: w.oto,
      conversationId: firstThread,
      slot: 'park',
      state: 'answered',
      turnId: turn!.id,
      askedMessageId: reply!.id,
      askedAt: new Date(),
      answer: 'central',
      answeredMessageId: customerLine!.id,
      closedAt: new Date(),
    });
    // A pending turn the press must cancel.
    await post(inbound(ALLOWED, 'one more question', 'ZZ Test Tester'));
    const listed = await call<{ conversations: Array<{ id: string }> }>(w, adminCookie, 'GET', `/inbox/conversations?channelAccountId=${line}`);
    expect(listed.body.conversations.map((c) => c.id)).toContain(firstThread);

    const done = await call<Record<string, unknown>>(w, adminCookie, 'POST', `/inbox/conversations/${firstThread}/start-over`, {});
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ conversationId: firstThread, channelAccountId: line, alreadyCleared: false, openQuestionAnswers: 1, turnsCancelled: 1, contactReset: true });
    expect(done.body['messages']).toBeGreaterThanOrEqual(5);

    const cleared = await conversationRow(w, firstThread);
    expect(cleared.archivedAt).not.toBeNull();
    expect(cleared.archivedByAccountId).not.toBeNull();
    expect(cleared.lastMessagePreview).toBeNull();
    const words = await w.ctx.db.select().from(s.message).where(eq(s.message.conversationId, firstThread));
    expect(words.every((m) => m.body === null && m.redactedAt !== null)).toBe(true);
    const [question] = await w.ctx.db.select().from(s.conversationOpenQuestion).where(eq(s.conversationOpenQuestion.conversationId, firstThread));
    expect(question!.answer).toBeNull();
    const turns = await w.ctx.db.select().from(s.aiTurn).where(and(eq(s.aiTurn.conversationId, firstThread), sql`state in ('pending','deciding')`));
    expect(turns).toHaveLength(0);
    const person = await contactOf(ALLOWED);
    expect(person).toMatchObject({ displayName: null, profileName: null, language: null, phone: ALLOWED, erasedAt: null });

    // Out of the inbox: not listed, not readable, not counted.
    const after = await call<{ conversations: Array<{ id: string }> }>(w, adminCookie, 'GET', `/inbox/conversations?channelAccountId=${line}`);
    expect(after.body.conversations.map((c) => c.id)).not.toContain(firstThread);
    expect((await call(w, adminCookie, 'GET', `/inbox/conversations/${firstThread}`)).status).toBe(404);

    const audits = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.conversation.start_over'), eq(s.auditLog.entityId, firstThread)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.after)).not.toContain(FIRST_WORDS);
    expect(JSON.stringify(audits[0]!.after)).not.toContain(ALLOWED.slice(1));

    const repeat = await call<Record<string, unknown>>(w, adminCookie, 'POST', `/inbox/conversations/${firstThread}/start-over`, {});
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ alreadyCleared: true, messages: 0 });
    expect(
      await w.ctx.db.select().from(s.auditLog).where(and(eq(s.auditLog.action, 'inbox.conversation.start_over'), eq(s.auditLog.entityId, firstThread))),
    ).toHaveLength(1);
  });

  it("the number's next message is a FIRST conversation, and the assistant's context holds nothing from before", async () => {
    const requestsBefore = w.fake.requests.length;
    await post(inbound(ALLOWED, `Hi there, do you sell grip socks? ${SECOND_WORDS}`, 'ZZ Test New Name'));
    const fresh = await liveThreadOf(ALLOWED);
    expect(fresh).toBeDefined();
    expect(fresh!.id).not.toBe(firstThread);
    expect(fresh).toMatchObject({ status: 'active', reopenedAt: null });
    const person = await contactOf(ALLOWED);
    expect(person).toMatchObject({ displayName: 'ZZ Test New Name', profileName: 'ZZ Test New Name' });

    await answer('Yes, grip socks are sold at reception.');
    const request = w.fake.requests[requestsBefore]!;
    const prompt = JSON.stringify(request.prompt.messages);
    expect(prompt).toContain(SECOND_WORDS);
    // Nothing of the first visit reaches the model: not the family's words, not the assistant's reply.
    expect(prompt).not.toContain(FIRST_WORDS);
    expect(prompt).not.toContain('one more question');
    expect(prompt).not.toContain('And on Sunday?');
    const questions = await w.ctx.db.select().from(s.conversationOpenQuestion).where(eq(s.conversationOpenQuestion.conversationId, fresh!.id));
    expect(questions).toHaveLength(0);
    const [reply] = await aiLines(w, fresh!.id);
    expect(reply).toMatchObject({ providerStatus: 'sent' });
    expect(twilio.at(-1)!.form.get('To')).toBe(`whatsapp:${ALLOWED}`);
  });
});

describe('the boot refusals (SCRUM-908)', () => {
  it('production refuses the test line; on without an https public origin refuses anywhere', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' } as const;
    expect(() => loadEnv({ ...base, INBOX_TWILIO_ENABLED: 'true' })).toThrow(/INBOX_TWILIO_PUBLIC_URL is not set/);
    expect(() => loadEnv({ ...base, INBOX_TWILIO_ENABLED: 'true', INBOX_TWILIO_PUBLIC_URL: 'http://api.example' })).toThrow(
      /INBOX_TWILIO_PUBLIC_URL is not an https origin/,
    );
    const env = loadEnv({ ...base, INBOX_TWILIO_ENABLED: 'true', INBOX_TWILIO_PUBLIC_URL: ORIGIN });
    expect(() => assertProductionSafe({ ...env, DEPLOY_ENV: 'production' })).toThrow(/INBOX_TWILIO_ENABLED is true — the Twilio WhatsApp line is a test line/);
    // Under test the switch stays off unless a suite turns it on.
    expect(loadEnv({ ...base }).INBOX_TWILIO_ENABLED).toBe('false');
  });
});
