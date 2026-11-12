import { randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditLog, otoappUsers, partyDepositRequest, schema as s } from '@oto/db';
import { TWIML_EMPTY, twilioSignature } from '@oto/messaging';
import { PartyDepositActionAnswerSchema, PartyDepositAnswerSchema, newId } from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import { runInboxSendJob } from '../src/services/inbox/send';
import type { DirectoryEventEditAnswer, DirectoryOutcome, OtoAppDirectory } from '../src/services/otoapp-directory';
import { runPartyDepositFollowUpJob } from '../src/services/party-deposit';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  teardownAll,
  type TestContext,
} from './helpers';
import { call, staff, type AiWorld } from './inbox-ai-support';

/**
 * SCRUM-908 — START OVER ON A TEST-LINE CHAT A PARTY WAS BOOKED FROM. The
 * first-line classifier files a test line's birthday opener under Birthdays &
 * Events, Book Date works there, and the owner's demo tests every case. Start
 * over must not leave the party posting into a thread nobody can open, nor
 * keep writing to the tester on WhatsApp:
 *
 *   - the thread lets go of the party (`event_order_ref` cleared, the old id
 *     in the start_over audit row's `before`); the BEO reads "no conversation";
 *   - every press that would post to the family's chat is refused
 *     PARTY_NO_CONVERSATION: Request deposit, Resend, the menu link, the
 *     choices received — and Twilio is never called;
 *   - a line the party still owes on its own (the reminder, the paid
 *     confirmation) is kept on the cleared thread and never sent
 *     (`CONVERSATION_CLEARED`), and the family's payment still SETTLES: the
 *     confirmation is posted inside the settlement, which a refusal there
 *     would roll back;
 *   - the number's next message is a new thread, not linked to the party.
 *
 * Twilio is answered by a stub (anything else is "no network"), the payment
 * gateway is the in-process simulator, the OTO App's directory a stand-in.
 * FICTIONAL DATA: +668987001NN numbers, zero-run SIDs, a token that says it
 * is not real.
 */

const ORIGIN = 'https://api.staging.example';
const SID = `AC${'0'.repeat(31)}9`;
const TOKEN = 'zz-test-auth-token-not-a-real-one-908b';
const ALLOWED = '+66898700101';
const SENDER = '+66898700199';
const REF = 'ZZPARTY';
const KEY = 'zz-test-private-party-key-908';
const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOTESTMERCHANT';
const WEBHOOK_TOKEN = 'a-path-filter-not-a-credential-908';
const PARTY_DAY = '2026-11-18';
const THB_3000 = 300_000;
const SETTINGS = {
  [`INBOX_TWILIO_ACCOUNT_SID_${REF}`]: SID,
  [`INBOX_TWILIO_AUTH_TOKEN_${REF}`]: TOKEN,
  [`INBOX_TWILIO_ALLOWED_NUMBERS_${REF}`]: ALLOWED,
};

let ctx: TestContext;
let operatorId: string;
let central: string;
let line: string;
let adminCookie: string;
let presser: string;
let appTenant: string;
let appPark: string;
const twilio: Array<{ form: URLSearchParams }> = [];
let smSeq = 0;
let msgSeq = 0;

/** The OTO App's directory, standing in: every write-back accepted. */
const directory: OtoAppDirectory = {
  configured: true,
  async checkinAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async addAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async editEvent(eventId, body): Promise<DirectoryOutcome<DirectoryEventEditAnswer>> {
    return {
      ok: true,
      status: 200,
      body: { edit: { id: body.id, eventId, editedAt: body.editedAt, fields: Object.keys(body.fields) }, event: { id: eventId, updatedAt: new Date().toISOString() }, replayed: false },
    };
  },
  async notify(body) {
    return { ok: true, status: 200, body: { notification: { id: body.id, recipientUserId: body.recipientUserId, type: 'inbox_handover', createdAt: new Date().toISOString() }, replayed: false } };
  },
};

beforeAll(async () => {
  // The line's settings are read by NAME from the process environment when the app is built.
  for (const [k, v] of Object.entries(SETTINGS)) process.env[k] = v;
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    if (url !== `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`) {
      throw new Error(`no network in this suite: ${url}`);
    }
    twilio.push({ form: new URLSearchParams(init.body ?? '') });
    smSeq += 1;
    return new Response(JSON.stringify({ sid: `SM${String(smSeq).padStart(32, '0')}`, status: 'queued' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  });
  const env: Record<string, string> = {
    PROCESS_ROLES: 'api,jobs',
    PGW_PROVIDER: 'simulator',
    PAYMENTS_SIMULATOR: 'on',
    PGW_MERCHANT_ID: MERCHANT,
    PGW_SECRET_KEY: SECRET,
    PGW_WEBHOOK_SECRET: WEBHOOK_TOKEN,
    PGW_BACKEND_RETURN_URL: `https://api.zz-test.example/webhooks/2c2p/payment?t=${WEBHOOK_TOKEN}`,
    INBOX_TWILIO_ENABLED: 'true',
    INBOX_TWILIO_PUBLIC_URL: ORIGIN,
  };
  ctx = await createTestContext({ otoapp: true, env });
  operatorId = await operatorIdByName(ctx.db, 'OTO');
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(KEY)}`;
  await ctx.restart();
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;

  // The app's park, anchored to Central, and the person who presses in the BEO.
  appTenant = newId();
  appPark = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'ZZ TEST 908', ${`zz-908-${appTenant}`})`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appPark}, ${appTenant}, 'ZZ TEST 908 park', 'Phuket', ${central})`);
  const [rec] = await ctx.db.select({ id: s.account.id }).from(s.account).where(eq(s.account.phone, RECEPTION.phone)).limit(1);
  presser = newId();
  await ctx.db.insert(otoappUsers).values({
    id: presser,
    email: `zz-908-${presser}@example.test`,
    password: 'not-a-real-hash',
    fullName: 'ZZ TEST 908 staff',
    role: 'manager',
    isActive: true,
    mustChangePassword: false,
    platformUserId: rec!.id,
  });
  await ctx.db.execute(
    sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope) values (${newId()}, ${appTenant}, ${presser}, ${appPark}, 'selected_branches')`,
  );

  // The test line, on an invented number (no sandbox pace in the checks), the assistant off.
  line = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: line,
    operatorId,
    branchId: null,
    channel: 'whatsapp',
    provider: 'twilio',
    externalId: SENDER,
    displayName: 'ZZ TEST WhatsApp test line 908b',
    credentialRef: REF,
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
    aiMode: 'off',
  });
  // staff() and call() read only the context and the operator of an AiWorld.
  const w = { ctx, oto: operatorId } as unknown as AiWorld;
  [, adminCookie] = await staff(w, '+66898700151', 'ZZ TEST Inbox Admin 908b', 'inbox_admin', { scopeType: 'operator', scopeId: operatorId });
}, 300_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(SETTINGS)) delete process.env[k];
  await ctx?.close();
  await teardownAll();
});

// --- The doors -------------------------------------------------------------------------

const nextSid = () => `SM${String(++msgSeq).padStart(28, '0')}9080`;

/** An incoming WhatsApp message as Twilio posts it, signed over the configured origin. */
async function inbound(body: string) {
  const sid = nextSid();
  const fields: Array<[string, string]> = [
    ['SmsMessageSid', sid],
    ['NumMedia', '0'],
    ['ProfileName', 'ZZ Test Party Tester'],
    ['MessageType', 'text'],
    ['SmsSid', sid],
    ['WaId', ALLOWED.slice(1)],
    ['SmsStatus', 'received'],
    ['Body', body],
    ['To', `whatsapp:${SENDER}`],
    ['NumSegments', '1'],
    ['MessageSid', sid],
    ['AccountSid', SID],
    ['From', `whatsapp:${ALLOWED}`],
    ['ApiVersion', '2010-04-01'],
  ];
  const path = `/webhooks/inbox/twilio/${line}`;
  const res = await ctx.app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(TOKEN, `${ORIGIN}${path}`, fields) },
    payload: new URLSearchParams(fields).toString(),
  });
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(TWIML_EMPTY);
}

async function liveThread(): Promise<string | undefined> {
  const [row] = await ctx.db
    .select({ id: s.conversation.id })
    .from(s.conversation)
    .innerJoin(s.contact, eq(s.contact.id, s.conversation.contactId))
    .where(and(eq(s.conversation.channelAccountId, line), eq(s.contact.phone, ALLOWED), isNull(s.conversation.archivedAt)))
    .limit(1);
  return row?.id;
}

const headersOf = (idem: string | null = newId()) => ({ authorization: `Bearer ${KEY}`, ...(idem === null ? {} : { 'idempotency-key': idem }) });

const readDeposit = (eventId: string) =>
  ctx.app.inject({ method: 'GET', url: `/otoapp/parties/${eventId}/deposit-request`, headers: headersOf(null) });
const requestDeposit = (eventId: string) =>
  ctx.app.inject({ method: 'POST', url: `/otoapp/parties/${eventId}/deposit-request`, headers: headersOf(), payload: { amountSatang: THB_3000, actorAppUserId: presser } });
const resend = (eventId: string, requestId: string) =>
  ctx.app.inject({ method: 'POST', url: `/otoapp/parties/${eventId}/deposit-request/${requestId}/resend`, headers: headersOf(), payload: { actorAppUserId: presser } });
const menuLink = (eventId: string) =>
  ctx.app.inject({ method: 'POST', url: `/otoapp/parties/${eventId}/menu-link`, headers: headersOf(), payload: { link: 'https://app.zz-test.example/menu-select/908', actorAppUserId: presser } });
const menuReceived = (eventId: string) =>
  ctx.app.inject({ method: 'POST', url: `/otoapp/parties/${eventId}/menu-received`, headers: headersOf(), payload: {} });

/** A birthday in the OTO App, linked to the thread both ways as Book Date links it. */
async function partyOf(conversationId: string): Promise<string> {
  const eventId = newId();
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      num_children, num_adults, location_text, status, inbox_conversation_id, created_at, updated_at)
    values (
      ${eventId}, ${appTenant}, ${appPark}, 'birthday', 'ZZ TEST 908 party', ${PARTY_DAY}, '13:00', '16:00',
      10, 4, 'Party room 1', 'upcoming', ${conversationId}, now() at time zone 'UTC', now() at time zone 'UTC')`);
  await ctx.db.update(s.conversation).set({ eventOrderRef: eventId, category: 'birthdays' }).where(eq(s.conversation.id, conversationId));
  return eventId;
}

async function aiLinesOf(conversationId: string) {
  return ctx.db
    .select()
    .from(s.message)
    .where(and(eq(s.message.conversationId, conversationId), eq(s.message.authorKind, 'ai')))
    .orderBy(asc(s.message.createdAt), asc(s.message.id));
}

const followUp = (now: Date) =>
  runPartyDepositFollowUpJob(ctx.db, ctx.app.env, { sender: { channels: ctx.app.inboxChannels, storage: null }, directory, log: ctx.app.log }, now);

// --- The case ----------------------------------------------------------------------------

describe('Start over on a test-line chat a party was booked from (SCRUM-908)', () => {
  let thread: string;
  let eventId: string;
  let requestId: string;
  let attemptId: string;

  it('before: the party is linked, and its deposit request reaches the tester through Twilio', async () => {
    await inbound('Hi! A birthday party for my son please');
    thread = (await liveThread())!;
    expect(thread).toBeDefined();
    eventId = await partyOf(thread);
    const made = await requestDeposit(eventId);
    expect(made.statusCode, made.body).toBe(200);
    const answer = PartyDepositActionAnswerSchema.parse(made.json());
    requestId = answer.request.id;
    const [row] = await ctx.db.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, requestId));
    attemptId = row!.paymentAttemptId;
    const [requestLine] = await aiLinesOf(thread);
    expect(requestLine).toMatchObject({ providerStatus: 'sent' });
    expect(twilio.at(-1)!.form.get('To')).toBe(`whatsapp:${ALLOWED}`);
    expect(PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json()).hasConversation).toBe(true);
  });

  it('Start over lets go of the party: the link cleared, the old id in the audit row', async () => {
    const done = await call<Record<string, unknown>>({ ctx } as unknown as AiWorld, adminCookie, 'POST', `/inbox/conversations/${thread}/start-over`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ alreadyCleared: false });
    const [conv] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, thread));
    expect(conv).toMatchObject({ eventOrderRef: null, bookingRef: null });
    expect(conv!.archivedAt).not.toBeNull();
    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'inbox.conversation.start_over'), eq(auditLog.entityId, thread)));
    expect(row!.before).toMatchObject({ eventOrderRef: eventId, bookingRef: null });
  });

  it('every press that would post to the chat is refused PARTY_NO_CONVERSATION, and Twilio is never called', async () => {
    const calls = twilio.length;
    const linesBefore = (await aiLinesOf(thread)).length;
    expect(PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json()).hasConversation).toBe(false);
    for (const res of [await resend(eventId, requestId), await menuLink(eventId), await menuReceived(eventId)]) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('PARTY_NO_CONVERSATION');
    }
    expect(twilio.length).toBe(calls);
    expect((await aiLinesOf(thread)).length).toBe(linesBefore);
  });

  it("the party's own reminder is kept on the cleared thread and never sent", async () => {
    const calls = twilio.length;
    const [row] = await ctx.db.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, requestId));
    const due = new Date(row!.requestedAt.getTime() + (ctx.app.env.PARTY_DEPOSIT_REMINDER_MIN + 1) * 60_000);
    await followUp(due);
    // The line is due at the sweep's time, past this clock: the send job, at that time, is what sends it.
    await runInboxSendJob(ctx.db, { channels: ctx.app.inboxChannels, now: () => due }, due);
    const [after] = await ctx.db.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, requestId));
    expect(after!.reminderMessageId).not.toBeNull();
    const [reminder] = await ctx.db.select().from(s.message).where(eq(s.message.id, after!.reminderMessageId!));
    expect(reminder).toMatchObject({ conversationId: thread, providerStatus: 'failed', error: 'CONVERSATION_CLEARED' });
    expect(twilio.length).toBe(calls);
  });

  it("the family's payment still settles; its confirmation is kept on the cleared thread and never sent", async () => {
    const calls = twilio.length;
    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/2c2p/hosted/${attemptId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=pay',
    });
    expect([200, 302, 303]).toContain(paid.statusCode);
    const [after] = await ctx.db.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, requestId));
    expect(after).toMatchObject({ state: 'paid', depositAfterSatang: THB_3000 });
    expect(after!.paidMessageId).not.toBeNull();
    const [confirmation] = await ctx.db.select().from(s.message).where(eq(s.message.id, after!.paidMessageId!));
    expect(confirmation).toMatchObject({ conversationId: thread, providerStatus: 'failed', error: 'CONVERSATION_CLEARED' });
    expect(twilio.length).toBe(calls);
  });

  it("the number's next message is a new thread, not linked to the party", async () => {
    await inbound('Hello again, a new question');
    const fresh = await liveThread();
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(thread);
    const [conv] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, fresh!));
    expect(conv!.eventOrderRef).toBeNull();
    expect(PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json()).hasConversation).toBe(false);
  });
});
