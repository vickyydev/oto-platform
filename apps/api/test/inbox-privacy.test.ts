import { hash } from '@node-rs/argon2';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { signMetaPayload, type RawWebhook, type SimulatorChannel } from '@oto/messaging';
import { INBOX_ERASED_CONTACT_NAME, newId } from '@oto/shared';
import type { Env } from '../src/env';
import type { FileStorage } from '../src/services/files';
import { mirrorNotice } from '../src/services/inbox/mirror';
import {
  INBOX_RETENTION_JOB,
  erasedHandleOf,
  purgeConversations,
  purgeMedia,
  purgeWebhookPayloads,
  redactPayload,
  retentionConfigOf,
  runInboxRetention,
} from '../src/services/inbox/privacy';
import { buildDefaultJobs, createJobRunner } from '../src/services/jobs';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { NO_LEAKS, inboxHolds, sentinelLeaks, smsConsoleLines } from './inbox-sentinel';

/**
 * S2-19 I2g (SCRUM-586) — the Inbox's PDPA paths (plan
 * `docs/progress/plans/inbox-build/PLAN.md` §3.6).
 *
 * What it holds:
 *   - THE SENTINEL. A body written through every inbox write path landed so
 *     far — the webhook ingest (a verified delivery and a forged one), the
 *     simulator panel, the check-in mirror through the real registration
 *     route, the booking-confirmation mirror, and the reads and read marker —
 *     reaches no audit row, timeline event, ops row or log line.
 *   - ERASURE, end to end: refused without the operator-scoped permission
 *     (a branch grant of it included), 404 across operators, 409 without both
 *     confirmations; then the person's every message gone in place — the
 *     MIRRORED notices included — their files deleted (a template's file only
 *     unlinked), name keys out of the timeline, the raw deliveries purged,
 *     the threads intact as structure, the reads honest about it, one audit
 *     row of ids; a second erasure finds nothing and says so; the same phone
 *     writing again is a new contact.
 *   - RETENTION: with no periods set every purge refuses and nothing changes,
 *     on the job's own ops record; with periods set (test configuration only)
 *     the old handled thread is emptied in place, its events deleted, the old
 *     media gone and the old payload nulled — and nothing recent is touched.
 */

const SECRET = 'inbox-privacy-test-secret';
const SENTINEL = 'SENTINEL-5eed-pdpa-never-outside-the-message-table';
/** The connection check's fixed sentence (I2c): the mirrored notice's body. */
const CHECK_TEXT = 'has just been registered at Oto';
const BOOKING_SENTINEL = 'SENTINEL-b00c-booking-confirmation-body';
const RETENTION_SENTINEL = 'SENTINEL-01d0-retention-old-thread';
const MALI_PHONE = '+66811111111';
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];
const PASSWORD = 'inboxprivacy1234';
const DAY = 86_400_000;

let ctx: TestContext;
let oto: string;
let central: string;
let caCentral: string;
let admin: string;
const logLines: string[] = [];
const stored = new Map<string, Buffer>();
const removed: string[] = [];

const memoryStorage: FileStorage = {
  bucket: 'inbox-privacy-test',
  presignedPut: async () => 'memory://unused',
  presignedGet: async () => 'memory://unused',
  put: async (key, bytes) => {
    stored.set(key, Buffer.from(bytes));
  },
  remove: async (key) => {
    stored.delete(key);
    removed.push(key);
  },
  probe: async () => ({ state: 'ready' }),
};

async function accountIdByPhone(phone: string): Promise<string> {
  const [row] = await ctx.db.select({ id: s.account.id }).from(s.account).where(eq(s.account.phone, phone)).limit(1);
  return row!.id;
}

async function simOf(id: string): Promise<SimulatorChannel> {
  const [row] = await ctx.db.select().from(s.channelAccount).where(eq(s.channelAccount.id, id)).limit(1);
  const sim = ctx.app.inboxChannels.simulatorFor({ ...row! });
  if (!sim) throw new Error('simulator off');
  return sim;
}

async function post(channelAccountId: string, webhook: RawWebhook, headers?: Record<string, string>) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/inbox/${channelAccountId}`,
    headers: headers ?? (webhook.headers as Record<string, string>),
    payload: typeof webhook.rawBody === 'string' ? webhook.rawBody : Buffer.from(webhook.rawBody),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { outcome: string };
}

async function play(from: string, text: string, name = 'Khun Mali') {
  const sim = await simOf(caCentral);
  const played = sim.inbound({ from, name, text });
  const { outcome } = await post(caCentral, played.webhook);
  expect(outcome).toBe('processed');
  return played;
}

/** A verified staff account holding one role at one scope. */
async function staff(phone: string, roleId: string, scope: { scopeType: 'operator' | 'branch'; scopeId: string }) {
  const employeeId = newId();
  await ctx.db.insert(s.employee).values({ id: employeeId, operatorId: oto, name: `Staff ${phone}`, phone });
  const accountId = newId();
  await ctx.db.insert(s.account).values({
    id: accountId,
    operatorId: oto,
    employeeId,
    phone,
    passwordHash: await hash(PASSWORD),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId, ...scope });
  return signInAs(ctx.app, phone, PASSWORD);
}

async function roleNamed(name: string): Promise<string> {
  const [role] = await ctx.db
    .select({ id: s.role.id })
    .from(s.role)
    .where(and(eq(s.role.operatorId, oto), eq(s.role.name, name)))
    .limit(1);
  return role!.id;
}

async function contactOf(channel: 'whatsapp' | 'line', phone = MALI_PHONE) {
  const [row] = await ctx.db
    .select()
    .from(s.contact)
    .where(and(eq(s.contact.operatorId, oto), eq(s.contact.channel, channel), eq(s.contact.phone, phone)))
    .limit(1);
  return row;
}

async function threadsOf(contactIds: string[]) {
  return ctx.db.select().from(s.conversation).where(inArray(s.conversation.contactId, contactIds));
}

function erase(cookie: string, contactId: string, body: Record<string, unknown>, key?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/inbox/contacts/${contactId}/erase`,
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    payload: body,
  });
}

const confirmed = (contactId: string) => ({ confirmContactId: contactId, confirm: 'ERASE' });

beforeAll(async () => {
  ctx = await createTestContext({
    env: { INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: SECRET },
    logCapture: { stream: { write: (line) => void logLines.push(line) }, level: 'debug' },
  });
  ctx.app.fileStorage = memoryStorage;
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  admin = await accountIdByPhone(ADMIN.phone);
  caCentral = newId();
  await ctx.db.insert(s.channelAccount).values({
    id: caCentral,
    operatorId: oto,
    branchId: central,
    channel: 'whatsapp',
    provider: 'simulator',
    externalId: 'test-wa-privacy',
    displayName: 'Test privacy',
    defaultCategory: 'general',
    canReply: true,
    status: 'active',
  });
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the no-body sentinel, across every inbox write path landed so far (I2g)', () => {
  it('ingest, the forged delivery, the simulator panel, the check-in and booking mirrors and the reads leave no body in audit, events, ops or logs', async () => {
    // The webhook ingest, verified.
    await play(MALI_PHONE.slice(1), `A party for two, please ${SENTINEL}`);
    // A forged delivery: refused, recorded without its payload.
    const sim = await simOf(caCentral);
    const forged = sim.inbound({ from: '66810009001', name: 'Forged', text: `forged ${SENTINEL}` });
    const raw = forged.webhook.rawBody as string;
    expect(
      (
        await post(caCentral, forged.webhook, {
          'content-type': 'application/json',
          'x-hub-signature-256': signMetaPayload(raw, 'not-the-secret'),
        })
      ).outcome,
    ).toBe('bad_signature');
    // The simulator panel's press.
    const adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const press = await ctx.app.inject({
      method: 'POST',
      url: '/inbox/simulator/inbound',
      headers: { cookie: adminCookie },
      payload: { channelAccountId: caCentral, from: '66810009002', name: 'Panel press', text: `A press ${SENTINEL}` },
    });
    expect(press.statusCode, press.body).toBe(200);

    // The check-in mirror, through the real registration route (Mali is a member).
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const [till] = await ctx.db
      .select()
      .from(s.station)
      .where(and(eq(s.station.branchId, central), eq(s.station.codePrefix, 'T1')));
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/registrations',
      headers: { cookie: reception },
      payload: {
        id: newId(),
        branchId: central,
        stationId: till!.id,
        guardianName: 'Khun Mali',
        guardianPhone: '0811111111',
        contactChannel: 'whatsapp',
        consentAcknowledged: true,
        acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
        children: [
          {
            checkinId: newId(),
            name: 'Mint',
            ageYears: 6,
            service: 'drop_off',
            allergies: null,
            foodRestrictions: null,
            foodProvision: { mode: 'none', paidSatang: 0 },
          },
        ],
      },
    });
    expect(reg.statusCode, reg.body).toBe(200);
    // The booking-confirmation mirror, on LINE: the same person, another contact.
    const booked = await ctx.db.transaction((tx) =>
      mirrorNotice(tx, {
        operatorId: oto,
        branchId: central,
        channel: 'line',
        phone: MALI_PHONE,
        displayName: 'Khun Mali',
        body: `Your booking is confirmed ${BOOKING_SENTINEL}`,
        source: 'booking.confirmation',
        sourceId: newId(),
        sentAt: new Date(),
        sender: { send: () => Promise.resolve() },
      }),
    );
    expect(booked.mirrored).toBe(true);

    // The reads and the read marker hand the body to the reader, and nowhere else.
    const wa = (await contactOf('whatsapp'))!;
    const threads = await threadsOf([wa.id]);
    expect(threads).toHaveLength(2); // the simulator number's thread and the check-in notice thread
    for (const t of threads) {
      const detail = await ctx.app.inject({ method: 'GET', url: `/inbox/conversations/${t.id}`, headers: { cookie: adminCookie } });
      expect(detail.statusCode).toBe(200);
      const page = await ctx.app.inject({
        method: 'GET',
        url: `/inbox/conversations/${t.id}/messages`,
        headers: { cookie: adminCookie },
      });
      expect(page.statusCode).toBe(200);
      const read = await ctx.app.inject({
        method: 'POST',
        url: `/inbox/conversations/${t.id}/read`,
        headers: { cookie: adminCookie },
        payload: {},
      });
      expect(read.statusCode, read.body).toBe(200);
    }
    const list = await ctx.app.inject({ method: 'GET', url: '/inbox/conversations?tab=team', headers: { cookie: adminCookie } });
    expect(list.body).toContain(SENTINEL); // the preview: the reader does get it

    // Not vacuous: each string IS in the message table, and the log captured lines.
    expect((await inboxHolds(ctx.db, SENTINEL)).messages).toBe(2);
    expect((await inboxHolds(ctx.db, CHECK_TEXT)).messages).toBe(1);
    expect((await inboxHolds(ctx.db, BOOKING_SENTINEL)).messages).toBe(1);
    expect(logLines.length).toBeGreaterThan(10);
    // The one line that does carry the notice is its delivery by the console SMS adapter (plan §7's residual).
    expect(smsConsoleLines(logLines, CHECK_TEXT)).toBe(1);
    for (const needle of [SENTINEL, CHECK_TEXT, BOOKING_SENTINEL]) {
      expect(await sentinelLeaks(ctx.db, needle, logLines), needle).toEqual(NO_LEAKS);
    }
  });
});

describe('PDPA erasure (I2g)', () => {
  let contactId: string;
  let lineContactId: string;
  let ownedFile: string;
  let templateFile: string;
  let avatarFile: string;
  let eraserCookie: string;
  /** SCRUM-590 R6: the curated examples sourced from Mali's threads, and the ones that must survive. */
  let examples: { proposed: string; rejected: string; approved: string; otherThread: string; kbEntry: string };
  let shape: { id: string; status: string; teamId: string | null; branchId: string | null; owners: number; messages: number }[];

  beforeAll(async () => {
    const wa = (await contactOf('whatsapp'))!;
    const line = (await contactOf('line'))!;
    contactId = wa.id;
    lineContactId = line.id;
    expect(wa.memberId).not.toBeNull(); // the soft link to Mali's member record

    // Media: one the inbox owns on the customer's line, one a template owns on the notice.
    const threads = await threadsOf([contactId]);
    const [customerLine] = await ctx.db
      .select()
      .from(s.message)
      .where(and(inArray(s.message.conversationId, threads.map((t) => t.id)), eq(s.message.direction, 'inbound')))
      .limit(1);
    const [notice] = await ctx.db
      .select()
      .from(s.message)
      .where(and(inArray(s.message.conversationId, threads.map((t) => t.id)), eq(s.message.source, 'checkin.contact')))
      .limit(1);
    ownedFile = newId();
    templateFile = newId();
    avatarFile = newId();
    await ctx.db.insert(s.fileObject).values([
      { id: ownedFile, operatorId: oto, bucket: 'b', objectKey: `inbox/${ownedFile}.jpg`, contentType: 'image/jpeg', ownerEntityType: 'inbox.message', ownerEntityId: customerLine!.id },
      { id: templateFile, operatorId: oto, bucket: 'b', objectKey: `inbox/${templateFile}.pdf`, contentType: 'application/pdf', ownerEntityType: 'inbox.template', ownerEntityId: newId() },
      { id: avatarFile, operatorId: oto, bucket: 'b', objectKey: `inbox/${avatarFile}.png`, contentType: 'image/png', ownerEntityType: 'inbox.contact', ownerEntityId: contactId },
    ]);
    for (const key of [`inbox/${ownedFile}.jpg`, `inbox/${templateFile}.pdf`, `inbox/${avatarFile}.png`]) stored.set(key, Buffer.from('x'));
    await ctx.db.update(s.message).set({ mediaFileIds: [ownedFile] }).where(eq(s.message.id, customerLine!.id));
    await ctx.db.update(s.message).set({ mediaFileIds: [templateFile] }).where(eq(s.message.id, notice!.id));
    await ctx.db.update(s.contact).set({ avatarFileId: avatarFile }).where(eq(s.contact.id, contactId));
    // A timeline payload carrying a name: no writer does this today; the erasure must still reach it.
    await ctx.db.insert(s.inboxEvent).values({
      id: newId(),
      operatorId: oto,
      conversationId: threads[0]!.id,
      kind: 'pos_update',
      actorKind: 'system',
      payload: { bookingRef: 'B-1', displayName: 'Khun Mali', nested: { phone: MALI_PHONE, kept: 'yes' } },
    });

    // SCRUM-590 R6 — the assistant's curated examples. Two UNAPPROVED ones
    // copied from Mali's threads (one linked by thread, one by message only),
    // an approved one (de-identified, no links), one from another customer's
    // thread, and a KB entry promoted from the first.
    const [otherThread] = await ctx.db
      .select({ id: s.conversation.id })
      .from(s.conversation)
      .where(and(eq(s.conversation.operatorId, oto), sql`${s.conversation.contactId} not in (${contactId}, ${lineContactId})`))
      .limit(1);
    examples = { proposed: newId(), rejected: newId(), approved: newId(), otherThread: newId(), kbEntry: newId() };
    const example = { operatorId: oto, intent: 'birthday_party', language: 'en' as const, verdict: 'should_handover' as const, proposedByAccountId: admin };
    await ctx.db.insert(s.aiExample).values([
      { ...example, id: examples.proposed, customerText: 'A party for two, please — Khun Mali', sourceConversationId: threads[0]!.id, sourceMessageId: customerLine!.id },
      { ...example, id: examples.rejected, customerText: 'A party, Khun Mali', status: 'rejected', sourceMessageId: notice!.id },
      { ...example, id: examples.approved, customerText: 'A party for two, please', status: 'approved', deidentifiedConfirmed: true, approvedByAccountId: admin, approvedAt: new Date() },
      { ...example, id: examples.otherThread, customerText: 'Somebody else asks', sourceConversationId: otherThread!.id },
    ]);
    await ctx.db.insert(s.kbEntry).values({
      id: examples.kbEntry,
      operatorId: oto,
      topic: 'faq',
      key: 'faq.privacy-test',
      language: 'en',
      question: 'A question',
      body: 'A fact',
      sourceExampleId: examples.proposed,
    });

    shape = [];
    for (const t of await threadsOf([contactId, lineContactId])) {
      const owners = await ctx.db
        .select()
        .from(s.assignment)
        .where(and(eq(s.assignment.conversationId, t.id), sql`${s.assignment.releasedAt} is null`));
      const msgs = await ctx.db.select().from(s.message).where(eq(s.message.conversationId, t.id));
      shape.push({ id: t.id, status: t.status, teamId: t.teamId, branchId: t.branchId, owners: owners.length, messages: msgs.length });
    }
  });

  it('refuses without inbox:contact:erase at operator scope — reception, an inbox admin, and a branch grant of it', async () => {
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await erase(reception, contactId, confirmed(contactId))).statusCode).toBe(403);

    const inboxAdmin = await staff('+66900077001', await roleNamed('inbox_admin'), { scopeType: 'operator', scopeId: oto });
    expect((await erase(inboxAdmin, contactId, confirmed(contactId))).statusCode).toBe(403);

    // A role carrying it, made and granted deliberately — at a branch, it is not enough.
    const roleId = newId();
    await ctx.db.insert(s.role).values({ id: roleId, operatorId: oto, name: 'pdpa_eraser', description: 'PDPA erasure' });
    await ctx.db.insert(s.rolePermission).values({ id: newId(), roleId, permission: 'inbox:contact:erase' });
    const branchEraser = await staff('+66900077002', roleId, { scopeType: 'branch', scopeId: central });
    const refused = await erase(branchEraser, contactId, confirmed(contactId));
    expect(refused.statusCode).toBe(403);
    // Operator-wide, it is.
    eraserCookie = await staff('+66900077003', roleId, { scopeType: 'operator', scopeId: oto });
    expect((await contactOf('whatsapp'))!.erasedAt).toBeNull();
  });

  it("another operator's admin gets 404, confirmed or not; an unknown id 404", async () => {
    const second = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    expect((await erase(second, contactId, confirmed(contactId))).statusCode).toBe(404);
    expect((await erase(second, contactId, {})).statusCode).toBe(404);
    const unknown = newId();
    expect((await erase(eraserCookie, unknown, confirmed(unknown))).statusCode).toBe(404);
  });

  it('refuses without BOTH confirmations: 409 ERASURE_UNCONFIRMED with what it would erase, and nothing changes', async () => {
    for (const body of [{}, { confirmContactId: contactId }, { confirm: 'ERASE' }, { confirmContactId: lineContactId, confirm: 'ERASE' }, { confirmContactId: contactId, confirm: 'erase' }]) {
      const res = await erase(eraserCookie, contactId, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(409);
      expect(res.json().error.code).toBe('ERASURE_UNCONFIRMED');
      expect(res.json().error.details).toMatchObject({
        contactIds: [contactId, lineContactId],
        conversations: 3,
        noticeMessages: 2,
        examplesDeleted: 2,
      });
    }
    expect((await contactOf('whatsapp'))!.erasedAt).toBeNull();
    expect((await inboxHolds(ctx.db, SENTINEL)).messages).toBe(2);
    expect(stored.has(`inbox/${ownedFile}.jpg`)).toBe(true);
  });

  it('erases the person in place: every message incl. the mirrored notices, the files, the names in the timeline, the raw deliveries — the threads intact', async () => {
    const receiptsBefore = await ctx.db
      .select({ id: s.webhookReceipt.id })
      .from(s.webhookReceipt)
      .where(and(eq(s.webhookReceipt.channelAccountId, caCentral), isNotNull(s.webhookReceipt.payload)));
    const res = await erase(eraserCookie, contactId, confirmed(contactId), 'erase-mali-1');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      contactId,
      alreadyErased: false,
      contactIds: [contactId, lineContactId],
      conversations: 3,
      noticeMessages: 2,
      filesDeleted: 2,
      filesUnlinked: 1,
      eventsRedacted: 1,
      webhookPayloadsPurged: 1,
      examplesDeleted: 2,
    });
    expect(body.messages).toBeGreaterThanOrEqual(3);

    // SCRUM-590 R6, in the same transaction: the unapproved examples copied
    // from Mali's threads deleted — by thread link and by message link alike;
    // the approved one and another customer's untouched; the KB entry
    // promoted from a deleted one keeps its words and loses the soft link.
    const left = await ctx.db.select({ id: s.aiExample.id }).from(s.aiExample).where(eq(s.aiExample.operatorId, oto));
    expect(left.map((e) => e.id).sort()).toEqual([examples.approved, examples.otherThread].sort());
    const [promoted] = await ctx.db.select().from(s.kbEntry).where(eq(s.kbEntry.id, examples.kbEntry));
    expect(promoted).toMatchObject({ sourceExampleId: null, body: 'A fact' });

    // The person: anonymised, both contacts.
    for (const id of [contactId, lineContactId]) {
      const [c] = await ctx.db.select().from(s.contact).where(eq(s.contact.id, id));
      expect(c).toMatchObject({
        displayName: INBOX_ERASED_CONTACT_NAME,
        externalHandle: erasedHandleOf(id),
        phone: null,
        memberId: null,
        avatarFileId: null,
        erasedByAccountId: await accountIdByPhone('+66900077003'),
      });
      expect(c!.erasedAt).not.toBeNull();
    }
    // Every message in their threads: no words, no media, marked.
    const threads = await threadsOf([contactId, lineContactId]);
    const msgs = await ctx.db.select().from(s.message).where(inArray(s.message.conversationId, threads.map((t) => t.id)));
    expect(msgs.filter((m) => m.source !== 'channel').map((m) => m.source).sort()).toEqual(['booking.confirmation', 'checkin.contact']);
    for (const m of msgs) {
      expect(m).toMatchObject({ body: null, translatedBody: null, transcript: null, mediaFileIds: [], audioFileId: null });
      expect(m.redactedAt).not.toBeNull();
    }
    // Nothing of theirs anywhere in the inbox schema.
    for (const needle of ['A party for two, please', CHECK_TEXT, BOOKING_SENTINEL, 'Khun Mali', MALI_PHONE, '66811111111']) {
      const holds = await inboxHolds(ctx.db, needle);
      expect(holds, needle).toEqual({ messages: 0, previews: 0, contacts: 0, receipts: 0, events: 0 });
    }
    // The other customer's press (its own thread) is untouched.
    expect((await inboxHolds(ctx.db, SENTINEL)).messages).toBe(1);
    // Files: the inbox's own deleted from storage and the register; the template's only unlinked.
    expect(removed.sort()).toEqual([`inbox/${avatarFile}.png`, `inbox/${ownedFile}.jpg`].sort());
    const files = await ctx.db.select({ id: s.fileObject.id }).from(s.fileObject).where(inArray(s.fileObject.id, [ownedFile, templateFile, avatarFile]));
    expect(files.map((f) => f.id)).toEqual([templateFile]);
    // The timeline: the name keys nulled, everything else kept, no event lost.
    const [named] = await ctx.db.select().from(s.inboxEvent).where(eq(s.inboxEvent.kind, 'pos_update'));
    expect(named!.payload).toEqual({ bookingRef: 'B-1', displayName: null, nested: { phone: null, kept: 'yes' } });
    // The raw delivery that carried Mali's line: nulled and stamped, the row kept.
    const receiptsAfter = await ctx.db
      .select({ id: s.webhookReceipt.id })
      .from(s.webhookReceipt)
      .where(and(eq(s.webhookReceipt.channelAccountId, caCentral), isNotNull(s.webhookReceipt.payload)));
    expect(receiptsAfter).toHaveLength(receiptsBefore.length - 1);
    expect(
      (await ctx.db.select().from(s.webhookReceipt).where(isNotNull(s.webhookReceipt.payloadPurgedAt))).length,
    ).toBe(1);
    // The structure: status, team, branch, owners and message counts as they were; previews and member links gone.
    for (const before of shape) {
      const [t] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, before.id));
      const owners = await ctx.db
        .select()
        .from(s.assignment)
        .where(and(eq(s.assignment.conversationId, t!.id), sql`${s.assignment.releasedAt} is null`));
      const count = await ctx.db.select().from(s.message).where(eq(s.message.conversationId, t!.id));
      expect({ id: t!.id, status: t!.status, teamId: t!.teamId, branchId: t!.branchId, owners: owners.length, messages: count.length }).toEqual(before);
      expect(t!.lastMessagePreview).toBeNull();
      expect(t!.memberId).toBeNull();
    }
    // One audit row: ids and counts, nothing erased.
    const rows = await ctx.db.select().from(s.auditLog).where(eq(s.auditLog.action, 'inbox.contact.erase'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: 'inbox.contact', entityId: contactId, operatorId: oto });
    const text = JSON.stringify([rows[0]!.before, rows[0]!.after]);
    for (const needle of ['Khun Mali', MALI_PHONE, '66811111111', SENTINEL, CHECK_TEXT, BOOKING_SENTINEL]) {
      expect(text).not.toContain(needle);
    }
  });

  it('a staff reader sees the erasure honestly: "Erased contact", no phone, redacted messages with no text', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    for (const t of await threadsOf([contactId, lineContactId])) {
      const detail = await ctx.app.inject({ method: 'GET', url: `/inbox/conversations/${t.id}`, headers: { cookie } });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().contact).toMatchObject({ displayName: INBOX_ERASED_CONTACT_NAME, phone: null, erased: true });
      expect(detail.json().lastMessagePreview).toBeNull();
      const page = await ctx.app.inject({ method: 'GET', url: `/inbox/conversations/${t.id}/messages`, headers: { cookie } });
      expect(page.statusCode).toBe(200);
      const messages = page.json().messages as { body: string | null; redacted: boolean; mediaFileIds: string[] }[];
      expect(messages.length).toBeGreaterThan(0);
      for (const m of messages) expect(m).toMatchObject({ body: null, redacted: true, mediaFileIds: [] });
    }
  });

  it('re-erasing is idempotent: nothing left, said so, recorded; the same key replays the same answer', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const again = await erase(cookie, contactId, confirmed(contactId), 'erase-mali-2');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({
      contactId,
      alreadyErased: true,
      contactIds: [contactId],
      conversations: 2,
      messages: 0,
      noticeMessages: 0,
      filesDeleted: 0,
      eventsRedacted: 0,
      webhookPayloadsPurged: 0,
      examplesDeleted: 0,
    });
    const replay = await erase(cookie, contactId, confirmed(contactId), 'erase-mali-2');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(again.json());
    const rows = await ctx.db.select().from(s.auditLog).where(eq(s.auditLog.action, 'inbox.contact.erase'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.after as { alreadyErased: boolean }).alreadyErased).sort()).toEqual([false, true]);
  });

  it('the same phone writing again is a NEW contact: nothing re-attaches to the erased one', async () => {
    await play(MALI_PHONE.slice(1), 'Hello again');
    const fresh = (await contactOf('whatsapp'))!;
    expect(fresh.id).not.toBe(contactId);
    expect(fresh.erasedAt).toBeNull();
    const [old] = await ctx.db.select().from(s.contact).where(eq(s.contact.id, contactId));
    expect(old!.erasedAt).not.toBeNull();
    expect(old!.phone).toBeNull();
  });

  it('redactPayload nulls only the word- and name-bearing keys, at any depth', () => {
    expect(redactPayload({ messageId: 'm', body: 'x', list: [{ name: 'n', id: 1 }], status: 'sent' })).toEqual({
      value: { messageId: 'm', body: null, list: [{ name: null, id: 1 }], status: 'sent' },
      changed: true,
    });
    expect(redactPayload({ messageId: 'm', body: null })).toEqual({ value: { messageId: 'm', body: null }, changed: false });
  });
});

describe('retention: built, OFF until owner Q19 sets the periods (I2g)', () => {
  let oldThread: string;
  let activeOldThread: string;
  let oldMessage: string;
  let oldReceipt: string;
  let oldFile: string;

  async function snapshot() {
    const q = async (x: ReturnType<typeof sql>) => Number((await ctx.db.execute<{ n: number }>(x)).rows[0]!.n);
    return {
      payloads: await q(sql`select count(*)::int as n from inbox.webhook_receipt where payload is not null`),
      bodies: await q(sql`select count(*)::int as n from inbox.message where body is not null`),
      media: await q(sql`select count(*)::int as n from inbox.message where cardinality(media_file_ids) > 0`),
      events: await q(sql`select count(*)::int as n from inbox.event`),
      retained: await q(sql`select count(*)::int as n from inbox.conversation where retain_until is not null`),
    };
  }

  function jobRunner(env: Env) {
    const log = ctx.app.log;
    const jobs = buildDefaultJobs({ db: ctx.db, env, log, channels: [], fileStorage: memoryStorage }).filter(
      (j) => j.name === INBOX_RETENTION_JOB,
    );
    expect(jobs).toHaveLength(1);
    return createJobRunner({ db: ctx.db, env: { ...env, PROCESS_ROLES: 'api,jobs' }, log, jobs, channels: [] });
  }

  async function lastRun() {
    const [run] = await ctx.db
      .select()
      .from(s.opsRun)
      .where(eq(s.opsRun.name, INBOX_RETENTION_JOB))
      .orderBy(desc(s.opsRun.startedAt))
      .limit(1);
    return run!;
  }

  beforeAll(async () => {
    const old = new Date(Date.now() - 400 * DAY);
    // A handled thread whose last word was 400 days ago, with media and a raw delivery that old.
    const played = await play('66810009100', `An old enquiry ${RETENTION_SENTINEL}`, 'Old Customer');
    const [m] = await ctx.db.select().from(s.message).where(eq(s.message.externalMessageId, played.externalMessageId));
    oldMessage = m!.id;
    oldThread = m!.conversationId;
    oldFile = newId();
    await ctx.db.insert(s.fileObject).values({
      id: oldFile,
      operatorId: oto,
      bucket: 'b',
      objectKey: `inbox/${oldFile}.jpg`,
      contentType: 'image/jpeg',
      ownerEntityType: 'inbox.message',
      ownerEntityId: oldMessage,
    });
    stored.set(`inbox/${oldFile}.jpg`, Buffer.from('x'));
    await ctx.db.update(s.message).set({ mediaFileIds: [oldFile], createdAt: old }).where(eq(s.message.id, oldMessage));
    await ctx.db
      .update(s.conversation)
      .set({ status: 'handled', handledAt: old, handledByKind: 'account', handledByAccountId: admin, lastMessageAt: old })
      .where(eq(s.conversation.id, oldThread));
    const [r] = await ctx.db
      .select({ id: s.webhookReceipt.id })
      .from(s.webhookReceipt)
      .where(sql`${s.webhookReceipt.payload}::text like ${'%' + RETENTION_SENTINEL + '%'}`);
    oldReceipt = r!.id;
    await ctx.db.update(s.webhookReceipt).set({ receivedAt: old }).where(eq(s.webhookReceipt.id, oldReceipt));
    // An ACTIVE thread just as old: open conversations are kept.
    const active = await play('66810009101', 'Still talking, a year on', 'Long Customer');
    const [am] = await ctx.db.select().from(s.message).where(eq(s.message.externalMessageId, active.externalMessageId));
    activeOldThread = am!.conversationId;
    await ctx.db.update(s.conversation).set({ lastMessageAt: old }).where(eq(s.conversation.id, activeOldThread));
  });

  it('unconfigured, every purge refuses — directly and as the daily job, on its ops record — and nothing changes', async () => {
    const before = await snapshot();
    const config = retentionConfigOf(ctx.app.env);
    expect(config).toEqual({ conversationDays: null, mediaDays: null, webhookPayloadDays: null });
    const direct = await runInboxRetention(ctx.db, config, { storage: memoryStorage, now: new Date() });
    expect(direct).toEqual({
      conversations: { state: 'refused', reason: 'NOT_CONFIGURED', variable: 'INBOX_CONVERSATION_RETENTION_DAYS' },
      media: { state: 'refused', reason: 'NOT_CONFIGURED', variable: 'INBOX_MEDIA_RETENTION_DAYS' },
      webhookPayloads: { state: 'refused', reason: 'NOT_CONFIGURED', variable: 'INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS' },
    });
    const runner = jobRunner(ctx.app.env);
    expect(await runner.runJob(INBOX_RETENTION_JOB, { force: true })).toBe('ok');
    const run = await lastRun();
    expect(run.outcome).toBe('ok');
    expect(run.detail).toMatchObject({
      conversations: { state: 'refused', variable: 'INBOX_CONVERSATION_RETENTION_DAYS' },
      media: { state: 'refused', variable: 'INBOX_MEDIA_RETENTION_DAYS' },
      webhookPayloads: { state: 'refused', variable: 'INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS' },
    });
    expect(await snapshot()).toEqual(before);
    expect(stored.has(`inbox/${oldFile}.jpg`)).toBe(true);
    // The env reads empty as unset, too.
    expect(retentionConfigOf({ INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS: undefined }).webhookPayloadDays).toBeNull();
  });

  it('webhook payloads: an old receipt keeps its row and loses its payload; recent ones are kept', async () => {
    const before = await snapshot();
    const out = await purgeWebhookPayloads(ctx.db, 30, { storage: memoryStorage, now: new Date() });
    expect(out).toMatchObject({ state: 'ran', days: 30, payloadsPurged: 1, more: false });
    const [r] = await ctx.db.select().from(s.webhookReceipt).where(eq(s.webhookReceipt.id, oldReceipt));
    expect(r!.payload).toBeNull();
    expect(r!.payloadPurgedAt).not.toBeNull();
    expect((await snapshot()).payloads).toBe(before.payloads - 1);
    const audit = await ctx.db.select().from(s.auditLog).where(eq(s.auditLog.action, 'inbox.retention.webhook_payloads'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ payloadsPurged: 1, days: 30 });
  });

  it('media: an old file is deleted and unlinked, the words stay; recent media are kept', async () => {
    const out = await purgeMedia(ctx.db, 30, { storage: memoryStorage, now: new Date() });
    expect(out).toMatchObject({ state: 'ran', messages: 1, filesDeleted: 1 });
    const [m] = await ctx.db.select().from(s.message).where(eq(s.message.id, oldMessage));
    expect(m!.mediaFileIds).toEqual([]);
    expect(m!.body).toContain(RETENTION_SENTINEL);
    expect(stored.has(`inbox/${oldFile}.jpg`)).toBe(false);
  });

  it('conversations: the old HANDLED thread is emptied in place and its events deleted; the active and the recent ones are kept', async () => {
    const eventsBefore = await ctx.db.select().from(s.inboxEvent).where(eq(s.inboxEvent.conversationId, oldThread));
    expect(eventsBefore.length).toBeGreaterThan(0);
    const otherEvents = Number(
      (await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from inbox.event where conversation_id <> ${oldThread}`)).rows[0]!.n,
    );
    const bodiesElsewhere = Number(
      (await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from inbox.message where conversation_id <> ${oldThread} and body is not null`)).rows[0]!.n,
    );

    const out = await purgeConversations(ctx.db, 365, { storage: memoryStorage, now: new Date() });
    expect(out).toMatchObject({ state: 'ran', days: 365, conversationsPurged: 1, eventsDeleted: eventsBefore.length });

    const [t] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, oldThread));
    expect(t).toMatchObject({ status: 'handled', lastMessagePreview: null });
    expect(t!.retainUntil).not.toBeNull();
    expect(await ctx.db.select().from(s.inboxEvent).where(eq(s.inboxEvent.conversationId, oldThread))).toHaveLength(0);
    const msgs = await ctx.db.select().from(s.message).where(eq(s.message.conversationId, oldThread));
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m.body).toBeNull();
      expect(m.redactedAt).not.toBeNull();
    }
    expect((await inboxHolds(ctx.db, RETENTION_SENTINEL)).messages).toBe(0);
    // The owners stay: the thread is still accounted for.
    const owners = await ctx.db.select().from(s.assignment).where(eq(s.assignment.conversationId, oldThread));
    expect(owners.length).toBeGreaterThan(0);
    // Nothing else moved: the active thread as old as it, and every recent one.
    const [active] = await ctx.db.select().from(s.conversation).where(eq(s.conversation.id, activeOldThread));
    expect(active!.retainUntil).toBeNull();
    expect(active!.lastMessagePreview).not.toBeNull();
    expect(
      Number((await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from inbox.event where conversation_id <> ${oldThread}`)).rows[0]!.n),
    ).toBe(otherEvents);
    expect(
      Number(
        (await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from inbox.message where conversation_id <> ${oldThread} and body is not null`)).rows[0]!.n,
      ),
    ).toBe(bodiesElsewhere);

    // A second pass finds nothing due.
    expect(await purgeConversations(ctx.db, 365, { storage: memoryStorage, now: new Date() })).toMatchObject({ conversationsPurged: 0 });
    const audit = await ctx.db.select().from(s.auditLog).where(eq(s.auditLog.action, 'inbox.retention.conversations'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ conversations: 1, conversationIds: [oldThread] });
  });

  it('the event table stays append-only outside the two doors', async () => {
    const [e] = await ctx.db.select().from(s.inboxEvent).limit(1);
    await expect(ctx.db.update(s.inboxEvent).set({ payload: {} }).where(eq(s.inboxEvent.id, e!.id))).rejects.toThrow();
    await expect(ctx.db.delete(s.inboxEvent).where(eq(s.inboxEvent.id, e!.id))).rejects.toThrow();
  });

  it('configured, the daily job runs all three and records what it did', async () => {
    const env: Env = {
      ...ctx.app.env,
      INBOX_CONVERSATION_RETENTION_DAYS: 365,
      INBOX_MEDIA_RETENTION_DAYS: 30,
      INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS: 30,
    };
    const runner = jobRunner(env);
    expect(await runner.runJob(INBOX_RETENTION_JOB, { force: true })).toBe('ok');
    const run = await lastRun();
    expect(run.detail).toMatchObject({
      conversations: { state: 'ran', days: 365, conversationsPurged: 0 },
      media: { state: 'ran', days: 30, messages: 0 },
      webhookPayloads: { state: 'ran', days: 30, payloadsPurged: 0 },
    });
  });
});

describe('the sentinel, once more, after the erasure and the purges (I2g)', () => {
  it('no body, name or phone of the erased person reached an audit row, an event, an ops row or a log line on the way', async () => {
    for (const needle of [SENTINEL, CHECK_TEXT, BOOKING_SENTINEL, RETENTION_SENTINEL]) {
      expect(await sentinelLeaks(ctx.db, needle, logLines), needle).toEqual(NO_LEAKS);
    }
  });
});
