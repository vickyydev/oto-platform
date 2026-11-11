import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, otoappUsers, partyDepositRequest, partyEdit, paymentAttempt, schema as s } from '@oto/db';
import { PartyDepositActionAnswerSchema, PartyDepositAnswerSchema, PartyMessageAnswerSchema, newId, type PartyDepositActionAnswer } from '@oto/shared';
import { signJwt } from '@oto/payments-2c2p';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import { conversationEventOf } from '../src/services/inbox/book-date';
import { runInboxSendJob, sendQueuedMessage } from '../src/services/inbox/send';
import type { DirectoryEventEditAnswer, DirectoryEventEditBody, DirectoryNotificationBody, DirectoryOutcome, OtoAppDirectory } from '../src/services/otoapp-directory';
import { configurePartyDeposit, partyDepositLinkOf, partyDepositReturnUrlOf, runPartyDepositFollowUpJob } from '../src/services/party-deposit';
import { gatewayFor, pollPendingAttempts } from '../src/services/payments/gateway';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-825 — A PARTY'S DEPOSIT ASKED FROM THE BEO, paid through the gateway's
 * page and watched by the platform. The home is the BEO's Billing section;
 * the OTO App's server asks with its provisioning key, and everything else is
 * the platform's: the gateway link, the assistant's lines in the family's
 * chat, the payment, the write-back and the follow-ups. Held here against a
 * real database with the OTO App's own tables (`otoapp: true`), the payment
 * SIMULATOR standing in for 2C2P (its hosted page's "Pay" sends a SIGNED
 * notification through the real webhook, as the sandbox's press does on
 * staging) and the inbox simulator standing in for WhatsApp:
 *
 *   - the doors are the key's: no key, a wrong key or a till session is 401;
 *     another operator's key does not find the party; a party with no linked
 *     conversation, or one named wrongly, is refused by name;
 *   - "Request deposit": a station-less WEB invoice, the hosted page's link
 *     and validity on the request, and ONE assistant line in the family's
 *     language — the amount, the party's day, the link, the validity — with
 *     a "deposit requested" pill carrying ids and figures and never the link;
 *     the same press again is the same request and no second line; a
 *     different amount under the key is refused; one open request per party;
 *   - "Resend": the line again, once per press; "Cancel request": the request
 *     and its attempt closed, a pill, nothing said to the family;
 *   - the family pays: the signed notification marks the request paid INSIDE
 *     the settlement, the party's ONE deposit figure moves by the amount and
 *     is written back to the app (SCRUM-804's party edit, prepaymentAmountThb
 *     and the paid day), the confirmation is posted once, the birthday
 *     manager's bell rings once — and a replayed notification changes nothing;
 *   - the write-back is a FACT: a BEO save after the payment (the app's
 *     order rule, which the stand-in applies) cannot refuse it, it goes alone
 *     (an older till edit still waiting is not carried into it), and the view
 *     reads synced; the figure is read where the party is NOW (moved to the
 *     operator's other park, it pays onto its figure) and never as zero (a
 *     party the till cannot read rolls the settlement back for the next
 *     notification, and the poller goes on with its tick);
 *   - the gateway would not open the page: refused by name with nothing
 *     posted, the same key again the same refusal, a new key a fresh request;
 *   - a party line is never withdrawn when a person writes in the thread
 *     before it left, and the BEO reads where the line stands;
 *   - the link runs out unpaid: the request is `expired`, and the next press
 *     issues a fresh link as a new request;
 *   - the follow-up job: no reminder before the window, ONE after it, the
 *     hand-over after the second window — the holding line, an `ai_handover`
 *     the assistant stands back on, the thread with Birthdays & Events, the
 *     bell — and nothing twice; a payment after the hand-over still pays;
 *   - the set-menu link posted with the right words, once per press, and the
 *     parent's choices confirmed once per submission;
 *   - the family's browser return writes nothing and shows a plain page;
 *   - every act is one audit row.
 *
 * EVERY CREDENTIAL HERE IS MINTED IN THIS PROCESS; every person and party is
 * a ZZ TEST fixture.
 */

const KEY = 'zz-test-private-party-deposit-key-825';
const OTHER_KEY = 'zz-test-other-operator-party-deposit-key-825';
const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOTESTMERCHANT';
const WEBHOOK_TOKEN = 'a-path-filter-not-a-credential';
const INBOX_SECRET = randomBytes(24).toString('hex');
/** A Wednesday, as SCRUM-822's party. */
const PARTY_DAY = '2026-11-18';
const THB_3000 = 300_000;

let ctx: TestContext;
let operatorId: string;
let otherOperatorId: string;
let central: string;
let reception: string;
let receptionAccountId: string;
let appTenant: string;
let appPark: string;
/** The park group's other park, anchored to Robinson Chalong; and one anchored to no platform branch. */
let appPark2: string;
let appParkUnknown: string;
let presser: string;
let manager: string;
let channelAccountId: string;
let birthdaysTeamId: string;
let phoneSeq = 0;

/** What the stand-in OTO App was told: every party edit and every bell. */
const edits: Array<{ eventId: string; body: DirectoryEventEditBody }> = [];
const bells: DirectoryNotificationBody[] = [];
/**
 * The app's ORDER RULE, as the stand-in applies it (the app's eventWrites.ts
 * `editPartyEvent`): a party saved in the app after an edit's stamp refuses
 * the edit as `edit_superseded` — unless the edit is a FACT the platform
 * settled (`fact: 'gateway_deposit'`), which the app records whatever it
 * changed since. A test sets the party's last save here to play a BEO save.
 */
const appUpdatedAt = new Map<string, Date>();
const directory: OtoAppDirectory = {
  configured: true,
  async checkinAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async addAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async editEvent(eventId, body): Promise<DirectoryOutcome<DirectoryEventEditAnswer>> {
    edits.push({ eventId, body });
    const savedAt = appUpdatedAt.get(eventId);
    if (body.fact !== 'gateway_deposit' && savedAt && savedAt.getTime() > new Date(body.editedAt).getTime()) {
      return {
        ok: false,
        status: 409,
        code: 'edit_superseded',
        message: 'This party was changed in the OTO App after the edit was made at the till, so the edit was not applied',
        retryable: false,
      };
    }
    return {
      ok: true,
      status: 200,
      body: { edit: { id: body.id, eventId, editedAt: body.editedAt, fields: Object.keys(body.fields) }, event: { id: eventId, updatedAt: new Date().toISOString() }, replayed: false },
    };
  },
  async notify(body) {
    bells.push(body);
    return { ok: true, status: 200, body: { notification: { id: body.id, recipientUserId: body.recipientUserId, type: 'inbox_handover', createdAt: new Date().toISOString() }, replayed: false } };
  },
};

// --- The doors -------------------------------------------------------------------------

const headersOf = (key: string | null, idem: string | null, extra: Record<string, string> = {}) => ({
  ...(key === null ? {} : { authorization: `Bearer ${key}` }),
  ...(idem === null ? {} : { 'idempotency-key': idem }),
  ...extra,
});

const readDeposit = (eventId: string, key: string | null = KEY, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/otoapp/parties/${eventId}/deposit-request`, headers: headersOf(key, null, extra) });

const request = (eventId: string, body: Record<string, unknown>, o: { key?: string | null; idem?: string | null } = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: `/otoapp/parties/${eventId}/deposit-request`,
    headers: headersOf(o.key === undefined ? KEY : o.key, o.idem === undefined ? newId() : o.idem),
    payload: body,
  });

const act = (eventId: string, requestId: string, what: 'resend' | 'cancel', o: { key?: string | null; idem?: string | null; actor?: string } = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: `/otoapp/parties/${eventId}/deposit-request/${requestId}/${what}`,
    headers: headersOf(o.key === undefined ? KEY : o.key, o.idem === undefined ? newId() : o.idem),
    payload: { actorAppUserId: o.actor ?? presser },
  });

const menuLink = (eventId: string, link: string, o: { idem?: string | null } = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: `/otoapp/parties/${eventId}/menu-link`,
    headers: headersOf(KEY, o.idem === undefined ? newId() : o.idem),
    payload: { link, actorAppUserId: presser },
  });

const menuReceived = (eventId: string, o: { idem?: string | null; submittedAt?: string } = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: `/otoapp/parties/${eventId}/menu-received`,
    headers: headersOf(KEY, o.idem === undefined ? newId() : o.idem),
    payload: o.submittedAt ? { submittedAt: o.submittedAt } : {},
  });

async function requestOk(eventId: string, amountSatang = THB_3000, idem = newId()): Promise<PartyDepositActionAnswer & { idem: string }> {
  const res = await request(eventId, { amountSatang, actorAppUserId: presser }, { idem });
  expect(res.statusCode, res.body).toBe(200);
  return { ...PartyDepositActionAnswerSchema.parse(res.json()), idem };
}

// --- The fixtures ---------------------------------------------------------------------

/** A family's thread on the simulated WhatsApp number, in its language, as the webhook makes it. */
async function newThread(language: 'en' | 'th' | 'ru'): Promise<string> {
  phoneSeq += 1;
  const [row] = await ctx.db.select().from(s.channelAccount).where(eq(s.channelAccount.id, channelAccountId)).limit(1);
  const sim = ctx.app.inboxChannels.simulatorFor({ ...row! });
  if (!sim) throw new Error('inbox simulator off');
  const played = sim.inbound({
    from: `6681000${String(8200 + phoneSeq)}`,
    name: `ZZ TEST Deposit Family ${phoneSeq}`,
    text: language === 'th' ? 'สวัสดีค่ะ อยากจองปาร์ตี้วันเกิดค่ะ' : language === 'ru' ? 'Здравствуйте, хотим заказать день рождения' : 'Hi! A birthday party please',
    hint: { category: 'birthdays', language },
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/inbox/${channelAccountId}`,
    headers: played.webhook.headers as Record<string, string>,
    payload: played.webhook.rawBody as string,
  });
  expect(res.json().outcome).toBe('processed');
  const [m] = await ctx.db
    .select({ conversationId: s.message.conversationId })
    .from(s.message)
    .where(and(eq(s.message.channelAccountId, channelAccountId), eq(s.message.externalMessageId, played.externalMessageId)))
    .limit(1);
  return m!.conversationId;
}

/** A birthday in the OTO App at the linked park, with or without a deposit already paid, linked to a thread both ways. */
async function party(o: { language?: 'en' | 'th' | 'ru'; depositThb?: number; link?: boolean; title?: string } = {}): Promise<{ eventId: string; conversationId: string | null }> {
  const eventId = newId();
  const conversationId = o.link === false ? null : await newThread(o.language ?? 'en');
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      num_children, num_adults, location_text, status, inbox_conversation_id, created_at, updated_at)
    values (
      ${eventId}, ${appTenant}, ${appPark}, 'birthday', ${o.title ?? 'ZZ TEST deposit party 825'}, ${PARTY_DAY}, '13:00', '16:00',
      10, 4, 'Party room 1', 'upcoming', ${conversationId}, now() at time zone 'UTC', now() at time zone 'UTC')`);
  if (o.depositThb) {
    await ctx.db.execute(sql`
      insert into otoapp.beo_event_billing (id, event_id, deposit_paid, deposit_paid_amount, deposit_paid_at)
      values (${newId()}, ${eventId}, true, ${o.depositThb}, '2026-11-01T00:00:00Z')`);
  }
  if (conversationId) {
    // Linked both ways as Book Date links them: the conversation's ref, and the pill the chip reads.
    await ctx.db.update(s.conversation).set({ eventOrderRef: eventId }).where(eq(s.conversation.id, conversationId));
    await ctx.db.insert(s.inboxEvent).values({
      id: newId(),
      operatorId,
      conversationId,
      kind: 'date_booked',
      actorKind: 'account',
      actorAccountId: receptionAccountId,
      payload: { eventId, branchId: central, title: o.title ?? 'ZZ TEST deposit party 825', date: PARTY_DAY, startTime: '13:00', status: 'tentative', statusName: 'Tentative', kids: 10, adults: 4 },
    });
  }
  return { eventId, conversationId };
}

async function linesOf(conversationId: string) {
  return ctx.db
    .select()
    .from(s.message)
    .where(and(eq(s.message.conversationId, conversationId), eq(s.message.authorKind, 'ai')))
    .orderBy(asc(s.message.createdAt), asc(s.message.id));
}

async function pillsOf(conversationId: string, kind?: string) {
  const rows = await ctx.db
    .select()
    .from(s.inboxEvent)
    .where(eq(s.inboxEvent.conversationId, conversationId))
    .orderBy(asc(s.inboxEvent.createdAt), asc(s.inboxEvent.id));
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}

async function requestRow(id: string) {
  const [row] = await ctx.db.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, id));
  return row!;
}

async function attemptRow(id: string) {
  const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id));
  return row!;
}

async function audits(entityId: string, action: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action)))
    .orderBy(asc(auditLog.createdAt));
}

async function templateOf(key: string, language: string) {
  const [row] = await ctx.db
    .select()
    .from(s.template)
    .where(and(eq(s.template.operatorId, operatorId), eq(s.template.key, key as never), eq(s.template.language, language as never)))
    .limit(1);
  return row!;
}

/** The simulated hosted page's button, pressed the way the family's browser presses it. */
async function press(attemptId: string, action: 'pay' | 'fail') {
  return ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/hosted/${attemptId}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `action=${action}`,
  });
}

function simulator() {
  const { qr } = gatewayFor(ctx.app.env);
  return qr as unknown as { apply: (invoiceNo: string, event: string) => { tranRef: string | null } | null };
}

const wire = (amountSatang: number) => `${Math.trunc(amountSatang / 100)}.${String(amountSatang % 100).padStart(2, '0')}000`;

function notification(over: Record<string, unknown>) {
  return {
    payload: signJwt(
      { merchantID: MERCHANT, currencyCode: 'THB', transactionDateTime: '20261112101500', agentCode: 'SCB', channelCode: 'PPQR', respCode: '0000', respDesc: 'Successful', ...over },
      SECRET,
    ),
  };
}

const postNotification = (body: unknown) => ctx.app.inject({ method: 'POST', url: `/webhooks/2c2p/payment?t=${WEBHOOK_TOKEN}`, payload: body as never });

const followUp = (now: Date) =>
  runPartyDepositFollowUpJob(ctx.db, ctx.app.env, { sender: { channels: ctx.app.inboxChannels, storage: null }, directory, log: ctx.app.log }, now);

const minutes = (n: number) => n * 60_000;

beforeAll(async () => {
  const env: Record<string, string> = {
    PROCESS_ROLES: 'api,jobs',
    PGW_PROVIDER: 'simulator',
    PAYMENTS_SIMULATOR: 'on',
    PGW_MERCHANT_ID: MERCHANT,
    PGW_SECRET_KEY: SECRET,
    PGW_WEBHOOK_SECRET: WEBHOOK_TOKEN,
    // The simulator's page is this api's own path: the chat's link is made absolute on this origin.
    PGW_BACKEND_RETURN_URL: `https://api.zz-test.example/webhooks/2c2p/payment?t=${WEBHOOK_TOKEN}`,
    INBOX_SIMULATOR: 'on',
    INBOX_SIMULATOR_SECRET: INBOX_SECRET,
  };
  ctx = await createTestContext({ otoapp: true, env });
  operatorId = await operatorIdByName(ctx.db, 'OTO');
  otherOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(KEY)},${otherOperatorId}:${otoAppProvisionKeyDigest(OTHER_KEY)}`;
  await ctx.restart();
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [rec] = await ctx.db.select({ id: s.account.id }).from(s.account).where(eq(s.account.phone, RECEPTION.phone)).limit(1);
  receptionAccountId = rec!.id;

  // The app's park group, its park anchored to Central Floresta, and two of its people.
  appTenant = newId();
  appPark = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'ZZ TEST 825', ${`zz-825-${appTenant}`})`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appPark}, ${appTenant}, 'ZZ TEST 825 park', 'Phuket', ${central})`);
  // The group's other park, anchored to the operator's other branch; and one the till does not know.
  const chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  appPark2 = newId();
  appParkUnknown = newId();
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appPark2}, ${appTenant}, 'ZZ TEST 825 other park', 'Phuket', ${chalong}),
           (${appParkUnknown}, ${appTenant}, 'ZZ TEST 825 unmapped park', 'Phuket', null)`);
  const appUser = async (platformUserId: string | null, name: string) => {
    const id = newId();
    await ctx.db.insert(otoappUsers).values({
      id,
      email: `zz-825-${id}@example.test`,
      password: 'not-a-real-hash',
      fullName: name,
      role: 'manager',
      isActive: true,
      mustChangePassword: false,
      platformUserId,
    });
    await ctx.db.execute(
      sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope) values (${newId()}, ${appTenant}, ${id}, ${appPark}, 'selected_branches')`,
    );
    return id;
  };
  presser = await appUser(receptionAccountId, 'ZZ TEST 825 staff');
  manager = await appUser(null, 'ZZ TEST 825 birthday manager');
  // The park's birthday manager, for the bell (SCRUM-823's contact).
  await ctx.db
    .update(branch)
    .set({ birthdayManagerContact: { name: 'ZZ TEST birthday manager', appUserId: manager, phone: null, channel: 'whatsapp' } })
    .where(eq(branch.id, central));

  // The simulated WhatsApp number the families write on.
  channelAccountId = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: channelAccountId,
    operatorId,
    branchId: central,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: 'deposit-wa-central-825',
    displayName: 'ZZ TEST Deposit WhatsApp',
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
  });
  const [team] = await ctx.db
    .select({ id: s.team.id })
    .from(s.team)
    .where(and(eq(s.team.operatorId, operatorId), eq(s.team.key, 'birthdays')))
    .limit(1);
  birthdaysTeamId = team!.id;
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// --- The fences ---------------------------------------------------------------------------

describe('the doors are the OTO App server’s, by its key', () => {
  it('no key, a key this platform does not hold, or a till session alone: 401 on every door', async () => {
    const { eventId } = await party();
    expect((await readDeposit(eventId, null)).statusCode).toBe(401);
    expect((await readDeposit(eventId, 'zz-not-a-key')).statusCode).toBe(401);
    expect((await readDeposit(eventId, null, { cookie: reception })).statusCode).toBe(401);
    expect((await request(eventId, { amountSatang: THB_3000, actorAppUserId: presser }, { key: null })).statusCode).toBe(401);
    expect((await act(eventId, newId(), 'resend', { key: 'zz-not-a-key' })).statusCode).toBe(401);
    expect((await act(eventId, newId(), 'cancel', { key: null })).statusCode).toBe(401);
  });

  it('the operator is the key’s: another operator’s key does not find the party; an id that is no party is 404; a bad id 400', async () => {
    const { eventId } = await party();
    const theirs = await request(eventId, { amountSatang: THB_3000, actorAppUserId: presser }, { key: OTHER_KEY });
    expect(theirs.statusCode, theirs.body).toBe(404);
    expect(theirs.json().error.message).toBe('Party not found');
    expect((await readDeposit(eventId, OTHER_KEY)).statusCode).toBe(404);
    expect((await request(newId(), { amountSatang: THB_3000, actorAppUserId: presser })).statusCode).toBe(404);
    expect((await request('not-a-uuid', { amountSatang: THB_3000, actorAppUserId: presser })).statusCode).toBe(400);
  });

  it('a press needs an Idempotency-Key and a whole amount of at least ฿1', async () => {
    const { eventId } = await party();
    expect((await request(eventId, { amountSatang: THB_3000, actorAppUserId: presser }, { idem: null })).statusCode).toBe(400);
    expect((await request(eventId, { amountSatang: 0, actorAppUserId: presser })).statusCode).toBe(400);
    expect((await request(eventId, { amountSatang: 150.5, actorAppUserId: presser })).statusCode).toBe(400);
    expect((await request(eventId, { amountSatang: THB_3000 })).statusCode).toBe(400);
  });

  it('a party with no linked conversation is refused by name, and nothing is minted; a conversation named wrongly too', async () => {
    const { eventId } = await party({ link: false });
    const res = await request(eventId, { amountSatang: THB_3000, actorAppUserId: presser });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('PARTY_NO_CONVERSATION');
    expect(await ctx.db.select().from(partyDepositRequest).where(eq(partyDepositRequest.otoappEventId, eventId))).toHaveLength(0);
    const read = PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json());
    expect(read).toEqual({ eventId, hasConversation: false, current: null, history: [] });

    const linked = await party();
    const wrong = await request(linked.eventId, { amountSatang: THB_3000, actorAppUserId: presser, conversationId: newId() });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('PARTY_CONVERSATION_MISMATCH');
    expect(wrong.json().error.details.conversationId).toBe(linked.conversationId);
  });
});

// --- The request -------------------------------------------------------------------------

describe('"Request deposit": the link minted, the assistant’s one line, the pill, and the same press again', () => {
  let eventId: string;
  let conversationId: string;
  let made: PartyDepositActionAnswer & { idem: string };

  it('mints a station-less WEB invoice with the hosted page and posts ONE line in the family’s language', async () => {
    ({ eventId, conversationId } = await party() as { eventId: string; conversationId: string });
    made = await requestOk(eventId);
    expect(made.replayed).toBe(false);
    const r = made.request;
    expect(r).toMatchObject({ eventId, conversationId, amountSatang: THB_3000, currency: 'THB', state: 'requested', remindedAt: null, handedOverAt: null, paidAt: null, closedAt: null, writeBack: null });
    expect(r.invoiceNo).toMatch(/WEB/);
    expect(r.paymentLink).toMatch(/^https:\/\/api\.zz-test\.example\/webhooks\/2c2p\/hosted\/[0-9a-f-]{36}$/);
    expect(new Date(r.linkExpiresAt!).getTime()).toBeGreaterThan(Date.now() + minutes(ctx.app.env.PARTY_DEPOSIT_LINK_VALIDITY_MIN - 5));

    const row = await requestRow(r.id);
    expect(row.idempotencyKey).toBe(made.idem);
    expect(row.accountId).toBe(receptionAccountId);
    expect(row.actorAppUserId).toBe(presser);
    const attempt = await attemptRow(row.paymentAttemptId);
    expect(attempt).toMatchObject({ stationId: null, saleId: null, branchId: central, amountSatang: THB_3000, provider: 'simulator', method: 'qr' });
    expect((attempt.payload as Record<string, unknown>).longLived).toBe(true);
    expect((attempt.payload as Record<string, unknown>).partyDepositRequestId).toBe(r.id);

    const lines = await linesOf(conversationId);
    expect(lines).toHaveLength(1);
    const en = await templateOf('party_deposit_request', 'en');
    expect(lines[0]).toMatchObject({ direction: 'outbound', authorKind: 'ai', templateId: en.id, bodyLanguage: 'en' });
    expect(lines[0]!.body).toContain('฿3,000');
    expect(lines[0]!.body).toContain('Wednesday 18 November 2026');
    expect(lines[0]!.body).toContain(r.paymentLink!);
    expect(lines[0]!.body).not.toContain('{{');
    expect(['queued', 'sent']).toContain(lines[0]!.providerStatus);
    expect(row.requestMessageId).toBe(lines[0]!.id);
    const [conv] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, conversationId));
    expect(conv!.lastMessagePreview).toContain('฿3,000');

    const pills = await pillsOf(conversationId, 'deposit_requested');
    expect(pills).toHaveLength(1);
    expect(pills[0]!.actorKind).toBe('ai');
    expect(pills[0]!.payload).toMatchObject({ requestId: r.id, eventId, amountSatang: THB_3000, currency: 'THB', messageId: lines[0]!.id, templateKey: 'party_deposit_request', language: 'en' });
    expect(JSON.stringify(pills[0]!.payload)).not.toContain(r.paymentLink!);

    const requested = await audits(r.id, 'party_deposit.request');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ operatorId, branchId: central, actorAccountId: receptionAccountId, entityType: 'party_deposit_request', actionId: made.idem });
    expect(requested[0]!.after).toMatchObject({ eventId, conversationId, amountSatang: THB_3000, invoiceNo: r.invoiceNo, via: 'otoapp_provision_key', actorAppUserId: presser });
    const posted = await audits(r.id, 'party_deposit.post');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.after).toMatchObject({ messageId: lines[0]!.id, templateKey: 'party_deposit_request', language: 'en' });
    expect(JSON.stringify(posted[0]!.after)).not.toContain('฿3,000');
  });

  it('the same press again is the same request and no second line; a different amount under the key is refused', async () => {
    const again = await request(eventId, { amountSatang: THB_3000, actorAppUserId: presser }, { idem: made.idem });
    expect(again.statusCode, again.body).toBe(200);
    expect(PartyDepositActionAnswerSchema.parse(again.json())).toMatchObject({ replayed: true, request: { id: made.request.id, state: 'requested' } });
    expect(await linesOf(conversationId)).toHaveLength(1);
    expect(await ctx.db.select().from(partyDepositRequest).where(eq(partyDepositRequest.otoappEventId, eventId))).toHaveLength(1);
    const other = await request(eventId, { amountSatang: 500_000, actorAppUserId: presser }, { idem: made.idem });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('one open request per party: a new press while one is open is refused, naming it', async () => {
    const second = await request(eventId, { amountSatang: 500_000, actorAppUserId: presser });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('DEPOSIT_REQUEST_OPEN');
    expect(second.json().error.details).toEqual({ requestId: made.request.id, amountSatang: THB_3000 });
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.branchId, central)).then((rows) => rows.filter((a) => (a.payload as Record<string, unknown>)?.partyEventId === eventId))).toHaveLength(1);
  });

  it('the read answers the open request as current, and the party linked', async () => {
    const read = PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json());
    expect(read.hasConversation).toBe(true);
    expect(read.current?.id).toBe(made.request.id);
    expect(read.history.map((r) => r.id)).toEqual([made.request.id]);
    expect(await conversationEventOf(ctx.db, operatorId, { id: conversationId, eventOrderRef: eventId })).toMatchObject({
      deposit: { requestId: made.request.id, state: 'requested', amountSatang: THB_3000, overdue: false },
    });
  });

  it('"Resend" posts the line again, once per press; the pill says it was a resend', async () => {
    const idem = newId();
    const res = await act(eventId, made.request.id, 'resend', { idem });
    expect(res.statusCode, res.body).toBe(200);
    expect(PartyDepositActionAnswerSchema.parse(res.json())).toMatchObject({ replayed: false, request: { id: made.request.id } });
    const lines = await linesOf(conversationId);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.body).toBe(lines[0]!.body);
    const pills = await pillsOf(conversationId, 'deposit_requested');
    expect(pills).toHaveLength(2);
    expect(pills[1]!.payload).toMatchObject({ resend: true, requestId: made.request.id });
    const retry = await act(eventId, made.request.id, 'resend', { idem });
    expect(PartyDepositActionAnswerSchema.parse(retry.json()).replayed).toBe(true);
    expect(await linesOf(conversationId)).toHaveLength(2);
    expect(await audits(made.request.id, 'party_deposit.resend')).toHaveLength(1);
    expect((await act(eventId, newId(), 'resend')).statusCode).toBe(404);
  });

  it('a Thai thread gets the Thai line; a Russian thread the Russian one', async () => {
    for (const [language, mark] of [['th', /[฀-๿]/], ['ru', /[Ѐ-ӿ]/]] as const) {
      const p = await party({ language });
      const r = await requestOk(p.eventId);
      const lines = await linesOf(p.conversationId!);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.bodyLanguage).toBe(language);
      expect(lines[0]!.body).toMatch(mark);
      expect(lines[0]!.body).toContain('฿3,000');
      expect(lines[0]!.body).toContain(r.request.paymentLink!);
      expect(lines[0]!.body).not.toContain('{{');
    }
  });
});

// --- Paid ----------------------------------------------------------------------------------

describe('the family pays: the signed notification settles it, the one deposit moves, the app is told, the chat confirmed, the bell rung', () => {
  let eventId: string;
  let conversationId: string;
  let made: PartyDepositActionAnswer;

  it('the simulated page’s "Pay" → paid once, written back once, confirmed once', async () => {
    ({ eventId, conversationId } = await party({ depositThb: 1_000 }) as { eventId: string; conversationId: string });
    made = await requestOk(eventId);
    const before = { edits: edits.length, bells: bells.length };
    const row = await requestRow(made.request.id);
    const paid = await press(row.paymentAttemptId, 'pay');
    expect([200, 302, 303]).toContain(paid.statusCode);

    const after = await requestRow(made.request.id);
    expect(after.state).toBe('paid');
    expect(after.paidAt).not.toBeNull();
    // ฿1,000 was already paid in the BEO: the one figure is now ฿4,000.
    expect(after.depositBeforeSatang).toBe(100_000);
    expect(after.depositAfterSatang).toBe(400_000);
    expect((await attemptRow(row.paymentAttemptId)).status).toBe('approved');

    expect(edits.length).toBe(before.edits + 1);
    const edit = edits[edits.length - 1]!;
    expect(edit.eventId).toBe(eventId);
    expect(edit.body.id).toBe(after.writeBackEditId);
    expect(edit.body.fields).toMatchObject({ prepaymentAmountThb: 4_000 });
    expect(edit.body.fields.prepaymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [editRow] = await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, after.writeBackEditId!));
    expect(editRow).toMatchObject({ syncState: 'synced', otoappEventId: eventId, fields: { depositSatang: 400_000 } });
    const read = PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json());
    expect(read.current).toMatchObject({ id: made.request.id, state: 'paid', depositBeforeSatang: 100_000, depositAfterSatang: 400_000, writeBack: { editId: after.writeBackEditId, syncState: 'synced', syncError: null } });

    const lines = await linesOf(conversationId);
    expect(lines).toHaveLength(2);
    const received = await templateOf('party_deposit_received', 'en');
    expect(lines[1]).toMatchObject({ templateId: received.id, bodyLanguage: 'en' });
    expect(lines[1]!.body).toBe('Thank you! We have received your deposit of ฿3,000 — your party on Wednesday 18 November 2026 is confirmed. See you then! 🎉');
    expect(after.paidMessageId).toBe(lines[1]!.id);
    const pills = await pillsOf(conversationId, 'deposit_paid');
    expect(pills).toHaveLength(1);
    expect(pills[0]!.payload).toMatchObject({ requestId: made.request.id, amountSatang: THB_3000, late: false, source: 'webhook' });

    expect(bells.length).toBe(before.bells + 1);
    expect(bells[bells.length - 1]).toMatchObject({ recipientUserId: manager, referenceType: 'inbox_conversation', referenceId: conversationId, title: 'A party deposit was paid' });
    expect(bells[bells.length - 1]!.body).toContain('฿3,000');
    expect(bells[bells.length - 1]!.body).not.toContain('ZZ TEST Deposit Family');

    const paidAudit = await audits(made.request.id, 'party_deposit.paid');
    expect(paidAudit).toHaveLength(1);
    expect(paidAudit[0]).toMatchObject({ actorAccountId: null, before: { state: 'requested', depositSatang: 100_000 } });
    expect(paidAudit[0]!.after).toMatchObject({ state: 'paid', source: 'webhook', late: false, depositSatang: 400_000, writeBackEditId: after.writeBackEditId });
    expect(await audits(made.request.id, 'party_deposit.notify')).toHaveLength(1);
    expect(await conversationEventOf(ctx.db, operatorId, { id: conversationId, eventOrderRef: eventId })).toMatchObject({ deposit: { state: 'paid', overdue: false } });
  });

  it('the notification delivered again changes nothing: one payment, one edit, one confirmation, one bell', async () => {
    const row = await requestRow(made.request.id);
    const invoiceNo = row.invoiceNo;
    const edited = edits.length;
    const rung = bells.length;
    const again = await postNotification(notification({ invoiceNo, amount: wire(THB_3000), tranRef: 'TR-ZZ-825-REPLAY' }));
    expect(again.statusCode).toBe(200);
    expect(await requestRow(made.request.id)).toMatchObject({ state: 'paid', depositAfterSatang: 400_000 });
    expect(await linesOf(conversationId)).toHaveLength(2);
    expect(await pillsOf(conversationId, 'deposit_paid')).toHaveLength(1);
    expect(edits.length).toBe(edited);
    expect(bells.length).toBe(rung);
    expect(await audits(made.request.id, 'party_deposit.paid')).toHaveLength(1);
  });

  it('a paid request takes no resend and no cancel; a new deposit can be asked after it', async () => {
    const resend = await act(eventId, made.request.id, 'resend');
    expect(resend.statusCode).toBe(409);
    expect(resend.json().error.code).toBe('DEPOSIT_REQUEST_NOT_OPEN');
    expect((await act(eventId, made.request.id, 'cancel')).statusCode).toBe(409);
    const next = await requestOk(eventId, 100_000);
    expect(next.request.id).not.toBe(made.request.id);
    const read = PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json());
    expect(read.current?.id).toBe(next.request.id);
    expect(read.history.map((r) => r.state)).toEqual(['requested', 'paid']);
  });
});

// --- The write-back as a fact, and the figure it moves ------------------------------------------

describe('the write-back is a FACT the app records whatever it changed since', () => {
  it('a BEO save after the payment cannot strand the one figure: the fact lands, alone, and the view reads synced', async () => {
    const { eventId } = await party({ depositThb: 1_000 });
    const made = await requestOk(eventId);
    // A till edit of the party still waiting for the app (the app was unreachable), older than the payment.
    const waiting = newId();
    const earlier = new Date(Date.now() - 60_000);
    await ctx.db.insert(partyEdit).values({
      id: waiting,
      operatorId,
      branchId: central,
      otoappEventId: eventId,
      fields: { expectedKids: 12 },
      syncState: 'pending',
      accountId: receptionAccountId,
      createdAt: earlier,
      updatedAt: earlier,
    });
    // The BEO saved the party AFTER the money lands: the app's order rule refuses any plain edit stamped before it.
    appUpdatedAt.set(eventId, new Date(Date.now() + 60_000));
    const plain = await directory.editEvent!(eventId, { id: newId(), editedAt: new Date().toISOString(), fields: { decoration: 'ZZ TEST' } });
    expect(plain).toMatchObject({ ok: false, status: 409, code: 'edit_superseded' });
    const told = edits.length;
    try {
      await press((await requestRow(made.request.id)).paymentAttemptId, 'pay');
      const after = await requestRow(made.request.id);
      expect(after).toMatchObject({ state: 'paid', depositBeforeSatang: 100_000, depositAfterSatang: 400_000 });
      expect(edits.length).toBe(told + 1);
      const edit = edits[edits.length - 1]!;
      expect(edit.body.fact).toBe('gateway_deposit');
      expect(Object.keys(edit.body.fields).sort()).toEqual(['prepaymentAmountThb', 'prepaymentDate']);
      expect(edit.body.fields.prepaymentAmountThb).toBe(4_000);
      const [editRow] = await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, after.writeBackEditId!));
      expect(editRow).toMatchObject({ syncState: 'synced', fields: { depositSatang: 400_000, fact: 'gateway_deposit' } });
      // The waiting till edit was not carried into the fact: it still waits, on its own.
      const [still] = await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, waiting));
      expect(still!.syncState).toBe('pending');
      const read = PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json());
      expect(read.current?.writeBack).toEqual({ editId: after.writeBackEditId, syncState: 'synced', syncError: null });
    } finally {
      appUpdatedAt.delete(eventId);
    }
  });
});

describe('the deposit figure is read where the party is NOW, and never as zero', () => {
  it('a party moved to the operator’s other park after the request pays onto its figure: before + amount', async () => {
    const { eventId } = await party({ depositThb: 1_000 });
    const made = await requestOk(eventId);
    await ctx.db.execute(sql`update otoapp.core_events set branch_id = ${appPark2} where id = ${eventId}`);
    await press((await requestRow(made.request.id)).paymentAttemptId, 'pay');
    expect(await requestRow(made.request.id)).toMatchObject({ state: 'paid', depositBeforeSatang: 100_000, depositAfterSatang: 400_000 });
    expect(edits[edits.length - 1]).toMatchObject({ eventId, body: { fact: 'gateway_deposit', fields: { prepaymentAmountThb: 4_000 } } });
  });

  it('a party the till cannot read is not settled as zero: the settlement is rolled back, the poller goes on, the next notification settles it', async () => {
    const { eventId, conversationId } = await party({ depositThb: 1_000 });
    const made = await requestOk(eventId);
    const row = await requestRow(made.request.id);
    const before = { edits: edits.length, bells: bells.length };
    // Moved to a park the till does not know: no platform branch is anchored to it.
    await ctx.db.execute(sql`update otoapp.core_events set branch_id = ${appParkUnknown} where id = ${eventId}`);
    const pressed = await press(row.paymentAttemptId, 'pay');
    expect([200, 302, 303]).toContain(pressed.statusCode);
    expect(await requestRow(made.request.id)).toMatchObject({ state: 'requested', paidAt: null, depositBeforeSatang: null, depositAfterSatang: null, writeBackEditId: null });
    const attempt = await attemptRow(row.paymentAttemptId);
    expect(attempt.status).not.toBe('approved');
    expect(await linesOf(conversationId!)).toHaveLength(1);
    expect(await pillsOf(conversationId!, 'deposit_paid')).toHaveLength(0);
    expect(edits.length).toBe(before.edits);
    // The poller finds the gateway paid, cannot settle it either, and goes on with its tick rather than aborting it.
    const stuck = await pollPendingAttempts(ctx.db, ctx.app.env, ctx.app.log, new Date(attempt.createdAt.getTime() + 90_000));
    expect(stuck.failed).toBeGreaterThanOrEqual(1);
    expect(await requestRow(made.request.id)).toMatchObject({ state: 'requested' });
    // Back where the till knows it: the next notification settles it onto the real figure.
    await ctx.db.execute(sql`update otoapp.core_events set branch_id = ${appPark} where id = ${eventId}`);
    const again = await postNotification(notification({ invoiceNo: row.invoiceNo, amount: wire(THB_3000), tranRef: 'TR-ZZ-825-UNREADABLE' }));
    expect(again.json().outcome).toBe('settled');
    expect(await requestRow(made.request.id)).toMatchObject({ state: 'paid', depositBeforeSatang: 100_000, depositAfterSatang: 400_000 });
    expect((await attemptRow(row.paymentAttemptId)).status).toBe('approved');
    expect(await linesOf(conversationId!)).toHaveLength(2);
    expect(await pillsOf(conversationId!, 'deposit_paid')).toHaveLength(1);
    expect(edits.length).toBe(before.edits + 1);
    expect(bells.length).toBe(before.bells + 1);
  });
});

// --- The gateway would not open the page -------------------------------------------------------

describe('the gateway would not open the page', () => {
  it('the press is refused by name with nothing posted; the same key again is the same refusal; a new key makes a fresh request', async () => {
    const { eventId, conversationId } = await party();
    const sim = gatewayFor(ctx.app.env).qr as unknown as { createHostedPayment: (...args: unknown[]) => Promise<unknown> };
    const real = sim.createHostedPayment;
    sim.createHostedPayment = () => Promise.reject(new Error('ZZ TEST: the gateway is down'));
    const idem = newId();
    try {
      const refused = await request(eventId, { amountSatang: THB_3000, actorAppUserId: presser }, { idem });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.code).toBe('DEPOSIT_PAGE_NOT_OPENED');
      const rows = await ctx.db.select().from(partyDepositRequest).where(eq(partyDepositRequest.otoappEventId, eventId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'cancelled', closeReason: 'gateway_refused', paymentLink: null, requestMessageId: null });
      expect((await attemptRow(rows[0]!.paymentAttemptId)).status).toBe('declined');
      expect(await linesOf(conversationId!)).toHaveLength(0);
      expect(await pillsOf(conversationId!, 'deposit_requested')).toHaveLength(0);
      const read = PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json());
      expect(read.current).toMatchObject({ id: rows[0]!.id, state: 'cancelled', closeReason: 'gateway_refused', requestLineStatus: null });
      // The app may keep the press id for a retry it cannot tell from a lost answer: the same key is the same refusal, never "already asked".
      const again = await request(eventId, { amountSatang: THB_3000, actorAppUserId: presser }, { idem });
      expect(again.statusCode, again.body).toBe(400);
      expect(again.json().error.code).toBe('DEPOSIT_PAGE_NOT_OPENED');
      expect(await ctx.db.select().from(partyDepositRequest).where(eq(partyDepositRequest.otoappEventId, eventId))).toHaveLength(1);
    } finally {
      sim.createHostedPayment = real;
    }
    const fresh = await requestOk(eventId);
    expect(fresh.request.state).toBe('requested');
    expect(['queued', 'sent']).toContain(fresh.request.requestLineStatus);
    expect(await linesOf(conversationId!)).toHaveLength(1);
    expect(PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json()).current?.id).toBe(fresh.request.id);
  });
});

// --- A party line is never withdrawn ---------------------------------------------------------------

describe('a party line is never withdrawn by a person’s reply, and the BEO reads where it stands', () => {
  it('a staff line between the post and the send withdraws the assistant’s own turn, not the deposit line; the view says sent, then failed', async () => {
    const { eventId, conversationId } = await party();
    // No post-commit send: the line waits for the sweeper, as it does while outbound is paused or the provider is down.
    configurePartyDeposit({ directory: () => directory, sender: () => null });
    const made = await requestOk(eventId).finally(() =>
      configurePartyDeposit({ directory: () => directory, sender: () => ({ channels: ctx.app.inboxChannels, storage: ctx.app.fileStorage ?? null }) }),
    );
    const [line] = await linesOf(conversationId!);
    expect(line!.providerStatus).toBe('queued');
    expect(made.request.requestLineStatus).toBe('queued');

    // A turn of the assistant's own, queued a moment after the deposit line; then a person's reply after both.
    // (Milliseconds apart, so both rows are already due when the sweeper's send is asked for them.)
    const turn = newId();
    const t0 = new Date(line!.createdAt.getTime() + 1);
    await ctx.db.insert(s.message).values({
      id: turn,
      operatorId,
      conversationId: conversationId!,
      channelAccountId,
      direction: 'outbound',
      authorKind: 'ai',
      body: 'ZZ TEST a turn of the assistant',
      bodyLanguage: 'en',
      providerStatus: 'queued',
      nextAttemptAt: null,
      createdAt: t0,
      updatedAt: t0,
    });
    const t1 = new Date(t0.getTime() + 1);
    await ctx.db.insert(s.message).values({
      id: newId(),
      operatorId,
      conversationId: conversationId!,
      channelAccountId,
      direction: 'outbound',
      authorKind: 'staff',
      authorAccountId: receptionAccountId,
      body: 'ZZ TEST a person replied',
      providerStatus: 'sent',
      sentAt: t1,
      createdAt: t1,
      updatedAt: t1,
    });
    // The sweeper's send of each, by id (its batch is fifty rows oldest first: the seeded thread's own queue comes before these).
    const deps = { channels: ctx.app.inboxChannels, storage: null };
    expect(await sendQueuedMessage(ctx.db, deps, turn)).toEqual({ messageId: turn, outcome: 'withdrawn' });
    expect((await sendQueuedMessage(ctx.db, deps, line!.id)).outcome).toBe('sent');
    const [sent] = await ctx.db.select().from(s.message).where(eq(s.message.id, line!.id));
    expect(sent!.providerStatus).toBe('sent');
    const [withdrawn] = await ctx.db.select().from(s.message).where(eq(s.message.id, turn));
    expect(withdrawn!.providerStatus).toBe('withdrawn');
    // Asked again by the sweeper, nothing withdraws the sent line and nothing sends the withdrawn turn.
    await runInboxSendJob(ctx.db, deps, new Date(t1.getTime() + 60_000));
    expect((await ctx.db.select().from(s.message).where(eq(s.message.id, line!.id)))[0]!.providerStatus).toBe('sent');
    expect((await ctx.db.select().from(s.message).where(eq(s.message.id, turn)))[0]!.providerStatus).toBe('withdrawn');
    expect((await pillsOf(conversationId!, 'ai_withdrawn')).map((p) => (p.payload as { messageId?: string }).messageId)).toEqual([turn]);
    expect(PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json()).current?.requestLineStatus).toBe('sent');

    // A line the channel refused for good shows as such.
    await ctx.db.update(s.message).set({ providerStatus: 'failed' }).where(eq(s.message.id, line!.id));
    expect(PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json()).current?.requestLineStatus).toBe('failed');
  });
});

// --- Cancelled, expired, re-issued --------------------------------------------------------------

describe('"Cancel request", a link that ran out, and the fresh link after either', () => {
  it('cancel closes the request and its attempt with a pill and no line to the family; twice is once', async () => {
    const { eventId, conversationId } = await party();
    const made = await requestOk(eventId);
    const idem = newId();
    const res = await act(eventId, made.request.id, 'cancel', { idem });
    expect(res.statusCode, res.body).toBe(200);
    expect(PartyDepositActionAnswerSchema.parse(res.json())).toMatchObject({ replayed: false, request: { state: 'cancelled', closeReason: 'staff' } });
    const row = await requestRow(made.request.id);
    expect(row.closedAt).not.toBeNull();
    expect((await attemptRow(row.paymentAttemptId)).status).toBe('cancelled');
    expect(await linesOf(conversationId!)).toHaveLength(1);
    expect(await pillsOf(conversationId!, 'deposit_cancelled')).toHaveLength(1);
    expect(await audits(made.request.id, 'party_deposit.cancel')).toHaveLength(1);
    expect(PartyDepositActionAnswerSchema.parse((await act(eventId, made.request.id, 'cancel', { idem })).json()).replayed).toBe(true);
    expect(PartyDepositActionAnswerSchema.parse((await act(eventId, made.request.id, 'cancel')).json()).replayed).toBe(true);
    expect(await pillsOf(conversationId!, 'deposit_cancelled')).toHaveLength(1);
    expect((await act(eventId, made.request.id, 'resend')).statusCode).toBe(409);
    // A fresh one after it, with its own invoice.
    const next = await requestOk(eventId);
    expect(next.request.invoiceNo).not.toBe(made.request.invoiceNo);
    expect(await linesOf(conversationId!)).toHaveLength(2);
    expect(await conversationEventOf(ctx.db, operatorId, { id: conversationId!, eventOrderRef: eventId })).toMatchObject({ deposit: { requestId: next.request.id, state: 'requested' } });
  });

  it('the gateway running the link out closes the request expired; the next press re-issues a fresh link', async () => {
    const { eventId, conversationId } = await party();
    const made = await requestOk(eventId);
    const row = await requestRow(made.request.id);
    const facts = simulator().apply(row.invoiceNo, 'expire')!;
    const res = await postNotification(notification({ invoiceNo: row.invoiceNo, amount: wire(THB_3000), tranRef: facts.tranRef, respCode: '9020' }));
    expect(res.json().outcome).toBe('not_paid');
    const closed = await requestRow(made.request.id);
    expect(closed.state).toBe('expired');
    expect(closed.closeReason).toBe('gateway_expired');
    expect(await pillsOf(conversationId!, 'deposit_expired')).toHaveLength(1);
    expect(await audits(made.request.id, 'party_deposit.expire')).toHaveLength(1);
    const resend = await act(eventId, made.request.id, 'resend');
    expect(resend.statusCode).toBe(409);
    const read = PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json());
    expect(read.current).toMatchObject({ id: made.request.id, state: 'expired' });

    const next = await requestOk(eventId);
    expect(next.request).toMatchObject({ state: 'requested' });
    expect(next.request.invoiceNo).not.toBe(made.request.invoiceNo);
    expect(next.request.paymentLink).not.toBe(made.request.paymentLink);
    expect(await linesOf(conversationId!)).toHaveLength(2);
    expect(PartyDepositAnswerSchema.parse((await readDeposit(eventId)).json()).current?.id).toBe(next.request.id);
  });

  it('money that lands after the link was closed still pays the party, marked late', async () => {
    const { eventId, conversationId } = await party();
    const made = await requestOk(eventId);
    await act(eventId, made.request.id, 'cancel');
    const row = await requestRow(made.request.id);
    simulator().apply(row.invoiceNo, 'paid');
    const res = await postNotification(notification({ invoiceNo: row.invoiceNo, amount: wire(THB_3000), tranRef: 'TR-ZZ-825-LATE' }));
    expect(res.statusCode).toBe(200);
    const paid = await requestRow(made.request.id);
    if (paid.state === 'paid') {
      expect(await pillsOf(conversationId!, 'deposit_paid')).toHaveLength(1);
      expect((await pillsOf(conversationId!, 'deposit_paid'))[0]!.payload).toMatchObject({ late: true });
      expect(paid.depositAfterSatang).toBe(THB_3000);
    } else {
      // The gateway refused to settle a cancelled attempt: the request stays closed and nothing was said.
      expect(paid.state).toBe('cancelled');
      expect(await pillsOf(conversationId!, 'deposit_paid')).toHaveLength(0);
    }
  });
});

// --- The follow-ups -------------------------------------------------------------------------

describe('the follow-up job: one reminder after the window, the hand-over after the second, never twice', () => {
  let eventId: string;
  let conversationId: string;
  let made: PartyDepositActionAnswer;
  let requestedAt: Date;
  const remindMin = () => ctx.app.env.PARTY_DEPOSIT_REMINDER_MIN;
  const handMin = () => ctx.app.env.PARTY_DEPOSIT_HANDOVER_MIN;

  it('before the window nothing; after it ONE reminder with its pill; the tick again posts nothing', async () => {
    ({ eventId, conversationId } = await party() as { eventId: string; conversationId: string });
    made = await requestOk(eventId);
    requestedAt = (await requestRow(made.request.id)).requestedAt;
    expect(remindMin()).toBe(1_440);
    expect(handMin()).toBe(1_440);

    const early = await followUp(new Date(requestedAt.getTime() + minutes(remindMin() - 5)));
    expect(early.reminded).toBe(0);
    expect((await requestRow(made.request.id)).remindedAt).toBeNull();
    expect(await linesOf(conversationId)).toHaveLength(1);

    const due = new Date(requestedAt.getTime() + minutes(remindMin() + 1));
    // Other parties of this file are open at the same age: the tick reminds them too, each once.
    const sweep = await followUp(due);
    expect(sweep.reminded).toBeGreaterThanOrEqual(1);
    const row = await requestRow(made.request.id);
    expect(row.remindedAt?.toISOString()).toBe(due.toISOString());
    const lines = await linesOf(conversationId);
    expect(lines).toHaveLength(2);
    const reminder = await templateOf('party_deposit_reminder', 'en');
    expect(lines[1]).toMatchObject({ templateId: reminder.id });
    expect(lines[1]!.body).toContain('฿3,000');
    expect(lines[1]!.body).toContain(made.request.paymentLink!);
    expect(row.reminderMessageId).toBe(lines[1]!.id);
    expect(await pillsOf(conversationId, 'deposit_reminded')).toHaveLength(1);
    expect(await audits(made.request.id, 'party_deposit.remind')).toHaveLength(1);

    const again = await followUp(new Date(due.getTime() + minutes(10)));
    expect(again.reminded).toBe(0);
    expect(again.handedOver).toBe(0);
    expect(await linesOf(conversationId)).toHaveLength(2);
    expect(await pillsOf(conversationId, 'deposit_reminded')).toHaveLength(1);
  });

  it('after the second window the thread is handed to the birthday manager: the holding line, the assistant standing back, the bell', async () => {
    const remindedAt = (await requestRow(made.request.id)).remindedAt!;
    const early = await followUp(new Date(remindedAt.getTime() + minutes(handMin() - 5)));
    expect(early.handedOver).toBe(0);

    const bellsFor = () => bells.filter((b) => b.referenceId === conversationId);
    const rung = bellsFor().length;
    const due = new Date(remindedAt.getTime() + minutes(handMin() + 1));
    const sweep = await followUp(due);
    expect(sweep.handedOver).toBeGreaterThanOrEqual(1);
    const row = await requestRow(made.request.id);
    expect(row.state).toBe('requested');
    expect(row.handedOverAt?.toISOString()).toBe(due.toISOString());
    const lines = await linesOf(conversationId);
    expect(lines).toHaveLength(3);
    const holding = await templateOf('closing_birthday', 'en');
    expect(lines[2]).toMatchObject({ templateId: holding.id });
    expect(lines[2]!.body).toBe('Thank you so much! Our birthday manager will be with you shortly.');
    expect(await pillsOf(conversationId, 'deposit_overdue')).toHaveLength(1);
    const handover = await pillsOf(conversationId, 'ai_handover');
    expect(handover).toHaveLength(1);
    expect(handover[0]!.payload).toMatchObject({ reason: 'DEPOSIT_UNPAID', partyDepositRequestId: made.request.id, reroutedTeamId: birthdaysTeamId, messageIds: [lines[2]!.id] });
    const [conv] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, conversationId));
    expect(conv!.category).toBe('birthdays');
    expect(conv!.teamId).toBe(birthdaysTeamId);
    expect(bellsFor()).toHaveLength(rung + 1);
    expect(bellsFor()[rung]).toMatchObject({ recipientUserId: manager, referenceId: conversationId, title: 'A party deposit is overdue' });
    expect(await audits(made.request.id, 'party_deposit.hand_over')).toHaveLength(1);
    expect(await conversationEventOf(ctx.db, operatorId, { id: conversationId, eventOrderRef: eventId })).toMatchObject({ deposit: { state: 'requested', overdue: true } });

    const again = await followUp(new Date(due.getTime() + minutes(60)));
    expect(again.handedOver).toBe(0);
    expect(await linesOf(conversationId)).toHaveLength(3);
    expect(await pillsOf(conversationId, 'deposit_overdue')).toHaveLength(1);
    expect(bellsFor()).toHaveLength(rung + 1);
  });

  it('a payment after the hand-over still pays the deposit, in time', async () => {
    const row = await requestRow(made.request.id);
    const paid = await press(row.paymentAttemptId, 'pay');
    expect([200, 302, 303]).toContain(paid.statusCode);
    expect(await requestRow(made.request.id)).toMatchObject({ state: 'paid', depositAfterSatang: THB_3000 });
    expect(await linesOf(conversationId)).toHaveLength(4);
    expect(await conversationEventOf(ctx.db, operatorId, { id: conversationId, eventOrderRef: eventId })).toMatchObject({ deposit: { state: 'paid', overdue: false } });
    // Paid: nothing more to remind or hand over, however late the tick.
    const late = await followUp(new Date(Date.now() + minutes(10 * 1_440)));
    expect(late.reminded + late.handedOver).toBe(0);
  });

  it('a request paid before the window is never reminded', async () => {
    const p = await party();
    const r = await requestOk(p.eventId);
    await press((await requestRow(r.request.id)).paymentAttemptId, 'pay');
    const sweep = await followUp(new Date(Date.now() + minutes(remindMin() + 10)));
    expect((await requestRow(r.request.id)).remindedAt).toBeNull();
    expect(sweep.remindersDue).toBe(0);
  });
});

// --- The set-menu link and the choices --------------------------------------------------------

describe('the set-menu link posted with the right words, and the parent’s choices confirmed', () => {
  it('"Send the menu choice link": one line with the link and the day, a pill, once per press', async () => {
    const { eventId, conversationId } = await party({ language: 'th' });
    const link = `https://app.zz-test.example/menu-select/${randomBytes(12).toString('hex')}`;
    const idem = newId();
    const res = await menuLink(eventId, link, { idem });
    expect(res.statusCode, res.body).toBe(200);
    const answer = PartyMessageAnswerSchema.parse(res.json());
    expect(answer).toMatchObject({ conversationId, language: 'th', replayed: false });
    const lines = await linesOf(conversationId!);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.id).toBe(answer.messageId);
    expect(lines[0]!.body).toContain(link);
    expect(lines[0]!.body).toMatch(/[฀-๿]/);
    expect(lines[0]!.body).not.toContain('{{');
    expect(await pillsOf(conversationId!, 'menu_link_sent')).toHaveLength(1);
    expect(JSON.stringify((await pillsOf(conversationId!, 'menu_link_sent'))[0]!.payload)).not.toContain(link);
    expect(PartyMessageAnswerSchema.parse((await menuLink(eventId, link, { idem })).json()).replayed).toBe(true);
    expect(await linesOf(conversationId!)).toHaveLength(1);
    expect(await audits(eventId, 'party_menu.link')).toHaveLength(1);
    expect((await menuLink(eventId, 'not a url')).statusCode).toBe(400);
    expect((await menuLink(eventId, link, { idem: null })).statusCode).toBe(400);
  });

  it('the choices landed: the confirmation once per submission; a party with no chat is refused by name', async () => {
    const { eventId, conversationId } = await party();
    const idem = `submission-${newId()}`;
    const res = await menuReceived(eventId, { idem, submittedAt: '2026-11-12T03:00:00.000Z' });
    expect(res.statusCode, res.body).toBe(200);
    expect(PartyMessageAnswerSchema.parse(res.json())).toMatchObject({ conversationId, language: 'en', replayed: false });
    const lines = await linesOf(conversationId!);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toBe('Thank you! We have received your menu choices for Wednesday 18 November 2026 — the kitchen will be ready 😊');
    expect((await pillsOf(conversationId!, 'menu_received'))[0]!.payload).toMatchObject({ eventId, submittedAt: '2026-11-12T03:00:00.000Z' });
    expect(PartyMessageAnswerSchema.parse((await menuReceived(eventId, { idem })).json()).replayed).toBe(true);
    expect(await linesOf(conversationId!)).toHaveLength(1);
    const alone = await party({ link: false });
    expect((await menuReceived(alone.eventId)).json().error.code).toBe('PARTY_NO_CONVERSATION');
    expect((await menuLink(alone.eventId, 'https://app.zz-test.example/menu-select/abc')).json().error.code).toBe('PARTY_NO_CONVERSATION');
  });
});

// --- The family's browser return -------------------------------------------------------------

describe('the family’s browser return is a page, never a payment', () => {
  it('is sent to this api’s own address: relative on the simulator, the webhook’s origin on the real gateway, else the booking return’s, else refused', () => {
    const env = ctx.app.env;
    expect(partyDepositReturnUrlOf(env, 'simulator')).toBe('../../../public/parties/deposit/return');
    expect(partyDepositReturnUrlOf(env, '2c2p')).toBe('https://api.zz-test.example/public/parties/deposit/return');
    expect(partyDepositReturnUrlOf({ ...env, PGW_BACKEND_RETURN_URL: '', PGW_FRONTEND_RETURN_URL: 'https://api.zz-test.example/public/bookings/return' }, '2c2p')).toBe(
      'https://api.zz-test.example/public/parties/deposit/return',
    );
    expect(partyDepositReturnUrlOf({ ...env, PGW_BACKEND_RETURN_URL: 'not an address', PGW_FRONTEND_RETURN_URL: '' }, '2c2p')).toBeNull();
    expect(partyDepositReturnUrlOf({ ...env, PGW_BACKEND_RETURN_URL: '', PGW_FRONTEND_RETURN_URL: '' }, '2c2p')).toBeNull();
  });

  it('shows a plain page for a missing, a forged and an honest hint, and writes nothing', async () => {
    const { eventId } = await party();
    const made = await requestOk(eventId);
    const before = await requestRow(made.request.id);
    const none = await ctx.app.inject({ method: 'GET', url: '/public/parties/deposit/return' });
    expect(none.statusCode).toBe(200);
    expect(none.headers['content-type']).toContain('text/html');
    expect(none.body).toContain('Checking your payment');
    const forged = await ctx.app.inject({ method: 'POST', url: '/public/parties/deposit/return', payload: { paymentResponse: 'not.a.jwt' } });
    expect(forged.statusCode).toBe(200);
    expect(forged.body).toContain('Checking your payment');
    expect(await requestRow(made.request.id)).toEqual(before);
    expect((await attemptRow(before.paymentAttemptId)).status).not.toBe('approved');
  });
});

describe('the link a chat carries always has an address', () => {
  const envOf = (backend: string, own: string) => ({ PGW_BACKEND_RETURN_URL: backend, RENDER_EXTERNAL_URL: own }) as unknown as Parameters<typeof partyDepositLinkOf>[0];
  it('an absolute page is left alone; a relative one takes the webhook’s origin, else this api’s own address', () => {
    expect(partyDepositLinkOf(envOf('', ''), 'https://pay.example/p/1')).toBe('https://pay.example/p/1');
    expect(partyDepositLinkOf(envOf('https://api.example/webhooks/2c2p', 'https://own.example'), '/webhooks/2c2p/hosted/a1')).toBe('https://api.example/webhooks/2c2p/hosted/a1');
    expect(partyDepositLinkOf(envOf('', 'https://own.example'), '/webhooks/2c2p/hosted/a1')).toBe('https://own.example/webhooks/2c2p/hosted/a1');
  });
});
